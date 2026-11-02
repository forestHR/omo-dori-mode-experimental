import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ServerWebSocket } from "bun";
import { missingTokens, runSocket, slackWatchOptions, startWatch, writeEnvValues } from "../../setups/discord-aoe/slack-watch.ts";
import { MessengerError } from "../src/messenger/http.ts";
import { clearEyes, readUneyed } from "../src/messenger/slack.ts";
import { run } from "../src/run.ts";

const WATCH = join(import.meta.dir, "..", "..", "setups", "discord-aoe", "slack-watch.ts");
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const BOT = ["xoxb", "1", "fake"].join("-");
const APP = ["xapp", "1", "fake"].join("-");

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-watch-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// A fake Slack: the Web API on /api/<method>, Socket Mode on /ws. Every change (a call, an ack, a socket) wakes waiters,
// so a test waits for the exact state it needs instead of for time.
const fakeSlack = () => {
  const calls: { method: string; auth: string; body: Record<string, unknown> }[] = [];
  const acks: string[] = [];
  const sockets: ServerWebSocket<unknown>[] = [];
  const waiters = new Set<() => void>();
  const changed = () => {
    for (const w of [...waiters]) w();
  };
  let opens = 0;
  let port = 0;
  let pings = 0;
  // unreact (or unreactBy[ts] for one message): what reactions.remove answers - "" ok, an error code, "stall" never,
  // "hold" only on release("remove"); reactHold: reactions.add answers only on release("add")
  const failing = { auth: 0, reactScope: false, reactStall: false, reactHold: false, unreact: "", unreactBy: {} as Record<string, string> };
  const held = { add: [] as (() => void)[], remove: [] as (() => void)[] };
  const release = (kind?: "add" | "remove") => {
    for (const k of kind ? [kind] : (["add", "remove"] as const)) for (const r of held[k].splice(0)) r();
  };
  const server = Bun.serve({
    port: 0,
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      if (url.pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      const method = url.pathname.replace("/api/", "");
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      calls.push({ method, auth: req.headers.get("authorization") ?? "", body });
      changed();
      const reply = (x: object) => Response.json({ ok: true, ...x });
      if (method === "auth.test" && failing.auth > 0) {
        failing.auth--;
        return new Response("unavailable", { status: 503 });
      }
      if (method === "auth.test") return reply({ user_id: "UBOT", bot_id: "BBOT", user: "okdori", team: "Lab" });
      if (method === "apps.connections.open") {
        opens++;
        return reply({ url: `ws://localhost:${port}/ws` });
      }
      if (method === "users.info") return reply({ user: { profile: { display_name: `name-${String(body.user)}` } } });
      if (method === "chat.postMessage") return reply({ channel: body.channel, ts: "1700000100.000100" });
      if (method === "reactions.add" && failing.reactStall) return new Promise<Response>(() => {});
      if (method === "reactions.add" && failing.reactHold) return new Promise<Response>((r) => held.add.push(() => r(reply({}))));
      const unreact = failing.unreactBy[String(body.timestamp)] ?? failing.unreact;
      if (method === "reactions.remove" && unreact === "stall") return new Promise<Response>(() => {});
      if (method === "reactions.remove" && unreact === "hold") return new Promise<Response>((r) => held.remove.push(() => r(reply({}))));
      if (method === "reactions.remove" && unreact) return Response.json({ ok: false, error: unreact });
      if (method === "reactions.add") return failing.reactScope ? Response.json({ ok: false, error: "missing_scope" }) : reply({});
      if (method === "reactions.remove") return reply({});
      return Response.json({ ok: false, error: "unknown_method" });
    },
    websocket: {
      open: (ws) => {
        sockets.push(ws);
        ws.send(JSON.stringify({ type: "hello" }));
        changed();
      },
      message: (_ws, m) => {
        acks.push(String((JSON.parse(String(m)) as { envelope_id?: string }).envelope_id));
        changed();
      },
      ping: () => {
        pings++;
        changed();
      },
    },
  });
  port = server.port ?? 0;
  cleanups.push(() => server.stop(true));
  const until = (what: string, ok: () => boolean, ms = 5000) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!ok()) return;
        waiters.delete(check);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`timed out waiting for ${what}`));
      }, ms);
      waiters.add(check);
      check();
    });
  let n = 0;
  const event = (event: object, envelope = `env-${++n}`) => {
    sockets.at(-1)?.send(JSON.stringify({ envelope_id: envelope, type: "events_api", payload: { event } }));
    return envelope;
  };
  return { calls, acks, sockets, opens: () => opens, pings: () => pings, failing, release, until, changed, event, api: `http://localhost:${port}/api`, server };
};

const watcher = async (slack: ReturnType<typeof fakeSlack>, threads: object[] = [], pingMs = 30_000, env: Record<string, string> = {}, reactMs = 3000) => {
  const dir = scratch();
  writeFileSync(join(dir, "slack-threads.json"), JSON.stringify(threads));
  const o = slackWatchOptions({ DORI_SLACK_APP_TOKEN: APP, DORI_SLACK_TOKEN: BOT, DORI_SLACK_OWNER_ID: "UOWNER", DORI_SLACK_API: slack.api, ...env }, dir);
  const lines: string[] = [];
  // the eyes reactions Slack had taken when each line was logged
  const eyesAt: number[] = [];
  const stop = { stopped: false };
  const done = startWatch(o, (l) => {
    lines.push(l);
    eyesAt.push(slack.calls.filter((c) => c.method === "reactions.add").length);
    slack.changed();
  }, stop, pingMs, reactMs);
  cleanups.push(async () => {
    stop.stopped = true;
    slack.server.stop(true);
    await done;
  });
  await slack.until("SLACK_WATCH_READY", () => lines.includes("SLACK_WATCH_READY"));
  const rows = () => (existsSync(o.inbox) ? readFileSync(o.inbox, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : []);
  return { o, lines, rows, eyesAt, msgs: () => lines.filter((l) => l.startsWith("SLACK_MSG")) };
};

test("a DM to the bot is acked, becomes one inbox row and one SLACK_MSG line, and the reply goes out with the bot token in that DM", async () => {
  // Given
  const slack = fakeSlack();
  const w = await watcher(slack);
  // When
  const env = slack.event({ type: "message", channel_type: "im", channel: "D1", user: "UOWNER", text: "옥돌 오늘 일정?", ts: "1700000000.000100" });
  await slack.until("the DM's SLACK_MSG", () => w.msgs().length === 1);
  // Then
  expect(slack.acks).toContain(env);
  expect(w.rows()).toEqual([
    { ts: expect.any(String), id: "1700000000.000100", channel_id: "D1", thread_ts: null, reply_thread: null, scope: "slack", author_id: "UOWNER", author_name: "name-UOWNER", author_kind: "owner", addressed: "dm", mentions_self: false, content: "옥돌 오늘 일정?" },
  ]);
  expect(w.msgs()).toEqual(["SLACK_MSG D1 - dm name-UOWNER (owner): 옥돌 오늘 일정?"]);
  // the eyes went on with the bot token before the SLACK_MSG line woke the lead (dori-superagent #9)
  expect(slack.calls.filter((c) => c.method === "reactions.add")).toEqual([{ method: "reactions.add", auth: `Bearer ${BOT}`, body: { channel: "D1", timestamp: "1700000000.000100", name: "eyes" } }]);
  expect(w.eyesAt[w.lines.findIndex((l) => l.startsWith("SLACK_MSG"))]).toBe(1);
  expect(slack.calls.filter((c) => c.method === "apps.connections.open").map((c) => c.auth)).toEqual([`Bearer ${APP}`]);
  expect(slack.calls.filter((c) => c.method !== "apps.connections.open").every((c) => c.auth === `Bearer ${BOT}`)).toBe(true);

  // When the lead answers a channel mention in its thread through dori send slack
  const state = scratch();
  const sent = await run(["env", `DORI_CONFIG=${join(state, "missing.json")}`, `DORI_STATE_DIR=${state}`, `DORI_ENV_FILE=${join(state, "missing.env")}`, `DORI_SLACK_TOKEN=${BOT}`, `DORI_SLACK_API=${slack.api}`,
    "bun", CLI, "send", "slack", "--to", "C1", "--thread", "1700000000.000200", "--text", "네, 확인할게요"]);
  // Then the post is the bot's, in that thread
  expect(sent.code).toBe(0);
  expect(slack.calls.filter((c) => c.method === "chat.postMessage")).toEqual([{ method: "chat.postMessage", auth: `Bearer ${BOT}`, body: { channel: "C1", text: "네, 확인할게요", thread_ts: "1700000000.000200" } }]);
});

test("a mention seen twice and retried is one row; bot, own, edited and unaddressed messages do not wake the lead; a reply in the Dori's own thread does", async () => {
  // Given a thread the Dori posted in (recorded by dori send slack)
  const slack = fakeSlack();
  const w = await watcher(slack, [{ channel: "C1", rootTs: "1700000000.000500", seenTs: "1700000000.000500" }]);
  const mention = { channel: "C1", user: "UGUEST", text: "<@UBOT> 자료 있어?", ts: "1700000000.000300" };
  // When
  slack.event({ type: "app_mention", ...mention });
  slack.event({ type: "message", channel_type: "channel", ...mention });
  slack.event({ type: "app_mention", ...mention }, "env-retry");
  slack.event({ type: "message", channel: "C1", user: "UGUEST", text: "다른 사람끼리 수다", ts: "1700000000.000310" });
  slack.event({ type: "message", subtype: "bot_message", bot_id: "BX", channel: "C1", text: "bot", ts: "1700000000.000320" });
  slack.event({ type: "message", channel: "C1", user: "UBOT", bot_id: "BBOT", text: "my own reply", ts: "1700000000.000330" });
  slack.event({ type: "message", channel: "C1", user: "UOTHERAPP", bot_id: "BOTHER", text: "<@UBOT> ping from another app", ts: "1700000000.000335" });
  slack.event({ type: "message", subtype: "message_changed", channel: "C1", ts: "1700000000.000340" });
  slack.event({ type: "message", channel: "C1", user: "UGUEST", text: "태그 없이 스레드 답", ts: "1700000000.000600", thread_ts: "1700000000.000500" });
  await slack.until("the own-thread SLACK_MSG", () => w.msgs().length === 2);
  // Then
  expect(slack.acks).toContain("env-retry");
  expect(w.rows().map((r) => [r.id, r.addressed, r.reply_thread])).toEqual([
    ["1700000000.000300", "mention", "1700000000.000300"],
    ["1700000000.000310", null, "1700000000.000310"],
    ["1700000000.000600", "own-thread", "1700000000.000500"],
  ]);
  expect(w.msgs()).toEqual(["SLACK_MSG C1 1700000000.000300 mention name-UGUEST: <@UBOT> 자료 있어?", "SLACK_MSG C1 1700000000.000500 own-thread name-UGUEST: 태그 없이 스레드 답"]);
  // eyes on the two addressed messages, once each, and on nothing else
  expect(slack.calls.filter((c) => c.method === "reactions.add").map((c) => c.body.timestamp)).toEqual(["1700000000.000300", "1700000000.000600"]);
});

test("a channel message that calls the Dori by name (DORI_SLACK_MENTION) wakes the lead as name and gets eyes; other people's talk and bots' posts with the name do not", async () => {
  // Given okdori's names, as the owner wrote at 00:19 KST without an @
  const slack = fakeSlack();
  const w = await watcher(slack, [], 30_000, { DORI_SLACK_MENTION: "옥돌|옥도리|okdori" });
  // When
  slack.event({ type: "message", channel_type: "channel", channel: "C1", user: "UOWNER", text: "옥돌아 들리면 대답해봐", ts: "1700000000.000800" });
  slack.event({ type: "message", channel_type: "channel", channel: "C1", user: "UGUEST", text: "점심 뭐 먹지", ts: "1700000000.000810" });
  slack.event({ type: "message", channel_type: "channel", channel: "C1", user: "UOTHERAPP", bot_id: "BOTHER", text: "okdori status ping", ts: "1700000000.000820" });
  slack.event({ type: "message", channel_type: "channel", channel: "C1", user: "UGUEST", text: "OkDori, 자료 있어?", ts: "1700000000.000830" });
  await slack.until("two name SLACK_MSG lines", () => w.msgs().length === 2);
  // Then
  expect(w.rows().map((r) => [r.id, r.addressed, r.mentions_self])).toEqual([
    ["1700000000.000800", "name", true],
    ["1700000000.000810", null, false],
    ["1700000000.000830", "name", true],
  ]);
  expect(w.msgs()).toEqual(["SLACK_MSG C1 1700000000.000800 name name-UOWNER (owner): 옥돌아 들리면 대답해봐", "SLACK_MSG C1 1700000000.000830 name name-UGUEST: OkDori, 자료 있어?"]);
  expect(slack.calls.filter((c) => c.method === "reactions.add").map((c) => c.body.timestamp)).toEqual(["1700000000.000800", "1700000000.000830"]);
});

test("a reactions.add that never answers holds neither its message's SLACK_MSG nor the messages after it", async () => {
  // Given Slack takes the reaction request and never answers (the deadline is the behavior under test: 200 ms here)
  const slack = fakeSlack();
  slack.failing.reactStall = true;
  const w = await watcher(slack, [], 30_000, {}, 200);
  // When two DMs arrive
  slack.event({ type: "message", channel_type: "im", channel: "D1", user: "UOWNER", text: "one", ts: "1700000000.000900" });
  slack.event({ type: "message", channel_type: "im", channel: "D1", user: "UOWNER", text: "two", ts: "1700000000.000910" });
  // Then both still wake the lead, each after its own failed reaction
  await slack.until("both SLACK_MSG lines", () => w.msgs().length === 2);
  expect(w.lines.filter((l) => /^SLACK_(REACT|MSG)/.test(l))).toEqual([
    "SLACK_REACT_FAIL D1 1700000000.000900 slack reactions.add: no answer within 0.2s",
    "SLACK_MSG D1 - dm name-UOWNER (owner): one",
    "SLACK_REACT_FAIL D1 1700000000.000910 slack reactions.add: no answer within 0.2s",
    "SLACK_MSG D1 - dm name-UOWNER (owner): two",
  ]);
});

test("an app without reactions:write logs SLACK_REACT_SKIPPED once and stops asking; every message still arrives", async () => {
  // Given an app installed before reactions:write was in the manifest
  const slack = fakeSlack();
  slack.failing.reactScope = true;
  const w = await watcher(slack);
  // When two DMs arrive
  slack.event({ type: "message", channel_type: "im", channel: "D1", user: "UOWNER", text: "one", ts: "1700000000.000700" });
  slack.event({ type: "message", channel_type: "im", channel: "D1", user: "UOWNER", text: "two", ts: "1700000000.000710" });
  await slack.until("both SLACK_MSG lines", () => w.msgs().length === 2);
  // Then
  expect(w.rows().map((r) => r.content)).toEqual(["one", "two"]);
  expect(w.lines.filter((l) => l.startsWith("SLACK_REACT_SKIPPED"))).toEqual(["SLACK_REACT_SKIPPED slack reactions.add: missing_scope: the app has no reactions:write, so messages arrive without eyes until it is added and the app reinstalled"]);
  expect(slack.calls.filter((c) => c.method === "reactions.add").length).toBe(1);
  expect(w.lines.some((l) => l.startsWith("SLACK_REACT_FAIL"))).toBe(false);
});

// dori send slack in the watcher's own state dir, as the lead answers
const send = (w: { o: { threads: string } }, slack: ReturnType<typeof fakeSlack>, args: string[], token = BOT) => {
  const state = dirname(w.o.threads);
  return run(["env", `DORI_CONFIG=${join(state, "missing.json")}`, `DORI_STATE_DIR=${state}`, `DORI_ENV_FILE=${join(state, "missing.env")}`, `DORI_SLACK_TOKEN=${token}`, `DORI_SLACK_API=${slack.api}`, "bun", CLI, "send", "slack", ...args]);
};
const unreacted = (slack: ReturnType<typeof fakeSlack>) => slack.calls.filter((c) => c.method === "reactions.remove").map((c) => `${String(c.body.channel)} ${String(c.body.timestamp)} ${String(c.body.name)} ${c.auth === `Bearer ${BOT}` ? "bot" : c.auth}`);

test("answering with dori send slack takes the watcher's eyes off the messages it answers, once, and off nothing else", async () => {
  // Given an unaddressed reply under the first mention (taken in first: rows wake no waiter, SLACK_MSG lines do), two
  // DMs and two channel mentions in different threads
  const slack = fakeSlack();
  const w = await watcher(slack);
  slack.event({ type: "message", channel: "C1", user: "UOTHER", text: "me too", ts: "1700000000.000210", thread_ts: "1700000000.000200" });
  slack.event({ type: "message", channel_type: "im", channel: "D1", user: "UOWNER", text: "one", ts: "1700000000.000100" });
  slack.event({ type: "message", channel_type: "im", channel: "D1", user: "UOWNER", text: "two", ts: "1700000000.000110" });
  slack.event({ type: "app_mention", channel: "C1", user: "UGUEST", text: "<@UBOT> a", ts: "1700000000.000200" });
  slack.event({ type: "app_mention", channel: "C1", user: "UGUEST", text: "<@UBOT> b", ts: "1700000000.000300" });
  await slack.until("four SLACK_MSG lines", () => w.msgs().length === 4);
  expect(w.rows().length).toBe(5);
  // When the lead answers the DM and the first mention's thread
  const dm = await send(w, slack, ["--to", "D1", "--text", "네"]);
  const th = await send(w, slack, ["--to", "C1", "--thread", "1700000000.000200", "--text", "자료 여기"]);
  // Then the bot's own eyes come off those three messages only, with the bot token, and nothing extra is printed
  expect([dm.code, dm.out.trim().startsWith("SENT "), th.code, th.out.trim().split("\n").length]).toEqual([0, true, 0, 1]);
  expect(unreacted(slack)).toEqual(["D1 1700000000.000100 eyes bot", "D1 1700000000.000110 eyes bot", "C1 1700000000.000200 eyes bot"]);
  // When the lead writes in that thread again
  const again = await send(w, slack, ["--to", "C1", "--thread", "1700000000.000200", "--text", "하나 더"]);
  // Then Slack is not asked again; the other mention keeps its eyes until its own thread is answered
  expect(again.code).toBe(0);
  expect(unreacted(slack).length).toBe(3);
  await send(w, slack, ["--to", "C1", "--thread", "1700000000.000300", "--text", "b 답"]);
  expect(unreacted(slack).at(-1)).toBe("C1 1700000000.000300 eyes bot");
});

test("taking the eyes off: no reactions:write is one SLACK_UNEYE_SKIPPED line and the answer still goes out; eyes already gone are quiet; a member's token never unreacts", async () => {
  // Given an addressed DM
  const slack = fakeSlack();
  const w = await watcher(slack);
  slack.event({ type: "message", channel_type: "im", channel: "D1", user: "UOWNER", text: "one", ts: "1700000000.000100" });
  await slack.until("the DM", () => w.msgs().length === 1);
  // When the lead answers with a member's token
  const member = await send(w, slack, ["--to", "D1", "--text", "a"], ["xoxp", "1"].join("-"));
  // Then the answer goes out and no reaction is touched
  expect(member.code).toBe(0);
  expect(unreacted(slack)).toEqual([]);
  // When the app has no reactions:write
  slack.failing.unreact = "missing_scope";
  const skipped = await send(w, slack, ["--to", "D1", "--text", "b"]);
  // Then one line says so and the answer went out
  expect(skipped.code).toBe(0);
  expect(skipped.out.trim().split("\n").slice(1)).toEqual(["SLACK_UNEYE_SKIPPED slack reactions.remove: missing_scope: the app has no reactions:write, so the eyes stay until it is added and the app reinstalled"]);
  expect(skipped.out).not.toContain(BOT);
  // When the scope is there but the eyes are already gone
  slack.failing.unreact = "no_reaction";
  const gone = await send(w, slack, ["--to", "D1", "--text", "c"]);
  const after = await send(w, slack, ["--to", "D1", "--text", "d"]);
  // Then nothing is printed beyond SENT, and Slack is not asked again
  expect([gone.code, gone.out.trim().split("\n").length, after.code]).toEqual([0, 1, 0]);
  expect(unreacted(slack)).toEqual(["D1 1700000000.000100 eyes bot", "D1 1700000000.000100 eyes bot"]);
});

test("a reactions.remove that never answers is aborted: the answer's command ends with SENT and one SLACK_UNEYE_FAIL, and the next answer takes the eyes off", async () => {
  // Given an addressed DM and a Slack that takes the removal and never answers (the 3 s deadline is the behavior here)
  const slack = fakeSlack();
  const w = await watcher(slack);
  slack.event({ type: "message", channel_type: "im", channel: "D1", user: "UOWNER", text: "one", ts: "1700000000.000100" });
  await slack.until("the DM", () => w.msgs().length === 1);
  slack.failing.unreact = "stall";
  // When
  const stalled = await send(w, slack, ["--to", "D1", "--text", "a"]);
  // Then the command still ends, the answer went out, and the message is left for the next answer
  expect(stalled.code).toBe(0);
  expect(stalled.out.trim().split("\n").slice(1)).toEqual(["SLACK_UNEYE_FAIL D1 1700000000.000100 slack reactions.remove: no answer within 3s"]);
  slack.failing.unreact = "";
  const next = await send(w, slack, ["--to", "D1", "--text", "b"]);
  expect([next.code, next.out.trim().split("\n").length]).toEqual([0, 1]);
  expect(unreacted(slack)).toEqual(["D1 1700000000.000100 eyes bot", "D1 1700000000.000100 eyes bot"]);
}, 15_000);

test("eyes that land after the answer already cleared the message come off again in the watcher", async () => {
  // Given a reactions.add that answers only after the watcher's deadline (200 ms here)
  const slack = fakeSlack();
  slack.failing.reactHold = true;
  const w = await watcher(slack, [], 30_000, {}, 200);
  slack.event({ type: "message", channel_type: "im", channel: "D1", user: "UOWNER", text: "one", ts: "1700000000.000100" });
  await slack.until("the DM", () => w.msgs().length === 1);
  // When the lead answers while the eyes are not on yet, and then they land
  slack.failing.unreact = "no_reaction";
  expect((await send(w, slack, ["--to", "D1", "--text", "a"])).code).toBe(0);
  slack.failing.unreact = "";
  slack.release();
  // Then the watcher takes them off again, with the bot token
  await slack.until("the second removal", () => unreacted(slack).length === 2);
  expect(unreacted(slack)).toEqual(["D1 1700000000.000100 eyes bot", "D1 1700000000.000100 eyes bot"]);
});

test("eyes landing while the same answer still waits on another message's removal come off again", async () => {
  // Given two DMs whose reactions.add answer late (200 ms deadline)
  const slack = fakeSlack();
  slack.failing.reactHold = true;
  const w = await watcher(slack, [], 30_000, {}, 200);
  slack.event({ type: "message", channel_type: "im", channel: "D1", user: "UOWNER", text: "a", ts: "1700000000.000100" });
  slack.event({ type: "message", channel_type: "im", channel: "D1", user: "UOWNER", text: "b", ts: "1700000000.000110" });
  await slack.until("both DMs", () => w.msgs().length === 2);
  // When one answer finds no eyes on A yet and is still waiting on B's removal
  slack.failing.unreactBy = { "1700000000.000100": "no_reaction", "1700000000.000110": "hold" };
  const answer = send(w, slack, ["--to", "D1", "--text", "둘 다"]);
  await slack.until("B's removal asked", () => unreacted(slack).includes("D1 1700000000.000110 eyes bot"));
  slack.failing.unreactBy = { "1700000000.000110": "hold" };
  slack.release("add");
  // Then the watcher takes A's late eyes off before that answer is over
  await slack.until("A's second removal", () => unreacted(slack).filter((c) => c.startsWith("D1 1700000000.000100 ")).length === 2);
  slack.release("remove");
  expect((await answer).code).toBe(0);
});

test("late eyes the watcher could not take off are asked about again on the next answer", async () => {
  // Given a DM whose reactions.add answers late, answered while its eyes were not on yet
  const slack = fakeSlack();
  slack.failing.reactHold = true;
  const w = await watcher(slack, [], 30_000, {}, 200);
  slack.event({ type: "message", channel_type: "im", channel: "D1", user: "UOWNER", text: "a", ts: "1700000000.000100" });
  await slack.until("the DM", () => w.msgs().length === 1);
  slack.failing.unreact = "no_reaction";
  expect((await send(w, slack, ["--to", "D1", "--text", "x"])).code).toBe(0);
  // When the eyes land and the watcher's removal fails
  slack.failing.unreact = "internal_error";
  slack.release("add");
  await slack.until("the watcher's SLACK_UNEYE_FAIL", () => w.lines.includes("SLACK_UNEYE_FAIL D1 1700000000.000100 slack reactions.remove: internal_error"));
  // Then the next answer there asks again, and it sticks
  slack.failing.unreact = "";
  const next = await send(w, slack, ["--to", "D1", "--text", "y"]);
  await send(w, slack, ["--to", "D1", "--text", "z"]);
  expect([next.code, next.out.trim().split("\n").length]).toEqual([0, 1]);
  expect(unreacted(slack).length).toBe(3);
});

test("a slow answer's done never closes a newer answer's failed attempt on the same message", async () => {
  // Given one answered DM in the inbox
  const dir = scratch();
  const files = { inbox: join(dir, "inbox.jsonl"), uneyed: join(dir, "slack-uneyed.log") };
  writeFileSync(files.inbox, `${JSON.stringify({ id: "1700000000.000100", channel_id: "D1", reply_thread: null, scope: "slack", addressed: "dm" })}\n`);
  const posted = { channel: "D1", ts: "1700000100.000100" };
  // When answer A's removal is slow, answer B's fails meanwhile, and only then A hears no_reaction
  let answerA: (e: Error) => void = () => {};
  let askedA = () => {};
  const asked = new Promise<void>((r) => (askedA = r));
  const a = clearEyes((_c, _t, _s) => new Promise<void>((_, reject) => { answerA = reject; askedA(); }), files, posted);
  await asked;
  const b = await clearEyes(async () => { throw new MessengerError("slack reactions.remove: internal_error", 200, "internal_error"); }, files, posted);
  answerA(new MessengerError("slack reactions.remove: no_reaction", 200, "no_reaction"));
  await a;
  // Then the message is still open, and the next answer asks Slack again
  expect(b).toEqual(["SLACK_UNEYE_FAIL D1 1700000000.000100 slack reactions.remove: internal_error"]);
  expect(readUneyed(files.uneyed).done.has("D1:1700000000.000100")).toBe(false);
  const asks: string[] = [];
  await clearEyes(async (c, t) => { asks.push(`${c} ${t}`); }, files, posted);
  expect(asks).toEqual(["D1 1700000000.000100"]);
  expect(readUneyed(files.uneyed).done.has("D1:1700000000.000100")).toBe(true);
});

test("a stalled late-eyes removal in the watcher leaves the message open: the next answer asks again", async () => {
  // Given a DM whose reactions.add answers late, answered while its eyes were not on yet
  const slack = fakeSlack();
  slack.failing.reactHold = true;
  const w = await watcher(slack, [], 30_000, {}, 200);
  slack.event({ type: "message", channel_type: "im", channel: "D1", user: "UOWNER", text: "a", ts: "1700000000.000100" });
  await slack.until("the DM", () => w.msgs().length === 1);
  slack.failing.unreact = "no_reaction";
  expect((await send(w, slack, ["--to", "D1", "--text", "x"])).code).toBe(0);
  // When the eyes land and the watcher's own removal never answers (or its process is gone)
  slack.failing.unreact = "stall";
  slack.release("add");
  await slack.until("the watcher's removal", () => unreacted(slack).length === 2);
  // Then the next answer asks again even while the watcher's request is still out, and the watcher says it gave up
  slack.failing.unreact = "";
  expect((await send(w, slack, ["--to", "D1", "--text", "y"])).code).toBe(0);
  expect(unreacted(slack).length).toBe(3);
  await slack.until("the watcher's SLACK_UNEYE_FAIL", () => w.lines.includes("SLACK_UNEYE_FAIL D1 1700000000.000100 slack reactions.remove: no answer within 0.2s"));
});

test("two answers at once in different DMs both keep their record", async () => {
  // Given addressed DMs in D1 and D2
  const slack = fakeSlack();
  const w = await watcher(slack);
  slack.event({ type: "message", channel_type: "im", channel: "D1", user: "UOWNER", text: "a", ts: "1700000000.000100" });
  slack.event({ type: "message", channel_type: "im", channel: "D2", user: "UGUEST", text: "b", ts: "1700000000.000200" });
  await slack.until("both DMs", () => w.msgs().length === 2);
  // When the D1 answer is still waiting on its removal while the D2 answer runs start to end
  slack.failing.unreactBy = { "1700000000.000100": "hold" };
  const d1 = send(w, slack, ["--to", "D1", "--text", "x"]);
  await slack.until("D1's removal asked", () => unreacted(slack).length === 1);
  expect((await send(w, slack, ["--to", "D2", "--text", "y"])).code).toBe(0);
  slack.release("remove");
  expect((await d1).code).toBe(0);
  // Then later answers in both places ask Slack nothing again
  slack.failing.unreactBy = {};
  await send(w, slack, ["--to", "D1", "--text", "x2"]);
  await send(w, slack, ["--to", "D2", "--text", "y2"]);
  expect(unreacted(slack)).toEqual(["D1 1700000000.000100 eyes bot", "D2 1700000000.000200 eyes bot"]);
});

test("more than 2,000 answered messages are each asked about once, never again", async () => {
  // Given an inbox with 2,001 addressed DMs (as the watcher writes them) and no done file
  const slack = fakeSlack();
  const dir = scratch();
  const rows = Array.from({ length: 2001 }, (_, i) => JSON.stringify({ id: `1690000000.${String(i).padStart(6, "0")}`, channel_id: "D9", thread_ts: null, reply_thread: null, scope: "slack", addressed: "dm" }));
  mkdirSync(join(dir, "discord"));
  writeFileSync(join(dir, "discord", "inbox.jsonl"), `${rows.join("\n")}\n`);
  const w = { o: { threads: join(dir, "slack-threads.json") } };
  // When the lead answers there twice
  const first = await send(w, slack, ["--to", "D9", "--text", "a"]);
  const second = await send(w, slack, ["--to", "D9", "--text", "b"]);
  // Then every message was asked about exactly once
  expect([first.code, second.code]).toEqual([0, 0]);
  expect(unreacted(slack).length).toBe(2001);
}, 30_000);

test("a disconnect from Slack opens a fresh connection and messages keep arriving", async () => {
  // Given
  const slack = fakeSlack();
  const w = await watcher(slack);
  // When
  slack.sockets.at(-1)?.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
  await slack.until("SLACK_WATCH_RECONNECTED", () => w.lines.includes("SLACK_WATCH_RECONNECTED"));
  slack.event({ type: "message", channel_type: "im", channel: "D2", user: "UGUEST", text: "still there?", ts: "1700000000.000700" });
  await slack.until("the DM after the reconnect", () => w.msgs().length === 1);
  // Then
  expect(slack.opens()).toBe(2);
  expect(w.lines).toContain("SLACK_WATCH_REFRESH refresh_requested");
  expect(w.msgs()).toEqual(["SLACK_MSG D2 - dm name-UGUEST: still there?"]);
});

test("a Slack outage at start is waited out (SLACK_AUTH_FAIL), not an exit; a healthy connection answers pings and is kept", async () => {
  // Given auth.test fails once
  const slack = fakeSlack();
  slack.failing.auth = 1;
  // When
  const w = await watcher(slack, [], 50);
  await slack.until("three pings answered", () => slack.pings() >= 3);
  // Then
  expect(w.lines.filter((l) => l.startsWith("SLACK_AUTH_FAIL"))).toEqual(["SLACK_AUTH_FAIL slack auth.test: 503, retry in 1s"]);
  expect(w.lines.filter((l) => l.startsWith("SLACK_WATCH_STALE"))).toEqual([]);
  expect(slack.opens()).toBe(1);
});

test("a connection that goes silent without a close is replaced by a fresh one", async () => {
  // Given a socket that takes pings and never answers anything after its hello
  const lines: string[] = [];
  const opened: string[] = [];
  const stop = { stopped: false };
  let wake = () => {};
  const done = runSocket(
    {
      connect: async () => `wss://fake/${opened.length + 1}`,
      open: (url, on) => {
        opened.push(url);
        queueMicrotask(() => on.message(JSON.stringify({ type: "hello" })));
        return { send: () => {}, close: () => {}, ping: () => {} };
      },
      handle: async () => {},
      log: (l) => {
        lines.push(l);
        wake();
      },
      sleep: async () => {},
      pingMs: 20,
    },
    stop,
  );
  // When
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reconnect: ${lines.join(" | ")}`)), 5000);
    wake = () => {
      if (!lines.includes("SLACK_WATCH_RECONNECTED")) return;
      clearTimeout(timer);
      resolve();
    };
  });
  stop.stopped = true;
  await done;
  // Then
  expect(lines.slice(0, 3)).toEqual(["SLACK_WATCH_READY", "SLACK_WATCH_STALE no frame or pong for 0.02s, opening a new connection", "SLACK_WATCH_RECONNECTED"]);
  expect(opened.slice(0, 2)).toEqual(["wss://fake/1", "wss://fake/2"]);
});

test("without tokens the watcher is off and exits 0; a member's token is refused", async () => {
  // Given
  const dir = scratch();
  // When
  const off = await run(["env", `DORI_CONFIG=${join(dir, "missing.json")}`, `DORI_STATE_DIR=${dir}`, `DORI_ENV_FILE=${join(dir, "missing.env")}`, "bun", WATCH]);
  // Then
  expect({ code: off.code, out: off.out.trim() }).toEqual({ code: 0, out: "SLACK_WATCH_OFF DORI_SLACK_APP_TOKEN is not set" });
  expect(missingTokens({ appToken: APP, botToken: ["xoxp", "1"].join("-") })).toBe("DORI_SLACK_TOKEN is not a bot token (xoxb-): this watcher never uses a member's token");
  expect(missingTokens({ appToken: APP, botToken: BOT })).toBe("");
});

test("--wait starts the watcher once the tokens appear in dori.env", async () => {
  // Given a Dori whose env file has no Slack tokens yet
  const slack = fakeSlack();
  const dir = scratch();
  const envFile = join(dir, "dori.env");
  writeFileSync(envFile, `DORI_SLACK_API=${slack.api}\n`);
  const proc = Bun.spawn(["bun", WATCH, "--wait"], { env: { ...process.env, DORI_CONFIG: join(dir, "missing.json"), DORI_STATE_DIR: dir, DORI_ENV_FILE: envFile, DORI_SLACK_WAIT_MS: "100" }, stdout: "pipe" });
  cleanups.push(() => proc.kill());
  let out = "";
  (async () => {
    for await (const chunk of proc.stdout) {
      out += new TextDecoder().decode(chunk);
      slack.changed();
    }
  })();
  await slack.until("SLACK_WATCH_WAIT", () => out.includes("SLACK_WATCH_WAIT"));
  // When
  writeEnvValues(envFile, { DORI_SLACK_TOKEN: BOT, DORI_SLACK_APP_TOKEN: APP });
  // Then
  await slack.until("SLACK_WATCH_READY", () => out.includes("SLACK_WATCH_READY"));
  expect(out).not.toContain(BOT);
  expect(out).not.toContain(APP);
});

test("writeEnvValues replaces only the named lines and leaves the file 0600", () => {
  // Given
  const file = join(scratch(), "dori.env");
  writeFileSync(file, "# comment\nDORI_DISCORD_TOKEN=keep\nDORI_SLACK_TOKEN=old\n", { mode: 0o644 });
  // When
  writeEnvValues(file, { DORI_SLACK_TOKEN: "new", DORI_SLACK_APP_TOKEN: "app" });
  // Then
  expect(readFileSync(file, "utf8")).toBe("# comment\nDORI_DISCORD_TOKEN=keep\nDORI_SLACK_TOKEN=new\nDORI_SLACK_APP_TOKEN=app\n");
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

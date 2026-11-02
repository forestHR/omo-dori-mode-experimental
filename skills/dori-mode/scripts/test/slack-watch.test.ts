import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { missingTokens, runSocket, slackWatchOptions, startWatch, writeEnvValues } from "../../setups/discord-aoe/slack-watch.ts";
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
  const failing = { auth: 0 };
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
  return { calls, acks, sockets, opens: () => opens, pings: () => pings, failing, until, changed, event, api: `http://localhost:${port}/api`, server };
};

const watcher = async (slack: ReturnType<typeof fakeSlack>, threads: object[] = [], pingMs = 30_000) => {
  const dir = scratch();
  writeFileSync(join(dir, "slack-threads.json"), JSON.stringify(threads));
  const o = slackWatchOptions({ DORI_SLACK_APP_TOKEN: APP, DORI_SLACK_TOKEN: BOT, DORI_SLACK_OWNER_ID: "UOWNER", DORI_SLACK_API: slack.api }, dir);
  const lines: string[] = [];
  const stop = { stopped: false };
  const done = startWatch(o, (l) => {
    lines.push(l);
    slack.changed();
  }, stop, pingMs);
  cleanups.push(async () => {
    stop.stopped = true;
    slack.server.stop(true);
    await done;
  });
  await slack.until("SLACK_WATCH_READY", () => lines.includes("SLACK_WATCH_READY"));
  const rows = () => (existsSync(o.inbox) ? readFileSync(o.inbox, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : []);
  return { o, lines, rows, msgs: () => lines.filter((l) => l.startsWith("SLACK_MSG")) };
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
});

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

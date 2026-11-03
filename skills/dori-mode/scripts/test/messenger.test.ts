import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { Discord, discordPresence } from "../src/messenger/discord.ts";
import { type Http, type HttpRequest, type HttpResponse, MessengerError, UnsafeMessageError } from "../src/messenger/http.ts";
import { Slack } from "../src/messenger/slack.ts";
import { pollSlackInbound } from "../src/messenger/slack-inbound.ts";
import { ThreadLedger } from "../src/messenger/thread-ledger.ts";
import { readUploads } from "../src/messenger/upload-files.ts";
import { slackPresence } from "../src/messenger/slack-presence.ts";
import { htmlTable, startThinking, Telegram, THINKING } from "../src/messenger/telegram.ts";
import { typingWhile } from "../src/messenger/typing.ts";
import { run as realRun } from "../src/run.ts";
import { transcribe, TranscriptionError } from "../src/messenger/voice.ts";
import { fakeClock, withState } from "./fakes.ts";

type Script = (req: HttpRequest, n: number) => HttpResponse;
const fakeHttp = (script: Script) => {
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    return script(req, seen.length);
  };
  return { http, seen };
};
const ok = (body: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, body: JSON.stringify(body) });
const sleeps = () => {
  const waited: number[] = [];
  const clock = { ...fakeClock(0), sleep: async (ms: number) => { waited.push(ms); } };
  return { clock, waited };
};
const fakeTimers = () => {
  const live = new Set<() => void>();
  return {
    live,
    timers: { setInterval: (cb: () => void) => { live.add(cb); return cb; }, clearInterval: (h: unknown) => { live.delete(h as () => void); } },
    fire: () => { for (const cb of live) cb(); },
  };
};

test("a Slack post that hits the rate limit waits retry-after seconds, retries, and lands in the thread", async () => {
  const { http, seen } = fakeHttp((_, n) => (n === 1 ? ok({ ok: false, error: "ratelimited" }, 429, { "retry-after": "3" }) : ok({ ok: true, channel: "C1", ts: "111.222" })));
  const { clock, waited } = sleeps();
  const posted = await new Slack(http, clock, { token: "t" }).post("C1", "deploy finished", "100.1");
  expect(posted).toEqual({ channel: "C1", ts: "111.222" });
  expect(waited).toEqual([3000]);
  expect(JSON.parse(String(seen[1]?.body))).toEqual({ channel: "C1", text: "deploy finished", thread_ts: "100.1" });
});

test("a Slack error that is not transient fails at once with the API error, without retries", async () => {
  const { http, seen } = fakeHttp(() => ok({ ok: false, error: "channel_not_found" }));
  const err = await new Slack(http, sleeps().clock, { token: "t" }).edit("C9", "1.2", "x").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(MessengerError);
  expect((err as MessengerError).code).toBe("channel_not_found");
  expect(seen).toHaveLength(1);
});

test("text carrying a $( substitution is refused before any request goes out, on every platform", async () => {
  const { http, seen } = fakeHttp(() => ok({ ok: true }));
  const clock = sleeps().clock;
  await expect(new Slack(http, clock, { token: "t" }).post("C1", "result: $(whoami)")).rejects.toBeInstanceOf(UnsafeMessageError);
  await expect(new Telegram(http, clock, "b").send({ chatId: 1 }, "$(id)")).rejects.toBeInstanceOf(UnsafeMessageError);
  await expect(new Discord(http, clock, "b").send("9", "x $(ls)")).rejects.toBeInstanceOf(UnsafeMessageError);
  expect(seen).toHaveLength(0);
});

test("a Slack upload asks for an upload URL per file, sends the bytes there, then shares all files as one message into the thread", async () => {
  let slots = 0;
  const { http, seen } = fakeHttp((req) => {
    if (req.url.endsWith("files.getUploadURLExternal")) return ok({ ok: true, upload_url: `https://files.example/up/${++slots}`, file_id: `F${slots}` });
    if (req.url.startsWith("https://files.example")) return { status: 200, headers: {}, body: "OK" };
    if (req.url.endsWith("files.info")) return ok({ ok: true, file: { shares: { public: { C1: [{ ts: "5.7", thread_ts: "5.6" }] } } } });
    return ok({ ok: true });
  });
  const file = (filename: string, bytes: number[]) => ({ filename, length: bytes.length, read: async () => new Uint8Array(bytes) });
  const files = [file("report.png", [1, 2, 3]), file("deck.pdf", [4])];
  const r = await new Slack(http, sleeps().clock, { token: "t" }).upload("C1", files, "5.6", "the deck");
  expect(r).toEqual({ ids: ["F1", "F2"], ts: "5.7" });
  expect(seen.map((r) => r.url.split("/").pop())).toEqual(["files.getUploadURLExternal", "1", "files.getUploadURLExternal", "2", "files.completeUploadExternal", "files.info"]);
  expect(JSON.parse(String(seen[2]?.body))).toEqual({ filename: "deck.pdf", length: 1 });
  expect(JSON.parse(String(seen[4]?.body))).toEqual({ files: [{ id: "F1", title: "report.png" }, { id: "F2", title: "deck.pdf" }], channel_id: "C1", thread_ts: "5.6", initial_comment: "the deck" });
});

test("a Slack share in the channel asks files.info, a second apart, until it lists the share's ts; without files:read it says why it is untracked", async () => {
  const file = { filename: "a.pdf", length: 1, read: async () => new Uint8Array([1]) };
  const slot = (req: HttpRequest) => (req.url.endsWith("files.getUploadURLExternal") ? ok({ ok: true, upload_url: "https://files.example/up/1", file_id: "F1" }) : req.url.startsWith("https://files.example") ? { status: 200, headers: {}, body: "OK" } : undefined);
  let infos = 0;
  const listed = fakeHttp((req) => slot(req) ?? (req.url.endsWith("files.info") ? ok({ ok: true, file: { shares: ++infos < 3 ? {} : { private: { C1: [{ ts: "9.1" }] } } } }) : ok({ ok: true })));
  const { clock, waited } = sleeps();
  expect(await new Slack(listed.http, clock, { token: "t" }).upload("C1", [file])).toEqual({ ids: ["F1"], ts: "9.1" });
  expect([infos, waited]).toEqual([3, [1000, 1000]]);
  const scopeless = fakeHttp((req) => slot(req) ?? (req.url.endsWith("files.info") ? ok({ ok: false, error: "missing_scope" }) : ok({ ok: true })));
  expect(await new Slack(scopeless.http, sleeps().clock, { token: "t" }).upload("C1", [file])).toEqual({ ids: ["F1"], untracked: "slack files.info: missing_scope" });
});

// the Dori shares at 1700000000.2 and its complete call returns at 1700000005; a reply at 1700000001 lies in between
for (const [how, info, cursor] of [
  ["the share's ts from files.info", () => ok({ ok: true, file: { shares: { private: { C1: [{ ts: "1700000000.200000", thread_ts: "1700000000.000100" }] } } } }), "1700000000.200000"],
  ["the moment before the first request when files.info answers no JSON", () => ({ status: 200, headers: {}, body: "<html>bad gateway</html>" }), "1700000000.000000"],
] as const) {
  test(`a file share in a thread keeps ${how} as the thread's cursor, so a reply that came while the upload finished is still polled`, async () => {
    const state = withState();
    try {
      const ledger = new ThreadLedger(join(state.dir, "slack-threads.json"));
      let at = 1_700_000_000_000;
      const clock = { now: () => at, sleep: async () => {} };
      const { http } = fakeHttp((req) => {
        if (req.url.endsWith("files.getUploadURLExternal")) return ok({ ok: true, upload_url: "https://files.example/up/1", file_id: "F1" });
        if (req.url.startsWith("https://files.example")) return { status: 200, headers: {}, body: "OK" };
        if (req.url.endsWith("files.completeUploadExternal")) {
          at = 1_700_000_005_000;
          return ok({ ok: true });
        }
        if (req.url.endsWith("files.info")) return info();
        if (req.url.endsWith("conversations.replies")) {
          const oldest = Number(JSON.parse(String(req.body)).oldest);
          return ok({ ok: true, messages: [{ ts: "1700000001.000000", user: "UGUEST", text: "고마워" }].filter((x) => Number(x.ts) > oldest) });
        }
        return ok({ ok: true });
      });
      const slack = new Slack(http, clock, { token: "t" }, undefined, ledger);
      const r = await slack.upload("C1", [{ filename: "a.pdf", length: 1, read: async () => new Uint8Array([1]) }], "1700000000.000100");
      expect({ ids: r.ids, untracked: r.untracked, cursor: (await ledger.list()).map((t) => [t.rootTs, t.seenTs]) }).toEqual({ ids: ["F1"], untracked: undefined, cursor: [["1700000000.000100", cursor]] });
      expect((await pollSlackInbound(slack, ledger, { selfUserId: "UBOT" })).map((i) => [i.source, i.ts])).toEqual([["own-thread", "1700000001.000000"]]);
    } finally {
      state.done();
    }
  });
}

test("a file changed after it was checked, even to the same size, stops the upload before anything is shared", async () => {
  const state = withState();
  try {
    const p = join(state.dir, "deck.pdf");
    writeFileSync(p, "aaaa");
    const [u] = await readUploads([p]);
    writeFileSync(p, "bbbb");
    await expect(u?.read() ?? Promise.resolve()).rejects.toThrow("SEND_FILE_CHANGED");
  } finally {
    state.done();
  }
});

test("a Slack upload whose text carries a $( substitution is refused before any file goes out", async () => {
  const { http, seen } = fakeHttp(() => ok({ ok: true }));
  const file = { filename: "a.pdf", length: 1, read: async () => new Uint8Array([1]) };
  await expect(new Slack(http, sleeps().clock, { token: "t" }).upload("C1", [file], undefined, "deck $(whoami)")).rejects.toBeInstanceOf(UnsafeMessageError);
  expect(seen).toHaveLength(0);
});

test("a Telegram reply starts as Thinking…, streams drafts no faster than the interval, then persists as a real message", async () => {
  const { http, seen } = fakeHttp((req) => ok({ ok: true, result: req.url.endsWith("sendMessage") ? { message_id: 77 } : true }));
  const clock = fakeClock(10_000);
  const tg = new Telegram(http, clock, "b");
  const s = await startThinking(tg, clock, { chatId: 5, threadId: 9 });
  clock.at += 100;
  await s.push("Half");
  clock.at += 900;
  await s.push("Half done");
  const id = await s.finish("All done");
  const calls = seen.map((r) => [r.url.split("/").pop(), JSON.parse(String(r.body)).text]);
  expect(calls).toEqual([["sendMessageDraft", THINKING], ["sendMessageDraft", "Half done"], ["sendMessage", "All done"]]);
  expect(id).toBe(77);
  expect(JSON.parse(String(seen[0]?.body)).message_thread_id).toBe(9);
});

test("a Telegram forum topic is created, renamed, closed and reopened by its thread id, and a send into it carries that id", async () => {
  const { http, seen } = fakeHttp((req) => ok({ ok: true, result: req.url.endsWith("createForumTopic") ? { message_thread_id: 41 } : req.url.endsWith("sendMessage") ? { message_id: 3 } : true }));
  const tg = new Telegram(http, fakeClock(0), "b");
  const topic = await tg.createTopic(5, "fix-login");
  await tg.send({ chatId: 5, threadId: topic }, "started");
  await tg.renameTopic(5, topic, "fix-login (done)");
  await tg.closeTopic(5, topic);
  await tg.reopenTopic(5, topic);
  const calls = seen.map((r) => [r.url.split("/").pop(), JSON.parse(String(r.body)).message_thread_id ?? null, JSON.parse(String(r.body)).name ?? null]);
  expect(calls).toEqual([["createForumTopic", null, "fix-login"], ["sendMessage", 41, null], ["editForumTopic", 41, "fix-login (done)"], ["closeForumTopic", 41, null], ["reopenForumTopic", 41, null]]);
});

test("Telegram's retry_after in the error body is honored", async () => {
  const { http } = fakeHttp((_, n) => (n === 1 ? ok({ ok: false, error_code: 429, parameters: { retry_after: 7 } }, 429) : ok({ ok: true, result: { message_id: 1 } })));
  const { clock, waited } = sleeps();
  await new Telegram(http, clock, "b").send({ chatId: 1 }, "hi");
  expect(waited).toEqual([7000]);
});

test("a rich Telegram table escapes HTML and lines columns up inside one pre block", () => {
  expect(htmlTable(["name", "n"], [["a<b", "10"], ["c", "2"]])).toBe("<pre>name  n \n----  --\na&lt;b   10\nc     2 </pre>");
});

test("Discord messages are sent without pinging anyone and edited in place; threads are named and archived", async () => {
  const { http, seen } = fakeHttp((req) => ok(req.method === "POST" && req.url.endsWith("/messages") ? { id: "M1" } : { id: "T1" }));
  const dc = new Discord(http, sleeps().clock, "b");
  expect(await dc.send("C1", "hello @everyone")).toBe("M1");
  await dc.edit("C1", "M1", "hello again");
  expect(await dc.startThread("C1", "M1", "[working] fix login")).toBe("T1");
  await dc.setThread("T1", { name: "[done] fix login", archived: true });
  expect(JSON.parse(String(seen[0]?.body)).allowed_mentions).toEqual({ parse: [] });
  expect(seen.map((r) => `${r.method} ${r.url.replace("https://discord.com/api/v10", "")}`)).toEqual(["POST /channels/C1/messages", "PATCH /channels/C1/messages/M1", "POST /channels/C1/messages/M1/threads", "PATCH /channels/T1"]);
});

test("the typing indicator is sent at once, repeats while work runs, and stops when it ends even on failure", async () => {
  const sent: number[] = [];
  const t = fakeTimers();
  const send = async () => { sent.push(1); };
  const result = await typingWhile(send, t.timers, async () => { t.fire(); t.fire(); return 42; });
  expect(result).toBe(42);
  expect(sent).toHaveLength(3);
  expect(t.live.size).toBe(0);
  await expect(typingWhile(send, t.timers, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  expect(t.live.size).toBe(0);
});

test("a Discord post requests typing immediately before sending when enabled", async () => {
  const { http, seen } = fakeHttp(() => ok({ id: "M1" }));
  await new Discord(http, fakeClock(0), "b").send("T1", "hello", true);
  expect(seen.map((r) => r.url.replace("https://discord.com/api/v10", ""))).toEqual(["/channels/T1/typing", "/channels/T1/messages"]);
});

test("a Discord post skips typing when disabled", async () => {
  const { http, seen } = fakeHttp(() => ok({ id: "M1" }));
  await new Discord(http, fakeClock(0), "b").send("T1", "hello", false);
  expect(seen.map((r) => r.url.replace("https://discord.com/api/v10", ""))).toEqual(["/channels/T1/messages"]);
});

test("failed Discord typing is logged once and the post still lands", async () => {
  const { http } = fakeHttp((req) => req.url.endsWith("/typing") ? ok({ retry_after: 300 }, 429) : ok({ id: "M1" }));
  const logs: string[] = [];
  const original = console.error;
  console.error = (line: string) => { logs.push(line); };
  try {
    const result = await new Discord(http, fakeClock(0), "b").send("T1", "hello", true);
    expect({ result, logs: logs.map((s) => s.split(" ")[0]) }).toEqual({ result: "M1", logs: ["DISCORD_TYPING_FAIL"] });
  } finally {
    console.error = original;
  }
});

test("a voice note becomes text through the configured hook, and a failing or empty transcription is an error", async () => {
  const calls: string[][] = [];
  const run = async (argv: readonly string[]) => { calls.push([...argv]); return { code: 0, out: "  ship it  ", err: "" }; };
  expect(await transcribe(run, ["stt", "--file", "{file}"], "/tmp/v 1.ogg")).toBe("ship it");
  expect(calls[0]).toEqual(["stt", "--file", "/tmp/v 1.ogg"]);
  await expect(transcribe(async () => ({ code: 0, out: "", err: "" }), ["stt", "{file}"], "/a.ogg")).rejects.toBeInstanceOf(TranscriptionError);
  await expect(transcribe(run, undefined, "/a.ogg")).rejects.toBeInstanceOf(TranscriptionError);
});

test("a hook sees variables dori loaded from dori.env after start-up (e.g. the speech-to-text install dir)", async () => {
  process.env.DORI_TEST_FROM_ENV_FILE = "loaded-later";
  try {
    expect((await realRun(["sh", "-c", "printf %s \"$DORI_TEST_FROM_ENV_FILE\""])).out).toBe("loaded-later");
  } finally {
    delete process.env.DORI_TEST_FROM_ENV_FILE;
  }
});

test("Slack presence opens one client-type socket with the cookie, then only tickles it; release closes it and sets away", async () => {
  const { http, seen } = fakeHttp((req) => (req.url.endsWith("client.getWebSocketURL") ? ok({ ok: true, primary_websocket_url: "wss://wss-primary.example/", routing_context: "gw-1" }) : ok({ ok: true })));
  const frames: string[] = [];
  let opened: { url: string; headers: Record<string, string> } | null = null;
  let open = false;
  const p = slackPresence(new Slack(http, sleeps().clock, { token: "xt", cookie: "dc" }), (url, headers) => {
    opened = { url, headers: { ...headers } };
    open = true;
    return { isOpen: () => open, send: (f) => frames.push(f), close: () => { open = false; } };
  }, { token: "xt", cookie: "dc" });
  expect(await p.hold()).toBe("opened");
  expect(await p.hold()).toBe("tickled");
  expect(await p.hold()).toBe("tickled");
  const url = new URL(opened!.url);
  expect(url.searchParams.get("slack_client")).toBe("desktop");
  expect(url.searchParams.get("gateway_server")).toBe("gw-1");
  expect(opened!.headers).toEqual({ Cookie: "d=dc", Origin: "https://app.slack.com" });
  expect(frames.map((f) => JSON.parse(f).type)).toEqual(["tickle", "tickle"]);
  await p.release();
  expect(open).toBe(false);
  expect(seen.filter((r) => r.url.endsWith("users.setPresence")).map((r) => JSON.parse(String(r.body)).presence)).toEqual(["auto", "away"]);
});

test("Discord presence identifies as online after hello, heartbeats with the last sequence, and stops beating on close", () => {
  const sent: string[] = [];
  let onMsg: (d: string) => void = () => {};
  const t = fakeTimers();
  let closed = false;
  const p = discordPresence(() => ({ send: (d) => sent.push(d), close: () => { closed = true; }, onMessage: (cb) => { onMsg = cb; } }), "BOT", t.timers);
  onMsg(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }));
  onMsg(JSON.stringify({ op: 0, s: 3, t: "READY", d: {} }));
  t.fire();
  const identify = JSON.parse(sent[0] ?? "{}");
  expect(identify.op).toBe(2);
  expect(identify.d.presence.status).toBe("online");
  expect(JSON.parse(sent[1] ?? "{}")).toEqual({ op: 1, d: 3 });
  p.close();
  expect(closed).toBe(true);
  expect(t.live.size).toBe(0);
});

// upstream dori-superagent #76 (https://github.com/sisyphuslabs/dori-superagent/pull/76, closes its issue #74): its test, with the
// state dir removed after the file (upstream leaves an empty afterEach)
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Http, HttpRequest, HttpResponse } from "../src/messenger/http.ts";
import type { TgInbound } from "../src/messenger/telegram-inbound.ts";
import { Telegram } from "../src/messenger/telegram.ts";
import { envInt, fileTgInboundStore, pollTelegramInbound, telegramInboundLoop, writeLineSync } from "../src/messenger/telegram-inbound.ts";
import { fakeClock, withState } from "./fakes.ts";

const OWNER = 5250;
const OTHER = 6612;
const GROUP = -1004;
const TOPIC = 3;

const state = withState();
afterAll(() => state.done());

type U = { update_id: number; message?: unknown; edited_message?: unknown };

const msg = (from: number, chatId: number, type: string, text: string, thread?: number, isTopicMessage?: boolean) => ({
  message_id: 1,
  from: { id: from, is_bot: false, username: from === OWNER ? "owner" : "someone" },
  chat: { id: chatId, type },
  ...(thread === undefined ? {} : { message_thread_id: thread }),
  ...(isTopicMessage === undefined ? {} : { is_topic_message: isTopicMessage }),
  text,
});

const telegramFake = (batches: U[][]) => {
  const bodies: Record<string, unknown>[] = [];
  const http: Http = async (req: HttpRequest): Promise<HttpResponse> => {
    bodies.push(JSON.parse(String(req.body ?? "{}")) as Record<string, unknown>);
    const batch = batches.shift() ?? [];
    return { status: 200, headers: {}, body: JSON.stringify({ ok: true, result: batch }) };
  };
  return { http, bodies };
};

const mk = (http: Http): Telegram => new Telegram(http, fakeClock(0), "T");

test("owner DMs pass, non-owner and bot messages drop, offset still advances", async () => {
  const { http, bodies } = telegramFake([
    [
      { update_id: 10, message: msg(OWNER, OWNER, "private", "hi") },
      { update_id: 11, message: msg(OTHER, OTHER, "private", "intruder") },
      { update_id: 12, message: { message_id: 1, from: { id: 777, is_bot: true }, chat: { id: OWNER, type: "private" }, text: "bot ping" } },
    ],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-1"));
  const out = await pollTelegramInbound(mk(http), store, { ownerId: OWNER, groupChatId: GROUP, topicId: TOPIC });
  expect(out.length).toBe(1);
  expect(out[0]!.source).toBe("dm");
  expect(out[0]!.text).toBe("hi");
  expect(out[0]!.updateId).toBe(10);
  // Offset persisted past ALL updates, including the dropped ones — no replay, no loss.
  expect(store.load()).toBe(13);
  expect(bodies[0]!.offset).toBe(0);
});

test("configured topic passes, other topics and other groups drop", async () => {
  const { http } = telegramFake([
    [
      { update_id: 20, message: msg(OWNER, GROUP, "supergroup", "in topic", TOPIC, true) },
      { update_id: 21, message: msg(OWNER, GROUP, "supergroup", "wrong topic", 555, true) },
      { update_id: 22, message: msg(OWNER, -999, "supergroup", "wrong group", TOPIC, true) },
    ],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-2"));
  const out = await pollTelegramInbound(mk(http), store, { ownerId: OWNER, groupChatId: GROUP, topicId: TOPIC });
  expect(out.length).toBe(1);
  expect(out[0]!.source).toBe("topic");
  expect(out[0]!.thread).toBe(TOPIC);
  expect(out[0]!.text).toBe("in topic");
  expect(store.load()).toBe(23);
});

test("a reply in the General topic counts as topic 1, not its reply-root id", async () => {
  const { http } = telegramFake([
    [
      // Direct post in General: no thread markers at all.
      { update_id: 30, message: msg(OWNER, GROUP, "supergroup", "general post") },
      // Reply inside General: message_thread_id is the reply ROOT's id (not a topic id),
      // and is_topic_message is false — telegram-bot-api#447.
      { update_id: 31, message: msg(OWNER, GROUP, "supergroup", "general reply", 1234, false) },
    ],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-3"));
  const out = await pollTelegramInbound(mk(http), store, { ownerId: OWNER, groupChatId: GROUP, topicId: 1 });
  expect(out.length).toBe(2);
  expect(out[0]!.thread).toBe(1);
  expect(out[1]!.thread).toBe(1);
});

test("a private chat run with topics carries the topic on DMs", async () => {
  const { http } = telegramFake([
    [
      { update_id: 40, message: msg(OWNER, OWNER, "private", "plain dm") },
      { update_id: 41, message: msg(OWNER, OWNER, "private", "dm in topic 7", 7, true) },
    ],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-4"));
  const out = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(out.length).toBe(2);
  expect(out[0]!.thread).toBeUndefined();
  expect(out[1]!.source).toBe("dm");
  expect(out[1]!.thread).toBe(7);
});

test("without a configured group only DMs arrive", async () => {
  const { http } = telegramFake([[{ update_id: 50, message: msg(OWNER, GROUP, "supergroup", "group msg", TOPIC, true) }]]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-5"));
  const out = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(out.length).toBe(0);
});

test("restart resumes from the persisted offset", async () => {
  const { http, bodies } = telegramFake([[], [{ update_id: 60, message: msg(OWNER, OWNER, "private", "after restart") }]]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-6"));
  store.save(60); // what a previous run persisted
  const first = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(first.length).toBe(0);
  expect(bodies[0]!.offset).toBe(60);
  const second = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(second.length).toBe(1);
  expect(second[0]!.updateId).toBe(60);
  expect(bodies[1]!.offset).toBe(60);
  expect(store.load()).toBe(61);
});

test("a crash mid-emit replays the unprinted message, not the printed one", async () => {
  const { http, bodies } = telegramFake([
    [{ update_id: 70, message: msg(OWNER, OWNER, "private", "first") }],
    [
      { update_id: 71, message: msg(OWNER, OWNER, "private", "second") },
      { update_id: 72, message: msg(OWNER, OWNER, "private", "third") },
    ],
    [
      { update_id: 71, message: msg(OWNER, OWNER, "private", "second") },
      { update_id: 72, message: msg(OWNER, OWNER, "private", "third") },
    ],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-7"));
  // First poll: prints "first", offset advances past it.
  const seen1: string[] = [];
  await pollTelegramInbound(mk(http), store, { ownerId: OWNER }, (i) => seen1.push(i.text ?? ""));
  expect(seen1).toEqual(["first"]);
  expect(store.load()).toBe(71);
  // Second poll: emit throws on "second" — offset must stay before it.
  await expect(
    pollTelegramInbound(mk(http), store, { ownerId: OWNER }, () => {
      throw new Error("print died");
    }),
  ).rejects.toThrow("print died");
  expect(store.load()).toBe(71); // not advanced past 71
  // Third poll restarts from 71 and returns the unprinted messages again.
  const seen3: string[] = [];
  const out3 = await pollTelegramInbound(mk(http), store, { ownerId: OWNER }, (i) => seen3.push(i.text ?? ""));
  expect(seen3).toEqual(["second", "third"]);
  expect(out3.map((i) => i.updateId)).toEqual([71, 72]);
  expect(bodies[2]!.offset).toBe(71);
  expect(store.load()).toBe(73);
});

test("the store creates its state dir on first save", async () => {
  const { http } = telegramFake([[{ update_id: 80, message: msg(OWNER, OWNER, "private", "fresh install") }]]);
  const store = fileTgInboundStore(join(state.dir, "nested", "deeper", "tg-off-8"));
  const out = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(out.length).toBe(1);
  expect(store.load()).toBe(81);
});

// review 1 of #350: dori inbound telegram itself. A line that cannot be written leaves the offset before its message, and
// a blank or out-of-range id is refused before any call.
// review 2 of #350: a Telegram setting in the shell running the tests is not the test's
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DORI_TELEGRAM_")));
const inbound = async (vars: Record<string, string>, tail = "", batch: U[] = [{ update_id: 90, message: msg(OWNER, OWNER, "private", "owner dm") }]) => {
  const dir = mkdtempSync(join(state.dir, "cli-"));
  const log = join(dir, "http.log");
  writeFileSync(log, "");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ stateDir: join(dir, "state") }));
  writeFileSync(join(dir, "batch.json"), JSON.stringify(batch));
  const argv = ["bun", "--preload", join(import.meta.dir, "telegram-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"), "inbound", "telegram"];
  const p = Bun.spawn(["bash", "-c", `"$@"${tail}`, "inbound", ...argv], {
    env: { ...inherited, DORI_CONFIG: join(dir, "config.json"), DORI_ENV_FILE: join(dir, "missing.env"), DORI_STATE_DIR: join(dir, "state"), DORI_TEST_TG_LOG: log, DORI_TEST_TG_BATCH: join(dir, "batch.json"), DORI_TELEGRAM_TOKEN: "fake", DORI_TELEGRAM_OWNER_ID: String(OWNER), ...vars },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const offsetFile = join(dir, "state", "telegram-offset");
  return { code, out: out.trim(), err: err.trim(), calls: readFileSync(log, "utf8").split("\n").filter(Boolean).length, offset: existsSync(offsetFile) ? readFileSync(offsetFile, "utf8") : undefined };
};

test("dori inbound telegram prints the owner's message and then moves the offset past it", async () => {
  expect(await inbound({})).toMatchObject({ code: 0, out: `INBOUND_READY telegram owner=${OWNER} group=- topic=-\nINBOUND dm ${OWNER} - 90 ${OWNER} "owner dm"`, calls: 1, offset: "91" });
});

test("a line that cannot be written (stdout closed) keeps the offset before its message", async () => {
  const closed = join(mkdtempSync(join(state.dir, "closed-")), "stdout-closed");
  const r = await inbound({ DORI_TEST_TG_AFTER: closed }, ` | { exec 0<&-; : > '${closed}'; }`);
  expect({ calls: r.calls, offset: r.offset }).toEqual({ calls: 1, offset: undefined });
});

test.each([
  ["a blank owner id", { DORI_TELEGRAM_OWNER_ID: "" }, 'DORI_TELEGRAM_OWNER_ID must be an integer, got: ""'],
  ["a whitespace owner id", { DORI_TELEGRAM_OWNER_ID: "  " }, 'DORI_TELEGRAM_OWNER_ID must be an integer, got: "  "'],
  ["owner id 0", { DORI_TELEGRAM_OWNER_ID: "0" }, 'DORI_TELEGRAM_OWNER_ID must be a positive user id, got: "0"'],
  ["a blank group id", { DORI_TELEGRAM_GROUP_ID: "" }, 'DORI_TELEGRAM_GROUP_ID must be an integer, got: ""'],
  ["a blank topic id", { DORI_TELEGRAM_GROUP_ID: String(GROUP), DORI_TELEGRAM_TOPIC_ID: "" }, 'DORI_TELEGRAM_TOPIC_ID must be an integer, got: ""'],
  ["topic id 0", { DORI_TELEGRAM_GROUP_ID: String(GROUP), DORI_TELEGRAM_TOPIC_ID: "0" }, 'DORI_TELEGRAM_TOPIC_ID must be a positive topic id, got: "0"'],
] as const)("dori inbound telegram refuses %s before any call", async (_, vars, err) => {
  expect(await inbound(vars)).toEqual({ code: 1, out: "", err, calls: 0, offset: undefined });
});

// review 2 of #350: a write that takes only part of the line is continued until all of it is out; no progress or an
// error throws, so pollTelegramInbound keeps the offset before that message
test("writeLineSync finishes a line written a few bytes at a time", () => {
  const out: string[] = [];
  const n = writeLineSync("INBOUND dm 1 - 2 3 \"héllo\"\n", 1, (_fd, buf, off, len) => { const k = Math.min(3, len); out.push(Buffer.from(buf.subarray(off, off + k)).toString("latin1")); return k; });
  expect(Buffer.from(out.join(""), "latin1").toString("utf8")).toBe("INBOUND dm 1 - 2 3 \"héllo\"\n");
  expect(n).toBe(Buffer.byteLength("INBOUND dm 1 - 2 3 \"héllo\"\n"));
});

test.each([
  ["no progress", "tg-off-short-1", (_fd: number, _buf: Uint8Array, off: number): number => (off === 0 ? 4 : 0)],
  ["an error after part of the line", "tg-off-short-2", (_fd: number, _buf: Uint8Array, off: number): number => { if (off > 0) throw new Error("EIO"); return 4; }],
] as const)("a line cut short by %s keeps the offset before its message", async (_, file, write) => {
  const { http } = telegramFake([[{ update_id: 95, message: msg(OWNER, OWNER, "private", "cut short") }]]);
  const store = fileTgInboundStore(join(state.dir, file));
  store.save(95);
  await expect(pollTelegramInbound(mk(http), store, { ownerId: OWNER }, (i) => { writeLineSync(`${i.text}\n`, 1, write); })).rejects.toThrow();
  expect(store.load()).toBe(95);
});

// upstream dori-superagent #79 (https://github.com/sisyphuslabs/dori-superagent/pull/79, closes its issue #77): its tests,
// as merged there; the state dir stays shared (each test has its own offset file) and is removed after the file
test("edited messages arrive as their own edit kind with the edited text", async () => {
  const { http, bodies } = telegramFake([
    [{ update_id: 90, edited_message: { ...msg(OWNER, OWNER, "private", "fixed typo"), edit_date: 1730 } }],
    [{ update_id: 91, message: msg(OWNER, OWNER, "private", "fresh after edit") }],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-9"));
  const out = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(out.length).toBe(1);
  expect(out[0]!.kind).toBe("edit");
  expect(out[0]!.text).toBe("fixed typo");
  expect(store.load()).toBe(91);
  expect(bodies[0]!.allowed_updates).toEqual(["message", "edited_message"]);
  const second = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(second[0]!.kind).toBe("message");
});

test("a voice note identifies its media so transcribe can fetch it", async () => {
  const { http } = telegramFake([
    [{ update_id: 100, message: { message_id: 55, from: { id: OWNER, is_bot: false, username: "owner" }, chat: { id: OWNER, type: "private" }, voice: { file_id: "FID_VOICE", duration: 9 } } }],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-10"));
  const out = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(out.length).toBe(1);
  expect(out[0]!.kind).toBe("message");
  expect(out[0]!.text).toBeUndefined();
  expect(out[0]!.media).toEqual({ kind: "voice", fileId: "FID_VOICE", messageId: 55 });
  expect(store.load()).toBe(101);
});

test("a photo with a caption carries both the text and the largest photo", async () => {
  const { http } = telegramFake([
    [{ update_id: 110, message: { message_id: 56, from: { id: OWNER, is_bot: false, username: "owner" }, chat: { id: OWNER, type: "private" }, photo: [{ file_id: "SMALL" }, { file_id: "LARGE" }], caption: "look at this" } }],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-11"));
  const out = await pollTelegramInbound(mk(http), store, { ownerId: OWNER });
  expect(out.length).toBe(1);
  expect(out[0]!.text).toBe("look at this");
  expect(out[0]!.media).toEqual({ kind: "photo", fileId: "LARGE", messageId: 56 });
});

test("an unparseable offset warns once across several polls and restarts from 0", async () => {
  writeFileSync(join(state.dir, "telegram-offset"), "not-a-number");
  const warns: string[] = [];
  const orig = console.error;
  console.error = (s?: unknown) => {
    warns.push(String(s));
  };
  try {
    const store = fileTgInboundStore(join(state.dir, "telegram-offset"));
    // Three polls, no updates: nothing saves over the corrupt file, every poll loads it.
    const { http } = telegramFake([[], [], []]);
    const tg = mk(http);
    for (let i = 0; i < 3; i++) await pollTelegramInbound(tg, store, { ownerId: OWNER });
    expect(store.load()).toBe(0);
  } finally {
    console.error = orig;
  }
  expect(warns).toHaveLength(1);
  expect(warns[0]).toContain("WARN");
  expect(warns[0]).toContain("unparseable");
});

test("envInt refuses empty, whitespace, 1e3 and 0x10; accepts plain integers", () => {
  for (const v of ["", "   ", "1e3", "0x10", "12.5", "abc", "99999999999999999999"]) {
    expect(() => envInt("DORI_TELEGRAM_OWNER_ID", v)).toThrow(`DORI_TELEGRAM_OWNER_ID must be an integer, got: ${JSON.stringify(v)}`);
  }
  expect(() => envInt("DORI_TELEGRAM_OWNER_ID", undefined)).toThrow("DORI_TELEGRAM_OWNER_ID is not set");
  expect(envInt("DORI_TELEGRAM_OWNER_ID", " 42 ")).toBe(42);
  expect(envInt("DORI_TELEGRAM_TOPIC_ID", "-5")).toBe(-5);
  expect(envInt("DORI_TELEGRAM_GROUP_ID", "0")).toBe(0);
});

test("one-shot (no --loop) returns after a single bounded poll under continuous traffic", async () => {
  // Continuous traffic: every poll would return another message if polled again.
  const { http } = telegramFake(Array.from({ length: 20 }, (_, i) => [{ update_id: 100 + i, message: msg(OWNER, OWNER, "private", `msg ${i}`) }]));
  const store = fileTgInboundStore(join(state.dir, "tg-off-oneshot"));
  const out: TgInbound[] = [];
  await telegramInboundLoop(mk(http), store, { ownerId: OWNER }, 0, (i) => out.push(i));
  // Returns, and drained exactly one poll's batch — not the whole stream.
  expect(out).toHaveLength(1);
  expect(out[0]!.updateId).toBe(100);
});

test("--loop re-polls immediately after a productive poll and sleeps only when idle", async () => {
  const { http } = telegramFake([
    [{ update_id: 200, message: msg(OWNER, OWNER, "private", "burst") }],
    [],
  ]);
  const store = fileTgInboundStore(join(state.dir, "tg-off-loop"));
  const out: TgInbound[] = [];
  const sleeps: number[] = [];
  const stop = new Error("STOP");
  // The first idle sleep throws to end the loop for the test.
  await telegramInboundLoop(
    mk(http),
    store,
    { ownerId: OWNER },
    1,
    (i) => out.push(i),
    () => {},
    async (ms) => {
      sleeps.push(ms);
      throw stop;
    },
  ).catch((e: unknown) => {
    if (e !== stop) throw e;
  });
  expect(out.map((i) => i.updateId)).toEqual([200]); // productive poll, then immediate re-poll
  expect(sleeps).toEqual([60_000]); // slept only after the idle poll
});

// the fork's addition: dori inbound telegram itself prints the edit kind and the media file id on the line
test("dori inbound telegram prints an edit as edit:dm and a media message with file=<kind>:<file_id>", async () => {
  const batch: U[] = [
    { update_id: 120, edited_message: { ...msg(OWNER, OWNER, "private", "fixed typo"), edit_date: 1730 } },
    { update_id: 121, message: { message_id: 57, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: "private" }, voice: { file_id: "FID_VOICE" } } },
    { update_id: 122, message: { message_id: 58, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: "private" }, photo: [{ file_id: "SMALL" }, { file_id: "LARGE" }], caption: "look" } },
  ];
  expect(await inbound({}, "", batch)).toMatchObject({
    code: 0,
    out: [
      `INBOUND_READY telegram owner=${OWNER} group=- topic=-`,
      `INBOUND edit:dm ${OWNER} - 120 ${OWNER} "fixed typo"`,
      `INBOUND dm ${OWNER} - 121 ${OWNER} "" file=voice:FID_VOICE`,
      `INBOUND dm ${OWNER} - 122 ${OWNER} "look" file=photo:LARGE`,
    ].join("\n"),
    calls: 1,
    offset: "123",
  });
});

test("dori inbound telegram refuses an id written as 1e3 or 0x10 before any call", async () => {
  expect(await inbound({ DORI_TELEGRAM_OWNER_ID: "1e3" })).toEqual({ code: 1, out: "", err: 'DORI_TELEGRAM_OWNER_ID must be an integer, got: "1e3"', calls: 0, offset: undefined });
  expect(await inbound({ DORI_TELEGRAM_GROUP_ID: "0x10" })).toEqual({ code: 1, out: "", err: 'DORI_TELEGRAM_GROUP_ID must be an integer, got: "0x10"', calls: 0, offset: undefined });
});

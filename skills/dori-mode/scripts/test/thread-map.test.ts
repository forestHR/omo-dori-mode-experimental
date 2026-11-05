import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dropThread, mapThread, threads } from "../src/messenger/thread-map.ts";
import { withState } from "./fakes.ts";

const ID = "300000000000000003";
const REF = `discord:${ID}`;
let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

test("a missing thread map is empty", () => {
  expect(threads(state.dir)).toEqual({});
});

test("mapping a session preserves a carried-over title and writes privately without leftover temp files", () => {
  writeFileSync(join(state.dir, "threads.json"), JSON.stringify({ [ID]: { session: "old", title: "fix login" } }), { mode: 0o600 });
  mapThread(state.dir, ID, "new");
  expect({ map: threads(state.dir), files: readdirSync(state.dir), mode: statSync(join(state.dir, "threads.json")).mode & 0o777 }).toEqual({
    map: { [ID]: { session: "new", title: "fix login" } }, files: ["threads.json"], mode: 0o600,
  });
});

test("a new mapping accepts a null session and a later drop removes it", () => {
  mapThread(state.dir, ID, null, "fix login");
  const opened = threads(state.dir);
  dropThread(state.dir, ID);
  expect({ opened, closed: threads(state.dir) }).toEqual({ opened: { [ID]: { session: null, title: "fix login" } }, closed: {} });
});

let discordWords: Record<string, unknown> = {};
// the ledger dori thread open reads: one rule for every lane, one a word calls
const rule = (id: string, scope: Record<string, unknown>, text: string) => ({ id, name: id, by: "lead", rule: text, basis: "test", date: "2026-11-02", source: "test", mode: "inject", scope });
const LEDGER = JSON.stringify({ entries: [rule("every-lane", { all: true }, "Every lane rule."), rule("login-rule", { keywords: ["login"] }, "Login work keeps SSO."), rule("card-rule", { keywords: ["카드"] }, "Card papers are ours.")] });
let ledgerText = LEDGER;
let localText: string | undefined;
beforeEach(() => { ledgerText = LEDGER; localText = undefined; });
const dori = async (...args: string[]) => {
  const config = join(state.dir, "config.json");
  writeFileSync(join(state.dir, "ledger.json"), ledgerText);
  if (localText !== undefined) writeFileSync(join(state.dir, "local.json"), localText);
  writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, discord: { statusStyle: "emoji", ...discordWords }, directives: { common: join(state.dir, "ledger.json"), local: localText === undefined ? "" : join(state.dir, "local.json") } }));
  const p = Bun.spawn(["bun", "--preload", join(import.meta.dir, "discord-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { ...process.env, DORI_CONFIG: config, DORI_ENV_FILE: join(state.dir, "missing.env"), DORI_STATE_DIR: state.dir, DORI_DISCORD_STATE_DIR: join(state.dir, "cards"), DORI_DISCORD_TOKEN: "fake", DORI_DISCORD_CHANNEL: "200000000000000002", DORI_TEST_HTTP: join(state.dir, "http.json") },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out: out.trim(), err: err.trim() };
};
const cli = (...args: string[]) => dori("thread", ...args);
const http = (): { name: string; archived: boolean; calls: { method: string; path: string; body: Record<string, unknown> }[] } => JSON.parse(readFileSync(join(state.dir, "http.json"), "utf8"));
const map = () => threads(join(state.dir, "cards"));

const OPENED = `THREAD_DIRECTIVES ${REF} 2: login-rule (keyword login), every-lane (all lanes); follow them in this thread's work\n[리드 규칙 login-rule] Login work keeps SSO.\n[리드 규칙 every-lane] Every lane rule.\nTHREAD_OPENED ${REF}`;

test("thread open creates a standalone marked thread, first message and session mapping", async () => {
  const result = await cli("open", "✅ 🔄 fix login", "--first", "Start here", "--session", "session-1");
  expect({ result, http: http(), map: map() }).toEqual({
    result: { code: 0, out: OPENED, err: "" },
    http: { name: "🔄 fix login", archived: false, calls: [
      { method: "POST", path: "/channels/200000000000000002/threads", body: { name: "🔄 fix login", type: 11, auto_archive_duration: 10080 } },
      { method: "POST", path: `/channels/${ID}/messages`, body: { content: "Start here", allowed_mentions: { parse: [] } } },
    ] }, map: { [ID]: { session: "session-1", title: "fix login", directives: ["login-rule", "every-lane"], openedAt: expect.any(String) } },
  });
});

test("thread open from a message does not post a standalone first message", async () => {
  const result = await cli("open", "fix login", "--from", "10001", "--first", "unused");
  expect({ result, calls: http().calls, map: map() }).toEqual({
    result: { code: 0, out: OPENED, err: "" },
    calls: [{ method: "POST", path: "/channels/200000000000000002/messages/10001/threads", body: { name: "🔄 fix login" } }],
    map: { [ID]: { session: null, title: "fix login", directives: ["login-rule", "every-lane"], openedAt: expect.any(String) } },
  });
});

// 2026-11-02: MooDori opened "Claude 10/29 카드 처리" from the owner's message with no lane brief and no directive read
test("thread open reads the owner's message it starts from in the inbox: the directives his words call are printed and kept", async () => {
  mkdirSync(join(state.dir, "discord"), { recursive: true });
  writeFileSync(join(state.dir, "discord", "inbox.jsonl"), `${JSON.stringify({ id: "10001", channel_id: "200000000000000002", scope: "channel", content: "그리고 카드처리해 서류 준비하고 있어" })}\n`);
  const result = await cli("open", "Claude 10/29 처리", "--from", "10001");
  expect({ out: result.out.split("\n")[0], directives: map()[ID]?.directives }).toEqual({
    out: `THREAD_DIRECTIVES ${REF} 2: card-rule (keyword 카드), every-lane (all lanes); follow them in this thread's work`, directives: ["card-rule", "every-lane"],
  });
});

test("thread open with a ledger it cannot read opens nothing: THREAD_REFUSED before Discord is called", async () => {
  ledgerText = "{ not json";
  const result = await cli("open", "fix login", "--first", "Start here");
  expect({ code: result.code, refused: result.err.startsWith("THREAD_REFUSED fix login: the directive ledger could not be read"), called: existsSync(join(state.dir, "http.json")), map: map() }).toEqual({ code: 1, refused: true, called: false, map: {} });
});

test("thread open with a broken host ledger opens nothing either, though the fork ledger reads fine (the host's own directives would be missing)", async () => {
  localText = "{ not json";
  const result = await cli("open", "fix login", "--first", "Start here");
  expect({ code: result.code, refused: result.err.startsWith("THREAD_REFUSED fix login: the directive ledger could not be read"), called: existsSync(join(state.dir, "http.json")), map: map() }).toEqual({ code: 1, refused: true, called: false, map: {} });
});

test("thread open refuses an empty standalone thread before calling Discord", async () => {
  const result = await cli("open", "fix login");
  expect({ code: result.code, called: existsSync(join(state.dir, "http.json")) }).toEqual({ code: 1, called: false });
});

test("thread map preserves the title, list shows it, and none clears the session without Discord", async () => {
  mapThread(join(state.dir, "cards"), ID, "old", "fix login");
  const mapped = await cli("map", REF, "new");
  const listed = await cli("list");
  const cleared = await cli("map", REF, "none");
  expect({ mapped, listed, cleared, map: map(), called: existsSync(join(state.dir, "http.json")) }).toEqual({
    mapped: { code: 0, out: `THREAD_MAPPED ${REF} new`, err: "" },
    listed: { code: 0, out: `${ID} new fix login`, err: "" },
    cleared: { code: 0, out: `THREAD_MAPPED ${REF} none`, err: "" },
    map: { [ID]: { session: null, title: "fix login" } }, called: false,
  });
});

test("thread set honors open-card, while done wins, archives and drops the map", async () => {
  await cli("open", "fix login", "--first", "Start");
  await cli("set", REF, "working", "--open-card");
  const waiting = http().name;
  const result = await cli("set", REF, "done", "--open-card");
  expect({ waiting, result, name: http().name, archived: http().archived, map: map() }).toEqual({
    waiting: "🔔 fix login", result: { code: 0, out: "", err: `THREAD_STATUS_APPLIED ${ID} done` }, name: "✅ fix login", archived: true, map: {},
  });
});

test("thread done keeps its existing posted output and removes the archived mapping", async () => {
  await cli("open", "fix login", "--first", "Start");
  const result = await cli("done", REF, "Finished");
  expect({ result, archived: http().archived, map: map() }).toEqual({
    result: { code: 0, out: expect.stringMatching(/^POSTED 900 len=8 sha=[0-9a-f]{8} first="Finished" THREAD_DONE$/), err: `THREAD_STATUS_APPLIED ${ID} done` }, archived: true, map: {},
  });
});

// another user of the thread, as the registry and the card store keep them
const openLane = (key: string, fields: Record<string, unknown> = {}) => {
  mkdirSync(join(state.dir, "lanes"), { recursive: true });
  writeFileSync(join(state.dir, "lanes", `${key}.json`), JSON.stringify({ key, title: key, brief: "/b.md", done: "file x", thread: REF, pane: `w:${key}`, openedAt: "2026-10-12T00:00:00Z", ...fields }));
};
// a lane dori close can close: no pane or tab to close, a Done signal that reads back live
const closable = (key: string) => openLane(key, { done: "file /etc/hostname", pane: undefined, cwd: state.dir });
const named = () => http().calls.filter((c) => c.method === "PATCH" && c.body.name).map((c) => c.body.name);
const openCard = (id: string) => {
  mkdirSync(join(state.dir, "cards"), { recursive: true });
  writeFileSync(join(state.dir, "cards", "questions.json"), JSON.stringify({ seq: 1, questions: [{ id, text: "Ship?", options: ["Yes", "No"], status: "open", thread: ID, askedAt: "2026-10-12T00:00:00Z" }] }));
};
const renamed = () => http().calls.filter((c) => c.method === "PATCH").length;
const SUMMARY = "The login page takes SSO now. Nothing is left; the nodes get it with the next update.";

test("thread done leaves a thread that another open lane uses as it is, but the closing lane itself is no other user (feature-verify 2026-10-12, follow-up b)", async () => {
  await cli("open", "fix login", "--first", "Start");
  openLane("lane-b");
  const left = await cli("done", REF, "lane-a finished");
  expect({ left, renames: renamed(), name: http().name, archived: http().archived }).toEqual({
    left: { code: 0, out: expect.stringMatching(new RegExp(`^POSTED 900 len=15 sha=[0-9a-f]{8} first="lane-a finished" THREAD_LEFT_OPEN ${REF}: open lane lane-b uses it; not marked done \\(--force marks it done anyway\\)$`)), err: "" }, renames: 0, name: "🔄 fix login", archived: false,
  });
  // lane-b's own close runs hooks.threadDone with DORI_CLOSING_LANE=lane-b (--lane says the same): that marks it done
  process.env.DORI_CLOSING_LANE = "lane-b";
  const own = await cli("done", REF, "lane-b finished").finally(() => delete process.env.DORI_CLOSING_LANE);
  expect({ own, archived: http().archived }).toEqual({ own: { code: 0, out: expect.stringMatching(/^POSTED 900 len=15 sha=[0-9a-f]{8} first="lane-b finished" THREAD_DONE$/), err: `THREAD_STATUS_APPLIED ${ID} done` }, archived: true });
});

test("thread done with an open card is left open, and --force marks it done with a warning", async () => {
  await cli("open", "fix login", "--first", "Start");
  openCard("Q1");
  const left = await cli("done", REF, "finished");
  expect({ out: left.out, renames: renamed() }).toEqual({ out: expect.stringMatching(new RegExp(`^POSTED 900 len=8 sha=[0-9a-f]{8} first="finished" THREAD_LEFT_OPEN ${REF}: open card Q1; not marked done \\(--force marks it done anyway\\)$`)), renames: 0 });
  // the same words again are not posted a second time (send-dedupe), and --force still marks the thread done
  const forced = await cli("done", REF, "finished", "--force");
  expect({ forced: { ...forced, out: forced.out.replace(/ \d+s ago/, " Ns ago") }, name: http().name, archived: http().archived }).toEqual({
    forced: { code: 0, out: `THREAD_DONE_FORCED ${REF}: open card Q1; marking it done anyway\nSEND_DUPLICATE ${REF} 900: the last post in ${REF} (900, Ns ago) has this same text; not sent again (build the text in the call that sends it; --again sends it once more) THREAD_DONE`, err: `THREAD_STATUS_APPLIED ${ID} done` }, name: "✅ fix login", archived: true,
  });
});

test("thread set done makes the same check: an open lane keeps the thread, --force marks it done with a warning", async () => {
  await cli("open", "fix login", "--first", "Start");
  openLane("lane-b");
  const left = await cli("set", REF, "done");
  expect({ left, renames: renamed(), archived: http().archived }).toEqual({
    left: { code: 0, out: `THREAD_LEFT_OPEN ${REF}: open lane lane-b uses it; not marked done (--force marks it done anyway)`, err: "" }, renames: 0, archived: false,
  });
  const forced = await cli("set", REF, "done", "--force");
  expect({ forced, archived: http().archived }).toEqual({
    forced: { code: 0, out: `THREAD_DONE_FORCED ${REF}: open lane lane-b uses it; marking it done anyway`, err: `THREAD_STATUS_APPLIED ${ID} done` }, archived: true,
  });
});

// feature-reverify 2026-10-13: the last working lane closed while a card stayed open, and the thread kept 🔄
test("closing the last working lane of a thread with an open card turns it waiting, not done", async () => {
  await cli("open", "fix login", "--first", "Start");
  openCard("Q1");
  closable("lane-a");
  const closed = await dori("close", "lane-a", "--summary", SUMMARY);
  expect({ code: closed.code, err: closed.err, names: named(), archived: http().archived }).toEqual({
    code: 0, err: `THREAD_STATUS_APPLIED ${ID} waiting`, names: ["🔔 fix login"], archived: false,
  });
  expect(closed.out).toContain("thread left open: open card Q1; summary posted\",\"waiting requested: applied");
});

// lead 2026-11-02 23:15 KST: the upstream-port thread stays open between ports
test("a thread set standing wears 📌, is listed as standing, and closing its last lane leaves it 📌 and unarchived", async () => {
  await cli("open", "fix login", "--first", "Start");
  const set = await cli("set", REF, "standing");
  expect({ out: set.out, name: http().name, standing: map()[ID]?.standing }).toEqual({ out: `THREAD_STANDING ${REF} applied`, name: "📌 fix login", standing: true });
  expect((await cli("list")).out).toBe(`${ID} none fix login [standing]`);
  closable("lane-a");
  const closed = await dori("close", "lane-a", "--summary", SUMMARY);
  expect({ code: closed.code, name: http().name, archived: http().archived, standing: map()[ID]?.standing }).toEqual({ code: 0, name: "📌 fix login", archived: false, standing: true });
  expect(closed.out).toContain("thread left open: standing thread; summary posted");
});

// owner 2026-11-03 11:10 KST: a thread kept open on purpose looked like it was waiting (🔔)
test("a standing thread keeps 📌 past working, waiting, an open card and a plain done, with no rename", async () => {
  await cli("open", "fix login", "--first", "Start");
  openLane("lane-b");
  await cli("set", REF, "standing");
  const before = renamed();
  await cli("set", REF, "working");
  await cli("set", REF, "waiting");
  await cli("set", REF, "waiting", "--open-card");
  const left = await cli("set", REF, "done");
  expect(left.out).toContain("standing thread; not marked done");
  const replied = await cli("done", REF, "finished");
  expect(replied.out).toContain("THREAD_LEFT_OPEN");
  expect({ name: http().name, archived: http().archived, renames: renamed() - before, standing: map()[ID]?.standing }).toEqual({ name: "📌 fix login", archived: false, renames: 0, standing: true });
});

test("setting standing again gives 📌 once, and a thread marked earlier gets it", async () => {
  await cli("open", "fix login", "--first", "Start");
  await cli("set", REF, "waiting");
  await cli("set", REF, "standing");
  await cli("set", REF, "standing");
  expect(http().name).toBe("📌 fix login");
});

test("unstanding takes 📌 off and the normal marks work again; a thread not standing is left alone", async () => {
  await cli("open", "fix login", "--first", "Start");
  expect((await cli("set", REF, "unstanding")).out).toBe(`THREAD_NOT_STANDING ${REF}`);
  expect(http().name).toBe("🔄 fix login");
  await cli("set", REF, "standing");
  expect((await cli("set", REF, "unstanding")).out).toBe(`THREAD_UNSTANDING ${REF} applied`);
  expect({ name: http().name, standing: map()[ID]?.standing }).toEqual({ name: "🔔 fix login", standing: false });
  await cli("set", REF, "working");
  expect(http().name).toBe("🔄 fix login");
  await cli("set", REF, "done");
  expect(http().name).toBe("✅ fix login");
});

test("a forced done ends a standing thread: ✅ with no 📌 left, archived, entry dropped", async () => {
  await cli("open", "fix login", "--first", "Start");
  await cli("set", REF, "standing");
  await cli("set", REF, "done", "--force");
  expect({ name: http().name, archived: http().archived, entry: map()[ID] }).toEqual({ name: "✅ fix login", archived: true, entry: undefined });
});

test("thread done --force ends a standing thread the same way", async () => {
  await cli("open", "fix login", "--first", "Start");
  await cli("set", REF, "standing");
  await cli("done", REF, "finished", "--force");
  expect({ name: http().name, archived: http().archived, entry: map()[ID] }).toEqual({ name: "✅ fix login", archived: true, entry: undefined });
});

test("a forced thread done whose post fails leaves the thread standing, and the retry still ends it with no 📌", async () => {
  await cli("open", "fix login", "--first", "Start");
  await cli("set", REF, "standing");
  const failed = await cli("done", REF, "📌", "--force");
  expect({ failed: failed.code !== 0, name: http().name, standing: map()[ID]?.standing }).toEqual({ failed: true, name: "📌 fix login", standing: true });
  await cli("done", REF, "finished", "--force");
  expect({ name: http().name, archived: http().archived, entry: map()[ID] }).toEqual({ name: "✅ fix login", archived: true, entry: undefined });
});

test("a release whose rename fails still takes 📌 off at the next rename, and unstanding again asks again", async () => {
  await cli("open", "fix login", "--first", "Start");
  await cli("set", REF, "standing");
  process.env.DORI_TEST_PATCH_FAIL = "1";
  try {
    await cli("set", REF, "unstanding");
  } finally {
    delete process.env.DORI_TEST_PATCH_FAIL;
  }
  expect({ name: http().name, standing: map()[ID]?.standing }).toEqual({ name: "📌 fix login", standing: false });
  expect((await cli("set", REF, "unstanding")).out).toBe(`THREAD_UNSTANDING ${REF} applied`);
  expect(http().name).toBe("🔔 fix login");
});

test("a forced done whose rename fails leaves the release, so the next done gives ✅ with no 📌", async () => {
  await cli("open", "fix login", "--first", "Start");
  await cli("set", REF, "standing");
  process.env.DORI_TEST_PATCH_FAIL = "1";
  try {
    await cli("set", REF, "done", "--force");
  } finally {
    delete process.env.DORI_TEST_PATCH_FAIL;
  }
  expect({ name: http().name, standing: map()[ID]?.standing }).toEqual({ name: "📌 fix login", standing: false });
  await cli("set", REF, "done");
  expect({ name: http().name, archived: http().archived, entry: map()[ID] }).toEqual({ name: "✅ fix login", archived: true, entry: undefined });
});

test("a 📌 in the title of a thread that was never standing stays through status changes", async () => {
  await cli("open", "📌 notices", "--first", "Start");
  await cli("set", REF, "waiting");
  expect(http().name).toBe("🔔 📌 notices");
});

test("a lane still working in the thread keeps it working when another lane closes, open card or not", async () => {
  await cli("open", "fix login", "--first", "Start");
  openCard("Q1");
  openLane("lane-b");
  closable("lane-a");
  const closed = await dori("close", "lane-a", "--summary", SUMMARY);
  expect({ code: closed.code, err: closed.err, names: named(), archived: http().archived }).toEqual({
    code: 0, err: "", names: [], archived: false,
  });
});

test("a waiting rename still held back by Discord's rate limit is kept for the listener, and the close warns that the mark has not moved yet", async () => {
  await cli("open", "fix login", "--first", "Start");
  openCard("Q1");
  closable("lane-a");
  const queued = join(state.dir, "cards", "thread-status.json");
  const due = Date.now() + 10 * 60_000;
  writeFileSync(queued, JSON.stringify({ [ID]: { status: "working", due, tries: 1, rev: 1 } }));
  const closed = await dori("close", "lane-a", "--summary", SUMMARY);
  expect({ code: closed.code, names: named(), queued: JSON.parse(readFileSync(queued, "utf8")) }).toEqual({ code: 0, names: [], queued: { [ID]: { status: "waiting", due, tries: 1, rev: 2 } } });
  expect(closed.out).toContain(`THREAD_STATUS_WARN lane-a ${REF}: waiting requested: pending`);
});

test("a done-claimed lane left in the thread is still ours: the mark stays until it settles, no 🔔 in between", async () => {
  await cli("open", "fix login", "--first", "Start");
  openCard("Q1");
  openLane("lane-b", { status: "done-claimed" });
  closable("lane-a");
  const closed = await dori("close", "lane-a", "--summary", SUMMARY);
  expect({ code: closed.code, err: closed.err, names: named(), archived: http().archived }).toEqual({ code: 0, err: "", names: [], archived: false });
});

test("a paused lane is not working: when the last working lane closes beside it, the thread turns waiting", async () => {
  await cli("open", "fix login", "--first", "Start");
  openLane("lane-b", { status: "paused" });
  closable("lane-a");
  const closed = await dori("close", "lane-a", "--summary", SUMMARY);
  expect({ code: closed.code, err: closed.err, names: named(), archived: http().archived }).toEqual({
    code: 0, err: `THREAD_STATUS_APPLIED ${ID} waiting`, names: ["🔔 fix login"], archived: false,
  });
  expect(closed.out).toContain("thread left open: open lane lane-b uses it too");
  // the paused lane is worked in again: the thread goes back to 🔄
  const resumed = await dori("resume", "lane-b");
  expect({ code: resumed.code, out: resumed.out, err: resumed.err, names: named() }).toEqual({
    code: 0, out: "LANE_RESUMED lane-b working", err: `THREAD_STATUS_APPLIED ${ID} working`, names: ["🔔 fix login", "🔄 fix login"],
  });
});

test("closing the only lane with no card left marks the thread done and archives it", async () => {
  await cli("open", "fix login", "--first", "Start");
  closable("lane-a");
  const closed = await dori("close", "lane-a", "--summary", SUMMARY);
  expect({ code: closed.code, err: closed.err, names: named(), archived: http().archived }).toEqual({
    code: 0, err: `THREAD_STATUS_APPLIED ${ID} done`, names: ["✅ fix login"], archived: true,
  });
});

// owner 2026-11-02 15:43 KST "이건 고쳐": a lane put on the thread a closed lane left ✅ works there, so it is 🔄 again
test("set-thread onto a thread a closed lane left ✅ and archived opens it again as 🔄 and maps it back", async () => {
  await cli("open", "fix login", "--first", "Start");
  closable("lane-a");
  await dori("close", "lane-a", "--summary", SUMMARY);
  const closed = { name: http().name, archived: http().archived, map: map() };
  openLane("lane-b", { thread: "discord:300000000000000009" });
  const set = await dori("set-thread", "lane-b", REF);
  expect({ closed, set, name: http().name, archived: http().archived, map: map() }).toEqual({
    closed: { name: "✅ fix login", archived: true, map: {} },
    set: { code: 0, out: `THREAD_SET lane-b discord:300000000000000009 -> ${REF}\nTHREAD_REOPEN lane-b ${REF}: working requested: applied`, err: `THREAD_STATUS_APPLIED ${ID} working` },
    name: "🔄 fix login", archived: false, map: { [ID]: { session: null, title: "lane-b" } },
  });
});

test("dori close posts the summary in the thread before it sets the done mark and archives it", async () => {
  await cli("open", "fix login", "--first", "Start");
  closable("lane-a");
  const closed = await dori("close", "lane-a", "--summary", SUMMARY);
  const after = http().calls.slice(2).map((c) => `${c.method} ${c.path}${c.body.name ? ` ${c.body.name}` : ""}${c.body.archived !== undefined ? ` archived=${c.body.archived}` : ""}${c.body.content ? ` ${c.body.content}` : ""}`);
  expect({ code: closed.code, after }).toEqual({ code: 0, after: [`POST /channels/${ID}/typing`, `POST /channels/${ID}/messages ${SUMMARY}`, `GET /channels/${ID}`, `PATCH /channels/${ID} ✅ fix login`, `PATCH /channels/${ID} archived=true`] });
});

// owner 2026-10-19 23:53 KST "왜 안알려주고 닫아?": a close with nothing for the owner is refused and changes nothing
test("dori close without a summary is CLOSE_SUMMARY_MISSING: exit 2, nothing posted, the thread keeps its mark and stays open", async () => {
  await cli("open", "fix login", "--first", "Start");
  closable("lane-a");
  const before = http().calls.length;
  const closed = await dori("close", "lane-a");
  expect({ code: closed.code, missing: closed.out.split("\n").at(-1), calls: http().calls.length - before, name: http().name, archived: http().archived }).toEqual({
    code: 2, missing: "CLOSE_SUMMARY_MISSING lane-a: no report, claim or REPORT.md to write one from", calls: 0, name: "🔄 fix login", archived: false,
  });
  expect(JSON.parse(readFileSync(join(state.dir, "lanes", "lane-a.json"), "utf8")).closedAt).toBeUndefined();
});

test("a summary for the owner with a path, a commit hash or backticks is refused before anything happens", async () => {
  closable("lane-a");
  for (const bad of ["see ~/.dori/qa/lane-a/REPORT.md", "merged abc1234 into main", "run `dori update`"]) {
    const r = await dori("claim-done", "lane-a", "--evidence", "merged", "--summary", bad);
    expect({ code: r.code, refused: r.err.startsWith("SUMMARY_REFUSED lane-a: ") }).toEqual({ code: 2, refused: true });
  }
  expect(JSON.parse(readFileSync(join(state.dir, "lanes", "lane-a.json"), "utf8")).claim).toBeUndefined();
});

// owner 2026-10-20 "가끔 이렇게 너 말투 달라지는 거니? 왜 달라지는 거야?": a lane's ~요 summary went out under the Dori's name in its owner's thread
test("a summary in 존댓말 is refused for a Korean owner spoken to in 반말; 반말, or ownerSpeech polite, is taken", async () => {
  closable("lane-a");
  const polite = "컴퓨터 6곳에 tokscale을 깔았어요.\n매일 오후 6시에 자동으로 올라가요.";
  try {
    discordWords = { locale: "ko-KR" };
    const refused = await dori("claim-done", "lane-a", "--evidence", "merged", "--summary", polite);
    expect({ code: refused.code, refused: refused.err.startsWith("SUMMARY_REFUSED lane-a: it is in 존댓말 ") }).toEqual({ code: 2, refused: true });
    expect(JSON.parse(readFileSync(join(state.dir, "lanes", "lane-a.json"), "utf8")).claim).toBeUndefined();
    const casual = await dori("claim-done", "lane-a", "--evidence", "merged", "--summary", "컴퓨터 6곳에 tokscale을 깔았어.\n남은 건 없고, 더 필요한 것도 필요 없어. 매일 오후 6시에 올라가.");
    expect(casual.code).toBe(0);
    discordWords = { locale: "ko-KR", ownerSpeech: "polite" };
    expect((await dori("claim-done", "lane-a", "--evidence", "merged", "--summary", polite)).code).toBe(0);
    discordWords = { locale: "ko-KR", ownerSpeech: "formal" };
    expect((await dori("claim-done", "lane-a", "--evidence", "merged", "--summary", polite)).err).toContain("discord.ownerSpeech must be");
  } finally {
    discordWords = {};
  }
});

test("the reply hook a closing lane runs does not count that lane as working (DORI_CLOSING_LANE)", async () => {
  await cli("open", "fix login", "--first", "Start");
  openCard("Q1");
  openLane("lane-a");
  process.env.DORI_CLOSING_LANE = "lane-a";
  const own = await cli("reply", REF, "lane-a: done").finally(() => delete process.env.DORI_CLOSING_LANE);
  expect({ err: own.err, names: named() }).toEqual({ err: `THREAD_STATUS_APPLIED ${ID} waiting`, names: ["🔔 fix login"] });
});

test("our reply with no lane working leaves the thread to the owner (🔔); with a lane working there it stays 🔄", async () => {
  await cli("open", "fix login", "--first", "Start");
  await cli("reply", REF, "here is the answer");
  expect(named().at(-1)).toBe("🔔 fix login");
  openLane("lane-a");
  await cli("reply", REF, "lane-a: tests are green");
  expect(named().at(-1)).toBe("🔄 fix login");
});

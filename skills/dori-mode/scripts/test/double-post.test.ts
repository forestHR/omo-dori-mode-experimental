import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { defaultDiscordWords } from "../src/config.ts";
import { claimDone, closeLane, type FlowDeps, recordThreadPost, RESULT_POST_MS, watchTick } from "../src/done-flow.ts";
import { Discord } from "../src/messenger/discord.ts";
import { discordThreadId, postInThread, setThreadStatus } from "../src/messenger/discord-thread.ts";
import type { Http, HttpRequest, HttpResponse } from "../src/messenger/http.ts";
import { type Lane, Registry, statusOf } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

// Owner 2026-10-21 07:19 KST "지금 왜 두번씩 답변하는지": a lane posted its result in the owner's thread itself (dori thread
// reply / dori send, as its brief asked), then dori close posted the claim's summary there as well, 37 s and 86 s later
// (jev-recall-filter 1562176450587664625 -> 1562176605869318166, cyto-ocr-merge 1562180973939138774 -> 1562181334640893983).

const T0 = Date.parse("2026-10-20T18:51:57.888Z");
const MIN = 60_000;
const THREAD_ID = "1561963113488842792";
const PANE = "aoe_jev-recall-filter_b0928fff";
const lane: Lane = { key: "jev-recall-filter", title: "JEV로 recall 후보 큰 모델 앞 거르기 시험", thread: `discord:${THREAD_ID}`, pane: PANE, brief: "/b.md", done: "file /etc/hostname", cwd: "/repo", openedAt: new Date(T0 - 60 * MIN).toISOString() };
const SUMMARY = "큰 모델이 recall 후보를 읽기 전에 JEV로 거르는 걸 질문 53개로 쟀어. 정답 하나도 안 잃는 기준이면 읽을 후보가 60개에서 평균 36개로 줄어.";
const LANE_POST = "큰 모델이 읽기 전에 JEV로 거르는 거 쟀어(질문 53개). 정답 하나도 안 잃는 기준이면 후보가 60개에서 평균 36개로 줄어.";

let state: ReturnType<typeof withState>;
let world: World;
const at = (ms: number, patch: Partial<FlowDeps> = {}): FlowDeps => ({ ...depsFor(world, fakeClock(ms), state.dir, { backend: "aoe", leadPane: "aoe_Dori_0a1b2c3d" }), ...patch });
const read = async (key = lane.key) => (await at(T0).registry.read(key)) ?? lane;

// a fake Discord: every request is recorded; GET answers a working thread
const fakeDiscord = () => {
  const seen: HttpRequest[] = [];
  const http: Http = async (req): Promise<HttpResponse> => {
    seen.push(req);
    return { status: 200, headers: {}, body: JSON.stringify(req.method === "GET" ? { name: "🔄 스파크 GPU 활용 조사", type: 11, thread_metadata: { archived: false } } : { id: "999" }) };
  };
  const dc = new Discord(http, fakeClock(0), "bot");
  const close = { markThreadDone: (ref: string) => setThreadStatus(dc, discordThreadId(ref), "done", { ...defaultDiscordWords, statusStyle: "emoji" }), postInThread: (ref: string, text: string) => postInThread(dc, ref, text) };
  const posts = () => seen.filter((r) => r.method === "POST" && r.url.endsWith(`/channels/${THREAD_ID}/messages`)).map((r) => (JSON.parse(String(r.body)) as { content: string }).content);
  const marks = () => seen.filter((r) => r.method !== "POST").map((r) => `${r.method}${r.body ? ` ${r.body}` : ""}`);
  return { close, posts, marks };
};

beforeEach(async () => {
  state = withState();
  world = newWorld();
  world.tmux = [PANE];
  await at(T0).registry.write(lane);
});
afterEach(() => state.done());

// the lane's own result post, as dori thread reply / dori send record it when they run in the lane's pane
const lanePosted = async (ms: number, id = "1562176450587664625") => {
  expect(await recordThreadPost(at(ms).registry, PANE, THREAD_ID, id, LANE_POST, new Date(ms).toISOString())).toBe(lane.key);
};

test("jev-recall-filter replay: the lane posted its result in the shared thread, so the close posts no second copy", async () => {
  await at(T0).registry.write({ ...lane, key: "cyto-ocr-merge", title: "PR #155", pane: "aoe_cyto-ocr-merge_786bc61b" });
  await lanePosted(T0 - 28_000);
  const claimed = await claimDone(at(T0), await read(), "REPORT JEV_RECALL_FILTER_OK", SUMMARY);
  expect(claimed.split("\n")).toEqual([`LANE_DONE_CLAIMED ${lane.key} ${PANE} REPORT JEV_RECALL_FILTER_OK`, `RESULT_ALREADY_POSTED ${lane.key} 1562176450587664625: the close posts no summary in the thread (the lane's result is there); --post-summary posts it anyway`]);
  const f = fakeDiscord();
  const r = await closeLane(at(T0 + 10_000, f.close), await read(), "closed by the lead");
  expect(r.closed).toBe(true);
  expect(f.posts()).toEqual([]);
  expect(r.lines).toContain(`CLOSE_SUMMARY_SKIPPED ${lane.key}: its result is already in the thread (1562176450587664625); no second post`);
  expect(JSON.stringify((await read()).receipt)).toContain("thread left open: open lane cyto-ocr-merge uses it too; result already posted (1562176450587664625)");
});

test("cyto-ocr-merge replay: a result sent with dori send into a thread that also holds an open card is not repeated by the close", async () => {
  await lanePosted(T0 - 81_000, "1562180973939138774");
  await claimDone(at(T0), await read(), "merged #155", SUMMARY);
  const f = fakeDiscord();
  const r = await closeLane(at(T0 + 5_000, { ...f.close, openCards: (ref) => (ref === lane.thread ? ["Q336"] : []) }), await read(), "closed");
  expect(r.closed).toBe(true);
  expect(f.posts()).toEqual([]);
  expect(f.marks()).toEqual([]);
});

test("a lane alone in its thread: the close posts nothing more and still marks the thread done and archives it", async () => {
  await lanePosted(T0 - MIN);
  await claimDone(at(T0), await read(), "ok", SUMMARY);
  const f = fakeDiscord();
  const r = await closeLane(at(T0 + MIN, f.close), await read(), "closed");
  expect(r.closed).toBe(true);
  expect(f.posts()).toEqual([]);
  expect(f.marks()).toEqual(["GET", 'PATCH {"name":"✅ 스파크 GPU 활용 조사"}', 'PATCH {"archived":true}']);
  expect(statusOf(await read())).toBe("closed");
});

test("the automatic close five quiet minutes after the claim posts no second copy either", async () => {
  await lanePosted(T0 - MIN);
  await claimDone(at(T0), await read(), "ok", SUMMARY);
  const f = fakeDiscord();
  const out = await watchTick(at(T0 + 10 * MIN, f.close));
  expect(out.some((l) => l.startsWith(`LANE_CLOSED ${lane.key} `))).toBe(true);
  expect(f.posts()).toEqual([]);
});

test("a lane that did not post its result still gets exactly one summary post", async () => {
  await claimDone(at(T0), await read(), "ok", SUMMARY);
  const f = fakeDiscord();
  expect((await closeLane(at(T0 + MIN, f.close), await read(), "closed")).closed).toBe(true);
  expect(f.posts()).toEqual([SUMMARY]);
});

test("a post older than the window (a progress line) does not stand in for the result", async () => {
  await lanePosted(T0 - RESULT_POST_MS - MIN);
  expect(await claimDone(at(T0), await read(), "ok", SUMMARY)).not.toContain("RESULT_ALREADY_POSTED");
  const f = fakeDiscord();
  await closeLane(at(T0 + MIN, f.close), await read(), "closed");
  expect(f.posts()).toEqual([SUMMARY]);
});

test("--post-summary: the lane's last post was not its result, so the close posts the summary once", async () => {
  await lanePosted(T0 - MIN);
  expect(await claimDone(at(T0), await read(), "ok", SUMMARY, { postSummary: true })).not.toContain("RESULT_ALREADY_POSTED");
  const f = fakeDiscord();
  await closeLane(at(T0 + MIN, f.close), await read(), "closed");
  expect(f.posts()).toEqual([SUMMARY]);
});

test("a result the lead relayed: dori close --posted <id> posts no summary; dori claim-done --posted names it too", async () => {
  await claimDone(at(T0), await read(), "ok", SUMMARY);
  const f = fakeDiscord();
  const r = await closeLane(at(T0 + MIN, f.close), await read(), "closed", undefined, "1561966208209915975");
  expect(f.posts()).toEqual([]);
  expect(r.lines).toContain(`CLOSE_SUMMARY_SKIPPED ${lane.key}: its result is already in the thread (1561966208209915975); no second post`);

  await at(T0).registry.write(lane);
  expect(await claimDone(at(T0), await read(), "ok", undefined, { posted: "1561966208209915975" })).toContain(`RESULT_ALREADY_POSTED ${lane.key} 1561966208209915975`);
  const g = fakeDiscord();
  expect((await closeLane(at(T0 + MIN, g.close), await read(), "closed")).closed).toBe(true);
  expect(g.posts()).toEqual([]);
});

test("an explicit close --summary is posted even when the lane posted: the lead asked for it", async () => {
  await lanePosted(T0 - MIN);
  await claimDone(at(T0), await read(), "ok", SUMMARY);
  const f = fakeDiscord();
  await closeLane(at(T0 + MIN, f.close), await read(), "closed", "정리해서 다시 말하면, 후보가 줄어.");
  expect(f.posts()).toEqual(["정리해서 다시 말하면, 후보가 줄어."]);
});

test("only the lane's own pane and its own thread count, and only the newest five posts are kept", async () => {
  const reg = at(T0).registry;
  expect(await recordThreadPost(reg, "aoe_Dori_0a1b2c3d", THREAD_ID, "1", "x", new Date(T0).toISOString())).toBeUndefined();
  expect(await recordThreadPost(reg, PANE, "1555211347338199112", "2", "x", new Date(T0).toISOString())).toBeUndefined();
  for (let i = 0; i < 7; i++) await recordThreadPost(reg, PANE, THREAD_ID, String(100 + i), "y".repeat(300), new Date(T0 + i).toISOString());
  const posts = (await read()).threadPosts ?? [];
  expect(posts.map((p) => p.id)).toEqual(["102", "103", "104", "105", "106"]);
  expect(posts[0]?.text.length).toBe(120);
});

// the real CLI: dori thread reply and dori send from the lane's pane (HERDR_PANE_ID with the default backend) record the post
test("dori thread reply and dori send record a post in the lane's own thread, and a post elsewhere is not recorded", async () => {
  const dir = state.dir;
  const reg = new Registry(dir);
  await reg.write({ ...lane, pane: "pane-7" });
  const http = join(dir, "http.json");
  const cli = (args: readonly string[], pane = "pane-7") => run(["env", `DORI_CONFIG=${join(dir, "missing.json")}`, `DORI_STATE_DIR=${dir}`, `DORI_ENV_FILE=${join(dir, "missing.env")}`, "DORI_DISCORD_TOKEN=fake", `DORI_TEST_HTTP=${http}`, `HERDR_PANE_ID=${pane}`,
    "bun", "--preload", join(import.meta.dir, "discord-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"), ...args]);
  const reply = await cli(["thread", "reply", `discord:${THREAD_ID}`, "결과 한 줄이야."]);
  expect(reply.out).toContain("POSTED 900");
  const sent = await cli(["send", "discord", "--to", THREAD_ID, "--text", "결과 두 줄째야.", "--no-typing"]);
  expect(sent.out.split(" ").slice(0, 2).join(" ")).toBe("SENT 900");
  await cli(["send", "discord", "--to", "1555211347338199112", "--text", "다른 데 올린 글.", "--no-typing"]);
  await cli(["send", "discord", "--to", THREAD_ID, "--text", "리드가 올린 글.", "--no-typing"], "lead-pane");
  expect(((await reg.read(lane.key))?.threadPosts ?? []).map((p) => p.text)).toEqual(["결과 한 줄이야.", "결과 두 줄째야."]);
});

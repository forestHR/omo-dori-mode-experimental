import { afterEach, beforeEach, expect, test } from "bun:test";

import { defaultDiscordWords, type DiscordWords } from "../src/config.ts";
import { deadPaneTick, newDeadPaneState } from "../src/dead-panes.ts";
import { claimDone, closeLane, type FlowDeps, LaneStateError, pauseLane, resumeLane, watchTick } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import { Discord } from "../src/messenger/discord.ts";
import { discordThreadId, postInThread, setThreadStatus, type ThreadStatus } from "../src/messenger/discord-thread.ts";
import type { Http, HttpRequest, HttpResponse } from "../src/messenger/http.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const PANE = "aoe_fix-a_abcdef12";
const THREAD_ID = "300000000000000003";
const lane: Lane = { key: "fix-a", title: "fix-a", thread: `discord:${THREAD_ID}`, pane: PANE, brief: "/b.md", done: "file /etc/hostname", cwd: "/repo", openedAt: new Date(T0 - 60 * MIN).toISOString() };

let state: ReturnType<typeof withState>;
let world: World;
const at = (ms: number, patch: Partial<FlowDeps> = {}): FlowDeps => ({
  ...depsFor(world, fakeClock(ms), state.dir, { backend: "aoe", leadPane: "aoe_Dori_0a1b2c3d", hooks: { threadReply: ["notify", "{thread}", "{text}"] } }),
  // the lane's session has no omo goal (pause-goal.test.ts covers one)
  readGoal: async () => "none",
  ...patch,
});
const read = async () => (await at(T0).registry.read("fix-a")) ?? lane;

beforeEach(async () => {
  state = withState();
  world = newWorld();
  world.aoe = [{ id: "abcdef1200112233", title: "fix-a", path: "/repo", tool: "omo", profile: "main" }];
  world.tmux = [PANE];
  await at(T0).registry.write(lane);
});
afterEach(() => state.done());

const waitingForHuman = () => {
  world.aoePs = [{ session: "abcdef1200112233", state: "waiting" }];
  world.screen = "[REPORT] fix-a | question | A or B?\nAllow this command? (y/n)\n❯ ";
};

test("a paused lane gets no freshness nudge or post, no LANE_BLOCKED and no DEAD_PANE; resume brings them back a full interval later", async () => {
  expect(await pauseLane(at(T0), lane, "waiting on the owner's pick")).toEqual(["LANE_PAUSED fix-a (was working) waiting on the owner's pick", `GOAL_SKIPPED fix-a ${PANE}: no goal in its session`]);
  waitingForHuman();
  expect(await freshnessTick(at(T0 + 30 * MIN), "/home/test")).toEqual([]);
  expect(await watchTick(at(T0 + 30 * MIN))).toEqual([]);
  world.screen = "omo has stopped\n$ ";
  const paused = (await at(T0).registry.open()).flatMap((l) => (statusOf(l) === "paused" && l.pane ? [l.pane] : []));
  const panes = newDeadPaneState();
  for (let i = 0; i < 3; i++) expect(await deadPaneTick(at(T0).run, at(T0).config, new Set(), "2026-01-01T12", paused, panes)).toEqual([]);
  expect(sent(world)).toEqual([]);
  expect(world.calls.some((c) => c[0] === "notify")).toBe(false);

  expect(await resumeLane(at(T0 + 40 * MIN), await read())).toEqual(["LANE_RESUMED fix-a working"]);
  const resumed = await read();
  expect(statusOf(resumed)).toBe("working");
  expect(resumed.history?.map((h) => [h.status, h.note])).toEqual([["paused", "PAUSED: waiting on the owner's pick"], ["working", "RESUMED"]]);
  waitingForHuman();
  expect(await freshnessTick(at(T0 + 41 * MIN), "/home/test")).toEqual([]);
  // the report first read at +41 min is the last word from the lane, so the nudge is due a full interval after it
  expect((await freshnessTick(at(T0 + 41 * MIN + at(T0).config.nudgeAfterMin * MIN), "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);
  expect(await watchTick(at(T0 + 60 * MIN))).toEqual([`LANE_BLOCKED fix-a waiting ${PANE}`]);
});

test("resume returns a lane to not-done when it was paused from not-done; pausing twice or resuming a running lane is refused", async () => {
  await at(T0).registry.write({ ...lane, status: "not-done" });
  await pauseLane(at(T0), await read(), "owner decides");
  await expect(pauseLane(at(T0), await read(), "again")).rejects.toBeInstanceOf(LaneStateError);
  await resumeLane(at(T0 + MIN), await read());
  expect(statusOf(await read())).toBe("not-done");
  await expect(resumeLane(at(T0), await read())).rejects.toBeInstanceOf(LaneStateError);
});

test("a done claim on a paused lane is announced once and never closes it; resume points at the waiting claim", async () => {
  await pauseLane(at(T0), lane, "owner approval");
  expect(await claimDone(at(T0 + MIN), await read(), "merged #3")).toBe(`LANE_DONE_CLAIMED_PAUSED fix-a ${PANE} merged #3`);
  expect(sent(world)[0]).toContain("does not close automatically");
  expect(await watchTick(at(T0 + 2 * MIN))).toEqual([`LANE_DONE_CLAIMED_PAUSED fix-a ${PANE} merged #3`]);
  expect(await watchTick(at(T0 + 20 * MIN))).toEqual([]);
  expect(statusOf(await read())).toBe("paused");
  expect(world.calls.some((c) => c[0] === "aoe" && c[1] === "rm")).toBe(false);
  const lines = await resumeLane(at(T0 + 21 * MIN), await read());
  expect(lines[1]).toStartWith("NOTE fix-a claimed done while paused (merged #3)");
});

// a fake Discord thread: GET returns its name and archive flag, PATCHes are recorded (or refused)
const fakeThread = (name: string, archived: boolean, refuse = false) => {
  const seen: HttpRequest[] = [];
  const http: Http = async (req): Promise<HttpResponse> => {
    seen.push(req);
    if (refuse && req.method === "PATCH") return { status: 403, headers: {}, body: JSON.stringify({ code: 50013, message: "Missing Permissions" }) };
    return { status: 200, headers: {}, body: JSON.stringify(req.method === "GET" ? { name, type: 11, thread_metadata: { archived } } : {}) };
  };
  const dc = new Discord(http, fakeClock(0), "bot");
  const markThreadDone = (ref: string) => setThreadStatus(dc, discordThreadId(ref), "done", { ...defaultDiscordWords, statusStyle: "emoji" });
  const calls = () => seen.map((r) => `${r.method} ${r.url.replace("https://discord.com/api/v10", "")}${r.body ? ` ${r.body}` : ""}`);
  // the status calls alone (GET and PATCH), without the summary's typing and message POSTs
  const marks = () => calls().filter((c) => !c.startsWith("POST"));
  // what cli wires with a Discord token: the summary posted straight to the thread, then the done mark
  const close = { markThreadDone, postInThread: (ref: string, text: string) => postInThread(dc, ref, text) };
  return { markThreadDone, calls, marks, close, dc };
};
const T = `/channels/${THREAD_ID}`;
const SUMMARY = "The login page takes SSO now. Nothing is left; the nodes get it with the next update.";

test("close sets the lane's Discord thread done and archives it", async () => {
  const f = fakeThread("🔄 fix login", false);
  const r = await closeLane(at(T0, f.close), lane, "closed by the lead", SUMMARY);
  expect(r.closed).toBe(true);
  // the owner's summary goes out first; only then is the thread marked done and archived
  expect(f.calls().filter((c) => !c.endsWith("/typing"))).toEqual([`POST ${T}/messages {"content":"${SUMMARY}","allowed_mentions":{"parse":[]}}`, `GET ${T}`, `PATCH ${T} {"name":"✅ fix login"}`, `PATCH ${T} {"archived":true}`]);
  expect(r.lines).toContain("CLOSE_SUMMARY fix-a from the lane");
  expect(JSON.stringify((await read()).receipt)).toContain("thread set done and archived");
});

test("an archived thread is opened, renamed and archived again, since Discord will not rename an archived thread; one already done is left alone", async () => {
  const f = fakeThread("🔄 fix login", true);
  await closeLane(at(T0, f.close), lane, "closed", SUMMARY);
  expect(f.marks()).toEqual([`GET ${T}`, `PATCH ${T} {"archived":false}`, `PATCH ${T} {"name":"✅ fix login"}`, `PATCH ${T} {"archived":true}`]);
  await at(T0).registry.write(lane);
  const done = fakeThread("✅ fix login", true);
  await closeLane(at(T0, done.close), lane, "closed", SUMMARY);
  expect(done.marks()).toEqual([`GET ${T}`]);
});

test("close strips every stacked status mark from a thread name, so it ends with one", async () => {
  const f = fakeThread("🔄 🔄 fix login", false);
  await closeLane(at(T0, f.close), lane, "closed", SUMMARY);
  expect(f.marks()).toEqual([`GET ${T}`, `PATCH ${T} {"name":"✅ fix login"}`, `PATCH ${T} {"archived":true}`]);
});

// the name setThreadStatus sends for a thread currently called `name`
const renamed = async (name: string, status: ThreadStatus, words: DiscordWords = { ...defaultDiscordWords, statusStyle: "emoji" }) => {
  let sent: string | undefined;
  const http: Http = async (req) => {
    if (req.method === "PATCH") sent = (JSON.parse(String(req.body ?? "{}")) as { name?: string }).name ?? sent;
    return { status: 200, headers: {}, body: "{}" };
  };
  await setThreadStatus(new Discord(http, fakeClock(0), "bot"), THREAD_ID, status, words, { name, type: 11 });
  return sent ?? name;
};

test("every status change leaves exactly one status mark in front of the title", async () => {
  expect(await renamed("✅ 🔄 fix login", "working")).toBe("🔄 fix login");
  expect(await renamed("fix login", "working")).toBe("🔄 fix login");
  expect(await renamed("⏸️⏳ ⏸ 🔄  fix login", "waiting")).toBe("⏸️ fix login");
  expect(await renamed("[working] [working] [api] fix login", "done", defaultDiscordWords)).toBe("[done] [api] fix login");
  expect(await renamed("🔄 [done] fix login", "working", defaultDiscordWords)).toBe("[working] fix login");
});

test("a thread that cannot be renamed is a warning, the lane still closes; a lane without a thread or sharing it with an open lane is not touched", async () => {
  const refused = fakeThread("🔄 fix login", false, true);
  const r = await closeLane(at(T0, refused.close), lane, "closed", SUMMARY);
  expect(r.closed).toBe(true);
  expect(r.lines.some((l) => l.startsWith(`THREAD_DONE_WARN fix-a discord:${THREAD_ID}: discord PATCH`))).toBe(true);
  expect(statusOf(await read())).toBe("closed");

  const none = fakeThread("🔄 fix login", false);
  await at(T0).registry.write({ ...lane, thread: "none" });
  expect((await closeLane(at(T0, none.close), { ...lane, thread: "none" }, "closed")).closed).toBe(true);
  expect(none.calls()).toEqual([]);
  await at(T0).registry.write(lane);
  await at(T0).registry.write({ ...lane, key: "fix-b", pane: "aoe_fix-b_00000000" });
  await closeLane(at(T0, none.close), lane, "closed", SUMMARY);
  expect(none.marks()).toEqual([]);
  expect(JSON.stringify((await read()).receipt)).toContain("thread left open: open lane fix-b uses it too");
});

// both thread hooks, told apart in the recorded argv
const bothHooks = (deps: FlowDeps): FlowDeps => ({ ...deps, config: { ...deps.config, hooks: { ...deps.config.hooks, threadReply: ["notify", "reply", "{thread}", "{text}"], threadDone: ["notify", "done", "{thread}", "{text}"] } } });
const hookCalls = () => world.calls.filter((c) => c[0] === "notify").map((c) => `${c[1]} ${c[3]}`);

test("two lanes in one thread: the automatic close of the first posts its result and leaves the thread working; closing the last marks it done", async () => {
  const f = fakeThread("🔄 dedup", false);
  const deps = (ms: number) => bothHooks(at(ms, { markThreadDone: f.markThreadDone }));
  await deps(T0).registry.write({ ...lane, key: "fix-b", title: "fix-b", pane: "aoe_fix-b_00000000" });
  await claimDone(deps(T0), lane, "merged #47", SUMMARY);
  const out = await watchTick(deps(T0 + 10 * MIN));
  expect(out.some((l) => l.startsWith("LANE_CLOSED fix-a "))).toBe(true);
  expect(hookCalls()).toEqual([`reply fix-a: ${SUMMARY}`]);
  expect(f.calls()).toEqual([]);
  expect(JSON.stringify((await read()).receipt)).toContain("thread left open: open lane fix-b uses it too; summary posted");

  const last = (await deps(T0).registry.read("fix-b")) ?? lane;
  expect((await closeLane(deps(T0 + 11 * MIN), last, "closed by the lead", "Dedup is done too.")).closed).toBe(true);
  expect(hookCalls().at(-1)).toBe("done Dedup is done too.");
  expect(f.calls()).toEqual([`GET ${T}`, `PATCH ${T} {"name":"✅ dedup"}`, `PATCH ${T} {"archived":true}`]);
});

test("with a Discord token the result goes straight to the thread: a waiting shared thread is not renamed, not even to working", async () => {
  const f = fakeThread("⏸️ shared", false);
  await at(T0).registry.write({ ...lane, key: "fix-b", title: "fix-b", pane: "aoe_fix-b_00000000", status: "paused" });
  const deps = bothHooks(at(T0, { markThreadDone: f.markThreadDone, postInThread: (ref, text) => postInThread(f.dc, ref, text) }));
  expect((await closeLane(deps, lane, "closed", SUMMARY)).closed).toBe(true);
  expect(f.calls().filter((c) => c.startsWith("PATCH") || c.startsWith("GET"))).toEqual([]);
  expect(f.calls().filter((c) => c.startsWith(`POST ${T}/messages`))).toHaveLength(1);
  expect(f.calls().join("\n")).toContain(`fix-a: ${SUMMARY}`);
  expect(hookCalls()).toEqual([]);
  expect(JSON.stringify((await read()).receipt)).toContain("thread left open: open lane fix-b uses it too; summary posted");
});

test("a thread with an open question card is not marked done when its only lane closes; the result is posted", async () => {
  const f = fakeThread("⏸️ dedup", false);
  const r = await closeLane(bothHooks(at(T0, { markThreadDone: f.markThreadDone, openCards: (ref) => (ref === lane.thread ? ["Q7"] : []) })), lane, "closed", SUMMARY);
  expect(r.closed).toBe(true);
  expect(hookCalls()).toEqual([`reply fix-a: ${SUMMARY}`]);
  expect(f.calls()).toEqual([]);
  expect(JSON.stringify((await read()).receipt)).toContain("thread left open: open card Q7; summary posted");
});

test("the reply hook a closing lane runs is told which lane closes, so the lane is not counted as working there", async () => {
  const deps = bothHooks(at(T0, { openCards: (ref) => (ref === lane.thread ? ["Q7"] : []) }));
  const envs: unknown[] = [];
  await closeLane({ ...deps, run: (argv, opts) => (argv[0] === "notify" && envs.push(opts?.env), deps.run(argv, opts)) }, lane, "closed", SUMMARY);
  expect(envs).toEqual([{ DORI_CLOSING_LANE: "fix-a" }]);
});

test("a card answered while the lane's close cleans up gives the thread back to work: no waiting is asked for", async () => {
  let cards = ["Q7"];
  const asked: string[] = [];
  const deps = at(T0, {
    openCards: () => cards,
    postInThread: async () => { cards = []; },
    requestThreadStatus: async (_ref, status) => (asked.push(status), "applied"),
  });
  expect((await closeLane(deps, lane, "closed", SUMMARY)).closed).toBe(true);
  expect(asked).toEqual([]);
  cards = ["Q7"];
  await at(T0).registry.write(lane);
  await closeLane({ ...deps, postInThread: async () => {} }, lane, "closed", SUMMARY);
  expect(asked).toEqual(["waiting"]);
});

// owner 2026-10-19 23:53 KST "왜 안알려주고 닫아?": two lanes closed with only "done, I'll sum it up for you" and archived
test("a lane with a thread and nothing to write a summary from is not closed: CLOSE_SUMMARY_MISSING, nothing posted, no done mark", async () => {
  const f = fakeThread("🔄 fix login", false);
  const r = await closeLane(at(T0, f.close), lane, "closed by the lead");
  expect(r.closed).toBe(false);
  expect(r.lines.at(-1)).toStartWith("CLOSE_SUMMARY_MISSING fix-a: no report, claim or REPORT.md to write one from");
  expect(f.calls()).toEqual([]);
  expect(statusOf(await read())).toBe("working");
  expect(world.calls.some((c) => c[0] === "aoe" && c[1] === "rm")).toBe(false);
});

test("a summary that did not go out leaves the thread without its done mark and the lane open", async () => {
  const f = fakeThread("🔄 fix login", false);
  const r = await closeLane(at(T0, { ...f.close, postInThread: async () => { throw new Error("discord POST 503"); } }), lane, "closed", SUMMARY);
  expect(r.closed).toBe(false);
  expect(r.lines.at(-1)).toBe(`CLOSE_SUMMARY_NOT_SENT fix-a discord:${THREAD_ID}: discord POST 503`);
  expect(f.calls()).toEqual([]);
  expect(statusOf(await read())).toBe("working");
});

test("the automatic close without a summary gives the lead CLOSE_SUMMARY_MISSING and tells the lane to claim again with --summary", async () => {
  const f = fakeThread("🔄 fix login", false);
  await claimDone(at(T0, f.close), lane, "merged #47");
  const out = await watchTick(at(T0 + 10 * MIN, f.close));
  expect(out.find((l) => l.startsWith("CLOSE_SUMMARY_MISSING fix-a: "))).toBeDefined();
  expect(out.some((l) => l.startsWith("LANE_CLOSED"))).toBe(false);
  expect(statusOf(await read())).toBe("not-done");
  expect(sent(world).some((t) => t.startsWith("[LEAD] not done: no summary for the owner's thread") && t.includes(`dori claim-done fix-a --evidence`) && t.includes("--summary"))).toBe(true);
  expect(f.calls()).toEqual([]);
  // claimed again with a summary, the next settle posts it, then marks the thread done
  await claimDone(at(T0 + 11 * MIN, f.close), await read(), "merged #47", SUMMARY);
  const closed = await watchTick(at(T0 + 20 * MIN, f.close));
  expect(closed).toContain("CLOSE_SUMMARY fix-a from the lane");
  expect(closed.at(-1)).toStartWith("LANE_CLOSED fix-a ");
  expect(f.calls().filter((c) => !c.endsWith("/typing")).map((c) => c.split(" ").slice(0, 2).join(" "))).toEqual([`POST ${T}/messages`, `GET ${T}`, `PATCH ${T}`, `PATCH ${T}`]);
});

// owner 2026-10-20 "가끔 이렇게 너 말투 달라지는 거니? 왜 달라지는 거야?": a claim made in 존댓말 is not posted as it is under the Dori's name
test("a lane's summary in 존댓말 goes to a Korean owner's thread rewritten in 반말 from that summary, an answer still in 존댓말 refused", async () => {
  const f = fakeThread("🔄 fix login", false);
  const base = at(T0, f.close);
  const given = "컴퓨터 6곳에 tokscale을 깔았어요.\n매일 오후 6시에 자동으로 올라가요.";
  const answers = ["<<<SUMMARY\n컴퓨터 6곳에 tokscale을 깔았습니다.\nSUMMARY>>>", "<<<SUMMARY\n컴퓨터 6곳에 tokscale을 깔았어.\n매일 오후 6시에 자동으로 올라가.\nSUMMARY>>>"];
  const asked: string[] = [];
  const deps: FlowDeps = {
    ...base,
    config: { ...base.config, discord: { ...base.config.discord, locale: "ko-KR" }, explore: { ...base.config.explore, modelsCommand: [] } },
    run: async (argv, opts) => (argv[0] === "omo" ? (asked.push(argv.at(-1) ?? ""), { code: 0, out: answers[asked.length - 1] ?? "", err: "" }) : base.run(argv, opts)),
  };
  const reported = { ...lane, lastReport: "[REPORT] fix-a | done | 첫 자동 실행은 10월 20일 18시 KST" };
  const r = await closeLane(deps, reported, "closed by the lead", given);
  expect(r.closed).toBe(true);
  expect(asked).toHaveLength(2);
  // the model is given the lane's own words alone to keep, none of the lead's notes to add from, and asked for 반말
  expect(asked[0]).toContain(given);
  expect(asked[0]).not.toContain("10월 20일");
  expect(asked[0]).toContain("반말");
  expect(r.lines.find((l) => l.startsWith("CLOSE_SUMMARY "))).toStartWith("CLOSE_SUMMARY fix-a from model ");
  expect(f.calls().find((c) => c.startsWith(`POST ${T}/messages`))).toContain("컴퓨터 6곳에 tokscale을 깔았어.\\n매일 오후 6시에 자동으로 올라가.");
});

test("without the lane's own summary a model writes one from its last report; an answer with a path or a hash is refused", async () => {
  const f = fakeThread("🔄 fix login", false);
  const base = at(T0, f.close);
  const answers = ["<<<SUMMARY\nSSO is in, see /home/me/repo/REPORT.md (abc1234).\nSUMMARY>>>", "<<<SUMMARY\nThe login page takes SSO now.\nNothing is left.\nSUMMARY>>>"];
  const asked: string[] = [];
  const deps: FlowDeps = {
    ...base,
    config: { ...base.config, explore: { ...base.config.explore, modelsCommand: [] } },
    run: async (argv, opts) => (argv[0] === "omo" ? (asked.push(argv.at(-1) ?? ""), { code: 0, out: answers[asked.length - 1] ?? "", err: "" }) : base.run(argv, opts)),
  };
  const reported = { ...lane, lastReport: "[REPORT] fix-a | done | SSO merged in acme/app#12 (abc1234), QA ok" };
  const r = await closeLane(deps, reported, "closed by the lead");
  expect(r.closed).toBe(true);
  expect(asked).toHaveLength(2);
  expect(asked[0]).toContain("[REPORT] fix-a | done | SSO merged");
  expect(r.lines.find((l) => l.startsWith("CLOSE_SUMMARY "))).toStartWith("CLOSE_SUMMARY fix-a from model ");
  expect(f.calls().find((c) => c.startsWith(`POST ${T}/messages`))).toContain("The login page takes SSO now.\\nNothing is left.");
});

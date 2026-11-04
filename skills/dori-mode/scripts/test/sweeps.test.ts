import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultDiscordWords } from "../src/config.ts";
import { deadPaneTick, newDeadPaneState } from "../src/dead-panes.ts";
import { claimDone } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import { parseGpuQuery, parsePmon, treeOf, type Usage } from "../src/heavy-headroom.ts";
import { acquire, acquireSlot, pidAlive, releaseSlot, type SlotDeps } from "../src/heavy-slot.ts";
import { guardTick } from "../src/host-guard.ts";
import { adoptLane, LaunchError } from "../src/launch.ts";
import type { Lane } from "../src/registry.ts";
import type { Clock } from "../src/run.ts";
import { resolveSession } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const working: Lane = { key: "quiet-lane", title: "quiet", thread: "chat:team/9", pane: "w:p7", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };

test("a lead note that does not reach the lead pane is reported as not told, and the next sweep tries again", async () => {
  // Given a lead pane whose input line keeps the note unsent.
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir);
  await deps(T0).registry.write(working);
  world.screens["w:p7"] = "noise\n[REPORT] quiet-lane | milestone | tests green, PR open\n❯ ";
  world.screens["lead:p1"] = "❯ [DORI] quiet-lane: 21 min without a new report";
  expect(await freshnessTick(deps(T0), "/home/test")).toEqual([]);
  expect((await freshnessTick(deps(T0 + 16 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);
  // When the sweep tells the lead, and again on the next sweep.
  const first = await freshnessTick(deps(T0 + 21 * MIN), "/home/test");
  const again = await freshnessTick(deps(T0 + 23 * MIN), "/home/test");
  // Then each says the lead was not told, and the lane stays due.
  expect(first.map((a) => a.kind)).toEqual(["lead-tell-failed"]);
  expect(first[0]?.detail).toContain("did not reach pane lead:p1");
  expect(again.map((a) => a.kind)).toEqual(["lead-tell-failed"]);
  expect((await deps(T0).registry.read("quiet-lane"))?.lastAutoReplyAt).toBeUndefined();
});

test("a silent lane with no leadPane configured stays due, so the lead configured later still gets the note for the same silence", async () => {
  // Given a Dori whose leadPane is not set yet (review #339).
  const noLead = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { leadPane: undefined });
  await noLead(T0).registry.write({ ...working, lastReport: "[REPORT] quiet-lane | milestone | tests green, PR open", lastNudgeAt: T0 + 16 * MIN });
  world.screens["w:p7"] = "working on it\n❯ ";
  // When a sweep finds it silent without a lead, and one after the lead is set, with no new report in between.
  const first = await freshnessTick(noLead(T0 + 21 * MIN), "/home/test");
  const later = await freshnessTick(depsFor(world, fakeClock(T0 + 26 * MIN), state.dir), "/home/test");
  // Then the first says the lead was not told, and the second tells it.
  expect(first.map((a) => [a.kind, a.detail])).toEqual([["lead-tell-failed", "21 min silent; leadPane is not configured"]]);
  expect(later.map((a) => a.kind)).toEqual(["lead-told"]);
  expect(sent(world).filter((t) => t.startsWith("[DORI] quiet-lane: 26 min"))).toHaveLength(1);
});

test("a lane silent past the nudge time is nudged once, then the lead is told once and nothing is posted in its thread", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write(working);
  world.screen = "noise\n[REPORT] quiet-lane | milestone | tests green on /home/test/repo, PR open\n\n❯ ";
  expect(await freshnessTick(deps(T0), "/home/test")).toEqual([]);
  expect(await freshnessTick(deps(T0 + 10 * MIN), "/home/test")).toEqual([]);
  expect((await freshnessTick(deps(T0 + 16 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);
  expect((await freshnessTick(deps(T0 + 17 * MIN), "/home/test")).map((a) => a.kind)).toEqual([]);
  const told = await freshnessTick(deps(T0 + 21 * MIN), "/home/test");
  expect(told.map((a) => a.kind)).toEqual(["lead-told"]);
  expect((await freshnessTick(deps(T0 + 40 * MIN), "/home/test")).map((a) => a.kind)).toEqual([]);
  // the owner's thread gets nothing from the sweep, even with a reply hook configured
  expect(world.calls.some((c) => c[0] === "notify")).toBe(false);
  // one nudge to the lane, one note to the lead carrying the report
  expect(sent(world)).toHaveLength(2);
  expect(sent(world)[1]).toBe("[DORI] quiet-lane: 21 min without a new report. Nothing was posted in its thread. If the owner needs to know where it stands, tell him in one plain line. Last report: [REPORT] quiet-lane | milestone | tests green on /home/test/repo, PR open");
});

test("a report the lane sent to the lead pane is found there, wrapped lines joined, and a new report resets the silence", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write(working);
  world.screens["w:p7"] = "working on it\n❯ ";
  world.screens["lead:p1"] = " [REPORT] quiet-lane | milestone | first step done\n\n [REPORT] other-lane | done | not ours\n [REPORT] quiet-lane | blocker | CI is red on the\n flaky e2e job, rerunning\n\n❯ ";
  expect(await freshnessTick(deps(T0 + 14 * MIN), "/home/test")).toEqual([]);
  expect((await freshnessTick(deps(T0 + 28 * MIN), "/home/test")).map((a) => a.kind)).toEqual([]);
  const later = await freshnessTick(deps(T0 + 35 * MIN), "/home/test");
  expect(later.map((a) => a.kind)).toEqual(["nudged", "lead-told"]);
  // the raw report goes to the lead pane, and nothing to the owner's thread
  expect(world.calls.some((c) => c[0] === "notify")).toBe(false);
  const toLead = world.calls.find((c) => c[0] === "herdr" && c[2] === "send-text" && c[3] === "lead:p1")?.[4];
  expect(toLead).toContain("[DORI] quiet-lane: 21 min without a new report");
  expect(toLead).toContain("Last report: [REPORT] quiet-lane | blocker | CI is red on the flaky e2e job, rerunning");
  expect(later[1]?.detail).toBe("21 min silent; nothing posted in its thread");
});

// omo runs in tmux's alternate screen (history_size 0): capture-pane -S -3000 returns only the visible rows, and omo's tail
// under a turn (cache wait, stall backstop, TPS, the todo list, the status lines) pushes a report off them. 2026-11-01:
// NO-REPORT for pingpong-analytics every 2 min from 00:22Z to 04:19Z while its reports sat in the lead's transcript.
const omoTail = [
  " ⚡ Cache-warm wait · iteration 3",
  " Stall backstop ready 2026-11-01 04:24 UTC (4m 30s) - the goal resumes as soon",
  " as a wake source delivers, inside the 1h prompt-cache TTL.",
  " Prior turn: ~151.6K cache-read/write tokens (cumulative) · est. $0.576",
  " discount if reused · next cache hit unverified",
  "",
  " TPS 148.9 tok/s. Cache hit 98.4%, 3.7s",
  "",
  " Todo",
  " Pre-roll PR",
  " [✓] Design pre-roll of about 1 s in the recorder",
  " [•] Replay plays the pre-roll (serve backswing visible)",
  " [ ] Back-to-back rallies with overlapping pre-roll",
  " [ ] Report pre-roll results to lead",
  "─────────────────────────────────────────────",
  "❯",
  "─────────────────────────────────────────────",
  " Claude·acct ▕░░░░░░░░░░░░░░▏ 0% 7d · resets 11/03 08:59 │ pool",
  "…ngpong-tournament • master • … • 152K/1M (15.2%) (auto)  claude-opus-5-5:medium",
  "(😺 OmO Native by Q Kim) Pursuing goal (22h 12m) goal continues ...",
].join("\n");
const userLine = (at: string, text: string): string => JSON.stringify({ type: "message", timestamp: at, message: { role: "user", content: [{ type: "text", text }] } });
const noSignals = { signals: async () => ({}) };

test("a lane that reported is not NO-REPORT once its report scrolled off both screens: the lead gets its last report", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write({ ...working, lastReport: "[REPORT] quiet-lane | milestone | recorder guard holds, PR open" });
  world.screens["w:p7"] = `v6-orig2 is recording.\n${omoTail}`;
  world.screens["lead:p1"] = omoTail;
  const acts = await freshnessTick(deps(T0 + 21 * MIN), "/home/test", { ...noSignals, leadTranscript: async () => undefined });
  expect(acts.map((a) => a.kind)).toEqual(["nudged", "lead-told"]);
  expect(sent(world).find((t) => t.startsWith("[DORI] quiet-lane"))).toContain("Last report: [REPORT] quiet-lane | milestone | recorder guard holds, PR open");
});

test("a lane that never reported is still NO-REPORT", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write(working);
  world.screens["w:p7"] = omoTail;
  world.screens["lead:p1"] = omoTail;
  const transcript = [userLine("2026-01-01T12:05:00.000Z", "[REPORT] other-lane | milestone | not ours"), userLine("2026-01-01T12:06:00.000Z", "[DORI] quiet-lane: 20 min without a new report. Last report: [REPORT] quiet-lane | milestone | quoted, not typed")].join("\n");
  const acts = await freshnessTick(deps(T0 + 21 * MIN), "/home/test", { ...noSignals, leadTranscript: async () => transcript });
  expect(acts.map((a) => [a.kind, a.detail])).toContainEqual(["no-report", "pane has no [REPORT] line"]);
  expect(world.calls.some((c) => c[0] === "notify")).toBe(false);
});

test("a report typed into the lead is read from its transcript, first line only, and a new one resets the silence", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write({ ...working, lastReport: "[REPORT] quiet-lane | milestone | older step" });
  world.screens["w:p7"] = omoTail;
  world.screens["lead:p1"] = omoTail;
  const transcript = [
    userLine("2026-01-01T12:01:00.000Z", "[REPORT] quiet-lane | milestone | older step"),
    JSON.stringify({ type: "message", timestamp: "2026-01-01T12:02:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "[REPORT] quiet-lane | done | the lead's own words are not a report" }] } }),
    userLine("2026-01-01T12:14:00.000Z", "[REPORT] quiet-lane | working | replay re-run done, second job waits in the core gate\nevidence: run 21631b1, qa/replay.log"),
  ].join("\n");
  const acts = await freshnessTick(deps(T0 + 16 * MIN), "/home/test", { ...noSignals, leadTranscript: async () => transcript });
  expect(acts.map((a) => a.kind)).toEqual([]);
  const lane = await deps(T0).registry.read("quiet-lane");
  expect(lane?.lastReport).toBe("[REPORT] quiet-lane | working | replay re-run done, second job waits in the core gate");
  expect(lane?.lastReplyAt).toBe(T0 + 16 * MIN);
});

test("a report wrapped on the lane's screen with a status outside the four words and omo's tail under it still counts", async () => {
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps(T0).registry.write(working);
  world.screens["lead:p1"] = omoTail;
  world.screens["w:p7"] = ` [REPORT] quiet-lane | working | origin 이동(end-sync 머지: 대회\n c6d071a, 비전 21631b1) 기록\n\n${omoTail}`;
  const acts = await freshnessTick(deps(T0 + 21 * MIN), "/home/test", { ...noSignals, leadTranscript: async () => undefined });
  expect(acts.map((a) => a.kind)).toEqual([]);
  expect((await deps(T0).registry.read("quiet-lane"))?.lastReport).toBe("[REPORT] quiet-lane | working | origin 이동(end-sync 머지: 대회 c6d071a, 비전 21631b1) 기록");
});

test("a Dori with no thread reply hook still tells the lead about a silent lane, its report defused; a lane with no thread is left out", async () => {
  // Given no hooks.threadReply (the case of every Dori but one on 2026-11-04).
  const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir);
  await deps(T0).registry.write(working);
  await deps(T0).registry.write({ ...working, key: "threadless", thread: "none", pane: "w:p8" });
  world.screens["lead:p1"] = " [REPORT] quiet-lane | milestone | (a) 승인 조건대로 ① `bun test` green, $(x) gone\n [REPORT] threadless | milestone | step one\n\n❯ ";
  await freshnessTick(deps(T0 + MIN), "/home/test");
  // When it has been silent past postAfterMin.
  const acts = await freshnessTick(deps(T0 + 22 * MIN), "/home/test");
  // Then the lead gets one note for the lane with a thread, with a backtick or $( defused instead of failing the sweep.
  expect(acts.filter((a) => a.kind === "lead-told").map((a) => a.lane)).toEqual(["quiet-lane"]);
  const notes = sent(world).filter((t) => t.startsWith("[DORI]"));
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("① 'bun test' green, $ (x) gone");
});

test("a done claim written while a sweep is nudging the lane survives the sweep's own registry write", async () => {
  const base = depsFor(world, fakeClock(T0 + 16 * MIN), state.dir);
  await base.registry.write(working);
  const run: typeof base.run = async (argv, opts) => {
    if (argv[0] === "herdr" && argv[2] === "send-text") await claimDone({ ...base, run: async () => ({ code: 0, out: "❯ ", err: "" }) }, working, "merged acme/app#1");
    return base.run(argv, opts);
  };
  expect((await freshnessTick({ ...base, run }, "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);
  const after = await base.registry.read("quiet-lane");
  expect(after?.status).toBe("done-claimed");
  expect(after?.lastNudgeAt).toBe(T0 + 16 * MIN);
});

test("a nudge that never reaches the lane's pane is reported as failed, not as sent", async () => {
  const deps = depsFor(world, fakeClock(T0 + 16 * MIN), state.dir);
  await deps.registry.write(working);
  world.screens["w:p7"] = "❯ [LEAD] your work thread has had no update";
  expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).toEqual(["nudge-failed"]);
});

test("a stopped agent pane is reported once per hour after two reads a tick apart agree, and the lead pane is never reported", async () => {
  world.panes = [{ pane_id: "w:p1", workspace_id: "w" }, { pane_id: "lead:p1", workspace_id: "lead" }];
  world.screen = "omo has stopped\n$ ";
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const seen = new Set<string>();
  const panes = newDeadPaneState();
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", [], panes)).toEqual([]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", [], panes)).toEqual(["DEAD_PANE w:p1"]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T12", [], panes)).toEqual([]);
  expect(await deadPaneTick(deps.run, deps.config, seen, "2026-01-01T13", [], panes)).toEqual(["DEAD_PANE w:p1"]);
});

test("the host guard alerts on low disk, clears when it recovers, and flips compute readiness on load", () => {
  const t = { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 50, panesMax: 20 };
  const st = { alerting: false } as { alerting: boolean; computeReady?: boolean };
  const healthy = { load1: 40, memFreePct: 50, diskFreeGb: 200, swapFreeGb: 4, panes: 5 };
  expect(guardTick(healthy, t, st)).toEqual(["HOST_GUARD COMPUTE_READY load 40 < 80"]);
  expect(guardTick({ ...healthy, diskFreeGb: 12 }, t, st)).toEqual(["HOST_GUARD ALERT disk free 12 GB < 50 GB"]);
  expect(guardTick({ ...healthy, diskFreeGb: 12 }, t, st)).toEqual([]);
  const recovered = guardTick({ ...healthy, load1: 120 }, t, st);
  expect(recovered[0]).toStartWith("HOST_GUARD CLEAR");
  expect(recovered.slice(1)).toEqual(["HOST_GUARD COMPUTE_BUSY load 120"]);
});

test("a heavy slot waits for load to drop, and a slot held by a dead process is taken over", async () => {
  const dir = join(state.dir, "heavy");
  const clock = fakeClock(T0);
  let loads = [120, 95, 40];
  const base = { dir, slots: 1, maxLoad: 80, clock, pid: 4242, load: async () => loads.shift() ?? 40 };
  const slot = await acquireSlot({ ...base, alive: () => true }, "build");
  expect(loads).toEqual([]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(slot, "owner"), "999999 other 2026-01-01T00:00:00Z");
  loads = [10];
  let polls = 0;
  const stolen = await acquireSlot({ ...base, alive: (pid) => pid !== 999999, clock: { ...clock, sleep: async () => { polls++; } } }, "test");
  expect(stolen).toBe(slot);
  expect(polls).toBe(0);
  releaseSlot(stolen);
});

test("a slot whose owner is alive is not taken", async () => {
  const dir = join(state.dir, "heavy");
  mkdirSync(join(dir, "slot.1"), { recursive: true });
  writeFileSync(join(dir, "slot.1", "owner"), "1 busy now");
  utimesSync(join(dir, "slot.1"), new Date(), new Date());
  let polls = 0;
  const clock = { now: () => Date.now(), sleep: async () => { polls++; if (polls > 2) throw new Error("stop"); } };
  await expect(acquireSlot({ dir, slots: 1, maxLoad: 80, clock, pid: 7, load: async () => 10, alive: () => true }, "x", 1)).rejects.toThrow("stop");
});

const heldSlot = (dir: string, n: number, pid: number, since: number) => {
  mkdirSync(join(dir, `slot.${n}`), { recursive: true });
  writeFileSync(join(dir, `slot.${n}`, "owner"), `${pid} running eval ${new Date(since).toISOString()}`);
};
const eval25: Usage = { gpu: 25, gpuMem: null, cpu: 10, mem: 10 };
const headroomDeps = (dir: string, host: () => Usage, logs: string[], clock: Clock = fakeClock(T0)): SlotDeps & { calls: number } => {
  const d = {
    dir, slots: 1, maxLoad: 80, clock, pid: 4242, load: async () => 10, alive: (pid: number) => pid !== 999999, calls: 0,
    headroom: { maxSlots: 4, free: 30, settleSec: 120, usage: async (pids: readonly number[]) => { d.calls++; return { host: host(), unified: true, jobs: pids.map(() => eval25), memTotalKb: 100_000_000 }; } },
    log: (l: string) => logs.push(l),
  };
  return d;
};
const stopAfter = (n: number) => { let polls = 0; return { now: () => T0, sleep: async () => { if (++polls >= n) throw new Error("stop"); } }; };

test("a heavy job starts beside a running one when every resource keeps 30% free with it, and waits when one would not", async () => {
  const dir = join(state.dir, "heavy");
  heldSlot(dir, 1, 100, T0 - 10 * MIN);
  const logs: string[] = [];
  const slot = await acquireSlot(headroomDeps(dir, () => ({ gpu: 45, gpuMem: null, cpu: 20, mem: 25 }), logs), "eval-b");
  expect(slot).toBe(join(dir, "slot.2"));
  expect(logs).toEqual(["HEAVY_ADMIT eval-b slot.2: 1 running beside it; gpu 45%+25% -> 30% free, cpu 20%+10% -> 70% free, mem(unified) 25%+10% -> 65% free (needs 30% free each)"]);
  heldSlot(dir, 2, 101, T0 - 10 * MIN);
  const waits: string[] = [];
  const busy = headroomDeps(dir, () => ({ gpu: 46, gpuMem: null, cpu: 20, mem: 25 }), waits, stopAfter(3));
  await expect(acquireSlot(busy, "eval-c", 1)).rejects.toThrow("stop");
  expect(waits).toEqual(["HEAVY_WAIT eval-c: 2 running; gpu 46%+25% -> 29% free, cpu 20%+10% -> 70% free, mem(unified) 25%+10% -> 65% free (needs 30% free each)"]);
  expect(busy.calls).toBe(3);
});

test("with --mem even the first heavy job waits until its memory keeps headroom free, counting what a running job said it needs and does not use yet", async () => {
  const dir = join(state.dir, "heavy");
  // Given: nothing runs, half of 100,000,000 KB is in use
  const waits: string[] = [];
  await expect(acquire(headroomDeps(dir, () => ({ gpu: 0, gpuMem: null, cpu: 0, mem: 50 }), waits, stopAfter(2)), "big", { pollMs: 1, memKb: 30_000_000 })).rejects.toThrow("stop");
  expect(waits).toEqual(["HEAVY_WAIT big: memory: needs 28.6G, 47.7G available, 0M held for running jobs still loading -> 20% free (needs 30% free)"]);
  const logs: string[] = [];
  const got = await acquire(headroomDeps(dir, () => ({ gpu: 0, gpuMem: null, cpu: 0, mem: 50 }), logs), "fits", { pollMs: 1, memKb: 15_000_000 });
  expect(got).toEqual({ slot: join(dir, "slot.1") });
  expect(readFileSync(join(dir, "slot.1", "mem"), "utf8")).toBe("15000000");
  rmSync(join(dir, "slot.1"), { recursive: true });
  // Given: a job said 40,000,000 KB and uses 10% (10,000,000 KB) so far, the host is 25% used: 30,000,000 KB more is coming
  heldSlot(dir, 1, 100, T0 - 10 * MIN);
  writeFileSync(join(dir, "slot.1", "mem"), "40000000");
  const host = () => ({ gpu: 45, gpuMem: null, cpu: 20, mem: 25 });
  const held: string[] = [];
  await expect(acquire(headroomDeps(dir, host, held, stopAfter(2)), "second", { pollMs: 1, memKb: 20_000_000 })).rejects.toThrow("stop");
  expect(held).toEqual(["HEAVY_WAIT second: memory: needs 19.1G, 71.5G available, 28.6G held for running jobs still loading -> 25% free (needs 30% free)"]);
  const beside: string[] = [];
  expect(await acquire(headroomDeps(dir, host, beside), "small", { pollMs: 1, memKb: 10_000_000 })).toEqual({ slot: join(dir, "slot.2") });
  expect(beside).toEqual(["HEAVY_ADMIT small slot.2: 1 running beside it; gpu 45%+25% -> 30% free, cpu 20%+10% -> 70% free (needs 30% free each); memory: needs 9.5G, 71.5G available, 28.6G held for running jobs still loading -> 35% free (needs 30% free)"]);
});

test("a heavy job waits while the last one taken has not shown its load, and two waiters never take one headroom twice", async () => {
  const dir = join(state.dir, "heavy");
  heldSlot(dir, 1, 100, T0 - 30_000);
  const logs: string[] = [];
  const settling = headroomDeps(dir, () => ({ gpu: 0, gpuMem: null, cpu: 0, mem: 0 }), logs, stopAfter(2));
  await expect(acquireSlot(settling, "eval-b", 1)).rejects.toThrow("stop");
  expect(logs).toEqual(["HEAVY_WAIT eval-b: slot.1 was taken 30s ago; its load shows after 120s"]);
  expect(settling.calls).toBe(0);
  heldSlot(dir, 1, 100, T0 - 10 * MIN);
  const both: string[] = [];
  const a = acquireSlot(headroomDeps(dir, () => ({ gpu: 0, gpuMem: null, cpu: 0, mem: 0 }), both, stopAfter(3)), "eval-b", 1);
  // eval-c stands behind eval-b in the line first, then sees eval-b's slot settle
  const b = acquireSlot(headroomDeps(dir, () => ({ gpu: 0, gpuMem: null, cpu: 0, mem: 0 }), both, stopAfter(20)), "eval-c", 1);
  const got = await Promise.allSettled([a, b]);
  expect(got.filter((g) => g.status === "fulfilled").length).toBe(1);
  expect(both.filter((l) => l.startsWith("HEAVY_ADMIT")).length).toBe(1);
  expect(both.some((l) => /^HEAVY_WAIT eval-[bc]: slot\.2 was taken 0s ago/.test(l))).toBe(true);
});

test("a slot whose pid now belongs to a process started after the claim is taken at the next admission; a live holder keeps its slot", async () => {
  // Given: slot.1 held by a job that started before its claim, slot.2 by a pid the system gave to a newer process
  const dir = join(state.dir, "heavy");
  heldSlot(dir, 1, 100, T0 - 10 * MIN);
  heldSlot(dir, 2, 200, T0 - 60 * MIN);
  const started: Record<number, number> = { 100: T0 - 11 * MIN, 200: T0 - 5 * MIN };
  const logs: string[] = [];
  const deps = { ...headroomDeps(dir, () => ({ gpu: 45, gpuMem: null, cpu: 20, mem: 25 }), logs), alive: (pid: number, since?: number) => since === undefined || (started[pid] ?? Infinity) <= since };
  // When
  const slot = await acquireSlot(deps, "eval-b");
  // Then: slot.2 is reused, only slot.1 counts beside it, and the 30% verdict reads as before
  expect(slot).toBe(join(dir, "slot.2"));
  expect(logs).toEqual(["HEAVY_ADMIT eval-b slot.2: 1 running beside it; gpu 45%+25% -> 30% free, cpu 20%+10% -> 70% free, mem(unified) 25%+10% -> 65% free (needs 30% free each)"]);
  expect(readFileSync(join(dir, "slot.1", "owner"), "utf8")).toStartWith("100 running eval");
  // and the real check tells this process from one that took a slot before it started
  expect(pidAlive(process.pid, Date.now())).toBe(true);
  expect(pidAlive(process.pid, performance.timeOrigin - MIN)).toBe(false);
});

test("a holder that ends after its slot was taken over leaves the new job's slot alone", async () => {
  const dir = join(state.dir, "heavy");
  const slot = await acquireSlot({ dir, slots: 1, maxLoad: 80, clock: fakeClock(T0), pid: 4242, load: async () => 10, alive: () => true }, "old");
  writeFileSync(join(slot, "owner"), `5151 next-job ${new Date(T0 + MIN).toISOString()}`);
  releaseSlot(slot);
  expect(readFileSync(join(slot, "owner"), "utf8")).toStartWith("5151 next-job");
});

test("a waiter for full slots is told which jobs hold them and for how long", async () => {
  const dir = join(state.dir, "heavy");
  [1, 2, 3, 4].forEach((n) => {
    mkdirSync(join(dir, `slot.${n}`), { recursive: true });
    writeFileSync(join(dir, `slot.${n}`, "owner"), `${100 + n} e7-eval-${n} ${new Date(T0 - n * 70 * MIN).toISOString()}`);
  });
  const logs: string[] = [];
  await expect(acquireSlot(headroomDeps(dir, () => ({ gpu: 0, gpuMem: null, cpu: 0, mem: 0 }), logs, stopAfter(2)), "eval-e", 1)).rejects.toThrow("stop");
  expect(logs).toEqual(["HEAVY_WAIT eval-e: all 4 slots busy: slot.1 e7-eval-1 pid 101 1h10m, slot.2 e7-eval-2 pid 102 2h20m, slot.3 e7-eval-3 pid 103 3h30m, slot.4 e7-eval-4 pid 104 4h40m"]);
});

test("waiters take a freed slot in the order they came, not by process id", async () => {
  // Given: one slot held, three waiters arriving one ms apart with falling pids; the earliest polls slowest
  const dir = join(state.dir, "heavy");
  heldSlot(dir, 1, 100, T0 - 10 * MIN);
  let holderAlive = true;
  const order: string[] = [];
  const waiter = async (label: string, pid: number, at: number) => {
    const hops = 3 - (at - T0);
    const clock = { now: () => at, sleep: async () => { for (let i = 0; i < hops; i++) await new Promise<void>((r) => setImmediate(r)); } };
    const slot = await acquireSlot({ dir, slots: 1, maxLoad: 80, clock, pid, load: async () => 10, alive: (p) => (p === 100 ? holderAlive : true) }, label, 1);
    order.push(label);
    releaseSlot(slot);
  };
  const all = Promise.all([waiter("first", 900, T0), waiter("second", 800, T0 + 1), waiter("third", 700, T0 + 2)]);
  // When: the holder ends after every waiter found the slot taken
  await new Promise<void>((r) => setImmediate(r));
  holderAlive = false;
  await all;
  // Then
  expect(order).toEqual(["first", "second", "third"]);
});

test("GPU, per-process and process-tree readings parse as nvidia-smi and ps print them on a GB10", () => {
  expect(parseGpuQuery("77, [N/A], [N/A]")).toEqual({ util: 77, memUsedMib: null, memTotalMib: null });
  expect(parseGpuQuery("40, 8000, 16000\n60, 4000, 16000")).toEqual({ util: 50, memUsedMib: 12000, memTotalMib: 32000 });
  const pmon = [
    "# gpu         pid   type     sm    mem    enc    dec    jpg    ofa     fb   ccpm    command ",
    "# Idx           #    C/G      %      %      %      %      %      %     MB     MB    name ",
    "    0       3292     G      -      -      -      -      -      -     18      0    Xorg           ",
    "    0    1977792     C     34      0      -      -      -      -    289      0    python         ",
  ].join("\n");
  expect(parsePmon(pmon).get(1977792)).toEqual({ sm: 34, fbMib: 289 });
  expect(parsePmon(pmon).get(3292)).toEqual({ sm: 0, fbMib: 18 });
  const t = treeOf("   10     1  100  0.0\n   11    10 2000 100\n   12    11  500 50.5\n   13     1  900 99", 10);
  expect(t.pids.sort()).toEqual([10, 11, 12]);
  expect(t.rssKb).toBe(2600);
  expect(t.cpuPct).toBe(150.5);
});

test("adopting a lane refuses a Done line the watcher could never check", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await expect(adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "two clean QA passes", pane: "w:p2" })).rejects.toBeInstanceOf(LaunchError);
  const ok = await adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "closed acme/app#3", pane: "w:p2" });
  expect(ok.thread).toBe("none");
  await expect(adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "closed acme/app#3", pane: "w:p2" })).rejects.toThrow("already registered");
});

test("the session id is read from --session, then a child's environment, then the session file made at start", async () => {
  const info = JSON.stringify({ result: { process_info: { shell_pid: 10 } } });
  const fake = (extra: Record<string, string>) => async (argv: readonly string[]) => {
    const line = argv.join(" ");
    if (line.startsWith("herdr pane process-info")) return { code: 0, out: info, err: "" };
    const hit = Object.entries(extra).find(([k]) => line.startsWith(k));
    return { code: hit ? 0 : 1, out: hit?.[1] ?? "", err: "" };
  };
  const table = [{ pid: 10, ppid: 1, cmd: "zsh" }, { pid: 11, ppid: 10, cmd: "/bin/bun /x/senpi/dist/bundle/cli.js --extension /x/plugin" }, { pid: 12, ppid: 11, cmd: "bun /x/mcp/cli.js mcp" }];
  const flagged = [{ pid: 10, ppid: 1, cmd: "zsh" }, { pid: 11, ppid: 10, cmd: "omo --session 01a0e129-23ce-7329-bbd1-fc0c1e7a6b8b" }];
  expect((await resolveSession("w:p1", "/repo", flagged, { run: fake({}), sessionsDir: "/s" })).via).toBe("argv");
  expect((await resolveSession("w:p1", "/repo", table, { run: fake({ "ps eww -o command= -p 12": "bun mcp PI_SESSION_ID=01a11440-ee81-7f90-b2ed-dcc7d51a0adf X=1" }), sessionsDir: "/s" })).id).toBe("01a11440-ee81-7f90-b2ed-dcc7d51a0adf");
  const listDir = () => ["2026-01-01T09-00-00-000Z_01a10000-0000-7000-8000-000000000000.jsonl", "2026-01-01T12-00-02-113Z_01a11440-ee81-7f90-b2ed-dcc7d51a0adf.jsonl"];
  const byStart = await resolveSession("w:p1", "/repo", table, { run: fake({ "ps eww": "bun mcp X=1", "ps -o lstart=": "Thu Jan  1 12:00:01 2026 GMT" }), sessionsDir: "/s", listDir });
  expect(byStart).toEqual({ id: "01a11440-ee81-7f90-b2ed-dcc7d51a0adf", via: "start-time", pid: 11 });
});

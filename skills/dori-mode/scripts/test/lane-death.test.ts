import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";

import { type FlowDeps, watchTick } from "../src/done-flow.ts";
import { writeFrozen } from "../src/frozen.ts";
import type { JobStat } from "../src/job-control.ts";
import { laneSuspendTick, type SuspendIO } from "../src/lane-death.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-10-30T02:33:00Z");
const S = 1_000;
const OOM = "aoe-session-8f671fcc7b52492e-1793325137515.scope: Failed with result 'oom-kill'.";

let state: ReturnType<typeof withState>;
beforeEach(() => (state = withState()));
afterEach(() => state.done());

const laneOf = (key: string, pane: string, patch: Partial<Lane> = {}): Lane => ({ key, title: key, thread: "discord:1", brief: "/b.md", done: "file /d", openedAt: new Date(T0 - 60 * 60 * S).toISOString(), pane, ...patch });

// panes: "live" | "dead <status>" | "gone"; journal: what journalctl --user prints for the grep
const world = (panes: Record<string, string>, journal: string[] = []) => {
  const w: World = newWorld();
  w.screens["lead:p1"] = "❯ ";
  const deps = (ms: number): FlowDeps => {
    const base = depsFor(w, fakeClock(ms), state.dir, { backend: "aoe", leadPane: "lead:p1" });
    return {
      ...base,
      run: async (argv, opts) => {
        const pane = (argv[argv.indexOf("-t") + 1] ?? "").replace(/^=|:$/g, "");
        if (argv[0] === "tmux" && argv[1] === "has-session" && pane in panes) return { code: panes[pane] === "gone" ? 1 : 0, out: "", err: "" };
        if (argv[0] === "tmux" && argv[1] === "display-message" && argv.at(-1) === "#{pane_dead} #{pane_dead_status}" && pane in panes) return { code: 0, out: panes[pane]?.startsWith("dead") ? `1 ${panes[pane]?.split(" ")[1]}` : "0 ", err: "" };
        if (argv[0] === "journalctl") {
          w.calls.push([...argv]);
          const g = argv[argv.indexOf("-g") + 1] ?? "";
          return { code: 0, out: journal.filter((l) => l.includes(g)).join("\n"), err: "" };
        }
        return base.run(argv, opts);
      },
    };
  };
  return { w, deps };
};

const died = (lines: string[]) => lines.filter((l) => l.startsWith("LANE_DIED"));

test("a lane whose pane dies in an OOM is told to the lead once within two checks, with 메모리 부족 from its scope's journal line", async () => {
  // Given: the asr lane's pane is dead (status 143) and this user's journal has its scope's oom-kill
  const panes: Record<string, string> = { "aoe_asr-nemotron-compare_8f671fcc": "dead 143", "aoe_other_11112222": "live" };
  const { w, deps } = world(panes, [OOM, "aoe-session-11112222aaaa.scope: Consumed 1s CPU time."]);
  await deps(T0).registry.write(laneOf("asr-nemotron-compare", "aoe_asr-nemotron-compare_8f671fcc"));
  await deps(T0).registry.write(laneOf("other", "aoe_other_11112222"));
  // When / Then: the first check only notes it, the second (30 s later) tells the lead
  expect(died(await watchTick(deps(T0)))).toEqual([]);
  expect(died(await watchTick(deps(T0 + 30 * S)))).toEqual([`LANE_DIED asr-nemotron-compare aoe_asr-nemotron-compare_8f671fcc: oom-kill (journal: ${OOM})`, "LANE_DIED_TOLD asr-nemotron-compare lead:p1"]);
  expect(sent(w)).toEqual(["[DORI] 레인 asr-nemotron-compare 꺼짐(메모리 부족) — 이어서 살릴지 정해"]);
  expect(w.calls.find((c) => c[0] === "journalctl")).toEqual(["journalctl", "--user", "--since", `@${Math.floor((T0 - 30 * 60 * S) / 1000)}`, "--no-pager", "-o", "cat", "-g", "aoe-session-8f671fcc"]);
  // and never again while it stays dead
  expect(died(await watchTick(deps(T0 + 60 * S)))).toEqual([]);
  expect(sent(w).length).toBe(1);
  // revived, then dead again without an OOM: told again, with the exit status
  panes["aoe_asr-nemotron-compare_8f671fcc"] = "live";
  expect(died(await watchTick(deps(T0 + 90 * S)))).toEqual([]);
  expect((await deps(T0).registry.read("asr-nemotron-compare"))?.died).toBeUndefined();
  panes["aoe_asr-nemotron-compare_8f671fcc"] = "dead 1";
  const { deps: noOom } = { deps: (ms: number) => ({ ...deps(ms), run: async (argv: readonly string[], opts?: Parameters<FlowDeps["run"]>[1]) => (argv[0] === "journalctl" ? { code: 0, out: "", err: "" } : deps(ms).run([...argv], opts)) }) };
  expect(died(await watchTick(noOom(T0 + 120 * S)))).toEqual([]);
  expect(died(await watchTick(noOom(T0 + 150 * S)))).toEqual(["LANE_DIED asr-nemotron-compare aoe_asr-nemotron-compare_8f671fcc: pane dead, status 1", "LANE_DIED_TOLD asr-nemotron-compare lead:p1"]);
  expect(sent(w).at(-1)).toBe("[DORI] 레인 asr-nemotron-compare 꺼짐(종료 코드 1) — 이어서 살릴지 정해");
});

test("a gone session is told as tmux 세션 없음; a paused lane and a pane back between the two checks are never told", async () => {
  const panes: Record<string, string> = { aoe_gone_aaaa1111: "gone", aoe_parked_bbbb2222: "gone", aoe_swap_cccc3333: "gone" };
  const { w, deps } = world(panes);
  await deps(T0).registry.write(laneOf("gone", "aoe_gone_aaaa1111"));
  await deps(T0).registry.write(laneOf("parked", "aoe_parked_bbbb2222", { status: "paused" }));
  await deps(T0).registry.write(laneOf("swap", "aoe_swap_cccc3333"));
  expect(died(await watchTick(deps(T0)))).toEqual([]);
  // a check soon after the first (a second watch) does not count as the confirming one
  expect(died(await watchTick(deps(T0 + 10 * S)))).toEqual([]);
  // a handover gave the swap lane a live pane before the second check
  panes.aoe_swap_cccc3333 = "live";
  expect(died(await watchTick(deps(T0 + 30 * S)))).toEqual(["LANE_DIED gone aoe_gone_aaaa1111: tmux session gone", "LANE_DIED_TOLD gone lead:p1"]);
  expect(sent(w)).toEqual(["[DORI] 레인 gone 꺼짐(tmux 세션 없음) — 이어서 살릴지 정해"]);
});

// handover-simplify on 2026-11-03: a rolled-back handover left its omo stopped behind its last busy screen for 18 hours
const held = (states: Record<number, "S" | "T" | "bg">): ((pid: number) => JobStat | undefined) => (pid) => {
  const s = states[pid];
  if (!s) return undefined;
  return { pid, state: s === "T" ? "T" : "S", ppid: 100, pgrp: pid, session: 100, tpgid: s === "bg" ? 100 : pid };
};
const shellOf = (pid: number): JobStat | undefined => (pid === 100 ? { pid: 100, state: "S", ppid: 1, pgrp: 100, session: 100, tpgid: 100 } : undefined);

test("a lane whose omo stays stopped reads as stopped once, the lead's own too; nothing is typed or signalled, and running again ends it", async () => {
  // Given: the lane's agent 200 is stopped (T) and the lead's agent 300 is a background job of its shell
  const { w, deps } = world({ "aoe_hs_aaaa1111": "live" });
  await deps(T0).registry.write(laneOf("handover-simplify", "aoe_hs_aaaa1111"));
  const states: Record<number, "S" | "T" | "bg"> = { 200: "T", 300: "bg" };
  const io: SuspendIO = { agentOf: async (pane) => (pane === "aoe_hs_aaaa1111" ? 200 : pane === "lead:p1" ? 300 : undefined), stat: (pid) => held(states)(pid) ?? shellOf(pid) };
  const tick = (ms: number) => laneSuspendTick(deps(ms), io, () => false);
  // When / Then: the first check only notes it, the second (30 s later) names both, the lead first
  expect(await tick(T0)).toEqual([]);
  expect(await tick(T0 + 30 * S)).toEqual([
    "LANE_SUSPENDED lead lead:p1: agent 300 background (state S, tty foreground group 100, its group 300); its screen is stale, so it reads as stopped, not busy",
    "LANE_SUSPENDED handover-simplify aoe_hs_aaaa1111: agent 200 stopped (state T, tty foreground group 200, its group 200); its screen is stale, so it reads as stopped, not busy",
  ]);
  // nothing goes to the lead's pane and no key or signal reaches any pane
  expect(sent(w)).toEqual([]);
  expect(w.calls.filter((c) => c[0] === "tmux" && c[1] === "send-keys")).toEqual([]);
  // still held: not named twice
  expect(await tick(T0 + 60 * S)).toEqual([]);
  expect(await tick(T0 + 90 * S)).toEqual([]);
  // the lead types fg for both: each runs again once, and a later stop is named again
  states[200] = "S";
  states[300] = "S";
  expect(await tick(T0 + 120 * S)).toEqual(["LANE_RUNNING_AGAIN lead lead:p1", "LANE_RUNNING_AGAIN handover-simplify aoe_hs_aaaa1111"]);
  expect(await tick(T0 + 150 * S)).toEqual([]);
  states[200] = "T";
  expect(await tick(T0 + 180 * S)).toEqual([]);
  expect((await tick(T0 + 210 * S)).map((l) => l.split(":")[0])).toEqual(["LANE_SUSPENDED handover-simplify aoe_hs_aaaa1111"]);
});

test("an agent a handover froze on purpose is never taken for a suspended lane", async () => {
  const { deps } = world({ "aoe_mv_bbbb2222": "live", "aoe_old_cccc3333": "live" });
  await deps(T0).registry.write(laneOf("moving", "aoe_mv_bbbb2222"));
  await deps(T0).registry.write(laneOf("frozenold", "aoe_old_cccc3333"));
  writeFrozen(state.dir, { pane: "aoe_old_cccc3333", aoeId: "x", at: new Date(T0).toISOString(), agentPid: 201, pids: [201] });
  mkdirSync(join(state.dir, "handover", "lanes"), { recursive: true });
  writeFileSync(join(state.dir, "handover", "lanes", "moving.lock"), JSON.stringify({ pid: 4242, at: new Date(T0).toISOString() }));
  const io: SuspendIO = { agentOf: async (pane) => (pane === "aoe_mv_bbbb2222" ? 200 : pane === "aoe_old_cccc3333" ? 201 : undefined), stat: (pid) => held({ 200: "T", 201: "T" })(pid) ?? shellOf(pid) };
  const tick = (ms: number) => laneSuspendTick(deps(ms), io, (pid) => pid === 4242);
  expect(await tick(T0)).toEqual([]);
  expect(await tick(T0 + 30 * S)).toEqual([]);
  expect(existsSync(join(state.dir, "suspended"))).toBe(false);
});

test("a failed lookup or an unreadable process keeps the mark, a watch restart does not name it again, and another agent in the pane is a new incident", async () => {
  // Given: a herdr lane whose agent 200 was named as a background job
  const { deps } = world({});
  await deps(T0).registry.write(laneOf("bg", "w5:p7"));
  const states: Record<number, "S" | "T" | "bg"> = { 200: "bg", 201: "T" };
  let agent = 200;
  let lookup: "ok" | "fails" | "unreadable" = "ok";
  const io: SuspendIO = {
    agentOf: async (pane) => {
      if (lookup === "fails") throw new Error("herdr down");
      return pane === "w5:p7" ? agent : undefined;
    },
    stat: (pid) => (lookup === "unreadable" ? undefined : held(states)(pid) ?? shellOf(pid)),
  };
  const tick = (ms: number) => laneSuspendTick(deps(ms), io, () => false);
  await tick(T0);
  expect((await tick(T0 + 30 * S)).map((l) => l.split(":")[0])).toEqual(["LANE_SUSPENDED bg w5"]);
  expect(existsSync(join(state.dir, "suspended", "w5_p7.json"))).toBe(true);
  // When: the lookup fails, then the process cannot be read, while the agent stays held
  lookup = "fails";
  expect(await tick(T0 + 60 * S)).toEqual([]);
  lookup = "unreadable";
  expect(await tick(T0 + 90 * S)).toEqual([]);
  lookup = "ok";
  // Then: the mark held (it is on disk, so a restarted watch reads it too): the same agent is not named again
  expect(await tick(T0 + 120 * S)).toEqual([]);
  expect(await tick(T0 + 150 * S)).toEqual([]);
  // When: the pane now runs another agent that is stopped too
  agent = 201;
  // Then: that is a new incident, confirmed on two checks like the first
  expect(await tick(T0 + 180 * S)).toEqual([]);
  expect((await tick(T0 + 210 * S)).map((l) => l.split(":")[0])).toEqual(["LANE_SUSPENDED bg w5"]);
  expect((await tick(T0 + 240 * S))).toEqual([]);
});

test("an agent replaced between the two checks is confirmed afresh: the new one is named only after its own second check", async () => {
  const { deps } = world({});
  await deps(T0).registry.write(laneOf("swap", "w5:p8"));
  let agent = 200;
  const io: SuspendIO = { agentOf: async (pane) => (pane === "w5:p8" ? agent : undefined), stat: (pid) => held({ 200: "T", 201: "T" })(pid) ?? shellOf(pid) };
  const tick = (ms: number) => laneSuspendTick(deps(ms), io, () => false);
  expect(await tick(T0)).toEqual([]);
  agent = 201;
  expect(await tick(T0 + 30 * S)).toEqual([]);
  const named = await tick(T0 + 60 * S);
  expect(named).toHaveLength(1);
  expect(named[0]).toStartWith("LANE_SUSPENDED swap w5:p8: agent 201 stopped");
});

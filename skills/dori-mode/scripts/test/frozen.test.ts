import { afterEach, beforeEach, expect, test } from "bun:test";

import { agentTree, closeDueFrozen, type FrozenRecord, readFrozen, thawFrozen, writeFrozen } from "../src/frozen.ts";
import { deadPaneTick, newDeadPaneState } from "../src/dead-panes.ts";
import { syncRegistry } from "../src/sync.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState, type World } from "./fakes.ts";

const OLD = "aoe_lead_0a0a0a0a";
const OLD_ID = "0a0a0a0a11112222";
const rec = (patch: Partial<FrozenRecord> = {}): FrozenRecord => ({ pane: OLD, aoeId: OLD_ID, at: "2026-10-11T16:35:00.000Z", agentPid: 11, pids: [11, 12, 13], closeAt: "2026-10-12T16:35:00.000Z", to: "aoe_lead2_5e5e5e5e", oldLog: "/s/old.jsonl", ...patch });

let state: { dir: string; done: () => void };
let w: World;
let sigs: string[];
const signal = (pid: number, sig: "SIGSTOP" | "SIGCONT") => {
  sigs.push(`${sig} ${pid}`);
  return true;
};

beforeEach(() => {
  state = withState();
  w = newWorld();
  w.aoe = [{ id: OLD_ID, title: "lead", path: "/work/lead", tool: "omo", profile: "main" }];
  w.tmux = [OLD];
  sigs = [];
});
afterEach(() => state.done());

test("the agent's tree leaves out the process that asks and its ancestors, so a run inside the pane cannot stop itself", () => {
  // Given: shell 10, agent 11, its bash tool 12 running this command 14, and a monitor 13
  const table = [{ pid: 10, ppid: 1, cmd: "bash" }, { pid: 11, ppid: 10, cmd: "node /x/senpi/dist/bundle/cli.js" }, { pid: 12, ppid: 11, cmd: "bash -c dori" }, { pid: 13, ppid: 11, cmd: "tail -F x" }, { pid: 14, ppid: 12, cmd: "bun cli.ts handover" }];
  // When / Then
  expect(agentTree(table, 10, 99).pids).toEqual([11, 12, 13, 14]);
  expect(agentTree(table, 10, 14).pids).toEqual([13]);
  expect(agentTree([{ pid: 10, ppid: 1, cmd: "bash" }], 10, 99)).toEqual({ pids: [] });
});

test("a frozen old lead is closed only once its close time passed: resumed children first, then stopped and trashed, its record gone", async () => {
  // Given
  writeFrozen(state.dir, rec());
  const deps = { run: fakeRunner(w), procs: async () => [], signal };
  // When
  const early = await closeDueFrozen(deps, state.dir, Date.parse("2026-10-12T16:34:00Z"));
  const due = await closeDueFrozen(deps, state.dir, Date.parse("2026-10-12T16:35:00Z"));
  // Then
  expect(early).toEqual([]);
  expect(due).toEqual([`HANDOVER_OLD_CLOSED aoe session ${OLD_ID} (${OLD}) stopped and trashed; its log stays at /s/old.jsonl`]);
  expect(sigs).toEqual(["SIGCONT 13", "SIGCONT 12", "SIGCONT 11"]);
  expect(w.calls.some((c) => c[0] === "aoe" && c[1] === "rm" && c[2] === OLD_ID)).toBe(true);
  expect(readFrozen(state.dir)).toEqual([]);
});

test("a frozen session kept by hand is never closed by the clock; one already gone only loses its record; thaw resumes and forgets it", async () => {
  // Given
  writeFrozen(state.dir, rec({ closeAt: undefined }));
  writeFrozen(state.dir, rec({ pane: "aoe_gone_77777777" }));
  const deps = { run: fakeRunner(w), procs: async () => [], signal };
  // When
  const lines = await closeDueFrozen(deps, state.dir, Date.parse("2026-10-20T00:00:00Z"));
  const thawed = thawFrozen({ signal }, state.dir, OLD);
  // Then
  expect(lines).toEqual(["HANDOVER_OLD_GONE aoe_gone_77777777: the frozen session is no longer open; record removed"]);
  expect(thawed).toBe(`HANDOVER_OLD_THAWED ${OLD}: 3/3 processes resumed (agent 11)`);
  expect(sigs).toEqual(["SIGCONT 13", "SIGCONT 12", "SIGCONT 11"]);
  expect(readFrozen(state.dir)).toEqual([]);
  expect(thawFrozen({ signal }, state.dir, OLD)).toStartWith(`FROZEN_NONE ${OLD}`);
  expect(w.calls.some((c) => c[0] === "aoe" && c[1] === "rm")).toBe(false);
});

test("sync and dead-panes leave a frozen old lead alone: it is neither an unregistered session nor a dead pane", async () => {
  // Given
  const base = depsFor(w, fakeClock(0), state.dir, { backend: "herdr", deadPanePatterns: ["has stopped"] });
  const deps = { ...base, run: async (argv: readonly string[]) => (argv[2] === "process-info" ? { code: 0, out: JSON.stringify({ result: { process_info: { shell_pid: 0 } } }), err: "" } : base.run(argv)) };
  w.panes = [{ pane_id: OLD, workspace_id: "w1", agent: "omo", title: "lead" }];
  w.screen = "omo has stopped";
  // When
  const before = (await syncRegistry(deps, false)).unregistered.map((r) => r.pane);
  const panes = newDeadPaneState();
  await deadPaneTick(deps.run, deps.config, new Set(), "h1", [], panes);
  const deadBefore = await deadPaneTick(deps.run, deps.config, new Set(), "h1", [], panes);
  writeFrozen(state.dir, rec());
  const after = (await syncRegistry(deps, false)).unregistered.map((r) => r.pane);
  const deadAfter = await deadPaneTick(deps.run, deps.config, new Set(), "h2", [], panes);
  // Then
  expect(before).toEqual([OLD]);
  expect(deadBefore).toEqual([`DEAD_PANE ${OLD}`]);
  expect(after).toEqual([]);
  expect(deadAfter).toEqual([]);
});

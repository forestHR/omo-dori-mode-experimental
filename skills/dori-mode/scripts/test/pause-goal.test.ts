import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type FlowDeps, GoalUnverifiedError, pauseLane, resumeLane } from "../src/done-flow.ts";
import { goalFileOf, type GoalRead, readGoalFile } from "../src/goal.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

// dori pause pauses the omo goal of the lane's session and reads it back (ported from dori-superagent 0057f49, #12)
const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const PANE = "aoe_fix-a_abcdef12";
const lane: Lane = { key: "fix-a", title: "fix-a", thread: "discord:300000000000000003", pane: PANE, brief: "/b.md", done: "file /etc/hostname", cwd: "/repo", openedAt: new Date(T0).toISOString() };

let state: ReturnType<typeof withState>;
let world: World;
// the goal omo keeps for the session; typed /goal commands change it like omo does unless `deaf`
let goal: GoalRead;
let deaf: boolean;
const omoGoal = async (): Promise<GoalRead> => {
  if (!deaf && typeof goal === "object") {
    const typed = sent(world);
    if (goal.status === "active" && typed.at(-1) === "/goal pause") goal = { status: "paused" };
    if (goal.status === "paused" && typed.at(-1) === "/goal resume") goal = { status: "active" };
  }
  return goal;
};
const at = (ms: number, patch: Partial<FlowDeps> = {}): FlowDeps => ({ ...depsFor(world, fakeClock(ms), state.dir, { backend: "aoe", leadPane: "aoe_Dori_0a1b2c3d" }), readGoal: omoGoal, ...patch });
const read = async () => (await at(T0).registry.read("fix-a")) as Lane;

beforeEach(async () => {
  state = withState();
  world = newWorld();
  world.aoe = [{ id: "abcdef1200112233", title: "fix-a", path: "/repo", tool: "omo", profile: "main" }];
  world.tmux = [PANE];
  goal = { status: "active" };
  deaf = false;
  await at(T0).registry.write(lane);
});
afterEach(() => state.done());

test("pause types /goal pause, marks the lane paused once the goal reads back paused, and resume resumes that goal", async () => {
  expect(await pauseLane(at(T0), lane, "owner said wait")).toEqual(["LANE_PAUSED fix-a (was working) owner said wait", `GOAL_PAUSED fix-a ${PANE}: goal store reads paused`]);
  expect(sent(world)).toEqual(["/goal pause"]);
  expect(world.calls).toContainEqual(["tmux", "send-keys", "-t", `=${PANE}:`, "Enter"]);
  const paused = await read();
  expect([statusOf(paused), paused.pausedGoal]).toEqual(["paused", true]);

  expect(await resumeLane(at(T0 + 60_000), paused)).toEqual(["LANE_RESUMED fix-a working", `GOAL_RESUMED fix-a ${PANE}: goal store reads active`]);
  expect(sent(world)).toEqual(["/goal pause", "/goal resume"]);
  const resumed = await read();
  expect([statusOf(resumed), resumed.pausedGoal]).toEqual(["working", undefined]);
});

test("a goal pause that is not read back leaves the lane working: PAUSE_UNVERIFIED", async () => {
  deaf = true;
  const err = await pauseLane(at(T0), lane, "owner said wait").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(GoalUnverifiedError);
  expect((err as Error).message).toBe(`PAUSE_UNVERIFIED fix-a ${PANE}: /goal pause typed but the goal was not read back paused within 10 s; lane left working`);
  expect(statusOf(await read())).toBe("working");
});

test("a resume whose goal is not read back active leaves the lane paused: RESUME_UNVERIFIED", async () => {
  await pauseLane(at(T0), lane, "wait");
  deaf = true;
  await expect(resumeLane(at(T0 + 60_000), await read())).rejects.toThrow(`RESUME_UNVERIFIED fix-a ${PANE}: /goal resume typed but the goal was not read back active within 10 s; lane left paused`);
  expect(statusOf(await read())).toBe("paused");
});

test("no goal, or a goal the agent already paused or completed, is left alone and nothing is typed; resume leaves it too", async () => {
  for (const [g, why] of [["none", "no goal in its session"], [{ status: "paused" }, "its goal is paused, left as it is"], [{ status: "complete" }, "its goal is complete, left as it is"]] as const) {
    await at(T0).registry.write(lane);
    goal = g;
    expect((await pauseLane(at(T0), lane, "wait"))[1]).toBe(`GOAL_SKIPPED fix-a ${PANE}: ${why}`);
    expect((await read()).pausedGoal).toBeUndefined();
    expect(await resumeLane(at(T0), await read())).toEqual(["LANE_RESUMED fix-a working"]);
  }
  expect(sent(world)).toEqual([]);
});

test("a lane whose session is dead is paused without typing: nothing can continue there", async () => {
  const base = at(T0).run;
  const run: Runner = async (argv, o) => (argv[1] === "display-message" && argv.at(-1)?.includes("pane_dead") ? { code: 0, out: "1 143", err: "" } : base(argv, o));
  expect((await pauseLane(at(T0, { run }), lane, "wait"))[1]).toBe(`GOAL_SKIPPED fix-a ${PANE}: no live session (its program exited (status 143)), nothing to pause`);
  expect(sent(world)).toEqual([]);
});

test("without a goal file the screen is read back: a new 'Goal paused' line, even with omo's side panel on the row", async () => {
  goal = "unknown";
  const base = at(T0).run;
  const run: Runner = async (argv, o) => {
    if (argv[1] === "send-keys" && argv.at(-1) === "Enter") world.screen = "Goal paused (an old one, already on screen)\n Goal paused                                GOAL  paused · 4s\n Objective: x\n❯ ";
    return base(argv, o);
  };
  world.screen = "Goal paused (an old one, already on screen)\n❯ ";
  expect((await pauseLane(at(T0, { run }), lane, "wait"))[1]).toBe(`GOAL_PAUSED fix-a ${PANE}: screen shows Goal paused`);
});

test("the goal file is found next to the session's transcript and read like omo writes it", () => {
  const dir = join(state.dir, "sessions", "--repo--");
  const file = goalFileOf(join(dir, "2026-11-02T06-36-31-656Z_01a19afc-dfa3-7b9e-a5f9-6fd3cca67db3.jsonl"));
  expect(file).toBe(join(dir, "extensions", "goal", "01a19afc-dfa3-7b9e-a5f9-6fd3cca67db3.json"));
  expect(readGoalFile(file as string)).toBe("none");
  mkdirSync(join(dir, "extensions", "goal"), { recursive: true });
  writeFileSync(file as string, JSON.stringify({ version: 1, goal: { id: "g", status: "paused", objective: "x" } }));
  expect(readGoalFile(file as string)).toEqual({ status: "paused" });
  writeFileSync(file as string, "{ half");
  expect(readGoalFile(file as string)).toBe("unknown");
});

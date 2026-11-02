import { afterEach, beforeEach, expect, test } from "bun:test";
import { laneBackground } from "../src/background.ts";
import { appendFileSync, chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sessionPath, withPi } from "../src/aoe.ts";
import { leadAlertPoster } from "../src/autoturn.ts";
import { deadPaneTick, newDeadPaneState, UNRECOGNISED_ALERT_AFTER } from "../src/dead-panes.ts";
import { claimDone, type FlowDeps, watchTick } from "../src/done-flow.ts";
import type { GoalRead } from "../src/goal.ts";
import { RESUME_TEXT } from "../src/lead-limit.ts";
import type { Question } from "../src/messenger/discord-cards.ts";
import { missedAnswersTick, sawAnswer } from "../src/missed-answers.ts";
import type { DoriConfig } from "../src/config.ts";
import { eightSteps, launchEnvArgs, launchLane, withSessionId } from "../src/launch.ts";
import { listPanes, sendVerified } from "../src/panes.ts";
import { SUBMIT_TIMING } from "../src/submit.ts";
import type { Lane } from "../src/registry.ts";
import { argvSessionId, resolveSession } from "../src/session-id.ts";
import { depsFor, fakeClock, launchReadyPath, NEW_AOE_ID, newWorld, RUNNING, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const LANE_ID = "abcdef1200112233";
const PANE = "aoe_fix-a_abcdef12";

let state: ReturnType<typeof withState>;
let world: World;
// launches here start lanes whose goal store holds a goal; the tests of dori-superagent issue #50 below override it
const at = (ms: number): FlowDeps => ({ ...depsFor(world, fakeClock(ms), state.dir, { backend: "aoe", leadPane: "aoe_Dori_0a1b2c3d" }), readGoal: async () => ({ status: "active" }) });

let restorePath = () => {};
beforeEach(() => {
  restorePath = launchReadyPath();
  state = withState();
  world = newWorld();
  world.aoe = [
    { id: LANE_ID, title: "fix-a", path: "/repo", tool: "omo", profile: "main" },
    { id: "0a1b2c3d4e5f6a7b", title: "Dori", path: "/home/test/dori", tool: "omo", profile: "main" },
    { id: "0000ffff00000000", title: "stopped", path: "/repo", tool: "omo", profile: "main" },
  ];
  world.tmux = [PANE, "aoe_term_fix-a_abcdef12", "aoe_Dori_0a1b2c3d", "0"];
});
afterEach(() => {
  state.done();
  restorePath();
});

test("each running aoe session is one pane named by its tmux session; terminals and stopped sessions are not panes", async () => {
  const panes = await listPanes(at(T0).run, "aoe");
  expect(panes.map((p) => p.pane_id)).toEqual([PANE, "aoe_Dori_0a1b2c3d"]);
  expect(panes[0]).toEqual({ pane_id: PANE, workspace_id: "main", agent: "omo", title: "fix-a", cwd: "/repo" });
});

test("a launch opens an aoe session, waits for the prompt and types the lane prompt as one argv argument", async () => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const r = await launchLane(at(T0), { noThread: "test lane", key: "smoke", title: "smoke", brief, done: "file /tmp/ok", cwd: "/tmp/w" });
  expect(world.calls).toContainEqual(["aoe", "add", "/tmp/w", "-t", "smoke", "--tool", "omo", "-l", "--extra-args", "--model anthropic/claude-opus-5-5"]);
  const pane = `aoe_smoke_${NEW_AOE_ID.slice(0, 8)}`;
  expect(r.lane.pane).toBe(pane);
  expect(r.startup).toBe(`STARTUP_OK smoke ${pane}`);
  expect(sent(world)).toHaveLength(1);
  expect(sent(world)[0]).toBe(`ulw set goal and work. Read and execute the lane brief at ${brief} in full. You are the smoke lane; report as the brief's footer says.`);
  expect(world.calls).toContainEqual(["tmux", "send-keys", "-t", `=${pane}:`, "Enter"]);
  expect(await Bun.file(brief).text()).toContain(`run ["dori","type","aoe_Dori_0a1b2c3d","--text","<report line>"]`);
  expect(await Bun.file(brief).text()).not.toContain("send-keys");
});

const GUARD = { CUDA_VISIBLE_DEVICES: "" };
const launchWith = async (patch: Partial<DoriConfig>, useGpu?: boolean, key = "gg") => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const deps = { ...at(T0), config: { ...at(T0).config, ...patch } };
  return { deps, r: await launchLane(deps, { noThread: "test lane", key, title: key, brief, done: "file /tmp/ok", cwd: `/tmp/${key}`, ...(useGpu ? { useGpu } : {}) }) };
};

test("launchEnv: the launch names each variable in tmux update-environment once, runs aoe add with it, and the session has it", async () => {
  world.updateEnv.push("OTHER");
  const { r } = await launchWith({ launchEnv: GUARD });
  expect(r.startup).toBe(`STARTUP_OK gg aoe_gg_${NEW_AOE_ID.slice(0, 8)}`);
  expect(world.updateEnv).toEqual(["DISPLAY", "SSH_AUTH_SOCK", "OTHER", "CUDA_VISIBLE_DEVICES"]);
  expect(world.aoeEnv).toEqual([GUARD]);
  expect(world.sessionEnv[`aoe_gg_${NEW_AOE_ID.slice(0, 8)}`]?.CUDA_VISIBLE_DEVICES).toBe("");
  expect(r.lane.useGpu).toBeUndefined();
  // a second launch finds the name there and does not append it again
  await launchWith({ launchEnv: GUARD }, false, "hh");
  expect(world.updateEnv.filter((n) => n === "CUDA_VISIBLE_DEVICES")).toHaveLength(1);
});

test("--use-gpu: aoe add runs with the launchEnv names removed, the lane is prompted, and the registry keeps useGpu", async () => {
  const { deps, r } = await launchWith({ launchEnv: GUARD }, true);
  expect(r.startup).toStartWith("STARTUP_OK gg");
  expect(world.aoeEnv).toEqual([{ CUDA_VISIBLE_DEVICES: undefined }]);
  expect(sent(world)).toHaveLength(1);
  expect((await deps.registry.read("gg"))?.useGpu).toBe(true);
});

test("no launchEnv: the launch leaves tmux options alone and runs aoe add with the plain environment", async () => {
  const { r } = await launchWith({});
  expect(r.startup).toStartWith("STARTUP_OK gg");
  expect(world.aoeEnv).toEqual([undefined]);
  expect(world.calls.some((c) => c[0] === "tmux" && /^(show|set)-(options|option|environment)$/.test(c[1] ?? ""))).toBe(false);
});

test("a session tmux did not give launchEnv gets no lane prompt: STARTUP_ERROR names the variable", async () => {
  world.dropEnv = true;
  const { r } = await launchWith({ launchEnv: GUARD });
  expect(r.startup).toBe(`STARTUP_ERROR gg aoe_gg_${NEW_AOE_ID.slice(0, 8)}: launchEnv not in the session: CUDA_VISIBLE_DEVICES=(unset); the lane prompt was not sent`);
  expect(sent(world)).toEqual([]);
});

// a bin dir holding an executable node (or, with bun, a node that is a link to bun as ~/.bun/bin/node can be)
const nodeDir = (dir: string, opts: { bun?: boolean; broken?: boolean } = {}): string => {
  mkdirSync(dir, { recursive: true });
  if (opts.bun) {
    writeFileSync(join(dir, "bun"), "#!/bin/sh\n");
    chmodSync(join(dir, "bun"), 0o755);
    symlinkSync("bun", join(dir, "node"));
  } else {
    writeFileSync(join(dir, "node"), "#!/bin/sh\n");
    chmodSync(join(dir, "node"), opts.broken ? 0o644 : 0o755);
  }
  return dir;
};
const nvmWith = (root: string, versions: string[], alias?: Record<string, string>): string => {
  for (const v of versions) nodeDir(join(root, "versions", "node", v, "bin"));
  for (const [name, to] of Object.entries(alias ?? {})) {
    mkdirSync(join(root, "alias", name, ".."), { recursive: true });
    writeFileSync(join(root, "alias", name), `${to}\n`);
  }
  return root;
};

test("sessionPath: a PATH whose node is real stays as it is; without node the nvm node goes in (self-restart.sh order); nothing at all is undefined", () => {
  const d = state.dir;
  const bare = `${join(d, "bunbin")}:/usr/bin:/bin`;
  mkdirSync(join(d, "bunbin"));
  // a caller with a working node keeps its PATH, even when nvm's default is another version
  const own = nodeDir(join(d, "own"));
  const nvm = nvmWith(join(d, "nvm"), ["v22.22.0", "v24.15.0"], { default: "22" });
  expect(sessionPath(`${own}:/usr/bin`, nvm)).toBe(`${own}:/usr/bin`);
  // no node on PATH: nvm's default alias wins over the newer version, appended so nothing on PATH is shadowed
  expect(sessionPath(bare, nvm)).toBe(`${bare}:${nvm}/versions/node/v22.22.0/bin`);
  // lts/* -> lts/jod -> v22.x is followed through the alias files
  const lts = nvmWith(join(d, "nvm-lts"), ["v22.1.0", "v24.15.0"], { default: "lts/*", "lts/*": "lts/jod", "lts/jod": "v22.1.0" });
  expect(sessionPath(bare, lts)).toBe(`${bare}:${lts}/versions/node/v22.1.0/bin`);
  // no default alias: the newest version (by number, v24 over v9), and a newest whose node is not executable is skipped
  const plain = nvmWith(join(d, "nvm-plain"), ["v9.0.0", "v24.15.0"]);
  expect(sessionPath(bare, plain)).toBe(`${bare}:${plain}/versions/node/v24.15.0/bin`);
  nodeDir(join(plain, "versions", "node", "v25.0.0", "bin"), { broken: true });
  expect(sessionPath(bare, plain)).toBe(`${bare}:${plain}/versions/node/v24.15.0/bin`);
  // a node that is only a link to bun: nvm's node goes in front of that dir; without nvm the bun link stays
  const bunLink = nodeDir(join(d, "bunlink"), { bun: true });
  expect(sessionPath(`/usr/bin:${bunLink}:/bin`, nvm)).toBe(`/usr/bin:${nvm}/versions/node/v22.22.0/bin:${bunLink}:/bin`);
  expect(sessionPath(`/usr/bin:${bunLink}:/bin`, join(d, "no-nvm"))).toBe(`/usr/bin:${bunLink}:/bin`);
  // no node anywhere
  expect(sessionPath(bare, join(d, "no-nvm"))).toBeUndefined();
});

test("a launch from a PATH without node (a systemd unit's bare PATH) runs aoe add with nvm's node on PATH; with no node at all it is refused before aoe add", async () => {
  const saved = { PATH: process.env.PATH, NVM_DIR: process.env.NVM_DIR };
  const bare = `${join(state.dir, "bunbin")}:/nonexistent`;
  mkdirSync(join(state.dir, "bunbin"));
  try {
    process.env.PATH = bare;
    process.env.NVM_DIR = nvmWith(join(state.dir, "nvm"), ["v24.15.0"]);
    const { r } = await launchWith({ launchEnv: GUARD });
    expect(r.startup).toStartWith("STARTUP_OK gg");
    expect(world.aoeEnv).toEqual([{ ...GUARD, PATH: `${bare}:${process.env.NVM_DIR}/versions/node/v24.15.0/bin` }]);
    process.env.NVM_DIR = join(state.dir, "no-nvm");
    await expect(launchWith({}, false, "hh")).rejects.toThrow(/NO_NODE .*#!\/usr\/bin\/env node/);
    expect(world.calls.filter((c) => c[0] === "aoe" && c[1] === "add")).toHaveLength(1);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.NVM_DIR === undefined) delete process.env.NVM_DIR;
    else process.env.NVM_DIR = saved.NVM_DIR;
  }
});

test("launch-env prints NAME=VALUE for an open lane, --unset=NAME for a --use-gpu lane, a closed lane or another session, nothing without launchEnv", async () => {
  const deps = { ...at(T0), config: { ...at(T0).config, launchEnv: GUARD } };
  const base = { title: "t", thread: "none", brief: "/b", done: "file /x", openedAt: "2026-01-01T00:00:00Z" };
  await deps.registry.write({ ...base, key: "cpu", pane: "aoe_cpu_1" });
  await deps.registry.write({ ...base, key: "gpu", pane: "aoe_gpu_1", useGpu: true });
  await deps.registry.write({ ...base, key: "old", pane: "aoe_old_1", status: "closed" });
  expect(await launchEnvArgs(deps, "aoe_cpu_1")).toEqual(["CUDA_VISIBLE_DEVICES="]);
  expect(await launchEnvArgs(deps, "aoe_gpu_1")).toEqual(["--unset=CUDA_VISIBLE_DEVICES"]);
  expect(await launchEnvArgs(deps, "aoe_old_1")).toEqual(["--unset=CUDA_VISIBLE_DEVICES"]);
  expect(await launchEnvArgs(deps, "aoe_Dori_0a1b2c3d")).toEqual(["--unset=CUDA_VISIBLE_DEVICES"]);
  expect(world.updateEnv).toContain("CUDA_VISIBLE_DEVICES");
  world.calls = [];
  expect(await launchEnvArgs(at(T0), "aoe_cpu_1")).toEqual([]);
  expect(world.calls).toEqual([]);
});

test("a launch whose Done only checks a file warns LAUNCH_DONE_WEAK and still launches; --done-weak-ok and a behavior signal stay quiet", async () => {
  const brief = join(state.dir, "brief.md");
  const warned: string[] = [];
  await Bun.write(brief, `# brief\n\n${await eightSteps()}\n`);
  const r = await launchLane(at(T0), { thread: "discord:100000000000000001", key: "weak", title: "weak", brief, done: "file /tmp/ok", cwd: "/tmp/w" }, (l) => warned.push(l));
  expect(r.startup).toStartWith("STARTUP_OK weak");
  expect(warned).toHaveLength(1);
  expect(warned[0]).toStartWith("LAUNCH_DONE_WEAK weak: every Done signal only checks files or text (file)");
  await launchLane(at(T0), { thread: "discord:100000000000000001", key: "weak-ok", title: "weak", brief, done: "file /tmp/ok", cwd: "/tmp/w", doneWeakOk: true }, (l) => warned.push(l));
  await launchLane(at(T0), { thread: "discord:100000000000000001", key: "strong", title: "strong", brief, done: 'file /tmp/ok; command ["bun","test"] stdout~" 0 fail"', cwd: "/tmp/w" }, (l) => warned.push(l));
  expect(warned).toHaveLength(1);
  const logged = (await Bun.file(at(T0).config.watchLog).text()).trim().split("\n");
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatch(/^\S+ launch LAUNCH_DONE_WEAK weak:/);
});

test("an agent that exits at start is a STARTUP_ERROR with its own message, without waiting out the prompt timeout", async () => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  world.screen = 'Error: Model "nosuch/model" not found. Use --list-models to see available models.\nPane is dead (status 1)';
  const r = await launchLane(at(T0), { noThread: "test lane", key: "smoke", title: "smoke", brief, done: "file /tmp/ok", cwd: "/tmp/w", model: "nosuch/model" });
  expect(r.startup).toBe(`STARTUP_ERROR smoke aoe_smoke_${NEW_AOE_ID.slice(0, 8)}: Model "nosuch/model" not found`);
  expect(world.calls.filter((c) => c[1] === "capture-pane")).toHaveLength(1);
  expect(sent(world)).toEqual([]);
});

test("five quiet minutes after a claim the lane's aoe session is stopped and trashed, never purged", async () => {
  const lane: Lane = { key: "fix-a", title: "fix-a", thread: "none", pane: PANE, brief: "/b.md", done: "file /etc/hostname", cwd: "/repo", openedAt: new Date(T0 - MIN).toISOString() };
  await at(T0).registry.write(lane);
  await claimDone(at(T0), lane, "file written");
  expect(sent(world)[0]).toStartWith("[LEAD] done claim recorded for fix-a");
  const lines = await watchTick(at(T0 + 5 * MIN + 1));
  expect(lines.at(-1)).toStartWith("LANE_CLOSED fix-a");
  expect(world.calls).toContainEqual(["aoe", "session", "stop", LANE_ID]);
  expect(world.calls).toContainEqual(["aoe", "rm", LANE_ID]);
  expect(world.calls.some((c) => c.includes("--purge"))).toBe(false);
});

test("only omo's input box counts as unsent text: a transcript line above it does not, text still in the box after a poll window gets one more Enter", async () => {
  const enters = () => world.calls.filter((c) => c[0] === "tmux" && c.at(-1) === "Enter").length;
  world.screen = "❯ [LEAD] stuck text still here\nworking...\n────\n❯ \n────";
  expect(await sendVerified(at(T0).run, at(T0).clock, at(T0).config, PANE, "[LEAD] stuck text still here")).toBe(true);
  expect(enters()).toBe(1);
  world.screen = "❯ ";
  world.stuckReads = SUBMIT_TIMING.clearPolls + 2; // the first two reads are the box before typing and the wait for the ❯ prompt
  expect(await sendVerified(at(T0).run, at(T0).clock, at(T0).config, PANE, "[LEAD] stuck text still here")).toBe(true);
  expect(enters()).toBe(3);
});

test("an aoe pane's session id is omo's --session-id under the tmux pane pid", async () => {
  const table = [{ pid: 10, ppid: 1, cmd: "/bin/bash /tmp/aoe-pane-env-XeE9cT" }, { pid: 11, ppid: 10, cmd: "/home/u/.bun/bin/bun /x/senpi/dist/bundle/cli.js --extension /x/plugin -e /x/pi-aoe-session-id.js --session-id 40ccbe13-33d4-4c1e-9d0e-0123456789ab" }];
  const hit = await resolveSession(PANE, "/repo", table, { run: at(T0).run, sessionsDir: "/s", backend: "aoe" });
  expect(hit).toEqual({ id: "40ccbe13-33d4-4c1e-9d0e-0123456789ab", via: "argv", pid: 11 });
  expect(world.calls).toContainEqual(["tmux", "display-message", "-p", "-t", `=${PANE}:`, "#{pane_pid}"]);
});

// ported from dori-superagent 40034ad (#7): no failure word is not a start; the agent has to show it runs
const after20s = (deps: ReturnType<typeof at>, then: () => void) => ({ ...deps, clock: { ...deps.clock, sleep: async (ms: number) => { if (ms === 20_000) then(); } } });

test("a lane whose screen shows no running turn and no prompt 20 s after its prompt is STARTUP_UNCONFIRMED with its last lines", async () => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const deps = after20s(at(T0), () => {
    world.screen = "Do you trust the files in /home/test/work?\n  1. Trust (this session only)\n  2. Exit";
  });
  const r = await launchLane(deps, { noThread: "test lane", key: "smoke", title: "smoke", brief, done: "file /tmp/ok", cwd: "/tmp/w" });
  expect(r.startup).toBe(`STARTUP_UNCONFIRMED smoke aoe_smoke_${NEW_AOE_ID.slice(0, 8)}: no running turn and no ❯ prompt on screen; last lines: Do you trust the files in (local path) / 1. Trust (this session only) / 2. Exit`);
});

test("a lane whose session ended within 20 s of its prompt is a STARTUP_ERROR, though no failure word shows", async () => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const base = at(T0);
  let ended = false;
  const deps = { ...after20s(base, () => { ended = true; world.screen = ""; }), run: async (argv: readonly string[], o?: Parameters<typeof base.run>[1]) => (ended && argv[1] === "has-session" ? { code: 1, out: "", err: "can't find session" } : base.run(argv, o)) };
  const r = await launchLane(deps, { noThread: "test lane", key: "smoke", title: "smoke", brief, done: "file /tmp/ok", cwd: "/tmp/w" });
  expect(r.startup).toBe(`STARTUP_ERROR smoke aoe_smoke_${NEW_AOE_ID.slice(0, 8)}: the tmux session is gone`);
});

// dori-superagent issue #50 reproduced here (MIT): https://github.com/sisyphuslabs/dori-superagent/issues/50
// A lane that runs but never set its goal stops after its first turn, so a running agent is not yet a good start.
const goalLaunch = async (reads: readonly GoalRead[], during?: (read: number) => void, config: Partial<DoriConfig> = {}, cwd = "/tmp/w") => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  let read = 0;
  const deps: FlowDeps = { ...at(T0), config: { ...at(T0).config, ...config }, readGoal: async () => { during?.(read); return reads[Math.min(read++, reads.length - 1)] as GoalRead; } };
  const r = await launchLane(deps, { noThread: "test lane", key: "smoke", title: "smoke", brief, done: "file /tmp/ok", cwd });
  return { startup: r.startup, read };
};

test("a lane whose first turn ended without a goal is STARTUP_NO_GOAL with its last lines after three idle reads", async () => {
  world.screen = "working on it\n❯ ";
  const r = await goalLaunch(["none"]);
  expect(r.startup).toBe(`STARTUP_NO_GOAL smoke aoe_smoke_${NEW_AOE_ID.slice(0, 8)}: the agent runs but no goal in its session: its first turn ended 40 s after its prompt; last lines: working on it / ❯`);
  expect(r.read).toBe(3);
});

test("a goal that shows up after the first check is still STARTUP_OK", async () => {
  const r = await goalLaunch(["none", "unknown", { status: "active" }]);
  expect(r.startup).toBe(`STARTUP_OK smoke aoe_smoke_${NEW_AOE_ID.slice(0, 8)}`);
  expect(r.read).toBe(3);
});

test("a session that ends while launch waits for its goal is a STARTUP_ERROR, not a missing goal", async () => {
  const base = at(T0);
  let ended = false;
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const deps: FlowDeps = { ...base, readGoal: async () => { ended = true; return "none"; }, run: async (argv, o) => (ended && argv[1] === "has-session" ? { code: 1, out: "", err: "can't find session" } : base.run(argv, o)) };
  const r = await launchLane(deps, { noThread: "test lane", key: "smoke", title: "smoke", brief, done: "file /tmp/ok", cwd: "/tmp/w" });
  expect(r.startup).toBe(`STARTUP_ERROR smoke aoe_smoke_${NEW_AOE_ID.slice(0, 8)}: the tmux session is gone`);
});

// a real ulw lane reads its brief and runs a discovery wave before it sets its goal: on 213 real lanes (2026-11-02) the
// goal came after 80 s for 81% of them, before their first turn ended for 201; so launch only reads the first turn
// briefly and leaves one still on to dori watch
const BUSY = "reading the brief\n⠋ Working… (esc to interrupt)\n❯ ";
const IDLE = "working on it\n❯ ";
const pendingPane = `aoe_smoke_${NEW_AOE_ID.slice(0, 8)}`;

test("a first turn still running with no goal is STARTUP_PENDING_GOAL at once, and the lane is marked for dori watch", async () => {
  world.screen = BUSY;
  const r = await goalLaunch(["none"]);
  expect(r.startup).toBe(`STARTUP_PENDING_GOAL smoke ${pendingPane}: its first turn is still on and has set no goal yet; dori watch says LANE_NO_GOAL if it ends without one`);
  expect(r.read).toBe(1);
  expect((await at(T0).registry.read("smoke"))?.pendingGoal?.idle).toBe(0);
});

test("an idle read, then a running turn (a gap between tool calls), is STARTUP_PENDING_GOAL, not a missing goal", async () => {
  const r = await goalLaunch(["none"], (read) => void (world.screen = read === 0 ? IDLE : BUSY));
  expect(r.startup).toStartWith(`STARTUP_PENDING_GOAL smoke ${pendingPane}`);
  expect(r.read).toBe(2);
});

// dori watch finishes the judgement of a lane launch left pending
const pendingLane = async () => {
  world.screen = BUSY;
  expect((await goalLaunch(["none"])).startup).toStartWith("STARTUP_PENDING_GOAL smoke");
};
const goalLines = (lines: readonly string[]) => lines.filter((l) => /^LANE_(NO_GOAL|GOAL_SET)/.test(l));
const watchWith = async (goal: GoalRead, screen: string, patch: Partial<FlowDeps> = {}) => {
  world.screen = screen;
  return goalLines(await watchTick({ ...at(T0), readGoal: async () => goal, ...patch }));
};

test("dori watch clears a pending lane's mark once its session holds a goal", async () => {
  await pendingLane();
  expect(await watchWith("none", BUSY)).toEqual([]);
  expect(await watchWith({ status: "active" }, BUSY)).toEqual([`LANE_GOAL_SET smoke ${pendingPane}: its session holds a goal now; the pending-goal mark is cleared`]);
  expect((await at(T0).registry.read("smoke"))?.pendingGoal).toBeUndefined();
  expect(await watchWith("none", IDLE)).toEqual([]);
});

test("three idle watch reads in a row say LANE_NO_GOAL and tell the lead once; a running read in between starts the count again", async () => {
  await pendingLane();
  expect(await watchWith("none", IDLE)).toEqual([]);
  expect(await watchWith("none", IDLE)).toEqual([]);
  expect(await watchWith("none", BUSY)).toEqual([]);
  expect((await at(T0).registry.read("smoke"))?.pendingGoal?.idle).toBe(0);
  expect(await watchWith("none", IDLE)).toEqual([]);
  expect(await watchWith("none", IDLE)).toEqual([]);
  const told = await watchWith("none", IDLE);
  expect(told[0]).toBe(`LANE_NO_GOAL smoke ${pendingPane}: its first turn ended with no goal in its session; last lines: working on it / ❯`);
  expect(told[1]).toBe("LANE_NO_GOAL_TOLD smoke aoe_Dori_0a1b2c3d");
  expect(sent(world).filter((t) => t.includes("LANE_NO_GOAL"))).toEqual(["[DORI] LANE_NO_GOAL smoke: 첫 턴이 goal 없이 끝남 — pane 보고 goal 세우라고 해"]);
  expect((await at(T0).registry.read("smoke"))?.pendingGoal).toBeUndefined();
  expect(await watchWith("none", IDLE)).toEqual([]);
});

test("a pending lane whose session is gone is left to the lane death check, never told as a missing goal", async () => {
  await pendingLane();
  world.screen = IDLE;
  const base = at(T0);
  const gone: FlowDeps = { ...base, readGoal: async () => "none", run: async (argv, o) => (argv[1] === "has-session" ? { code: 1, out: "", err: "can't find session" } : base.run(argv, o)) };
  for (let i = 0; i < 4; i++) expect(goalLines(await watchTick(gone))).toEqual([]);
  expect((await at(T0).registry.read("smoke"))?.pendingGoal?.idle).toBe(0);
});

// lane c of the 2026-11-02 QA: the harness moved its sleep 150 to the background after 5 s, the turn ended, and its goal
// came when the job did. A job of its own (done-flow's laneBackground, read from the lane's real transcript here) keeps a
// first turn on; only once the job ended do idle reads count.
const detachedJob = (sessions: string, cwd: string) => {
  world.ps = `10 1 /bin/bash /dev/fd/4\n11 10 /home/u/.bun/bin/bun /x/senpi/dist/bundle/cli.js --extension /x/plugin --model m --session-id ${ID}`;
  sessionFiles(sessions, cwd)(ID, "QA. Read and execute the lane brief");
  const file = join(sessions, `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`, `2026-01-01T12-00-01-000Z_${ID}.jsonl`);
  const line = (entry: object) => appendFileSync(file, `${JSON.stringify({ timestamp: new Date(T0 + 30_000).toISOString(), ...entry })}\n`);
  line({ type: "message", message: { role: "toolResult", toolName: "eval", toolCallId: "toolu_1", content: [{ type: "text", text: "ok" }], details: { toolCalls: [{ name: "bash", resultPreview: "Command is still running; auto-detached to background with ID: bash_1 (not killed; the original 240s timeout still applies)." }] } } });
  return () => line({ type: "custom_message", customType: "senpi-monitor:notification", content: "Background terminal session bash_1 finished (exit 0)" });
};

test("a first turn waiting on a background job of its own is STARTUP_PENDING_GOAL though its screen is idle", async () => {
  const sessions = join(state.dir, "sessions");
  detachedJob(sessions, "/tmp/w");
  world.screen = IDLE;
  const r = await goalLaunch(["none"], undefined, { sessionsDir: sessions });
  expect(r.startup).toStartWith(`STARTUP_PENDING_GOAL smoke ${pendingPane}`);
  expect(r.read).toBe(1);
});

test("dori watch counts no idle read while the lane waits on a background job of its own; once the job ended with no goal, three idle reads say LANE_NO_GOAL", async () => {
  const sessions = join(state.dir, "sessions");
  const jobEnds = detachedJob(sessions, "/tmp/w");
  world.screen = BUSY;
  expect((await goalLaunch(["none"], undefined, { sessionsDir: sessions })).startup).toStartWith("STARTUP_PENDING_GOAL smoke");
  const own: Partial<FlowDeps> = { config: { ...at(T0).config, sessionsDir: sessions } };
  for (let i = 0; i < 4; i++) expect(await watchWith("none", IDLE, own)).toEqual([]);
  expect((await at(T0).registry.read("smoke"))?.pendingGoal?.idle).toBe(0);
  jobEnds();
  expect(await watchWith("none", IDLE, own)).toEqual([]);
  expect(await watchWith("none", IDLE, own)).toEqual([]);
  expect((await watchWith("none", IDLE, own))[0]).toStartWith(`LANE_NO_GOAL smoke ${pendingPane}: its first turn ended with no goal in its session`);
});

test("a first turn waiting on a background job whose transcript sits under a symlinked cwd's real path is STARTUP_PENDING_GOAL", async () => {
  const sessions = join(state.dir, "sessions");
  const real = join(state.dir, "real-job");
  const link = join(state.dir, "link-job");
  mkdirSync(real, { recursive: true });
  symlinkSync(real, link);
  detachedJob(sessions, realpathSync(real));
  world.screen = IDLE;
  expect((await goalLaunch(["none"], undefined, { sessionsDir: sessions }, link)).startup).toStartWith(`STARTUP_PENDING_GOAL smoke ${pendingPane}`);
});

test("a pending lane whose done claim was rejected (not-done) is still read: three idle reads say LANE_NO_GOAL", async () => {
  await pendingLane();
  await at(T0).registry.patch("smoke", { status: "not-done" });
  for (let i = 0; i < 2; i++) expect(await watchWith("none", IDLE)).toEqual([]);
  expect((await watchWith("none", IDLE))[0]).toStartWith(`LANE_NO_GOAL smoke ${pendingPane}`);
});

// herdr has no lane death check of its own, and a herdr lane's background jobs are read from its exact session's transcript
const herdrWatch = (sessions: string): FlowDeps => {
  const base = depsFor(world, fakeClock(T0), state.dir, { sessionsDir: sessions });
  return { ...base, readGoal: async () => "none", run: async (argv, o) => (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "process-info" ? { code: 0, out: JSON.stringify({ result: { process_info: { shell_pid: 500 } } }), err: "" } : base.run(argv, o)) };
};

test("a herdr pending lane waiting on a background job of its own is not told; once its agent is gone it is LANE_NO_GOAL_AGENT_GONE, told once", async () => {
  const sessions = join(state.dir, "sessions");
  detachedJob(sessions, "/tmp/w");
  world.ps = "500 1 bash\n501 500 omo --model m";
  const deps = herdrWatch(sessions);
  await deps.registry.write({ key: "hp", title: "hp", thread: "none", brief: "/b", done: "file /x", openedAt: "2026-01-01T00:00:00Z", pane: "w:p9", session: ID, cwd: "/tmp/w", pendingGoal: { idle: 0 } });
  for (let i = 0; i < 4; i++) expect(goalLines(await watchTick(deps))).toEqual([]);
  expect((await deps.registry.read("hp"))?.pendingGoal?.idle).toBe(0);
  world.ps = "500 1 bash";
  const gone = (await watchTick(deps)).filter((l) => /^LANE_NO_GOAL/.test(l));
  expect(gone[0]).toBe("LANE_NO_GOAL_AGENT_GONE hp w:p9: no agent runs in the pane any more before it set a goal");
  expect(gone[1]).toStartWith("LANE_NO_GOAL_");
  expect((await deps.registry.read("hp"))?.pendingGoal).toBeUndefined();
  expect((await watchTick(deps)).filter((l) => /^LANE_NO_GOAL/.test(l))).toEqual([]);
});

test("a job record from before the agent's own start (a restarted session) keeps no first turn on: three idle reads say LANE_NO_GOAL", async () => {
  const sessions = join(state.dir, "sessions");
  detachedJob(sessions, "/tmp/w");
  world.screen = BUSY;
  expect((await goalLaunch(["none"], undefined, { sessionsDir: sessions })).startup).toStartWith("STARTUP_PENDING_GOAL smoke");
  world.agentStart = new Date(T0 + 60_000).toUTCString();
  const own: Partial<FlowDeps> = { config: { ...at(T0).config, sessionsDir: sessions } };
  expect(await watchWith("none", IDLE, own)).toEqual([]);
  expect(await watchWith("none", IDLE, own)).toEqual([]);
  expect((await watchWith("none", IDLE, own))[0]).toStartWith(`LANE_NO_GOAL smoke ${pendingPane}`);
});

// a persistent monitor omo restored after a same-session restart: its start record predates the new agent, and the
// session's monitor manifest (extensions/terminal/<id>.json) says it runs while its recorded process lives
const restoredMonitor = (sessions: string, cwd: string, pid: number, createdAt = T0 - 60_000) => {
  const dir = join(sessions, `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`, "extensions", "terminal");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ID}.json`), JSON.stringify({ monitors: [{ description: "result file", command: "until [ -f /tmp/r ]; do sleep 5; done", createdAt, runtime: { pid } }] }));
};
const restartedLane = (sessions: string) => {
  world.ps = `10 1 /bin/bash /dev/fd/4\n11 10 /home/u/.bun/bin/bun /x/senpi/dist/bundle/cli.js --extension /x/plugin --model m --session-id ${ID}`;
  sessionFiles(sessions, "/tmp/w")(ID, "QA. Read and execute the lane brief");
  world.agentStart = new Date(T0).toUTCString();
};
const DEAD_PID = 2147480000;

test("a persistent monitor restored after a restart keeps a pending lane's first turn on while its process lives; once it is gone, three idle reads say LANE_NO_GOAL", async () => {
  const sessions = join(state.dir, "sessions");
  restartedLane(sessions);
  restoredMonitor(sessions, "/tmp/w", process.pid);
  world.screen = IDLE;
  expect((await goalLaunch(["none"], undefined, { sessionsDir: sessions })).startup).toStartWith(`STARTUP_PENDING_GOAL smoke ${pendingPane}`);
  const own: Partial<FlowDeps> = { config: { ...at(T0).config, sessionsDir: sessions } };
  for (let i = 0; i < 4; i++) expect(await watchWith("none", IDLE, own)).toEqual([]);
  restoredMonitor(sessions, "/tmp/w", DEAD_PID);
  expect(await watchWith("none", IDLE, own)).toEqual([]);
  expect(await watchWith("none", IDLE, own)).toEqual([]);
  expect((await watchWith("none", IDLE, own))[0]).toStartWith(`LANE_NO_GOAL smoke ${pendingPane}: its first turn ended`);
});

test("laneBackground, the blocked check's reading, counts a persistent monitor restored after a restart while its process lives", async () => {
  const sessions = join(state.dir, "sessions");
  restartedLane(sessions);
  restoredMonitor(sessions, "/tmp/w", process.pid);
  expect((await laneBackground(at(T0).run, sessions, PANE, "/tmp/w"))?.map((j) => j.id)).toEqual(["restored:result file"]);
  restoredMonitor(sessions, "/tmp/w", DEAD_PID);
  expect(await laneBackground(at(T0).run, sessions, PANE, "/tmp/w")).toEqual([]);
});

test("laneBackground does not count a live watcher the current agent armed as restored: with no restart its age window holds", async () => {
  const sessions = join(state.dir, "sessions");
  restartedLane(sessions);
  restoredMonitor(sessions, "/tmp/w", process.pid, T0 + 60_000);
  expect(await laneBackground(at(T0).run, sessions, PANE, "/tmp/w", Number.POSITIVE_INFINITY, T0 + 120_000)).toEqual([]);
});

test("a lane still pending 25 minutes after launch is LANE_NO_GOAL once, even while its first turn runs", async () => {
  await pendingLane();
  const later: Partial<FlowDeps> = { clock: fakeClock(T0 + 25 * 60_000) };
  expect(await watchWith("none", BUSY)).toEqual([]);
  const told = await watchWith("none", BUSY, later);
  expect(told[0]).toStartWith(`LANE_NO_GOAL smoke ${pendingPane}: still pending 25 minutes after launch`);
  expect(told[1]).toStartWith("LANE_NO_GOAL_TOLD smoke");
  expect(await watchWith("none", BUSY, later)).toEqual([]);
});

test("a herdr lane is held to its goal the same way: STARTUP_NO_GOAL without one, STARTUP_OK once it shows, STARTUP_ERROR when its agent ends", async () => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  world.ps = "500 1 bash\n501 500 omo --model m";
  const herdr = (reads: readonly GoalRead[]): FlowDeps => {
    let read = 0;
    const base = depsFor(world, fakeClock(T0), state.dir);
    return { ...base, readGoal: async () => reads[Math.min(read++, reads.length - 1)] as GoalRead, run: async (argv, o) => {
      if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }), err: "" };
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "process-info") return { code: 0, out: JSON.stringify({ result: { process_info: { shell_pid: 500 } } }), err: "" };
      return base.run(argv, o);
    } };
  };
  const input = (key: string) => ({ noThread: "test lane", key, title: key, brief, done: "file /tmp/ok", cwd: "/tmp/w" });
  expect((await launchLane(herdr(["none"]), input("hd"))).startup).toStartWith("STARTUP_NO_GOAL hd w:p9: the agent runs but no goal in its session: its first turn ended");
  expect((await launchLane(herdr(["unknown", { status: "active" }]), input("hd2"))).startup).toBe("STARTUP_OK hd2 w:p9");
  // herdr runs the agent with the lane's own prompt in its command line: a key or brief named mcp is not an MCP server
  world.ps = "500 1 bash\n501 500 omo --model m ulw. Read and execute the lane brief at /tmp/mcp.md in full. You are the mcp-fix lane; report as the brief's footer says.";
  expect((await launchLane(herdr([{ status: "active" }]), input("mcp-fix"))).startup).toBe("STARTUP_OK mcp-fix w:p9");
  world.ps = "500 1 bash";
  expect((await launchLane(herdr(["none"]), input("hd3"))).startup).toBe("STARTUP_ERROR hd3 w:p9: no agent runs in the pane any more");
  // a goal of an agent that already ended is no start either: the agent is read before its goal, every time
  expect((await launchLane(herdr([{ status: "active" }]), input("hd4"))).startup).toBe("STARTUP_ERROR hd4 w:p9: no agent runs in the pane any more");
});

// The lane's session is the exact id its agent runs under, read from the agent's command line: aoe pins it, herdr omo gets
// one from launch. No prompt marker, no transcript search: a sibling in the same cwd holding this lane's prompt never counts.
const ID = "99999999-9999-4999-8999-999999999999";
const sessionFiles = (sessions: string, cwd: string) => {
  const dir = join(sessions, `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);
  mkdirSync(join(dir, "extensions", "goal"), { recursive: true });
  return (id: string, prompt: string, goal?: string) => {
    writeFileSync(join(dir, `2026-01-01T12-00-01-000Z_${id}.jsonl`), `${JSON.stringify({ type: "message", message: { role: "user", content: prompt } })}\n`);
    if (goal) writeFileSync(join(dir, "extensions", "goal", `${id}.json`), JSON.stringify({ goal: { status: goal } }));
  };
};

test("exact session id: an aoe lane's goal is read from the session aoe put in its agent's command line, under a symlinked cwd's real path; launch adds no selector and the registry keeps the id", async () => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const sessions = join(state.dir, "sessions");
  const real = join(state.dir, "real");
  const link = join(state.dir, "link");
  mkdirSync(real, { recursive: true });
  symlinkSync(real, link);
  const session = sessionFiles(sessions, realpathSync(real));
  // the pane's shell (tmux pane_pid 10) runs aoe's wrapper, which runs the agent aoe pinned
  world.ps = `10 1 /bin/bash /dev/fd/4\n11 10 /home/u/.bun/bin/bun /x/senpi/dist/bundle/cli.js --extension /x/plugin -e /x/pi-aoe-session-id.js --model m --session-id ${ID}`;
  const launch = async (key: string, write: (own: string) => void) => {
    const base: FlowDeps = { ...at(T0), readGoal: undefined, config: { ...at(T0).config, sessionsDir: sessions } };
    const deps: FlowDeps = { ...base, clock: { ...base.clock, sleep: async (ms: number) => { if (ms === 20_000) write(sent(world).at(-1) ?? ""); } } };
    return launchLane(deps, { noThread: "test lane", key, title: key, brief, done: "file /tmp/ok", cwd: link });
  };
  const pane = (key: string) => `aoe_${key}_${NEW_AOE_ID.slice(0, 8)}`;
  // a sibling (or another Dori's same-key launch) in the same cwd holds this lane's very prompt and a goal; the lane's own session has none
  const r = await launch("smoke", (own) => {
    session("22222222-2222-4222-8222-222222222222", own, "active");
    session(ID, own);
  });
  expect(r.startup).toStartWith(`STARTUP_NO_GOAL smoke ${pane("smoke")}: the agent runs but no goal in its session`);
  expect(r.lane.session).toBe(ID);
  expect((await at(T0).registry.read("smoke"))?.session).toBe(ID);
  expect(world.calls.filter((c) => c[0] === "aoe" && c[1] === "add").every((c) => !c.join(" ").includes("--session"))).toBe(true);
  // the lane's own session writes its goal: STARTUP_OK
  expect((await launch("smoke2", (own) => session(ID, own, "active"))).startup).toBe(`STARTUP_OK smoke2 ${pane("smoke2")}`);
});

test("exact session id: an aoe agent whose command line names no session is STARTUP_UNCONFIRMED, never a goal borrowed from a session holding its prompt", async () => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const sessions = join(state.dir, "sessions");
  const session = sessionFiles(sessions, "/tmp/w");
  world.ps = "10 1 /bin/bash /dev/fd/4\n11 10 /home/u/.bun/bin/bun /x/senpi/dist/bundle/cli.js --extension /x/plugin --model m";
  const base: FlowDeps = { ...at(T0), readGoal: undefined, config: { ...at(T0).config, sessionsDir: sessions } };
  const deps: FlowDeps = { ...base, clock: { ...base.clock, sleep: async (ms: number) => { if (ms === 20_000) session("33333333-3333-4333-8333-333333333333", sent(world).at(-1) ?? "", "active"); } } };
  const r = await launchLane(deps, { noThread: "test lane", key: "smoke", title: "smoke", brief, done: "file /tmp/ok", cwd: "/tmp/w" });
  expect(r.startup).toStartWith(`STARTUP_UNCONFIRMED smoke aoe_smoke_${NEW_AOE_ID.slice(0, 8)}: the agent runs but its command line names no session id`);
  expect(r.lane.session).toBeUndefined();
});

test("exact session id: a herdr omo lane gets launch's own --session-id after the program and its goal is read from that session; an agentCommand with its own selector is run as it is", async () => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const sessions = join(state.dir, "sessions");
  const session = sessionFiles(sessions, "/tmp/w");
  world.ps = "500 1 bash\n501 500 omo --model m";
  const herdr = (agentCommand: readonly string[], write: (cmd: string) => void): FlowDeps => {
    const base = depsFor(world, fakeClock(T0), state.dir, { sessionsDir: sessions, agentCommand: [...agentCommand] });
    let cmd = "";
    return { ...base, clock: { ...base.clock, sleep: async (ms: number) => { if (ms === 20_000) write(cmd); } }, run: async (argv, o) => {
      if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") return { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }), err: "" };
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "process-info") return { code: 0, out: JSON.stringify({ result: { process_info: { shell_pid: 500 } } }), err: "" };
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "run") cmd = argv[4] ?? "";
      return base.run(argv, o);
    } };
  };
  const input = (key: string) => ({ noThread: "test lane", key, title: key, brief, done: "file /tmp/ok", cwd: "/tmp/w" });
  let id = "";
  const r = await launchLane(herdr(["omo", "--model", "{model}", "{prompt}"], (cmd) => {
    id = /^omo --session-id ([0-9a-f-]{36}) --model /.exec(cmd)?.[1] ?? "";
    session("44444444-4444-4444-8444-444444444444", "You are the hd lane; report", "active");
    session(id, "You are the hd lane; report", "active");
  }), input("hd"));
  expect(id).not.toBe("");
  expect(r.startup).toBe("STARTUP_OK hd w:p9");
  expect(r.lane.session).toBe(id);
  // a session the lane did not run under never lends its goal: the same launch whose own session has none
  const r2 = await launchLane(herdr(["omo", "--model", "{model}", "{prompt}"], (cmd) => {
    session("55555555-5555-4555-8555-555555555555", cmd, "active");
    session(/--session-id (\S+)/.exec(cmd)?.[1] ?? "", cmd);
  }), input("hd2"));
  expect(r2.startup).toStartWith("STARTUP_NO_GOAL hd2 w:p9: the agent runs but no goal in its session");
  // --continue picks the session itself: no second selector, and no id to read
  let continued = "";
  const r3 = await launchLane(herdr(["omo", "--continue", "--model", "{model}", "{prompt}"], (cmd) => { continued = cmd; }), input("hd3"));
  expect(continued).toStartWith("omo --continue --model ");
  expect(r3.startup).toStartWith("STARTUP_UNCONFIRMED hd3 w:p9: the agent runs but its command line names no session id");
  // --session with a partial uuid is resolved by omo itself: the prefix is not the session's id, so no goal file is guessed
  let partial = "";
  const r4 = await launchLane(herdr(["omo", "--session", "99999999", "--model", "{model}", "{prompt}"], (cmd) => { partial = cmd; session(ID, cmd, "active"); }), input("hd4"));
  expect(partial).toStartWith("omo --session 99999999 --model ");
  expect(r4.startup).toStartWith("STARTUP_UNCONFIRMED hd4 w:p9: the agent runs but its command line names no session id");
  // --session with a whole uuid names that session exactly
  const r5 = await launchLane(herdr(["omo", "--session", ID, "--model", "{model}", "{prompt}"], (cmd) => session(ID, cmd, "active")), input("hd5"));
  expect(r5.startup).toBe("STARTUP_OK hd5 w:p9");
  expect(r5.lane.session).toBe(ID);
  // a command that keeps its sessions in its own --session-dir: the goal is not under sessionsDir, so it is not read there
  let own = "";
  const r6 = await launchLane(herdr(["omo", "--session-dir", "/elsewhere", "--model", "{model}", "{prompt}"], (cmd) => { own = /--session-id (\S+)/.exec(cmd)?.[1] ?? ""; session(own, cmd, "active"); }), input("hd6"));
  expect(own).not.toBe("");
  expect(r6.startup).toStartWith("STARTUP_UNCONFIRMED hd6 w:p9: the agent runs but its command line names no session id");
});

test("exact session id: argvSessionId reads only an exact id: --session-id, a session file, or a whole uuid; never a partial uuid", () => {
  expect(argvSessionId(["omo", "--session-id", ID])).toBe(ID);
  expect(argvSessionId(["omo", "--session", `/s/--x--/2026-01-01T12-00-00-000Z_${ID}.jsonl`])).toBe(ID);
  expect(argvSessionId(["omo", "--session", ID])).toBe(ID);
  expect(argvSessionId(["omo", "--session", "99999999"])).toBe("");
  expect(argvSessionId(["omo", "--fork", ID])).toBe("");
  expect(argvSessionId(["omo", "--model", "m"])).toBe("");
});

test("exact session id: withSessionId adds one --session-id only to an omo command that names no session itself", () => {
  expect(withSessionId(["omo", "--model", "{model}", "{prompt}"], ID)).toEqual(["omo", "--session-id", ID, "--model", "{model}", "{prompt}"]);
  expect(withSessionId(["/home/u/.bun/bin/omo", "{prompt}"], ID)).toEqual(["/home/u/.bun/bin/omo", "--session-id", ID, "{prompt}"]);
  for (const own of [["omo", "--session", "/s/x.jsonl"], ["omo", "--session-id=abc"], ["omo", "--continue"], ["omo", "-c"], ["omo", "--resume"], ["omo", "-r"], ["omo", "--fork", "/s/x.jsonl"], ["omo", "--rebind", "/old/repo/x.jsonl"], ["omo", "--rebind=abc"], ["omo", "--no-session"], ["claude", "{prompt}"]]) expect(withSessionId(own, ID)).toEqual(own);
});

test("exact session id: aoe add gets the pi of the agent's own install when its PATH has none, so aoe pins the session", () => {
  const root = join(state.dir, "pi-install");
  const install = join(root, "global", "node_modules");
  mkdirSync(join(install, "omo-ai", "bin"), { recursive: true });
  mkdirSync(join(install, ".bin"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(install, "omo-ai", "bin", "omo.js"), "#!/bin/sh\n");
  chmodSync(join(install, "omo-ai", "bin", "omo.js"), 0o755);
  writeFileSync(join(install, ".bin", "pi"), "#!/bin/sh\n");
  chmodSync(join(install, ".bin", "pi"), 0o755);
  symlinkSync(join(install, "omo-ai", "bin", "omo.js"), join(root, "bin", "omo"));
  const bare = `${join(root, "bin")}:/usr/bin:/bin`;
  expect(withPi(bare, "omo")).toBe(`${bare}:${join(install, ".bin")}`);
  // a PATH with a pi already, or with no such agent, stays as it is
  expect(withPi(`${bare}:${join(install, ".bin")}`, "omo")).toBe(`${bare}:${join(install, ".bin")}`);
  expect(withPi("/usr/bin:/bin", "omo")).toBe("/usr/bin:/bin");
});

test("exact session id: a pane resumed through a selector omo resolves itself is never matched to a sibling started nearby", async () => {
  // a sibling lane's new session, written a second after this agent started, in the same directory
  const sibling = "2026-01-01T12-00-01-000Z_22222222-2222-4222-8222-222222222222.jsonl";
  const deps = { run: at(T0).run, sessionsDir: "/s", backend: "aoe" as const, listDir: () => [sibling] };
  world.agentStart = "Thu Jan  1 12:00:00 UTC 2026";
  const agent = (args: string) => [{ pid: 10, ppid: 1, cmd: "/bin/bash /dev/fd/4" }, { pid: 11, ppid: 10, cmd: `/home/u/.bun/bin/bun /x/senpi/dist/bundle/cli.js --extension /x/plugin ${args}` }];
  // with no selector the start time still finds the session the agent created
  expect((await resolveSession(PANE, "/repo", agent("--model m"), deps)).id).toBe("22222222-2222-4222-8222-222222222222");
  for (const args of ["--session 01a11bb6", "--continue", "--resume", "--fork 01a11bb6", "--rebind /old/x.jsonl"]) expect(await resolveSession(PANE, "/repo", agent(`--model m ${args}`), deps)).toEqual({ id: "", via: "none", pid: 11 });
});

test("an aoe pane resumed with --session <session file> gets the uuid from the file name, not the path", async () => {
  const file = "/home/u/.omo/agent/sessions/--home-u-Documents-kakaodori--/2026-10-08T13-31-43-234Z_01a11bb6-6f02-7f43-932d-4f19bae69e1c.jsonl";
  const table = [{ pid: 10, ppid: 1, cmd: "/bin/bash /tmp/aoe-pane-env-fLuABz" }, { pid: 11, ppid: 10, cmd: `/home/u/.bun/bin/bun /x/senpi/dist/bundle/cli.js --extension /x/plugin --session ${file}` }];
  const hit = await resolveSession(PANE, "/repo", table, { run: at(T0).run, sessionsDir: "/s", backend: "aoe" });
  expect(hit).toEqual({ id: "01a11bb6-6f02-7f43-932d-4f19bae69e1c", via: "argv", pid: 11 });
});

test("a working lane whose aoe session waits for a human is reported once as LANE_BLOCKED, never while its turn still runs", async () => {
  const lane: Lane = { key: "fix-a", title: "fix-a", thread: "none", pane: PANE, brief: "/b.md", done: "file /etc/hostname", cwd: "/repo", openedAt: new Date(T0).toISOString() };
  await at(T0).registry.write(lane);
  const state = (s: string) => { world.aoePs = [{ session: LANE_ID, state: s }, { session: "0a1b2c3d4e5f6a7b", state: "waiting" }]; };
  const busy = "Working (12s • esc to interrupt)\n❯ ";
  state("running");
  world.screen = busy;
  expect(await watchTick(at(T0))).toEqual([]);
  state("waiting");
  expect(await watchTick(at(T0))).toEqual([]);
  world.screen = "Allow this command? (y/n)\n❯ ";
  expect(await watchTick(at(T0))).toEqual([`LANE_BLOCKED fix-a waiting ${PANE}`]);
  expect(await watchTick(at(T0))).toEqual([]);
  state("error");
  expect(await watchTick(at(T0))).toEqual([`LANE_BLOCKED fix-a error ${PANE}`]);
  // aoe shows an open omo question as idle; the question UI on screen says otherwise
  state("idle");
  world.screen = " Ask user · 2m\n dori-qa: pick A or B?\n → 1. A\n Submit (0/1 answered) — Enter advances";
  expect(await watchTick(at(T0))).toEqual([`LANE_BLOCKED fix-a question ${PANE}`]);
  world.screen = busy;
  expect(await watchTick(at(T0))).toEqual([]);
  // a turn that ended counts once it stays idle for the settle time, not before, and not while a goal wake is due
  world.screen = "All done here.\n❯ ";
  expect(await watchTick(at(T0 + MIN))).toEqual([]);
  expect(await watchTick(at(T0 + MIN + 30_000))).toEqual([]);
  expect(await watchTick(at(T0 + 2 * MIN))).toEqual([`LANE_BLOCKED fix-a idle ${PANE}`]);
  expect(await watchTick(at(T0 + 3 * MIN))).toEqual([]);
  world.screen = "Pursuing goal · goal continues in 4m\n❯ ";
  expect(await watchTick(at(T0 + 4 * MIN))).toEqual([]);
  world.screen = "All done here.\n❯ ";
  expect(await watchTick(at(T0 + 4 * MIN + 30_000))).toEqual([]);
  expect((await at(T0).registry.read("fix-a"))?.idleSince).toBe(T0 + 4 * MIN + 30_000);
});

test("an idle lane that waits on its own monitor, wake source or goal is never LANE_BLOCKED idle; a question or aoe waiting still is", async () => {
  const lane: Lane = { key: "fix-a", title: "fix-a", thread: "none", pane: PANE, brief: "/b.md", done: "file /etc/hostname", cwd: "/repo", openedAt: new Date(T0).toISOString() };
  await at(T0).registry.write(lane);
  world.aoePs = [{ session: LANE_ID, state: "idle" }];
  const status = (s: string) => `❯ \n Claude │ pool\n(OmO) mem:repo just now ${s}`;
  let t = T0;
  for (const mark of ["◉ watching local_ci approval-path-audit #2 (2m)", "2 wake source(s) on duty", "goal continues in 4m", "Pursuing goal (18m)"]) {
    world.screen = status(mark);
    for (let i = 0; i < 4; i++, t += 30_000) expect(await watchTick(at(t))).toEqual([]);
  }
  world.screen = ` Ask user · 2m\n Submit (0/1 answered)\n${status("Pursuing goal (18m)")}`;
  expect(await watchTick(at(t))).toEqual([`LANE_BLOCKED fix-a question ${PANE}`]);
  world.aoePs = [{ session: LANE_ID, state: "waiting" }];
  world.screen = watching("ci (1m)");
  expect(await watchTick(at(t + 30_000))).toEqual([`LANE_BLOCKED fix-a waiting ${PANE}`]);
});

const SESSION_ID = "40ccbe13-33d4-4c1e-9d0e-0123456789ab";
const bgWorld = (agentStart: number) => {
  const sessionsDir = join(state.dir, "sessions");
  const file = join(sessionsDir, "--repo--", `2026-01-01T10-00-00-000Z_${SESSION_ID}.jsonl`);
  mkdirSync(join(sessionsDir, "--repo--"), { recursive: true });
  writeFileSync(file, "");
  world.aoePs = [{ session: LANE_ID, state: "idle" }];
  world.ps = `10 1 /bin/bash /tmp/aoe-pane-env\n11 10 /x/senpi/dist/bundle/cli.js --session-id ${SESSION_ID}\n`;
  world.agentStart = new Date(agentStart).toString();
  const add = (ms: number, entry: object) => appendFileSync(file, `${JSON.stringify({ timestamp: new Date(ms).toISOString(), ...entry })}\n`);
  return {
    deps: (ms: number) => ({ ...at(ms), config: { ...at(ms).config, sessionsDir } }),
    result: (ms: number, tool: string, text: string, details: object = {}, toolCallId = "toolu_x") => add(ms, { type: "message", message: { role: "toolResult", toolCallId, toolName: tool, content: [{ type: "text", text }], details } }),
    said: (ms: number, text: string) => add(ms, { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }),
    notified: (ms: number, text: string) => add(ms, { type: "custom_message", customType: "senpi-codemode:notification", content: text }),
    entry: add,
  };
};
const idleLane = async () => at(T0).registry.write({ key: "fix-a", title: "fix-a", thread: "none", pane: PANE, brief: "/b.md", done: "file /etc/hostname", cwd: "/repo", openedAt: new Date(T0).toISOString() });

test("an idle lane waiting on a detached eval cell, background bash or task it started is BG_WAITING, not LANE_BLOCKED, until blockedWaitMin", async () => {
  await idleLane();
  const w = bgWorld(T0 - 60 * MIN);
  w.result(T0 - 20_000, "eval", "Eval cell toolu_01RfMaz detached and is running in the js kernel (0 other live cells). Completion arrives as a notification; do not re-run it.", {}, "toolu_01RfMaz");
  w.result(T0 - 15_000, "eval", "started", { toolCalls: [{ name: "bash", resultPreview: "Command running in background with ID: bash_3" }, { name: "monitor", resultPreview: "Monitor started with ID: mon_X" }] });
  w.result(T0 - 12_000, "task", "Started task explore the code (st_01a14301, running). Completion is automatically delivered.", { task_id: "st_01a14301", status: "running", run_in_background: true });
  // what a lane printed (a grep of logs or of omo's source) starts nothing
  w.result(T0 - 11_000, "eval", "Eval cell toolu_Z detached and is running\nCommand running in background with ID: bash_9\nStarted task x (st_01a19999, running)", {}, "toolu_01Grep");
  w.said(T0 - 10_000, "Waiting on the browser cell.");
  world.screen = "Waiting on the browser cell.\n❯ ";
  expect(await watchTick(w.deps(T0))).toEqual([]);
  expect(await watchTick(w.deps(T0 + 30_000))).toEqual([]);
  expect(await watchTick(w.deps(T0 + MIN))).toEqual([`BG_WAITING fix-a eval:toolu_01RfMaz,bash:bash_3,monitor:mon_X,task:st_01a14301 ${PANE}`]);
  for (let t = T0 + MIN + 30_000; t < T0 + 60 * MIN; t += 10 * MIN) expect(await watchTick(w.deps(t))).toEqual([]);
  expect((await at(T0).registry.read("fix-a"))?.waitingOn).toBe("eval:toolu_01RfMaz,bash:bash_3,monitor:mon_X,task:st_01a14301");
  // waiting too long: blocked after all, once
  expect(await watchTick(w.deps(T0 + 60 * MIN))).toEqual([`LANE_BLOCKED fix-a idle ${PANE}`]);
  expect(await watchTick(w.deps(T0 + 61 * MIN))).toEqual([]);
});

test("once its background work ended, or when the work is from before the agent started, an idle lane is LANE_BLOCKED idle as before", async () => {
  await idleLane();
  const w = bgWorld(T0 - 60 * MIN);
  w.result(T0 - 20_000, "eval", "Eval cell toolu_A detached and is running in the py kernel (0 other live cells).", {}, "toolu_A");
  w.result(T0 - 19_000, "eval", "x", { toolCalls: [{ name: "bash", resultPreview: "Command is still running; auto-detached to background with ID: bash_7 (not killed; the or" }] });
  w.result(T0 - 18_000, "task", "Batch running.\n1. L1-horizon st_01a14025 (running)", { task_id: "st_01a14025", status: "running", run_in_background: true, items: [{ task_id: "st_01a14025", status: "running" }] });
  w.result(T0 - 18_000, "bash", "Command running in background with ID: bash_8", { bash_id: "bash_8", background: true });
  w.said(T0 - 17_000, "Eval cell toolu_Q detached and is running — I only quote it.");
  world.screen = "Waiting.\n❯ ";
  expect(await watchTick(w.deps(T0))).toEqual([]);
  expect(await watchTick(w.deps(T0 + MIN))).toEqual([`BG_WAITING fix-a eval:toolu_A,bash:bash_7,task:st_01a14025,bash:bash_8 ${PANE}`]);
  w.notified(T0 + 2 * MIN, "<system-reminder>Detached eval cell toolu_A (py) completed.\nok</system-reminder>");
  w.notified(T0 + 2 * MIN, "<system-reminder>Background terminal session bash_7 finished: completed (exit code 0).</system-reminder>");
  w.notified(T0 + 2 * MIN, "Terminal state after restart (offline up to 58s): restored 1 - 1 \"post13\" (respawned); background: bash_8 exited.");
  // the task's end is newer than the settle time: it may not have woken the lane yet
  w.notified(T0 + 3 * MIN, "task completion name:L1-horizon id:st_01a14025 agent:explore status:completed");
  expect(await watchTick(w.deps(T0 + 3 * MIN + 30_000))).toEqual([`BG_WAITING fix-a task:st_01a14025 ${PANE}`]);
  expect(await watchTick(w.deps(T0 + 4 * MIN))).toEqual([`LANE_BLOCKED fix-a idle ${PANE}`]);
  // a new agent process: jobs its predecessor started died with it
  world.screen = `${RUNNING}\n❯ `;
  expect(await watchTick(w.deps(T0 + 5 * MIN))).toEqual([]);
  w.result(T0 + 5 * MIN, "eval", "Eval cell toolu_B detached and is running in the js kernel (0 other live cells).");
  world.agentStart = new Date(T0 + 6 * MIN).toString();
  world.screen = "Waiting.\n❯ ";
  expect(await watchTick(w.deps(T0 + 7 * MIN))).toEqual([]);
  expect(await watchTick(w.deps(T0 + 8 * MIN))).toEqual([`LANE_BLOCKED fix-a idle ${PANE}`]);
  // a server it left running for longer than blockedWaitMin is not what it waits on
  world.screen = `${RUNNING}\n❯ `;
  expect(await watchTick(w.deps(T0 + 70 * MIN))).toEqual([]);
  w.result(T0 + 8 * MIN, "bash", "Command running in background with ID: bash_1", { bash_id: "bash_1", background: true });
  world.screen = "Waiting.\n❯ ";
  expect(await watchTick(w.deps(T0 + 70 * MIN + 1))).toEqual([]);
  expect(await watchTick(w.deps(T0 + 71 * MIN))).toEqual([`LANE_BLOCKED fix-a idle ${PANE}`]);
});

// replay dashboard-save-403 2026-10-21T13:04:08Z (one of 8 such false alarms in 30 days): the lane armed a persistent
// merge watcher from a cell and ended its turn; omo's status line did not show it, and the lane was LANE_BLOCKED idle
const monitorStart = { name: "monitor", ok: true, args: { description: "PR 166 merge-pr", command: "merge-pr.sh 166", persistent: true }, resultPreview: "Monitor started with ID: mon_P1DBNZEPY6J5A5H8" };
const monitorEvent = (kinds: string[]) => ({ type: "custom_message", customType: "senpi-monitor:notification", content: "<system-reminder>Monitor event(PR 166 merge-pr): MERGE_DONE rc=0</system-reminder>", details: { monitors: [{ id: "bash_2", description: "PR 166 merge-pr", eventCount: 1, kinds }] } });

test("replay dashboard-save-403: an idle lane waiting on a monitor it armed is BG_WAITING until the watched command ends, a line event does not end it", async () => {
  await idleLane();
  const w = bgWorld(T0 - 60 * MIN);
  w.result(T0 - 20_000, "eval", "Monitor started with ID: mon_P1DBNZEPY6J5A5H8", { toolCalls: [monitorStart] });
  world.screen = "PR #166 merge running in a watcher.\n❯ ";
  expect(await watchTick(w.deps(T0))).toEqual([]);
  expect(await watchTick(w.deps(T0 + MIN))).toEqual([`BG_WAITING fix-a monitor:mon_P1DBNZEPY6J5A5H8 ${PANE}`]);
  w.entry(T0 + 2 * MIN, monitorEvent(["line"]));
  expect(await watchTick(w.deps(T0 + 4 * MIN))).toEqual([]);
  w.entry(T0 + 5 * MIN, monitorEvent(["line", "summary"]));
  expect(await watchTick(w.deps(T0 + 7 * MIN))).toEqual([`LANE_BLOCKED fix-a idle ${PANE}`]);
});

// replay pingpong-analytics 2026-11-02T00:20:03Z: bash_19 started about 40 minutes before the lane went idle and ran 85
// minutes; once it was an hour old it no longer counted and the lane was LANE_BLOCKED idle while it still ran
test("replay pingpong-analytics: a job the lane started shortly before it went idle still counts after it is an hour old; it ends, then the lane is blocked", async () => {
  await idleLane();
  const w = bgWorld(T0 - 120 * MIN);
  w.result(T0 - 40 * MIN, "bash", "Command running in background with ID: bash_19", { bash_id: "bash_19", background: true });
  world.screen = "Waiting on the analysis run.\n❯ ";
  expect(await watchTick(w.deps(T0))).toEqual([]);
  expect(await watchTick(w.deps(T0 + MIN))).toEqual([`BG_WAITING fix-a bash:bash_19 ${PANE}`]);
  expect(await watchTick(w.deps(T0 + 20 * MIN))).toEqual([]);
  expect(await watchTick(w.deps(T0 + 36 * MIN))).toEqual([]);
  w.notified(T0 + 45 * MIN, "<system-reminder>Background terminal session bash_19 finished: completed (exit code 0).</system-reminder>");
  expect(await watchTick(w.deps(T0 + 47 * MIN))).toEqual([`LANE_BLOCKED fix-a idle ${PANE}`]);
});

test("a stopped agent in an aoe session is reported once two reads a tick apart agree, and the lead's session is skipped", async () => {
  world.screen = "omo has stopped\n$ ";
  const deps = at(T0);
  const panes = newDeadPaneState();
  expect(await deadPaneTick(deps.run, deps.config, new Set(), "2026-01-01T12", [], panes)).toEqual([]);
  expect(await deadPaneTick(deps.run, deps.config, new Set(), "2026-01-01T12", [], panes)).toEqual([`DEAD_PANE ${PANE}`]);
});

// ported from dori-superagent 40034ad (#7): positive evidence first, never one screen read alone
test("an aoe agent showing its prompt or a running turn is alive, whatever dead words its output holds", async () => {
  const deps = at(T0);
  const panes = newDeadPaneState();
  for (const screen of ["the training job has stopped\n❯ ", `omo has stopped earlier, retrying\n${" • Working (esc to interrupt)"}`]) {
    world.screen = screen;
    for (let i = 0; i < 4; i++) expect(await deadPaneTick(deps.run, deps.config, new Set(), "2026-01-01T12", [], panes)).toEqual([]);
  }
});

test("a dead marker on a screen that changes between ticks is never DEAD_PANE", async () => {
  const deps = at(T0);
  const panes = newDeadPaneState();
  for (let i = 0; i < 4; i++) {
    world.screen = `omo has stopped\nredraw ${i}\n$ `;
    expect(await deadPaneTick(deps.run, deps.config, new Set(), "2026-01-01T12", [], panes)).toEqual([]);
  }
});

test("an aoe pane with no prompt, no running turn and no dead marker is named once after three ticks, and again only after it was alive", async () => {
  const deps = at(T0);
  const panes = newDeadPaneState();
  const tick = () => deadPaneTick(deps.run, deps.config, new Set(), "2026-01-01T12", [], panes);
  world.screen = "Do you trust this folder?\n  1. Trust (this session only)";
  for (let i = 1; i < UNRECOGNISED_ALERT_AFTER; i++) expect(await tick()).toEqual([]);
  expect(await tick()).toEqual([`UNRECOGNISED_PANE ${PANE} dead-panes: no agent prompt, running turn or dead marker for 3 ticks`]);
  expect(await tick()).toEqual([]);
  world.screen = "❯ ";
  expect(await tick()).toEqual([]);
  world.screen = "Do you trust this folder?";
  for (let i = 1; i < UNRECOGNISED_ALERT_AFTER; i++) expect(await tick()).toEqual([]);
  expect((await tick())[0]).toStartWith(`UNRECOGNISED_PANE ${PANE}`);
});

const typed = () => ({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } });
const watching = (s: string) => `❯ \n Claude │ pool\n(OmO) mem:repo just now ◉ watching ${s}`;
const limitHit = (n = 150, by = "goal-continuation", reason = "per-user-input") => ({ type: "custom", customType: "engine-turn-limit", data: { customType: by, reason, sinceUserInput: n, toolFreeInWindow: 0 } });
const iso = (ms: number) => new Date(ms).toISOString();

test("a lane omo paused after 150 turns of its own is LANE_AUTOTURN_PAUSED once and gets one [LEAD] message, at most autoturnResumeMax a day", async () => {
  await idleLane();
  const w = bgWorld(T0 - 120 * MIN);
  w.entry(T0 - 100 * MIN, typed());
  w.entry(T0 - 10 * MIN, limitHit());
  w.entry(T0 - 5 * MIN, limitHit(150, "senpi-monitor:notification"));
  world.screen = watching("digest (8h)");
  const line = (since: number, tail: string) => `LANE_AUTOTURN_PAUSED fix-a ${PANE} 150 turns on its own (per-user-input) since ${iso(since)}; ${tail}`;
  expect(await watchTick(w.deps(T0))).toEqual([line(T0 - 10 * MIN, "resumed 1/3 in 24h")]);
  expect(sent(world)).toHaveLength(1);
  expect(sent(world)[0]).toStartWith("[LEAD] autoturn: omo paused this session after it started 150 turns on its own");
  expect(sent(world)[0]).toContain("one monitor gate");
  // the same pause is not reported again, also after a watcher restart (the mark is in the registry)
  expect(await watchTick(w.deps(T0 + 30_000))).toEqual([]);
  expect((await at(T0).registry.read("fix-a"))?.autoturn?.since).toBe(iso(T0 - 10 * MIN));
  // the message lifted it; each later pause gets its own line, and the fourth in 24 hours only a report
  for (const [k, tail] of [[2, "resumed 2/3 in 24h"], [3, "resumed 3/3 in 24h"], [4, "not resumed: 3 resumes in 24h already (autoturnResumeMax 3), the lead decides"]] as const) {
    w.entry(T0 + k * MIN, typed());
    expect(await watchTick(w.deps(T0 + k * MIN + 10_000))).toEqual([]);
    w.entry(T0 + k * MIN + 20_000, limitHit());
    expect(await watchTick(w.deps(T0 + k * MIN + 30_000))).toEqual([line(T0 + k * MIN + 20_000, tail)]);
  }
  expect(sent(world)).toHaveLength(3);
  // a day later the cap has room again
  w.entry(T0 + 25 * 60 * MIN, typed());
  w.entry(T0 + 25 * 60 * MIN + 1000, limitHit());
  expect(await watchTick(w.deps(T0 + 25 * 60 * MIN + 30_000))).toEqual([line(T0 + 25 * 60 * MIN + 1000, "resumed 1/3 in 24h")]);
});

test("no auto-turn pause stays quiet: none at all, one lifted by a typed message or a new engine turn, or the words only quoted in a tool result", async () => {
  await idleLane();
  const w = bgWorld(T0 - 120 * MIN);
  world.screen = watching("ci (1m)");
  w.entry(T0 - 50 * MIN, typed());
  expect(await watchTick(w.deps(T0))).toEqual([]);
  w.entry(T0 - 40 * MIN, limitHit());
  w.entry(T0 - 39 * MIN, typed());
  w.entry(T0 - 30 * MIN, limitHit(12, "senpi-monitor:notification", "tool-free-rate"));
  w.entry(T0 - 29 * MIN, { type: "custom", customType: "engine-turn-start", data: { customType: "goal-continuation" } });
  w.result(T0 - 20 * MIN, "bash", '{"type":"custom","customType":"engine-turn-limit","data":{"reason":"per-user-input"}}');
  expect(await watchTick(w.deps(T0 + MIN))).toEqual([]);
  expect(sent(world)).toEqual([]);
  expect((await at(T0).registry.read("fix-a"))?.autoturn).toBeUndefined();
});

test("a lane paused by the lead is still caught and told to keep waiting; the lead's own pause is typed into the lead pane", async () => {
  await idleLane();
  const deps = at(T0);
  await deps.registry.write({ ...(await deps.registry.read("fix-a"))!, status: "paused", pausedFrom: "working" });
  const w = bgWorld(T0 - 120 * MIN);
  w.entry(T0 - 10 * MIN, limitHit(150, "senpi-monitor:notification"));
  const leadFile = join(state.dir, "sessions", "--home-test-dori--", `2026-01-01T10-00-00-000Z_${SESSION_ID}.jsonl`);
  mkdirSync(join(state.dir, "sessions", "--home-test-dori--"), { recursive: true });
  writeFileSync(leadFile, `${JSON.stringify({ timestamp: iso(T0 - 3 * MIN), ...limitHit(150, "senpi-monitor:notification") })}\n`);
  world.screen = watching("5: Dori inbox +4 more");
  expect(await watchTick(w.deps(T0))).toEqual([
    `LANE_AUTOTURN_PAUSED fix-a ${PANE} 150 turns on its own (per-user-input) since ${iso(T0 - 10 * MIN)}; resumed 1/3 in 24h`,
    `LANE_AUTOTURN_PAUSED lead aoe_Dori_0a1b2c3d 150 turns on its own (per-user-input) since ${iso(T0 - 3 * MIN)}; resumed 1/3 in 24h`,
  ]);
  expect(sent(world)[0]).toContain("the lead paused this lane, so keep waiting and start no new work");
  expect(sent(world)[1]).toStartWith("[DORI] LANE_AUTOTURN_PAUSED lead: omo paused this session");
  expect(await watchTick(w.deps(T0 + 30_000))).toEqual([]);
});

test("a session that keeps running on its own is LANE_AUTOTURN_LONG once per autoturnLongTurns turns since its last user message, only reported", async () => {
  await idleLane();
  const w = bgWorld(T0 - 300 * MIN);
  world.screen = watching("chain (5h)");
  const start = (ms: number) => w.entry(ms, { type: "custom", customType: "engine-turn-start", data: { customType: "goal-continuation" } });
  const starts = (from: number, n: number) => {
    for (let i = 0; i < n; i++) start(from + i);
  };
  w.entry(T0 - 290 * MIN, typed());
  starts(T0 - 280 * MIN, 299);
  expect(await watchTick(w.deps(T0))).toEqual([]);
  start(T0 - 1000);
  expect(await watchTick(w.deps(T0 + 30_000))).toEqual([`LANE_AUTOTURN_LONG fix-a 300 ${iso(T0 - 290 * MIN)}`]);
  expect(sent(world)).toEqual([]);
  // once per 300: not again at 301..599, also after a watcher restart (the mark is in the registry)
  starts(T0 + MIN, 299);
  expect(await watchTick(w.deps(T0 + 2 * MIN))).toEqual([]);
  expect((await at(T0).registry.read("fix-a"))?.autoturn?.long).toEqual({ user: iso(T0 - 290 * MIN), at: 300 });
  start(T0 + 3 * MIN);
  expect(await watchTick(w.deps(T0 + 4 * MIN))).toEqual([`LANE_AUTOTURN_LONG fix-a 600 ${iso(T0 - 290 * MIN)}`]);
  // a typed (or lead) message starts the count again
  w.entry(T0 + 5 * MIN, typed());
  starts(T0 + 6 * MIN, 300);
  expect(await watchTick(w.deps(T0 + 7 * MIN))).toEqual([`LANE_AUTOTURN_LONG fix-a 300 ${iso(T0 + 5 * MIN)}`]);
  expect(sent(world)).toEqual([]);
  // the lead's own session is counted too, and autoturnLongTurns 0 turns it off
  const leadFile = join(state.dir, "sessions", "--home-test-dori--", `2026-01-01T10-00-00-000Z_${SESSION_ID}.jsonl`);
  mkdirSync(join(state.dir, "sessions", "--home-test-dori--"), { recursive: true });
  writeFileSync(leadFile, Array.from({ length: 300 }, (_, i) => JSON.stringify({ timestamp: iso(T0 + i), type: "custom", customType: "engine-turn-start" })).join("\n"));
  const off = (ms: number) => ({ ...w.deps(ms), config: { ...w.deps(ms).config, autoturnLongTurns: 0 } });
  expect(await watchTick(off(T0 + 8 * MIN))).toEqual([]);
  expect(await watchTick(w.deps(T0 + 9 * MIN))).toEqual(["LANE_AUTOTURN_LONG lead 300 none"]);
  expect(await watchTick(w.deps(T0 + 10 * MIN))).toEqual([]);
});

test("the lead's own LANE_AUTOTURN_LONG and LANE_AUTOTURN_PAUSED also go out to the other Dori and the owner, once each; a lane's stay with the lead", async () => {
  await idleLane();
  const w = bgWorld(T0 - 300 * MIN);
  world.screen = watching("chain (5h)");
  const posts: string[] = [];
  const deps = (ms: number) => ({ ...w.deps(ms), postLeadAlert: async (text: string) => (posts.push(text), [`LEAD_ALERT_POSTED pair P m${posts.length}`]) });
  const start = { type: "custom", customType: "engine-turn-start", data: { customType: "goal-continuation" } };
  w.entry(T0 - 290 * MIN, typed());
  for (let i = 0; i < 300; i++) w.entry(T0 - 280 * MIN + i, start);
  expect(await watchTick(deps(T0))).toEqual([`LANE_AUTOTURN_LONG fix-a 300 ${iso(T0 - 290 * MIN)}`]);
  expect(posts).toEqual([]);
  const leadFile = join(state.dir, "sessions", "--home-test-dori--", `2026-01-01T10-00-00-000Z_${SESSION_ID}.jsonl`);
  mkdirSync(join(state.dir, "sessions", "--home-test-dori--"), { recursive: true });
  const lead = (ms: number, entry: object) => appendFileSync(leadFile, `${JSON.stringify({ timestamp: iso(ms), ...entry })}\n`);
  lead(T0 - 200 * MIN, typed());
  for (let i = 0; i < 300; i++) lead(T0 - 100 * MIN + i, start);
  expect(await watchTick(deps(T0 + MIN))).toEqual([`LANE_AUTOTURN_LONG lead 300 ${iso(T0 - 200 * MIN)}`, "LEAD_ALERT_POSTED pair P m1"]);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toStartWith("LEAD_RUNAWAY aoe_Dori_0a1b2c3d 300: ");
  expect(posts[0]).not.toContain("<@");
  // once per 300 turns: the next tick posts nothing
  expect(await watchTick(deps(T0 + 2 * MIN))).toEqual([]);
  // omo pausing the lead is one more post, once per pause
  lead(T0 + 2 * MIN + 1000, limitHit());
  expect(await watchTick(deps(T0 + 3 * MIN))).toEqual([
    `LANE_AUTOTURN_PAUSED lead aoe_Dori_0a1b2c3d 150 turns on its own (per-user-input) since ${iso(T0 + 2 * MIN + 1000)}; resumed 1/3 in 24h`,
    "LEAD_ALERT_POSTED pair P m2",
  ]);
  // two minutes after the runaway post that asked for a check it is the same event: a repeat that asks for nothing
  expect(posts[1]).toStartWith("LEAD_AUTOTURN_PAUSED aoe_Dori_0a1b2c3d 150 repeat: ");
  expect(await watchTick(deps(T0 + 4 * MIN))).toEqual([]);
  expect(posts).toHaveLength(2);
  // the lead's pane got only the resume message: nothing stops it
  expect(sent(world)).toHaveLength(1);
  expect(sent(world)[0]).toStartWith("[DORI] LANE_AUTOTURN_PAUSED lead:");
  // 30 minutes after that request a new pause asks for a check again
  lead(T0 + 5 * MIN, typed());
  lead(T0 + 31 * MIN, limitHit());
  expect(await watchTick(deps(T0 + 32 * MIN))).toEqual([
    `LANE_AUTOTURN_PAUSED lead aoe_Dori_0a1b2c3d 150 turns on its own (per-user-input) since ${iso(T0 + 31 * MIN)}; resumed 2/3 in 24h`,
    "LEAD_ALERT_POSTED pair P m3",
  ]);
  expect(posts[2]).toStartWith("LEAD_AUTOTURN_PAUSED aoe_Dori_0a1b2c3d 150: ");
});

const OWNER = "100000000000000001";
const limitWorld = () => {
  const w = bgWorld(T0 - 300 * MIN);
  const inbox = join(state.dir, "inbox.jsonl");
  writeFileSync(inbox, "");
  const leadFile = join(state.dir, "sessions", "--home-test-dori--", `2026-01-01T10-00-00-000Z_${SESSION_ID}.jsonl`);
  mkdirSync(join(state.dir, "sessions", "--home-test-dori--"), { recursive: true });
  writeFileSync(leadFile, "");
  const posts: string[][] = [];
  const deps = (ms: number, patch: Partial<DoriConfig> = {}) => ({
    ...w.deps(ms),
    config: { ...w.deps(ms).config, ...patch },
    ownerInbox: { path: inbox, ownerId: OWNER, ownerChannel: "C-OWNER" },
    postOwner: async (channel: string, text: string) => (posts.push([channel, text]), `m${posts.length}`),
  });
  const row = (ms: number, id: string, content: string, extra: object = {}) => appendFileSync(inbox, `${JSON.stringify({ ts: iso(ms), id, channel_id: "T-THREAD", scope: "thread", author_id: OWNER, content, ...extra })}\n`);
  const reply = (ms: number, errorMessage?: string) =>
    appendFileSync(leadFile, `${JSON.stringify({ timestamp: iso(ms), type: "message", message: { role: "assistant", content: [], ...(errorMessage ? { stopReason: "error", errorMessage } : { stopReason: "stop" }) } })}\n`);
  const laneReply = (ms: number, errorMessage?: string) => w.entry(ms, { type: "message", message: { role: "assistant", content: [], ...(errorMessage ? { stopReason: "error", errorMessage } : { stopReason: "stop" }) } });
  return { deps, posts, row, reply, laneReply };
};
const blockedError = (until: number) => `All Claude accounts for anthropic-subscription are currently blocked (rate limit or auth errors).\n  Soonest automatic retry: ${iso(until)}.\n  /claude-account list  - inspect account states`;

test("the lead's model out at its usage limit while the owner waits: the owner hears the retry time once, the lead is woken when it passes, and the owner hears it is back", async () => {
  const l = limitWorld();
  world.screen = watching("5: Dori inbox");
  l.reply(T0 - 60 * MIN);
  l.row(T0 - 30 * MIN, "m-1", "요즘 눈만찍고 대답을 안한다??");
  l.row(T0 - 29 * MIN, "m-pair", "pair talk", { scope: "pair-bot" });
  l.reply(T0 - 30 * MIN + 3000, blockedError(T0 + 90 * MIN));
  expect(await watchTick(l.deps(T0))).toEqual([
    `LEAD_LIMIT_NOTICE aoe_Dori_0a1b2c3d model failing since ${iso(T0 - 30 * MIN + 3000)}, retry ${iso(T0 + 90 * MIN)}, 1 owner message(s) waiting; POSTED T-THREAD m1`,
  ]);
  expect(l.posts).toEqual([["T-THREAD", "I can't answer right now: my model is at its usage limit until about 13:30. I'll read your messages then."]]);
  // the same block: no second notice, and no typing into a lead whose model is still out
  l.row(T0 + MIN, "m-2", "도리야?");
  l.reply(T0 + MIN + 3000, blockedError(T0 + 90 * MIN));
  expect(await watchTick(l.deps(T0 + 2 * MIN))).toEqual([]);
  expect(sent(world)).toEqual([]);
  // the retry time passed and nothing woke the lead: one line in its pane, once
  const woke = await watchTick(l.deps(T0 + 91 * MIN));
  expect(woke).toEqual([`LEAD_OWNER_WAITING aoe_Dori_0a1b2c3d 2 owner message(s), oldest ${iso(T0 - 30 * MIN)} (121 min), model failing; woke the lead (SUBMITTED)`]);
  expect(sent(world)).toHaveLength(1);
  expect(sent(world)[0]).toStartWith("[DORI] LEAD_OWNER_WAITING: 2 owner message(s) since 11:30 have had no reply from you for 121 min");
  expect(await watchTick(l.deps(T0 + 92 * MIN))).toEqual([]);
  // a reply works: the owner hears it where he heard of the limit, once
  l.reply(T0 + 93 * MIN);
  expect(await watchTick(l.deps(T0 + 94 * MIN))).toEqual([`LEAD_LIMIT_CLEARED aoe_Dori_0a1b2c3d since ${iso(T0 - 30 * MIN + 3000)}; POSTED T-THREAD m2`]);
  expect(l.posts[1]).toEqual(["T-THREAD", "My model works again; reading your messages now."]);
  expect(await watchTick(l.deps(T0 + 95 * MIN))).toEqual([]);
  expect(sent(world)).toHaveLength(1);
});

test("a Dori without a bot token reports the limit notice it cannot send once, not on every tick", async () => {
  const l = limitWorld();
  world.screen = watching("5: Dori inbox");
  const noToken = (ms: number) => ({ ...l.deps(ms), postOwner: undefined });
  l.reply(T0 - 60 * MIN);
  l.row(T0 - MIN, "m-1", "도리야?");
  l.reply(T0 - MIN + 2000, blockedError(T0 + 60 * MIN));
  expect(await watchTick(noToken(T0))).toEqual([`LEAD_LIMIT_NOTICE aoe_Dori_0a1b2c3d model failing since ${iso(T0 - MIN + 2000)}, retry ${iso(T0 + 60 * MIN)}, 1 owner message(s) waiting; NOT_POSTED no bot token`]);
  expect(await watchTick(noToken(T0 + 30_000))).toEqual([]);
});

test("an owner message the lead has not answered for leadWakeMin is typed into its pane once; a short rate limit, a pair row or an answered message is not", async () => {
  const l = limitWorld();
  world.screen = watching("5: Dori inbox");
  l.reply(T0 - 60 * MIN);
  l.row(T0 - 59 * MIN, "m-0", "answered");
  l.reply(T0 - 58 * MIN);
  l.row(T0 - 9 * MIN, "m-pair", "pair talk", { scope: "pair-bot" });
  l.row(T0 - 9 * MIN, "m-1", "30프로 여유 규칙 더 줄여 10%해");
  // an error with a retry a minute away is a short rate limit: no notice (its retry passed, so the lead is told to go on)
  l.reply(T0 - 9 * MIN + 2000, blockedError(T0 - 8 * MIN));
  expect(await watchTick(l.deps(T0))).toEqual([`LIMIT_RESUME_WOKE lead aoe_Dori_0a1b2c3d limit error since ${iso(T0 - 9 * MIN + 2000)}, retry ${iso(T0 - 8 * MIN)} passed; SUBMITTED`]);
  expect(await watchTick(l.deps(T0 + MIN, { leadWakeMin: 0 }))).toEqual([]);
  expect(await watchTick(l.deps(T0 + MIN))).toEqual([`LEAD_OWNER_WAITING aoe_Dori_0a1b2c3d 1 owner message(s), oldest ${iso(T0 - 9 * MIN)} (10 min), model failing; woke the lead (SUBMITTED)`]);
  expect(sent(world)[1]).toContain('The oldest: "30프로 여유 규칙 더 줄여 10%해"');
  expect(l.posts).toEqual([]);
  expect(await watchTick(l.deps(T0 + 2 * MIN))).toEqual([]);
  // a card answer is the owner too; once the lead replied, nothing waits
  l.row(T0 + 3 * MIN, "q-1", "", { kind: "answer", answer: "폰만", author_id: undefined, channel_id: undefined, scope: undefined });
  expect(await watchTick(l.deps(T0 + 14 * MIN))).toEqual([`LEAD_OWNER_WAITING aoe_Dori_0a1b2c3d 2 owner message(s), oldest ${iso(T0 - 9 * MIN)} (23 min), model failing; woke the lead (SUBMITTED)`]);
  l.reply(T0 + 15 * MIN);
  expect(await watchTick(l.deps(T0 + 40 * MIN))).toEqual([]);
  expect(sent(world)).toHaveLength(3);
});

test("the limit lifted: the lead and a working lane stopped on a usage-limit error are woken once each on the first tick after the retry time; a paused lane, another error, a session that went on or a still-blocked pool are not", async () => {
  const l = limitWorld();
  await idleLane();
  world.screen = watching("5: Dori inbox");
  const woke = (key: string, pane: string, since: number, until: number) => `LIMIT_RESUME_WOKE ${key} ${pane} limit error since ${iso(since)}, retry ${iso(until)} passed; SUBMITTED`;
  const pool = (blockedUntil: number) => writeFileSync(join(state.dir, "credential-pool-state.json"), JSON.stringify({ providers: { "anthropic-subscription": { lanes: { stored: { slots: { a: { blockedUntil }, b: { blockedUntil: T0 + 600 * MIN } } } } } } }));
  l.reply(T0 - 60 * MIN);
  l.reply(T0 - 30 * MIN, blockedError(T0 + 10 * MIN));
  l.reply(T0 - 20 * MIN, blockedError(T0 + 10 * MIN));
  l.laneReply(T0 - 50 * MIN);
  l.laneReply(T0 - 29 * MIN, blockedError(T0 + 10 * MIN));
  // before the retry time, and while every account of the provider is still blocked in omo's pool: nothing
  expect(await watchTick(l.deps(T0 + 5 * MIN))).toEqual([]);
  pool(T0 + 20 * MIN);
  expect(await watchTick(l.deps(T0 + 11 * MIN))).toEqual([]);
  expect(sent(world)).toEqual([]);
  // an account is free again: one line each, once
  pool(T0 + 10 * MIN);
  expect(await watchTick(l.deps(T0 + 12 * MIN))).toEqual([woke("fix-a", PANE, T0 - 29 * MIN, T0 + 10 * MIN), woke("lead", "aoe_Dori_0a1b2c3d", T0 - 30 * MIN, T0 + 10 * MIN)]);
  expect(sent(world)).toEqual([RESUME_TEXT, RESUME_TEXT]);
  expect(await watchTick(l.deps(T0 + 13 * MIN))).toEqual([]);
  // the lead went on; the lane hits the limit again while the lead paused it: neither is typed into
  l.reply(T0 + 13 * MIN);
  await at(T0).registry.write({ ...(await at(T0).registry.read("fix-a"))!, status: "paused", pausedFrom: "working" });
  l.laneReply(T0 + 14 * MIN, blockedError(T0 + 15 * MIN));
  expect(await watchTick(l.deps(T0 + 16 * MIN))).toEqual([]);
  // working again, but its newest error is not a usage limit
  await at(T0).registry.write({ ...(await at(T0).registry.read("fix-a"))!, status: "working" });
  l.laneReply(T0 + 17 * MIN, "Connection error: socket hang up");
  expect(await watchTick(l.deps(T0 + 18 * MIN))).toEqual([]);
  expect(sent(world)).toHaveLength(2);
  // a new limit block with its own retry time is woken once more
  l.laneReply(T0 + 19 * MIN, blockedError(T0 + 19 * MIN + 30_000));
  expect(await watchTick(l.deps(T0 + 20 * MIN))).toEqual([woke("fix-a", PANE, T0 - 29 * MIN, T0 + 19 * MIN + 30_000)]);
  expect(await watchTick(l.deps(T0 + 21 * MIN))).toEqual([]);
  expect(sent(world)).toHaveLength(3);
});

test("leadAlertPoster posts to the pair channel only, and to the owner's channel only when there is no pair channel", async () => {
  const calls: string[][] = [];
  const post = leadAlertPoster(async (ch, text) => {
    calls.push([ch, text]);
    return "m1";
  }, { pair: "P", owner: "O" });
  expect(await post("x")).toEqual(["LEAD_ALERT_POSTED pair P m1"]);
  expect(calls).toEqual([["P", "x"]]);
  expect(await leadAlertPoster(async () => { throw new Error("429"); }, { pair: "", owner: "O" })("x")).toEqual(["LEAD_ALERT_WARN owner O Error: 429"]);
});

const card = (id: string, answeredAt: number, tmux: string | null = PANE): Question => ({ id, text: "도리방 말투?", options: ["a", "b"], channel: "c", thread: null, session: null, tmux, created: iso(answeredAt - MIN), status: "answered", answer: "a", answerKind: "button", answeredAt: iso(answeredAt) });

test("a card answer its session never got (the monitor event lost, e.g. in a compaction) is typed into that pane once; one it got is not", async () => {
  const w = bgWorld(T0 - 120 * MIN);
  w.said(T0 - 100 * MIN, "asked");
  // Q1 reached the session as its monitor event; Q2 did not; Q3 is too fresh; Q4 is older than the window
  w.notified(T0 - 9 * MIN, `<system-reminder>Monitor event(Dori inbox): {\"ts\":\"x\",\"kind\":\"answer\",\"qid\":\"Q1\",\"answer\":\"a\"}</system-reminder>`);
  const cards = [card("Q1", T0 - 10 * MIN), card("Q2", T0 - 10 * MIN), card("Q3", T0 - MIN), card("Q4", T0 - 3 * 60 * MIN)];
  const deps = (ms: number) => ({ ...w.deps(ms), answeredCards: () => cards });
  expect(await missedAnswersTick(deps(T0))).toEqual([`CARD_ANSWER_REDELIVERED Q2 ${PANE}: answered ${iso(T0 - 10 * MIN)}, not in that session's transcript; typed it there (SUBMITTED)`]);
  expect(sent(world)).toHaveLength(1);
  expect(sent(world)[0]).toStartWith("[DORI] ANSWER Q2 (button, ");
  expect(sent(world)[0]).toContain("question: 도리방 말투?");
  // the next tick sends nothing again (the mark), also when the typed line is not in the transcript yet
  expect(await missedAnswersTick(deps(T0 + 30_000))).toEqual([]);
  // Q3 past the grace and still missing: once
  expect(await missedAnswersTick(deps(T0 + 3 * MIN))).toEqual([`CARD_ANSWER_REDELIVERED Q3 ${PANE}: answered ${iso(T0 - MIN)}, not in that session's transcript; typed it there (SUBMITTED)`]);
  expect(sent(world)).toHaveLength(2);
  // the watch runs it: a new card missed by the session comes out of watchTick
  cards.push(card("Q5", T0 - 5 * MIN));
  expect(await watchTick(deps(T0 + 4 * MIN))).toContain(`CARD_ANSWER_REDELIVERED Q5 ${PANE}: answered ${iso(T0 - 5 * MIN)}, not in that session's transcript; typed it there (SUBMITTED)`);
});

test("a card answered before its session started (a rollover) is not re-sent, and a card with no tmux goes to the lead's pane", async () => {
  const w = bgWorld(T0 - 120 * MIN);
  w.said(T0 - 20 * MIN, "new session after a rollover");
  const old = [card("Q7", T0 - 30 * MIN)];
  expect(await missedAnswersTick({ ...w.deps(T0), answeredCards: () => old })).toEqual([]);
  expect(sawAnswer('{\\"qid\\":\\"Q7\\"}', "Q7")).toBe(true);
  expect(sawAnswer('"qid": "Q7"', "Q7")).toBe(true);
  expect(sawAnswer('"qid":"Q70"', "Q7")).toBe(false);
  expect(sawAnswer("[DORI] ANSWER Q7 (text, x): y", "Q7")).toBe(true);
  // the lead's session: its own transcript, under its cwd
  const deps = { ...w.deps(T0), answeredCards: () => [card("Q8", T0 - 10 * MIN, null)] };
  const leadDir = join(deps.config.sessionsDir, "--home-test-dori--");
  mkdirSync(leadDir, { recursive: true });
  writeFileSync(join(leadDir, `2026-01-01T09-00-00-000Z_${SESSION_ID}.jsonl`), `${JSON.stringify({ type: "session", timestamp: iso(T0 - 60 * MIN) })}\n`);
  expect(await missedAnswersTick(deps)).toEqual([`CARD_ANSWER_REDELIVERED Q8 aoe_Dori_0a1b2c3d: answered ${iso(T0 - 10 * MIN)}, not in that session's transcript; typed it there (SUBMITTED)`]);
  expect(world.calls.some((c) => c.join(" ").includes("=aoe_Dori_0a1b2c3d:"))).toBe(true);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeAoeSession, envMismatch, isClosedLine, liveSessions, paneActivity, paneLife, sessionFor } from "../src/aoe.ts";
import { agentLine, openHerdrSession } from "../src/herdr.ts";
import { readScreen } from "../src/panes.ts";
import { shellPidOf } from "../src/session-id.ts";
import { closeLane } from "../src/done-flow.ts";
import { launchLane } from "../src/launch.ts";
import { submitToPane } from "../src/panes.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, RUNNING, sent, type World } from "./fakes.ts";

// The herdr side of the session primitives (herdr.ts): a pane id with ":" goes to herdr, a tmux name to tmux, so one Dori
// can hold lanes of both while it moves.
let world: World;
let dir: string;
beforeEach(() => {
  world = newWorld();
  dir = mkdtempSync(join(tmpdir(), "herdr-backend-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const omo = (patch = {}) => depsFor(world, fakeClock(0), dir, { backend: "herdr", ...patch });

test("a herdr pane is live while an agent runs in it, dead once only its shell is left, gone when herdr has no such pane", async () => {
  const run = fakeRunner(world);
  world.herdrDead = ["w1:p2"];
  world.herdrGone = ["w1:p3"];
  expect([await paneLife(run, "w1:p1"), await paneLife(run, "w1:p2"), await paneLife(run, "w1:p3")]).toEqual([{ live: true }, { live: false, how: "dead", status: -1 }, { live: false, how: "gone" }]);
  expect(world.calls.some((c) => c[0] === "tmux")).toBe(false);
});

test("text for a herdr omo pane gets the aoe checks: a gone or dead pane is named and nothing typed; a live one waits for the prompt, is typed in pieces and submitted", async () => {
  const deps = omo();
  world.herdrGone = ["w1:p3"];
  world.herdrDead = ["w1:p2"];
  expect(await submitToPane(deps.run, deps.clock, deps.config, "w1:p3", "[LEAD] hi")).toMatchObject({ status: "NOT_SUBMITTED", reason: "PANE_GONE: there is no herdr pane w1:p3 (it ended, or the name is wrong); nothing was typed" });
  expect(await submitToPane(deps.run, deps.clock, deps.config, "w1:p2", "[LEAD] hi")).toMatchObject({ status: "NOT_SUBMITTED", reason: "PANE_DEAD: the program in w1:p2 exited (no agent runs in it); nothing was typed" });
  expect(sent(world)).toEqual([]);
  const long = "가".repeat(3000);
  expect((await submitToPane(deps.run, deps.clock, deps.config, "w1:p1", long)).status).toBe("SUBMITTED");
  expect(sent(world).length).toBeGreaterThan(1);
  expect(sent(world).join("")).toBe(long);
});

test("a frozen herdr omo agent (state T) gets no text", async () => {
  const deps = omo();
  // the pane's agent 4001 under its shell 4000, stopped (ps state T) by a handover
  const base = fakeRunner(world);
  const run: Runner = async (argv, o) => (argv[0] === "ps" && argv[1] === "-A" ? { code: 0, out: "4000 1 S -bash\n4001 4000 T omo --model m", err: "" } : base(argv, o));
  const r = await submitToPane(run, deps.clock, deps.config, "w1:p1", "[LEAD] hi");
  expect(r).toMatchObject({ status: "NOT_SUBMITTED" });
  expect((r as { reason: string }).reason).toStartWith("the agent in the pane is stopped (pid 4001, frozen)");
});

test("live sessions join aoe's and the herdr server's, and each pane name finds only its own backend's session", async () => {
  world.aoe = [{ id: "8d4297370000", title: "lead", path: "/home/a" }];
  world.tmux = ["aoe_lead_8d429737"];
  world.panes = [{ pane_id: "w1:p4", workspace_id: "w1", cwd: "/home/h" }];
  const sessions = await liveSessions(fakeRunner(world));
  expect(sessionFor(sessions, "aoe_lead_8d429737")?.path).toBe("/home/a");
  expect(sessionFor(sessions, "w1:p4")?.path).toBe("/home/h");
  expect(sessionFor(sessions, "w1:p9")).toBeUndefined();
});

test("closing a herdr session closes its tab when the pane is all it holds, and the line reads as closed", async () => {
  const line = await closeAoeSession(fakeRunner(world), "w1:p4");
  expect(line).toBe("herdr tab w1:t-p4 (w1:p4) stopped and closed");
  expect(isClosedLine(line)).toBe(true);
  expect(world.calls.at(-1)).toEqual(["herdr", "tab", "close", "w1:t-p4"]);
  world.herdrGone = ["w1:p5"];
  expect(isClosedLine(await closeAoeSession(fakeRunner(world), "w1:p5"))).toBe(false);
});

test("a herdr pane's activity comes from its screen; a pane with no agent is left out", async () => {
  world.herdrDead = ["w1:p2"];
  world.screens = { "w1:p1": `${RUNNING}\n❯ `, "w1:p3": "❯ \n ◉ watching 1: ci" };
  expect([...(await paneActivity(fakeRunner(world), ["w1:p1", "w1:p2", "w1:p3"]))]).toEqual([["w1:p1", "busy"], ["w1:p3", "running"]]);
});

test("the agent line sets and removes the session's variables with env(1) and quotes each word once", () => {
  expect(agentLine(["omo", "--model", "a/b:high", "it's"], { CUDA_VISIBLE_DEVICES: "", GPU: undefined })).toBe("env -u GPU CUDA_VISIBLE_DEVICES= omo --model a/b:high 'it'\\''s'");
  expect(agentLine(["omo"])).toBe("omo");
});

test("a herdr session's launchEnv is read from its agent's own environment", async () => {
  const run: Runner = async (argv) => (argv[2] === "process-info" ? { code: 0, out: JSON.stringify({ result: { process_info: { shell_pid: 1, foreground_processes: [{ pid: process.pid, cmdline: "omo" }] } } }), err: "" } : { code: 0, out: "", err: "" });
  expect(await envMismatch(run, "w1:p1", { PATH: process.env.PATH })).toEqual([]);
  expect(await envMismatch(run, "w1:p1", { HERDR_TEST_NOT_SET: "1" })).toEqual(["HERDR_TEST_NOT_SET=1(unset)"]);
});


test("a session opened on a fresh herdr server, which has no workspace yet, gets one first", async () => {
  const calls: string[][] = [];
  let made = false;
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    if (argv[1] === "tab" && argv[2] === "create") return made ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w1:p2", tab_id: "w1:t2" } } }), err: "" } : { code: 1, out: JSON.stringify({ error: { code: "workspace_not_found", message: "no active workspace" } }), err: "" };
    if (argv[1] === "workspace" && argv[2] === "create") return (made = true), { code: 0, out: JSON.stringify({ result: { workspace: { workspace_id: "w1" } } }), err: "" };
    if (argv[2] === "read") return { code: 0, out: "$ ", err: "" };
    return { code: 0, out: "", err: "" };
  };
  expect(await openHerdrSession(run, fakeClock(0), { title: "lane", cwd: "/tmp", argv: ["omo"] })).toEqual({ pane: "w1:p2", tab: "w1:t2" });
  expect(calls.filter((c) => c[2] === "create").map((c) => c.slice(1, 5))).toEqual([["tab", "create", "--cwd", "/tmp"], ["workspace", "create", "--label", "dori"], ["tab", "create", "--workspace", "w1"]]);
});



test("while a Dori moves (config herdr), its aoe lanes keep going through tmux: screen, shell pid and close", async () => {
  const deps = omo();
  world.aoe = [{ id: "abcdef0011223344", title: "old", path: "/repo" }];
  world.tmux = ["aoe_old_abcdef00"];
  await readScreen(deps.run, "herdr", "aoe_old_abcdef00");
  await shellPidOf("aoe_old_abcdef00", { run: deps.run, sessionsDir: dir, backend: "herdr" });
  expect(world.calls.filter((c) => c[0] === "herdr").map((c) => c.slice(1, 3).join(" "))).toEqual([]);
  expect(world.calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["tmux capture-pane", "tmux display-message"]);
  await Bun.write(join(dir, "done"), "ok");
  await deps.registry.write({ key: "old", title: "old", thread: "none", brief: "/b", done: `file ${join(dir, "done")}`, openedAt: "2026-01-01T00:00:00Z", pane: "aoe_old_abcdef00", status: "working" });
  await closeLane({ ...deps, exists: () => true }, (await deps.registry.read("old"))!, "QA");
  expect(world.calls.filter((c) => c[0] === "aoe" && (c[1] === "rm" || c[1] === "session")).map((c) => c.slice(0, 3).join(" "))).toEqual(["aoe session stop", "aoe rm abcdef0011223344"]);
  expect(world.calls.some((c) => c[0] === "herdr" && c[2] === "close")).toBe(false);
});



test("launch on a fresh herdr server (no workspace yet) opens the lane in a workspace it made", async () => {
  const brief = join(dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const deps = omo({ agentCommand: ["claude", "{prompt}"] });
  const base = deps.run;
  let made = false;
  const r = await launchLane({ ...deps, readGoal: async () => ({ status: "active" }), run: async (argv, o) => {
    if (argv[1] === "tab" && argv[2] === "create") return made ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w1:p2", tab_id: "w1:t2" } } }), err: "" } : { code: 1, out: JSON.stringify({ error: { code: "workspace_not_found" } }), err: "" };
    if (argv[1] === "workspace" && argv[2] === "create") return (made = true), { code: 0, out: JSON.stringify({ result: { workspace: { workspace_id: "w1" } } }), err: "" };
    return base(argv, o);
  } }, { noThread: "QA", key: "fresh", title: "fresh", brief, done: "file /x", cwd: "/tmp" });
  expect(r.lane).toMatchObject({ pane: "w1:p2", tab: "w1:t2" });
});


test("under a herdr config a tmux session of any name (no aoe_ prefix) still goes to tmux: screen and shell pid", async () => {
  const deps = omo();
  await readScreen(deps.run, "herdr", "lead");
  await shellPidOf("lead", { run: deps.run, sessionsDir: dir, backend: "herdr" });
  expect(world.calls.some((c) => c[0] === "herdr")).toBe(false);
  expect(world.calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["tmux capture-pane", "tmux display-message"]);
});

test("a herdr launch of an agent that is no omo needs no node: it starts with the server's PATH", async () => {
  const brief = join(dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const deps = omo({ agentCommand: ["claude", "{prompt}"] });
  const path = process.env.PATH;
  const nvm = process.env.NVM_DIR;
  process.env.PATH = "/nonexistent";
  process.env.NVM_DIR = join(dir, "no-nvm");
  try {
    const base = deps.run;
    const run: Runner = async (argv, o) => (argv[1] === "tab" && argv[2] === "create" ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w1:p3", tab_id: "w1:t3" } } }), err: "" } : base(argv, o));
    const r = await launchLane({ ...deps, run, readGoal: async () => ({ status: "active" }) }, { noThread: "QA", key: "nonode", title: "nonode", brief, done: "file /x", cwd: "/tmp" });
    expect(r.startup).not.toContain("NO_NODE");
    expect(world.calls.find((c) => c[2] === "run")?.[4] ?? "").not.toContain("PATH=");
  } finally {
    process.env.PATH = path;
    if (nvm === undefined) delete process.env.NVM_DIR;
    else process.env.NVM_DIR = nvm;
  }
});

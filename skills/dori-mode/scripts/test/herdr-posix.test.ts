import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envMismatch } from "../src/aoe.ts";
import { agentLine } from "../src/herdr.ts";
import { submitToPane } from "../src/panes.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, type World } from "./fakes.ts";

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


test("a frozen herdr omo agent (state T) gets no text", async () => {
  const deps = omo();
  // the pane's agent 4001 under its shell 4000, stopped (ps state T) by a handover
  const base = fakeRunner(world);
  const run: Runner = async (argv, o) => (argv[0] === "ps" && argv[1] === "-A" ? { code: 0, out: "4000 1 S -bash\n4001 4000 T omo --model m", err: "" } : base(argv, o));
  const r = await submitToPane(run, deps.clock, deps.config, "w1:p1", "[LEAD] hi");
  expect(r).toMatchObject({ status: "NOT_SUBMITTED" });
  expect((r as { reason: string }).reason).toStartWith("the agent in the pane is stopped (pid 4001, frozen)");
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

test("herdr-guard refuses server stop inside a pane even behind a global option and its value, and runs the real herdr it was moved to", async () => {
  const home = join(dir, "home");
  mkdirSync(join(home, ".local/lib/herdr"), { recursive: true });
  const real = join(home, ".local/lib/herdr/herdr");
  writeFileSync(real, "#!/bin/sh\necho REAL \"$@\"\n", { mode: 0o755 });
  const guard = join(import.meta.dir, "../../setups/discord-aoe/herdr-guard");
  const call = async (args: string[], env: Record<string, string>) => {
    const p = Bun.spawn(["bash", guard, ...args], { env: { PATH: "/usr/bin:/bin", HOME: home, ...env }, stdout: "pipe", stderr: "pipe" });
    return { code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() };
  };
  for (const args of [["server", "stop"], ["--session", "default", "server", "stop"], ["server", "--session", "default", "stop"], ["server", "--session=default", "stop"]]) {
    const r = await call(args, { HERDR_PANE_ID: "w1:p1" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("HERDR_GUARD_REFUSED");
  }
  expect((await call(["--session", "default", "server", "stop"], {})).out).toBe("REAL --session default server stop\n");
  expect((await call(["pane", "list"], { HERDR_PANE_ID: "w1:p1" })).out).toBe("REAL pane list\n");
  // text that only holds the words is no server stop
  expect((await call(["pane", "send-text", "w1:p1", "server", "stop"], { HERDR_PANE_ID: "w1:p1" })).out).toBe("REAL pane send-text w1:p1 server stop\n");
});



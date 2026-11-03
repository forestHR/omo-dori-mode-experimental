import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOmoExecutable } from "../src/executable.ts";
import { launchLane } from "../src/launch.ts";
import { laneHandover, type LaneHandoverDeps } from "../src/lane-handover.ts";
import { submitToPane } from "../src/panes.ts";
import { depsFor, fakeClock, newWorld, sent, type World } from "./fakes.ts";

const programs = ["omo.exe", "omo-windows-x64.exe", "C:\\Program Files\\OmO\\omo.exe",
  process.platform === "win32" ? "C:\\Tools\\OMO.EXE" : "/opt/bin/omo.exe"];
let dir: string;
let world: World;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dori-native-name-"));
  world = newWorld();
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("review 3 native executable matching follows Windows case rules", () => {
  expect(isOmoExecutable("C:\\Program Files\\OmO\\OMO.EXE", "win32")).toBe(true);
  expect(isOmoExecutable("/opt/bin/OMO.EXE", "linux")).toBe(false);
  expect(isOmoExecutable("C:\\tools\\tomo.exe", "win32")).toBe(false);
});

test.each(programs)("review 3 launch pins the session for %s", async (program) => {
  // Given a real registry and a native executable template.
  const brief = join(dir, "brief.md");
  writeFileSync(brief, "# Native executable launch\n");
  const deps = depsFor(world, fakeClock(0), dir, { backend: "herdr", agentCommand: [program, "--model", "{model}", "{prompt}"] });
  const runner = deps.run;
  // When the public launch flow opens the lane through the herdr wire adapter.
  const result = await launchLane({
    ...deps, readGoal: async () => ({ status: "active" }),
    run: async (argv, options) => argv[1] === "tab" && argv[2] === "create"
      ? { code: 0, out: '{"result":{"root_pane":{"pane_id":"w1:p2","tab_id":"w1:t2"}}}', err: "" }
      : runner(argv, options),
  }, { key: "native", title: "Native", brief, done: "file /done", noThread: "native regression", cwd: dir, model: "review/model" });
  // Then its persisted session is pinned rather than silently left unknown.
  expect(result.lane?.session).toMatch(/^[0-9a-f-]{36}$/);
  expect((await deps.registry.read("native"))?.sessionVia).toBe("launch");
});

test.each(programs)("review 3 type keeps omo safety checks for %s", async (program) => {
  // Given an omo question that must never be answered by an unrelated message.
  const deps = depsFor(world, fakeClock(0), dir, { backend: "herdr", agentCommand: [program, "{prompt}"] });
  world.screens["w1:p1"] = "Ask user · Which one?\n❯ ";
  // When sending through the real messaging decision path.
  const result = await submitToPane(deps.run, deps.clock, deps.config, "w1:p1", "unrelated");
  // Then the question guard refuses delivery before any text is sent.
  expect(result.status).toBe("NOT_SUBMITTED");
  expect(sent(world)).toEqual([]);
});

test.each(programs)("native configuration %s passes handover preflight and writes its note", async (program) => {
  // Given a live lane, its process table and a native executable configuration.
  const brief = join(dir, "brief.md");
  writeFileSync(brief, "# Native handover\n");
  const base = depsFor(world, fakeClock(0), dir, { backend: "herdr", agentCommand: [program, "{prompt}"], sessionsDir: join(dir, "sessions") });
  await base.registry.write({ key: "native", title: "Native", pane: "w1:p1", thread: "none", brief, cwd: dir, model: "review/model", done: "file /done", status: "working", openedAt: new Date(0).toISOString() });
  const deps: LaneHandoverDeps = {
    ...base, cardDir: join(dir, "cards"), home: dir, sessionOf: async () => "",
    procs: async () => [{ pid: 4000, ppid: 1, cmd: "pwsh.exe" }, { pid: 4001, ppid: 4000, cmd: `"${program}"` }],
    envOf: () => "", alive: () => false, signal: () => true, realpath: (path) => path, nonce: () => "native", print: () => {},
  };
  // When the public handover preflight runs.
  const result = await laneHandover(deps, "native", "w0:p0", { dryRun: true });
  // Then both platforms accept the executable and produce a note for the proposed handover.
  expect(result.code).toBe(0);
  expect(await Bun.file(result.note ?? "").exists()).toBe(true);
});

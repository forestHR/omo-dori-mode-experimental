import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrLeadSession, readHerdrSessions, recordHerdrSession, reviveHerdr } from "../src/herdr-sessions.ts";
import { run, type Runner } from "../src/run.ts";
import { powershellLiteral as quote } from "../src/powershell.ts";
import { depsFor, fakeClock, fakeRunner, newWorld } from "./fakes.ts";
import { argvSessionId, winArgv } from "../src/session-id.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const temporary = () => {
  const root = mkdtempSync(join(tmpdir(), "dori-review-1-"));
  roots.push(root);
  return root;
};
const session = "11111111-2222-4333-8444-555555555555";

test.skipIf(process.platform !== "win32").each(["pwsh"])("review 1 revive executes its complete command in %s", async (shell) => {
  // Given a stopped lead and a real PowerShell process whose omo function records its invocation.
  const dir = temporary();
  const capture = join(dir, "agent.json");
  const world = newWorld();
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.herdrDead = ["w1:p1"];
  recordHerdrSession(dir, "w1:p1", { session, cwd: dir, model: "review/model", at: new Date(0).toISOString() });
  const deps = depsFor(world, fakeClock(0), dir, { backend: "herdr" });
  const base = fakeRunner(world);
  const runner: Runner = async (argv, options) => {
    if (argv[0] === "herdr" && argv[2] === "run") {
      const child = Bun.spawn([shell, "-NoProfile", "-NonInteractive", "-Command", `
        function omo {
          [IO.File]::WriteAllText(${quote(capture)}, (@{ argv = @($args); path = $env:PATH } | ConvertTo-Json -Compress))
        }
        ${argv[4]}
      `], { stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0) return { code, out, err };
    }
    return base(argv, options);
  };
  // When revival executes the actual generated pane command.
  const result = await reviveHerdr(runner, deps.clock, deps.config, "w1:p1", "", async () => true);
  // Then the agent really ran with the selected session, model and environment.
  expect(result).toBe(`REVIVE_OK w1:p1 session ${session}`);
  expect(await Bun.file(capture).json()).toEqual({ argv: ["--session-id", session, "--model", "review/model"], path: process.env.PATH });
}, 30_000);

test.skipIf(process.platform !== "win32")("review 1 records a native lead started without a session argument", async () => {
  // Given an omo executable with a session created in omo's canonical Windows directory.
  const dir = temporary();
  const cwd = join(dir, "project with spaces");
  mkdirSync(cwd);
  const sessions = join(dir, "sessions");
  const executable = join(dir, "omo.exe");
  copyFileSync(process.execPath, executable);
  const ready = Promise.withResolvers<void>();
  const child = Bun.spawn([executable, "--eval", `
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const encoded = "--" + process.cwd().replace(/^[/\\\\]/, "").replace(/[/\\\\:]/g, "-") + "--";
    const dir = join(process.env.TEST_SESSIONS, encoded);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, new Date().toISOString().replace(/[:.]/g, "-") + "_${session}.jsonl"), "{}\\n");
    process.on("message", () => {});
    process.send("READY");
  `], {
    cwd, env: { ...Bun.env, TEST_SESSIONS: sessions }, stdout: "pipe", stderr: "pipe",
    ipc(message) { if (message === "READY") ready.resolve(); },
    onExit(_child, code, _signal, error) { ready.reject(error ?? new TypeError(`Agent exited before readiness: ${code}`)); },
  });
  const deadline = setTimeout(() => ready.reject(new TypeError("Agent readiness timed out")), 20_000);
  try {
    await ready.promise;
    const runner: Runner = async (argv, options) => {
      if (argv[0] !== "herdr") {
        if (argv[0] === "ps") throw new TypeError("Windows session discovery invoked Unix ps");
        return run(argv, options);
      }
      const result = argv[2] === "process-info"
        ? { process_info: { shell_pid: child.pid } }
        : argv[1] === "pane" ? { panes: [{ pane_id: "w1:p1", cwd }] } : { tabs: [] };
      return { code: 0, out: JSON.stringify({ result }), err: "" };
    };
    // When the live lead is discovered from the actual Windows process table.
    const id = await herdrLeadSession(runner, { stateDir: dir, sessionsDir: sessions }, "w1:p1", true);
    // Then its argument-free session is recorded for subsequent revival.
    expect(id).toBe(session);
    expect(readHerdrSessions(dir)["w1:p1"]).toMatchObject({ session, cwd });
  } finally {
    clearTimeout(deadline);
    child.kill();
    await child.exited;
  }
}, 40_000);

test("review 5 splits a Windows command line with CommandLineToArgvW quoting", () => {
  // Given command lines as Win32_Process reports them.
  const resumed = `"C:\\Program Files\\omo\\omo.exe" --session "C:\\work dir\\2026-11-03T08-00-00-000Z_${session}.jsonl" --model m`;
  // Then quoted words stay whole and backslash runs follow the Windows rules.
  expect(winArgv(resumed)).toEqual(["C:\\Program Files\\omo\\omo.exe", "--session", `C:\\work dir\\2026-11-03T08-00-00-000Z_${session}.jsonl`, "--model", "m"]);
  expect(argvSessionId(winArgv(resumed))).toBe(session);
  expect(winArgv('a\\\\"b c" d')).toEqual(["a\\b c", "d"]);
  expect(winArgv('a\\\\\\"b c')).toEqual(['a\\"b', "c"]);
  expect(winArgv('"x""y" ""')).toEqual(['x"y', ""]);
  expect(winArgv("C:\\dir\\omo.exe   -c\t")).toEqual(["C:\\dir\\omo.exe", "-c"]);
});

test.skipIf(process.platform !== "win32")("review 5 records a lead resumed from a quoted session path with spaces", async () => {
  // Given a live lead whose Windows command line resumes a session file under a directory with a space.
  const dir = temporary();
  const sessions = join(dir, "sessions");
  const file = `C:\\work dir\\2026-11-03T08-00-00-000Z_${session}.jsonl`;
  const table = [
    { ProcessId: 4242, ParentProcessId: 1, CommandLine: "pwsh.exe", ExecutablePath: "C:\\pwsh\\pwsh.exe", StartedAt: "2026-11-03T07:59:00.000Z" },
    { ProcessId: 4243, ParentProcessId: 4242, CommandLine: `"C:\\Program Files\\omo\\omo.exe" --session "${file}"`, ExecutablePath: "C:\\Program Files\\omo\\omo.exe", StartedAt: "2026-11-03T08:00:00.000Z" },
  ];
  const runner: Runner = async (argv) => {
    if (argv[0] === "powershell") return { code: 0, out: JSON.stringify(table), err: "" };
    if (argv[0] !== "herdr") throw new TypeError(`unexpected command ${argv[0]}`);
    const result = argv[2] === "process-info"
      ? { process_info: { shell_pid: 4242 } }
      : argv[1] === "pane" ? { panes: [{ pane_id: "w1:p1", cwd: "C:\\work dir" }] } : { tabs: [] };
    return { code: 0, out: JSON.stringify({ result }), err: "" };
  };
  // When the lead's session is read from that process table.
  const id = await herdrLeadSession(runner, { stateDir: dir, sessionsDir: sessions }, "w1:p1", true);
  // Then the session named by the quoted path is recorded.
  expect(id).toBe(session);
  expect(readHerdrSessions(dir)["w1:p1"]).toMatchObject({ session });
});

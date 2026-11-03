import { expect, test } from "bun:test";
import { agentLine } from "../src/herdr.ts";
import { agentPath } from "../src/aoe.ts";
import { AGENT, descendants, procTable, WIN_PROCS, winProcs } from "../src/session-id.ts";
import { run, type Runner } from "../src/run.ts";

test("Windows process discovery rejects a recycled parent newer than its child", () => {
  const table = winProcs(JSON.stringify([
    { ProcessId: 10, ParentProcessId: 0, StartedAt: "2026-11-03T10:00:00Z" },
    { ProcessId: 11, ParentProcessId: 10, StartedAt: "2026-11-03T09:00:00Z", CommandLine: "omo.exe" },
    { ProcessId: 12, ParentProcessId: 10, StartedAt: "2026-11-03T10:01:00Z" },
  ]));
  expect(table.map((p) => [p.pid, p.ppid])).toEqual([[10, 0], [11, 0], [12, 10]]);
  expect(descendants(table, 10).map((p) => p.pid)).toEqual([12]);
});

test("process traversal visits a cyclic tree once without including its root", () => {
  const table = [
    { pid: 10, ppid: 12, cmd: "pwsh.exe" },
    { pid: 11, ppid: 10, cmd: "omo.exe" },
    { pid: 12, ppid: 11, cmd: "child" },
    { pid: 13, ppid: 13, cmd: "self-parent" },
  ];
  expect(descendants(table, 10).map((p) => p.pid)).toEqual([11, 12]);
  expect(descendants(table, 13)).toEqual([]);
});

test("Windows process discovery recognizes omo executables and bundle paths", async () => {
  // Given a Win32_Process response including a process without a command line.
  const cim = JSON.stringify([
    { ProcessId: 1116, ParentProcessId: 900, CommandLine: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoExit' },
    { ProcessId: 3676, ParentProcessId: 1116, CommandLine: '"C:\\h\\omo-windows-x64.exe" --session-id 11111111-2222-4333-8444-555555555555' },
    { ProcessId: 4, ParentProcessId: 0, CommandLine: null },
  ]);
  const run: Runner = async (argv) => ({ code: 0, out: argv.join(" ") === WIN_PROCS.join(" ") ? cim : "", err: "" });
  // When Windows process discovery runs.
  const table = await procTable(run, "win32");
  // Then it preserves process relationships and identifies only the agent.
  expect(table.map((p) => [p.pid, p.ppid])).toEqual([[1116, 900], [3676, 1116], [4, 0]]);
  expect(table.filter((p) => AGENT.test(p.cmd)).map((p) => p.pid)).toEqual([3676]);
  expect(AGENT.test("C:\\Users\\u\\.bun\\bin\\bun.exe C:\\Users\\u\\.bun\\install\\global\\node_modules\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js --model m")).toBe(true);
  expect(AGENT.test("C:\\tools\\tomo.exe")).toBe(false);
  expect(AGENT.test("/home/u/.bun/bin/bun /x/senpi/dist/bundle/cli.js --model m")).toBe(true);
});

test("Windows agent lines quote PowerShell arguments and environment assignments", () => {
  // Given an executable, an argument containing a quote, and environment changes.
  const argv = ["C:\\h\\omo.exe", "--model", "it's"];
  // When the pane command is built.
  const line = agentLine(argv, { A: "1", GPU: undefined }, "win32");
  // Then PowerShell receives separate quoted words after the call operator.
  expect(line).toBe("$PSNativeCommandArgumentPassing = 'Standard'; $env:A = '1'; Remove-Item Env:GPU -ErrorAction SilentlyContinue; & 'C:\\h\\omo.exe' '--model' 'it''s'");
});

test.skipIf(process.platform !== "win32")("Windows process discovery finds the calling Bun process natively", async () => {
  // Given the real PowerShell process adapter.
  // When Win32_Process is queried.
  const table = await procTable(run);
  // Then this test process has its real command line and parent.
  const self = table.find((processInfo) => processInfo.pid === process.pid);
  expect(self?.ppid).toBe(process.ppid);
  expect(self?.cmd.toLowerCase()).toContain("bun");
}, 30_000);

test.skipIf(process.platform !== "win32")("Windows launch preserves the caller's native PATH", () => {
  // Given the caller's semicolon-separated executable search path.
  const path = process.env.PATH ?? "";
  // When preparing a native omo executable.
  const actual = agentPath("omo");
  // Then no Unix node or colon-separated PATH lookup is required.
  expect(actual).toBe(path);
});

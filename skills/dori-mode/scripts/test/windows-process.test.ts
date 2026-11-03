import { expect, test } from "bun:test";
import { agentLine } from "../src/herdr.ts";
import { AGENT, procTable, WIN_PROCS } from "../src/session-id.ts";
import type { Runner } from "../src/run.ts";

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
  expect(line).toBe("$env:A = '1'; Remove-Item Env:GPU -ErrorAction SilentlyContinue; & 'C:\\h\\omo.exe' '--model' 'it''s'");
});

import { readFileSync } from "node:fs";

import type { Clock, Runner } from "./run.ts";
import { commandExecutable, executableName } from "./executable.ts";
import { powershellData } from "./powershell.ts";
import { AGENT, type Proc, procTable, topAgent } from "./session-id.ts";

// herdr's side of the session primitives in aoe.ts (dori-mode on herdr, as upstream runs it; ported here for the move of
// every Dori off aoe/tmux, owner card Q462 2026-11-03). tmux refuses a ":" in a session name and every herdr pane id holds
// one (w1:p2, measured on herdr 0.9.5), so each primitive there picks the backend from the pane it is given: a lane opened
// under aoe keeps working after its Dori's config names herdr, and dori handover --lane can move it from one to the other.
// herdr's own agent_status is not used for omo (herdr 0.9.5 has no omo rule and falls back to idle; upstream #62/#63): the
// state comes from omo's screen, the same marks the aoe side reads (https://github.com/sisyphuslabs/dori-superagent/pull/63,
// https://github.com/sisyphuslabs/dori-superagent/issues/62).
export const isHerdrPane = (pane: string): boolean => pane.includes(":");

export type HerdrPane = { readonly pane_id: string; readonly tab_id?: string; readonly workspace_id?: string; readonly cwd?: string; readonly agent?: string };
type HerdrTab = { readonly tab_id: string; readonly label?: string; readonly pane_count?: number };

// the result object of a herdr call, or undefined when it failed or printed no JSON
export const herdrResult = async (run: Runner, argv: readonly string[]): Promise<Record<string, unknown> | undefined> => {
  const r = await run(["herdr", ...argv]);
  if (r.code !== 0) return undefined;
  try {
    return (JSON.parse(r.out) as { result?: Record<string, unknown> }).result;
  } catch {
    return undefined;
  }
};

// Every pane of the server as a session row (aoe.ts AoeSession): id and pane are the pane id, title its tab's label, path
// its cwd, profile its workspace. No server (or no herdr at all) is no session.
export const herdrSessions = async (run: Runner): Promise<{ id: string; title: string; path: string; tool?: string; profile?: string; pane: string; tab?: string }[]> => {
  const panes = ((await herdrResult(run, ["pane", "list"]))?.panes ?? []) as HerdrPane[];
  if (!panes.length) return [];
  const tabs = ((await herdrResult(run, ["tab", "list"]))?.tabs ?? []) as HerdrTab[];
  return panes.map((p) => ({ id: p.pane_id, title: tabs.find((t) => t.tab_id === p.tab_id)?.label ?? p.pane_id, path: p.cwd ?? "", ...(p.agent ? { tool: p.agent } : {}), ...(p.workspace_id ? { profile: p.workspace_id } : {}), pane: p.pane_id, ...(p.tab_id ? { tab: p.tab_id } : {}) }));
};

type ProcessInfo = { readonly shell_pid?: number; readonly foreground_processes?: readonly { readonly pid?: number; readonly cmdline?: string }[] };
const processInfo = async (run: Runner, pane: string): Promise<ProcessInfo | undefined> => (await herdrResult(run, ["pane", "process-info", "--pane", pane]))?.process_info as ProcessInfo | undefined;

export const herdrShellPid = async (run: Runner, pane: string): Promise<number> => Number((await processInfo(run, pane))?.shell_pid ?? 0);

// upstream dori-superagent #69 (https://github.com/sisyphuslabs/dori-superagent/pull/69, its src/herdr.ts and
// skills/dori-mode/scripts/src/panes.ts): its shell list. Upstream lets a shell running a command (sh -c, pwsh -Command)
// through as the agent's child; here every shell in the foreground holds the text, whatever its arguments, because no
// reading of a command line proves the agent owns the input (reviews 1-3 of #347 and the dori challenge of its plan:
// pwsh prefix-matches 39 switches, cmd /k cmd /c, zsh -oemacs -i, and bash -c 'while read -r l; do eval "$l"; done').
const SHELLS: ReadonlySet<string> = new Set([
  "sh", "ash", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "elvish", "xonsh", "pwsh", "powershell", "busybox", "cmd",
]);
// herdr on Windows names a process by its path with \ and .exe (pwsh.exe, cmd.exe)
const baseName = (value: unknown): string => String(value ?? "").replace(/^-/, "").split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");

// The shell herdr pane process-info shows in the pane's foreground group (its name), "" for an empty group or an entry
// with no readable name (doubt), else undefined. herdr still reports an agent suspended with Ctrl+Z as idle while its
// shell is in front.
export const interactiveShellInFront = (info: unknown): boolean => shellInFrontName(info) !== undefined;
export const shellInFrontName = (info: unknown): string | undefined => {
  const procs = (info as { foreground_processes?: unknown } | undefined)?.foreground_processes;
  if (!Array.isArray(procs) || procs.length === 0) return "";
  for (const proc of procs as { name?: unknown; argv?: unknown }[]) {
    const name = baseName(proc?.name);
    if (!name) return "";
    const argv0 = Array.isArray(proc?.argv) ? baseName(proc.argv[0]) : "";
    if (SHELLS.has(name)) return name;
    if (SHELLS.has(argv0)) return argv0;
  }
  return undefined;
};

export class HerdrShellError extends Error {
  readonly code = "HERDR_SHELL_UNSUPPORTED";
  constructor(readonly pane: string, readonly executable: string, readonly version: string, need = "Windows herdr panes need pwsh 7.3+") {
    super(`HERDR_SHELL_UNSUPPORTED ${pane}: ${executable || "unknown shell"} (${version}); ${need}`);
    this.name = "HerdrShellError";
  }
}

// emptyEnv: variables the launch sets to "". pwsh before 7.5 removes a variable assigned an empty string, which would turn
// e.g. CUDA_VISIBLE_DEVICES="" (no GPU) into all GPUs, so such a launch needs 7.5+.
export const requireHerdrPwsh = async (run: Runner, pane: string, platform: NodeJS.Platform = process.platform, emptyEnv: readonly string[] = []): Promise<void> => {
  if (platform !== "win32") return;
  const pid = await herdrShellPid(run, pane);
  const shell = (await procTable(run, platform)).find((process) => process.pid === pid);
  const executable = shell?.executable || commandExecutable(shell?.cmd ?? "");
  if (!["pwsh", "pwsh.exe"].includes(executableName(executable, "win32"))) throw new HerdrShellError(pane, executable, "unsupported");
  const result = await run([executable, "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]);
  const version = result.out.trim();
  const parts = /^(\d+)\.(\d+)/.exec(version);
  const major = Number(parts?.[1] ?? 0);
  const minor = Number(parts?.[2] ?? 0);
  if (result.code !== 0 || major < 7 || (major === 7 && minor < 3)) throw new HerdrShellError(pane, executable, version || "unknown version");
  if (emptyEnv.length && major === 7 && minor < 5) throw new HerdrShellError(pane, executable, version, `keeping the empty value of ${emptyEnv.join(", ")} needs pwsh 7.5+ (older pwsh removes the variable); update pwsh or leave the value out of launchEnv`);
};

// The pane's agent: the foreground process herdr names (an agent started with pane run is the shell's foreground job), else
// the topmost agent process under its shell (a zombie is none). Its command line is not searched for "mcp": a herdr lane
// carries its prompt there, so a lane keyed mcp-fix would read as an MCP server; an agent's MCP servers sit below it.
export const herdrAgentPid = async (run: Runner, pane: string, table?: readonly Proc[]): Promise<number | undefined> => {
  const info = await processInfo(run, pane);
  if (!info) return undefined;
  const fg = info.foreground_processes?.find((p) => p.pid && AGENT.test(p.cmdline ?? ""));
  if (fg?.pid) return fg.pid;
  const shell = Number(info.shell_pid ?? 0);
  if (!shell) return undefined;
  const rows = table ?? (await procTable(run));
  return topAgent(rows, shell)?.pid;
};

// gone: herdr has no such pane (its shell exited, its tab closed, or no server runs); dead: the pane is there but no agent
// runs in it any more (its shell stays after the agent exits; herdr keeps no exit status, so status is -1)
export const herdrLife = async (run: Runner, pane: string): Promise<{ readonly live: true } | { readonly live: false; readonly how: "gone" } | { readonly live: false; readonly how: "dead"; readonly status: number }> => {
  if (!(await herdrResult(run, ["pane", "get", pane]))) return { live: false, how: "gone" };
  return (await herdrAgentPid(run, pane)) ? { live: true } : { live: false, how: "dead", status: -1 };
};

export const herdrRead = async (run: Runner, pane: string, lines?: number): Promise<string> =>
  (await run(["herdr", "pane", "read", pane, "--source", lines ? "recent" : "visible", ...(lines ? ["--lines", String(lines)] : [])])).out;

export const shellQuote = (arg: string): string => (/^[\w./:@=+,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

// The line a pane's shell runs to start the agent: env(1) sets and removes the session's variables (an undefined value
// removes one, as laneEnv asks for a --use-gpu lane), so the agent starts as asked whatever the server's environment holds.
// On Windows a herdr pane runs PowerShell (herdr 0.9.5): there a line starting with a quoted path is an expression, so the
// command goes after the call operator &, words in single quotes ('' for a quote), and the variables are set before it.
export const agentLine = (argv: readonly string[], env: Readonly<Record<string, string | undefined>> = {}, platform: string = process.platform): string => {
  if (platform === "win32") {
    // Names, values and arguments never become PowerShell text: each goes in as data (powershellData).
    const data = powershellData;
    const vars = Object.entries(env).map(([k, v]) => (v === undefined
      ? `Remove-Item -LiteralPath ('Env:' + ${data(k)}) -ErrorAction SilentlyContinue; `
      : `Set-Item -LiteralPath ('Env:' + ${data(k)}) -Value ${data(v)}; `)).join("");
    return `$PSNativeCommandArgumentPassing = 'Standard'; ${vars}$doriArgv = @(${argv.map(data).join(", ")}); $doriRest = @($doriArgv | Select-Object -Skip 1); & $doriArgv[0] @doriRest`;
  }
  const unset = Object.entries(env).flatMap(([k, v]) => (v === undefined ? ["-u", k] : []));
  const set = Object.entries(env).flatMap(([k, v]) => (v === undefined ? [] : [`${k}=${v}`]));
  return [...(unset.length || set.length ? ["env", ...unset, ...set] : []), ...argv].map(shellQuote).join(" ");
};

// A new tab labelled title in cwd (in workspace when given) whose root pane runs argv; the pane and tab ids.
export const openHerdrSession = async (run: Runner, clock: Clock, opts: { readonly title: string; readonly cwd: string; readonly argv: readonly string[]; readonly env?: Readonly<Record<string, string | undefined>>; readonly workspace?: string }): Promise<{ readonly pane: string; readonly tab?: string }> => {
  const tabArgv = (workspace?: string) => ["herdr", "tab", "create", ...(workspace ? ["--workspace", workspace] : []), "--cwd", opts.cwd, "--label", opts.title, "--no-focus"];
  let created = await run(tabArgv(opts.workspace));
  // a fresh server has no workspace to put a tab in ("workspace_not_found", herdr 0.9.5 on Linux and Windows): make one
  if (created.code !== 0 && !opts.workspace && /workspace_not_found/.test(created.out + created.err)) {
    const ws = (await herdrResult(run, ["workspace", "create", "--label", "dori", "--cwd", opts.cwd, "--no-focus"]))?.workspace as { workspace_id?: string } | undefined;
    if (ws?.workspace_id) created = await run(tabArgv(ws.workspace_id));
  }
  if (created.code !== 0) throw new Error(`herdr tab create failed: ${created.err || created.out}`);
  const made = (JSON.parse(created.out) as { result: { root_pane: { pane_id: string; tab_id?: string }; tab?: { tab_id?: string }; tab_id?: string } }).result;
  const pane = made.root_pane.pane_id;
  const tab = made.root_pane.tab_id ?? made.tab?.tab_id ?? made.tab_id;
  // a fresh shell may drop what is typed before its prompt is drawn
  for (let i = 0; i < 20 && !(await herdrRead(run, pane)).trim(); i++) await clock.sleep(250);
  await requireHerdrPwsh(run, pane, process.platform, Object.entries(opts.env ?? {}).flatMap(([k, v]) => (v === "" ? [k] : [])));
  const ran = await run(["herdr", "pane", "run", pane, agentLine(opts.argv, opts.env)]);
  if (ran.code !== 0) throw new Error(`herdr pane run failed in ${pane}: ${ran.err || ran.out}`);
  return { pane, ...(tab ? { tab } : {}) };
};

// Closes the pane's tab when the pane is all it holds, else the pane only; the line says which (closedLine).
export const closeHerdrSession = async (run: Runner, pane: string): Promise<string> => {
  const got = (await herdrResult(run, ["pane", "get", pane]))?.pane as HerdrPane | undefined;
  if (!got) return `herdr pane ${pane} not found`;
  const tab = got.tab_id ? ((await herdrResult(run, ["tab", "get", got.tab_id]))?.tab as HerdrTab | undefined) : undefined;
  const whole = tab?.tab_id && (tab.pane_count ?? 1) <= 1;
  const r = await run(whole ? ["herdr", "tab", "close", tab.tab_id] : ["herdr", "pane", "close", pane]);
  return r.code === 0 ? `herdr ${whole ? `tab ${tab.tab_id}` : "pane"} (${pane}) stopped and closed` : `herdr ${pane} not closed: ${(r.err || r.out).slice(0, 160)}`;
};

// the environment a process started with (/proc/<pid>/environ); empty when it cannot be read
export const procEnv = (pid: number): Map<string, string> => {
  try {
    return new Map(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)] as [string, string]));
  } catch {
    return new Map();
  }
};

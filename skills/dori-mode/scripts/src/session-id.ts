import { readdirSync } from "node:fs";
import { join } from "node:path";

import { tmuxPanePid } from "./aoe.ts";
import type { Backend } from "./config.ts";
import type { Runner } from "./run.ts";
import { isAgentCommand } from "./executable.ts";

// stat: the ps state letters ("S", "R+", "Z" for a zombie); absent when the table was built without it
export type Proc = { readonly pid: number; readonly ppid: number; readonly cmd: string; readonly stat?: string; readonly startedAt?: string; readonly executable?: string };
export type SessionHit = { readonly id: string; readonly via: "argv" | "child-env" | "start-time" | "none"; readonly pid?: number };

// omo on Linux and macOS (senpi's bundle under bun, or the omo command), and on Windows (the same bundle path with
// backslashes, or omo.exe / omo-windows-x64.exe, quoted as Win32_Process shows a command line with spaces in its path)
export const AGENT = { test: isAgentCommand } as const;
const ENV_ID = /(?:^|\s)PI_SESSION_ID=([0-9a-f-]{36})(?:\s|$)/;
export const SESSION_FILE = /^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z_([0-9a-f-]{36})\.jsonl$/;
const START_WINDOW_MS = 180_000;

// Windows has no ps: its process table comes from Win32_Process (pid, parent, command line; no state letters)
export const WIN_PROCS = ["powershell", "-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath,@{Name='StartedAt';Expression={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')}}} | ConvertTo-Json -Compress"];

export const winProcs = (json: string): Proc[] => {
  try {
    const rows: unknown = JSON.parse(json || "[]");
    const table = (Array.isArray(rows) ? rows : [rows]).flatMap((r: unknown): Proc[] => {
      if (typeof r !== "object" || r === null || !("ProcessId" in r) || typeof r.ProcessId !== "number" || !r.ProcessId) return [];
      return [{
        pid: r.ProcessId,
        ppid: "ParentProcessId" in r && typeof r.ParentProcessId === "number" ? r.ParentProcessId : 0,
        cmd: "CommandLine" in r && typeof r.CommandLine === "string" ? r.CommandLine : "",
        ...("ExecutablePath" in r && typeof r.ExecutablePath === "string" ? { executable: r.ExecutablePath } : {}),
        ...("StartedAt" in r && typeof r.StartedAt === "string" ? { startedAt: r.StartedAt } : {}),
        stat: "",
      }];
    });
    const byPid = new Map(table.map((p) => [p.pid, p]));
    // A parent PID can have been reused after the child's original parent exited.
    return table.map((p) => Date.parse(byPid.get(p.ppid)?.startedAt ?? "") > Date.parse(p.startedAt ?? "") ? { ...p, ppid: 0 } : p);
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
};

export const procTable = async (run: Runner, platform: string = process.platform): Promise<Proc[]> =>
  platform === "win32" ? winProcs((await run(WIN_PROCS)).out) : (await run(["ps", "-A", "-o", "pid=,ppid=,stat=,command="])).out.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3] ?? "", cmd: m[4] ?? "" }] : [];
  });

// A zombie ("[bash] <defunct>"): it already ended and only waits for its parent to collect it, so no work dies with it.
export const ended = (p: Proc): boolean => (p.stat ?? "").startsWith("Z") || /<defunct>\s*$/.test(p.cmd);

export const descendants = (table: readonly Proc[], root: number): Proc[] => {
  const byParent = new Map<number, Proc[]>();
  for (const p of table) byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p]);
  const out: Proc[] = [];
  const queue = [...(byParent.get(root) ?? [])];
  const seen = new Set([root]);
  for (let p = queue.shift(); p; p = queue.shift()) {
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    out.push(p);
    queue.push(...(byParent.get(p.pid) ?? []));
  }
  return out;
};

// The pane's agent: the topmost agent process at or under its shell, read in tree order. Its command line is not searched
// for "mcp": a herdr lane carries its own prompt there (a lane keyed mcp-fix), and the agent's MCP servers sit below it.
export const topAgent = (table: readonly Proc[], shell: number): Proc | undefined =>
  shell ? [...table.filter((p) => p.pid === shell), ...descendants(table, shell)].find((p) => AGENT.test(p.cmd) && !ended(p)) : undefined;

export const sessionDirFor = (sessionsDir: string, cwd: string): string => join(sessionsDir, `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A Windows command line split the way CommandLineToArgvW splits it: quotes group words, 2n backslashes before a quote
// give n backslashes and toggle quoting, 2n+1 give n and a literal quote, "" inside quotes is a literal quote, and other
// backslashes are literal.
export const winArgv = (line: string): string[] => {
  const out: string[] = [];
  let word = "";
  let inWord = false;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      let n = 0;
      while (line[i] === "\\") { n++; i++; }
      if (line[i] === '"') { word += "\\".repeat(Math.floor(n / 2)); if (n % 2) word += '"'; else { quoted = !quoted; } }
      else { word += "\\".repeat(n); i--; }
      inWord = true;
    } else if (c === '"') {
      if (quoted && line[i + 1] === '"') { word += '"'; i++; } else quoted = !quoted;
      inWord = true;
    } else if ((c === " " || c === "\t") && !quoted) {
      if (inWord) out.push(word);
      word = "";
      inWord = false;
    } else { word += c; inWord = true; }
  }
  if (inWord) out.push(word);
  return out;
};

// The exact session an agent's command line names: --session-id <id> (omo: "use exact project session ID"), or
// --session <path to the session .jsonl> (the uuid at the end of that file name; aoe resumes a session this way) or a
// whole uuid. "" when it names none, or only a partial uuid omo would resolve itself (which session that is, is not known).
export const argvSessionId = (argv: readonly string[]): string => {
  const flagAt = argv.findIndex((a) => a === "--session" || a === "--session-id");
  const value = flagAt >= 0 ? (argv[flagAt + 1] ?? "") : "";
  if (argv[flagAt] === "--session-id") return value;
  if (value.endsWith(".jsonl")) return SESSION_FILE.exec(value.split(/[\\/]/).pop() ?? "")?.[5] ?? "";
  return UUID.test(value) ? value : "";
};

// The flags with which omo picks its session itself (omo --help: --session, --session-id, --continue/-c, --resume/-r,
// --fork, --rebind, --no-session), as a separate word or as --flag=value.
const SELECTORS = ["--session", "--session-id", "--continue", "-c", "--resume", "-r", "--fork", "--rebind", "--no-session"];
export const hasSessionSelector = (argv: readonly string[]): boolean => argv.some((a) => SELECTORS.some((s) => a === s || a.startsWith(`${s}=`)));

export type SessionDeps = { readonly run: Runner; readonly sessionsDir: string; readonly backend?: Backend; readonly listDir?: (dir: string) => readonly string[] };

export const shellPidOf = async (pane: string, deps: SessionDeps): Promise<number> => {
  // the pane id says its backend, whatever the config says (aoe.ts tmuxPanePid: herdr process-info for a herdr pane id)
  return tmuxPanePid(deps.run, pane);
};

export const resolveSession = async (pane: string, cwd: string, table: readonly Proc[], deps: SessionDeps): Promise<SessionHit> => {
  const shellPid = await shellPidOf(pane, deps);
  const agent = topAgent(table, shellPid);
  if (!agent) return { id: "", via: "none" };
  const argv = process.platform === "win32" ? winArgv(agent.cmd) : agent.cmd.split(/\s+/);
  const fromFlag = argvSessionId(argv);
  if (fromFlag) return { id: fromFlag, via: "argv", pid: agent.pid };
  // a selector omo resolves itself (a partial --session uuid, --continue, --resume, --fork, --rebind) can open an older
  // session, whose file name is no start time: only a child's exact PI_SESSION_ID may name it, never a nearby new session
  const selected = hasSessionSelector(argv);
  for (const child of process.platform === "win32" ? [] : descendants(table, agent.pid).slice(0, 40)) {
    const env = await deps.run(["ps", "eww", "-o", "command=", "-p", String(child.pid)]);
    const hit = ENV_ID.exec(env.out);
    if (hit?.[1]) return { id: hit[1], via: "child-env", pid: agent.pid };
  }
  if (selected) return { id: "", via: "none", pid: agent.pid };
  const started = Date.parse(process.platform === "win32" ? agent.startedAt ?? "" : (await deps.run(["ps", "-o", "lstart=", "-p", String(agent.pid)])).out);
  if (Number.isNaN(started)) return { id: "", via: "none", pid: agent.pid };
  const list = deps.listDir ?? ((d: string) => { try { return readdirSync(d); } catch { return []; } });
  const near = list(sessionDirFor(deps.sessionsDir, cwd)).flatMap((name) => {
    const m = SESSION_FILE.exec(name);
    const at = m ? Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`) : Number.NaN;
    return m?.[5] && at >= started - 5_000 && at <= started + START_WINDOW_MS ? [{ id: m[5], at }] : [];
  }).sort((a, b) => a.at - b.at);
  return near[0] ? { id: near[0].id, via: "start-time", pid: agent.pid } : { id: "", via: "none", pid: agent.pid };
};

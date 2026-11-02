import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { tmuxPanePid } from "./aoe.ts";
import type { Backend } from "./config.ts";
import type { Runner } from "./run.ts";

// stat: the ps state letters ("S", "R+", "Z" for a zombie); absent when the table was built without it
export type Proc = { readonly pid: number; readonly ppid: number; readonly cmd: string; readonly stat?: string };
export type SessionHit = { readonly id: string; readonly via: "argv" | "child-env" | "start-time" | "none"; readonly pid?: number };

export const AGENT = /senpi\/dist\/bundle\/cli\.js|(^|\/)omo(\s|$)/;
const ENV_ID = /(?:^|\s)PI_SESSION_ID=([0-9a-f-]{36})(?:\s|$)/;
export const SESSION_FILE = /^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z_([0-9a-f-]{36})\.jsonl$/;
const START_WINDOW_MS = 180_000;

export const procTable = async (run: Runner): Promise<Proc[]> =>
  (await run(["ps", "-A", "-o", "pid=,ppid=,stat=,command="])).out.split("\n").flatMap((line) => {
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
  for (let p = queue.shift(); p; p = queue.shift()) {
    out.push(p);
    queue.push(...(byParent.get(p.pid) ?? []));
  }
  return out;
};

export const sessionDirFor = (sessionsDir: string, cwd: string): string => join(sessionsDir, `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);

export type SessionDeps = { readonly run: Runner; readonly sessionsDir: string; readonly backend?: Backend; readonly listDir?: (dir: string) => readonly string[] };

export const shellPidOf = async (pane: string, deps: SessionDeps): Promise<number> => {
  if (deps.backend === "aoe") return tmuxPanePid(deps.run, pane);
  const info = await deps.run(["herdr", "pane", "process-info", "--pane", pane]);
  return info.code === 0 ? Number((JSON.parse(info.out) as { result?: { process_info?: { shell_pid?: number } } }).result?.process_info?.shell_pid ?? 0) : 0;
};

export const resolveSession = async (pane: string, cwd: string, table: readonly Proc[], deps: SessionDeps): Promise<SessionHit> => {
  const shellPid = await shellPidOf(pane, deps);
  const agent = shellPid ? descendants(table, shellPid).find((p) => AGENT.test(p.cmd) && !/\bmcp\b/.test(p.cmd)) : undefined;
  if (!agent) return { id: "", via: "none" };
  const argv = agent.cmd.split(/\s+/);
  const flagAt = argv.findIndex((a) => a === "--session" || a === "--session-id");
  // omo also takes --session <path to the session .jsonl>; the id is the uuid at the end of that file name
  const flagValue = flagAt >= 0 ? (argv[flagAt + 1] ?? "") : "";
  const fromFlag = flagValue.endsWith(".jsonl") ? (SESSION_FILE.exec(basename(flagValue))?.[5] ?? "") : flagValue;
  if (fromFlag) return { id: fromFlag, via: "argv", pid: agent.pid };
  for (const child of descendants(table, agent.pid).slice(0, 40)) {
    const env = await deps.run(["ps", "eww", "-o", "command=", "-p", String(child.pid)]);
    const hit = ENV_ID.exec(env.out);
    if (hit?.[1]) return { id: hit[1], via: "child-env", pid: agent.pid };
  }
  const started = Date.parse((await deps.run(["ps", "-o", "lstart=", "-p", String(agent.pid)])).out);
  if (Number.isNaN(started)) return { id: "", via: "none", pid: agent.pid };
  const list = deps.listDir ?? ((d: string) => { try { return readdirSync(d); } catch { return []; } });
  const near = list(sessionDirFor(deps.sessionsDir, cwd)).flatMap((name) => {
    const m = SESSION_FILE.exec(name);
    const at = m ? Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`) : Number.NaN;
    return m?.[5] && at >= started - 5_000 && at <= started + START_WINDOW_MS ? [{ id: m[5], at }] : [];
  }).sort((a, b) => a.at - b.at);
  return near[0] ? { id: near[0].id, via: "start-time", pid: agent.pid } : { id: "", via: "none", pid: agent.pid };
};

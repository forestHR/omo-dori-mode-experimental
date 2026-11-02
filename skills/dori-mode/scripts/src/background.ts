import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Runner } from "./run.ts";
import { type Proc, procTable, resolveSession, sessionDirFor } from "./session-id.ts";

// Background work an omo session started and is still waiting on, read from its session transcript: a detached eval
// cell, a background (or auto-detached) bash session, a background task child, a monitor a cell armed (tool.monitor, ended
// by the notification that its command exited or its file fired, matched by its description). omo shows none of these on its status
// line, so a lane that ended its turn to wait for one looks idle on screen. Each start is read from the tool's own result
// (never from text it printed: a lane that greps logs or omo's source must not look busy), each end from a delivered
// notification or a kill/cancel result; a start without its end is still running.
export type BackgroundJob = { readonly kind: "eval" | "bash" | "task" | "monitor"; readonly id: string; readonly at: number };

const BASH_START = /^(?:Command running in background with ID: |Command is still running; auto-detached to background with ID: )(bash_\w+)/;
const TASK_START = /\((st_[0-9a-z]+), running\)/;
const ENDS: readonly RegExp[] = [
  /Detached eval cell (\S+) \(/g,
  /Background terminal session (bash_\w+) finished/g,
  /Killed (bash_\w+)\./g,
  /\b(bash_\w+) exited\b/g,
  /task completion [^\n]*?\bid:(st_[0-9a-z]+)/g,
  /Task (st_[0-9a-z]+) had already finished/g,
];
// a line without any of these cannot start or end a job; it is not parsed
const HINT = /detached and is running|"bash_id"|in background with ID|auto-detached|st_[0-9a-z]+|Detached eval cell|is cancelled|Background terminal session|Killed bash_|bash_\w+ exited|Monitor started with ID|senpi-monitor:notification/;

const MONITOR_START = /^Monitor started with ID: (mon_\w+)/;

type ToolCall = { readonly name?: string; readonly resultPreview?: string; readonly args?: { readonly description?: string; readonly path?: string } };
// a monitor notification: each monitor it carries, by the watch's id (bash_<n> for a command) and description; kind
// "summary" is the end of its command
type MonitorEvent = { readonly id?: string; readonly description?: string; readonly kinds?: readonly string[] };
type TaskRun = { readonly task_id?: string; readonly status?: string };
type Details = TaskRun & { readonly bash_id?: string; readonly background?: boolean; readonly run_in_background?: boolean; readonly items?: readonly TaskRun[]; readonly toolCalls?: readonly ToolCall[] };
type Entry = { readonly type?: string; readonly customType?: string; readonly details?: { readonly monitors?: readonly MonitorEvent[] }; readonly timestamp?: string; readonly content?: unknown; readonly message?: { readonly role?: string; readonly toolName?: string; readonly toolCallId?: string; readonly content?: unknown; readonly details?: Details } };

const ENDING_TOOLS = new Set(["kill_bash", "task_cancel"]);
const EVAL_STOPPED = /^Eval cell (\S+) \(\w+\) is cancelled/;

// the jobs one tool result started: its own detached cell, the bash sessions and tasks it (or its cell's tool calls) put
// in the background
const startsOf = (tool: string, callId: string, text: string, d: Details | undefined): [BackgroundJob["kind"], string][] => {
  const out: [BackgroundJob["kind"], string][] = [];
  if (tool === "eval" && callId && text.startsWith(`Eval cell ${callId} detached and is running`)) out.push(["eval", callId]);
  if (tool === "bash" && d?.background && d.bash_id) out.push(["bash", d.bash_id]);
  if (tool === "task" && d?.run_in_background) for (const t of d.items ?? [d]) if (t.task_id && t.status === "running") out.push(["task", t.task_id]);
  for (const c of d?.toolCalls ?? []) {
    const bash = c.name === "bash" ? BASH_START.exec(c.resultPreview ?? "")?.[1] : undefined;
    const task = c.name === "task" && c.resultPreview?.startsWith("Started task ") ? TASK_START.exec(c.resultPreview)?.[1] : undefined;
    const monitor = c.name === "monitor" ? MONITOR_START.exec(c.resultPreview ?? "")?.[1] : undefined;
    if (monitor) out.push(["monitor", monitor]);
    if (bash) out.push(["bash", bash]);
    if (task) out.push(["task", task]);
  }
  return out;
};

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c && typeof c === "object" && "text" in c && typeof c.text === "string" ? c.text : "")).join("\n") : "";

// The jobs started in [since, until] whose end is not in the transcript up to until.
export const pendingBackground = (transcript: string, since = 0, until = Number.POSITIVE_INFINITY): BackgroundJob[] => {
  const open = new Map<string, BackgroundJob>();
  // a monitor's start names it mon_<id>, its notifications name the watch bash_<n>: both are tied by its description
  const monitors = new Map<string, { readonly description: string; readonly path: boolean }>();
  const watchOf = new Map<string, string>();
  for (const line of transcript.split("\n")) {
    if (!HINT.test(line)) continue;
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    const at = Date.parse(e.timestamp ?? "");
    if (Number.isNaN(at) || at > until) continue;
    const tool = e.message?.role === "toolResult" ? (e.message.toolName ?? "") : undefined;
    const text = e.type === "custom_message" ? textOf(e.content) : tool !== undefined ? textOf(e.message?.content) : "";
    if (e.type === "custom_message" && e.customType === "senpi-monitor:notification")
      for (const ev of e.details?.monitors ?? [])
        for (const [id, m] of monitors)
          if (m.description === ev.description) {
            if (ev.id) watchOf.set(ev.id, id);
            if (m.path || ev.kinds?.includes("summary")) open.delete(id);
          }
    if (e.type === "custom_message" || (tool && ENDING_TOOLS.has(tool)))
      for (const re of ENDS)
        for (const m of text.matchAll(re))
          if (m[1]) {
            open.delete(m[1]);
            const mon = watchOf.get(m[1]);
            if (mon) open.delete(mon);
          }
    const stopped = tool === "eval" ? EVAL_STOPPED.exec(text)?.[1] : undefined;
    if (stopped) open.delete(stopped);
    if (tool === "task_cancel") for (const m of text.matchAll(/\b(st_[0-9a-z]+)\b/g)) if (m[1]) open.delete(m[1]);
    if (tool === undefined || at < since) continue;
    for (const [kind, id] of startsOf(tool, e.message?.toolCallId ?? "", text, e.message?.details)) if (!open.has(id)) open.set(id, { kind, id, at });
    for (const c of e.message?.details?.toolCalls ?? []) {
      const mon = c.name === "monitor" ? MONITOR_START.exec(c.resultPreview ?? "")?.[1] : undefined;
      if (mon) monitors.set(mon, { description: c.args?.description ?? "", path: Boolean(c.args?.path) });
    }
  }
  return [...open.values()];
};

// senpi's own record of a background task (<home>/.omo/agent/projects/<project>/senpi-task/tasks/<id>.json). Its status
// is what the transcript cannot tell: a task that wakes itself again after its completion line (GongDori's step3-adopt
// st_01a17b36 on 2026-10-27, run 38 after 37 completions) still runs although the transcript shows it ended.
// host: the process that runs it (host_pid): the session's own agent for an in-process task, the account's shared task host
// (omo --mode rpc --multi-session) for one in execution mode "process"
export type TaskRecord = { readonly id: string; readonly status: string; readonly file: string; readonly at?: string; readonly what?: string; readonly host?: number; readonly mode?: string };

// senpi's task statuses are pending, running, paused, completed, error, cancelled, interrupted and lost; the first three
// have not ended
const OPEN_STATUS = new Set(["pending", "running", "paused"]);
export const taskOpen = (r: TaskRecord): boolean => OPEN_STATUS.has(r.status);

const taskDirs = (home: string): string[] => {
  const projects = join(home, ".omo", "agent", "projects");
  try {
    return readdirSync(projects).map((d) => join(projects, d, "senpi-task", "tasks")).filter((d) => existsSync(d));
  } catch {
    return [];
  }
};

type RawRecord = { readonly task_id?: string; readonly status?: string; readonly started_at?: string; readonly created_at?: string; readonly task_summary?: string; readonly parent_session_id?: string; readonly root_session_id?: string; readonly host_pid?: number | null; readonly execution_mode?: string };

const parseRecord = (file: string, text: string): (TaskRecord & { readonly parent?: string; readonly root?: string }) | undefined => {
  let r: RawRecord;
  try {
    r = JSON.parse(text) as RawRecord;
  } catch {
    return undefined;
  }
  const id = r.task_id ?? file.slice(file.lastIndexOf("/") + 1, -".json".length);
  const at = r.started_at ?? r.created_at;
  return { id, status: r.status ?? "", file, ...(at ? { at } : {}), ...(r.task_summary ? { what: r.task_summary } : {}), ...(typeof r.host_pid === "number" ? { host: r.host_pid } : {}), ...(r.execution_mode ? { mode: r.execution_mode } : {}), ...(r.parent_session_id ? { parent: r.parent_session_id } : {}), ...(r.root_session_id ? { root: r.root_session_id } : {}) };
};

// The record of one task, under any project; undefined when senpi keeps none.
export const taskRecord = (home: string, id: string): TaskRecord | undefined => {
  for (const dir of taskDirs(home)) {
    const file = join(dir, `${id}.json`);
    if (existsSync(file)) return parseRecord(file, readFileSync(file, "utf8"));
  }
  return undefined;
};

// The records of the tasks a session started, its own and those of its tasks' tasks (parent or root session).
export const taskRecords = (home: string, session: string): TaskRecord[] => {
  if (!session) return [];
  const out: TaskRecord[] = [];
  for (const dir of taskDirs(home)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = join(dir, name);
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!text.includes(session)) continue;
      const r = parseRecord(file, text);
      if (r && (r.parent === session || r.root === session)) out.push({ id: r.id, status: r.status, file: r.file, ...(r.at ? { at: r.at } : {}), ...(r.what ? { what: r.what } : {}), ...(r.host !== undefined ? { host: r.host } : {}), ...(r.mode ? { mode: r.mode } : {}) });
    }
  }
  return out;
};

// The tasks of a replaced session that still run after the move: open in senpi's record (its own or its tasks' tasks, never
// another session's on the same host) and their host alive. A task whose record says completed is left out: another
// session's task_cancel answers "is completed, not running. No change." for it (QA 2026-11-01). One whose host is the
// old agent (in-process) stops when that agent is frozen (stopped) and ends when it closes: leave passes it while frozen. One in the account's
// shared task host (execution mode "process", GongDori's) is reached by neither: on 2026-10-27 three such tasks of
// e7-ledger-replay's closed session went on editing the repository for 74 minutes, until the lead ran task_cancel.
export const strayTasks = (home: string, session: string, alive: (pid: number) => boolean, leave?: number): TaskRecord[] =>
  taskRecords(home, session).filter((r) => taskOpen(r) && (r.host === undefined || (r.host !== leave && alive(r.host))));

// The lane's own session transcript (the session its pane's omo runs) and the agent's start, or undefined when either
// cannot be read. Jobs started before the agent process started died with the earlier process; jobs started before
// notBefore (a server or watcher left running for hours) are not what the lane waits on.
// The transcript file of the session a pane's omo runs, and that agent's pid, or undefined when either cannot be read.
export const sessionFile = async (run: Runner, sessionsDir: string, pane: string, cwd: string, table?: readonly Proc[]): Promise<{ readonly path: string; readonly pid: number } | undefined> => {
  const hit = await resolveSession(pane, cwd, table ?? (await procTable(run)), { run, sessionsDir, backend: "aoe" });
  if (!hit.id || !hit.pid) return undefined;
  const dir = sessionDirFor(sessionsDir, cwd);
  let name: string | undefined;
  try {
    name = readdirSync(dir).find((n) => n.endsWith(`_${hit.id}.jsonl`));
  } catch {
    return undefined;
  }
  return name ? { path: join(dir, name), pid: hit.pid } : undefined;
};

export const laneBackground = async (run: Runner, sessionsDir: string, pane: string, cwd: string, until = Number.POSITIVE_INFINITY, notBefore = 0): Promise<BackgroundJob[] | undefined> => {
  const file = await sessionFile(run, sessionsDir, pane, cwd);
  if (!file) return undefined;
  const started = Date.parse((await run(["ps", "-o", "lstart=", "-p", String(file.pid)])).out.trim());
  return pendingBackground(readFileSync(file.path, "utf8"), Math.max(Number.isNaN(started) ? 0 : started, notBefore), until);
};

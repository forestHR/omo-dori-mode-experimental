// allow: SIZE_OK - existing lane-handover state machine; the signal wrapper is per transaction.
// dori handover --lane <key>: move a lane whose conversation grew long to a new agent session.
// Order: refuse while work would die with the old session (a local chain, a background eval cell, a running turn, an
// open question) unless the
// lane marked a safe point (dori handover ready) -> write the note -> open the new session in the same real path with the
// lane's model and thinking level -> point the registry and the question cards at it -> check its status line, its
// monitors and a [LEAD] probe ack -> only then close the old session. A failed check moves everything back and closes
// the new session; the old one stays the lane. Detached jobs (outside the pane's process tree) are listed, never touched.
// Work a monitor of the old session started (a LAUNCHES_WORK monitor: a chain it put in the background) runs under that
// monitor, so the old session is frozen instead of closed, its monitors left running, and closes once that work ended.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { pendingBackground, taskOpen, taskRecord, taskRecords } from "./background.ts";
import { captureTmux, closeAoeSession, envMismatch, inputLine, isClosedLine, laneEnv, liveSessions, openAoeSession, paneLife, QUESTION_MARK, sessionFor, tmuxPanePid } from "./aoe.ts";
import { turnRunning } from "./submit.ts";
import type { FlowDeps } from "./done-flow.ts";
import { freezePane, freezeSignal, writeFrozen } from "./frozen.ts";
import { endOldMonitors } from "./handover-monitors.ts";
import { ackFile, endStrayTasks, type HandoverDeps, liveMonitors, manifestPath, monitorLine, type MonitorSpec, missingMonitors, monitorWork, openGoal, openTodos, PROBE, readManifest, takeLock } from "./handover.ts";
import { awaitPrompt } from "./launch.ts";
import { QuestionStore } from "./messenger/discord-cards.ts";
import { herdrResult, isHerdrPane } from "./herdr.ts";
import { omoSession, sendVerified } from "./panes.ts";
import { hasSessionSelector } from "./session-id.ts";
import { type Lane, statusOf } from "./registry.ts";
import { iso, type Runner } from "./run.ts";
import { AGENT, descendants, ended, type Proc, sessionDirFor } from "./session-id.ts";
import { commandExecutable } from "./executable.ts";
import { appendRollover, type OwnerMessage, ownerMessagesFor, approvalProblem, autoReason, type Blocked, clearQuiet, COMMITTED, contextK, decidedBy, heldTyped, inboxMessages, LEAD_PREFIX, lastProposal, leadLines, limitsFor, ownerRolloverText, readRollovers, reportToOwner, rolloverCause, type RolloverEntry, type RolloverRequest, type Said, sessionFixes, type Signals, sessionSignals, setQuiet, type Sizes, sizePct, type Step, type Supplement, takeAutoGrant, userLines } from "./rollover.ts";
import { stuckTop } from "./explore.ts";
import { bulletsIn, covered, fillGaps, flat, type Missing, missingHeadings, quoted, quotesIn, section, seedRestatement, wholeBullet } from "./restatement.ts";
import { watchLog } from "./watch-log.ts";

export type LaneHandoverDeps = FlowDeps & {
  readonly cardDir: string;
  readonly home: string;
  // the omo session id of the agent running in a pane ("" when it cannot be told)
  readonly sessionOf: (pane: string, cwd: string) => Promise<string>;
  readonly procs: () => Promise<Proc[]>;
  // a process's environment as NAME=value lines ("" when it cannot be read)
  readonly envOf: (pid: number) => string;
  readonly alive: (pid: number) => boolean;
  // stops, resumes or ends a process group; false when the signal could not be sent
  readonly signal: HandoverDeps["signal"];
  // the path with symlinks resolved (the path itself when it cannot be resolved)
  readonly realpath: (path: string) => string;
  readonly nonce: () => string;
  readonly print: (line: string) => void;
  // posts the owner's after-the-fact note of a rollover the lead decided (in the lane's discord thread, else the owner's
  // channel) and returns its message id; absent when no messenger is set up, and then a lead: approval is refused
  readonly reportOwner?: (thread: string | null, text: string) => Promise<string>;
  // the Discord inbox and the owner's ids in it (DORI_DISCORD_OWNER, DORI_KAKAO_OWNER_ID): an approval "lead:<reason>, owner
  // <message id or link>" holds only when that message is the owner's there
  readonly inbox?: string;
  readonly ownerIds?: readonly string[];
};

export type LaneHandoverOptions = {
  // the approval: lead:<reason and signal>, the owner's answered card Qn, a message link or their words (rollover.ts approvalProblem); --dry-run needs none
  readonly approvedBy?: string;
  // the one-use grant freshness wrote for the run it started (DORI_HANDOVER_AUTO_GRANT): an auto: approval holds only with it
  readonly autoGrant?: string;
  readonly note?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly force?: boolean;
  readonly keepOld?: boolean;
  readonly dryRun?: boolean;
  readonly verifyMin?: number;
  // an automatic start (freshness passes --wait-idle): wait up to this many minutes for the lane's turn to end and move it
  // at that idle moment
  readonly waitIdleMin?: number;
  // set by a run that waited for another run's lock: the lane's pane it found then (internal)
  readonly boundPane?: string;
  // the waiting request a resumed run was started for (freshness readyResume): its time and the pane it was asked in
  readonly serves?: { readonly at: string; readonly pane: string };
  // set by that waiting loop: it holds the lock; final means the wait is over, so a lane still busy is refused
  readonly idle?: { readonly final: boolean; readonly since: number; readonly waitedMin: number };
};

// retry: only a running turn or an open question held the lane, and the waiting loop tries again when it is idle
export type LaneHandoverResult = { readonly code: number; readonly note?: string; readonly to?: string; readonly retry?: boolean };

// What the lane confirmed with dori handover ready: the local chains it accepts losing, and its own notes.
export type ReadyMark = { readonly key: string; readonly pane: string; readonly at: string; readonly chains: readonly number[]; readonly note?: string };

export type StatusLine = { readonly model?: string; readonly thinking?: string; readonly contextPct?: number; readonly account?: string };

// pids: the chain and every process under it, so a grandchild that outlives its parent still counts as the chain running
type Job = { readonly pid: number; readonly cmd: string; readonly pids?: readonly number[] };

export type LaneFacts = {
  readonly lane: Lane;
  readonly from: { readonly pane: string; readonly aoeId: string; readonly session: string; readonly title: string; readonly cwd: string };
  readonly cwd: string;
  readonly model: string;
  readonly thinking?: string;
  readonly contextPct?: number;
  readonly account?: string;
  readonly monitors: readonly MonitorSpec[];
  readonly todos: readonly string[];
  readonly goal?: string;
  readonly chains: readonly Job[];
  readonly detached: readonly Job[];
  // work the old session's monitors started (pid: the monitor's process, pids: the work under it); absent: none
  readonly work?: readonly Job[];
  readonly ready?: ReadyMark;
  readonly laneNote: string;
  readonly approvedBy?: string;
  readonly signals: Signals;
  // the old agent's process (frozen during the switch) and the old conversation's log file
  readonly agentPid?: number;
  readonly oldLog?: string;
  // the owner's own messages since the lane's last handover (rollover.ts ownerMessagesFor)
  readonly ownerMessages?: readonly OwnerMessage[];
  // the lead's own [LEAD] instructions in the old conversation since the lane's last handover, as they were typed
  readonly leadWords?: readonly Said[];
  // background tasks (task tool, st_...) the old session started that had not ended when the note was written
  readonly tasks?: readonly TaskRun[];
};

// A background task of the old session: its id, when it started, what it was asked (the task tool's start line) and where
// senpi keeps its record and transcript (<home>/.omo/agent/projects/<project>/senpi-task/), which other sessions can read.
export type TaskRun = { readonly id: string; readonly at: string; readonly what?: string; readonly record?: string; readonly transcript?: string };

// The task tool's start line names what the task does: "Started task <what> (st_..., running)".
const taskRuns = (log: string, ids: readonly { readonly id: string; readonly at: number; readonly what?: string }[], home: string): TaskRun[] => {
  const what = new Map([...log.matchAll(/Started task (.{1,240}?) \((st_[0-9a-z]+), running\)/g)].map((m) => [m[2] ?? "", (m[1] ?? "").replace(/\\"/g, '"')]));
  const projects = join(home, ".omo", "agent", "projects");
  let dirs: string[] = [];
  try {
    dirs = readdirSync(projects);
  } catch {
    dirs = [];
  }
  return ids.map(({ id, at, what: summary }) => {
    const dir = dirs.map((d) => join(projects, d, "senpi-task")).find((d) => existsSync(join(d, "tasks", `${id}.json`)));
    const asked = what.get(id) ?? summary;
    return { id, at: new Date(at).toISOString(), ...(asked ? { what: asked } : {}), ...(dir ? { record: join(dir, "tasks", `${id}.json`), transcript: join(dir, "children", id, "sessions", id) } : {}) };
  });
};

// One lead instruction as it was typed (its lines quoted), with where it came from.
const leadItem = (s: Said): string => [`- ${s.at.slice(0, 16)}Z${s.line ? ` (old log line ${s.line})` : " (typed into the old pane while the handover ran)"}:`, ...s.text.split("\n").map((l) => `  > ${l}`)].join("\n");

// The headings of the conversation summary the old session writes at its safe point (dori handover ready --note FILE):
// what only its conversation knows. The new session reads it; dori handover ready --template prints them.
export const SUMMARY_HEADINGS = ["Owner's words and constraints", "Decisions and why", "Ruled out", "In progress", "Next step"] as const;
export const SUMMARY_TEMPLATE = [
  "## Owner's words and constraints",
  "(every instruction and constraint from the owner or the lead that still holds, how the work must be done included, quoted exactly in \"double quotes\", newest last, with the message link when you have it; summaries lose these first)",
  "## Decisions and why",
  "(each decision made in this conversation and the evidence it rests on)",
  "## Ruled out",
  "(approaches, hypotheses and fixes already tried and rejected, with the result that rejected each; the new session must not try them again without a new reason)",
  "## In progress",
  "(what is half done: files touched, commands and tests run with their results (verified apart from only attempted), runs going, results awaited, and the judgment you were forming)",
  "## Next step",
  "(the exact next action, and the check that tells it worked)",
  "",
].join("\n");
// The headings the new session's restatement needs (written before it acks the probe).
export const UNDERSTOOD_HEADINGS = ["Goal", "Owner's words", "Decisions", "Next step", "Ruled out", "Questions"] as const;
// the headings the new session writes itself; the handover fills the others in before it asks (restatement.ts seedRestatement)
export const LANE_OWN = ["Next step", "Questions"] as const;

// What the new session's restatement left out, measured against what the handover holds: the fix ledger and the lane's
// goal (independent of the summary), and the owner's quoted words and the decisions of the old session's summary.
export type { Missing };

export const missingFrom = (text: string, facts: LaneFacts): Missing[] => {
  if (!text.trim()) return [{ kind: "restatement", text: "the restatement file is missing or empty", under: "", source: "the probe" }];
  const all = flat(text);
  const ruled = flat(section(text, "Ruled out"));
  const goal = facts.lane.goal?.trim() ?? "";
  const out: Missing[] = missingHeadings(text, UNDERSTOOD_HEADINGS).map((h) => ({ kind: "heading", text: `## ${h}`, under: h, source: "the restatement format" }));
  for (const h of new Set(sessionFixes(facts.lane).map((x) => x.hypothesis))) if (!ruled.includes(flat(h))) out.push({ kind: "tried fix", text: h, under: "Ruled out", source: "the fix ledger (dori fix-attempt), kept apart from the summary" });
  if (goal && !quoted(all, goal)) out.push({ kind: "owner goal", text: goal, under: "Goal", source: "the lane's registry entry (the owner's words at launch)" });
  for (const q of quotesIn(section(facts.laneNote, "Owner's words and constraints"))) if (!quoted(all, q) && flat(q) !== flat(goal)) out.push({ kind: "owner's words", text: q, under: "Owner's words", source: "the old session's summary, Owner's words and constraints" });
  for (const d of bulletsIn(facts.laneNote, "Decisions and why")) if (!covered(all, d)) out.push({ kind: "decision", text: d, under: "Decisions", source: "the old session's summary, Decisions and why", byWords: true, whole: wholeBullet(facts.laneNote, "Decisions and why", d) });
  return out;
};

const logOf = (dir: string, session: string): string | undefined => {
  if (!session) return undefined;
  try {
    const name = readdirSync(dir).find((n) => n.endsWith(`_${session}.jsonl`));
    return name ? join(dir, name) : undefined;
  } catch {
    return undefined;
  }
};

// Written once the new session exists and removed when the run ends either way: a run killed in between (crash, reboot,
// SIGKILL) leaves it behind, and the next dori handover --lane for that lane repairs the state from it first.
// fromSession and cwd: the outgoing session and where the new one opens, so a recovery records the lane's sessions too
export type Pending = { readonly key: string; readonly pid: number; readonly at: string; readonly from: string; readonly to: string; readonly note: string; readonly chains?: readonly Job[]; readonly agentPid?: number; readonly fromSession?: string; readonly cwd?: string };

const POLL_MS = 5_000;
const THINKING = /^(.*):(off|minimal|low|medium|high|xhigh|max)$/;
// processes every omo session runs besides the work: MCP servers, the subagent RPC host, the provider's own CLI, and the
// omo-ai plugin's own daemons (its memory run supervisor under plugin/extensions, its LSP daemon under plugin/runtime),
// which refused ZzangDori's herdr-switch move twice on 2026-11-03 as "local chains"
const INFRA = /\bmcp\b|--internal-rpc-host-supervisor|--mode rpc|claude-agent-sdk/;
// a command line's first words, quotes kept together (a quoted Windows path is one word)
const words = (cmd: string, n: number): string[] => {
  const out: string[] = [];
  for (let rest = cmd; out.length < n; ) {
    const w = commandExecutable(rest);
    if (!w) break;
    out.push(w);
    rest = rest.slice(rest.indexOf(w) + w.length + 1);
  }
  return out;
};
// the omo-ai daemon itself: bun or node running a script of the plugin, never a command line that only names that path
const omoDaemon = (cmd: string): boolean => {
  const [exe = "", script = ""] = words(cmd, 2);
  return /^(?:bun|node)(?:\.exe)?$/i.test(exe.split(/[\\/]/).pop() ?? "") && /omo-ai[\\/]plugin[\\/](?:extensions|runtime)[\\/]/.test(script);
};
const infra = (cmd: string): boolean => INFRA.test(cmd) || omoDaemon(cmd);
// another session's processes: an agent, the herdr server (started from a lane, it carries that lane's environment) and
// everything under them
const HERDR_SERVER = /(?:^|[\\/\s])herdr(?:\.exe)?\s+server\b/;
// omo's eval kernel (python3 -u .../senpi-codemode/src/kernels/py/prelude.py): the session's own interpreter, alive once
// the lane used it. Not work itself; what a cell started under it is, and a cell running in it is read from the log.
// either path separator: a native Windows command line names the kernel with backslashes
const KERNEL = /senpi-codemode[\\/]src[\\/]kernels[\\/][\w-]+[\\/]prelude\.\w+/;
const CONTEXT = /\b\d+(?:\.\d+)?[KMG]?\/\d+(?:\.\d+)?[KMG]?\s+\((\d+(?:\.\d+)?)%\)/;

export const splitModel = (model: string): { readonly base: string; readonly thinking?: string } => {
  const m = THINKING.exec(model);
  return m?.[1] && m[2] ? { base: m[1], thinking: m[2] } : { base: model };
};

const modelId = (model: string): string => splitModel(model).base.split("/").pop() ?? model;
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// omo's status line sits below the ❯ input line: "... 90K/1M (9.0%) ... claude-opus-5-5 • effort high" (or "claude-opus-5-5:high").
export const statusLine = (screen: string, model: string): StatusLine => {
  const lines = screen.split("\n");
  const at = lines.findLastIndex((l) => l === inputLine(screen));
  const tail = (at >= 0 ? lines.slice(at + 1) : lines.slice(-6)).join("\n");
  const id = modelId(model);
  const named = new RegExp(`(?:^|[\\s(/])${escape(id)}(?::(\\w+))?(?=\\s|$)`, "m").exec(tail);
  const effort = /\beffort (\w+)/.exec(tail);
  const pct = CONTEXT.exec(tail);
  const thinking = named?.[1] ?? effort?.[1];
  // the subscription account the session runs on: "(provider@account)" or the usage row "Claude·account"
  const account = (/@([\w.-]+)\)/.exec(tail) ?? /Claude·(\S+)/.exec(tail))?.[1];
  return { ...(named ? { model: id } : {}), ...(thinking ? { thinking } : {}), ...(pct?.[1] ? { contextPct: Number(pct[1]) } : {}), ...(account ? { account } : {}) };
};

// The engine's error for a turn it refused because the context stayed over the compaction threshold (senpi
// REQUIRED_COMPACTION_ERROR_MESSAGE); the TUI wraps it over lines, so it is matched with the whitespace collapsed.
export const COMPACTION_ERROR = "Context remains above the compaction threshold because compaction did not complete";

// How often that error stands on a session's screen, when it is the last thing above the input box (only the box's border
// follows it) and came at least twice: a session that answers every message with it can take no turn, and nothing it
// does by itself ends that. 0 for a session that went on working after an error, or met it once.
export const compactionStuckOn = (screen: string): number => {
  const lines = screen.split("\n");
  const at = lines.findLastIndex((l) => l === inputLine(screen));
  const above = (at >= 0 ? lines.slice(0, at) : lines).join(" ").replace(/\s+/g, " ");
  const hits = above.split(COMPACTION_ERROR).length - 1;
  if (hits < 2) return 0;
  return above.slice(above.lastIndexOf(COMPACTION_ERROR) + COMPACTION_ERROR.length).replace(/[\s─-╿]/g, "") ? 0 : hits;
};

// The work the old session's agent runs that dies with it: every child process of the agent except omo's own helpers
// and its monitors (those are re-armed in the new session). exclude: pids that must not count (the caller's own chain).
// The session itself is not a chain: the shells that launched the agent (aoe runs it from /bin/bash /dev/fd/4 under the
// pane's shell) and omo's eval kernel. What runs under them is. A zombie (an ended process its parent has not collected,
// "[bash] <defunct>") is no work either: it refused 5 automatic moves of yoodori-gate-gaps on 2026-10-19.
// When the agent started: native Windows has no ps, and its process table carries the start time (as resolveSession reads it)
export const agentStartOf = async (run: Runner, agent: Proc, platform: string = process.platform): Promise<number> =>
  Date.parse(platform === "win32" ? agent.startedAt ?? "" : (await run(["ps", "-o", "lstart=", "-p", String(agent.pid)])).out.trim());

// A job that left the pane's process tree (its parent ended, or nohup ... &) but not a terminal session of a process still
// in that tree dies with the pane all the same: herdr ends every process of the pane's session when it closes the tab, and
// omo ends its eval kernel's, which runs in a session of its own (measured 2026-11-03 on herdr 0.9.5: sleep & disown,
// nohup sleep & and an orphaned bash -c 'sleep &' of the pane's shell ended, and so did an orphan the py kernel left;
// setsid sleep, and a nohup job of omo's bash tool, whose session leader had already ended, survived). Those jobs count as
// local chains too: 27 of 27 "detached jobs" the notes said would keep running were dead after the close. Only a job in
// another session survives and stays a detached job. The session is known only where the process table has it (Linux).
export const localChains = (table: readonly Proc[], shellPid: number, monitorPids: readonly number[], exclude: ReadonlySet<number> = new Set()): { readonly agent?: Proc; readonly chains: Job[]; readonly tree: Set<number> } => {
  const tree = descendants(table, shellPid);
  const agent = tree.find((p) => AGENT.test(p.cmd) && !ended(p));
  const ids = new Set([shellPid, ...tree.map((p) => p.pid)]);
  if (!agent) return { chains: [], tree: ids };
  const session = new Set([...ancestors(table, agent.pid)].filter((pid) => ids.has(pid)));
  const kernels = new Set(table.filter((p) => p.ppid === agent.pid && KERNEL.test(p.cmd)).map((p) => p.pid));
  const sids = new Set(table.filter((p) => ids.has(p.pid) && (p.sid ?? 0) > 0).map((p) => p.sid));
  const stray = new Set(table.filter((p) => sids.has(p.sid) && !ids.has(p.pid) && p.pid !== process.pid).map((p) => p.pid));
  // the children of the agent, of its kernel and of the shells that launched it (jobs started from the pane die with it too),
  // and the topmost of the jobs that left the tree but not the pane's session
  const roots = table.filter((p) => ((session.has(p.ppid) || kernels.has(p.ppid)) && !session.has(p.pid) && !kernels.has(p.pid)) || (stray.has(p.pid) && !stray.has(p.ppid)))
    .filter((p) => !ended(p) && !infra(p.cmd) && !monitorPids.includes(p.pid) && !exclude.has(p.pid))
    .map((p) => ({ pid: p.pid, cmd: p.cmd, pids: [p.pid, ...descendants(table, p.pid).filter((d) => !ended(d)).map((d) => d.pid)] }));
  return { agent, chains: roots, tree: new Set([...ids, ...stray]) };
};

// Why an automatic rollover leaves a lane to the lead: a tag in handover.trainingTags, or a live monitor watching a training
// or eval chain (handover.trainingWatch on its command, path, filter or description), as e7-beyond-eth's q267_chain_watch.sh
// and, since 10-19, q267_spark_watch.sh with filter Q267_EVAL (a replay on another node: no chain word in the command).
export const trainingMark = (lane: Lane, monitors: readonly MonitorSpec[], h: { readonly trainingTags: readonly string[]; readonly trainingWatch: string }): string | undefined => {
  const tag = lane.tags?.find((t) => h.trainingTags.includes(t));
  if (tag) return `tag ${tag}`;
  if (!h.trainingWatch) return undefined;
  const watch = new RegExp(h.trainingWatch, "i");
  const m = monitors.find((x) => watch.test([x.command, x.path, x.filter, x.description].filter(Boolean).join(" ")));
  return m ? `training chain watched: monitor "${m.description}"` : undefined;
};

// Jobs the lane started that left its pane's process tree (setsid, nohup, systemd-run): their environment still names
// the lane's omo session or aoe session. They survive the old session and are only listed.
export const detachedJobs = (table: readonly Proc[], tree: ReadonlySet<number>, session: string, aoeId: string, envOf: (pid: number) => string): Job[] => {
  const marks = [...(session ? [`PI_SESSION_ID=${session}`] : []), ...(aoeId ? [`/${aoeId}/session_id`] : [])];
  if (!marks.length) return [];
  const foreign = foreignPids(table, tree);
  return table.filter((p) => !tree.has(p.pid) && !foreign.has(p.pid) && p.pid !== process.pid).flatMap((p) => {
    const env = envOf(p.pid);
    return env && marks.some((m) => env.split("\n").some((line) => line === m || line.endsWith(m))) ? [{ pid: p.pid, cmd: p.cmd }] : [];
  });
};

export const foreignPids = (table: readonly Proc[], tree: ReadonlySet<number>): Set<number> => {
  const others = table.filter((p) => !tree.has(p.pid) && (AGENT.test(p.cmd) || HERDR_SERVER.test(p.cmd)));
  return new Set([...others.map((p) => p.pid), ...others.flatMap((p) => descendants(table, p.pid).map((d) => d.pid))]);
};

// Jobs an earlier handover of the lane listed (detached, or chains that outlived their session) that still run: their
// environment names an older session, so detachedJobs alone would lose them from one handover to the next.
const carried = (dir: string, key: string, alive: (pid: number) => boolean, known: ReadonlySet<number>): Job[] => {
  let files: string[] = [];
  try {
    // <key>-<stamp>.json, or <key>-<stamp>-<pid>.json for a run that wrote second in the same second (the newer one)
    const name = new RegExp(`^${escape(key)}-(\\d{8}-\\d{6})(?:-(\\d+))?\\.json$`);
    const order = (n: string): string => {
      const m = name.exec(n);
      return `${m?.[1] ?? ""}-${m?.[2] === undefined ? "0" : "1"}-${(m?.[2] ?? "").padStart(10, "0")}`;
    };
    files = readdirSync(dir).filter((n) => name.test(n)).sort((a, b) => order(a).localeCompare(order(b)));
  } catch {
    return [];
  }
  const last = files.at(-1);
  const prev = last ? readJson<{ readonly detached?: Job[]; readonly chains?: Job[] }>(join(dir, last)) : undefined;
  return [...(prev?.detached ?? []), ...(prev?.chains ?? [])].filter((j) => alive(j.pid) && !known.has(j.pid)).map((j) => ({ pid: j.pid, cmd: j.cmd }));
};

const ancestors = (table: readonly Proc[], pid: number): Set<number> => {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const out = new Set<number>();
  for (let p = byPid.get(pid); p && !out.has(p.pid); p = byPid.get(p.ppid)) out.add(p.pid);
  return out;
};

// what the lane is asked when a rollover finds it busy (an automatic one, or the lead's approved one): reach a safe point,
// write the summary, mark ready, go idle
// the causes quote command lines, and a backtick or $( is never typed into a pane (sendVerified refuses the whole text):
// they are written as ' and $ ( so the ask still reaches the lane (review 320 round 9)
const typeSafe = (text: string): string => text.replace(/`/g, "'").replace(/\$\(/g, "$ (");
export const safePointText = (key: string, cause: string, by: "auto" | "lead"): string =>
  safePointBody(key, typeSafe(cause), by);
const safePointBody = (key: string, why: string, by: "auto" | "lead"): string =>
  `[LEAD] ${by === "auto" ? `An automatic rollover of ${key} to a new session is due` : `The lead moves ${key} to a new session`}, but the lane is busy (${why}). At your next safe point: start no new work, write your conversation summary (dori handover ready --template prints its headings) to a file, run dori handover ready ${key} --note <file>, then end your turn.${/background task\(s\) still run/.test(why) ? " The ready mark does not cover your background tasks: the move waits until they end, so start no new ones and let these finish (or end them yourself if their work is no longer needed)." : ""} The local chains that command lists end with this session: if one must keep running (a training, eval or deploy run), let it finish or move it out of the session (setsid, systemd-run) first, and say so in your report. The move starts by itself once you are idle; nothing else to do.`;

export const readyFile = (stateDir: string, key: string): string => join(stateDir, "handover", "lanes", `${key}.ready.json`);
export const pendingFile = (stateDir: string, key: string): string => join(stateDir, "handover", "lanes", `${key}.pending.json`);
// the waiting request whose safe-point ask freshness typed after the refusing run could not (request: that row's time)
export const safePointFile = (stateDir: string, key: string): string => join(stateDir, "handover", "lanes", `${key}.safe-point.json`);

// The handover a lead (or the owner) approved and that was refused because the lane was busy (a turn ran, or work would
// die): the lane's last handover run, approved by anyone but the automation, refused with blocked work or busy, in the
// lane's pane now. A ready mark the lane writes after it starts that same move again (freshness readyResume); an automatic
// run comes back from freshness's rolloverDue instead, and a run that went ahead or failed later ends the request.
export const waitingRequest = (entries: readonly RolloverEntry[], key: string, pane: string): Extract<RolloverEntry, { kind: "rollover" }> | undefined => {
  // an automatic run's refusal leaves a lead's waiting request waiting: a run started before it logs its refusal after it
  // (review 320 round 13)
  const last = entries.findLast((e): e is Extract<RolloverEntry, { kind: "rollover" }> => e.kind === "rollover" && e.who === "lane" && e.key === key && !(e.result === "refused" && !!e.approvedBy?.trim() && decidedBy(e.approvedBy.trim()) === "auto"));
  const by = last?.approvedBy?.trim() ?? "";
  return last && last.result === "refused" && (last.blocked === "work" || last.blocked === "busy") && last.from === pane && by && decidedBy(by) !== "auto" ? last : undefined;
};

// The safe-point ask of the lane's waiting request that has not reached the lane yet: neither the refusing run nor freshness
// got it through. A later refusal of the same request (a resumed run, which asks nothing itself) carries it on, so freshness
// goes on asking until the pane takes it (review 320 round 9).
const untoldAsk = (stateDir: string, key: string, pane: string): { readonly why: string; readonly told: boolean } | undefined => {
  const prev = waitingRequest(readRollovers(stateDir), key, pane);
  return prev?.safePoint && !prev.safePoint.told && readJson<{ request?: string }>(safePointFile(stateDir, key))?.request !== prev.at ? prev.safePoint : undefined;
};

// The pids of the monitors omo runs for the session in a pane (they are re-armed, not lost).
const monitorPidsOf = async (deps: LaneHandoverDeps, pane: string, cwd: string): Promise<{ readonly session: string; readonly entries: ReturnType<typeof readManifest>; readonly pids: number[] }> => {
  const session = await deps.sessionOf(pane, cwd).catch(() => "");
  const entries = session ? readManifest(manifestPath(deps.config.sessionsDir, cwd, session)) : [];
  return { session, entries, pids: entries.flatMap((e) => (e.runtime?.pid !== undefined ? [e.runtime.pid] : [])) };
};

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};
const readReady = (stateDir: string, key: string): ReadyMark | undefined => readJson<ReadyMark>(readyFile(stateDir, key));
const readPending = (stateDir: string, key: string): Pending | undefined => readJson<Pending>(pendingFile(stateDir, key));

// dori handover ready, run by the lane in its own pane at a safe point: records the local chains it accepts losing (the
// chain running this command is left out) and the lane's own notes for the new session.
export const markReady = async (deps: LaneHandoverDeps, lane: Lane, here: string, self: number, noteFile?: string): Promise<{ readonly code: number; readonly line: string }> => {
  if (!lane.pane || here !== lane.pane) return { code: 2, line: `HANDOVER_READY_REFUSED ${lane.key}: run it inside the lane's own pane ${lane.pane ?? "(none)"}, not ${here || "outside tmux"}` };
  if (!noteFile) return { code: 2, line: `HANDOVER_READY_REFUSED ${lane.key}: write the conversation summary first (dori handover ready --template prints its headings), then dori handover ready ${lane.key} --note FILE` };
  if (!existsSync(noteFile)) return { code: 2, line: `HANDOVER_READY_REFUSED ${lane.key}: note file not found: ${noteFile}` };
  const lacking = missingHeadings(readFileSync(noteFile, "utf8"), SUMMARY_HEADINGS);
  if (lacking.length) return { code: 2, line: `HANDOVER_READY_REFUSED ${lane.key}: the summary ${noteFile} lacks ${lacking.map((h) => `## ${h}`).join(", ")} (dori handover ready --template)` };
  const old = sessionFor(await liveSessions(deps.run), lane.pane);
  const { pids } = await monitorPidsOf(deps, lane.pane, old?.path ?? lane.cwd ?? deps.config.defaultCwd);
  const table = await deps.procs();
  const shell = await tmuxPanePid(deps.run, lane.pane);
  // The chain that runs this command is covered too: a shell that ends right after, or a process the eval kernel started,
  // which may stay alive while the lane idles and would otherwise block the move the lane just declared safe.
  const all = localChains(table, shell, pids).chains;
  const runner = all.filter((c) => ancestors(table, self).has(c.pid));
  const chains = all.filter((c) => !runner.includes(c));
  const mark: ReadyMark = { key: lane.key, pane: lane.pane, at: iso(deps.clock), chains: all.map((c) => c.pid), ...(noteFile ? { note: readFileSync(noteFile, "utf8") } : {}) };
  mkdirSync(join(deps.config.stateDir, "handover", "lanes"), { recursive: true });
  writeFileSync(readyFile(deps.config.stateDir, lane.key), JSON.stringify(mark, null, 1));
  const list = chains.map((c) => `${c.pid} ${c.cmd.slice(0, 80)}`).join("; ");
  const asked = waitingRequest(readRollovers(deps.config.stateDir), lane.key, lane.pane);
  return { code: 0, line: `HANDOVER_READY ${lane.key} pane=${lane.pane} chains=${chains.length}${list ? ` (${list}; these end when the old session closes)` : ""}${runner.length ? ` runner=${runner.map((c) => c.pid).join(",")} (runs this command; covered too)` : ""} note=${noteFile ? "yes" : "no"}; valid ${deps.config.handover.readyMin} min. ${asked ? `The handover the lead asked for at ${asked.at} starts again by itself within a few minutes, once your turn ends. Tell the lead, then end your turn.` : "Tell the lead, then end your turn."}` };
};

const job = (j: Job): string => `- ${j.pid}: \`${j.cmd.slice(0, 200).replace(/`/g, "'")}\``;

export const renderLaneNote = (f: LaneFacts, at: string, stateDir: string): string => [
  `# Lane handover ${f.lane.key} ${at}`,
  "",
  `You are the ${f.lane.key} lane, in a new session. The old one (${f.from.pane}, aoe ${f.from.aoeId}, omo session ${f.from.session || "unknown"}) ran out of room; dori handover --lane points the lane's registry entry at you. The old conversation does not come with you: this note and your brief are all you know.`,
  "",
  "## Do this first",
  "1. Arm every monitor under Monitors again as a persistent monitor, with the same command and filter; one marked LAUNCHES_WORK gets the watch-only monitor its line describes instead, never its own command (its work still runs under the old session or already ended). Take each command, filter and description from its line under Monitors, where they are JSON strings: put them into the tool call as they are (a JSON string is a valid JS string), not retyped and not from the conversation summary, where a copy can differ. Arm each one once, all in one call, and print only how many armed and the ones that failed: each monitor's full reply is context the new session carries to its end.",
  `2. A [LEAD] line with ${PROBE} <id> is a check of this handover: read this whole note and your brief first, then run the dori handover ack command it gives (with its --state) and nothing else for that line. A [LEAD] HANDOVER_SUPPLEMENT <id> line comes from the audit after the commit: it names a file with what you were missing and the old log lines behind it; write those items into the file it names (create it if it is not there) and run the ack command it gives.`,
  `3. Read your brief ${f.lane.brief} in full. It still holds: same Done, same footer, and reports still go to the lead.`,
  `4. Until a [LEAD] ${COMMITTED} line arrives, do nothing else: change no file, start no process besides the monitors of step 1, post nothing. Until then the handover can still roll back and close this session.`,
  `5. After ${COMMITTED}: ${f.goal ? "register the goal under Goal again with your goal tool, same objective, and rebuild the todo list from Todos." : "rebuild the todo list from Todos."} Then continue the work from where Last reports and the lane's notes leave it. A [LEAD] HANDOVER_SUPPLEMENT line that comes later is the audit after the handover: do what it says and go on. When you find later that the old session knew something this note did not carry and it cost you (you had to ask, redo or guess), run dori handover gap ${f.lane.key} --kind "<owner's words|decision|lead instruction|todo|goal|monitor|tried fix|other>" --text "<one line, no secret values>" and tell the lead.`,
  "",
  "## Lane",
  `- Key ${f.lane.key}: ${f.lane.title}. Work thread: ${f.lane.thread}.`,
  `- Brief: ${f.lane.brief}`,
  `- Done: ${f.lane.done}`,
  ...(f.lane.goal ? [`- Owner goal (owner words): "${f.lane.goal}"`] : []),
  `- Model ${f.model}${f.thinking ? `, thinking ${f.thinking}` : ""}; cwd ${f.cwd}${f.cwd === f.from.cwd ? "" : ` (the old session ran from ${f.from.cwd})`}.`,
  ...(f.approvedBy ? [`- Moved with the owner's approval: ${f.approvedBy}`] : []),
  "",
  `## Monitors (${f.monitors.length})`,
  ...(f.monitors.length ? f.monitors.map(monitorLine) : ["none"]),
  "",
  ...(f.goal ? ["## Goal", f.goal, ""] : []),
  "## Todos",
  ...(f.todos.length ? f.todos.map((t) => `- ${t}`) : ["none"]),
  "",
  `## Local chains of the old session (${f.chains.length})`,
  ...(f.chains.length ? ["Do NOT start these again now: they still run under the old session until it closes, and a second copy would run the same work twice (duplicate node jobs, results written over). Once the old session is closed and these pids are gone, a [LEAD] HANDOVER_CHAINS_ENDED line tells you; then restart only what is still needed, from its checkpoint or progress files, skipping steps that already finished.", ...f.chains.map(job)] : ["none"]),
  "",
  ...(f.work?.length
    ? [`## Work the old session's monitors started (${f.work.length})`, "It runs under a monitor of the old session (marked LAUNCHES_WORK under Monitors), so the handover keeps that session frozen instead of closing it, its monitors left running, and closes it once this work ended. Do not start it again; follow it with the watch-only monitors of step 1.", ...f.work.map((j) => `- monitor ${j.pid} "${j.cmd.slice(0, 120)}": ${(j.pids ?? []).join(", ")}`), ""]
    : []),
  `## Detached jobs (${f.detached.length})`,
  ...(f.detached.length ? ["They run in a terminal session of their own, outside the old pane, so closing it does not end them; the handover does not touch them. Check on them, do not start them twice.", ...f.detached.map(job)] : ["none"]),
  "",
  `## Background tasks of the old session (${f.tasks?.length ?? 0})`,
  ...(f.tasks?.length
    ? ["The old session started these with its task tool and they had not ended when this note was written. They are not your children: task_output and task_send do not reach them, their answer goes to the old session, and an in-process task ends when that session closes. Read each one's record (status, terminal_at) and its transcript, at the paths given, for its answer; when it has none and the work is still needed, run it again as your own task.", ...f.tasks.map((t) => `- ${t.id} (started ${t.at.slice(0, 16)}Z)${t.what ? `: ${t.what}` : ""}${t.record ? `; record ${t.record}, transcript ${t.transcript}` : "; no record found under ~/.omo/agent/projects"}`)]
    : ["none"]),
  "",
  "## Last reports",
  `- Last report: ${f.lane.lastReport ?? "none"}`,
  ...(f.lane.direction ? [`- Direction (intent-check ${f.lane.direction.at}): ${f.lane.direction.text}${f.lane.direction.next ? `; next: ${f.lane.direction.next}` : ""}`] : []),
  ...(f.lane.history ?? []).slice(-3).map((h) => `- ${h.at} ${h.status}: ${h.note}`),
  "",
  `## The owner's messages since the last handover (${f.ownerMessages?.length ?? 0})`,
  ...(f.ownerMessages?.length
    ? ["His own messages from the inbox (written by his account, by message id): those in this lane's thread and those the lead relayed into the old conversation by id. Under Owner's words in your restatement, quote each one that still holds.", ...f.ownerMessages.map((m) => `- ${m.at.slice(0, 16)}Z ${m.link ?? `message ${m.id}`}: "${m.text.slice(0, 400).replace(/"/g, '\\"')}"`)]
    : ["none"]),
  "",
  `## The lead's instructions in the old conversation since the last handover (${f.leadWords?.length ?? 0})`,
  ...(f.leadWords?.length
    ? ["The lead's own [LEAD] lines in the old conversation, as they were typed, oldest first (nudges and handover steps left out). Each still holds unless a later line or a report says it was done or replaced; carry the ones that hold under Decisions in your restatement.", ...f.leadWords.map(leadItem)]
    : ["none"]),
  "",
  "## Conversation summary (written by the old session)",
  f.laneNote.trim() || "(none: the old session did not write one with dori handover ready --note FILE; read the old conversation below before you act on a guess)",
  "",
  `## Fix attempts in the old session (${sessionFixes(f.lane).length})`,
  ...(sessionFixes(f.lane).length
    ? ["Already tried; do not try one again without a new reason, and at the 3rd of one same fix change the hypothesis instead.", ...sessionFixes(f.lane).map((x) => `- ${x.at} ${x.metric} / ${x.hypothesis} (${x.via}${x.improved ? ", the one before it moved the metric" : ""})`)]
    : ["none"]),
  "",
  "## The old conversation",
  f.oldLog ? `Its full log is ${f.oldLog} (JSONL; it stays on disk after the old session closes). When this note leaves something out, search it (the owner's words, a file name, an error) before you ask.` : "Its log was not found.",
  "",
  `State dir for acks: ${stateDir}`,
  "",
].join("\n");

const ackedBy = (stateDir: string, id: string): string | undefined => {
  try {
    return (JSON.parse(readFileSync(ackFile(stateDir, id), "utf8")) as { pane?: string }).pane ?? "";
  } catch {
    return undefined;
  }
};

const titleFor = (old: string, stamp: string): string => `${old.replace(/-\d{8}$/, "")}-${stamp.slice(4, 8)}${stamp.slice(9, 13)}`;

// One handover per lane at a time, and no request lost to the lock: a run that finds the lane's lock held by a live run
// writes its request here (approval, --force, options); the run waiting for the lane's idle moment takes it by rename at
// its next look and goes on with it, so a lead's --force moves the lane at once instead of "another handover is running"
// (ZzangDori herdr-switch, 2026-11-03 09:10:45Z). A holder that is moving the lane takes nothing: the request is withdrawn.
// Each request is a file of its own (<key>.takeover-<pid>-<id>.json, published whole by rename), so two runs never write over
// each other and each withdraws only its own.
const takeoverDir = (stateDir: string): string => join(stateDir, "handover", "lanes");
const takeoverPrefix = (key: string): string => `${key}.takeover-`;
type Takeover = { readonly pid: number; readonly at: string; readonly approvedBy?: string; readonly force: boolean };
const TAKE_POLL_MS = 1_000;
const TAKE_TRIES = 15;

const lockHolder = (file: string, alive: (pid: number) => boolean): { readonly pid: number; readonly at: string } | undefined => {
  const held = readJson<{ pid?: number; at?: string }>(file);
  return held?.pid && held.pid !== process.pid && alive(held.pid) ? { pid: held.pid, at: held.at ?? "?" } : undefined;
};

// The taking side. A run waiting for the lane's idle moment steps aside for it: it takes the request, logs nothing and ends,
// and this run goes on with its own approval, --force and options, taking the lock itself, so it moves the lane (or is
// refused) and reports that itself; a holder that ended without taking it (its wait was over) clears the way the same
// way. A holder that takes nothing within 15 s is moving the lane: the request is withdrawn and this run is refused,
// with no rollover row, so the lane's waiting request stays its last one. undefined: go on.
const handOver = async (deps: LaneHandoverDeps, key: string, holder: { readonly pid: number; readonly at: string }, opts: LaneHandoverOptions, at: string, emit: (line: string) => void): Promise<LaneHandoverResult | undefined> => {
  // its own id, not deps.nonce(): the probe ids of the move this run may make next come from that
  const file = join(takeoverDir(deps.config.stateDir), `${takeoverPrefix(key)}${process.pid}-${randomUUID().slice(0, 8)}.json`);
  const mine: Takeover = { pid: process.pid, at, ...(opts.approvedBy?.trim() ? { approvedBy: opts.approvedBy.trim() } : {}), force: Boolean(opts.force) };
  writeFileSync(`${file}.part`, JSON.stringify(mine));
  renameSync(`${file}.part`, file);
  for (let i = 0; i < TAKE_TRIES && deps.alive(holder.pid); i++) await deps.clock.sleep(TAKE_POLL_MS);
  const taken = !existsSync(file);
  rmSync(file, { force: true });
  if (deps.alive(holder.pid)) {
    emit(`HANDOVER_REFUSED ${key}: another handover is running (pid ${holder.pid}, started ${holder.at}) and is moving the lane now: it took no new request`);
    return { code: 2 };
  }
  emit(`HANDOVER_TAKEN_OVER ${key}: ${taken ? `the run of pid ${holder.pid} that waited for the lane's idle moment (since ${holder.at}) stepped aside` : `the run of pid ${holder.pid} ended`}; this run moves the lane${opts.force ? " with --force" : ""}`);
  return undefined;
};

// the waiting side: a request another run left for this lane, taken by rename so only one run takes it; one whose writer
// is gone is dropped and the next looked at; the others stay for their writers
const claimTakeover = (deps: LaneHandoverDeps, key: string): Takeover | undefined => {
  const dir = takeoverDir(deps.config.stateDir);
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(takeoverPrefix(key)) && n.endsWith(".json"));
  } catch {
    return undefined;
  }
  const queued = names.map((n) => ({ n, t: readJson<Takeover>(join(dir, n)) })).filter((x) => x.t).sort((x, y) => (x.t?.at ?? "").localeCompare(y.t?.at ?? "") || x.n.localeCompare(y.n));
  for (const { n } of queued) {
    const mine = join(dir, `${n}.claimed-${process.pid}`);
    try {
      renameSync(join(dir, n), mine);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    const t = readJson<Takeover>(mine);
    rmSync(mine, { force: true });
    if (t && deps.alive(t.pid)) return t;
  }
  return undefined;
};

const attempt = async (deps: LaneHandoverDeps, key: string, here: string, opts: LaneHandoverOptions, granted: boolean): Promise<LaneHandoverResult> => {
  const { config } = deps;
  const at = iso(deps.clock);
  const stamp = at.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const dir = join(config.stateDir, "handover", "lanes");
  const emit = (line: string): void => {
    deps.print(line);
    if (!opts.dryRun) watchLog(config.watchLog, deps.clock, { source: "handover", line });
  };
  let fromPane = "";
  // an auto: approval without the grant of a run freshness started is borrowed: refused first, and never logged, since a
  // row approved auto: is read by freshness as its own run's result (lastAuto) and ends a lead's waiting request
  const borrowed = decidedBy(opts.approvedBy?.trim() ?? "") === "auto" && !granted;
  // I1 for the rollover log too: a refusal row (the lane's waiting request, read under the lock by a run started again for
  // it) is written only by a run that holds the lane's lock. A run freshness started holds it for its whole wait; any other
  // takes it for the write. One that finds it held by a live run writes nothing and goes the takeover way, so the holder
  // steps aside for this request or is mid-move and keeps the lane (review 320 round 15)
  let holding = Boolean(opts.idle);
  const rowLock = join(dir, `${key}.lock`);
  const forRow = async (): Promise<{ readonly release: () => void; readonly log: boolean } | { readonly via: LaneHandoverResult }> => {
    if (holding || borrowed || opts.dryRun || !opts.approvedBy?.trim()) return { release: () => {}, log: true };
    mkdirSync(dir, { recursive: true });
    const locked = takeLock(rowLock, deps.alive, at);
    if (!locked) {
      holding = true;
      return { release: () => { holding = false; rmSync(rowLock, { force: true }); }, log: true };
    }
    const holder = lockHolder(rowLock, deps.alive);
    if (!holder) {
      emit(`HANDOVER_NOT_LOGGED ${key}: ${locked}; the refusal below is not logged, so the lane's waiting request stays as it was`);
      return { release: () => {}, log: false };
    }
    const stop = await handOver(deps, key, holder, opts, at, emit);
    return { via: stop ?? (await attempt(deps, key, here, { ...opts, ...(opts.boundPane ?? fromPane ? { boundPane: opts.boundPane ?? fromPane } : {}) }, granted)) };
  };
  // a resumed run's request, read under the lane's lock: no longer the lane's waiting one in that pane, it moves nothing
  const requestGone = (pane: string): LaneHandoverResult | undefined => {
    if (!opts.serves) return undefined;
    const waiting = waitingRequest(readRollovers(config.stateDir), key, pane);
    if (pane === opts.serves.pane && waiting?.at === opts.serves.at) return undefined;
    emit(`HANDOVER_REQUEST_GONE ${key}: the request of ${opts.serves.at} in ${opts.serves.pane} is no longer the lane's waiting one (the lane is in ${pane}${waiting ? `, waiting request ${waiting.at}` : ", no request waits"}); nothing is moved`);
    return { code: pane !== opts.serves.pane ? 0 : 2, ...(pane !== opts.serves.pane ? { to: pane } : {}) };
  };
  const refuse = async (why: string, held?: { readonly blocked: Blocked; readonly pids?: readonly number[]; readonly tasks?: readonly string[]; readonly safePoint?: { readonly why: string; readonly told: boolean } }): Promise<LaneHandoverResult> => {
    const gate = await forRow();
    if ("via" in gate) return gate.via;
    try {
      return refused(why, held, gate.log);
    } finally {
      gate.release();
    }
  };
  const refused = (why: string, held: { readonly blocked: Blocked; readonly pids?: readonly number[]; readonly tasks?: readonly string[]; readonly safePoint?: { readonly why: string; readonly told: boolean } } | undefined, log: boolean): LaneHandoverResult => {
    emit(`HANDOVER_REFUSED ${key}: ${why}`);
    if (borrowed) return { code: 2 };
    // a run refused while the lane was busy keeps the options it was given (the note as an absolute path): a ready mark
    // starts it again with them (freshness readyResume)
    const safePoint = held?.safePoint ?? (held && fromPane && opts.approvedBy?.trim() && decidedBy(opts.approvedBy.trim()) !== "auto" ? untoldAsk(config.stateDir, key, fromPane) : undefined);
    const request: RolloverRequest = { ...(opts.note ? { note: resolve(opts.note) } : {}), ...(opts.model ? { model: opts.model } : {}), ...(opts.thinking ? { thinking: opts.thinking } : {}), ...(opts.keepOld ? { keepOld: true } : {}), ...(opts.verifyMin ? { verifyMin: opts.verifyMin } : {}) };
    if (log && !opts.dryRun && opts.approvedBy?.trim()) appendRollover(config.stateDir, { kind: "rollover", who: "lane", at, key, from: fromPane, approvedBy: opts.approvedBy.trim(), signals: {}, steps: [], result: "refused", reasons: [why], ...(held ? { blocked: held.blocked, ...(held.pids?.length ? { pids: held.pids } : {}), ...(held.tasks?.length ? { tasks: held.tasks } : {}), request, ...(safePoint ? { safePoint } : {}) } : {}), ...(opts.serves ? { resumes: opts.serves.at } : {}) });
    return { code: 2 };
  };
  if (borrowed) return refuse(`a lane moves to a new session only with an approval: ${approvalProblem(opts.approvedBy, () => undefined, { on: config.handover.autoRolloverLanes, key: "handover.autoRolloverLanes", granted }, key, "", [])} (--dry-run needs none)`);
  if (!omoSession(config)) return refuse("dori handover --lane needs omo as the agent (backend aoe, or herdr with agentCommand omo)");
  // a herdr handover opens a new conversation; an agentCommand that picks its session itself (--continue, --session ...) would reopen the old one
  if (config.backend === "herdr" && hasSessionSelector(config.agentCommand.slice(1))) return refuse(`dori handover --lane on herdr needs an agentCommand without a session selector (it opens a new session): ${config.agentCommand.join(" ")}`);
  const lane = await deps.registry.read(key);
  if (!lane) return refuse("no such lane");
  if (statusOf(lane) === "closed") return refuse("the lane is closed");
  if (!lane.pane) return refuse("the lane has no pane");
  fromPane = lane.pane;
  // a run freshness started again for a request the lead has since replaced (or a move finished) leaves here, before any
  // refusal of its own: a row it logged would hide the newer waiting request (review 320 round 16). It holds the lane's
  // lock; a move's journal names the pane the request was for, so a dead move is still repaired by this run
  if (opts.idle && opts.serves) {
    const gone = requestGone(readPending(config.stateDir, key)?.from ?? lane.pane);
    if (gone) return gone;
  }
  if (here === lane.pane) return refuse(`run it from the lead, not from the lane's own pane; the lane marks a safe point with dori handover ready ${key} and tells the lead`);
  if (opts.note && !existsSync(opts.note)) return refuse(`note file not found: ${opts.note}`);
  const pending = readPending(config.stateDir, key);
  if (pending) {
    // a run waiting on a move in flight asks for the move's source, not the pane the lane points at now: a repair that rolls
    // back puts the lane there again and this request runs; a move that finished leaves it elsewhere (review 320 round 13)
    if (pending.pid !== process.pid && deps.alive(pending.pid)) {
      if (opts.dryRun || opts.idle) return refuse(`another handover of ${key} is running (pid ${pending.pid}, started ${pending.at})`);
      // a run mid-move: this one goes the takeover way, which logs no rollover row, so the lane's waiting request stays its
      // last and outlives that run dying before it repointed (review 320 round 8)
      const stop = await handOver(deps, key, { pid: pending.pid, at: pending.at }, opts, at, emit);
      if (stop) return stop;
      return attempt(deps, key, here, { ...opts, boundPane: opts.boundPane ?? pending.from }, granted);
    }
    if (opts.dryRun) return refuse(`an interrupted handover (${pending.from} -> ${pending.to}, ${pending.at}) left ${pendingFile(config.stateDir, key)}; run without --dry-run to repair it first`);
    // the repair writes the registry and removes the journal, so it holds the lane's lock like any writer (I1): a run that
    // finds the lock held waits for its holder the takeover way, and the journal is read again under the lock, so a repair
    // done meanwhile (or a newer move's journal) is never repaired or removed twice (review 320 round 12). A run freshness
    // started (idle) already holds the lock.
    const lockFile = join(dir, `${key}.lock`);
    if (!opts.idle) {
      mkdirSync(dir, { recursive: true });
      const locked = takeLock(lockFile, deps.alive, at);
      if (locked) {
        const holder = lockHolder(lockFile, deps.alive);
        if (!holder) return refuse(locked);
        const stop = await handOver(deps, key, holder, opts, at, emit);
        if (stop) return stop;
        return attempt(deps, key, here, { ...opts, boundPane: opts.boundPane ?? pending.from }, granted);
      }
    }
    let repaired = false;
    try {
      const again = readPending(config.stateDir, key);
      if (again && again.pid === pending.pid && again.at === pending.at) {
        emit(`HANDOVER_INTERRUPTED ${key}: the run from ${pending.at} (pid ${pending.pid}) ended between opening ${pending.to} and finishing; repairing`);
        await recover(deps, again, emit);
        repaired = true;
      }
    } finally {
      if (!opts.idle) rmSync(lockFile, { force: true });
    }
    if (!repaired) return attempt(deps, key, here, { ...opts, boundPane: opts.boundPane ?? pending.from }, granted);
    return { code: 3 };
  }
  // a run that waited for a holder asked for the session it found then: once an interrupted move is repaired (above), a
  // lane in another pane was moved by the holder or a run beside this one, and is not moved again
  if (opts.boundPane && lane.pane !== opts.boundPane) {
    // the move that won applied its own options: a request that asked to keep the old session (or to close it) and got the
    // other is a conflict, not a success (plan challenge 14:48Z)
    const won = readRollovers(config.stateDir).flatMap((r) => (r.kind === "rollover" && r.key === key && r.result.startsWith("done") ? [r] : [])).at(-1);
    const keptOld = won?.result === "done-kept-old";
    if (won && keptOld !== !!opts.keepOld) {
      emit(`HANDOVER_CONFLICT ${key}: the lane moved from ${opts.boundPane} to ${lane.pane} while this run waited, by a run that ${keptOld ? "kept" : "closed"} the old session; this request asked to ${opts.keepOld ? "keep" : "close"} it and is not moved again`);
      return { code: 2, to: lane.pane };
    }
    emit(`HANDOVER_ALREADY_MOVED ${key}: the lane moved from ${opts.boundPane} to ${lane.pane} while this run waited; it is not moved again`);
    return { code: 0, to: lane.pane };
  }
  // a run freshness started holds the lane's lock here (I1), and only under it is the waiting request read for good: a resumed
  // run moves only for the request it was started for, while the lane is still in that request's pane; it leaves no row, so
  // the waiting request stays the last (review 320 round 14)
  if (opts.idle) {
    const gone = opts.serves ? requestGone(lane.pane) : undefined;
    if (gone) return gone;
    // an automatic run gives way to a lead's waiting request; every refusal row is written under this lock, so none is
    // published beside it (review 320 rounds 14-16)
    const waiting = waitingRequest(readRollovers(config.stateDir), key, lane.pane);
    if (!opts.serves && waiting && decidedBy(opts.approvedBy?.trim() ?? "") === "auto") {
      emit(`HANDOVER_YIELDED ${key}: the lead's request of ${waiting.at} waits for this lane; the automatic run leaves the move to it`);
      return { code: 2 };
    }
  }
  // a dry run needs no approval, but a given one is checked the same way, so it can be tried before the real run
  const unapproved = opts.dryRun && !opts.approvedBy?.trim() ? undefined : approvalProblem(opts.approvedBy, (id) => new QuestionStore(deps.cardDir).get(id), { on: config.handover.autoRolloverLanes, key: "handover.autoRolloverLanes", granted }, key, lane.pane ?? "", readRollovers(config.stateDir), Boolean(deps.reportOwner), inboxMessages(deps.inbox ?? "", deps.ownerIds ?? []));
  if (unapproved) return refuse(`a lane moves to a new session only with an approval: ${unapproved} (--dry-run needs none)`);
  if (opts.dryRun && opts.approvedBy?.trim()) emit(`HANDOVER_APPROVAL_OK ${JSON.stringify(opts.approvedBy.trim())}`);
  const lockFile = join(dir, `${key}.lock`);
  // a run that finds another holding the lane hands it this request instead of a second move or a refusal: a run waiting
  // for the lane's idle moment takes it (and a --force with it) at its next look
  const holder = opts.dryRun || opts.idle ? undefined : lockHolder(lockFile, deps.alive);
  if (holder) {
    const stop = await handOver(deps, key, holder, opts, at, emit);
    if (stop) return stop;
    // the holder is gone. The request is for the session this run found in the lane's pane: one that moved meanwhile (another
    // run that waited beside this one moved it) is not moved again (plan challenge, review 320). Else start over, so an
    // interrupted move the holder left (its pending journal) is repaired first and the registry is read again.
    return attempt(deps, key, here, { ...opts, boundPane: opts.boundPane ?? lane.pane }, granted);
  }
  const old = sessionFor(await liveSessions(deps.run), lane.pane);
  if (!old) return refuse(`no live session for pane ${lane.pane}`);
  const real = deps.realpath(old.path);
  // omo may keep the session under the path aoe shows or under the real one (a symlinked cwd): use whichever names the session
  let base = old.path;
  let found = await monitorPidsOf(deps, lane.pane, base);
  if (!found.session && real !== old.path) {
    const byReal = await monitorPidsOf(deps, lane.pane, real);
    if (byReal.session) [base, found] = [real, byReal];
  }
  const { session, entries, pids: monitorPids } = found;
  if (!session) emit(`HANDOVER_SESSION_UNSEEN ${key}: the omo session of ${lane.pane} was not found under ${old.path}${real !== old.path ? ` or ${real}` : ""}; the note has no monitors, todos, goal or old log`);
  const now = deps.clock.now();
  const monitors = liveMonitors(entries, now, deps.alive, deps.home);
  // the owner's rule: an automatic start never moves a lane that runs or watches a training or eval chain; the lead does.
  // It stops the automatic starts in this pane at once (no retries, no gave-up line later).
  const training = decidedBy(opts.approvedBy?.trim() ?? "") === "auto" ? trainingMark(lane, monitors, config.handover) : undefined;
  if (training) {
    if (lane.rolloverDue?.pane === lane.pane) await deps.registry.patch(key, { rolloverDue: { ...lane.rolloverDue, leftToLead: training } });
    return refuse(`an automatic rollover does not move a lane that runs or watches a training or eval chain (${training}); no more automatic starts in ${lane.pane}. The lead moves it by hand: dori handover --lane ${key} --approved-by "lead:<reason and signal>"`, { blocked: "training" });
  }
  const table = await deps.procs();
  const shell = await tmuxPanePid(deps.run, lane.pane);
  const { agent, chains, tree } = localChains(table, shell, monitorPids);
  if (!agent) return refuse(`no omo agent process under pane ${lane.pane} (shell pid ${shell || "?"})`);
  const jobs = monitorWork(entries, table, now, deps.alive, deps.home);
  const marked = detachedJobs(table, tree, session, old.id, deps.envOf);
  // a pid in the pane's own tree is no detached job, even when an earlier note listed it (as a chain, before the session's
  // own launcher shell and eval kernel stopped counting as chains)
  // nor is another session's process an earlier note took for one (a herdr server the lane started, its panes' agents)
  const detached = [...marked, ...carried(dir, key, deps.alive, new Set([...marked.map((d) => d.pid), ...chains.flatMap((c) => c.pids ?? [c.pid]), ...monitorPids, ...tree, ...foreignPids(table, tree)]))];
  const model = opts.model || lane.model || config.defaultModel;
  const screen = await captureTmux(deps.run, lane.pane);
  const shown = statusLine(screen, model);
  // the level the lane runs at now (its status line), else the one it was launched with
  const thinking = opts.thinking || shown.thinking || splitModel(model).thinking;
  if (!shown.model) emit(`HANDOVER_MODEL_UNSEEN ${key}: the status line of ${lane.pane} does not name ${modelId(model)}; the new session gets ${model} anyway`);
  const mark = readReady(config.stateDir, key);
  const ready = mark && mark.pane === lane.pane && now - Date.parse(mark.at) <= config.handover.readyMin * 60_000 ? mark : undefined;
  if (mark && !ready) emit(`HANDOVER_READY_STALE ${key}: the ready mark from ${mark.at} (pane ${mark.pane}) is older than ${config.handover.readyMin} min or from another pane; ignored`);
  const uncovered = chains.filter((c) => !ready?.chains.includes(c.pid));
  const sessionDir = sessionDirFor(config.sessionsDir, base);
  // a detached eval cell computing in the kernel (or in the agent, for js) has no process of its own: its start without an
  // end in the session log, since this agent started; a ready mark covers the cells started before it
  const oldLog = logOf(sessionDir, session);
  const agentStart = await agentStartOf(deps.run, agent);
  const logText = oldLog ? readFileSync(oldLog, "utf8") : "";
  const background = logText ? pendingBackground(logText, Number.isNaN(agentStart) ? 0 : agentStart) : [];
  const cells = background.filter((j) => j.kind === "eval" && !(ready && j.at <= Date.parse(ready.at)));
  // a background task's answer goes to the session that started it (GongDori's e7-leap st_01a16c13 answered into the closed
  // session on 2026-10-24), and a task in its own process keeps working after the move: GongDori's e7-ledger-replay moved
  // on 2026-10-27 05:37Z because its ready mark covered two tasks started before it, and those and a third that had
  // woken itself after its completion line went on editing the repository until 06:51Z, out of reach of the new session.
  // So no ready mark covers a task: one still running holds the move until it ends (or --force). Whether it runs is
  // senpi's record of it (pending, running, paused); a task the transcript shows started and not ended, without a record,
  // runs too.
  const records = session ? taskRecords(deps.home, session) : [];
  const known = new Set(records.map((r) => r.id));
  const startedAt = new Map(background.map((j) => [j.id, j.at]));
  const tasks = [
    ...records.filter(taskOpen).map((r) => ({ id: r.id, at: Date.parse(r.at ?? "") || startedAt.get(r.id) || 0, ...(r.what ? { what: r.what } : {}) })),
    ...background.filter((j) => j.kind === "task" && !known.has(j.id)).filter((j) => {
      const r = taskRecord(deps.home, j.id);
      return !r || taskOpen(r);
    }),
  ];
  const work = [
    ...(uncovered.length ? [`${uncovered.length} local chain(s) would die: ${uncovered.map((c) => `${c.pid} ${c.cmd.slice(0, 80)}`).join("; ")}`] : []),
    ...(cells.length ? [`${cells.length} eval cell(s) still run in the background: ${cells.map((c) => c.id).join(", ")}`] : []),
    ...(tasks.length ? [`${tasks.length} background task(s) still run, and their answers go to the old session: ${tasks.map((c) => c.id).join(", ")}`] : []),
  ];
  const busy = [
    // a ready mark covers chains only: a turn that started after it (a nudge, a message) still blocks
    ...(turnRunning(screen) ? ["a turn is running (esc to interrupt on screen)"] : []),
    ...(QUESTION_MARK.test(screen) ? ["a question is open in the pane"] : []),
  ];
  const blockers = [...work, ...busy];
  const blocked = blockers.length > 0 && !opts.force;
  // an automatic start that waits for the idle moment tries again once the turn ends; work that would die refuses at once
  if (blocked && !opts.dryRun && opts.idle && !opts.idle.final && !work.length) return { code: 2, retry: true };
  const blockedWhy = `${opts.idle && !work.length ? `the lane stayed busy for ${opts.idle.waitedMin} min: ` : ""}${blockers.join("; ")}. Ask the lane to reach a safe point and write its conversation summary and run dori handover ready ${key} --note FILE in its own pane, or pass --force${opts.approvedBy?.trim() && decidedBy(opts.approvedBy.trim()) !== "auto" ? ` (once it marks ready within ${config.handover.readyMin} min, freshness starts this handover again by itself with the same approval)` : ""}`;
  // a dry run still writes the note, so a rollover proposal can show it with what blocks the move
  if (blocked && !opts.dryRun) {
    // the lead's (or the owner's) request waits instead of ending here: the lane is asked for its safe point now, as the lead
    // used to type by hand, and freshness starts the request again (freshness readyResume); a waiting run asks nothing again.
    // Whether the pane took the ask is kept on the request: freshness asks again until it does (review 320 round 8)
    const waits = !opts.idle && !!opts.approvedBy?.trim() && decidedBy(opts.approvedBy.trim()) !== "auto";
    const asked = blockers.join("; ");
    // the lock for the row is taken before the ask, so a run that goes the takeover way instead asks the lane nothing
    const gate = await forRow();
    if ("via" in gate) return gate.via;
    let r: LaneHandoverResult;
    let told = false;
    try {
      told = waits ? await tell(deps, lane.pane, safePointText(key, asked, "lead")) : false;
      r = refused(blockedWhy, { blocked: work.length ? "work" : "busy", pids: uncovered.flatMap((c) => c.pids ?? [c.pid]), tasks: tasks.map((t) => t.id), ...(waits ? { safePoint: { why: asked, told } } : {}) }, gate.log);
    } finally {
      gate.release();
    }
    if (waits && gate.log) {
      emit(`HANDOVER_PENDING ${key}: the move waits and ${work.length ? "starts by itself once the lane marks ready or the work it named ended" : "starts by itself the moment the lane is idle"} (freshness, same approval and options; a run of yours with --force takes it over and moves it now); ${told ? "the lane was asked for its safe point" : `the request for a safe point did not reach ${lane.pane}`}`);
    }
    return r;
  }
  if (blocked) emit(`HANDOVER_REFUSED ${key}: ${blockedWhy}`);
  else if (blockers.length) emit(`HANDOVER_FORCED ${key}: ${blockers.join("; ")}`);
  if (real !== old.path) emit(`HANDOVER_CWD_SYMLINK ${key}: the lane runs from ${old.path}, a symlink to ${real}; the new session opens in ${real}`);
  const stuck = stuckTop(lane);
  const blockedTurns = compactionStuckOn(screen);
  const signals: Signals = { ...(shown.contextPct !== undefined ? { contextPct: shown.contextPct } : {}), ...sessionSignals(sessionDir, session, now), ...(stuck ? { stuck } : {}), ...(blockedTurns ? { compactionStuck: blockedTurns } : {}) };
  const laneNote = [ready?.note ?? "", opts.note ? readFileSync(opts.note, "utf8") : ""].filter((t) => t.trim()).join("\n\n");
  const since = lane.history?.findLast((h) => h.note.startsWith("pane moved "))?.at ?? lane.openedAt;
  const leadWords = leadLines(userLines(oldLog), Date.parse(since) || 0);
  const facts: LaneFacts = {
    lane, from: { pane: lane.pane, aoeId: old.id, session, title: old.title, cwd: old.path }, cwd: real, model: splitModel(model).base, thinking, ...(shown.contextPct !== undefined ? { contextPct: shown.contextPct } : {}), ...(shown.account ? { account: shown.account } : {}),
    monitors, todos: session ? openTodos(sessionDir, session) : [], goal: session ? openGoal(sessionDir, session) : undefined, chains, detached, ...(jobs.length ? { work: jobs } : {}), ...(ready ? { ready } : {}), laneNote, signals, ...(opts.approvedBy?.trim() ? { approvedBy: opts.approvedBy.trim() } : {}),
    agentPid: agent.pid, ...(logOf(sessionDir, session) ? { oldLog: logOf(sessionDir, session) } : {}),
    ownerMessages: ownerMessagesFor({ inbox: deps.inbox ?? "", ownerIds: deps.ownerIds ?? [], oldLog: logOf(sessionDir, session), thread: lane.thread.startsWith("discord:") ? lane.thread.slice("discord:".length) : undefined, since, guild: process.env.DORI_DISCORD_GUILD?.trim() }),
    ...(leadWords.length ? { leadWords } : {}),
    ...(tasks.length ? { tasks: taskRuns(logText, tasks, deps.home) } : {}),
  };
  // the lock is taken before the first shared write (the note the new session reads): a run beside this one that locked
  // first after the same checks leaves this one nothing to write, and it goes the takeover way instead; once locked, a lane
  // moved meanwhile or a move left half done is looked at again from the start (review 320 round 8)
  mkdirSync(dir, { recursive: true });
  const lockedHere = !opts.dryRun && !opts.idle;
  if (lockedHere) {
    const locked = takeLock(lockFile, deps.alive, at);
    if (locked) return lockHolder(lockFile, deps.alive) ? attempt(deps, key, here, { ...opts, boundPane: opts.boundPane ?? lane.pane }, granted) : refuse(locked);
    const after = await deps.registry.read(key);
    if (after?.pane !== lane.pane || readPending(config.stateDir, key)) {
      rmSync(lockFile, { force: true });
      return attempt(deps, key, here, { ...opts, boundPane: opts.boundPane ?? lane.pane }, granted);
    }
  }
  try {
    // one note per run, even for two runs started in the same second
    const id = existsSync(join(dir, `${key}-${stamp}.md`)) ? `${stamp}-${process.pid}` : stamp;
    const note = join(dir, `${key}-${id}.md`);
    writeFileSync(note, renderLaneNote(facts, at, config.stateDir));
    writeFileSync(join(dir, `${key}-${id}.json`), JSON.stringify(facts, null, 1));
    emit(`HANDOVER_NOTE ${note}: ${monitors.length} monitors, ${facts.todos.length} todos, goal ${facts.goal ? "yes" : "no"}, ${chains.length} local chains, ${detached.length} detached jobs, ${tasks.length} background tasks, ${leadWords.length} lead instructions, context ${shown.contextPct ?? "?"}%, compactions ${signals.compactions ?? "?"}, age ${signals.ageH ?? "?"} h, ready ${ready ? ready.at : "no"}`);
    if (jobs.length) emit(`HANDOVER_MONITOR_WORK ${key} ${jobs.length}: ${jobs.map((j) => `monitor ${j.pid} "${j.cmd.slice(0, 60)}" runs ${(j.pids ?? []).join(",")}`).join("; ")}; the old session is frozen, not closed, until it ends`);
    const title = titleFor(old.title, stamp);
    if (opts.dryRun) {
      if (blocked) return { code: 2, note };
      deps.print(`HANDOVER_DRY_RUN ${key} would open ${config.backend} session "${title}" in ${real} (--model ${facts.model}${thinking ? ` --thinking ${thinking}` : ""}), point the lane at it, check the status line, ${monitors.length} monitors (${monitors.map((m) => m.description || m.command || m.path).join(", ") || "none"}) and a probe within ${opts.verifyMin ?? config.handover.verifyMin} min, then ${opts.keepOld ? "keep" : "close"} ${lane.pane}; detached jobs left alone: ${detached.map((d) => d.pid).join(",") || "none"}`);
      return { code: 0, note };
    }
    // an automatic start moves the lane at its idle moment: the old agent is frozen now, before the new session opens, so
    // no goal continuation, nudge or message starts a turn whose work the note would not carry; a turn that slipped in
    // between the check and the freeze thaws it again and the waiting loop goes on
    let frozen = false;
    if (opts.idle) {
      frozen = deps.signal(agent.pid, "SIGSTOP");
      emit(frozen ? `HANDOVER_FROZEN ${key} agent ${agent.pid} in ${lane.pane} at its idle moment (${Math.round((deps.clock.now() - opts.idle.since) / 1000)} s after the automatic start)` : `HANDOVER_FREEZE_FAIL ${key} agent ${agent.pid}: it stays told and quiet only`);
      const after = await captureTmux(deps.run, lane.pane);
      if (turnRunning(after) || QUESTION_MARK.test(after)) {
        if (frozen) emit(deps.signal(agent.pid, "SIGCONT") ? `HANDOVER_THAWED ${key} agent ${agent.pid}: a turn started as it was frozen` : `HANDOVER_THAW_FAIL ${key} agent ${agent.pid}`);
        if (!opts.idle.final) return { code: 2, retry: true };
        return refuse(`the lane stayed busy for ${opts.idle.waitedMin} min: a turn started as it was frozen`, { blocked: "busy" });
      }
    }
    const steps: Step[] = [];
    let last = deps.clock.now();
    const mark = (step: string, ok: boolean) => {
      const t = deps.clock.now();
      steps.push({ step, ms: t - last, ok });
      last = t;
    };
    const accounts: { to?: string } = {};
    const supplements: Supplement[] = [];
    const sizes: Mutable<Sizes> = {};
    const r = await moveLane(deps, opts, facts, { note, at, title, emit, steps, mark, accounts, supplements, frozen, sizes });
    const proposal = lastProposal(readRollovers(config.stateDir), key);
    const result = r.code === 0 ? (opts.keepOld ? "done-kept-old" : "done") : r.code === 1 ? "done-close-failed" : "rolled-back";
    const by = facts.approvedBy ? decidedBy(facts.approvedBy) : undefined;
    const reason = by === "lead" ? (facts.approvedBy ?? "").slice(LEAD_PREFIX.length).trim() : by === "auto" ? autoReason("lane", facts.signals, config.handover) : undefined;
    const ownerText = ownerRolloverText({ who: "lane", title: lane.title || key, cause: rolloverCause(facts.approvedBy ?? "", facts.signals, limitsFor("lane", config.handover)), sizes }, config.discord.locale);
    const ownerReport = (by === "lead" || by === "auto") && r.to && r.code !== 3 ? await reportToOwner(deps, key, lane.thread.startsWith("discord:") ? lane.thread.slice("discord:".length) : null, ownerText, emit) : undefined;
    appendRollover(config.stateDir, {
      kind: "rollover", who: "lane", at, key, from: lane.pane, ...(r.to ? { to: r.to } : {}), ...(facts.approvedBy ? { approvedBy: facts.approvedBy } : {}),
      ...(by ? { decidedBy: by } : {}), ...(reason ? { reason } : {}), ...(ownerReport ? { ownerReport } : {}),
      ...(proposal ? { proposedAt: proposal.at, approvalMin: Math.round((Date.parse(at) - Date.parse(proposal.at)) / 6_000) / 10 } : {}),
      signals: facts.signals, steps, result, reasons: steps.filter((st) => !st.ok).map((st) => st.step), accounts: { from: facts.account ?? "", to: accounts.to ?? "" },
      ...(supplements.length ? { supplementRounds: supplements.length, supplements } : {}),
      ...(Object.keys(sizes).length ? { sizes } : {}),
    });
    return r;
  } finally {
    // the waiting loop of an automatic start holds the lock itself
    if (lockedHere) rmSync(lockFile, { force: true });
  }
};

const IDLE_POLL_MS = 3_000;

// dori handover --lane. An automatic start (--wait-idle, from freshness) moves the lane at its idle moment: it holds the
// lane's lock while it waits, so freshness starts no second run, and tries at once; while only a running turn or an open
// question holds the lane it watches the screen every few seconds and tries again the moment the turn ends, for up to
// waitIdleMin minutes. Then a lane still busy is refused (blocked busy, and freshness asks it to reach a safe point).
// Work that would die (a local chain, a background eval cell) or go on unreachable (a background task) refuses at once
// (blocked work).
export const laneHandover = async (input: LaneHandoverDeps, key: string, here: string, opts: LaneHandoverOptions = {}): Promise<LaneHandoverResult> => {
  const deps = { ...input, signal: freezeSignal(input.signal) };
  // the grant is taken once, before any wait: every attempt of this run is the run freshness started
  const granted = decidedBy(opts.approvedBy?.trim() ?? "") === "auto" && takeAutoGrant(deps.config.stateDir, "lane", key, opts.autoGrant, deps.clock.now());
  // a borrowed auto: is refused by attempt before anything else, also when another run holds the lock
  if (!opts.waitIdleMin || opts.dryRun || (decidedBy(opts.approvedBy?.trim() ?? "") === "auto" && !granted)) return attempt(deps, key, here, opts, granted);
  const emit = (line: string): void => {
    deps.print(line);
    watchLog(deps.config.watchLog, deps.clock, { source: "handover", line });
  };
  const dir = join(deps.config.stateDir, "handover", "lanes");
  mkdirSync(dir, { recursive: true });
  const lockFile = join(dir, `${key}.lock`);
  const held = takeLock(lockFile, deps.alive, iso(deps.clock));
  if (held) {
    emit(`HANDOVER_REFUSED ${key}: ${held}`);
    return { code: 2 };
  }
  try {
    const since = deps.clock.now();
    const until = since + opts.waitIdleMin * 60_000;
    for (let waiting = false; ; waiting = true) {
      const r = await attempt(deps, key, here, { ...opts, idle: { final: deps.clock.now() >= until, since, waitedMin: opts.waitIdleMin } }, granted);
      if (!r.retry) return r;
      if (!waiting) emit(`HANDOVER_WAIT_IDLE ${key}: a turn is running or a question is open; the move starts the moment the lane is idle (up to ${opts.waitIdleMin} min)`);
      for (;;) {
        await deps.clock.sleep(IDLE_POLL_MS);
        // another run asks for the lane (the lead's --force, a new approval): this run steps aside, logs no rollover row and
        // ends (the lock goes with it), and that run moves the lane itself
        const taken = claimTakeover(deps, key);
        if (taken) {
          emit(`HANDOVER_STEPPED_ASIDE ${key}: the run of pid ${taken.pid} (${taken.approvedBy ?? "no approval"}${taken.force ? ", --force" : ""}) takes the lane over from this run, waiting since ${new Date(since).toISOString()}`);
          return { code: 2 };
        }
        if (deps.clock.now() >= until) break;
        const pane = (await deps.registry.read(key))?.pane;
        const screen = pane ? await captureTmux(deps.run, pane) : "";
        if (!turnRunning(screen) && !QUESTION_MARK.test(screen)) break;
      }
    }
  } finally {
    rmSync(lockFile, { force: true });
  }
};

type Check = { readonly reasons: string[]; readonly session: string; readonly account?: string; readonly supplements?: readonly Supplement[] };

// Every committed move records the lane's sessions: the new one, and the outgoing one (found in the old pane, else the
// registry's: an adopted lane has none recorded until dori sync --write), which Registry.write keeps in priorSessions.
// A new session that could not be found yet leaves the lane with no current session, so its usage reads unknown (never
// the old transcript twice) until dori sync --write finds it.
export const keepSessions = async (deps: Pick<LaneHandoverDeps, "registry">, key: string, found: string, next: string): Promise<void> => {
  const now = await deps.registry.read(key);
  const outgoing = found || now?.session;
  await deps.registry.patch(key, {
    ...(next ? { session: next, sessionVia: "handover" } : { session: undefined, sessionVia: "handover-unresolved" }),
    ...(outgoing && outgoing !== next ? { priorSessions: [...(now?.priorSessions ?? []).filter((s) => s !== outgoing), outgoing] } : {}),
  });
};

const verifyLane = async (deps: LaneHandoverDeps, facts: LaneFacts, pane: string, verifyMin: number, understood: string, emit: (line: string) => void): Promise<Check> => {
  const tries = Math.max(1, Math.ceil((verifyMin * 60_000) / POLL_MS));
  let i = 0;
  let session = "";
  let shown: StatusLine = {};
  let missing = facts.monitors.map((m) => m.description || m.command || m.path || "?");
  const settled = () => shown.model && (!facts.thinking || shown.thinking === facts.thinking) && !missing.length && (session || !facts.monitors.length);
  for (; i < tries; i++) {
    shown = statusLine(await captureTmux(deps.run, pane), facts.model);
    session ||= await deps.sessionOf(pane, facts.cwd).catch(() => "");
    if (session && facts.monitors.length) missing = missingMonitors(facts.monitors, readManifest(manifestPath(deps.config.sessionsDir, facts.cwd, session)), deps.alive, deps.home, deps.clock.now());
    if (settled()) break;
    await deps.clock.sleep(POLL_MS);
  }
  const reasons = [
    ...(!shown.model ? [`the status line of ${pane} does not show ${modelId(facts.model)}`] : []),
    ...(shown.model && facts.thinking && shown.thinking !== facts.thinking ? [`${pane} runs at thinking ${shown.thinking ?? "unknown"}, not ${facts.thinking}`] : []),
    ...(facts.monitors.length && !session ? [`the omo session of ${pane} was not found under ${facts.cwd}, so its monitors could not be checked`] : []),
    ...(session && missing.length ? [`monitors not running in ${pane}: ${missing.join(", ")}`] : []),
  ];
  if (reasons.length) return { reasons, session, ...(shown.account ? { account: shown.account } : {}) };
  emit(`HANDOVER_STATUS_OK ${pane} ${shown.model}${shown.thinking ? ` thinking ${shown.thinking}` : ""}`);
  if (facts.monitors.length) emit(`HANDOVER_MONITORS_OK ${facts.monitors.length} in ${pane} (session ${session})`);
  // No restatement before the commit (owner Q476, 2026-11-03: since the note carries the owner's words word for word, 19
  // handovers needed no supplement round, while the rewrite held the lane up to two minutes): the probe asks only for the
  // ack, which shows the new session reads its pane and runs dori; the audit after the commit still checks what it holds.
  // the probe goes in once the new session's first turn (reading the note) has ended: typed into a running turn it is a
  // steering line among tool results, which a session read as the last line of the note and held (herdr QA 2026-11-03)
  for (; i < tries && turnRunning(await captureTmux(deps.run, pane)); i++) await deps.clock.sleep(POLL_MS);
  if (i >= tries) return { reasons: [`the first turn of ${pane} was still running after the verify time; the probe was not sent`], session };
  const id = deps.nonce();
  if (!(await sendVerified(deps.run, deps.clock, deps.config, pane, `[LEAD] ${PROBE} ${id}: once you have read the whole handover note, run dori handover ack ${id} --state ${deps.config.stateDir} and nothing else for this line.`))) return { reasons: [`the probe did not reach ${pane}`], session };
  emit(`HANDOVER_PROBE_SENT ${id} -> ${pane}`);
  let by: string | undefined;
  for (; i < tries; i++) {
    by = ackedBy(deps.config.stateDir, id);
    if (by !== undefined) break;
    await deps.clock.sleep(POLL_MS);
  }
  if (by === undefined) return { reasons: [`no ack for the probe ${id}`], session };
  if (by !== pane) return { reasons: [`the probe was acked from ${by || "an unknown pane"}, not ${pane}`], session };
  // checked again before the old session goes: a monitor that ran at the first check can end before the move commits (a
  // remote tail whose ssh dropped with code 255 after its first lines, live 2026-10-20 23:51Z), and a new session is not
  // told when a monitor ends
  const stopped = facts.monitors.length ? missingMonitors(facts.monitors, readManifest(manifestPath(deps.config.sessionsDir, facts.cwd, session)), deps.alive, deps.home, deps.clock.now()) : [];
  if (stopped.length) return { reasons: [`monitors stopped in ${pane} after the first check: ${stopped.join(", ")}`], session };
  return { reasons: [], session, ...(shown.account ? { account: shown.account } : {}) };
};

// Only once the old session's local chains are gone may the new session restart them: two copies of one chain would run
// the same work twice. A chain that outlives the close (it left the session's process group) is reported, not restarted.
const running = (deps: LaneHandoverDeps, c: Job): boolean => (c.pids ?? [c.pid]).some((pid) => deps.alive(pid));

const chainsEnded = async (deps: LaneHandoverDeps, key: string, chains: readonly Job[], pane: string, emit: (line: string) => void): Promise<void> => {
  let alive = chains.filter((c) => running(deps, c));
  for (let i = 0; i < 6 && alive.length; i++) {
    await deps.clock.sleep(POLL_MS);
    alive = alive.filter((c) => running(deps, c));
  }
  const ended = chains.filter((c) => !alive.includes(c));
  if (ended.length) {
    await tell(deps, pane, `[LEAD] HANDOVER_CHAINS_ENDED: the old session is closed and its local chains ended (${ended.map((c) => `${c.pid} ${c.cmd.slice(0, 60)}`).join("; ")}). Restart only what is still needed, from its checkpoint or progress files, and skip steps that already finished.`);
    emit(`HANDOVER_CHAINS_ENDED ${key} ${ended.map((c) => c.pid).join(",")}; the new session may restart them`);
  }
  if (alive.length) {
    await tell(deps, pane, `[LEAD] HANDOVER_CHAIN_SURVIVED: these local chains of the old session still run after it closed: ${alive.map((c) => `${c.pid} ${c.cmd.slice(0, 60)}`).join("; ")}. Do not start them again; watch them instead.`);
    emit(`HANDOVER_CHAIN_SURVIVED ${key} ${alive.map((c) => c.pid).join(",")}; the new session was told not to restart them`);
  }
};

// frozen: the old agent was already frozen at its idle moment (an automatic start)
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MoveContext = { readonly note: string; readonly at: string; readonly title: string; readonly emit: (line: string) => void; readonly steps: Step[]; readonly mark: (step: string, ok: boolean) => void; readonly accounts: { to?: string }; readonly supplements: Supplement[]; readonly frozen: boolean; readonly sizes: Mutable<Sizes> };

const tell = (deps: LaneHandoverDeps, pane: string, text: string) => sendVerified(deps.run, deps.clock, deps.config, pane, text).catch(() => false);

export const LATE_LEAD_HEADING = "The lead's instructions that reached the old session after this note was written";

// The lead's instructions that came after the note was written: [LEAD] lines the old session logged since then and what
// dori type typed into its pane while the handover ran (a frozen agent logs it only when thawed to be closed, or never).
// Read once the old session is closed or left for good, they go to the end of the note and the new session is told.
const forwardLate = async (deps: LaneHandoverDeps, facts: LaneFacts, ctx: MoveContext, pane: string): Promise<void> => {
  const known = new Set((facts.leadWords ?? []).map((s) => flat(s.text)));
  const since = Date.parse(ctx.at);
  const typed = heldTyped(deps.config.stateDir, facts.from.pane).map((h) => ({ line: 0, at: h.at, text: h.text }));
  const late: Said[] = [];
  for (const s of [...leadLines(userLines(facts.oldLog), since), ...leadLines(typed, since)]) {
    if (known.has(flat(s.text))) continue;
    known.add(flat(s.text));
    late.push(s);
  }
  if (!late.length) return;
  appendFileSync(ctx.note, ["", `## ${LATE_LEAD_HEADING} (${late.length})`, "Added when the handover committed; as they were typed, oldest first. Follow each one that still holds.", ...late.map(leadItem), ""].join("\n"));
  await tell(deps, pane, `[LEAD] HANDOVER_LEAD_LATE ${late.length}: the lead's instructions that reached the old session after the note was written are now at the end of the note ${ctx.note}, under ## ${LATE_LEAD_HEADING}. Read them and follow each one that still holds.`);
  ctx.emit(`HANDOVER_LEAD_LATE ${facts.lane.key} ${late.length}: ${late.map((s) => (s.line ? `old log line ${s.line}` : `typed ${s.at}`)).join(", ")} -> ${ctx.note}`);
};

// The registry entry and the open question cards of the lane follow its pane.
const pointLane = async (deps: LaneHandoverDeps, key: string, from: string, to: string, why: string, emit: (line: string) => void): Promise<void> => {
  const fresh = await deps.registry.read(key);
  // a herdr lane's tab is the new pane's (dori close closes it); the old tab goes with the old session
  const tab = isHerdrPane(to) ? ((await herdrResult(deps.run, ["pane", "get", to]))?.pane as { tab_id?: string } | undefined)?.tab_id : undefined;
  if (fresh && fresh.pane !== to) await deps.registry.write({ ...fresh, pane: to, tab, history: [...(fresh.history ?? []), { at: iso(deps.clock), status: statusOf(fresh), note: why }] });
  const cards = new QuestionStore(deps.cardDir).retarget({ tmux: from }, { tmux: to });
  emit(`HANDOVER_LANE ${key} pane -> ${to}; cards ${cards.length ? cards.join(",") : "none"}`);
};

// Whether a pane still has its agent: an aoe session while aoe lists it; a herdr pane while an agent runs in it (herdr
// keeps the shell of a pane whose agent ended, so a listed pane is not enough)
export const agentAlive = async (run: Runner, sessions: Awaited<ReturnType<typeof liveSessions>>, pane: string): Promise<boolean> =>
  isHerdrPane(pane) ? (await paneLife(run, pane)).live : !!sessionFor(sessions, pane);

// Repairs what an interrupted run left: while the old session lives it stays the lane and the new one is closed; when
// only the new one lives (the old was already closed) the lane stays on the new one.
export const recover = async (deps: LaneHandoverDeps, p: Pending, emit: (line: string) => void): Promise<void> => {
  // an agent that runs, not a pane that is listed: a herdr pane keeps its shell after its agent ended
  const sessions = await liveSessions(deps.run);
  const oldAlive = await agentAlive(deps.run, sessions, p.from);
  const newAlive = await agentAlive(deps.run, sessions, p.to);
  if (oldAlive) {
    if (p.agentPid) deps.signal(p.agentPid, "SIGCONT");
    await pointLane(deps, p.key, p.to, p.from, `pane back to ${p.from}: interrupted handover repaired`, emit);
    const closed = newAlive ? await closeAoeSession(deps.run, p.to) : `${p.to} already gone`;
    await tell(deps, p.from, `[LEAD] The handover of ${p.key} was stopped before it finished. You stay the ${p.key} lane: carry on where you were.`);
    emit(`HANDOVER_RECOVERED ${p.key} back on ${p.from}; new session: ${closed}`);
  } else if (newAlive) {
    await pointLane(deps, p.key, p.from, p.to, `pane kept on ${p.to}: interrupted handover repaired, the old session is gone`, emit);
    await tell(deps, p.to, `[LEAD] ${COMMITTED}: the handover was interrupted after the old session ${p.from} closed; you are the ${p.key} lane now. ${deps.config.launchKeywords}: go on with step 5 of the note ${p.note}.`);
    emit(`HANDOVER_RECOVERED ${p.key} kept on ${p.to}: the old session ${p.from} is gone`);
    await keepSessions(deps, p.key, p.fromSession ?? "", p.cwd ? await deps.sessionOf(p.to, p.cwd).catch(() => "") : "");
    if (p.chains?.length) await chainsEnded(deps, p.key, p.chains, p.to, emit);
  } else {
    emit(`HANDOVER_RECOVERED ${p.key}: neither ${p.from} nor ${p.to} is alive (a reboot?); the registry is left as it is, dori sync and dead-panes show the lane`);
  }
  rmSync(pendingFile(deps.config.stateDir, p.key), { force: true });
  clearQuiet(deps.config.stateDir, p.from);
};

const moveLane = async (deps: LaneHandoverDeps, opts: LaneHandoverOptions, facts: LaneFacts, ctx: MoveContext): Promise<LaneHandoverResult> => {
  const { config } = deps;
  const { note, title, emit } = ctx;
  const { lane, from } = facts;
  let pane: string;
  try {
    // the new session opens in this Dori's backend, so a lane moves from aoe to herdr at its next handover
    const workspace = config.backend === "herdr" ? config.laneWorkspace || (isHerdrPane(from.pane) ? sessionFor(await liveSessions(deps.run), from.pane)?.profile : undefined) : undefined;
    pane = await openAoeSession(deps.run, deps.clock, { title, cwd: facts.cwd, tool: config.agentCommand[0] ?? "omo", agentCommand: config.agentCommand, model: facts.model, ...(facts.thinking ? { thinking: facts.thinking } : {}), env: laneEnv(config.launchEnv, lane.useGpu), backend: config.backend, ...(workspace ? { workspace } : {}) });
    ctx.mark("open", true);
  } catch (e) {
    ctx.mark("open", false);
    if (ctx.frozen && facts.agentPid) emit(deps.signal(facts.agentPid, "SIGCONT") ? `HANDOVER_THAWED ${lane.key} agent ${facts.agentPid}` : `HANDOVER_THAW_FAIL ${lane.key} agent ${facts.agentPid}`);
    emit(`HANDOVER_FAIL ${lane.key}: could not open the new session: ${e instanceof Error ? e.message : String(e)}; nothing moved, ${from.pane} stays the lane`);
    return { code: 3, note };
  }
  const pending: Pending = { key: lane.key, pid: process.pid, at: iso(deps.clock), from: from.pane, to: pane, note, chains: facts.chains, ...(facts.agentPid ? { agentPid: facts.agentPid } : {}), ...(from.session ? { fromSession: from.session } : {}), cwd: facts.cwd };
  writeFileSync(pendingFile(config.stateDir, lane.key), JSON.stringify(pending, null, 1));
  // the old pane stays quiet when it is still open after a finished move (--keep-old, or the close failed); the mark expires
  let keepQuiet = false;
  try {
    const r = await finishMove(deps, opts, facts, ctx, pane);
    keepQuiet = r.code === 1 || (r.code === 0 && !!opts.keepOld);
    return r;
  } catch (e) {
    ctx.mark("error", false);
    emit(`HANDOVER_FAIL ${lane.key}: ${e instanceof Error ? e.message : String(e)}; repairing`);
    await recover(deps, pending, emit);
    return { code: 3, note, to: pane };
  } finally {
    rmSync(pendingFile(config.stateDir, lane.key), { force: true });
    if (!keepQuiet) clearQuiet(config.stateDir, from.pane);
  }
};

const finishMove = async (deps: LaneHandoverDeps, opts: LaneHandoverOptions, facts: LaneFacts, ctx: MoveContext, pane: string): Promise<LaneHandoverResult> => {
  const { config } = deps;
  const { note, emit, mark } = ctx;
  const { lane, from } = facts;
  const record = (result: string, reasons: readonly string[]) =>
    writeFileSync(note.replace(/\.md$/, ".result.json"), JSON.stringify({ at: iso(deps.clock), key: lane.key, from, to: pane, note, approvedBy: facts.approvedBy, signals: facts.signals, result, reasons, ...(Object.keys(ctx.sizes).length ? { sizes: ctx.sizes } : {}) }, null, 1));
  let frozen = ctx.frozen;
  const thaw = (): void => {
    if (frozen && facts.agentPid) emit(deps.signal(facts.agentPid, "SIGCONT") ? `HANDOVER_THAWED ${lane.key} agent ${facts.agentPid}` : `HANDOVER_THAW_FAIL ${lane.key} agent ${facts.agentPid}`);
    frozen = false;
  };
  const discard = async (why: string): Promise<LaneHandoverResult> => {
    thaw();
    const closed = await closeAoeSession(deps.run, pane);
    await tell(deps, from.pane, `[LEAD] Handover of ${lane.key} failed (${why}). You stay the ${lane.key} lane: carry on where you were.`);
    emit(`HANDOVER_ROLLED_BACK ${lane.key}: ${from.pane} stays the lane; new session ${pane}: ${closed}`);
    record("rolled-back", [why]);
    return { code: 3, note, to: pane };
  };
  const startup = await awaitPrompt(deps, pane);
  mark("startup", !startup);
  if (startup) {
    emit(`HANDOVER_FAIL ${lane.key}: new session ${pane}: ${startup}`);
    return discard(`the new session did not start: ${startup}`);
  }
  const off = await envMismatch(deps.run, pane, laneEnv(config.launchEnv, lane.useGpu));
  if (off.length) {
    emit(`HANDOVER_FAIL ${lane.key}: new session ${pane} lacks launchEnv: ${off.join(", ")}`);
    return discard(`the new session did not get launchEnv: ${off.join(", ")}`);
  }
  setQuiet(config.stateDir, from.pane, deps.clock.now() + ((opts.verifyMin ?? config.handover.verifyMin) + 10) * 60_000, `the handover of ${lane.key} to ${pane} is running`);
  // an agent frozen at its idle moment reads nothing typed now; it is told only if the move rolls back
  if (!frozen) await tell(deps, from.pane, `[LEAD] Handover of ${lane.key} to ${pane} started (note ${note}). Stop here: start no new tool call, leave running processes alone, and ignore ${PROBE} lines. If it fails you are told and stay the lane.`);
  // frozen, the old agent cannot answer, report or start a second copy of the work while both sessions live
  if (facts.agentPid && !frozen) {
    frozen = deps.signal(facts.agentPid, "SIGSTOP");
    emit(frozen ? `HANDOVER_FROZEN ${lane.key} agent ${facts.agentPid} in ${from.pane}` : `HANDOVER_FREEZE_FAIL ${lane.key} agent ${facts.agentPid}: it stays told and quiet only`);
  }
  // no work keyword here: the new session only arms monitors and answers the probe until it is committed
  const first = await sendVerified(deps.run, deps.clock, config, pane, `You are the ${lane.key} lane in a new session; the old session hands its work over to you. Read the handover note at ${note} in full and do steps 1 to 4 of its first section; start the work only when a [LEAD] ${COMMITTED} line tells you to.`);
  mark("first-message", first);
  if (!first) {
    emit(`HANDOVER_FAIL ${lane.key}: the first message did not register in ${pane}`);
    return discard("the first message did not register in the new session");
  }
  await pointLane(deps, lane.key, from.pane, pane, `pane moved ${from.pane} -> ${pane} (dori handover --lane; approved by ${facts.approvedBy ?? "-"})`, emit);
  emit(`HANDOVER_STARTED ${lane.key} ${from.pane} -> ${pane}`);
  const checked = await verifyLane(deps, facts, pane, opts.verifyMin ?? config.handover.verifyMin, note.replace(/\.md$/, ".understood.md"), emit);
  ctx.supplements.push(...(checked.supplements ?? []));
  mark("verify", !checked.reasons.length);
  if (checked.reasons.length && !(await agentAlive(deps.run, await liveSessions(deps.run), from.pane))) {
    // nothing to go back to: the old session ended during the checks, so the new one stays the lane
    emit(`HANDOVER_OLD_GONE ${lane.key}: ${from.pane} ended during the checks (${checked.reasons.join("; ")}); the lane stays on ${pane}`);
    await tell(deps, pane, `[LEAD] ${COMMITTED}: the old session ended during the checks, so you are the ${lane.key} lane now although a check failed (${checked.reasons.join("; ")}); tell the lead what you see. ${config.launchKeywords}: go on with step 5 of the note.`);
    record("kept-new-old-gone", checked.reasons);
    await keepSessions(deps, lane.key, facts.from.session, checked.session || (await deps.sessionOf(pane, facts.cwd).catch(() => "")));
    await forwardLate(deps, facts, ctx, pane);
    await endStrayTasks(deps, { who: lane.key, session: from.session, pane, note, emit });
    if (facts.chains.length) await chainsEnded(deps, lane.key, facts.chains, pane, emit);
    return { code: 1, note, to: pane };
  }
  if (checked.reasons.length) {
    emit(`HANDOVER_VERIFY_FAIL ${lane.key} ${pane}: ${checked.reasons.join("; ")}`);
    await pointLane(deps, lane.key, pane, from.pane, `pane moved back to ${from.pane}: handover check failed`, emit);
    return discard(checked.reasons.join("; "));
  }
  if (facts.account && checked.account && facts.account !== checked.account) emit(`HANDOVER_ACCOUNT ${lane.key} ${facts.account} -> ${checked.account} (the account pool chose it for the new session)`);
  ctx.accounts.to = checked.account;
  // what the move bought, from the two session logs: the old session's last context, the new one's first and its context now
  const newLog = logOf(sessionDirFor(config.sessionsDir, facts.cwd), checked.session);
  const fresh = newLog ? contextK(newLog, iso(deps.clock)) : {};
  const oldK = facts.oldLog ? contextK(facts.oldLog).last : undefined;
  Object.assign(ctx.sizes, { ...(oldK !== undefined ? { oldK } : {}), ...(fresh.first !== undefined ? { firstK: fresh.first } : {}), ...(fresh.last !== undefined ? { checkedK: fresh.last } : {}), ...(newLog ? { newLog } : {}) });
  emit(`HANDOVER_SIZE ${lane.key} old ${oldK ?? "?"}k -> new first ${fresh.first ?? "?"}k, checked ${fresh.last ?? "?"}k (${sizePct(ctx.sizes) ?? "?"}% of the old)`);
  await keepSessions(deps, lane.key, facts.from.session, checked.session);
  rmSync(readyFile(config.stateDir, lane.key), { force: true });
  if (opts.keepOld) {
    thaw();
    await tell(deps, from.pane, `[LEAD] Handover of ${lane.key} to ${pane} is done and checked. You are no longer the lane; stay idle until the lead closes you.`);
    await tell(deps, pane, `[LEAD] ${COMMITTED}: the handover is checked and the old session ${from.pane} stays open but idle; you are the ${lane.key} lane now. ${config.launchKeywords}: go on with step 5 of the note.`);
    if (facts.chains.length) await tell(deps, pane, `[LEAD] HANDOVER_CHAINS_KEPT: the old session ${from.pane} stays open, so its local chains (${facts.chains.map((c) => c.pid).join(", ")}) still run. Do not start them again.`);
    await forwardLate(deps, facts, ctx, pane);
    await endStrayTasks(deps, { who: lane.key, session: from.session, pane, note, emit });
    emit(`HANDOVER_DONE ${lane.key} ${from.pane} -> ${pane}; old session kept (--keep-old)`);
    record("done-kept-old", []);
    return { code: 0, note, to: pane };
  }
  // work a monitor of the old session started still runs under it: closing the session would end it, so the old agent and
  // everything else under it are frozen, the monitors with work left running, and freshness closes it once the work ended
  const kept = (facts.work ?? []).filter((c) => running(deps, c));
  if (kept.length) {
    // the local chains are left running too: the new session is told they run on, as with --keep-old
    for (const line of await endOldMonitors(deps, facts, [...kept, ...facts.chains].map((c) => c.pid))) emit(line);
    const ice = await freezePane(deps, from.pane, process.pid, [...kept, ...facts.chains].map((c) => c.pid)).catch((e: unknown) => ({ pids: [] as number[], agentPid: undefined, why: e instanceof Error ? e.message : String(e) }));
    mark("freeze", !!ice.agentPid);
    if (!ice.agentPid) thaw();
    const pids = kept.flatMap((c) => c.pids ?? [c.pid]);
    writeFrozen(config.stateDir, { pane: from.pane, aoeId: from.aoeId, at: iso(deps.clock), agentPid: ice.agentPid ?? 0, pids: ice.pids, keepFor: pids, to: pane, ...(from.session ? { session: from.session } : {}), ...(facts.oldLog ? { oldLog: facts.oldLog } : {}) });
    const list = kept.map((c) => `${c.cmd.slice(0, 60)}: ${(c.pids ?? [c.pid]).join(",")}`).join("; ");
    emit(`HANDOVER_WORK_KEPT ${lane.key} ${from.pane}: the work its monitors started still runs (${list}); ${ice.agentPid ? `the old session stays frozen (agent ${ice.agentPid}, ${ice.pids.length} processes stopped, the monitors with work left running)` : `the old agent could not be frozen (${ice.why ?? "nothing stopped"}), so it stays open, told to stay idle,`} and closes once that work ended; dori handover close-frozen ${from.pane} closes it now and ends the work`);
    if (!ice.agentPid) await tell(deps, from.pane, `[LEAD] Handover of ${lane.key} to ${pane} is done and checked. You are no longer the lane; stay idle and leave running processes alone until the session is closed.`);
    emit(`HANDOVER_DONE ${lane.key} ${from.pane} -> ${pane}; old session kept until the work its monitors started ends`);
    record("done-frozen", []);
    await tell(deps, pane, `[LEAD] ${COMMITTED}: the handover is checked; the old session ${from.pane} stays open because work its monitors started still runs there (${list}), and it closes by itself once that work ended. You are the ${lane.key} lane now. Do not start that work again; follow it with the watch-only monitors of step 1. ${config.launchKeywords}: go on with step 5 of the note.`);
    emit(`${COMMITTED} ${lane.key} ${pane}`);
    await forwardLate(deps, facts, ctx, pane);
    // a task in the frozen agent is stopped with it; one in the shared task host is not
    await endStrayTasks(deps, { who: lane.key, session: from.session, pane, note, ...(ice.agentPid ? { leave: ice.agentPid } : {}), emit });
    if (facts.chains.length) await tell(deps, pane, `[LEAD] HANDOVER_CHAINS_KEPT: the old session ${from.pane} stays open, so its local chains (${facts.chains.map((c) => c.pid).join(", ")}) still run until it closes. Do not start them again.`);
    if (facts.detached.length) emit(`HANDOVER_DETACHED_ALIVE ${facts.detached.filter((d) => deps.alive(d.pid)).length}/${facts.detached.length} (${facts.detached.map((d) => d.pid).join(",")})`);
    return { code: 0, note, to: pane };
  }
  emit(`HANDOVER_DONE ${lane.key} ${from.pane} -> ${pane}; closing ${from.pane}`);
  record("done", []);
  // resumed only to be closed: a stopped process does not act on the hangup
  thaw();
  const closed = await closeAoeSession(deps.run, from.pane);
  const ok = isClosedLine(closed);
  mark("close", ok);
  emit(ok ? `HANDOVER_CLOSED ${closed}` : `HANDOVER_CLOSE_FAIL ${closed}`);
  await tell(deps, pane, `[LEAD] ${COMMITTED}: the handover is checked and the old session ${ok ? "is closed" : `${from.pane} did not close but stays idle`}; you are the ${lane.key} lane now. ${config.launchKeywords}: go on with step 5 of the note.`);
  emit(`${COMMITTED} ${lane.key} ${pane}`);
  // read after the close: a line typed into the frozen old pane is logged only once it is thawed to be closed
  await forwardLate(deps, facts, ctx, pane);
  await endStrayTasks(deps, { who: lane.key, session: from.session, pane, note, emit });
  if (facts.chains.length) await chainsEnded(deps, lane.key, facts.chains, pane, emit);
  if (facts.detached.length) emit(`HANDOVER_DETACHED_ALIVE ${facts.detached.filter((d) => deps.alive(d.pid)).length}/${facts.detached.length} (${facts.detached.map((d) => d.pid).join(",")})`);
  return { code: ok ? 0 : 1, note, to: pane };
};

// The length signals of the session in any pane (a lane's or the lead's): context use from its status line, compactions
// and age from its session log.
export const paneSignals = async (deps: LaneHandoverDeps, pane: string, model: string): Promise<Signals> => {
  const s = sessionFor(await liveSessions(deps.run), pane);
  const screen = await captureTmux(deps.run, pane);
  const shown = statusLine(screen, model);
  const blockedTurns = compactionStuckOn(screen);
  const session = s ? await deps.sessionOf(pane, s.path).catch(() => "") : "";
  return { ...(shown.contextPct !== undefined ? { contextPct: shown.contextPct } : {}), ...(blockedTurns ? { compactionStuck: blockedTurns } : {}), ...(s ? sessionSignals(sessionDirFor(deps.config.sessionsDir, s.path), session, deps.clock.now()) : {}) };
};

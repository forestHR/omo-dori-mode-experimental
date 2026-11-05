// dori handover: move the lead to a new agent session without losing work, monitors or notifications.
// Order: write the note -> open the new session -> point leadPane, lanes and cards at it -> check that its monitors run and
// that a [REPORT] and an inbox event reach it -> only then close the old session. A failed check moves everything back.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { captureTmux, closeAoeSession, inputLine, isClosedLine, laneEnv, liveSessions, openAoeSession, sessionFor } from "./aoe.ts";
import { strayTasks, taskRecords } from "./background.ts";
import { type HandoverWatcher } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { type FreezeDeps, type FrozenRecord, type Sig, freezePane, writeFrozen } from "./frozen.ts";
import { pointInstanceAlerts } from "./handover-alerts.ts";
import { endOldMonitors } from "./handover-monitors.ts";
import { leadMovedText, noteLaneTell } from "./lane-tells.ts";
import { compactionStuckOn } from "./lane-handover.ts";
import { awaitPrompt } from "./launch.ts";
import { type Question, QuestionStore } from "./messenger/discord-cards.ts";
import { isHerdrPane } from "./herdr.ts";
import { omoSession, sendVerified } from "./panes.ts";
import { hasSessionSelector } from "./session-id.ts";
import { type Lane, statusOf } from "./registry.ts";
import { iso } from "./run.ts";
import { descendants, ended, type Proc, sessionDirFor } from "./session-id.ts";
import { bulletsIn, covered, fillGaps, flat, type Missing, missingHeadings, quoted, quotesIn, ROUND_TRIES, section, seedRestatement, wholeBullet, words } from "./restatement.ts";
import { appendRollover, approvalProblem, autoReason, type Candidate, clearQuiet, COMMITTED, decidedBy, filledApproval, inboxMessages, measuredSignal, LEAD_PREFIX, lastProposal, limitsFor, ownerQuotes, ownerRolloverText, readRollovers, reportToOwner, rolloverCause, type Signals, sessionSignals, setQuiet, type Step, type Supplement, takeAutoGrant, userLines } from "./rollover.ts";
import { turnRunning } from "./submit.ts";
import { watchLog } from "./watch-log.ts";
import { Worklog, worklogLines } from "./worklog.ts";

export type HandoverDeps = FlowDeps & Pick<FreezeDeps, "procs"> & {
  readonly signal: (pid: number, sig: Sig | "SIGTERM" | "SIGKILL") => boolean;
  readonly configPath: string;
  readonly envPath: string;
  readonly cardDir: string;
  readonly inbox: string;
  readonly home: string;
  // the omo session id of the agent running in a pane ("" when it cannot be told)
  readonly sessionOf: (pane: string, cwd: string) => Promise<string>;
  // leadPane as a freshly started dori process reads it (config file plus DORI_LEAD_PANE)
  readonly routedPane: () => Promise<string>;
  // DORI_LEAD_PANE as this process got it: it overrides the config file, so a handover cannot move it
  readonly envLeadPane: string;
  readonly alive: (pid: number) => boolean;
  // the path with symlinks resolved (the path itself when it cannot be resolved)
  readonly realpath: (path: string) => string;
  readonly timers: () => Promise<string[]>;
  // restart a user unit; a reason when it failed
  readonly restart: (unit: string) => Promise<string | undefined>;
  readonly nonce: () => string;
  readonly print: (line: string) => void;
  // posts the owner's after-the-fact note of a rollover the lead decided and returns its message id (rollover.ts reportToOwner)
  readonly reportOwner?: (thread: string | null, text: string) => Promise<string>;
  // the owner's ids in the inbox (DORI_DISCORD_OWNER, DORI_KAKAO_OWNER_ID): their recent messages go into the note and the
  // new lead's restatement is checked for each
  readonly ownerIds?: readonly string[];
};

export type HandoverOptions = {
  // the approval: lead:<reason and signal>, the owner's answered card Qn, a message link or their words (rollover.ts approvalProblem); --dry-run needs none
  readonly approvedBy?: string;
  // the one-use grant freshness wrote for the run it started (DORI_HANDOVER_AUTO_GRANT): an auto: approval holds only with it
  readonly autoGrant?: string;
  readonly title?: string;
  readonly model?: string;
  readonly note?: string;
  readonly keepOld?: boolean;
  readonly dryRun?: boolean;
  readonly noMonitors?: boolean;
  readonly verifyMin?: number;
};

// A monitor command that starts work besides watching (see launchOf): why, the files its work writes, and the exact
// watch-only command when its script has a mode for that.
export type Launch = { readonly why: string; readonly writes: readonly string[]; readonly rearm?: string };
export type MonitorSpec = { readonly description: string; readonly command?: string; readonly filter?: string; readonly path?: string; readonly event?: string; readonly persistent: boolean; readonly launch?: Launch };

type ManifestEntry = {
  readonly description?: string;
  readonly command?: string;
  readonly filter?: string;
  readonly path?: string;
  readonly event?: string;
  readonly persistent?: boolean;
  readonly suspended?: boolean;
  // omo writes null for a monitor that is not persistent: it has no expiry
  readonly expiresAt?: number | null;
  readonly runtime?: { readonly pid?: number };
};

type Target = { readonly pane: string; readonly aoeId: string; readonly session: string };

export type HandoverFacts = {
  readonly from: Target & { readonly title: string; readonly cwd: string };
  // where the new session opens: handover.cwd, else the old lead's path with symlinks resolved
  readonly cwd: string;
  readonly lanes: readonly Lane[];
  readonly monitors: readonly MonitorSpec[];
  readonly watchers: readonly HandoverWatcher[];
  readonly cards: readonly Question[];
  readonly todos: readonly string[];
  // the lead's open owner requests from dori worklog (upstream dori-superagent#96), one OPEN line each with its Next line
  readonly worklog?: WorklogFacts;
  readonly goal?: string;
  readonly timers: readonly string[];
  readonly leadNote: string;
  readonly ownerWords: readonly OwnerWord[];
  // the old lead's conversation log, quoted by the supplements
  readonly oldLog?: string;
  // the quotes in the old conversation's messages (the owner's with proof, else the lead's) that neither the summary nor the
  // owner's recent messages hold: the audit after the handover looks for the same ones (rollover.ts ownerQuotes)
  readonly quotes?: readonly Candidate[];
};

// the newest quotes the note carries
const QUOTES_MAX = 60;

export type WorklogFacts = { readonly markdown: string; readonly open: number; readonly lines: readonly string[] };

// Upstream https://github.com/sisyphuslabs/dori-superagent/pull/96 lists these in dori boot, which this fork does not have:
// here the new lead reads them in its handover note. A damaged or unreadable record is named, never a refusal.
export const worklogFacts = (stateDir: string): WorklogFacts => {
  const log = new Worklog(stateDir);
  try {
    const read = log.read();
    const [, ...open] = worklogLines(read.items);
    return { markdown: log.markdownPath, open: open.length, lines: [...open, ...read.problems.map((p) => `WORKLOG damaged ${p}`), ...read.warnings.map((w) => `WORKLOG warning ${w}`)] };
  } catch (error) {
    return { markdown: log.markdownPath, open: 0, lines: [`WORKLOG unreadable ${log.path}: ${error instanceof Error ? error.message : String(error)}`] };
  }
};

export type OwnerWord = { readonly at: string; readonly where: string; readonly text: string };

// The summary the old lead writes before it is replaced (dori handover --note FILE; dori handover --template prints the
// headings): what only its conversation knows.
export const LEAD_SUMMARY_HEADINGS = ["Owner's words and constraints", "Decisions and why", "Promised follow-ups", "In progress", "Next step"] as const;
export const LEAD_SUMMARY_TEMPLATE = [
  "## Owner's words and constraints",
  "(every instruction and constraint from the owner that still holds, and what he asked last and is waiting for, quoted exactly in \"double quotes\", newest last, with the message link when you have it)",
  "## Decisions and why",
  "(each decision made in this conversation and what it rests on, one bullet each)",
  "## Promised follow-ups",
  "(each thing you told the owner you would do or report, and when, one bullet each)",
  "## In progress",
  "(what is half done: lanes you were about to launch, steer or close, answers you were writing, checks you were running)",
  "## Next step",
  "(the exact next action)",
  "",
].join("\n");
// The headings of the new lead's restatement, written before it is committed.
export const LEAD_UNDERSTOOD_HEADINGS = ["Goal", "Owner's words", "Open lanes", "Open work", "Open cards", "Timers", "Promised follow-ups", "Decisions", "Next step", "Questions"] as const;
// the headings the new lead writes itself; the handover fills the others in before it asks (restatement.ts seedRestatement)
export const LEAD_OWN = ["Next step", "Questions"] as const;
// the owner's messages the note carries: those of the last OWNER_HOURS, at most OWNER_MAX, newest last
const OWNER_HOURS = 24;
const OWNER_MAX = 8;

export const recentOwnerWords = (inbox: string, ids: readonly string[], now: number): OwnerWord[] => {
  if (!ids.length || !existsSync(inbox)) return [];
  const out: OwnerWord[] = [];
  for (const line of readFileSync(inbox, "utf8").split("\n")) {
    let row: { ts?: string; author_id?: string; content?: string; transcript?: unknown; scope?: string; channel_id?: string; room?: string; id?: string };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      continue;
    }
    const text = (row.content?.trim() || (typeof row.transcript === "string" ? row.transcript.trim() : "")).replace(/\s+/g, " ");
    const at = Date.parse(row.ts ?? "");
    if (!text || !row.author_id || !ids.includes(row.author_id) || !(at <= now && now - at <= OWNER_HOURS * 3_600_000)) continue;
    out.push({ at: row.ts ?? "", where: `${row.scope ?? "?"} ${row.room ?? row.channel_id ?? "-"}, message ${row.id ?? "-"}`, text });
  }
  return out.slice(-OWNER_MAX);
};

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const named = (text: string, name: string): boolean => new RegExp(`(^|[^\\w-])${escapeRe(name)}($|[^\\w-])`, "i").test(text);
const timerUnit = (line: string): string => /(\S+\.timer)\b/.exec(line)?.[1] ?? line;
const todoText = (todo: string): string => todo.replace(/^[^:]*:\s*/, "").replace(/\s*\((?:pending|in_progress)\)$/, "");

// What the new lead's restatement left out, measured against the handover's own records (open lanes, open cards, timers,
// todos, the old session's goal, the owner's recent messages in the inbox: all kept apart from any summary) and against
// the old lead's summary (the owner's quoted words, decisions, promised follow-ups). An open lane, card or timer counts
// only under its own heading.
export const missingLeadFrom = (text: string, facts: HandoverFacts): Missing[] => {
  if (!text.trim()) return [{ kind: "restatement", text: "the restatement file is missing or empty", under: "", source: "the handover" }];
  const all = flat(text);
  const out: Missing[] = missingHeadings(text, LEAD_UNDERSTOOD_HEADINGS).map((h) => ({ kind: "heading", text: `## ${h}`, under: h, source: "the restatement format" }));
  const lanes = section(text, "Open lanes");
  for (const l of facts.lanes) if (!named(lanes, l.key)) out.push({ kind: "open lane", text: l.key, under: "Open lanes", source: `the lane registry: ${statusOf(l)}, pane ${l.pane ?? "-"}, thread ${l.thread}, last report ${cell(l.lastReport ?? "-")}` });
  const cards = section(text, "Open cards");
  for (const q of facts.cards) if (!named(cards, q.id)) out.push({ kind: "open card", text: q.id, under: "Open cards", source: `the open question cards: "${cell(q.text)}" (options: ${q.options.join(" / ")}; thread ${q.thread ?? "-"}), waiting for the owner's answer` });
  const timers = flat(section(text, "Timers"));
  for (const t of facts.timers) if (!timers.includes(flat(timerUnit(t)))) out.push({ kind: "timer", text: timerUnit(t), under: "Timers", source: `systemctl --user list-timers: ${t}` });
  const work = flat(section(text, "Open work"));
  for (const t of facts.todos.map(todoText)) if (!(words(t).length >= 3 ? covered(work, t) : quoted(work, t))) out.push({ kind: "open work", text: t, under: "Open work", source: "the old session's todo list", byWords: true });
  const goal = facts.goal?.replace(/\s*\((?:active|paused|blocked|[a-z_]+)\)$/, "").trim() ?? "";
  if (goal && !quoted(all, goal)) out.push({ kind: "goal", text: goal, under: "Goal", source: "the old session's goal" });
  for (const w of facts.ownerWords) if (flat(w.text).length >= 6 && !quoted(all, w.text)) out.push({ kind: "owner's words", text: w.text, under: "Owner's words", source: `the owner's message at ${w.at} (${w.where}), from the inbox` });
  for (const q of quotesIn(section(facts.leadNote, "Owner's words and constraints"))) if (!quoted(all, q) && !out.some((m) => flat(m.text) === flat(q))) out.push({ kind: "owner's words", text: q, under: "Owner's words", source: "the old lead's summary, Owner's words and constraints" });
  for (const d of bulletsIn(facts.leadNote, "Decisions and why")) if (!covered(all, d)) out.push({ kind: "decision", text: d, under: "Decisions", source: "the old lead's summary, Decisions and why", byWords: true, whole: wholeBullet(facts.leadNote, "Decisions and why", d) });
  for (const d of bulletsIn(facts.leadNote, "Promised follow-ups")) if (!covered(all, d)) out.push({ kind: "promised follow-up", text: d, under: "Promised follow-ups", source: "the old lead's summary, Promised follow-ups", byWords: true, whole: wholeBullet(facts.leadNote, "Promised follow-ups", d) });
  return out;
};

const POLL_MS = 5_000;
export const PROBE = "HANDOVER_PROBE";
export const UNDERSTAND = "HANDOVER_UNDERSTAND";

// omo keeps each session's monitors in <session dir>/extensions/terminal/<session id>.json
export const manifestPath = (sessionsDir: string, cwd: string, session: string): string => join(sessionDirFor(sessionsDir, cwd), "extensions", "terminal", `${session}.json`);

export const readManifest = (file: string): ManifestEntry[] => {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { monitors?: ManifestEntry[] };
    return Array.isArray(parsed.monitors) ? parsed.monitors : [];
  } catch {
    return [];
  }
};

const spec = (e: ManifestEntry): MonitorSpec => ({
  description: e.description ?? "",
  ...(e.command ? { command: e.command } : {}),
  ...(e.filter ? { filter: e.filter } : {}),
  ...(e.path ? { path: e.path } : {}),
  ...(e.event ? { event: e.event } : {}),
  persistent: !!e.persistent,
});

const running = (e: ManifestEntry, now: number): boolean => !e.suspended && (e.expiresAt == null || e.expiresAt > now) && !!(e.command || e.path);

// What a monitor command starts besides watching: a job (nohup, setsid, a lone &, systemd-run, dori heavy, tmux, screen,
// docker, sbatch) or a change (a dori command that posts or moves, kill, rm, mv, git push/commit). Armed again in a new
// session such a command starts its work again: GongDori's E7 chain watch (2026-10-20) ran "if pgrep ...; else nohup setsid
// bash bs_chain_mn.sh 400 > logs/bs_chain.out 2>&1 &; fi; tail -F logs/bs_chain.out", and once the chain had ended a
// re-arm started the 400-iteration chain again. A & counts only after output sent to a file ("job > log 2>&1 &"): a
// backgrounded check inside a watch (the lead's "( sleep 60; tail ... || echo X ) &") starts nothing; kill -0 is no work.
const STARTS: readonly RegExp[] = [
  /\bnohup\b/, /\bsetsid\b/, /\bsystemd-run\b/, /\bdisown\b/,
  /(?<![0-9&>])>>?\s*(?!\/dev\/null\b)[^\s;&|()<>]+(?:\s+\d?>&\d)*\s*&(?=\s|$|[;)'"])/,
  /\bdori\s+(?:heavy|launch|send|type|close|claim-done|handover|ask|thread\s+(?:reply|done))\b/,
  /\btmux\s+(?:new|send-keys|kill)/, /\bscreen\s+-d/, /\bdocker\s+(?:run|start|exec)\b/, /\bsbatch\b/,
  /\b(?:pkill|killall|kill)\b(?!\s+-0\b)/, /\bgit\s+(?:push|commit|reset|checkout)\b/, /(?:^|[\s;&|(])(?:rm|mv)\s/,
];
const RESTORED = "SENPI_MONITOR_RESTORED";

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const startsWork = (text: string): string | undefined => {
  for (const re of STARTS) {
    const m = re.exec(text);
    if (m) return m[0].trim().endsWith("&") ? "a background job writing a file" : m[0].replace(/^[\s;&|(]+/, "").trim();
  }
  return undefined;
};

// A command that only watches gives undefined. A local script it runs (bash x.sh, ./x.sh, an absolute path) is read too:
// a script that honours SENPI_MONITOR_RESTORED (omo sets it when it restores a monitor) watches only when that is set.
// The account's home for task and session records: homedir(), not $HOME, which native Windows does not set (USERPROFILE).
export const accountHome = (): string => homedir();

// A handover that must run apart from the agent it freezes (the lead's own pane, an automatic rollover, a resume after
// ready, the audit after a commit) starts through systemd-run. Native Windows has none yet: refused, with what to do.
export const windowsDetachRefusal = (platform: string = process.platform): string | undefined =>
  platform === "win32"
    ? "HANDOVER_DETACH_UNSUPPORTED on native Windows a handover cannot run detached yet: run dori handover (or dori handover --lane <key>) from another herdr pane, not the lead's own, and roll lanes over by hand"
    : undefined;

export const launchOf = (command: string, home: string, read: (path: string) => string | undefined = readText): Launch | undefined => {
  const scripts = [...command.matchAll(/(?:^|[\s;&|(])((?:~\/|\$HOME\/|\/)[^\s;&|'"()]*\.sh)\b/g)].map((m) => read((m[1] ?? "").replace(/^(?:~|\$HOME)\//, `${home}/`)) ?? "");
  const honours = scripts.some((s) => s.includes(RESTORED));
  if (honours && new RegExp(`\\b${RESTORED}=1\\b`).test(command)) return undefined;
  const why = startsWork(command) ?? scripts.map(startsWork).find(Boolean);
  if (!why) return undefined;
  const writes = [...new Set([...command.matchAll(/(?:(?<![0-9&>])>>?|\btee\s+(?:-a\s+)?)\s*([^\s;&|'"()>]+)/g)].map((m) => m[1] ?? "").filter((f) => f && f !== "/dev/null"))];
  return { why, writes, ...(honours ? { rearm: `export ${RESTORED}=1; ${command}` } : {}) };
};

// Every watch the old session still runs, persistent or not: the new session must run each one. A command monitor whose
// recorded process is gone has ended and is left out. One that starts work carries launch: the new session arms a
// watch-only one in its place.
export const liveMonitors = (entries: readonly ManifestEntry[], now: number, alive: (pid: number) => boolean, home: string): MonitorSpec[] =>
  entries.filter((e) => running(e, now) && (!!e.path || e.runtime?.pid === undefined || alive(e.runtime.pid))).map((e) => {
    const s = spec(e);
    const launch = s.command ? launchOf(s.command, home) : undefined;
    return launch ? { ...s, launch } : s;
  });

// The work a monitor that starts work (launch) still runs: the processes under its command besides the readers it follows
// the work with (tail, grep). They are in the old session's process tree, so closing that session ends them (GongDori's
// e7-leap chain s21 -> s31 under "dori heavy ... > log 2>&1 & tail --pid" died at its lane handover on 2026-10-24 04:05Z).
// pid: the monitor's own process; pids: the work under it.
export type MonitorWork = { readonly pid: number; readonly cmd: string; readonly pids: readonly number[] };
const READER = /^(?:\S*\/)?(?:tail|grep)\s/;
export const monitorWork = (entries: readonly ManifestEntry[], table: readonly Proc[], now: number, alive: (pid: number) => boolean, home: string): MonitorWork[] =>
  entries.flatMap((e) => {
    const pid = e.runtime?.pid;
    if (pid === undefined || !e.command || !running(e, now) || !alive(pid) || !launchOf(e.command, home)) return [];
    const pids = descendants(table, pid).filter((p) => !ended(p) && !READER.test(p.cmd)).map((p) => p.pid);
    return pids.length ? [{ pid, cmd: e.description || e.command, pids }] : [];
  });

const fillTarget = (argv: readonly string[], target: { readonly pane: string; readonly session: string }): string[] =>
  argv.map((a) => a.replaceAll("{pane}", target.pane).replaceAll("{session}", target.session));

// A configured watcher runs when its check command exits 0; the names (with the failed command) of those that do not.
export const missingWatchers = async (deps: Pick<HandoverDeps, "run">, watchers: readonly HandoverWatcher[], target: { readonly pane: string; readonly session: string }): Promise<string[]> => {
  const out: string[] = [];
  for (const w of watchers) {
    const argv = fillTarget(w.check, target);
    const r = await deps.run(argv);
    if (r.code !== 0) out.push(`${w.name} (${JSON.stringify(argv)} exit ${r.code}${r.err.trim() ? `: ${r.err.trim().slice(0, 120)}` : ""})`);
  }
  return out;
};

const norm = (text: string, home: string): string => text.replace(/(^|[\s=:'"])~\//g, `$1${home}/`).replace(/\s+/g, " ").trim();

// The words a shell makes of a command: quotes and backslashes resolved, operators (| ; & ( ) < >) as words of their own
// (marked, so a quoted "|" stays a plain word); undefined for an unclosed quote.
const OP = "\u0000";
export const shellWords = (text: string): string[] | undefined => {
  const out: string[] = [];
  let cur = "";
  let has = false;
  const push = () => {
    if (has) out.push(cur);
    cur = "";
    has = false;
  };
  for (let i = 0; i < text.length; ) {
    const c = text[i] ?? "";
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return undefined;
      cur += text.slice(i + 1, end);
      has = true;
      i = end + 1;
    } else if (c === '"') {
      has = true;
      for (i++; ; ) {
        if (i >= text.length) return undefined;
        const d = text[i] ?? "";
        if (d === '"') break;
        // inside double quotes a backslash escapes only $ ` " \ and a newline
        if (d === "\\" && '$`"\\\n'.includes(text[i + 1] ?? "x")) {
          if (text[i + 1] !== "\n") cur += text[i + 1];
          i += 2;
        } else {
          cur += d;
          i++;
        }
      }
      i++;
    } else if (c === "\\") {
      if (text[i + 1] !== undefined && text[i + 1] !== "\n") {
        cur += text[i + 1];
        has = true;
      }
      i += 2;
    } else if (/\s/.test(c)) {
      push();
      i++;
    } else if ("|&;()<>".includes(c)) {
      push();
      const op = /^(?:\|\||&&|;;|>>|<<|\d?>&|[|&;()<>])/.exec(text.slice(i))?.[0] ?? c;
      out.push(OP + op);
      i += op.length;
    } else {
      cur += c;
      has = true;
      i++;
    }
  }
  push();
  return out;
};

// ssh options that take a value (the next word), so the host is the first word after the options
const SSH_ARG = /^-[46AaCfGgKkMNnqsTtVvXxYy]*[BbcDEeFIiJLlmOoPpQRSWw]$/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

// A command in a form that two spellings a shell runs the same way share: its words, with what another shell runs (the
// remote command of ssh, the -c string of bash) in that form too. GongDori's E7 lane (2026-10-20 23:39Z) re-armed
// ssh ori644d 'tail ... | sed -u "/DONE\\|ABORT/q"' with \\| for \| (the same sed argument inside the remote double quotes),
// and a text compare rolled the handover back while that tail ran.
export const commandForm = (text: string, home: string, depth = 3): string => {
  const words = shellWords(text);
  if (!words) return norm(text, home);
  const out: string[] = [];
  for (let i = 0; i < words.length; ) {
    let end = words.findIndex((w, k) => k >= i && w.startsWith(OP));
    if (end < 0) end = words.length;
    const seg = words.slice(i, end).map((w) => w.replace(/^~\//, `${home}/`));
    let k = seg.findIndex((w) => !/^[A-Za-z_]\w*=/.test(w));
    const cmd = k < 0 ? "" : (seg[k] ?? "").replace(/^.*\//, "");
    if (depth > 0 && cmd === "ssh") {
      for (k++; k < seg.length && (seg[k] ?? "").startsWith("-"); k++) if (SSH_ARG.test(seg[k] ?? "")) k++;
      // ssh joins the words after the host with spaces and the remote shell reads them again
      if (k + 1 < seg.length) seg.splice(k + 1, seg.length, `${OP}remote ${commandForm(seg.slice(k + 1).join(" "), home, depth - 1)}`);
    } else if (depth > 0 && SHELLS.has(cmd)) {
      const c = seg.findIndex((w, j) => j > k && /^-[a-z]*c[a-z]*$/.test(w));
      if (c > 0 && c + 1 < seg.length) seg[c + 1] = `${OP}shell ${commandForm(seg[c + 1] ?? "", home, depth - 1)}`;
    }
    out.push(...seg, ...(end < words.length ? [words[end] ?? ""] : []));
    i = end + 1;
  }
  return JSON.stringify(out);
};

export const sameCommand = (a: string, b: string, home: string): boolean => norm(a, home) === norm(b, home) || commandForm(a, home) === commandForm(b, home);

const firstDiff = (a: string, b: string): string => {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 12);
  return `from char ${i}: ${JSON.stringify(a.slice(from, i + 24))} wanted, ${JSON.stringify(b.slice(from, i + 24))} armed`;
};

// why an armed entry does not count as running
const notRunning = (e: ManifestEntry, alive: (pid: number) => boolean, now: number): string =>
  e.suspended ? "it is suspended" : e.expiresAt != null && e.expiresAt <= now ? "it expired" : !e.persistent ? "it is not persistent" : e.runtime?.pid === undefined ? "no process is recorded for it" : !alive(e.runtime.pid) ? `its process ${e.runtime.pid} ended (a remote tail whose ssh failed or whose log ended exits at once)` : "it does not run";

// A monitor counts as re-armed when the new session runs a persistent watch with the same command (or path, or
// description), whose process is alive. One that starts work (launchOf) counts as re-armed by a watch-only one instead:
// a path watch, or a command that starts nothing, with the same description or filter (or its exact watch-only form);
// the same command armed again does not count, since that started the work a second time.
export const missingMonitors = (wanted: readonly MonitorSpec[], entries: readonly ManifestEntry[], alive: (pid: number) => boolean, home: string, now: number): string[] => {
  const live = entries.filter((e) => e.persistent && running(e, now) && (e.path || (e.runtime?.pid !== undefined && alive(e.runtime.pid))));
  const same = (a: string, b: string) => sameCommand(a, b, home);
  const out: string[] = [];
  for (const m of wanted) {
    const name = m.description || m.command || m.path || "?";
    const launch = m.launch ?? (m.command ? launchOf(m.command, home) : undefined);
    if (m.command && launch) {
      const watchOnly = live.some((e) => (e.path || (!!e.command && !launchOf(e.command, home)))
        && ((!!m.description && e.description === m.description) || (!!m.filter && e.filter === m.filter) || (!!launch.rearm && !!e.command && same(launch.rearm, e.command))));
      const command = m.command;
      if (!watchOnly) out.push(live.some((e) => !!e.command && same(command, e.command)) ? `${name} (armed again with the command that starts work; arm a watch-only one instead)` : `${name} (starts work: arm a watch-only one with the same description)`);
      continue;
    }
    // the same watch, not just the same name: the command (and its filter) or the path; the description only for a monitor that has neither
    const ok = live.some((e) => m.command ? !!e.command && same(m.command, e.command) && (!m.filter || e.filter === m.filter)
      : m.path ? !!e.path && same(m.path, e.path)
      : !!m.description && e.description === m.description);
    if (ok) continue;
    // say why, so the lead (and the rollback record) tells "not armed" from "armed but ended" and "armed differently"
    const command = m.command;
    const armed = command ? entries.find((e) => !!e.command && same(command, e.command)) : m.path ? entries.find((e) => !!e.path && same(m.path ?? "", e.path)) : undefined;
    const like = command ? live.find((e) => !!e.command && ((!!m.description && e.description === m.description) || (!!m.filter && e.filter === m.filter) || same(command, e.command))) : undefined;
    out.push(armed && !live.includes(armed) ? `${name} (armed, but ${notRunning(armed, alive, now)})`
      : like?.command && command ? `${name} (a monitor runs ${same(command, like.command) ? `its command with filter ${JSON.stringify(like.filter ?? "")}, not ${JSON.stringify(m.filter ?? "")}` : `another command, ${firstDiff(command, like.command)}`}; arm it with the command and filter of the note's Monitors line)`
      : name);
  }
  return out;
};

const sessionFile = (dir: string, session: string): string | undefined => {
  try {
    const name = readdirSync(dir).find((n) => n.endsWith(`_${session}.jsonl`));
    return name ? join(dir, name) : undefined;
  } catch {
    return undefined;
  }
};

export const openTodos = (sessionDir: string, session: string): string[] => {
  const file = sessionFile(sessionDir, session);
  if (!file) return [];
  const last = readFileSync(file, "utf8").split("\n").findLast((l) => l.includes('"senpi.todo-state"'));
  if (!last) return [];
  try {
    const data = (JSON.parse(last) as { data?: { phases?: { name?: string; tasks?: { content?: string; status?: string }[] }[] } }).data;
    return (data?.phases ?? []).flatMap((p) => (p.tasks ?? []).filter((t) => t.status !== "completed" && t.status !== "abandoned").map((t) => `${p.name ?? "-"}: ${t.content ?? ""} (${t.status ?? "pending"})`));
  } catch {
    return [];
  }
};

export const openGoal = (sessionDir: string, session: string): string | undefined => {
  try {
    const goal = (JSON.parse(readFileSync(join(sessionDir, "extensions", "goal", `${session}.json`), "utf8")) as { goal?: { objective?: string; status?: string } }).goal;
    return goal?.objective && goal.status !== "complete" ? `${goal.objective} (${goal.status ?? "active"})` : undefined;
  } catch {
    return undefined;
  }
};

const cell = (text: string): string => text.replace(/\s*\|\s*/g, " / ").replace(/\s*[\r\n]+\s*/g, " ").slice(0, 160);
const launchHow = (m: MonitorSpec, l: Launch): string =>
  ` LAUNCHES_WORK (${l.why}): do not arm this command again, it would start its work a second time. Arm in its place a persistent watch-only monitor with the same description${m.filter ? " and filter" : ""} that only reads what the work writes${l.writes.length ? ` (${l.writes.join(", ")})` : ""}, where it runs (the same ssh host, if any): tail -F, grep, an until-wait; nothing that starts, posts or changes anything.${l.rearm ? ` Its script has a watch-only mode: arm exactly command ${JSON.stringify(l.rearm)}${m.filter ? ` filter ${JSON.stringify(m.filter)}` : ""}.` : ""}`;
export const monitorLine = (m: MonitorSpec): string =>
  `- ${m.description || "(no description)"}: ${m.command ? `command ${JSON.stringify(m.command)}${m.filter ? ` filter ${JSON.stringify(m.filter)}` : ""}` : `path ${JSON.stringify(m.path)}${m.event ? ` event ${m.event}` : ""}`}${m.persistent ? "" : " (was not persistent in the old session; arm it as persistent)"}${m.launch ? launchHow(m, m.launch) : ""}`;
const watcherLine = (w: HandoverWatcher): string => `- ${w.name}: check ${JSON.stringify(w.check)}${w.arm ? `; to start it: ${w.arm}` : "; runs outside omo, nothing to arm"}`;

export const renderNote = (f: HandoverFacts, at: string): string => [
  `# Dori handover ${at}`,
  "",
  `From ${f.from.pane} (aoe ${f.from.aoeId}, omo session ${f.from.session || "unknown"}, cwd ${f.from.cwd}). You are the new lead session${f.cwd === f.from.cwd ? "" : `, opened in ${f.cwd}`}: dori handover points leadPane, the open lanes and the open question cards at you.`,
  "",
  "## Do this first",
  "1. Arm every monitor under Monitors again as a persistent monitor, with the same command and filter; one marked LAUNCHES_WORK gets the watch-only monitor its line describes instead, never its own command. Take each command, filter and description from its line under Monitors, where they are JSON strings: put them into the tool call as they are (a JSON string is a valid JS string), not retyped and not from the conversation summary, where a copy can differ. Arm each one once. Start each watcher under Watchers that says how. The handover checks that the monitors run in this session and runs each watcher's check.",
  `2. A line with ${PROBE} <id>, typed into this session or arriving as an inbox event, is a check of this handover: run the dori handover ack command the line gives (with its --state) and nothing else.`,
  `3. A [LEAD] HANDOVER_SUPPLEMENT <id> line comes from the audit after the commit: it names a file with what you were missing and the old log lines behind it; write those items into the file it names (create it if it is not there), keep them in mind as the note's, and run the ack command it gives. No restatement is asked before the commit.`,
  `4. Until a [LEAD] ${COMMITTED} line arrives answer no one, act on no event and change nothing besides that file: the handover can still roll back. The old session stays quiet meanwhile and is closed once the checks pass.`,
  `5. After ${COMMITTED}, carry on: open lanes, owner questions, todos, open worklog items (each from its Next line, and keep it with dori worklog next|note|close), timers, promised follow-ups and the old lead's notes; answer the owner where his last messages left off. A [LEAD] HANDOVER_SUPPLEMENT line that comes later is the audit after the handover: do what it says and go on. When you or a lane find later that an old session knew something its handover did not carry and it cost something (asking again, redoing, guessing), run dori handover gap <lane key or lead> --kind "<owner's words|decision|lead instruction|todo|goal|monitor|tried fix|other>" --text "<one line, no secret values>".`,
  "",
  `## Monitors (${f.monitors.length})`,
  ...(f.monitors.length ? f.monitors.map(monitorLine) : ["none"]),
  "",
  `## Watchers (${f.watchers.length}, from handover.watchers)`,
  ...(f.watchers.length ? f.watchers.map(watcherLine) : ["none"]),
  "",
  `## Open lanes (${f.lanes.length})`,
  ...(f.lanes.length
    ? ["| key | status | pane | thread | last report |", "|---|---|---|---|---|", ...f.lanes.map((l) => `| ${l.key} | ${statusOf(l)} | ${l.pane ?? "-"} | ${l.thread} | ${cell(l.lastReport ?? "-")} |`)]
    : ["none"]),
  "",
  `## Open owner questions (${f.cards.length})`,
  ...(f.cards.length ? f.cards.map((q) => `- ${q.id}: ${cell(q.text)} (options: ${q.options.join(" / ")}; thread ${q.thread ?? "-"})`) : ["none"]),
  "",
  "## Todos left in the old session",
  ...(f.todos.length ? f.todos.map((t) => `- ${t}`) : ["none"]),
  ...(f.worklog ? ["", `## Open worklog items (${f.worklog.open}, dori worklog list --open; ${f.worklog.markdown})`, ...(f.worklog.lines.length ? f.worklog.lines.map((l) => `- ${l}`) : ["none"])] : []),
  ...(f.goal ? ["", "## Goal of the old session", f.goal] : []),
  "",
  "## Timers and reminders",
  ...(f.timers.length ? f.timers.map((t) => `- ${t}`) : ["none"]),
  "",
  `## The owner's recent messages (${f.ownerWords.length}, last ${OWNER_HOURS} h, newest last)`,
  ...(f.ownerWords.length ? f.ownerWords.map((w) => `- ${w.at} (${w.where}): "${w.text}"`) : ["none"]),
  "",
  "## The old lead's notes",
  f.leadNote.trim() || "(none: the old lead wrote no summary (dori handover --template prints its headings, dori handover --note FILE adds it); read the old conversation below before you act on a guess)",
  "",
  `## Quotes in the old conversation (${f.quotes?.length ?? 0})`,
  ...(f.quotes?.length
    ? ["Quoted in the messages the old lead got (its log), oldest first, that the notes above do not hold: the owner's words (his only with proof: his message id in the inbox or a card he answered) and the lead's own words. Carry each one that still holds under Owner's words (his) or Decisions (the lead's) in your restatement; one a later line replaced, or work already done, does not hold.", ...f.quotes.map((q) => `- ${q.at.slice(0, 16)}Z ${q.kind} (old log line ${q.line}): "${q.text}"`)]
    : ["none"]),
  "",
  "## The old conversation",
  f.oldLog ? `Its full log is ${f.oldLog} (JSONL; it stays on disk after the old session closes). When this note leaves something out, search it (the owner's words, a lane key, a card id) before you ask.` : "Its log was not found.",
  "",
].join("\n");

// The quotes of the old lead's conversation that its summary and the owner's recent messages do not hold, newest QUOTES_MAX:
// on 2026-10-31 the audit after the lead handover 20261031-070115 found three ("주소는 하나로", "영상 전체 위에 오버레이",
// "별도의 섹션") only in the old conversation, ten minutes after the commit.
export const conversationQuotes = (deps: Pick<HandoverDeps, "inbox" | "ownerIds" | "cardDir">, oldLog: string | undefined, held: string): Candidate[] => {
  if (!oldLog) return [];
  const inbox = inboxMessages(deps.inbox, deps.ownerIds ?? []);
  const cards = new QuestionStore(deps.cardDir);
  const all = flat(held);
  return ownerQuotes(userLines(oldLog), { message: (id) => inbox.ids.includes(inbox.find(id)?.author ?? "-"), card: (id) => cards.get(id)?.status === "answered" }).filter((q) => !quoted(all, q.text)).slice(-QUOTES_MAX);
};

// The lanes' footer, their [LEAD] message and the config text all name the lead's pane; moving it is one function, so a
// rollback is the same call with the two sides swapped.
export const pointLead = async (deps: HandoverDeps, from: Target, to: Target, stamp: string): Promise<string[]> => {
  const out: string[] = [];
  const at = iso(deps.clock);
  const backup = (path: string) => {
    const copy = `${path}.bak-handover-${stamp}`;
    if (!existsSync(copy)) writeFileSync(copy, readFileSync(path));
  };
  const raw = existsSync(deps.configPath) ? (JSON.parse(readFileSync(deps.configPath, "utf8")) as Record<string, unknown> & { update?: Record<string, unknown> }) : {};
  if (existsSync(deps.configPath)) backup(deps.configPath);
  raw.leadPane = to.pane;
  if (raw.update?.alertPane === from.pane) raw.update.alertPane = to.pane;
  writeFileSync(deps.configPath, `${JSON.stringify(raw, null, 2)}\n`);
  out.push(`HANDOVER_CONFIG leadPane ${from.pane} -> ${to.pane} in ${deps.configPath}`);
  out.push(...pointInstanceAlerts(deps, { from: from.pane, to: to.pane, stamp }));
  if (existsSync(deps.envPath)) {
    const text = readFileSync(deps.envPath, "utf8");
    // a line the file lacks is added, so the listener that reads dori.env learns the new lead too
    const set = (body: string, key: string, value: string): string => {
      const line = new RegExp(`^${key}=.*$`, "m");
      return line.test(body) ? body.replace(line, `${key}=${value}`) : `${body}${body && !body.endsWith("\n") ? "\n" : ""}${key}=${value}\n`;
    };
    const tmux = set(text, "DORI_LEAD_TMUX", to.pane);
    const next = to.aoeId ? set(tmux, "DORI_LEAD_AOE_ID", to.aoeId) : tmux;
    if (next !== text) {
      backup(deps.envPath);
      writeFileSync(deps.envPath, next);
      out.push(`HANDOVER_ENV DORI_LEAD_TMUX/DORI_LEAD_AOE_ID -> ${to.pane}/${to.aoeId || "-"} in ${deps.envPath}`);
    }
  }
  for (const lane of await deps.registry.open()) {
    let brief = "missing";
    if (existsSync(lane.brief)) {
      const text = readFileSync(lane.brief, "utf8");
      brief = text.includes(from.pane) ? "rewritten" : "unchanged";
      if (brief === "rewritten") writeFileSync(lane.brief, text.split(from.pane).join(to.pane));
    }
    const fresh = (await deps.registry.read(lane.key)) ?? lane;
    await deps.registry.write({ ...fresh, history: [...(fresh.history ?? []), { at, status: statusOf(fresh), note: `lead moved ${from.pane} -> ${to.pane} (dori handover)` }] });
    const told = lane.pane ? await sendVerified(deps.run, deps.clock, deps.config, lane.pane, leadMovedText(to.pane)) : false;
    // a lane that did not take it is retried by freshness (lane-tells.ts) instead of being left told=no
    if (lane.pane) noteLaneTell(deps.config.stateDir, lane.key, lane.pane, to.pane, at, told);
    out.push(`HANDOVER_LANE ${lane.key} brief=${brief} told=${told ? "yes" : `no${lane.pane ? " (freshness retries it)" : ""}`}`);
  }
  const cards = new QuestionStore(deps.cardDir).retarget({ tmux: from.pane }, { tmux: to.pane });
  out.push(`HANDOVER_CARDS ${cards.length ? cards.join(",") : "none"} -> ${to.pane}`);
  return out;
};

export const ackFile = (stateDir: string, nonce: string): string => join(stateDir, "handover", "acks", `${nonce.replace(/[^\w-]/g, "")}.json`);

export const ackHandover = (stateDir: string, nonce: string, pane: string, at: string): string => {
  const file = ackFile(stateDir, nonce);
  mkdirSync(join(stateDir, "handover", "acks"), { recursive: true });
  writeFileSync(file, JSON.stringify({ nonce, pane, at }));
  return `HANDOVER_ACK ${nonce} pane=${pane || "-"}`;
};

export const ackedBy = (stateDir: string, id: string): string | undefined => {
  try {
    return (JSON.parse(readFileSync(ackFile(stateDir, id), "utf8")) as { pane?: string }).pane ?? "";
  } catch {
    return undefined;
  }
};

const ackProblem = (stateDir: string, nonce: string, what: string, pane: string): string | undefined => {
  const file = ackFile(stateDir, nonce);
  if (!existsSync(file)) return `no ack for the ${what}`;
  const by = (JSON.parse(readFileSync(file, "utf8")) as { pane?: string }).pane ?? "";
  return by === pane ? undefined : `the ${what} was acked from ${by || "an unknown pane"}, not ${pane}`;
};

type Checked = { readonly reasons: string[]; readonly session: string; readonly supplements?: readonly Supplement[] };

const verify = async (deps: HandoverDeps, facts: HandoverFacts, to: Target, verifyMin: number, understood: string, emit: (line: string) => void): Promise<Checked> => {
  const tries = Math.max(1, Math.ceil((verifyMin * 60_000) / POLL_MS));
  let i = 0;
  let session = "";
  if (facts.monitors.length || facts.watchers.length) {
    let missing = facts.monitors.map((m) => m.description);
    let down: string[] = facts.watchers.map((w) => w.name);
    for (; i < tries; i++) {
      session ||= await deps.sessionOf(to.pane, facts.cwd).catch(() => "");
      if (session && facts.monitors.length) missing = missingMonitors(facts.monitors, readManifest(manifestPath(deps.config.sessionsDir, facts.cwd, session)), deps.alive, deps.home, deps.clock.now());
      down = await missingWatchers(deps, facts.watchers, { pane: to.pane, session });
      if ((session || !facts.monitors.length) && !missing.length && !down.length) break;
      await deps.clock.sleep(POLL_MS);
    }
    if (facts.monitors.length && !session) return { reasons: [`the omo session of ${to.pane} was not found under ${facts.cwd}, so its monitors could not be checked`], session };
    const reasons = [...(missing.length ? [`monitors not running in ${to.pane}: ${missing.join(", ")}`] : []), ...(down.length ? [`watchers not running for ${to.pane}: ${down.join(", ")}`] : [])];
    if (reasons.length) return { reasons, session };
    if (facts.monitors.length) emit(`HANDOVER_MONITORS_OK ${facts.monitors.length} in ${to.pane} (session ${session})`);
    if (facts.watchers.length) emit(`HANDOVER_WATCHERS_OK ${facts.watchers.map((w) => w.name).join(",")} for ${to.pane}`);
  }
  const routed = await deps.routedPane();
  if (routed !== to.pane) return { reasons: [`lanes would still report to ${routed || "(no leadPane)"}, not ${to.pane}`], session };
  const report = deps.nonce();
  const inbox = deps.nonce();
  const ack = (id: string) => `dori handover ack ${id} --state ${deps.config.stateDir}`;
  // the probes go in once the new lead's first turn (reading the note) has ended, as a lane's does (lane-handover.ts verifyLane)
  for (; i < tries && turnRunning(await captureTmux(deps.run, to.pane)); i++) await deps.clock.sleep(POLL_MS);
  if (i >= tries) return { reasons: [`the first turn of ${to.pane} was still running after ${verifyMin} min; the probes were not sent`], session };
  const line = `[REPORT] handover-probe | milestone | ${PROBE} ${report}: run ${ack(report)}`;
  if (!(await sendVerified(deps.run, deps.clock, deps.config, routed, line))) return { reasons: [`the report probe did not reach ${routed}`], session };
  appendFileSync(deps.inbox, `${JSON.stringify({ ts: iso(deps.clock), id: `handover-${inbox}`, scope: "channel", kind: "handover-probe", content: `${PROBE} ${inbox}: run ${ack(inbox)}` })}\n`);
  emit(`HANDOVER_PROBES_SENT report=${report} inbox=${inbox} (${deps.inbox})`);
  let problems: string[] = [];
  for (; i < tries; i++) {
    problems = [ackProblem(deps.config.stateDir, report, "report probe", to.pane), ackProblem(deps.config.stateDir, inbox, "inbox probe", to.pane)].filter((p): p is string => !!p);
    if (!problems.length) break;
    await deps.clock.sleep(POLL_MS);
  }
  if (problems.length) return { reasons: problems, session };
  // No restatement before the commit (owner Q476, 2026-11-03): the probes' acks show the new lead reads its pane and its
  // inbox and runs dori; the note carries the owner's words word for word, and the audit after the commit checks the rest.
  // checked again before the old lead goes: a monitor that ran at the first check can end before the move commits (a
  // remote tail whose ssh dropped), and a new session is not told when a monitor ends
  const stopped = facts.monitors.length ? missingMonitors(facts.monitors, readManifest(manifestPath(deps.config.sessionsDir, facts.cwd, session)), deps.alive, deps.home, deps.clock.now()) : [];
  if (stopped.length) return { reasons: [`monitors stopped in ${to.pane} after the first check: ${stopped.join(", ")}`], session };
  return { reasons: [], session };
};

export type HandoverResult = { readonly code: number; readonly note?: string; readonly to?: string };

export const TASKS_CANCEL = "HANDOVER_TASKS_CANCEL";
export const ENDED_TASKS_HEADING = "Background tasks of the old session ended at the handover";

// Once the move is committed, the old session's tasks that still run (background.ts strayTasks: only that session's own,
// never another session's on the same task host) are ended by the new session with task_cancel, the tool any session of
// the account can end a task with (GongDori's lead ended e7-ledger-replay's st_01a17bd9 so on 2026-10-27); dori has no
// way of its own to reach senpi's task host. What ended goes at the end of the note, with its record, so the new session
// can read what it found or run it again; one still open is a HANDOVER_TASK_ALIVE line.
export const endStrayTasks = async (deps: Pick<HandoverDeps, "run" | "clock" | "config" | "home" | "alive" | "nonce">, o: { readonly who: string; readonly session: string; readonly pane: string; readonly note: string; readonly leave?: number; readonly emit: (line: string) => void }): Promise<void> => {
  const stray = o.session ? strayTasks(deps.home, o.session, deps.alive, o.leave) : [];
  if (!stray.length) return;
  const ids = stray.map((t) => t.id);
  const id = deps.nonce();
  const ack = `dori handover ack ${id} --state ${deps.config.stateDir}`;
  const told = await sendVerified(deps.run, deps.clock, deps.config, o.pane, `[LEAD] ${TASKS_CANCEL} ${id}: ${stray.length} background task(s) of the old session still run after the move: ${stray.map((t) => `${t.id}${t.what ? ` (${t.what})` : ""}`).join("; ")}. They can still change the files you work on, and their answers go to the old session. End each one with task_cancel (task_id ${ids.join(", ")}); its record and transcript stay readable, and the note lists them, so run one again as your own task if its work is still needed. Then run ${ack} and nothing else for this line.`).catch(() => false);
  let acked: string | undefined;
  for (let j = 0; told && j < ROUND_TRIES && acked === undefined; j++) {
    await deps.clock.sleep(POLL_MS);
    acked = ackedBy(deps.config.stateDir, id);
  }
  const now = new Map(taskRecords(deps.home, o.session).map((r) => [r.id, r.status]));
  const left = strayTasks(deps.home, o.session, deps.alive, o.leave).filter((t) => ids.includes(t.id));
  // ended: cancelled now, or finished by itself while the request was on its way (its record says which)
  const ended = stray.filter((t) => !left.some((l) => l.id === t.id));
  const cancelled = ended.filter((t) => now.get(t.id) === "cancelled");
  const finished = ended.filter((t) => now.get(t.id) !== "cancelled");
  appendFileSync(o.note, ["", `## ${ENDED_TASKS_HEADING} (${stray.length})`, "Added after the commit. Each one's record and transcript stay readable; run one again as your own task if its work is still needed.", ...stray.map((t) => `- ${t.id}${t.what ? `: ${t.what}` : ""}; ${now.get(t.id) ?? t.status}${left.some((l) => l.id === t.id) ? " (still running)" : ""}; record ${t.file}`), ""].join("\n"));
  if (cancelled.length) o.emit(`HANDOVER_TASKS_CANCELLED ${o.who} ${cancelled.map((t) => `${t.id}${t.what ? ` "${t.what.slice(0, 80)}"` : ""}`).join(", ")} -> ${o.note}`);
  if (finished.length) o.emit(`HANDOVER_TASKS_ENDED ${o.who} ${finished.map((t) => `${t.id} ${now.get(t.id) ?? "gone"}`).join(", ")}: ended by themselves before the cancel -> ${o.note}`);
  if (left.length) o.emit(`HANDOVER_TASK_ALIVE ${o.who} ${left.map((t) => t.id).join(",")}: ${!told ? `the cancel request did not reach ${o.pane}` : acked === undefined ? `${o.pane} did not ack the cancel request` : "still open after the new session's task_cancel"}; they can still change files: end each with task_cancel <id> from any session of this account`);
};

// One handover at a time per state dir: two would each open a session and repoint the lead to their own.
export const takeLock = (file: string, alive: (pid: number) => boolean, at: string, what = "handover"): string | undefined => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, at }), { flag: "wx" });
      return undefined;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const held = (() => {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as { pid?: number; at?: string };
      } catch {
        return {};
      }
    })();
    if (held.pid && alive(held.pid)) return `another ${what} is running (pid ${held.pid}, started ${held.at ?? "?"}); ${file}`;
    rmSync(file, { force: true });
  }
  return `could not take the ${what} lock ${file}`;
};

type MoveContext = { readonly note: string; readonly stamp: string; readonly dir: string; readonly title: string; readonly model: string; readonly units: readonly string[]; readonly emit: (line: string) => void; readonly mark: (step: string, ok: boolean) => void; readonly supplements: Supplement[]; frozen?: FrozenRecord };

export const handover = async (deps: HandoverDeps, opts: HandoverOptions = {}): Promise<HandoverResult> => {
  const { config } = deps;
  const at = iso(deps.clock);
  const stamp = at.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const dir = join(config.stateDir, "handover");
  const emit = (line: string): void => {
    deps.print(line);
    if (!opts.dryRun) watchLog(config.watchLog, deps.clock, { source: "handover", line });
  };
  // an auto: approval without the grant of a run freshness started is borrowed: refused first, and never logged, since a
  // row approved auto: is read by freshness as its own run's result (lastAuto)
  const granted = decidedBy(opts.approvedBy?.trim() ?? "") === "auto" && takeAutoGrant(config.stateDir, "lead", "lead", opts.autoGrant, deps.clock.now());
  const borrowed = decidedBy(opts.approvedBy?.trim() ?? "") === "auto" && !granted;
  const refuse = (why: string): HandoverResult => {
    emit(`HANDOVER_REFUSED ${why}`);
    if (!borrowed && !opts.dryRun && opts.approvedBy?.trim()) appendRollover(config.stateDir, { kind: "rollover", who: "lead", at, key: "lead", from: config.leadPane, approvedBy: opts.approvedBy.trim(), signals: {}, steps: [], result: "refused", reasons: [why] });
    return { code: 2 };
  };
  if (borrowed) return refuse(`the lead moves to a new session only with an approval: ${approvalProblem(opts.approvedBy, () => undefined, { on: config.handover.autoRolloverLead, key: "handover.autoRolloverLead", granted }, "lead", "", [])} (--dry-run needs none)`);
  if (!omoSession(config)) return refuse("dori handover needs omo as the agent (backend aoe, or herdr with agentCommand omo)");
  // a herdr handover opens a new conversation; an agentCommand that picks its session itself (--continue, --session ...) would reopen the old one
  if (config.backend === "herdr" && hasSessionSelector(config.agentCommand.slice(1))) return refuse(`dori handover on herdr needs an agentCommand without a session selector (it opens a new session): ${config.agentCommand.join(" ")}`);
  if (!config.leadPane) return refuse("leadPane is not set");
  if (deps.envLeadPane) return refuse(`DORI_LEAD_PANE=${deps.envLeadPane} is set in the environment and overrides leadPane in ${deps.configPath}, so lanes would keep reporting there; remove it (also from any wrapper script) and keep the pane in the config file`);
  if (opts.note && !existsSync(opts.note)) return refuse(`note file not found: ${opts.note}`);
  const lacking = opts.note ? missingHeadings(readFileSync(opts.note, "utf8"), LEAD_SUMMARY_HEADINGS) : [];
  if (lacking.length) return refuse(`the old lead's summary ${opts.note} lacks ${lacking.map((h) => `## ${h}`).join(", ")} (dori handover --template prints the headings)`);
  // the signal of the lead's approval is the one measured for this lead session: the threshold freshness saw crossed in
  // its pane (lead-due.json) or the last rollover proposal for it (owner Q475)
  const due = (() => {
    try {
      return JSON.parse(readFileSync(join(config.stateDir, "handover", "lead-due.json"), "utf8")) as { pane: string; crossed: string[] };
    } catch {
      return undefined;
    }
  })();
  const filled = filledApproval(opts.approvedBy, measuredSignal({ pane: config.leadPane, ...(due?.pane && Array.isArray(due.crossed) ? { due } : {}), proposal: lastProposal(readRollovers(config.stateDir), "lead") }));
  if (filled) {
    emit(`HANDOVER_APPROVAL_FILLED lead: ${JSON.stringify(filled)} (the signal read from the records)`);
    opts = { ...opts, approvedBy: filled };
  }
  // a dry run needs no approval, but a given one is checked the same way, so it can be tried before the real run
  const unapproved = opts.dryRun && !opts.approvedBy?.trim() ? undefined : approvalProblem(opts.approvedBy, (id) => new QuestionStore(deps.cardDir).get(id), { on: config.handover.autoRolloverLead, key: "handover.autoRolloverLead", granted }, "lead", config.leadPane, readRollovers(config.stateDir), Boolean(deps.reportOwner), inboxMessages(deps.inbox, deps.ownerIds ?? []));
  if (unapproved) return refuse(`the lead moves to a new session only with an approval: ${unapproved} (--dry-run needs none)`);
  if (opts.dryRun && opts.approvedBy?.trim()) emit(`HANDOVER_APPROVAL_OK ${JSON.stringify(opts.approvedBy.trim())}`);
  const old = sessionFor(await liveSessions(deps.run), config.leadPane);
  if (!old) return refuse(`no live session for leadPane ${config.leadPane}`);
  const bad = config.handover.watchers.find((w) => !w.name || !Array.isArray(w.check) || !w.check.length);
  if (bad) return refuse(`handover.watchers entry ${JSON.stringify(bad)} needs a name and a check argv`);
  const session = await deps.sessionOf(config.leadPane, old.path).catch(() => "");
  const sessionDir = sessionDirFor(config.sessionsDir, old.path);
  const manifest = session ? manifestPath(config.sessionsDir, old.path, session) : "";
  const entries = manifest ? readManifest(manifest) : [];
  const now = deps.clock.now();
  const leadScreen = await captureTmux(deps.run, config.leadPane);
  const status = leadScreen.split("\n").slice(leadScreen.split("\n").findLastIndex((l) => l === inputLine(leadScreen)) + 1).join("\n");
  const pct = /\b\d+(?:\.\d+)?[KMG]?\/\d+(?:\.\d+)?[KMG]?\s+\((\d+(?:\.\d+)?)%\)/.exec(status)?.[1];
  const blockedTurns = compactionStuckOn(leadScreen);
  const signals: Signals = { ...(pct ? { contextPct: Number(pct) } : {}), ...sessionSignals(sessionDir, session, now), ...(blockedTurns ? { compactionStuck: blockedTurns } : {}) };
  const real = deps.realpath(old.path);
  const cwd = config.handover.cwd || real;
  if (real !== old.path) emit(`HANDOVER_CWD_SYMLINK the old lead runs from ${old.path}, a symlink to ${real}; the new session opens in ${cwd}${config.handover.cwd ? " (handover.cwd)" : " (set handover.cwd to choose another)"}`);
  const known: HandoverFacts = {
    from: { pane: config.leadPane, aoeId: old.id, session, title: old.title, cwd: old.path },
    cwd,
    lanes: await deps.registry.open(),
    monitors: liveMonitors(entries, now, deps.alive, deps.home),
    watchers: config.handover.watchers,
    cards: new QuestionStore(deps.cardDir).all().filter((q) => q.status === "open"),
    todos: session ? openTodos(sessionDir, session) : [],
    worklog: worklogFacts(config.stateDir),
    goal: session ? openGoal(sessionDir, session) : undefined,
    timers: await deps.timers().catch(() => []),
    leadNote: opts.note ? readFileSync(opts.note, "utf8") : "",
    ownerWords: recentOwnerWords(deps.inbox, deps.ownerIds ?? [], now),
    ...(session && sessionFile(sessionDir, session) ? { oldLog: sessionFile(sessionDir, session) } : {}),
  };
  const quotes = conversationQuotes(deps, known.oldLog, [known.leadNote, ...known.ownerWords.map((w) => w.text)].join("\n"));
  const facts: HandoverFacts = { ...known, ...(quotes.length ? { quotes } : {}) };
  const down = await missingWatchers(deps, facts.watchers, { pane: config.leadPane, session });
  if (down.length) return refuse(`configured watchers not running for ${config.leadPane}: ${down.join(", ")}; start them or fix handover.watchers before the handover`);
  if (!facts.monitors.length && !facts.watchers.length && !opts.noMonitors) {
    const where = session ? `in ${manifest}` : `(its omo session could not be told from the process under ${config.leadPane})`;
    return refuse(`no running monitor found for ${config.leadPane} ${where}; arm them first, list outside watchers in handover.watchers, or pass --no-monitors`);
  }
  mkdirSync(dir, { recursive: true });
  const note = join(dir, `${stamp}.md`);
  writeFileSync(note, renderNote(facts, at));
  writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(facts, null, 1));
  emit(`HANDOVER_NOTE ${note}: ${facts.lanes.length} lanes, ${facts.monitors.length} monitors, ${facts.watchers.length} watchers, ${facts.cards.length} open questions, ${facts.todos.length} todos, ${facts.worklog?.open ?? 0} open worklog items, ${facts.timers.length} timers, ${facts.ownerWords.length} owner messages, ${facts.quotes?.length ?? 0} quotes from the old conversation, old log ${facts.oldLog ? "yes" : "no"}${opts.note ? "" : "; HANDOVER_NO_LEAD_NOTE (pass --note FILE with your summary, dori handover --template)"}`);
  const units = config.handover.services.length ? config.handover.services : config.update.services.map((s) => s.unit);
  const model = opts.model || config.handover.model || config.defaultModel;
  const title = opts.title || config.handover.title || `${old.title.replace(/-\d{8}$/, "")}-${stamp.slice(4, 8)}${stamp.slice(9, 13)}`;
  if (opts.dryRun) {
    deps.print(`HANDOVER_DRY_RUN would open ${config.backend} session "${title}" in ${cwd} (${model}), point leadPane and ${facts.lanes.length} lanes at it, restart ${units.join(",") || "no units"}, check ${facts.monitors.length} monitors (${facts.monitors.map((m) => m.description || m.command || m.path).join(", ") || "none"}), ${facts.watchers.length} watchers (${facts.watchers.map((w) => w.name).join(", ") || "none"}) and two probes within ${opts.verifyMin ?? config.handover.verifyMin} min, then ${opts.keepOld ? "keep" : "close"} ${config.leadPane}`);
    return { code: 0, note };
  }
  const lockFile = join(dir, "lock");
  const busy = takeLock(lockFile, deps.alive, at);
  if (busy) return refuse(busy);
  const steps: Step[] = [];
  let last = deps.clock.now();
  const mark = (step: string, ok: boolean) => {
    const t = deps.clock.now();
    steps.push({ step, ms: t - last, ok });
    last = t;
  };
  let r: HandoverResult = { code: 3, note };
  const supplements: Supplement[] = [];
  const ctx: MoveContext = { note, stamp, dir, title, model, units, emit, mark, supplements };
  try {
    r = await moveLead(deps, opts, facts, ctx);
    return r;
  } finally {
    rmSync(lockFile, { force: true });
    // the old lead may talk again once it is closed or stays the lead; with --keep-old it stays quiet until the mark expires
    // (and when the close failed: it is still open but no longer the lead)
    if (!(r.code === 1 || (r.code === 0 && opts.keepOld))) clearQuiet(config.stateDir, config.leadPane);
    const proposal = lastProposal(readRollovers(config.stateDir), "lead");
    const ref = opts.approvedBy?.trim() ?? "";
    const by = ref ? decidedBy(ref) : undefined;
    const reason = by === "lead" ? ref.slice(LEAD_PREFIX.length).trim() : by === "auto" ? autoReason("lead", signals, config.handover) : undefined;
    const ownerText = ownerRolloverText({ who: "lead", cause: rolloverCause(ref, signals, limitsFor("lead", config.handover)), ...(ctx.frozen ? { frozenH: ctx.frozen.closeAt ? config.handover.frozenCloseH : null } : {}) }, config.discord.locale);
    const ownerReport = (by === "lead" || by === "auto") && r.to && r.code !== 3 ? await reportToOwner(deps, "lead", null, ownerText, emit) : undefined;
    appendRollover(config.stateDir, {
      kind: "rollover", who: "lead", at, key: "lead", from: config.leadPane, ...(r.to ? { to: r.to } : {}), ...(ref ? { approvedBy: ref } : {}),
      ...(by ? { decidedBy: by } : {}), ...(reason ? { reason } : {}), ...(ownerReport ? { ownerReport } : {}),
      ...(proposal ? { proposedAt: proposal.at, approvalMin: Math.round((Date.parse(at) - Date.parse(proposal.at)) / 6_000) / 10 } : {}),
      signals, steps, result: r.code === 0 ? (ctx.frozen ? "done-frozen" : opts.keepOld ? "done-kept-old" : "done") : r.code === 1 ? "done-close-failed" : "rolled-back", reasons: steps.filter((st) => !st.ok).map((st) => st.step),
      ...(ctx.frozen ? { frozen: { pids: ctx.frozen.pids.length, closeAt: ctx.frozen.closeAt ?? null } } : {}),
      ...(supplements.length ? { supplementRounds: supplements.length, supplements } : {}),
    });
  }
};

const moveLead = async (deps: HandoverDeps, opts: HandoverOptions, facts: HandoverFacts, ctx: MoveContext): Promise<HandoverResult> => {
  const { config } = deps;
  const { note, stamp, dir, title, model, units, emit, mark } = ctx;
  const tell = (pane: string, text: string) => sendVerified(deps.run, deps.clock, config, pane, text).catch(() => false);
  let pane: string;
  try {
    // the lead is no lane: it never starts with launchEnv, even when the handover runs from a lane's environment
    // the new lead opens in this Dori's backend: a herdr Dori's next to the old herdr lead (its workspace), an aoe lead moves to herdr once the config says so
    const workspace = config.backend === "herdr" && isHerdrPane(facts.from.pane) ? sessionFor(await liveSessions(deps.run), facts.from.pane)?.profile : undefined;
    pane = await openAoeSession(deps.run, deps.clock, { title, cwd: facts.cwd, tool: config.agentCommand[0] ?? "omo", agentCommand: config.agentCommand, model, env: laneEnv(config.launchEnv, true), backend: config.backend, ...(workspace ? { workspace } : {}) });
    mark("open", true);
  } catch (e) {
    mark("open", false);
    emit(`HANDOVER_FAIL could not open the new session: ${e instanceof Error ? e.message : String(e)}; nothing moved, ${config.leadPane} stays the lead`);
    return { code: 3, note };
  }
  const startup = await awaitPrompt(deps, pane);
  mark("startup", !startup);
  if (startup) {
    emit(`HANDOVER_FAIL new session ${pane}: ${startup}; nothing moved, ${config.leadPane} stays the lead`);
    return { code: 3, note, to: pane };
  }
  setQuiet(config.stateDir, config.leadPane, deps.clock.now() + ((opts.verifyMin ?? config.handover.verifyMin) + 10) * 60_000, `the handover of the lead to ${pane} is running`);
  await tell(config.leadPane, `[LEAD] Handover to ${pane} started (note ${note}). Stay quiet now: do not answer the owner or act on inbox, lane or session events, and ignore ${PROBE} lines. If the handover fails you are told and stay the lead.`);
  if (!(await sendVerified(deps.run, deps.clock, config, pane, `${config.handover.prompt}. Read the handover note at ${note} in full and do what it says, starting with its first section.`))) {
    await tell(config.leadPane, `[LEAD] Handover to ${pane} failed before anything moved: its first message did not register. You stay the lead.`);
    emit(`HANDOVER_FAIL the first message did not register in ${pane}; nothing moved, ${config.leadPane} stays the lead`);
    return { code: 3, note, to: pane };
  }
  const to: Target = { pane, aoeId: sessionFor(await liveSessions(deps.run), pane)?.id ?? "", session: "" };
  emit(`HANDOVER_STARTED ${config.leadPane} -> ${pane}`);
  const restartAll = async (): Promise<string[]> => {
    const failed: string[] = [];
    for (const unit of units) {
      const why = await deps.restart(unit);
      emit(why ? `HANDOVER_RESTART_FAIL ${unit} ${why}` : `HANDOVER_RESTARTED ${unit}`);
      if (why) failed.push(`restart of ${unit} failed: ${why}`);
    }
    return failed;
  };
  for (const line of await pointLead(deps, facts.from, to, stamp)) emit(line);
  const restartFailures = await restartAll();
  mark("repoint", !restartFailures.length);
  const checked: Checked = restartFailures.length ? { reasons: restartFailures, session: "" } : await verify(deps, facts, to, opts.verifyMin ?? config.handover.verifyMin, join(dir, `${stamp}.understood.md`), emit);
  ctx.supplements.push(...(checked.supplements ?? []));
  if (!restartFailures.length) mark("verify", !checked.reasons.length);
  const record = (result: string, reasons: readonly string[]) => writeFileSync(join(dir, `${stamp}.result.json`), JSON.stringify({ at: iso(deps.clock), from: facts.from, to: { ...to, session: checked.session }, note, result, reasons }, null, 1));
  if (checked.reasons.length) {
    emit(`HANDOVER_VERIFY_FAIL ${pane}: ${checked.reasons.join("; ")}`);
    for (const line of await pointLead(deps, to, facts.from, stamp)) emit(line);
    await restartAll();
    await tell(config.leadPane, `[LEAD] Handover to ${pane} failed (${checked.reasons.join("; ")}). You stay the lead: answer the owner and handle events again.`);
    await tell(pane, `[LEAD] HANDOVER_ROLLED_BACK: the handover failed (${checked.reasons.join("; ")}); ${config.leadPane} stays the lead. You are not the lead: do nothing more.`);
    emit(`HANDOVER_ROLLED_BACK ${config.leadPane} stays the lead; ${pane} is left open to look at (aoe rm it when done)`);
    record("rolled-back", checked.reasons);
    return { code: 3, note, to: pane };
  }
  if (facts.from.session && checked.session) new QuestionStore(deps.cardDir).retarget({ session: facts.from.session }, { session: checked.session });
  // committed: the old lead is frozen, not closed, so it spends no tokens and does nothing while its pane and log stay.
  // A rolled-back move never gets here, and before this point it was only told to stay quiet.
  // work a monitor of the old lead started goes on: those monitors are not stopped, and the session closes once it ended
  const work = facts.from.session ? monitorWork(readManifest(manifestPath(config.sessionsDir, facts.from.cwd, facts.from.session)), await deps.procs(), deps.clock.now(), deps.alive, deps.home) : [];
  for (const line of await endOldMonitors(deps, facts, work.map((j) => j.pid))) emit(line);
  const ice = await freezePane(deps, config.leadPane, process.pid, work.map((j) => j.pid)).catch((e: unknown) => ({ pids: [] as number[], agentPid: undefined, why: e instanceof Error ? e.message : String(e) }));
  mark("freeze", !!ice.agentPid);
  if (ice.agentPid) {
    const h = config.handover.frozenCloseH;
    const closeAt = !opts.keepOld && h > 0 ? new Date(deps.clock.now() + h * 3_600_000).toISOString() : undefined;
    const keepFor = work.flatMap((j) => j.pids);
    if (keepFor.length) emit(`HANDOVER_WORK_KEPT ${config.leadPane}: the work its monitors started still runs (${work.map((j) => `${j.cmd.slice(0, 60)}: ${j.pids.join(",")}`).join("; ")}); those monitors are left running and the old session closes once that work ended`);
    const rec: FrozenRecord = { pane: config.leadPane, aoeId: facts.from.aoeId, at: iso(deps.clock), agentPid: ice.agentPid, pids: ice.pids, ...(closeAt ? { closeAt } : {}), ...(keepFor.length ? { keepFor } : {}), to: pane, ...(facts.from.session ? { session: facts.from.session } : {}), ...(facts.oldLog ? { oldLog: facts.oldLog } : {}) };
    writeFrozen(config.stateDir, rec);
    ctx.frozen = rec;
    emit(`HANDOVER_OLD_FROZEN ${config.leadPane} agent ${ice.agentPid}: ${ice.pids.length} processes stopped (${ice.pids.join(",")}); ${closeAt ? `closes at ${closeAt} (handover.frozenCloseH ${h})` : "kept until closed by hand"}; dori handover thaw ${config.leadPane} resumes it; log ${facts.oldLog ?? "-"}`);
    emit(`HANDOVER_DONE ${config.leadPane} -> ${pane}; old session frozen`);
    record("done-frozen", []);
    await tell(pane, `[LEAD] ${COMMITTED}: the handover is checked and the old session ${config.leadPane} is frozen (its processes are stopped, its log stays); you are the lead now. Go on with step 5 of the note.`);
    emit(`${COMMITTED} lead ${pane}`);
    // a task in the frozen agent is stopped with it; one in the shared task host is not
    await endStrayTasks(deps, { who: "lead", session: facts.from.session, pane, note, leave: ice.agentPid, emit });
    return { code: 0, note, to: pane };
  }
  emit(`HANDOVER_FREEZE_FAIL ${config.leadPane}: ${ice.why ?? "nothing stopped"}${ice.pids.length ? ` (stopped ${ice.pids.join(",")}, resumed)` : ""}; ${opts.keepOld ? "it stays open, told to stay idle" : "closing it instead"}`);
  for (const p of [...ice.pids].reverse()) deps.signal(p, "SIGCONT");
  if (opts.keepOld) {
    await tell(config.leadPane, `[LEAD] Handover to ${pane} is done and checked. You are no longer the lead; stay idle until the lead closes you.`);
    await tell(pane, `[LEAD] ${COMMITTED}: the handover is checked and ${config.leadPane} stays open but idle; you are the lead now. Go on with step 5 of the note.`);
    emit(`HANDOVER_DONE ${config.leadPane} -> ${pane}; old session kept (--keep-old)`);
    record("done-kept-old", []);
    await endStrayTasks(deps, { who: "lead", session: facts.from.session, pane, note, emit });
    return { code: 0, note, to: pane };
  }
  emit(`HANDOVER_DONE ${config.leadPane} -> ${pane}; closing ${config.leadPane}`);
  record("done", []);
  const closed = await closeAoeSession(deps.run, config.leadPane);
  const ok = isClosedLine(closed);
  mark("close", ok);
  emit(ok ? `HANDOVER_CLOSED ${closed}` : `HANDOVER_CLOSE_FAIL ${closed}`);
  await tell(pane, `[LEAD] ${COMMITTED}: the handover is checked and the old session ${ok ? "is closed" : `${config.leadPane} did not close but stays idle`}; you are the lead now. Go on with step 5 of the note.`);
  emit(`${COMMITTED} lead ${pane}`);
  await endStrayTasks(deps, { who: "lead", session: facts.from.session, pane, note, emit });
  return { code: ok ? 0 : 1, note, to: pane };
};

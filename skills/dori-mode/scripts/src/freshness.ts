import { repeatTick } from "./auto-signals.ts";
import { type DoriConfig, fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { runOwnerCheck } from "./owner-check.ts";
import { researchCheck, stuckTop } from "./explore.ts";
import { paneTranscript, readScreen, sendVerified } from "./panes.ts";
import { type Lane, type RolloverDue, statusOf } from "./registry.ts";
import { fixTag, recordFix } from "./same-fix.ts";
import { leadAlert } from "./autoturn.ts";
import { taskOpen, taskRecord } from "./background.ts";
import { compactionStuckOn, pendingFile, type ReadyMark, readyFile, statusLine } from "./lane-handover.ts";
import { COMMITTED, crossed, dueReasons, limitsFor, readRollovers, type RolloverEntry, type Signals, type Who } from "./rollover.ts";
import { auditDue, type Committed, weeklyDue, writeMarker } from "./rollover-audit.ts";
import { dailyAuditSince, linksDue } from "./directive-audit.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchLog } from "./watch-log.ts";

// Any status word counts as hearing from the lane (pingpong-analytics reports "| working |"); the footer's placeholder
// "| <milestone|...> | <one plain line ..." never does, nor a template line a lane's code prints before filling it in
// (echo "[REPORT] <key> | milestone | ${message}", f"... | {message}"): issue #22 of dori-superagent
// (https://github.com/sisyphuslabs/dori-superagent/issues/22, MIT), where the template on screen was posted as the report.
const reportGrammar = (key: string): RegExp => new RegExp(`\\[REPORT\\] ${key.replace(/[.]/g, "\\.")} \\| [a-z]+ \\| (?!<)(?!.*(?:\\$\\{\\w|\\{\\w+\\}))\\S`);

// A report the agent UI wrapped over several lines continues until the next blank line.
export const lastReportLine = (screen: string, key: string): string | null => {
  const grammar = reportGrammar(key);
  const lines = screen.split("\n");
  const at = lines.findLastIndex((l) => grammar.test(l));
  if (at < 0) return null;
  const parts = [lines[at]?.slice(lines[at]?.indexOf("[REPORT]")) ?? ""];
  for (const l of lines.slice(at + 1, at + 8)) {
    if (!l.trim() || l.includes("[REPORT]")) break;
    parts.push(l);
  }
  return parts.map((p) => p.trim()).join(" ").replace(/["'\])\s,]+$/, "");
};

// A report a lane typed into the lead (dori type) is a user message of the lead's transcript, whole and unwrapped, while
// the lead's screen is omo's alternate screen: tmux keeps no history there, so a report is gone from it once omo's tail
// under a turn fills the rows. The newest one counts, its first line only (the evidence sits below it); a line the lead
// wrote or a [DORI] note quoting a report is not one.
export const transcriptReport = (lines: readonly string[], key: string): string | null => {
  const head = `[REPORT] ${key} |`;
  const grammar = reportGrammar(key);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (!line.includes(head)) continue;
    let said = "";
    try {
      const o = JSON.parse(line) as { message?: { role?: string; content?: unknown } };
      if (o.message?.role !== "user") continue;
      const c = o.message.content;
      said = typeof c === "string" ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? "").join("\n") : "";
    } catch {
      continue;
    }
    const hit = said.split("\n").findLast((l) => l.trimStart().startsWith(head) && grammar.test(l));
    if (hit) return hit.trim();
  }
  return null;
};

export const scrubForThread = (line: string, home: string): string =>
  line
    .replace(/^\[REPORT\]\s*[^|]*\|\s*[^|]*\|\s*/, "")
    .split(home).join("~")
    .replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)")
    .replace(/\bw\w+:p\w+\b/g, "(pane)")
    .replace(/`/g, "'")
    .trim();

export type SweepAct = { readonly kind: "nudged" | "nudge-failed" | "posted" | "no-report" | "stuck" | "research_started" | "research_not_started" | "rollover_due" | "rollover_auto" | "rollover_audit" | "audit_summary" | "lead_compaction_stuck" | "directive_audit" | "directive_links"; readonly lane: string; readonly detail: string };

export type RolloverHooks = {
  // the length signals of the session in a pane: context use, compactions, age
  readonly signals: (pane: string, model: string) => Promise<Signals>;
  // starts a rollover without asking (handover.autoRolloverLanes / autoRolloverLead on); the line says what it started
  readonly auto?: (who: Who, key: string) => Promise<string>;
  // whether a process still runs (a handover's lock holder, the chain pids a refusal named); process.kill(pid, 0) by default
  readonly alive?: (pid: number) => boolean;
  // whether a background task (st_...) a refusal named has ended: its senpi record under home has a final status (a task
  // without a record has not ended)
  readonly taskEnded?: (id: string) => boolean;
  // starts the audit of a committed handover (dori handover audit, detached); the line says what it started
  readonly audit?: (c: Committed) => Promise<string>;
  // puts the week's audit summary in the lead's inbox; the line says what it wrote
  readonly auditSummary?: (week: string) => string;
  // the daily directive audit (dori directive-audit from `since`), so it runs on every Dori with no timer of its own
  readonly directiveAudit?: (since: string) => Promise<readonly string[]>;
  // pushes the owner's message links of the local ledger to the other Dori (directives.linkPeers)
  readonly directiveLinks?: () => Promise<readonly string[]>;
  // the lead's omo transcript, where each report a lane typed into the lead sits (read first, before the screens);
  // undefined when there is none (backend herdr, no leadPane, no session file)
  readonly leadTranscript?: () => Promise<string | undefined>;
};

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};

// A handover of this lane (or of the lead) runs now: its lock or its journal names a live process.
const handoverRunning = (stateDir: string, who: Who, key: string, alive: (pid: number) => boolean): boolean =>
  (who === "lane" ? [join(stateDir, "handover", "lanes", `${key}.lock`), pendingFile(stateDir, key)] : [join(stateDir, "handover", "lock")]).some((f) => {
    const pid = readJson<{ pid?: number }>(f)?.pid;
    return typeof pid === "number" && pid !== process.pid && alive(pid);
  });

type Attempt = Extract<RolloverEntry, { kind: "rollover" }>;

// The record of the automatic run started at autoAt: the last automatic rollover entry of this lane (or the lead) since.
const lastAuto = (stateDir: string, who: Who, key: string, since: string): Attempt | undefined =>
  readRollovers(stateDir).findLast((e): e is Attempt => e.kind === "rollover" && e.who === who && e.key === key && (e.approvedBy ?? "").startsWith("auto:") && e.at >= since);

// what the lane is asked when an automatic rollover finds it busy: reach a safe point, write the summary, mark ready, go idle
export const safePointText = (key: string, why: string): string =>
  `[LEAD] An automatic rollover of ${key} to a new session is due, but the lane is busy (${why}). At your next safe point: start no new work, write your conversation summary (dori handover ready --template prints its headings) to a file, run dori handover ready ${key} --note <file>, then end your turn.${/background task\(s\) still run/.test(why) ? " The ready mark does not cover your background tasks: the move waits until they end, so start no new ones and let these finish (or end them yourself if their work is no longer needed)." : ""} The local chains that command lists end with this session: if one must keep running (a training, eval or deploy run), let it finish or move it out of the session (setsid, systemd-run) first, and say so in your report. The move starts by itself once you are idle; nothing else to do.`;

const screenSignals = (deps: FlowDeps): RolloverHooks => ({
  signals: async (pane, model) => {
    const screen = await readScreen(deps.run, deps.config.backend, pane, 40);
    const blockedTurns = compactionStuckOn(screen);
    return { contextPct: statusLine(screen, model).contextPct, ...(blockedTurns ? { compactionStuck: blockedTurns } : {}) };
  },
});

// A lead whose compaction did not complete reads nothing freshness types into it, and its ROLLOVER_DUE line lands in a log
// only that lead reads: when nothing moves it (the auto key is off, or the automatic handover was refused or failed: a
// misnamed handover.watchers entry refuses every run), the pair channel hears of it once per lead pane (postLeadAlert).
const leadStuckFile = (stateDir: string): string => join(stateDir, "handover", "lead-compaction-stuck.json");
const leadStuckAlert = async (deps: FlowDeps, hooks: RolloverHooks, pane: string, model: string, due: RolloverDue | undefined): Promise<SweepAct[]> => {
  const n = (await hooks.signals(pane, model).catch((): Signals => ({}))).compactionStuck ?? 0;
  const file = leadStuckFile(deps.config.stateDir);
  if (!n || readJson<{ pane?: string }>(file)?.pane === pane) return [];
  const last = due?.pane === pane && due.autoAt ? lastAuto(deps.config.stateDir, "lead", "lead", due.autoAt) : undefined;
  const why = !deps.config.handover.autoRolloverLead
    ? "the automatic lead rollover is off (handover.autoRolloverLead)"
    : last && last.result !== COMMITTED
      ? `the automatic handover ended ${last.result}${last.reasons[0] ? `: ${last.reasons[0].slice(0, 240)}` : ""}`
      : "";
  if (!why) return [];
  const since = due?.pane === pane ? due.at : new Date(deps.clock.now()).toISOString();
  const lines = await leadAlert(deps, { head: "LEAD_COMPACTION_STUCK", pane, turns: n, template: deps.config.discord.leadCompactionStuckText, since, reason: why });
  if (lines.some((l) => l.startsWith("LEAD_ALERT_POSTED "))) {
    mkdirSync(join(deps.config.stateDir, "handover"), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ pane, at: new Date(deps.clock.now()).toISOString() })}\n`);
  }
  return [{ kind: "lead_compaction_stuck", lane: "lead", detail: `${pane} answers with "compaction did not complete" (${n}x on its screen) and was not moved: ${why}; ${lines.join("; ") || "no pair or owner channel to alert (postLeadAlert unset)"}` }];
};

const leadDueFile = (stateDir: string): string => join(stateDir, "handover", "lead-due.json");

// A session past a measured threshold (context, compactions, age) is due for a rollover. Freshness says so once per pane
// and only suggests: the lead decides and runs the handover with --approved-by lead:<reason and signal>, unless the owner
// turned the auto key on. A stuck lane's rollover point is rung 4 of the stuck ladder, which has its own STUCK line.
// With the auto key on, rung 4 of the stuck ladder is a reason too, and a session still in the same pane is started again
// from what the last automatic run left in the rollover log, never on a fixed clock and never given up: a lane that stayed
// busy is asked to reach a safe point and started again at once (the run waits for its idle moment); a lane whose chain or
// eval cell would die, or whose background tasks still run, is asked, and started again when it marks ready, when those
// chains and tasks ended, or after autoRetryMin (tasks still running refuse every start; the lead hears of it once); a
// move that failed is started again after autoRetryMin, doubling while failures go on (up to 8 times). Only a training or
// eval chain stops it: the lead moves that lane (the owner's rule). A refusal goes to the watch log only
// (HANDOVER_REFUSED); the owner hears of a move that happened.
const rolloverDue = async (deps: FlowDeps, hooks: RolloverHooks, who: Who, key: string, pane: string, model: string, seen: RolloverDue | undefined, stuck: Signals["stuck"], save: (due: RolloverDue) => Promise<void>): Promise<SweepAct[]> => {
  const h = deps.config.handover;
  if (deps.config.backend !== "aoe") return [];
  const auto = (who === "lane" ? h.autoRolloverLanes : h.autoRolloverLead) ? hooks.auto : undefined;
  const limits = limitsFor(who, h);
  const reasons = async (): Promise<string[]> => {
    const signals: Signals = await hooks.signals(pane, model).catch(() => ({}));
    return auto ? dueReasons({ ...signals, ...(stuck ? { stuck } : {}) }, limits) : crossed(signals, limits);
  };
  const now = deps.clock.now();
  const at = new Date(now).toISOString();
  if (seen?.pane === pane) {
    if (!auto || seen.leftToLead) return [];
    // due while the key was off (only the ROLLOVER_DUE line so far): the first automatic start, now that it is on
    if (!seen.autoAt) {
      const hit = await reasons();
      if (!hit.length) return [];
      await save({ ...seen, autoAt: at, tries: 1 });
      return [{ kind: "rollover_auto", lane: key, detail: `${hit.join(", ")}: ${await auto(who, key)}` }];
    }
    const alive = hooks.alive ?? pidAlive;
    const stateDir = deps.config.stateDir;
    if (handoverRunning(stateDir, who, key, alive)) return [];
    const retryMs = h.autoRetryMin * 60_000;
    const last = lastAuto(stateDir, who, key, seen.autoAt);
    const acts: SweepAct[] = [];
    let failures = 0;
    if (!last) {
      // started but nothing logged yet (still starting) or the run died before it logged: start again after autoRetryMin
      if (now - Date.parse(seen.autoAt) < retryMs) return [];
    } else if (last.result === "refused" && (last.blocked === "work" || last.blocked === "busy")) {
      // the lane was busy: ask it once per autoRetryMin to reach a safe point, then start again when it can move
      if (who === "lane" && (!seen.askedAt || now - Date.parse(seen.askedAt) >= retryMs)) {
        const why = (last.reasons[0] ?? "").replace(/\. Ask the lane to reach a safe point.*$/, "");
        const told = await sendVerified(deps.run, deps.clock, deps.config, pane, safePointText(key, why));
        seen = { ...seen, askedAt: at };
        await save(seen);
        acts.push({ kind: "rollover_auto", lane: key, detail: `asked ${pane} to reach a safe point and write its summary (${why})${told ? "" : `; the request did not reach pane ${pane}`}` });
      }
      if (last.blocked === "work") {
        const mark = readJson<ReadyMark>(readyFile(stateDir, key));
        const readied = mark?.pane === pane && mark.at > last.at;
        const pids = last.pids ?? [];
        const tasks = last.tasks ?? [];
        const taskEnded = hooks.taskEnded ?? (() => false);
        // the old session's tasks still run after a start that came back (its ready mark covers none): the move waits for
        // them, and the lead hears of it once in this pane, with what it can do
        const running = tasks.filter((id) => !taskEnded(id));
        if (who === "lane" && running.length && (seen.tries ?? 1) >= 2 && !seen.tasksToldAt) {
          const lead = deps.config.leadPane;
          const text = `[DORI] ${key}: the automatic rollover is held: background task(s) ${running.join(", ")} of the old session still run, and a move would leave them editing the lane's files out of the new session's reach. It moves by itself once they end. To move it sooner, ask the lane to let them finish or end them, or run dori handover --lane ${key} --approved-by "lead:<reason and signal>" --force (their answers then go to the old session).`;
          const told = lead ? await sendVerified(deps.run, deps.clock, deps.config, lead, text) : false;
          seen = { ...seen, tasksToldAt: at };
          await save(seen);
          acts.push({ kind: "rollover_auto", lane: key, detail: `held by the old session's background tasks ${running.join(", ")}; ${!lead ? "lead not told: leadPane is not configured" : told ? "lead told" : `lead not told: the note did not reach pane ${lead}`}` });
        }
        const ended = pids.length + tasks.length > 0 && pids.every((pid) => !alive(pid)) && !running.length;
        if (!readied && !ended && now - Date.parse(last.at) < retryMs) return acts;
      }
    } else if (last.result === "refused" && last.blocked === "training") {
      return [];
    } else {
      // the move failed or rolled back, or the run was refused for another reason: back off, doubling up to 8 times
      failures = (seen.failures ?? 0) + 1;
      if (now - Date.parse(last.at) < retryMs * 2 ** Math.min(3, failures - 1)) return [];
    }
    const hit = await reasons();
    if (!hit.length) return acts;
    const tries = (seen.tries ?? 1) + 1;
    await save({ ...seen, autoAt: at, tries, failures });
    return [...acts, { kind: "rollover_auto", lane: key, detail: `start ${tries} (${hit.join(", ")}${last ? `; last: ${last.result}${last.blocked ? ` ${last.blocked}` : ""}` : ""}): ${await auto(who, key)}` }];
  }
  const hit = await reasons();
  if (!hit.length) return [];
  await save({ pane, at, crossed: hit, ...(auto ? { autoAt: at, tries: 1 } : {}) });
  const run = who === "lane" ? `dori handover --lane ${key} --approved-by "lead:<reason and this signal>"` : `dori handover --approved-by "lead:<reason and this signal>"`;
  const acts: SweepAct[] = [{ kind: "rollover_due", lane: key, detail: `${hit.join(", ")} in ${pane}: decide it (dori rollover-propose ${key} shows the note); to go ahead, ${who === "lane" ? `once the lane is at a safe point (dori handover ready ${key}), ` : ""}run ${run}; the owner is told afterwards` }];
  if (auto) acts.push({ kind: "rollover_auto", lane: key, detail: await auto(who, key) });
  return acts;
};

// The line freshness prints when it starts: whether rollovers start by themselves, on what, and how often they are retried.
export const autoReadyLine = (h: DoriConfig["handover"]): string => {
  const side = (who: Who, on: boolean): string => {
    const name = who === "lane" ? "lanes" : "lead";
    if (!on) return `${name} off`;
    const l = limitsFor(who, h);
    const what = [l.contextPct > 0 ? `context >= ${l.contextPct}%` : "", l.compactions > 0 ? `compactions >= ${l.compactions}` : "", (l.afterCompactK ?? 0) > 0 ? `context after compaction >= ${l.afterCompactK}k` : "", l.ageH > 0 ? `age >= ${l.ageH} h` : "", who === "lane" ? "stuck rung 4" : ""].filter(Boolean);
    return `${name} on (${what.join(", ") || "no threshold set"})`;
  };
  const sides = `${side("lane", h.autoRolloverLanes)}, ${side("lead", h.autoRolloverLead)}`;
  return h.autoRolloverLanes || h.autoRolloverLead
    ? `ROLLOVER_AUTO_READY ${sides}; a lane moves at its idle moment (waits up to ${h.autoWaitMin} min), a busy lane is asked for a safe point first, a failed move is retried after ${h.autoRetryMin} min (doubling), with no last try; the owner is told after each move`
    : `ROLLOVER_AUTO_OFF ${sides}; rollovers wait for the lead's decision`;
};

// A milestone report that announces a new stage or phase is the moment to compare the lane's direction with the owner's goal:
// that lane's owner check goes first in the sweep.
export const stageChange = (report: string, pattern: string): boolean => /\| milestone \|/.test(report) && new RegExp(pattern, "i").test(report.replace(/^\[REPORT\][^|]*\|[^|]*\|/, ""));

const lastHeard = (lane: Lane): number => lane.lastReplyAt ?? Date.parse(lane.openedAt);

const stuckAct = (lane: string, line: string): SweepAct => ({ kind: "stuck", lane, detail: line.replace(/^STUCK \S+ /, "") });

// a lane heard from since its last owner check, past the per-lane interval: worth reading its reports again
const ownerCheckDue = (lane: Lane, now: number, minIntervalMin: number): boolean => {
  const last = lane.ownerCheck ? Date.parse(lane.ownerCheck.at) : 0;
  return (lane.lastReplyAt ?? 0) > last && now - last >= minIntervalMin * 60_000;
};

// Lanes send [REPORT] lines to the lead pane, so that is where they are read first; the lane's own screen is the fallback.
// A report not seen before counts as hearing from the lane.
export const freshnessTick = async (deps: FlowDeps, home: string, given: RolloverHooks = screenSignals(deps)): Promise<SweepAct[]> => {
  const hooks: RolloverHooks = { taskEnded: (id) => {
    const r = taskRecord(home, id);
    return r !== undefined && !taskOpen(r);
  }, leadTranscript: async () => {
    const pane = deps.config.leadPane;
    if (deps.config.backend !== "aoe" || !pane) return undefined;
    const path = await paneTranscript(deps.run, deps.config.sessionsDir, pane);
    return path ? readFileSync(path, "utf8") : undefined;
  }, ...given };
  const acts: SweepAct[] = [];
  const now = deps.clock.now();
  const staged = new Set<string>();
  let leadScreen: string | undefined;
  let leadLines: readonly string[] | undefined;
  for (const lane of await deps.registry.open()) {
    if (!lane.pane) continue;
    // a lane told "not done" keeps working: it is moved to a new session like a working one (cyto-p2-timers carried 306k
    // after its 13th compaction on 10-19 and was never started); its reports, nudges and posts stay as they were
    if (statusOf(lane) === "not-done") {
      acts.push(...(await rolloverDue(deps, hooks, "lane", lane.key, lane.pane, lane.model ?? deps.config.defaultModel, lane.rolloverDue, stuckTop(lane), (due) => deps.registry.patch(lane.key, { rolloverDue: due }))));
      continue;
    }
    if (statusOf(lane) !== "working") continue;
    leadScreen ??= deps.config.leadPane ? await readScreen(deps.run, deps.config.backend, deps.config.leadPane, 3000) : "";
    leadLines ??= await (hooks.leadTranscript?.() ?? Promise.resolve(undefined)).then((t) => t?.split("\n") ?? [], (e: unknown) => {
      watchLog(deps.config.watchLog, deps.clock, { source: "freshness", line: `FRESHNESS_WARN lead transcript not read: ${String(e).slice(0, 200)}` });
      return [];
    });
    const report = transcriptReport(leadLines, lane.key) ?? lastReportLine(leadScreen, lane.key) ?? lastReportLine(await readScreen(deps.run, deps.config.backend, lane.pane, 200), lane.key);
    let current = lane;
    if (report && report !== lane.lastReport) {
      current = { ...current, lastReport: report, lastReplyAt: now };
      await deps.registry.patch(lane.key, { lastReport: report, lastReplyAt: now });
      // the stuck ladder, from a tagged attempt and from the untagged count (reports, commits, tree): one STUCK line per rung
      const tag = fixTag(report);
      if (tag) for (const n of (await recordFix(deps, lane.key, { at: new Date(now).toISOString(), ...tag, via: "report" })).notes) acts.push(stuckAct(lane.key, n));
      try {
        for (const line of (await repeatTick(deps, (await deps.registry.read(lane.key)) ?? current)).lines) acts.push(stuckAct(lane.key, line));
      } catch (e) {
        watchLog(deps.config.watchLog, deps.clock, { source: "auto-signals", line: `AUTO_SIGNALS_WARN ${lane.key} repeat check failed: ${String(e).slice(0, 200)}` });
      }
      current = (await deps.registry.read(lane.key)) ?? current;
      if (stageChange(report, deps.config.explore.stagePattern)) staged.add(lane.key);
    }
    // a ulw research text sent to the lane: does its session log show the skill starting (RESEARCH_STARTED / _NOT_STARTED)
    if (lane.research && !lane.research.result) {
      const r = await researchCheck(deps, lane);
      if (r.verdict === "started" || r.verdict === "not-started") acts.push({ kind: r.verdict === "started" ? "research_started" : "research_not_started", lane: lane.key, detail: r.line.replace(/^RESEARCH_\w+ \S+ /, "") });
    }
    acts.push(...(await rolloverDue(deps, hooks, "lane", lane.key, lane.pane, lane.model ?? deps.config.defaultModel, current.rolloverDue, stuckTop(current), (due) => deps.registry.patch(lane.key, { rolloverDue: due }))));
    const heard = lastHeard(current);
    const silentMin = Math.round((now - heard) / 60_000);
    if (silentMin >= deps.config.nudgeAfterMin && (current.lastNudgeAt ?? 0) < heard) {
      const delivered = await sendVerified(deps.run, deps.clock, deps.config, lane.pane, `[LEAD] your work thread has had no update for ${silentMin} min. Post a 1-2 sentence progress line (done since last, next) and keep its status true.`);
      current = { ...current, lastNudgeAt: now };
      await deps.registry.patch(lane.key, { lastNudgeAt: now });
      acts.push({ kind: delivered ? "nudged" : "nudge-failed", lane: lane.key, detail: delivered ? `${silentMin} min silent` : `${silentMin} min silent; the nudge did not reach pane ${lane.pane}` });
    }
    const hook = deps.config.hooks.threadReply;
    if (silentMin >= deps.config.postAfterMin && hook && lane.thread !== "none" && (current.lastAutoReplyAt ?? 0) < heard) {
      // a report seen before still stands once it left the screens; only a lane never heard from is NO-REPORT
      const known = report ?? current.lastReport;
      if (!known) {
        acts.push({ kind: "no-report", lane: lane.key, detail: "pane has no [REPORT] line" });
        continue;
      }
      // the report is the lane's note to the lead; the owner gets a plain status line and the lead the note to retell
      const words = deps.config.discord;
      const text = words.postRawReports ? `Progress (from the lane's last report): ${scrubForThread(known, home)}` : words.quietText.replaceAll("{min}", String(silentMin));
      await deps.run(fill(hook, { thread: lane.thread, text, key: lane.key }));
      await deps.registry.patch(lane.key, { lastAutoReplyAt: now });
      let lead = "";
      if (!words.postRawReports) {
        const pane = deps.config.leadPane;
        const note = `[DORI] ${lane.key}: ${silentMin} min without a new report, so its thread got a short status line instead of the report. Tell the owner where it stands in plain words. Last report: ${known.replace(/`/g, "'").replaceAll("$(", "$ (")}`;
        lead = !pane ? "; lead not told: leadPane is not configured" : (await sendVerified(deps.run, deps.clock, deps.config, pane, note)) ? "; lead told" : `; lead not told: the note did not reach pane ${pane}`;
      }
      acts.push({ kind: "posted", lane: lane.key, detail: `${text}${lead}` });
    }
  }
  // owner-instruction check: a reviewer model reads the newest reports of a lane heard from since its last check (a lane whose
  // milestone report announced a new stage first); a finding is the stuck ladder's context rung (its STUCK line)
  const oc = deps.config.autoSignals.ownerCheck;
  if (oc.enabled) {
    let budget = oc.perTick;
    const lanes = (await deps.registry.open()).sort((a, b) => Number(staged.has(b.key)) - Number(staged.has(a.key)));
    for (const lane of lanes) {
      if (budget <= 0) break;
      if (statusOf(lane) !== "working" || !ownerCheckDue(lane, now, oc.minIntervalMin)) continue;
      const r: { readonly lines: readonly string[]; readonly skipped?: string } = await runOwnerCheck(deps, lane).catch((e: unknown) => {
        watchLog(deps.config.watchLog, deps.clock, { source: "owner-check", line: `OWNER_CHECK_FAILED ${lane.key} ${String(e).slice(0, 200)}` });
        return { lines: [] };
      });
      // a check skipped before any model call (no report in the session files yet) does not use up the sweep's budget
      if (!r.skipped?.startsWith("OWNER_CHECK_SKIP")) budget--;
      for (const line of r.lines) if (line.startsWith("STUCK ")) acts.push(stuckAct(lane.key, line));
    }
  }
  const lead = deps.config.leadPane;
  if (lead) {
    const file = leadDueFile(deps.config.stateDir);
    const seen = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RolloverDue) : undefined;
    const model = deps.config.handover.model || deps.config.defaultModel;
    acts.push(...(await rolloverDue(deps, hooks, "lead", "lead", lead, model, seen, undefined, async (due) => {
      mkdirSync(join(deps.config.stateDir, "handover"), { recursive: true });
      writeFileSync(file, JSON.stringify(due));
    })));
    acts.push(...(await leadStuckAlert(deps, hooks, lead, model, readJson<RolloverDue>(file))));
  }
  // the audit after each committed handover, once (queued before it starts, so the next sweep does not start a second one),
  // and the week's summary for the lead
  if (hooks.audit) {
    for (const c of auditDue(deps.config.stateDir, now, deps.config.handover)) {
      writeMarker(c.note, { at: new Date(now).toISOString(), status: "queued" });
      acts.push({ kind: "rollover_audit", lane: c.key, detail: `${c.stamp}: ${await hooks.audit(c)}` });
    }
  }
  const week = hooks.auditSummary ? weeklyDue(deps.config.stateDir, now, deps.config.scorecard.timeZone, deps.config.handover.auditSummaryAt) : undefined;
  if (week && hooks.auditSummary) acts.push({ kind: "audit_summary", lane: "lead", detail: hooks.auditSummary(week) });
  // links first, so a peer's audit later reads what this Dori's ledger holds now
  if (hooks.directiveLinks && linksDue(deps.config, now)) for (const detail of await hooks.directiveLinks()) acts.push({ kind: "directive_links", lane: "lead", detail });
  const since = hooks.directiveAudit ? dailyAuditSince(deps.config.stateDir, now) : undefined;
  if (since && hooks.directiveAudit) for (const detail of await hooks.directiveAudit(since)) acts.push({ kind: "directive_audit", lane: "lead", detail });
  return acts;
};

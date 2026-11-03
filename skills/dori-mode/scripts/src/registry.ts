import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import type { BudgetLimits } from "./supervision.ts";

export const LANE_KEY = /^[a-z0-9][a-z0-9._-]{1,60}$/;

// A lane's work thread: <adapter>:<id>, or "none" for a lane without one. Discord ids are numeric snowflakes.
export const NO_THREAD = "none";

export const threadRefProblem = (ref: string): string | undefined => {
  const m = /^([a-z][a-z0-9_-]*):(.*)$/.exec(ref);
  // a bare Discord id names the retry that works, so a failed launch is fixed by one edit, not by running the turn again
  if (!m) return /^\d{5,25}$/.test(ref) ? `thread "${ref}" is not <adapter>:<id> (a Discord thread is --thread discord:${ref})` : `thread "${ref}" is not <adapter>:<id>`;
  const [, adapter, id = ""] = m;
  if (!id) return `thread "${ref}" has an empty id`;
  if (/\s/.test(id)) return `thread "${ref}" has whitespace in its id`;
  if (adapter === "discord" && !/^\d{5,25}$/.test(id)) return `thread "${ref}" is not a Discord thread id (digits only)`;
  return undefined;
};

// true when the lane has a thread that a threadDone hook can act on
export const hasThread = (lane: Lane): boolean => typeof lane.thread === "string" && lane.thread !== NO_THREAD && threadRefProblem(lane.thread) === undefined;

// "paused": the lead parked the lane (e.g. it waits on the owner); no sweep nudges, posts for, or flags it until resumed.
export type LaneStatus = "working" | "done-claimed" | "verified-done" | "not-done" | "paused" | "closed";
// summary: the lane's words for the owner's thread (dori claim-done --summary), posted when the lane closes, unless posted
// names the lane's result already in that thread (its own post shortly before the claim, or --posted): then the close posts
// nothing more, so the owner does not read the result twice (owner 2026-10-21 "지금 왜 두번씩 답변하는지")
// idleAt: when dori watch first saw the lane's pane idle after the claim, cleared when a turn ran before IDLE_SETTLE_MS
export type Claim = { readonly at: string; readonly evidence: string; readonly emitted?: boolean; readonly summary?: string; readonly posted?: string; readonly idleAt?: number };
// a message the lane's own session posted in its work thread (dori send, dori thread reply|wait|done run in its pane)
export type ThreadPost = { readonly id: string; readonly at: string; readonly text: string };
export type Objection = { readonly at: string; readonly reasons: readonly string[] };
export type HistoryEntry = { readonly at: string; readonly status: LaneStatus; readonly note: string };
// one fix attempt on a failing metric, from a tagged [REPORT] or from the lead (dori fix-attempt)
// improved: the attempt before this one moved the metric, so the stuck count (dori fix-attempt --improved) starts again here
export type FixAttempt = { readonly at: string; readonly metric: string; readonly hypothesis: string; readonly via: "report" | "lead"; readonly improved?: boolean };
// a review of a lane's plan by another model family (dori challenge); file holds the review
export type ChallengeRecord = { readonly at: string; readonly model: string; readonly plan: string; readonly file: string };
// one dori fork-explore run: its saved result table
export type ExplorationRecord = { readonly at: string; readonly metric: string; readonly branches: number; readonly file: string };
// the last ulw research text sent to the lane: sentAt (ms) and probe (its start) find it in the lane's session log;
// result is set once the check decided (RESEARCH_STARTED or RESEARCH_NOT_STARTED)
// signal: the failed attempts on that metric when it was sent (the stuck count at rung 3)
export type ResearchSent = { readonly at: string; readonly sentAt: number; readonly probe: string; readonly metric: string; readonly signal: number; readonly result?: "started" | "not-started" };
// the rung one metric (or "@context", the intent check) reached on the stuck ladder, at count n, in the session of pane;
// report: for "@context", the report the last finding rested on (one report moves the rung once)
export type StuckMark = { readonly rung: number; readonly n: number; readonly at: string; readonly pane?: string; readonly report?: string };

// live: every new signal read back live when it was set
export type DoneChange = { readonly at: string; readonly from: string; readonly to: string; readonly reason: string; readonly live: boolean };

// autoAt/tries: the last automatic start in this pane and how many there were; askedAt: when the busy lane was last asked to
// reach a safe point; failures: moves in a row that failed (they back off); leftToLead: why automatic starts stopped in
// this pane (a training or eval chain, the owner's rule); tasksToldAt: when the lead was told that the old session's running
// background tasks hold the move (once per pane). gaveUp was written by older versions after autoMaxTries; it is ignored.
export type RolloverDue = { readonly pane: string; readonly at: string; readonly crossed: readonly string[]; readonly auto?: boolean; readonly autoAt?: string; readonly tries?: number; readonly askedAt?: string; readonly failures?: number; readonly leftToLead?: string; readonly gaveUp?: boolean; readonly tasksToldAt?: string };

export type Lane = {
  readonly key: string;
  readonly title: string;
  readonly thread: string;
  // why the lane was launched without a work thread (dori launch --no-thread "<reason>")
  readonly noThread?: string;
  // why the lane opened a new thread though related open threads were shown (dori launch --thread new --why-new "<reason>")
  readonly whyNew?: string;
  readonly pane?: string;
  readonly tab?: string;
  readonly session?: string;
  readonly sessionVia?: string;
  // the sessions this lane had before its current one, oldest first (a handover adds the outgoing one)
  readonly priorSessions?: readonly string[];
  readonly brief: string;
  readonly done: string;
  // every change of the Done line after launch (dori done-set): the line before and after, and why
  readonly doneChanges?: readonly DoneChange[];
  readonly cwd?: string;
  readonly model?: string;
  // topic tags (dori launch --tag); the key's first word (rl in rl-e7) is always a tag too
  readonly tags?: readonly string[];
  readonly worktrees?: readonly string[];
  readonly status?: LaneStatus;
  readonly pausedFrom?: LaneStatus;
  // dori pause paused the omo goal of the lane's session (read back), so dori resume resumes it
  readonly pausedGoal?: boolean;
  readonly claim?: Claim;
  // dori launch left the lane's goal pending (STARTUP_PENDING_GOAL: its first turn was still on with no goal); dori watch
  // reads it on (pending-goal.ts): its goal clears the mark, three idle reads in a row (counted in idle) say LANE_NO_GOAL
  readonly pendingGoal?: { readonly idle: number; readonly at?: number };
  // the newest posts its own session made in its work thread, oldest first (at most 5, text cut to 120 characters)
  readonly threadPosts?: readonly ThreadPost[];
  readonly objection?: Objection;
  readonly history?: readonly HistoryEntry[];
  readonly openedAt: string;
  readonly closedAt?: string;
  readonly lastReplyAt?: number;
  readonly lastNudgeAt?: number;
  readonly lastAutoReplyAt?: number;
  readonly lastReport?: string;
  readonly fixes?: readonly FixAttempt[];
  // the owner's goal in their own words (dori launch --goal), and the lane's latest stated direction (dori intent-check)
  readonly goal?: string;
  readonly direction?: { readonly at: string; readonly text: string; readonly next?: string };
  // big steps this lane must put through dori challenge first (dori launch --challenge-before)
  readonly challengeBefore?: readonly string[];
  // the lane's sessions start without config launchEnv (dori launch|adopt --use-gpu, dori set-gpu): launch, handover, restart
  readonly useGpu?: boolean;
  // launched with --ui, or its brief read like UI work: the directive ledger's UI directives apply to it
  readonly ui?: boolean;
  // the owner's directives dori launch found in scope (applied) and those the lead left out with a reason (dori launch --waive)
  readonly directives?: { readonly applied: readonly string[]; readonly waived: readonly { readonly id: string; readonly reason: string; readonly at: string }[] };
  readonly challenges?: readonly ChallengeRecord[];
  readonly explorations?: readonly ExplorationRecord[];
  readonly research?: ResearchSent;
  readonly blocked?: string;
  readonly idleSince?: number;
  // the background jobs (kind:id) an idle lane waits on, as the last BG_WAITING line named them
  readonly waitingOn?: string;
  // the last omo auto-turn pause dori watch reported (since: its first engine-turn-limit entry) and when it lifted one
  readonly autoturn?: AutoturnMark;
  // the last ROLLOVER_DUE freshness gave for a measured threshold (context, compactions, age): one per pane, so a lane's new
  // session can get its own (auto: written by older versions, not read); autoAt and tries: the last automatic start in this
  // pane and how many there were, the safe-point request, failures in a row, leftToLead for a training or eval chain
  readonly rolloverDue?: RolloverDue;
  // untagged repeats freshness inferred in the current session: cycles per metric (the inferred half of the stuck count) and
  // when the reports last showed each metric PASS (the tagged half counts only attempts after that), and the count at the
  // last --improved of a metric (baseline: only cycles after it count)
  // cycles: when each counted cycle's attempt was made, per metric, so the ladder sees what the lane did after them
  readonly inferred?: { readonly at: string; readonly counts: Readonly<Record<string, number>>; readonly cycles?: Readonly<Record<string, readonly string[]>>; readonly passedAt?: Readonly<Record<string, string>>; readonly baseline?: Readonly<Record<string, number>>; readonly lastEventAt?: string };
  // the stuck ladder: the rung each metric reached, so each rung change alerts once
  readonly stuck?: Readonly<Record<string, StuckMark>>;
  // the last dori intent-check: when, up to which report, by which reviewer, what it found (finding: the first finding, for
  // the re-read the lead may send)
  readonly intentCheck?: { readonly at: string; readonly lastReportAt: string; readonly model: string; readonly kinds: readonly string[]; readonly finding?: string; readonly rereadAt?: string };
  // lane caps of this lane over the config's (dori launch --wall-minutes/--token-limit/--cost-limit, dori caps), extra files
  // whose change counts as activity (launch --activity-path), and the last supervision failure freshness printed (once)
  readonly budget?: BudgetLimits;
  readonly activityPaths?: readonly string[];
  readonly supervisionError?: string;
  readonly receipt?: unknown;
  // the last LANE_DIED for this pane (lane-death.ts): reason for the lead, why for the log, told once the lead had it
  readonly died?: LaneDied;
};

export type LaneDied = { readonly pane: string; readonly at: string; readonly reason: string; readonly why: string; readonly told: boolean };

export type AutoturnMark = { readonly since?: string; readonly resumes?: readonly string[]; readonly long?: AutoturnLongMark };
// the last LANE_AUTOTURN_LONG: the user message its run counts from and the multiple of autoturnLongTurns it reported
export type AutoturnLongMark = { readonly user: string; readonly at: number };

export const statusOf = (lane: Lane): LaneStatus => (lane.closedAt ? "closed" : (lane.status ?? "working"));

export const withStatus = (lane: Lane, status: LaneStatus, note: string, at: string, patch: Partial<Lane> = {}): Lane => ({
  ...lane,
  ...patch,
  status,
  history: [...(lane.history ?? []), { at, status, note }],
});

// A lane recorded before 2026-11-02 keeps its last check under ownerCheck (the periodic owner check, removed then; dori
// intent-check wrote there too): it is read as intentCheck, so a pending finding can still be re-read and a confirmed
// re-read still makes the next finding rung 4. The old field is not written back.
type Recorded = Lane & { readonly ownerCheck?: Lane["intentCheck"] };
const loaded = (raw: Recorded): Lane => {
  const { ownerCheck: old, ...lane } = raw;
  if (!old || lane.intentCheck) return lane;
  return { ...lane, intentCheck: { at: old.at, lastReportAt: old.lastReportAt, model: old.model, kinds: old.kinds, ...(old.finding ? { finding: old.finding.replace(/^OWNER_CHECK /, "INTENT_CHECK ") } : {}), ...(old.rereadAt ? { rereadAt: old.rereadAt } : {}) } };
};

export class Registry {
  readonly dir: string;
  constructor(stateDir: string) {
    this.dir = join(stateDir, "lanes");
  }

  path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  async read(key: string): Promise<Lane | null> {
    const f = Bun.file(this.path(key));
    return (await f.exists()) ? loaded((await f.json()) as Recorded) : null;
  }

  // temp file + rename so a concurrent reader never sees a half-written lane
  async write(lane: Lane): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    // A lane's sessions are history: whatever path changes its session (a handover, dori sync --write, a revive), the
    // outgoing one is kept in priorSessions, so its cost counts every session it had (supervision.ts laneSessionUsage)
    const before = await this.read(lane.key).catch(() => null);
    const outgoing = before?.session && before.session !== lane.session ? [before.session] : [];
    const prior = [...new Set([...(before?.priorSessions ?? []), ...(lane.priorSessions ?? []), ...outgoing])].filter((s) => s !== lane.session);
    if (prior.length) lane = { ...lane, priorSessions: prior };
    const tmp = `${this.path(lane.key)}.${process.pid}.tmp`;
    await Bun.write(tmp, JSON.stringify(lane, null, 1));
    renameSync(tmp, this.path(lane.key));
  }

  // Sweeps change only their own fields: merge them onto the lane as it is now, so a claim or an objection written
  // by another process since the sweep read the lane is kept.
  async patch(key: string, fields: Partial<Lane>): Promise<void> {
    const fresh = await this.read(key);
    if (fresh) await this.write({ ...fresh, ...fields });
  }

  async list(): Promise<Lane[]> {
    mkdirSync(this.dir, { recursive: true });
    const lanes: Lane[] = [];
    for (const f of readdirSync(this.dir)) if (f.endsWith(".json")) lanes.push(loaded((await Bun.file(join(this.dir, f)).json()) as Recorded));
    return lanes;
  }

  async open(): Promise<Lane[]> {
    return (await this.list()).filter((l) => statusOf(l) !== "closed");
  }

  async byPane(pane: string): Promise<Lane | null> {
    return (await this.open()).find((l) => l.pane === pane) ?? null;
  }
}

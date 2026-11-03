// Lane caps (wall minutes, tokens, cost), hung calls and the cost record, after dori-superagent #61
// (https://github.com/sisyphuslabs/omo-dori-mode-experimental/pull/61, src/supervision.ts at 90f02c1, MIT), rewritten on
// this fork's registry and freshness sweep. Upstream keeps a reports.jsonl journal per lane (#30, not ported): there a
// ceiling appends a blocker report. Here a lane's newest report is lane.lastReport in the registry, and a ceiling or a hung
// call is told to the lead (alert) once per change. Nothing stops, closes or types into the lane.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { CheckpointError, Checkpoints, takeLock } from "./checkpoints.ts";
import { fill } from "./config.ts";
import { paneTranscript } from "./panes.ts";
import { type Lane, statusOf } from "./registry.ts";
import type { Clock, Runner } from "./run.ts";

export const BUDGET_NAMES = ["wallMinutes", "tokens", "costUsd"] as const;
export type BudgetName = (typeof BUDGET_NAMES)[number];
// a number is a ceiling, null turns it off; an absent field leaves the one below it (defaults < lanes.<key> < the lane's own)
export type BudgetLimits = { readonly wallMinutes?: number | null; readonly tokens?: number | null; readonly costUsd?: number | null };
export type Usage = { readonly tokens: number | null; readonly costUsd: number | null };
// session: the sessions the reading summed (no usageArgv)
export type UsageSnapshot = Usage & {
  readonly key: string;
  readonly at: string;
  readonly session?: string;
  readonly final?: true;
};
export type SessionUsage = { readonly session: string; readonly tokens: number; readonly costUsd: number | null };

export type SupervisionSettings = {
  readonly defaults: BudgetLimits;
  readonly lanes: Readonly<Record<string, BudgetLimits>>;
  // minutes a Working/Running timer must grow from one start, and minutes with no report, checkpoint or file change (0: off)
  readonly hungAfterMinutes: number;
  readonly staleAfterMinutes: number;
  // argv printing {"tokens": N, "costUsd": N} cumulative for {key} {session} {cwd}; empty: the lane's omo transcript
  readonly usageArgv: readonly string[];
  // argv run once at close with {key} {session} {tokens} {costUsd} {at} {closeKey}; empty: none
  readonly recordCostArgv: readonly string[];
  readonly activityPaths: readonly string[];
  readonly gitActivity: boolean;
};

export const defaultSupervision = (): SupervisionSettings => ({
  defaults: { wallMinutes: null, tokens: null, costUsd: null },
  lanes: {},
  hungAfterMinutes: 20,
  staleAfterMinutes: 20,
  usageArgv: [],
  recordCostArgv: [],
  activityPaths: [],
  gitActivity: true,
});

const SETTING_NAMES = Object.keys(defaultSupervision());

const limitsProblem = (where: string, value: unknown): string | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return `${where} must be an object of ${BUDGET_NAMES.join(", ")}`;
  for (const [name, v] of Object.entries(value)) {
    if (!(BUDGET_NAMES as readonly string[]).includes(name)) return `${where}.${name} is not a ceiling (${BUDGET_NAMES.join(", ")})`;
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) return `${where}.${name} must be a number >= 0 or null, not ${JSON.stringify(v)}`;
  }
  return undefined;
};

// The supervision entry of a config file as written: a misspelt name or a bad ceiling is refused, never dropped, so a typo
// cannot turn a ceiling off (upstream b68a8be, d4a349b).
export const supervisionProblem = (raw: unknown): string | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "supervision must be an object";
  for (const [name, v] of Object.entries(raw)) {
    const where = `supervision.${name}`;
    if (!SETTING_NAMES.includes(name)) return `${where} is not a supervision setting (${SETTING_NAMES.join(", ")})`;
    if (name === "defaults") {
      const p = limitsProblem(where, v);
      if (p) return p;
    } else if (name === "lanes") {
      if (v === null || typeof v !== "object" || Array.isArray(v)) return `${where} must map lane keys to ceilings`;
      for (const [key, limits] of Object.entries(v)) {
        const p = limitsProblem(`${where}.${key}`, limits);
        if (p) return p;
      }
    } else if (name === "hungAfterMinutes" || name === "staleAfterMinutes") {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return `${where} must be a number >= 0 (0: off), not ${JSON.stringify(v)}`;
    } else if (name === "gitActivity") {
      if (typeof v !== "boolean") return `${where} must be true or false`;
    } else if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) return `${where} must be a list of strings`;
  }
  return undefined;
};

const defined = (limits: BudgetLimits | undefined): BudgetLimits =>
  Object.fromEntries(Object.entries(limits ?? {}).filter(([, v]) => v !== undefined)) as BudgetLimits;

// The ceilings in force for a lane: defaults, then supervision.lanes.<key>, then the lane's own (launch flags, dori caps).
export const laneLimits = (settings: SupervisionSettings, lane: Pick<Lane, "key" | "budget">): Required<{ [K in BudgetName]: number | null }> => ({
  wallMinutes: null, tokens: null, costUsd: null,
  ...defined(settings.defaults), ...defined(settings.lanes[lane.key]), ...defined(lane.budget),
}) as Required<{ [K in BudgetName]: number | null }>;

// Match only an explicit duration on a visible Working/Running line (omo: "── • Running bash (2m 5s • esc to interrupt)").
// step is the smallest unit shown, in seconds: "25m" is rounded to the minute, so two readings can place the same call's
// start up to a minute apart. Ported unchanged from upstream.
export const workingTimer = (screen: string): { kind: string; seconds: number; step: number } | null => {
  for (const line of Bun.stripANSI(screen).split("\n")) {
    const kind = /^\s*[^\w\n]*(Working|Running)\b/i.exec(line)?.[1]?.toLowerCase();
    if (!kind) continue;
    const clock = /\b(\d+):(\d{2})(?::(\d{2}))?\b/.exec(line);
    if (clock) {
      const seconds = clock[3] === undefined ? Number(clock[1]) * 60 + Number(clock[2]) :
        Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
      return { kind, seconds, step: 1 };
    }
    const parts = [...line.matchAll(/(\d+(?:\.\d+)?)\s*(h(?:ours?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)\b/gi)];
    const unit = (name = ""): number => (/^h/i.test(name) ? 3600 : /^m/i.test(name) ? 60 : 1);
    if (parts.length) return { kind, seconds: parts.reduce((sum, match) => sum + Number(match[1]) * unit(match[2]), 0), step: Math.min(...parts.map((match) => unit(match[2]))) };
  }
  return null;
};

// What an omo session spent since the lane opened: the assistant turns' usage.totalTokens and usage.cost.total. A turn
// without a cost leaves the cost unknown (null), never zero.
export const transcriptUsage = (text: string, since: string): { tokens: number; costUsd: number | null } => {
  let tokens = 0;
  let cost: number | null = 0;
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let e: { timestamp?: string; message?: { role?: string; usage?: { totalTokens?: unknown; cost?: { total?: unknown } } } };
    try {
      e = JSON.parse(line);
    } catch {
      continue; // a line being written
    }
    if (e.message?.role !== "assistant" || !e.message.usage || (e.timestamp ?? "") < since) continue;
    const t = e.message.usage.totalTokens;
    if (typeof t === "number" && Number.isFinite(t)) tokens += t;
    const c = e.message.usage.cost?.total;
    cost = cost !== null && typeof c === "number" && Number.isFinite(c) ? cost + c : null;
  }
  return { tokens, costUsd: cost };
};

// The default usage source: the omo transcripts of every session the lane had (lane.priorSessions, then lane.session),
// found by id anywhere under the sessions directory (ids are unique; a lane's sessions may sit under its written cwd, its
// real path, or the pane's own cwd for an adopted lane). A lane with no recorded session reads the transcript of the
// session in its pane. Unknown, never smaller: a session whose transcript is not found, or a move whose new session is
// not known yet (priorSessions but no session), makes the usage unknown.
export const laneSessionUsage = (run: Runner, sessionsDir: string) => async (lane: Lane): Promise<SessionUsage | null> => {
  const ids = [...new Set([...(lane.priorSessions ?? []), ...(lane.session ? [lane.session] : [])])];
  if (lane.priorSessions?.length && !lane.session) return null;
  if (ids.length) {
    const files = readdirSync(sessionsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => {
      try {
        return readdirSync(join(sessionsDir, d.name)).filter((n) => n.endsWith(".jsonl")).map((n) => join(sessionsDir, d.name, n));
      } catch {
        return [];
      }
    });
    let tokens = 0;
    let costUsd: number | null = 0;
    for (const id of ids) {
      const file = files.find((f) => f.endsWith(`_${id}.jsonl`));
      if (!file) return null;
      const one = transcriptUsage(readFileSync(file, "utf8"), lane.openedAt);
      tokens += one.tokens;
      costUsd = costUsd === null || one.costUsd === null ? null : costUsd + one.costUsd;
    }
    return { session: ids.join(","), tokens, costUsd };
  }
  const path = lane.pane ? await paneTranscript(run, sessionsDir, lane.pane) : undefined;
  if (!path || !existsSync(path)) return null;
  return { session: path, ...transcriptUsage(readFileSync(path, "utf8"), lane.openedAt) };
};

export type SupervisionDeps = {
  readonly stateDir: string;
  readonly run: Runner;
  readonly clock: Pick<Clock, "now">;
  // tells the lead; true once it arrived. False (or a throw) keeps the alert unsent, so the next sweep sends it again.
  readonly alert?: (lane: Lane, message: string) => boolean | Promise<boolean>;
  // the lane's current session usage when no usageArgv is set
  readonly sessionUsage?: (lane: Lane) => Promise<SessionUsage | null>;
};

export type SupervisionResult = {
  readonly enabled: boolean;
  // alerts new since the last sweep, and those of them the lead did not get (sent again next sweep)
  readonly alerts: readonly string[];
  readonly undelivered: readonly string[];
  readonly capped: readonly string[];
  readonly hung: boolean;
  readonly usage: UsageSnapshot | null;
  // set when the saved observation could not be read and the sweep started over
  readonly reset?: string;
};

type Observation = {
  readonly at: number;
  readonly timer: number | null;
  readonly timerKind: string | null;
  readonly activity: string;
  readonly activeAt: number;
  readonly alerts: readonly string[];
};

const ACTIVITY_FILES = 5000;

export const HUNG_MESSAGE = "Working/Running timer exceeded threshold without fresh report, checkpoint, or file activity";

// Another close holds this lane's cost record; that close finishes the lane (pane, worktrees, registry).
export class CostRecordBusy extends Error {
  override readonly name = "CostRecordBusy";
}

export class Supervision {
  readonly checkpoints: Checkpoints;
  constructor(readonly deps: SupervisionDeps, readonly settings: SupervisionSettings = defaultSupervision()) {
    this.checkpoints = new Checkpoints(deps.stateDir);
  }

  private dir(key: string): string {
    return dirname(this.checkpoints.path(key));
  }

  private costPath(key: string): string {
    return join(this.dir(key), "cost.jsonl");
  }

  private readings(key: string): UsageSnapshot[] {
    const path = this.costPath(key);
    if (!existsSync(path)) return [];
    // A line torn by a crash mid-append is skipped, not fatal: the readings are a record, and one bad line must not stop
    // every later sweep and the close from reading the rest.
    return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => {
      try {
        const v = JSON.parse(l) as UsageSnapshot;
        return v && typeof v === "object" && v.key ? [v] : [];
      } catch {
        return [];
      }
    });
  }

  private record(snapshot: UsageSnapshot): void {
    const path = this.costPath(snapshot.key);
    mkdirSync(dirname(path), { recursive: true });
    // after a line torn by a crash (no newline at the end) the reading starts its own line
    const torn = existsSync(path) && statSync(path).size > 0 && !readFileSync(path, "utf8").endsWith("\n");
    appendFileSync(path, `${torn ? "\n" : ""}${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  }

  // Cumulative usage: the usageArgv hook's reading, else the lane's current omo session plus the last reading of each
  // earlier session of this lane (a handover moves it to a new transcript). Unknown stays null, never 0.
  private async usage(lane: Lane, now: number, persist: boolean): Promise<UsageSnapshot> {
    const at = new Date(now).toISOString();
    if (this.settings.usageArgv.length) {
      let usage: Usage = { tokens: null, costUsd: null };
      const result = await this.deps.run(fill(this.settings.usageArgv, { key: lane.key, session: lane.session ?? "", cwd: lane.cwd ?? "" }), { ...(lane.cwd ? { cwd: lane.cwd } : {}), timeoutMs: 10_000 });
      if (result.code === 0) {
        try {
          const value: unknown = JSON.parse(result.out);
          const metric = (name: "tokens" | "costUsd"): number | null => {
            const n = typeof value === "object" && value !== null && name in value ? (value as Record<string, unknown>)[name] : null;
            return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
          };
          usage = { tokens: metric("tokens"), costUsd: metric("costUsd") };
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      const snapshot: UsageSnapshot = { key: lane.key, at, ...usage };
      if (persist) this.record(snapshot);
      return snapshot;
    }
    const current = await (this.deps.sessionUsage?.(lane) ?? Promise.resolve(null));
    const snapshot: UsageSnapshot = { key: lane.key, at, tokens: current?.tokens ?? null, costUsd: current?.costUsd ?? null, ...(current ? { session: current.session } : {}) };
    const last = this.readings(lane.key).at(-1);
    if (persist && current && !(last && last.tokens === snapshot.tokens && last.costUsd === snapshot.costUsd && last.session === snapshot.session)) this.record(snapshot);
    return snapshot;
  }

  private async activity(lane: Lane): Promise<string> {
    // the paths configured by hand: always looked at, and through a symlink (a latest.log pointing at a growing log)
    const explicit = new Set([...this.settings.activityPaths, ...(lane.activityPaths ?? [])].map((path) => resolve(lane.cwd ?? ".", path)));
    const paths = new Set<string>();
    const changes: string[] = [];
    // git prints the changed paths relative to the repository's top, not to the lane's cwd (a lane in a subdirectory)
    const top = this.settings.gitActivity && lane.cwd ? (await this.deps.run(["git", "-C", lane.cwd, "rev-parse", "--show-toplevel"], { timeoutMs: 10_000 })) : undefined;
    if (lane.cwd && top?.code === 0 && top.out.trim()) {
      const result = await this.deps.run(["git", "-C", lane.cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { timeoutMs: 10_000, preserveOutput: true });
      if (result.code === 0) {
        // git prints real paths: compare them with the cwd's real path (a symlinked cwd), else every change looks outside it
        let cwdReal = resolve(lane.cwd);
        try {
          cwdReal = realpathSync(lane.cwd);
        } catch {
          // a cwd that is gone keeps its written path
        }
        const entries = result.out.split("\0");
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index];
          if (!entry) continue;
          const path = resolve(top.out.trim(), entry.slice(3));
          const rel = relative(cwdReal, path);
          // Dependency churn and paths outside the lane's cwd are not the lane's progress.
          if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.split("/").includes("node_modules")) {
            paths.add(path);
            changes.push(entry);
          }
          if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") index++;
        }
      }
    }
    // every untracked file is listed (a file written inside an untracked directory is progress); at most ACTIVITY_FILES
    // are looked at, so a huge untracked tree does not make each sweep slow
    const files = [...[...explicit].sort(), ...[...paths].filter((path) => !explicit.has(path)).sort()].slice(0, ACTIVITY_FILES).map((path) => {
      try {
        const stat = lstatSync(path);
        const own = [path, stat.mtimeMs, stat.ctimeMs, stat.size];
        if (!explicit.has(path) || !stat.isSymbolicLink()) return own;
        // the link's own metadata (a retarget counts) and its target's (writes through the link count); a dangling link is null
        const target = statSync(path, { throwIfNoEntry: false });
        return [...own, target ? [target.mtimeMs, target.ctimeMs, target.size] : null];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return [path, null];
      }
    });
    return JSON.stringify({ report: lane.lastReport ?? null, checkpoint: this.checkpoints.read(lane.key).at(-1) ?? null, files, changes: changes.sort() });
  }

  // One look at a working lane: its ceilings, a hung call on its screen. Each alert reaches the lead once per change.
  async sweep(lane: Lane, screen: string): Promise<SupervisionResult> {
    // a lane told "not done" keeps working, so it is supervised like a working one; paused and finished lanes are not
    if (!["working", "not-done"].includes(statusOf(lane)) || !lane.pane) return { enabled: false, alerts: [], undelivered: [], capped: [], hung: false, usage: null };
    const now = this.deps.clock.now();
    const path = join(this.dir(lane.key), "supervision.json");
    // The observation is a cache of the last sweep: one that cannot be read (a crash mid-write, an edit) is started over,
    // and said once, instead of turning this lane's supervision off for good.
    let previous: Observation | null = null;
    let reset: string | undefined;
    if (existsSync(path)) {
      try {
        previous = JSON.parse(readFileSync(path, "utf8")) as Observation;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        reset = `${path} could not be read (${error.message}); this lane's supervision started over`;
      }
    }
    const activity = await this.activity(lane);
    const timer = workingTimer(screen);
    const activeAt = !previous || activity !== previous.activity ? now : previous.activeAt;
    const limits = laneLimits(this.settings, lane);
    const wantsUsage = typeof limits.tokens === "number" || typeof limits.costUsd === "number" || this.settings.usageArgv.length > 0;
    const usage = wantsUsage ? await this.usage(lane, now, true) : null;
    const capped: string[] = [];
    const exceeds = (name: BudgetName, actual: number | null): void => {
      const ceiling = limits[name];
      if (typeof ceiling === "number" && actual !== null && actual >= ceiling) capped.push(`${name} ceiling reached (${ceiling})`);
    };
    exceeds("wallMinutes", (now - Date.parse(lane.openedAt)) / 60_000);
    exceeds("tokens", usage?.tokens ?? null);
    exceeds("costUsd", usage?.costUsd ?? null);
    const hungAfter = this.settings.hungAfterMinutes;
    const hung = hungAfter > 0 && previous !== null && timer !== null && previous.timer !== null &&
      timer.kind === previous.timerKind && timer.seconds > previous.timer &&
      // A changed timer origin means a new call, even if its duration is larger. Rounding to the shown unit moves the
      // computed origin by up to one unit, plus sweep jitter.
      Math.abs((now - timer.seconds * 1000) - (previous.at - previous.timer * 1000)) <= timer.step * 1000 + 2000 &&
      timer.seconds >= hungAfter * 60 &&
      now - activeAt >= this.settings.staleAfterMinutes * 60_000;
    const unavailable = (["tokens", "costUsd"] as const)
      .filter((name) => typeof limits[name] === "number" && (usage?.[name] ?? null) === null)
      .map((name) => `${name} ceiling cannot be checked: usage unavailable`);
    // caps and a hung call are told apart, each once: a lane already told about its cap that then hangs is told that too
    const alerts = [...capped, ...(hung ? [HUNG_MESSAGE] : []), ...unavailable];
    const fresh = alerts.filter((message) => !previous?.alerts.includes(message));
    // Deliver before saving, so only alerts that reached the lead count as sent; a failed one is sent again next sweep.
    const undelivered: string[] = [];
    for (const message of fresh) {
      try {
        if ((await this.deps.alert?.(lane, message)) === false) undelivered.push(message);
      } catch {
        undelivered.push(message);
      }
    }
    const observation: Observation = { at: now, timer: timer?.seconds ?? null, timerKind: timer?.kind ?? null, activity, activeAt, alerts: alerts.filter((m) => !undelivered.includes(m)) };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(observation), { mode: 0o600 });
    renameSync(temporary, path);
    return { enabled: true, alerts: fresh, undelivered, capped, hung, usage, ...(reset ? { reset } : {}) };
  }

  // The lane's last usage reading at close. A close that already recorded its final reading (a retried or second close)
  // returns it and runs no hook, so a cost ledger gets each lane once; {closeKey} is the same on every attempt.
  // Two closes at once (the watcher and a manual close) take turns on a lock per lane; the second finds the first's final
  // reading and runs no hook.
  // A close that finds the lock taken throws CostRecordBusy: the other close owns the lane's teardown from here.
  async close(lane: Lane): Promise<UsageSnapshot> {
    mkdirSync(this.dir(lane.key), { recursive: true });
    let release: () => void;
    try {
      release = takeLock(join(this.dir(lane.key), "cost.lock"), this.deps.clock.now(), "cost record", lane.key);
    } catch (error) {
      // takeLock throws CheckpointError only when another holder has the lock; any other error is a real failure
      if (error instanceof CheckpointError) throw new CostRecordBusy(error.message);
      throw error;
    }
    try {
      return await this.closeLocked(lane);
    } finally {
      release();
    }
  }

  private async closeLocked(lane: Lane): Promise<UsageSnapshot> {
    const recorded = this.readings(lane.key).findLast((entry) => entry.final === true);
    if (recorded) return recorded;
    const snapshot = await this.usage(lane, this.deps.clock.now(), false);
    if (this.settings.recordCostArgv.length && (snapshot.tokens !== null || snapshot.costUsd !== null)) {
      const result = await this.deps.run(fill(this.settings.recordCostArgv, {
        key: lane.key, session: lane.session ?? "", tokens: snapshot.tokens === null ? "null" : String(snapshot.tokens),
        costUsd: snapshot.costUsd === null ? "null" : String(snapshot.costUsd), at: snapshot.at, closeKey: `${lane.key}@${lane.openedAt}`,
      }), { ...(lane.cwd ? { cwd: lane.cwd } : {}), timeoutMs: 10_000 });
      if (result.code !== 0) {
        // Kept as a plain reading, so the next close takes a new one and runs the hook again.
        this.record(snapshot);
        throw new Error(`recordCost failed for ${lane.key}: ${result.err || result.out || `exit ${result.code}`}`);
      }
    }
    const final: UsageSnapshot = { ...snapshot, final: true };
    this.record(final);
    return final;
  }
}

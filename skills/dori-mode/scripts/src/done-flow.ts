import { type GoalAct, goalCommand, type GoalRead, liveSession } from "./goal.ts";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { closeAoeSession, paneActivity, paneLife } from "./aoe.ts";
import { autoturnTick } from "./autoturn.ts";
import { laneBackground } from "./background.ts";
import { BACKUP_REMOTE, type DoriConfig, fill } from "./config.ts";
import type { Question } from "./messenger/discord-cards.ts";
import { laneDeathTick, laneSuspendTick } from "./lane-death.ts";
import { leadDownTick } from "./lead-down.ts";
import { leadLimitTick, limitResumeTick } from "./lead-limit.ts";
import { missedAnswersTick } from "./missed-answers.ts";
import { hasThread, type Lane, type Registry, statusOf, type ThreadPost, withStatus } from "./registry.ts";
import { type Clock, iso, type Runner } from "./run.ts";
import { omoPane, omoSession, sendVerified, submitToPane } from "./panes.ts";
import { pendingGoalTick } from "./pending-goal.ts";
import type { Submitted } from "./submit.ts";
import { replacementOf } from "./frozen.ts";
import { watchLog } from "./watch-log.ts";
import { checkDone, type SignalIo } from "./done-signals.ts";
import { gateMissing } from "./merge-gate.ts";
import { ownerSummary } from "./close-summary.ts";
import { CostRecordBusy, laneSessionUsage, Supervision } from "./supervision.ts";
import { Lessons, type LessonInput } from "./lessons.ts";
import { appendRollover, outcomeLine, outcomeMissing, pendingStuck, readRollovers } from "./rollover.ts";

export type FlowDeps = {
  readonly run: Runner;
  readonly clock: Clock;
  readonly registry: Registry;
  readonly config: DoriConfig;
  readonly exists?: (path: string) => boolean;
  readonly signalIo?: SignalIo;
  // sets a discord:<id> work thread to done and archives it (cli wires it when DORI_DISCORD_TOKEN is set)
  readonly markThreadDone?: (ref: string) => Promise<unknown>;
  // posts in a discord:<id> work thread without changing its status mark (cli wires it when DORI_DISCORD_TOKEN is set)
  readonly postInThread?: (ref: string, text: string) => Promise<unknown>;
  // ids of the question cards still open in a work thread (cli reads the card store for discord:<id> threads)
  readonly openCards?: (ref: string) => readonly string[];
  // the question cards the owner answered (cli reads the card store); the watch re-types an answer its session missed
  readonly answeredCards?: () => readonly Question[];
  // asks the thread status queue for a status on a discord:<id> work thread; the queue keeps it working while a lane there
  // still works. Resolves with the queue's outcome (cli wires it when DORI_DISCORD_TOKEN is set)
  readonly requestThreadStatus?: (ref: string, status: "working" | "waiting") => Promise<string>;
  // a discord:<id> thread marked standing (dori thread set <ref> standing, threads.json): the place a kind of work always
  // lives, so its last lane closing leaves it waiting instead of done and archived (cli reads threads.json)
  readonly standingThread?: (ref: string) => boolean;
  // a lane put on an existing discord:<id> thread (dori launch --thread, adopt, set-thread) works there now: asks the queue
  // for working (unarchived, 🔄) and puts its threads.json record back if a done mark dropped it. Resolves with the
  // queue's outcome (cli wires it when DORI_DISCORD_TOKEN is set)
  readonly reopenThread?: (ref: string, title: string) => Promise<string>;
  // posts the lead's own runaway or pause alert to the pair channel (the other Dori's inbox) and the owner's channel as
  // this Dori's bot, without mentions; one LEAD_ALERT_POSTED / LEAD_ALERT_WARN line per channel (cli wires leadAlertPoster)
  readonly postLeadAlert?: (text: string) => Promise<readonly string[]>;
  // the inbox the listener writes, the owner's user id and his channel: dori watch reads which owner messages wait for the
  // lead (lead-limit.ts; cli wires DORI_DISCORD_INBOX, DORI_DISCORD_OWNER, DORI_DISCORD_CHANNEL)
  readonly ownerInbox?: { readonly path: string; readonly ownerId: string; readonly ownerChannel: string };
  // posts one line as this Dori's bot in a channel or thread of the owner's and returns the message id (cli wires it when
  // DORI_DISCORD_TOKEN is set)
  readonly postOwner?: (channel: string, text: string) => Promise<string>;
  // opens a work thread named for a lane in this Dori's own channel and returns its ref (dori launch --thread new; cli wires it
  // when DORI_DISCORD_TOKEN and DORI_DISCORD_CHANNEL are set)
  readonly openThread?: (title: string) => Promise<string>;
  // ids of channels that are not threads (this Dori's channel, the pair channel, watched channels): refused as --thread
  readonly channels?: readonly string[];
  // the omo goal of a pane's session (goal.ts sessionGoal reads its goal file when unset); tests set it
  readonly readGoal?: (pane: string) => Promise<GoalRead>;
};

export class LaneStateError extends Error {}
// the goal command was typed or could not be, and its effect was not read back: the lane is left as it was (exit 3)
export class GoalUnverifiedError extends Error {}

const signalIo = (deps: FlowDeps, lane: Lane): SignalIo => ({ cwd: lane.cwd ?? deps.config.defaultCwd, ...deps.signalIo });

const windowMs = (deps: FlowDeps): number => deps.config.closeAfterMin * 60_000;

// A lane's result reaches its thread once. Lanes post it themselves (their briefs ask for a short line in the owner's
// thread) and the close posted the claim's summary there too, the same result twice within a minute (owner 2026-10-21
// 07:19 KST "지금 왜 두번씩 답변하는지"; 11 lanes on 2026-10-20, e.g. jev-recall-filter and cyto-ocr-merge). So dori send and
// dori thread record what a lane's own session posts in its work thread, and the newest such post made up to
// RESULT_POST_MS before the claim is taken as the result: the close then posts no summary.
export const RESULT_POST_MS = 30 * 60_000;
const KEEP_POSTS = 5;
const POST_TEXT = 120;

// Records a post made from pane in thread (a Discord id) on the open lane of that pane, when the thread is its work thread;
// returns the lane's key, or undefined when the post is not a lane's post in its own thread.
export const recordThreadPost = async (registry: Registry, pane: string, thread: string, id: string, text: string, at: string): Promise<string | undefined> => {
  if (!pane) return undefined;
  const lane = await registry.byPane(pane);
  if (!lane || lane.thread !== `discord:${thread}`) return undefined;
  const post: ThreadPost = { id, at, text: text.trim().slice(0, POST_TEXT) };
  await registry.patch(lane.key, { threadPosts: [...(lane.threadPosts ?? []), post].slice(-KEEP_POSTS) });
  return lane.key;
};

const resultPost = (lane: Lane, now: number): ThreadPost | undefined => lane.threadPosts?.findLast((p) => now - Date.parse(p.at) <= RESULT_POST_MS);

// rolloverOutcome: a lane moved to a new session for being stuck (rung 4) says in one line what it did differently after
// the move; resolved false when the move did not solve it (the lane is done another way)
export type ClaimOptions = { readonly posted?: string; readonly postSummary?: boolean; readonly rolloverOutcome?: { readonly line: string; readonly resolved: boolean } };

// The outcome of the lane's stuck rollover, kept in the rollover log next to it once the claim is recorded:
// ROLLOVER_OUTCOME_MISSING when the lane owes one and gave none (nothing is recorded), else what the claim output adds.
const claimOutcome = (deps: FlowDeps, lane: Lane, at: string, given: ClaimOptions["rolloverOutcome"]): { readonly missing?: string; readonly write: () => string } => {
  const pending = pendingStuck(readRollovers(deps.config.stateDir), lane.key);
  const line = given ? outcomeLine(given.line) : "";
  if (!pending) return { write: () => (line ? `\nROLLOVER_OUTCOME_SKIPPED ${lane.key}: no stuck rollover of this lane waits for a line` : "") };
  if (!line) return { missing: outcomeMissing(lane.key, pending), write: () => "" };
  const resolved = given?.resolved !== false;
  return {
    write: () => {
      appendRollover(deps.config.stateDir, { kind: "outcome", at, key: lane.key, rolloverAt: pending.at, resolved, line, by: "claim-done" });
      return `\nROLLOVER_OUTCOME ${lane.key} ${resolved ? "resolved" : "not resolved"} (rollover ${pending.at}): ${line}`;
    },
  };
};

// summary: what the owner's thread gets when the lane closes (dori claim-done --summary), kept with the claim; posted: the
// lane's result already in its thread (opts.posted, else its own post there in the last RESULT_POST_MS), so the close posts
// no summary; opts.postSummary: that post was not the result, post the summary anyway
export const claimDone = async (deps: FlowDeps, lane: Lane, evidence: string, summary?: string, opts: ClaimOptions = {}): Promise<string> => {
  const at = iso(deps.clock);
  const posted = opts.postSummary || !hasThread(lane) ? undefined : (opts.posted ?? resultPost(lane, deps.clock.now())?.id);
  const claim = { at, evidence, emitted: false, ...(summary?.trim() ? { summary: summary.trim() } : {}), ...(posted ? { posted } : {}) };
  const outcome = claimOutcome(deps, lane, at, opts.rolloverOutcome);
  if (outcome.missing) return outcome.missing;
  const postedLine = posted ? `\nRESULT_ALREADY_POSTED ${lane.key} ${posted}: the close posts no summary in the thread (the lane's result is there); --post-summary posts it anyway` : "";
  // A paused lane waits on a human, so its claim is recorded and announced but never closes it on a timer.
  if (statusOf(lane) === "paused") {
    await deps.registry.write({ ...lane, claim, history: [...(lane.history ?? []), { at, status: "paused", note: `done claimed while paused: ${evidence}` }] });
    if (lane.pane) await sendVerified(deps.run, deps.clock, deps.config, lane.pane, `[LEAD] done claim recorded for ${lane.key}, but the lane is paused, so it does not close automatically; the lead decides. Stay idle until then.`);
    return `LANE_DONE_CLAIMED_PAUSED ${lane.key} ${lane.pane ?? "-"} ${evidence}${postedLine}${outcome.write()}`;
  }
  await deps.registry.write(withStatus(lane, "done-claimed", evidence, at, { claim }));
  const outcomeNote = outcome.write();
  if (lane.pane) {
    const closesAt = new Date(deps.clock.now() + windowMs(deps)).toISOString().slice(11, 16);
    await sendVerified(deps.run, deps.clock, deps.config, lane.pane, `[LEAD] done claim recorded for ${lane.key}: this lane closes automatically at ${closesAt}Z (${deps.config.closeAfterMin} minutes) unless the lead objects with reasons. Stay idle until then; an objection arrives here as [LEAD] not done.`);
  }
  return `LANE_DONE_CLAIMED ${lane.key} ${lane.pane ?? "-"} ${evidence}${postedLine}${outcomeNote}`;
};

// The lead often gives a lane new work right after it claimed done (the owner's feedback on its result). On 2026-10-31
// Moodori's dori-promo claimed at 07:16:55Z, the lead typed two new instructions into it at 07:19 and 07:22 (both
// SUBMITTED), the lane started on them, and the watch closed it at 07:22:29Z in the middle of that work: five minutes after
// the claim without an objection. The claim is now taken back when the lead types into the lane (dori type) or the lane
// runs a new turn after it sat idle: the lane is working again, without a timer, until it claims again.
export const reopenClaim = async (deps: FlowDeps, lane: Lane, why: string): Promise<string> => {
  await deps.registry.write(withStatus(lane, "working", `REOPENED: ${why}`, iso(deps.clock), { claim: undefined, idleSince: undefined, blocked: undefined, lastReplyAt: deps.clock.now() }));
  return `LANE_CLAIM_REOPENED ${lane.key} ${lane.pane ?? "-"} ${why}`;
};

const reopenedText = (key: string, why: string): string =>
  `[LEAD] your done claim for ${key} is taken back: ${why}. The lane is working again and does not close on a timer; when this work is done, claim again with dori claim-done ${key}.`;

// Who closed a closed lane: the watch closes a claim it settled (verified-done just before closed), else dori close did.
export const closerOf = (lane: Lane): string => {
  const h = lane.history ?? [];
  const i = h.findLastIndex((e) => e.status === "closed");
  return h[i - 1]?.status === "verified-done" ? "the watch (automatic close after the done claim)" : "dori close (the lead)";
};

// dori type: a text the lead types into a lane. Into a done-claimed lane it is new work, so the claim is taken back first
// (LANE_CLAIM_REOPENED in the watch log, then the lane is told after the text). Into the pane of a closed lane nothing is
// typed: NOT_SUBMITTED <pane> LANE_IS_CLOSED <key> with when and who closed it, instead of the screen check's "no ❯
// prompt", which the lead read as a busy lane for 30 minutes (Moodori 2026-10-31 07:23Z). A gone or dead pane is named the
// same way by the screen check (PANE_GONE / PANE_DEAD).
export const typeIntoPane = async (deps: FlowDeps, pane: string, text: string): Promise<Submitted & { readonly pane: string; readonly notes: readonly string[] }> => {
  const log = (line: string) => watchLog(deps.config.watchLog, deps.clock, { source: "type", line });
  const notes: string[] = [];
  // a pane a handover froze forwards its text to the session that replaced it (submitToPane): no lane check here
  const forwarded = replacementOf(deps.config.stateDir, pane) !== undefined;
  const lane = forwarded ? null : await deps.registry.byPane(pane);
  if (!lane && !forwarded) {
    const closed = (await deps.registry.list()).filter((l) => l.pane === pane && statusOf(l) === "closed").sort((a, b) => (a.closedAt ?? "").localeCompare(b.closedAt ?? "")).at(-1);
    if (closed) {
      const gone = omoPane(deps.config, pane) && !(await paneLife(deps.run, pane)).live ? "; its pane is gone" : "";
      const reason = `LANE_IS_CLOSED ${closed.key} closed at ${closed.closedAt} by ${closerOf(closed)}${gone}: nothing was typed; no lane reads this pane, launch a new lane (dori launch) for new work`;
      log(`NOT_SUBMITTED ${pane} ${reason}`);
      return { status: "NOT_SUBMITTED", reason, pane, notes };
    }
  }
  const why = "the lead typed a new instruction into the lane (dori type)";
  if (lane && statusOf(lane) === "done-claimed") {
    const line = await reopenClaim(deps, lane, why);
    log(line);
    notes.push(line);
  }
  const r = await submitToPane(deps.run, deps.clock, deps.config, pane, text);
  if (notes.length && lane?.pane && r.status === "SUBMITTED") await sendVerified(deps.run, deps.clock, deps.config, r.pane, reopenedText(lane.key, why));
  return { ...r, notes };
};

export const objectDone = async (deps: FlowDeps, lane: Lane, reasons: readonly string[]): Promise<string> => {
  const at = iso(deps.clock);
  await deps.registry.write(withStatus(lane, "not-done", reasons.join("; "), at, { objection: { at, reasons } }));
  if (lane.pane) await sendVerified(deps.run, deps.clock, deps.config, lane.pane, `[LEAD] not done: ${reasons.join("; ")}; keep working, claim again when fixed`);
  return `LANE_NOT_DONE ${lane.key} ${reasons.join("; ")}`;
};

const pausedAt = (lane: Lane): string => lane.history?.findLast((h) => h.status === "paused" && h.note.startsWith("PAUSED:"))?.at ?? "";

// Parks a lane that waits on the owner: freshness, LANE_BLOCKED and dead-pane alerts skip it until it is resumed, and the
// omo goal of its session is paused first, read back, so it starts no turn on its own (goal.ts). A live session whose
// goal pause is not read back leaves the lane as it was (GoalUnverifiedError, PAUSE_UNVERIFIED).
export const pauseLane = async (deps: FlowDeps, lane: Lane, reason: string): Promise<string[]> => {
  const from = statusOf(lane);
  if (from !== "working" && from !== "not-done") throw new LaneStateError(`lane ${lane.key} is ${from}; only a working or not-done lane can be paused`);
  const goal = await goalLine(deps, lane, "pause");
  await deps.registry.write(withStatus(lane, "paused", `PAUSED: ${reason}`, iso(deps.clock), { pausedFrom: from, pausedGoal: goal?.changed || undefined, blocked: undefined, idleSince: undefined, waitingOn: undefined }));
  return [`LANE_PAUSED ${lane.key} (was ${from}) ${reason}`, ...(goal ? [goal.line] : [])];
};

// The goal step of pause and resume, for a lane with a pane dori drives omo in (panes.ts omoPane; another herdr agent's pane is left as before): its GOAL_* line and
// whether the goal was changed; undefined when there is nothing to do.
const goalLine = async (deps: FlowDeps, lane: Lane, act: GoalAct): Promise<{ readonly line: string; readonly changed: boolean } | undefined> => {
  const pane = lane.pane;
  if (!pane || !omoPane(deps.config, pane)) return undefined;
  const head = act === "pause" ? "PAUSE_UNVERIFIED" : "RESUME_UNVERIFIED";
  const dead = await liveSession(deps, pane);
  if (dead) return { line: `GOAL_SKIPPED ${lane.key} ${pane}: no live session (${dead}), nothing to ${act}`, changed: false };
  const r = await goalCommand(deps, pane, act);
  switch (r.outcome) {
    case "confirmed":
      return { line: `GOAL_${act === "pause" ? "PAUSED" : "RESUMED"} ${lane.key} ${pane}: ${r.detail}`, changed: true };
    case "no-goal":
    case "not-active":
      return { line: `GOAL_SKIPPED ${lane.key} ${pane}: ${r.detail}`, changed: false };
    case "unconfirmed":
    case "failed":
      throw new GoalUnverifiedError(`${head} ${lane.key} ${pane}: ${r.detail}; lane left ${statusOf(lane)}`);
  }
};

// Back to the status it had before the pause; the silence clock restarts now, so the first nudge comes a full interval later.
export const resumeLane = async (deps: FlowDeps, lane: Lane): Promise<string[]> => {
  if (statusOf(lane) !== "paused") throw new LaneStateError(`lane ${lane.key} is ${statusOf(lane)}, not paused`);
  const to = lane.pausedFrom ?? "working";
  // only a goal this pause paused is resumed: one the agent or the owner paused stays paused
  const goal = lane.pausedGoal ? await goalLine(deps, lane, "resume") : undefined;
  const { pausedFrom: _, pausedGoal: __, ...rest } = lane;
  await deps.registry.write(withStatus(rest, to, "RESUMED", iso(deps.clock), { lastReplyAt: deps.clock.now() }));
  const out = [`LANE_RESUMED ${lane.key} ${to}`, ...(goal ? [goal.line] : [])];
  // a thread left 🔔 while this lane was paused (its last working lane closed) is worked in again
  if (deps.requestThreadStatus && hasThread(lane) && lane.thread.startsWith("discord:")) {
    await deps.requestThreadStatus(lane.thread, "working").catch((e: unknown) => out.push(`THREAD_STATUS_WARN ${lane.key} ${lane.thread}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`));
  }
  if (lane.claim && lane.claim.at >= pausedAt(lane)) out.push(`NOTE ${lane.key} claimed done while paused (${lane.claim.evidence}); close it with dori close ${lane.key}, or object with dori object-done`);
  return out;
};

export const discoverWorktrees = async (lane: Lane, run: Runner, extraRoots: readonly string[] = []): Promise<string[]> => {
  const found = new Set<string>(lane.worktrees ?? []);
  const ours = (name: string) => name === lane.key || name.startsWith(`${lane.key}-`);
  for (const root of new Set([lane.cwd ?? "", ...extraRoots].filter(Boolean))) {
    const r = await run(["git", "-C", root, "worktree", "list", "--porcelain"]);
    if (r.code !== 0) continue;
    let path = "";
    for (const line of r.out.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("branch ") && path !== root && (ours(line.split("/").pop() ?? "") || ours(path.split("/").pop() ?? ""))) found.add(path);
    }
  }
  return [...found];
};

// `git rev-parse --local-env-vars` (git 2.43) and GIT_CEILING_DIRECTORIES, each unset for a child git
const GIT_REPO_ENV_CLEARED: Readonly<Record<string, undefined>> = Object.fromEntries(
  ["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES"].map((k) => [k, undefined]),
);

// owner/name of a GitHub URL in its https, ssh or scp-like form (git@github.com:owner/name.git), lower case
const githubRepo = (url: string): string | undefined => /^(?:https:\/\/|ssh:\/\/)?(?:[^@/]+@)?github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url.trim())?.[1]?.toLowerCase();

// the backup remote counts only when this Dori names a backup repo and the remote's configured URL is that repo
const isBackupRemote = async (git: Runner, wt: string, repo: string): Promise<boolean> => {
  if (!repo) return false;
  const url = await git(["git", "-C", wt, "config", "--get", `remote.${BACKUP_REMOTE}.url`]);
  return url.code === 0 && githubRepo(url.out) === repo.toLowerCase();
};

export const unpushedWork = async (deps: FlowDeps, lane: Lane): Promise<string[]> => {
  const exists = deps.exists ?? existsSync;
  const reasons: string[] = [];
  // dori-superagent issue #40 reproduced here (MIT): https://github.com/sisyphuslabs/dori-superagent/issues/40
  // A lane with no worktree of its own works in its cwd, so that checkout is what is checked; one with its own worktree
  // is checked there only, and the human's checkout in its cwd does not hold it. Git is asked first, and a checkout it
  // finds is checked. When it fails, a .git entry in the cwd or above it (on the physical path, as git walks it, so a
  // cwd that is a symlink into a repository counts) means a broken checkout: unreadable git state, which holds the lane.
  // Without one the cwd is no checkout and has no work to push. Git's message cannot tell the two apart: it prints
  // "not a git repository" for a missing repository and for a bad HEAD or a .git file pointing nowhere alike (git's
  // setup.c skips a .git it cannot use and walks on up). A .git entry counts when lstat sees it, so a dangling .git
  // symlink holds too; only ENOENT or ENOTDIR mean none. Every git call here, the worktree discovery too, runs without
  // the repository overrides git lists in `git rev-parse --local-env-vars` and without GIT_CEILING_DIRECTORIES: from the
  // watcher's environment they would point git at another repository, index or object store, or stop its walk.
  // (discoverWorktrees stays as it is: closeLane removes what it finds, never the cwd.)
  const git: Runner = (argv, opts) => deps.run(argv, { ...opts, env: { ...opts?.env, ...GIT_REPO_ENV_CLEARED } });
  const own = await discoverWorktrees(lane, git, [deps.config.defaultCwd]);
  const cwd = lane.cwd ?? deps.config.defaultCwd;
  const present = (p: string): boolean => {
    if (exists(p)) return true;
    try {
      lstatSync(p);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code !== "ENOENT" && code !== "ENOTDIR";
    }
  };
  const underGit = (dir: string): boolean => {
    let d = resolve(dir);
    try {
      d = realpathSync(d);
    } catch {
      // a path the file system cannot resolve is walked as written
    }
    for (; ; d = dirname(d)) {
      if (present(join(d, ".git"))) return true;
      if (dirname(d) === d) return false;
    }
  };
  let checked = own;
  if (!own.length && exists(cwd)) {
    const probe = await git(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"]);
    if (probe.code === 0) checked = probe.out.trim() === "true" ? [cwd] : [];
    else if (underGit(cwd)) reasons.push(`unpushed work in ${cwd} (git state unreadable)`);
  }
  for (const wt of checked) {
    if (!exists(wt)) continue;
    const dirty = await git(["git", "-C", wt, "status", "--porcelain", "--untracked-files=no"]);
    // a cwd checkout with no remote at all (a Dori's own Documents repository) has nowhere to push its commits, so they
    // are not unpushed work; its uncommitted changes still are. Its history is still walked, so one git cannot read
    // stays unreadable. A lane's own worktree is checked as before.
    // This Dori's stateGit backup remote (named backup, its URL this Dori's stateGit.backup.repo) takes only snapshots of
    // HEAD on their own history, so it is no place to push either: a checkout with only that remote is one with no
    // remote, and with a real remote besides, the commits are counted against the real one, never the snapshot refs.
    const remotes = own.length ? undefined : await git(["git", "-C", wt, "remote"]);
    if (remotes && remotes.code !== 0) {
      reasons.push(`unpushed work in ${wt} (git state unreadable)`);
      continue;
    }
    const names = remotes ? remotes.out.split("\n").map((n) => n.trim()).filter(Boolean) : [];
    const snapshotOnly = names.includes(BACKUP_REMOTE) && (await isBackupRemote(git, wt, deps.config.stateGit.backup.repo));
    const noRemote = remotes !== undefined && !names.some((n) => !(snapshotOnly && n === BACKUP_REMOTE));
    const notPushed = noRemote ? [] : ["--not", ...(snapshotOnly ? [`--exclude=${BACKUP_REMOTE}/*`] : []), "--remotes"];
    let ahead = await git(["git", "-C", wt, "rev-list", "--count", "HEAD", ...notPushed]);
    if (noRemote && ahead.code === 0) ahead = { code: 0, out: "0", err: "" };
    // a fresh repository's branch has no commit yet (an unborn HEAD): rev-list fails, but there is nothing to push;
    // it is unborn only when HEAD names a branch that resolves to no commit. A HEAD that resolves but cannot be read
    // (a missing object) stays unreadable. Its staged files still show in status.
    if (ahead.code !== 0 && (await git(["git", "-C", wt, "rev-parse", "-q", "--verify", "HEAD"])).code === 1 && (await git(["git", "-C", wt, "symbolic-ref", "-q", "HEAD"])).code === 0) ahead = { code: 0, out: "0", err: "" };
    if (dirty.code !== 0 || ahead.code !== 0) reasons.push(`unpushed work in ${wt} (git state unreadable)`);
    else if (dirty.out.trim() || Number(ahead.out.trim()) > 0) reasons.push(`unpushed work in ${wt}`);
  }
  return reasons;
};

// note goes into the lane's record. A lane with a work thread closes only with a summary for the owner (summary, else the
// claim's, else one a model writes from the lane's notes; close-summary.ts), posted there before the thread is marked done
// and archived: no summary is CLOSE_SUMMARY_MISSING, a post that did not go out is CLOSE_SUMMARY_NOT_SENT, and either way
// nothing is changed and the lane stays open. When the lane's result is already in the thread (posted, else the claim's
// posted) and no summary is given here, none is posted: CLOSE_SUMMARY_SKIPPED, and the thread is marked as usual.
// dori close --lesson TEXT, given any number of times: each lesson is one record (src/lessons.ts keeps one evidence per
// rule), so the n-th --evidence goes with the n-th --lesson; one --evidence serves them all, none means the Done line. Any
// other count cannot be paired and comes back as the reason, for the close to refuse before it does anything.
export const closeLessons = (rules: readonly string[], evidence: readonly string[], done: string): Pick<LessonInput, "rule" | "evidence">[] | string => {
  if (!rules.length) return [];
  if (evidence.length > 1 && evidence.length !== rules.length) return `${rules.length} --lesson and ${evidence.length} --evidence: give one --evidence per --lesson, one for all, or none (the Done line)`;
  return rules.map((rule, i) => ({ rule, evidence: evidence.length > 1 ? evidence[i]! : (evidence[0] ?? done) }));
};

export const closeLane = async (deps: FlowDeps, lane: Lane, note: string, summary?: string, posted?: string, lessons: readonly Pick<LessonInput, "rule" | "evidence">[] = []): Promise<{ readonly closed: boolean; readonly lines: string[] }> => {
  const exists = deps.exists ?? existsSync;
  const checks = await checkDone(lane.done, deps.run, signalIo(deps, lane));
  const lines = checks.map((c) => `SIGNAL ${c.ok ? "OK " : "NOT"} ${c.signal} -> ${c.detail}`);
  if (checks.some((c) => !c.ok)) return { closed: false, lines: [...lines, `REFUSED ${lane.key}: a Done signal is not live`] };
  const ungated = await gateMissing(deps, lane.done);
  if (ungated.length) return { closed: false, lines: [...lines, ...ungated, `REFUSED ${lane.key}: a PR of a gated repo was not merged through dori merge`] };
  let threadText = "";
  const already = summary?.trim() || !hasThread(lane) ? undefined : (posted ?? lane.claim?.posted);
  if (already) lines.push(`CLOSE_SUMMARY_SKIPPED ${lane.key}: its result is already in the thread (${already}); no second post`);
  else if (hasThread(lane)) {
    const s = await ownerSummary(deps, lane, summary ?? lane.claim?.summary);
    if (!s.text) return { closed: false, lines: [...lines, `CLOSE_SUMMARY_MISSING ${lane.key}: ${s.why ?? "no summary"}`] };
    threadText = s.text;
    lines.push(`CLOSE_SUMMARY ${lane.key} from ${s.source}`);
  }
  const notSent = (why: string) => ({ closed: false, lines: [...lines, `CLOSE_SUMMARY_NOT_SENT ${lane.key} ${lane.thread}: ${why.slice(0, 200)}`] });
  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 160);
  const cleanup: string[] = [];
  const warnings: string[] = [];
  const hook = deps.config.hooks.threadDone;
  // A thread another open lane or an open question card still uses stays as it is: this lane's result is posted as a
  // reply, and the thread is not marked done, renamed or archived. The last lane to close it marks it done.
  const sharing = hasThread(lane) ? (await deps.registry.open()).filter((l) => l.key !== lane.key && l.thread === lane.thread).map((l) => l.key) : [];
  const cards = hasThread(lane) ? (deps.openCards?.(lane.thread) ?? []) : [];
  const standing = hasThread(lane) && lane.thread.startsWith("discord:") && Boolean(deps.standingThread?.(lane.thread));
  const holders = [
    ...(sharing.length ? [`open lane ${sharing.join(", ")} uses it too`] : []),
    ...(cards.length ? [`open card ${cards.join(", ")}`] : []),
    ...(standing ? ["standing thread"] : []),
  ];
  if (already) {
    if (holders.length) cleanup.push(`thread left open: ${holders.join("; ")}; result already posted (${already})`);
    else if (deps.markThreadDone && lane.thread.startsWith("discord:")) cleanup.push(`result already posted (${already})`);
    else {
      // without a Discord token only the threadDone hook marks a thread done, and it posts a text: posting nothing wins
      warnings.push(`THREAD_DONE_WARN ${lane.key} ${lane.thread}: result already posted (${already}) and no Discord token to mark the thread done without a post; mark it by hand`);
      cleanup.push(`result already posted (${already}); thread not marked done`);
    }
  } else if (holders.length) {
    const text = `${lane.title}: ${threadText}`;
    const reply = deps.config.hooks.threadReply;
    if (deps.postInThread && lane.thread.startsWith("discord:")) {
      // straight to Discord, so a waiting (or any) mark stays; the reply hook would mark the thread working
      const why = await deps.postInThread(lane.thread, text).then(() => "", errText);
      if (why) return notSent(why);
    } else if (reply) {
      // the closing lane is still open while its hook runs: DORI_CLOSING_LANE tells dori thread reply not to count it as working
      const r = await deps.run(fill(reply, { thread: lane.thread, text, key: lane.key }), { env: { DORI_CLOSING_LANE: lane.key } });
      if (r.code !== 0) return notSent(`reply hook failed: ${r.err}`);
    } else return notSent("no Discord token and no threadReply hook: nothing can post in the thread");
    cleanup.push(`thread left open: ${holders.join("; ")}; summary posted`);
  } else if (deps.postInThread && deps.markThreadDone && hasThread(lane) && lane.thread.startsWith("discord:")) {
    // straight to Discord, then the done mark and the archive below; the threadDone hook would post a second time
    const why = await deps.postInThread(lane.thread, threadText).then(() => "", errText);
    if (why) return notSent(why);
    cleanup.push("summary posted");
  } else if (hook && hasThread(lane)) {
    // the closing lane is still open while its hook runs: DORI_CLOSING_LANE tells dori thread done not to count it as a user
    const r = await deps.run(fill(hook, { thread: lane.thread, text: threadText, key: lane.key }), { env: { DORI_CLOSING_LANE: lane.key } });
    if (r.code !== 0) return notSent(`thread hook failed: ${r.err}`);
    cleanup.push("summary posted, thread marked done");
  } else if (hasThread(lane)) {
    return notSent("no Discord token and no threadDone hook: nothing can post in the thread");
  } else if (hook) {
    // a missing or broken thread ref would leave the work thread open without a word; say so
    warnings.push(`THREAD_MISSING ${lane.key} thread=${JSON.stringify(lane.thread ?? null)}; threadDone not run, close the thread by hand or set it with dori set-thread first`);
    cleanup.push("thread missing: threadDone not run");
  }
  if (deps.markThreadDone && !holders.length && hasThread(lane) && lane.thread.startsWith("discord:")) {
    try {
      await deps.markThreadDone(lane.thread);
      cleanup.push("thread set done and archived");
    } catch (e) {
      // the lane is finished either way; a thread that could not be renamed is the lead's to fix by hand
      const why = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      warnings.push(`THREAD_DONE_WARN ${lane.key} ${lane.thread}: ${why}`);
      cleanup.push(`thread not set done: ${why}`);
    }
  }
  // the lane's cost, recorded once (src/supervision.ts close), after every point that can still refuse the close: a refused
  // close leaves the lane working, and its later close takes the reading then. A reading or hook that fails is printed and
  // never keeps a verified lane open.
  try {
    const cost = await new Supervision({ stateDir: deps.config.stateDir, run: deps.run, clock: deps.clock, sessionUsage: laneSessionUsage(deps.run, deps.config.sessionsDir) }, deps.config.supervision).close(lane);
    lines.push(`COST ${lane.key} tokens=${cost.tokens ?? "unknown"} costUsd=${cost.costUsd ?? "unknown"}`);
  } catch (e) {
    // Another close (the watcher and a manual close at once) is taking the lane's reading, maybe through its live pane:
    // this one tears nothing down, so that reading is not lost and the other close finishes the lane.
    if (e instanceof CostRecordBusy) return { closed: false, lines: [...lines, ...warnings, `CLOSE_IN_PROGRESS ${lane.key}: ${e.message}; the other close finishes the lane`] };
    lines.push(`COST ${lane.key} not recorded: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
  }
  // an aoe session or a herdr pane is closed by its own backend (the pane id says which; a herdr pane's tab goes only when
  // the pane is all it holds); a lane of another herdr agent keeps the tab/pane close it had
  if (lane.pane && omoPane(deps.config, lane.pane)) {
    cleanup.push(await closeAoeSession(deps.run, lane.pane));
  } else if (lane.tab) cleanup.push((await deps.run(["herdr", "tab", "close", lane.tab])).code === 0 ? `tab ${lane.tab} closed` : `tab ${lane.tab} not closed`);
  else if (lane.pane) cleanup.push((await deps.run(["herdr", "pane", "close", lane.pane])).code === 0 ? `pane ${lane.pane} closed` : `pane ${lane.pane} not closed`);
  const root = lane.cwd ?? deps.config.defaultCwd;
  for (const wt of (await discoverWorktrees(lane, deps.run, [deps.config.defaultCwd])).filter(exists)) {
    const r = await deps.run(["git", "-C", root, "worktree", "remove", wt]);
    cleanup.push(r.code === 0 ? `worktree ${wt} removed` : `worktree ${wt} kept: ${r.err.slice(0, 120)}`);
  }
  const at = iso(deps.clock);
  const receipt = { checks, note, cleanup };
  await deps.registry.write(withStatus(lane, "closed", note, at, { closedAt: at, receipt }));
  // dori close --lesson (dori-superagent #65): kept only after the close is recorded, and a failure to keep it is a warning
  // that never undoes or blocks the close. Each lesson is kept on its own: one that cannot be kept costs only itself.
  for (const lesson of lessons) {
    try {
      lines.push(`LESSON ${new Lessons(deps.config.stateDir).add({ ...lesson, lane: lane.key, cwd: root }, deps.clock.now()).id}`);
    } catch (e) {
      warnings.push(`LESSON_WARNING ${lane.key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Only now, with this lane recorded closed, is it no longer working there. The thread turns waiting when what is left
  // waits on the owner: an open card or a paused lane. A lane still working keeps it working, and a done-claimed one is
  // still ours (the lead decides), so then the mark is left alone. Read again here, since a card answered during the
  // cleanup gives the thread back to work.
  const left = holders.length ? (await deps.registry.open()).filter((l) => l.key !== lane.key && l.thread === lane.thread) : [];
  const ownersTurn = holders.length && left.every((l) => statusOf(l) === "paused") && (left.length > 0 || standing || (deps.openCards?.(lane.thread) ?? []).length > 0);
  if (ownersTurn && deps.requestThreadStatus && lane.thread.startsWith("discord:")) {
    const status = await deps.requestThreadStatus(lane.thread, "waiting").then(
      (outcome) => `waiting requested: ${outcome}`,
      (e: unknown) => `waiting not requested: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`,
    );
    cleanup.push(status);
    // a rate-limited rename is kept and applied later by the listener; say that the mark has not moved yet
    if (!/: (applied|unchanged)$/.test(status)) warnings.push(`THREAD_STATUS_WARN ${lane.key} ${lane.thread}: ${status}`);
    await deps.registry.patch(lane.key, { receipt });
  }
  return { closed: true, lines: [...lines, ...warnings, `CLOSED ${lane.key} ${JSON.stringify(receipt)}`] };
};

const settle = async (deps: FlowDeps, lane: Lane, evidence: string): Promise<string[]> => {
  const blocked = await unpushedWork(deps, lane);
  if (blocked.length) return [await objectDone(deps, lane, blocked)];
  const failing = (await checkDone(lane.done, deps.run, signalIo(deps, lane))).filter((c) => !c.ok).map((c) => `${c.signal} -> ${c.detail}`);
  if (failing.length) return [await objectDone(deps, lane, failing)];
  // the checks take seconds: a dori type that took the claim back meanwhile wins
  const fresh = await deps.registry.read(lane.key);
  if (fresh && statusOf(fresh) !== "done-claimed") return [];
  const verified = withStatus(lane, "verified-done", "Done signals read back live", iso(deps.clock));
  await deps.registry.write(verified);
  const note = `Done: ${evidence}`;
  // the claim's summary is read by closeLane itself; an explicit summary there would post even when the result is in the thread
  const result = await closeLane(deps, verified, note);
  if (!result.closed) {
    // a manual close got there first and finishes the lane: nothing to tell the lane
    const busy = result.lines.find((l) => l.startsWith("CLOSE_IN_PROGRESS "));
    if (busy) return [busy];
    const current = (await deps.registry.read(lane.key)) ?? verified;
    // no summary, or it did not go out: the lead gets the line, and the lane (still idle in its session) is told how to claim again
    const gate = result.lines.find((l) => l.startsWith("CLOSE_SUMMARY_MISSING ") || l.startsWith("CLOSE_SUMMARY_NOT_SENT "));
    if (gate) return [gate, await objectDone(deps, current, [`${gate.startsWith("CLOSE_SUMMARY_MISSING ") ? "no summary for the owner's thread" : "the summary did not reach the owner's thread"} (${gate.split(": ").slice(1).join(": ").slice(0, 300)}); claim again with dori claim-done ${lane.key} --evidence \"...\" --summary \"<2 to 5 plain lines in the owner's language: what changed, what is left, when it reaches where it is used>\"`])];
    return [await objectDone(deps, current, result.lines.filter((l) => l.startsWith("SIGNAL NOT")))];
  }
  return [...result.lines.filter((l) => l.startsWith("CLOSE_SUMMARY ") || l.startsWith("COST ") || l.startsWith("THREAD_MISSING ") || l.startsWith("THREAD_DONE_WARN ") || l.startsWith("THREAD_STATUS_WARN ")), `LANE_CLOSED ${lane.key} ${result.lines.at(-1)?.split(" ").slice(2).join(" ") ?? ""}`];
};

export const watchTick = async (deps: FlowDeps): Promise<string[]> => {
  const out: string[] = [];
  for (const listed of await deps.registry.list()) {
    if (statusOf(listed) === "paused" && listed.claim && !listed.claim.emitted) {
      out.push(`LANE_DONE_CLAIMED_PAUSED ${listed.key} ${listed.pane ?? "-"} ${listed.claim.evidence}`);
      await deps.registry.patch(listed.key, { claim: { ...listed.claim, emitted: true } });
      continue;
    }
    if (statusOf(listed) !== "done-claimed" || !listed.claim) continue;
    let lane = listed;
    const claim = listed.claim;
    if (!claim.emitted) {
      out.push(`LANE_DONE_CLAIMED ${lane.key} ${lane.pane ?? "-"} ${claim.evidence}`);
      lane = { ...lane, claim: { ...claim, emitted: true } };
      await deps.registry.write(lane);
    }
    if (lane.pane && omoPane(deps.config, lane.pane)) {
      const reopened = await claimTurn(deps, lane, lane.claim ?? claim);
      if (reopened) {
        out.push(reopened);
        continue;
      }
    }
    if (deps.clock.now() - Date.parse(claim.at) < windowMs(deps)) continue;
    out.push(...(await settle(deps, (await deps.registry.read(lane.key)) ?? lane, claim.evidence)));
  }
  out.push(...(await pendingGoalTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN pending goal check: ${String(e).slice(0, 200)}`])));
  if (omoSession(deps.config)) {
    out.push(...(await blockedTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN blocked check: ${String(e).slice(0, 200)}`])));
    out.push(...(await autoturnTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN autoturn check: ${String(e).slice(0, 200)}`])));
    out.push(...(await missedAnswersTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN missed answer check: ${String(e).slice(0, 200)}`])));
    out.push(...(await leadDownTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN lead down check: ${String(e).slice(0, 200)}`])));
    out.push(...(await laneDeathTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN lane death check: ${String(e).slice(0, 200)}`])));
    out.push(...(await laneSuspendTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN lane suspend check: ${String(e).slice(0, 200)}`])));
    out.push(...(await leadLimitTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN lead limit check: ${String(e).slice(0, 200)}`])));
    out.push(...(await limitResumeTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN limit resume check: ${String(e).slice(0, 200)}`])));
  }
  return out;
};

// a turn that ended counts as stopped only after it stays ended this long (a goal wake or the next step may follow)
export const IDLE_SETTLE_MS = 45_000;

// A claimed lane answers the claim's [LEAD] line and may get a goal wake, both within IDLE_SETTLE_MS of going idle. Once it
// stayed idle that long, a main turn running again (omo's busy mark) is new work: a text typed some other way than dori
// type, a background result. The claim is taken back and the lane told. A turn before that only restarts the idle clock.
const claimTurn = async (deps: FlowDeps, lane: Lane, claim: NonNullable<Lane["claim"]>): Promise<string | undefined> => {
  const pane = lane.pane ?? "";
  const act = (await paneActivity(deps.run, [pane])).get(pane);
  const now = deps.clock.now();
  if (act === "idle") {
    if (claim.idleAt === undefined) await deps.registry.patch(lane.key, { claim: { ...claim, idleAt: now } });
    return undefined;
  }
  if (act !== "busy" || claim.idleAt === undefined) return undefined;
  if (now - claim.idleAt < IDLE_SETTLE_MS) {
    await deps.registry.patch(lane.key, { claim: { ...claim, idleAt: undefined } });
    return undefined;
  }
  const why = `the lane ran a new turn after it sat idle since ${new Date(claim.idleAt).toISOString()}`;
  const line = await reopenClaim(deps, lane, why);
  await sendVerified(deps.run, deps.clock, deps.config, pane, reopenedText(lane.key, why));
  return line;
};

// LANE_BLOCKED once each time a working lane's agent stops for a human: aoe says waiting or error, an omo question is
// open, or the turn ended and stayed idle; never while the screen shows a running turn. An idle lane whose session still
// waits on background work it started (a detached eval cell, a background bash session or task, a monitor) is BG_WAITING
// instead, a quiet watch-log line, until that work ends or the lane has been idle for blockedWaitMin; work started more
// than blockedWaitMin before the lane went idle (a server or watcher left running) does not count. A job that runs
// longer than an hour is not a human block by itself: on 2026-11-02 pingpong-analytics' long bash_19 and bash_21 aged out of
// "started within the last hour" and the lane was LANE_BLOCKED idle three times while they ran.
export const blockedTick = async (deps: FlowDeps): Promise<string[]> => {
  const lanes = (await deps.registry.open()).filter((l) => l.pane && (statusOf(l) === "working" || statusOf(l) === "not-done"));
  const activity = await paneActivity(deps.run, lanes.map((l) => l.pane ?? ""));
  const now = deps.clock.now();
  const out: string[] = [];
  for (const lane of lanes) {
    const act = activity.get(lane.pane ?? "");
    const idleSince = act === "idle" ? (lane.idleSince ?? now) : undefined;
    let blocked = act === "waiting" || act === "error" || act === "question" ? act : idleSince !== undefined && now - idleSince >= IDLE_SETTLE_MS ? "idle" : undefined;
    let waitingOn: string | undefined;
    const waitMs = deps.config.blockedWaitMin * 60_000;
    if (blocked === "idle" && lane.blocked !== "idle" && idleSince !== undefined && now - idleSince < waitMs) {
      // an end that landed within the settle time may not have woken the lane yet; it counts once the lane stayed idle after it
      const jobs = await laneBackground(deps.run, deps.config.sessionsDir, lane.pane ?? "", lane.cwd ?? "", now - IDLE_SETTLE_MS, idleSince - waitMs).catch((e: unknown) => {
        out.push(`LANE_WATCH_WARN background check ${lane.key}: ${String(e).slice(0, 160)}`);
        return undefined;
      });
      if (jobs?.length) {
        blocked = undefined;
        waitingOn = jobs.map((j) => `${j.kind}:${j.id}`).join(",");
      }
    }
    if (blocked === lane.blocked && idleSince === lane.idleSince && waitingOn === lane.waitingOn) continue;
    await deps.registry.patch(lane.key, { blocked, idleSince, waitingOn });
    if (waitingOn && waitingOn !== lane.waitingOn) out.push(`BG_WAITING ${lane.key} ${waitingOn} ${lane.pane}`);
    if (blocked && blocked !== lane.blocked) out.push(`LANE_BLOCKED ${lane.key} ${blocked} ${lane.pane}`);
  }
  return out;
};

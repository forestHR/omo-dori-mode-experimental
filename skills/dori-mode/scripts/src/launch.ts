import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";

import { agentPath, AoeError, BUSY_MARK, envMismatch, forwardEnv, inputLine, laneEnv, openAoeSession, paneLife, target, WAKE_MARKS } from "./aoe.ts";
import { turnRunning } from "./submit.ts";
import { isHerdrPane, openHerdrSession } from "./herdr.ts";
import { type Backend, fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { agentGone, firstTurnRuns, GOAL_WAIT, goalReader, lastLines, noGoalWhy } from "./pending-goal.ts";
import { AGENT, argvSessionId, descendants, ended, hasSessionSelector, procTable, sessionDirFor, shellPidOf } from "./session-id.ts";
import { leadReplies } from "./lead-limit.ts";
import { omoSession, readScreen, sendVerified } from "./panes.ts";
import { hasThread, LANE_KEY, type Lane, NO_THREAD, threadRefProblem } from "./registry.ts";
import { areaLabel, type AreaQuery, areaSignals, pastSignalsSection, tagsOf } from "./lane-signals.ts";
import { iso } from "./run.ts";
import { checkDone, doneSyntaxErrors, weakDone } from "./done-signals.ts";
import { laneArea, loadTree, treeSection } from "./explore.ts";
import { watchLog } from "./watch-log.ts";
import { StartRefused } from "./backlog.ts";
import { relatedLines, relatedThreads, type RelatedThread } from "./related-thread.ts";
import { addedLine, checkedLedger, type Ledger, missingLines, planDirectives, repoName, scopeContext, uiHits, scopeText, waivedLines, withDirectives } from "./directives.ts";
import { join } from "node:path";
import type { BudgetLimits } from "./supervision.ts";

export type LaunchInput = {
  readonly key: string;
  readonly title: string;
  readonly brief: string;
  readonly done: string;
  // the work thread: <adapter>:<id> of the thread the work continues in, or NEW_THREAD for one launch opens in this Dori's channel
  readonly thread?: string;
  // lane caps over the config's (launch --wall-minutes N|none --token-limit N|none --cost-limit N|none) and extra activity files
  readonly budget?: BudgetLimits;
  readonly activityPaths?: readonly string[];
  // why the lane has no work thread (dori launch --no-thread "<reason>"): only a lane the owner did not ask for
  readonly noThread?: string;
  // why --thread new opens a new thread though related open threads were shown (dori launch --why-new "<reason>")
  readonly whyNew?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly tags?: readonly string[];
  // launch without the LAUNCH_DONE_WEAK warning
  readonly doneWeakOk?: boolean;
  // the owner's goal in their own words, kept in the registry for dori intent-check
  readonly goal?: string;
  // big steps the lane must put through dori challenge first
  readonly challengeBefore?: readonly string[];
  // the lane needs the GPU: its sessions start without config launchEnv
  readonly useGpu?: boolean;
  // UI work: the owner's seven UI steps (references/ui-work.md) go at the top of the brief
  readonly ui?: boolean;
  // directive id -> the lead's reason: dori launch --waive <id> "<reason>" leaves that directive of the ledger out
  readonly waive?: Readonly<Record<string, string>>;
  // started by the backlog pass (dori backlog), the only launch that may use a "bl-" key
  readonly backlog?: boolean;
};

export class LaunchError extends Error {}
// The session could not be opened (the terminal backend failed): worth another try, unlike every other LaunchError, which
// the launch input itself causes and which no retry changes.
export class LaunchFailed extends LaunchError {
  // the work thread this launch had already opened (--thread new): the next try continues there instead of opening another
  constructor(message: string, readonly thread?: string) {
    super(message);
  }
}

/** A launch error as the backlog pass sees it: a refusal holds the item at once, an operational failure is tried again. */
export const asStartFailure = (e: unknown): unknown => (e instanceof LaunchError && !(e instanceof LaunchFailed) ? new StartRefused(e.message) : e);

// --thread new: dori launch opens the lane's work thread in this Dori's own channel (deps.openThread), named for --title
export const NEW_THREAD = "new";

// A launch with no work thread and no --no-thread reason, or a channel as its thread: nothing was opened, written or registered.
export class ThreadMissingError extends LaunchError {}

// --thread new while related open threads exist and no --why-new: the LAUNCH_RELATED_THREAD lines; nothing was opened.
export class RelatedThreadError extends ThreadMissingError {}

// A require directive of the ledger the brief does not meet: nothing was opened, written or registered.
export class DirectiveMissingError extends LaunchError {
  constructor(readonly lines: readonly string[]) {
    super(lines.join("\n"));
  }
}

const STARTUP_FAILURE = /Cannot find module|All fallback models failed|No API key|model_not_available|usage limit|rate limit|quota|Session crashed|unknown provider|Model "[^"\n]*" not found|Pane is dead/i;

// A failure word is a failed start only where the agent itself put it (dori-superagent PR #51 review reproduced here (MIT):
// https://github.com/sisyphuslabs/dori-superagent/pull/51#discussion_r4445875794, a working lane quotes such words). On
// 2026-11-02 two healthy lanes got STARTUP_ERROR rate limit from the 40 lines launch reads: the cat of a log, the lane's
// own brief in a tool result, and the status lines under the input box (the session title and goal objective omo makes
// from the brief, the account usage bars). Measured on omo 5.1.51: its own errors are one line each, drawn above the
// input box at most one space in, as "Error: ..." (No API key found, 429, out of quota; the CLI's Model "x" not found),
// "The <provider> account usage limit has been reached" or "All <name> accounts for <provider> are currently blocked";
// tmux adds "Pane is dead" at the bottom; bun's own crash is "error: Cannot find module". So a failure word counts only on
// such a line (prose that merely starts with a failure word or "Error handling ..." is none), never while a turn runs (a
// running lane quotes what it reads; a 429 omo retries shows no running-turn mark and still counts), and never once the
// model has answered this launch: the newest reply in the lane's own session, written since the launch began, ended
// without an error (a resumed session's older replies say nothing about this start).
const OWN_ERROR = /^ ?(?:error:|All \S+ accounts for \S+ are currently blocked|The \S+ account usage limit has been reached|Pane is dead)/i;

// omo draws its running-turn mark ("── • Working (4s • esc to interrupt) ──") on the border right above the ❯ line;
// the status lines under the box may quote the words (a session title), so only the lines just above the ❯ are read
export const startupFailure = (screen: string, answered = false): string | undefined => {
  const lines = screen.split("\n");
  const box = lines.findLastIndex((l) => l.trimStart().startsWith("❯"));
  const running = box >= 0 && lines.slice(Math.max(0, box - 3), box).some((l) => l.toLowerCase().includes(BUSY_MARK));
  if (answered || running) return undefined;
  for (const [i, line] of lines.entries()) {
    const own = box < 0 || i < box ? OWN_ERROR.test(line) : line.startsWith("Pane is dead");
    const bad = own ? STARTUP_FAILURE.exec(line) : null;
    if (bad) return bad[0];
  }
  return undefined;
};

// whether the newest model reply in the lane's own session (the exact id from its command line, under the cwd or its real
// path) is from this launch (at or after since) and ended without an error; no id, no transcript or no such reply is none
const modelAnswered = (sessionsDir: string, cwd: string, session: string, since: number): boolean => {
  if (!session) return false;
  const at = resolve(cwd);
  let real = at;
  try {
    real = realpathSync(at);
  } catch {}
  for (const dir of new Set([sessionDirFor(sessionsDir, at), sessionDirFor(sessionsDir, real)])) {
    try {
      const name = readdirSync(dir).find((n) => n.endsWith(`_${session}.jsonl`));
      if (!name) continue;
      const last = leadReplies(readFileSync(join(dir, name), "utf8")).at(-1);
      return last !== undefined && last.at >= since && last.error === undefined;
    } catch {}
  }
  return false;
};

const failureOf = (deps: FlowDeps, screen: string, cwd: string, session: string, since: number): string | undefined =>
  startupFailure(screen, modelAnswered(deps.config.sessionsDir, cwd, session, since));

export const validateLaunch = async (deps: FlowDeps, input: LaunchInput): Promise<void> => {
  if (!LANE_KEY.test(input.key)) throw new LaunchError(`key must match ${LANE_KEY}`);
  // backlog lanes are bl-<item>: no other launch takes such a key, so an ordinary lane never shares one with the backlog
  if (input.key.startsWith("bl-") && !input.backlog) throw new LaunchError(`key ${input.key}: keys starting with bl- belong to the backlog (dori backlog); pick another key`);
  if (await deps.registry.read(input.key)) throw new LaunchError(`lane ${input.key} is already registered`);
  if (input.thread !== undefined && input.thread !== NO_THREAD && input.thread !== NEW_THREAD) {
    const problem = threadRefProblem(input.thread);
    if (problem) throw new LaunchError(`${problem}; pass --thread <adapter>:<id> or --thread ${NEW_THREAD}`);
  }
  const errors = doneSyntaxErrors(input.done);
  if (errors.length) throw new LaunchError(`Done line is not checkable: ${errors.join("; ")}`);
};

// The owner's long work gets a work thread (directive long-work-thread): a launch names the open thread the work continues
// in (--thread <ref>), has one opened in this Dori's own channel (--thread new), or says why the lane has none
// (--no-thread "<reason>", a lane the owner did not ask for). A channel is not a thread. dori adopt is not gated: it
// registers a session that is already running, an older lane without a thread among them.
export const threadGate = (deps: Pick<FlowDeps, "openThread" | "channels">, input: LaunchInput): void => {
  const threadless = input.thread === undefined || input.thread === NO_THREAD;
  if (input.whyNew !== undefined) {
    if (!input.whyNew.trim()) throw new LaunchError(`--why-new needs a reason: --why-new "<why this is not the work of the related threads>"`);
    if (input.thread !== NEW_THREAD) throw new LaunchError(`--why-new goes with --thread ${NEW_THREAD} only: it says why a new thread opens though related ones are open`);
  }
  if (input.noThread !== undefined) {
    if (!input.noThread.trim()) throw new LaunchError(`--no-thread needs a reason: --no-thread "<why this lane has no work thread>"`);
    if (!threadless) throw new LaunchError(`pass --thread or --no-thread "<reason>", not both`);
    return;
  }
  if (threadless)
    throw new ThreadMissingError(
      `LAUNCH_NO_THREAD ${input.key}: a lane opens with a work thread (the owner's long work gets one: directive long-work-thread); nothing was opened. Pass --thread <adapter>:<id> for the open thread this work continues, --thread ${NEW_THREAD} to open one in this Dori's own channel, or --no-thread "<reason>" for a lane the owner did not ask for.`,
    );
  if (input.thread === NEW_THREAD) {
    if (!deps.openThread) throw new LaunchError(`--thread ${NEW_THREAD} opens the work thread in this Dori's own channel and needs DORI_DISCORD_TOKEN and DORI_DISCORD_CHANNEL; pass --thread <adapter>:<id> instead`);
    return;
  }
  const id = input.thread.startsWith("discord:") ? input.thread.slice("discord:".length) : "";
  if (id && deps.channels?.includes(id))
    throw new ThreadMissingError(`LAUNCH_THREAD_IS_CHANNEL ${input.key}: ${input.thread} is a channel, not a thread; nothing was opened. Pass --thread ${NEW_THREAD} to open a work thread in it, or the ref of a thread.`);
};

const readText = (path: string): Promise<string> => Promise.resolve().then(() => Bun.file(path).text()).catch(() => "");

// The open threads the lane's work may continue (src/related-thread.ts), from the registry and the briefs of its lanes.
export const relatedFor = async (deps: Pick<FlowDeps, "registry" | "config" | "clock" | "channels">, input: LaunchInput): Promise<RelatedThread[]> => {
  const lanes = await deps.registry.list();
  const briefs = new Map(await Promise.all(lanes.map(async (l) => [l.key, await readText(l.brief)] as const)));
  const brief = await readText(input.brief);
  return relatedThreads(lanes, { key: input.key, title: input.title, brief, cwd: input.cwd ?? deps.config.defaultCwd, ...(input.tags?.length ? { tags: input.tags } : {}) }, {
    now: deps.clock.now(),
    settings: deps.config.related,
    channels: deps.channels ?? [],
    defaultCwd: deps.config.defaultCwd,
    briefOf: (l) => briefs.get(l.key) ?? "",
  });
};

// Related lanes stay in one thread: --thread new shows the related open threads first (LAUNCH_RELATED_THREAD) and opens
// nothing until the lead passes --thread <ref> of one of them, or --why-new "<reason>" for work that is not theirs (that
// reason is kept in the registry and the watch log: LAUNCH_NEW_THREAD_WHY). Nothing is ever joined on its own: a wrong
// guess in someone else's thread is worse than a new one. Without related threads --thread new opens as before.
export const relatedGate = async (deps: Pick<FlowDeps, "registry" | "config" | "clock" | "channels">, input: LaunchInput): Promise<string[]> => {
  if (input.thread !== NEW_THREAD) return [];
  const found = await relatedFor(deps, input);
  const why = input.whyNew?.trim();
  if (!found.length) return why ? [`LAUNCH_NEW_THREAD_WHY ${input.key}: no related open thread; reason kept: ${why}`] : [];
  if (!why) throw new RelatedThreadError(relatedLines(input.key, found).join("\n"));
  return [`LAUNCH_NEW_THREAD_WHY ${input.key}: a new thread though ${found.length} related open thread(s) were found (${found.map((t) => t.thread).join(", ")}), on the lead's word: ${why}`];
};

// A warning, never a refusal: a Done line that only checks files or text proves the files are there, not that the work behaves.
export const doneWeakWarning = async (input: LaunchInput, cwd: string): Promise<string | undefined> => {
  if (input.doneWeakOk) return undefined;
  const weak = await weakDone(input.done, { cwd });
  return weak
    ? `LAUNCH_DONE_WEAK ${input.key}: every Done signal only checks files or text (${weak}). Add at least one that measures the behavior: a command that runs it or its tests (command ["bun","test"] stdout~" 0 fail"), or a url with status= and body~. --done-weak-ok silences this.`
    : undefined;
};

// The owner's seven UI steps: the block between the markers in references/ui-work.md, the one copy of their wording.
export const UI_WORK_DOC = join(import.meta.dir, "../../references/ui-work.md");
export const uiSteps = async (doc = UI_WORK_DOC): Promise<string> => {
  const m = /<!-- ui-steps:begin -->\n([\s\S]*?)\n<!-- ui-steps:end -->/.exec(await Bun.file(doc).text());
  if (!m?.[1]) throw new LaunchError(`no ui-steps block in ${doc}`);
  return m[1];
};

// The steps right after the first line when it is the ulw line, else at the very top; a brief that already has them is left alone.
export const withUiSteps = (brief: string, steps: string): string => {
  if (brief.includes(steps.split("\n")[0] ?? steps)) return brief;
  const lines = brief.split("\n");
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0 && /^ulw\b/i.test(lines[first]?.trim() ?? "")) return [...lines.slice(0, first + 1), "", steps, ...lines.slice(first + 1)].join("\n");
  return `${steps}\n\n${brief}`;
};

// The owner's eight steps (1. 조사 ... 8. 보고) of the brief template in references/sessions.md, the one copy of their wording.
export const SESSIONS_DOC = join(import.meta.dir, "../../references/sessions.md");
export const eightSteps = async (doc = SESSIONS_DOC): Promise<string> => {
  const template = /```text\n(ulw\n[\s\S]*?)```/.exec(await Bun.file(doc).text())?.[1] ?? "";
  const m = /^1\. 조사:[\s\S]*?^8\. 보고:[^\n]*$/m.exec(template);
  if (!m) throw new LaunchError(`no eight-step block (1. 조사: ... 8. 보고:) in the brief template of ${doc}`);
  return m[0];
};

const FIELD = /^\s*\[(?:목표|끝난 상태|사용자와 장면|넘으면 안 되는 선)\]/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A brief with none of the eight step headings gets the whole block after the four fields (after the ulw line when it has
// no fields, else at the top); one with all eight is left alone; one with some of them is an edited frame: left as the
// lead wrote it, with a warning.
export const withEightSteps = (brief: string, steps: string): { readonly text: string; readonly added: boolean; readonly missing: readonly number[] } => {
  const heads = [...steps.matchAll(/^([1-8])\. ([^:\n]+):/gm)].map(([, n, name]) => ({ n: Number(n), re: new RegExp(`^\\s*${n}\\.\\s*${escapeRe(name ?? "")}\\s*:`, "m") }));
  const missing = heads.filter((h) => !h.re.test(brief)).map((h) => h.n);
  if (missing.length < heads.length) return { text: brief, added: false, missing };
  const lines = brief.split("\n");
  const lastField = lines.reduce((at, l, i) => (FIELD.test(l) ? i : at), -1);
  let at: number;
  if (lastField >= 0) {
    at = lastField + 1;
    while (at < lines.length && lines[at]?.trim()) at++;
  } else {
    const first = lines.findIndex((l) => l.trim());
    at = first >= 0 && /^ulw\b/i.test(lines[first]?.trim() ?? "") ? first + 1 : 0;
  }
  const before = lines.slice(0, at);
  const after = lines.slice(at);
  while (after.length && !after[0]?.trim()) after.shift();
  const text = [...before, ...(before.length ? [""] : []), steps, ...(after.length ? ["", ...after] : [])].join("\n");
  return { text, added: true, missing };
};

export const stepsLine = (key: string, r: { readonly added: boolean; readonly missing: readonly number[] }): string | undefined =>
  r.added
    ? `LAUNCH_STEPS_ADDED ${key}: the brief had none of the owner's eight steps (1. 조사 ... 8. 보고, references/sessions.md); added them as written there, after the four fields.`
    : r.missing.length
      ? `LAUNCH_STEPS_PARTIAL ${key}: the brief has only some of the owner's eight steps (missing ${r.missing.join(", ")}); left as the lead wrote it, nothing added. Check that the edit was meant.`
      : undefined;

// The lead's brief reads like UI work (two UI words, one of them not 화면; quoted words and directive names do not count) and
// --ui is missing. added: the directive ledger put the UI steps in anyway (directive ui-steps); without a ledger they are not.
export const uiWarning = (input: LaunchInput, brief: string, ledger: Pick<Ledger, "entries"> = { entries: [] }, added = false): string | undefined => {
  if (input.ui) return undefined;
  const hits = uiHits(scopeText(brief, ledger));
  if (!hits.length) return undefined;
  const words = [...new Set(hits)].slice(0, 4).join(", ");
  return added
    ? `LAUNCH_UI_HINT ${input.key}: the brief reads like UI work (${words}) and has no --ui; the owner's seven UI steps (references/ui-work.md, directive ui-steps) were put in. Launch UI work with --ui; when it is not UI work, --waive ui-steps "<reason>".`
    : `LAUNCH_UI_HINT ${input.key}: the brief reads like UI work (${words}) but has no --ui, so the owner's seven UI steps (references/ui-work.md) are not in it. Launched as is; for UI work, launch with --ui.`;
};

export const footer = (lane: Lane, leadPane: string, backend: Backend = "herdr", gated: readonly string[] = []): string => [
  "",
  "## Lane footer (written by dori launch)",
  `- Key: ${lane.key}. Work thread: ${lane.thread}.`,
  `- Done = ${lane.done}. The lane closes only when every signal reads back live.`,
  `- Report to the lead at each milestone: [REPORT] ${lane.key} | <milestone|blocker|question|done> | <one plain line: what is done, and what the owner has to do if anything>; the evidence (ids, paths, hashes, numbers, links) goes on the lines below that first line, never in it, and a (fix: ...) tag stays on the first line. Type it into ${backend === "aoe" ? "tmux session" : "pane"} ${leadPane || "(lead pane)"} with dori type, as an argv array, never a shell string: run ["dori","type","${leadPane || "(lead pane)"}","--text","<report line>"]. It prints SUBMITTED once the lead took it; NOT_SUBMITTED <reason> (exit 1) means it did not arrive: send it once more. Keep backticks and $( out of the text (dori type refuses them).`,
  `- A report that is a fix attempt for a failing check or metric carries (fix: <metric> / <hypothesis>). The lead's stuck ladder counts failed attempts on one metric, tagged or not: from the 2nd, competing hypotheses before the next patch; at the 3rd, ulw research and a dori challenge of your next plan (sent to you, in this session); after that, or with one hypothesis tried 3 times, the lead may move you to a new session. A blocker, an impossible or an ambiguous task is a fine report (| blocker |), better than another retry.`,
  `- Stuck after a fix that did not move the metric: before the next patch, write at least 3 competing hypotheses with one cheap discriminating test each, run the tests, and record what they showed (dori tree add|falsify|support --lane ${lane.key}). The lead's dori fix-attempt refuses a second attempt on one metric without them.`,
  `- Big memory work (a large model, a long GPU run) goes through dori heavy <label> --mem <estimate, e.g. 70G> -- <command>, never inside this session's own process (an eval kernel, a shell of this session): there a job over its memory dies alone in its own scope, while inside the session it takes the whole lane down with it.`,
  `- Heavy browser, CPU or build test bundles go through dori heavy <label> --kind browser|cpu --sync <every folder or file the command reads or writes> -- <command>, not a hand-made core lock: the less busy PC runs it and its output, files and exit code come back here (HEAVY_LOCAL <why> means it stayed here; add the path it names to --sync).`,
  ...(lane.goal ? [`- Goal (owner words): "${lane.goal}". At each stage change (a new phase, a pivot, before a big step) run dori intent-check ${lane.key} --direction "<what you do now>" --next "<next step>" (a reviewer model reads it against the owner's words) and say in your report how the step serves this goal.`] : []),
  ...(lane.challengeBefore?.length ? [`- Before ${lane.challengeBefore.map((s) => `"${s}"`).join(" or ")}: write the plan to a file and run dori challenge ${lane.key} --plan <file> (a model of another family reviews it); answer its reasons in your next report. A done claim is refused until a challenge is on record.`] : []),
  `- After each finished step run dori checkpoint ${lane.key} --step <unique step> --result <result> --evidence <path or link> [--remote-effect <receipt of a push, merge or deploy it did>] (one flag per receipt). On resume run dori checkpoints ${lane.key} before any work and never repeat a recorded remote effect; after a crash between a remote action and its checkpoint, read the live remote state first.`,
  `- What you learn goes to one place: a standing instruction of the owner to the lead in a [REPORT] for the directive ledger, a lesson, fact or how the work went into your omo memory, and the report stays the record (references/done-protocol.md).`,
  ...(gated.length ? [`- A PR in ${gated.join(", ")} merges only through the review gate: in a clean checkout of the PR's head run dori review <repo>#<N> (it runs the tests there first, then a reviewer of another model family; VERDICT: CLEAR is needed; a PR with GitHub checks or auto-merge is refused as unsupported), then dori merge <repo>#<N>, which merges only that exact head (--match-head-commit). A commit pushed after the review needs dori review again; a PR merged with plain gh pr merge makes claim-done refuse (MERGE_GATE_MISSING).`] : []),
  `- When done: dori claim-done ${lane.key} --evidence "<merge SHA, closed issue, version>"${hasThread(lane) ? ` --summary "<2 to 5 plain lines for the owner, in his language: what changed, what is left, when it reaches where it is used; no paths, hashes or codes>" (your one result post: the close posts it in the work thread; if you already posted your result there yourself in the last 30 minutes, the close posts nothing more, so never post it twice; without --summary and a post the close has a model write one from your last report and REPORT.md)` : ""}. See references/done-protocol.md.`,
  "",
].join("\n");

const intentFields = (input: LaunchInput): Partial<Lane> => ({ ...(input.goal?.trim() ? { goal: input.goal.trim() } : {}), ...(input.challengeBefore?.length ? { challengeBefore: input.challengeBefore } : {}), ...(input.useGpu ? { useGpu: true } : {}), ...(input.ui ? { ui: true } : {}) });

const EMPTY_LEDGER: Ledger = { entries: [], kinds: {}, minHits: 3, labels: [], standing: "", reviewed: [], fillers: [], files: [] };
// config directives.common and .local; a broken ledger stops the launch (it would let directives through unseen)
export const launchLedger = (deps: Pick<FlowDeps, "config">): Ledger => (deps.config.directives.common || deps.config.directives.local ? checkedLedger(deps.config) : EMPTY_LEDGER);

// The repo a lane works in (directive scope "repos"): its origin remote's name, else its directory's name.
export const laneRepo = async (deps: Pick<FlowDeps, "run">, cwd: string): Promise<string> => {
  const r = await deps.run(["git", "-C", cwd, "remote", "get-url", "origin"]);
  return repoName(r.code === 0 ? r.out : "", cwd);
};

export const adoptLane = async (deps: FlowDeps, input: LaunchInput & { readonly pane: string }): Promise<Lane> => {
  await validateLaunch(deps, input);
  const lane: Lane = { key: input.key, title: input.title, thread: input.thread ?? "none", pane: input.pane, brief: resolve(input.brief), done: input.done, cwd: input.cwd ?? deps.config.defaultCwd, ...(input.tags?.length ? { tags: input.tags } : {}), ...intentFields(input), openedAt: iso(deps.clock) };
  await deps.registry.write(lane);
  return lane;
};

// A lane put on a thread works there: one left ✅ or ⏸️, or archived (a lane closed in it before), is opened again and
// marked 🔄, as closeLane and dori resume decide it (a working lane makes its thread working, past an open card). The
// rename goes through the thread status queue, so Discord's rename limit parks it for the listener instead of failing.
// A thread already 🔄 and open is only read. Without a Discord token or a discord: ref nothing is done.
export const reopenLaneThread = async (deps: FlowDeps, lane: Lane): Promise<string | undefined> => {
  if (!deps.reopenThread || !lane.thread.startsWith("discord:")) return undefined;
  const line = await deps.reopenThread(lane.thread, lane.title).then(
    (outcome) => `THREAD_REOPEN ${lane.key} ${lane.thread}: working requested: ${outcome}`,
    (e: unknown) => `THREAD_REOPEN_WARN ${lane.key} ${lane.thread}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`,
  );
  watchLog(deps.config.watchLog, deps.clock, { source: "launch", line });
  return line;
};

// Points an existing lane at another work thread, e.g. one made after the lane was launched; the lane works there now.
export const setThread = async (deps: FlowDeps, lane: Lane, ref: string): Promise<string> => {
  const problem = threadRefProblem(ref);
  if (problem) throw new LaunchError(problem);
  await deps.registry.patch(lane.key, { thread: ref });
  const reopened = await reopenLaneThread(deps, { ...lane, thread: ref });
  return [`THREAD_SET ${lane.key} ${lane.thread || "-"} -> ${ref}`, ...(reopened ? [reopened] : [])].join("\n");
};

// The lane's brief with its footer's Done line set to the new one and a line under it saying what it was and why it
// changed (newest first). A brief without that line (adopted lanes) gets both at its end.
export const briefWithDone = (brief: string, done: string, change: { readonly at: string; readonly from: string; readonly reason: string }): string => {
  const doneLine = `- Done = ${done}. The lane closes only when every signal reads back live.`;
  const changed = `- Done changed ${change.at} (dori done-set): ${change.reason}. Earlier: Done = ${change.from}`;
  const lines = brief.split("\n");
  const i = lines.findIndex((l) => l.startsWith("- Done = "));
  if (i < 0) return `${brief.replace(/\n*$/, "")}\n\n## Done changed (written by dori done-set)\n${doneLine}\n${changed}\n`;
  return [...lines.slice(0, i), doneLine, changed, ...lines.slice(i + 1)].join("\n");
};

// The lead changes an open lane's Done line when the plan changed after launch (the old signals can no longer read back
// live, though the work is done). The new line must parse like a launch's, the reason is required, and the new signals
// are read once now; every signal still has to read back live for dori close or the watcher to close the lane. The
// earlier line stays in the lane's doneChanges, the watch log gets a DONE_SET line, the brief's footer is updated and
// the lane is told.
export const setDone = async (deps: FlowDeps, lane: Lane, done: string, reason: string): Promise<string[]> => {
  const next = done.trim().replace(/^Done\s*=\s*/i, "");
  if (!reason.trim()) throw new LaunchError("--reason is required: why the Done line changed");
  const errors = doneSyntaxErrors(next);
  if (errors.length) throw new LaunchError(`Done line is not checkable: ${errors.join("; ")}`);
  if (next === lane.done.trim()) throw new LaunchError(`lane ${lane.key} already has this Done line`);
  const checks = await checkDone(next, deps.run, { cwd: lane.cwd ?? deps.config.defaultCwd, ...deps.signalIo });
  const live = checks.filter((c) => c.ok).length;
  const at = iso(deps.clock);
  const change = { at, from: lane.done, to: next, reason: reason.trim(), live: live === checks.length };
  await deps.registry.patch(lane.key, { done: next, doneChanges: [...(lane.doneChanges ?? []), change] });
  watchLog(deps.config.watchLog, deps.clock, { source: "done-set", line: `DONE_SET ${lane.key} live ${live}/${checks.length}; reason: ${change.reason}; was: ${lane.done}; now: ${next}` });
  const out = checks.map((c) => `SIGNAL ${c.ok ? "OK " : "NOT"} ${c.signal} -> ${c.detail}`);
  try {
    await Bun.write(lane.brief, briefWithDone(await Bun.file(lane.brief).text(), next, change));
    out.push(`BRIEF_UPDATED ${lane.brief}`);
  } catch (e) {
    out.push(`DONE_SET_BRIEF_WARN ${lane.key} ${lane.brief}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
  }
  if (lane.pane) {
    const text = `[LEAD] Done line changed for ${lane.key}: ${change.reason}. The new line is in your brief's Lane footer (${lane.brief}); the lane closes only when it reads back live.`;
    await sendVerified(deps.run, deps.clock, deps.config, lane.pane, text).then(
      (ok) => out.push(ok ? `LANE_TOLD ${lane.pane}` : `DONE_SET_NOT_SENT ${lane.key} ${lane.pane}: not submitted (see NOT_SUBMITTED in the watch log)`),
      (e: unknown) => out.push(`DONE_SET_NOT_SENT ${lane.key} ${lane.pane}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`),
    );
  }
  out.push(
    change.live
      ? `DONE_SET ${lane.key} live ${live}/${checks.length}: every new signal reads back live; dori close ${lane.key} closes it now`
      : `DONE_SET ${lane.key} live ${live}/${checks.length}: not every new signal reads back live yet; the lane closes once they do`,
  );
  return out;
};

// Marks whether a lane's sessions start without launchEnv. The running session keeps the environment it started with.
export const setGpu = async (deps: FlowDeps, lane: Lane, on: boolean): Promise<string> => {
  await deps.registry.patch(lane.key, { useGpu: on });
  return `GPU_SET ${lane.key} ${lane.useGpu ? "on" : "off"} -> ${on ? "on" : "off"}: applies from its next handover or restart; the running session keeps its environment`;
};

// env(1) arguments that restart a session the way dori opens it (setups/discord-aoe/self-restart.sh): NAME=VALUE for an
// open lane without --use-gpu, --unset=NAME for anything else (a GPU lane, the lead, a session no lane owns). Nothing
// when launchEnv is empty; otherwise its names go into tmux update-environment first.
export const launchEnvArgs = async (deps: FlowDeps, pane: string): Promise<string[]> => {
  const names = Object.keys(deps.config.launchEnv);
  if (!names.length) return [];
  const lane = (await deps.registry.list()).find((l) => l.pane === pane && l.status !== "closed");
  await forwardEnv(deps.run, names);
  // env(1) reads options only before the first NAME=VALUE (a later --unset=X would set a variable named "--unset")
  const env = Object.entries(laneEnv(deps.config.launchEnv, !lane || lane.useGpu));
  return [...env.filter(([, v]) => v === undefined).map(([name]) => `--unset=${name}`), ...env.flatMap(([name, value]) => (value === undefined ? [] : [`${name}=${value}`]))];
};

// Earlier lanes in the same repo (a cwd other than the default one) or with a shared tag, for the new brief.
export const pastSignals = async (deps: FlowDeps, input: LaunchInput, cwd: string): Promise<string | undefined> => {
  const q: AreaQuery = { ...(cwd !== deps.config.defaultCwd ? { cwd } : {}), tags: tagsOf({ key: input.key, tags: input.tags }) };
  const list = await areaSignals(await deps.registry.list(), q, deps.config);
  return pastSignalsSection(areaLabel(q), list, deps.config.signals.launchLanes);
};

// The hypothesis trees of the new lane's area (its repo, else its first tag) and of its other tags, in compact form.
export const treeContext = async (deps: FlowDeps, draft: Lane): Promise<string | undefined> => {
  const main = laneArea(draft, deps.config);
  const areas = [main, ...tagsOf(draft).filter((t) => t !== main.tag).map((tag) => ({ tag }))];
  const trees = await Promise.all(areas.map((a) => loadTree(deps.config.stateDir, a)));
  return treeSection(trees, deps.config.explore.treeLines, `dori tree --lane ${draft.key}`);
};

const draftLane = (deps: FlowDeps, input: LaunchInput): Lane => ({
  ...(input.noThread?.trim() ? { noThread: input.noThread.trim() } : {}),
  ...(input.whyNew?.trim() ? { whyNew: input.whyNew.trim() } : {}),
  // the brief as an absolute path: the audit, intent-check and freshness read it from another directory than the lead's
  key: input.key, title: input.title, thread: input.thread ?? "none", brief: resolve(input.brief), done: input.done, cwd: input.cwd ?? deps.config.defaultCwd, model: input.model ?? deps.config.defaultModel,
  ...(input.tags?.length ? { tags: input.tags } : {}), ...intentFields(input), openedAt: iso(deps.clock),
  ...(input.budget && Object.keys(input.budget).length ? { budget: input.budget } : {}), ...(input.activityPaths?.length ? { activityPaths: input.activityPaths } : {}),
});

export type Rendered = {
  readonly draft: Lane;
  readonly text: string;
  readonly steps?: string;
  // LAUNCH_UI_HINT, LAUNCH_DIRECTIVE_ADDED and LAUNCH_DIRECTIVE_WAIVED lines, for the lead and the watch log
  readonly lines: readonly string[];
  // LAUNCH_DIRECTIVE_MISSING lines: the launch stops when there is one
  readonly missing: readonly string[];
};

// The brief as the lane will read it: the lead's text with the eight steps, the UI steps for UI work and the directives of
// the ledger in scope it lacks, then Past signals, the hypothesis tree, and the footer.
export const renderBrief = async (deps: FlowDeps, input: LaunchInput): Promise<Rendered> => {
  const briefFile = Bun.file(input.brief);
  if (!(await briefFile.exists())) throw new LaunchError(`brief not found: ${input.brief}`);
  const raw = (await briefFile.text()).replace(/\s*$/, "");
  const cwd = input.cwd ?? deps.config.defaultCwd;
  const ledger = launchLedger(deps);
  const ctx = scopeContext(raw, ledger, { ui: input.ui, repo: ledger.entries.length ? await laneRepo(deps, cwd) : "" });
  const plan = planDirectives(raw, ledger, ctx, input.waive);
  const ui = Boolean(input.ui) || plan.blocks.includes("ui-steps");
  const at = iso(deps.clock);
  const draft: Lane = { ...draftLane(deps, input), ...(ui ? { ui: true } : {}), ...(ledger.entries.length ? { directives: { applied: plan.applied, waived: plan.waived.map(({ e, reason }) => ({ id: e.id, reason, at })) } } : {}) };
  const past = await pastSignals(deps, input, draft.cwd ?? deps.config.defaultCwd);
  const tree = await treeContext(deps, draft);
  const skipEight = plan.waived.some(({ e }) => e.block === "eight-steps");
  const eight = skipEight ? { text: raw, added: false, missing: [] } : withEightSteps(raw, await eightSteps());
  const lead = withDirectives(eight.text, plan.add);
  const steps = stepsLine(input.key, eight);
  const hint = uiWarning(input, raw, ledger, ui);
  const added = addedLine(input.key, plan);
  const lines = [...(hint ? [hint] : []), ...(added ? [added] : []), ...waivedLines(input.key, plan)];
  return { draft, ...(steps ? { steps } : {}), lines, missing: missingLines(input.key, plan), text: `${ui ? withUiSteps(lead, await uiSteps()) : lead}\n${past ? `${past}\n` : ""}${tree ? `${tree}\n` : ""}${footer(draft, deps.config.leadPane, deps.config.backend, Object.keys(deps.config.mergeGate.repos))}` };
};

// The first lines of the lead's brief (headings and blank lines left out), for the thread's first message.
export const briefSummary = (brief: string, lines = 4): string =>
  brief.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).slice(0, lines).map((l) => (l.length > 200 ? `${l.slice(0, 199)}…` : l)).join("\n");

// discord.laneStartText filled in; a line whose placeholder has nothing to fill (a lane without --goal) is left out.
export const laneStartText = (template: string, lane: Lane, brief: string): string => {
  const values: Record<string, string> = { title: lane.title, goal: lane.goal ?? "", brief: briefSummary(brief), done: lane.done, key: lane.key, pane: lane.pane ?? "" };
  const text = template
    .split("\n")
    .filter((line) => [...line.matchAll(/\{(\w+)\}/g)].every(([, k]) => !(k && k in values) || values[k]))
    .map((line) => line.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m))
    .join("\n");
  return text.length > 1900 ? `${text.slice(0, 1899)}…` : text;
};

export const goalWarning = (input: LaunchInput): string | undefined =>
  input.goal?.trim() ? undefined : `LAUNCH_NO_GOAL ${input.key}: no --goal "<the owner's words>"; dori intent-check cannot compare the lane's direction with what the owner asked`;

export const launchLane = async (deps: FlowDeps, input: LaunchInput, warn: (line: string) => void = () => {}): Promise<{ readonly lane: Lane; readonly startup: string }> => {
  await validateLaunch(deps, input);
  let related: string[];
  try {
    threadGate(deps, input);
    related = await relatedGate(deps, input);
  } catch (e) {
    if (e instanceof ThreadMissingError) watchLog(deps.config.watchLog, deps.clock, { source: "launch", line: e.message });
    throw e;
  }
  const model = input.model ?? deps.config.defaultModel;
  const cwd = input.cwd ?? deps.config.defaultCwd;
  const weak = await doneWeakWarning(input, cwd);
  if (weak) {
    warn(weak);
    watchLog(deps.config.watchLog, deps.clock, { source: "launch", line: weak });
  }
  const rendered = await renderBrief(deps, input);
  const { steps, lines, missing } = rendered;
  let { draft, text } = rendered;
  const threadless = input.noThread?.trim() ? [`LAUNCH_THREADLESS ${input.key}: no work thread, on the lead's word: ${input.noThread.trim()}`] : [];
  for (const line of [...lines, ...(steps ? [steps] : []), ...missing, ...threadless, ...related]) {
    warn(line);
    watchLog(deps.config.watchLog, deps.clock, { source: "launch", line });
  }
  if (missing.length) throw new DirectiveMissingError(missing);
  // opened only once nothing else can stop the launch, so a refused launch leaves no empty thread behind
  let openedThread: string | undefined;
  if (input.thread === NEW_THREAD && deps.openThread) {
    const ref = await deps.openThread(input.title);
    openedThread = ref;
    const line = `THREAD_OPENED ${input.key} ${ref}: the lane's work thread, new in this Dori's channel (--thread ${NEW_THREAD})`;
    warn(line);
    watchLog(deps.config.watchLog, deps.clock, { source: "launch", line });
    ({ draft, text } = await renderBrief(deps, { ...input, thread: ref }));
  }
  await Bun.write(input.brief, text);
  const prompt = `${deps.config.launchKeywords}. Read and execute the lane brief at ${resolve(input.brief)} in full. You are the ${input.key} lane; report as the brief's footer says.`;
  // a model reply older than this is not an answer to this launch (a resumed session holds earlier ones)
  const launchedAt = deps.clock.now();
  const env = laneEnv(deps.config.launchEnv, input.useGpu);
  const opened = await (deps.config.backend === "aoe" ? openAoe(deps, input.key, cwd, model, prompt, env) : openHerdr(deps, input.key, cwd, model, prompt, env)).catch((e: unknown) => {
    throw e instanceof LaunchFailed && openedThread ? new LaunchFailed(e.message, openedThread) : e;
  });
  const lane: Lane = { ...draft, pane: opened.pane, ...(opened.tab ? { tab: opened.tab } : {}), ...(opened.session ? { session: opened.session, sessionVia: "launch" } : {}) };
  await deps.registry.write(lane);
  // registered first, so the queue counts this lane as working in the thread; a thread --thread new just opened is 🔄 already
  if (input.thread !== NEW_THREAD) {
    const reopened = await reopenLaneThread(deps, lane);
    if (reopened) warn(reopened);
  }
  if (opened.failure) return { lane, startup: `STARTUP_ERROR ${input.key} ${opened.pane}: ${opened.failure}` };
  await deps.clock.sleep(20_000);
  const screen = await readScreen(deps.run, deps.config.backend, opened.pane, 40);
  const bad = failureOf(deps, screen, cwd, opened.session ?? "", launchedAt);
  if (bad) return { lane, startup: `STARTUP_ERROR ${input.key} ${opened.pane}: ${bad}` };
  const started = omoSession(deps.config) ? await aoeStartup(deps, input.key, opened.pane, screen) : `STARTUP_OK ${input.key} ${opened.pane}`;
  if (!started.startsWith("STARTUP_OK")) return { lane, startup: started };
  return { lane, startup: (await startupGoal(deps, input.key, opened.pane, cwd, opened.session ?? "", launchedAt)) ?? started };
};

// A running agent is not yet a good start: a lane that never sets its goal does its first turn and stops, and the lead
// found the quiet lane long after a STARTUP_OK (dori-superagent issue #50 reproduced here (MIT):
// https://github.com/sisyphuslabs/dori-superagent/issues/50; upstream PR #51 reads herdr's screen, this reads omo's
// goal store, the file `dori pause`/`dori resume` confirm with, of the session id the lane's agent runs under, read from
// its command line: aoe's own --session-id, or the one launch gave a herdr omo; goal.ts laneGoal). Launch reads it
// briefly and never waits out a first turn (pending-goal.ts has the measurement): right after the 20 s check a goal is
// STARTUP_OK; a first turn still on (its turn running, or the agent waiting on a background job of its own) is
// STARTUP_PENDING_GOAL (exit 0; the lane is marked and dori watch finishes the judgement); three idle reads 10 s apart
// with no goal are STARTUP_NO_GOAL (exit 3); an agent that ends or shows a startup failure is STARTUP_ERROR.
const startupGoal = async (deps: FlowDeps, key: string, pane: string, cwd: string, session: string, launchedAt: number): Promise<string | undefined> => {
  // no session id in the agent's command line (aoe did not pin one, or an agentCommand that is not omo): which session is
  // the lane's is not known, and guessing it could read another session's goal
  if (!deps.readGoal && !session) return `STARTUP_UNCONFIRMED ${key} ${pane}: the agent runs but its command line names no session id, so its goal cannot be read; last lines: ${lastLines(await readScreen(deps.run, deps.config.backend, pane, 40))}`;
  const read = goalReader(deps, cwd, session);
  for (let idle = 1; ; idle++) {
    // a goal is no good news from an agent that already ended, so the agent is read before its goal, every time
    const gone = await agentGone(deps, pane);
    if (gone) return `STARTUP_ERROR ${key} ${pane}: ${gone}`;
    const goal = await read(pane);
    if (typeof goal === "object") return undefined;
    const screen = await readScreen(deps.run, deps.config.backend, pane, 40);
    const bad = failureOf(deps, screen, cwd, session, launchedAt);
    if (bad) return `STARTUP_ERROR ${key} ${pane}: ${bad}`;
    if (await firstTurnRuns(deps, pane, cwd, session, screen)) {
      await deps.registry.patch(key, { pendingGoal: { idle: 0, at: deps.clock.now() } });
      return `STARTUP_PENDING_GOAL ${key} ${pane}: its first turn is still on and has set no goal yet; dori watch says LANE_NO_GOAL if it ends without one`;
    }
    if (idle >= GOAL_WAIT.idleChecks) return `STARTUP_NO_GOAL ${key} ${pane}: the agent runs but ${noGoalWhy(goal)}: its first turn ended ${20 + ((idle - 1) * GOAL_WAIT.everyMs) / 1_000} s after its prompt; last lines: ${lastLines(screen)}`;
    await deps.clock.sleep(GOAL_WAIT.everyMs);
  }
};

// No failure word on screen is not a start (ported from dori-superagent 40034ad, #7, MIT,
// https://github.com/sisyphuslabs/dori-superagent/commit/40034ad1a557b92a34aa1450565adcafd3352c96, with tmux and the
// agent's own screen in place of herdr's agent_status): STARTUP_OK only when the session still runs and its agent shows a
// running turn, a wake mark or its ❯ input line 20 s after the lane prompt; a session that ended is a STARTUP_ERROR, and
// anything else is STARTUP_UNCONFIRMED with its last lines, for the lead to look at (exit 3 like an error).
export const aoeStartup = async (deps: FlowDeps, key: string, pane: string, screen: string): Promise<string> => {
  const life = await paneLife(deps.run, pane);
  if (!life.live) return `STARTUP_ERROR ${key} ${pane}: ${life.how === "gone" ? (isHerdrPane(pane) ? "the herdr pane is gone" : "the tmux session is gone") : life.status < 0 ? "no agent runs in the pane any more" : `the agent exited (status ${life.status})`}`;
  const full = await readScreen(deps.run, "aoe", pane);
  const shows = [screen, full].some((s) => turnRunning(s) || WAKE_MARKS.some((m) => s.includes(m)) || inputLine(s) !== undefined);
  return shows ? `STARTUP_OK ${key} ${pane}` : `STARTUP_UNCONFIRMED ${key} ${pane}: no running turn and no ❯ prompt on screen; last lines: ${lastLines(full || screen)}`;
};


// session: the id the lane's agent runs under, from its command line ("" or absent when it names none)
type Opened = { readonly pane: string; readonly tab?: string; readonly failure?: string; readonly session?: string };

// A herdr lane's agent picks its own session unless told: an omo agentCommand that names no session of its own gets
// --session-id <a new id> after the program, so launch knows the lane's session exactly. Any other command is run as it is.
export const withSessionId = (argv: readonly string[], id: string): string[] =>
  basename(argv[0] ?? "") === "omo" && !hasSessionSelector(argv) ? [argv[0] ?? "omo", "--session-id", id, ...argv.slice(1)] : [...argv];

// env: launchEnv for the lane (laneEnv), set on the agent's command line, since a herdr pane takes the server's environment
const openHerdr = async (deps: FlowDeps, key: string, cwd: string, model: string, prompt: string, env: Readonly<Record<string, string | undefined>> = {}): Promise<Opened> => {
  // the template is checked, not the filled argv: the prompt is one argument and never a selector
  const argv = fill(withSessionId(deps.config.agentCommand, crypto.randomUUID()), { model, prompt });
  // the shared opener (herdr.ts): a tab labelled with the key, a workspace first on a fresh server, the agent run there
  let opened: { readonly pane: string; readonly tab?: string };
  try {
    // omo needs node for its hooks (agentPath); another agent starts with the server's PATH as before
    const path = basename(argv[0] ?? "") === "omo" ? { PATH: agentPath(argv[0] ?? "omo") } : {};
    opened = await openHerdrSession(deps.run, deps.clock, { title: key, cwd, argv, env: { ...env, ...path }, ...(deps.config.laneWorkspace ? { workspace: deps.config.laneWorkspace } : {}) });
  } catch (e) {
    throw new LaunchFailed(e instanceof Error ? e.message : String(e));
  }
  const { pane, tab } = opened;
  // a command with its own --session-dir keeps its sessions (and goals) outside sessionsDir, so launch cannot read them
  const elsewhere = argv.some((a) => a === "--session-dir" || a.startsWith("--session-dir="));
  return { pane, ...(tab ? { tab } : {}), session: elsewhere ? "" : argvSessionId(argv) };
};

const openAoe = async (deps: FlowDeps, key: string, cwd: string, model: string, prompt: string, env: Readonly<Record<string, string | undefined>>): Promise<Opened> => {
  let pane: string;
  try {
    pane = await openAoeSession(deps.run, deps.clock, { title: key, cwd, tool: deps.config.agentCommand[0] ?? "omo", model, env });
  } catch (e) {
    if (e instanceof AoeError) throw new LaunchFailed(e.message);
    throw e;
  }
  const failure = await awaitPrompt(deps, pane);
  if (failure) return { pane, failure };
  const session = await aoeAgentSession(deps, pane);
  // a lane that missed launchEnv (the GPU guard) gets no prompt: it would start working with the GPU in reach
  const off = await envMismatch(deps.run, pane, env);
  if (off.length) return { pane, failure: `launchEnv not in the session: ${off.join(", ")}; the lane prompt was not sent` };
  // an agent with no API key shows its error where the prompt went in and keeps the text: that error is the reason
  if (!(await sendVerified(deps.run, deps.clock, deps.config, pane, prompt)))
    return { pane, failure: startupFailure(await readScreen(deps.run, "aoe", pane)) ?? "the launch prompt was not submitted (see NOT_SUBMITTED in the watch log)" };
  return { pane, session };
};

// The session aoe started the lane's agent with: aoe pins an omo session by putting --session-id <id> in its command line
// (openAoeSession gives aoe add the PATH it needs for that). launch adds no selector of its own: aoe would then refuse
// every restart of the session ("already contains native session selector"). The agent is the first agent process under
// the pane's shell, read once its prompt shows.
const aoeAgentSession = async (deps: FlowDeps, pane: string): Promise<string> => {
  const shell = await shellPidOf(pane, { run: deps.run, sessionsDir: deps.config.sessionsDir, backend: "aoe" });
  const agent = shell ? descendants(await procTable(deps.run), shell).find((p) => AGENT.test(p.cmd) && !ended(p)) : undefined;
  return agent ? argvSessionId(agent.cmd.split(/\s+/)) : "";
};

// The agent's ❯ prompt, or the first startup error on screen: an agent that exits at once never shows a prompt.
export const awaitPrompt = async (deps: FlowDeps, pane: string): Promise<string | undefined> => {
  for (let i = 0; i < 90; i++) {
    const screen = await readScreen(deps.run, "aoe", pane);
    if (inputLine(screen) !== undefined) return undefined;
    const bad = startupFailure(screen);
    if (bad) return bad;
    await deps.clock.sleep(2_000);
  }
  return "no ❯ prompt within 3 minutes";
};

export const quoteForPane = (arg: string): string => (/^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

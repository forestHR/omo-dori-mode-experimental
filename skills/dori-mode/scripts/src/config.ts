import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tokenBotId } from "./messenger/discord.ts";
import { run } from "./run.ts";
import type { RelatedSettings } from "./related-thread.ts";
import type { BackupSettings } from "./state-backup.ts";
import type { StateGitSettings } from "./state-git.ts";

// stateGit.backup defaults (src/state-backup.ts); here so loading the config does not load git or the backup code
export const BACKUP_DEFAULTS: BackupSettings = {
  repo: "",
  dirs: [],
  at: "06:00",
  retryMin: 30,
  until: "07:30",
  secretFiles: [],
  messageFiles: [],
  ownerMinChars: 30,
  ownerQuoteOk: ["directives.json", "AGENTS.md", "HANDOFF*.md"],
};

export type UpdateService = {
  readonly unit: string;
  readonly paths: readonly string[];
  readonly log: string;
  readonly ready: string;
};
export type UpdateConfig = {
  readonly repo: string;
  readonly branch: string;
  readonly services: readonly UpdateService[];
  readonly readyTimeoutSec: number;
  readonly alertPane: string;
  readonly announce: string;
};

export type ArgvTemplate = readonly string[];

export type Hooks = {
  readonly threadReply?: ArgvTemplate;
  readonly threadDone?: ArgvTemplate;
  readonly transcribe?: ArgvTemplate;
};

// dori heavy --job: a named job one host may run for another. argv fills {in} (the input folder), {in0}, {in1}... (the
// input files in the order given), {out} (a folder for result files); env is all the job gets besides PATH, HOME, LANG and
// TMPDIR (inside the job's folder). rl: reinforcement learning, run only on hosts whose heavyQueue.rl is true (queue host or helper).
export type HeavyJob = { readonly argv: ArgvTemplate; readonly env?: Readonly<Record<string, string>>; readonly rl?: boolean };
// a second GPU host the queue host hands jobs to: ssh argv to its forced-command `dori heavy-worker`
export type HeavyHelper = { readonly name: string; readonly ssh: ArgvTemplate };
export type HeavyQueue = {
  readonly jobs: Readonly<Record<string, HeavyJob>>;
  // on the queue host: helpers tried in order when a job at the front of the line cannot start here
  readonly helpers: readonly HeavyHelper[];
  // on any other host: argv that runs `dori` on the queue host (e.g. ["ssh", "main", "~/.bun/bin/dori"]); empty: this
  // host is the queue
  readonly queue: ArgvTemplate;
  // whether this host runs rl jobs at all (false: as a helper it refuses them, cut off from the queue it waits instead)
  readonly rl: boolean;
  // a job's files live here while it runs, on every host, and are deleted after (memory-backed, gone at reboot)
  readonly jobDir: string;
  // as a helper: run other hosts' own commands (dori heavy --kind ... --sync ...) in a bwrap box (heavy-spread.ts)
  readonly exec: boolean;
  // as a helper: such a run is stopped after this many minutes
  readonly execMaxMin: number;
};

const isArgv = (v: unknown): boolean => Array.isArray(v) && v.length > 0 && v.every((p) => typeof p === "string");
const isStringMap = (v: unknown): boolean => v === undefined || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string"));

// what is wrong with a heavyQueue section, or undefined
export const heavyQueueProblem = (q: HeavyQueue): string | undefined => {
  for (const [name, job] of Object.entries(q.jobs)) {
    if (!/^[\w.-]{1,64}$/.test(name)) return `heavyQueue.jobs: job name "${name}" must be letters, digits, . _ -`;
    if (!isArgv(job.argv)) return `heavyQueue.jobs.${name}.argv must be a non-empty list of strings`;
    if (!isStringMap(job.env)) return `heavyQueue.jobs.${name}.env must map variable names to strings`;
  }
  for (const h of q.helpers) if (typeof h.name !== "string" || !/^[\w.-]{1,64}$/.test(h.name) || !isArgv(h.ssh)) return `heavyQueue.helpers: each needs a name (letters, digits, . _ -) and an ssh argv`;
  if (!Array.isArray(q.queue) || !q.queue.every((p) => typeof p === "string")) return "heavyQueue.queue must be a list of strings";
  if (q.queue.length && q.helpers.length) return "heavyQueue: a host is either the queue (helpers) or reaches it (queue), not both";
  if (typeof q.exec !== "boolean") return "heavyQueue.exec must be true or false";
  if (!Number.isInteger(q.execMaxMin) || q.execMaxMin < 1) return "heavyQueue.execMaxMin must be a whole number of minutes, 1 or more";
  return undefined;
};

export type GuardThresholds = {
  readonly loadAlert: number;
  readonly loadOk: number;
  readonly memFreeMinPct: number;
  readonly diskFreeMinGb: number;
  readonly panesMax: number;
};

export type Backend = "herdr" | "aoe";

// "words" marks status as [working] / [waiting] / [done]; "emoji" uses 🔄 / ⏸️ / ✅ (and ⏳ / ✅ in progress text).
export type StatusStyle = "words" | "emoji";

// The speech this Dori uses with its owner in his channel and threads, which a lane's summary for him has to match (the
// lanes write to the lead politely; 2026-10-20 a lane's ~요 summary went out under ZzangDori's name, owner "가끔 이렇게 너
// 말투 달라지는 거니? 왜 달라지는 거야?"). "" follows discord.locale: Korean is casual (반말), any other locale is not checked.
export type OwnerSpeech = "" | "casual" | "polite";
export const OWNER_SPEECHES: readonly OwnerSpeech[] = ["", "casual", "polite"];
export const ownerSpeechOf = (locale: string, speech: OwnerSpeech = ""): OwnerSpeech => speech || (locale.toLowerCase().startsWith("ko") ? "casual" : "");

// Words the Discord helpers write: thread status words, question-card labels, and how answer times are shown.
// autoUnEye: the listener takes its eyes reaction off the owner's earlier messages once its bot writes in that channel.
// quietText ({min} = minutes since the lane's last report) is what freshness posts in the owner's thread (hooks.threadReply,
// any messenger) instead of the lane's own report, a note for the lead; it promises nothing the scripts do not do.
// postRawReports brings back posting the report as it is. A close posts the lane's summary for the owner
// (close-summary.ts), not fixed words. laneStartText is the first message
// dori launch posts in a discord:<id> work thread that has none ({title}, {goal}, {brief}, {done}, {key}, {pane}; a line
// whose placeholder is empty is left out). waiveText is the line the owner gets when dori launch --waive leaves one of his
// directives out of a brief ({key}, {id}, {name}, {reason}): in the lane's discord:<id> thread, else DORI_DISCORD_CHANNEL.
// leadRunawayText / leadPausedText follow the LEAD_RUNAWAY / LEAD_AUTOTURN_PAUSED head dori watch posts to the pair channel
// and DORI_DISCORD_CHANNEL when the lead itself ran autoturnLongTurns turns on its own or omo paused it ({pane}, {turns},
// {since}, {reason}). leadRepeatText follows "<head> repeat:" when the last alert that asked for a check is under 30 min
// old ({pane}, {turns}, {since}, {reason}, {min} = minutes since that alert, {at} = its time): it asks for nothing.
// leadCompactionStuckText follows the LEAD_COMPACTION_STUCK head dori freshness posts the same way, once per lead pane, when
// the lead answers every message with the engine's "compaction did not complete" error and nothing moves it: the auto key
// is off or the automatic handover was refused or failed ({pane}, {turns} = the error's count on its screen, {since} = when
// freshness first saw it due, {reason} = why it did not move).
export type DiscordWords = {
  readonly statusStyle: StatusStyle;
  readonly autoUnEye: boolean;
  readonly quietText: string;
  readonly laneStartText: string;
  readonly waiveText: string;
  readonly leadRunawayText: string;
  readonly leadPausedText: string;
  readonly leadRepeatText: string;
  readonly leadCompactionStuckText: string;
  // the owner's line from dori watch when the lead's model calls fail while his message waits (lead-limit.ts):
  // leadLimitText names the retry time the error gives ({until}, discord.timeZone), leadLimitNoTimeText the error
  // ({reason}) when it gives none; leadBackText goes to the same place once a reply works again
  readonly leadLimitText: string;
  readonly leadLimitNoTimeText: string;
  readonly leadBackText: string;
  // the owner's line when dori watch starts a lead that was down (lead-down.ts; {since}: when it went down, discord.timeZone)
  readonly leadDownText: string;
  readonly postRawReports: boolean;
  // minutes a done (✅) thread in DORI_DISCORD_CHANNEL stays quiet before freshness archives it (0: never; a thread an open
  // lane, an open card or a pending rename holds is left open)
  readonly autoArchiveMin: number;
  readonly working: string;
  readonly waiting: string;
  readonly done: string;
  readonly other: string;
  readonly pick: string;
  readonly recommended: string;
  readonly answered: string;
  readonly ownerOnly: string;
  readonly byButton: string;
  readonly byText: string;
  // a card folded by dori resolve: the owner answered in a message; repliedInText is the answer shown without --answer
  readonly byReply: string;
  readonly repliedInText: string;
  readonly locale: string;
  readonly timeZone: string;
  readonly ownerSpeech: OwnerSpeech;
  // the user id of this Dori's own bot; Discord writes refuse a DORI_DISCORD_TOKEN of another bot (empty: no check)
  readonly botId: string;
  // role ids that call this Dori besides the roles its bot member has (read at listener start): an owner message anywhere
  // in the guild that mentions its bot or one of these roles reaches the inbox (scope "mention")
  readonly mentionRoleIds: readonly string[];
};

export const defaultDiscordWords: DiscordWords = {
  statusStyle: "words",
  autoUnEye: true,
  quietText: "Still working on it. The last report came {min} min ago.",
  laneStartText: "{title}\nGoal, in your words: {goal}\n{brief}\nDone when: {done}\nLane {key}, pane {pane}",
  waiveText: "Lane {key} was launched without your directive {id} ({name}). The lead's reason: {reason}",
  leadRunawayText: "The lead {pane} has started {turns} turns on its own since its last user message ({since}). Other Dori: type one short check message into {pane}; do not stop it.",
  leadPausedText: "omo paused the lead {pane} after {turns} turns on its own ({reason}, since {since}). Other Dori: type one short check message into {pane}; do not stop it.",
  leadRepeatText: "The lead {pane} is still on its own ({turns} turns). A check was already asked for {min} min ago ({at}): send no new message.",
  leadCompactionStuckText: "The lead {pane} answers every message with \"compaction did not complete\" ({turns} times on its screen, due since {since}) and was not moved to a new session: {reason}. Other Dori: tell your lead; this lead needs dori handover to a new session on its host.",
  leadLimitText: "I can't answer right now: my model is at its usage limit until about {until}. I'll read your messages then.",
  leadLimitNoTimeText: "I can't answer right now: my model calls fail ({reason}). I'll read your messages once they work again.",
  leadBackText: "My model works again; reading your messages now.",
  leadDownText: "My session went down at {since}; I'm starting it again in the same conversation and will answer in a few minutes.",
  postRawReports: false,
  autoArchiveMin: 30,
  working: "working",
  waiting: "waiting",
  done: "done",
  other: "Write my own",
  pick: "Pick {n}",
  recommended: "recommended",
  answered: "answered",
  ownerOnly: "Only the owner can answer this.",
  byButton: "button",
  byText: "typed",
  byReply: "reply",
  repliedInText: "answered in text",
  locale: "en-US",
  timeZone: "UTC",
  ownerSpeech: "",
  botId: "",
  mentionRoleIds: [],
};

// The stuck ladder (dori fix-attempt, freshness): one count per metric, the failed attempts since the last PASS or
// --improved, the larger of the tagged count (fix tags, dori fix-attempt) and the inferred one (untagged reports, commits,
// tree). Rung 2 from hypothesesAt attempts: competing hypotheses with cheap tests before the next patch. Rung 3 from
// researchAt attempts: ulw research and a dori challenge of the next plan, in the same session, no rollover. Rung 4: a
// failure after rung 3, the same hypothesis fixatedAfter times, or an owner-check finding that comes back: the lead may
// roll the lane over. rereadText ({key}, {brief}, {finding}) goes to a lane whose report broke the owner's words, only when
// the lead confirms it with dori owner-check <key> --reread.
export type Stuck = { readonly hypothesesAt: number; readonly researchAt: number; readonly fixatedAfter: number; readonly rereadText: string };

// Reviewer models of another family for dori challenge and dori owner-check, in order (best GPT, Claude, Grok, then a
// second model of each family). Each command takes the first callable one of another family than the lane's.
// allowSameFamily: dori challenge (and challenge --check) also keeps a model of the lane's family (only the lane's own
// model is skipped), so an account can have Claude Fable review a Claude Opus lane. owner-check, intent-check, the
// directives check and the rollover audit still take another family.
export type Reviewers = { readonly models: readonly string[]; readonly allowSameFamily: boolean };

// dori review / dori merge (src/merge-gate.ts). repos: "<owner>/<repo>" -> ISO time; claim-done refuses a lane whose done
// signal names a PR of that repo merged at or after that time without dori merge (empty: no repo is checked). testCommand
// runs in <checkout>/<testDir> for a PR with no GitHub checks, at most testMinutes.
export type MergeGate = { readonly repos: Readonly<Record<string, string>>; readonly testCommand: readonly string[]; readonly testDir: string; readonly testMinutes: number };

// dori scorecard: where the day's numbers come from and how the card reads. Empty paths leave that line as n/a.
export type Scorecard = {
  readonly timeZone: string;
  readonly language: "en" | "ko";
  // session files whose cost line ① counts; empty means sessionsDir (every session on the host)
  readonly sessions: string;
  readonly lanesLog: string;
  readonly leadSessions: string;
  readonly inbox: string;
  readonly replyPattern: string;
  readonly leadSendPattern: string;
  readonly postTo: string;
  // days of <stateDir>/scorecard/YYYY-MM-DD.json kept; older files are removed when a new one is written
  readonly keepDays: number;
};

// dori signals: the failure record of earlier lanes. launchLanes caps how many lanes the "Past signals" section of a new
// brief lists. A report or lead message matching numberedAttemptPattern (group 1 = the attempt number) is a numbered fix
// attempt; one matching rootCausePattern after the first attempt is the switch to a root-cause hunt.
export type Signals = { readonly launchLanes: number; readonly numberedAttemptPattern: string; readonly rootCausePattern: string };

// Exploration when a lane is stuck (dori fix-attempt, tree, challenge, fork-explore, research-hint).
// minHypotheses: competing hypotheses, each with a cheap discriminating test, that rung 2 of the stuck ladder asks for.
// researchText goes to the lane at rung 3 when sendResearchToLane is on ({question}, {n}, {metric}, {key}). It must start
// with "ulw research " (RESEARCH_PREFIX): omo attaches its ulw-research skill only to typed input that names it, and not
// when the text starts with a [TAG]. researchVerifyMin: how long after sending the lane's session log may take to show the
// skill pointer and a read of its SKILL.md before RESEARCH_NOT_STARTED.
// stagePattern: a milestone report matching it announces a new stage, and freshness runs the owner check on that lane first.
// Before a review each reviewers.models id is checked against modelsCommand (the host's models) and authCommand
// ({provider}: is it logged in); an id the host cannot call is skipped or moved to a logged-in provider of the same model.
// challengeCommand / branchCommand: argv templates ({model}, {prompt}, and {system}, the reviewer's system prompt, for
// challengeCommand); branchMinutes: time limit per fork-explore branch.
export type Explore = {
  readonly minHypotheses: number;
  readonly sendResearchToLane: boolean;
  readonly researchText: string;
  readonly researchVerifyMin: number;
  readonly stagePattern: string;
  readonly treeLines: number;
  readonly modelsCommand: ArgvTemplate;
  readonly authCommand: ArgvTemplate;
  readonly challengeCommand: ArgvTemplate;
  readonly challengeMinutes: number;
  readonly branchCommand: ArgvTemplate;
  readonly branchMinutes: number;
};

// Signals that need no tag from the lane: the inferred count of the stuck ladder and OWNER_CHECK. The inferred count is
// the cycles of "a gate line failed, then a new attempt targets it" on one metric; repeatGapMin: attempts on one
// metric closer than this are one attempt told twice. failPattern / passPattern: a gate line's verdict; verdictPattern: a
// prescription's verdict (fails every known metric the text names); inferAttemptPattern: a new attempt (a prescription, an
// adjustment, a patch; "시작"/"반영" alone are not, they also start evals and record decisions);
// prescriptionPattern: words that make it an attempt even when the text also reads as a diagnosis (diagnosticPattern).
// aliases: metric names that mean the same gate ({ "교착": ["deadlock"] }); the key is the name shown. conditionWords: names
// of conditions a report breaks results down by (soil, seed, depth, cell: "교착 113(양토 1.0 61 ...)"), never a metric.
// discriminationPattern: a report or tree entry that tells hypotheses apart (dori tree H.., 가설 판별); when it makes no new
// attempt itself (its result changed the next action), the next attempt on a metric it investigated is not a repeat; one that
// prescribes again in the same report counts as an attempt. targetScope: an
// attempt targets a metric named in the same "sentence" (the default: reports name the target a few words from the prescription)
// or the same "clause" (between commas: quieter, misses more).
// ownerCheck: a reviewer of another family reads the brief, the owner's words and recent reports and answers VIOLATION /
// CONTRADICTION / GOAL_LOSS / OK. enabled: freshness runs it on new reports; first: the reviewers.models id it tries first
// (gpt-6.1-sol: on live Korean lane logs the cheaper gpt-6-luna misread a relayed order's scope); command: argv
// template ({model}, {prompt}, {system}); minutes: time limit; minIntervalMin: at most one check per lane in this time;
// maxPerDay: per lane; reports: the newest reports it reads at least; maxReports: at most this many of the reports since the
// last check (all of them up to that); relays: how many owner [LEAD] relays it reads, and how many of the owner's decisions in the lane's thread (card answers, his messages); perTick: checks per sweep.
export type OwnerCheck = {
  readonly enabled: boolean;
  readonly first: string;
  readonly command: ArgvTemplate;
  readonly minutes: number;
  readonly minIntervalMin: number;
  readonly maxPerDay: number;
  readonly reports: number;
  readonly maxReports: number;
  readonly relays: number;
  readonly perTick: number;
};

export type AutoSignals = {
  readonly repeatGapMin: number;
  readonly failPattern: string;
  readonly passPattern: string;
  readonly verdictPattern: string;
  readonly inferAttemptPattern: string;
  readonly prescriptionPattern: string;
  readonly diagnosticPattern: string;
  readonly aliases: Readonly<Record<string, readonly string[]>>;
  readonly conditionWords: readonly string[];
  readonly discriminationPattern: string;
  readonly targetScope: "clause" | "sentence";
  readonly ownerCheck: OwnerCheck;
};

// dori handover: switch the lead to a new agent session. prompt starts the first message of the new session (the note's
// path follows); title names it (empty: the old title plus MMDDhhmm); model (empty: defaultModel); services are the user
// units restarted after leadPane moves, so long-running sweeps read it again (empty: the update.services units); timers is
// a regex for `systemctl --user list-timers` lines listed in the note; verifyMin bounds the checks; inbox is the file the
// inbox probe goes to (empty: DORI_DISCORD_INBOX, else <stateDir>/discord/inbox.jsonl); cwd is where the new session opens
// (empty: the old lead's path with symlinks resolved); watchers are the watches that are not omo monitors of the old
// session (a host guard, a separate listener): check is an argv ({pane}, {session} filled in) whose exit 0 means it runs,
// before the move for the old lead and after it for the new one; arm tells the new session how to start it, if it must.
// Rollover (moving a session to a new one): readyMin is how long a lane's `dori handover ready` mark stays valid. lane* and
// lead* are the thresholds at which freshness says a rollover is due (ROLLOVER_DUE): context use in percent (status line),
// compactions in the session log, hours since the session began, thousands of tokens still held after the last compaction
// (*AfterCompactK); 0 turns one off. A stuck lane is due at rung 4 of the
// stuck ladder (stuck.*). Nothing switches on a threshold: the lead decides (dori rollover-propose prints proposalText
// for the lead and logs it), runs the handover with --approved-by lead:<reason and signal>, and the handover tells the
// owner afterwards and logs that message's id. autoRolloverLanes / autoRolloverLead let freshness start it on a measured
// threshold or at rung 4 of the stuck ladder without asking; off until the owner decides from dori rollover-stats. An
// automatic lane start waits up to autoWaitMin minutes for the lane's turn to end and moves it at that idle moment; a lane
// that stays busy, or runs a chain that would die, is asked to reach a safe point first (again after autoRetryMin), and
// the move starts again once it is idle or marked ready. There is no last try: a move that failed is started again after
// autoRetryMin minutes, doubling up to 8 times that while failures go on.
// An automatic start never moves a lane that runs or watches a training or eval chain: one with a tag in trainingTags, or
// a live monitor whose command, path or description matches trainingWatch (a regex, case-insensitive); the lead moves it.
// That message to the owner is written by the scripts (rollover.ts ownerRolloverText), one or two plain sentences in
// discord.locale's language: what moved, why, and that he has nothing to do; it goes in the lane's discord thread or DORI_DISCORD_CHANNEL and carries no
// pane, config key or link (the watch log does). supplementRounds is how many times a lane handover fills in what the new session's
// restatement left out (from the note and the old log) and asks again before it rolls back; 0 rolls back at the first gap.
// A committed lead handover freezes the old lead (SIGSTOP on its agent and every child) instead of closing it; frozenCloseH
// is how many hours later freshness closes it (0: only by hand, dori handover close-frozen); the owner's message of that
// rollover says how long the old one is kept, and a lane's says how much context the move took off.
// The audit after a committed handover (rollover-audit.ts): freshness starts it auditAfterMin minutes after the commit, for
// handovers committed at most auditWindowH hours ago (0 turns it off); the lead's instructions of the old session's last
// auditLeadH hours are read with the owner's quoted words; auditSummaryAt ("Mon 08:30" in scorecard.timeZone; empty: off)
// is when the week's summary goes to the lead's inbox.
export type HandoverWatcher = { readonly name: string; readonly check: readonly string[]; readonly arm?: string };

export type Handover = {
  readonly prompt: string;
  readonly title: string;
  readonly model: string;
  readonly services: readonly string[];
  readonly timers: string;
  readonly verifyMin: number;
  readonly inbox: string;
  readonly cwd: string;
  readonly watchers: readonly HandoverWatcher[];
  readonly readyMin: number;
  readonly laneContextPct: number;
  readonly laneCompactions: number;
  readonly laneAgeH: number;
  readonly laneAfterCompactK: number;
  readonly leadContextPct: number;
  readonly leadCompactions: number;
  readonly leadAgeH: number;
  readonly leadAfterCompactK: number;
  readonly autoRolloverLanes: boolean;
  readonly autoRolloverLead: boolean;
  readonly autoRetryMin: number;
  readonly autoWaitMin: number;
  readonly trainingTags: readonly string[];
  readonly trainingWatch: string;
  readonly supplementRounds: number;
  readonly frozenCloseH: number;
  readonly proposalText: string;
  readonly auditAfterMin: number;
  readonly auditWindowH: number;
  readonly auditLeadH: number;
  readonly auditSummaryAt: string;
};

export type DoriConfig = {
  readonly backend: Backend;
  readonly stateDir: string;
  readonly watchLog: string;
  readonly update: UpdateConfig;
  readonly laneWorkspace: string;
  readonly workspaces: readonly string[];
  readonly ignorePanes: readonly string[];
  readonly leadPane: string;
  readonly defaultCwd: string;
  readonly agentCommand: ArgvTemplate;
  readonly defaultModel: string;
  readonly launchKeywords: string;
  // variables every lane session starts with (aoe backend), e.g. {"CUDA_VISIBLE_DEVICES": ""} on a training node; a lane
  // launched with --use-gpu starts without them
  readonly launchEnv: Readonly<Record<string, string>>;
  // the directive ledger (src/directives.ts): common is the fork's references/directives.json (empty turns it off), local
  // the host's own file with its directives and links (empty: none); links a file of { id, source } rows another Dori
  // pushed, which only sets the source of fork entries (empty: none); linkPeers "<user>:<absolute path>" the Dori this one
  // pushes the links of its local ledger to (dori directives links --push, and freshness when the local ledger changed)
  // memory: the lead's omo memory repo an owner message's inbox row recalls notes from (empty: the repo of a session in
  // handover.cwd, else defaultCwd; "off": no recall)
  readonly directives: { readonly common: string; readonly local: string; readonly links?: string; readonly linkPeers?: readonly string[]; readonly memory?: string };
  readonly sessionsDir: string;
  readonly nudgeAfterMin: number;
  // dori watch: an idle lane waiting on background work it started (BG_WAITING) is LANE_BLOCKED idle after this long
  readonly blockedWaitMin: number;
  // dori watch: how many [LEAD] messages may lift one session's omo auto-turn pause (LANE_AUTOTURN_PAUSED) in 24 hours;
  // past it the pause is only reported, so omo's guard against an endless self-driven run still holds (0: never resume)
  readonly autoturnResumeMax: number;
  // dori watch: LANE_AUTOTURN_LONG each time a session has started this many more turns on its own since the last user
  // (or lead) message, only reported, never stopped; with engineTurns.maxPerUserInput 0 omo no longer pauses (0: off)
  readonly autoturnLongTurns: number;
  // dori watch: minutes an owner message may wait with no working reply from the lead before one LEAD_OWNER_WAITING line
  // is typed into the lead pane (lead-limit.ts; 0: never typed, the owner's limit notice still goes out)
  readonly leadWakeMin: number;
  // dori watch: minutes the lead's tmux session may be gone (or its pane dead) before dori watch starts it again in the same
  // conversation and tells the owner once (lead-down.ts; 0: never)
  readonly leadReviveMin: number;
  readonly postAfterMin: number;
  readonly closeAfterMin: number;
  readonly heavySlots: number;
  readonly heavyMaxLoad: number;
  // dori heavy beside the first heavySlots jobs: up to heavyMaxSlots at once, a job only when GPU use, GPU (or unified)
  // memory, CPU and memory each keep heavyHeadroomPct percent free with it added, and none while a job taken less than
  // heavySettleSec ago has not shown its load. Owner 2026-10-16 20:52 KST: "한 번에 하나의 작업을 돌리라고 하긴 했지만 이렇게
  // 리소스가 30% 정도로 넉넉하게 남으면 한꺼번에 돌려도 돼" (speech-to-text wrote 리소스 as 리수 수). Owner 2026-10-22 02:15 KST lowered 30% to 10%: "30프로 여유 규칙 더 줄여 10%해".
  readonly heavyMaxSlots: number;
  readonly heavyHeadroomPct: number;
  readonly heavySettleSec: number;
  readonly heavyQueue: HeavyQueue;
  readonly deadPanePatterns: readonly string[];
  readonly guard: GuardThresholds;
  readonly hooks: Hooks;
  readonly discord: DiscordWords;
  readonly stuck: Stuck;
  readonly reviewers: Reviewers;
  readonly mergeGate: MergeGate;
  readonly scorecard: Scorecard;
  readonly signals: Signals;
  readonly explore: Explore;
  readonly autoSignals: AutoSignals;
  readonly handover: Handover;
  // dori launch --thread new: related open threads shown first (src/related-thread.ts)
  readonly related: RelatedSettings;
  // dori state-git: this Dori's state in local git, committed by dori-lanes (src/state-git.ts)
  readonly stateGit: StateGitSettings;
  readonly instances: readonly InstanceRef[];
};

// Another Dori on this host: its config file (whose defaultCwd marks its directory) and its dori.env (default: next to
// that config). A dori command run without DORI_CONFIG and DORI_ENV_FILE inside that directory acts as that Dori.
export type InstanceRef = { readonly config: string; readonly envFile?: string };

export const defaultConfig = (home = homedir()): DoriConfig => ({
  backend: "herdr",
  stateDir: join(home, ".dori", "state"),
  watchLog: join(home, ".dori", "state", "lanes.log"),
  update: { repo: resolve(import.meta.dir, "../../../.."), branch: "main", services: [], readyTimeoutSec: 60, alertPane: "", announce: "Tell the owner in your own channel, briefly, what changed and how your behaviour changes because of it." },
  laneWorkspace: "",
  workspaces: [],
  ignorePanes: [],
  leadPane: "",
  defaultCwd: home,
  agentCommand: ["omo", "--model", "{model}", "{prompt}"],
  defaultModel: "anthropic/claude-opus-5-5",
  launchKeywords: "ulw set goal and work",
  launchEnv: {},
  directives: { common: join(import.meta.dir, "../../references/directives.json"), local: "", links: "", linkPeers: [], memory: "" },
  sessionsDir: join(home, ".omo", "agent", "sessions"),
  nudgeAfterMin: 15,
  blockedWaitMin: 60,
  autoturnResumeMax: 3,
  autoturnLongTurns: 300,
  leadWakeMin: 10,
  leadReviveMin: 2,
  postAfterMin: 20,
  closeAfterMin: 5,
  heavySlots: 1,
  heavyMaxLoad: 80,
  heavyMaxSlots: 8,
  heavyHeadroomPct: 10,
  heavySettleSec: 120,
  heavyQueue: { jobs: {}, helpers: [], queue: [], rl: true, jobDir: "/dev/shm/dori-heavy", exec: false, execMaxMin: 240 },
  deadPanePatterns: ["has stopped", "no suitable jobs"],
  guard: { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 50, panesMax: 20 },
  hooks: {},
  discord: defaultDiscordWords,
  stuck: {
    hypothesesAt: 2,
    researchAt: 3,
    fixatedAfter: 3,
    rereadText: "[LEAD] Your last report breaks what the owner asked ({finding}). Before the next step, read your brief again ({brief}) and the owner's words in it and in my relays, quote the line you broke, say how you correct course, and report.",
  },
  reviewers: {
    models: ["chatgpt-subscription/gpt-6-astra", "anthropic-subscription/claude-fable-5-1", "xai/grok-4.7", "chatgpt-subscription/gpt-6.1-sol", "anthropic-subscription/claude-opus-5-5", "xai/grok-4.6", "chatgpt-subscription/gpt-6-luna"],
    allowSameFamily: false,
  },
  scorecard: {
    timeZone: "UTC",
    language: "en",
    sessions: "",
    lanesLog: "",
    leadSessions: "",
    inbox: "",
    replyPattern: "^(SENT|POSTED) \\d",
    leadSendPattern: "send-keys\\W+-t\\W+={pane}:\\W+-l|send-text\\W+{pane}\\b|dori\\W+type\\W+{pane}\\b",
    postTo: "",
    keepDays: 30,
  },
  related: { recentH: 24, minScore: 0.2, max: 3 },
  signals: {
    launchLanes: 5,
    numberedAttemptPattern: "(?:fix(?: attempt)?|attempt|adjustment|조정|땜질)\\s*#?(\\d{1,2})(?:\\s*/\\s*\\d+)?(?![\\d.a-z])",
    rootCausePattern: "root[ -]cause|근본 원인",
  },
  explore: {
    minHypotheses: 3,
    sendResearchToLane: true,
    researchText: "ulw research {question} First read the ulw-research SKILL.md (the omo-ulw-research pointer names its path) and follow it, kept on this one symptom (failed attempt {n} on {metric}). Record each useful finding with dori tree add --lane {key} --kind finding --text '<source url>: <what it says, which hypothesis it supports or rules out>'. Then write your next plan to a file, have it challenged with dori challenge {key} --plan <file>, and report back to the lead what the research and the challenge change about your next step, before the next patch.",
    researchVerifyMin: 5,
    stagePattern: "\\b(?:stage|phase|pivot|switch(?:ing)? to|next step)\\b|단계|국면|방향 전환|다음 단계",
    treeLines: 6,
    modelsCommand: ["omo", "--list-models"],
    authCommand: ["omo", "auth", "check", "--provider", "{provider}", "--json"],
    challengeCommand: ["omo", "-p", "--no-session", "--tools", "read,grep,find,ls", "--no-extensions", "--no-skills", "--no-context-files", "--omo-senpi-disabled", "--system-prompt", "{system}", "--model", "{model}", "{prompt}"],
    challengeMinutes: 10,
    branchCommand: ["omo", "-p", "--no-session", "--model", "{model}", "{prompt}"],
    branchMinutes: 15,
  },
  autoSignals: {
    repeatGapMin: 30,
    failPattern: "\\bFAIL(?:ED|S)?\\b|불합격|미달|✗|❌",
    passPattern: "\\bPASS(?:ED|ES)?\\b|(?<!불)합격|✓|✅",
    verdictPattern: "\\bREJECTED\\b|\\bNOT[ _]JUDGEABLE\\b|\\bUNCLEAR\\b|\\bno effect\\b|\\bdid not (?:move|improve)\\b|기각|판정 불가|지지 안 함|효과 없음|개선 없음",
    inferAttemptPattern: "처방|조정|수정|패치|재학습|벌점|\\bprescri|\\bpatch|\\bretrain|\\btweak|\\badjust|\\bpenalt|\\bfix(?:ed|es)?\\b|^(?:fix|feat|perf)\\(",
    prescriptionPattern: "처방|조정|수정|패치|재학습|벌점|\\bprescri|\\bpatch|\\bretrain|\\btweak|\\badjust|\\bpenalt|^(?:fix|feat|perf)\\(",
    diagnosticPattern: "탐침|probe|판독|readout|재생|replay|진단|diagnos|가설|hypothes|평가|\\beval|측정|measure|비교|compar|예선|결선|^(?:qa|docs|test)\\(",
    aliases: {},
    conditionWords: ["양토", "점토", "사토", "모래", "흙", "씨앗", "깊이", "셀", "seed", "seeds", "depth", "soil", "clay", "loam", "sand", "cell"],
    discriminationPattern: "dori tree [HFD]\\d|가설 판별|판별|\\bdiscriminat|\\bfalsif|\\bablation",
    targetScope: "sentence",
    ownerCheck: {
      enabled: true,
      first: "chatgpt-subscription/gpt-6.1-sol",
      command: ["omo", "-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--omo-senpi-disabled", "--system-prompt", "{system}", "--model", "{model}", "{prompt}"],
      minutes: 4,
      minIntervalMin: 30,
      maxPerDay: 48,
      reports: 6,
      maxReports: 20,
      relays: 8,
      perTick: 1,
    },
  },
  handover: { prompt: "Dori mode", title: "", model: "", services: [], timers: "remind", verifyMin: 15, inbox: "", cwd: "", watchers: [], readyMin: 30,
    laneContextPct: 0, laneCompactions: 0, laneAgeH: 0, laneAfterCompactK: 0, leadContextPct: 0, leadCompactions: 0, leadAgeH: 0, leadAfterCompactK: 0, autoRolloverLanes: false, autoRolloverLead: false, autoRetryMin: 30, autoWaitMin: 20,
    trainingTags: ["training"], trainingWatch: "chain[_-]?watch|_chain_|\\btrain(ing)?\\b|learning iteration|/runs/|run[_-]?dir|\\bdori heavy\\b|(^|[^a-z])(eval|replay)([^a-z]|$)", supplementRounds: 2, frozenCloseH: 24, auditAfterMin: 10, auditWindowH: 24, auditLeadH: 6, auditSummaryAt: "Mon 08:30",
    proposalText: "Move {who} to a new session? {signals}. The handover note it would get: {note}{blockers}" },
  stateGit: { dirs: [], everyMin: 10, maxFileKb: 512, timeoutSec: 60, timeZone: "", backup: BACKUP_DEFAULTS },
  mergeGate: { repos: {}, testCommand: ["bun", "test"], testDir: "skills/dori-mode/scripts", testMinutes: 20 },
  instances: [],
});

export class ConfigError extends Error {}

// the start of every text typed into a lane for its external-search step: omo's trigger for the ulw-research skill
export const RESEARCH_PREFIX = "ulw research ";

export const researchTextProblem = (text: string): string | undefined =>
  !text.startsWith(RESEARCH_PREFIX)
    ? `explore.researchText must start with "${RESEARCH_PREFIX}" (omo starts its ulw-research skill only for typed text that begins that way here), got "${text.slice(0, 40)}"`
    : !text.includes("{question}")
      ? "explore.researchText must contain {question}, where the research question built from the lane's records goes"
      : undefined;

export const envFilePath = (): string => process.env.DORI_ENV_FILE ?? join(homedir(), ".dori", "dori.env");

// What one Dori's dori.env sets: bot tokens, channel, inbox, card store, lead, voice, Google, Kakao, usage. A process can
// inherit another Dori's set: a tmux server started by a unit that loaded dori.env hands it to every pane it opens.
// DORI_LEAD_PANE and DORI_DISCORD_SHADOW_INBOX choose how this run works (set by its unit or caller), not instance values.
const instanceVar = (name: string): boolean => /^DORI_(DISCORD|SLACK|TELEGRAM|LEAD|ASR|GOOGLE|KAKAO|USAGE)_/.test(name) && name !== "DORI_LEAD_PANE" && name !== "DORI_DISCORD_SHADOW_INBOX";

// The bot a token signs in as: a Discord token's base64 user id before its first dot, a Telegram token's id before its
// colon, else the token itself. A rotated token of the same bot is the same bot.
const tokenIdentity = (name: string, token: string): string => {
  const t = token.trim();
  if (name === "DORI_DISCORD_TOKEN") return tokenBotId(t) ?? t;
  return name === "DORI_TELEGRAM_TOKEN" && /^\d+:/.test(t) ? t.split(":")[0] ?? t : t;
};

// KEY=VALUE lines (tokens, Discord ids) for every dori command; a variable already set wins over the file, except when
// the file names another bot than the inherited token. Then the environment is another Dori's: every inherited
// instance variable is dropped first, so this file and the defaults apply. Returns the dropped names.
export const loadEnvFile = async (path: string, env: Record<string, string | undefined> = process.env): Promise<string[]> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const values = new Map<string, string>();
  for (const line of (await file.text()).split("\n")) {
    const [, name, value] = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line) ?? [];
    if (name && value !== undefined && !values.has(name)) values.set(name, value.trim().replace(/^(["'])(.*)\1$/, "$2"));
  }
  const foreign = [...values].some(([name, value]) => {
    const inherited = env[name];
    return /^DORI_\w+_TOKEN$/.test(name) && value !== "" && inherited !== undefined && tokenIdentity(name, inherited) !== tokenIdentity(name, value);
  });
  const dropped = foreign ? Object.keys(env).filter((name) => instanceVar(name) && env[name] !== undefined) : [];
  for (const name of dropped) delete env[name];
  for (const [name, value] of values) if (env[name] === undefined) env[name] = value;
  return dropped;
};

const realOr = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

// A dori command run without DORI_CONFIG and DORI_ENV_FILE inside another Dori's directory (the defaultCwd of a config
// listed under `instances` in ~/.dori/config.json, reached through a symlink or not) takes that Dori's config and
// dori.env. Returns the config path it chose.
export const resolveInstance = async (cwd: string, env: Record<string, string | undefined> = process.env, home = homedir()): Promise<string | undefined> => {
  if (env.DORI_CONFIG !== undefined || env.DORI_ENV_FILE !== undefined) return undefined;
  const main = Bun.file(join(home, ".dori", "config.json"));
  if (!(await main.exists())) return undefined;
  const here = realOr(cwd);
  for (const ref of ((await main.json()) as { instances?: InstanceRef[] }).instances ?? []) {
    const config = expandHome(ref.config, home);
    const file = Bun.file(config);
    const dir = (await file.exists()) ? ((await file.json()) as { defaultCwd?: string }).defaultCwd : undefined;
    if (!dir) continue;
    const root = realOr(expandHome(dir, home));
    if (here !== root && !here.startsWith(`${root}/`)) continue;
    env.DORI_CONFIG = config;
    env.DORI_ENV_FILE = expandHome(ref.envFile ?? join(dirname(config), "dori.env"), home);
    return config;
  }
  return undefined;
};

export const configPath = (): string => process.env.DORI_CONFIG ?? join(homedir(), ".dori", "config.json");

export const expandHome = (path: string, home = homedir()): string => (path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path);

type Raw = Record<string, Record<string, unknown> | undefined>;

// Keys this consolidation replaced (the stuck ladder, one reviewer list, the attempt patterns' names). An old key still
// works where it has a new home, moved there unless the new key is set too; one with none is ignored. Each gives one
// CONFIG_OLD_KEY line, so a config can be fixed at leisure.
export const migrateOldKeys = (input: Raw): { readonly raw: Raw; readonly warnings: readonly string[] } => {
  const raw: Raw = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v && typeof v === "object" && !Array.isArray(v) ? { ...v } : v]));
  const warnings: string[] = [];
  const section = (name: string): Record<string, unknown> => (raw[name] ??= {});
  const take = (from: string, key: string): unknown => {
    const s = raw[from];
    if (!s || !(key in s)) return undefined;
    const v = s[key];
    delete s[key];
    return v;
  };
  const move = (from: string, key: string, to: string, toKey: string, convert: (v: unknown) => unknown = (v) => v): void => {
    const v = take(from, key);
    if (v === undefined) return;
    const target = section(to);
    const kept = toKey in target;
    if (!kept) target[toKey] = convert(v);
    warnings.push(`CONFIG_OLD_KEY ${from}.${key} -> ${to}.${toKey}${kept ? " (both set: the new key wins)" : ""}; rename it in the config`);
  };
  const drop = (from: string, key: string, why: string): void => {
    if (take(from, key) !== undefined) warnings.push(`CONFIG_OLD_KEY ${from}.${key} is no longer read: ${why}; remove it from the config`);
  };
  const hypothesesAt = Number(raw.stuck?.hypothesesAt ?? raw.explore?.hypothesesFrom ?? 2);
  const userReviewers = "models" in (input.reviewers ?? {});
  move("sameFix", "after", "stuck", "fixatedAfter");
  drop("sameFix", "sendToLane", "the stuck ladder sends a lane research at rung 3 and a re-read only when the lead confirms it (stuck.rereadText)");
  drop("sameFix", "laneText", "stuck.rereadText is the text the lead confirms");
  move("explore", "hypothesesFrom", "stuck", "hypothesesAt");
  // researchAt counted stuck signals (1 = the first attempt that needed hypotheses); stuck.researchAt counts failed attempts
  move("explore", "researchAt", "stuck", "researchAt", (v) => Number(v) + hypothesesAt - 1);
  drop("explore", "driftBelow", "dori intent-check reads the owner's words with a reviewer model (owner-check) instead of counting shared words");
  drop("handover", "laneRepeats", "a stuck lane is due for a rollover at rung 4 of the stuck ladder");
  drop("discord", "doneText", "a close posts the lane's own summary for the owner (dori claim-done --summary, or one a model writes from its last report and REPORT.md), and a lane with a thread does not close without one");
  // owner 2026-10-20 "이건 왜 아직 기계적 구문 생성이 남아있어?": the rollover message is written, not filled in
  for (const key of ["reportText", "frozenText", "sizeText"]) drop("handover", key, "the owner's rollover message is one or two plain sentences the scripts write in discord.locale's language (what moved, why, nothing for him to do); panes and the thaw command are in the watch log");
  drop("handover", "proposalOptions", "dori rollover-propose no longer posts an owner card; the lead decides");
  drop("autoSignals", "repeatAfter", "the inferred count is one input of the stuck ladder (stuck.researchAt)");
  move("signals", "attemptPattern", "signals", "numberedAttemptPattern");
  move("autoSignals", "attemptPattern", "autoSignals", "inferAttemptPattern");
  move("explore", "challengeModels", "reviewers", "models");
  const oc = raw.autoSignals?.ownerCheck as Record<string, unknown> | undefined;
  if (oc && "models" in oc) {
    const models = oc.models;
    const rest = { ...oc };
    delete rest.models;
    section("autoSignals").ownerCheck = { ...(Array.isArray(models) && models[0] && !("first" in oc) ? { first: models[0] } : {}), ...rest };
    // both old lists set: one list holding both (challenge order first); only a reviewers.models the config sets itself wins
    const moved = section("reviewers").models;
    if (Array.isArray(models) && !userReviewers) section("reviewers").models = [...new Set([...(Array.isArray(moved) ? moved : []), ...models, ...(Array.isArray(moved) ? [] : defaultConfig().reviewers.models)])];
    warnings.push("CONFIG_OLD_KEY autoSignals.ownerCheck.models -> reviewers.models (one list for challenge and owner-check) and autoSignals.ownerCheck.first; rename it in the config");
  }
  return { raw, warnings };
};

export const loadConfig = async (path = configPath(), home = homedir(), warn: (line: string) => void = (line) => console.error(line)): Promise<DoriConfig> => {
  const base = defaultConfig(home);
  const file = Bun.file(path);
  const migrated = migrateOldKeys((await file.exists()) ? ((await file.json()) as Raw) : {});
  for (const w of migrated.warnings) warn(`${w} (${path})`);
  const raw = migrated.raw as Partial<DoriConfig>;
  const merged: DoriConfig = { ...base, ...raw, update: { ...base.update, ...raw.update }, guard: { ...base.guard, ...raw.guard }, hooks: { ...base.hooks, ...raw.hooks }, discord: { ...base.discord, ...raw.discord }, stuck: { ...base.stuck, ...raw.stuck }, reviewers: { ...base.reviewers, ...raw.reviewers }, mergeGate: { ...base.mergeGate, ...raw.mergeGate }, scorecard: { ...base.scorecard, ...raw.scorecard }, signals: { ...base.signals, ...raw.signals }, explore: { ...base.explore, ...raw.explore }, autoSignals: { ...base.autoSignals, ...raw.autoSignals, ownerCheck: { ...base.autoSignals.ownerCheck, ...raw.autoSignals?.ownerCheck } }, handover: { ...base.handover, ...raw.handover }, related: { ...base.related, ...raw.related }, stateGit: { ...base.stateGit, ...raw.stateGit, backup: { ...base.stateGit.backup, ...raw.stateGit?.backup } }, heavyQueue: { ...base.heavyQueue, ...raw.heavyQueue } };
  const heavyProblem = heavyQueueProblem(merged.heavyQueue);
  if (heavyProblem) throw new ConfigError(`${path}: ${heavyProblem}`);
  if (!OWNER_SPEECHES.includes(merged.discord.ownerSpeech)) throw new ConfigError(`${path}: discord.ownerSpeech must be "" (follow discord.locale), "casual" or "polite", not ${JSON.stringify(merged.discord.ownerSpeech)}`);
  const researchProblem = researchTextProblem(merged.explore.researchText);
  if (researchProblem) throw new ConfigError(`${path}: ${researchProblem}`);
  const env: unknown = merged.launchEnv;
  if (!env || typeof env !== "object" || Array.isArray(env) || Object.values(env).some((v) => typeof v !== "string")) throw new ConfigError(`${path}: launchEnv must map variable names to strings, e.g. {"CUDA_VISIBLE_DEVICES": ""}`);
  const stateDir = expandHome(process.env.DORI_STATE_DIR ?? merged.stateDir, home);
  const leadPane = process.env.DORI_LEAD_PANE ?? merged.leadPane;
  const repo = raw.update?.repo ? expandHome(raw.update.repo, home) : (await run(["git", "-C", import.meta.dir, "rev-parse", "--show-toplevel"])).out || base.update.repo;
  return {
    ...merged,
    stateDir,
    watchLog: expandHome(raw.watchLog ?? join(stateDir, "lanes.log"), home),
    update: { ...merged.update, repo, alertPane: raw.update?.alertPane ?? leadPane, services: merged.update.services.map((s) => ({ ...s, paths: s.paths ?? ["skills/dori-mode/scripts/src/"], log: expandHome(s.log ?? "", home), ready: s.ready ?? "" })) },
    defaultCwd: expandHome(merged.defaultCwd, home),
    directives: { common: expandHome(raw.directives?.common ?? base.directives.common, home), local: expandHome(raw.directives?.local ?? "", home), links: expandHome(raw.directives?.links ?? "", home), linkPeers: raw.directives?.linkPeers ?? [], memory: expandHome(raw.directives?.memory ?? "", home) },
    sessionsDir: expandHome(merged.sessionsDir, home),
    scorecard: { ...merged.scorecard, sessions: expandHome(merged.scorecard.sessions || merged.sessionsDir, home), lanesLog: expandHome(merged.scorecard.lanesLog || (raw.watchLog ?? join(stateDir, "lanes.log")), home), leadSessions: expandHome(merged.scorecard.leadSessions, home), inbox: expandHome(merged.scorecard.inbox, home) },
    handover: { ...merged.handover, inbox: expandHome(merged.handover.inbox, home), cwd: expandHome(merged.handover.cwd, home) },
    stateGit: {
      ...merged.stateGit,
      dirs: merged.stateGit.dirs.map((d) => expandHome(d, home)),
      backup: { ...merged.stateGit.backup, ...Object.fromEntries((["dirs", "secretFiles", "messageFiles"] as const).map((k) => [k, merged.stateGit.backup[k].map((d) => expandHome(d, home))])) },
    },
    leadPane,
  };
};

export const fill = (template: ArgvTemplate, values: Readonly<Record<string, string>>): string[] =>
  template.map((part) => part.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole));

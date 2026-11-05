#!/usr/bin/env bun
// allow: SIZE_OK — existing command dispatcher; command behavior lives in separate modules.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { currentTmuxSession, paneActivity, paneLife } from "./aoe.ts";
import { isHerdrPane } from "./herdr.ts";
import { jobSignal, resumeAfterThaw } from "./job-control.ts";
import { reviveHerdr } from "./herdr-sessions.ts";
import { fileLog, installTaskRefusal, serve, serveLoops, spawnLoop, TASK_NAME, taskArgv } from "./serve.ts";
import { winSignal } from "./win-suspend.ts";
import { type AskPlace, AskPlaceError, askPlace } from "./ask-place.ts";
import { CheckpointError, Checkpoints } from "./checkpoints.ts";
import { isLessonOutcome, LessonError, Lessons } from "./lessons.ts";
import { Worklog, WorklogError } from "./worklog.ts";
import { type BudgetLimits, laneLimits } from "./supervision.ts";
import { addItem, BacklogError, backlogTick, byTurn, decideItem, dropItem, type FeedTodo, feedIntake, inboxReader, instanceOf, itemLine, laneKeyOf, lastRun, listItems, orderIntake, pairIntake, readItem, type TickDeps, withBacklogLock } from "./backlog.ts";
import { poolFree } from "./lead-limit.ts";
import { leadAlertPoster } from "./autoturn.ts";
import { findLead, LeadError } from "./lead.ts";
import { accountHome, ackHandover, handover, type HandoverDeps, LEAD_SUMMARY_TEMPLATE, missingWatchers, windowsDetachRefusal } from "./handover.ts";
import { laneHandover, type LaneHandoverDeps, markReady, paneSignals, SUMMARY_TEMPLATE } from "./lane-handover.ts";
import { auditHandover, auditSummary, type Committed, findCommitted, markerFile, reportGap, sendAuditSummary, summaryWeek } from "./rollover-audit.ts";
import { appendRollover, AUTO_GRANT_ENV, decidedBy, dueReasons, holdTyped, LEAD_PREFIX, limitsFor, mintAutoGrant, outcomeLine, peerStuckLines, pendingStuck, quietReason, readRollovers, type RolloverRequest, rolloverStats, sessionStart, stuckOutcomeLines } from "./rollover.ts";
import { procTable, resolveSession } from "./session-id.ts";
import { restartService } from "./update-ready.ts";
import { ConfigError, configPath, envFilePath, fill, loadConfig, loadEnvFile, resolveInstance } from "./config.ts";
import { checkRepo, commitDir, initRepo, logDir, restoreDir, type StateGitDeps, stateGitDirs } from "./state-git.ts";
import { approve, backupTick, type BackupDeps, envFilesIn, guardDir, loadSecrets, msToNextSlot, previewDir, pushAll, pushCheck } from "./state-backup.ts";
import { backupRemoteUrl, backupVisibility } from "./backup-visibility.ts";
import { paneTranscriptHas, sendVerified, submitToPane } from "./panes.ts";
import { retryLaneTells } from "./lane-tells.ts";
import { applyUpdate } from "./update.ts";
import { announceChange } from "./update-announce.ts";
import { deadPaneTick, newDeadPaneState } from "./dead-panes.ts";
import { claimDone, closeLane, closeLessons, type FlowDeps, GoalUnverifiedError, LaneStateError, objectDone, pauseLane, recordThreadPost, resumeLane, typeIntoPane, watchTick } from "./done-flow.ts";
import { ownerSpeechProblem, plainSummaryProblem } from "./close-summary.ts";
import { literalNewlineProblem } from "./messenger/literal-newline.ts";
import { autoReadyLine, freshnessTick, resumeArgs } from "./freshness.ts";
import { sampleUsage } from "./heavy-headroom.ts";
import { gpuRoom, neverFits, parseMem, readMeminfo, spawnScoped } from "./heavy-mem.ts";
import { heavyJobCommand, HeavyJobError, heavyServe } from "./heavy-queue.ts";
import { acquireSlot, pidAlive, releaseSlot, type SlotDeps } from "./heavy-slot.ts";
import { heavyWorker } from "./heavy-worker.ts";
import { heavySpread, isKind, spreadPlan, withPipefail, type SpreadJob } from "./heavy-spread.ts";
import { guardTick, sampleHost } from "./host-guard.ts";
import { areaLabel, type AreaQuery, areaSignals, formatSignals, hasSignals, oneLine, priorFixLines, tagsOf } from "./lane-signals.ts";
import { adoptLane, asStartFailure, DirectiveMissingError, doneWeakWarning, goalWarning, laneStartText, launchEnvArgs, launchLane, LaunchError, launchLedger, relatedGate, renderBrief, reopenLaneThread, setDone, setGpu, setThread, threadGate, ThreadMissingError, validateLaunch } from "./launch.ts";
import { checkedLedger, DirectiveError, directiveLine, HINT_LIMIT, type Ledger, ledgerProblems, ledgerTable, loadLedger, messageLines, promptTable, textDirectives } from "./directives.ts";
import { applyDirectives, auditOrReport, checkMeaning, dailyAuditHook, linkRows, memoryRepoFor, pushLinks, sinceIso } from "./directive-audit.ts";
import { addNode, formatIntent, formatTree, gateFix, intentView, laneArea, loadTree, NODE_KINDS, type NodeKind, recordBranch, recordOverride, recordRefusal, requiredMessage, researchCheck, researchFacts, researchHint, sendResearch, setStatus, stuckTop, stuckView, type TreeArea, TreeError, updateTree } from "./explore.ts";
import { challengeMissing, ChallengeError, checkReviewers, familyOf, reviewers, runChallenge } from "./challenge.ts";
import { gateMissing, GateRefusal, mergePr, parsePr, reviewPr } from "./merge-gate.ts";
import { canonical, evidenceLines, inferredLine, inferRepeats, laneEvents, type MetricRepeat, suspects } from "./auto-signals.ts";
import { runIntentCheck, sendReread } from "./intent-check.ts";
import { branchesFrom, ForkError, forkExplore, type Mode } from "./fork-explore.ts";
import { Registry, statusOf } from "./registry.ts";
import { realClock, run } from "./run.ts";
import { watchLog } from "./watch-log.ts";
import { syncRegistry } from "./sync.ts";
import { closeDueFrozen, closeFrozen, frozenLine, readFrozen, thawFrozen } from "./frozen.ts";
import { canLaunch } from "./routing.ts";
import { normFix, recordFix } from "./same-fix.ts";
import { computeScorecard, dayWindow, formatScorecard, saveScorecard, ScorecardError } from "./scorecard.ts";
import { fetchHttp, MessengerError, UnsafeMessageError } from "./messenger/http.ts";
import { clearEyes, Slack, slackRowIds, slackUnreact } from "./messenger/slack.ts";
import type { UploadFile } from "./messenger/slack.ts";
import { type DiscordFile, discordMessageProblem, filesKey, readDiscordFiles, readUploads, UploadRefused } from "./messenger/upload-files.ts";
import { pollSlackInbound } from "./messenger/slack-inbound.ts";
import { envInt, fileTgInboundStore, telegramInboundLoop, writeLineSync } from "./messenger/telegram-inbound.ts";
import { ThreadLedger } from "./messenger/thread-ledger.ts";
import { slackPresence } from "./messenger/slack-presence.ts";
import { Telegram } from "./messenger/telegram.ts";
import { Discord, discordPresence, tokenBotId } from "./messenger/discord.ts";
import { openCardIds, QuestionCards, QuestionError, QuestionStore } from "./messenger/discord-cards.ts";
import { DiscordListener, eyesOff } from "./messenger/discord-listener.ts";
import { bareThreadName, discordThreadId, postInThread, postLaneStart, progressText, threadName, ThreadRefError, type ThreadStatus, type ThreadVerb, VERB_STATUS, withoutEmoji } from "./messenger/discord-thread.ts";
import { duplicateLine, SEND_DUPLICATE_EXIT, type Sent, sendKey, sendOnce, sentLine } from "./send-dedupe.ts";
import { mapThread, standThread, threads, unstandThread } from "./messenger/thread-map.ts";
import { archiveDoneThreads } from "./messenger/thread-archive.ts";
import { ThreadStatusQueue } from "./messenger/thread-status-queue.ts";
import { realTimers } from "./messenger/typing.ts";
import { transcribe, TranscriptionError } from "./messenger/voice.ts";

const USAGE = `dori <command> [options]

  lead                                 print the live lead as "<aoe-id> <tmux-session>" (herdr: "<omo session id> <pane>"),
                                       " stopped" after it when its session or agent is not running
  serve [--log FILE] [--only TAG ...] [--install-task]
                                       keep this Dori's loops running in one process where there is no systemd (native
                                       Windows): watch, freshness, dead-panes, guard, state-git, inbound discord and the
                                       session watcher, each started again when it exits, every line stamped and tagged in
                                       --log (default <stateDir>/serve.log); --install-task registers it with the Windows
                                       Task Scheduler to start at logon with no execution time limit
  revive <herdr pane> [--text TEXT]    start the omo session recorded for a herdr pane whose agent is gone again in that
                                       pane (omo --session-id), wait for its prompt and type TEXT; REVIVE_OK or REVIVE_FAIL;
                                       a pane whose agent runs is left alone (REVIVE_ALREADY_RUNNING)
  launch <key> --title T --brief FILE --done "merged o/r#N; closed o/r#M" --thread REF|new [--why-new "<reason>"] | --no-thread "<reason>" [--model M] [--cwd DIR] [--tag T ...] [--done-weak-ok]
         [--goal "owner words"] [--challenge-before STEP ...] [--use-gpu] [--ui] [--dry-run]
         [--wall-minutes N|none] [--token-limit N|none] [--cost-limit N|none] [--activity-path FILE ...]
                                       every lane opens with a work thread (the owner's long work gets one): --thread REF
                                       for the open thread the work continues in, --thread new to open one named T in this
                                       Dori's own channel (DORI_DISCORD_CHANNEL; THREAD_OPENED, then the lane's first
                                       message), or --no-thread "<reason>" for a lane the owner did not ask for
                                       (LAUNCH_THREADLESS, kept in the registry). Neither, or --thread none: LAUNCH_NO_THREAD,
                                       exit 4, nothing opened; a channel id as REF: LAUNCH_THREAD_IS_CHANNEL, exit 4.
                                       --thread new first looks for related open threads (a lane open there or closed
                                       less than related.recentH hours ago; an owner message the brief links in it, the
                                       same link, its ~/.dori/qa/<key>/ folder, shared title and brief words): found, it
                                       prints a LAUNCH_RELATED_THREAD line per thread with its evidence and exits 4,
                                       nothing opened; pass --thread REF to continue there, or --why-new "<reason>" to
                                       open a new one anyway (LAUNCH_NEW_THREAD_WHY, the reason kept in the registry)
                                       prints LAUNCH_DONE_WEAK (and still launches) when every Done signal only checks
                                       files or text; --done-weak-ok silences it. The brief gets a "Past signals" section
                                       from earlier lanes in the same cwd or with a shared tag (the key's first word is one)
                                       and the area's "Hypothesis tree". --goal keeps the owner's words for intent-check
                                       (LAUNCH_NO_GOAL without it); --challenge-before makes the lane run dori challenge
                                       before that step (claim-done is refused until it did); --dry-run prints the brief
                                       as the lane would read it and opens nothing. The session starts with config
                                       launchEnv (aoe), e.g. the GPU hidden; --use-gpu starts it without, and the
                                       registry keeps that for handover and restart. --ui puts the owner's seven UI steps
                                       (references/ui-work.md) at the top of the brief, after its ulw line; a brief that
                                       reads like UI work without --ui prints LAUNCH_UI_HINT (and still launches). A brief with none of
                                       the eight steps of references/sessions.md gets them after its four fields
                                       (LAUNCH_STEPS_ADDED); with only some, LAUNCH_STEPS_PARTIAL and nothing added.
                                       The directive ledger (config directives.common + .local, dori directives): a
                                       directive in scope (all lanes, UI work, a kind of work, the --cwd repo, a keyword;
                                       quoted words and directive names do not count) that the brief lacks is added as
                                       written there (LAUNCH_DIRECTIVE_ADDED); a require directive the brief does not meet
                                       stops the launch (LAUNCH_DIRECTIVE_MISSING, exit 4, nothing opened) unless
                                       --waive <id> "<reason>" (repeatable) leaves it out: LAUNCH_DIRECTIVE_WAIVED in the
                                       watch log and the registry, and discord.waiveText to the owner
  backlog [list [--all]|add <id> --title T --brief FILE --done "..." [--priority 1-9] [--cwd DIR] [--thread REF|new | --no-thread "<reason>"] [--why-new R] [--goal "owner words"] [--tag T ...] [--ask "<question for the owner>"] [--read-only] [--owner-link URL] [--by owner|lead]|drop <id> [--reason R]|decide <id> [--question Q --hash H] --text "<the owner's answer>"|tick [--force]]
                                       the list of work the owner or the lead put by hand (no GitHub import): with
                                       config backlog.enabled, the freshness loop of dori-lanes runs a pass every tick: a
                                       running item whose lane closed is done (BACKLOG_DONE), an item with --ask puts one
                                       backlog-ask row in the lead's inbox and never starts before decide (BACKLOG_ASK), and
                                       the next open items start at once by priority through dori launch (its directives,
                                       eight steps and work thread; --thread new by default) under the lane key bl-<id>
                                       while fewer than backlog.maxLanes backlog lanes of this Dori and backlog.hostMaxLanes
                                       of all Doris on the host run, at most backlog.maxStarts a pass, and, checked before
                                       each start, a model account is free and dori can-launch and the load guard allow
                                       (BACKLOG_STARTED; BACKLOG_HOLD and BACKLOG_WAIT when that changes or at a
                                       backlog.everyMin sweep). With backlog.writeNeedsOwnerLink an item without --read-only
                                       and without a checked --owner-link asks the owner first; --read-only items launch
                                       with a read-only rule. A refused launch holds the item at once, a backend failure
                                       after two tries (BACKLOG_HELD, a backlog-held row) until add replaces it or drop.
                                       backlog.feedCommand (YooDori's dashboard todos) is read at each sweep: an entry the
                                       owner approved by card (auto_applied false) works within its own scope, any other
                                       only reads and drafts (the limit is added at each launch from the item's state, and
                                       bound to the entry's content: changed content asks again, decide --question --hash
                                       answers that one question); an entry on hold (보류) waits, one finished or gone on
                                       the dashboard drops its open item. backlog.dayReportAt sends one backlog-day row a day.
                                       tick runs a pass by hand (--force: a sweep now, even when off)
  directives [table|prompts|check [--static]|apply <key> [--dry-run]|hint <text>|links [--push]]
                                       hint prints the directives (at most five) an owner message with that text carries
                                       in its inbox row (DIRECTIVE_HINT / DIRECTIVE_HINT_NONE);
                                       the directive ledger: table (default) prints it as one table for the owner; prompts
                                       prints his words next to the prompt each brief gets (형 원문 | 지침문); check
                                       validates both layers and has a reviewer of another family compare every new or
                                       changed prompt with his words (DIRECTIVES_OK, or DIRECTIVES_BAD / _MEANING_FAILED
                                       lines and exit 1; --static skips the reviewer); apply sends a lane launched before
                                       a directive was in the ledger the ones in scope its brief lacks, as one [LEAD]
                                       message, and adds them to its brief under "## 추가 지침(리드, launch 뒤)"
                                       (DIRECTIVES_APPLIED; none missing: DIRECTIVES_APPLY_NONE; not submitted:
                                       DIRECTIVES_APPLY_NOT_SENT, exit 1, brief unchanged)
  directive-audit [--since 24h|Nd|ISO] [--dry-run]
                                       the lanes opened since then against the ledger (directives in scope missing from
                                       the brief, a lane without a thread) and the owner's messages that read like a
                                       standing directive no ledger entry cites, a lead thread opened without the ledger read
                                       (DIRECTIVE_LEAD thread:<id>), and a line of the lead's memory (system/, reference/)
                                       that keeps a ledger directive a second time instead of a pointer "장부:<id>"
                                       (DIRECTIVE_DUPLICATE): DIRECTIVE_GAP / DIRECTIVE_LEAD / DIRECTIVE_UNLEDGERED /
                                       DIRECTIVE_DUPLICATE lines into the watch log and one [DIRECTIVE_AUDIT] summary to
                                       the lead; none: DIRECTIVE_AUDIT_OK on stdout only. --dry-run prints and sends nothing
  adopt  <key> --pane ID --title T --brief FILE --done "..." [--thread REF] [--tag T ...] [--goal G] [--challenge-before STEP ...] [--use-gpu]
                                       REF is <adapter>:<id> (discord:<thread id>); an empty or malformed REF is refused
  set-thread <key> <adapter>:<id>      point an open lane at another work thread
  done-set <key> --done "<signals>" --reason "<why>"
                                       change an open lane's Done line when its plan changed after launch: the new line is
                                       checked like launch's and read once now (SIGNAL OK/NOT lines, DONE_SET <key> live k/n);
                                       the earlier line stays in the lane's doneChanges, the watch log gets DONE_SET, the
                                       brief's footer gets the new line and the lane is told. dori close and the watcher then
                                       read the new line, and every signal still has to read back live
  set-gpu <key> on|off                 on: the lane's next session (handover, restart) starts without launchEnv; off: with it
  launch-env <tmux-session>            env(1) arguments a restart of that session needs to start like dori opens it
                                       (NAME=VALUE for a lane, --unset=NAME for a --use-gpu lane or any other session;
                                       nothing without launchEnv); used by setups/discord-aoe/self-restart.sh
  sync   [--write]                     registry vs live panes; read-only unless --write; a SIGNALS line per open lane with a record
  checkpoint <key> --step ID --result TEXT --evidence PATH [--remote-effect RECEIPT]...
                                       record a finished step in <stateDir>/lane-state/<key>/checkpoints.jsonl (locked);
                                       the same step again with the same data is a no-op, with other data it is refused;
                                       one --remote-effect per receipt (a push, a merge), each recorded under one step only
  checkpoints <key>                    print the lane's finished steps (JSON); read them before resuming remote work
  caps <key> [--wall-minutes N|none] [--token-limit N|none] [--cost-limit N|none]
                                       print the lane's caps (supervision.defaults, then supervision.lanes.<key>, then its own);
                                       with flags, set its own (none: off). At a cap freshness tells the lead once (LANE_CAP);
                                       the lane is never stopped or told
  claim-done [<key>] --evidence TEXT [--summary TEXT] [--posted ID|LINK] [--post-summary] [--rollover-outcome TEXT [--rollover-unresolved]]
                                       key defaults to the lane registered for this pane (the tmux session it runs in, else
                                       $HERDR_PANE_ID); --summary: 2 to 5 plain lines for the owner's thread in his language.
                                       The result reaches the thread once: when this lane's session posted in its work thread
                                       (dori send, dori thread) in the last 30 minutes, or --posted names that message, it is
                                       the result (RESULT_ALREADY_POSTED) and the close posts no summary; --post-summary: that
                                       post was not the result, post the summary anyway. A lane moved to a new session at
                                       rung 4 of the stuck ladder gives --rollover-outcome: one line on what it did
                                       differently after the move (--rollover-unresolved: the move did not solve it); without
                                       it the claim is ROLLOVER_OUTCOME_MISSING, exit 2, nothing recorded
                                       (what changed, what is left, when it reaches where it is used), posted before the close
                                       marks the thread done; paths, commit hashes, backticks or report heads are refused
                                       (SUMMARY_REFUSED, exit 2). Without it the close has a model write one from the lane's
                                       last report and REPORT.md
  object-done <key> --reason TEXT [--reason TEXT ...]
  pause  <key> <reason>                park a lane that waits on a human: no freshness nudge or post, LANE_BLOCKED or
                                       DEAD_PANE for it, and a done claim does not close it; the reason goes in its history.
                                       With aoe it first pauses the omo goal of the lane's session (/goal pause, read back:
                                       GOAL_PAUSED or GOAL_SKIPPED); PAUSE_UNVERIFIED, exit 3, lane unchanged, if not confirmed
  resume <key>                         back to the status it had before the pause, and /goal resume for a goal the pause
                                       paused (RESUME_UNVERIFIED, exit 3, still paused, if not confirmed)
  fix-attempt <key> --metric M --hypothesis H [--hypotheses H1 --test T1 ...] [--improved] [--no-hypotheses REASON]
                                       record that you asked the lane for another fix of M on hypothesis H; first prints
                                       PRIOR_FIX lines (hypotheses already tried on M in this area). One step of the stuck
                                       ladder (lanes tag reports "(fix: M / H)" for the same count; untagged repeats count
                                       too): from stuck.hypothesesAt (2) failed attempts on M it refuses (HYPOTHESES_REQUIRED,
                                       exit 5) unless 3+ competing --hypotheses each have a cheap --test (STUCK_BRANCH, into
                                       the tree); at stuck.researchAt (3) STUCK rung 3 sends the lane ulw research and a
                                       challenge of its next plan; after that, or one hypothesis fixatedAfter (3) times,
                                       STUCK rung 4 (the lead may roll it over). --improved: the last fix moved M, the count
                                       starts again; --no-hypotheses REASON goes on anyway (HYPOTHESES_OVERRIDE, logged)
  tree [show|add|falsify|support|close|reopen] [ID] [--lane K | --cwd DIR | --tag T] [--kind K] [--text T] [--test X] [--metric M] [--result R]
                                       the area's hypothesis tree: open, supported and falsified hypotheses, untried
                                       directions (--kind direction), findings, research due, attempts tried. add takes
                                       --kind hypothesis|direction|finding|research --text; falsify/support/close take
                                       an ID and --result. No area option: this pane's lane, else the current directory
  challenge <key> --plan FILE [--model M] [--all]
                                       a model of another family than the lane's reviews the plan in a fresh context,
                                       with read-only access to the plan's repository: reasons it will fail, missing
                                       alternatives, the cheapest falsifying test. Saved under <stateDir>/challenges/<key>/
                                       and recorded on the lane (CHALLENGE_SAVED). Reviewers go in reviewers.models
                                       order (best GPT, Claude, Grok); the first that writes a review wins, --all asks one
                                       of each family in turn. Ids this host cannot call are skipped before any call
  challenge --check [<key>]            each reviewer id: REVIEWER_OK (and the id it is called as) or REVIEWER_SKIP and why
  review <owner/repo#N> [--dir CHECKOUT] [--model M] [--lane K] [--no-test "<reason>"]
                                       a review receipt pinned to the PR's head commit: CHECKOUT (default: here) must be
                                       that head with no changes; the commit checks run first (REVIEW_CHECKS_FAILED: a
                                       commit's author or committer is not mergeGate.identities[repo], or a fix: commit
                                       changes source and no commit adds or changes a test; --no-test waives only the
                                       test rule, its reason kept in the tests receipt); mergeGate.testCommand next (TESTS_OK, or
                                       REVIEW_TESTS_FAILED and no review); then a fresh reviewer of another family than
                                       the lane's model reads the diff and the code and ends with VERDICT: CLEAR|BLOCK
                                       (exit 1 on BLOCK). For repos without CI: a PR with GitHub checks or auto-merge is
                                       refused (unsupported). Receipts: <stateDir>/receipts/<repo>_<N>@<sha>.<kind>.json
  merge <owner/repo#N> [--dry-run] [--delete-branch]
                                       MERGE_REFUSED <reason> unless the head has a CLEAR review receipt and a passing
                                       local test receipt; then gh pr merge --squash --match-head-commit <head>, read back
                                       as MERGED ... merge=<sha>. A commit pushed after the review has no receipt, so it is
                                       refused until reviewed again
  fork-explore <key> --metric M --hypotheses H1 --test T1 --hypotheses H2 --test T2 ... [--gpu N ...|--gpu-all]
               [--mode agent|cmd] [--minutes N] [--model M]
                                       one time-boxed task per hypothesis, in parallel, all on metric M; GPU branches
                                       (--gpu <branch number>) wait for a heavy slot. agent: an omo -p run per branch;
                                       cmd: each --test is a command. Prints a comparison table, feeds the tree
  research-hint <key> [--send]         a search plan for the lane's stuck symptom (papers, issues, repos), from its records;
                                       --send types explore.researchText into the lane: "ulw research " and a question
                                       built from its records, so omo starts its ulw-research skill (RESEARCH_SENT)
  research-check <key>                 did the last ulw research text start the skill: the lane's session log holds the
                                       omo-ulw-research:skill-pointer and a read of ulw-research/SKILL.md (RESEARCH_STARTED),
                                       not yet (RESEARCH_PENDING), or not within explore.researchVerifyMin (RESEARCH_NOT_STARTED,
                                       exit 6). freshness runs the same check on every tick
  intent-check <key> [--direction TEXT] [--next TEXT] [--goal "owner words"] | intent-check <key> --reread
                                       the owner's goal next to the lane's current direction and next step, then a reviewer
                                       of another family (reviewers.models, reviewers.first first) reads them, the brief,
                                       the owner's words in it and in the lead's [LEAD] relays, his card answers and
                                       messages in the lane's thread (dated, the newest wins; in a thread other lanes share,
                                       only those tied to this lane) and the newest reports: INTENT_CHECK <key> OK, or
                                       VIOLATION|CONTRADICTION|GOAL_LOSS with quoted evidence as the stuck ladder's context
                                       rung (STUCK "@context"; again after a confirmed re-read, rung 4). An owner quote not
                                       in his words is dropped (INTENT_CHECK_UNGROUNDED), one in a shared thread's message
                                       for another lane too (INTENT_CHECK_SHARED), a report an earlier check read is not
                                       flagged again (INTENT_CHECK_STALE). --direction/--next record what the lane says it
                                       does now; --goal sets a missing goal. --reread: you confirmed the last finding, so
                                       the lane gets stuck.rereadText (its brief and the owner's words to re-read; REREAD_SENT)
  repeat-check <key> [--since ISO|Nd|Nh] [--until ISO] [--repo DIR ...] [--backtest]
                                       untagged repeats: a gate line (metric) that failed and was re-targeted by a new
                                       prescription or patch, from the lane's [REPORT] lines, its branch commits (worktrees,
                                       cwd, --repo) and tree entries; INFERRED <key> "<metric>" <n> with the evidence from
                                       stuck.researchAt cycles (the inferred half of the stuck count). Default window: the
                                       lane's current session. --backtest prints each time a count reached it, with its time
  signals [--lane K | --cwd DIR | --tag T]
                                       what earlier lanes tried and how it went: numbered fix attempts and the root-cause
                                       switch, tagged fixes by metric, rejected done claims, re-sends, nudges, outcome,
                                       warnings; no option = one SIGNALS line per open lane. Read it before re-instructing
  lesson add <key> --rule TEXT --evidence PATH [--cwd DIR]
                                       keep a rule the lane learned about its repo (the lane's cwd); the next launch there
                                       puts it in the brief under "Lessons for this repo"
  lesson list [--cwd DIR]              current lessons, newest first; a damaged journal line is a LESSON_WARNING
  lesson mark <id> --outcome pending|helped|no-effect|harmful|encoded
                                       only pending and helped ones reach new briefs
  worklog add <title> --source REF     record an owner request when it arrives (upstream dori-superagent#96)
  worklog next|note <id> <text>        set the item's next step, or add a note (a decision, an owner)
  worklog close <id> --result TEXT     close the item with what came of it
  worklog list [--open]                items as JSON; <stateDir>/worklog.md holds the same for reading, and the
                                       dori handover note lists the open ones
  close  <key> [--note TEXT] [--summary TEXT] [--posted ID|LINK] [--lesson TEXT [--evidence PATH]]...
                                       close now (Done signals must read back live); a lane with a work thread first posts
                                       its summary for the owner there (--summary, the claim's, else one a model writes from
                                       its last report and REPORT.md): none is CLOSE_SUMMARY_MISSING, a post that failed is
                                       CLOSE_SUMMARY_NOT_SENT, exit 2 and nothing changed. Then a discord:<id> thread is set
                                       done and archived when DORI_DISCORD_TOKEN is set; a thread another open lane or an
                                       open card uses only gets the summary posted. With the result already in the thread
                                       (the claim's RESULT_ALREADY_POSTED, or --posted for one the lead relayed) and no
                                       --summary, nothing is posted: CLOSE_SUMMARY_SKIPPED. A lane moved for being stuck that
                                       closes with no outcome line gets the --note as one, counted unknown (ROLLOVER_OUTCOME)
  watch                                long-running: emits LANE_* lines every 30 s
  update [--pull] [--dry-run]           apply changed scripts to configured services and report unset new config keys
  notify-change --summary TEXT [--file PATH ...]
                                       tell the lead about changed guidance using update.announce
  scorecard [--date YYYY-MM-DD|today|yesterday] [--post] [--to discord:<id>]
                                       the day's token scorecard from session usage, the registry, the lanes log and the
                                       inbox (no model call), saved to <stateDir>/scorecard/<date>.json and latest.md;
                                       --post also sends it to scorecard.postTo or DORI_DISCORD_CHANNEL (off by default)
  freshness [--loop MIN]               nudge silent lanes, hand their last report to the lead
  dead-panes [--loop MIN]              print DEAD_PANE <id> for stopped agent panes
  guard [--loop MIN]                   host load, memory, disk and pane-count alerts
  heavy <label> [--mem SIZE] -- <command ...>
                                       run a heavy command when a slot is free and load is low; beside a running one only
                                       when GPU, memory and CPU each keep heavyHeadroomPct (10) percent free with it
                                       (HEAVY_ADMIT / HEAVY_WAIT lines on stderr and in state/heavy/heavy.log); waiters
                                       start in the order they came. The command runs in its own systemd user scope
                                       (HEAVY_SCOPE) capped at MemoryMax: --mem (e.g. 70G), else what keeps 10% free at
                                       its start; over it only the job is killed (HEAVY_OOM, exit 137), never the lane
                                       that started it. --mem also waits until that much memory keeps 10% free (counting
                                       what running jobs said and do not use yet) and refuses one that never fits
  gpu-room [label] [--want SIZE]       make SIZE (heavyGpuFreeGb, 20G) of free memory for a GPU start, as dori heavy does
                                       before every GPU job: below it, page cache is pushed out by touching anonymous
                                       memory and letting it go, never taking MemAvailable under heavyHeadroomPct and
                                       stopping once anything is swapped out (HEAVY_GPU_ROOM / _SHORT / _FAILED on stderr
                                       and in state/heavy/heavy.log; nothing when enough is free)
  heavy <label> --job <name> [--in FILE ...] [--out DIR] [--rl] [-- arg ...]
                                       run heavyQueue.jobs.<name> in the GPU line of all hosts: on the queue host here
                                       first, then on a heavyQueue.helpers host (an rl job only where its heavyQueue.rl), else wait;
                                       elsewhere sent to the queue host (heavyQueue.queue), run here only while it cannot
                                       be reached. Prints the job's stdout, copies its result files to --out, exits with
                                       its code (HEAVY_HELPER / HEAVY_DONE / HEAVY_QUEUE_DOWN lines)
  heavy <label> [--mem SIZE] --kind cpu|browser|gpu --sync PATH ... [--env NAME ...] -- <command ...>
                                       run the lane's own command on the less busy PC: a heavyQueue.helpers host when this
                                       one is more than 15 points busier or refuses it, in a bwrap box with no network,
                                       the --sync folders copied there at the same paths and changed files copied back
                                       (HEAVY_SPREAD / HEAVY_BACK / HEAVY_DONE); paths outside --sync run here (HEAVY_LOCAL)
  heavy-serve <label> <name> [--rl] -- [arg ...]
                                       queue host side of a job sent by another host: inputs as tar on stdin, result tar
                                       on stdout
  heavy-worker [--caller ACCOUNT]      a helper's forced command for the queue host's key (SSH_ORIGINAL_COMMAND "run
                                       <label> <name> [arg ...]", "exec ..." when heavyQueue.exec is
                                       true, or "sweep"); job files live in heavyQueue.jobDir and
                                       are deleted after each run
  can-launch                           exit 0 if the host has room for a new lane, else print why and exit 4
  state-git [init|commit|log [N]|restore <time|sha> [--file PATH ...]|loop|check|push-check] [--dir DIR ...]
  state-git backup [create|preview|approve --by "lead: ..." [--history-ok DIR:PATH ...]|push|tick [--clock ISO]]
                                       the private backup (stateGit.backup.repo): a checked snapshot per directory,
                                       pushed by the loop at stateGit.backup.at (06:00) when no pane is mid-turn, no
                                       heavy job and no git lock (again every retryMin, none after until); the first
                                       push waits for approve; push-check is the pre-push hook
                                       this Dori's state in local git (config dir, stateDir, inbox dir; pushed only as above):
                                       commit only when something changed, never env/inbox/briefs/logs or token-shaped
                                       content; restore "yesterday 21:00" (stateGit.timeZone) commits first, so it can
                                       be undone; loop is what dori-lanes runs every stateGit.everyMin minutes
  send <slack|telegram|discord> --to TARGET --text TEXT | --text-file FILE [--thread ID] [--edit ID] [--status working|done] [--no-typing] [--ping USER_ID] [--reply ID] [--again]
  send slack --to CHANNEL --file PATH [--file PATH ...] [--text TEXT | --text-file FILE] [--thread TS]
  send discord --to CHANNEL --file PATH [--file PATH ...] [--text TEXT | --text-file FILE] [--thread ID] [--reply ID]
                                       post or edit a message (tokens from DORI_SLACK_TOKEN, DORI_TELEGRAM_TOKEN, DORI_DISCORD_TOKEN);
                                       --file (slack, up to 10, 1 GB each) uploads the files and shares them as one message
                                       with the text, in the thread with --thread (SENT <file ids>); a missing, empty or too
                                       big file is refused before anything is sent (SEND_FILE_MISSING|REFUSED|TOO_BIG, exit 2);
                                       shared once per call, never retried or repeat-checked: a failure exits non-zero;
                                       the watcher's eyes stay on (a text answer takes them off)
                                       --file (discord, up to 10, 20 MiB each, 25 MiB a message; also thread reply|wait|done) posts the text
                                       and the files as one message (SENT <id>; same refusals before anything is sent); a
                                       repeat needs the same files too (sha256), --again sends it anyway
                                       --text-file posts the file's text (real line breaks) the same way as --text. A text
                                       with a literal \n and no real line break outside code is refused before anything is
                                       sent (SEND_LITERAL_NEWLINE, exit 2; also thread reply|wait|done|open --first, ask,
                                       claim-done and close --summary)
                                       --status (discord) writes it as the progress message, in discord.statusStyle;
                                       Discord posts show typing first (best effort); --no-typing skips it
                                       --ping USER_ID (digits only) mentions and pings only that user on a new Discord post
                                       --reply ID (Discord, digits only) posts it as a reply to that message, no ping
                                       the same new message (place, --reply, --ping, text) within 10 minutes, or the
                                       place's last post at any age, is not sent again: SEND_DUPLICATE <place> <earlier
                                       id>, exit 3, also for two sends at once (thread reply too; wait|done still set
                                       their status, exit 0); --again sends it anyway; a post prints what the service
                                       holds: SENT <id> len=<n> sha=<8 hex> first="<40 chars>"; an option send does not
                                       take is refused (UNKNOWN_OPTION, exit 2)
  type <pane> --text TEXT | --text-file FILE
                                       type text into an agent pane and confirm it was submitted: Enter, an empty input
                                       box (one more Enter if not), a running turn. Prints SUBMITTED, or NOT_SUBMITTED
                                       <reason> (also in the watch log) and exits 1. Use it for every [LEAD] relay
  presence <slack|discord>             keep the account shown as online until stopped
  transcribe <audio-file>              run hooks.transcribe and print the text
  inbound slack [--loop MIN]           print INBOUND lines: unread thread replies (threads view), replies in threads
                                       the Dori posted in (any helper), DMs and channels with unread mentions
  inbound telegram [--loop MIN]        print INBOUND lines: the owner's Telegram DMs and his messages in the configured
                                       group topic (DORI_TELEGRAM_TOKEN, DORI_TELEGRAM_OWNER_ID, optional
                                       DORI_TELEGRAM_GROUP_ID, DORI_TELEGRAM_TOPIC_ID), owner-gated getUpdates; his
                                       edits as edit:dm / edit:topic, media with file=<kind>:<file_id>
  inbound discord                      long-running gateway listener: the owner's messages get an eyes reaction and an
                                       inbox row, voice is transcribed, question-card answers are recorded; with
                                       DORI_DISCORD_WATCH_CHANNELS + DORI_DISCORD_WATCH_BOTS a monitoring bot's problem
                                       alert there (DORI_DISCORD_WATCH_MATCH) is a scope:"watch" row for the lead
  eyes off <message id | link>         take this Dori's own eyes off one message at once: an owner message it read and
                                       will not answer (another Dori's work in the pair channel). Prints EYES_OFF
                                       <channel> <id>; the channel comes from the link, eyes.json or
                                       DORI_DISCORD_PAIR_CHANNEL. Other reactions stay
  ask --text Q --option A [--option B ...] [--thread REF | --reply-to MSG | --channel "<reason>"] [--session ID] [--tmux NAME]
                                       post a Discord question card; the first option is the recommended one. It goes in
                                       its work's thread: --thread, else the open lane thread of the asking session
                                       (--tmux, --session or this pane) or the one thread mapped to it (ASK_THREAD_AUTO);
                                       --reply-to answers the owner's own message where he wrote it; --channel "<reason>"
                                       posts in the channel with the reason on the card; none found: ASK_THREAD_REQUIRED
                                       (exit 2), nothing posted
  questions [--open]                   list tracked question cards
  reopen <Qn> / resolve <Qn> [--answer TEXT]
                                       put a card's buttons back / forget a settled question; a card still open (the
                                       owner answered in text) folds into its record with TEXT as the answer
  handover --approved-by REF [--note FILE] [--title T] [--model M] [--keep-old] [--no-monitors] [--minutes N] [--dry-run]
                                       move the lead to a new session (omo on aoe or herdr): write a note (open lanes, the old
                                       session's running monitors, open question cards, todos, timers, the owner's
                                       messages of the last 24 h from the inbox, the old log's path, --note: the old lead's
                                       summary under the headings of handover --template), open the new session on it,
                                       point leadPane, dori.env DORI_LEAD_*, the lanes and the cards at it, restart
                                       handover.services, then check that its monitors run, that a [REPORT] probe and an
                                       inbox probe are acked from it, and that its restatement (HANDOVER_UNDERSTAND) names
                                       every open lane, card and timer, the owner's words and the summary's decisions and
                                       follow-ups; what it leaves out is sent back with the old log lines behind it
                                       (HANDOVER_SUPPLEMENT, up to handover.supplementRounds rounds). Only then is the old
                                       lead frozen (SIGSTOP on its agent and children, HANDOVER_OLD_FROZEN, HANDOVER_DONE) and
                                       closed handover.frozenCloseH hours later by freshness; a failed check moves everything
                                       back and freezes nothing (HANDOVER_VERIFY_FAIL, exit 3). Run from inside the lead it
                                       detaches itself (systemd-run)
  handover frozen | thaw <pane> | close-frozen [<pane>]
                                       list the frozen old sessions (leads, and lanes kept for the work their monitors
                                       started); resume one frozen by mistake; close one now, or every one whose close time
                                       passed or whose monitors' work ended (its log stays)
  handover audit <note.md|key|lead> [--dry-run] [--no-send] [--force]
                                       the audit after a committed handover (freshness starts it handover.auditAfterMin
                                       after the commit): the owner's quoted words and recent lead instructions only the
                                       old conversation held (a reviewer sorts them: standing, done, chatter), and the
                                       todos, goal and monitors the new session lacks; one line per gap in
                                       <stateDir>/handover/audit.jsonl, sent once as HANDOVER_SUPPLEMENT (HANDOVER_AUDIT)
  handover gap <key|lead> --kind K --text T [--fixed]
                                       record what a session found later that its handover did not carry (HANDOVER_GAP)
  handover audit-summary [--days N] [--send]
                                       the audit ledger summed up; --send puts it in the lead's inbox (freshness does it
                                       each week after handover.auditSummaryAt)
  handover --template                  print the headings of the old lead's summary (--note FILE)
  handover ack <id> [--state DIR]      the new lead answers a HANDOVER_PROBE, HANDOVER_UNDERSTAND or HANDOVER_SUPPLEMENT line with this
  handover --lane <key> --approved-by REF [--note FILE] [--model M] [--thinking L] [--force] [--keep-old] [--minutes N] [--dry-run]
                                       move a lane to a new session (run by the lead): REF is lead:<reason and the signal behind
                                       it> (the lead decides; the owner gets a line afterwards, its message id goes to the
                                       log, ROLLOVER_OWNER_REPORT_MISSING when it cannot be sent), or the owner's answered card
                                       Qn or message link, kept in the note and log: refuses while a local chain of the
                                       lane's agent or eval kernel (not the session's own launcher shell or idle kernel), a
                                       background eval cell, a running turn or an open question would die, unless the lane
                                       ran handover ready (or --force); a lead's or owner's request refused that way waits
                                       (HANDOVER_PENDING): the lane is asked for its safe point and freshness starts it again
                                       by itself; a run that finds a waiting run of the lane makes it step aside and moves
                                       the lane itself (HANDOVER_TAKEN_OVER); an automatic start (auto:) never moves a lane that
                                       runs or watches a training or eval chain (handover.trainingTags, trainingWatch);
                                       --wait-idle MIN (freshness's automatic start): waits up to MIN minutes for a running
                                       turn to end and freezes the old agent at that idle moment, before the new session opens;
                                       under the lane's lock an automatic run gives way to a lead's waiting request
                                       (HANDOVER_YIELDED); --request-at AT --request-pane PANE (freshness's start again of a
                                       waiting request): moves only while that request still waits in PANE (HANDOVER_REQUEST_GONE);
                                       writes a note (brief, owner goal, Done, the owner's messages since the last handover, todos, goal,
                                       monitors, local chains, detached jobs, last reports, model and thinking), opens a
                                       session in the same real path with --model and --thinking, points the registry and
                                       cards at it, checks its status line, monitors and a [LEAD] probe ack, then closes the
                                       old session (HANDOVER_DONE); a failed check moves back and closes the new one (exit 3);
                                       a run killed midway is repaired by the next run for that lane (HANDOVER_RECOVERED)
  rollover-propose <lead|key> [--dry-run]
                                       the rollover proposal for the lead to decide: handover.proposalText with the length
                                       signals, the thresholds crossed, the lane's stuck rung and the note a dry-run handover
                                       writes (ROLLOVER_PROPOSAL), logged to <stateDir>/rollover-log.jsonl; then run the
                                       handover with --approved-by "lead:<reason and signal>" (or "lead:<reason>,
                                       owner <message id>" when the owner asked for it: checked against the inbox)
  rollover-stats [--window H] [--stuck]
                                       proposals and rollovers from the log: signal values, approval time, each step's time
                                       and result, and the lane's watch-log quality signals H hours (24) before and after;
                                       then STUCK_OUTCOMES: stuck (rung 4) rollovers, resolved / not resolved / unknown, and
                                       one STUCK_ROLLOVER line each with the lane's own words. --stuck prints only that, for
                                       this Dori and each handover.statsPeers Dori
  handover ready [<key>] --note FILE   run by a lane in its own pane at a safe point: the local chains running now may end
                                       with the old session; FILE is the lane's conversation summary (its headings: handover
                                       ready --template) and goes into the note (valid handover.readyMin minutes)
  thread open <title> [--from MSG_ID] [--first TEXT] [--session S]
                                       open and map a work thread; standalone threads require --first. The directive
                                       ledger is read first against the title, first message and owner's message:
                                       THREAD_DIRECTIVES and one line per directive; unreadable: THREAD_REFUSED, nothing opened
  thread map discord:<id> <session|none>
                                       set the mapped session, preserving the title
  thread list                          print mapped thread ids, sessions and titles
  thread set discord:<id> working|waiting|done|standing|unstanding [--open-card]
                                       queue its status; done archives it and removes its mapping
  thread <reply|wait|done> discord:<id> <text> | --text-file FILE [--file PATH ...]
                                       post in a work thread and set its status (working, waiting, done); done archives it
                                       (Discord env: DORI_DISCORD_TOKEN, DORI_DISCORD_GUILD, DORI_DISCORD_CHANNEL, DORI_DISCORD_OWNER)`;

const die = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};

await resolveInstance(process.cwd());
const foreignEnv = await loadEnvFile(envFilePath());
if (foreignEnv.length) console.error(`DORI_ENV_FOREIGN dropped ${foreignEnv.length} inherited variables of another Dori (its bot token differs from ${envFilePath()}): ${foreignEnv.join(" ")}`);
const config = await loadConfig().catch((e: unknown) => (e instanceof ConfigError ? die(`CONFIG_INVALID ${e.message}`, 2) : Promise.reject(e)));
const discordToken = process.env.DORI_DISCORD_TOKEN?.trim();
const deps: FlowDeps = {
  run,
  clock: realClock,
  registry: new Registry(config.stateDir),
  config,
  // a close leaves a thread with an open question card as it is (cards are kept per Discord thread id)
  openCards: (ref: string) => (ref.startsWith("discord:") ? openCardIds(new QuestionStore(cardDir()), discordThreadId(ref)) : []),
  answeredCards: () => new QuestionStore(cardDir()).all().filter((q) => q.status === "answered"),
  ...(discordToken
    ? {
        markThreadDone: async (ref: string) => {
          // a rename left pending (429) is applied later by the listener; the close still says it did not happen yet
          const outcome = await threadStatuses(ownDiscord(discordToken)).request(discordThreadId(ref), "done");
          if (outcome === "pending" || outcome === "dropped") throw new Error(`thread rename ${outcome}, see the THREAD_STATUS line`);
        },
        postInThread: async (ref: string, text: string) => postInThread(ownDiscord(discordToken), ref, text),
        requestThreadStatus: async (ref: string, status: "working" | "waiting") => String(await threadStatuses(ownDiscord(discordToken)).request(discordThreadId(ref), status)),
        standingThread: (ref: string) => threads(cardDir())[discordThreadId(ref)]?.standing === true,
        reopenThread: async (ref: string, title: string) => {
          const id = discordThreadId(ref);
          const outcome = String(await threadStatuses(ownDiscord(discordToken)).request(id, "working"));
          // a done mark dropped its record (thread-status-queue.ts); a lane works in it again, mapped like --thread new
          if (outcome !== "dropped" && !threads(cardDir())[id]) mapThread(cardDir(), id, null, title);
          return outcome;
        },
        postOwner: async (channel: string, text: string) => ownDiscord(discordToken).send(channel, text),
        postLeadAlert: leadAlertPoster((channel, text) => ownDiscord(discordToken).send(channel, text), {
          pair: process.env.DORI_DISCORD_PAIR_CHANNEL?.trim() ?? "",
          owner: process.env.DORI_DISCORD_CHANNEL?.trim() ?? "",
        }),
        ...(process.env.DORI_DISCORD_CHANNEL?.trim()
          ? {
              // dori launch --thread new: a working thread in this Dori's own channel, mapped like dori thread open
              openThread: async (title: string) => {
                const id = await ownDiscord(discordToken).startThread(env("DORI_DISCORD_CHANNEL"), undefined, threadName("working", title, config.discord));
                mapThread(cardDir(), id, null, title);
                return `discord:${id}`;
              },
            }
          : {}),
      }
    : {}),
  ownerInbox: {
    path: process.env.DORI_DISCORD_INBOX?.trim() || join(config.stateDir, "discord", "inbox.jsonl"),
    ownerId: process.env.DORI_DISCORD_OWNER?.trim() ?? "",
    ownerChannel: process.env.DORI_DISCORD_CHANNEL?.trim() ?? "",
  },
  channels: [process.env.DORI_DISCORD_CHANNEL, process.env.DORI_DISCORD_PAIR_CHANNEL, process.env.DORI_DISCORD_WATCH_CHANNELS].flatMap((v) => (v ?? "").split(/[\s,]+/)).filter(Boolean),
};
const [command = "", ...rest] = process.argv.slice(2);

// --waive <id> "<reason>" takes two values, which parseArgs cannot: taken out of the arguments first
const waive: Record<string, string> = {};
for (let i = rest.indexOf("--waive"); i >= 0; i = rest.indexOf("--waive")) {
  const [id, reason] = [rest[i + 1], rest[i + 2]];
  if (!id || !reason?.trim() || id.startsWith("--") || reason.startsWith("--")) die('--waive takes a directive id and a reason: --waive <id> "<reason>"');
  waive[id ?? ""] = reason?.trim() ?? "";
  rest.splice(i, 3);
}

const flags = parseArgs({
  args: rest,
  allowPositionals: true,
  strict: false,
  options: {
    title: { type: "string" }, brief: { type: "string" }, done: { type: "string" }, thread: { type: "string" },
    model: { type: "string" }, cwd: { type: "string" }, pane: { type: "string" }, evidence: { type: "string", multiple: true },
    reason: { type: "string", multiple: true }, note: { type: "string" }, write: { type: "boolean" }, loop: { type: "string" },
    to: { type: "string" }, text: { type: "string" }, edit: { type: "string" }, status: { type: "string" }, "no-typing": { type: "boolean" }, ping: { type: "string" },
    option: { type: "string", multiple: true }, session: { type: "string" }, tmux: { type: "string" }, open: { type: "boolean" },
    from: { type: "string" }, first: { type: "string" }, "open-card": { type: "boolean" },
    "done-weak-ok": { type: "boolean" }, tag: { type: "string", multiple: true }, lane: { type: "string" }, metric: { type: "string" }, hypothesis: { type: "string" }, date: { type: "string" }, post: { type: "boolean" },
    pull: { type: "boolean" }, push: { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean" }, "use-gpu": { type: "boolean" }, ui: { type: "boolean" },
    hypotheses: { type: "string", multiple: true }, test: { type: "string", multiple: true }, "no-hypotheses": { type: "string" }, improved: { type: "boolean" }, template: { type: "boolean" },
    goal: { type: "string" }, "challenge-before": { type: "string", multiple: true }, plan: { type: "string" }, kind: { type: "string" }, result: { type: "string" },
    direction: { type: "string" }, next: { type: "string" }, gpu: { type: "string", multiple: true }, "gpu-all": { type: "boolean" }, mode: { type: "string" }, minutes: { type: "string" },
    summary: { type: "string" }, file: { type: "string", multiple: true }, all: { type: "boolean" }, check: { type: "boolean" }, send: { type: "boolean" },
    "keep-old": { type: "boolean" }, "wait-idle": { type: "string" }, "request-at": { type: "string" }, "request-pane": { type: "string" }, "no-monitors": { type: "boolean" }, state: { type: "string" }, "text-file": { type: "string" },
    force: { type: "boolean" }, thinking: { type: "string" }, "approved-by": { type: "string" }, window: { type: "string" }, reread: { type: "boolean" },
    answer: { type: "string" }, repo: { type: "string", multiple: true }, since: { type: "string" }, until: { type: "string" }, backtest: { type: "boolean" },
    static: { type: "boolean" }, dir: { type: "string", multiple: true }, "no-thread": { type: "string" }, "why-new": { type: "string" },
    remote: { type: "string" }, url: { type: "string" }, by: { type: "string" }, "history-ok": { type: "string", multiple: true }, clock: { type: "string" },
    rule: { type: "string" }, outcome: { type: "string" }, lesson: { type: "string", multiple: true },
    job: { type: "string" }, in: { type: "string", multiple: true }, out: { type: "string" }, rl: { type: "boolean" }, mem: { type: "string" }, want: { type: "string" }, sync: { type: "string", multiple: true }, env: { type: "string", multiple: true }, caller: { type: "string" },
    reply: { type: "string" }, again: { type: "boolean" }, channel: { type: "string" }, "reply-to": { type: "string" }, posted: { type: "string" }, "post-summary": { type: "boolean" }, "rollover-outcome": { type: "string" }, "rollover-unresolved": { type: "boolean" }, stuck: { type: "boolean" },
    step: { type: "string" }, "remote-effect": { type: "string", multiple: true },
    "wall-minutes": { type: "string" }, "token-limit": { type: "string" }, "cost-limit": { type: "string" }, "activity-path": { type: "string", multiple: true },
    "delete-branch": { type: "boolean" }, "no-test": { type: "string" }, "install-task": { type: "boolean" }, only: { type: "string", multiple: true }, log: { type: "string" }, priority: { type: "string" }, ask: { type: "string" }, "read-only": { type: "boolean" }, "owner-link": { type: "string" }, hash: { type: "string" }, question: { type: "string" },
    source: { type: "string" },
  },
});
const opt = (name: string): string | undefined => {
  const v = flags.values[name];
  return typeof v === "string" ? v.trim() : undefined;
};
const need = (name: string): string => opt(name) || die(`--${name} is required`);
// Every text dori posts for a person: a literal \n with no real line break is refused (messenger/literal-newline.ts).
const postable = (text: string, what: string): string => {
  const problem = literalNewlineProblem(text);
  return problem ? die(`SEND_LITERAL_NEWLINE ${what}: ${problem}`, 2) : text;
};
// --text-file FILE (read as it is, trimmed) or the inline text
const textOrFile = async (inline: string | undefined, usage: string): Promise<string> => {
  const file = opt("text-file");
  if (file && inline) die(`${usage}: give --text-file or the text, not both`);
  return file ? (await Bun.file(file).text()).trim() || die(`${usage}: ${file} is empty`) : inline || die(usage);
};
// a bare --thread (no value) is a thread ref that came out empty, not a lane without a thread
const threadOpt = (): string | undefined => (flags.values.thread === true ? "" : opt("thread"));
// a bare --no-thread is a reason that came out empty, refused like --no-thread ""
const noThreadOpt = (): string | undefined => (flags.values["no-thread"] === true ? "" : opt("no-thread"));
const whyNewOpt = (): string | undefined => (flags.values["why-new"] === true ? "" : opt("why-new"));
const key = flags.positionals[0];
// One option table serves every command (strict: false), so a command that posts checks its own: an option it does not
// take, or a stray word, is refused before anything is sent instead of dropped (2026-10-20: --reply was dropped and the
// lead's post went out as no reply).
const onlyOptions = (what: string, allowed: readonly string[], positionals: number): void => {
  const extra = Object.keys(flags.values).filter((k) => !allowed.includes(k));
  if (extra.length) die(`UNKNOWN_OPTION ${what}: ${extra.map((k) => `--${k}`).join(", ")} is not an option of ${what}; nothing was sent`, 2);
  if (flags.positionals.length > positionals) die(`UNKNOWN_OPTION ${what}: unexpected ${JSON.stringify(flags.positionals.slice(positionals).join(" "))}; nothing was sent`, 2);
};
const tags = (): string[] => ((flags.values.tag as string[] | undefined) ?? []).map((t) => t.trim()).filter(Boolean);
const many = (name: string): string[] => ((flags.values[name] as string[] | undefined) ?? []).map((t) => t.trim()).filter(Boolean);
// every --evidence, trimmed, an empty one kept (close pairs them with --lesson by place); the other commands take the
// last one, as they did when --evidence was a single option
const evidences = (): string[] => ((flags.values.evidence as string[] | undefined) ?? []).map((t) => t.trim());
const evidence = (): string => evidences().at(-1) || die("--evidence is required");

// `dori <command> --help`: that command's lines of USAGE
const helpFor = (cmd: string): string => {
  const lines = USAGE.split("\n");
  const at = lines.findIndex((l) => new RegExp(`^  ${cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(l));
  if (!cmd || at < 0) return USAGE;
  const out = [lines[at] ?? ""];
  for (const l of lines.slice(at + 1)) {
    if (/^  \S/.test(l)) break;
    out.push(l);
  }
  return `dori ${out.join("\n").trim()}`;
};
if (flags.values.help) {
  console.log(helpFor(command));
  process.exit(0);
}
// --wall-minutes N|none, --token-limit N|none, --cost-limit N|none: a number >= 0 is a cap, none turns it off, an absent
// flag leaves the cap below it; a bad value is refused, so a typo cannot turn a cap off
const budgetOpts = (): BudgetLimits => {
  const out: Record<string, number | null> = {};
  for (const [flag, name] of [["wall-minutes", "wallMinutes"], ["token-limit", "tokens"], ["cost-limit", "costUsd"]] as const) {
    const v = flags.values[flag];
    if (v === undefined) continue;
    const text = typeof v === "string" ? v.trim() : "";
    if (text === "none") out[name] = null;
    else if (text !== "" && Number.isFinite(Number(text)) && Number(text) >= 0) out[name] = Number(text);
    else die(`--${flag} takes a number >= 0 or none, not ${JSON.stringify(v)}`, 2);
  }
  return out;
};
const loopMin = Number(opt("loop") ?? 0);
const heavyDeps = (load: () => Promise<number>): SlotDeps => ({
  dir: `${config.stateDir}/heavy`,
  slots: config.heavySlots,
  maxLoad: config.heavyMaxLoad,
  clock: realClock,
  load,
  alive: pidAlive,
  pid: process.pid,
  headroom: { maxSlots: config.heavyMaxSlots, free: config.heavyHeadroomPct, settleSec: config.heavySettleSec, usage: (pids) => sampleUsage(run, pids), gpuFreeKb: config.heavyGpuFreeGb * 1024 ** 2 },
  log: (line) => {
    console.error(line);
    // a refusal comes before any slot work made the folder
    mkdirSync(`${config.stateDir}/heavy`, { recursive: true });
    appendFileSync(`${config.stateDir}/heavy/heavy.log`, `${new Date().toISOString()} ${line}\n`);
  },
});

const realpathOr = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
// the owner's after-the-fact line of a rollover the lead decided: in the given Discord thread, else DORI_DISCORD_CHANNEL
const reportOwner = discordToken && process.env.DORI_DISCORD_CHANNEL?.trim()
  ? { reportOwner: async (thread: string | null, text: string): Promise<string> => discordClient().send(thread ?? env("DORI_DISCORD_CHANNEL"), text) }
  : {};
const sessionOfPane = async (pane: string, cwd: string): Promise<string> => (await resolveSession(pane, cwd, await procTable(run), { run, sessionsDir: config.sessionsDir, backend: config.backend })).id;
// a shell's foreground job is stopped with its shell and resumed before it, so the tty stays with it (job-control.ts)
const sendSignal: HandoverDeps["signal"] = jobSignal((pid, sig) => {
  if (process.platform === "win32" && (sig === "SIGSTOP" || sig === "SIGCONT")) return winSignal(pid, sig);
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
});
const freezeDeps = { run, procs: () => procTable(run), signal: sendSignal };
const laneDepsFor = (print: (line: string) => void = (line) => console.log(line)): LaneHandoverDeps => ({
  ...deps,
  cardDir: cardDir(),
  home: accountHome(),
  sessionOf: sessionOfPane,
  procs: () => procTable(run),
  envOf: (pid) => {
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").join("\n");
    } catch {
      return "";
    }
  },
  alive: pidAlive,
  signal: sendSignal,
  realpath: realpathOr,
  nonce: () => crypto.randomUUID().slice(0, 8),
  print,
  inbox: config.handover.inbox || process.env.DORI_DISCORD_INBOX?.trim() || join(config.stateDir, "discord", "inbox.jsonl"),
  ownerIds: [process.env.DORI_DISCORD_OWNER, process.env.DORI_KAKAO_OWNER_ID].map((id) => id?.trim() ?? "").filter(Boolean),
  ...reportOwner,
});
const leadDepsFor = (print: (line: string) => void): HandoverDeps => ({
  ...deps,
  configPath: configPath(),
  envPath: envFilePath(),
  cardDir: cardDir(),
  inbox: config.handover.inbox || process.env.DORI_DISCORD_INBOX?.trim() || join(config.stateDir, "discord", "inbox.jsonl"),
  home: accountHome(),
  sessionOf: sessionOfPane,
  routedPane: async () => (await loadConfig()).leadPane,
  envLeadPane: process.env.DORI_LEAD_PANE?.trim() ?? "",
  alive: pidAlive,
  procs: () => procTable(run),
  signal: sendSignal,
  realpath: realpathOr,
  timers: async () => {
    const pattern = new RegExp(config.handover.timers);
    return (await run(["systemctl", "--user", "list-timers", "--all", "--no-legend", "--no-pager"])).out.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l && pattern.test(l));
  },
  restart: (unit) => restartService({ systemctl: run, clock: realClock, timeoutSec: config.update.readyTimeoutSec }, config.update.services.find((s) => s.unit === unit) ?? { unit, paths: [], log: "", ready: "" }),
  nonce: () => crypto.randomUUID().slice(0, 8),
  print,
  ownerIds: [process.env.DORI_DISCORD_OWNER, process.env.DORI_KAKAO_OWNER_ID].map((id) => id?.trim() ?? "").filter(Boolean),
  ...reportOwner,
});
// dori commands that talk to the owner refuse from a session that a running handover is replacing (no double replies)
const quietGuard = async (): Promise<void> => {
  const here = await currentTmuxSession(run);
  const why = quietReason(config.stateDir, here, Date.now());
  if (why) die(why, 4);
};
const passEnv = (): string[] => ["PATH", "HOME", "DORI_CONFIG", "DORI_STATE_DIR", "DORI_ENV_FILE", "DORI_DISCORD_INBOX", "DORI_DISCORD_STATE_DIR"].filter((n) => process.env[n] !== undefined).map((n) => `--setenv=${n}`);

const lane = async (k: string | undefined) => {
  const here = await currentTmuxSession(run);
  const found = k ? await deps.registry.read(k) : await deps.registry.byPane(here);
  if (!found) return die(k ? `no registered lane "${k}"` : "no open lane is registered for this pane");
  if (statusOf(found) === "closed") return die(`lane ${found.key} is already closed`);
  return found;
};

// A post this session made in an open lane's own work thread is recorded on that lane, so its close does not post the same
// result a second time (done-flow.ts recordThreadPost). Not recording it only means the close posts its summary as before.
const notePost = async (thread: string, id: string, text: string): Promise<void> => {
  const here = await currentTmuxSession(run).catch(() => "");
  await recordThreadPost(deps.registry, here, thread, id, text, new Date().toISOString()).catch((e: unknown) => console.error(`THREAD_POST_NOT_RECORDED discord:${thread} ${id}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`));
};
const withFileNames = (text: string, files: readonly DiscordFile[]): string => [text, ...files.map((f) => `[file] ${f.filename}`)].filter(Boolean).join("\n");
// --posted: a message id or its Discord link
const postedId = (): string | undefined => {
  const raw = opt("posted")?.trim();
  if (raw === undefined) return undefined;
  return /(?:^|\/)(\d{5,25})\/?$/.exec(raw)?.[1] ?? die(`--posted takes the id or link of the message that holds the result, not ${JSON.stringify(raw)}`);
};

const env = (name: string): string => process.env[name]?.trim() || die(`${name} is not set`);
const idList = (value: string | undefined): string[] => (value ?? "").split(/[\s,]+/).filter(Boolean);
const watchMatch = (value: string | undefined): { watchMatch?: RegExp } => {
  const source = value?.trim();
  if (!source) return {};
  try {
    return { watchMatch: new RegExp(source) };
  } catch {
    return die(`DORI_DISCORD_WATCH_MATCH is not a valid regular expression: ${source}`);
  }
};
// Discord writes go out only as this Dori's own bot: the token's bot must be discord.botId when that is set, and is never
// any pair Dori's bot (DORI_DISCORD_PAIR_BOT). An inherited token of another Dori fails here instead of posting as it.
const discordBotProblem = (token: string): string | undefined => {
  const bot = tokenBotId(token);
  const pairBots = idList(process.env.DORI_DISCORD_PAIR_BOT);
  const where = `config ${configPath()}, env file ${envFilePath()}`;
  if (config.discord.botId && bot !== config.discord.botId)
    return `DISCORD_BOT_MISMATCH DORI_DISCORD_TOKEN is bot ${bot ?? "unknown"}, but this Dori is bot ${config.discord.botId} (discord.botId; ${where}). Nothing was sent. An inherited token of another Dori? Unset the DORI_DISCORD_* variables or fix the token.`;
  if (bot && pairBots.includes(bot)) return `DISCORD_BOT_MISMATCH DORI_DISCORD_TOKEN is the pair Dori's bot ${bot} (DORI_DISCORD_PAIR_BOT; ${where}). Nothing was sent.`;
  return undefined;
};
const checkedDiscordToken = (token: string): string => {
  const why = discordBotProblem(token);
  return why ? die(why, 2) : token;
};
// DORI_DISCORD_API: the REST base for a Dori whose only way out is an egress gate (setups/egress-gate); unset = Discord
const discordApi = (): string => process.env.DORI_DISCORD_API?.trim() || "https://discord.com/api/v10";
// the gateway socket follows HTTPS_PROXY when one is set, like fetch does
const gatewaySocket = (): WebSocket => {
  const proxy = process.env.HTTPS_PROXY?.trim() || process.env.https_proxy?.trim();
  return new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json", proxy ? { proxy } : undefined);
};
const ownDiscord = (token: string): Discord => {
  const why = discordBotProblem(token);
  if (why) throw new Error(why);
  return new Discord(fetchHttp, realClock, token, discordApi());
};
const discordClient = () => new Discord(fetchHttp, realClock, checkedDiscordToken(env("DORI_DISCORD_TOKEN")), discordApi());
// A Discord place that is the owner's: DORI_DISCORD_CHANNEL, a thread in it, or a DM (a bot's DM is with the owner). The pair
// channel is the Doris' own. A place that cannot be looked up counts as his.
const ownerPlace = async (dc: Discord, id: string): Promise<boolean> => {
  const channel = process.env.DORI_DISCORD_CHANNEL?.trim() ?? "";
  if (id === (process.env.DORI_DISCORD_PAIR_CHANNEL?.trim() || undefined)) return false;
  if (id === channel) return true;
  const c = await dc.call<{ type?: number; parent_id?: string | null }>("GET", `/channels/${id}`).catch(() => undefined);
  return !c || c.type === 1 || (channel !== "" && c.parent_id === channel);
};
// What dori send, thread and ask post for the owner is in the speech this Dori uses with him (close-summary.ts
// ownerSpeechProblem), refused before anything is sent; the place is looked up only for a text that fails.
const ownerSpeech = async (text: string, what: string, toOwner: () => Promise<boolean>): Promise<void> => {
  const problem = ownerSpeechProblem(text, config.discord.locale, config.discord.ownerSpeech);
  if (problem && (await toOwner())) die(`SPEECH_REFUSED ${what}: ${problem}; nothing was sent`, 2);
};
// question cards and their answers; DORI_DISCORD_STATE_DIR keeps them where an existing install already has them
const cardDir = (): string => process.env.DORI_DISCORD_STATE_DIR?.trim() || join(config.stateDir, "discord");
// The ledger an owner message and a lead's thread are read against: both layers, a bad local line left out (as the audit
// reads it). No ledger configured is not "no directives": it throws, like a ledger that cannot be read.
const hintLedger = (opts: { readonly strict?: boolean } = {}): Ledger => {
  if (!config.directives.common && !config.directives.local) throw new DirectiveError("no directive ledger is configured (config directives.common and directives.local are empty)");
  return checkedLedger(config, { tolerant: !opts.strict });
};

// The omo memory repo of this Dori's lead that dori directive-audit reads for DIRECTIVE_DUPLICATE: directives.memory, else
// the repo omo keeps for its cwd (handover.cwd, else defaultCwd) under this account's home.
const leadMemoryRepo = (): string => config.directives.memory || memoryRepoFor(config.handover.cwd || config.defaultCwd, homedir());
// the owner's message a thread starts from, as the inbox has it (text or voice transcript); empty when it is not there
const inboxText = (id: string): string => {
  const file = process.env.DORI_DISCORD_INBOX?.trim() || join(config.stateDir, "discord", "inbox.jsonl");
  if (!existsSync(file)) return "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes(id)) continue;
    try {
      const row = JSON.parse(line) as { id?: string; content?: string; transcript?: string | null };
      if (row.id === id) return row.transcript || row.content || "";
    } catch {
      // a torn line is not the message
    }
  }
  return "";
};
// the inbox dori directive-audit reads the owner's messages from and leaves its notices for the lead in
const auditInbox = (): string => config.handover.inbox || process.env.DORI_DISCORD_INBOX?.trim() || join(config.stateDir, "discord", "inbox.jsonl");
// why a Discord message link is not the owner's word (his account or his registered webhook), or undefined when it is
const ownerLinkProblem = async (url: string, maxAgeMs?: number): Promise<string | undefined> => {
  const m = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/\d+\/(\d+)\/(\d+)$/.exec(url.trim());
  if (!m) return `${url} is not a Discord message link`;
  if (!discordToken) return "DORI_DISCORD_TOKEN is not set, so the link cannot be read";
  const msg = await ownDiscord(discordToken).call<{ author?: { id?: string }; webhook_id?: string; timestamp?: string }>("GET", `/channels/${m[1]}/messages/${m[2]}`).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  if (typeof msg === "string") return `the message could not be read (${msg.slice(0, 120)})`;
  const owner = process.env.DORI_DISCORD_OWNER?.trim() ?? "";
  const hook = process.env.DORI_DISCORD_OWNER_WEBHOOK?.trim() ?? "";
  if (!(owner && msg.author?.id === owner) && !(hook && msg.webhook_id === hook)) return "the message is not the owner's";
  if (maxAgeMs !== undefined && Date.now() - Date.parse(msg.timestamp ?? "") > maxAgeMs) return `the owner's message is older than ${Math.round(maxAgeMs / 3_600_000)} hours`;
  return undefined;
};
// dori backlog: a pass starts an item through the same launch as dori launch and tells the lead in its inbox
const backlogInbox = (kind: string, id: string, content: string): void => {
  const inbox = auditInbox();
  mkdirSync(join(inbox, ".."), { recursive: true });
  appendFileSync(inbox, `${JSON.stringify({ ts: new Date().toISOString(), id, kind, content })}\n`);
};
const backlogDeps = (): TickDeps => ({
  stateDir: config.stateDir,
  settings: config.backlog,
  now: realClock.now,
  lanes: () => deps.registry.list(),
  busy: async () => {
    const host = await sampleHost(run, config.backend);
    return [...canLaunch(host, config.guard).reasons, ...(host.load1 > config.guard.loadOk ? [`load ${host.load1.toFixed(1)} > ${config.guard.loadOk}`] : [])];
  },
  launch: async (item, brief, key) => {
    const leadBrief = readFileSync(brief, "utf8");
    const input = { key, backlog: true, title: item.title, brief, done: item.done, thread: item.thread, noThread: item.noThread, whyNew: item.whyNew, cwd: item.cwd, tags: [...(item.tags ?? []), "backlog"], goal: item.goal };
    const r = await launchLane(deps, input, (line) => console.log(line)).catch((e: unknown) => {
      throw asStartFailure(e);
    });
    if (r.lane.thread.startsWith("discord:") && discordToken) {
      console.log(await Promise.resolve().then(() => postLaneStart(ownDiscord(discordToken), r.lane.thread, laneStartText(config.discord.laneStartText, r.lane, leadBrief))).catch((e: unknown) => `THREAD_START_FAILED ${r.lane.thread}: ${e instanceof Error ? e.message : String(e)}`));
    }
    return { pane: r.lane.pane ?? "?", startup: r.startup };
  },
  limited: () => {
    const provider = config.defaultModel.split("/")[0];
    return poolFree(config.sessionsDir, provider, Date.now()) ? undefined : `usage limit: no ${provider} account is free in omo's credential pool`;
  },
  host: { dir: config.backlog.hostDir, user: userInfo().username, instance: instanceOf(config.stateDir), max: config.backlog.hostMaxLanes },
  intake: async (sweep) => {
    // the #dori-pair posts and the owner's orders every tick, from where the last pass stopped reading the inbox (kept once
    // both took them)
    const inbox = inboxReader(config.stateDir, auditInbox());
    const orders = [
      ...pairIntake({ stateDir: config.stateDir, settings: config.backlog, rows: inbox.rows, now: realClock.now, pairBots: idList(process.env.DORI_DISCORD_PAIR_BOT), guild: process.env.DORI_DISCORD_GUILD?.trim() ?? "" }),
      ...orderIntake({ stateDir: config.stateDir, settings: config.backlog, rows: inbox.rows, now: realClock.now }),
    ];
    inbox.commit();
    if (!sweep || !config.backlog.feedCommand.length) return orders;
    const feed = async (): Promise<{ readonly todos: readonly FeedTodo[] } | { readonly why: string }> => {
      const r = await run(config.backlog.feedCommand.map((p) => p.replace(/^~(?=\/)/, homedir())), { timeoutMs: 120_000 });
      if (r.code !== 0) return { why: (r.err || r.out).trim().split("\n")[0]?.slice(0, 200) || `exit ${r.code}` };
      try {
        const v = JSON.parse(r.out) as unknown;
        const list = Array.isArray(v) ? v : (v as { todos?: unknown }).todos;
        return Array.isArray(list) ? { todos: list as FeedTodo[] } : { why: "the output is not a JSON list" };
      } catch {
        return { why: "the output is not JSON" };
      }
    };
    return [...orders, ...(await feedIntake({ stateDir: config.stateDir, settings: config.backlog, feed, now: realClock.now }))];
  },
  inbox: backlogInbox,
});
// every thread status change goes through this queue: coalesced, retried after a 429, decided by the open cards and
// the lanes still working in the thread
// working, or sent back to work by an objection (not-done); a lane that claimed done or is paused waits like the thread
// The lane whose close runs a thread hook (DORI_CLOSING_LANE) is still open in the registry then, but no longer works there.
const workingLanes = async (t: string): Promise<string[]> =>
  (await deps.registry.open()).filter((l) => l.key !== process.env.DORI_CLOSING_LANE && l.thread === `discord:${t}` && (statusOf(l) === "working" || statusOf(l) === "not-done")).map((l) => l.key);
const threadStatuses = (dc: Discord, log: (line: string) => void = (line) => console.error(line)) => {
  const store = new QuestionStore(cardDir());
  return new ThreadStatusQueue({ dc, words: config.discord, file: join(cardDir(), "thread-status.json"), openCards: (t) => openCardIds(store, t), workingLanes, now: realClock.now, log });
};
const questionCards = (dc: Discord, statuses: ThreadStatusQueue = threadStatuses(dc)) => new QuestionCards(dc, new QuestionStore(cardDir()), { channel: env("DORI_DISCORD_CHANNEL"), owner: env("DORI_DISCORD_OWNER"), words: config.discord }, realClock.now, statuses);

const transcribeUrl = async (url: string, filename: string): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "dori-voice-"));
  try {
    const res = await fetch(url);
    if (!res.ok) throw new TranscriptionError(`voice download failed: ${res.status}`);
    const file = join(dir, filename.replace(/[^\w.-]/g, "_") || "voice");
    await Bun.write(file, await res.arrayBuffer());
    return await transcribe(run, config.hooks.transcribe, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// one SIGNALS line per open lane that has a record, for the lead's status view (dori sync, dori signals)
const openSignals = async (): Promise<string[]> => {
  const open = await deps.registry.open();
  return (await areaSignals(open, { tags: [...new Set(open.flatMap((l) => tagsOf(l)))] }, config)).filter(hasSignals).map(oneLine);
};

const every = async (minutes: number, tick: () => Promise<void>): Promise<void> => {
  for (;;) {
    await tick().catch((e: unknown) => console.log(`WARN ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)));
    if (minutes <= 0) return;
    await Bun.sleep(minutes * 60_000);
  }
};

try {
  switch (command) {
    case "notify-change": {
      const files = flags.values.file;
      process.exitCode = await announceChange({ config, clock: realClock, send: (pane, text) => sendVerified(run, realClock, config, pane, text), print: (line) => console.log(line) }, { summary: need("summary"), files: Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : [] }) ? 0 : 1;
      break;
    }
    case "eyes": {
      if (key !== "off") die("usage: dori eyes off <message id | link>", 2);
      onlyOptions("eyes off", [], 2);
      const ref = flags.positionals[1] ?? die("usage: dori eyes off <message id | link>", 2);
      const inbox = process.env.DORI_DISCORD_INBOX?.trim() || join(config.stateDir, "discord", "inbox.jsonl");
      console.log(await eyesOff(discordClient(), join(dirname(inbox), "eyes.json"), ref, process.env.DORI_DISCORD_PAIR_CHANNEL?.trim() ?? "").catch((e: unknown) => die(`EYES_OFF_FAIL ${ref} ${e instanceof Error ? e.message : String(e)}`)));
      break;
    }
    case "type": {
      const pane = key ?? die("type needs a pane (a tmux session name or a herdr pane id)");
      const file = opt("text-file");
      const text = file ? (await Bun.file(file).text()).trim() : need("text");
      if (!text) die("type needs non-empty text");
      const r = await typeIntoPane(deps, pane, text);
      for (const note of r.notes) console.error(note);
      if (r.pane !== pane) console.error(`FORWARDED ${pane} -> ${r.pane}: ${pane} was frozen by a handover, so the text went to the session that replaced it`);
      console.log(r.status === "SUBMITTED" ? `SUBMITTED ${r.pane}` : `NOT_SUBMITTED ${r.pane} ${r.reason}`);
      // a pane a handover is moving: the text is kept for the new session too (lane-handover hands it over at the commit)
      if (holdTyped(config.stateDir, pane, Date.now(), text)) console.error(`HANDOVER_HELD ${pane}: a handover is moving this session; the text is also kept for the new session and handed to it when the move commits`);
      process.exitCode = r.status === "SUBMITTED" ? 0 : 1;
      break;
    }
    case "update":
      process.exitCode = await applyUpdate({ config, configPath: configPath(), git: run, systemctl: run, clock: realClock, send: (pane, text) => sendVerified(run, realClock, config, pane, text), print: (line) => console.log(line) }, { pull: Boolean(flags.values.pull), dryRun: Boolean(flags.values["dry-run"]) }) ? 0 : 1;
      break;
    case "launch": {
      const input = { key: key ?? "", title: need("title"), brief: need("brief"), done: need("done"), thread: threadOpt(), noThread: noThreadOpt(), whyNew: whyNewOpt(), model: opt("model"), cwd: opt("cwd"), tags: tags(), doneWeakOk: Boolean(flags.values["done-weak-ok"]), goal: opt("goal"), challengeBefore: many("challenge-before"), useGpu: Boolean(flags.values["use-gpu"]), ui: Boolean(flags.values.ui), waive, budget: budgetOpts(), activityPaths: many("activity-path") };
      const noGoal = goalWarning(input);
      if (noGoal) console.log(noGoal);
      // LAUNCH_NO_THREAD / LAUNCH_THREAD_IS_CHANNEL / LAUNCH_RELATED_THREAD: nothing opened, exit 4 like a missing directive
      const threadMissing = (e: unknown): never => {
        if (e instanceof ThreadMissingError) die(e.message, 4);
        throw e;
      };
      if (flags.values["dry-run"]) {
        await validateLaunch(deps, input);
        try {
          threadGate(deps, input);
          for (const line of await relatedGate(deps, input)) console.log(line);
        } catch (e) {
          threadMissing(e);
        }
        const weak = await doneWeakWarning(input, input.cwd ?? config.defaultCwd);
        if (weak) console.log(weak);
        const rendered = await renderBrief(deps, input);
        for (const line of [...rendered.lines, ...(rendered.steps ? [rendered.steps] : []), ...rendered.missing]) console.log(line);
        console.log(rendered.text);
        console.log(`DRY_RUN ${input.key}: brief not written, no pane opened, nothing registered${rendered.missing.length ? "; a real launch stops here (LAUNCH_DIRECTIVE_MISSING)" : ""}`);
        if (rendered.missing.length) process.exit(4);
        break;
      }
      const leadBrief = await Bun.file(input.brief).text().catch(() => "");
      const r = await launchLane(deps, input, (line) => console.log(line)).catch((e: unknown) => {
        // the LAUNCH_DIRECTIVE_MISSING lines are printed and logged already
        if (e instanceof DirectiveMissingError) process.exit(4);
        return threadMissing(e);
      });
      console.log(`LAUNCHED ${r.lane.key} pane=${r.lane.pane} tab=${r.lane.tab ?? "?"}`);
      for (const w of r.lane.directives?.waived ?? []) {
        const name = launchLedger(deps).entries.find((e) => e.id === w.id)?.name ?? w.id;
        const text = fill([config.discord.waiveText], { key: r.lane.key, id: w.id, name, reason: w.reason })[0] ?? "";
        const line = !discordToken
          ? `DIRECTIVE_WAIVE_NOT_SENT ${r.lane.key} ${w.id}: DORI_DISCORD_TOKEN is not set, so the owner was not told`
          : await Promise.resolve()
              .then((): Promise<unknown> => (r.lane.thread.startsWith("discord:") ? postInThread(ownDiscord(discordToken), r.lane.thread, text) : discordClient().send(env("DORI_DISCORD_CHANNEL"), text)))
              .then(() => `DIRECTIVE_WAIVE_SENT ${r.lane.key} ${w.id}: the owner was told`)
              .catch((e: unknown) => `DIRECTIVE_WAIVE_NOT_SENT ${r.lane.key} ${w.id}: ${e instanceof Error ? e.message : String(e)}`);
        console.log(line);
        watchLog(config.watchLog, realClock, { source: "launch", line });
      }
      if (r.lane.thread.startsWith("discord:")) {
        if (!discordToken) console.log(`THREAD_START_NO_TOKEN ${r.lane.thread}: DORI_DISCORD_TOKEN is not set, so no first message was posted`);
        else {
          const started = await Promise.resolve().then(() => postLaneStart(ownDiscord(discordToken), r.lane.thread, laneStartText(config.discord.laneStartText, r.lane, leadBrief))).catch((e: unknown) => `THREAD_START_FAILED ${r.lane.thread}: ${e instanceof Error ? e.message : String(e)}`);
          console.log(started);
        }
      }
      console.log(r.startup);
      process.exit(/^STARTUP_(OK|PENDING_GOAL) /.test(r.startup) ? 0 : 3);
    }
    case "adopt": {
      const l = await adoptLane(deps, { key: key ?? "", title: need("title"), brief: need("brief"), done: need("done"), thread: threadOpt(), pane: need("pane"), tags: tags(), goal: opt("goal"), challengeBefore: many("challenge-before"), useGpu: Boolean(flags.values["use-gpu"]) });
      console.log(`ADOPTED ${l.key} pane=${l.pane} thread=${l.thread}`);
      const reopened = await reopenLaneThread(deps, l);
      if (reopened) console.log(reopened);
      if (config.backend === "aoe" && Object.keys(config.launchEnv).length) console.log(`ADOPT_ENV ${l.key}: the running session keeps the environment it started with; ${l.useGpu ? "no launchEnv" : "launchEnv"} applies from its next handover or restart`);
      break;
    }
    case "sync": {
      const r = await syncRegistry(deps, Boolean(flags.values.write));
      console.log("key | thread | pane | session | status");
      for (const row of [...r.rows, ...r.unregistered]) console.log([row.key, row.thread, row.pane, row.session, row.status].join(" | "));
      for (const s of await openSignals()) console.log(s);
      console.log(r.drift.length ? `DRIFT (${r.drift.length}):\n${r.drift.map((d) => `- ${d}`).join("\n")}` : "DRIFT none");
      console.log(flags.values.write ? "WROTE session ids" : "READ_ONLY");
      break;
    }
    case "set-thread": {
      const ref = flags.positionals[1]?.trim() ?? die("usage: dori set-thread <key> <adapter>:<id>");
      console.log(await setThread(deps, await lane(key ?? die("set-thread needs a lane key")), ref));
      break;
    }
    case "done-set": {
      const l = await lane(key ?? die("done-set needs a lane key"));
      for (const line of await setDone(deps, l, need("done"), many("reason").join("; "))) console.log(line);
      break;
    }
    case "set-gpu": {
      const on = flags.positionals[1]?.trim();
      if (on !== "on" && on !== "off") die("usage: dori set-gpu <key> on|off");
      console.log(await setGpu(deps, await lane(key ?? die("set-gpu needs a lane key")), on === "on"));
      break;
    }
    case "launch-env": {
      for (const arg of await launchEnvArgs(deps, key ?? die("usage: dori launch-env <tmux-session>"))) console.log(arg);
      break;
    }
    case "claim-done": {
      const l = await lane(key);
      const missing = challengeMissing(l);
      if (missing) die(missing, 5);
      const ungated = await gateMissing(deps, l.done);
      if (ungated.length) die(ungated.join("\n"), 5);
      const summary = opt("summary");
      if (summary !== undefined) postable(summary, `claim-done --summary ${l.key}`);
      const bad = summary === undefined ? undefined : plainSummaryProblem(summary, config.discord.locale, config.discord.ownerSpeech);
      if (bad) die(`SUMMARY_REFUSED ${l.key}: ${bad}; write it for the owner in plain words`, 2);
      const outcome = opt("rollover-outcome");
      if (flags.values["rollover-unresolved"] && outcome === undefined) die("--rollover-unresolved goes with --rollover-outcome \"<one line>\"", 2);
      const claimed = await claimDone(deps, l, evidence(), summary, { posted: postedId(), postSummary: Boolean(flags.values["post-summary"]), ...(outcome !== undefined ? { rolloverOutcome: { line: outcome, resolved: !flags.values["rollover-unresolved"] } } : {}) });
      if (claimed.startsWith("ROLLOVER_OUTCOME_MISSING ")) die(claimed, 2);
      console.log(claimed);
      break;
    }
    case "object-done": {
      const reasons = (flags.values.reason as string[] | undefined)?.map((r) => r.trim()).filter(Boolean) ?? [];
      if (!reasons.length) die("--reason is required");
      console.log(await objectDone(deps, await lane(key ?? die("object-done needs a lane key")), reasons));
      break;
    }
    case "pause": {
      const reason = flags.positionals.slice(1).join(" ").trim() || die("usage: dori pause <key> <reason>");
      try {
        for (const line of await pauseLane(deps, await lane(key ?? die("pause needs a lane key")), reason)) console.log(line);
      } catch (e) {
        if (!(e instanceof GoalUnverifiedError)) throw e;
        console.log(e.message);
        process.exit(3);
      }
      break;
    }
    case "fix-attempt": {
      const l = await lane(key ?? die("fix-attempt needs a lane key"));
      const metric = normFix(need("metric"));
      // the name the stuck count uses (autoSignals.aliases), so PRIOR_FIX and the gate lines name what STUCK counts
      const shown = canonical(metric, config.autoSignals.aliases);
      const area: AreaQuery = { lane: l.key, ...(l.cwd && l.cwd !== config.defaultCwd ? { cwd: l.cwd } : {}), tags: tagsOf(l) };
      for (const line of priorFixLines(await areaSignals(await deps.registry.list(), area, config), l.key, metric, config.autoSignals.aliases)) console.log(line);
      const attempt = { at: new Date().toISOString(), metric, hypothesis: normFix(need("hypothesis")), via: "lead" as const, ...(flags.values.improved ? { improved: true } : {}) };
      const branch = { hypotheses: many("hypotheses"), tests: many("test"), override: opt("no-hypotheses") };
      const gate = gateFix(l, attempt, branch, config);
      if (gate.verdict === "required") {
        const msg = requiredMessage(l.key, shown, gate, config.explore);
        recordRefusal(deps, msg);
        die(msg, 5);
      }
      if (gate.verdict === "override") console.log(recordOverride(deps, l.key, shown, gate, branch.override ?? ""));
      if (gate.verdict === "branch") console.log(await recordBranch(deps, l, shown, branch, gate));
      const r = await recordFix(deps, l.key, attempt);
      const v = stuckView((await deps.registry.read(l.key)) ?? l, metric, config);
      console.log(`FIX_RECORDED ${l.key} attempt=${r.count} on-metric=${gate.attempt} stuck=${v.n} (tagged ${v.tagged}, inferred ${v.inferred})`);
      for (const n of r.notes) console.log(n);
      break;
    }
    case "tree": {
      const verb = key ?? "show";
      const anyLane = async (k: string) => (await deps.registry.read(k)) ?? die(`no registered lane "${k}"`);
      const here = await currentTmuxSession(run).catch(() => "");
      const paneLane = here ? await deps.registry.byPane(here) : null;
      const laneKey = opt("lane");
      const area: TreeArea = laneKey ? laneArea(await anyLane(laneKey), config) : opt("cwd") ? { cwd: resolve(opt("cwd") ?? "") } : tags()[0] ? { tag: tags()[0] } : paneLane ? laneArea(paneLane, config) : { cwd: resolve(process.cwd()) };
      const at = new Date().toISOString();
      const id = flags.positionals[1] ?? "";
      if (verb === "show") console.log(formatTree(await loadTree(config.stateDir, area)));
      else if (verb === "add") {
        const kind = (opt("kind") ?? "hypothesis") as NodeKind;
        if (!NODE_KINDS.includes(kind)) die(`--kind is one of ${NODE_KINDS.join(", ")}`);
        let added: { id: string; isNew: boolean } = { id: "", isNew: false };
        await updateTree(config.stateDir, area, (t) => {
          const r = addNode(t, { kind, text: need("text"), test: opt("test"), metric: opt("metric") ? normFix(opt("metric") ?? "") : undefined, lane: laneKey ?? paneLane?.key, source: "dori tree add", result: opt("result") }, at);
          added = { id: r.node.id, isNew: r.added };
          return r.tree;
        });
        console.log(`TREE_${added.isNew ? "ADDED" : "EXISTS"} ${added.id} in ${area.cwd ? `cwd ${area.cwd}` : `tag ${area.tag}`}`);
      } else if (verb === "falsify" || verb === "support" || verb === "close" || verb === "reopen") {
        if (!id) die(`usage: dori tree ${verb} <ID> [--result TEXT]`);
        const status = verb === "falsify" ? "falsified" : verb === "support" ? "supported" : verb === "close" ? "closed" : "open";
        let shown = "";
        await updateTree(config.stateDir, area, (t) => {
          const r = setStatus(t, id, status, opt("result"), at);
          shown = `${r.node.id} ${r.node.status}${r.node.result ? ` -> ${r.node.result}` : ""}`;
          return r.tree;
        });
        console.log(`TREE_SET ${shown}`);
      } else die("usage: dori tree [show|add|falsify|support|close|reopen] [ID] [--lane K | --cwd DIR | --tag T]");
      break;
    }
    case "challenge": {
      if (flags.values.check) {
        const own = key ? ((await lane(key)).model ?? config.defaultModel) : undefined;
        const listed = own ? reviewers(own, config.reviewers.models, config.reviewers.allowSameFamily === true) : [...config.reviewers.models];
        const checks = await checkReviewers(deps, listed);
        for (const c of checks) console.log(c.call ? `REVIEWER_OK ${c.listed}${c.call !== c.listed ? ` -> ${c.call}` : ""} (${familyOf(c.listed)}): ${c.note}` : `REVIEWER_SKIP ${c.listed} (${familyOf(c.listed)}): ${c.note}`);
        if (!checks.some((c) => c.call)) die("no reviewer in reviewers.models can be called on this host");
        break;
      }
      const l = await lane(key ?? die("challenge needs a lane key"));
      const r = await runChallenge(deps, l, resolve(need("plan")), { model: opt("model"), all: Boolean(flags.values.all) });
      for (const f of r.failures) console.log(`CHALLENGE_SKIP ${f}`);
      for (const v of r.reviews) {
        console.log(v.text);
        console.log(`CHALLENGE_SAVED ${v.record.file} reviewer=${v.record.model}`);
      }
      break;
    }
    case "review": {
      const pr = parsePr(key ?? die('usage: dori review <owner/repo#N> [--dir CHECKOUT] [--model M] [--lane K] [--no-test "<reason>"]'));
      const noTest = flags.values["no-test"] === undefined ? undefined : opt("no-test") || die('--no-test needs a reason: --no-test "<why this fix has no test>"');
      const laneKey = opt("lane");
      const here = laneKey ? "" : await currentTmuxSession(run).catch(() => "");
      const owner = laneKey ? await lane(laneKey) : here ? await deps.registry.byPane(here) : null;
      const out = await reviewPr(deps, pr, { dir: resolve(many("dir")[0] ?? process.cwd()), model: opt("model"), lane: owner, ...(noTest ? { noTest } : {}) });
      for (const line of out) console.log(line);
      if (/ verdict=BLOCK /.test(out.at(-1) ?? "")) process.exit(1);
      break;
    }
    case "merge": {
      const pr = parsePr(key ?? die("usage: dori merge <owner/repo#N> [--dry-run] [--delete-branch]"));
      console.log(await mergePr(deps, pr, { dryRun: Boolean(flags.values["dry-run"]), deleteBranch: Boolean(flags.values["delete-branch"]) }));
      break;
    }
    case "fork-explore": {
      const l = await lane(key ?? die("fork-explore needs a lane key"));
      const mode = (opt("mode") ?? "agent") as Mode;
      if (mode !== "agent" && mode !== "cmd") die("--mode is agent or cmd");
      const minutes = Number(opt("minutes") ?? config.explore.branchMinutes);
      if (!(minutes > 0)) die("--minutes must be a positive number");
      const branches = branchesFrom(many("hypotheses"), many("test"), many("gpu").map(Number), Boolean(flags.values["gpu-all"]));
      const load = async () => (await sampleHost(run, config.backend)).load1;
      const takeSlot = async (label: string) => {
        const slot = await acquireSlot(heavyDeps(load), label);
        return () => releaseSlot(slot);
      };
      console.log(`FORK_START ${l.key} ${branches.length} branches on "${need("metric")}" (${branches.filter((b) => b.gpu).length} gpu, queued on the heavy slot), ${minutes} min each, mode ${mode}`);
      const r = await forkExplore(deps, l, { metric: normFix(need("metric")), branches, mode, minutes, model: opt("model") }, takeSlot);
      console.log(r.table);
      console.log(`FORK_SAVED ${r.file}; tree updated (dori tree --lane ${l.key})`);
      break;
    }
    case "research-hint": {
      const l = (await deps.registry.read(key ?? die("research-hint needs a lane key"))) ?? die(`no registered lane "${key}"`);
      const tree = await loadTree(config.stateDir, laneArea(l, config));
      for (const line of researchHint(l, tree)) console.log(line);
      if (flags.values.send) {
        if (!l.pane) die(`lane ${l.key} has no pane to send the ulw research text to`);
        const { metric } = researchFacts(l, tree);
        const delivered = await sendResearch(deps, l, tree, stuckView(l, metric, config).n, metric);
        const line = delivered ? `RESEARCH_SENT ${l.key}: ulw research text typed into pane ${l.pane}; dori research-check ${l.key} (or freshness) confirms the skill started` : `RESEARCH_SEND_FAILED ${l.key}: the text did not reach pane ${l.pane}`;
        watchLog(config.watchLog, realClock, { source: "research", line });
        console.log(line);
        if (!delivered) process.exit(1);
      }
      break;
    }
    case "research-check": {
      const l = (await deps.registry.read(key ?? die("research-check needs a lane key"))) ?? die(`no registered lane "${key}"`);
      const r = await researchCheck(deps, l);
      console.log(r.line);
      if (r.verdict === "not-started") process.exit(6);
      break;
    }
    case "intent-check": {
      let l = await lane(key ?? die("intent-check needs a lane key"));
      if (flags.values.reread) {
        const sent = await sendReread(deps, l);
        console.log(sent.line);
        if (!sent.ok) process.exit(1);
        break;
      }
      const at = new Date().toISOString();
      const patch = {
        ...(opt("goal") ? { goal: opt("goal") } : {}),
        ...(opt("direction") || opt("next") ? { direction: { at, text: opt("direction") ?? l.direction?.text ?? "", ...(opt("next") ? { next: opt("next") } : {}) } } : {}),
      };
      if (Object.keys(patch).length) {
        await deps.registry.patch(l.key, patch);
        l = { ...l, ...patch };
      }
      for (const line of formatIntent(l, intentView(l, await loadTree(config.stateDir, laneArea(l, config))))) console.log(line);
      // the verdict: a reviewer of another family reads the direction just stated
      const r = await runIntentCheck(deps, l);
      if (r.skipped) {
        console.log(r.skipped);
        if (r.skipped.startsWith("INTENT_CHECK_FAILED")) process.exit(1);
        break;
      }
      for (const line of r.lines) console.log(line);
      break;
    }
    case "repeat-check": {
      const l = (await deps.registry.read(key ?? die("repeat-check needs a lane key"))) ?? die(`no registered lane "${key}"`);
      const ago = /^(\d+(?:\.\d+)?)([dh])$/.exec(opt("since") ?? "");
      const since = ago ? new Date(Date.now() - Number(ago[1]) * (ago[2] === "d" ? 86_400_000 : 3_600_000)).toISOString() : (opt("since") ?? sessionStart(l));
      if (Number.isNaN(Date.parse(since))) die(`--since takes an ISO time or Nd / Nh, not ${opt("since")}`);
      const scan = await laneEvents(deps, l, { since, ...(opt("until") ? { until: opt("until") } : {}), repos: many("repo") });
      const cfg = config.autoSignals;
      const after = config.stuck.researchAt;
      console.log(`REPEAT_SCAN ${l.key} since ${since}${opt("until") ? ` until ${opt("until")}` : ""}: ${scan.reports} reports, ${scan.commits} commits, ${scan.tree} tree entries; scope ${cfg.targetScope}, aliases ${Object.keys(cfg.aliases).length}, after ${after} (stuck.researchAt)`);
      const tagged = (metric: string): number => stuckView(l, metric, config).tagged;
      if (flags.values.backtest) {
        // each time a metric's inferred count reached stuck.researchAt or grew past it, report by report
        const fired: { at: string; r: MetricRepeat }[] = [];
        inferRepeats(scan.events, cfg, (r, e) => r.n >= after && fired.push({ at: e.at, r }));
        for (const f of fired) {
          console.log(`${f.at} ${inferredLine(l.key, f.r, tagged(f.r.metric))}`);
          for (const line of evidenceLines(f.r).slice(-4)) console.log(line);
        }
        console.log(`REPEAT_BACKTEST ${l.key} ${fired.length} alerts on ${new Set(fired.map((f) => f.r.metric)).size} metrics`);
        break;
      }
      const state = inferRepeats(scan.events, cfg);
      const hits = suspects(state, after);
      for (const r of hits) {
        console.log(inferredLine(l.key, r, tagged(r.metric)));
        for (const line of evidenceLines(r)) console.log(line);
      }
      if (!hits.length) console.log(`REPEAT_NONE ${l.key} no metric re-targeted ${after}+ times after failing (counts: ${[...state.counts.values()].map((r) => `${r.metric} ${r.n}`).join(", ") || "none"})`);
      break;
    }
    case "resume":
      try {
        for (const line of await resumeLane(deps, await lane(key ?? die("resume needs a lane key")))) console.log(line);
      } catch (e) {
        if (!(e instanceof GoalUnverifiedError)) throw e;
        console.log(e.message);
        process.exit(3);
      }
      break;
    case "close": {
      const summary = opt("summary");
      if (summary !== undefined) postable(summary, `close --summary ${key ?? ""}`);
      const bad = summary === undefined ? undefined : plainSummaryProblem(summary, config.discord.locale, config.discord.ownerSpeech);
      if (bad) die(`SUMMARY_REFUSED ${key ?? ""}: ${bad}; write it for the owner in plain words`, 2);
      const target = await lane(key ?? die("close needs a lane key"));
      // --lesson, any number of times: kept after a successful close, each with the --evidence in its place, one --evidence
      // for all, or the Done line; never blocks the close. Evidence that pairs with no lesson is refused before anything.
      const paired = closeLessons(((flags.values.lesson as string[] | undefined) ?? []).map((t) => t.trim()), evidences(), target.done);
      const lessons = typeof paired === "string" ? die(`LESSON_EVIDENCE_MISMATCH ${target.key}: ${paired}; nothing was closed`, 2) : paired;
      const note = opt("note") ?? "closed by the lead";
      const r = await closeLane(deps, target, note, summary, postedId(), lessons);
      for (const line of r.lines) console.log(line);
      // a lane moved for being stuck that closes without its outcome line: the lead's note stands in, counted unknown (the
      // owner may have dropped or changed the work), so rollover-stats still lists it
      const stuck = r.closed ? pendingStuck(readRollovers(config.stateDir), target.key) : undefined;
      if (stuck) {
        const line = outcomeLine(note);
        appendRollover(config.stateDir, { kind: "outcome", at: new Date().toISOString(), key: target.key, rolloverAt: stuck.at, line, by: "close" });
        console.log(`ROLLOVER_OUTCOME ${target.key} unknown (rollover ${stuck.at}): ${line}`);
      }
      process.exit(r.closed ? 0 : 2);
    }
    case "watch":
      console.log("LANE_WATCH_READY");
      for (;;) {
        for (const line of await watchTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN ${String(e).slice(0, 200)}`])) console.log(line);
        await Bun.sleep(30_000);
      }
    case "scorecard": {
      const window = dayWindow(opt("date") ?? "today", config.scorecard.timeZone, Date.now());
      const data = await computeScorecard({
        stateDir: config.stateDir,
        sessionsDir: config.scorecard.sessions,
        lanes: await deps.registry.list(),
        settings: config.scorecard,
        inbox: config.scorecard.inbox || process.env.DORI_DISCORD_INBOX?.trim() || join(config.stateDir, "discord", "inbox.jsonl"),
        owner: process.env.DORI_DISCORD_OWNER?.trim() ?? "",
      }, window);
      const text = formatScorecard(data, config.scorecard.language, Date.now());
      console.log(text);
      console.log(`SAVED ${await saveScorecard(join(config.stateDir, "scorecard"), data, text, config.scorecard.keepDays)}`);
      if (flags.values.post) {
        const ref = opt("to") || config.scorecard.postTo || `discord:${env("DORI_DISCORD_CHANNEL")}`;
        const id = /^discord:(\d{5,25})$/.exec(ref)?.[1] ?? die(`scorecard posts to discord:<channel or thread id>, not ${ref}`);
        console.log(`SENT ${await discordClient().send(id, text)}`);
      }
      break;
    }
    case "signals": {
      const q: AreaQuery = { ...(opt("lane") ? { lane: opt("lane") } : {}), ...(opt("cwd") ? { cwd: resolve(opt("cwd") ?? "") } : {}), ...(tags().length ? { tags: tags() } : {}) };
      if (!q.lane && !q.cwd && !q.tags) {
        const lines = await openSignals();
        console.log(lines.length ? lines.join("\n") : "SIGNALS none for open lanes");
        break;
      }
      const list = await areaSignals(await deps.registry.list(), q, config);
      console.log(list.length ? formatSignals(areaLabel(q), list) : `SIGNALS no lane in ${areaLabel(q)}`);
      break;
    }
    case "freshness":
      console.log(autoReadyLine(config.handover));
      // a handover.watchers check that fails refuses every lead handover, the automatic one too: said once at start (the
      // lanes service starts again after each update), in the watch log and to the pair channel, not first at the refusal
      if (config.leadPane && config.handover.watchers.length) {
        const down = await missingWatchers({ run }, config.handover.watchers, { pane: config.leadPane, session: "" });
        if (down.length) {
          const line = `HANDOVER_WATCHER_DOWN ${config.leadPane}: ${down.join(", ")}; every lead handover, the automatic one too, is refused until it runs or handover.watchers is fixed`;
          console.log(line);
          for (const l of (await deps.postLeadAlert?.(line).catch((e: unknown) => [`LEAD_ALERT_WARN ${String(e).slice(0, 160)}`])) ?? []) console.log(l);
        }
      }
      await every(loopMin, async () => {
        const laneDeps = laneDepsFor(() => {});
        const hooks = {
          signals: (pane: string, model: string) => paneSignals(laneDeps, pane, model),
          // automatic rollover (handover.autoRolloverLanes / autoRolloverLead): a detached run, approved as auto:<key>
          auto: async (who: "lead" | "lane", k: string) => {
            const refused = windowsDetachRefusal();
            if (refused) return `could not start: ${refused}`;
            const unit = `dori-rollover-${k}-${Date.now()}`;
            const log = join(config.stateDir, "handover", "run.log");
            mkdirSync(join(config.stateDir, "handover"), { recursive: true });
            const r = await run(["systemd-run", "--user", "--collect", `--unit=${unit}`, "--setenv=DORI_HANDOVER_DETACHED=1", `--setenv=${AUTO_GRANT_ENV}=${mintAutoGrant(config.stateDir, who, who === "lane" ? k : "lead", Date.now())}`, ...passEnv(), `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`, process.execPath, import.meta.path, "handover", ...(who === "lane" ? ["--lane", k, "--wait-idle", String(config.handover.autoWaitMin)] : []), "--approved-by", `auto:handover.autoRollover${who === "lane" ? "Lanes" : "Lead"}`]);
            return r.code === 0 ? `started unit=${unit} log=${log}` : `could not start: ${(r.err || r.out).trim().slice(0, 160)}`;
          },
          // a lead's lane handover refused while the lane was busy, started again once the lane marked ready: a detached run
          // with the same approval and options that waits for the lane's idle moment like an automatic one
          resume: async (k: string, approvedBy: string, request: RolloverRequest, serves: { readonly at: string; readonly pane: string }) => {
            const refused = windowsDetachRefusal();
            if (refused) return { started: false, line: `could not start: ${refused}` };
            const unit = `dori-rollover-${k}-${Date.now()}`;
            const log = join(config.stateDir, "handover", "run.log");
            mkdirSync(join(config.stateDir, "handover"), { recursive: true });
            const r = await run(["systemd-run", "--user", "--collect", `--unit=${unit}`, "--setenv=DORI_HANDOVER_DETACHED=1", ...(decidedBy(approvedBy) === "auto" ? [`--setenv=${AUTO_GRANT_ENV}=${mintAutoGrant(config.stateDir, "lane", k, Date.now())}`] : []), ...passEnv(), `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`, process.execPath, import.meta.path, "handover", "--lane", k, "--wait-idle", String(config.handover.autoWaitMin), "--approved-by", approvedBy, ...resumeArgs(request), "--request-at", serves.at, "--request-pane", serves.pane]);
            return r.code === 0 ? { started: true, line: `unit=${unit} log=${log}` } : { started: false, line: `could not start: ${(r.err || r.out).trim().slice(0, 160)}` };
          },
          // the audit after a committed handover: a detached run, so its supplement round does not hold up the sweep
          audit: async (c: Committed) => {
            const refused = windowsDetachRefusal();
            if (refused) {
              rmSync(markerFile(c.note), { force: true });
              return `could not start: ${refused}`;
            }
            const unit = `dori-handover-audit-${c.key}-${Date.now()}`;
            const log = join(config.stateDir, "handover", "run.log");
            const r = await run(["systemd-run", "--user", "--collect", `--unit=${unit}`, ...passEnv(), `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`, process.execPath, import.meta.path, "handover", "audit", c.note]);
            if (r.code !== 0) rmSync(markerFile(c.note), { force: true });
            return r.code === 0 ? `started unit=${unit} log=${log}` : `could not start: ${(r.err || r.out).trim().slice(0, 160)}`;
          },
          auditSummary: (week: string) => sendAuditSummary(deps, laneDeps.inbox ?? join(config.stateDir, "discord", "inbox.jsonl"), week),
          // the daily directive audit on every Dori, and the owner's links pushed to the other Dori (directives.linkPeers)
          directiveAudit: dailyAuditHook(config, async (since: string) => (await auditOrReport(deps, { since, inbox: auditInbox(), owner: process.env.DORI_DISCORD_OWNER?.trim() ?? "", threads: threads(cardDir()), memory: leadMemoryRepo() })).lines),
          directiveLinks: async () => (await pushLinks(deps)).lines,
        };
        for (const a of await freshnessTick(deps, accountHome(), hooks)) console.log(`${a.kind.toUpperCase()} ${a.lane} ${a.detail}`);
        // a done thread that a post after its close opened again goes back to the archive once quiet (discord.autoArchiveMin)
        if (discordToken) {
          const statusFile = join(cardDir(), "thread-status.json");
          const store = new QuestionStore(cardDir());
          const archived = await Promise.resolve()
            .then(() =>
              archiveDoneThreads({
                dc: ownDiscord(discordToken),
                guild: process.env.DORI_DISCORD_GUILD?.trim() ?? "",
                channel: process.env.DORI_DISCORD_CHANNEL?.trim() ?? "",
                words: config.discord,
                afterMin: config.discord.autoArchiveMin,
                now: realClock.now,
                laneThreads: async () => new Set((await deps.registry.open()).flatMap((l) => (l.thread?.startsWith("discord:") ? [l.thread.slice("discord:".length)] : []))),
                openCards: (t) => openCardIds(store, t),
                pendingStatus: (t) => existsSync(statusFile) && t in (JSON.parse(readFileSync(statusFile, "utf8")) as Record<string, unknown>),
              }),
            )
            .catch((e: unknown) => [`THREAD_AUTO_ARCHIVE_WARN ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200)}`]);
          for (const line of archived) console.log(line);
        }
        // a lane a lead handover could not tell (told=no) is told once a turn runs there, or the lead hears of it
        for (const line of await retryLaneTells({ run, clock: realClock, config, registry: deps.registry, delivered: (pane, text, since) => paneTranscriptHas(run, config.sessionsDir, pane, text, since) })) {
          watchLog(config.watchLog, realClock, { source: "handover", line });
          console.log(line);
        }
        // a frozen old lead is closed handover.frozenCloseH hours after its handover
        for (const line of await closeDueFrozen(freezeDeps, config.stateDir, Date.now())) {
          watchLog(config.watchLog, realClock, { source: "handover", line });
          console.log(line);
        }
        // the backlog pass (dori backlog), on a Dori that turned it on: every tick, with a sweep every backlog.everyMin minutes
        if (config.backlog.enabled) {
          for (const line of await backlogTick(backlogDeps()).catch((e: unknown) => [`BACKLOG_WARN ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200)}`])) {
            watchLog(config.watchLog, realClock, { source: "backlog", line });
            console.log(line);
          }
        }
      });
      break;
    case "dead-panes": {
      const seen = new Set<string>();
      const panes = newDeadPaneState();
      await every(loopMin, async () => {
        const paused = (await deps.registry.open()).flatMap((l) => (statusOf(l) === "paused" && l.pane ? [l.pane] : []));
        for (const line of await deadPaneTick(run, config, seen, new Date().toISOString().slice(0, 13), paused, panes)) console.log(line);
      });
      break;
    }
    case "guard": {
      const state = { alerting: false };
      console.log("HOST_GUARD_READY");
      await every(loopMin, async () => {
        for (const line of guardTick(await sampleHost(run, config.backend), config.guard, state)) console.log(line);
      });
      break;
    }
    case "heavy": {
      const sep = rest.indexOf("--");
      const label = rest[0];
      const cmd = sep >= 0 ? rest.slice(sep + 1) : [];
      const load = async () => (await sampleHost(run, config.backend)).load1;
      const jobName = opt("job");
      if (jobName !== undefined) {
        const jobLabel = label && !label.startsWith("-") ? label : die("usage: dori heavy <label> --job <name> [--in FILE ...] [--out DIR] [--rl] [-- arg ...]");
        const out = opt("out");
        process.exitCode = await heavyJobCommand({ q: config.heavyQueue, deps: heavyDeps(load) }, { req: { label: jobLabel, kind: jobName, rl: Boolean(flags.values.rl), args: cmd }, files: many("in").map((f) => resolve(f)), ...(out ? { out: resolve(out) } : {}) });
        break;
      }
      const name = label && label !== "--" && !label.startsWith("-") && cmd.length ? label : die("usage: dori heavy <label> [--mem SIZE] [--kind cpu|browser|gpu --sync PATH ... [--env NAME ...]] -- <command ...>");
      const memOpt = opt("mem");
      const needBytes = memOpt === undefined ? undefined : (parseMem(memOpt) ?? die(`dori heavy --mem takes a size like 70G or 200M, not "${memOpt}"`));
      const deps = heavyDeps(load);
      // a bash -c pipe into tail must not turn a failure into exit 0, here or on a helper (heavy-spread.ts withPipefail)
      const jobCmd = withPipefail(cmd);
      if (jobCmd !== cmd) deps.log?.(`HEAVY_PIPEFAIL ${name}: the bash -c script pipes, so it runs with set -o pipefail and a failing stage fails the job`);
      const host = readMeminfo();
      const never = needBytes && host ? neverFits(needBytes, host, config.heavyHeadroomPct) : undefined;
      if (never) {
        deps.log?.(`HEAVY_REFUSED ${name}: ${never}`);
        process.exitCode = 2;
        break;
      }
      // --kind: the command may run on the less busy host (heavy-spread.ts); what it cannot take along keeps it here
      const kindOpt = opt("kind");
      const kind = kindOpt === undefined ? undefined : isKind(kindOpt) ? kindOpt : die(`dori heavy --kind takes cpu, browser or gpu, not "${kindOpt}"`);
      let spreadSlot: string | undefined;
      if (kind !== undefined) {
        const badEnv = many("env").find((e) => !/^[A-Za-z_]\w{0,63}$/.test(e));
        if (badEnv !== undefined) die(`dori heavy --env takes a variable name, not "${badEnv}"`);
        const env = Object.fromEntries(["LANG", "TZ", ...many("env")].flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])));
        const job: SpreadJob = { label: name, kind, cmd: jobCmd, cwd: process.cwd(), sync: many("sync").map((s) => resolve(s)), env, ...(needBytes ? { needBytes } : {}) };
        const plan = spreadPlan(job, { uid: process.getuid?.() ?? -1, home: homedir() });
        if (!plan.ok) deps.log?.(`HEAVY_LOCAL ${name}: ${plan.why}`);
        else if (!config.heavyQueue.helpers.length) deps.log?.(`HEAVY_LOCAL ${name}: no heavyQueue.helpers on this host`);
        else {
          const r = await heavySpread({ q: config.heavyQueue, deps }, job, plan);
          if ("code" in r) {
            process.exitCode = r.code;
            break;
          }
          spreadSlot = r.slot;
        }
      }
      const slot = spreadSlot ?? (await acquireSlot(deps, name, 15_000, needBytes ? needBytes / 1024 : undefined));
      try {
        // plain dori heavy is the GPU slot line, and --kind gpu a GPU job: both get free memory made first (heavy-mem.ts gpuRoom)
        const gpu = kind === undefined || kind === "gpu";
        process.exitCode = await spawnScoped({ label: name, cmd: jobCmd, free: config.heavyHeadroomPct, ...(needBytes ? { needBytes } : {}), ...(deps.log ? { log: deps.log } : {}), ...(gpu ? { gpuFreeKb: config.heavyGpuFreeGb * 1024 ** 2 } : {}) }, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
      } finally {
        releaseSlot(slot);
      }
      break;
    }
    case "gpu-room": {
      // what dori heavy does before a GPU job, on its own: a script whose CUDA start failed calls it before its one retry
      const wantOpt = opt("want");
      const want = wantOpt === undefined ? config.heavyGpuFreeGb * 1024 ** 3 : (parseMem(wantOpt) ?? die(`dori gpu-room --want takes a size like 20G, not "${wantOpt}"`));
      await gpuRoom(key && !key.startsWith("-") ? key : "gpu-room", want / 1024, config.heavyHeadroomPct, heavyDeps(async () => 0).log);
      break;
    }
    case "heavy-serve": {
      const sep = rest.indexOf("--");
      const load = async () => (await sampleHost(run, config.backend)).load1;
      const [label = "", kind = ""] = flags.positionals;
      process.exitCode = await heavyServe({ q: config.heavyQueue, deps: heavyDeps(load) }, { label, kind, rl: Boolean(flags.values.rl), args: sep >= 0 ? rest.slice(sep + 1) : [] });
      break;
    }
    case "heavy-worker": {
      const load = async () => (await sampleHost(run, config.backend)).load1;
      const at = rest.indexOf("--caller");
      const words = at >= 0 ? [...rest.slice(0, at), ...rest.slice(at + 2)] : rest;
      process.exitCode = await heavyWorker({ q: config.heavyQueue, deps: heavyDeps(load) }, process.env.SSH_ORIGINAL_COMMAND ?? words.join(" "), opt("caller"));
      break;
    }
    case "state-git": {
      const sg = config.stateGit;
      const sgDeps: StateGitDeps = { settings: sg, timeZone: sg.timeZone || config.scorecard.timeZone, now: () => Date.now(), print: (line) => console.log(line) };
      const inbox = process.env.DORI_DISCORD_INBOX?.trim() || join(config.stateDir, "discord", "inbox.jsonl");
      const picked = many("dir").map((d) => resolve(d));
      const dirs = picked.length ? picked : stateGitDirs({ configFile: configPath(), stateDir: config.stateDir, inbox, home: process.env.HOME ?? "", dirs: sg.dirs }).filter((d) => existsSync(d));
      const sub = key ?? "log";
      const show = (lines: readonly string[]): void => {
        for (const line of lines) console.log(line);
      };
      const bk = sg.backup;
      // the repos the backup pushes: the state-git ones and the Dori's docs repos (stateGit.backup.dirs)
      const backupDirs = [...new Set([...dirs, ...bk.dirs.filter((d) => existsSync(join(d, ".git")))])];
      const clockAt = opt("clock") ? Date.parse(opt("clock") ?? "") : undefined;
      if (clockAt !== undefined && !Number.isFinite(clockAt)) die(`--clock takes an ISO time with its offset, e.g. 2026-10-18T06:00+09:00`);
      const backupDeps = (): BackupDeps => ({
        ...sgDeps,
        now: clockAt === undefined ? () => Date.now() : () => clockAt,
        backup: bk,
        stateDir: config.stateDir,
        home: accountHome(),
        visibility: (repo) => backupVisibility(repo, { run, fetch }),
        remoteUrl: backupRemoteUrl,
        secrets: async () => {
          const gh = await run(["gh", "auth", "token"]);
          const ghToken = gh.code === 0 && gh.out.trim() ? [{ value: gh.out.trim(), from: "gh auth token" }] : [];
          const ownerIds = [process.env.DORI_DISCORD_OWNER, process.env.DORI_KAKAO_OWNER_ID].map((v) => v?.trim() ?? "").filter(Boolean);
          const messageFiles = [...bk.messageFiles, inbox, process.env.DORI_KAKAO_INBOX?.trim() ?? ""].filter(Boolean);
          const secretFiles = bk.secretFiles.flatMap((f) => (existsSync(f) && statSync(f).isDirectory() ? envFilesIn(f) : [f]));
          return loadSecrets([...secretFiles, envFilePath(), ...backupDirs.flatMap(envFilesIn)], messageFiles, ownerIds, bk.ownerMinChars, ghToken);
        },
        busy: async () => {
          const why: string[] = [];
          const lanes = (await deps.registry.open()).filter((l) => l.pane);
          const panes = [...new Set([config.leadPane, ...lanes.map((l) => l.pane ?? "")].filter(Boolean))];
          try {
            for (const [pane, a] of await paneActivity(run, panes)) if (a === "busy") why.push(`turn:${lanes.find((l) => l.pane === pane)?.key ?? (pane === config.leadPane ? "lead" : pane)}`);
          } catch (e) {
            if (!(e instanceof Error)) throw e;
            why.push(`pane check failed (${e.message.slice(0, 80)})`);
          }
          const heavy = join(config.stateDir, "heavy");
          for (const slot of existsSync(heavy) ? readdirSync(heavy).filter((n) => n.startsWith("slot.")) : []) {
            const owner = existsSync(join(heavy, slot, "owner")) ? readFileSync(join(heavy, slot, "owner"), "utf8").split(" ") : [];
            if (pidAlive(Number(owner[0]), Date.parse(owner.at(-1) ?? "") || undefined)) why.push(`heavy:${owner[1] ?? slot}`);
          }
          for (const d of backupDirs) if (["index.lock", "dori-state.lock"].some((f) => existsSync(join(d, ".git", f)))) why.push(`git-lock:${d}`);
          return why;
        },
      });
      if (sub === "push-check") {
        // the pre-push hook: refuse unless the remote is this Dori's private backup and the pushed commits are clean
        const refused = await pushCheck(backupDeps(), resolve(many("repo")[0] ?? process.cwd()), opt("remote") ?? "", opt("url") ?? "", await new Response(Bun.stdin.stream()).text());
        for (const line of refused) console.error(`STATE_GIT_PUSH_REFUSED ${line}`);
        process.exit(refused.length ? 1 : 0);
      }
      if (sub === "backup") {
        const step = flags.positionals[1] ?? "preview";
        if (!bk.repo) die("BACKUP_OFF stateGit.backup.repo is empty in this Dori's config");
        const bd = backupDeps();
        if (step === "create") {
          let vis = await bd.visibility(bk.repo);
          if (vis === "missing") {
            const made = await run(["gh", "repo", "create", bk.repo, "--private", "--description", "Dori local backup (private; pushed by dori state-git)"]);
            if (made.code !== 0) die(`BACKUP_REPO_FAILED ${bk.repo}: ${(made.err || made.out).slice(0, 200)}`);
            vis = await bd.visibility(bk.repo);
          }
          if (vis !== "private") die(`BACKUP_REPO_NOT_PRIVATE ${bk.repo} is ${vis}: nothing will be pushed there`);
          console.log(`BACKUP_REPO_OK ${bk.repo} private`);
        } else if (step === "preview") {
          const secrets = await bd.secrets();
          console.log(`BACKUP_SECRETS ${secrets.values.length} secret values (never printed), ${secrets.ownerTexts.length} owner messages to look for`);
          for (const d of backupDirs) show(await previewDir(bd, d, secrets));
        } else if (step === "approve") {
          console.log(approve(bd, need("by"), many("history-ok")));
        } else if (step === "push") {
          for (const d of backupDirs) show(await guardDir(bd, d, dirs.includes(d)));
          show(await pushAll(bd, backupDirs));
        } else if (step === "tick") {
          show(await backupTick(bd, backupDirs));
        } else die(`state-git backup: unknown step ${step} (create, preview, approve, push, tick)`);
        break;
      }
      if (sub === "check") {
        const lines = await checkRepo(sgDeps, resolve(many("repo")[0] ?? process.cwd()));
        for (const line of lines) console.error(line);
        process.exit(lines.length ? 1 : 0);
      }
      if (sub === "loop") {
        // dori-lanes runs this beside the other sweeps; it must never exit (wait -n would restart them all)
        if (sg.everyMin <= 0) {
          console.log("STATE_GIT_OFF stateGit.everyMin is 0");
          for (;;) await Bun.sleep(3_600_000);
        }
        console.log(`STATE_GIT_READY ${dirs.join(" ")} every ${sg.everyMin} min${bk.repo ? `; backup to ${bk.repo} at ${bk.at} ${sgDeps.timeZone} when quiet (${backupDirs.join(" ")})` : ""}`);
        if (bk.repo) for (const d of backupDirs.filter((x) => !dirs.includes(x))) await guardDir(backupDeps(), d, false);
        for (;;) {
          for (const d of dirs) {
            try {
              show((await commitDir(sgDeps, d)).lines.filter((l) => !l.startsWith("STATE_GIT_NOCHANGE")));
            } catch (e) {
              console.log(`STATE_GIT_WARN ${d} ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200)}`);
            }
          }
          if (bk.repo) {
            try {
              show(await backupTick(backupDeps(), backupDirs));
            } catch (e) {
              console.log(`STATE_GIT_PUSH_WARN ${bk.repo} ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200)}`);
            }
          }
          // wake for the next backup try when it comes before the next commit tick
          await Bun.sleep(bk.repo ? Math.max(1000, Math.min(sg.everyMin * 60_000, msToNextSlot(Date.now(), sgDeps.timeZone, bk))) : sg.everyMin * 60_000);
        }
      }
      for (const d of dirs) {
        if (sub === "init") show(await initRepo(sgDeps, d));
        else if (sub === "commit") show((await commitDir(sgDeps, d, undefined, 30_000)).lines);
        else if (sub === "log") show(await logDir(sgDeps, d, Number(flags.positionals[1] ?? 15)));
        else if (sub === "restore") show(await restoreDir(sgDeps, d, flags.positionals[1] ?? die("state-git restore needs a time or a commit, e.g. \"yesterday 21:00\""), many("file")));
        else die(`state-git: unknown step ${sub} (init, commit, log, restore, loop, check)`);
      }
      if (!dirs.length) console.log("STATE_GIT_NO_DIRS none of this Dori's directories exists");
      break;
    }
    case "backlog": {
      const sub = key ?? "list";
      const id = flags.positionals[1];
      const at = new Date().toISOString();
      const state = config.backlog.enabled ? `BACKLOG_ON one pass every ${config.backlog.everyMin} min, at most ${config.backlog.maxStarts} start(s) a pass while fewer than ${config.backlog.maxLanes} lanes are open` : `BACKLOG_OFF backlog.enabled is false in ${configPath()}: items wait until this Dori turns it on`;
      try {
        if (sub === "list") {
          const items = listItems(config.stateDir).filter((i) => flags.values.all || i.status === "open" || i.status === "running").sort(byTurn);
          console.log(items.length ? items.map(itemLine).join("\n") : "BACKLOG_EMPTY");
          const last = lastRun(config.stateDir);
          console.log(`${state}${last ? `; last pass ${last.at}` : ""}`);
        } else if (sub === "add") {
          const itemId = id ?? die("usage: dori backlog add <id> --title T --brief FILE --done \"...\"");
          const ownerLink = opt("owner-link");
          const ownerProblem = ownerLink ? await ownerLinkProblem(ownerLink) : undefined;
          if (ownerLink && ownerProblem && !config.backlog.writeNeedsOwnerLink) die(`BACKLOG_REFUSED --owner-link ${ownerLink}: ${ownerProblem}`, 2);
          const registered = Boolean(await deps.registry.read(laneKeyOf(itemId)));
          const r = await withBacklogLock(config.stateDir, 120, () => addItem(config.stateDir, { id: itemId, title: need("title"), brief: need("brief"), done: need("done"), priority: opt("priority"), cwd: opt("cwd"), thread: threadOpt(), noThread: noThreadOpt(), whyNew: whyNewOpt(), goal: opt("goal"), tags: tags(), ask: flags.values.ask === true ? "" : opt("ask"), by: opt("by"), readOnly: Boolean(flags.values["read-only"]), ownerLink }, { registered, at, needOwnerLink: config.backlog.writeNeedsOwnerLink, ownerProblem }));
          console.log(`${r.replaced ? "BACKLOG_REPLACED" : "BACKLOG_ADDED"} ${itemLine(r.item)}`);
          if (!config.backlog.enabled) console.log(state);
        } else if (sub === "drop") {
          const dropId = id ?? die("usage: dori backlog drop <id> [--reason R]");
          await withBacklogLock(config.stateDir, 120, () => dropItem(config.stateDir, dropId, many("reason").join("; ") || "by the lead", at));
          console.log(`BACKLOG_DROPPED ${id}`);
        } else if (sub === "decide") {
          const kst = `${new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ")} KST`;
          const decideId = id ?? die("usage: dori backlog decide <id> --text \"<the owner's answer>\"");
          const item = await withBacklogLock(config.stateDir, 120, () => decideItem(config.stateDir, decideId, opt("text") ?? "", at, kst, opt("question"), flags.values.hash === undefined ? undefined : String(flags.values.hash)));
          console.log(`BACKLOG_DECIDED ${item.id}: the answer is in its brief; it starts at a pass when its turn comes`);
        } else if (sub === "tick") {
          if (!config.backlog.enabled && !flags.values.force) die(state, 4);
          const lines = await backlogTick(backlogDeps(), { force: Boolean(flags.values.force) });
          for (const line of lines) {
            watchLog(config.watchLog, realClock, { source: "backlog", line });
            console.log(line);
          }
          if (!lines.length) console.log(`BACKLOG_QUIET nothing new since the last pass; the next sweep is ${config.backlog.everyMin} min after ${lastRun(config.stateDir)?.at ?? "?"} (--force: now)`);
        } else if (sub === "show") {
          const item = readItem(config.stateDir, id ?? die("usage: dori backlog show <id>")) ?? die(`no backlog item ${id}`);
          console.log(JSON.stringify(item, null, 1));
        } else die(`backlog: unknown step ${sub} (list, add, drop, decide, tick, show)`);
      } catch (e) {
        if (e instanceof BacklogError) die(`BACKLOG_REFUSED ${e.message}`, 2);
        throw e;
      }
      break;
    }
    case "can-launch": {
      const v = canLaunch(await sampleHost(run, config.backend), config.guard);
      console.log(v.ok ? "CAN_LAUNCH" : `HOLD ${v.reasons.join(" | ")}`);
      process.exit(v.ok ? 0 : 4);
    }
    case "send": {
      await quietGuard();
      const platform = key ?? die("send needs slack, telegram or discord");
      onlyOptions("send", ["to", "text", "text-file", "thread", "edit", "status", "no-typing", "ping", "reply", "again", "file"], 1);
      const to = need("to");
      const status = opt("status");
      if (status !== undefined && (platform !== "discord" || (status !== "working" && status !== "done"))) die("--status takes working or done, with discord");
      const thread = opt("thread");
      const edit = opt("edit");
      const filePaths = ((flags.values.file as (string | boolean)[] | undefined) ?? []).map((p) => (typeof p === "string" ? p.trim() : ""));
      if (filePaths.some((p) => !p)) die("SEND_FILE_REFUSED --file takes a path; nothing was sent", 2);
      if (filePaths.length && platform !== "slack" && platform !== "discord") die(`SEND_FILE_REFUSED --file is only supported for slack and discord, not ${platform}; nothing was sent`, 2);
      if (filePaths.length && edit) die("SEND_FILE_REFUSED --file is for a new message, not --edit; nothing was sent", 2);
      if (filePaths.length && platform === "slack" && flags.values.again) die("SEND_FILE_REFUSED --again is for a text post; a slack --file send is never checked for repeats; nothing was sent", 2);
      let uploads: UploadFile[] = [];
      // discord: the files go in the message's own request and their sha256 into its repeat check
      let discordFiles: DiscordFile[] = [];
      try {
        if (filePaths.length && platform === "slack") uploads = readUploads(filePaths);
        if (filePaths.length && platform === "discord") discordFiles = await readDiscordFiles(filePaths);
      } catch (e) {
        if (!(e instanceof UploadRefused)) throw e;
        die(e.message, 2);
      }
      // with --file the text is optional: it goes out as the files' message (Slack initial_comment, Discord content)
      const body = filePaths.length && !opt("text") && !opt("text-file") ? "" : postable(await textOrFile(opt("text"), "send needs --text TEXT or --text-file FILE (or --file PATH, slack or discord)"), "send");
      const text = status === "working" || status === "done" ? progressText(status, body, config.discord) : body;
      const tooBig = discordMessageProblem(discordFiles, text);
      if (tooBig) die(tooBig, 2);
      const rawPing = flags.values.ping;
      if (rawPing !== undefined && (typeof rawPing !== "string" || rawPing.length === 0 || /[^0-9]/.test(rawPing))) die("--ping takes a digits-only user id");
      const ping = typeof rawPing === "string" ? rawPing : undefined;
      if (ping !== undefined && (platform !== "discord" || edit)) die("--ping is only supported for new Discord messages");
      const reply = opt("reply");
      if (flags.values.reply !== undefined && (!reply || /[^0-9]/.test(reply))) die("--reply takes the digits-only id of the message this one answers");
      if (reply !== undefined && (platform !== "discord" || edit)) die("--reply is only supported for new Discord messages");
      if (flags.values.again && edit) die("--again is for a new message; an edit is never checked for repeats");
      const token = (name: string) => process.env[name] ?? die(`${name} is not set`);
      // a new message goes out once per place, reply target, ping and text in SEND_DEDUPE_MS, and never when it is the
      // place's last post (src/send-dedupe.ts); a repeat exits SEND_DUPLICATE_EXIT, a post prints what the service holds
      const place = platform === "discord" ? `discord:${thread ?? to}` : `${platform}:${to}${thread ? `/${thread}` : ""}`;
      const sentDir = join(config.stateDir, "sent");
      // Discord puts a --ping in front of the text unless the text already has it, so both inputs key as the one message
      // that goes out (review 8 of #338)
      const keyText = platform === "discord" && ping !== undefined && !text.includes(`<@${ping}>`) ? `<@${ping}> ${text}` : text;
      const dedupeKey = sendKey([platform, platform === "discord" ? (thread ?? to) : `${to}/${thread ?? ""}`, reply, ping, keyText, ...filesKey(discordFiles)]);
      // an edit is never checked and does not move the place's last-post record (docs/follow-ups.md)
      const once = async (post: () => Promise<Sent>) => {
        const r = await sendOnce(sentDir, place, dedupeKey, post, { again: Boolean(flags.values.again) });
        console.log(r.duplicate ? duplicateLine(place, r) : sentLine("SENT", r));
        if (r.duplicate) process.exitCode = SEND_DUPLICATE_EXIT;
        return r;
      };
      if (platform === "slack") {
        const slack = new Slack(fetchHttp, realClock, { token: token("DORI_SLACK_TOKEN"), cookie: process.env.DORI_SLACK_COOKIE }, process.env.DORI_SLACK_API?.trim() || undefined, new ThreadLedger(`${config.stateDir}/slack-threads.json`));
        if (edit) await slack.edit(to, edit, text);
        else {
          let posted: { channel: string; ts: string } | undefined;
          // files are shared once per call and never by the repeat check: a failure exits non-zero and a person calls again.
          const files = { inbox: process.env.DORI_DISCORD_INBOX?.trim() || join(config.stateDir, "discord", "inbox.jsonl"), uneyed: join(config.stateDir, "slack-uneyed.log") };
          // completeUploadExternal names no message ts, so the share answers the rows there before its upload started and
          // none that came during it (OkDori answered the owner with a file share and the eyes stayed, 2026-11-03)
          let known: ReadonlySet<string> | undefined;
          if (uploads.length) {
            known = slackRowIds(files.inbox, to);
            console.log(`SENT ${(await slack.upload(to, uploads, thread, text || undefined)).join(",")}`);
            posted = { channel: to, ts: "" };
          } else
            await once(async () => {
              const p = await slack.post(to, text, thread);
              posted = p;
              return { id: p.ts, content: p.text };
            });
          // only the watcher's bot puts eyes on; a member's token (xoxp-) must never take a reaction off
          if (posted && process.env.DORI_SLACK_TOKEN?.startsWith("xoxb-")) {
            for (const line of await clearEyes(slackUnreact(process.env.DORI_SLACK_TOKEN, process.env.DORI_SLACK_API?.trim() || undefined), files, posted, thread, 3000, known)) console.log(line);
          }
        }
      } else if (platform === "telegram") {
        const tg = new Telegram(fetchHttp, realClock, token("DORI_TELEGRAM_TOKEN"));
        const target = { chatId: to, ...(thread ? { threadId: Number(thread) } : {}) };
        if (edit) await tg.edit(target, Number(edit), text);
        else
          await once(async () => {
            const m = await tg.post(target, text);
            return { id: String(m.id), content: m.text };
          });
      } else if (platform === "discord") {
        const dc = new Discord(fetchHttp, realClock, checkedDiscordToken(token("DORI_DISCORD_TOKEN")), discordApi());
        await ownerSpeech(body, "send", () => ownerPlace(dc, edit ? to : (thread ?? to)));
        if (edit) await dc.edit(to, edit, text);
        else {
          const r = await once(() => dc.post(thread ?? to, text, !flags.values["no-typing"], ping, reply, discordFiles));
          if (!r.duplicate) await notePost(thread ?? to, r.id, withFileNames(body, discordFiles));
        }
      } else die(`unknown platform ${platform}`);
      break;
    }
    case "presence": {
      if (key === "slack") {
        const auth = { token: process.env.DORI_SLACK_TOKEN ?? die("DORI_SLACK_TOKEN is not set"), cookie: process.env.DORI_SLACK_COOKIE ?? die("DORI_SLACK_COOKIE is not set (user-token presence needs the d cookie)") };
        const p = slackPresence(new Slack(fetchHttp, realClock, auth), (url, headers) => {
          const options: Bun.WebSocketOptions = { headers: { ...headers } };
          const ws = new WebSocket(url, options);
          return { isOpen: () => ws.readyState === WebSocket.OPEN, send: (f) => ws.send(f), close: () => ws.close() };
        }, auth);
        console.log("PRESENCE_READY slack");
        await every(1, async () => console.log(`PRESENCE slack ${await p.hold()}`));
      } else if (key === "discord") {
        const token = checkedDiscordToken(process.env.DORI_DISCORD_TOKEN ?? die("DORI_DISCORD_TOKEN is not set"));
        discordPresence(() => {
          const ws = gatewaySocket();
          let handler: (d: string) => void = () => {};
          ws.addEventListener("message", (e) => handler(String(e.data)));
          return { send: (d) => ws.send(d), close: () => ws.close(), onMessage: (cb) => { handler = cb; } };
        }, token, realTimers);
        console.log("PRESENCE_READY discord");
        await new Promise(() => {});
      } else die("presence needs slack or discord");
      break;
    }
    case "inbound": {
      if (key === "discord") {
        // a shadow run writes only to its own inbox, never the live one (which dori.env may also name)
        const shadowInbox = process.env.DORI_DISCORD_SHADOW_INBOX?.trim() ?? "";
        const liveInbox = process.env.DORI_DISCORD_INBOX?.trim() || join(config.stateDir, "discord", "inbox.jsonl");
        if (shadowInbox && resolve(shadowInbox) === resolve(liveInbox)) die("DORI_DISCORD_SHADOW_INBOX must differ from the live inbox");
        const dc = discordClient();
        const statuses = threadStatuses(dc, (line) => console.log(line));
        // the listener owns the delayed renames: a burst becomes one rename, and a 429 waits out retry_after
        if (!shadowInbox) statuses.watch({ setTimeout: (cb, ms) => setTimeout(cb, ms), setInterval: (cb, ms) => setInterval(cb, ms) });
        const listener = new DiscordListener({
          dc,
          cards: questionCards(dc, statuses),
          open: () => {
            const ws = gatewaySocket();
            return {
              send: (d) => ws.send(d),
              close: (code, reason) => ws.close(code, reason),
              onMessage: (cb) => ws.addEventListener("message", (e) => cb(String(e.data))),
              onClose: (cb) => ws.addEventListener("close", (e) => cb(e.code)),
            };
          },
          token: env("DORI_DISCORD_TOKEN"),
          guild: env("DORI_DISCORD_GUILD"),
          channel: env("DORI_DISCORD_CHANNEL"),
          owner: env("DORI_DISCORD_OWNER"),
          ownerWebhook: process.env.DORI_DISCORD_OWNER_WEBHOOK?.trim() ?? "",
          pairChannel: process.env.DORI_DISCORD_PAIR_CHANNEL?.trim() ?? "",
          pairBots: idList(process.env.DORI_DISCORD_PAIR_BOT),
          watchChannels: idList(process.env.DORI_DISCORD_WATCH_CHANNELS),
          watchBots: idList(process.env.DORI_DISCORD_WATCH_BOTS),
          ...watchMatch(process.env.DORI_DISCORD_WATCH_MATCH),
          shadow: !!shadowInbox,
          words: config.discord,
          inboxFile: shadowInbox || liveInbox,
          timers: { ...realTimers, setTimeout: (cb, ms) => setTimeout(cb, ms) },
          now: realClock.now,
          log: (line) => console.log(line),
          fatal: (code) => process.exit(code === 4014 ? 4 : 3),
          ...(config.hooks.transcribe?.length ? { transcribe: transcribeUrl } : {}),
          // read per message, so a ledger edited while the listener runs is what the next message gets
          hints: (text) => messageLines(text, hintLedger()),
        });
        listener.start();
        await new Promise(() => {});
      }
      // upstream dori-superagent #76 (https://github.com/sisyphuslabs/dori-superagent/pull/76): telegram inbound; #79
      // (https://github.com/sisyphuslabs/dori-superagent/pull/79): edits, media file ids, envInt and its inbound loop
      if (key === "telegram") {
        const tg = new Telegram(fetchHttp, realClock, process.env.DORI_TELEGRAM_TOKEN ?? die("DORI_TELEGRAM_TOKEN is not set"));
        const store = fileTgInboundStore(`${config.stateDir}/telegram-offset`);
        // review 1 of #350: a blank id is refused rather than read as 0, and so are ids Telegram never gives; #79's envInt
        // also refuses 1e3 and 0x10
        const num = (name: string, positive?: string): number => {
          const raw = process.env[name];
          let n = 0;
          try {
            n = envInt(name, raw);
          } catch (e) {
            die(e instanceof Error ? e.message : String(e));
          }
          if (positive && n <= 0) die(`${name} must be a positive ${positive} id, got: ${JSON.stringify(raw)}`);
          return n;
        };
        const ownerId = num("DORI_TELEGRAM_OWNER_ID", "user");
        const groupChatId = process.env.DORI_TELEGRAM_GROUP_ID === undefined ? undefined : num("DORI_TELEGRAM_GROUP_ID");
        const topicId = process.env.DORI_TELEGRAM_TOPIC_ID === undefined ? undefined : num("DORI_TELEGRAM_TOPIC_ID", "topic");
        console.log(`INBOUND_READY telegram owner=${ownerId} group=${groupChatId ?? "-"} topic=${topicId ?? "-"}`);
        // Full text, JSON-escaped on one line: getUpdates cannot fetch a message twice. writeLineSync, not console.log,
        // which drops a failed write (a closed stdout): the whole line is out before the offset moves past its message.
        await telegramInboundLoop(
          tg,
          store,
          { ownerId, groupChatId, topicId },
          loopMin,
          (i) =>
            void writeLineSync(
              `INBOUND ${i.kind === "edit" ? "edit:" : ""}${i.source} ${i.chat} ${i.thread ?? "-"} ${i.updateId} ${i.from} ${JSON.stringify(i.text ?? "")}` +
                `${i.media === undefined ? "" : ` file=${i.media.kind}:${i.media.fileId}`}\n`,
            ),
          (m) => console.log(`WARN ${m}`.slice(0, 300)),
        );
        break;
      }
      if (key !== "slack") die("inbound supports slack, discord and telegram");
      const auth = { token: process.env.DORI_SLACK_TOKEN ?? die("DORI_SLACK_TOKEN is not set"), cookie: process.env.DORI_SLACK_COOKIE };
      const ledger = new ThreadLedger(`${config.stateDir}/slack-threads.json`);
      const slack = new Slack(fetchHttp, realClock, auth, process.env.DORI_SLACK_API?.trim() || undefined, ledger);
      const me = String((await slack.call("auth.test", {})).user_id ?? die("auth.test returned no user_id"));
      console.log("INBOUND_READY slack");
      await every(loopMin, async () => {
        for (const i of await pollSlackInbound(slack, ledger, { selfUserId: me })) console.log(`INBOUND ${i.source} ${i.channel} ${i.threadTs ?? "-"} ${i.ts || "-"} ${i.user ?? "-"} ${JSON.stringify((i.text ?? "").slice(0, 200))}`);
      });
      break;
    }
    case "ask": {
      await quietGuard();
      // a card is for the owner: only he answers it
      await ownerSpeech([need("text"), ...((flags.values.option as string[] | undefined) ?? [])].join("\n"), "ask", async () => true);
      const text = postable(need("text"), "ask");
      let place: AskPlace;
      try {
        place = askPlace({
          thread: threadOpt(),
          channel: flags.values.channel === true ? "" : opt("channel"),
          replyTo: flags.values["reply-to"] === true ? "" : opt("reply-to"),
          tmux: opt("tmux"),
          session: opt("session"),
          here: await currentTmuxSession(run).catch(() => ""),
          lanes: await deps.registry.open(),
          threads: threads(cardDir()),
          inbox: process.env.DORI_DISCORD_INBOX?.trim() || join(config.stateDir, "discord", "inbox.jsonl"),
          owner: process.env.DORI_DISCORD_OWNER?.trim() ?? "",
        });
      } catch (e) {
        if (e instanceof AskPlaceError) die(e.message, 2);
        throw e;
      }
      const thread = place.kind === "channel" ? null : place.thread;
      const q = await questionCards(discordClient()).ask(text, (flags.values.option as string[] | undefined) ?? [], {
        thread,
        session: opt("session") || null,
        // the lane found from this pane is where its answer is relayed, as if --tmux had named it
        tmux: opt("tmux") || (place.kind === "thread" ? place.pane : undefined) || null,
        ...(place.kind === "channel" ? { channelWhy: place.why } : {}),
        ...(place.kind === "reply" ? { replyTo: place.replyTo } : {}),
      });
      if (place.kind === "thread" && place.line) console.log(place.line);
      if (place.kind === "channel") console.log(`ASK_CHANNEL ${q.id}: ${place.why}`);
      if (place.kind === "reply") console.log(`ASK_REPLY ${q.id} ${place.replyTo} ${place.thread ? `in thread discord:${place.thread}` : "in the channel"}`);
      console.log(`ASKED ${q.id} message=${q.message}`);
      break;
    }
    case "questions": {
      const all = new QuestionStore(cardDir()).all().filter((q) => !flags.values.open || q.status === "open");
      for (const q of all) console.log(`${q.id} ${q.status} ${JSON.stringify(q.text)}${q.answer ? ` -> ${JSON.stringify(q.answer)} (${q.answerKind})` : ""} thread=${q.thread ?? "-"} session=${q.session ?? "-"} tmux=${q.tmux ?? "-"}`);
      if (!all.length) console.log("NO_QUESTIONS");
      break;
    }
    case "reopen":
      console.log(`REOPENED ${(await questionCards(discordClient()).reopen(key ?? die("reopen needs a question id"))).id}`);
      break;
    case "resolve": {
      const id = key ?? die("resolve needs a question id");
      const resolved = (await questionCards(discordClient()).resolve(id, opt("answer"))) ?? die(`no question ${id}`);
      console.log(`RESOLVED ${id} ${resolved}`);
      break;
    }
    case "lead":
      console.log(await findLead(run, config));
      break;
    case "serve": {
      const cli = fileURLToPath(import.meta.url);
      const sessionWatch = fileURLToPath(new URL("../../setups/discord-aoe/session-watch.ts", import.meta.url));
      if (flags.values["install-task"]) {
        const refused = installTaskRefusal((Array.isArray(flags.values.only) ? flags.values.only : []).map(String), opt("log"));
        if (refused) die(refused);
        const argv = taskArgv(process.execPath, cli, config.stateDir);
        const r = await run(argv);
        console.log(r.code === 0 ? `SERVE_TASK_INSTALLED "${TASK_NAME}" at logon` : `SERVE_TASK_FAIL ${(r.err || r.out).slice(0, 200)}`);
        if (r.code !== 0) process.exitCode = 1;
        break;
      }
      const only = new Set(Array.isArray(flags.values.only) ? flags.values.only : []);
      const loops = serveLoops(process.execPath, cli, sessionWatch).filter((l) => !only.size || only.has(l.tag));
      const log = opt("log") ?? join(config.stateDir, "serve.log");
      console.log(`SERVE_READY ${loops.map((l) => l.tag).join(",")} log ${log}`);
      await serve(loops, { start: spawnLoop, log: fileLog(log, realClock), clock: realClock });
      break;
    }
    case "revive": {
      const pane = key ?? die("usage: dori revive <herdr pane> [--text TEXT]");
      if (!isHerdrPane(pane)) die("revive takes a herdr pane id (an aoe session restarts with self-restart.sh)");
      // dori never ends a live herdr agent: only a pane whose agent is gone is started again
      if ((await paneLife(run, pane)).live) {
        console.log(`REVIVE_ALREADY_RUNNING ${pane}`);
        break;
      }
      const line = await reviveHerdr(run, realClock, config, pane, opt("text") ?? "", (p, t) => sendVerified(run, realClock, config, p, t));
      console.log(line);
      if (!line.startsWith("REVIVE_OK")) process.exitCode = 1;
      break;
    }
    case "thread": {
      await quietGuard();
      const [verb, ref, text] = flags.positionals;
      if (verb === "list") {
        for (const [id, entry] of Object.entries(threads(cardDir()))) console.log(`${id} ${entry.session ?? "none"} ${entry.title}${entry.standing ? " [standing]" : ""}`);
        break;
      }
      if (verb === "map") {
        if (!ref || !text?.trim()) die("usage: dori thread map discord:<id> <session|none>");
        mapThread(cardDir(), discordThreadId(ref ?? ""), text === "none" ? null : text ?? null);
        console.log(`THREAD_MAPPED ${ref} ${text}`);
        break;
      }
      if (verb === "open") {
        const title = bareThreadName(ref ?? "", config.discord).trim();
        const from = opt("from")?.trim();
        const first = opt("first")?.trim();
        if (first) postable(first, "thread open --first");
        if (!title || (!from && !first)) die("usage: dori thread open <title> [--from MSG_ID] [--first TEXT] [--session S]; standalone threads need --first");
        // a thread the lead opens is work without a lane brief: the ledger is read against its title, first message and the
        // owner's message it starts from before anything is opened; a ledger that cannot be read opens nothing
        let found: ReturnType<typeof textDirectives> = [];
        try {
          found = textDirectives([title, first ?? "", from ? inboxText(from) : ""].join("\n"), hintLedger({ strict: true }), { all: true });
        } catch (e) {
          die(`THREAD_REFUSED ${title}: the directive ledger could not be read (${e instanceof Error ? e.message : String(e)}); no thread is opened without its directives. Fix the ledger (dori directives check), or open the work as a lane (dori launch --thread new)`);
        }
        const dc = discordClient();
        const id = await dc.startThread(env("DORI_DISCORD_CHANNEL"), from, threadName("working", title, config.discord));
        if (!from && first) await dc.send(id, first);
        mapThread(cardDir(), id, opt("session") ?? null, title, { directives: found.map(({ e }) => e.id), openedAt: new Date().toISOString() });
        console.log(`THREAD_DIRECTIVES discord:${id} ${found.length}: ${found.map(({ e, why }) => `${e.id} (${why})`).join(", ") || "none in scope"}; follow them in this thread's work`);
        for (const { e } of found) console.log(directiveLine(e));
        console.log(`THREAD_OPENED discord:${id}`);
        break;
      }
      // Marking a thread done by hand (thread done, thread set done) makes the same check as closing a lane (#47): while
      // another open lane or an open question card uses the thread, it is left as it is. The lane whose close runs this
      // (hooks.threadDone, which sets DORI_CLOSING_LANE, or --lane) is not another user. --force marks it done anyway.
      const holdersOf = async (thread: string): Promise<string> => {
        const closing = opt("lane") ?? process.env.DORI_CLOSING_LANE ?? "";
        const sharing = (await deps.registry.open()).filter((l) => l.key !== closing && l.thread === thread).map((l) => l.key);
        const cards = deps.openCards?.(thread) ?? [];
        const standing = threads(cardDir())[discordThreadId(thread)]?.standing === true;
        return [...(sharing.length ? [`open lane ${sharing.join(", ")} uses it`] : []), ...(cards.length ? [`open card ${cards.join(", ")}`] : []), ...(standing ? ["standing thread"] : [])].join("; ");
      };
      if (verb === "set") {
        if (!ref || (text !== "working" && text !== "waiting" && text !== "done" && text !== "standing" && text !== "unstanding")) die("usage: dori thread set discord:<id> working|waiting|done|standing|unstanding [--open-card] [--force]");
        if (text === "standing") {
          const id = discordThreadId(ref ?? "");
          standThread(cardDir(), id);
          // the queue shows it standing from here on, whatever status is asked
          console.log(`THREAD_STANDING discord:${id} ${await threadStatuses(discordClient()).request(id, "waiting")}`);
          break;
        }
        if (text === "unstanding") {
          const id = discordThreadId(ref ?? "");
          // false: released before and its rename may have failed, so it is asked again
          if (!unstandThread(cardDir(), id) && threads(cardDir())[id]?.standing !== false) {
            console.log(`THREAD_NOT_STANDING discord:${id}`);
            break;
          }
          // back to the normal rules: waiting unless a lane works there or a card is open
          console.log(`THREAD_UNSTANDING discord:${id} ${await threadStatuses(discordClient()).request(id, "waiting")}`);
          break;
        }
        const status = text === "done" ? "done" : flags.values["open-card"] ? "waiting" : text === "waiting" ? "waiting" : "working";
        const id = discordThreadId(ref ?? "");
        const holders = status === "done" ? await holdersOf(`discord:${id}`) : "";
        if (holders && !flags.values.force) {
          console.log(`THREAD_LEFT_OPEN discord:${id}: ${holders}; not marked done (--force marks it done anyway)`);
          break;
        }
        if (holders) console.log(`THREAD_DONE_FORCED discord:${id}: ${holders}; marking it done anyway`);
        if (status === "done") unstandThread(cardDir(), id);
        await threadStatuses(discordClient()).request(id, status);
        break;
      }
      if ((verb !== "reply" && verb !== "wait" && verb !== "done") || !ref) die("usage: dori thread <reply|wait|done> discord:<thread id> <text> | --text-file FILE");
      onlyOptions(`thread ${verb}`, ["text-file", "force", "lane", "again", "file"], 3);
      const filePaths = ((flags.values.file as (string | boolean)[] | undefined) ?? []).map((p) => (typeof p === "string" ? p.trim() : ""));
      if (filePaths.some((p) => !p)) die("SEND_FILE_REFUSED --file takes a path; nothing was sent", 2);
      let files: DiscordFile[] = [];
      try {
        files = await readDiscordFiles(filePaths);
      } catch (e) {
        if (!(e instanceof UploadRefused)) throw e;
        die(e.message, 2);
      }
      const body = files.length && !text?.trim() && !opt("text-file") ? "" : postable(await textOrFile(text?.trim(), "usage: dori thread <reply|wait|done> discord:<thread id> <text> | --text-file FILE (or --file PATH)"), `thread ${verb}`);
      const tooBig = discordMessageProblem(files, body);
      if (tooBig) die(tooBig, 2);
      const dc = discordClient();
      await ownerSpeech(body, `thread ${verb}`, () => ownerPlace(dc, discordThreadId(ref ?? "")));
      // keyed on the text as it is posted (postInThread removes emoji, review 10 of #338): for a text without emoji the
      // same key as `dori send discord --to <thread id>`, so the two commands do not post one text twice either
      const place = `discord:${discordThreadId(ref ?? "")}`;
      const threadOnce = (post: () => Promise<Sent>) => sendOnce(join(config.stateDir, "sent"), place, sendKey(["discord", discordThreadId(ref ?? ""), undefined, undefined, withoutEmoji(body), ...filesKey(files)]), post, { again: Boolean(flags.values.again) });
      if (verb === "done") {
        // the text is posted either way; with users left the thread keeps its mark and stays open
        const thread = `discord:${discordThreadId(ref ?? "")}`;
        const holders = await holdersOf(thread);
        if (holders && !flags.values.force) {
          const r = await threadOnce(() => postInThread(dc, ref ?? "", body, files));
          if (!r.duplicate) await notePost(discordThreadId(ref ?? ""), r.id, withFileNames(body, files));
          console.log(`${r.duplicate ? duplicateLine(place, r) : sentLine("POSTED", r)} THREAD_LEFT_OPEN ${thread}: ${holders}; not marked done (--force marks it done anyway)`);
          break;
        }
        if (holders) console.log(`THREAD_DONE_FORCED ${thread}: ${holders}; marking it done anyway`);
      }
      const statuses = threadStatuses(dc);
      // released after the post: a post that fails leaves a standing thread standing
      const mark = (t: string, s: ThreadStatus) => {
        if (verb === "done") unstandThread(cardDir(), t);
        return statuses.request(t, s);
      };
      // only the post is inside the repeat check, so it is recorded as soon as Discord made it; the status step comes after
      // (review 10 of #338: a slow status step left the post unrecorded past the claim's minute). A repeat is not posted,
      // but the status still goes through: a done after a reply with the same words still closes
      const r = await threadOnce(() => postInThread(dc, ref ?? "", body, files));
      await mark(discordThreadId(ref ?? ""), VERB_STATUS[verb as ThreadVerb]);
      if (!r.duplicate) await notePost(discordThreadId(ref ?? ""), r.id, withFileNames(body, files));
      console.log(`${r.duplicate ? duplicateLine(place, r) : sentLine("POSTED", r)}${verb === "done" ? " THREAD_DONE" : verb === "wait" ? " THREAD_WAITING" : ""}`);
      // wait and done still set their status, so only a reply that posted nothing exits as a repeat
      if (r.duplicate && verb === "reply") process.exitCode = SEND_DUPLICATE_EXIT;
      break;
    }
    case "handover": {
      const here = await currentTmuxSession(run);
      // the one-use grant of a run freshness started (auto hook); kept from the sessions and processes this run starts
      const autoGrant = process.env[AUTO_GRANT_ENV];
      delete process.env[AUTO_GRANT_ENV];
      if (key === "ack") {
        console.log(ackHandover(opt("state") ? resolve(opt("state") ?? "") : config.stateDir, flags.positionals[1]?.trim() || die("usage: dori handover ack <id> [--state DIR]"), here, new Date().toISOString()));
        break;
      }
      // the old lead frozen at a committed handover: list, resume one frozen by mistake, close one (or every due one)
      if (key === "frozen") {
        const recs = readFrozen(config.stateDir);
        console.log(recs.length ? recs.map(frozenLine).join("\n") : "FROZEN none");
        break;
      }
      if (key === "thaw") {
        const pane = flags.positionals[1]?.trim() || die("usage: dori handover thaw <pane>");
        const agent = readFrozen(config.stateDir).find((r) => r.pane === pane)?.agentPid;
        const thawed = thawFrozen(freezeDeps, config.stateDir, pane);
        // checked once resumed: the agent is again its tty's running foreground job, or is brought back to it
        const fg = agent && !thawed.startsWith("FROZEN_NONE") ? await resumeAfterThaw({ run, clock: realClock, signal: sendSignal }, pane, agent) : "";
        const line = fg ? `${thawed}; ${fg}` : thawed;
        watchLog(config.watchLog, realClock, { source: "handover", line });
        console.log(line);
        if (line.startsWith("FROZEN_NONE")) process.exit(1);
        break;
      }
      if (key === "close-frozen") {
        const pane = flags.positionals[1]?.trim();
        const rec = pane ? readFrozen(config.stateDir).find((r) => r.pane === pane) : undefined;
        if (pane && !rec) die(`FROZEN_NONE ${pane}: no frozen session recorded for this pane (dori handover frozen lists them)`);
        const lines = rec ? [await closeFrozen(freezeDeps, config.stateDir, rec)] : await closeDueFrozen(freezeDeps, config.stateDir, Date.now());
        for (const line of lines) watchLog(config.watchLog, realClock, { source: "handover", line });
        console.log(lines.join("\n") || "FROZEN_NONE_DUE");
        break;
      }
      // the audit after a committed handover, what a session reports it did not know, and the weekly summary (rollover-audit.ts)
      if (key === "audit") {
        const ref = flags.positionals[1]?.trim() || die("usage: dori handover audit <note.md|key|lead> [--dry-run] [--no-send] [--force]");
        const c = findCommitted(config.stateDir, ref.endsWith(".md") ? resolve(ref) : ref) ?? die(`HANDOVER_AUDIT_NONE ${ref}: no committed handover on record (a result.json with done, done-frozen, done-kept-old or kept-new-old-gone)`);
        const r = await auditHandover(laneDepsFor(), c, { dryRun: Boolean(flags.values["dry-run"]), noSend: Boolean(flags.values["no-send"]), force: Boolean(flags.values.force) });
        process.exit(r.code);
      }
      if (key === "gap") {
        const k = flags.positionals[1]?.trim() || die("usage: dori handover gap <key|lead> --kind KIND --text \"what the new session did not know\" [--fixed]");
        if (k !== "lead") await lane(k);
        const kind = opt("kind")?.trim() || die("--kind is needed: owner's words, decision, lead instruction, todo, goal, monitor, tried fix or other");
        const text = opt("text")?.trim() || die("--text is needed: one line on what was not known (a summary, no secret values)");
        const by = k !== "lead" && here && here === (await deps.registry.read(k))?.pane ? "lane" : "lead";
        console.log(reportGap(deps, k, kind, text, by, Boolean(flags.values.fixed)).line);
        break;
      }
      if (key === "audit-summary") {
        const days = opt("days") ? Number(opt("days")) : 7;
        if (!(days > 0)) die("--days must be a positive number");
        if (flags.values.send) {
          const week = summaryWeek(Date.now(), config.scorecard.timeZone || "UTC", config.handover.auditSummaryAt || "Mon 08:30") ?? die(`handover.auditSummaryAt "${config.handover.auditSummaryAt}" is not like "Mon 08:30"`);
          console.log(sendAuditSummary(deps, laneDepsFor().inbox ?? join(config.stateDir, "discord", "inbox.jsonl"), week));
        } else console.log(auditSummary(config.stateDir, Date.now(), days));
        break;
      }
      if (key === "ready" || opt("lane")) {
        const laneDeps = laneDepsFor();
        if (key === "ready") {
          if (flags.values.template) {
            console.log(SUMMARY_TEMPLATE);
            break;
          }
          const r = await markReady(laneDeps, await lane(flags.positionals[1]), here, process.pid, opt("note"));
          console.log(r.line);
          process.exit(r.code);
        }
        const minutes = opt("minutes") ? Number(opt("minutes")) : undefined;
        if (minutes !== undefined && !(minutes > 0)) die("--minutes must be a positive number");
        const waitIdle = opt("wait-idle") ? Number(opt("wait-idle")) : undefined;
        if (waitIdle !== undefined && !(waitIdle > 0)) die("--wait-idle must be a positive number of minutes");
        const r = await laneHandover(laneDeps, opt("lane") ?? "", here, { approvedBy: opt("approved-by"), ...(autoGrant ? { autoGrant } : {}), note: opt("note"), model: opt("model"), thinking: opt("thinking"), force: Boolean(flags.values.force), keepOld: Boolean(flags.values["keep-old"]), dryRun: Boolean(flags.values["dry-run"]), verifyMin: minutes, ...(waitIdle ? { waitIdleMin: waitIdle } : {}), ...(opt("request-at") && opt("request-pane") ? { serves: { at: opt("request-at") ?? "", pane: opt("request-pane") ?? "" } } : {}) });
        process.exit(r.code);
      }
      if (flags.values.template) {
        console.log(LEAD_SUMMARY_TEMPLATE);
        break;
      }
      // closing the old lead ends every process in its tmux session, so a handover started there continues as a user unit
      // and since the old lead is frozen at the commit (--keep-old too), it must not run under the agent it stops
      if (here && here === config.leadPane && !flags.values["dry-run"] && !process.env.DORI_HANDOVER_DETACHED) {
        const refused = windowsDetachRefusal();
        if (refused) die(refused);
        const unit = `dori-handover-${Date.now()}`;
        const log = join(config.stateDir, "handover", "run.log");
        mkdirSync(join(config.stateDir, "handover"), { recursive: true });
        const pass = ["PATH", "DORI_CONFIG", "DORI_STATE_DIR", "DORI_ENV_FILE", "DORI_LEAD_PANE", "DORI_DISCORD_INBOX", "DORI_DISCORD_STATE_DIR"].filter((n) => process.env[n] !== undefined).map((n) => `--setenv=${n}`);
        const r = await run(["systemd-run", "--user", "--collect", `--unit=${unit}`, "--setenv=DORI_HANDOVER_DETACHED=1", ...pass, `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`, process.execPath, import.meta.path, "handover", ...rest]);
        if (r.code !== 0) die(`HANDOVER_DETACH_FAIL ${r.err || r.out}`);
        console.log(`HANDOVER_DETACHED unit=${unit} log=${log}; progress also goes to ${config.watchLog}`);
        break;
      }
      const minutes = opt("minutes") ? Number(opt("minutes")) : undefined;
      if (minutes !== undefined && !(minutes > 0)) die("--minutes must be a positive number");
      const r = await handover(leadDepsFor((line) => console.log(line)), { approvedBy: opt("approved-by"), ...(autoGrant ? { autoGrant } : {}), note: opt("note"), title: opt("title"), model: opt("model"), keepOld: Boolean(flags.values["keep-old"]), dryRun: Boolean(flags.values["dry-run"]), noMonitors: Boolean(flags.values["no-monitors"]), verifyMin: minutes });
      process.exit(r.code);
    }
    case "rollover-propose": {
      const who = key === "lead" ? "lead" : "lane";
      const l = who === "lane" ? await lane(key) : undefined;
      const pane = l ? (l.pane ?? die(`lane ${l.key} has no pane`)) : config.leadPane || die("leadPane is not set");
      const model = l ? (l.model ?? config.defaultModel) : config.handover.model || config.defaultModel;
      const stuck = l ? stuckTop(l) : undefined;
      const signals = { ...(await paneSignals(laneDepsFor(() => {}), pane, model)), ...(stuck ? { stuck } : {}) };
      const h = config.handover;
      const hit = dueReasons(signals, limitsFor(who, h));
      const lines: string[] = [];
      const preview = l ? await laneHandover(laneDepsFor((line) => lines.push(line)), l.key, "", { dryRun: true }) : await handover(leadDepsFor((line) => lines.push(line)), { dryRun: true });
      const blockers = lines.filter((x) => x.startsWith("HANDOVER_REFUSED")).map((x) => x.replace(/^HANDOVER_REFUSED\s*/, "")).join("; ");
      const shown = [signals.contextPct !== undefined ? `context ${signals.contextPct}%` : "", signals.compactions !== undefined ? `${signals.compactions} compactions` : "", signals.afterCompactK !== undefined ? `${signals.afterCompactK}k after the last compaction` : "", signals.ageH !== undefined ? `${signals.ageH} h old` : "", stuck ? `stuck rung ${stuck.rung} on "${stuck.metric}" (${stuck.n} attempts)` : ""].filter(Boolean).join(", ");
      const text = h.proposalText.replaceAll("{who}", l ? `lane ${l.key} (${l.title})` : "the lead").replaceAll("{signals}", hit.length ? `${shown} (${hit.join(", ")})` : `${shown || "no signals"} (no threshold crossed)`).replaceAll("{note}", preview.note ?? "(no note)").replaceAll("{blockers}", blockers ? `. Blocked now: ${blockers}` : "");
      const run = `dori handover ${l ? `--lane ${l.key} ` : ""}--approved-by "${LEAD_PREFIX}<your reason>, ${(hit[0] ?? "<the signal>").replaceAll('"', "'")}"`;
      if (flags.values["dry-run"]) {
        console.log(`ROLLOVER_PROPOSAL_DRY_RUN ${who} ${l?.key ?? "lead"}: ${text}; to go ahead: ${run}`);
        break;
      }
      appendRollover(config.stateDir, { kind: "proposal", who, at: new Date().toISOString(), key: l?.key ?? "lead", pane, signals, crossed: hit, ...(preview.note ? { note: preview.note } : {}), blockers });
      console.log(`ROLLOVER_PROPOSAL ${who} ${l?.key ?? "lead"}: ${text}; logged. Your decision: to go ahead, ${run} (the owner is told afterwards)`);
      break;
    }
    case "rollover-stats": {
      const window = opt("window") ? Number(opt("window")) : 24;
      if (!(window > 0)) die("--window must be a positive number of hours");
      if (flags.values.stuck) {
        for (const line of [...stuckOutcomeLines(readRollovers(config.stateDir)), ...(await peerStuckLines(run, config.handover.statsPeers))]) console.log(line);
        break;
      }
      const watch = existsSync(config.watchLog) ? readFileSync(config.watchLog, "utf8").split("\n") : [];
      for (const line of rolloverStats(readRollovers(config.stateDir), watch, Date.now(), window)) console.log(line);
      break;
    }
    case "directives": {
      // the owner's message links of fork entries in this Dori's local ledger, and with --push to directives.linkPeers
      if (key === "links") {
        if (!flags.values.push) {
          console.log(JSON.stringify(linkRows(config), null, 2));
          break;
        }
        const r = await pushLinks(deps);
        for (const line of r.lines) console.log(line);
        if (!r.ok) process.exit(1);
        break;
      }
      const ledger = loadLedger(config);
      if ((key ?? "table") === "check") {
        const problems = ledgerProblems(ledger);
        for (const p of problems) console.log(`DIRECTIVES_BAD ${p}`);
        if (problems.length) process.exit(1);
        if (!flags.values.static) {
          const meaning = await checkMeaning(deps, ledger);
          for (const line of meaning.lines) console.log(line);
          if (!meaning.ok) process.exit(1);
        }
        console.log(`DIRECTIVES_OK ${ledger.entries.length} directives (${ledger.entries.filter((e) => e.layer === "common").length} fork, ${ledger.entries.filter((e) => e.layer === "local").length} local) in ${ledger.files.join(", ") || "no ledger"}`);
        break;
      }
      if (key === "apply") {
        const r = await applyDirectives(deps, await lane(flags.positionals[1] ?? die("usage: dori directives apply <key> [--dry-run]")), { dryRun: Boolean(flags.values["dry-run"]) });
        for (const line of r.lines) console.log(line);
        if (flags.values["dry-run"] && r.message) console.log(r.message);
        if (!r.ok) process.exit(1);
        break;
      }
      if (key === "prompts") {
        console.log(promptTable(ledger));
        break;
      }
      // what an owner message carries in the inbox row (the listener's hints), for a text the lead gives
      if (key === "hint") {
        const text = flags.positionals.slice(1).join(" ").trim() || die("usage: dori directives hint <text>");
        const hl = hintLedger();
        const found = textDirectives(text, hl).slice(0, HINT_LIMIT);
        for (const line of hl.skipped ?? []) console.log(line);
        for (const { e, why } of found) console.log(`DIRECTIVE_HINT ${e.id} (${why}): ${directiveLine(e)}`);
        if (!found.length) console.log("DIRECTIVE_HINT_NONE: no directive's keyword, kind of work or UI words in the text");
        break;
      }
      if (key !== undefined && key !== "table") die("usage: dori directives [table|prompts|check [--static]|apply <key> [--dry-run]|hint <text>|links [--push]]");
      console.log(ledgerTable(ledger));
      break;
    }
    case "directive-audit": {
      const since = sinceIso(opt("since") ?? "24h", Date.now());
      const r = await auditOrReport(deps, { since, inbox: auditInbox(), owner: process.env.DORI_DISCORD_OWNER?.trim() ?? "", threads: threads(cardDir()), memory: leadMemoryRepo(), dryRun: Boolean(flags.values["dry-run"]) });
      for (const line of r.lines) console.log(line);
      if (r.failed) process.exit(1);
      break;
    }
    case "lesson": {
      const lessons = new Lessons(config.stateDir);
      switch (key) {
        case "add": {
          const laneKey = flags.positionals[1] ?? die("usage: dori lesson add <key> --rule TEXT --evidence PATH [--cwd DIR]");
          // a closed lane may still add what it learned, so the registry is read directly, not through lane()
          const target = (await deps.registry.read(laneKey)) ?? die(`no registered lane "${laneKey}"`);
          console.log(JSON.stringify(lessons.add({ lane: laneKey, cwd: opt("cwd") ?? target.cwd ?? config.defaultCwd, rule: need("rule"), evidence: evidence() }, realClock.now())));
          break;
        }
        case "list": {
          const read = lessons.read(opt("cwd"));
          for (const problem of read.problems) console.error(`LESSON_WARNING ${problem}`);
          console.log(JSON.stringify(read.lessons, null, 2));
          break;
        }
        case "mark": {
          const id = flags.positionals[1] ?? die("usage: dori lesson mark <id> --outcome pending|helped|no-effect|harmful|encoded");
          const outcome = need("outcome");
          if (isLessonOutcome(outcome)) console.log(JSON.stringify(lessons.mark(id, outcome)));
          else die("--outcome must be pending, helped, no-effect, harmful or encoded");
          break;
        }
        default:
          die("usage: dori lesson add|list|mark");
      }
      break;
    }
    // The lead's record of owner requests, from upstream https://github.com/sisyphuslabs/dori-superagent/pull/96.
    case "worklog": {
      const worklog = new Worklog(config.stateDir);
      const id = () => flags.positionals[1] ?? die(`worklog ${key} needs an item id`);
      const text = () => flags.positionals.slice(2).join(" ").trim() || die(`worklog ${key} needs text`);
      const now = realClock.now();
      switch (key) {
        case "add":
          console.log(JSON.stringify(worklog.add(flags.positionals.slice(1).join(" ").trim() || die("worklog add needs a title"), need("source"), now)));
          break;
        case "next":
          console.log(JSON.stringify(worklog.next(id(), text(), now)));
          break;
        case "note":
          console.log(JSON.stringify(worklog.note(id(), text(), now)));
          break;
        case "close":
          console.log(JSON.stringify(worklog.close(id(), need("result"), now)));
          break;
        case "list": {
          const read = worklog.read();
          for (const problem of [...read.problems, ...read.warnings]) console.error(`WORKLOG_WARNING ${problem}`);
          console.log(JSON.stringify(flags.values.open ? read.items.filter((item) => item.closedAt === undefined) : read.items, null, 2));
          break;
        }
        default:
          die("worklog needs add, next, note, close or list");
      }
      break;
    }
    case "checkpoint": {
      const target = await lane(key ?? die("checkpoint needs a lane key"));
      // parseArgs takes one value per flag; a second bare receipt would otherwise be dropped and its effect repeated later.
      const stray = flags.positionals.slice(1);
      if (stray.length) die(`checkpoint: unexpected argument ${stray[0]}; give each receipt its own --remote-effect`);
      const result = new Checkpoints(config.stateDir).write(target.key, {
        step: need("step"), result: need("result"), evidence: [evidence()], remoteEffects: many("remote-effect"),
      }, realClock.now());
      console.log(JSON.stringify(result));
      break;
    }
    case "caps": {
      const l = (key ? await deps.registry.read(key) : undefined) ?? die(`usage: dori caps <key> [--wall-minutes N|none] [--token-limit N|none] [--cost-limit N|none]; no registered lane ${JSON.stringify(key ?? "")}`, 2);
      const set = budgetOpts();
      if (Object.keys(set).length) await deps.registry.patch(l.key, { budget: { ...l.budget, ...set } });
      const now = (await deps.registry.read(l.key)) ?? l;
      const caps = laneLimits(config.supervision, now);
      const show = (v: number | null): string => (v === null ? "off" : String(v));
      console.log(`CAPS ${l.key} wallMinutes=${show(caps.wallMinutes)} tokens=${show(caps.tokens)} costUsd=${show(caps.costUsd)} (its own: ${JSON.stringify(now.budget ?? {})})`);
      if (Object.keys(set).length) console.log(`CAPS_SET ${l.key}: the next freshness sweep reads them; a cap reached tells the lead once, again only after the cap changes`);
      break;
    }
    case "checkpoints": {
      if (!key || !(await deps.registry.read(key))) die("checkpoints needs a registered lane key");
      console.log(JSON.stringify(new Checkpoints(config.stateDir).read(key ?? ""), null, 2));
      break;
    }
    case "transcribe":
      console.log(await transcribe(run, config.hooks.transcribe, key ?? die("transcribe needs an audio file path")));
      break;
    default:
      console.log(USAGE);
      process.exit(command ? 1 : 0);
  }
} catch (e) {
  if (e instanceof LeadError || e instanceof LaunchError || e instanceof UnsafeMessageError || e instanceof MessengerError || e instanceof TranscriptionError || e instanceof QuestionError || e instanceof ThreadRefError || e instanceof LaneStateError || e instanceof ScorecardError || e instanceof TreeError || e instanceof ChallengeError || e instanceof GateRefusal || e instanceof ForkError || e instanceof DirectiveError || e instanceof HeavyJobError || e instanceof CheckpointError || e instanceof LessonError || e instanceof WorklogError) die(e.message);
  throw e;
}

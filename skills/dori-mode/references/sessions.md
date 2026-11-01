# Sessions (lanes)

A lane is one agent session doing one job in its own herdr tab, or its own aoe session with `backend: "aoe"` (see "The aoe backend" below). You launch it, track it in the registry, answer it when it is stuck, and close it when its work is proven done.

## Launching

```sh
dori launch fix-login --title "Fix the login redirect loop" \
  --brief ~/briefs/fix-login.md --done "merged acme/app#412; closed acme/app#398" \
  --thread "telegram:<chat>/<topic>" --model anthropic/claude-opus-5-5
```

`launch` checks the key and the `Done =` line, appends a footer to the brief, opens a tab in `laneWorkspace`, starts the agent, and after 20 seconds reads the pane for startup errors (missing module, no API key, rate limit, quota). On `STARTUP_ERROR`, relaunch on another model.

Write the brief like a careful prompt, on this template. The four fields and the eight steps are the owner's shared prompt for big tasks (2026-10-14): fill in the four fields, keep the steps as written here, and put the lane's own lines under them. Each step carries the owner's original prompt (owner, 2026-10-14 21:09 KST) with its typos and spacing corrected and its repeats merged (owner, 21:27 and 21:29 KST): every point and its strength (타협 없이, 1:1 100%, 예외 없이 핑계 없이, the end user, 이유와 함께, plan approval, set goal and mass-ulw) stays as written here, never dropped or softened; a line in parentheses says how a step meets one of the rules below. A small fix keeps the same frame and the same eight steps; only the lane's own lines get shorter.

```text
ulw

[목표] (한 줄)
[끝난 상태] (눈으로 확인되는 상태 한 줄)
[사용자와 장면] (이 결과를 실제로 쓸 사람 한 명 + 그 사람이 겪는 장면 하나)
[넘으면 안 되는 선] (2~3개, 없으면 "없음")

1. 조사: 결정을 위한 정보를 ulw explore로 모두 수집하라. explore(코드·파일·로그)와 librarian(외부 문서·라이브러리)을 적극 활용하라.
2. 이상적인 상태: 제품을 사용하는 최종 사용자(코드가 되었건, 다른 프로그래머가 되었건, 실제 고객이 되었건 이 결과물이 영향을 줄 사람)를 명확히 하고, 그가 어떻게 쓰며 무엇을 더 낫게 할지 상상하라. 걸리거나, 이상하거나, 리그레션·경험 열화가 일어나지 않는 가장 이상적인 상태를 정의하라. ([사용자와 장면]에는 그중 대표 한 사람과 장면.)
3. 차이: 그 상태와 현재의 차이점을 모두, 차이마다 근거(파일, 출력)와 함께 나열하라.
4. 계획과 QA: 그 상태가 되기 위한 계획과 검증할 QA 시나리오를 타협 없이 세우라. QA는 테스트 통과가 아니라 실제 화면·호출·출력. 2~4단계는 모두 구체적이고 논리적으로 이유와 함께 나열하라.
5. 실행: 그 내용대로 타협 없이 구현하라. set goal and go mass ulw loop(필요하면 workflow를 도구 삼아 여러 개). 서로 독립적인 일은 unspecified-low 대신 quick으로 잘게 쪼개 동시에 돌리고, 검증은 더 빡세고 엄격하게.
6. 대조: 이상적인 상태와 1:1 100% 동일한지 QA 시나리오로 항목별로 확인하고, 아니면 예외 없이, 핑계 없이 3번부터 다시 하라.
   (재시도 상한이 먼저다: 같은 지표에서 정한 횟수만큼 실패하면 다시 계획하는 대신 | blocker |로 남은 차이를 그대로 보고한다. 새 계획이 실패 횟수를 되돌리지 않고, 그 보고는 핑계가 아니다.)
7. 기록: $ulw-plan처럼 상세히 적어 체크하고, todo 상태를 항상 업데이트하며 보고하라. plan approval은 모두 허가하니 더 이상 질문하지 말고 바로 진행하라.
   (질문은 [넘으면 안 되는 선]을 넘어야 하거나 오너만 정할 수 있는 선택일 때만 | question |으로 보고한다.)
8. 보고: [끝난 상태]와 QA 항목마다 증거(캡처, 출력, 파일 경로)를 붙여라.

(lane마다 따로 적는 줄: 위치, 지금까지 아는 것, 형 말과 원문 링크, 할 일)
```

How the fields carry what a brief always needs:

- **Keywords.** The template opens with `ulw`; add any other keywords you would type yourself (for example `ulw set goal and work`).
- **The eight steps are guaranteed.** `dori launch` checks the brief for the step headings (`1. 조사:` ... `8. 보고:`). With none of them it puts the block above, as written here, right after the four fields (after the `ulw` line when there are no fields) and prints `LAUNCH_STEPS_ADDED` and a watch-log line; with all eight it changes nothing; with only some it adds nothing and prints `LAUNCH_STEPS_PARTIAL` with the missing numbers, so an edited frame stays as the lead wrote it. Change the steps here, never in the code: launch reads them from this file.
- **The owner's directives are guaranteed.** The directive ledger (`references/directives.json` in the fork, plus the host's `directives.local`) holds his standing directives with his words, date, source and scope. `dori launch` decides what the brief is about (`--ui` or UI words, a kind of work such as learning, GPU, release or autophagy, the repo of `--cwd`, keywords; quoted words, directive names and scope labels are left out) and adds each directive in scope the brief lacks under `## 형 지침 (지침 장부에서 dori launch가 넣음)` (`LAUNCH_DIRECTIVE_ADDED`): the owner's directive as its `prompt` under `[형 지침 <id>, <date>]` (his words rewritten by the lead as a directive: no question, every condition, target and strength kept, nothing added; the eight steps and the UI steps stay as he wrote them), never a summary; a rule the lead set as `[리드 규칙 <id>]` and that rule. A required one the brief does not meet (the four fields) stops the launch (`LAUNCH_DIRECTIVE_MISSING`, exit 4, nothing opened): write it in, or pass `--waive <id> "<reason>"` when it really does not fit; the waiver goes to the watch log, the registry and the owner. Change a directive in the ledger, never in the brief template or the code. A lane launched before a directive was in the ledger gets it with `dori directives apply <key>` (one `[LEAD]` message, then a `## 추가 지침(리드, launch 뒤)` section in its brief). An inject entry with `via: <id>` stays in the ledger and in scope but goes into a brief as that one pointer entry (for example a lead rule that names the repo's `AGENTS.md`, where those rules are written in full): the pointer in a brief counts for every entry that names it, `dori directives apply` and owner-check ask for the pointer only (not of a brief that already has every entry naming it as their own texts, a lane launched before the pointer), and a retired pointer lets the entries go in as their own texts again.
- **UI work.** When the owner asks for UI work (a screen, a design, a dashboard, a page, an app's UI), launch with `--ui`: the owner's seven UI steps (`references/ui-work.md`) go right after the `ulw` line, above the four fields, as written there. `LAUNCH_UI_HINT` means the brief reads like UI work and `--ui` is missing; the steps go in anyway (directive `ui-steps`).
- **[목표]** is the owner's request in one line; launch with `--goal "<the owner's words>"` as well, so the owner check reads them.
- **[끝난 상태]** is a state someone can see, written as the person sees it. The `Done =` line is the machine check that backs it (see the table below): pick the signal that reads the closest thing back live, and keep the end state as it is rather than narrowing it to what a signal can read.
- **[사용자와 장면]** is the ideal end state from the point of view of whoever uses the result: one person, one moment.
- **[넘으면 안 되는 선]** is what not to touch. When the lane could reach a live node or service, name it here: the lane must not experiment on it and tries on a scratch copy first. "없음" is right only when nothing like that is in reach.
  학습 노드 GPU: on a node whose GPU runs training, name the GPU here as well: the lane and every test, measurement or subagent it starts stay off it. `launchEnv` (`{"CUDA_VISIBLE_DEVICES": ""}`) hides it from lane sessions by default; launch a lane that needs it with `--use-gpu`. It does not reach omo task subagents (senpi's RPC host drops it; `scripts.md`, "Backend aoe"), so on such a node say in the brief that GPU-capable work (tests, measurements, models) runs in the lane's own tools, not in a subagent.
- **Proceeding without asking.** Plan approval is given in advance (step 7): inside the lines the lane does not ask. It reports a `| question |` only to cross a line or for a choice only the owner can make.
- **Evidence is the real thing.** Steps 4, 6 and 8 mean the real screen, the real call, the real output, not a passing test suite. The tests the repository keeps stay green as well, and for a code change a mutation shows they catch the bug; they back the proof, they are not the proof.
- **Under the steps:** where the code is and what has been learned so far, the owner's words with the link to his message, and the concrete steps you already know (for example tests, docs, PR, `dori challenge`, merge, update).
- when the work is the same as or continues earlier work, the thread it already has: launch with `--thread` on that ref instead of opening a new thread (`references/operating-lessons.md` #17); new long work the owner asked for gets `--thread new` (launch opens it in your own channel; when it prints `LAUNCH_RELATED_THREAD` lines instead, the work likely belongs to one of those threads: continue with `--thread <ref>` of the first, and only for other work add `--why-new "<reason>"`, #31), and only a lane the owner did not ask for goes without one, with `--no-thread "<reason>"`; a launch with neither is refused (`LAUNCH_NO_THREAD`, #30);
- when the work adds a feature (a command, flag, hook, service or rule), which existing feature does the same job and why it cannot be fixed instead (`references/operating-lessons.md` #18);
- how and when to report: the footer `dori launch` adds gives the `[REPORT]` line, the `Done =` line and `dori claim-done`; ask for times in the owner's time zone when it is not the machine's;
- before a big step (one that costs hours or a GPU queue, or changes the approach), a `dori challenge` of the plan; launch with `--challenge-before` to require it;
- that big memory work (a large model, a long GPU run) goes through `dori heavy <label> --mem <estimate> -- <command>`, never inside the lane's own process (its eval kernel or its shell), the same rule as the ledger's heavy one: there a job over its memory dies alone in its own scope, inside the lane it takes the lane down with it (the footer says this to every lane); heavy browser, CPU or build test bundles go through `dori heavy <label> --kind browser|cpu --sync <dir> ... -- <command>` rather than hand-made core locks, so the less busy of both PCs runs them (the footer says this to every lane too);
- that the docs and tests of what the lane changes change with it;
- when the lane makes or changes a yardstick (a metric, a threshold, a pass/fail check), one line on how that yardstick could get better while the real goal gets worse;
- that a blocker, an impossible task or an ambiguous request is a fine report (`| blocker |`), not a failure to hide;
- a retry cap: after a set number of failed attempts at the same step (two or three), report a blocker instead of trying again. Step 6 loops back to a new plan, but a new plan or hypothesis does not reset the count: the cap and the stuck ladder count failed attempts per metric, and they win over step 6's loop back and its 예외 없이, 핑계 없이: a blocker at the cap reports the gap that is left, it is not an excuse.

**Why the `Done =` line has to be checkable:** the watcher closes lanes on its own, so it can only trust what it can read back itself. `launch` and `adopt` refuse any signal outside this list. Signals are joined with `;`, and every one has to pass.

| Signal | Passes when |
|---|---|
| `merged <owner/repo>#N` | the PR is merged and has a merge commit |
| `closed <owner/repo>#N` | the issue is closed |
| `published <pkg>@<version>` | npm has that exact version |
| `command ["argv","as","json"] [stdout~"regex"]` | the command exits 0 when the watcher runs it, and stdout matches if a regex is given |
| `file <path> [sha256=<hex>] [json:.a.b=<json value>]` | the file exists, its sha256 matches, and the JSON field equals the value |
| `url <http(s) url> [status=200] [body~"regex"]` | a GET returns that status, and the body matches if a regex is given |

The last three are for work that never lands as a PR: a local setup, a QA pass, a running service. Write the check so that it can fail. `command ["bun","test"] stdout~" 0 fail"` is a real check, while `command ["true"]` checks nothing. The watcher runs commands itself, in the lane's directory, as a plain argv with no shell. They have a 2-minute limit. It never trusts the lane's own report that something passed. Relative file paths resolve from the lane's directory, and `~` is your home. JSON values compare as JSON, so `json:.n=3` and `json:.n="3"` are different checks.

Example for a QA-only lane:

```
Done = command ["bun","test"] stdout~" 0 fail"; file qa/report.json json:.passed=true; url http://localhost:3000/health body~"ready"
```

Work no script can check (a design review, a judgement call) stays in the lane's own plan. You judge it yourself before the claim.

**When the plan changes after launch,** the `Done =` line can go stale: the work is done, but the signal still looks for what the old plan would have made, so `dori close` keeps refusing. Change the line, never skip it: `dori done-set <key> --done "<signals that fit the plan now>" --reason "<what changed and who decided>"`. It reads the new signals once and prints the result, keeps the earlier line in the lane's record, writes a `DONE_SET` line to the watch log, updates the brief's footer and tells the lane. The lane then closes the usual way, only when every new signal reads back live.

**Measure behavior, not files.** A Done line that only proves files exist or contain some text lets a lane pass without the thing working. `launch` prints `LAUNCH_DONE_WEAK <key>: ...` when every signal is a `file` signal or a command that only reads files or text (`grep`, `test`, `cat`, `ls`, `wc`, `jq` and the like, given directly, through `sh -c`, or in a shell script it can read). Add at least one signal that runs the thing: its tests, a command that exercises it, a `url` with the expected status and body. The lane still launches; pass `--done-weak-ok` when a file really is the deliverable (a report, a dataset).

## Repeated fixes

Fixing the same symptom again and again on the same idea burns tokens without moving. A lane tags a report that is a fix attempt with `(fix: <metric> / <hypothesis>)`, e.g. `[REPORT] e7 | milestone | raised the reward again (fix: deadlock count / reward too small)`. When you re-instruct a lane to fix something, record it yourself:

```sh
dori fix-attempt e7 --metric "deadlock count" --hypothesis "reward too small"
```

Each attempt is one step of the stuck ladder (next section). The tagged count is conservative: metric names must match (case and spacing aside, or through `autoSignals.aliases`), a report read again is not a new attempt, and a fix you asked for that the lane then reports counts once. Lanes rarely tag, so freshness also infers attempts from the lane's reports, commits and tree (a gate line that failed and was re-targeted by a new prescription); the ladder uses the larger of the two counts. The lane is never stopped.

Before you re-instruct a lane, read its record: `dori signals --lane <key>` (or `--cwd <repo>`, `--tag <topic>` for the whole area). It lists the numbered attempts the lane and you already made ("adjustment 1" .. "adjustment 4", read from the `[REPORT]` lines and your messages to it), whether and when the work switched to a root-cause hunt, the fixes by metric and hypothesis, rejected done claims with their reasons, and how often you re-sent or the sweep nudged. A fix on that list is not a new idea; after two failed patches on one metric, ask for the root cause instead of a third. `dori fix-attempt` prints the same per-metric list (`PRIOR_FIX`) before it records, and `dori launch` puts a short version into a new lane's brief as "Past signals" so the next lane in that repo or topic starts from it.

## Stuck: branch, look outside, check intent

Counting repeated fixes stops the same patch; it does not say what to do instead. One ladder per metric does: the failed attempts since the last PASS or `--improved` (the larger of the tagged and the inferred count) give the rung, and each rung change prints one line for you, `STUCK <key> "<metric>" rung N (tagged t, inferred i, hypotheses h[, fixated]) -> <what to do> [old names]`. Rung 2 (`stuck.hypothesesAt`, the 2nd attempt) is step 1 below; rung 3 (`stuck.researchAt`, the 3rd) is steps 4 and 5 together, in the same session; rung 4 (a failure after rung 3, one hypothesis tried `stuck.fixatedAfter` times after branching, or an owner-check finding still there after a re-read you confirmed) is where a new session may help: you decide (`references/rollover.md`). When a fix did not move a metric, the next step is to find out which explanation is true:

1. **Branch.** At rung 2, `dori fix-attempt` refuses unless you give at least three competing hypotheses, each with one cheap experiment whose result tells it apart from the others (`--hypotheses H --test T`, repeated). Make them really compete: reward, exploration, value estimate, the setup itself, not three versions of one idea. The lane runs the tests before any patch. `--improved` when the last fix did move the metric; `--no-hypotheses "<reason>"` when you go on anyway, which is logged.
2. **Run the branches side by side** when the tests are short: `dori fork-explore <key> --metric M --hypotheses ... --test ...` runs one bounded task per hypothesis, queues GPU ones on the heavy slot, and prints one comparison table.
3. **Keep the tree.** Every attempt, hypothesis and result lands in the area's hypothesis tree (`dori tree`), and every new brief in that repo or tag gets its compact form next to Past signals, so the next lane starts from what was falsified instead of retrying it.
4. **Look outside.** At rung 3 (the third failed attempt, tagged or inferred), the lane gets an instruction to search papers, issues and repos for the exact symptom (`dori research-hint <key>` writes the search plan), to record findings in the tree, and to have its next plan challenged before the next patch. The instruction is typed as `ulw research <question>`, so omo runs it as an ultra research, with the question built from the lane's symptom, attempts, falsified and open hypotheses. Within `explore.researchVerifyMin` the lane's session log must show the skill pointer and a read of its SKILL.md: `RESEARCH_STARTED`, else `RESEARCH_NOT_STARTED` in the watch log (re-send with `dori research-hint <key> --send`).
5. **Challenge big steps.** Before a step that costs hours or a GPU queue, changes the approach, or follows a falsified hypothesis, have the lane run `dori challenge <key> --plan FILE`: a model of another family lists why it will fail, what alternatives are missing, and the cheapest test that would show it. Launch such lanes with `--challenge-before "<step>"`; their done claim is refused until a challenge is on record.
6. **Check the owner's intent at stage changes.** Launch with `--goal "<the owner's words>"`. Lanes run `dori intent-check <key> --direction ... --next ...` at each stage change (the footer says so): it records the direction and has the owner check read it against the brief and the owner's words at once. When a milestone report announces a new stage or phase, freshness checks that lane first. In a thread several lanes share (the related-thread rule), the check takes the owner's messages there as this lane's only when something ties them to it (a `[LEAD]` relay or brief link to it, a reply to its post or card, its card's answer, its key named, or no other lane open then); relay an owner message with its link to the lane it is for, and a finding that rests on a message for another lane, or for none, is `OWNER_CHECK_SHARED` with no rung. A finding is the ladder's context rung (`STUCK <key> "@context" rung context`): confirm it, then `dori owner-check <key> --reread` sends the lane its brief and the owner's words to re-read; a finding still there after that re-read is rung 4.

## The registry

One JSON file per lane under `<stateDir>/lanes/`, written atomically (temp file + rename), so two writers never leave a half-written file. Each lane records:

| Field | Meaning |
|---|---|
| `thread` | where its updates go, as `platform:thread` (or `none`) |
| `pane`, `tab` | its herdr location; with aoe, `pane` is the session's tmux name (`aoe_<title>_<first 8 of the id>`) and there is no tab |
| `session` | the agent's own session id, so a closed job can be reopened later |
| `status` | `working`, `done-claimed`, `verified-done`, `not-done`, `closed` |
| `claim`, `objection`, `history` | what was claimed, what was objected, every status change |

`dori sync` compares the registry with live panes and prints drift (a pane that is gone, a session id that changed, an empty `Done =` line). It never deletes anything. With `--write` it stores the session ids it found.

How the session id is found for a pane, in order:

1. the agent process's `--session <id>` argument;
2. `PI_SESSION_ID` in the environment of one of its child processes;
3. the session file whose timestamp falls within three minutes after the agent process started.

The id from step 1 is the session the agent was launched with. If someone switches sessions inside the agent, only steps 2 and 3 notice.

When the owner writes in a closed lane's thread, reopen its recorded session in a new tab, set its monitors again, and keep replying there. A monitor whose command starts work (a chain, a job, a post) is set again as a watch-only one that tails what that work writes, never as the same command: that would start the work a second time.

## Messaging a session

Before you type into a pane:

1. check it runs a live agent (`herdr pane process-info --pane <id>`), not a shell, a stopped agent or a startup screen;
2. read it (`herdr pane read <id> --source recent-unwrapped --lines 40`) and confirm the input line is empty and no approval or question prompt is open;
3. send with `dori type <pane> --text "<text>"` (or `--text-file FILE` for a long one): it types the text as one argument, presses Enter, waits for the input box to be empty (one more Enter if not) and for a running turn, and prints `SUBMITTED` or `NOT_SUBMITTED <reason>` (exit 1, also in the watch log). Every script that types into a pane uses the same check;
4. on `NOT_SUBMITTED`, read the pane before typing again: the text may still be in the box. A text for a pane a handover froze goes to the session that replaced it (`FORWARDED <old> -> <new>`); a stopped agent with no such record gets nothing typed. A lane whose main turn only waits on its children may hold the text undelivered (`... not in the session's transcript ...`): it arrives when that turn ends, so a second copy can arrive too.

Exit code 0 of a send and echoed input are not proof the agent got the message. The input box is the lines between the last two `─` borders, not only the `❯` line, and ends where the borders end (senpi's side panel on the same rows is not part of it): a long or multi-line text folds into `[paste #1 +13 lines]`, and a tall box scrolls its `❯` line out of view. A reply from the session, or its record of handling the message, is the final proof.

With aoe the same steps read: `aoe ps --json` shows the session's state (`waiting` means a question or approval is open), `tmux capture-pane -p -J -t =<name>:` reads it, the input box sits between the last two `─` borders with its `❯` line, `esc to interrupt` on or above the top border means a turn runs, and `dori type` sends text with `tmux send-keys -t =<name>: -l -- <text>` followed by a separate `Enter`. The `=` and trailing `:` make tmux match the exact session name; an empty name would hit whatever pane you are in. Lanes and you type through `dori type` only, never a raw `send-keys`: a long text folds into a paste and an Enter right after it can be lost, which only `dori type` notices.

## Watching

- Sessions that turn blocked or ask a question: answer them or bring them to the owner.
- Sessions that report a bug: reproduce it before it counts, then give it its own thread.
- `dori dead-panes` reports agent panes that stopped; restart the session in place (`<agent> --session <id>`) unless its work is finished.
- With aoe, `dori watch` also prints `LANE_BLOCKED <key> <state> <pane>` once each time a working lane's agent stops for a human. `state` is `waiting` or `error` (from `aoe ps --json`), `question` (omo's question UI is open on screen; aoe shows that as `idle`), or `idle` (the turn ended and stayed ended for 45 seconds, and nothing is set to wake it: no `◉ watching` monitor, `wake source`, `goal continues in` or `Pursuing goal` on its status line, and no detached eval cell, background bash session or background task it started is still running according to its session transcript; such a lane is a quiet `BG_WAITING` line in the watch log, and `LANE_BLOCKED … idle` only after `blockedWaitMin` minutes, 60 by default). It never fires while the screen shows a running turn (`esc to interrupt`): aoe's state lags behind omo, so the screen decides.
- With aoe, `dori watch` also prints `LANE_AUTOTURN_PAUSED <key> <pane> ...` once when omo paused a lane (working, not-done or `dori pause`d) or the lead after 150 turns it started on its own since the last typed message (goal continuations and monitor notifications count). It types one short message that lifts the pause, at most `autoturnResumeMax` (3) times per session in 24 hours, then only reports; the setting is `engineTurns.maxPerUserInput` in omo's settings. The lead's own pause and runaway alerts (`LANE_AUTOTURN_LONG lead`) are also posted to the pair channel and the owner's channel (`LEAD_RUNAWAY` / `LEAD_AUTOTURN_PAUSED`), so the other Dori checks on it once and the owner sees it; a lane's stay with its lead. A lane that waits for a set time (a morning check) waits on one monitor gate for it rather than letting goal continuations or frequent wakes spend turns. With that limit off (`maxPerUserInput: 0`) nothing pauses, and the watch prints `LANE_AUTOTURN_LONG <key> <turns> <last user message time>` every `autoturnLongTurns` (300) turns a session started on its own since its last user message; the lead reads it as a possible runaway and decides.
- With aoe, `dori watch` also types a question-card answer into the session that asked (the card's tmux, else the lead) when that session's transcript never got it, for example because the inbox monitor's event came during a context compaction: `[DORI] ANSWER <Qn> ...` once, and `CARD_ANSWER_REDELIVERED <Qn> <pane>` in the watch log (`references/scripts.md`).
- With aoe, `dori watch` also tells the owner, without a model, when the lead's model calls fail while his message waits (a usage limit: `LEAD_LIMIT_NOTICE` with the retry time, then `LEAD_LIMIT_CLEARED`), and types `[DORI] LEAD_OWNER_WAITING ...` into the lead pane when his message has had no working reply for `leadWakeMin` (10) minutes; once the retry time of a usage-limit error has passed and an account is free again, it types `[DORI] 한도 풀림 — 하던 일 이어가. ...` once into the lead and into each working (not paused) lane whose newest reply is that error (`LIMIT_RESUME_WOKE`; `references/scripts.md`).
- With aoe, `dori watch` also tells you when an open lane's session dies (its pane dead or its tmux session gone on two checks, within about a minute): `LANE_DIED <key> <pane>: <why>` in the watch log and `[DORI] 레인 <key> 꺼짐(<이유>) — 이어서 살릴지 정해` once in your pane, `메모리 부족` when the journal shows an OOM kill in its scope. Decide whether to revive it (`dori handover --lane <key>` or a restart in place) and tell the owner only what he needs; it is not sent to him (`references/scripts.md`).
- With aoe, `dori watch` also starts the lead again when its tmux session is gone or its pane is dead for `leadReviveMin` (2) minutes: `self-restart.sh --start` in its own user unit resumes the same conversation and types `[DORI] LEAD_REVIVED ...`, and the owner gets `discord.leadDownText` once from this Dori's bot (`LEAD_DOWN`, `LEAD_REVIVE_STARTED`, `LEAD_DOWN_NOTICE`, `LEAD_UP`; `references/scripts.md`).
- A lane never tests against the live tmux server or the real aoe state. Every pane runs with `$TMUX` set to the default socket, and tmux takes the socket from `$TMUX` before `TMUX_TMPDIR`, so `TMUX_TMPDIR=<tmp> tmux kill-server` (or any server command without `-L`/`-S`) inside a pane hits the server every Dori session runs on (2026-10-22 18:23 KST: one lane's QA cleanup killed the lead and four other sessions this way). A test server gets `tmux -L <name>` or `-S <socket>` on every call, including its cleanup; an aoe experiment runs with a temporary `HOME` (aoe keeps its state in `~/.config/agent-of-empires`); a fake lead is a session on such a test server. `setups/discord-aoe/tmux-guard`, linked as `~/.local/bin/tmux`, refuses a `kill-server` aimed at the live server with `TMUX_GUARD_REFUSED` and lets one on any other socket through, with or without `$TMUX` in the shell.

## The aoe backend

Set `"backend": "aoe"` in `~/.dori/config.json` to run lanes as aoe (agent-of-empires) sessions on tmux instead of herdr tabs. Everything above holds; these parts differ:

- **Launch** runs `aoe add <cwd> -t <key> --tool <agentCommand[0]> -l --extra-args "--model <model>"`, waits up to 3 minutes for the agent's `❯` prompt, then types the lane prompt and checks it left the input line. With `launchEnv` set the session starts with those variables (through tmux `update-environment`; see `scripts.md`, "Backend aoe"), unless the lane was launched with `--use-gpu`; handovers and `self-restart.sh` keep the lane's choice, and `dori set-gpu <key> on|off` changes it. The session always gets node on PATH, even when the launcher (a systemd unit, a timer) has a bare PATH: nvm's node is added when the caller has none (`scripts.md`, "Backend aoe"), and with no node at all the launch is refused (`NO_NODE`). The aoe title is the lane key. aoe refuses a title and path pair that already exists, even in its trash; `aoe rm <id> --purge` clears it. aoe takes the agent as `--tool omo`; `--cmd omo` is refused. `aoe session set-session-id` is refused for omo ("wrapper execution identity is unknown"): to start a session on a known omo session, pass `--extra-args "--session <id>"`.
- **Pane ids** are tmux session names. `dori adopt <key> --pane aoe_<title>_<id8>` registers a running session; `tmux ls` lists them (`aoe_term_*` are plain terminals, not agents).
- **Report shape.** A lane's report to its lead (typed into the lead's pane, which the owner does not read) is `[REPORT] <who> | <milestone|blocker|question|done> | <one plain line: what is done, and what the owner has to do if anything>` with ids, paths, hashes, numbers and links on the lines below (owner Q302, 2026-10-20 00:34 KST: "머리([REPORT] 누가|상태)는 두고 바로 뒤 사람 말 한 줄 먼저, 근거(id·경로·지문)는 아래로"). A `(fix: <metric> / <hypothesis>)` tag stays on the first line: `dori signals` and the stuck ladder read only that line, and `dori freshness` reads it with the lines that follow up to the next blank line. In the pair channel, which the owner reads, a Dori writes without the head, one or two sentences as to a colleague, still saying what is done, one thing the reader can check and what is left or needed (owner Q304, 2026-10-20 01:03 KST: "도리방은 머리 없이 사람처럼 한두 문장, [REPORT] 머리는 형이 안 보는 lane→리드 보고에만"); the listener takes such a post as a `pair-bot` row whatever its shape.
- **Reports.** The footer tells the lane to send `[REPORT]` lines to the lead's tmux session with `dori type` as an argv array (`["dori","type","<lead>","--text","<line>"]`), which checks the lead took it (`SUBMITTED`). The report lands in the lead's pane, not the lane's, so `dori freshness` reads the lead pane (last 3000 lines) first and the lane's screen second. A report it has not seen before counts as hearing from the lane.
- **Claim from inside a lane.** `dori claim-done` without a key finds the lane by the tmux session it runs in.
- **Close** stops the session (`aoe session stop`) and moves it to the aoe trash (`aoe rm`), where it can still be restored. It never purges.
- **Blocked lanes** come from `aoe ps --json` plus the screen check, as `LANE_BLOCKED` lines from `dori watch`.
- **Startup errors.** An agent that exits at once (a bad model name, a missing module) leaves a dead pane with no prompt; `launch` reports its message as `STARTUP_ERROR` as soon as it is on screen instead of waiting out the 3-minute prompt timeout.

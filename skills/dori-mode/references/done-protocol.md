# Lane done protocol

Give this file to every lane you launch.

When your lane's `Done =` signals are live and every change is pushed, claim done from your own session. The signals might be a PR merged, an issue closed or a version published. For local or QA-only work they can also be a command that passes, a file with the expected content, or a URL that answers (see `sessions.md`). Run them yourself first: the watcher re-runs every one and never takes your word for it.

A PR in a repo your Dori gates (`mergeGate.repos`; your lane footer names it) merges only through the review gate, never with plain `gh pr merge`. Push, then in a clean checkout of the PR's head run `dori review <owner/repo>#<N>`: it runs the tests there first (the gate is for repos without CI: a PR with GitHub checks or auto-merge is refused as unsupported), then a reviewer of another model family reads the diff and must end with `VERDICT: CLEAR`. Then `dori merge <owner/repo>#<N>` merges exactly that head (`--match-head-commit`). Any commit pushed after the review gets `MERGE_REFUSED` until you review again at the new head; a `BLOCK` means fix the findings, push, review again. A gated PR merged without `dori merge` makes `claim-done` refuse with `MERGE_GATE_MISSING`.

```sh
dori claim-done <your-lane-key> --evidence "<merge SHA, closed issue, version, links>" \
  --summary "<2 to 5 plain lines for the owner, in his language: what changed, what is left, when it reaches where it is used>"
```

The evidence is for the lead; the summary is what the owner reads in your work thread when the lane closes, posted before the thread is marked done. The owner reads your result once: if you already posted it in your work thread yourself (`dori thread reply`, `dori send` from your session, because your brief asked for a line there), claim within 30 minutes of that post and the close posts nothing more (`RESULT_ALREADY_POSTED` on your claim, `CLOSE_SUMMARY_SKIPPED` on the close); `--posted <id or link>` names that message when it is older. If your last post there was a progress line and not the result, add `--post-summary` so the summary still goes out. Never post the same result again by hand after the claim. Write it for him, in the speech the Dori uses with him rather than the polite speech you use with the lead (it goes out under the Dori's name; a Korean owner is spoken to in 반말 unless `discord.ownerSpeech` says `polite`): no ~요 or ~니다 endings then, no paths, commit hashes, command names or report codes (`SUMMARY_REFUSED` otherwise). Without `--summary` the close has a model write one from your last report and `REPORT.md`; if nothing can be written, the lane does not close and you are asked to claim again with one.

The key is in your brief's lane footer. If you leave it out, the lane registered for your pane is used.

## What happens next

1. The Dori gets a `LANE_DONE_CLAIMED` event, and you get a `[LEAD]` line saying when the lane closes.
2. Stay idle and start no new work. If the lead gives you new work now (a `dori type` into your pane, often the owner's feedback on your result), your claim is taken back: you get `[LEAD] your done claim for <key> is taken back: ...`, the lane is working again and nothing closes it on a timer. Do that work, then claim again.
3. If the Dori does not object within 5 minutes, the watcher closes the lane. Before closing, it reads back every `Done =` signal live. It refuses to close if any of your worktrees still has uncommitted tracked changes, or commits that are on no remote.
4. Closing posts your summary in your thread first (unless your result is already there, see above), and only once it went out marks the thread done (with a Discord token by renaming it to its done mark and archiving it, else through the thread hook), unless another open lane or an open question card still uses the thread: then your summary is only posted there and the thread keeps its status. No summary, or a post that failed, and the lane stays open (`CLOSE_SUMMARY_MISSING` / `CLOSE_SUMMARY_NOT_SENT`): you get `[LEAD] not done` with the line to claim again. It closes your tab, and removes your worktrees. A lane with no usable thread ref gets `THREAD_MISSING <key>` instead of a silent skip; the lead fixes the ref with `dori set-thread <key> <adapter>:<id>`.

If the lead has paused your lane (`dori pause`, e.g. while it waits on the owner), your claim is recorded but nothing closes on a timer; you get a `[LEAD]` line saying so, and the lead closes the lane or objects.

## What you learned

Before you claim, put each thing where it belongs, once: a standing instruction of the owner that the lane met goes to the lead in a `[REPORT]` for the directive ledger (not only into memory); a lesson, a fact or how the work went goes into your omo memory with the report's path; the report itself stays in `~/.dori/qa` as the record.

## Reporting honestly

- A blocker, an impossible task or an ambiguous request is a fine report: `[REPORT] <key> | blocker | <one plain line: what blocks and what you need>`, with what you tried and the evidence on the lines below. Say it plainly instead of retrying or claiming done.
- Cap your retries: after two or three failed attempts at the same step, report a blocker.
- Evidence is the real thing: the real screen, the real call, the real output, with a capture, output or file path for [끝난 상태] and for each QA item. A passing test suite alone does not show the result works; keep the repository's tests green as well, and for a code change show with a mutation that they catch the bug.
- Step 6 of the brief (back to a new plan until [끝난 상태] holds) does not reset the retry cap or the stuck ladder: they count failed attempts per metric, whatever the plan.
- Inside your brief's [넘으면 안 되는 선], proceed without asking: plan approval is given in advance. Report a `| question |` only to cross a line or for a choice only the owner can make.
- Tag a report that is a fix attempt for a failing check or metric with `(fix: <metric> / <hypothesis>)`. The lead's stuck ladder counts failed attempts on one metric (untagged ones too): at the 2nd, competing hypotheses before the next patch; at the 3rd you get ulw research and a challenge of your next plan; with one hypothesis tried 3 times after you branched, or a failure after the research, the lead may move you to a new session. Stop patching, reproduce the failure and read the logs for the root cause.
- If your brief has a "Past signals" section, read it before you plan: it lists what earlier lanes in the same repo or topic tried and what failed. Don't repeat a fix listed there without a new reason.
- When you make or change a yardstick (a metric, a threshold, a check), write one line on how it could get better while the real goal gets worse.

## If the Dori objects, or a check fails

You get `[LEAD] not done: <reasons>; keep working, claim again when fixed` in your pane, and the lane goes back to not-done. This happens when:

- the Dori objects;
- a `Done =` signal does not read back live;
- there is unpushed work (the reason names the path).

Fix every reason, then claim again. A new claim starts a fresh 5-minute window.

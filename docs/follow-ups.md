# Follow-ups

Work left out of a merged change on purpose, with why and what would close it. Each entry names the PR that left it.

## Lane handover: one record per lane, with a generation number (#320)

A lane's waiting handover is spread over several per-lane files: the lock, the pending journal, the ready mark, the ready-resume claim, the safe-point file and the facts snapshots, plus the waiting request read from the last rollover row. Review rounds 7-12 of #320 found 2-5 new races per round, nearly all between two of those files. #320 therefore keeps crash repair as main had it: a dead journal is repaired by the next handover run of the lane, under the lane's lock, and `freshness` repairs nothing itself.

What would close it: a single per-lane record, written under the lock with a generation number that each writer checks and bumps (compare-and-set), holding the request, its phase (asked, waiting, moving, repointed, committed) and the run that owns it. Recovery then reads one phase instead of inferring one from several files, and `freshness` can finish a committed move or undo an uncommitted one by itself. Write the crash points x actors as one table test before the code.

Until then a run that dies after repointing the lane, before it finishes, leaves the move to the next `dori handover --lane <key>` run, whether the lead starts it or an automatic rollover does.

Design chosen after review round 17 of #320 (not started; the lead set it aside on 2026-11-04), plan `/tmp/tmp.6Nnl3yJr6R/plan-320-r17.md`:
- One record per lane, `<stateDir>/handover/lanes/<key>.handover.json`, changed only by a transition under the lane lock; it folds in the lock owner, the waiting request, the ready-resume claim, the takeover files and the journal, and the rollover log stays history only.
- Three numbers: `rev` (every write, compare-and-write), request id (`at` + `by`), and `epoch` (the fencing token, bumped only when ownership of the move changes), checked under the lock at the repoint and the commit row.
- One executor: commands (lead run, ready mark, `--force`, a due auto) only write intent, and one `reconcile()` does every move, so the owner's four flows (one waiting request, start again on ready or idle, the first `--force` moves, never two moves) are checked in one place. Cutover is quiesced (one PR switches every writer and imports a waiting row once); liveness holds given that the lane eventually goes idle or ready and freshness keeps sweeping.
- About 3 PRs: record + `reconcile()` + an exhaustive interleaving harness (safety checked before review); cutover of the writers; docs + herdr QA.

## Lane handover: an exception after the commit with --keep-old rolls the move back (#320)

With `--keep-old`, the new session is told `HANDOVER_COMMITTED` before the post-commit steps (the note append, the owner report). If one of them throws, the run's exception repair uses `recover()`, which closes the new session while the old one is alive, as on main. A process that dies there is handled the same way by the next run. The lead accepted this as main's behaviour on 2026-11-04. The record above closes it: the committed phase makes recovery finish the move.

## Lane handover: a crash between the idle-moment freeze and the journal leaves the old agent stopped (#320)

An automatic start (`--wait-idle`, or a waiting request `freshness` starts again) freezes the lane's agent at its idle moment, before the new session opens and before the pending journal is written. A run that dies in that window leaves the agent stopped (state T) with no journal, so no later run knows to thaw it. The code is the same as on main (plan challenge of review 320 round 13). What would close it: write the journal, or the per-lane record above, with the frozen agent's pid and start time before the `SIGSTOP`, so the repair under the lock thaws exactly that process; until then the lead resumes a stopped lane by hand (#332, open, has `dori watch` report it as `LANE_SUSPENDED`).

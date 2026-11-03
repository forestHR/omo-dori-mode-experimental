# Native Windows handover freezing

Lead and lane handovers use `NtSuspendProcess` / `NtResumeProcess` through
`bun:ffi` on a `PROCESS_SUSPEND_RESUME` handle. The existing transaction-local
`freezeSignal` prevents an agent from being suspended twice when a lane first
stops the agent and later expands the freeze to its children. Thaw deduplicates
the recorded PIDs and resumes children before the agent.

`Win32_Process` does not expose suspension. The Windows process-table query also
reads `Get-Process` threads and reports `Stat: "T"` only for a nonempty thread
set whose threads are all in `Wait` with `WaitReason` `Suspended`. `winProcs`
preserves that state for the existing `stoppedAgent` messaging guard. Native
state covers a second invocation during a handover, before a frozen replacement
record exists; it needs no additional persistent freeze marker. The PowerShell
query is static and interpolates no PIDs, names, paths or arguments.

`test/windows-freeze.test.ts` covers suspend, tree expansion, attempted messaging
against a stale running-turn screen, and thaw from a fresh invocation. It checks
that neither text nor Enter is sent while suspended. The manual Windows workflow
runs the real-process version, including native thread-state discovery and a
separate Bun process to thaw.

Mutation check on Linux: temporarily replacing `winProcs`' suspended-state mapping
with the old `stat: ""` made the portable suspend/submit/thaw regression fail:
expected `NOT_SUBMITTED`, received `SUBMITTED`. Restoring the mapping makes it
pass. This reproduces review round 4 finding 2 rather than only testing the
duplicate-suspension tracker.

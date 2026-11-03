# Deferred Windows freeze implementation

This branch preserves the native suspension implementation from PR #301 at
5ff75b46f320ec69f9bd58ed3982d1d23450b914. It is not ready for review or use.
Windows freeze, thaw, and handover are refused in the native-process PR.

Before a later freeze PR, address review round 4's suspended-state finding:
Win32_Process supplies no suspended-state information, so stoppedAgent cannot
recognize a suspended Windows agent while a handover is in progress, before
its replacement record exists. Expose native suspension state or track freezes
across invocations. Add an actual Windows suspend -> submit -> thaw regression
asserting that neither text nor Enter is sent to the suspended agent.
The per-transaction duplicate-stop guard alone does not fix this messaging gap.

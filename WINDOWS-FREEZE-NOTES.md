# Deferred Windows freeze implementation

This branch preserves the native suspension implementation from PR #301 at
5ff75b46f320ec69f9bd58ed3982d1d23450b914. It is not ready for review or use.
Windows freeze, thaw, and handover are refused in the native-process PR.

Before a later freeze PR, address review round 4's suspended-state finding:
Win32_Process supplies no suspended-state information. Detect already suspended
agents and refuse before changing them; do not add a suspend count to a process
that was suspended outside the current transaction. Test that rejection and
verify that thaw neither leaves a process suspended nor resumes an unrelated
suspension. The per-transaction duplicate-stop guard alone does not establish
that safety property.

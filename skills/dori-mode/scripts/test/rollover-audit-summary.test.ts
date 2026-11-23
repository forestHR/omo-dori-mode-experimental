import { afterEach, beforeEach, expect, test } from "bun:test";

import { appendRollover, COMMITTED } from "../src/rollover.ts";
import { auditSummary } from "../src/rollover-audit.ts";
import { withState } from "./fakes.ts";

let state: { dir: string; done: () => void };

beforeEach(() => {
  state = withState();
});

afterEach(() => state.done());

test("the weekly summary counts distinct automatic refusals by reason and excludes manual or old attempts", () => {
  // Given
  const now = Date.parse("2026-10-19T10:30:00Z");
  const missing = {
    kind: "rollover" as const,
    who: "lead" as const,
    at: "2026-10-18T10:00:00.000Z",
    key: "lead",
    from: "w1:p1",
    approvedBy: "auto:handover.autoRolloverLead",
    signals: {},
    steps: [],
    result: "refused",
    reasons: ["HANDOVER_MISSING /state/handover/2026-10-18.md"],
  };
  const busy = {
    kind: "rollover" as const,
    who: "lead" as const,
    at: "2026-10-18T11:00:00.000Z",
    key: "lead",
    from: "w1:p1",
    approvedBy: "auto:handover.autoRolloverLead",
    signals: {},
    steps: [],
    result: "refused",
    blocked: "busy" as const,
    reasons: ["HANDOVER_FAIL the lead has an active turn"],
  };
  const manual = { ...busy, at: "2026-10-18T12:00:00.000Z", approvedBy: "lead:requested", reasons: ["manual refusal"] };
  const old = { ...missing, at: "2026-10-11T10:00:00.000Z" };
  const committed = { ...missing, at: "2026-10-18T13:00:00.000Z", result: COMMITTED, reasons: [] };
  appendRollover(state.dir, missing);
  appendRollover(state.dir, missing);
  appendRollover(state.dir, busy);
  appendRollover(state.dir, manual);
  appendRollover(state.dir, old);
  appendRollover(state.dir, committed);
  // When
  const summary = auditSummary(state.dir, now);
  // Then
  expect(summary).toContain("자동 교대 거절 2번");
  expect(summary).toContain("HANDOVER_MISSING 1");
  expect(summary).toContain("busy 1");
  expect(summary).toContain("자동 교대 실패 0번");
  expect(summary).not.toContain("교대 기능 고칠 거리 없음");
});

test("the weekly summary never says there is nothing to fix when an automatic move failed", () => {
  // Given
  appendRollover(state.dir, {
    kind: "rollover",
    who: "lead",
    at: "2026-10-19T10:00:00.000Z",
    key: "lead",
    from: "w1:p1",
    approvedBy: "auto:handover.autoRolloverLead",
    signals: {},
    steps: [],
    result: "rolled-back",
    reasons: ["HANDOVER_FAIL could not start the new session"],
  });
  // When
  const summary = auditSummary(state.dir, Date.parse("2026-10-19T10:30:00Z"));
  // Then
  expect(summary).toContain("자동 교대 실패 1번");
  expect(summary).not.toContain("교대 기능 고칠 거리 없음");
});

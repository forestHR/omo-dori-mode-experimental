import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { automaticLeadSessionHandover } from "../src/lead-session-handover.ts";
import { freshnessTick } from "../src/freshness.ts";
import { readRollovers } from "../src/rollover.ts";
import { createLeadSessionHandoverFixture, DATE, notePath, OLD_ID, PANE } from "./lead-session-handover-fixture.ts";
import { fakeClock } from "./fakes.ts";

let fixture: ReturnType<typeof createLeadSessionHandoverFixture>;
beforeEach(() => {
  fixture = createLeadSessionHandoverFixture();
});
afterEach(() => fixture.state.done());

test("freshness retries a refused automatic lead handover as soon as its dated note is written", async () => {
  // Given
  const clock = fakeClock(Date.parse(`${DATE}T12:00:00.000Z`));
  const base = fixture.setup();
  const posts: string[] = [];
  const starts: string[] = [];
  const deps = {
    ...base,
    clock,
    config: { ...base.config, handover: { ...base.config.handover, autoRolloverLead: true, leadContextPct: 80 } },
    postLeadAlert: async (text: string) => { posts.push(text); return [`LEAD_ALERT_POSTED pair c1 m${posts.length}`]; },
  };
  rmSync(notePath(fixture.state.dir));
  const hooks = {
    signals: async () => ({ contextPct: 85 }),
    auto: async () => {
      const result = await automaticLeadSessionHandover(deps);
      starts.push(result.line);
      return result.code === 0 ? `started ${result.line}` : `could not start: ${result.line}`;
    },
  };
  // When
  const refused = await freshnessTick(deps, "/home/test", hooks);
  clock.at += 60_000;
  const stillMissing = await freshnessTick(deps, "/home/test", hooks);
  writeFileSync(notePath(fixture.state.dir), "Today's active work, owner constraints, and next tasks.\n");
  clock.at += 60_000;
  const resumed = await freshnessTick(deps, "/home/test", hooks);
  // Then
  expect(refused.some((act) => act.kind === "rollover_auto" && act.detail.includes("HANDOVER_MISSING"))).toBe(true);
  expect(stillMissing.some((act) => act.kind === "rollover_auto")).toBe(false);
  expect(resumed.some((act) => act.kind === "rollover_auto" && act.detail.includes("HANDOVER_OK"))).toBe(true);
  expect(starts).toHaveLength(2);
  expect(posts).toHaveLength(1);
  expect(fixture.currentSession).not.toBe(OLD_ID);
  expect(readRollovers(fixture.state.dir).filter((entry) => entry.kind === "rollover").map((entry) => entry.result)).toEqual(["refused", "HANDOVER_COMMITTED"]);
});

test("freshness alerts for a new missing-note path when the date changes before autoRetryMin", async () => {
  // Given
  const clock = fakeClock(Date.parse(`${DATE}T23:59:30.000Z`));
  const base = fixture.setup();
  const posts: string[] = [];
  const deps = {
    ...base,
    clock,
    config: { ...base.config, handover: { ...base.config.handover, autoRolloverLead: true, leadContextPct: 80 } },
    postLeadAlert: async (text: string) => { posts.push(text); return [`LEAD_ALERT_POSTED pair c1 m${posts.length}`]; },
  };
  rmSync(notePath(fixture.state.dir));
  const hooks = {
    signals: async () => ({ contextPct: 85 }),
    auto: async () => {
      const result = await automaticLeadSessionHandover(deps);
      return result.code === 0 ? `started ${result.line}` : `could not start: ${result.line}`;
    },
  };
  // When
  await freshnessTick(deps, "/home/test", hooks);
  clock.at = Date.parse("2026-11-17T00:00:30.000Z");
  await freshnessTick(deps, "/home/test", hooks);
  // Then
  expect(posts).toHaveLength(2);
  expect(posts[0]).toContain(notePath(fixture.state.dir));
  expect(posts[1]).toContain(join(fixture.state.dir, "handover", "2026-11-17.md"));
  expect(readRollovers(fixture.state.dir).filter((entry) => entry.kind === "rollover").map((entry) => entry.reasons[0]?.startsWith("HANDOVER_MISSING"))).toEqual([true, true]);
});

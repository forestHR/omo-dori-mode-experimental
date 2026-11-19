import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { HandoverDeps } from "../src/handover.ts";
import { automaticLeadSessionHandover, leadSessionHandover } from "../src/lead-session-handover.ts";
import { herdrLeadSession, readHerdrSessions, recordHerdrSession } from "../src/herdr-sessions.ts";
import { readRollovers } from "../src/rollover.ts";
import type { Runner } from "../src/run.ts";
import { createLeadSessionHandoverFixture, DATE, handoverLock, NEW_ID, notePath, OLD_ID, PANE } from "./lead-session-handover-fixture.ts";
import { fakeClock } from "./fakes.ts";

let fixture: ReturnType<typeof createLeadSessionHandoverFixture>;
beforeEach(() => {
  fixture = createLeadSessionHandoverFixture();
});

afterEach(() => fixture.state.done());

test("refuses a missing handover file before reading or changing the lead pane", async () => {
  // Given
  const deps = fixture.setup();
  rmSync(notePath(fixture.state.dir));
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  expect(result.code).toBe(2);
  expect(fixture.printed).toEqual([`HANDOVER_MISSING ${notePath(fixture.state.dir)}`]);
  expect(fixture.world.calls).toEqual([]);
  expect(readHerdrSessions(fixture.state.dir)[PANE]?.session).toBe(OLD_ID);
});

test("refuses an empty handover file before reading or changing the lead pane", async () => {
  // Given
  const deps = fixture.setup();
  writeFileSync(notePath(fixture.state.dir), "");
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  expect(result.code).toBe(2);
  expect(fixture.printed).toEqual([`HANDOVER_MISSING ${notePath(fixture.state.dir)} is empty`]);
  expect(fixture.world.calls).toEqual([]);
  expect(readHerdrSessions(fixture.state.dir)[PANE]?.session).toBe(OLD_ID);
});

test("dry-run describes the same-pane restart without changing the process or its record", async () => {
  // Given
  const deps = fixture.setup();
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: true });
  // Then
  expect(result.code).toBe(0);
  expect(fixture.printed).toEqual([`HANDOVER_DRY_RUN would replace session ${OLD_ID} with a new session id in ${PANE}, then submit the handover file ${notePath(fixture.state.dir)}`]);
  expect(fixture.world.calls.some((argv) => argv[2] === "send-keys" || argv[2] === "run")).toBe(false);
  expect(readHerdrSessions(fixture.state.dir)[PANE]?.session).toBe(OLD_ID);
  expect(fixture.currentSession).toBe(OLD_ID);
});

test("refuses an active lead turn without sending stop keys or changing the session record", async () => {
  // Given
  const deps = fixture.setup();
  fixture.world.screens[PANE] = "──────── • Working (4s • esc to interrupt) ────────\n❯ \n────────";
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  expect(result.code).toBe(2);
  expect(fixture.printed[0]).toBe(`HANDOVER_FAIL the lead has an active turn in ${PANE}`);
  expect(fixture.world.calls.some((argv) => argv[2] === "send-keys")).toBe(false);
  expect(fixture.world.calls.some((argv) => argv[2] === "run")).toBe(false);
  expect(readHerdrSessions(fixture.state.dir)[PANE]?.session).toBe(OLD_ID);
});

test("refuses to start a handover controller inside the pane it would stop", async () => {
  // Given
  const deps = fixture.setup();
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false, originPane: PANE });
  // Then
  expect(result.code).toBe(2);
  expect(fixture.printed[0]).toContain("outside its target pane");
  expect(fixture.world.calls).toEqual([]);
  expect(readHerdrSessions(fixture.state.dir)[PANE]?.session).toBe(OLD_ID);
});

test("starts a distinct session in the same pane and updates the revive record after the first input", async () => {
  // Given
  const deps = fixture.setup();
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  const record = readHerdrSessions(fixture.state.dir)[PANE];
  const firstStarted = fixture.started[0];
  const firstInput = fixture.world.calls.find((argv) => argv[0] === "herdr" && argv[2] === "send-text")?.[4] ?? "";
  if (!record || !firstStarted) throw new Error("the new session record or start command is missing");
  expect(result.code).toBe(0);
  expect(record.session).not.toBe(OLD_ID);
  expect(record.session).toBe(firstStarted);
  expect(fixture.currentSession).toBe(record.session);
  expect(fixture.world.calls.some((argv) => argv[0] === "herdr" && argv[2] === "run" && argv[3] === PANE)).toBe(true);
  expect(fixture.world.calls.some((argv) => argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create")).toBe(false);
  expect(firstInput).toContain(notePath(fixture.state.dir));
  expect(fixture.printed).toEqual([`HANDOVER_OK lead-handover ${OLD_ID} -> ${record.session} ${notePath(fixture.state.dir)}`]);
});

test("restores the old live session and keeps its record when the new session fails to start", async () => {
  // Given
  const deps = fixture.setup();
  fixture.rejectFreshStart = true;
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  expect(result.code).toBe(3);
  expect(fixture.printed[0]).toContain("HANDOVER_FAIL could not start the new session");
  expect(fixture.printed[0]).toContain(`old session ${OLD_ID} restored`);
  expect(fixture.currentSession).toBe(OLD_ID);
  expect(readHerdrSessions(fixture.state.dir)[PANE]?.session).toBe(OLD_ID);
  expect(fixture.started).toEqual([expect.any(String), OLD_ID]);
  expect(fixture.world.herdrDead?.includes(PANE)).toBe(false);
});

test("uses Ctrl+D to restore the old session after an idle new-session note change", async () => {
  // Given
  const deps = fixture.setup();
  fixture.changeNoteAfterFirstInput = true;
  fixture.busyNewSession = false;
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  const newSession = fixture.started[0];
  if (!newSession) throw new Error("the new session did not start");
  expect(result.code).toBe(3);
  expect(fixture.printed[0]).toContain(`HANDOVER_FAIL the handover file ${notePath(fixture.state.dir)} changed before commit`);
  expect(fixture.printed[0]).toContain(`old session ${OLD_ID} restored`);
  expect(fixture.stopEvents).toEqual([{ key: "ctrl+d", session: OLD_ID }, { key: "ctrl+d", session: newSession }]);
  expect(fixture.currentSession).toBe(OLD_ID);
  expect(readHerdrSessions(fixture.state.dir)[PANE]?.session).toBe(OLD_ID);
  expect(fixture.world.herdrDead?.includes(PANE)).toBe(false);
});

test("interrupts a busy new session with Esc before restoring the old session", async () => {
  // Given
  const deps = fixture.setup();
  fixture.changeNoteAfterFirstInput = true;
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  const newSession = fixture.started[0];
  if (!newSession) throw new Error("the new session did not start");
  expect(result.code).toBe(3);
  expect(fixture.printed[0]).toContain(`HANDOVER_FAIL the handover file ${notePath(fixture.state.dir)} changed before commit`);
  expect(fixture.printed[0]).toContain(`old session ${OLD_ID} restored`);
  expect(fixture.stopEvents).toEqual([
    { key: "ctrl+d", session: OLD_ID },
    { key: "esc", session: newSession },
    { key: "ctrl+d", session: newSession },
  ]);
  expect(fixture.currentSession).toBe(OLD_ID);
  expect(readHerdrSessions(fixture.state.dir)[PANE]?.session).toBe(OLD_ID);
  expect(fixture.world.herdrDead?.includes(PANE)).toBe(false);
});

test("restores the old mapping if success reporting fails after the new id was written", async () => {
  // Given
  const base = fixture.setup();
  let failed = false;
  const deps: HandoverDeps = {
    ...base,
    print: (line) => {
      if (line.startsWith("HANDOVER_OK") && !failed) {
        failed = true;
        throw new Error("injected success output failure");
      }
      fixture.printed.push(line);
    },
  };
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  expect(result.code).toBe(3);
  expect(fixture.printed[0]).toContain("HANDOVER_FAIL injected success output failure");
  expect(fixture.printed[0]).toContain(`old session ${OLD_ID} restored`);
  expect(fixture.currentSession).toBe(OLD_ID);
  expect(readHerdrSessions(fixture.state.dir)[PANE]?.session).toBe(OLD_ID);
  expect(fixture.world.herdrDead?.includes(PANE)).toBe(false);
});

test("reports the session id actually on disk when the committed new agent cannot stop", async () => {
  // Given
  const base = fixture.setup();
  fixture.keepNewAgentAliveAfterCtrlD = true;
  let failSuccessOutput = true;
  const deps: HandoverDeps = {
    ...base,
    print: (line) => {
      if (line.startsWith("HANDOVER_OK") && failSuccessOutput) { failSuccessOutput = false; throw new Error("injected success output failure"); }
      fixture.printed.push(line);
    },
  };
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  const recorded = readHerdrSessions(fixture.state.dir)[PANE]?.session;
  expect(result.code).toBe(3);
  expect(recorded).toBe(fixture.currentSession);
  expect(recorded).not.toBe(OLD_ID);
  expect(fixture.printed[0]).toContain(`record now names ${recorded}`);
});

test("automatic lead busy refusal uses the configured retry path rather than the busy fast path", async () => {
  // Given
  const deps = { ...fixture.setup(), clock: fakeClock(Date.parse(`${DATE}T12:00:00.000Z`)) };
  fixture.world.screens[PANE] = "──────── • Working (4s • esc to interrupt) ────────\n❯ \n────────";
  // When
  const result = await automaticLeadSessionHandover(deps);
  // Then
  const last = readRollovers(fixture.state.dir).at(-1);
  if (!last || last.kind !== "rollover") throw new Error("the automatic attempt did not write a rollover result");
  expect(result.code).toBe(2);
  expect(result.line).toContain("active turn");
  expect(last.result).toBe("refused");
  expect(last.blocked).toBeUndefined();
  expect(fixture.currentSession).toBe(OLD_ID);
});

test("a handover lock refuses a second same-pane session transaction", async () => {
  // Given
  const deps = fixture.setup();
  writeFileSync(handoverLock(fixture.state.dir), JSON.stringify({ pid: process.pid, at: new Date(0).toISOString() }));
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  expect(result.code).toBe(2);
  expect(fixture.printed[0]).toContain("another lead session handover is running");
  expect(fixture.world.calls.some((argv) => argv[2] === "send-keys")).toBe(false);
  expect(readHerdrSessions(fixture.state.dir)[PANE]?.session).toBe(OLD_ID);
});

test("an in-flight herdr-session refresh cannot overwrite the newer record after handover commits", async () => {
  // Given
  const deps = fixture.setup();
  let changed = false;
  const baseRun = deps.run;
  const run: Runner = async (argv, options) => {
    const result = await baseRun(argv, options);
    if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "list" && !changed) {
      changed = true;
      recordHerdrSession(fixture.state.dir, PANE, { session: NEW_ID, cwd: fixture.state.dir, model: "provider/new", at: new Date(1).toISOString() });
    }
    return result;
  };
  // When
  const found = await herdrLeadSession(run, { stateDir: fixture.state.dir, sessionsDir: join(fixture.state.dir, "sessions") }, PANE, true);
  // Then
  expect(found).toBe(OLD_ID);
  expect(readHerdrSessions(fixture.state.dir)[PANE]?.session).toBe(NEW_ID);
});

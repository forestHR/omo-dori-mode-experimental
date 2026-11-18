import { afterEach, beforeEach, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { manifestPath } from "../src/handover.ts";
import type { HandoverDeps } from "../src/handover.ts";
import { automaticLeadSessionHandover, leadSessionHandover } from "../src/lead-session-handover.ts";
import { COMMITTED, readRollovers } from "../src/rollover.ts";
import { readHerdrSessions, recordHerdrSession } from "../src/herdr-sessions.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const PANE = "w1:p1";
const DATE = "2026-11-16";
const OLD_ID = "11111111-2222-4333-8444-555555555555";
const MANIFEST = { description: "lead inbox", path: "/home/test/inbox.jsonl", event: "modify", persistent: true, suspended: false };
const notePath = (stateDir: string): string => join(stateDir, "handover", `${DATE}.md`);
const sessionIdFrom = (line: string): string | undefined => {
  const encoded = [...line.matchAll(/FromBase64String\('([^']*)'\)/g)].map((match) => Buffer.from(match[1] ?? "", "base64").toString("utf8"));
  const at = encoded.indexOf("--session-id");
  if (at >= 0) return encoded[at + 1];
  return /(?:^|\s)--session-id\s+([0-9a-f-]+)/i.exec(line)?.[1];
};

let state: { readonly dir: string; readonly done: () => void };
let world: World;
let currentSession: string;
let rearmMonitor: boolean;
let failPaneRead: boolean;
let deleteNoteOnRead: boolean;
let changeNoteAfterFirstInput: boolean;
let ignoreFirstOldStop: boolean;
let interruptBusyTurnOnly: boolean;
let oldStopAttempts: number;
let busyTurnInterrupted: boolean;
let printed: string[];

const setup = (): HandoverDeps => {
  mkdirSync(join(state.dir, "handover"), { recursive: true });
  writeFileSync(notePath(state.dir), "Open work and next steps.\n");
  recordHerdrSession(state.dir, PANE, { session: OLD_ID, cwd: state.dir, model: "provider/model", at: new Date(0).toISOString() });
  const oldManifest = manifestPath(join(state.dir, "sessions"), state.dir, OLD_ID);
  mkdirSync(dirname(oldManifest), { recursive: true });
  writeFileSync(oldManifest, JSON.stringify({ version: 1, sessionId: OLD_ID, monitors: [MANIFEST] }));
  world.panes = [{ pane_id: PANE, workspace_id: "w1", agent: "omo", cwd: state.dir }];
  world.screen = "────────\n❯ \n────────";
  world.ps = `4001 4000 omo --session-id ${OLD_ID} --model provider/model`;
  const base = depsFor(world, fakeClock(0), state.dir, {
    backend: "herdr",
    leadPane: PANE,
    sessionsDir: join(state.dir, "sessions"),
    agentCommand: ["omo", "--model", "{model}", "{prompt}"],
    defaultModel: "provider/model",
  });
  const baseRun = base.run;
  const run: Runner = async (argv, options) => {
    if (failPaneRead && argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "read") {
      world.calls.push([...argv]);
      return { code: 1, out: "────────\n❯ \n────────", err: "injected screen read failure" };
    }
    if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "send-keys" && argv.at(-1) === "ctrl+c") {
      if (currentSession === OLD_ID && ignoreFirstOldStop && oldStopAttempts++ === 0) {
        // Herdr accepted the first signal, but the old process has not exited yet.
      } else if (currentSession !== OLD_ID && interruptBusyTurnOnly && !busyTurnInterrupted) {
        // A busy OMO consumes Ctrl+C to stop its turn; a second signal exits the process.
        busyTurnInterrupted = true;
        world.started = [];
        world.screens[PANE] = "────────\n❯ \n────────";
      } else {
        world.herdrDead = [PANE];
        world.ps = "4000 1 pwsh.exe";
      }
    }
    if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "run") {
      const session = sessionIdFrom(argv[4] ?? "");
      if (session) {
        currentSession = session;
        world.ps = `4001 4000 omo --session-id ${session} --model provider/model`;
      }
    }
    const result = await baseRun(argv, options);
    if (deleteNoteOnRead && argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "read") {
      deleteNoteOnRead = false;
      rmSync(notePath(state.dir));
    }
    if (changeNoteAfterFirstInput && argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "send-text") {
      changeNoteAfterFirstInput = false;
      writeFileSync(notePath(state.dir), "Changed during the session switch.\n");
    }
    if (rearmMonitor && argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "send-text") {
      const file = manifestPath(join(state.dir, "sessions"), state.dir, currentSession);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ version: 1, sessionId: currentSession, monitors: [MANIFEST] }));
    }
    return result;
  };
  return {
    ...base,
    run,
    configPath: join(state.dir, "config.json"),
    envPath: join(state.dir, "dori.env"),
    cardDir: join(state.dir, "discord"),
    inbox: join(state.dir, "inbox.jsonl"),
    home: "/home/test",
    sessionOf: async (pane) => pane === PANE ? currentSession : "",
    routedPane: async () => PANE,
    envLeadPane: "",
    alive: (pid) => pid === process.pid,
    procs: async () => [],
    signal: () => true,
    realpath: (path) => path,
    timers: async () => [],
    restart: async () => undefined,
    nonce: () => "monitor-handover-test",
    print: (line) => printed.push(line),
  };
};

beforeEach(() => {
  state = withState();
  world = newWorld();
  currentSession = OLD_ID;
  rearmMonitor = false;
  failPaneRead = false;
  deleteNoteOnRead = false;
  changeNoteAfterFirstInput = false;
  ignoreFirstOldStop = false;
  interruptBusyTurnOnly = false;
  oldStopAttempts = 0;
  busyTurnInterrupted = false;
  printed = [];
});

afterEach(() => state.done());

test("commits only after the new session has a matching live monitor", async () => {
  // Given
  const deps = setup();
  rearmMonitor = true;
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  const record = readHerdrSessions(state.dir)[PANE];
  expect(result.code).toBe(0);
  expect(record?.session).not.toBe(OLD_ID);
});

test("restores the old session if its live monitors were not re-armed in the new session", async () => {
  // Given
  const deps = setup();
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  expect(result.code).toBe(3);
  expect(printed[0]?.startsWith("HANDOVER_FAIL")).toBe(true);
  expect(currentSession).toBe(OLD_ID);
  expect(readHerdrSessions(state.dir)[PANE]?.session).toBe(OLD_ID);
  expect(world.herdrDead?.includes(PANE)).toBe(false);
});

test("refuses a failed OMO screen read without stopping the recorded session", async () => {
  // Given
  const deps = setup();
  failPaneRead = true;
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  expect(result.code).toBe(2);
  expect(world.calls.some((argv) => argv[2] === "send-keys" && argv.at(-1) === "ctrl+c")).toBe(false);
  expect(world.calls.some((argv) => argv[2] === "run")).toBe(false);
  expect(readHerdrSessions(state.dir)[PANE]?.session).toBe(OLD_ID);
});

test("refuses a shell prompt that is not an OMO input box", async () => {
  // Given
  const deps = setup();
  world.screen = "PS> ";
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  expect(result.code).toBe(2);
  expect(world.calls.some((argv) => argv[2] === "send-keys" && argv.at(-1) === "ctrl+c")).toBe(false);
  expect(readHerdrSessions(state.dir)[PANE]?.session).toBe(OLD_ID);
});

test("revalidates the handover file after acquiring the lock and before stopping the old session", async () => {
  // Given
  const deps = setup();
  deleteNoteOnRead = true;
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  expect(result.code).toBe(2);
  expect(printed[0]).toBe(`HANDOVER_MISSING ${notePath(state.dir)}`);
  expect(world.calls.some((argv) => argv[2] === "send-keys" && argv.at(-1) === "ctrl+c")).toBe(false);
  expect(readHerdrSessions(state.dir)[PANE]?.session).toBe(OLD_ID);
});

test("restores the old session when the handover file changes before record commit", async () => {
  // Given
  const deps = setup();
  changeNoteAfterFirstInput = true;
  rearmMonitor = true;
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  expect(result.code).toBe(3);
  expect(currentSession).toBe(OLD_ID);
  expect(readHerdrSessions(state.dir)[PANE]?.session).toBe(OLD_ID);
  expect(world.herdrDead?.includes(PANE)).toBe(false);
});

test("checks the fresh process id before submitting the first new-session input", async () => {
  // Given
  const base = setup();
  rearmMonitor = true;
  const deps: HandoverDeps = {
    ...base,
    sessionOf: async (pane) => pane !== PANE ? "" : currentSession === OLD_ID ? OLD_ID : "unexpected-session",
  };
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  expect(result.code).toBe(3);
  expect(world.calls.some((argv) => argv[0] === "herdr" && argv[2] === "send-text")).toBe(false);
  expect(currentSession).toBe(OLD_ID);
  expect(readHerdrSessions(state.dir)[PANE]?.session).toBe(OLD_ID);
});

test("restores the old session when the initial stop does not exit before its deadline", async () => {
  // Given
  const deps = setup();
  ignoreFirstOldStop = true;
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  expect(result.code).toBe(3);
  expect(printed[0]).toContain(`old session ${OLD_ID} restored`);
  expect(currentSession).toBe(OLD_ID);
  expect(readHerdrSessions(state.dir)[PANE]?.session).toBe(OLD_ID);
});

test("retries Ctrl+C after the first signal only interrupts a busy new turn", async () => {
  // Given
  const deps = setup();
  changeNoteAfterFirstInput = true;
  rearmMonitor = true;
  interruptBusyTurnOnly = true;
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  expect(result.code).toBe(3);
  expect(busyTurnInterrupted).toBe(true);
  expect(currentSession).toBe(OLD_ID);
  expect(readHerdrSessions(state.dir)[PANE]?.session).toBe(OLD_ID);
  expect(world.herdrDead?.includes(PANE)).toBe(false);
});

test("automatic Herdr lead rollover uses the current UTC note and records the same-pane commit", async () => {
  // Given
  const base = setup();
  const clock = fakeClock(Date.parse(`${DATE}T12:00:00.000Z`));
  rearmMonitor = true;
  const deps: HandoverDeps = {
    ...base,
    clock,
    reportOwner: async () => "message-1",
  };
  // When
  const result = await automaticLeadSessionHandover(deps);
  // Then
  const session = readHerdrSessions(state.dir)[PANE]?.session;
  const rollover = readRollovers(state.dir).at(-1);
  expect(result.code).toBe(0);
  expect(result.line).toStartWith(`HANDOVER_OK lead-handover ${OLD_ID} -> ${session} ${notePath(state.dir)}`);
  expect(session).not.toBe(OLD_ID);
  expect(rollover).toMatchObject({
    kind: "rollover", who: "lead", key: "lead", from: PANE, to: PANE,
    approvedBy: "auto:handover.autoRolloverLead", decidedBy: "auto", result: COMMITTED,
    ownerReport: { message: "message-1" },
  });
});

test("automatic Herdr lead rollover reports the UTC path when only the KST date note exists", async () => {
  // Given
  const base = setup();
  const clock = fakeClock(Date.parse("2026-11-17T23:30:00.000Z"));
  rmSync(notePath(state.dir)); writeFileSync(join(state.dir, "handover", "2026-11-18.md"), "KST date note.\n");
  // When
  const result = await automaticLeadSessionHandover({ ...base, clock });
  // Then
  expect(result.code).toBe(2);
  expect(result.line).toBe(`HANDOVER_MISSING ${join(state.dir, "handover", "2026-11-17.md")}`);
  expect(currentSession).toBe(OLD_ID);
  expect(readHerdrSessions(state.dir)[PANE]?.session).toBe(OLD_ID);
  expect(readRollovers(state.dir).at(-1)).toMatchObject({
    kind: "rollover", who: "lead", key: "lead",
    approvedBy: "auto:handover.autoRolloverLead", decidedBy: "auto", result: "refused",
  });
});

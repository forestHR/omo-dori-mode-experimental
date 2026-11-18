import { afterEach, beforeEach, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { HandoverDeps } from "../src/handover.ts";
import { automaticLeadSessionHandover, leadSessionHandover } from "../src/lead-session-handover.ts";
import { herdrLeadSession, readHerdrSessions, recordHerdrSession } from "../src/herdr-sessions.ts";
import { readRollovers } from "../src/rollover.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState, type World } from "./fakes.ts";

const PANE = "w1:p1";
const DATE = "2026-11-16";
const OLD_ID = "11111111-2222-4333-8444-555555555555";
const NEW_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const notePath = (stateDir: string): string => join(stateDir, "handover", `${DATE}.md`);
const handoverLock = (stateDir: string): string => join(stateDir, "handover", "lock");

const sessionIdFrom = (line: string): string | undefined => {
  const encoded = [...line.matchAll(/FromBase64String\('([^']*)'\)/g)].map((match) => Buffer.from(match[1] ?? "", "base64").toString("utf8"));
  const at = encoded.indexOf("--session-id");
  if (at >= 0) return encoded[at + 1];
  return /(?:^|\s)--session-id\s+([0-9a-f-]+)/i.exec(line)?.[1];
};

let state: { readonly dir: string; readonly done: () => void };
let world: World;
let currentSession: string;
let rejectFreshStart: boolean;
let rejectedFreshStart: boolean;
let keepNewAgentAliveAfterCtrlC: boolean;
let started: string[];
let printed: string[];

const setup = (): HandoverDeps => {
  mkdirSync(join(state.dir, "handover"), { recursive: true });
  writeFileSync(notePath(state.dir), "Open work and next steps.\n");
  recordHerdrSession(state.dir, PANE, { session: OLD_ID, cwd: state.dir, model: "provider/model:high", at: new Date(0).toISOString() });
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
    if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "send-keys" && argv.at(-1) === "ctrl+c") {
      if (!(keepNewAgentAliveAfterCtrlC && currentSession !== OLD_ID)) {
        world.herdrDead = [PANE];
        world.ps = "4000 1 pwsh.exe";
      }
    }
    if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "run") {
      const session = sessionIdFrom(argv[4] ?? "");
      if (session) started.push(session);
      if (rejectFreshStart && !rejectedFreshStart && session !== OLD_ID) {
        rejectedFreshStart = true;
        world.calls.push([...argv]);
        return { code: 1, out: "", err: "injected new-session start failure" };
      }
      if (session) {
        currentSession = session;
        world.ps = `4001 4000 omo --session-id ${session} --model provider/model`;
      }
    }
    return baseRun(argv, options);
  };
  return {
    ...base,
    run,
    configPath: join(state.dir, "config.json"),
    envPath: join(state.dir, "dori.env"),
    cardDir: join(state.dir, "discord"),
    inbox: join(state.dir, "inbox.jsonl"),
    home: state.dir,
    sessionOf: async (pane) => pane === PANE ? currentSession : "",
    routedPane: async () => PANE,
    envLeadPane: "",
    alive: (pid) => pid === process.pid,
    procs: async () => [],
    signal: () => true,
    realpath: (path) => path,
    timers: async () => [],
    restart: async () => undefined,
    nonce: () => "handover-test",
    print: (line) => printed.push(line),
  };
};

beforeEach(() => {
  state = withState();
  world = newWorld();
  currentSession = OLD_ID;
  rejectFreshStart = false;
  rejectedFreshStart = false;
  keepNewAgentAliveAfterCtrlC = false;
  started = [];
  printed = [];
});

afterEach(() => state.done());

test("refuses a missing handover file before reading or changing the lead pane", async () => {
  // Given
  const deps = setup();
  rmSync(notePath(state.dir));
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  expect(result.code).toBe(2);
  expect(printed).toEqual([`HANDOVER_MISSING ${notePath(state.dir)}`]);
  expect(world.calls).toEqual([]);
  expect(readHerdrSessions(state.dir)[PANE]?.session).toBe(OLD_ID);
});

test("refuses an empty handover file before reading or changing the lead pane", async () => {
  // Given
  const deps = setup();
  writeFileSync(notePath(state.dir), "");
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  expect(result.code).toBe(2);
  expect(printed).toEqual([`HANDOVER_MISSING ${notePath(state.dir)} is empty`]);
  expect(world.calls).toEqual([]);
  expect(readHerdrSessions(state.dir)[PANE]?.session).toBe(OLD_ID);
});

test("dry-run describes the same-pane restart without changing the process or its record", async () => {
  // Given
  const deps = setup();
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: true });
  // Then
  expect(result.code).toBe(0);
  expect(printed).toEqual([`HANDOVER_DRY_RUN would replace session ${OLD_ID} with a new session id in ${PANE}, then submit the handover file ${notePath(state.dir)}`]);
  expect(world.calls.some((argv) => argv[2] === "send-keys" || argv[2] === "run")).toBe(false);
  expect(readHerdrSessions(state.dir)[PANE]?.session).toBe(OLD_ID);
  expect(currentSession).toBe(OLD_ID);
});

test("refuses an active lead turn without sending Ctrl+C or changing the session record", async () => {
  // Given
  const deps = setup();
  world.screens[PANE] = "──────── • Working (4s • esc to interrupt) ────────\n❯ \n────────";
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  expect(result.code).toBe(2);
  expect(printed[0]).toBe(`HANDOVER_FAIL the lead has an active turn in ${PANE}`);
  expect(world.calls.some((argv) => argv[2] === "send-keys" && argv.at(-1) === "ctrl+c")).toBe(false);
  expect(world.calls.some((argv) => argv[2] === "run")).toBe(false);
  expect(readHerdrSessions(state.dir)[PANE]?.session).toBe(OLD_ID);
});

test("refuses to start a handover controller inside the pane it would stop", async () => {
  // Given
  const deps = setup();
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false, originPane: PANE });
  // Then
  expect(result.code).toBe(2);
  expect(printed[0]).toContain("outside its target pane");
  expect(world.calls).toEqual([]);
  expect(readHerdrSessions(state.dir)[PANE]?.session).toBe(OLD_ID);
});

test("starts a distinct session in the same pane and updates the revive record after the first input", async () => {
  // Given
  const deps = setup();
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  const record = readHerdrSessions(state.dir)[PANE];
  const firstStarted = started[0];
  const firstInput = world.calls.find((argv) => argv[0] === "herdr" && argv[2] === "send-text")?.[4] ?? "";
  if (!record || !firstStarted) throw new Error("the new session record or start command is missing");
  expect(result.code).toBe(0);
  expect(record.session).not.toBe(OLD_ID);
  expect(record.session).toBe(firstStarted);
  expect(currentSession).toBe(record.session);
  expect(world.calls.some((argv) => argv[0] === "herdr" && argv[2] === "run" && argv[3] === PANE)).toBe(true);
  expect(world.calls.some((argv) => argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create")).toBe(false);
  expect(firstInput).toContain(notePath(state.dir));
  expect(printed).toEqual([`HANDOVER_OK lead-handover ${OLD_ID} -> ${record.session} ${notePath(state.dir)}`]);
});

test("restores the old live session and keeps its record when the new session fails to start", async () => {
  // Given
  const deps = setup();
  rejectFreshStart = true;
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  expect(result.code).toBe(3);
  expect(printed[0]).toContain("HANDOVER_FAIL could not start the new session");
  expect(printed[0]).toContain(`old session ${OLD_ID} restored`);
  expect(currentSession).toBe(OLD_ID);
  expect(readHerdrSessions(state.dir)[PANE]?.session).toBe(OLD_ID);
  expect(started).toEqual([expect.any(String), OLD_ID]);
  expect(world.herdrDead?.includes(PANE)).toBe(false);
});

test("restores the old mapping if success reporting fails after the new id was written", async () => {
  // Given
  const base = setup();
  let failed = false;
  const deps: HandoverDeps = {
    ...base,
    print: (line) => {
      if (line.startsWith("HANDOVER_OK") && !failed) {
        failed = true;
        throw new Error("injected success output failure");
      }
      printed.push(line);
    },
  };
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  expect(result.code).toBe(3);
  expect(printed[0]).toContain("HANDOVER_FAIL injected success output failure");
  expect(printed[0]).toContain(`old session ${OLD_ID} restored`);
  expect(currentSession).toBe(OLD_ID);
  expect(readHerdrSessions(state.dir)[PANE]?.session).toBe(OLD_ID);
  expect(world.herdrDead?.includes(PANE)).toBe(false);
});

test("reports the session id actually on disk when the committed new agent cannot stop", async () => {
  // Given
  const base = setup();
  keepNewAgentAliveAfterCtrlC = true;
  let failSuccessOutput = true;
  const deps: HandoverDeps = {
    ...base,
    print: (line) => {
      if (line.startsWith("HANDOVER_OK") && failSuccessOutput) { failSuccessOutput = false; throw new Error("injected success output failure"); }
      printed.push(line);
    },
  };
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  const recorded = readHerdrSessions(state.dir)[PANE]?.session;
  expect(result.code).toBe(3);
  expect(recorded).toBe(currentSession);
  expect(recorded).not.toBe(OLD_ID);
  expect(printed[0]).toContain(`record now names ${recorded}`);
});

test("automatic lead busy refusal uses the configured retry path rather than the busy fast path", async () => {
  // Given
  const deps = { ...setup(), clock: fakeClock(Date.parse(`${DATE}T12:00:00.000Z`)) };
  world.screens[PANE] = "──────── • Working (4s • esc to interrupt) ────────\n❯ \n────────";
  // When
  const result = await automaticLeadSessionHandover(deps);
  // Then
  const last = readRollovers(state.dir).at(-1);
  if (!last || last.kind !== "rollover") throw new Error("the automatic attempt did not write a rollover result");
  expect(result.code).toBe(2);
  expect(result.line).toContain("active turn");
  expect(last.result).toBe("refused");
  expect(last.blocked).toBeUndefined();
  expect(currentSession).toBe(OLD_ID);
});

test("a handover lock refuses a second same-pane session transaction", async () => {
  // Given
  const deps = setup();
  writeFileSync(handoverLock(state.dir), JSON.stringify({ pid: process.pid, at: new Date(0).toISOString() }));
  // When
  const result = await leadSessionHandover(deps, { date: DATE, dryRun: false });
  // Then
  expect(result.code).toBe(2);
  expect(printed[0]).toContain("another lead session handover is running");
  expect(world.calls.some((argv) => argv[2] === "send-keys" && argv.at(-1) === "ctrl+c")).toBe(false);
  expect(readHerdrSessions(state.dir)[PANE]?.session).toBe(OLD_ID);
});

test("an in-flight herdr-session refresh cannot overwrite the newer record after handover commits", async () => {
  // Given
  const deps = setup();
  let changed = false;
  const baseRun = deps.run;
  const run: Runner = async (argv, options) => {
    const result = await baseRun(argv, options);
    if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "list" && !changed) {
      changed = true;
      recordHerdrSession(state.dir, PANE, { session: NEW_ID, cwd: state.dir, model: "provider/new", at: new Date(1).toISOString() });
    }
    return result;
  };
  // When
  const found = await herdrLeadSession(run, { stateDir: state.dir, sessionsDir: join(state.dir, "sessions") }, PANE, true);
  // Then
  expect(found).toBe(OLD_ID);
  expect(readHerdrSessions(state.dir)[PANE]?.session).toBe(NEW_ID);
});

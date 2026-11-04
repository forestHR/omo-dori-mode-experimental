import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Checkpoints } from "../src/checkpoints.ts";
import { loadConfig } from "../src/config.ts";
import { type Lane, Registry } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { defaultSupervision, HUNG_MESSAGE, laneSessionUsage, type SessionUsage, Supervision, type SupervisionSettings, supervisionProblem, transcriptUsage, workingTimer } from "../src/supervision.ts";
import { claimDone, closeLane, watchTick } from "../src/done-flow.ts";
import { takeLock } from "../src/checkpoints.ts";
import { keepSessions } from "../src/lane-handover.ts";
import { run } from "../src/run.ts";
import { freshnessTick } from "../src/freshness.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

// The meaning of dori-superagent #61's test/supervision.test.ts (15 cases, at 90f02c1), carried over to this fork, where a
// lane's reports are lane.lastReport in the registry instead of a reports.jsonl journal and an alert goes to the lead.
const start = Date.parse("2026-10-29T00:00:00Z");
const lane: Lane = { key: "demo-lane", title: "Demo", thread: "none", brief: "", done: "", pane: "w1:p9", openedAt: new Date(start).toISOString() };
const fixture = (settings: Partial<SupervisionSettings> = {}) => {
  const state = withState();
  const clock = fakeClock(start);
  const calls: string[][] = [];
  const alerts: string[] = [];
  let usage = '{"tokens":null,"costUsd":null}';
  let dirty = "";
  let session: SessionUsage | null = null;
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    return { code: 0, out: argv[0] === "usage" ? usage : argv[0] === "git" ? (argv.includes("rev-parse") ? argv[2] ?? "" : dirty) : "", err: "" };
  };
  const deps = { stateDir: state.dir, clock, run, alert: (_lane: Lane, message: string) => { alerts.push(message); return true; }, sessionUsage: async () => session };
  const options: SupervisionSettings = { ...defaultSupervision(), ...settings };
  return {
    ...state, clock, calls, alerts, deps, options, supervisor: new Supervision(deps, options),
    setUsage: (value: string) => { usage = value; }, setDirty: (value: string) => { dirty = value; }, setSession: (value: SessionUsage | null) => { session = value; },
  };
};

describe("supervision", () => {
  // upstream: "legacy lanes perform no commands or state writes"
  test("a lane that is not working, or has no pane, is not supervised: no commands, no state writes", async () => {
    const f = fixture({ usageArgv: ["usage"], defaults: { wallMinutes: 0 } });
    try {
      for (const off of [{ ...lane, status: "done-claimed" as const }, { ...lane, status: "paused" as const }, { ...lane, pane: undefined }]) {
        expect((await f.supervisor.sweep(off, "Working 40m")).enabled).toBe(false);
      }
      expect(f.calls).toEqual([]);
      expect(f.alerts).toEqual([]);
      expect(existsSync(join(f.dir, "lane-state"))).toBe(false);
    } finally { f.done(); }
  });

  test("with no caps and no usage hook a sweep runs no usage command and writes no cost record", async () => {
    const f = fixture();
    try {
      f.setSession({ session: "/s/a.jsonl", tokens: 5, costUsd: 1 });
      expect((await f.supervisor.sweep(lane, "")).usage).toBeNull();
      expect(f.calls).toEqual([]);
      expect(existsSync(join(f.dir, "lane-state", lane.key, "cost.jsonl"))).toBe(false);
    } finally { f.done(); }
  });

  test("growing same timer requires persisted observations and fresh-activity grace", async () => {
    const f = fixture();
    try {
      expect((await f.supervisor.sweep(lane, "Working (21m 0s)")).alerts).toEqual([]);
      f.clock.at += 20 * 60_000;
      const restarted = new Supervision(f.deps, f.options);
      const hung = await restarted.sweep(lane, "Working (41m 0s)");
      expect(hung.hung).toBe(true);
      expect(hung.alerts).toEqual([HUNG_MESSAGE]);
      expect(f.alerts).toHaveLength(1);
      f.clock.at += 60_000;
      expect((await restarted.sweep(lane, "Working (42m 0s)")).alerts).toEqual([]);
      expect(f.alerts).toHaveLength(1);
      expect(f.calls.some((args) => /kill|send-text|send-keys/.test(args.join(" ")))).toBe(false);
    } finally { f.done(); }
  });

  test("timer reset, frozen timer, and changed timer origin do not mark hung", async () => {
    const f = fixture({ staleAfterMinutes: 0 });
    try {
      await f.supervisor.sweep(lane, "Working 25m");
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 25m")).alerts).toEqual([]);
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 1m")).alerts).toEqual([]);
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 30m")).alerts).toEqual([]);
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Running 31m")).alerts).toEqual([]);
    } finally { f.done(); }
  });

  test("a minute-rounded timer is hung even when sweeps do not line up with its minute boundary", async () => {
    const f = fixture({ staleAfterMinutes: 0 });
    try {
      await f.supervisor.sweep(lane, "Working 25m");
      f.clock.at += 90_000; // the real timer went 25m10s -> 26m40s and shows 26m
      expect((await f.supervisor.sweep(lane, "Working 26m")).hung).toBe(true);
    } finally { f.done(); }
  });

  test("hungAfterMinutes 0 turns hung detection off", async () => {
    const f = fixture({ hungAfterMinutes: 0, staleAfterMinutes: 0 });
    try {
      await f.supervisor.sweep(lane, "Working 25m");
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 26m")).hung).toBe(false);
    } finally { f.done(); }
  });

  test("report and checkpoint progress suppress hung detection until stale", async () => {
    const f = fixture();
    try {
      await f.supervisor.sweep({ ...lane, lastReport: "[REPORT] demo-lane | milestone | starting" }, "Working 21m");
      f.clock.at += 20 * 60_000;
      const progressed = { ...lane, lastReport: "[REPORT] demo-lane | milestone | progress" };
      expect((await f.supervisor.sweep(progressed, "Working 41m")).hung).toBe(false);
      f.clock.at += 20 * 60_000;
      new Checkpoints(f.dir).write(lane.key, { step: "build", result: "ok", evidence: [], remoteEffects: [] }, f.clock.now());
      expect((await f.supervisor.sweep(progressed, "Working 61m")).hung).toBe(false);
      f.clock.at += 20 * 60_000;
      expect((await f.supervisor.sweep(progressed, "Working 81m")).hung).toBe(true);
    } finally { f.done(); }
  });

  test("an explicit activity file that is a symlink: writes through the unchanged link count as progress", async () => {
    const f = fixture();
    try {
      const target = join(f.dir, "train.log");
      writeFileSync(target, "step 1\n");
      symlinkSync(target, join(f.dir, "latest.log"));
      const activeLane = { ...lane, cwd: f.dir, activityPaths: ["latest.log"] };
      await f.supervisor.sweep(activeLane, "Running 21m");
      f.clock.at += 20 * 60_000;
      appendFileSync(target, "step 2\n");
      expect((await f.supervisor.sweep(activeLane, "Running 41m")).hung).toBe(false);
      f.clock.at += 20 * 60_000;
      expect((await f.supervisor.sweep(activeLane, "Running 61m")).hung).toBe(true);
    } finally { f.done(); }
  });

  test("explicit file and git changed-file activity suppress stalls without scanning", async () => {
    const f = fixture();
    try {
      const path = join(f.dir, "source.ts");
      writeFileSync(path, "first");
      const activeLane = { ...lane, cwd: f.dir, activityPaths: [path] };
      await f.supervisor.sweep(activeLane, "Running 21m");
      f.clock.at += 20 * 60_000;
      utimesSync(path, new Date(f.clock.at), new Date(f.clock.at));
      expect((await f.supervisor.sweep(activeLane, "Running 41m")).hung).toBe(false);
      f.clock.at += 20 * 60_000;
      f.setDirty(" M source.ts\0?? node_modules/\0");
      expect((await f.supervisor.sweep(activeLane, "Running 61m")).hung).toBe(false);
      f.clock.at += 20 * 60_000;
      expect((await f.supervisor.sweep(activeLane, "Running 81m")).hung).toBe(true);
      f.clock.at += 60_000;
      utimesSync(path, new Date(f.clock.at), new Date(f.clock.at));
      expect((await f.supervisor.sweep(activeLane, "Running 82m")).hung).toBe(false);
      expect(f.calls.every((args) => args[0] === "git")).toBe(true);
    } finally { f.done(); }
  });

  test("changes under node_modules or outside the lane's cwd are not activity", async () => {
    const f = fixture();
    try {
      const activeLane = { ...lane, cwd: f.dir };
      f.setDirty(" M node_modules/a/index.js\0");
      await f.supervisor.sweep(activeLane, "Running 21m");
      f.clock.at += 20 * 60_000;
      f.setDirty(" M node_modules/b/index.js\0 M ../elsewhere.ts\0");
      expect((await f.supervisor.sweep(activeLane, "Running 41m")).hung).toBe(true);
    } finally { f.done(); }
  });

  test("caps alert the lead without stopping the lane, support per-lane overrides and deduplicate alerts", async () => {
    const f = fixture({ usageArgv: ["usage", "{key}"], defaults: { wallMinutes: 100, tokens: 1000, costUsd: 10 }, lanes: { "demo-lane": { wallMinutes: 1, tokens: 10, costUsd: 1 } } });
    try {
      f.setUsage('{"tokens":10,"costUsd":1}');
      f.clock.at += 60_000;
      const result = await f.supervisor.sweep(lane, "Working 1m");
      expect(result.usage).toEqual({ key: lane.key, at: new Date(f.clock.at).toISOString(), tokens: 10, costUsd: 1 });
      expect(result.alerts).toEqual(["wallMinutes ceiling reached (1)", "tokens ceiling reached (10)", "costUsd ceiling reached (1)"]);
      expect(f.alerts).toEqual([...result.alerts]);
      f.setUsage('{"tokens":11,"costUsd":2}');
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 2m")).alerts).toEqual([]);
      expect(f.calls).toEqual([["usage", lane.key], ["usage", lane.key]]);
      expect(f.calls.some((args) => /kill|send-text|send-keys|close/.test(args.join(" ")))).toBe(false);
    } finally { f.done(); }
  });

  // upstream: "a ceiling reached while the lane waits on a question still appends a durable blocker"
  test("a cap reached while the lane's last report is a question still alerts once, and the record survives a restart", async () => {
    const f = fixture({ defaults: { wallMinutes: 1 } });
    try {
      const asking = { ...lane, lastReport: "[REPORT] demo-lane | question | which branch?" };
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(asking, "")).alerts).toEqual(["wallMinutes ceiling reached (1)"]);
      const saved = JSON.parse(readFileSync(join(f.dir, "lane-state", lane.key, "supervision.json"), "utf8")) as { alerts: string[] };
      expect(saved.alerts).toEqual(["wallMinutes ceiling reached (1)"]);
      f.clock.at += 60_000;
      expect((await new Supervision(f.deps, f.options).sweep(asking, "")).alerts).toEqual([]);
      expect(f.alerts).toEqual(["wallMinutes ceiling reached (1)"]);
    } finally { f.done(); }
  });

  test("an alert whose delivery failed is sent again on the next sweep, and a delivered one is not", async () => {
    const f = fixture({ defaults: { wallMinutes: 1 } });
    try {
      const sent: string[] = [];
      let mode: "throw" | "false" | "ok" = "throw";
      const supervisor = new Supervision({ ...f.deps, alert: (_lane: Lane, message: string) => {
        if (mode === "throw") throw new Error("messenger down");
        if (mode === "false") return false;
        sent.push(message);
        return true;
      } }, f.options);
      f.clock.at += 60_000;
      expect((await supervisor.sweep(lane, "")).undelivered).toEqual(["wallMinutes ceiling reached (1)"]);
      mode = "false";
      f.clock.at += 60_000;
      expect((await supervisor.sweep(lane, "")).undelivered).toEqual(["wallMinutes ceiling reached (1)"]);
      mode = "ok";
      f.clock.at += 60_000;
      expect((await supervisor.sweep(lane, "")).alerts).toEqual(["wallMinutes ceiling reached (1)"]);
      f.clock.at += 60_000;
      expect((await supervisor.sweep(lane, "")).alerts).toEqual([]);
      expect(sent).toEqual(["wallMinutes ceiling reached (1)"]);
    } finally { f.done(); }
  });

  test("a raised cap is not reached; reaching the new one alerts again", async () => {
    const f = fixture({ defaults: { wallMinutes: 1 } });
    try {
      f.clock.at += 2 * 60_000;
      expect((await f.supervisor.sweep(lane, "")).alerts).toEqual(["wallMinutes ceiling reached (1)"]);
      const raised = { ...lane, budget: { wallMinutes: 5 } };
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(raised, "")).capped).toEqual([]);
      f.clock.at += 2 * 60_000;
      expect((await f.supervisor.sweep(raised, "")).alerts).toEqual(["wallMinutes ceiling reached (5)"]);
    } finally { f.done(); }
  });

  test("lane caps override defaults and unknown usage stays null in the persisted close snapshot", async () => {
    const f = fixture({ usageArgv: ["usage"], recordCostArgv: ["record", "{key}", "{tokens}", "{costUsd}"], defaults: { wallMinutes: 0, tokens: 0, costUsd: 0 } });
    try {
      f.setUsage('{"tokens":-1,"costUsd":"not-known"}');
      const result = await f.supervisor.sweep({ ...lane, budget: { wallMinutes: null } }, "Working 1m");
      expect(result.capped).toEqual([]);
      expect(result.usage?.tokens).toBeNull();
      expect(result.usage?.costUsd).toBeNull();
      expect(result.alerts).toEqual(["tokens ceiling cannot be checked: usage unavailable", "costUsd ceiling cannot be checked: usage unavailable"]);
      f.setUsage("malformed");
      const snapshot = await f.supervisor.close(lane);
      expect(snapshot.tokens).toBeNull();
      expect(f.calls.some((args) => args[0] === "record")).toBe(false);
      const stored = readFileSync(join(f.dir, "lane-state", lane.key, "cost.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(stored.at(-1)).toEqual(snapshot);
    } finally { f.done(); }
  });

  test("available cumulative usage reaches the optional close recording hook", async () => {
    const f = fixture({ usageArgv: ["usage"], recordCostArgv: ["record", "{key}", "{tokens}", "{costUsd}"] });
    try {
      f.setUsage('{"tokens":1234,"costUsd":0.25}');
      const snapshot = await f.supervisor.close(lane);
      expect(snapshot.tokens).toBe(1234);
      expect(f.calls.at(-1)).toEqual(["record", lane.key, "1234", "0.25"]);
    } finally { f.done(); }
  });

  test("a second close keeps the first final reading and runs the cost hook once, with a stable close key", async () => {
    const f = fixture({ usageArgv: ["usage"], recordCostArgv: ["record", "{closeKey}", "{tokens}"] });
    try {
      f.setUsage('{"tokens":1234,"costUsd":0.25}');
      const first = await f.supervisor.close(lane);
      f.setUsage('{"tokens":9999,"costUsd":9}');
      f.clock.at += 60_000;
      expect(await new Supervision(f.deps, f.options).close(lane)).toEqual(first);
      expect(f.calls.filter((args) => args[0] === "record")).toEqual([["record", `${lane.key}@${lane.openedAt}`, "1234"]]);
    } finally { f.done(); }
  });

  test("a cost record torn by a crash mid-line is skipped: the close still reads the rest and records once", async () => {
    const f = fixture({ usageArgv: ["usage"], recordCostArgv: ["record", "{tokens}"] });
    try {
      f.setUsage('{"tokens":5,"costUsd":0.1}');
      await f.supervisor.sweep(lane, "");
      appendFileSync(join(f.dir, "lane-state", lane.key, "cost.jsonl"), '{"key":"demo-lane","at":"2026-');
      const closed = await f.supervisor.close(lane);
      expect(closed).toMatchObject({ tokens: 5, final: true });
      expect(await f.supervisor.close(lane)).toEqual(closed);
      expect(f.calls.filter((args) => args[0] === "record")).toHaveLength(1);
    } finally { f.done(); }
  });

  test("a failing cost hook keeps a plain reading, so the next close runs it again", async () => {
    const f = fixture({ usageArgv: ["usage"], recordCostArgv: ["record", "{tokens}"] });
    try {
      f.setUsage('{"tokens":7,"costUsd":0.5}');
      let fail = true;
      const supervisor = new Supervision({ ...f.deps, run: async (argv) => {
        f.calls.push([...argv]);
        if (argv[0] === "record" && fail) return { code: 1, out: "", err: "ledger down" };
        return { code: 0, out: argv[0] === "usage" ? '{"tokens":7,"costUsd":0.5}' : "", err: "" };
      } }, f.options);
      await expect(supervisor.close(lane)).rejects.toThrow("recordCost failed for demo-lane: ledger down");
      fail = false;
      expect((await supervisor.close(lane)).final).toBe(true);
      expect(f.calls.filter((args) => args[0] === "record")).toHaveLength(2);
    } finally { f.done(); }
  });

  // upstream: "terminal progress is not overwritten by budget or hung reports"
  test("a lane told about its cap that then hangs is told that too", async () => {
    const f = fixture({ defaults: { wallMinutes: 1 }, staleAfterMinutes: 0 });
    try {
      f.clock.at += 2 * 60_000;
      expect((await f.supervisor.sweep(lane, "Working 25m")).alerts).toEqual(["wallMinutes ceiling reached (1)"]);
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 26m")).alerts).toEqual([HUNG_MESSAGE]);
      expect(f.alerts).toEqual(["wallMinutes ceiling reached (1)", HUNG_MESSAGE]);
    } finally { f.done(); }
  });

  test("two closes at once take turns: the one that finds the cost record taken is refused and runs no hook", async () => {
    const f = fixture({ usageArgv: ["usage"], recordCostArgv: ["record", "{tokens}"] });
    try {
      f.setUsage('{"tokens":7,"costUsd":0.5}');
      const dir = join(f.dir, "lane-state", lane.key);
      mkdirSync(dir, { recursive: true });
      const held = takeLock(join(dir, "cost.lock"), f.clock.now(), "cost record", lane.key);
      await expect(f.supervisor.close(lane)).rejects.toThrow(`cost record locked: ${lane.key}`);
      expect(f.calls.some((args) => args[0] === "record")).toBe(false);
      held();
      expect((await f.supervisor.close(lane)).final).toBe(true);
      expect((await f.supervisor.close(lane)).final).toBe(true);
      expect(f.calls.filter((args) => args[0] === "record")).toHaveLength(1);
    } finally { f.done(); }
  });

  test("a lane working in a subdirectory of its repository: git's root-relative changed paths count as its activity", async () => {
    const f = fixture();
    try {
      const repo = join(f.dir, "repo");
      const file = join(repo, "sub", "a.ts");
      mkdirSync(join(repo, "sub"), { recursive: true });
      writeFileSync(file, "one");
      const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
      git("init", "-q");
      git("add", ".");
      git("commit", "-qm", "one");
      writeFileSync(file, "two");
      const real = new Supervision({ ...f.deps, run }, f.options);
      const inSub = { ...lane, cwd: join(repo, "sub") };
      await real.sweep(inSub, "Running 21m");
      f.clock.at += 20 * 60_000;
      utimesSync(file, new Date(f.clock.at), new Date(f.clock.at));
      expect((await real.sweep(inSub, "Running 41m")).hung).toBe(false);
      f.clock.at += 20 * 60_000;
      expect((await real.sweep(inSub, "Running 61m")).hung).toBe(true);
    } finally { f.done(); }
  });

  test("a lane told not done keeps working and stays supervised: its cap and a hung call still reach the lead", async () => {
    const f = fixture({ defaults: { wallMinutes: 1 }, staleAfterMinutes: 0 });
    try {
      const rejected = { ...lane, status: "not-done" as const };
      f.clock.at += 2 * 60_000;
      expect((await f.supervisor.sweep(rejected, "Working 25m")).alerts).toEqual(["wallMinutes ceiling reached (1)"]);
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(rejected, "Working 26m")).alerts).toEqual([HUNG_MESSAGE]);
    } finally { f.done(); }
  });

  test("a file written inside an untracked directory counts as activity", async () => {
    const f = fixture();
    try {
      const repo = join(f.dir, "repo");
      mkdirSync(join(repo, "out"), { recursive: true });
      writeFileSync(join(repo, "a.ts"), "one");
      const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
      git("init", "-q");
      git("add", "a.ts");
      git("commit", "-qm", "one");
      const log = join(repo, "out", "train.log");
      writeFileSync(log, "step 1\n");
      const real = new Supervision({ ...f.deps, run }, f.options);
      const working = { ...lane, cwd: repo };
      await real.sweep(working, "Running 21m");
      f.clock.at += 20 * 60_000;
      appendFileSync(log, "step 2\n");
      utimesSync(log, new Date(f.clock.at), new Date(f.clock.at));
      expect((await real.sweep(working, "Running 41m")).hung).toBe(false);
    } finally { f.done(); }
  });

  test("a lane whose cwd is a symlink into its repository: changes git prints under the real path count", async () => {
    const f = fixture();
    try {
      const repo = join(f.dir, "repo");
      mkdirSync(repo, { recursive: true });
      const file = join(repo, "a.ts");
      writeFileSync(file, "one");
      const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
      git("init", "-q");
      git("add", ".");
      git("commit", "-qm", "one");
      writeFileSync(file, "two");
      const link = join(f.dir, "link");
      symlinkSync(repo, link);
      const real = new Supervision({ ...f.deps, run }, f.options);
      const linked = { ...lane, cwd: link };
      await real.sweep(linked, "Running 21m");
      f.clock.at += 20 * 60_000;
      utimesSync(file, new Date(f.clock.at), new Date(f.clock.at));
      expect((await real.sweep(linked, "Running 41m")).hung).toBe(false);
    } finally { f.done(); }
  });

  test("a lane that claimed done is not alerted on, even past its caps with a long timer", async () => {
    const f = fixture({ defaults: { wallMinutes: 0 }, staleAfterMinutes: 0 });
    try {
      const claimed = { ...lane, status: "done-claimed" as const };
      await f.supervisor.sweep(claimed, "Working 30m");
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(claimed, "Working 31m")).alerts).toEqual([]);
      expect(f.alerts).toEqual([]);
    } finally { f.done(); }
  });

  test("parses visible timer variants but not unrelated or absent durations", () => {
    expect(workingTimer("\x1b[32m* Working (1h 2m 3s)\x1b[0m")).toEqual({ kind: "working", seconds: 3723, step: 1 });
    expect(workingTimer("Running 21:05")).toEqual({ kind: "running", seconds: 1265, step: 1 });
    expect(workingTimer("Working 25m")).toEqual({ kind: "working", seconds: 1500, step: 60 });
    expect(workingTimer("Running 1:02:03")).toEqual({ kind: "running", seconds: 3723, step: 1 });
    expect(workingTimer("── • Running bash (2m 5s • esc to interrupt) ──")).toEqual({ kind: "running", seconds: 125, step: 1 });
    expect(workingTimer("Working ...")).toBeNull();
    expect(workingTimer("log mentions Working 20m")).toBeNull();
  });
});

describe("usage from the lane's omo transcript", () => {
  const turn = (at: string, tokens: number, cost?: number) =>
    JSON.stringify({ type: "message", timestamp: at, message: { role: "assistant", usage: { totalTokens: tokens, ...(cost === undefined ? {} : { cost: { total: cost } }) } } });

  test("sums the assistant turns since the lane opened; a turn without a cost leaves the cost unknown", () => {
    const text = [turn("2026-10-28T23:00:00Z", 999, 9), turn("2026-10-29T00:01:00Z", 100, 0.5), JSON.stringify({ type: "message", timestamp: "2026-10-29T00:02:00Z", message: { role: "user", usage: { totalTokens: 7 } } }), turn("2026-10-29T00:03:00Z", 50, 0.25), "{\"usage\": broken"].join("\n");
    expect(transcriptUsage(text, lane.openedAt)).toEqual({ tokens: 150, costUsd: 0.75 });
    expect(transcriptUsage([text, turn("2026-10-29T00:04:00Z", 10)].join("\n"), lane.openedAt)).toEqual({ tokens: 160, costUsd: null });
  });

  test("every session the lane had counts, read whole from its transcript; a session with no transcript leaves the usage unknown", async () => {
    const state = withState();
    try {
      const sessionsDir = join(state.dir, "sessions");
      const cwd = "/work/repo";
      const dir = sessionDirFor(sessionsDir, cwd);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "2026-10-29T00-00-00_old-1.jsonl"), [turn("2026-10-29T00:01:00Z", 200, 1), turn("2026-10-29T03:00:00Z", 50, 0.5)].join("\n"));
      writeFileSync(join(dir, "2026-10-29T04-00-00_new-2.jsonl"), turn("2026-10-29T04:01:00Z", 120, 0.25));
      const read = laneSessionUsage(async () => ({ code: 1, out: "", err: "" }), sessionsDir);
      const moved = { ...lane, cwd, session: "new-2", priorSessions: ["old-1"] };
      expect(await read(moved)).toEqual({ session: "old-1,new-2", tokens: 370, costUsd: 1.75 });
      expect(await read({ ...moved, priorSessions: ["gone-0", "old-1"] })).toBeNull();
      const f = fixture({ defaults: { tokens: 300 } });
      try {
        const capped = await new Supervision({ ...f.deps, sessionUsage: read }, f.options).sweep(moved, "");
        expect(capped.alerts).toEqual(["tokens ceiling reached (300)"]);
      } finally { f.done(); }
    } finally { state.done(); }
  });

  test("a lane whose cwd is a symlink: sessions filed under the written path and under its real path both count", async () => {
    const state = withState();
    try {
      const sessionsDir = join(state.dir, "sessions");
      const real = join(state.dir, "real-repo");
      const link = join(state.dir, "link-repo");
      mkdirSync(real, { recursive: true });
      symlinkSync(real, link);
      mkdirSync(sessionDirFor(sessionsDir, link), { recursive: true });
      mkdirSync(sessionDirFor(sessionsDir, real), { recursive: true });
      writeFileSync(join(sessionDirFor(sessionsDir, link), "a_old-1.jsonl"), turn("2026-10-29T00:01:00Z", 200, 1));
      writeFileSync(join(sessionDirFor(sessionsDir, real), "b_new-2.jsonl"), turn("2026-10-29T04:01:00Z", 120, 0.25));
      const read = laneSessionUsage(async () => ({ code: 1, out: "", err: "" }), sessionsDir);
      expect(await read({ ...lane, cwd: link, session: "new-2", priorSessions: ["old-1"] })).toEqual({ session: "old-1,new-2", tokens: 320, costUsd: 1.25 });
    } finally { state.done(); }
  });

  test("a session is found by its id wherever omo filed it: an adopted lane whose recorded cwd is not where it runs", async () => {
    const state = withState();
    try {
      const sessionsDir = join(state.dir, "sessions");
      mkdirSync(join(sessionsDir, "--home-me-project--"), { recursive: true });
      writeFileSync(join(sessionsDir, "--home-me-project--", "a_s9.jsonl"), turn("2026-10-29T00:01:00Z", 42, 0.5));
      const read = laneSessionUsage(async () => ({ code: 1, out: "", err: "" }), sessionsDir);
      expect(await read({ ...lane, cwd: "/home/me/default-cwd", session: "s9" })).toEqual({ session: "s9", tokens: 42, costUsd: 0.5 });
    } finally { state.done(); }
  });

  test("no transcript means unknown usage, and a token cap says it cannot be checked", async () => {
    const f = fixture({ defaults: { tokens: 300 } });
    try {
      expect((await f.supervisor.sweep(lane, "")).alerts).toEqual(["tokens ceiling cannot be checked: usage unavailable"]);
    } finally { f.done(); }
  });
});

describe("a lane's session history", () => {
  test("whatever path changes a lane's session, the registry keeps the outgoing one, once and in order", async () => {
    const state = withState();
    try {
      const registry = new Registry(state.dir);
      await registry.write({ ...lane, session: "s1" });
      await registry.patch(lane.key, { session: "s2" });
      await registry.write({ ...lane, session: "s3" });
      await registry.patch(lane.key, { lastReport: "[REPORT] demo-lane | milestone | x" });
      await registry.patch(lane.key, { session: "s1" });
      expect(await registry.read(lane.key)).toMatchObject({ session: "s1", priorSessions: ["s2", "s3"] });
    } finally { state.done(); }
  });
});

describe("a move whose new session is not known yet", () => {
  test("leaves the lane with no current session and its usage unknown, never the old transcript twice", async () => {
    const state = withState();
    try {
      const registry = new Registry(state.dir);
      await registry.write({ ...lane, session: "s1" });
      await keepSessions({ registry } as never, lane.key, "", "");
      const moved = await registry.read(lane.key);
      expect(moved?.session).toBeUndefined();
      expect(moved?.priorSessions).toEqual(["s1"]);
      const sessionsDir = join(state.dir, "sessions");
      mkdirSync(join(sessionsDir, "--work--"), { recursive: true });
      writeFileSync(join(sessionsDir, "--work--", "a_s1.jsonl"), JSON.stringify({ type: "message", timestamp: "2026-10-29T00:01:00Z", message: { role: "assistant", usage: { totalTokens: 100, cost: { total: 1 } } } }));
      expect(await laneSessionUsage(async () => ({ code: 1, out: "", err: "" }), sessionsDir)(moved as Lane)).toBeNull();
    } finally { state.done(); }
  });
});

describe("supervision config", () => {
  test("a misspelt or malformed supervision entry is refused by name, never dropped", async () => {
    expect(supervisionProblem(undefined)).toBeUndefined();
    expect(supervisionProblem({ defaults: { wallMinutes: 600, tokens: null }, lanes: { a: { costUsd: 5 } }, hungAfterMinutes: 0 })).toBeUndefined();
    expect(supervisionProblem({ defaults: { toknes: 5 } })).toContain("supervision.defaults.toknes is not a ceiling");
    expect(supervisionProblem({ lanes: { a: { costUSD: 1 } } })).toContain("supervision.lanes.a.costUSD is not a ceiling");
    expect(supervisionProblem({ lanes: { a: null } })).toContain("supervision.lanes.a must be an object");
    expect(supervisionProblem({ defaults: { wallMinutes: -1 } })).toContain("must be a number >= 0 or null");
    expect(supervisionProblem({ usageArgv: "usage" })).toContain("supervision.usageArgv must be a list of strings");
    expect(supervisionProblem({ hungAfter: 5 })).toContain("supervision.hungAfter is not a supervision setting");
    const state = withState();
    try {
      const path = join(state.dir, "config.json");
      writeFileSync(path, JSON.stringify({ supervision: { defaults: { toknes: 5 } } }));
      await expect(loadConfig(path, state.dir, () => {})).rejects.toThrow("invalid supervision.defaults.toknes is not a ceiling");
      writeFileSync(path, JSON.stringify({}));
      const config = await loadConfig(path, state.dir, () => {});
      expect(config.supervision.defaults).toEqual({ wallMinutes: null, tokens: null, costUsd: null });
      expect(config.supervision.hungAfterMinutes).toBe(20);
    } finally { state.done(); }
  });
});

describe("supervision in the freshness sweep and the close", () => {
  const T0 = Date.parse("2026-01-01T12:00:00.000Z");
  const working: Lane = { key: "quiet-lane", title: "quiet", thread: "none", pane: "w:p7", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };
  const typed = (calls: string[][], pane: string): string[] => calls.flatMap((c) => (c[0] === "herdr" && c[2] === "send-text" && c[3] === pane ? [c[4] ?? ""] : []));

  test("a lane at its cap: freshness tells the lead once and types nothing into the lane", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { nudgeAfterMin: 999, supervision: { ...defaultSupervision(), defaults: { wallMinutes: 5 } } });
      await deps(T0).registry.write(working);
      expect((await freshnessTick(deps(T0 + 4 * 60_000), "/home/test")).filter((a) => a.kind === "lane_cap")).toEqual([]);
      const capped = (await freshnessTick(deps(T0 + 6 * 60_000), "/home/test")).filter((a) => a.kind === "lane_cap");
      expect(capped.map((a) => [a.lane, a.detail.split(";")[0]])).toEqual([["quiet-lane", "wallMinutes ceiling reached (5)"]]);
      expect(typed(world.calls, "lead:p1").filter((t) => t.startsWith("[DORI] quiet-lane: wallMinutes ceiling reached (5)"))).toHaveLength(1);
      expect((await freshnessTick(deps(T0 + 7 * 60_000), "/home/test")).filter((a) => a.kind === "lane_cap")).toEqual([]);
      expect(typed(world.calls, "w:p7")).toEqual([]);
      expect(world.calls.some((c) => c.includes("close") || c.includes("kill"))).toBe(false);
    } finally { state.done(); }
  });

  test("a lane told not done is still swept: its cap reaches the lead", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const deps = depsFor(world, fakeClock(T0 + 6 * 60_000), state.dir, { nudgeAfterMin: 999, supervision: { ...defaultSupervision(), defaults: { wallMinutes: 5 } } });
      await deps.registry.write({ ...working, status: "not-done" });
      expect((await freshnessTick(deps, "/home/test")).filter((a) => a.kind === "lane_cap").map((a) => a.detail.split(";")[0])).toEqual(["wallMinutes ceiling reached (5)"]);
    } finally { state.done(); }
  });

  test("a lane told not done that keeps reporting is not called hung: its new report counts as progress", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { nudgeAfterMin: 999 });
      await deps(T0).registry.write({ ...working, status: "not-done", lastReport: "[REPORT] quiet-lane | milestone | first" });
      world.screens["w:p7"] = "── • Running bash (21m 0s • esc to interrupt) ──\n❯ ";
      world.screens["lead:p1"] = " [REPORT] quiet-lane | milestone | first\n❯ ";
      await freshnessTick(deps(T0), "/home/test");
      world.screens["w:p7"] = "── • Running bash (41m 0s • esc to interrupt) ──\n❯ ";
      world.screens["lead:p1"] = " [REPORT] quiet-lane | milestone | first\n [REPORT] quiet-lane | milestone | objection fixed, rerunning the checks\n❯ ";
      expect((await freshnessTick(deps(T0 + 20 * 60_000), "/home/test")).filter((a) => a.kind === "stalled")).toEqual([]);
      expect((await deps(T0).registry.read("quiet-lane"))?.lastReport).toContain("objection fixed");
    } finally { state.done(); }
  });

  test("with no lead pane the cap note counts as not sent: once a lead pane is set, it goes out", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const deps = (ms: number, leadPane: string) => depsFor(world, fakeClock(ms), state.dir, { leadPane, nudgeAfterMin: 999, supervision: { ...defaultSupervision(), defaults: { wallMinutes: 5 } } });
      await deps(T0, "").registry.write(working);
      const first = (await freshnessTick(deps(T0 + 6 * 60_000, ""), "/home/test")).filter((a) => a.kind === "lane_cap");
      expect(first.map((a) => a.detail)).toEqual(["wallMinutes ceiling reached (5); lead not told: leadPane is not configured; sent again next sweep"]);
      const second = (await freshnessTick(deps(T0 + 7 * 60_000, "lead:p1"), "/home/test")).filter((a) => a.kind === "lane_cap");
      expect(second.map((a) => a.detail)).toEqual(["wallMinutes ceiling reached (5); lead told"]);
    } finally { state.done(); }
  });

  test("with no supervision config nothing is capped, however long the lane runs", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const deps = depsFor(world, fakeClock(T0 + 30 * 24 * 60 * 60_000), state.dir, { nudgeAfterMin: 999_999 });
      await deps.registry.write(working);
      expect((await freshnessTick(deps, "/home/test")).filter((a) => ["lane_cap", "usage_unknown", "supervision_error"].includes(a.kind))).toEqual([]);
    } finally { state.done(); }
  });

  test("an unreadable supervision state is started over and said once; the lane stays supervised", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const deps = depsFor(world, fakeClock(T0), state.dir, { nudgeAfterMin: 999 });
      await deps.registry.write(working);
      const path = join(state.dir, "lane-state", "quiet-lane", "supervision.json");
      mkdirSync(join(state.dir, "lane-state", "quiet-lane"), { recursive: true });
      writeFileSync(path, "{not json");
      expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).toEqual(["supervision_error"]);
      expect(JSON.parse(readFileSync(path, "utf8")).alerts).toEqual([]);
      expect(await freshnessTick(deps, "/home/test")).toEqual([]);
    } finally { state.done(); }
  });

  test("a close refused after its Done signals (no summary for a thread) records no cost; the close that goes through takes the reading then", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const deps = depsFor(world, fakeClock(T0), state.dir);
      const threaded = { ...working, thread: "discord:1566844859174756462" };
      await deps.registry.write(threaded);
      const refused = await closeLane(deps, threaded, "verified");
      expect(refused.closed).toBe(false);
      expect(refused.lines.some((l) => l.startsWith("COST "))).toBe(false);
      expect(existsSync(join(state.dir, "lane-state", "quiet-lane", "cost.jsonl"))).toBe(false);
      const closed = await closeLane(deps, working, "verified");
      expect(closed.closed).toBe(true);
      expect(closed.lines).toContain("COST quiet-lane tokens=unknown costUsd=unknown");
    } finally { state.done(); }
  });

  test("a close that finds another close taking the cost tears nothing down; once that one is gone the close goes through", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const deps = depsFor(world, fakeClock(T0), state.dir);
      await deps.registry.write(working);
      const dir = join(state.dir, "lane-state", "quiet-lane");
      mkdirSync(dir, { recursive: true });
      const held = takeLock(join(dir, "cost.lock"), T0, "cost record", "quiet-lane");
      const busy = await closeLane(deps, working, "verified");
      expect(busy.closed).toBe(false);
      expect(busy.lines.at(-1)).toStartWith("CLOSE_IN_PROGRESS quiet-lane: cost record locked: quiet-lane");
      expect(world.calls.some((c) => c.includes("close") || (c.includes("worktree") && c.includes("remove")))).toBe(false);
      expect((await deps.registry.read("quiet-lane"))?.status).not.toBe("closed");
      held();
      const closed = await closeLane(deps, working, "verified");
      expect(closed.closed).toBe(true);
      expect(closed.lines).toContain("COST quiet-lane tokens=unknown costUsd=unknown");
    } finally { state.done(); }
  });

  test("the watcher's close that finds a manual close taking the cost leaves the lane to it and does not tell the lane it is not done", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const at = (ms: number) => depsFor(world, fakeClock(ms), state.dir);
      const claimed = { ...working, done: "file /etc/hostname" };
      await at(T0).registry.write(claimed);
      await claimDone(at(T0), claimed, "file written");
      const dir = join(state.dir, "lane-state", "quiet-lane");
      mkdirSync(dir, { recursive: true });
      const held = takeLock(join(dir, "cost.lock"), T0, "cost record", "quiet-lane");
      const sent = world.calls.length;
      const lines = await watchTick(at(T0 + 5 * 60_000 + 1));
      held();
      expect(lines.some((l) => l.startsWith("CLOSE_IN_PROGRESS quiet-lane"))).toBe(true);
      expect(lines.some((l) => l.startsWith("LANE_CLOSED") || l.startsWith("NOT_DONE"))).toBe(false);
      expect(typed(world.calls.slice(sent), "w:p7")).toEqual([]);
      expect(world.calls.slice(sent).some((c) => c.includes("close") || (c.includes("worktree") && c.includes("remove")))).toBe(false);
      expect((await at(T0).registry.read("quiet-lane"))?.status).toBe("verified-done");
    } finally { state.done(); }
  });

  test("an automatic close by the watcher prints the lane's COST line too", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const at = (ms: number) => depsFor(world, fakeClock(ms), state.dir);
      const claimed = { ...working, done: "file /etc/hostname" };
      await at(T0).registry.write(claimed);
      await claimDone(at(T0), claimed, "file written");
      const lines = await watchTick(at(T0 + 5 * 60_000 + 1));
      expect(lines.at(-1)).toStartWith("LANE_CLOSED quiet-lane");
      expect(lines).toContain("COST quiet-lane tokens=unknown costUsd=unknown");
    } finally { state.done(); }
  });

  test("a close prints the lane's cost and records it once", async () => {
    const state = withState();
    try {
      const world = newWorld();
      const deps = depsFor(world, fakeClock(T0), state.dir);
      await deps.registry.write(working);
      const r = await closeLane(deps, working, "verified");
      expect(r.lines).toContain("COST quiet-lane tokens=unknown costUsd=unknown");
      const stored = readFileSync(join(state.dir, "lane-state", "quiet-lane", "cost.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ key: "quiet-lane", tokens: null, costUsd: null, final: true });
    } finally { state.done(); }
  });
});

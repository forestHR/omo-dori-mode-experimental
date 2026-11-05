import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argvSessionLog, herdrLeadSession, readHerdrSessions, recordHerdrSession, reviveHerdr } from "../src/herdr-sessions.ts";
import { findLead } from "../src/lead.ts";
import { leadDownTick } from "../src/lead-down.ts";
import type { Runner } from "../src/run.ts";
import { sessionDirFor, winArgv } from "../src/session-id.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, type World } from "./fakes.ts";

// The names, values and arguments a Windows agent line carries, decoded from its base64 data in order.
const winData = (line: string): string[] => [...line.matchAll(/FromBase64String\('([^']*)'\)/g)].map((m) => Buffer.from(m[1] ?? "", "base64").toString("utf8"));

// The herdr side of the session primitives (herdr.ts): a pane id with ":" goes to herdr, a tmux name to tmux, so one Dori
// can hold lanes of both while it moves.
let world: World;
let dir: string;
beforeEach(() => {
  world = newWorld();
  dir = mkdtempSync(join(tmpdir(), "herdr-backend-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const omo = (patch = {}) => depsFor(world, fakeClock(0), dir, { backend: "herdr", ...patch });

// where a lead's session log is looked for from its arguments: where they keep their word boundaries (Linux /proc, a
// Windows command line); macOS reads only the exactly known logs
const readsLogs = process.platform === "linux" || process.platform === "win32";


test("a herdr lead whose agent is gone is named stopped with the session recorded for its pane, and revived in that session", async () => {
  const deps = omo({ leadPane: "w1:p1" });
  recordHerdrSession(dir, "w1:p1", { session: "11111111-2222-4333-8444-555555555555", cwd: dir, model: "m/x", at: new Date(0).toISOString() });
  world.herdrDead = ["w1:p1"];
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  expect(await findLead(deps.run, deps.config)).toBe("11111111-2222-4333-8444-555555555555 w1:p1 stopped");
  const typed: string[] = [];
  const line = await reviveHerdr(deps.run, deps.clock, deps.config, "w1:p1", "[DORI] back", async (_p, t) => (typed.push(t), true));
  expect(line).toBe("REVIVE_OK w1:p1 session 11111111-2222-4333-8444-555555555555 (prompt submitted)");
  const ran = world.calls.find((c) => c[2] === "run") ?? [];
  expect(ran.slice(0, 4)).toEqual(["herdr", "pane", "run", "w1:p1"]);
  // the checked PATH goes first (a herdr pane takes the server's environment), then the recorded session and model
  if (process.platform === "win32") {
    expect(ran[4]).toStartWith("Clear-Host; $PSNativeCommandArgumentPassing = 'Standard'; Set-Item -LiteralPath ('Env:' + ");
    expect(winData(ran[4] ?? "")).toEqual(["PATH", expect.any(String), "omo", "--session-id", "11111111-2222-4333-8444-555555555555", "--model", "m/x"]);
  } else expect(ran[4]).toMatch(/^clear && env PATH=\S+ omo --session-id 11111111-2222-4333-8444-555555555555 --model m\/x$/);
  expect(typed).toEqual(["[DORI] back"]);
  expect(await reviveHerdr(deps.run, deps.clock, deps.config, "w1:p9", "", async () => true)).toStartWith("REVIVE_FAIL w1:p9: no omo session recorded");
  expect(readHerdrSessions(dir)["w1:p1"]?.model).toBe("m/x");
});

test("a revive right after a server restart waits for herdr to spawn the pane, and an omo herdr already started again only gets the prompt", async () => {
  const deps = omo({ leadPane: "w1:p1" });
  recordHerdrSession(dir, "w1:p1", { session: "11111111-2222-4333-8444-555555555555", cwd: dir, at: new Date(0).toISOString() });
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.herdrGone = ["w1:p1"];
  const base = fakeRunner(world);
  let reads = 0;
  // pane list has it at once; process-info answers pane_not_found for the first two reads, then herdr has restored omo
  const run: Runner = async (argv, o) => {
    if (argv[2] === "process-info" && ++reads > 2) world.herdrGone = [];
    return base(argv, o);
  };
  world.screens = { "w1:p1": "omo\n────────\n❯ \n────────" };
  const typed: string[] = [];
  const line = await reviveHerdr(run, deps.clock, deps.config, "w1:p1", "[DORI] back", async (_p, t) => (typed.push(t), true));
  expect(line).toBe("REVIVE_OK w1:p1 session 11111111-2222-4333-8444-555555555555 (herdr had started it again, pid 4001) (prompt submitted)");
  expect(world.calls.some((c) => c[2] === "run")).toBe(false);
  expect(typed).toEqual(["[DORI] back"]);
});

test("a herdr lead with no record yet (just handed over) is recorded on the first live check", async () => {
  const deps = omo({ leadPane: "w1:p1", leadReviveMin: 5, sessionsDir: dir });
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/repo" }];
  world.ps = "4000 1 -bash\n4001 4000 omo --session-id 11111111-2222-4333-8444-555555555555 --model m/x";
  expect(readHerdrSessions(dir)["w1:p1"]).toBeUndefined();
  expect(await leadDownTick(deps)).toEqual([]);
  expect(readHerdrSessions(dir)["w1:p1"]).toMatchObject({ session: "11111111-2222-4333-8444-555555555555", model: "m/x" });
});

test.if(readsLogs)("a lead's /thinking (and /model) change is what its record keeps and its revive opens with, not its launch --model", async () => {
  const deps = omo({ leadPane: "w1:p1", leadReviveMin: 5, sessionsDir: dir });
  const id = "11111111-2222-4333-8444-555555555555";
  const logDir = sessionDirFor(dir, dir);
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, `2026-11-04T16-00-00-000Z_${id}.jsonl`);
  const entry = (e: object) => `${JSON.stringify(e)}\n`;
  // what omo writes: the start's model and level, then the owner's /thinking medium
  writeFileSync(log, entry({ type: "session", id, cwd: dir }) + entry({ type: "model_change", provider: "p", modelId: "m" }) + entry({ type: "thinking_level_change", thinkingLevel: "high", provider: "p", modelId: "m" }) + entry({ type: "thinking_level_change", thinkingLevel: "medium", provider: "p", modelId: "m" }));
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.ps = `4000 1 -bash\n4001 4000 omo --session-id ${id} --model p/m:high`;
  await leadDownTick(deps);
  expect(readHerdrSessions(dir)["w1:p1"]?.model).toBe("p/m:medium");
  // changed again after the last check (/model, then /thinking low), and then its agent is gone: the revive reads the log
  appendFileSync(log, entry({ type: "model_change", provider: "p", modelId: "n" }) + entry({ type: "thinking_level_change", thinkingLevel: "low", provider: "p", modelId: "n" }));
  world.ps = "4000 1 -bash";
  world.herdrDead = ["w1:p1"];
  expect(await reviveHerdr(deps.run, deps.clock, deps.config, "w1:p1", "", async () => true)).toBe(`REVIVE_OK w1:p1 session ${id}`);
  const ran = world.calls.filter((c) => c[2] === "run").at(-1)?.[4] ?? "";
  if (process.platform === "win32") expect(winData(ran).slice(2)).toEqual(["omo", "--session-id", id, "--model", "p/n", "--thinking", "low"]);
  else expect(ran).toMatch(new RegExp(` omo --session-id ${id} --model p/n --thinking low$`));
});

test.if(readsLogs)("a lead started with its own --session-dir has its /thinking read from the log in that folder, for the record and the revive", async () => {
  const own = join(dir, "own-sessions");
  const deps = omo({ leadPane: "w1:p1", leadReviveMin: 5, sessionsDir: join(dir, "sessions"), agentCommand: ["omo", "--session-dir", own, "--model", "{model}", "{prompt}"] });
  const id = "11111111-2222-4333-8444-555555555555";
  // omo keeps the logs of a --session-dir session right in that folder, with no per-cwd folder
  mkdirSync(own, { recursive: true });
  const log = join(own, `2026-11-04T16-00-00-000Z_${id}.jsonl`);
  const entry = (e: object) => `${JSON.stringify(e)}\n`;
  writeFileSync(log, entry({ type: "thinking_level_change", thinkingLevel: "high", provider: "p", modelId: "m" }) + entry({ type: "thinking_level_change", thinkingLevel: "medium", provider: "p", modelId: "m" }));
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.ps = `4000 1 -bash\n4001 4000 omo --session-dir ${own} --session-id ${id} --model p/m:high`;
  await leadDownTick(deps);
  expect(readHerdrSessions(dir)["w1:p1"]).toMatchObject({ model: "p/m:medium", log });
  appendFileSync(log, entry({ type: "thinking_level_change", thinkingLevel: "low", provider: "p", modelId: "m" }));
  world.ps = "4000 1 -bash";
  world.herdrDead = ["w1:p1"];
  expect(await reviveHerdr(deps.run, deps.clock, deps.config, "w1:p1", "", async () => true)).toBe(`REVIVE_OK w1:p1 session ${id}`);
  const ran = world.calls.filter((c) => c[2] === "run").at(-1)?.[4] ?? "";
  if (process.platform === "win32") expect(winData(ran).slice(2)).toEqual(["omo", "--session-id", id, "--session-dir", own, "--model", "p/m", "--thinking", "low"]);
  else expect(ran).toEndWith(` omo --session-id ${id} --session-dir ${own} --model p/m --thinking low`);
});

// Windows reads no child environment (resolveSession and sessionLog skip it there)
test.if(process.platform === "linux")("the log path omo hands its children (PI_SESSION_FILE) wins, spaces and all, and a later check that finds no log keeps the recorded one", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  // a session resumed from its file (herdr restores omo with --session <file>), in a folder with a space, outside sessionsDir
  const spaced = join(dir, "my sessions");
  mkdirSync(spaced, { recursive: true });
  const log = join(spaced, `2026-11-04T16-00-00-000Z_${id}.jsonl`);
  const entry = (e: object) => `${JSON.stringify(e)}\n`;
  writeFileSync(log, entry({ type: "thinking_level_change", thinkingLevel: "high", provider: "p", modelId: "m" }) + entry({ type: "thinking_level_change", thinkingLevel: "medium", provider: "p", modelId: "m" }));
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.ps = `4000 1 -bash\n4001 4000 omo --session ${log} --model p/m:high\n4002 4001 python3 -u prelude.py`;
  let env = `python3 -u prelude.py HOME=/h PI_SESSION_ID=${id} PI_SESSION_FILE=${log} PI_SESSION_CWD=${dir}`;
  const base = omo({ leadPane: "w1:p1", leadReviveMin: 5, sessionsDir: join(dir, "sessions") });
  const run: Runner = async (argv, o) => (argv[1] === "eww" && argv.at(-1) === "4002" ? { code: 0, out: env, err: "" } : base.run(argv, o));
  const deps = { ...base, run };
  await leadDownTick(deps);
  expect(readHerdrSessions(dir)["w1:p1"]).toMatchObject({ session: id, model: "p/m:medium", log });
  // checked again while the child shows the session but not its file (and the spaced --session word cannot name it): the
  // record keeps the log it had
  env = `python3 -u prelude.py PI_SESSION_ID=${id}`;
  await herdrLeadSession(run, deps.config, "w1:p1", true);
  expect(readHerdrSessions(dir)["w1:p1"]).toMatchObject({ model: "p/m:medium", log });
  appendFileSync(log, entry({ type: "thinking_level_change", thinkingLevel: "low", provider: "p", modelId: "m" }));
  world.ps = "4000 1 -bash";
  world.herdrDead = ["w1:p1"];
  expect(await reviveHerdr(run, deps.clock, deps.config, "w1:p1", "", async () => true)).toBe(`REVIVE_OK w1:p1 session ${id}`);
  const ran = world.calls.filter((c) => c[2] === "run").at(-1)?.[4] ?? "";
  if (process.platform === "win32") expect(winData(ran).slice(2)).toEqual(["omo", "--session-id", id, "--model", "p/m", "--thinking", "low"]);
  else expect(ran).toEndWith(` omo --session-id ${id} --model p/m --thinking low`);
});

test.if(readsLogs)("a spaced --session-dir is read with its word boundaries, so its log is found and not a stale copy where its first word points, and a check that reads no log keeps the recorded model", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const entry = (e: object) => `${JSON.stringify(e)}\n`;
  const level = (l: string) => entry({ type: "thinking_level_change", thinkingLevel: l, provider: "p", modelId: "m" });
  // the real log in "my sessions" (now low) and a stale copy of the same session in "my", where a whitespace split points
  const real = join(dir, "my sessions");
  const stale = join(dir, "my");
  mkdirSync(real, { recursive: true });
  mkdirSync(stale, { recursive: true });
  const log = join(real, `2026-11-04T16-00-00-000Z_${id}.jsonl`);
  writeFileSync(log, level("medium") + level("low"));
  writeFileSync(join(stale, `2026-11-04T15-00-00-000Z_${id}.jsonl`), level("high"));
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  // as ps shows it (Windows quotes the spaced word), and as /proc keeps it on Linux
  world.ps = `4000 1 -bash\n4001 4000 omo --session-id ${id} --session-dir ${process.platform === "win32" ? `"${real}"` : real} --model p/m:high`;
  world.cmdlines = { 4001: ["omo", "--session-id", id, "--session-dir", real, "--model", "p/m:high"] };
  const deps = omo({ leadPane: "w1:p1", sessionsDir: join(dir, "sessions") });
  expect(await herdrLeadSession(deps.run, deps.config, "w1:p1", true)).toBe(id);
  expect(readHerdrSessions(dir)["w1:p1"]).toMatchObject({ log, model: "p/m:low" });
  // the log is gone and the guess finds nothing: the model stays the session's last one, not the launch :high
  rmSync(log);
  rmSync(stale, { recursive: true });
  await herdrLeadSession(deps.run, deps.config, "w1:p1", true);
  expect(readHerdrSessions(dir)["w1:p1"]?.model).toBe("p/m:low");
});

test("a Windows command line with a quoted spaced --session-dir or --session names the log (winArgv, run on every platform)", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const spaced = join(dir, "my sessions");
  mkdirSync(spaced, { recursive: true });
  const log = join(spaced, `2026-11-04T16-00-00-000Z_${id}.jsonl`);
  writeFileSync(log, "");
  expect(argvSessionLog(winArgv(`omo.exe --session-id ${id} --session-dir "${spaced}" --model p/m:high`), join(dir, "sessions"), dir, id)).toBe(log);
  expect(argvSessionLog(winArgv(`omo.exe --session "${log}" --model p/m:high`), join(dir, "sessions"), dir, id)).toBe(log);
  // split on whitespace, the same line names no log (the macOS limit, docs/follow-ups.md)
  expect(argvSessionLog(`omo --session-id ${id} --session-dir ${spaced}`.split(/\s+/), join(dir, "sessions"), dir, id)).toBeUndefined();
});

test.if(readsLogs)("a lead resumed from another copy of its session (--session B) has B read, not the log A recorded before, for the record and the revive", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const level = (l: string) => `${JSON.stringify({ type: "thinking_level_change", thinkingLevel: l, provider: "p", modelId: "m" })}\n`;
  mkdirSync(join(dir, "a"));
  mkdirSync(join(dir, "b"));
  const a = join(dir, "a", `2026-11-04T15-00-00-000Z_${id}.jsonl`);
  const b = join(dir, "b", `2026-11-04T16-00-00-000Z_${id}.jsonl`);
  writeFileSync(a, level("high"));
  writeFileSync(b, level("high") + level("medium"));
  recordHerdrSession(dir, "w1:p1", { session: id, cwd: dir, model: "p/m:high", log: a, at: new Date(0).toISOString() });
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.ps = `4000 1 -bash\n4001 4000 omo --session ${b} --model p/m:high`;
  const deps = omo({ leadPane: "w1:p1", sessionsDir: join(dir, "sessions") });
  expect(await herdrLeadSession(deps.run, deps.config, "w1:p1", true)).toBe(id);
  expect(readHerdrSessions(dir)["w1:p1"]).toMatchObject({ log: b, model: "p/m:medium" });
  appendFileSync(b, level("low"));
  world.ps = "4000 1 -bash";
  world.herdrDead = ["w1:p1"];
  expect(await reviveHerdr(deps.run, deps.clock, deps.config, "w1:p1", "", async () => true)).toBe(`REVIVE_OK w1:p1 session ${id}`);
  const ran = world.calls.filter((c) => c[2] === "run").at(-1)?.[4] ?? "";
  if (process.platform === "win32") expect(winData(ran).slice(2)).toEqual(["omo", "--session-id", id, "--model", "p/m", "--thinking", "low"]);
  else expect(ran).toEndWith(` omo --session-id ${id} --model p/m --thinking low`);
});

test.if(process.platform === "linux")("arguments without their word boundaries (no /proc cmdline to read) name no log: the record keeps the launch model, as on main, and no stale copy is read", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const spaced = join(dir, "my sessions");
  mkdirSync(spaced, { recursive: true });
  mkdirSync(join(dir, "my"));
  writeFileSync(join(spaced, `2026-11-04T16-00-00-000Z_${id}.jsonl`), "");
  writeFileSync(join(dir, "my", `2026-11-04T15-00-00-000Z_${id}.jsonl`), `${JSON.stringify({ type: "thinking_level_change", thinkingLevel: "low", provider: "p", modelId: "m" })}\n`);
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.ps = `4000 1 -bash\n4001 4000 omo --session-id ${id} --session-dir ${spaced} --model p/m:high`;
  world.cmdlines = { 4001: null };
  const deps = omo({ leadPane: "w1:p1", sessionsDir: join(dir, "sessions") });
  expect(await herdrLeadSession(deps.run, deps.config, "w1:p1", true)).toBe(id);
  const rec = readHerdrSessions(dir)["w1:p1"];
  expect(rec?.model).toBe("p/m:high");
  expect(rec?.log).toBeUndefined();
});

// The macOS path, run here: process.platform set to darwin for the call, so the agent's arguments are not read (ps loses
// their word boundaries; KERN_PROCARGS2 is a follow-up) even where this host's /proc could give them
const asPlatform = async (platform: string, fn: () => Promise<void>): Promise<void> => {
  const own = Object.getOwnPropertyDescriptor(process, "platform");
  if (!own) throw new Error("process.platform has no descriptor");
  Object.defineProperty(process, "platform", { ...own, value: platform });
  try {
    await fn();
  } finally {
    Object.defineProperty(process, "platform", own);
  }
};

test.if(process.platform !== "win32")("on macOS only exactly known logs are read: no log from the arguments, the child's PI_SESSION_FILE, then the log recorded before, and the revive reads that log with --thinking apart", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const level = (l: string) => `${JSON.stringify({ type: "thinking_level_change", thinkingLevel: l, provider: "p", modelId: "m" })}\n`;
  const own = join(dir, "own");
  mkdirSync(own);
  const log = join(own, `2026-11-04T16-00-00-000Z_${id}.jsonl`);
  writeFileSync(log, level("high") + level("medium"));
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.ps = `4000 1 -bash\n4001 4000 omo --session-dir ${own} --session-id ${id} --model p/m:high\n4002 4001 python3 -u prelude.py`;
  let env = `python3 -u prelude.py PI_SESSION_ID=${id}`;
  const base = omo({ leadPane: "w1:p1", sessionsDir: join(dir, "sessions") });
  const run: Runner = async (argv, o) => (argv[1] === "eww" && argv.at(-1) === "4002" ? { code: 0, out: env, err: "" } : base.run(argv, o));
  await asPlatform("darwin", async () => {
    // the arguments name the log, but they are not read on macOS: the launch model, as on main
    expect(await herdrLeadSession(run, base.config, "w1:p1", true)).toBe(id);
    expect(readHerdrSessions(dir)["w1:p1"]?.model).toBe("p/m:high");
    expect(readHerdrSessions(dir)["w1:p1"]?.log).toBeUndefined();
    // a child shows the file: read and recorded
    env = `python3 -u prelude.py PI_SESSION_ID=${id} PI_SESSION_FILE=${log}`;
    await herdrLeadSession(run, base.config, "w1:p1", true);
    expect(readHerdrSessions(dir)["w1:p1"]).toMatchObject({ model: "p/m:medium", log });
    // no child shows it any more: the recorded log is read again
    env = `python3 -u prelude.py PI_SESSION_ID=${id}`;
    appendFileSync(log, level("low"));
    await herdrLeadSession(run, base.config, "w1:p1", true);
    expect(readHerdrSessions(dir)["w1:p1"]).toMatchObject({ model: "p/m:low", log });
    // and the revive reads it once more, with the level as its own --thinking
    appendFileSync(log, level("minimal"));
    world.ps = "4000 1 -bash";
    world.herdrDead = ["w1:p1"];
    expect(await reviveHerdr(run, base.clock, base.config, "w1:p1", "", async () => true)).toBe(`REVIVE_OK w1:p1 session ${id}`);
  });
  expect(world.calls.filter((c) => c[2] === "run").at(-1)?.[4] ?? "").toEndWith(` omo --session-id ${id} --model p/m --thinking minimal`);
});

test("an unchanged herdr lead record gets its check time on each read, so the next read waits its ten minutes", async () => {
  const deps = omo({ leadPane: "w1:p1", leadReviveMin: 5, sessionsDir: dir });
  // checked 11 minutes before the (fake) clock: due again
  const old = new Date(-11 * 60_000).toISOString();
  recordHerdrSession(dir, "w1:p1", { session: "11111111-2222-4333-8444-555555555555", cwd: "/repo", model: "m/x", at: old });
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/repo" }];
  world.ps = "4000 1 -bash\n4001 4000 omo --session-id 11111111-2222-4333-8444-555555555555 --model m/x";
  await leadDownTick(deps);
  expect(readHerdrSessions(dir)["w1:p1"]?.at).not.toBe(old);
});

test("a herdr lead revived after leadReviveMin tells the owner once, as an aoe lead does", async () => {
  recordHerdrSession(dir, "w1:p1", { session: "11111111-2222-4333-8444-555555555555", cwd: dir, at: new Date(0).toISOString() });
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.herdrDead = ["w1:p1"];
  const posts: string[] = [];
  const inbox = join(dir, "inbox.jsonl");
  await Bun.write(inbox, `${JSON.stringify({ ts: new Date(0).toISOString(), author_id: "owner", channel_id: "c1", content: "hi" })}\n`);
  const at = (ms: number) => ({ ...omo({ leadPane: "w1:p1", leadReviveMin: 5 }), clock: fakeClock(ms), ownerInbox: { path: inbox, ownerId: "owner", ownerChannel: "c1" }, postOwner: async (_c: string, t: string) => (posts.push(t), "m1") });
  expect((await leadDownTick(at(0)))[0]).toStartWith("LEAD_DOWN w1:p1 no live herdr agent");
  // herdr starts omo again during the revive (its pane answers as live from the next process-info)
  const run = at(6 * 60_000).run;
  const deps = { ...at(6 * 60_000), run: async (argv: readonly string[], o?: Parameters<Runner>[1]) => { if (argv[2] === "run") world.herdrDead = []; return run(argv, o); } };
  const lines = await leadDownTick(deps);
  expect(lines[0]).toStartWith("LEAD_REVIVE_STARTED w1:p1");
  expect(lines.some((l) => l.startsWith("LEAD_DOWN_NOTICE w1:p1 POSTED"))).toBe(true);
  expect(posts).toHaveLength(1);
});

test("a revive is OK only once an agent runs and draws its own prompt: a ❯ left by the ended agent is no sign, and agentCommand's options stay", async () => {
  const deps = omo({ leadPane: "w1:p1", agentCommand: ["omo", "--session-dir", "/s", "--model", "{model}", "{prompt}"] });
  recordHerdrSession(dir, "w1:p1", { session: "11111111-2222-4333-8444-555555555555", cwd: dir, model: "m/x", at: new Date(0).toISOString() });
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.herdrDead = ["w1:p1"];
  world.screens = { "w1:p1": "❯ old prompt of the ended agent" };
  world.herdrNoStart = true;
  expect(await reviveHerdr(deps.run, deps.clock, deps.config, "w1:p1", "", async () => true)).toStartWith("REVIVE_FAIL w1:p1: no running agent with its ❯ prompt");
  world.herdrNoStart = false;
  expect(await reviveHerdr(deps.run, deps.clock, deps.config, "w1:p1", "", async () => true)).toBe("REVIVE_OK w1:p1 session 11111111-2222-4333-8444-555555555555");
  const ran = world.calls.filter((c) => c[2] === "run").at(-1)?.[4] ?? "";
  if (process.platform === "win32") expect(winData(ran).slice(2)).toEqual(["omo", "--session-id", "11111111-2222-4333-8444-555555555555", "--session-dir", "/s", "--model", "m/x"]);
  else expect(ran).toMatch(/ omo --session-id 11111111-2222-4333-8444-555555555555 --session-dir \/s --model m\/x$/);
  const selector = omo({ leadPane: "w1:p1", agentCommand: ["omo", "--continue", "{prompt}"] });
  world.herdrDead = ["w1:p1"];
  expect(await reviveHerdr(selector.run, selector.clock, selector.config, "w1:p1", "", async () => true)).toStartWith("REVIVE_FAIL w1:p1: agentCommand picks its session itself");
});

test("a revived agent that runs but has not drawn omo's input box yet is not ready: an echoed command and a shell ❯ are no sign", async () => {
  const deps = omo({ leadPane: "w1:p1" });
  recordHerdrSession(dir, "w1:p1", { session: "11111111-2222-4333-8444-555555555555", cwd: dir, model: "m/x", at: new Date(0).toISOString() });
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.herdrDead = ["w1:p1"];
  world.herdrNoStart = true;
  let reads = 0;
  const base = deps.run;
  const run: Runner = async (argv, o) => {
    if (argv[2] === "run") world.herdrDead = [];
    if (argv[2] === "read" && world.herdrDead?.length === 0) world.screens["w1:p1"] = ++reads < 4 ? "user$ clear && omo --session-id 11111111-2222-4333-8444-555555555555\n❯ " : "omo\n────────\n❯ \n────────";
    return base(argv, o);
  };
  const typed: string[] = [];
  expect(await reviveHerdr(run, deps.clock, deps.config, "w1:p1", "[DORI] back", async (_p, t) => (typed.push(t), true))).toBe("REVIVE_OK w1:p1 session 11111111-2222-4333-8444-555555555555 (prompt submitted)");
  expect(reads).toBeGreaterThanOrEqual(4);
  expect(world.calls.find((c) => c[2] === "run")?.[4] ?? "").toStartWith(process.platform === "win32" ? "Clear-Host; " : "clear && ");
});

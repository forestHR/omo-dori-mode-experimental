import { afterEach, beforeEach, expect, test } from "bun:test";

import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { claimDone, closeLane, objectDone, unpushedWork, watchTick } from "../src/done-flow.ts";
import { run } from "../src/run.ts";
import { sendVerified, UnsafeTextError } from "../src/panes.ts";
import { SUBMIT_TIMING } from "../src/submit.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World, WT } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const SUMMARY = "The demo page works now. Nothing is left.";
const lane: Lane = { key: "demo-lane", title: "demo", thread: "chat:team/123", pane: "w:p1", brief: "/briefs/demo.md", done: "merged acme/app#1; closed acme/app#2", cwd: "/repo", openedAt: new Date(T0 - 60 * MIN).toISOString() };

let state: ReturnType<typeof withState>;
let world: World;
const at = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadDone: ["notify", "{thread}", "{text}"] } });
const closedVia = () => world.calls.filter((c) => c[0] === "herdr" && (c[1] === "pane" || c[1] === "tab") && c[2] === "close");

beforeEach(async () => {
  state = withState();
  world = newWorld();
  await at(T0).registry.write(lane);
});
afterEach(() => state.done());

test("an objection inside the window keeps the lane open and the lane hears why", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1 abc123");
  await objectDone(at(T0 + MIN), (await at(T0).registry.read("demo-lane")) ?? lane, ["changelog entry missing"]);
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("not-done");
  expect(closedVia()).toHaveLength(0);
  expect(sent(world).some((t) => t.startsWith("[LEAD] not done: changelog entry missing"))).toBe(true);
});

test("five quiet minutes after a claim the lane is closed, its thread marked done and its worktree removed", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1 abc123", SUMMARY);
  expect(await watchTick(at(T0 + 4 * MIN))).toEqual(["LANE_DONE_CLAIMED demo-lane w:p1 merged acme/app#1 abc123"]);
  expect(closedVia()).toHaveLength(0);
  const lines = await watchTick(at(T0 + 5 * MIN + 1));
  expect(lines).toEqual(["CLOSE_SUMMARY demo-lane from the lane", expect.stringMatching(/^LANE_CLOSED demo-lane /)]);
  expect(closedVia()).toEqual([["herdr", "pane", "close", "w:p1"]]);
  // the owner's thread gets the lane's summary for him; the claim's evidence stays in the lane's record
  expect(world.calls).toContainEqual(["notify", "chat:team/123", SUMMARY]);
  expect(world.calls.some((c) => c[0] === "notify" && c[2]?.includes("abc123"))).toBe(false);
  expect(world.calls).toContainEqual(["git", "-C", "/repo", "worktree", "remove", WT]);
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("closed");
  expect(after?.history?.at(-1)?.note).toBe("Done: merged acme/app#1 abc123");
  expect(await watchTick(at(T0 + 9 * MIN))).toEqual([]);
});

test("commits that reached no remote block the close and name the worktree", async () => {
  world.aheadCount = "2";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after?.objection?.reasons).toEqual([`unpushed work in ${WT}`]);
  expect(closedVia()).toHaveLength(0);
});

test("uncommitted tracked changes also block the close", async () => {
  world.dirty = " M src/app.ts";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual([`unpushed work in ${WT}`]);
  expect(closedVia()).toHaveLength(0);
});

// dori-superagent issue #40 reproduced here (MIT): https://github.com/sisyphuslabs/dori-superagent/issues/40
// A lane that never made a worktree works straight in its cwd; its work there was checked nowhere.
const cwdOnly = "worktree /repo\nHEAD 1111111\nbranch refs/heads/main";

test("a lane with no worktree of its own and uncommitted changes in its cwd is not closed", async () => {
  world.worktreeList = cwdOnly;
  world.dirty = " M src/app.ts";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual(["unpushed work in /repo"]);
  expect(closedVia()).toHaveLength(0);
});

test("a lane with no worktree of its own and unpushed commits in its cwd is not closed", async () => {
  world.worktreeList = cwdOnly;
  world.aheadCount = "1";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual(["unpushed work in /repo"]);
  expect(closedVia()).toHaveLength(0);
});

test("a lane with a clean worktree of its own is not held by changes in the human's checkout", async () => {
  world.dirtyIn = { "/repo": " M notes.md" };
  world.aheadIn = { "/repo": "3" };
  await claimDone(at(T0), lane, "merged acme/app#1 abc123", SUMMARY);
  const lines = await watchTick(at(T0 + 6 * MIN));
  expect(lines.at(-1)).toStartWith("LANE_CLOSED demo-lane ");
});

test("a cwd that is no git checkout raises no objection of its own", async () => {
  world.inGit = false;
  const noGitDir = (ms: number) => ({ ...at(ms), exists: (p: string) => !p.endsWith("/.git") });
  await claimDone(noGitDir(T0), lane, "merged acme/app#1 abc123", SUMMARY);
  const lines = await watchTick(noGitDir(T0 + 6 * MIN));
  expect(lines.at(-1)).toStartWith("LANE_CLOSED demo-lane ");
});

test("a cwd that is a symlink into a subdirectory of a real checkout is checked there", async () => {
  const g = async (...a: string[]) => expect((await run(["git", ...a])).code).toBe(0);
  const repo = join(state.dir, "checkout");
  await g("init", "-q", "--bare", "-b", "main", join(state.dir, "origin.git"));
  await g("clone", "-q", join(state.dir, "origin.git"), repo);
  mkdirSync(join(repo, "sub"));
  writeFileSync(join(repo, "sub", "a.txt"), "one\n");
  await g("-C", repo, "add", "sub/a.txt");
  await g("-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "one");
  await g("-C", repo, "push", "-q", "origin", "main");
  writeFileSync(join(repo, "sub", "a.txt"), "two\n");
  const link = join(state.dir, "lane-src");
  symlinkSync(join(repo, "sub"), link);
  const deps = { ...at(T0), run, exists: existsSync, config: { ...at(T0).config, defaultCwd: state.dir } };
  expect(await unpushedWork(deps, { ...lane, cwd: link })).toEqual([`unpushed work in ${link}`]);
  // the same checkout broken: its .git is found on the physical path, not the symlink's
  writeFileSync(join(repo, ".git", "config"), "[core\n");
  expect(await unpushedWork(deps, { ...lane, cwd: link })).toEqual([`unpushed work in ${link} (git state unreadable)`]);
});

test("a dangling .git symlink holds the lane, and a GIT_DIR in the watcher's environment does not hide the cwd's work", async () => {
  const realDeps = { ...at(T0), run, exists: existsSync, config: { ...at(T0).config, defaultCwd: state.dir } };
  const dangling = join(state.dir, "dangling");
  mkdirSync(dangling);
  symlinkSync(join(state.dir, "gone"), join(dangling, ".git"));
  expect(await unpushedWork(realDeps, { ...lane, cwd: dangling })).toEqual([`unpushed work in ${dangling} (git state unreadable)`]);
  const repo = join(state.dir, "plain");
  expect((await run(["git", "init", "-q", repo])).code).toBe(0);
  writeFileSync(join(repo, "a.txt"), "one\n");
  expect((await run(["git", "-C", repo, "add", "a.txt"])).code).toBe(0);
  expect((await run(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "one"])).code).toBe(0);
  writeFileSync(join(repo, "a.txt"), "two\n");
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = join(state.dir, "nowhere");
  try {
    expect(await unpushedWork(realDeps, { ...lane, cwd: repo })).toEqual([`unpushed work in ${repo}`]);
    // the lane's own worktree, found by its name, is still found: the human's dirty checkout does not hold the lane
    expect((await run(["git", "-C", repo, "worktree", "add", "-q", "-b", "demo-lane", join(state.dir, "wt", "demo-lane")], { env: { GIT_DIR: undefined } })).code).toBe(0);
    expect(await unpushedWork(realDeps, { ...lane, cwd: repo })).toEqual([`unpushed work in ${join(state.dir, "wt", "demo-lane")}`]);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  }
});

test("a fresh repository with no commit yet is checked for staged work, not called unreadable; a HEAD git cannot read is", async () => {
  const realDeps = { ...at(T0), run, exists: existsSync, config: { ...at(T0).config, defaultCwd: state.dir } };
  const fresh = join(state.dir, "fresh");
  expect((await run(["git", "init", "-q", "-b", "main", fresh])).code).toBe(0);
  expect(await unpushedWork(realDeps, { ...lane, cwd: fresh })).toEqual([]);
  writeFileSync(join(fresh, "a.txt"), "one\n");
  expect((await run(["git", "-C", fresh, "add", "a.txt"])).code).toBe(0);
  expect(await unpushedWork(realDeps, { ...lane, cwd: fresh })).toEqual([`unpushed work in ${fresh}`]);
  // a history git cannot walk: HEAD resolves and status reads its tree, but the parent commit's object is gone
  const commit = (m: string) => run(["git", "-C", fresh, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", m]);
  expect((await commit("one")).code).toBe(0);
  const parent = (await run(["git", "-C", fresh, "rev-parse", "HEAD"])).out;
  writeFileSync(join(fresh, "a.txt"), "two\n");
  expect((await commit("two")).code).toBe(0);
  rmSync(join(fresh, ".git", "objects", parent.slice(0, 2), parent.slice(2)));
  expect((await run(["git", "-C", fresh, "status", "--porcelain"])).code).toBe(0);
  expect(await unpushedWork(realDeps, { ...lane, cwd: fresh })).toEqual([`unpushed work in ${fresh} (git state unreadable)`]);
});

// git says "not a git repository" for a .git file pointing nowhere or a bad HEAD too: a .git entry makes it unreadable
test.each(["fatal: bad config line 1 in file .git/config", "fatal: not a git repository: /repo/.git/worktrees/gone"])("a cwd with a .git git cannot read holds the lane as unreadable git state (%s)", async (err) => {
  world.worktreeList = cwdOnly;
  world.revParseErr = err;
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  expect((await at(T0).registry.read("demo-lane"))?.objection?.reasons).toEqual(["unpushed work in /repo (git state unreadable)"]);
  expect(closedVia()).toHaveLength(0);
});

test("a Done signal that does not read back live becomes the objection", async () => {
  world.issueState = "OPEN";
  await claimDone(at(T0), lane, "merged acme/app#1");
  await watchTick(at(T0 + 6 * MIN));
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("not-done");
  expect(after?.objection?.reasons).toEqual(["closed acme/app#2 -> OPEN"]);
  expect(closedVia()).toHaveLength(0);
});

test("a watcher restarted inside the window keeps the original deadline and announces the claim once", async () => {
  await claimDone(at(T0), lane, "merged acme/app#1", SUMMARY);
  const first = await watchTick(at(T0 + 2 * MIN));
  const afterRestart = await watchTick(at(T0 + 3 * MIN));
  const settled = await watchTick(at(T0 + 6 * MIN));
  expect(first).toHaveLength(1);
  expect(afterRestart).toEqual([]);
  expect(settled.at(-1)).toStartWith("LANE_CLOSED demo-lane");
  expect(closedVia()).toHaveLength(1);
});

test("closing directly refuses while a signal is not live and leaves the pane alone", async () => {
  world.prState = "OPEN";
  const r = await closeLane(at(T0), lane, "manual");
  expect(r.closed).toBe(false);
  expect(r.lines.at(-1)).toStartWith("REFUSED demo-lane");
  expect(closedVia()).toHaveLength(0);
});

test("the close refuses a PR of a gated repo merged without dori merge, even after an earlier claim", async () => {
  const gated = depsFor(world, fakeClock(T0), state.dir, { hooks: { threadDone: ["notify", "{thread}", "{text}"] }, mergeGate: { ...at(T0).config.mergeGate, repos: { "acme/app": "2026-01-01T10:00:00Z" } } });
  const r = await closeLane(gated, lane, "manual");
  expect(r.closed).toBe(false);
  expect(r.lines).toContainEqual(expect.stringMatching(/^MERGE_GATE_MISSING acme\/app#1: merged at 2026-01-01T11:00:00Z without dori merge/));
  expect(r.lines.at(-1)).toStartWith("REFUSED demo-lane");
  expect(closedVia()).toHaveLength(0);
});

test("text still sitting in the pane input after a poll window gets one more Enter", async () => {
  world.stuckReads = SUBMIT_TIMING.clearPolls;
  expect(await sendVerified(at(T0).run, at(T0).clock, { ...at(T0).config, backend: "herdr" }, "w:p1", "[LEAD] stuck text still here")).toBe(true);
  expect(world.calls.filter((c) => c[2] === "send-keys")).toHaveLength(2);
});

test("text with a backtick never reaches a pane", async () => {
  await expect(sendVerified(at(T0).run, at(T0).clock, { ...at(T0).config, backend: "herdr" }, "w:p1", "run `rm -rf`")).rejects.toBeInstanceOf(UnsafeTextError);
  expect(world.calls).toHaveLength(0);
});

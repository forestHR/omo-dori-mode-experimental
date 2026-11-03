import { afterEach, beforeEach, expect, test } from "bun:test";

import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { claimDone, closeLane, objectDone, unpushedWork, watchTick } from "../src/done-flow.ts";
import { run } from "../src/run.ts";
import { sendVerified, UnsafeTextError } from "../src/panes.ts";
import { SUBMIT_TIMING } from "../src/submit.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { appendRollover, readRollovers } from "../src/rollover.ts";
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
  expect(lines).toEqual(["CLOSE_SUMMARY demo-lane from the lane", "COST demo-lane tokens=unknown costUsd=unknown", expect.stringMatching(/^LANE_CLOSED demo-lane /)]);
  // the lane's pane is all its tab holds, so the tab closes (aoe.ts closeAoeSession for a herdr pane)
  expect(closedVia()).toEqual([["herdr", "tab", "close", "w:t-p1"]]);
  // the owner's thread gets the lane's summary for him; the claim's evidence stays in the lane's record
  expect(world.calls).toContainEqual(["notify", "chat:team/123", SUMMARY]);
  expect(world.calls.some((c) => c[0] === "notify" && c[2]?.includes("abc123"))).toBe(false);
  expect(world.calls).toContainEqual(["git", "-C", "/repo", "worktree", "remove", WT]);
  const after = await at(T0).registry.read("demo-lane");
  expect(after && statusOf(after)).toBe("closed");
  expect(after?.history?.at(-1)?.note).toBe("Done: merged acme/app#1 abc123");
  expect(await watchTick(at(T0 + 9 * MIN))).toEqual([]);
});

const stuckMove = (key: string, atIso: string, rung = 4) =>
  appendRollover(state.dir, { kind: "rollover", who: "lane", at: atIso, key, from: "w:p0", to: "w:p1", approvedBy: "auto:handover.autoRolloverLanes", decidedBy: "auto", signals: { stuck: { metric: "dori review #9", n: 4, rung } }, steps: [], result: "done", reasons: [] });

test("a lane moved for being stuck claims done only with its one outcome line, which lands in the rollover log", async () => {
  // Given: the lane's session came from a stuck (rung 4) rollover
  stuckMove("demo-lane", "2026-01-01T11:30:00.000Z");
  // When it claims without the line, nothing is recorded and it is told what to add
  const refused = await claimDone(at(T0), lane, "merged acme/app#1");
  expect(refused).toStartWith("ROLLOVER_OUTCOME_MISSING demo-lane: this lane moved to a new session at 2026-01-01T11:30:00.000Z while stuck on \"dori review #9\" (4 attempts)");
  expect(statusOf((await at(T0).registry.read("demo-lane")) ?? lane)).not.toBe("done-claimed");
  expect(readRollovers(state.dir).filter((e) => e.kind === "outcome")).toEqual([]);
  // When it claims with the line
  const out = await claimDone(at(T0), lane, "merged acme/app#1", undefined, { rolloverOutcome: { line: "split the review fix\ninto two PRs", resolved: true } });
  // Then the claim stands and the line names that rollover, on one line
  expect(out).toContain("LANE_DONE_CLAIMED demo-lane");
  expect(out).toContain("ROLLOVER_OUTCOME demo-lane resolved (rollover 2026-01-01T11:30:00.000Z): split the review fix into two PRs");
  expect(readRollovers(state.dir).filter((e) => e.kind === "outcome")).toEqual([{ kind: "outcome", at: "2026-01-01T12:00:00.000Z", key: "demo-lane", rolloverAt: "2026-01-01T11:30:00.000Z", resolved: true, line: "split the review fix into two PRs", by: "claim-done" }]);
  // and a claim again (after an objection) is not asked a second time
  expect(await claimDone(at(T0 + MIN), lane, "merged acme/app#1")).toStartWith("LANE_DONE_CLAIMED demo-lane");
});

test("a lane whose move did not solve it says so; a lane never moved for being stuck is not asked", async () => {
  stuckMove("demo-lane", "2026-01-01T11:30:00.000Z");
  await claimDone(at(T0), lane, "merged acme/app#1", undefined, { rolloverOutcome: { line: "same block; scoped the PR down instead", resolved: false } });
  expect(readRollovers(state.dir).find((e) => e.kind === "outcome")).toMatchObject({ resolved: false, line: "same block; scoped the PR down instead" });
  // a rung 3 move (or none) asks nothing
  const other: Lane = { ...lane, key: "other-lane", pane: "w:p2" };
  await at(T0).registry.write(other);
  stuckMove("other-lane", "2026-01-01T11:40:00.000Z", 3);
  expect(await claimDone(at(T0), other, "merged acme/app#3")).toBe("LANE_DONE_CLAIMED other-lane w:p2 merged acme/app#3");
});

test("only the move that started the current session is asked about: an earlier stuck move followed by another move is not", async () => {
  // Given two stuck moves, the newer one answered: a claim again is not asked about the older one
  stuckMove("demo-lane", "2026-01-01T11:00:00.000Z");
  stuckMove("demo-lane", "2026-01-01T11:30:00.000Z");
  await claimDone(at(T0), lane, "merged acme/app#1", undefined, { rolloverOutcome: { line: "second session split the PR", resolved: true } });
  expect(readRollovers(state.dir).filter((e) => e.kind === "outcome").map((e) => e.kind === "outcome" && e.rolloverAt)).toEqual(["2026-01-01T11:30:00.000Z"]);
  expect(await claimDone(at(T0 + MIN), lane, "merged acme/app#1")).toStartWith("LANE_DONE_CLAIMED demo-lane");
  // Given a stuck move followed by a context move: the claim is not asked and the stuck move gets no credit
  const other: Lane = { ...lane, key: "other-lane", pane: "w:p2" };
  await at(T0).registry.write(other);
  stuckMove("other-lane", "2026-01-01T11:00:00.000Z");
  appendRollover(state.dir, { kind: "rollover", who: "lane", at: "2026-01-01T11:40:00.000Z", key: "other-lane", from: "w:p1", to: "w:p2", signals: { contextPct: 90 }, steps: [], result: "done", reasons: [] });
  expect(await claimDone(at(T0), other, "merged acme/app#3")).toBe("LANE_DONE_CLAIMED other-lane w:p2 merged acme/app#3");
  expect(readRollovers(state.dir).filter((e) => e.kind === "outcome" && e.key === "other-lane")).toEqual([]);
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

test("a cwd checkout with no remote has nowhere to push: its commits pass, its uncommitted changes hold the lane; a branch with no upstream in a checkout with a remote still holds", async () => {
  const realDeps = { ...at(T0), run, exists: existsSync, config: { ...at(T0).config, defaultCwd: state.dir } };
  const g = async (...a: string[]) => expect((await run(["git", ...a])).code).toBe(0);
  const docs = join(state.dir, "documents");
  await g("init", "-q", "-b", "main", docs);
  writeFileSync(join(docs, "AGENTS.md"), "one\n");
  await g("-C", docs, "add", "AGENTS.md");
  await g("-C", docs, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "one");
  expect(await unpushedWork(realDeps, { ...lane, cwd: docs })).toEqual([]);
  writeFileSync(join(docs, "AGENTS.md"), "two\n");
  expect(await unpushedWork(realDeps, { ...lane, cwd: docs })).toEqual([`unpushed work in ${docs}`]);
  // a remote exists, the branch was never pushed and has no upstream: its commit is still unpushed
  const repo = join(state.dir, "cloned");
  await g("init", "-q", "--bare", "-b", "main", join(state.dir, "origin.git"));
  await g("clone", "-q", join(state.dir, "origin.git"), repo);
  await g("-C", repo, "checkout", "-q", "-b", "topic");
  writeFileSync(join(repo, "a.txt"), "one\n");
  await g("-C", repo, "add", "a.txt");
  await g("-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "one");
  expect(await unpushedWork(realDeps, { ...lane, cwd: repo })).toEqual([`unpushed work in ${repo}`]);
});

test("a cwd checkout whose only remote is this Dori's stateGit backup has nowhere to push; a real remote besides is the one counted", async () => {
  const base = at(T0).config;
  const withRepo = (repo: string) => ({ ...at(T0), run, exists: existsSync, config: { ...base, defaultCwd: state.dir, stateGit: { ...base.stateGit, backup: { ...base.stateGit.backup, repo } } } });
  const realDeps = withRepo("Acme/Dori-Local-Demo");
  const g = async (...a: string[]) => expect((await run(["git", ...a])).code).toBe(0);
  const docs = join(state.dir, "documents");
  const commit = async (text: string) => {
    writeFileSync(join(docs, "AGENTS.md"), text);
    await g("-C", docs, "add", "AGENTS.md");
    await g("-C", docs, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", text);
  };
  await g("init", "-q", "-b", "main", docs);
  await commit("one\n");
  // what state-backup leaves: a snapshot of HEAD's tree on its own history, under the backup remote's refs
  const tree = (await run(["git", "-C", docs, "rev-parse", "HEAD^{tree}"])).out.trim();
  const snap = (await run(["git", "-C", docs, "-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", tree, "-m", "backup"])).out.trim();
  await g("-C", docs, "update-ref", "refs/remotes/backup/documents-demo", snap);
  await g("-C", docs, "remote", "add", "backup", "git@github.com:acme/dori-local-demo.git");
  await commit("two\n");
  await commit("three\n");
  expect(await unpushedWork(realDeps, { ...lane, cwd: docs })).toEqual([]);
  writeFileSync(join(docs, "AGENTS.md"), "dirty\n");
  expect(await unpushedWork(realDeps, { ...lane, cwd: docs })).toEqual([`unpushed work in ${docs}`]);
  await g("-C", docs, "checkout", "-q", "--", "AGENTS.md");
  // a remote named backup at another repository, or a Dori with no backup repo, is a real remote: the commits hold
  await g("-C", docs, "remote", "set-url", "backup", "https://github.com/acme/other.git");
  expect(await unpushedWork(realDeps, { ...lane, cwd: docs })).toEqual([`unpushed work in ${docs}`]);
  await g("-C", docs, "remote", "set-url", "backup", "https://github.com/acme/dori-local-demo.git");
  expect(await unpushedWork(realDeps, { ...lane, cwd: docs })).toEqual([]);
  expect(await unpushedWork(withRepo(""), { ...lane, cwd: docs })).toEqual([`unpushed work in ${docs}`]);
  // with a real remote too, a commit only it lacks holds, even when a backup ref holds that commit
  await g("init", "-q", "--bare", "-b", "main", join(state.dir, "origin.git"));
  await g("-C", docs, "remote", "add", "origin", join(state.dir, "origin.git"));
  await g("-C", docs, "push", "-q", "origin", "main");
  expect(await unpushedWork(realDeps, { ...lane, cwd: docs })).toEqual([]);
  await commit("four\n");
  await g("-C", docs, "update-ref", "refs/remotes/backup/documents-demo", "HEAD");
  expect(await unpushedWork(realDeps, { ...lane, cwd: docs })).toEqual([`unpushed work in ${docs}`]);
  await g("-C", docs, "push", "-q", "origin", "main");
  expect(await unpushedWork(realDeps, { ...lane, cwd: docs })).toEqual([]);
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
  expect(await sendVerified(at(T0).run, at(T0).clock, { ...at(T0).config, backend: "herdr", agentCommand: ["claude", "{prompt}"] }, "w:p1", "[LEAD] stuck text still here")).toBe(true);
  expect(world.calls.filter((c) => c[2] === "send-keys")).toHaveLength(2);
});

test("text with a backtick never reaches a pane", async () => {
  await expect(sendVerified(at(T0).run, at(T0).clock, { ...at(T0).config, backend: "herdr" }, "w:p1", "run `rm -rf`")).rejects.toBeInstanceOf(UnsafeTextError);
  expect(world.calls).toHaveLength(0);
});

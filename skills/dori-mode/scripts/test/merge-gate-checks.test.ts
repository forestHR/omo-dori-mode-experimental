import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkCommits, isSourcePath, isTestPath, type PrCommit, readPrCommits } from "../src/merge-gate.ts";
import { run, type Runner } from "../src/run.ts";

// What dori-superagent PR #44 (dori verify-pr, https://github.com/sisyphuslabs/dori-superagent/pull/44) tested, and the
// follow-ups of its issue #57 (https://github.com/sisyphuslabs/dori-superagent/issues/57), for the checks dori review runs.

const ME = { name: "Lane Dori", email: "lane@example.org" };
const sha = (c: string): string => c.repeat(40);
const commit = (c: string, over: Partial<PrCommit> = {}): PrCommit => ({ sha: sha(c), subject: "feat: x", author: ME, committer: ME, parents: 1, files: [{ path: "src/x.ts", lines: 3 }], ...over });
const AT_HEAD = new Set(["src/x.ts", "test/x.test.ts"]);
const check = (commits: PrCommit[], o: { identity?: { name: string; email: string }; noTest?: string; atHead?: Set<string>; executables?: Set<string> } = {}) =>
  checkCommits("acme/app", commits, { atHead: o.atHead ?? AT_HEAD, ...(o.executables ? { executables: o.executables } : {}), ...(o.identity ? { identity: o.identity } : {}), ...(o.noTest ? { noTest: o.noTest } : {}) });

test("a wrong commit email names the commit and both roles, with the address masked", () => {
  const r = check([commit("1", { author: { ...ME, email: "other@corp.io" }, committer: { ...ME, email: "Other@corp.io" } })], { identity: ME });
  expect(r.problems).toHaveLength(2);
  expect(r.problems[0]).toMatch(/^author email ot\*\*\*@co\*\*\* \(commit 111111111111\) is not the one set for acme\/app in mergeGate.identities \(la\*\*\*@ex\*\*\*\)$/);
  expect(r.problems[1]).toMatch(/^committer email Ot\*\*\*@co\*\*\* \(commit 111111111111\)/);
  expect(r.problems.join(" ")).not.toContain("other@corp.io");
  expect(r.problems.join(" ")).not.toContain("lane@example.org");
});

test("emails match whatever their case; the name must be the one set", () => {
  expect(check([commit("1", { author: { ...ME, email: "LANE@Example.org" } })], { identity: ME }).problems).toEqual([]);
  const r = check([commit("1", { committer: { ...ME, name: "Someone Else" } })], { identity: ME });
  expect(r.problems).toEqual([expect.stringMatching(/^committer name \(commit 111111111111\) is not the one set for acme\/app in mergeGate.identities$/)]);
  expect(r.problems[0]).not.toContain("Someone Else");
});

test("one other address over many commits is one reason naming how many", () => {
  const other = { ...ME, email: "other@corp.io" };
  const r = check(["1", "2", "3", "4"].map((c) => commit(c, { author: other })), { identity: ME });
  expect(r.problems).toEqual(["author email ot***@co*** (4 commits: 111111111111, 222222222222, 333333333333, ...) is not the one set for acme/app in mergeGate.identities (la***@ex***)"]);
});

test("GitHub's noreply address passes only as a merge commit's committer", () => {
  const gh = { name: "GitHub", email: "noreply@github.com" };
  expect(check([commit("1", { parents: 2, committer: gh, files: [] })], { identity: ME }).problems).toEqual([]);
  expect(check([commit("1", { committer: gh })], { identity: ME }).problems).toHaveLength(1);
  expect(check([commit("1", { parents: 2, author: gh, files: [] })], { identity: ME }).problems).toHaveLength(1);
});

test("a repo with no identity set is skipped with one line, and an identity without a name or email is a problem", () => {
  const r = check([commit("1", { author: { name: "x", email: "x@y.z" } })]);
  expect(r.problems).toEqual([]);
  expect(r.lines).toContain("IDENTITY_SKIP acme/app has no mergeGate.identities entry; commit names and emails are not checked");
  expect(check([commit("1")], { identity: { name: "", email: "lane@example.org" } }).problems).toEqual([expect.stringMatching(/^mergeGate.identities\["acme\/app"\] needs a nonempty name and email/)]);
});

test("a source fix with no test change in the PR fails; a test in a later commit passes with a note", () => {
  const fix = commit("1", { subject: "fix: wrong count" });
  expect(check([fix]).problems).toEqual([expect.stringMatching(/^fix commit 111111111111 changes source and no commit of the PR adds or changes a test/)]);
  const r = check([fix, commit("2", { subject: "test: count", files: [{ path: "test/x.test.ts", lines: 9 }] })]);
  expect(r.problems).toEqual([]);
  expect(r.lines).toContain("FIXTEST_NOTE fix commit 111111111111 has no test of its own; another commit of the PR changes test/x.test.ts");
});

test("fix commits match without case (#57-1)", () => {
  for (const subject of ["Fix: x", "FIX(scope): x", "fix!: x", "Fix(a-b)!: x"]) expect(check([commit("1", { subject })]).problems).toHaveLength(1);
  for (const subject of ["fixture: x", "prefix: x", "feat: fix x"]) expect(check([commit("1", { subject })]).problems).toEqual([]);
});

test("a fix touching only docs or fixtures needs no test", () => {
  expect(check([commit("1", { subject: "fix: typo", files: [{ path: "README.md", lines: 1 }, { path: "test/fixtures/a.ts", lines: 2 }] })]).problems).toEqual([]);
});

test("a test changed with no line (a pure rename, #57-2) or deleted from the head does not count", () => {
  const fix = commit("1", { subject: "fix: x", files: [{ path: "src/x.ts", lines: 1 }, { path: "test/y.test.ts", oldPath: "test/x.test.ts", lines: 0 }] });
  expect(check([fix], { atHead: new Set(["src/x.ts", "test/y.test.ts"]) }).problems).toHaveLength(1);
  const gone = commit("1", { subject: "fix: x", files: [{ path: "src/x.ts", lines: 1 }, { path: "test/z.test.ts", lines: 5 }] });
  expect(check([gone]).problems).toHaveLength(1);
});

test("under test/ only files named as tests are tests; other code there is source (#57-3)", () => {
  expect(isTestPath("skills/dori-mode/scripts/test/merge-gate.test.ts")).toBe(true);
  expect(isTestPath("tests/test_api.py")).toBe(true);
  expect(isTestPath("pkg/api_test.go")).toBe(true);
  expect(isTestPath("src/__tests__/a.ts")).toBe(true);
  expect(isTestPath("src/test/java/a/FooTest.java")).toBe(true);
  expect(isTestPath("tests/integration.rs")).toBe(true);
  expect(isTestPath("test/server.ts")).toBe(false);
  expect(isSourcePath("test/server.ts")).toBe(true);
  expect(isTestPath("test/fakes.ts")).toBe(false);
  expect(isTestPath("test/fixtures/a.test.ts")).toBe(false);
  expect(isSourcePath("test/fixtures/a.ts")).toBe(false);
  expect(isSourcePath("docs/a.ts")).toBe(false);
  expect(check([commit("1", { subject: "fix: x", files: [{ path: "test/server.ts", lines: 2 }] })], { atHead: new Set(["test/server.ts"]) }).problems).toHaveLength(1);
});

test("--no-test waives the fix-test rule with its reason, never the identity check", () => {
  const r = check([commit("1", { subject: "fix: x" })], { noTest: "config only" });
  expect(r.problems).toEqual([]);
  expect(r.waiver).toBe("config only");
  expect(r.lines).toContain("FIXTEST_WAIVED fix commit 111111111111 has no test; --no-test: config only (kept in the tests receipt)");
  expect(check([commit("1", { author: { ...ME, email: "o@x.y" } })], { identity: ME, noTest: "r" }).problems).toHaveLength(1);
});

test("an extensionless executable at the head is source, so a fix of it needs a test (review of #305)", () => {
  const relay = "skills/dori-mode/setups/discord-aoe/dori-file-relay";
  const fix = commit("1", { subject: "fix: relay", files: [{ path: relay, lines: 4 }] });
  expect(check([fix], { atHead: new Set([relay]), executables: new Set([relay]) }).problems).toEqual([expect.stringMatching(/^fix commit 111111111111 changes source/)]);
  expect(check([fix], { atHead: new Set([relay]) }).problems).toEqual([]);
});

test("a test changed in one commit and renamed unchanged in a later one still counts (review of #305)", () => {
  const files = (path: string, lines: number, oldPath?: string) => [{ path, lines, ...(oldPath ? { oldPath } : {}) }];
  const commits = [commit("1", { subject: "fix: x" }), commit("2", { subject: "test: x", files: files("test/a.test.ts", 6) }), commit("3", { subject: "test: move", files: files("test/b.test.ts", 0, "test/a.test.ts") })];
  expect(check(commits, { atHead: new Set(["src/x.ts", "test/b.test.ts"]) }).problems).toEqual([]);
  const gone = [...commits, commit("4", { subject: "chore", files: files("test/b.test.ts", 6) })];
  expect(check(gone, { atHead: new Set(["src/x.ts"]) }).problems).toHaveLength(1);
});

test("a merge commit's files are not the PR's own: its source changes need no test", () => {
  expect(check([commit("1", { subject: "fix: x", parents: 2 })]).problems).toEqual([]);
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("from a real checkout: renames, identities and files are read from git, the commit list from GitHub", async () => {
  const root = mkdtempSync(join(tmpdir(), "gate-checks-"));
  dirs.push(root);
  const git = async (...a: string[]) => {
    const r = await run(["git", "-C", root, ...a], { env: { GIT_AUTHOR_NAME: ME.name, GIT_AUTHOR_EMAIL: ME.email, GIT_COMMITTER_NAME: ME.name, GIT_COMMITTER_EMAIL: ME.email } });
    if (r.code !== 0) throw new Error(r.err);
    return r.out.trim();
  };
  await git("init", "-q", "-b", "main");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "tool"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  writeFileSync(join(root, "test/a.test.ts"), "import { a } from '../src/a.ts';\nexpect(a).toBe(1);\n".repeat(5));
  await git("add", ".");
  await git("commit", "-q", "-m", "base");
  writeFileSync(join(root, "src/a.ts"), "export const a = 2;\n");
  renameSync(join(root, "test/a.test.ts"), join(root, "test/b.test.ts"));
  await git("add", "-A");
  await git("commit", "-q", "-m", "Fix: a is two\n\nbody");
  const head = await git("rev-parse", "HEAD");
  const calls: string[][] = [];
  const runner: Runner = async (argv, opts) => {
    calls.push([...argv]);
    return argv[0] === "gh" ? { code: 0, out: `${head}\n`, err: "" } : run(argv, opts);
  };
  const read = await readPrCommits({ run: runner }, { repo: "acme/app", number: "7", id: "acme/app#7" }, root, head);
  expect([...read.executables]).toEqual(["tool"]);
  expect(calls[0]).toEqual(["gh", "api", "--paginate", "repos/acme/app/pulls/7/commits?per_page=100", "--jq", ".[].sha"]);
  expect(read.commits).toEqual([{ sha: head, subject: "Fix: a is two", author: ME, committer: ME, parents: 1, files: [{ path: "src/a.ts", lines: 2 }, { path: "test/b.test.ts", oldPath: "test/a.test.ts", lines: 0 }] }]);
  expect(checkCommits("acme/app", read.commits, { atHead: read.atHead, identity: ME }).problems).toEqual([expect.stringMatching(/^fix commit [0-9a-f]{12} changes source/)]);
});

test("a commit list that does not end at the head, or a commit missing from the checkout, is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "gate-checks-"));
  dirs.push(root);
  await run(["git", "-C", root, "init", "-q"]);
  const pr = { repo: "acme/app", number: "7", id: "acme/app#7" };
  const gh = (out: string): Runner => async (argv, opts) => (argv[0] === "gh" ? { code: 0, out, err: "" } : run(argv, opts));
  await expect(readPrCommits({ run: gh(`${sha("1")}\n`) }, pr, root, sha("2"))).rejects.toThrow(/^REVIEW_REFUSED the commit list GitHub gave for acme\/app#7 does not end at its head 222222222222/);
  await expect(readPrCommits({ run: gh(`${sha("2")}\n`) }, pr, root, sha("2"))).rejects.toThrow(/^REVIEW_REFUSED commit 222222222222 of acme\/app#7 cannot be read in /);
  await expect(readPrCommits({ run: async () => ({ code: 1, out: "", err: "HTTP 502" }) }, pr, root, sha("2"))).rejects.toThrow(/^REVIEW_REFUSED cannot read the commits of acme\/app#7: HTTP 502/);
});

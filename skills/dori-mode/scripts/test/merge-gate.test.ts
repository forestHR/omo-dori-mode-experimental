import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig } from "../src/config.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { gateMissing, mergePr, parsePr, PROMPT_MAX_BYTES, readReceipt, reviewPrompt, reviewPr, verdictOf } from "../src/merge-gate.ts";
import { Registry } from "../src/registry.ts";
import type { Ran, Runner } from "../src/run.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const PR = parsePr("acme/app#7");
const DIR = "/wt/app";

type FakeCommit = { sha: string; subject: string; email?: string; numstat?: string };
type Gh = { commits?: FakeCommit[]; atHead?: string[]; head: string; checkout: string; state: string; dirtyAfterTests?: boolean; tested?: boolean; statusFails?: boolean; queued?: boolean; viewFailsAfterMerge?: boolean; deleteFails?: boolean; mergeRejects?: boolean; autoMerge?: boolean; diff?: string; prompt?: string; pushDuringReview?: string; noVerdict?: { code: number; out: string; times: number; err?: string }; checks: Record<string, string>[]; testsCode: number; verdict: string; mergedAt: string; calls: string[][] };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const world = (): Gh => ({ head: A, checkout: A, state: "OPEN", checks: [], testsCode: 0, verdict: "CLEAR", mergedAt: "", calls: [] });

const runner = (w: Gh): Runner => async (argv) => {
  w.calls.push([...argv]);
  const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
  const a = argv.join(" ");
  if (a.startsWith("gh pr view") && w.viewFailsAfterMerge && w.calls.some((c) => c[2] === "merge")) return { code: 1, out: "", err: "HTTP 502" };
  if (a.startsWith("gh pr view")) return ok(JSON.stringify({ state: w.state, headRefOid: w.head, mergedAt: w.mergedAt || null, mergeCommit: w.state === "MERGED" ? { oid: "m".repeat(40) } : null, title: "demo", statusCheckRollup: w.checks, autoMergeRequest: w.autoMerge ? { enabledAt: "2026-11-02T08:00:00Z" } : null }));
  if (a.startsWith("gh pr diff")) return ok(w.diff ?? "diff --git a/x b/x\n+x");
  const listed = w.commits ?? [{ sha: w.head, subject: "feat: demo" }];
  if (a.startsWith("gh api --paginate repos/")) return ok(listed.map((c) => `${c.sha}\n`).join(""));
  const one = listed.find((c) => c.sha === argv.at(-1));
  if (argv[3] === "log" && one) return ok(`Lane\0${one.email ?? "lane@example.org"}\0Lane\0${one.email ?? "lane@example.org"}\0${"0".repeat(40)}\0${one.subject}\n`);
  if (argv[3] === "show" && one) return ok(one.numstat ?? "3\t1\tsrc/x.ts\0");
  if (argv[3] === "ls-tree") return ok((w.atHead ?? ["src/x.ts"]).map((p) => `100644 blob ${"0".repeat(40)}\t${p}\0`).join(""));
  if (a.startsWith("gh pr merge") && argv.includes("--disable-auto")) return ok();
  if (a.startsWith("gh pr merge") && w.mergeRejects) return { code: 1, out: "", err: "GraphQL: Head branch was modified. Review and try the merge again." };
  if (a.startsWith("gh pr merge")) {
    const at = argv[argv.indexOf("--match-head-commit") + 1];
    if (at !== w.head) return { code: 1, out: "", err: "GraphQL: Head branch was modified" };
    if (!w.queued) w.state = "MERGED";
    return w.deleteFails ? { code: 1, out: "", err: "failed to delete remote branch feat" } : ok();
  }
  if (a.includes("rev-parse --show-toplevel")) return ok(`${DIR}\n`);
  if (a.includes("rev-parse HEAD")) return ok(`${w.checkout}\n`);
  if (a.includes(` diff ${A}..${B}`)) return ok("diff --git a/fix b/fix\n+FIXED_SINCE_REVIEW");
  if (a.includes("status --porcelain") && w.statusFails) return { code: 128, out: "", err: "fatal: not a git repository" };
  if (a.includes("status --porcelain")) return ok(w.tested && w.dirtyAfterTests ? " M src/x.ts\n" : "");
  if (argv[0] === "bun" && argv[1] === "test") {
    w.tested = true;
    return { code: w.testsCode, out: "", err: w.testsCode ? "1 fail" : "42 pass\n0 fail" };
  }
  if (argv[0] === "fake-reviewer") {
    if (w.pushDuringReview) w.head = w.pushDuringReview;
    w.prompt = argv.at(-1);
    if (w.noVerdict && w.noVerdict.times-- > 0) return { code: w.noVerdict.code, out: w.noVerdict.out, err: w.noVerdict.err ?? (w.noVerdict.code ? "error: provider overloaded" : "") };
    return ok(`LOW x:1 nit\nVERDICT: ${w.verdict}\n`);
  }
  return { code: 127, out: "", err: `unexpected ${a}` };
};

const deps = (w: Gh, repos: Record<string, string> = {}, identities: Record<string, { name: string; email: string }> = {}): FlowDeps => {
  const state = mkdtempSync(join(tmpdir(), "merge-gate-"));
  dirs.push(state);
  const base = defaultConfig(state);
  const config = { ...base, stateDir: state, watchLog: join(state, "lanes.log"), explore: { ...base.explore, modelsCommand: [], challengeCommand: ["fake-reviewer", "{model}", "{prompt}"] }, mergeGate: { ...base.mergeGate, repos, identities } };
  return { run: runner(w), clock: { now: () => Date.parse("2026-11-02T08:00:00Z"), sleep: async () => {} }, registry: new Registry(state), config };
};

const merges = (w: Gh) => w.calls.filter((c) => c[0] === "gh" && c[2] === "merge");

test("merge without a review receipt is refused and gh pr merge never runs", async () => {
  const w = world();
  await expect(mergePr(deps(w), PR)).rejects.toThrow(/^MERGE_REFUSED acme\/app#7 head aaaaaaaaaaaa has no review receipt/);
  expect(merges(w)).toEqual([]);
});

test("a CLEAR review with passing local tests at the head merges with --match-head-commit at that head", async () => {
  const w = world();
  const d = deps(w);
  const lines = await reviewPr(d, PR, { dir: DIR });
  expect(lines.at(-1)).toMatch(new RegExp(`^REVIEW acme/app#7 head=${A} verdict=CLEAR`));
  expect(await mergePr(d, PR)).toMatch(new RegExp(`^MERGED acme/app#7 head=${A} merge=m{40}`));
  expect(merges(w)).toEqual([["gh", "pr", "merge", "7", "--repo", "acme/app", "--squash", "--match-head-commit", A]]);
  expect((await readReceipt(d.config.stateDir, PR, A, "merge"))?.mergeCommit).toBe("m".repeat(40));
});

test("a commit pushed after the review is refused and names the reviewed commit", async () => {
  const w = world();
  const d = deps(w);
  await reviewPr(d, PR, { dir: DIR });
  w.head = B;
  await expect(mergePr(d, PR)).rejects.toThrow(`MERGE_REFUSED acme/app#7 head bbbbbbbbbbbb has no review receipt; the last review was at aaaaaaaaaaaa`);
  expect(merges(w)).toEqual([]);
});

test("a review run in a checkout that is not the PR head writes no receipt", async () => {
  const w = { ...world(), checkout: B };
  const d = deps(w);
  await expect(reviewPr(d, PR, { dir: DIR })).rejects.toThrow(/^REVIEW_REFUSED \/wt\/app is at bbbbbbbbbbbb, acme\/app#7 head is aaaaaaaaaaaa/);
  expect(await readReceipt(d.config.stateDir, PR, A, "review")).toBeUndefined();
});

test("a BLOCK verdict is refused", async () => {
  const w = { ...world(), verdict: "BLOCK" };
  const d = deps(w);
  await reviewPr(d, PR, { dir: DIR });
  await expect(mergePr(d, PR)).rejects.toThrow(/^MERGE_REFUSED acme\/app#7 review at aaaaaaaaaaaa is BLOCK/);
});

test("with no GitHub checks failing local tests stop the review and the merge", async () => {
  const w = { ...world(), testsCode: 1 };
  const d = deps(w);
  await expect(reviewPr(d, PR, { dir: DIR })).rejects.toThrow(/^REVIEW_TESTS_FAILED/);
  expect(w.calls.some((c) => c[0] === "fake-reviewer")).toBe(false);
  await expect(mergePr(d, PR)).rejects.toThrow(/^MERGE_REFUSED acme\/app#7 head aaaaaaaaaaaa has no review receipt/);
});

test("claim-done check: a gated PR merged with plain gh after the since time is missing, before it or through dori merge it is not", async () => {
  const w = { ...world(), state: "MERGED", mergedAt: "2026-11-02T09:00:00Z" };
  expect(await gateMissing(deps(w, { "acme/app": "2026-11-02T08:30:00Z" }), "merged acme/app#7; closed acme/app#8")).toEqual([expect.stringMatching(/^MERGE_GATE_MISSING acme\/app#7: merged at 2026-11-02T09:00:00Z without dori merge/)]);
  expect(await gateMissing(deps(w, { "acme/app": "2026-11-02T09:30:00Z" }), "merged acme/app#7")).toEqual([]);
  expect(await gateMissing(deps(w), "merged acme/app#7")).toEqual([]);
  const open = world();
  const d = deps(open, { "acme/app": "2026-11-02T07:00:00Z" });
  await reviewPr(d, PR, { dir: DIR });
  await mergePr(d, PR);
  open.mergedAt = "2026-11-02T08:00:00Z";
  expect(await gateMissing(d, "merged acme/app#7")).toEqual([]);
});

test("a test run that edits tracked files writes no receipt", async () => {
  const w = { ...world(), dirtyAfterTests: true };
  const d = deps(w);
  await expect(reviewPr(d, PR, { dir: DIR })).rejects.toThrow(/^REVIEW_REFUSED \/wt\/app has changes that are not in aaaaaaaaaaaa \(after the tests\)/);
  expect(await readReceipt(d.config.stateDir, PR, A, "tests")).toBeUndefined();
  expect(w.calls.some((c) => c[0] === "fake-reviewer")).toBe(false);
});

test("a push while the reviewer reads writes no review receipt for the old head", async () => {
  const w = { ...world(), pushDuringReview: B };
  const d = deps(w);
  await expect(reviewPr(d, PR, { dir: DIR })).rejects.toThrow(/\(after the review\)/);
  expect(await readReceipt(d.config.stateDir, PR, A, "review")).toBeUndefined();
});

test("--model of the lane's own family is refused, also with reviewers.allowSameFamily", async () => {
  const w = world();
  const base = deps(w);
  const d = { ...base, config: { ...base.config, reviewers: { ...base.config.reviewers, allowSameFamily: true } } };
  const lane = { key: "k", title: "t", thread: "none", pane: "p", brief: "/b", done: "", openedAt: "", model: "anthropic-subscription/claude-opus-5-5" };
  await expect(reviewPr(d, PR, { dir: DIR, model: "anthropic-subscription/claude-fable-5-1", lane })).rejects.toThrow(/^REVIEW_REFUSED --model anthropic-subscription\/claude-fable-5-1 is of the lane's own family \(anthropic\)/);
  expect(w.calls.some((c) => c[0] === "fake-reviewer")).toBe(false);
});

test("claim-done check reads the Done = form and quoted parts like the signal checker", async () => {
  const w = { ...world(), state: "MERGED", mergedAt: "2026-11-02T09:00:00Z" };
  expect(await gateMissing(deps(w, { "acme/app": "2026-11-02T08:30:00Z" }), 'Done = merged acme/app#7; command "echo a;b"')).toEqual([expect.stringMatching(/^MERGE_GATE_MISSING acme\/app#7/)]);
});

test("a failing test rerun at the same head takes back the earlier pass, so the merge is refused", async () => {
  const w = world();
  const d = deps(w);
  await reviewPr(d, PR, { dir: DIR });
  w.testsCode = 1;
  await expect(reviewPr(d, PR, { dir: DIR })).rejects.toThrow(/^REVIEW_TESTS_FAILED/);
  await expect(mergePr(d, PR)).rejects.toThrow(/^MERGE_REFUSED acme\/app#7 has no local test receipt at head aaaaaaaaaaaa/);
  expect(merges(w)).toEqual([]);
});

test("receipts do not depend on the repo's casing", async () => {
  const w = world();
  const d = deps(w, { "acme/app": "2026-11-02T07:00:00Z" });
  await reviewPr(d, parsePr("Acme/App#7"), { dir: DIR });
  await mergePr(d, parsePr("acme/app#7"));
  w.mergedAt = "2026-11-02T08:00:00Z";
  expect(await gateMissing(d, "merged ACME/app#7")).toEqual([]);
});

test("a git status that fails is not a clean checkout", async () => {
  const w = { ...world(), statusFails: true };
  const d = deps(w);
  await expect(reviewPr(d, PR, { dir: DIR })).rejects.toThrow(/^REVIEW_REFUSED cannot read the status of \/wt\/app/);
  expect(w.calls.some((c) => c[0] === "bun")).toBe(false);
});

test("a merge whose read-back fails is MERGE_UNCONFIRMED and claim-done does not guess it was the gate's", async () => {
  const w = { ...world(), viewFailsAfterMerge: true };
  const d = deps(w, { "acme/app": "2026-11-02T07:00:00Z" });
  await reviewPr(d, PR, { dir: DIR });
  await expect(mergePr(d, PR)).rejects.toThrow(/^MERGE_UNCONFIRMED acme\/app#7: gh pr merge at head aaaaaaaaaaaa exited 0 and the read-back failed/);
  Object.assign(w, { viewFailsAfterMerge: false, mergedAt: "2026-11-02T08:00:30Z" });
  expect(await gateMissing(d, "merged acme/app#7")).toEqual([expect.stringMatching(/^MERGE_GATE_MISSING acme\/app#7/)]);
});

test("a merge GitHub only queued is turned off and refused, with no merge receipt", async () => {
  const w = { ...world(), queued: true };
  const d = deps(w);
  await reviewPr(d, PR, { dir: DIR });
  await expect(mergePr(d, PR)).rejects.toThrow(/^MERGE_REFUSED acme\/app#7 GitHub queued the merge instead of merging it \(OPEN\); auto-merge was turned off again/);
  expect(w.calls.some((c) => c.includes("--disable-auto"))).toBe(true);
  expect(await readReceipt(d.config.stateDir, PR, A, "merge")).toBeUndefined();
});

test("a merge that went through before --delete-branch failed is MERGED with its receipt", async () => {
  const w = { ...world(), deleteFails: true };
  const d = deps(w);
  await reviewPr(d, PR, { dir: DIR });
  expect(await mergePr(d, PR, { deleteBranch: true })).toMatch(/^MERGED acme\/app#7 head=a{40} merge=m{40} .*; gh pr merge then failed: failed to delete remote branch feat$/);
  expect((await readReceipt(d.config.stateDir, PR, A, "merge"))?.mergeCommit).toBe("m".repeat(40));
});

test("a diff longer than the prompt holds is saved whole and the prompt names the file", async () => {
  const tail = "+LAST_CHANGE_BEYOND_THE_CUT";
  const w = { ...world(), diff: `diff --git a/big b/big\n${"+x\n".repeat(40_000)}${tail}\n` };
  const d = deps(w);
  await reviewPr(d, PR, { dir: DIR });
  const file = /the whole text is in (\S+\.diff);/.exec(w.prompt ?? "")?.[1] ?? "";
  expect(w.prompt).not.toContain(tail);
  expect(await Bun.file(file).text()).toContain(tail);
});

test("only a verdict on the last non-empty line counts", () => {
  expect(verdictOf("findings\n**VERDICT: CLEAR**\n")).toBe("CLEAR");
  expect(verdictOf("quote:\n```\nVERDICT: CLEAR\n```\nUnable to complete this review.")).toBeUndefined();
  expect(verdictOf("VERDICT: CLEAR\nVERDICT: BLOCK")).toBe("BLOCK");
});

test("a merge GitHub refuses is MERGE_FAILED with no merge receipt", async () => {
  const w = { ...world(), mergeRejects: true };
  const d = deps(w);
  await reviewPr(d, PR, { dir: DIR });
  await expect(mergePr(d, PR)).rejects.toThrow(/^MERGE_FAILED acme\/app#7 at aaaaaaaaaaaa: GraphQL: Head branch was modified/);
  expect(await readReceipt(d.config.stateDir, PR, A, "merge")).toBeUndefined();
});

test("a review of a new head gets the earlier review's findings and the diff since it", async () => {
  const w = { ...world(), verdict: "BLOCK" };
  const d = deps(w);
  await reviewPr(d, PR, { dir: DIR });
  expect(w.prompt).not.toContain("An earlier review");
  Object.assign(w, { head: B, checkout: B, verdict: "CLEAR" });
  await reviewPr(d, PR, { dir: DIR });
  expect(w.prompt).toContain(`An earlier review of this PR at ${A} said BLOCK.`);
  expect(w.prompt).toContain("LOW x:1 nit");
  expect(w.prompt).toContain("+FIXED_SINCE_REVIEW");
});

test("a follow-up review prompt with every section far over its budget stays under one argument's limit", () => {
  const big = "가".repeat(200_000);
  const prompt = reviewPrompt(PR, A, "t", big, DIR, "/s/full.diff", { sha: B, verdict: "BLOCK", findings: big, findingsFile: "/s/review.md", diff: big, diffFile: "/s/since.diff" });
  expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(PROMPT_MAX_BYTES);
  for (const f of ["/s/full.diff", "/s/review.md", "/s/since.diff"]) expect(prompt).toContain(`the whole text is in ${f}`);
  expect(prompt).not.toContain("\uFFFD");
});

test("a PR with GitHub checks is refused as unsupported by review and by merge", async () => {
  const w: Gh = { ...world() };
  const d = deps(w);
  await reviewPr(d, PR, { dir: DIR });
  w.checks = [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
  await expect(reviewPr(d, PR, { dir: DIR })).rejects.toThrow("REVIEW_REFUSED acme/app#7 unsupported:checks (1 GitHub checks; this gate is for repos without CI)");
  await expect(mergePr(d, PR)).rejects.toThrow("MERGE_REFUSED acme/app#7 unsupported:checks");
  expect(merges(w)).toEqual([]);
});

test("a PR with auto-merge on is refused as unsupported", async () => {
  const w = world();
  const d = deps(w);
  await reviewPr(d, PR, { dir: DIR });
  w.autoMerge = true;
  await expect(mergePr(d, PR)).rejects.toThrow("MERGE_REFUSED acme/app#7 unsupported:queue (auto-merge is on for this PR)");
  expect(merges(w)).toEqual([]);
});

test("a merge whose gh call and read-back both fail records the attempt and leaves claim-done to the lead", async () => {
  const w = { ...world(), deleteFails: true, viewFailsAfterMerge: true };
  const d = deps(w, { "acme/app": "2026-11-02T07:00:00Z" });
  await reviewPr(d, PR, { dir: DIR });
  await expect(mergePr(d, PR, { deleteBranch: true })).rejects.toThrow(/^MERGE_UNCONFIRMED acme\/app#7: gh pr merge at head aaaaaaaaaaaa failed \(failed to delete remote branch feat\) and the read-back failed/);
  expect(await readReceipt(d.config.stateDir, PR, A, "attempt")).toBeDefined();
  Object.assign(w, { viewFailsAfterMerge: false, mergedAt: "2026-11-02T08:00:30Z" });
  expect(await gateMissing(d, "merged acme/app#7")).toEqual([expect.stringMatching(/^MERGE_GATE_MISSING acme\/app#7/)]);
});

test("an attempt that never merged does not let a plain gh merge pass later, even with the head still CLEAR", async () => {
  const w = { ...world(), mergeRejects: true, viewFailsAfterMerge: true };
  const d = deps(w, { "acme/app": "2026-11-02T07:00:00Z" });
  await reviewPr(d, PR, { dir: DIR });
  await expect(mergePr(d, PR)).rejects.toThrow(/^MERGE_UNCONFIRMED/);
  Object.assign(w, { mergeRejects: false, viewFailsAfterMerge: false, state: "MERGED", mergedAt: "2026-11-02T09:00:00Z" });
  expect(await gateMissing(d, "merged acme/app#7")).toEqual([expect.stringMatching(/^MERGE_GATE_MISSING acme\/app#7/)]);
});


// dori-superagent #71 (https://github.com/sisyphuslabs/dori-superagent/issues/71): a reviewer that ends without a verdict
// leaves its stdout tail in a private file the skip line names, and no review receipt
const kept = (line: string): string => {
  const m = /reviewer stdout kept in (\S+\.txt)/.exec(line);
  if (!m?.[1]) throw new Error(`no kept stdout path in: ${line}`);
  return m[1];
};

test("exit 0 without a VERDICT line: a bounded, masked stdout tail is kept in a 0600 file the refusal names, and no review receipt", async () => {
  const lines = Array.from({ length: 205 }, (_, i) => `line-${i + 1}`);
  lines[203] = "token: ghp_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
  const w = { ...world(), noVerdict: { code: 0, out: lines.join("\n"), times: 99 } };
  const d = deps(w);
  const failure = await reviewPr(d, PR, { dir: DIR }).then(() => undefined, (e: unknown) => e);
  expect(failure).toBeInstanceOf(Error);
  const message = (failure as Error).message;
  expect(message).toStartWith("REVIEW_FAILED acme/app#7: no reviewer printed a VERDICT line:");
  expect(message).toContain(": no VERDICT line; reviewer stdout kept in ");
  const file = kept(message);
  expect(file.startsWith(join(d.config.stateDir, "reviewer-output") + "/")).toBe(true);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const text = readFileSync(file, "utf8");
  expect(text.split("\n")).toEqual(lines.slice(5).map((l) => (l.startsWith("token:") ? "token: [masked]" : l)));
  expect(text).not.toContain("ghp_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ");
  expect(await readReceipt(d.config.stateDir, PR, A, "review")).toBeUndefined();
});

test("a nonzero exit keeps its stdout tail too and the exit reason, and the next reviewer's CLEAR is the review", async () => {
  const w = { ...world(), noVerdict: { code: 9, out: "partial reviewer output", times: 1 } };
  const d = deps(w);
  const lines = await reviewPr(d, PR, { dir: DIR });
  const skip = lines.find((l) => l.startsWith("REVIEW_SKIP "));
  expect(skip).toContain("error: provider overloaded; reviewer stdout kept in ");
  const file = kept(skip ?? "");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).toBe("partial reviewer output");
  expect(lines.at(-1)).toMatch(new RegExp(`^REVIEW acme/app#7 head=${A} verdict=CLEAR`));
  expect((await readReceipt(d.config.stateDir, PR, A, "review"))?.verdict).toBe("CLEAR");
});

test("a nonzero exit with empty stderr names its exit code, never its unmasked stdout, in the refusal (review of #302)", async () => {
  const w = { ...world(), noVerdict: { code: 7, out: "half done\napi_key=ghp_YYYYYYYYYYYYYYYYYYYYYYYYYYYYYY", times: 99, err: "" } };
  const d = deps(w);
  const failure = await reviewPr(d, PR, { dir: DIR }).then(() => undefined, (e: unknown) => e);
  const message = (failure as Error).message;
  expect(message).toContain(": exit 7; reviewer stdout kept in ");
  expect(message).not.toContain("ghp_YYYYYYYYYYYYYYYYYYYYYYYYYYYYYY");
  expect(message).not.toContain("half done");
  expect(readFileSync(kept(message), "utf8")).toBe("half done\napi_key=[masked]");
});


// dori review's commit checks (dori-superagent #44 https://github.com/sisyphuslabs/dori-superagent/pull/44 and #57
// https://github.com/sisyphuslabs/dori-superagent/issues/57) run before the tests: a refusal runs no test and no reviewer
test("a source fix with no test is refused before the tests, and takes back an earlier pass at that head", async () => {
  const w = world();
  const d = deps(w);
  await reviewPr(d, PR, { dir: DIR });
  w.commits = [{ sha: A, subject: "Fix: count" }];
  const before = w.calls.length;
  await expect(reviewPr(d, PR, { dir: DIR })).rejects.toThrow(/^REVIEW_CHECKS_FAILED acme\/app#7 head=aaaaaaaaaaaa: fix commit aaaaaaaaaaaa changes source and no commit of the PR adds or changes a test/);
  expect(w.calls.slice(before).some((c) => c[0] === "bun" || c[0] === "fake-reviewer")).toBe(false);
  expect(await readReceipt(d.config.stateDir, PR, A, "tests")).toBeUndefined();
  await expect(mergePr(d, PR)).rejects.toThrow(/^MERGE_REFUSED acme\/app#7 has no local test receipt/);
});

test("--no-test lets a fix without a test through and its reason is in the tests receipt", async () => {
  const w = { ...world(), commits: [{ sha: A, subject: "fix: config default" }] };
  const d = deps(w);
  const lines = await reviewPr(d, PR, { dir: DIR, noTest: "only a default in config.ts; no behaviour to test" });
  expect(lines).toContain("FIXTEST_WAIVED fix commit aaaaaaaaaaaa has no test; --no-test: only a default in config.ts; no behaviour to test (kept in the tests receipt)");
  expect((await readReceipt(d.config.stateDir, PR, A, "tests"))?.waiver).toBe("only a default in config.ts; no behaviour to test");
});

test("a commit by another identity than the repo's is refused without its address; no entry skips with one line", async () => {
  const w = { ...world(), commits: [{ sha: A, subject: "feat: x", email: "stranger@corp.io" }] };
  const d = deps(w, {}, { "Acme/App": { name: "Lane", email: "lane@example.org" } });
  const failure = (await reviewPr(d, PR, { dir: DIR }).then(() => undefined, (e: unknown) => e)) as Error;
  expect(failure.message).toStartWith("REVIEW_CHECKS_FAILED acme/app#7 head=aaaaaaaaaaaa: author email st***@co*** (commit aaaaaaaaaaaa) is not the one set for acme/app");
  expect(failure.message).not.toContain("stranger@corp.io");
  expect(w.calls.some((c) => c[0] === "bun")).toBe(false);
  const lines = await reviewPr(deps({ ...world(), commits: w.commits }), PR, { dir: DIR });
  expect(lines.slice(0, 2)).toEqual(["IDENTITY_SKIP acme/app has no mergeGate.identities entry; commit names and emails are not checked", `CHECKS_OK acme/app#7 head=${A} identity=skipped fix-test=no-fix`]);
});


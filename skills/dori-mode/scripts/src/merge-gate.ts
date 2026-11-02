import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { checkReviewers, familyOf, reviewers } from "./challenge.ts";
import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { parseSignal, splitDone } from "./done-signals.ts";
import type { Lane } from "./registry.ts";
import { iso, type Ran } from "./run.ts";
import { watchLog } from "./watch-log.ts";

// dori review / dori merge: a PR merges only at the exact head commit a review receipt names (ported from dori-superagent
// harness.ts review()/mergeGate(), MIT). A lane that changes a commit after its review has no receipt at the new head, so
// dori merge refuses it, and gh pr merge --match-head-commit makes GitHub refuse a head that moved after the gate's read.
// dori-superagent also refuses an empty check list ("never green"); the fork has no CI, so there every merge would be
// refused. This gate is for repositories without CI: a passing local test run (dori review ran mergeGate.testCommand in
// a clean checkout at that head) stands in for checks, and a PR that has GitHub checks or an auto-merge request is
// refused as unsupported (MERGE_REFUSED unsupported:checks / unsupported:queue). Porting check handling is follow-up
// work for when a gated repo gets CI.
// The reviewer is a fresh run (explore.challengeCommand: omo -p, no session, read-only tools) of a reviewers.models id of
// another family than the lane's model, the same machinery as dori challenge. A review inside the lane's own session
// (omo-native-code-reviewer) leaves its only copy with the lane; this one the CLI runs and records itself.

export class GateRefusal extends Error {}

export type PrRef = { readonly repo: string; readonly number: string; readonly id: string };

export const parsePr = (s: string): PrRef => {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s.trim()) ?? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/.exec(s.trim());
  if (!m?.[1] || !m[2]) throw new GateRefusal(`PR must look like owner/repo#123 or its github.com pull URL, got "${s}"`);
  return { repo: m[1], number: m[2], id: `${m[1]}#${m[2]}` };
};

// attempt: a dori merge whose outcome is not known yet (pending); merge: a merge read back as done (confirmed)
export type Kind = "review" | "tests" | "attempt" | "merge";
export type Receipt = {
  readonly pr: string;
  readonly sha: string;
  readonly kind: Kind;
  readonly at: string;
  readonly verdict?: "CLEAR" | "BLOCK";
  readonly reviewer?: string;
  readonly file?: string;
  readonly command?: readonly string[];
  readonly code?: number;
  readonly tail?: string;
  readonly mergeCommit?: string;
};

const receiptDir = (stateDir: string): string => join(stateDir, "receipts");
// GitHub repo names are case-insensitive: Acme/App#7 and acme/app#7 share their receipts
const stem = (pr: PrRef): string => `${pr.repo.toLowerCase().replace("/", "__")}_${pr.number}`;
export const receiptPath = (stateDir: string, pr: PrRef, sha: string, kind: Kind): string => join(receiptDir(stateDir), `${stem(pr)}@${sha}.${kind}.json`);

export const readReceipt = async (stateDir: string, pr: PrRef, sha: string, kind: Kind): Promise<Receipt | undefined> => {
  const f = Bun.file(receiptPath(stateDir, pr, sha, kind));
  return (await f.exists()) ? ((await f.json()) as Receipt) : undefined;
};

const writeReceipt = async (stateDir: string, pr: PrRef, r: Receipt): Promise<string> => {
  mkdirSync(receiptDir(stateDir), { recursive: true });
  const path = receiptPath(stateDir, pr, r.sha, r.kind);
  await Bun.write(path, `${JSON.stringify(r, null, 2)}\n`);
  return path;
};

// every receipt of one kind for the PR, newest first (to name the reviewed commit when the head moved after it)
const receiptsOf = async (stateDir: string, pr: PrRef, kind: Kind): Promise<Receipt[]> => {
  let names: string[] = [];
  try {
    names = readdirSync(receiptDir(stateDir)).filter((n) => n.startsWith(`${stem(pr)}@`) && n.endsWith(`.${kind}.json`));
  } catch {
    return [];
  }
  const all = await Promise.all(names.map(async (n) => (await Bun.file(join(receiptDir(stateDir), n)).json()) as Receipt));
  return all.sort((a, b) => b.at.localeCompare(a.at));
};

const short = (sha: string): string => sha.slice(0, 12);
const why = (r: Ran): string => (r.err || r.out).trim().split("\n").slice(-3).join(" ").slice(0, 300) || `exit ${r.code}`;

type View = { readonly state: string; readonly headRefOid: string; readonly autoMergeRequest?: unknown; readonly statusCheckRollup?: readonly unknown[] | null; readonly mergedAt?: string | null; readonly mergeCommit?: { readonly oid?: string } | null; readonly title?: string };

export const viewPr = async (deps: Pick<FlowDeps, "run">, pr: PrRef): Promise<View> => {
  const r = await deps.run(["gh", "pr", "view", pr.number, "--repo", pr.repo, "--json", "state,headRefOid,mergedAt,mergeCommit,title,autoMergeRequest,statusCheckRollup"]);
  if (r.code !== 0) throw new GateRefusal(`cannot read ${pr.id}: ${why(r)}`);
  const v = JSON.parse(r.out) as View;
  if (!/^[0-9a-f]{40}$/.test(v.headRefOid ?? "")) throw new GateRefusal(`${pr.id} has no head commit in gh's answer`);
  return v;
};

// what this gate does not handle: GitHub checks (it has no check logic) and auto-merge or a merge queue (a merge that
// happens later could take another head)
export const unsupported = (v: View): string | undefined =>
  v.statusCheckRollup?.length ? `unsupported:checks (${v.statusCheckRollup.length} GitHub checks; this gate is for repos without CI)` : v.autoMergeRequest ? "unsupported:queue (auto-merge is on for this PR)" : undefined;

export const REVIEW_SYSTEM = "You are a code reviewer. You may read files with the read, grep, find and ls tools; you cannot change anything or run code. Your final message is the review the user asks for, ending with the VERDICT line. You never ask questions.";

// The prompt is one argv argument, and Linux caps one argument at 128 KiB (MAX_ARG_STRLEN): each section gets a byte
// budget that keeps the whole prompt under that, and what is cut is read from the saved file the cut names.
const DIFF_BYTES = 64_000;
const SINCE_BYTES = 16_000;
const FINDINGS_BYTES = 12_000;
export const PROMPT_MAX_BYTES = 100_000;

export type Prior = { readonly sha: string; readonly verdict: string; readonly findings: string; readonly findingsFile: string; readonly diff: string; readonly diffFile: string };

const cut = (text: string, max: number, file: string): string => {
  const bytes = Buffer.from(text);
  return bytes.length > max ? `${bytes.subarray(0, max).toString().replace(/\uFFFD+$/, "")}\n[cut at ${max} bytes: the whole text is in ${file}; read the rest there before you give a verdict]` : text;
};

export const reviewPrompt = (pr: PrRef, sha: string, title: string, diff: string, root: string, diffFile: string, prior?: Prior): string => [
  `You are a code reviewer. Review pull request ${pr.id} ("${title}") at exactly head ${sha}.`,
  `The diff is below. The repository checked out at that head is ${root}; read files there with the read, grep, find and ls tools when the diff alone does not show whether the change is right.`,
  "Context: this repository has no CI. dori merge refuses a PR that has GitHub checks or auto-merge (unsupported:checks / unsupported:queue) and merges only at once, at this exact head, so paths that need CI checks, a merge queue or auto-merge cannot run here. Grade each finding by whether it can happen in this repository.",
  "Check the change against the PR's stated goal: correctness, regressions, missing tests for changed behaviour, security issues (secrets, injection, unsafe shell use), and scope creep. Ignore style nits a formatter would fix.",
  "<<<DIFF",
  cut(diff, DIFF_BYTES, diffFile),
  "DIFF>>>",
  ...(prior
    ? [
        `An earlier review of this PR at ${prior.sha} said ${prior.verdict}. Its findings, then the diff from that commit to this head:`,
        "<<<EARLIER_REVIEW",
        cut(prior.findings, FINDINGS_BYTES, prior.findingsFile),
        "EARLIER_REVIEW>>>",
        "<<<DIFF_SINCE_EARLIER_REVIEW",
        cut(prior.diff, SINCE_BYTES, prior.diffFile),
        "DIFF_SINCE_EARLIER_REVIEW>>>",
        "Check first whether each earlier finding is fixed at this head (say so per finding), then what the change since that review broke, then the rest of the PR.",
      ]
    : []),
  "List each finding as: severity (HIGH/MEDIUM/LOW), file:line, problem, fix.",
  "Then print exactly one final line:",
  "VERDICT: CLEAR   (no HIGH or MEDIUM findings)",
  "VERDICT: BLOCK   (at least one HIGH or MEDIUM finding)",
].join("\n");

// only the last non-empty line counts: a verdict quoted earlier in a reply that then gives up is no verdict
export const verdictOf = (text: string): "CLEAR" | "BLOCK" | undefined =>
  /^[\s*_`]*VERDICT:[\s*_`]*(CLEAR|BLOCK)\b[^\n]*$/.exec(text.trim().split("\n").at(-1)?.trim() ?? "")?.[1] as "CLEAR" | "BLOCK" | undefined;

const secs = (deps: Pick<FlowDeps, "clock">, since: number): number => Math.round((deps.clock.now() - since) / 1000);

const tailOf = (r: Ran): string => `${r.out}\n${r.err}`.trim().slice(-1500);

export type ReviewOptions = { readonly dir: string; readonly model?: string; readonly lane?: Lane | null };

// dori review <pr>: the checkout at dir must be the PR's head, clean. A PR with checks or auto-merge is refused; the tests run there first
// (a failing run writes its receipt and no review is asked for); then reviewers are tried in order until one prints a
// VERDICT line. Each receipt is keyed by the head SHA it was made at. The checkout and the PR head are read again after
// the tests, after the diff and after the review: a test run that edits files, or a push meanwhile, writes no receipt (a
// receipt must certify the code the tests and the reviewer actually read).
export const reviewPr = async (deps: FlowDeps, pr: PrRef, opts: ReviewOptions): Promise<string[]> => {
  const log = (line: string) => watchLog(deps.config.watchLog, deps.clock, { source: "merge-gate", line });
  const v = await viewPr(deps, pr);
  if (v.state !== "OPEN") throw new GateRefusal(`REVIEW_REFUSED ${pr.id} is ${v.state}, not open`);
  const notHere = unsupported(v);
  if (notHere) throw new GateRefusal(`REVIEW_REFUSED ${pr.id} ${notHere}`);
  const sha = v.headRefOid;
  const top = await deps.run(["git", "-C", opts.dir, "rev-parse", "--show-toplevel"]);
  const root = top.out.trim();
  if (top.code !== 0 || !root) throw new GateRefusal(`REVIEW_REFUSED ${opts.dir} is not a git checkout: ${why(top)}`);
  const still = async (stage: string): Promise<void> => {
    const head = await deps.run(["git", "-C", root, "rev-parse", "HEAD"]);
    const here = head.out.trim();
    if (head.code !== 0) throw new GateRefusal(`REVIEW_REFUSED cannot read the HEAD of ${root} (${stage}): ${why(head)}`);
    if (here !== sha) throw new GateRefusal(`REVIEW_REFUSED ${root} is at ${short(here)}, ${pr.id} head is ${short(sha)} (${stage}); push or check out the head and run it there (the review reads the code that would merge)`);
    const status = await deps.run(["git", "-C", root, "status", "--porcelain"]);
    if (status.code !== 0) throw new GateRefusal(`REVIEW_REFUSED cannot read the status of ${root} (${stage}): ${why(status)}`);
    const dirty = status.out.trim();
    if (dirty) throw new GateRefusal(`REVIEW_REFUSED ${root} has changes that are not in ${short(sha)} (${stage}): ${dirty.split("\n").slice(0, 3).join("; ")}`);
    const now = (await viewPr(deps, pr)).headRefOid;
    if (now !== sha) throw new GateRefusal(`REVIEW_REFUSED ${pr.id} head moved from ${short(sha)} to ${short(now)} (${stage}); no receipt written, review the new head`);
  };
  await still("before the review");
  const lines: string[] = [];
  const cfg = deps.config.mergeGate;
  const testDir = join(root, cfg.testDir);
  // a new run at this head replaces the old result: a pass from before must not outlive a failure now
  rmSync(receiptPath(deps.config.stateDir, pr, sha, "tests"), { force: true });
  const started = deps.clock.now();
  const t = await deps.run(cfg.testCommand, { cwd: testDir, timeoutMs: cfg.testMinutes * 60_000 });
  if (t.code !== 0) throw new GateRefusal(`REVIEW_TESTS_FAILED ${pr.id} head=${short(sha)}: ${cfg.testCommand.join(" ")} in ${testDir} exited ${t.code}; no receipt\n${tailOf(t).slice(-600)}`);
  await still("after the tests");
  const path = await writeReceipt(deps.config.stateDir, pr, { pr: pr.id, sha, kind: "tests", at: iso(deps.clock), command: cfg.testCommand, code: t.code, tail: tailOf(t) });
  log(`TESTS ${pr.id} head=${sha} exit=${t.code} receipt=${path}`);
  lines.push(`TESTS_OK ${pr.id} head=${sha} ${cfg.testCommand.join(" ")} exit 0 in ${secs(deps, started)} s receipt=${path}`);
  const diff = await deps.run(["gh", "pr", "diff", pr.number, "--repo", pr.repo]);
  if (diff.code !== 0) throw new GateRefusal(`REVIEW_REFUSED cannot read the diff of ${pr.id}: ${why(diff)}`);
  await still("after reading the diff");
  // always another family, --model too: reviewers.allowSameFamily is for dori challenge only
  const own = opts.lane?.model ?? deps.config.defaultModel;
  const candidates = reviewers(own, opts.model ? [opts.model] : deps.config.reviewers.models);
  if (!candidates.length) throw new GateRefusal(opts.model ? `REVIEW_REFUSED --model ${opts.model} is of the lane's own family (${familyOf(own)}); pick another family` : `REVIEW_REFUSED no reviewer in reviewers.models is of another family than ${own} (${familyOf(own)})`);
  const dir = join(deps.config.stateDir, "receipts", "reviews");
  mkdirSync(dir, { recursive: true });
  const diffFile = join(dir, `${stem(pr)}@${sha}.diff`);
  await Bun.write(diffFile, diff.out);
  // the newest review of an earlier head of this PR: its findings and what changed since, so the reviewer checks the fixes
  // first instead of starting over (each review of this gate's own PR found new edges while the old ones went unchecked)
  const earlier = (await receiptsOf(deps.config.stateDir, pr, "review")).find((r) => r.sha !== sha);
  let prior: Prior | undefined;
  if (earlier) {
    const since = await deps.run(["git", "-C", root, "diff", `${earlier.sha}..${sha}`]);
    const sinceFile = join(dir, `${stem(pr)}@${earlier.sha}..${sha}.diff`);
    await Bun.write(sinceFile, since.code === 0 ? since.out : "");
    const findings = earlier.file && (await Bun.file(earlier.file).exists()) ? await Bun.file(earlier.file).text() : "(review text not found)";
    prior = { sha: earlier.sha, verdict: earlier.verdict ?? "?", findings, findingsFile: earlier.file ?? "-", diff: since.code === 0 ? since.out : `(git diff ${short(earlier.sha)}..${short(sha)} failed: ${why(since)}; the commit is not in this checkout)`, diffFile: sinceFile };
  }
  const prompt = reviewPrompt(pr, sha, v.title ?? "", diff.out, root, diffFile, prior);
  const failures: string[] = [];
  for (const c of await checkReviewers(deps, candidates)) {
    if (!c.call) {
      failures.push(`${c.listed}: ${c.note}`);
      continue;
    }
    const started = deps.clock.now();
    const r = await deps.run(fill(deps.config.explore.challengeCommand, { model: c.call, prompt, system: REVIEW_SYSTEM }), { cwd: root, timeoutMs: deps.config.explore.challengeMinutes * 60_000 });
    const verdict = r.code === 0 ? verdictOf(r.out) : undefined;
    if (!verdict) {
      failures.push(`${c.call}: ${r.code !== 0 ? why(r) : "no VERDICT line"}`);
      continue;
    }
    await still("after the review");
    const at = iso(deps.clock);
    const file = join(dir, `${stem(pr)}@${sha}-${at.replace(/[:.]/g, "-")}.md`);
    await Bun.write(file, [`# Review of ${pr.id} at ${sha}`, "", `- At: ${at}`, `- Reviewer: ${c.call} (${familyOf(c.call)}); lane model ${own}`, `- Checkout: ${root}`, "", r.out.trim(), ""].join("\n"));
    const path = await writeReceipt(deps.config.stateDir, pr, { pr: pr.id, sha, kind: "review", at, verdict, reviewer: c.call, file });
    log(`REVIEW ${pr.id} head=${sha} verdict=${verdict} reviewer=${c.call} receipt=${path}`);
    for (const f of failures) lines.push(`REVIEW_SKIP ${f}`);
    lines.push(`REVIEW ${pr.id} head=${sha} verdict=${verdict} reviewer=${c.call} in ${secs(deps, started)} s review=${file}`);
    return lines;
  }
  throw new GateRefusal(`REVIEW_FAILED ${pr.id}: no reviewer printed a VERDICT line: ${failures.join(" | ")}`);
};

// dori merge <pr>: refuses with MERGE_REFUSED <reason> unless the current head has a CLEAR review receipt and a passing
// local test receipt and the PR has no checks or auto-merge; then merges with --match-head-commit at that head.
export const mergePr = async (deps: FlowDeps, pr: PrRef, opts: { readonly dryRun?: boolean; readonly deleteBranch?: boolean } = {}): Promise<string> => {
  const v = await viewPr(deps, pr);
  if (v.state !== "OPEN") throw new GateRefusal(`MERGE_REFUSED ${pr.id} is ${v.state}, not open`);
  const sha = v.headRefOid;
  const review = await readReceipt(deps.config.stateDir, pr, sha, "review");
  if (!review) {
    const last = (await receiptsOf(deps.config.stateDir, pr, "review"))[0];
    throw new GateRefusal(last
      ? `MERGE_REFUSED ${pr.id} head ${short(sha)} has no review receipt; the last review was at ${short(last.sha)} (${last.at}), so commits came after it: run dori review ${pr.id} at the new head`
      : `MERGE_REFUSED ${pr.id} head ${short(sha)} has no review receipt: run dori review ${pr.id} in a checkout of that head`);
  }
  if (review.verdict !== "CLEAR") throw new GateRefusal(`MERGE_REFUSED ${pr.id} review at ${short(sha)} is ${review.verdict} (${review.file ?? "-"}): fix the findings, push, and review again`);
  const notHere = unsupported(v);
  if (notHere) throw new GateRefusal(`MERGE_REFUSED ${pr.id} ${notHere}`);
  const tests = await readReceipt(deps.config.stateDir, pr, sha, "tests");
  if (!tests) throw new GateRefusal(`MERGE_REFUSED ${pr.id} has no local test receipt at head ${short(sha)}: run dori review ${pr.id} (it runs the tests first)`);
  if (tests.code !== 0) throw new GateRefusal(`MERGE_REFUSED ${pr.id} local tests at ${short(sha)} exited ${tests.code}`);
  const basis = `local tests passed at head (${(tests.command ?? []).join(" ")})`;
  if (opts.dryRun) return `MERGE_OK ${pr.id} head=${sha} reviewer=${review.reviewer ?? "-"}; ${basis} (dry run, nothing merged)`;
  // The attempt is recorded before gh runs, bound to this reviewed head, and dropped only when a read-back shows the PR
  // did not merge: gh can merge and then fail (--delete-branch), and the read-back can fail too, and a merge that went
  // through must never be left without the receipt claim-done looks for. A merge GitHub only queued (merge queue,
  // auto-merge) is turned off and refused: it would merge later, maybe another head.
  const receipt = { pr: pr.id, sha, kind: "attempt" as const, at: iso(deps.clock), reviewer: review.reviewer, ...(review.file ? { file: review.file } : {}) };
  const path = await writeReceipt(deps.config.stateDir, pr, receipt);
  const started = deps.clock.now();
  const m = await deps.run(["gh", "pr", "merge", pr.number, "--repo", pr.repo, "--squash", "--match-head-commit", sha, ...(opts.deleteBranch ? ["--delete-branch"] : [])]);
  const after = await viewPr(deps, pr).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  if (typeof after === "string") throw new GateRefusal(`MERGE_UNCONFIRMED ${pr.id}: gh pr merge at head ${short(sha)} ${m.code === 0 ? "exited 0" : `failed (${why(m)})`} and the read-back failed: ${after}; the attempt is recorded in ${path}; do not merge again: read it with gh pr view and tell the lead (claim-done counts only a merge read back as done; the lead decides with dori done-set)`);
  if (after.state === "MERGED" && after.headRefOid === sha && after.mergeCommit?.oid) {
    const oid = after.mergeCommit.oid;
    const done = await writeReceipt(deps.config.stateDir, pr, { ...receipt, kind: "merge", mergeCommit: oid });
    rmSync(path, { force: true });
    watchLog(deps.config.watchLog, deps.clock, { source: "merge-gate", line: `MERGED ${pr.id} head=${sha} merge=${oid} receipt=${done}` });
    return `MERGED ${pr.id} head=${sha} merge=${oid} in ${secs(deps, started)} s; ${basis}; receipt ${done}${m.code !== 0 ? `; gh pr merge then failed: ${why(m)}` : ""}`;
  }
  rmSync(path, { force: true });
  if (m.code !== 0) throw new GateRefusal(`MERGE_FAILED ${pr.id} at ${short(sha)}: ${why(m)}`);
  const off = await deps.run(["gh", "pr", "merge", pr.number, "--repo", pr.repo, "--disable-auto"]);
  throw new GateRefusal(`MERGE_REFUSED ${pr.id} GitHub queued the merge instead of merging it (${after.state}); ${off.code === 0 ? "auto-merge was turned off again" : `turning auto-merge off failed: ${why(off)}; turn it off by hand`}. dori merge only merges at once, at the reviewed head`);
};

// claim-done: a lane's done signal "merged <repo>#N" for a repo in mergeGate.repos (repo -> since time), merged at or
// after that time, needs the merge receipt dori merge wrote at the PR's final head. A PR merged with plain gh has none.
// PRs merged before the time stay as they were, so lanes that merged before the gate was turned on are not caught.
// claim-done and the close (closeLane, after the signals read back live) both ask: a lane that claims before its PR is
// merged and then merges it with plain gh is caught at the close. A PR that cannot be read is MERGE_GATE_UNREADABLE.
export const gateMissing = async (deps: Pick<FlowDeps, "run" | "config">, done: string): Promise<string[]> => {
  const repos = deps.config.mergeGate.repos;
  if (!Object.keys(repos).length) return [];
  const missing: string[] = [];
  for (const part of splitDone(done)) {
    let sig: ReturnType<typeof parseSignal>;
    try {
      sig = parseSignal(part);
    } catch {
      continue;
    }
    if (sig.kind !== "merged") continue;
    const since = Object.entries(repos).find(([r]) => r.toLowerCase() === sig.repo.toLowerCase())?.[1];
    if (!since) continue;
    const pr = parsePr(`${sig.repo}#${sig.n}`);
    let v: View;
    try {
      v = await viewPr(deps, pr);
    } catch (e) {
      missing.push(`MERGE_GATE_UNREADABLE ${pr.id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (v.state !== "MERGED" || !v.mergedAt || Date.parse(v.mergedAt) < Date.parse(since)) continue;
    // only a merge read back as done counts: GitHub cannot tell a dori merge from a plain one by the same account, so an
    // attempt whose outcome was never read back (MERGE_UNCONFIRMED) is left to the lead (dori done-set), never guessed
    if (await readReceipt(deps.config.stateDir, pr, v.headRefOid, "merge")) continue;
    missing.push(`MERGE_GATE_MISSING ${pr.id}: merged at ${v.mergedAt} without dori merge (no merge receipt at its head ${short(v.headRefOid)}); ${sig.repo} PRs merge only through dori review then dori merge. Tell the lead; the merged commit had no review receipt at its head.`);
  }
  return missing;
};

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { checkReviewers, familyOf, reviewers } from "./challenge.ts";
import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { parseSignal, splitDone } from "./done-signals.ts";
import type { Lane } from "./registry.ts";
import { exitNote, keepReviewerOutput } from "./reviewer-output.ts";
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
  // tests: the commit checks' lines, and the --no-test reason that let a fix without a test through
  readonly checks?: readonly string[];
  readonly waiver?: string;
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

// The commit checks dori review runs before the tests: dori-superagent PR #44 (dori verify-pr,
// https://github.com/sisyphuslabs/dori-superagent/pull/44) checked commit identities and fix-without-test as a command of
// its own; here they are part of dori review, so a lane learns no new command. Its issue #57
// (https://github.com/sisyphuslabs/dori-superagent/issues/57) items 1-3 are in: fix commits match without case, a test
// changed by no line (a pure rename) does not count, and a file under test/ or tests/ is a test only when named as one, so
// code there counts as source (item 3, the narrower rule). Item 4 (a footer listing identities) has no counterpart here.
// The commit list comes from GitHub (the PR's own commits), each commit's names, emails and files from git in the checkout.
export type Identity = { readonly name: string; readonly email: string };
export type PrFile = { readonly path: string; readonly oldPath?: string; readonly lines: number };
export type PrCommit = { readonly sha: string; readonly subject: string; readonly author: Identity; readonly committer: Identity; readonly parents: number; readonly files: readonly PrFile[] };

const CODE = String.raw`\.(?:[cm]?[jt]sx?|py|go|rs|rb|sh|java|kt|swift)$`;
// fixture, helper, fake and mock directories never hold counted tests (from #44)
export const isTestPath = (path: string): boolean =>
  !/(?:^|\/)(?:fixtures?|__fixtures__|__snapshots__|helpers?|fakes?|mocks?)\//i.test(path)
  && (new RegExp(String.raw`(?:^|/)[^/]+\.(?:test|spec)${CODE}`, "i").test(path)
    || /(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.(?:go|py|rb)|[^/]+_spec\.rb|[^/]+\.bats)$/i.test(path)
    || /(?:^|\/)[^/]+Tests?\.(?:java|kt|swift)$/.test(path)
    || new RegExp(String.raw`(?:^|/)__tests__/.+${CODE}`, "i").test(path)
    || /(?:^|\/)tests\/[^/]+\.rs$/.test(path));

export const isSourcePath = (path: string): boolean =>
  !isTestPath(path) && !/(?:^|\/)(?:docs?|fixtures?|__fixtures__|__snapshots__)\//i.test(path)
  && /\.(?:[cm]?[jt]sx?|css|scss|sass|less|html|vue|svelte|py|go|rs|rb|sh|sql|c|cpp|h|java|kt|swift)$/i.test(path);

const FIX = /^fix(?:\([^)]*\))?!?:/i;
const NOREPLY = "noreply@github.com";
// a mail address is personal: refusals and logs show only its first letters
export const maskEmail = (email: string): string => email.replace(/^(.{0,2})[^@]*@(.{0,2}).*$/, "$1***@$2***");

export type CheckResult = { readonly problems: readonly string[]; readonly lines: readonly string[]; readonly waiver?: string };

export const checkCommits = (repo: string, commits: readonly PrCommit[], o: { readonly atHead: ReadonlySet<string>; readonly executables?: ReadonlySet<string>; readonly identity?: Identity; readonly noTest?: string }): CheckResult => {
  const problems: string[] = [];
  const lines: string[] = [];
  const want = o.identity;
  let identity = "skipped";
  if (!want) lines.push(`IDENTITY_SKIP ${repo} has no mergeGate.identities entry; commit names and emails are not checked`);
  else if (typeof want.name !== "string" || !want.name.trim() || typeof want.email !== "string" || !want.email.trim()) problems.push(`mergeGate.identities["${repo}"] needs a nonempty name and email`);
  else {
    identity = `ok(${commits.length})`;
    // one reason per role and address, with the commits it covers: a PR of 16 commits by one other address is one line
    const wrong = new Map<string, string[]>();
    const add = (reason: string, c: PrCommit) => wrong.set(reason, [...(wrong.get(reason) ?? []), short(c.sha)]);
    for (const c of commits) {
      for (const role of ["author", "committer"] as const) {
        const got = c[role];
        // GitHub commits a merge it makes (Update branch) as itself
        if (role === "committer" && c.parents > 1 && got.email.toLowerCase() === NOREPLY) continue;
        if (got.email.toLowerCase() !== want.email.trim().toLowerCase() || got.email.toLowerCase() === NOREPLY) add(`${role} email ${maskEmail(got.email)}`, c);
        else if (got.name.trim() !== want.name.trim()) add(`${role} name`, c);
      }
    }
    for (const [reason, shas] of wrong) problems.push(`${reason} (${shas.length === 1 ? `commit ${shas[0]}` : `${shas.length} commits: ${shas.slice(0, 3).join(", ")}${shas.length > 3 ? ", ..." : ""}`}) is not the one set for ${repo} in mergeGate.identities${reason.includes("email") ? ` (${maskEmail(want.email)})` : ""}`);
  }
  // a merge commit's files came from the base branch, not from this PR
  const own = commits.filter((c) => c.parents <= 1);
  // an extensionless script that is executable at the head (setups/discord-aoe/dori-file-relay) is source too
  const source = (p: string): boolean => isSourcePath(p) || (o.executables?.has(p) === true && !isTestPath(p));
  const fixes = own.filter((c) => FIX.test(c.subject) && c.files.some((f) => source(f.path) || (f.oldPath !== undefined && source(f.oldPath))));
  // where a test changed in commit i is at the head: later commits may rename it with no changed line
  const finalPath = (i: number, path: string): string => own.slice(i + 1).reduce((p, c) => c.files.find((f) => f.oldPath === p)?.path ?? p, path);
  const counted = (i: number, f: PrFile): string | undefined => {
    const at = finalPath(i, f.path);
    return isTestPath(f.path) && f.lines > 0 && isTestPath(at) && o.atHead.has(at) ? at : undefined;
  };
  const testsOf = (c: PrCommit): string[] => c.files.flatMap((f) => counted(own.indexOf(c), f) ?? []);
  const tests = [...new Set(own.flatMap(testsOf))];
  let fixTest = "no-fix";
  let waiver: string | undefined;
  if (fixes.length && !tests.length) {
    const shas = fixes.map((c) => short(c.sha)).join(", ");
    if (o.noTest) {
      fixTest = "waived";
      waiver = o.noTest;
      lines.push(`FIXTEST_WAIVED fix commit ${shas} has no test; --no-test: ${o.noTest} (kept in the tests receipt)`);
    } else problems.push(`fix commit ${shas} changes source and no commit of the PR adds or changes a test (a test file renamed with no changed line, or deleted at the head, does not count); add a test, or pass --no-test "<reason>" when the fix cannot have one`);
  } else if (fixes.length) {
    fixTest = "tested";
    for (const c of fixes) if (!testsOf(c).length) lines.push(`FIXTEST_NOTE fix commit ${short(c.sha)} has no test of its own; another commit of the PR changes ${tests.join(", ")}`);
  }
  return { problems, lines: [...lines, ...(problems.length ? [] : [`CHECKS_OK {pr} identity=${identity} fix-test=${fixTest}`])], ...(waiver ? { waiver } : {}) };
};

// git show --numstat -z: "added\tdeleted\tpath\0", a rename "added\tdeleted\t\0old\0new\0"; a binary file shows - for both
const parseNumstat = (out: string): PrFile[] => {
  const parts = out.split("\0");
  const files: PrFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^\s*(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i] ?? "");
    if (!m) continue;
    const lines = m[1] === "-" ? 1 : Number(m[1]) + Number(m[2]);
    if (m[3]) files.push({ path: m[3], lines });
    else {
      files.push({ path: parts[i + 2] ?? "", oldPath: parts[i + 1] ?? "", lines });
      i += 2;
    }
  }
  return files;
};

export const readPrCommits = async (deps: Pick<FlowDeps, "run">, pr: PrRef, root: string, head: string): Promise<{ commits: PrCommit[]; atHead: Set<string>; executables: Set<string> }> => {
  const list = await deps.run(["gh", "api", "--paginate", `repos/${pr.repo}/pulls/${pr.number}/commits?per_page=100`, "--jq", ".[].sha"]);
  if (list.code !== 0) throw new GateRefusal(`REVIEW_REFUSED cannot read the commits of ${pr.id}: ${why(list)}`);
  const shas = list.out.split("\n").map((s) => s.trim()).filter(Boolean);
  // GitHub lists at most 250 commits; a list cut short does not end at the head
  if (!shas.length || !shas.every((s) => /^[0-9a-f]{40}$/.test(s)) || shas.at(-1) !== head) throw new GateRefusal(`REVIEW_REFUSED the commit list GitHub gave for ${pr.id} does not end at its head ${short(head)} (${shas.length} commits); the commit checks cannot read every commit`);
  const commits: PrCommit[] = [];
  for (const s of shas) {
    const meta = await deps.run(["git", "-C", root, "log", "-1", "--format=%an%x00%ae%x00%cn%x00%ce%x00%P%x00%s", s]);
    const f = meta.out.replace(/\n$/, "").split("\0");
    if (meta.code !== 0 || f.length !== 6) throw new GateRefusal(`REVIEW_REFUSED commit ${short(s)} of ${pr.id} cannot be read in ${root}: ${why(meta)}`);
    const [an = "", ae = "", cn = "", ce = "", parents = "", subject = ""] = f;
    const n = parents.split(" ").filter(Boolean).length;
    let files: PrFile[] = [];
    if (n <= 1) {
      const stat = await deps.run(["git", "-C", root, "show", "--numstat", "-z", "-M", "--format=", s]);
      if (stat.code !== 0) throw new GateRefusal(`REVIEW_REFUSED cannot read the files of commit ${short(s)} of ${pr.id}: ${why(stat)}`);
      files = parseNumstat(stat.out);
    }
    commits.push({ sha: s, subject, author: { name: an, email: ae }, committer: { name: cn, email: ce }, parents: n, files });
  }
  const tree = await deps.run(["git", "-C", root, "ls-tree", "-r", "-z", head]);
  if (tree.code !== 0) throw new GateRefusal(`REVIEW_REFUSED cannot list the files at ${short(head)} in ${root}: ${why(tree)}`);
  // "<mode> <type> <object>\t<path>"
  const entries = tree.out.split("\0").filter(Boolean).map((e) => ({ mode: e.slice(0, e.indexOf(" ")), path: e.slice(e.indexOf("\t") + 1) }));
  return { commits, atHead: new Set(entries.map((e) => e.path)), executables: new Set(entries.filter((e) => e.mode === "100755").map((e) => e.path)) };
};

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

export type ReviewOptions = { readonly dir: string; readonly model?: string; readonly lane?: Lane | null; readonly noTest?: string };

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
  // a new run at this head replaces the old result: a pass from before must not outlive a failure now (of the checks too)
  rmSync(receiptPath(deps.config.stateDir, pr, sha, "tests"), { force: true });
  const read = await readPrCommits(deps, pr, root, sha);
  const identity = Object.entries(cfg.identities ?? {}).find(([r]) => r.toLowerCase() === pr.repo.toLowerCase())?.[1];
  const checked = checkCommits(pr.repo, read.commits, { atHead: read.atHead, executables: read.executables, ...(identity ? { identity } : {}), ...(opts.noTest ? { noTest: opts.noTest } : {}) });
  if (checked.problems.length) throw new GateRefusal(`REVIEW_CHECKS_FAILED ${pr.id} head=${short(sha)}: ${checked.problems.join("; ")}; no receipt, no tests run`);
  const checks = checked.lines.map((l) => l.replace("{pr}", `${pr.id} head=${sha}`));
  lines.push(...checks);
  log(`CHECKS ${pr.id} head=${sha} ${checks.at(-1)?.replace(/^CHECKS_OK \S+ head=\S+ /, "") ?? ""}${checked.waiver ? " (waived with --no-test)" : ""}`);
  const started = deps.clock.now();
  const t = await deps.run(cfg.testCommand, { cwd: testDir, timeoutMs: cfg.testMinutes * 60_000 });
  if (t.code !== 0) throw new GateRefusal(`REVIEW_TESTS_FAILED ${pr.id} head=${short(sha)}: ${cfg.testCommand.join(" ")} in ${testDir} exited ${t.code}; no receipt\n${tailOf(t).slice(-600)}`);
  await still("after the tests");
  const path = await writeReceipt(deps.config.stateDir, pr, { pr: pr.id, sha, kind: "tests", at: iso(deps.clock), command: cfg.testCommand, code: t.code, tail: tailOf(t), checks, ...(checked.waiver ? { waiver: checked.waiver } : {}) });
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
      failures.push(`${c.call}: ${r.code !== 0 ? exitNote(r) : "no VERDICT line"}; ${keepReviewerOutput(deps.config.stateDir, `review-${stem(pr)}@${short(sha)}`, r.out)}`);
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

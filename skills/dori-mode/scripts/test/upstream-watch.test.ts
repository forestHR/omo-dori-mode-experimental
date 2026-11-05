import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../setups/discord-aoe/upstream-watch.py");
const UP = "https://github.com/sisyphuslabs/dori-superagent";
let root = "";
let src = "";
let gh = "";
let ourRoot = "";

const sh = (cmd: string[], cwd: string) => {
  const p = Bun.spawnSync(cmd, { cwd, env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1" } });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
};
const json = (name: string, value: unknown) => writeFileSync(join(gh, name), JSON.stringify(value));

// Our checkout: its history starts at one commit and its code cites upstream #7's commit and issue #22, and our fork's own
// PR #30, which shares an old repository name with upstream.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dori-upstream-watch-"));
  src = join(root, "src");
  gh = join(root, "gh");
  mkdirSync(src);
  mkdirSync(gh);
  sh(["git", "init", "-q"], src);
  writeFileSync(join(src, "cite.ts"), `// ${UP}/commit/40034ad1a557b92a34aa1450565adcafd3352c96\n// ${UP}/issues/22\n// ${UP}/pull/47\n// https://github.com/orientpine/omo-dori-mode-experimental/pull/30\n`);
  sh(["git", "add", "."], src);
  sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "root"], src);
  ourRoot = sh(["git", "rev-parse", "HEAD"], src);

  // a PR's files as GitHub's pulls/N/files lists them, with the patch of the given ones
  const patches: Record<string, string> = {
    "src/telemetry.ts": "@@ -0,0 +1 @@\n+  const res = await fetch(url);",
    "skills/dori-mode/scripts/src/cli.ts": "@@ -0,0 +1 @@\n+// see https://github.com/x/y",
  };
  const pr = (number: number, title: string, paths: string[], extra: object = {}) => {
    json(`files-${number}.json`, paths.map((filename) => ({ filename, patch: patches[filename] ?? null })));
    return { number, title, url: `${UP}/pull/${number}`, mergedAt: "2026-11-02T00:00:00Z", mergeCommit: { oid: `${number}`.padStart(40, "c") }, body: "", ...extra };
  };
  json("prs.json", [
    pr(7, "fix(dori-mode): decide pane state", ["skills/dori-mode/scripts/src/dead-panes.ts"], { mergeCommit: { oid: "40034ad1a557b92a34aa1450565adcafd3352c96" } }),
    pr(16, "feat: dori superharness on herdr + omo", ["src/herdr.ts", "README.md"]),
    pr(17, "docs(readme): avatar", ["README.md"]),
    pr(21, "feat(telemetry): anonymous usage counts", ["src/telemetry.ts", "README.md"], { body: "Closes #27" }),
    pr(23, "feat(loop): hourly loop that keeps picking up the next backlog item", ["src/loop.ts"]),
    pr(25, "fix(dori-mode): skip report templates", ["skills/dori-mode/scripts/src/freshness.ts"], { body: "Fixes #22" }),
    pr(30, "fix(dori-mode): keep reports in reports.jsonl", ["skills/dori-mode/scripts/src/cli.ts"]),
    // more files than one page and than gh pr list shows (100); the skills/ change is the 101st
    // merged, but into a branch other than upstream main: not in main, so not a candidate
    pr(44, "fix(dori-mode): lane sweep on the next branch", ["skills/dori-mode/scripts/src/sweeps.ts"], { baseRefName: "next" }),
    // proposals: open, and closed without a merge
    pr(45, "fix(dori-mode): retry a lost send", ["skills/dori-mode/scripts/src/send.ts"], { state: "OPEN", mergedAt: null, mergeCommit: null }),
    pr(46, "fix(dori-mode): an abandoned idea", ["skills/dori-mode/scripts/src/x.ts"], { state: "CLOSED", mergedAt: null, mergeCommit: null }),
    // merged outside main, and our code already cites it: already here, not an integration ask
    pr(47, "fix(dori-mode): a fix we took from the next branch", ["skills/dori-mode/scripts/src/y.ts"], { baseRefName: "next" }),
    pr(40, "fix: rename the docs pages", [...Array.from({ length: 100 }, (_, i) => `docs/page-${String(i).padStart(3, "0")}.md`), "skills/dori-mode/zz-late.ts"]),
  ]);
  const issue = (number: number, title: string, state = "OPEN") => ({ number, title, state, url: `${UP}/issues/${number}`, createdAt: "2026-11-02T00:00:00Z" });
  json("issues.json", [issue(22, "freshness: lastReportLine selects templates", "CLOSED"), issue(27, "Telemetry", "CLOSED"), issue(29, "freshness: other report-template shapes"), issue(31, "dori send fails for agents launched with pane run"), issue(33, "an idea closed without code", "CLOSED")]);
  const commit = (sha: string, message: string) => ({ sha, commit: { message }, html_url: `${UP}/commit/${sha}` });
  writeFileSync(join(gh, "commits.jsonl"), [
    commit("b".repeat(40), "direct: fix the lane sweep"),
    commit("c".repeat(39) + "1", "fix(dori-mode): skip report templates (#25)"),
    commit(ourRoot, "root"),
    commit("a".repeat(40), "a commit older than our history"),
  ].map((c) => JSON.stringify(c)).join("\n"));
  json(`commit-${"b".repeat(40)}.json`, [{ filename: "skills/dori-mode/scripts/src/sweeps.ts", patch: "+x" }]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = async (args: string[] = [], extra: Record<string, string> = {}) => {
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: root,
    UPSTREAM_WATCH_STATE_DIR: join(root, "state"),
    UPSTREAM_WATCH_INBOX: join(root, "inbox.jsonl"),
    UPSTREAM_WATCH_SRC: src,
    UPSTREAM_WATCH_REPO: "sisyphuslabs/dori-superagent",
    UPSTREAM_WATCH_GH_DIR: gh,
    ...extra,
  };
  const p = Bun.spawn(["/usr/bin/python3", "-I", SCRIPT, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};
const inbox = (): Record<string, string>[] => {
  const path = join(root, "inbox.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const seen = () => JSON.parse(readFileSync(join(root, "state/seen.json"), "utf8")).items as Record<string, { class: string }>;

test("ports (in upstream main) and integration asks (open issues, PRs outside main) reach the inbox; what we already have or do not use goes to one weekly line", async () => {
  const r = await run([], { UPSTREAM_WATCH_THREAD: "discord:42" });
  expect(r.code).toBe(0);
  const rows = inbox();
  expect(rows.filter((x) => x.kind === "upstream-change").every((x) => x.thread === "discord:42" && x.content!.includes("dori launch --thread discord:42"))).toBe(true);
  expect(rows.filter((x) => x.kind === "upstream-change").map((x) => [x.item, x.class])).toEqual([
    // upstream's first root harness on herdr, titled so: in main the files decide, and they are root-only
    ["pr:16", "4"],
    ["pr:23", "4"],
    ["pr:30", "4"],
    ["pr:40", "4"],
    ["pr-proposed:44", "3"],
    ["pr-proposed:45", "3"],
    ["issue:29", "3"],
    [`commit:${"b".repeat(40)}`, "4"],
  ]);
  const classes = Object.fromEntries(Object.entries(seen()).map(([k, v]) => [k, v.class]));
  expect(classes).toMatchObject({ "pr:7": "1", "pr:25": "1", "issue:22": "1", [`commit:${ourRoot}`]: "1", [`commit:${"a".repeat(40)}`]: "1", "pr:17": "2", "issue:27": "2", "issue:31": "2", "pr:21": "2", "pr-proposed:46": "2", "pr-proposed:47": "1" });
  // not in upstream main: the merged-elsewhere PR is no pr:N item, so its later merge into main is a new one
  expect(seen()["pr:44"]).toBeUndefined();
  const weekly = rows.filter((x) => x.kind === "upstream-weekly");
  expect(weekly).toHaveLength(1);
  expect(weekly[0]!.thread).toBe("discord:42");
  expect(weekly[0]!.content).toContain("① 이미 있음 6건");
  expect(r.out).toContain("inbox_lines=8 weekly=True");
});

test("a second run and a seeded run write nothing more", async () => {
  await run();
  const before = inbox().length;
  expect((await run()).out).toContain("new=0 inbox_lines=0 weekly=False");
  expect(inbox()).toHaveLength(before);
  rmSync(join(root, "state"), { recursive: true });
  rmSync(join(root, "inbox.jsonl"));
  expect((await run(["--seed"])).out).toContain("new=20 inbox_lines=0");
  expect(inbox()).toHaveLength(0);
  expect((await run()).out).toContain("new=0 inbox_lines=0");
});

test("an item is recorded only after its inbox line is written, so a failed append is retried next hour", async () => {
  mkdirSync(join(root, "inbox.jsonl"));
  const failed = await run();
  expect(failed.code).not.toBe(0);
  expect(existsSync(join(root, "state/seen.json")) ? Object.keys(seen()).filter((k) => ["pr:30", "pr:40", "pr-proposed:45", "issue:29"].includes(k)) : []).toEqual([]);
  rmSync(join(root, "inbox.jsonl"), { recursive: true });
  expect((await run()).code).toBe(0);
  expect(inbox().filter((x) => x.kind === "upstream-change").map((x) => x.item)).toContain("pr:30");
});

test("a failing gh records nothing and exits 3; the third failure in a row tells the lead once", async () => {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 'HTTP 502' >&2\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);
  const fail = () => run([], { UPSTREAM_WATCH_GH_DIR: "", PATH: `${bin}:/usr/bin:/bin` });
  for (let i = 1; i <= 4; i++) {
    const r = await fail();
    expect(r.code).toBe(3);
    expect(r.err).toContain(`UPSTREAM-WATCH-FAIL GhError`);
  }
  expect(seen()).toEqual({});
  expect(inbox().map((x) => x.kind)).toEqual(["upstream-watch-fail"]);
  expect((await run()).code).toBe(0);
});

test("a PR closed without a merge and reopened later is an integration ask then; a hand decision stays decided", async () => {
  await run();
  expect(seen()["pr-proposed:46"]!.class).toBe("2");
  const prs = JSON.parse(readFileSync(join(gh, "prs.json"), "utf8")) as { number: number; state?: string }[];
  for (const p of prs) if (p.number === 46 || p.number === 45) p.state = "CLOSED";
  json("prs.json", prs);
  await run();
  await run(["--mark", "pr-proposed:46", "--why", "owner: leave it"]);
  for (const p of prs) if (p.number === 46 || p.number === 45) p.state = "OPEN";
  json("prs.json", prs);
  const before = inbox().length;
  await run();
  // #45 was open, then closed, then open again: asked once more; #46 the owner decided by hand: not again
  expect(inbox().slice(before).filter((x) => x.kind === "upstream-change").map((x) => [x.item, x.class])).toEqual([["pr-proposed:45", "3"]]);
  expect(seen()["pr-proposed:46"]!.class).toBe("decided");
});

test("a PR closed without a merge and merged into another branch later is an integration ask then", async () => {
  await run();
  expect(seen()["pr-proposed:46"]!.class).toBe("2");
  const prs = JSON.parse(readFileSync(join(gh, "prs.json"), "utf8")) as Record<string, unknown>[];
  for (const p of prs) if (p.number === 46) Object.assign(p, { state: "MERGED", mergedAt: "2026-11-03T00:00:00Z", baseRefName: "next", mergeCommit: { oid: "4".repeat(39) + "6" } });
  json("prs.json", prs);
  const before = inbox().length;
  await run();
  expect(inbox().slice(before).filter((x) => x.kind === "upstream-change").map((x) => [x.item, x.class])).toEqual([["pr-proposed:46", "3"]]);
});

test("a record the old watcher wrote has no lifecycle: the upgraded watcher fills it in, so a closed issue opened again is read again", async () => {
  await run();
  const path = join(root, "state/seen.json");
  const old = JSON.parse(readFileSync(path, "utf8"));
  for (const r of Object.values(old.items) as Record<string, unknown>[]) { delete r.open; delete r.status; }
  writeFileSync(path, JSON.stringify(old));
  expect((await run()).out).toContain("new=0 inbox_lines=0");
  const issues = JSON.parse(readFileSync(join(gh, "issues.json"), "utf8")) as Record<string, unknown>[];
  for (const i of issues) if (i.number === 33) i.state = "OPEN";
  json("issues.json", issues);
  const before = inbox().length;
  await run();
  expect(inbox().slice(before).filter((x) => x.kind === "upstream-change").map((x) => [x.item, x.class])).toEqual([["issue:33", "3"]]);
});

test("a closed issue the old watcher recorded and that opened again before the upgrade is asked once", async () => {
  // the old watcher's record: class 2, no lifecycle fields
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state/seen.json"), JSON.stringify({ items: { "issue:33": { class: "2", why: "코드 없이 닫힘", at: "2026-11-01T00:00:00.000Z" } }, minor: [], fails: 0 }));
  const issues = JSON.parse(readFileSync(join(gh, "issues.json"), "utf8")) as Record<string, unknown>[];
  for (const i of issues) if (i.number === 33) i.state = "OPEN";
  json("issues.json", issues);
  await run();
  await run();
  expect(inbox().filter((x) => x.kind === "upstream-change" && x.item === "issue:33").map((x) => x.class)).toEqual(["3"]);
});

test("an open issue the old watcher already sent as class 4 is not asked again", async () => {
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state/seen.json"), JSON.stringify({ items: { "issue:29": { class: "4", why: "열린 이슈, 우리 쪽 재현 먼저", at: "2026-11-01T00:00:00.000Z" } }, minor: [], fails: 0 }));
  await run();
  expect(inbox().filter((x) => x.kind === "upstream-change").map((x) => x.item)).not.toContain("issue:29");
});

test("an open issue first read as the herdr harness and retitled to our code is asked then", async () => {
  await run();
  expect(seen()["issue:31"]!.class).toBe("2");
  const issues = JSON.parse(readFileSync(join(gh, "issues.json"), "utf8")) as Record<string, unknown>[];
  for (const i of issues) if (i.number === 31) i.title = "dori send fails for agents started by dori launch";
  json("issues.json", issues);
  const before = inbox().length;
  await run();
  await run();
  expect(inbox().slice(before).filter((x) => x.kind === "upstream-change").map((x) => [x.item, x.class])).toEqual([["issue:31", "3"]]);
});

test("right after --seed, a closed PR or issue that opens or merges into another branch is asked; what was open at the seed is not", async () => {
  expect((await run(["--seed"])).code).toBe(0);
  const prs = JSON.parse(readFileSync(join(gh, "prs.json"), "utf8")) as Record<string, unknown>[];
  for (const p of prs) if (p.number === 46) Object.assign(p, { state: "MERGED", mergedAt: "2026-11-03T00:00:00Z", baseRefName: "next", mergeCommit: { oid: "4".repeat(39) + "6" } });
  json("prs.json", prs);
  const issues = JSON.parse(readFileSync(join(gh, "issues.json"), "utf8")) as Record<string, unknown>[];
  for (const i of issues) if (i.number === 33) i.state = "OPEN";
  json("issues.json", issues);
  await run();
  await run();
  expect(inbox().filter((x) => x.kind === "upstream-change").map((x) => x.item).sort()).toEqual(["issue:33", "pr-proposed:46"]);
});

test("a PR merged outside main that the old watcher recorded as pr:N is classified again and asked once when it is class 3 now", async () => {
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state/seen.json"), JSON.stringify({ items: { "pr:44": { class: "2", why: "herdr 하네스", at: "2026-11-01T00:00:00.000Z" } }, minor: [], fails: 0 }));
  await run();
  await run();
  const items = inbox().filter((x) => x.kind === "upstream-change").map((x) => x.item);
  expect(items.filter((i) => i === "pr-proposed:44")).toHaveLength(1);
});

test("an issue a merged PR closed and that opened again is asked", async () => {
  await run();
  expect(seen()["issue:27"]!.class).toBe("2");
  const issues = JSON.parse(readFileSync(join(gh, "issues.json"), "utf8")) as Record<string, unknown>[];
  for (const i of issues) if (i.number === 27) Object.assign(i, { state: "OPEN", title: "anonymous usage counts come back after the fix" });
  json("issues.json", issues);
  const before = inbox().length;
  await run();
  expect(inbox().slice(before).filter((x) => x.kind === "upstream-change").map((x) => [x.item, x.class])).toEqual([["issue:27", "3"]]);
});

test("an item the owner already decided is marked by hand and never reaches the inbox", async () => {
  expect((await run(["--mark", "pr:30", "--why", "owner chose; lane backlog-loop"])).out).toContain("UPSTREAM_MARKED pr:30");
  expect((await run(["--mark", "pr-proposed:45"])).out).toContain("UPSTREAM_MARKED pr-proposed:45");
  // a merged PR the watch saw as pr:N before proposals had their own key is not sent again as pr-proposed:N
  expect((await run(["--mark", "pr:44", "--why", "seen before the upgrade"])).code).toBe(0);
  expect((await run(["--mark", "23"])).code).not.toBe(0);
  await run();
  const items = inbox().filter((x) => x.kind === "upstream-change").map((x) => x.item);
  expect(items).toContain("pr:40");
  expect(items).not.toContain("pr:30");
  expect(items).not.toContain("pr-proposed:45");
  expect(items).not.toContain("pr-proposed:44");
  expect(seen()["pr:30"]!.class).toBe("decided");
});

test("without an inbox setting the line goes to the listener's inbox under DORI_STATE_DIR", async () => {
  const state = join(root, "dori-state");
  mkdirSync(join(state, "discord"), { recursive: true });
  const env = { UPSTREAM_WATCH_INBOX: "", UPSTREAM_WATCH_STATE_DIR: "", DORI_STATE_DIR: state };
  expect((await run([], env)).code).toBe(0);
  expect(readFileSync(join(state, "discord/inbox.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).item)).toContain("pr:30");
  expect(existsSync(join(state, "upstream-watch/seen.json"))).toBe(true);
  expect(existsSync(join(root, "inbox.jsonl"))).toBe(false);
});

test("lists longer than one page are read in full, and a commit of a PR the watch has not seen is still classified", async () => {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const prs = Array.from({ length: 150 }, (_, i) => ({
    number: i + 1, title: `fix(dori-mode): case ${i + 1}`, url: `${UP}/pull/${i + 1}`, mergedAt: "2026-11-02T00:00:00Z",
    files: [{ path: "skills/dori-mode/scripts/src/cli.ts" }], mergeCommit: { oid: `${i + 1}`.padStart(40, "d") }, body: "",
  }));
  const commits = [
    ...Array.from({ length: 120 }, (_, i) => ({ sha: `${i + 1}`.padStart(40, "e"), commit: { message: `fix: case (#${i + 1})` } })),
    { sha: "f".repeat(40), commit: { message: "fix: a PR this watch never listed (#999)" } },
    { sha: "9".repeat(40), commit: { message: "fix: squashed without a PR number" } },
  ];
  writeFileSync(join(root, "prs.json"), JSON.stringify(prs));
  writeFileSync(join(root, "commits.jsonl"), commits.map((c) => JSON.stringify(c)).join("\n"));
  // gh stand-in: lists stop at --limit like gh does, and the commits feed needs --paginate. The watch calls it once per
  // PR (about 155 times here), so it is /bin/sh, not Python: a Python start per call made this test miss its 5 s limit
  // on a busy PC. Only the one pr list call, which has to cut the JSON list at --limit, starts Python.
  writeFileSync(join(root, "pr-list.py"), `import json, sys
a = sys.argv[1:]
print(json.dumps(json.load(open("${join(root, "prs.json")}"))[: int(a[a.index("--limit") + 1])]))
`);
  writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$1 $2" in
"pr list") exec /usr/bin/python3 -I "${join(root, "pr-list.py")}" "$@" ;;
"issue list") echo '[]' ;;
"api --paginate")
  case "$3" in
  */pulls/*) echo '{"filename": "skills/dori-mode/scripts/src/cli.ts", "patch": "+x"}' ;;
  # a commit's files come 300 per page; the skills/ change is on the second page
  */commits/*) echo '{"filename": "docs/a.md", "patch": "+a"}'; echo '{"filename": "skills/dori-mode/scripts/src/sweeps.ts", "patch": "+x"}' ;;
  *) cat "${join(root, "commits.jsonl")}" ;;
  esac ;;
"api "*)
  case "$2" in
  *${"f".repeat(40)}*/pulls) echo '[{"number": 999, "merged_at": "2026-11-02T00:00:00Z"}]' ;;
  */pulls) echo '[{"number": 5, "merged_at": "2026-11-02T00:00:00Z"}]' ;;
  */commits/*) echo '{"filename": "docs/a.md", "patch": "+a"}' ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
  esac ;;
*) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(bin, "gh"), 0o755);
  const r = await run([], { UPSTREAM_WATCH_GH_DIR: "", PATH: `${bin}:/usr/bin:/bin` });
  expect(r.code).toBe(0);
  const items = inbox().filter((x) => x.kind === "upstream-change").map((x) => x.item ?? "");
  // pr:22 and pr:47 are class 1: our checkout cites upstream issue #22 and pull #47, and GitHub numbers PRs and issues together.
  expect(items.filter((i) => i.startsWith("pr:"))).toHaveLength(148);
  expect(items).not.toContain("pr:22");
  expect(items).not.toContain("pr:47");
  expect(items).toContain(`commit:${"f".repeat(40)}`);
  expect(items.filter((i) => i.startsWith("commit:"))).toHaveLength(1);
  expect(seen()[`commit:${"9".repeat(40)}`]!.class).toBe("2");
});

test("a list that reaches its limit records nothing and tells the lead on that run, once", async () => {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/usr/bin/python3
import json, sys
a = sys.argv[1:]
if a[:2] == ["pr", "list"]:
    n = int(a[a.index("--limit") + 1])
    print(json.dumps([{"number": i + 1, "title": "t", "url": "u", "files": [], "body": ""} for i in range(n)]))
else:
    print("[]")
`);
  chmodSync(join(bin, "gh"), 0o755);
  const cut = () => run([], { UPSTREAM_WATCH_GH_DIR: "", UPSTREAM_WATCH_THREAD: "discord:42", PATH: `${bin}:/usr/bin:/bin` });
  const first = await cut();
  expect(first.code).toBe(3);
  expect(first.err).toContain("UPSTREAM-WATCH-FAIL Incomplete");
  expect(seen()).toEqual({});
  expect(inbox().map((x) => [x.kind, x.thread])).toEqual([["upstream-watch-fail", "discord:42"]]);
  for (let i = 0; i < 3; i++) expect((await cut()).code).toBe(3);
  expect(inbox()).toHaveLength(1);
});

test("a PR at GitHub's 3000-file cap is still a port, for the lead to check by hand, and the other items still arrive", async () => {
  json("files-30.json", Array.from({ length: 3000 }, (_, i) => ({ filename: `docs/f${i}.md`, patch: null })));
  const r = await run();
  expect(r.code).toBe(0);
  const rows = inbox().filter((x) => x.kind === "upstream-change");
  expect(rows.find((x) => x.item === "pr:30")).toMatchObject({ class: "4" });
  expect(rows.find((x) => x.item === "pr:30")!.reason).toContain("PR #30 lists 3000 files");
  // its files are not known: the lead's check keeps both limits of a root-only change
  expect(rows.find((x) => x.item === "pr:30")!.content).toContain("루트 하네스 파일은 들이지 않는다");
  expect(rows.find((x) => x.item === "pr:30")!.content).toContain("원격 측정은 들이지 않는다");
  expect(rows.map((x) => x.item)).toContain("pr:40");
});

test("in upstream main, outbound code found in a patch and code without a patch are ports with a note for the lane, not owner decisions", async () => {
  json("prs.json", [
    { number: 41, title: "refactor: client cleanup", url: `${UP}/pull/41`, mergedAt: "2026-11-02T00:00:00Z", mergeCommit: { oid: "4".repeat(40) }, body: "" },
    { number: 42, title: "refactor: tidy the store", url: `${UP}/pull/42`, mergedAt: "2026-11-02T00:00:00Z", mergeCommit: { oid: "5".repeat(40) }, body: "" },
    { number: 43, title: "refactor: move a file", url: `${UP}/pull/43`, mergedAt: "2026-11-02T00:00:00Z", mergeCommit: { oid: "6".repeat(40) }, body: "" },
  ]);
  json("files-41.json", [{ filename: "skills/dori-mode/scripts/src/client.ts", patch: "@@ -0,0 +1 @@\n+await post('https://t.omo.dev/v1/logs')", status: "modified", changes: 1 }]);
  json("files-42.json", [{ filename: "skills/dori-mode/scripts/src/store.ts", patch: null, status: "modified", changes: 900 }]);
  json("files-43.json", [{ filename: "src/old.ts", patch: null, status: "removed", changes: 40 }, { filename: "README.md", patch: null, status: "modified", changes: 2 }]);
  json("issues.json", []);
  writeFileSync(join(gh, "commits.jsonl"), "");
  expect((await run()).code).toBe(0);
  const rows = inbox().filter((x) => x.kind === "upstream-change");
  expect(rows.map((x) => [x.item, x.class])).toEqual([["pr:41", "4"], ["pr:42", "4"], ["pr:43", "4"]]);
  expect(rows[0]!.reason).toContain("살필 것: 바깥으로 데이터를 보냄(skills/dori-mode/scripts/src/client.ts에 t.omo.dev)");
  expect(rows[1]!.reason).toContain("살필 것: 내용을 못 읽음(patch 없음: skills/dori-mode/scripts/src/store.ts), 리드가 손으로 확인");
  // a removed root file has no patch to read and is no blind spot
  expect(rows[2]!.reason).not.toContain("못 읽음");
});

test("in upstream main, a change only to the root harness is a same-defect review, never a port of its files; telemetry and docs are not ours (owner Q19)", async () => {
  const main = (number: number, title: string) => ({ number, title, url: `${UP}/pull/${number}`, mergedAt: "2026-11-02T00:00:00Z", mergeCommit: { oid: `${number}`.padStart(40, "8") }, body: "" });
  const files: Record<number, string[]> = {
    60: ["src/harness.ts", "test/harness.test.ts", "prompts/lead.md"],
    61: ["package.json"],
    // telemetry with its wiring: other harness files changed, so reviewed, with telemetry itself never brought in
    62: ["src/telemetry.ts", "src/cli.ts", "test/telemetry.test.ts", "README.md"],
    63: ["src/telemetry.ts"],
    64: ["README.md", "docs/guide.md"],
    65: ["skills/dori-mode/scripts/src/panes.ts", "src/herdr-free.ts"],
    // the title does not decide (usage counts, tracking): the files do
    66: ["src/telemetry.ts", "src/cli.ts"],
    // a harness fix that also touches telemetry: reviewed, with the telemetry part named as not brought in
    67: ["src/harness.ts", "src/telemetry.ts"],
    // a herdr title does not make a main change not ours: the fork runs on herdr too
    68: ["src/herdr.ts", "test/herdr.test.ts"],
    70: ["src/harness.ts", "src/telemetry.ts"],
  };
  json("prs.json", [main(60, "fix(send): keep a failed flush from stopping delivery"), main(61, "chore: bump the version"), main(62, "feat(telemetry): anonymous usage counts"), main(63, "refactor: tidy a module"), main(64, "docs: a guide"), main(65, "fix(send): hold delivery in both stacks"), main(66, "feat: anonymous usage counts like omo"), main(67, "fix(send): keep the duty tick alive"), main(68, "fix(herdr): retry lost sends"), main(70, "fix(send): repair delivery tracking")]);
  for (const [n, paths] of Object.entries(files)) json(`files-${n}.json`, paths.map((filename) => ({ filename, patch: "@@ -0,0 +1 @@\n+x", status: "modified", changes: 1 })));
  json("issues.json", []);
  writeFileSync(join(gh, "commits.jsonl"), JSON.stringify({ sha: "d".repeat(40), commit: { message: "direct: fix the duty tick" }, html_url: `${UP}/commit/${"d".repeat(40)}` }));
  json(`commit-${"d".repeat(40)}.json`, [{ filename: "src/harness.ts", patch: "+x", status: "modified", changes: 1 }]);
  expect((await run()).code).toBe(0);
  const rows = inbox().filter((x) => x.kind === "upstream-change");
  expect(rows.map((x) => [x.item, x.class])).toEqual([["pr:60", "4"], ["pr:61", "4"], ["pr:62", "4"], ["pr:65", "4"], ["pr:66", "4"], ["pr:67", "4"], ["pr:68", "4"], ["pr:70", "4"], [`commit:${"d".repeat(40)}`, "4"]]);
  for (const n of [62, 66, 67, 70]) expect(rows.find((x) => x.item === `pr:${n}`)!.reason).toContain("원격 측정(src/telemetry.ts)도 바뀜, 그 부분은 안 들임(형 Q19)");
  expect(rows.filter((x) => x.item !== "pr:65").every((x) => x.content!.includes("원격 측정은 들이지 않는다"))).toBe(true);
  const root = rows.filter((x) => x.item !== "pr:65");
  expect(root.every((x) => x.reason!.startsWith("루트 하네스") && x.content!.includes("루트 하네스 파일은 들이지 않는다") && !x.content!.includes("이식 레인"))).toBe(true);
  // skills/ changed too: a port of the skills/ part as before, and the root part is not brought in
  expect(rows.find((x) => x.item === "pr:65")!.content).toContain("이식 레인");
  expect(rows.find((x) => x.item === "pr:65")!.reason).toContain("루트 하네스 1파일도 바뀜");
  const items = seen() as Record<string, { class: string; why: string }>;
  expect(Object.fromEntries(["pr:63", "pr:64"].map((k) => [k, [items[k]!.class, items[k]!.why]]))).toEqual({
    "pr:63": ["2", "원격 측정은 안 들임(형 Q19)"],
    "pr:64": ["2", "skills/ 밖만 바뀜(문서)"],
  });
});

test("a root-only main PR the old watcher put aside (class 2, or an old class-3 owner question) is reviewed once; a decided, a docs or a ported one is not", async () => {
  const main = (number: number, title: string) => ({ number, title, url: `${UP}/pull/${number}`, mergedAt: "2026-11-02T00:00:00Z", mergeCommit: { oid: `${number}`.padStart(40, "9") }, body: "" });
  json("prs.json", [main(17, "docs(readme): avatar"), main(21, "feat(telemetry): anonymous usage counts"), main(34, "fix: deliver to omo panes started with pane run"), main(84, "fix(send): wait for the pane"), main(90, "fix(dori-mode): a port we did"), main(63, "fix(send): deliver to an omo herdr calls working"), main(47, "fix(send): a herdr fix our code cites"), main(91, "fix(herdr): hold delivery in both stacks")]);
  const files: Record<number, string[]> = { 17: ["README.md"], 21: ["src/telemetry.ts"], 34: ["src/harness.ts"], 84: ["src/herdr.ts"], 90: ["skills/dori-mode/scripts/src/a.ts"], 63: ["src/herdr.ts"], 47: ["src/herdr.ts"], 91: ["skills/dori-mode/scripts/src/panes.ts", "src/herdr.ts"] };
  for (const [n, paths] of Object.entries(files)) json(`files-${n}.json`, paths.map((filename) => ({ filename, patch: "@@ -0,0 +1 @@\n+x", status: "modified", changes: 1 })));
  json("issues.json", []);
  writeFileSync(join(gh, "commits.jsonl"), "");
  mkdirSync(join(root, "state"));
  const at = "2026-11-01T00:00:00.000Z";
  writeFileSync(join(root, "state/seen.json"), JSON.stringify({ items: {
    "pr:17": { class: "2", why: "skills/ 밖만 바뀜(루트 하네스·문서)", at },
    "pr:21": { class: "decided", why: "형 Q458 안 가져오기", at },
    "pr:34": { class: "3", why: "자율 범위가 바뀜(loop), 이슈 #31, #32 닫음", at },
    "pr:84": { class: "2", why: "skills/ 밖만 바뀜(루트 하네스·문서), 이슈 #56 닫음", at },
    "pr:90": { class: "4", why: "skills/ 1파일 바뀜", at },
    // put aside by its herdr title, files unread: reviewed once like the rest; one our code cites is already here
    "pr:63": { class: "2", why: "herdr 하네스", at },
    "pr:47": { class: "2", why: "herdr 하네스, 이슈 #54 닫음", at },
    // its files were never read: it changes skills/ too, so it is a port now, sent once
    "pr:91": { class: "2", why: "herdr 하네스", at },
  }, minor: [], fails: 0 }));
  expect((await run()).code).toBe(0);
  expect(inbox().filter((x) => x.kind === "upstream-change").map((x) => [x.item, x.class])).toEqual([["pr:34", "4"], ["pr:63", "4"], ["pr:84", "4"], ["pr:91", "4"]]);
  expect(inbox().find((x) => x.item === "pr:91")!.content).toContain("이식 레인");
  expect(seen()["pr:21"]!.class).toBe("decided");
  expect((await run()).out).toContain("inbox_lines=0");
  expect(inbox().filter((x) => x.kind === "upstream-change")).toHaveLength(4);
});

test("a dependency added to a skills package.json is noted for the lane whatever its version spec; version and scripts lines are not", async () => {
  const pkg = "skills/dori-mode/scripts/package.json";
  // a hunk inside the dependencies block, adding one entry with the given spec
  const midBlock = (spec: string) => `@@ -3,6 +3,7 @@\n   "dependencies": {\n     "a": "^1.0.0",\n+    "b": "${spec}",\n     "c": "2.0.0"\n   }`;
  const patches: Record<number, string> = {
    50: `@@ -0,0 +1,10 @@\n+{\n+  "name": "x",\n+  "version": "1.0.0",\n+  "scripts": {\n+    "build": "tsc"\n+  },\n+  "dependencies": {\n+    "left": "latest"\n+  }\n+}`,
    51: midBlock("*"),
    52: midBlock("npm:real@2"),
    53: midBlock("git+https://github.com/x/b.git"),
    54: midBlock("file:../b"),
    55: `@@ -1,6 +1,6 @@\n {\n-  "version": "1.0.0",\n+  "version": "1.1.0",\n   "scripts": {\n-    "build": "tsc"\n+    "build": "tsc -b"\n   }`,
    // hunks that start below the dependencies header: the block cannot be told from the patch, so the owner checks it
    56: `@@ -20,5 +20,6 @@\n     "m": "^1.0.0",\n     "n": "^2.0.0",\n+    "helper": "latest",\n     "o": "^3.0.0"\n   }`,
    57: `@@ -1,3 +1,3 @@\n {\n-  "version": "1.0.0",\n+  "version": "1.1.0",\n@@ -30,4 +30,5 @@\n     "p": "^1.0.0",\n+    "later": "github:x/later",\n     "q": "^2.0.0"`,
  };
  const numbers = Object.keys(patches).map(Number);
  json("prs.json", numbers.map((n) => ({ number: n, title: "chore: package tidy", url: `${UP}/pull/${n}`, mergedAt: "2026-11-02T00:00:00Z", mergeCommit: { oid: `${n}`.padStart(40, "7") }, body: "" })));
  for (const n of numbers) json(`files-${n}.json`, [{ filename: pkg, patch: patches[n], status: "modified", changes: 2 }]);
  json("issues.json", []);
  writeFileSync(join(gh, "commits.jsonl"), "");
  expect((await run()).code).toBe(0);
  const rows = inbox().filter((x) => x.kind === "upstream-change");
  expect(rows.every((x) => x.class === "4")).toBe(true);
  expect(rows.filter((x) => x.reason!.includes("새 의존성")).map((x) => x.item)).toEqual(["pr:50", "pr:51", "pr:52", "pr:53", "pr:54", "pr:56", "pr:57"]);
  expect(rows.find((x) => x.item === "pr:50")!.reason).toContain(`${pkg}에 left`);
  expect(rows.find((x) => x.item === "pr:51")!.reason).toContain(`${pkg}에 b`);
  expect(rows.find((x) => x.item === "pr:56")!.reason).toContain(`${pkg}에 helper, 블록을 패치로 못 가림`);
  expect(rows.find((x) => x.item === "pr:57")!.reason).toContain(`${pkg}에 later, 블록을 패치로 못 가림`);
});

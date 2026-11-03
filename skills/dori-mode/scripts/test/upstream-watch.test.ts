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
  writeFileSync(join(src, "cite.ts"), `// ${UP}/commit/40034ad1a557b92a34aa1450565adcafd3352c96\n// ${UP}/issues/22\n// https://github.com/orientpine/omo-dori-mode-experimental/pull/30\n`);
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
    pr(40, "fix: rename the docs pages", [...Array.from({ length: 100 }, (_, i) => `docs/page-${String(i).padStart(3, "0")}.md`), "skills/dori-mode/zz-late.ts"]),
  ]);
  const issue = (number: number, title: string, state = "OPEN") => ({ number, title, state, url: `${UP}/issues/${number}`, createdAt: "2026-11-02T00:00:00Z" });
  json("issues.json", [issue(22, "freshness: lastReportLine selects templates", "CLOSED"), issue(27, "Telemetry", "CLOSED"), issue(29, "freshness: other report-template shapes"), issue(31, "dori send fails for agents launched with pane run")]);
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

test("only owner decisions and port candidates reach the inbox; what we already have or do not use goes to one weekly line", async () => {
  const r = await run([], { UPSTREAM_WATCH_THREAD: "discord:42" });
  expect(r.code).toBe(0);
  const rows = inbox();
  expect(rows.filter((x) => x.kind === "upstream-change").every((x) => x.thread === "discord:42" && x.content!.includes("dori launch --thread discord:42"))).toBe(true);
  expect(rows.filter((x) => x.kind === "upstream-change").map((x) => [x.item, x.class])).toEqual([
    ["pr:21", "3"],
    ["pr:23", "3"],
    ["pr:30", "4"],
    ["pr:40", "4"],
    ["issue:29", "4"],
    [`commit:${"b".repeat(40)}`, "4"],
  ]);
  const classes = Object.fromEntries(Object.entries(seen()).map(([k, v]) => [k, v.class]));
  expect(classes).toMatchObject({ "pr:7": "1", "pr:25": "1", "issue:22": "1", [`commit:${ourRoot}`]: "1", [`commit:${"a".repeat(40)}`]: "1", "pr:16": "2", "pr:17": "2", "issue:27": "2", "issue:31": "2" });
  const weekly = rows.filter((x) => x.kind === "upstream-weekly");
  expect(weekly).toHaveLength(1);
  expect(weekly[0]!.thread).toBe("discord:42");
  expect(weekly[0]!.content).toContain("① 이미 있음 5건");
  expect(r.out).toContain("inbox_lines=6 weekly=True");
});

test("a second run and a seeded run write nothing more", async () => {
  await run();
  const before = inbox().length;
  expect((await run()).out).toContain("new=0 inbox_lines=0 weekly=False");
  expect(inbox()).toHaveLength(before);
  rmSync(join(root, "state"), { recursive: true });
  rmSync(join(root, "inbox.jsonl"));
  expect((await run(["--seed"])).out).toContain("new=15 inbox_lines=0");
  expect(inbox()).toHaveLength(0);
  expect((await run()).out).toContain("new=0 inbox_lines=0");
});

test("an item is recorded only after its inbox line is written, so a failed append is retried next hour", async () => {
  mkdirSync(join(root, "inbox.jsonl"));
  const failed = await run();
  expect(failed.code).not.toBe(0);
  expect(existsSync(join(root, "state/seen.json")) ? Object.keys(seen()).filter((k) => ["pr:21", "pr:23", "pr:30", "issue:29"].includes(k)) : []).toEqual([]);
  rmSync(join(root, "inbox.jsonl"), { recursive: true });
  expect((await run()).code).toBe(0);
  expect(inbox().filter((x) => x.kind === "upstream-change").map((x) => x.item)).toContain("pr:21");
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

test("an item the owner already decided is marked by hand and never reaches the inbox", async () => {
  expect((await run(["--mark", "pr:23", "--why", "owner chose; lane backlog-loop"])).out).toContain("UPSTREAM_MARKED pr:23");
  expect((await run(["--mark", "23"])).code).not.toBe(0);
  await run();
  const items = inbox().filter((x) => x.kind === "upstream-change").map((x) => x.item);
  expect(items).toContain("pr:21");
  expect(items).not.toContain("pr:23");
  expect(seen()["pr:23"]!.class).toBe("decided");
});

test("without an inbox setting the line goes to the listener's inbox under DORI_STATE_DIR", async () => {
  const state = join(root, "dori-state");
  mkdirSync(join(state, "discord"), { recursive: true });
  const env = { UPSTREAM_WATCH_INBOX: "", UPSTREAM_WATCH_STATE_DIR: "", DORI_STATE_DIR: state };
  expect((await run([], env)).code).toBe(0);
  expect(readFileSync(join(state, "discord/inbox.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).item)).toContain("pr:21");
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
  // pr:22 is class 1: our checkout cites upstream issue #22, and GitHub numbers PRs and issues together.
  expect(items.filter((i) => i.startsWith("pr:"))).toHaveLength(149);
  expect(items).not.toContain("pr:22");
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

test("a PR at GitHub's 3000-file cap goes to the lead as a decision by itself, and the other items still arrive", async () => {
  json("files-30.json", Array.from({ length: 3000 }, (_, i) => ({ filename: `docs/f${i}.md`, patch: null })));
  const r = await run();
  expect(r.code).toBe(0);
  const rows = inbox().filter((x) => x.kind === "upstream-change");
  expect(rows.find((x) => x.item === "pr:30")).toMatchObject({ class: "3" });
  expect(rows.find((x) => x.item === "pr:30")!.reason).toContain("PR #30 lists 3000 files");
  expect(rows.map((x) => x.item)).toContain("pr:21");
});

test("with a neutral title the file contents decide: outbound code found in a patch, and code without a patch, both go to the owner", async () => {
  json("prs.json", [
    { number: 41, title: "refactor: client cleanup", url: `${UP}/pull/41`, mergedAt: "2026-11-02T00:00:00Z", mergeCommit: { oid: "4".repeat(40) }, body: "" },
    { number: 42, title: "refactor: tidy the store", url: `${UP}/pull/42`, mergedAt: "2026-11-02T00:00:00Z", mergeCommit: { oid: "5".repeat(40) }, body: "" },
    { number: 43, title: "refactor: move a file", url: `${UP}/pull/43`, mergedAt: "2026-11-02T00:00:00Z", mergeCommit: { oid: "6".repeat(40) }, body: "" },
  ]);
  json("files-41.json", [{ filename: "src/client.ts", patch: "@@ -0,0 +1 @@\n+await post('https://t.omo.dev/v1/logs')", status: "modified", changes: 1 }]);
  json("files-42.json", [{ filename: "src/store.ts", patch: null, status: "modified", changes: 900 }]);
  json("files-43.json", [{ filename: "src/old.ts", patch: null, status: "removed", changes: 40 }, { filename: "README.md", patch: null, status: "modified", changes: 2 }]);
  json("issues.json", []);
  writeFileSync(join(gh, "commits.jsonl"), "");
  expect((await run()).code).toBe(0);
  expect(inbox().filter((x) => x.kind === "upstream-change").map((x) => [x.item, x.class])).toEqual([["pr:41", "3"], ["pr:42", "3"]]);
  expect(seen()["pr:43"]!.class).toBe("2");
});

test("a dependency added to a skills package.json goes to the owner whatever its version spec; version and scripts lines do not", async () => {
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
  expect(rows.map((x) => [x.item, x.class])).toEqual([["pr:50", "3"], ["pr:51", "3"], ["pr:52", "3"], ["pr:53", "3"], ["pr:54", "3"], ["pr:55", "4"], ["pr:56", "3"], ["pr:57", "3"]]);
  expect(rows.find((x) => x.item === "pr:50")!.reason).toContain(`${pkg}에 left`);
  expect(rows.find((x) => x.item === "pr:51")!.reason).toContain(`${pkg}에 b`);
  expect(rows.find((x) => x.item === "pr:56")!.reason).toContain(`${pkg}에 helper, 블록을 패치로 못 가림`);
  expect(rows.find((x) => x.item === "pr:57")!.reason).toContain(`${pkg}에 later, 블록을 패치로 못 가림`);
});

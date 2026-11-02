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

// Our checkout: its history starts at one commit and its code cites upstream #7's commit and issue #22.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dori-upstream-watch-"));
  src = join(root, "src");
  gh = join(root, "gh");
  mkdirSync(src);
  mkdirSync(gh);
  sh(["git", "init", "-q"], src);
  writeFileSync(join(src, "cite.ts"), `// ${UP}/commit/40034ad1a557b92a34aa1450565adcafd3352c96\n// ${UP}/issues/22\n`);
  sh(["git", "add", "."], src);
  sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "root"], src);
  ourRoot = sh(["git", "rev-parse", "HEAD"], src);
  const pr = (number: number, title: string, paths: string[], extra: object = {}) => ({
    number, title, url: `${UP}/pull/${number}`, mergedAt: "2026-11-02T00:00:00Z", files: paths.map((path) => ({ path })),
    mergeCommit: { oid: `${number}`.padStart(40, "c") }, body: "", ...extra,
  });
  json("prs.json", [
    pr(7, "fix(dori-mode): decide pane state", ["skills/dori-mode/scripts/src/dead-panes.ts"], { mergeCommit: { oid: "40034ad1a557b92a34aa1450565adcafd3352c96" } }),
    pr(16, "feat: dori superharness on herdr + omo", ["src/herdr.ts", "README.md"]),
    pr(17, "docs(readme): avatar", ["README.md"]),
    pr(21, "feat(telemetry): anonymous usage counts", ["src/telemetry.ts", "README.md"], { body: "Closes #27" }),
    pr(23, "feat(loop): hourly loop that keeps picking up the next backlog item", ["src/loop.ts"]),
    pr(25, "fix(dori-mode): skip report templates", ["skills/dori-mode/scripts/src/freshness.ts"], { body: "Fixes #22" }),
    pr(30, "fix(dori-mode): keep reports in reports.jsonl", ["skills/dori-mode/scripts/src/cli.ts"]),
  ]);
  writeFileSync(join(gh, "diff-21.txt"), "diff --git a/src/telemetry.ts b/src/telemetry.ts\n+++ b/src/telemetry.ts\n+  const res = await fetch(url);\n");
  writeFileSync(join(gh, "diff-30.txt"), "diff --git a/skills/dori-mode/scripts/src/cli.ts b/skills/dori-mode/scripts/src/cli.ts\n+// see https://github.com/x/y\n");
  const issue = (number: number, title: string, state = "OPEN") => ({ number, title, state, url: `${UP}/issues/${number}`, createdAt: "2026-11-02T00:00:00Z" });
  json("issues.json", [issue(22, "freshness: lastReportLine selects templates", "CLOSED"), issue(27, "Telemetry", "CLOSED"), issue(29, "freshness: other report-template shapes"), issue(31, "dori send fails for agents launched with pane run")]);
  const commit = (sha: string, message: string) => ({ sha, commit: { message }, html_url: `${UP}/commit/${sha}` });
  json("commits.json", [
    commit("b".repeat(40), "direct: fix the lane sweep"),
    commit("c".repeat(39) + "1", "fix(dori-mode): skip report templates (#25)"),
    commit(ourRoot, "root"),
    commit("a".repeat(40), "a commit older than our history"),
  ]);
  json(`commit-${"b".repeat(40)}.json`, { files: [{ filename: "skills/dori-mode/scripts/src/sweeps.ts", patch: "+x" }] });
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
  const r = await run();
  expect(r.code).toBe(0);
  const rows = inbox();
  expect(rows.filter((x) => x.kind === "upstream-change").map((x) => [x.item, x.class])).toEqual([
    ["pr:21", "3"],
    ["pr:23", "3"],
    ["pr:30", "4"],
    ["issue:29", "4"],
    [`commit:${"b".repeat(40)}`, "4"],
  ]);
  const classes = Object.fromEntries(Object.entries(seen()).map(([k, v]) => [k, v.class]));
  expect(classes).toMatchObject({ "pr:7": "1", "pr:25": "1", "issue:22": "1", [`commit:${ourRoot}`]: "1", [`commit:${"a".repeat(40)}`]: "1", "pr:16": "2", "pr:17": "2", "issue:27": "2", "issue:31": "2" });
  const weekly = rows.filter((x) => x.kind === "upstream-weekly");
  expect(weekly).toHaveLength(1);
  expect(weekly[0]!.content).toContain("① 이미 있음 5건");
  expect(r.out).toContain("inbox_lines=5 weekly=True");
});

test("a second run and a seeded run write nothing more", async () => {
  await run();
  const before = inbox().length;
  expect((await run()).out).toContain("new=0 inbox_lines=0 weekly=False");
  expect(inbox()).toHaveLength(before);
  rmSync(join(root, "state"), { recursive: true });
  rmSync(join(root, "inbox.jsonl"));
  expect((await run(["--seed"])).out).toContain("new=14 inbox_lines=0");
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

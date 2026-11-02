import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import { takeLock } from "./handover.ts";
import { pidAlive } from "./heavy-slot.ts";
import type { BackupSettings } from "./state-backup.ts";

// A Dori's state kept in a local git repo per directory (owner 10-17 21:56 KST: "도리들 상태 파일도 메모리처럼 깃으로
// 관리하라고 해줘"; 21:57: "상태가 잘못됐을때 깃으로 복구하려는거야"). Local only: no remote, a pre-push hook refuses a push.
// Secrets and message text never go in: the fork's excludes (.git/info/exclude, rewritten on every run), a size limit,
// a file-name check and a token-shape scan of every staged blob. Nothing waits on a commit: the dori-lanes loop runs
// it in its own process under nice/ionice with a timeout, and a failure is one STATE_GIT_WARN line.

export type StateGitSettings = {
  // directories kept in git; empty: the config file's directory, the stateDir and the inbox's directory (each unless
  // inside another one, never $HOME or /)
  readonly dirs: readonly string[];
  // dori-lanes commits every this many minutes when something changed (0: off)
  readonly everyMin: number;
  // a file larger than this is left out (and listed in .git/info/exclude)
  readonly maxFileKb: number;
  // one git command is killed after this long
  readonly timeoutSec: number;
  // times in `log` and `restore "<time>"` (empty: scorecard.timeZone)
  readonly timeZone: string;
  // the private GitHub backup (src/state-backup.ts); backup.repo empty: none
  readonly backup: BackupSettings;
};

export type StateGitDeps = {
  readonly settings: StateGitSettings;
  readonly timeZone: string;
  readonly now: () => number;
  readonly print: (line: string) => void;
};

export class StateGitError extends Error {}

const MARK_BIG = "# too big for state-git (dori state-git adds these)";

// The fork's defaults. A local .gitignore adds to them; it cannot take one out (git reads info/exclude as well).
export const EXCLUDES = [
  "# dori state-git defaults, rewritten by every run from the fork; add your own lines to .gitignore",
  "# secrets: env files, tokens, passwords, keys, cookies",
  "*.env", "*.env.*", ".env", ".env.*", "*token*", "*secret*", "*password*", "*passwd*", "*credential*", "*cookie*",
  "*.pem", "*.key", "*.p12", "id_rsa*", "id_ed25519*", ".netrc",
  "# message text and personal data: inbox, card answers, mail and session events, briefs (they quote the owner)",
  "*inbox*.jsonl", "answers*.jsonl", "*events*.jsonl", "briefs/",
  "# logs, locks, caches, QA evidence, trash",
  "*.log", "*.lock", "*.pid", "*.tmp", "*.swp", "*cache*", "qa/", "qa-*", "trash-*/", "gpu/",
  "# dori review's PR diffs: gh pr diff rebuilds them, and a PR's test fixtures look like tokens (the review .md and receipt .json stay)",
  "**/receipts/reviews/*.diff",
  "# checkouts, worktrees, models, binaries, archives, media",
  "src/", "wt/", "node_modules/", "models/", "whisper.cpp/", "research/",
  "*.zip", "*.tar", "*.tar.*", "*.tgz", "*.gz", "*.7z", "*.bin", "*.gguf", "*.onnx", "*.so", "*.o",
  "*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.heic", "*.mp3", "*.mp4", "*.wav", "*.ogg", "*.m4a", "*.opus", "*.webm", "*.pdf",
];

// a staged file with one of these names is refused even when forced in (git add -f) or the excludes were edited
export const SECRET_NAME = /(^|\.)env$|\.env\.|^\.env|token|secret|passw|credential|cookie|\.pem$|\.key$|\.p12$|^id_(rsa|ed25519)|^\.netrc$|inbox.*\.jsonl$|^answers.*\.jsonl$|events.*\.jsonl$/i;

// token shapes: a file whose staged content matches one is not committed
export const TOKEN_SHAPES: readonly (readonly [string, RegExp])[] = [
  ["discord-token", /\b[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}\b/],
  ["github-token", /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["api-key", /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{24,}/],
  ["google-key", /\bAIza[0-9A-Za-z_-]{35}/],
  ["aws-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["telegram-token", /\b\d{8,10}:AA[A-Za-z0-9_-]{33}/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["bearer", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
  // a value right after the =, not a path or variable (a lane's "grep -c ^OPENAI_API_KEY= /home/ops/.env" is no secret)
  ["env-secret", /\b[A-Z][A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY)=["']?(?![$/{<~.])[^\s"'$]{8,}/],
  ["password", /(password|passwd|비밀번호|비번)["']?\s*[:=]\s*["']?[^\s"',}]{4,}/i],
];

export const tokenShape = (text: string): string | undefined => TOKEN_SHAPES.find(([, re]) => re.test(text))?.[0];

export const stateGitDirs = (o: { readonly configFile: string; readonly stateDir: string; readonly inbox: string; readonly home: string; readonly dirs: readonly string[] }): string[] => {
  const pick = (o.dirs.length ? o.dirs : [dirname(o.configFile), o.stateDir, dirname(o.inbox)]).map((d) => resolve(d));
  const all = [...new Set(pick)].filter((d) => d !== "/" && d !== resolve(o.home));
  return all.filter((d) => !all.some((other) => other !== d && d.startsWith(other + sep)));
};

const PRE_COMMIT = `#!/bin/sh
# dori state-git: a manual commit here is checked like the automatic one (secret file names, token-shaped content)
d=$(command -v dori || echo "$HOME/.bun/bin/dori")
exec "$d" state-git check --repo "$(git rev-parse --show-toplevel)"
`;
// a push goes only to this Dori's private backup repo (stateGit.backup.repo), after the same checks dori runs itself
export const PRE_PUSH = `#!/bin/sh
# dori state-git: push only to this Dori's private backup repo, checked first (visibility private, no secret, no owner message)
d=$(command -v dori || echo "$HOME/.bun/bin/dori")
"$d" state-git push-check --repo "$(git rev-parse --show-toplevel)" --remote "$1" --url "$2" || { echo "dori state-git: push refused" >&2; exit 1; }
`;

type Git = { readonly code: number; readonly out: string; readonly err: string };

const niceArgv = ((): string[] => (Bun.which("ionice") ? ["nice", "-n", "19", "ionice", "-c3"] : Bun.which("nice") ? ["nice", "-n", "19"] : []))();

export const git = async (deps: StateGitDeps, dir: string, args: readonly string[], stdin?: Uint8Array, env: Readonly<Record<string, string>> = {}): Promise<Git & { readonly bytes: Uint8Array }> => {
  const argv = [...niceArgv, "git", "-C", dir, "-c", "user.name=Dori state", "-c", "user.email=dori-state@localhost", "-c", "commit.gpgsign=false", "-c", "core.quotepath=false", ...args];
  const p = Bun.spawn(argv, { stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe", timeout: deps.settings.timeoutSec * 1000, killSignal: "SIGKILL", env: { ...process.env, TZ: deps.timeZone, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...env } });
  const [bytes, err, code] = await Promise.all([new Response(p.stdout).bytes(), new Response(p.stderr).text(), p.exited]);
  return { code: p.signalCode ? 124 : code, out: new TextDecoder().decode(bytes).trim(), err: p.signalCode ? `killed by ${p.signalCode} (timeout ${deps.settings.timeoutSec}s)` : err.trim(), bytes };
};

export const must = async (deps: StateGitDeps, dir: string, args: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<string> => {
  const r = await git(deps, dir, args, undefined, env);
  if (r.code !== 0) throw new StateGitError(`git ${args[0]}: ${(r.err || r.out || `exit ${r.code}`).slice(0, 200)}`);
  return r.out;
};

const gitDir = (dir: string): string => join(dir, ".git");

const writeExclude = (dir: string, big: readonly string[] = []): void => {
  const file = join(gitDir(dir), "info", "exclude");
  mkdirSync(dirname(file), { recursive: true });
  const old = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const at = old.indexOf(MARK_BIG);
  const kept = at >= 0 ? old.slice(at + 1).filter(Boolean) : [];
  const list = [...new Set([...kept, ...big])];
  writeFileSync(file, `${[...EXCLUDES, ...(list.length ? [MARK_BIG, ...list] : [])].join("\n")}\n`);
};

export const writeHook = (dir: string, name: string, body: string): void => {
  const file = join(gitDir(dir), "hooks", name);
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file) && readFileSync(file, "utf8") === body) return;
  writeFileSync(file, body);
  chmodSync(file, 0o755);
};

// init: a repo (once), the fork's excludes and hooks (every time, so an update reaches every Dori)
export const initRepo = async (deps: StateGitDeps, dir: string): Promise<string[]> => {
  if (!existsSync(dir)) throw new StateGitError(`no such directory: ${dir}`);
  const lines: string[] = [];
  if (!existsSync(gitDir(dir))) {
    await must(deps, dir, ["init", "-q", "-b", "main"]);
    lines.push(`STATE_GIT_INIT ${dir}`);
  }
  // a manual commit needs an author before git runs the pre-commit hook (this host has no global identity)
  if ((await git(deps, dir, ["config", "--local", "user.email"])).code !== 0) {
    await must(deps, dir, ["config", "--local", "user.name", "Dori state"]);
    await must(deps, dir, ["config", "--local", "user.email", "dori-state@localhost"]);
  }
  writeExclude(dir);
  writeHook(dir, "pre-commit", PRE_COMMIT);
  writeHook(dir, "pre-push", PRE_PUSH);
  const gi = join(dir, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "# local additions to dori state-git's defaults (those are in .git/info/exclude)\n");
  const remotes = await must(deps, dir, ["remote"]);
  const other = remotes.split("\n").filter((r) => r && r !== "backup");
  if (other.length) lines.push(`STATE_GIT_WARN ${dir} has a remote (${other.join(",")}); state-git pushes only to its private backup remote`);
  return lines;
};

type Staged = { readonly path: string; readonly mode: string; readonly sha: string; readonly status: string };

// `git diff --cached --raw -z`: ":<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0"
const staged = async (deps: StateGitDeps, dir: string): Promise<Staged[]> => {
  const out = (await git(deps, dir, ["diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev"])).out;
  const parts = out.split("\0");
  const list: Staged[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:\d+ (\d+) \S+ ([0-9a-f]+) (\w)/.exec(parts[i] ?? "");
    if (m?.[1] && m[2] && m[3]) list.push({ mode: m[1], sha: m[2], status: m[3], path: parts[i + 1] ?? "" });
  }
  return list;
};

// every staged blob in one `git cat-file --batch`
const blobs = async (deps: StateGitDeps, dir: string, shas: readonly string[]): Promise<Map<string, Uint8Array>> => {
  const map = new Map<string, Uint8Array>();
  if (!shas.length) return map;
  const r = await git(deps, dir, ["cat-file", "--batch"], new TextEncoder().encode(`${shas.join("\n")}\n`));
  if (r.code !== 0) throw new StateGitError(`git cat-file: ${r.err.slice(0, 200)}`);
  const b = r.bytes;
  let at = 0;
  while (at < b.length) {
    const nl = b.indexOf(10, at);
    if (nl < 0) break;
    const [sha, , size] = new TextDecoder().decode(b.subarray(at, nl)).split(" ");
    const n = Number(size);
    if (!sha || !Number.isFinite(n)) break;
    map.set(sha, b.subarray(nl + 1, nl + 1 + n));
    at = nl + 1 + n + 1;
  }
  return map;
};

// what in the index must not be committed: a secret file name or token-shaped content
export const refusals = async (deps: StateGitDeps, dir: string, list: readonly Staged[]): Promise<{ readonly path: string; readonly why: string; readonly sha: string }[]> => {
  const adds = list.filter((s) => s.status !== "D" && s.mode !== "160000");
  const content = await blobs(deps, dir, [...new Set(adds.map((s) => s.sha))]);
  const out: { path: string; why: string; sha: string }[] = [];
  for (const s of adds) {
    if (SECRET_NAME.test(basename(s.path))) {
      out.push({ path: s.path, why: "secret-name", sha: s.sha });
      continue;
    }
    const bytes = content.get(s.sha);
    if (!bytes || bytes.includes(0)) continue;
    const kind = tokenShape(new TextDecoder().decode(bytes));
    if (kind) out.push({ path: s.path, why: kind, sha: s.sha });
  }
  return out;
};

const summary = (list: readonly Staged[]): string => {
  const names = list.map((s) => `${s.status === "A" ? "+" : s.status === "D" ? "-" : ""}${s.path}`);
  return `state: ${list.length} file${list.length === 1 ? "" : "s"}: ${names.slice(0, 4).join(", ")}${names.length > 4 ? ` +${names.length - 4}` : ""}`;
};

const unlockStale = (deps: StateGitDeps, dir: string): string[] => {
  const lock = join(gitDir(dir), "index.lock");
  try {
    const age = deps.now() - statSync(lock).mtimeMs;
    if (age < deps.settings.timeoutSec * 2000) return [];
    rmSync(lock, { force: true });
    return [`STATE_GIT_UNLOCK ${dir} removed a stale index.lock (${Math.round(age / 1000)}s old)`];
  } catch {
    return [];
  }
};

const withLock = async <T>(deps: StateGitDeps, dir: string, waitMs: number, body: () => Promise<T>): Promise<T | undefined> => {
  const file = join(gitDir(dir), "dori-state.lock");
  const until = deps.now() + waitMs;
  for (;;) {
    const busy = takeLock(file, pidAlive, new Date(deps.now()).toISOString(), "state-git");
    if (!busy) break;
    if (deps.now() >= until) return undefined;
    await Bun.sleep(250);
  }
  try {
    return await body();
  } finally {
    rmSync(file, { force: true });
  }
};

export type CommitResult = { readonly lines: string[]; readonly sha?: string };

// the files of an index (env GIT_INDEX_FILE: another one) that the fork's excludes cover
const covered = async (deps: StateGitDeps, dir: string, env: Readonly<Record<string, string>> = {}): Promise<string[]> =>
  (await must(deps, dir, ["ls-files", "-z", "-c", "-i", `--exclude-from=${join(gitDir(dir), "info", "exclude")}`], env)).split("\0").filter(Boolean);

const commitLocked = async (deps: StateGitDeps, dir: string, message?: string): Promise<CommitResult> => {
  const started = deps.now();
  const lines = unlockStale(deps, dir);
  // new files over the size limit are listed in the excludes before anything is hashed
  const untracked = (await must(deps, dir, ["ls-files", "-z", "-o", "--exclude-standard"])).split("\0").filter(Boolean);
  const big = untracked.filter((p) => {
    try {
      return statSync(join(dir, p)).size > deps.settings.maxFileKb * 1024;
    } catch {
      return false;
    }
  });
  if (big.length) {
    writeExclude(dir, big.map((p) => `/${p}`));
    lines.push(`STATE_GIT_BIG ${dir} left out ${big.length} file(s) over ${deps.settings.maxFileKb} KB: ${big.slice(0, 3).join(", ")}${big.length > 3 ? " ..." : ""}`);
  }
  // git keeps tracking a file an exclude covers: one committed before a new default (dori review's diffs before
  // 2026-11-02) is taken out of the index here, and stays on disk
  const out = await covered(deps, dir);
  if (out.length) {
    await must(deps, dir, ["rm", "-q", "--cached", "--", ...out]);
    lines.push(`STATE_GIT_UNTRACK ${dir} ${out.length} file(s) the excludes now cover, kept on disk: ${out.slice(0, 3).join(", ")}${out.length > 3 ? " ..." : ""}`);
  }
  await must(deps, dir, ["add", "-A"]);
  let list = await staged(deps, dir);
  // a checkout inside (its own .git) would be a gitlink: left out and excluded
  const links = list.filter((s) => s.mode === "160000");
  if (links.length) {
    await must(deps, dir, ["rm", "-q", "--cached", "--", ...links.map((s) => s.path)]);
    writeExclude(dir, links.map((s) => `/${s.path}/`));
    lines.push(`STATE_GIT_BIG ${dir} left out nested repo(s): ${links.map((s) => s.path).join(", ")}`);
  }
  const refused = await refusals(deps, dir, list);
  if (refused.length) {
    await must(deps, dir, ["reset", "-q", "--", ...refused.map((r) => r.path)]);
    // one line per refused content, not one every run
    const seenFile = join(gitDir(dir), "dori-refused");
    const seen = new Set(existsSync(seenFile) ? readFileSync(seenFile, "utf8").split("\n") : []);
    for (const r of refused.filter((x) => !seen.has(x.sha))) lines.push(`STATE_GIT_REFUSED ${dir} ${r.path} ${r.why}: not committed; move the secret out or add the file to ${dir}/.gitignore`);
    writeFileSync(seenFile, [...new Set([...seen, ...refused.map((r) => r.sha)])].filter(Boolean).join("\n"));
  }
  list = await staged(deps, dir);
  if (!list.length) return { lines: [...lines, `STATE_GIT_NOCHANGE ${dir}`] };
  await must(deps, dir, ["commit", "-q", "--no-verify", "-m", message ? `state: ${message}` : summary(list), ...(message ? ["-m", summary(list)] : [])]);
  const sha = await must(deps, dir, ["rev-parse", "--short", "HEAD"]);
  lines.push(`STATE_GIT_COMMIT ${dir} ${sha} ${list.length} file(s) ${deps.now() - started}ms`);
  return { lines, sha };
};

// commit what changed (nothing changed: STATE_GIT_NOCHANGE, no commit); busy with another run: STATE_GIT_BUSY
export const commitDir = async (deps: StateGitDeps, dir: string, message?: string, waitMs = 0): Promise<CommitResult> => {
  const init = await initRepo(deps, dir);
  const r = await withLock(deps, dir, waitMs, () => commitLocked(deps, dir, message));
  return r ? { ...r, lines: [...init, ...r.lines] } : { lines: [...init, `STATE_GIT_BUSY ${dir} another state-git run holds .git/dori-state.lock`] };
};

const hasHead = async (deps: StateGitDeps, dir: string): Promise<boolean> => (await git(deps, dir, ["rev-parse", "-q", "--verify", "HEAD"])).code === 0;

export const logDir = async (deps: StateGitDeps, dir: string, count: number): Promise<string[]> => {
  if (!existsSync(gitDir(dir)) || !(await hasHead(deps, dir))) return [`STATE_GIT_EMPTY ${dir} (no commit yet: dori state-git commit)`];
  const out = await must(deps, dir, ["log", `-n${count}`, "--date=format-local:%Y-%m-%d %H:%M", "--format=%h %cd %s"]);
  return [`== ${dir} (${deps.timeZone})`, ...out.split("\n")];
};

// "<sha>" or a time git reads ("2026-10-16 21:00", "yesterday 21:00", "3 hours ago"), in deps.timeZone: the last
// commit at or before it. Undefined when the repo has neither.
export const resolveTarget = async (deps: StateGitDeps, dir: string, target: string): Promise<string | undefined> => {
  if (!(await hasHead(deps, dir))) return undefined;
  if (/^[0-9a-f]{4,40}$/i.test(target)) {
    const r = await git(deps, dir, ["rev-parse", "-q", "--verify", `${target}^{commit}`]);
    if (r.code === 0) return r.out;
  }
  const r = await git(deps, dir, ["rev-list", "-1", `--before=${target}`, "HEAD"]);
  return r.code === 0 && r.out ? r.out : undefined;
};

// restore: commit what is there now (so the restore can be undone), put the tracked files (all, or `paths`) back as
// they were at the target, then commit that. Ignored files (env, inbox, logs) are never touched.
export const restoreDir = async (deps: StateGitDeps, dir: string, target: string, paths: readonly string[]): Promise<string[]> => {
  const sha = await resolveTarget(deps, dir, target);
  if (!sha) return [`STATE_GIT_NO_TARGET ${dir} has no commit at or before ${target}`];
  const r = await withLock(deps, dir, 30_000, async () => {
    // the fork's excludes as of this version, also when no commit ran since an update: the snapshot and the files
    // kept below follow them
    writeExclude(dir);
    const lines = (await commitLocked(deps, dir, `before restore to ${sha.slice(0, 7)}`)).lines.filter((l) => !l.startsWith("STATE_GIT_NOCHANGE"));
    const before = await must(deps, dir, ["rev-parse", "--short", "HEAD"]);
    const when = await must(deps, dir, ["log", "-1", "--date=format-local:%Y-%m-%d %H:%M", "--format=%cd", sha]);
    // a file the excludes now cover stays as it is on disk: the commit just made no longer holds it, so a restore
    // that overwrote it could not be undone
    const idx = join(gitDir(dir), "dori-restore-index");
    await must(deps, dir, ["read-tree", sha], { GIT_INDEX_FILE: idx });
    const keep = await covered(deps, dir, { GIT_INDEX_FILE: idx }).finally(() => rmSync(idx, { force: true }));
    await must(deps, dir, ["restore", `--source=${sha}`, "--staged", "--worktree", "--", ...(paths.length ? paths : ["."]), ...keep.map((p) => `:(exclude,literal)${p}`)]);
    const done = await commitLocked(deps, dir, `restore ${paths.length ? paths.join(" ") : "all"} to ${sha.slice(0, 7)} (${when})`);
    lines.push(...done.lines.filter((l) => !l.startsWith("STATE_GIT_NOCHANGE")));
    lines.push(`STATE_GIT_RESTORED ${dir} to ${sha.slice(0, 7)} (${when} ${deps.timeZone}); undo: dori state-git restore ${before} --dir ${dir}`);
    return lines;
  });
  return r ?? [`STATE_GIT_BUSY ${dir} another state-git run holds .git/dori-state.lock; try again`];
};

// the pre-commit hook: refuse a manual commit with a secret file name or token-shaped content
export const checkRepo = async (deps: StateGitDeps, dir: string): Promise<string[]> =>
  (await refusals(deps, dir, await staged(deps, dir))).map((r) => `STATE_GIT_REFUSED ${dir} ${r.path} ${r.why}: unstage it (git reset -- ${r.path}) or move the secret out`);

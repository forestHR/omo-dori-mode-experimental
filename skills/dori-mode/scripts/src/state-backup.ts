import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import { BACKUP_REMOTE } from "./config.ts";
import { git, initRepo, must, PRE_PUSH, SECRET_NAME, type StateGitDeps, TOKEN_SHAPES, tokenShape, writeHook } from "./state-git.ts";

// The private GitHub backup of a Dori's local repos (owner 10-18 00:19 KST: "로컬 도리들은 비공개 레포로 올려두기 그리고
// 푸시는 대기 상태일때 새벽6시에 수행"). One private repo per Dori, one branch per directory. What leaves the host is a
// snapshot of each repo's HEAD with every file a check refused left out, committed on its own branch history: the local
// history (10-minute commits, commit messages that quote the owner, a secret a past commit held) never leaves. Before every
// push: the repo must be private on GitHub, the lead must have approved the first push, and the snapshot is scanned for
// secret file names, token shapes, the real secret values on this host and the owner's messages word for word.

export type BackupSettings = {
  // "owner/name" of this Dori's private GitHub repo; empty: no backup
  readonly repo: string;
  // repos pushed besides the state-git ones, as they are committed (a Dori's local docs repo, e.g. ~/Documents/zzangdori)
  readonly dirs: readonly string[];
  // the daily push, in stateGit.timeZone: first try at `at`, again every retryMin while busy, none after `until`
  readonly at: string;
  readonly retryMin: number;
  readonly until: string;
  // files whose secret values must never leave: env files (KEY=VALUE, keys named like a token, secret, password, key,
  // webhook) and message files (token-shaped strings in them). The env files of the pushed dirs and DORI_ENV_FILE are added.
  readonly secretFiles: readonly string[];
  // inbox files (jsonl): an owner message of ownerMinChars or more found word for word in a file keeps that file out.
  // DORI_DISCORD_INBOX and DORI_KAKAO_INBOX are added.
  readonly messageFiles: readonly string[];
  readonly ownerMinChars: number;
  // file names that may quote the owner (the directive ledger and the instructions keep his words on purpose)
  readonly ownerQuoteOk: readonly string[];
};

export { BACKUP_DEFAULTS } from "./config.ts";

export type Secrets = {
  // the values, never printed; `from` names the file each came from
  readonly values: readonly { readonly value: string; readonly from: string }[];
  readonly ownerTexts: readonly string[];
};

export type BackupDeps = StateGitDeps & {
  readonly backup: BackupSettings;
  readonly stateDir: string;
  readonly home: string;
  // "private" | "public" | "internal" | "missing" | "unknown: <why>"
  readonly visibility: (repo: string) => Promise<string>;
  readonly remoteUrl: (repo: string) => string;
  readonly secrets: () => Promise<Secrets>;
  // why now is not a quiet moment (a pane mid-turn, a heavy job, a git lock); empty: idle
  readonly busy: () => Promise<readonly string[]>;
};

export type Hit = { readonly path: string; readonly kind: string };

const ZERO = /^0+$/;
const REMOTE = BACKUP_REMOTE;

// ~/.dori -> dot-dori, ~/Documents/zzangdori -> documents-zzangdori
export const branchFor = (dir: string, home: string): string => {
  const rel = relative(resolve(home), resolve(dir));
  const name = (rel && !rel.startsWith("..") ? rel : resolve(dir).slice(1)).toLowerCase();
  return name.split("/").map((p) => (p.startsWith(".") ? `dot-${p.slice(1)}` : p)).join("-").replace(/[^a-z0-9._-]+/g, "-");
};

const SECRET_KEY = /TOKEN|SECRET|PASS|API_?KEY|WEBHOOK|CREDENTIAL|COOKIE|AUTH/i;

// the secret values in an env file: KEY=VALUE lines whose key is named like a secret (ids and paths are no secrets)
export const envSecrets = (text: string): string[] =>
  text.split("\n").flatMap((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    const value = (m?.[2] ?? "").trim().replace(/^["']|["']$/g, "");
    return m?.[1] && SECRET_KEY.test(m[1]) && value.length >= 6 && !/^\d+$/.test(value) && !/^[$/~.]/.test(value) ? [value] : [];
  });

// token-shaped strings in any text (a bot token the owner pasted into a chat): the value part only
export const shapedSecrets = (text: string): string[] => {
  const out: string[] = [];
  for (const [kind, re] of TOKEN_SHAPES) {
    if (kind === "password") continue;
    for (const m of text.matchAll(new RegExp(re.source, `${re.flags.replace("g", "")}g`))) {
      const v = kind === "env-secret" ? m[0].slice(m[0].indexOf("=") + 1).replace(/^["']/, "") : kind === "bearer" ? m[0].replace(/^Bearer\s+/, "") : m[0];
      if (v.length >= 8) out.push(v);
    }
  }
  return out;
};

// the owner's messages in an inbox file: rows by the owner (author_kind "owner" or one of the owner ids)
export const ownerMessages = (text: string, ownerIds: readonly string[], minChars: number): string[] =>
  text.split("\n").flatMap((line) => {
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== "object") return [];
      const r = row as Record<string, unknown>;
      const content = typeof r.content === "string" ? r.content.trim() : typeof r.text === "string" ? r.text.trim() : "";
      const owner = r.author_kind === "owner" || (ownerIds.length > 0 && ownerIds.includes(String(r.author_id ?? "")));
      return owner && content.length >= minChars ? [content] : [];
    } catch (e) {
      if (e instanceof SyntaxError) return [];
      throw e;
    }
  });

const glob = (pattern: string): RegExp => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

const MESSAGE_PATH = /(^|\/)briefs\//;

// what in one file must not leave: a secret name, message text, a token shape, a real secret value, the owner's words
export const fileHit = (path: string, bytes: Uint8Array, secrets: Secrets, s: BackupSettings): string | undefined => {
  const name = basename(path);
  if (SECRET_NAME.test(name)) return "secret-name";
  if (MESSAGE_PATH.test(path)) return "message-file";
  if (bytes.includes(0)) return undefined;
  const text = new TextDecoder().decode(bytes);
  const shape = tokenShape(text);
  if (shape) return shape;
  const real = secrets.values.find((v) => text.includes(v.value));
  if (real) return `real-secret (a value from ${basename(real.from)})`;
  if (s.ownerQuoteOk.some((p) => glob(p).test(name))) return undefined;
  const quoted = secrets.ownerTexts.filter((m) => text.includes(m)).length;
  return quoted ? `owner-message x${quoted}` : undefined;
};

// every blob of a tree (path, sha) and their content in one cat-file run
const treeFiles = async (deps: StateGitDeps, dir: string, tree: string): Promise<{ readonly path: string; readonly sha: string }[]> =>
  (await must(deps, dir, ["ls-tree", "-r", "-z", "--full-tree", tree]))
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => {
      const m = /^\d+ blob ([0-9a-f]+)\t(.*)$/s.exec(entry);
      return m?.[1] && m[2] !== undefined ? [{ sha: m[1], path: m[2] }] : [];
    });

const catBlobs = async (deps: StateGitDeps, dir: string, shas: readonly string[]): Promise<Map<string, Uint8Array>> => {
  const map = new Map<string, Uint8Array>();
  if (!shas.length) return map;
  const r = await git(deps, dir, ["cat-file", "--batch"], new TextEncoder().encode(`${shas.join("\n")}\n`));
  if (r.code !== 0) throw new Error(`git cat-file: ${r.err.slice(0, 200)}`);
  let at = 0;
  const b = r.bytes;
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

export const scanTree = async (deps: BackupDeps, dir: string, tree: string, secrets: Secrets): Promise<{ readonly files: readonly string[]; readonly hits: readonly Hit[] }> => {
  const files = await treeFiles(deps, dir, tree);
  const content = await catBlobs(deps, dir, [...new Set(files.map((f) => f.sha))]);
  const hits: Hit[] = [];
  for (const f of files) {
    const kind = fileHit(f.path, content.get(f.sha) ?? new Uint8Array(), secrets, deps.backup);
    if (kind) hits.push({ path: f.path, kind });
  }
  return { files: files.map((f) => f.path), hits };
};

// a secret in the local history (a past blob or a commit message; the files of HEAD are checked by the snapshot): such a
// repo is held until the lead has looked
export const scanHistory = async (deps: BackupDeps, dir: string, secrets: Secrets): Promise<readonly Hit[]> => {
  if ((await git(deps, dir, ["rev-parse", "-q", "--verify", "HEAD"])).code !== 0) return [];
  const objects = (await must(deps, dir, ["rev-list", "--objects", "--all", "--no-object-names"])).split("\n").filter(Boolean);
  const kinds = new Map((await git(deps, dir, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], new TextEncoder().encode(`${objects.join("\n")}\n`))).out.split("\n").map((l) => l.split(" ") as [string, string]));
  const inHead = new Set((await treeFiles(deps, dir, "HEAD")).map((f) => f.sha));
  const blobs = objects.filter((o) => kinds.get(o) === "blob" && !inHead.has(o));
  const content = await catBlobs(deps, dir, blobs);
  const names = new Map<string, string>();
  for (const l of (await must(deps, dir, ["rev-list", "--objects", "--all"])).split("\n")) {
    const at = l.indexOf(" ");
    if (at > 0 && !names.has(l.slice(0, at))) names.set(l.slice(0, at), l.slice(at + 1));
  }
  const hits: Hit[] = [];
  for (const sha of blobs) {
    const path = names.get(sha) ?? sha;
    const text = new TextDecoder().decode(content.get(sha) ?? new Uint8Array());
    const shape = SECRET_NAME.test(basename(path)) ? "secret-name" : tokenShape(text);
    const real = shape ? undefined : secrets.values.find((v) => text.includes(v.value));
    if (shape || real) hits.push({ path: `${path}@${sha.slice(0, 7)}`, kind: shape ?? `real-secret (a value from ${basename(real?.from ?? "")})` });
  }
  const log = await must(deps, dir, ["log", "--all", "--format=%h%x00%B%x01"]);
  for (const entry of log.split("\x01")) {
    const [sha, body = ""] = entry.trim().split("\0");
    if (!sha) continue;
    const shape = tokenShape(body);
    const real = shape ? undefined : secrets.values.find((v) => body.includes(v.value));
    if (shape || real) hits.push({ path: `commit message ${sha}`, kind: shape ?? `real-secret (a value from ${basename(real?.from ?? "")})` });
  }
  return hits;
};

export type Approval = { readonly at: string; readonly by: string; readonly repo: string; readonly historyOk: readonly string[] };

const markDir = (deps: BackupDeps): string => join(deps.stateDir, "state-git");
const approvalFile = (deps: BackupDeps): string => join(markDir(deps), "backup-approved.json");

export const readApproval = (deps: BackupDeps): Approval | undefined => {
  const f = approvalFile(deps);
  if (!existsSync(f)) return undefined;
  const a = JSON.parse(readFileSync(f, "utf8")) as Approval;
  return a.repo === deps.backup.repo ? a : undefined;
};

export const approve = (deps: BackupDeps, by: string, historyOk: readonly string[]): string => {
  mkdirSync(markDir(deps), { recursive: true });
  const a: Approval = { at: new Date(deps.now()).toISOString(), by, repo: deps.backup.repo, historyOk };
  writeFileSync(approvalFile(deps), `${JSON.stringify(a, null, 2)}\n`);
  return `BACKUP_APPROVED ${deps.backup.repo} by ${by}${historyOk.length ? ` (history hits accepted: ${historyOk.length})` : ""}`;
};

type Snapshot = { readonly tree: string; readonly files: readonly string[]; readonly hits: readonly Hit[]; readonly history: readonly Hit[] };

const snapshot = async (deps: BackupDeps, dir: string, secrets: Secrets): Promise<Snapshot | undefined> => {
  const head = await git(deps, dir, ["rev-parse", "-q", "--verify", "HEAD^{tree}"]);
  if (head.code !== 0) return undefined;
  const scan = await scanTree(deps, dir, head.out, secrets);
  const history = await scanHistory(deps, dir, secrets);
  if (!scan.hits.length) return { tree: head.out, ...scan, history };
  // the HEAD tree without the refused files, built in a scratch index (the repo's own index is not touched)
  const env = { GIT_INDEX_FILE: join(dir, ".git", "dori-backup-index") };
  await must(deps, dir, ["read-tree", head.out], env);
  await must(deps, dir, ["rm", "-q", "--cached", "--ignore-unmatch", "--", ...scan.hits.map((h) => h.path)], env);
  const tree = await must(deps, dir, ["write-tree"], env);
  return { tree, files: scan.files.filter((f) => !scan.hits.some((h) => h.path === f)), hits: scan.hits, history };
};

export const previewDir = async (deps: BackupDeps, dir: string, secrets: Secrets): Promise<string[]> => {
  const branch = branchFor(dir, deps.home);
  const snap = await snapshot(deps, dir, secrets);
  if (!snap) return [`BACKUP_PREVIEW ${dir} -> ${deps.backup.repo}:${branch} no commit yet`];
  const out = join(markDir(deps), "backup-preview", `${branch}.txt`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, [`# ${dir} -> ${deps.backup.repo} branch ${branch}: ${snap.files.length} files go up (paths only)`, ...snap.files, "", `# left out of the push: ${snap.hits.length}`, ...snap.hits.map((h) => `${h.path}\t${h.kind}`), "", `# secrets in the local history (never pushed; the repo is held until the lead accepts them with backup approve --history-ok "<dir>:<path>"): ${snap.history.length}`, ...snap.history.map((h) => `${h.path}\t${h.kind}`), ""].join("\n"));
  return [`BACKUP_PREVIEW ${dir} -> ${deps.backup.repo}:${branch} ${snap.files.length} files, left out ${snap.hits.length}, history secrets ${snap.history.length}; list: ${out}`];
};

export const pushDir = async (deps: BackupDeps, dir: string, secrets: Secrets, approval: Approval): Promise<string[]> => {
  const repo = deps.backup.repo;
  const branch = branchFor(dir, deps.home);
  const lines: string[] = [];
  const started = deps.now();
  const vis = await deps.visibility(repo);
  if (vis !== "private") return [`STATE_GIT_PUSH_REFUSED ${dir} ${repo} is ${vis}, not private: nothing pushed`];
  const snap = await snapshot(deps, dir, secrets);
  if (!snap) return [`STATE_GIT_PUSH_NOCHANGE ${dir} no commit yet`];
  // the lead accepts a path ("<dir>:<path>"), so a later version of the same file does not hold the repo again
  const held = snap.history.filter((h) => !approval.historyOk.includes(`${dir}:${h.path.replace(/@[0-9a-f]+$/, "")}`));
  if (held.length) return [`STATE_GIT_PUSH_HELD ${dir} its local history holds ${held.length} secret(s) (${held.slice(0, 3).map((h) => `${h.path} ${h.kind}`).join("; ")}): not pushed, tell the lead (dori state-git backup preview)`];
  const seen = join(dir, ".git", "dori-backup-left-out");
  const known = new Set(existsSync(seen) ? readFileSync(seen, "utf8").split("\n") : []);
  for (const h of snap.hits.filter((x) => !known.has(`${x.path}\t${x.kind}`))) lines.push(`STATE_GIT_PUSH_LEFT_OUT ${dir} ${h.path} ${h.kind}`);
  writeFileSync(seen, snap.hits.map((h) => `${h.path}\t${h.kind}`).join("\n"));
  const ref = `refs/dori-backup/${branch}`;
  const prev = await git(deps, dir, ["rev-parse", "-q", "--verify", ref]);
  const url = deps.remoteUrl(repo);
  const remotes = (await must(deps, dir, ["remote"])).split("\n");
  await must(deps, dir, remotes.includes(REMOTE) ? ["remote", "set-url", REMOTE, url] : ["remote", "add", REMOTE, url]);
  let tip = prev.code === 0 ? prev.out : "";
  if (!tip || (await must(deps, dir, ["rev-parse", `${tip}^{tree}`])) !== snap.tree) {
    const head = await must(deps, dir, ["rev-parse", "--short", "HEAD"]);
    const day = new Date(deps.now()).toLocaleString("sv-SE", { timeZone: deps.timeZone }).slice(0, 16);
    tip = await must(deps, dir, ["commit-tree", snap.tree, ...(tip ? ["-p", tip] : []), "-m", `backup ${day} ${deps.timeZone}: ${snap.files.length} files from ${head}`]);
    await must(deps, dir, ["update-ref", ref, tip]);
  }
  const pushed = await git(deps, dir, ["rev-parse", "-q", "--verify", `refs/remotes/${REMOTE}/${branch}`]);
  if (pushed.code === 0 && pushed.out === tip) return [...lines, `STATE_GIT_PUSH_NOCHANGE ${dir}`];
  // the same checks ran just above, in this process; the hook is for a push by hand
  const r = await git(deps, dir, ["push", "-q", "--no-verify", REMOTE, `${tip}:refs/heads/${branch}`]);
  if (r.code !== 0) return [...lines, `STATE_GIT_PUSH_WARN ${dir} git push: ${(r.err || r.out).replace(/\s+/g, " ").slice(0, 200)}`];
  await must(deps, dir, ["update-ref", `refs/remotes/${REMOTE}/${branch}`, tip]);
  lines.push(`STATE_GIT_PUSHED ${dir} ${repo}:${branch} ${tip.slice(0, 7)} ${snap.files.length} files ${deps.now() - started}ms (approved by ${approval.by})`);
  return lines;
};

// the docs repos get the guarding pre-push hook too (unless they have their own)
export const guardDir = async (deps: BackupDeps, dir: string, stateGitDir: boolean): Promise<string[]> => {
  if (stateGitDir) return initRepo(deps, dir);
  const hook = join(dir, ".git", "hooks", "pre-push");
  if (!existsSync(hook) || readFileSync(hook, "utf8").includes("# dori state-git")) writeHook(dir, "pre-push", PRE_PUSH);
  return [];
};

export const pushAll = async (deps: BackupDeps, dirs: readonly string[]): Promise<string[]> => {
  const approval = readApproval(deps);
  if (!approval) return [`STATE_GIT_PUSH_WAIT_APPROVAL ${deps.backup.repo}: the first push waits for the lead (dori state-git backup preview, then backup approve --by "lead: ...")`];
  const secrets = await deps.secrets();
  const lines: string[] = [];
  for (const d of dirs) {
    try {
      lines.push(...(await pushDir(deps, d, secrets, approval)));
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      lines.push(`STATE_GIT_PUSH_WARN ${d} ${e.message.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  }
  return lines;
};

// pre-push: remote must be this Dori's backup remote and private, and the pushed commits clean (their whole history)
export const pushCheck = async (deps: BackupDeps, dir: string, remote: string, url: string, refs: string): Promise<string[]> => {
  const repo = deps.backup.repo;
  if (!repo) return [`no stateGit.backup.repo for this Dori: this repo stays on the host`];
  if (remote !== REMOTE || url !== deps.remoteUrl(repo)) return [`only the remote "${REMOTE}" at ${deps.remoteUrl(repo)} takes a push (got ${remote} ${url})`];
  const vis = await deps.visibility(repo);
  if (vis !== "private") return [`${repo} is ${vis}, not private`];
  if (!readApproval(deps)) return [`the lead has not approved the first push to ${repo} (dori state-git backup preview, then backup approve)`];
  const secrets = await deps.secrets();
  const out: string[] = [];
  for (const line of refs.split("\n").filter(Boolean)) {
    const [, local = "", , remoteSha = ""] = line.split(" ");
    if (ZERO.test(local)) continue;
    const range = ZERO.test(remoteSha) ? [local] : [local, `^${remoteSha}`];
    const commits = (await must(deps, dir, ["rev-list", ...range])).split("\n").filter(Boolean);
    for (const c of commits) {
      const tree = await must(deps, dir, ["rev-parse", `${c}^{tree}`]);
      for (const h of (await scanTree(deps, dir, tree, secrets)).hits) out.push(`${c.slice(0, 7)} ${h.path} ${h.kind}`);
      const body = await must(deps, dir, ["log", "-1", "--format=%B", c]);
      if (tokenShape(body) || secrets.values.some((v) => body.includes(v.value))) out.push(`${c.slice(0, 7)} commit message holds a secret`);
    }
  }
  return [...new Set(out)];
};

export type BackupMark = { readonly day: string; readonly slot: number; readonly done?: boolean; readonly skipped?: boolean };
export type Step = { readonly kind: "none" } | { readonly kind: "try"; readonly day: string; readonly slot: number } | { readonly kind: "skip"; readonly day: string };

const minutes = (hhmm: string): number => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
};

// the local day and minute of the day in a time zone
export const localClock = (ms: number, timeZone: string): { readonly day: string; readonly min: number; readonly sec: number } => {
  const s = new Date(ms).toLocaleString("sv-SE", { timeZone, hourCycle: "h23" });
  const [day = "", time = "00:00:00"] = s.split(" ");
  const [h = "0", m = "0", sec = "0"] = time.split(":");
  return { day, min: Number(h) * 60 + Number(m), sec: Number(sec) };
};

// what to do now: try at `at` and every retryMin after it while the last try was busy, skip the day after `until`
export const backupStep = (ms: number, timeZone: string, s: BackupSettings, mark: BackupMark | undefined): Step => {
  const { day, min } = localClock(ms, timeZone);
  const at = minutes(s.at);
  if (min < at) return { kind: "none" };
  const today = mark?.day === day ? mark : undefined;
  if (today?.done || today?.skipped) return { kind: "none" };
  if (min > minutes(s.until)) return { kind: "skip", day };
  const slot = Math.floor((min - at) / s.retryMin);
  return today && today.slot >= slot ? { kind: "none" } : { kind: "try", day, slot };
};

// milliseconds until the next try could be due (the loop wakes then, or at its own commit tick if that is sooner)
export const msToNextSlot = (ms: number, timeZone: string, s: BackupSettings): number => {
  const { min, sec } = localClock(ms, timeZone);
  const at = minutes(s.at);
  const next = min < at ? at : at + (Math.floor((min - at) / s.retryMin) + 1) * s.retryMin;
  const target = next <= minutes(s.until) + 1 ? next : at + 24 * 60;
  return ((target - min) * 60 - sec) * 1000;
};

const markFile = (deps: BackupDeps): string => join(markDir(deps), "backup.json");

export const readMark = (deps: BackupDeps): BackupMark | undefined => {
  const f = markFile(deps);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as BackupMark) : undefined;
};

const writeMark = (deps: BackupDeps, mark: BackupMark): void => {
  mkdirSync(markDir(deps), { recursive: true });
  writeFileSync(markFile(deps), `${JSON.stringify(mark)}\n`);
};

const hhmm = (m: number): string => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// one tick of the loop: nothing, a deferral (busy), the day's skip, or the push
export const backupTick = async (deps: BackupDeps, dirs: readonly string[]): Promise<string[]> => {
  const step = backupStep(deps.now(), deps.timeZone, deps.backup, readMark(deps));
  if (step.kind === "none") return [];
  if (step.kind === "skip") {
    writeMark(deps, { day: step.day, slot: -1, skipped: true });
    return [`STATE_GIT_PUSH_SKIP ${step.day} no quiet moment from ${deps.backup.at} to ${deps.backup.until} ${deps.timeZone}: no backup today`];
  }
  const busy = await deps.busy();
  if (busy.length) {
    writeMark(deps, { day: step.day, slot: step.slot });
    const next = minutes(deps.backup.at) + (step.slot + 1) * deps.backup.retryMin;
    return [`STATE_GIT_PUSH_DEFER ${step.day} ${hhmm(localClock(deps.now(), deps.timeZone).min)} busy: ${busy.join(", ")}; ${next <= minutes(deps.backup.until) ? `next try ${hhmm(next)}` : "no try left today"}`];
  }
  const lines = await pushAll(deps, dirs);
  writeMark(deps, { day: step.day, slot: step.slot, done: true });
  return lines;
};

// the env files directly in a directory (dori.env, discord.env, kakao.env, their .bak copies)
export const envFilesIn = (dir: string): string[] => {
  try {
    return readdirSync(dir)
      .filter((n) => /(^|\.)env($|\.)/.test(n))
      .map((n) => join(dir, n))
      .filter((f) => statSync(f).isFile());
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return [];
    throw e;
  }
};

export const loadSecrets = (secretFiles: readonly string[], messageFiles: readonly string[], ownerIds: readonly string[], minChars: number, extra: readonly { readonly value: string; readonly from: string }[]): Secrets => {
  const values = new Map<string, string>(extra.map((e) => [e.value, e.from]));
  for (const f of new Set(secretFiles)) {
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf8");
    for (const v of [...envSecrets(text), ...shapedSecrets(text)]) if (!values.has(v)) values.set(v, f);
  }
  const ownerTexts = new Set<string>();
  for (const f of new Set(messageFiles)) {
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf8");
    for (const v of shapedSecrets(text)) if (!values.has(v)) values.set(v, f);
    for (const m of ownerMessages(text, ownerIds, minChars)) ownerTexts.add(m);
  }
  return { values: [...values].map(([value, from]) => ({ value, from })), ownerTexts: [...ownerTexts] };
};

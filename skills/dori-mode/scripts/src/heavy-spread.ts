import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

import type { HeavyHelper } from "./config.ts";
import { newJobDir, onStop, stopWithCaller, TarError, unpackFrom } from "./heavy-job.ts";
import { canScope, spawnScoped } from "./heavy-mem.ts";
import { linesOf, type HeavyCtx } from "./heavy-queue.ts";
import { acquire, admitOnce, releaseSlot } from "./heavy-slot.ts";

// dori heavy <label> --kind cpu|browser|gpu --sync PATH... -- <cmd>: a lane's own command (a browser test, a build) runs on
// the less busy PC. When this host is more than SPREAD_MARGIN points busier than a helper, the helper runs it; else it
// waits for this host's heavy slots as before, and a helper still takes it when this host refuses it (load, headroom,
// full slots). On the helper the command runs in a bwrap box: the --sync paths (shipped as tar) are mounted at the same
// absolute paths, so the command and its arguments work unchanged; /home and /tmp are empty, the system is read-only,
// there is no network, and only the job's own folder is writable. Its stdout and stderr stream back live, the files it
// made or changed under the --sync paths are copied back to the same paths here, and its exit code is the exit code.
// Owner 2026-11-01 14:44 KST: "모든 도리들도 리소스 이렇게 분할해서 쓸수있게 해".

export const KINDS = ["cpu", "browser", "gpu"] as const;
export type Kind = (typeof KINDS)[number];
export const isKind = (s: string): s is Kind => (KINDS as readonly string[]).includes(s);

// percentage points this host must be busier than a helper before a job leaves for it (a short job is not worth the trip
// when both are about as busy)
export const SPREAD_MARGIN = 15;
// seconds a cpu or browser job needs before its load shows, so the next one may start beside it under the headroom rule
// (heavySettleSec, 120 by default, is for GPU jobs that load a model; browser tests often end before it)
export const QUICK_SETTLE_SEC = 20;
const settleFor = (kind: Kind): number | undefined => (kind === "gpu" ? undefined : QUICK_SETTLE_SEC);
// files a helper run may send back; more and nothing comes back (the run then exits 70)
export const BACK_MAX_BYTES = 4 * 1024 ** 3;
const BACK_TOO_BIG_EXIT = 70;

const NAME = /^[\w.-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_]\w{0,63}$/;
// paths a command may name that are the same on every host (read-only in the box)
const SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt", "/proc", "/dev", "/sys"];

export const within = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

export type SpreadJob = {
  readonly label: string;
  readonly kind: Kind;
  readonly cmd: readonly string[];
  readonly cwd: string;
  readonly sync: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly needBytes?: number;
};
export type Plan = { readonly ok: true; readonly sync: readonly string[]; readonly playwright?: string } | { readonly ok: false; readonly why: string };

// A bash -c script whose pipeline ends in tail, grep or head exits with that last command's code, so a failing test run
// piped into tail looked like a pass (2026-11-02: 171 of 744 failed on the helper, HEAVY_DONE exit 0). The script that pipes
// and does not set pipefail itself runs with set -o pipefail, so any failing stage fails the job; anything else is unchanged.
export const withPipefail = (cmd: readonly string[]): readonly string[] => {
  if (basename(cmd[0] ?? "") !== "bash" || cmd.some((a) => a.includes("pipefail"))) return cmd;
  let sawC = false;
  for (let i = 1; i < cmd.length; i++) {
    const a = cmd[i]!;
    if (/^[-+][oO]$/.test(a)) {
      i++;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(a)) {
      sawC ||= a.includes("c");
      continue;
    }
    if (a === "--" || a.startsWith("--")) continue;
    if (!sawC || !/(?:^|[^|])\|(?!\|)/.test(a)) return cmd;
    return [...cmd.slice(0, i), `set -o pipefail; ${a}`, ...cmd.slice(i + 1)];
  }
  return cmd;
};

// absolute paths inside one argument: the whole argument, or what follows = , or : (not the // of a URL)
export const pathsIn = (arg: string): string[] => [...arg.matchAll(/(?:^|[=,:])(\/(?!\/)[^\s=,:;"'\]}]*)/g)].map((m) => normalize(m[1]!));

const nearestExisting = (p: string): string => {
  let at = p;
  while (!existsSync(at) && at !== "/") at = dirname(at);
  return at;
};

// symlinks in a synced folder: [link, absolute target]
const linksIn = (root: string): [string, string][] => {
  const p = Bun.spawnSync(["find", root, "-type", "l", "-printf", "%p\\0%l\\0"]);
  const parts = p.stdout.toString().split("\0");
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const link = parts[i]!;
    const to = parts[i + 1]!;
    out.push([link, normalize(isAbsolute(to) ? to : resolve(dirname(link), to))]);
  }
  return out;
};

const playwrightVersion = (roots: readonly string[]): string | undefined => {
  for (const r of roots) {
    for (const f of [join(r, "node_modules", "playwright-core", "package.json"), join(r, "playwright-core", "package.json")]) {
      try {
        const v = (JSON.parse(readFileSync(f, "utf8")) as { version?: unknown }).version;
        if (typeof v === "string" && /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(v)) return v;
      } catch {
        // not here
      }
    }
  }
  return undefined;
};

// the git checkout a folder is in, or undefined
const gitTop = (dir: string): string | undefined => {
  const p = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
  const top = p.exitCode === 0 ? p.stdout.toString().trim() : "";
  return top && isAbsolute(top) ? normalize(top) : undefined;
};

// STAY_FILE in the working folder or a folder above it up to `root`: its first line says why the job runs here only
export const STAY_FILE = ".dori-heavy-local";
const stayHere = (cwd: string, root: string): string | undefined => {
  for (let at = cwd; ; at = dirname(at)) {
    const f = join(at, STAY_FILE);
    if (existsSync(f)) return `${f}: ${readFileSync(f, "utf8").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? "runs here only"}`;
    if (at === root || !within(at, root) || at === "/") return undefined;
  }
};

// Whether the job can run on another host unchanged: every path it needs travels with --sync, and every --sync path is
// this account's own (its home or /tmp, owned by it, no link on the way, no ..). Anything else runs here (HEAVY_LOCAL).
export const spreadPlan = (job: SpreadJob, who: { readonly uid: number; readonly home: string }): Plan => {
  const no = (why: string): Plan => ({ ok: false, why });
  if (!job.sync.length) return no("no --sync path (the command's folder travels only with --sync)");
  const roots: string[] = [];
  for (const raw of job.sync) {
    if (!isAbsolute(raw) || raw.split("/").includes("..")) return no(`--sync ${raw} must be an absolute path without ..`);
    const p = normalize(raw).replace(/(.)\/$/, "$1");
    if (!within(p, who.home) && !within(p, "/tmp") || p === who.home || p === "/tmp") return no(`--sync ${p} must be a folder or file inside your home or /tmp`);
    const at = nearestExisting(p);
    if (realpathSync(at) !== at) return no(`--sync ${p} goes through a link (${at} is ${realpathSync(at)}); give the real path`);
    if (at === p) {
      const st = lstatSync(p);
      if (st.uid !== who.uid) return no(`--sync ${p} belongs to another account`);
      if (!st.isDirectory() && !st.isFile()) return no(`--sync ${p} is not a folder or a file`);
    }
    roots.push(p);
  }
  // a path inside another --sync path travels with it
  const sync = [...new Set(roots)].sort((a, b) => a.length - b.length).filter((p, i, all) => !all.slice(0, i).some((q) => within(p, q)));
  const covered = (p: string): boolean => sync.some((s) => within(p, s)) || SYSTEM.some((s) => within(p, s));
  if (!sync.some((s) => within(job.cwd, s))) return no(`the working folder ${job.cwd} is not in a --sync path`);
  // a test run reads its whole checkout (docs, fixtures, sibling folders) by relative path, which no argument names: a
  // checkout synced in part fails on the helper and passes here (2026-11-02: scripts/ only, 171 of 744 failed there)
  const top = gitTop(job.cwd);
  if (top && top !== who.home && (within(top, who.home) || within(top, "/tmp")) && !sync.some((s) => within(top, s))) return no(`the working folder is in the git checkout ${top}, which --sync carries only in part (its tests read the rest); add --sync ${top}`);
  // a folder that says it must run here (its tests start boxes and systemd scopes themselves, which a helper's box cannot)
  const stay = stayHere(job.cwd, top ?? sync.find((s) => within(job.cwd, s))!);
  if (stay) return no(stay);
  for (const arg of job.cmd) for (const p of pathsIn(arg)) if (!covered(p)) return no(`${p} (in "${arg.slice(0, 80)}") is not in a --sync path`);
  for (const s of sync) {
    if (!existsSync(s) || !statSync(s).isDirectory()) continue;
    for (const [link, to] of linksIn(s)) if (existsSync(to) && !covered(to)) return no(`the link ${link} points to ${to}, which is not in a --sync path (add it with --sync)`);
  }
  const playwright = job.kind === "browser" ? playwrightVersion(sync.filter((s) => existsSync(s))) : undefined;
  return { ok: true, sync, ...(playwright ? { playwright } : {}) };
};

// how busy this host is for a job of this kind, in percent (gpu: the GPU or the CPU, whichever is busier)
export const busyOf = async (ctx: HeavyCtx, kind: Kind): Promise<number> => {
  const s = await ctx.deps.headroom?.usage([]);
  if (!s) return 0;
  return Math.round(kind === "gpu" ? Math.max(s.host.gpu ?? 0, s.host.cpu) : s.host.cpu);
};

// Copies the files a helper run sent back (unpacked under back/) to the same paths here: regular files inside a --sync
// path only, never through a link here that leads out of the --sync paths, never onto a link.
export const copyBack = (back: string, sync: readonly string[]): { files: number; bytes: number; skipped: number } => {
  const n = { files: 0, bytes: 0, skipped: 0 };
  const inSync = (p: string) => sync.some((s) => within(p, s));
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(back, rel), { withFileTypes: true })) {
      const r = join(rel, e.name);
      if (e.isDirectory()) {
        walk(r);
        continue;
      }
      const to = `/${r}`;
      if (!e.isFile() || !inSync(to)) {
        n.skipped++;
        continue;
      }
      const at = nearestExisting(dirname(to));
      const real = realpathSync(at);
      if ((real !== at && !inSync(real)) || (existsSync(to) && lstatSync(to).isSymbolicLink())) {
        n.skipped++;
        continue;
      }
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(join(back, r), to);
      n.files++;
      n.bytes += statSync(to).size;
    }
  };
  walk("");
  return n;
};

type Sink = { write(chunk: Uint8Array): number | Promise<number>; flush(): number | Promise<number>; end(): number | Promise<number> };

// the job (job.json) and the --sync paths that exist, as one tar into the helper's stdin; the bytes sent
const sendTar = async (sink: Sink, job: SpreadJob, sync: readonly string[]): Promise<number> => {
  const tmp = mkdtempSync(join(tmpdir(), "dori-spread-"));
  try {
    writeFileSync(join(tmp, "job.json"), JSON.stringify({ argv: job.cmd, cwd: job.cwd, sync, env: job.env }));
    const have = sync.filter((s) => existsSync(s)).map((s) => s.slice(1));
    const tar = Bun.spawn(["tar", "-cf", "-", "-C", tmp, "job.json", ...(have.length ? ["-C", "/", ...have] : [])], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let bytes = 0;
    for await (const chunk of tar.stdout) {
      bytes += chunk.byteLength;
      sink.write(chunk);
      await sink.flush();
    }
    await sink.end();
    const code = await tar.exited;
    if (code !== 0) throw new TarError(`tar -c exited ${code}: ${(await new Response(tar.stderr).text()).trim().slice(0, 200)}`);
    return bytes;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

type Started = { readonly helper: string; readonly done: Promise<number | null> };
type HelperTry = { readonly kind: "started"; readonly run: Started } | { readonly kind: "busy" | "down" | "refused"; readonly why: string };
const VERDICT = /^WORKER_(ADMIT|BUSY|REFUSED)\b ?(.*)$/;

const startExec = async (ctx: HeavyCtx, h: HeavyHelper, job: SpreadJob, plan: Extract<Plan, { ok: true }>, below: number): Promise<HelperTry> => {
  const args = ["exec", job.label, job.kind, String(Math.max(0, Math.min(100, Math.floor(below)))), ...(plan.playwright ? [`playwright=${plan.playwright}`] : []), ...(job.needBytes ? [`mem=${Math.round(job.needBytes)}`] : [])];
  const p = Bun.spawn([...h.ssh, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const lines = linesOf(p.stderr);
  let verdict: RegExpExecArray | null = null;
  let last = "";
  for (let n = await lines.next(); !n.done; n = await lines.next()) {
    verdict = VERDICT.exec(n.value);
    if (verdict) break;
    last = n.value;
    process.stderr.write(`${n.value}\n`);
  }
  if (verdict?.[1] !== "ADMIT") {
    await p.stdin.end();
    const code = await p.exited;
    if (!verdict) return { kind: "down", why: last || `ssh exited ${code}` };
    return { kind: verdict[1] === "BUSY" ? "busy" : "refused", why: verdict[2] ?? "" };
  }
  const stop = onStop(() => p.kill("SIGKILL"));
  let exit: number | undefined;
  let tooBig = false;
  // O <line>: the command's stdout, E <line>: its stderr, WORKER_EXIT <code> at the end, anything else: the helper's lines
  const forward = (async () => {
    for (let n = await lines.next(); !n.done; n = await lines.next()) {
      const l = n.value;
      if (l.startsWith("O ")) process.stdout.write(`${l.slice(2)}\n`);
      else if (l.startsWith("E ")) process.stderr.write(`${l.slice(2)}\n`);
      else if (/^WORKER_EXIT \d+$/.test(l)) exit = Number(l.slice(12));
      else {
        if (l.startsWith("WORKER_BACK_TOO_BIG")) tooBig = true;
        process.stderr.write(`${l}\n`);
      }
    }
  })();
  mkdirSync(ctx.deps.dir, { recursive: true });
  const back = mkdtempSync(join(ctx.deps.dir, "back-"));
  const untar = Bun.spawn(["tar", "-C", back, "--no-same-owner", "-xf", "-"], { stdin: p.stdout, stdout: "ignore", stderr: "pipe" });
  let sent = -1;
  try {
    sent = await sendTar(p.stdin, job, plan.sync);
  } catch (e) {
    ctx.deps.log?.(`HEAVY_SPREAD_SEND ${job.label} ${h.name}: ${String(e).slice(0, 200)}`);
    p.kill("SIGKILL");
  }
  const done = (async (): Promise<number | null> => {
    const [code, ucode] = await Promise.all([p.exited, untar.exited]);
    await forward;
    stop();
    try {
      if (sent < 0 || code !== 0 || exit === undefined || ucode !== 0) return null;
      const n = copyBack(back, plan.sync);
      ctx.deps.log?.(`HEAVY_BACK ${job.label} ${h.name}: sent ${sent} bytes, ${n.files} file(s) ${n.bytes} bytes back${n.skipped ? `, ${n.skipped} skipped (outside --sync or through a link)` : ""}`);
      return tooBig && exit === 0 ? BACK_TOO_BIG_EXIT : exit;
    } finally {
      rmSync(back, { recursive: true, force: true });
    }
  })();
  return { kind: "started", run: { helper: h.name, done } };
};

export type SpreadResult = { readonly slot: string } | { readonly code: number };

// The caller's side: a helper's exit code, or this host's heavy slot when the job is to run here after all.
export const heavySpread = async (ctx: HeavyCtx, job: SpreadJob, plan: Extract<Plan, { ok: true }>): Promise<SpreadResult> => {
  const log = (line: string) => ctx.deps.log?.(line);
  const seen = new Map<string, string>();
  const helpers = async (below: number, why: string): Promise<Started | null> => {
    for (const h of ctx.q.helpers) {
      const t = await startExec(ctx, h, job, plan, below);
      if (t.kind === "started") {
        seen.delete(h.name);
        log(`HEAVY_SPREAD ${job.label} ${h.name}: ${why}`);
        return t.run;
      }
      if (seen.get(h.name) !== `${t.kind} ${t.why}`) log(`HEAVY_HELPER_${t.kind.toUpperCase()} ${job.label} ${h.name}: ${t.why}`);
      seen.set(h.name, `${t.kind} ${t.why}`);
    }
    return null;
  };
  const busy = await busyOf(ctx, job.kind);
  let run = busy > SPREAD_MARGIN ? await helpers(busy - SPREAD_MARGIN, `this host is ${busy}% busy (${job.kind}), the helper less than ${busy - SPREAD_MARGIN}%`) : null;
  const since = ctx.deps.clock.now();
  for (;;) {
    if (!run) {
      const got = await acquire<Started>(ctx.deps, job.label, { since, elsewhere: (why) => helpers(100, why), elsewhereWhileSettling: true, ...(settleFor(job.kind) ? { settleSec: settleFor(job.kind) } : {}), ...(job.needBytes ? { memKb: job.needBytes / 1024 } : {}) });
      if ("slot" in got) return { slot: got.slot };
      run = got.elsewhere;
    }
    const code = await run.done;
    if (code !== null) {
      log(`HEAVY_DONE ${job.label} ${run.helper}: exit ${code}`);
      return { code };
    }
    log(`HEAVY_HELPER_CUT ${job.label} ${run.helper}: the run broke off; nothing came back, the job goes back to the line`);
    run = null;
    await ctx.deps.clock.sleep(15_000);
  }
};

// ---- the helper's side: dori heavy-worker "exec <label> <kind> <below> [playwright=<version>] [mem=<bytes>]"

type ExecSpec = { readonly argv: string[]; readonly cwd: string; readonly sync: string[]; readonly env: Record<string, string> };

export const specProblem = (x: unknown): string | ExecSpec => {
  const s = x as Partial<ExecSpec> | null;
  if (!s || typeof s !== "object") return "job.json is not an object";
  if (!Array.isArray(s.argv) || !s.argv.length || !s.argv.every((a) => typeof a === "string")) return "argv must be a non-empty list of strings";
  const absOk = (p: unknown): p is string => typeof p === "string" && isAbsolute(p) && !p.split("/").includes("..") && normalize(p) === p;
  if (!Array.isArray(s.sync) || !s.sync.length || !s.sync.every((p) => absOk(p) && (p.startsWith("/home/") || p.startsWith("/tmp/")))) return "sync must be absolute paths under /home/ or /tmp/ without ..";
  if (!absOk(s.cwd) || !s.sync.some((p) => within(s.cwd as string, p))) return "cwd must be inside a sync path";
  if (!s.env || typeof s.env !== "object" || !Object.entries(s.env).every(([k, v]) => ENV_NAME.test(k) && typeof v === "string")) return "env must map variable names to strings";
  return s as ExecSpec;
};

export type BoxTools = { readonly bunDir?: string; readonly browsersDir?: string; readonly toolsDir?: string };
export const BOX_TOOLS = "/run/dori-tools";

// the bwrap argv for one run: from = where each --sync path's copy lives in the job folder
export const sandboxArgv = (kind: Kind, spec: ExecSpec, from: (p: string) => string, tools: BoxTools): string[] => {
  const ro = (src: string | undefined, name: string): string[] => (src && existsSync(src) ? ["--ro-bind", src, `${BOX_TOOLS}/${name}`] : []);
  const env: Record<string, string> = {
    PATH: `${BOX_TOOLS}/bun:${BOX_TOOLS}/tools/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: "/tmp/home",
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    ...(tools.browsersDir && existsSync(tools.browsersDir) ? { PLAYWRIGHT_BROWSERS_PATH: `${BOX_TOOLS}/ms-playwright` } : {}),
    ...spec.env,
  };
  return [
    "bwrap",
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--ro-bind", "/", "/",
    ...(kind === "gpu" ? ["--dev-bind", "/dev", "/dev"] : ["--dev", "/dev"]),
    "--proc", "/proc",
    "--tmpfs", "/home",
    "--tmpfs", "/tmp",
    "--tmpfs", "/var/tmp",
    "--tmpfs", "/run",
    ...ro(tools.bunDir, "bun"),
    ...ro(tools.browsersDir, "ms-playwright"),
    ...ro(tools.toolsDir, "tools"),
    "--dir", "/tmp/home",
    ...[...spec.sync].sort((a, b) => a.length - b.length).flatMap((p) => ["--bind", from(p), p]),
    // the empty /home, /var/tmp and /run are read-only too: the job writes only its own --sync copies and /tmp
    "--remount-ro", "/home",
    "--remount-ro", "/var/tmp",
    "--remount-ro", "/run",
    "--chdir", spec.cwd,
    "--clearenv",
    ...Object.entries(env).flatMap(([k, v]) => ["--setenv", k, v]),
    "--",
    ...spec.argv,
  ];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// the browsers of the caller's playwright version, installed once into this host's own cache (user space, no sudo)
const ensurePlaywright = async (version: string, browsersDir: string, log: (l: string) => void): Promise<void> => {
  const mark = join(browsersDir, `.dori-playwright-${version}`);
  if (existsSync(mark)) return;
  mkdirSync(browsersDir, { recursive: true });
  const lock = join(browsersDir, ".dori-playwright-lock");
  for (let waited = 0; ; waited += 2_000) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (existsSync(mark)) return;
      if (waited > 20 * 60_000 || Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0) > 20 * 60_000) rmSync(lock, { recursive: true, force: true });
      await sleep(2_000);
    }
  }
  try {
    if (existsSync(mark)) return;
    log(`HEAVY_PW_INSTALL playwright ${version} browsers into ${browsersDir}`);
    const p = Bun.spawn([process.execPath, "x", `playwright@${version}`, "install", "chromium", "ffmpeg"], { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersDir, PLAYWRIGHT_SKIP_BROWSER_GC: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const pump = async (s: ReadableStream<Uint8Array>) => {
      for await (const l of linesOf(s)) process.stderr.write(`W ${l}\n`);
    };
    const [code] = await Promise.all([p.exited, pump(p.stdout), pump(p.stderr)]);
    if (code === 0) writeFileSync(mark, new Date().toISOString());
    else log(`HEAVY_PW_FAIL playwright ${version}: install exited ${code}; the run goes on and its browser may be missing`);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
};

const duBytes = (p: string): number => Number(Bun.spawnSync(["du", "-sb", p]).stdout.toString().split(/\s/)[0]) || 0;

export type ExecDeps = { readonly refuse: (label: string, why: string) => number; readonly caller: string; readonly tools: BoxTools; readonly maxMin: number };

export const heavyExec = async (ctx: HeavyCtx, words: readonly string[], d: ExecDeps): Promise<number> => {
  const [label = "", kind = "", belowS = "", ...opts] = words;
  if (!NAME.test(label)) return d.refuse("-", `label "${label}" must be letters, digits, . _ -`);
  if (!isKind(kind)) return d.refuse(label, `kind "${kind}" is not cpu, browser or gpu`);
  if (!/^\d{1,3}$/.test(belowS) || Number(belowS) > 100) return d.refuse(label, `"${belowS}" is not a busy percent`);
  const bad = opts.find((o) => !/^playwright=\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(o) && !/^mem=\d{1,15}$/.test(o));
  if (bad !== undefined) return d.refuse(label, `unknown option "${bad}"`);
  if (!ctx.q.exec) return d.refuse(label, "exec is off on this host (heavyQueue.exec)");
  if (!Bun.which("bwrap")) return d.refuse(label, "no bwrap on this host");
  const noScope = await canScope();
  if (noScope) return d.refuse(label, `no memory/CPU/time caps here: ${noScope}`);
  const playwright = opts.find((o) => o.startsWith("playwright="))?.slice("playwright=".length);
  const mem = Number(opts.find((o) => o.startsWith("mem="))?.slice(4)) || undefined;
  const below = Number(belowS);
  if (below < 100) {
    const b = await busyOf(ctx, kind);
    if (b >= below) {
      console.error(`WORKER_BUSY this host is ${b}% busy (${kind}), not under ${below}%`);
      return 75;
    }
  }
  const t = await admitOnce(ctx.deps, label, settleFor(kind));
  if (!t || !("slot" in t)) {
    console.error(`WORKER_BUSY ${t?.why ?? "another job is being admitted"}`);
    return 75;
  }
  const log = (l: string) => ctx.deps.log?.(l);
  log(`HEAVY_WORKER_ADMIT ${label} exec ${kind} ${basename(t.slot)} caller=${d.caller}: ${t.why}`);
  console.error(`WORKER_ADMIT ${basename(t.slot)}`);
  stopWithCaller(true);
  const dir = newJobDir(join(ctx.deps.dir, "exec"));
  const forget = onStop(() => {
    rmSync(dir, { recursive: true, force: true });
    releaseSlot(t.slot);
  });
  const root = join(dir, "in");
  let cmdName = "-";
  let inBytes = 0;
  try {
    await unpackFrom("inherit", root);
    inBytes = duBytes(root);
    let raw: unknown = null;
    try {
      raw = JSON.parse(readFileSync(join(root, "job.json"), "utf8"));
    } catch {
      raw = null;
    }
    rmSync(join(root, "job.json"), { force: true });
    const spec = specProblem(raw);
    if (typeof spec === "string") {
      log(`HEAVY_EXEC_BAD ${label} caller=${d.caller}: ${spec}`);
      console.error(`WORKER_REFUSED ${spec}`);
      return 3;
    }
    cmdName = basename(spec.argv[0]!);
    for (const p of spec.sync) if (!existsSync(join(root, p))) mkdirSync(join(root, p), { recursive: true });
    if (playwright && kind === "browser" && d.tools.browsersDir) await ensurePlaywright(playwright, d.tools.browsersDir, log);
    const start = join(dir, "start");
    writeFileSync(start, "");
    const pumps: Promise<void>[] = [];
    const ncpu = Math.max(1, cpus().length);
    const code = await spawnScoped(
      { label, cmd: sandboxArgv(kind, spec, (p) => join(root, p), d.tools), free: ctx.deps.headroom?.free ?? 10, ...(mem ? { needBytes: mem } : {}), props: [`CPUQuota=${ncpu * 90}%`, `RuntimeMaxSec=${d.maxMin * 60}`], log },
      { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      (_pid, proc) => {
        const pump = async (s: ReadableStream<Uint8Array> | undefined, tag: string) => {
          if (!s) return;
          for await (const l of linesOf(s)) process.stderr.write(`${tag} ${l}\n`);
        };
        pumps.push(pump(proc.stdout as ReadableStream<Uint8Array> | undefined, "O"), pump(proc.stderr as ReadableStream<Uint8Array> | undefined, "E"));
      },
    );
    await Promise.all(pumps);
    // the files the run made or changed (regular files only), as tar on stdout
    const list = join(dir, "back.list");
    const found = Bun.spawnSync(["find", root, "-newer", start, "-type", "f", "-printf", "%P\\0"]);
    writeFileSync(list, found.stdout);
    const names = found.stdout.toString().split("\0").filter(Boolean);
    const backBytes = names.reduce((a, n) => a + (statSync(join(root, n), { throwIfNoEntry: false })?.size ?? 0), 0);
    const tooBig = backBytes > BACK_MAX_BYTES;
    if (tooBig) {
      console.error(`WORKER_BACK_TOO_BIG ${backBytes} bytes changed, over ${BACK_MAX_BYTES}; nothing is sent back`);
      writeFileSync(list, "");
    }
    const tar = Bun.spawn(["tar", "-C", root, "--null", "--no-recursion", "-T", list, "-cf", "-"], { stdin: "ignore", stdout: "inherit", stderr: "pipe" });
    const tcode = await tar.exited;
    if (tcode !== 0) throw new TarError(`tar -c exited ${tcode}: ${(await new Response(tar.stderr).text()).trim().slice(0, 200)}`);
    console.error(`WORKER_EXIT ${code}`);
    log(`HEAVY_EXEC_DONE ${label} caller=${d.caller} cmd=${cmdName} in=${inBytes} back=${tooBig ? 0 : backBytes} exit=${code}`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    releaseSlot(t.slot);
    forget();
  }
};

export const defaultTools = (): BoxTools => ({
  bunDir: dirname(process.execPath),
  browsersDir: process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright"),
  toolsDir: join(homedir(), ".local", "share", "dori-heavy", "tools"),
});

import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { fill, type HeavyJob } from "./config.ts";
import { treeOf } from "./heavy-headroom.ts";
import { spawnScoped } from "./heavy-mem.ts";

// A dori heavy --job run lives in one folder: in/ (inputs, named <n>-<file> so their order survives a tar), out/ (result
// files), tmp/ (the job's TMPDIR), and after the run code and stdout. The same folder shape travels between hosts as tar.

export type JobRequest = { readonly label: string; readonly kind: string; readonly rl: boolean; readonly args: readonly string[] };
export type JobResult = { readonly code: number; readonly stdout: string };

const NAME = /^[\w.-]{1,64}$/;
// extra arguments cross ssh as one shell line on the other host: no characters a shell would read
const ARG = /^[\w.=:,+@%-]{1,128}$/;

export const requestProblem = (r: JobRequest): string | undefined =>
  !NAME.test(r.label) ? `label "${r.label}" must be letters, digits, . _ -` : !NAME.test(r.kind) ? `job "${r.kind}" must be letters, digits, . _ -` : r.args.find((a) => !ARG.test(a)) !== undefined ? `argument "${r.args.find((a) => !ARG.test(a))}" has characters a job argument may not have (letters, digits, . _ = : , + @ % -)` : undefined;

const undo = new Set<() => void>();
export const onStop = (f: () => void): (() => void) => {
  undo.add(f);
  return () => undo.delete(f);
};
const stopNow = (code: number): never => {
  for (const f of [...undo].reverse()) f();
  process.exit(code);
};

// SIGTERM/SIGINT/SIGHUP, and (watchParent) the parent going away: over ssh without a terminal the session ends without a
// signal, so a parent that changed means the caller is gone
export const stopWithCaller = (watchParent: boolean): void => {
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => stopNow(143));
  if (!watchParent) return;
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) stopNow(141);
  }, 2_000).unref();
};

export const killTree = (pid: number): void => {
  const ps = Bun.spawnSync(["ps", "-eo", "pid=,ppid=,rss=,pcpu="]).stdout.toString();
  for (const p of treeOf(ps, pid).pids.reverse()) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      // already gone
    }
  }
};

export const newJobDir = (root: string): string => {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(root, `${process.pid}-`));
  for (const d of ["in", "out", "tmp"]) mkdirSync(join(dir, d), { mode: 0o700 });
  return dir;
};

export const stageInputs = (dir: string, files: readonly string[]): void =>
  files.forEach((f, i) => copyFileSync(f, join(dir, "in", `${i}-${basename(f)}`)));

// job folders under root whose process died (a job killed hard leaves its folder behind)
export const sweepJobDirs = (root: string, alive: (pid: number) => boolean): number => {
  if (!existsSync(root)) return 0;
  let n = 0;
  for (const name of readdirSync(root)) {
    if (alive(Number(name.split("-")[0]))) continue;
    rmSync(join(root, name), { recursive: true, force: true });
    n++;
  }
  return n;
};

const inputs = (dir: string): string[] =>
  readdirSync(join(dir, "in"))
    .filter((n) => /^\d+-/.test(n))
    .sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]));

// the job runs in its own memory-capped scope (heavy-mem.ts): free is heavyHeadroomPct, log the heavy log; a job of the
// GPU line gets gpuFreeKb of free memory made first (heavy-mem.ts gpuRoom)
export type JobRun = { readonly label: string; readonly free: number; readonly log?: (line: string) => void; readonly gpuFreeKb?: number };

export const runJob = async (job: HeavyJob, dir: string, args: readonly string[], scope: JobRun = { label: "job", free: 10 }): Promise<JobResult> => {
  const values: Record<string, string> = { in: join(dir, "in"), out: join(dir, "out") };
  inputs(dir).forEach((n, i) => (values[`in${i}`] = join(dir, "in", n)));
  const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? "/", LANG: process.env.LANG ?? "C.UTF-8", TMPDIR: join(dir, "tmp"), ...job.env };
  let forget = () => {};
  const code = await spawnScoped({ ...scope, cmd: [...fill(job.argv, values), ...args] }, { cwd: dir, env, stdin: "ignore", stdout: Bun.file(join(dir, "stdout")), stderr: "inherit" }, (pid) => {
    const f = onStop(() => killTree(pid));
    forget = () => void f();
  });
  forget();
  writeFileSync(join(dir, "code"), String(code));
  return readResult(dir);
};

export const readResult = (dir: string): JobResult => ({ code: Number(readFileSync(join(dir, "code"), "utf8")), stdout: existsSync(join(dir, "stdout")) ? readFileSync(join(dir, "stdout"), "utf8") : "" });

export class TarError extends Error {}

export const packTo = async (dir: string, entries: readonly string[], to: "inherit" | "pipe"): Promise<Uint8Array> => {
  const p = Bun.spawn(["tar", "-C", dir, "-cf", "-", ...entries], { stdin: "ignore", stdout: to, stderr: "pipe" });
  const bytes = to === "pipe" ? new Uint8Array(await new Response(p.stdout).arrayBuffer()) : new Uint8Array();
  const code = await p.exited;
  if (code !== 0) throw new TarError(`tar -c exited ${code}: ${(await new Response(p.stderr).text()).trim().slice(0, 200)}`);
  return bytes;
};

export const unpackFrom = async (from: "inherit" | Uint8Array, dir: string): Promise<void> => {
  const p = Bun.spawn(["tar", "-C", dir, "--no-same-owner", "-xf", "-"], { stdin: from, stdout: "ignore", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) throw new TarError(`tar -x exited ${code}: ${(await new Response(p.stderr).text()).trim().slice(0, 200)}`);
};

export const RESULT_ENTRIES = ["code", "stdout", "out"] as const;

export const deliverOut = (dir: string, outDir: string | undefined): void => {
  if (!outDir || !readdirSync(join(dir, "out")).length) return;
  mkdirSync(outDir, { recursive: true });
  cpSync(join(dir, "out"), outDir, { recursive: true });
};

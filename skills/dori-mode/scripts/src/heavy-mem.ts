import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";

// 2026-10-30 02:33 UTC on a GB10 host: a lane ran `dori heavy asr-nemo-smoke -- python ...` (a 67.5 GB model) from its own
// omo process. The job ran in the lane's aoe-session scope, the host ran out of memory, the kernel killed the python, and
// systemd (DefaultOOMPolicy=stop) then stopped that whole scope: the lane's omo died with its job (pane dead, status 143).
// So every heavy job runs in its own systemd user scope: a MemoryMax (no swap) caps it, an OOM kill there stops only that
// scope, and a raised oom_score_adj makes the kernel pick the job before the lane or a host service on a host-wide OOM.

export const JOB_OOM_SCORE_ADJ = 500;
// the smallest MemoryMax a job gets when it gave no estimate and the host is nearly full
const MIN_LIMIT_BYTES = 512 * 1024 ** 2;

const UNITS: Record<string, number> = { "": 1, B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

// "70G", "200M", "1.5T", "512K", plain bytes; undefined for anything else
export const parseMem = (s: string): number | undefined => {
  const m = /^(\d+(?:\.\d+)?)\s*([KMGT]?)(?:i?B)?$/i.exec(s.trim());
  if (!m) return undefined;
  const bytes = Math.round(Number(m[1]) * (UNITS[(m[2] ?? "").toUpperCase()] ?? NaN));
  return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
};

export const fmtMem = (bytes: number): string => (bytes >= 1024 ** 4 ? `${(bytes / 1024 ** 4).toFixed(1)}T` : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)}G` : `${Math.round(bytes / 1024 ** 2)}M`);

export type MemInfo = { readonly totalKb: number; readonly availKb: number };

export const parseMeminfo = (text: string): MemInfo | undefined => {
  const kb = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(text)?.[1]);
  const totalKb = kb("MemTotal");
  const availKb = kb("MemAvailable");
  return totalKb > 0 && Number.isFinite(availKb) ? { totalKb, availKb } : undefined;
};

export const readMeminfo = (): MemInfo | undefined => {
  try {
    return parseMeminfo(readFileSync("/proc/meminfo", "utf8"));
  } catch {
    return undefined;
  }
};

// An estimate that can never fit on this host, even when nothing else runs: the job is refused at once instead of waiting.
export const neverFits = (needBytes: number, m: MemInfo, free: number): string | undefined =>
  needBytes / 1024 > m.totalKb * (1 - free / 100) ? `--mem ${fmtMem(needBytes)} never fits here: this host has ${fmtMem(m.totalKb * 1024)} and keeps ${free}% free` : undefined;

// Whether a job that says it needs needKb fits now: what is available, less what running jobs said they need and do not
// use yet (a model still loading), less the job's need, must keep `free` percent of the host's memory free.
export const memVerdict = (m: MemInfo, needKb: number, reservedKb: number, free: number): { readonly ok: boolean; readonly why: string } => {
  const leftKb = m.availKb - reservedKb - needKb;
  const leftPct = (100 * leftKb) / m.totalKb;
  const why = `memory: needs ${fmtMem(needKb * 1024)}, ${fmtMem(m.availKb * 1024)} available, ${fmtMem(reservedKb * 1024)} held for running jobs still loading -> ${Math.round(leftPct)}% free (needs ${free}% free)`;
  return { ok: leftPct >= free, why };
};

// The job's MemoryMax: its own estimate, else what keeps `free` percent of the host free when it starts.
export const scopeLimit = (m: MemInfo, free: number, needBytes?: number): number =>
  needBytes ?? Math.max(MIN_LIMIT_BYTES, Math.floor((m.availKb - (m.totalKb * free) / 100) * 1024));

// systemd unit names take letters, digits and : _ . - only. n numbers the jobs of one process: systemd drops a scope
// only some time after its process ends, so a second job of one label in one process (a job sent back from a helper, or
// started while the first still runs) under the same name was refused ("Unit ... was already loaded", 2026-11-02)
export const unitName = (label: string, pid: number, n: number): string => `dori-heavy-${label.replace(/[^\w.:-]/g, "_").slice(0, 64)}-${pid}-${n}`;
let scopes = 0;

export const scopeArgv = (unit: string, limitBytes: number, cmd: readonly string[], props: readonly string[] = []): string[] => [
  "systemd-run",
  "--user",
  "--scope",
  "--quiet",
  "--unit",
  unit,
  "-p",
  `MemoryMax=${limitBytes}`,
  "-p",
  "MemorySwapMax=0",
  ...props.flatMap((p) => ["-p", p]),
  "--",
  "/bin/sh",
  "-c",
  `echo ${JOB_OOM_SCORE_ADJ} > /proc/self/oom_score_adj 2>/dev/null; exec "$@"`,
  "dori-heavy-job",
  ...cmd,
];

// systemd-run --user needs the user manager's bus, found through XDG_RUNTIME_DIR (a job env may not carry it)
export const userBusEnv = (env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> => {
  const dir = env.XDG_RUNTIME_DIR || `/run/user/${userInfo().uid}`;
  return existsSync(dir) ? { XDG_RUNTIME_DIR: dir } : {};
};

// a user scope can be made here: Linux with a reachable systemd user manager
export const canScope = async (): Promise<string | undefined> => {
  if (process.platform !== "linux") return `no systemd on ${process.platform}`;
  if (!Bun.which("systemd-run")) return "no systemd-run";
  try {
    const p = Bun.spawn(["systemd-run", "--user", "--scope", "--quiet", "--", "true"], { env: { ...process.env, ...userBusEnv() }, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const code = await p.exited;
    return code === 0 ? undefined : `systemd-run --user failed (${code}): ${(await new Response(p.stderr).text()).trim().slice(0, 160)}`;
  } catch (e) {
    return `systemd-run --user failed: ${String(e).slice(0, 160)}`;
  }
};

// what systemd says ended the scope (oom-kill, exit-code, signal ...); a failed scope stays listed until reset-failed
const scopeResult = async (unit: string): Promise<string> => {
  const env = { ...process.env, ...userBusEnv() };
  const p = Bun.spawn(["systemctl", "--user", "show", "-p", "Result", "--value", `${unit}.scope`], { env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const result = (await new Response(p.stdout).text()).trim();
  await p.exited;
  await Bun.spawn(["systemctl", "--user", "reset-failed", `${unit}.scope`], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
  return result;
};

// props: more scope properties (CPUQuota=..., RuntimeMaxSec=...)
export type ScopedRun = { readonly label: string; readonly cmd: readonly string[]; readonly free: number; readonly needBytes?: number; readonly props?: readonly string[]; readonly log?: (line: string) => void };
type SpawnOpts = { cwd?: string; env?: Record<string, string | undefined>; stdin?: "inherit" | "ignore"; stdout?: "inherit" | "ignore" | "pipe" | ReturnType<typeof Bun.file>; stderr?: "inherit" | "ignore" | "pipe" };

// Starts a heavy command in its own scope (HEAVY_SCOPE) or, where no user scope can be made, as before (HEAVY_NO_SCOPE).
// Resolves with the command's exit code; HEAVY_OOM when the kernel killed it in its scope.
export const spawnScoped = async (r: ScopedRun, opts: SpawnOpts, onStart?: (pid: number, proc: Bun.Subprocess) => void): Promise<number> => {
  const m = readMeminfo();
  const no = m ? await canScope() : "no /proc/meminfo";
  const unit = unitName(r.label, process.pid, ++scopes);
  const limit = m ? scopeLimit(m, r.free, r.needBytes) : 0;
  if (no) r.log?.(`HEAVY_NO_SCOPE ${r.label}: ${no}; runs without a memory cap`);
  else r.log?.(`HEAVY_SCOPE ${r.label} ${unit}.scope MemoryMax=${fmtMem(limit)}${r.needBytes ? " (its --mem)" : ` (keeps ${r.free}% free now)`}`);
  const argv = no ? [...r.cmd] : scopeArgv(unit, limit, r.cmd, r.props);
  const env = no ? opts.env : { ...(opts.env ?? process.env), ...userBusEnv(opts.env ?? process.env) };
  const p = Bun.spawn(argv, { ...opts, ...(env ? { env } : {}) });
  onStart?.(p.pid, p);
  const code = await p.exited;
  if (!no && code !== 0) {
    const result = await scopeResult(unit);
    if (result === "oom-kill") r.log?.(`HEAVY_OOM ${r.label}: killed at MemoryMax=${fmtMem(limit)} in ${unit}.scope (exit ${code}); only the job stopped, the caller keeps running`);
  }
  return code;
};

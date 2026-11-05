import { cpus, loadavg } from "node:os";

import { parseMeminfo } from "./heavy-mem.ts";
import type { Runner } from "./run.ts";

// Percent used of each resource. gpu and gpuMem are null when the host has no GPU nvidia-smi can read; gpuMem is also null
// on a unified-memory GPU (GB10, Jetson: nvidia-smi reports memory as [N/A]), where GPU memory is system memory (mem).
export type Usage = { readonly gpu: number | null; readonly gpuMem: number | null; readonly cpu: number; readonly mem: number };
// memTotalKb: the host's memory (0 where /proc/meminfo is missing), so a job's memory estimate can be weighed in percent
export type UsageSample = { readonly host: Usage; readonly unified: boolean; readonly jobs: readonly Usage[]; readonly memTotalKb: number };

const RESOURCES = ["gpu", "gpuMem", "cpu", "mem"] as const;
type Resource = (typeof RESOURCES)[number];

const nameOf = (r: Resource, unified: boolean): string => (r === "gpuMem" ? "gpu-mem" : r === "mem" && unified ? "mem(unified)" : r);
const pct = (n: number): string => `${Math.round(n)}%`;

export type Verdict = { readonly ok: boolean; readonly short: readonly string[]; readonly detail: string };

// A new job fits when every measured resource keeps at least `free` percent free with it added. Its use is guessed from the
// heavy jobs running now: the largest use of each resource among them (a new eval looks like the evals already running).
// skip: resources weighed elsewhere (memory when the job gave its own --mem estimate)
export const headroomVerdict = (s: UsageSample, free: number, skip: readonly string[] = []): Verdict => {
  const short: string[] = [];
  const parts: string[] = [];
  for (const r of RESOURCES) {
    if (skip.includes(r)) continue;
    const used = s.host[r];
    if (used === null) continue;
    const est = Math.max(0, ...s.jobs.map((j) => j[r] ?? 0));
    const left = 100 - used - est;
    if (left < free) short.push(nameOf(r, s.unified));
    parts.push(`${nameOf(r, s.unified)} ${pct(used)}+${pct(est)} -> ${pct(left)} free`);
  }
  return { ok: short.length === 0, short, detail: `${parts.join(", ")} (needs ${free}% free each)` };
};

// nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits: one line per GPU
export const parseGpuQuery = (out: string): { util: number; memUsedMib: number | null; memTotalMib: number | null } | null => {
  const rows = out.split("\n").map((l) => l.split(",").map((c) => c.trim())).filter((c) => c.length >= 3 && c[0] !== "");
  const utils = rows.map((c) => Number(c[0])).filter(Number.isFinite);
  if (!utils.length) return null;
  const used = rows.map((c) => Number(c[1]));
  const total = rows.map((c) => Number(c[2]));
  const known = used.every(Number.isFinite) && total.every(Number.isFinite) && total.some((t) => t > 0);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return { util: sum(utils) / utils.length, memUsedMib: known ? sum(used) : null, memTotalMib: known ? sum(total) : null };
};

// nvidia-smi pmon -c 1 -s um: SM percent and framebuffer MiB per process, columns found by the header line
export const parsePmon = (out: string): Map<number, { sm: number; fbMib: number }> => {
  const lines = out.split("\n");
  const header = lines.find((l) => /^#\s*gpu\s/i.test(l))?.replace(/^#/, "").trim().split(/\s+/).map((h) => h.toLowerCase()) ?? [];
  const at = (h: string) => header.indexOf(h);
  const m = new Map<number, { sm: number; fbMib: number }>();
  if (at("pid") < 0) return m;
  for (const l of lines) {
    if (l.startsWith("#") || !l.trim()) continue;
    const c = l.trim().split(/\s+/);
    const pid = Number(c[at("pid")]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const num = (h: string) => (at(h) < 0 ? 0 : Number(c[at(h)]) || 0);
    const prev = m.get(pid) ?? { sm: 0, fbMib: 0 };
    m.set(pid, { sm: prev.sm + num("sm"), fbMib: prev.fbMib + num("fb") });
  }
  return m;
};

// ps -eo pid=,ppid=,rss=,pcpu=: every process under root (root included)
export const treeOf = (ps: string, root: number): { pids: number[]; rssKb: number; cpuPct: number } => {
  const rows = ps.split("\n").map((l) => l.trim().split(/\s+/).map(Number)).filter((c) => c.length >= 4 && Number.isInteger(c[0]));
  const kids = new Map<number, number[]>();
  for (const [pid, ppid] of rows) kids.set(ppid!, [...(kids.get(ppid!) ?? []), pid!]);
  const pids: number[] = [];
  const todo = [root];
  while (todo.length) {
    const p = todo.pop()!;
    if (pids.includes(p)) continue;
    pids.push(p);
    todo.push(...(kids.get(p) ?? []));
  }
  const own = rows.filter((c) => pids.includes(c[0]!));
  return { pids, rssKb: own.reduce((a, c) => a + (c[2] || 0), 0), cpuPct: own.reduce((a, c) => a + (c[3] || 0), 0) };
};

// What the host uses now and what each running heavy job (the process tree under its dori heavy pid) uses.
export const sampleUsage = async (run: Runner, jobPids: readonly number[]): Promise<UsageSample> => {
  const [q, pmon, ps, meminfo] = await Promise.all([
    run(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], { timeoutMs: 20_000 }),
    run(["nvidia-smi", "pmon", "-c", "1", "-s", "um"], { timeoutMs: 20_000 }),
    run(["ps", "-eo", "pid=,ppid=,rss=,pcpu="]),
    run(["cat", "/proc/meminfo"]),
  ]);
  const gpu = q.code === 0 ? parseGpuQuery(q.out) : null;
  const unified = gpu !== null && gpu.memTotalMib === null;
  const info = meminfo.code === 0 ? parseMeminfo(meminfo.out) : undefined;
  const memTotalKb = info?.totalKb ?? 0;
  const mem = info ? 100 * (1 - info.availKb / info.totalKb) : await macMemUsed(run);
  const ncpu = Math.max(1, cpus().length);
  const host: Usage = {
    gpu: gpu ? gpu.util : null,
    gpuMem: gpu && gpu.memTotalMib ? (100 * (gpu.memUsedMib ?? 0)) / gpu.memTotalMib : null,
    cpu: Math.min(100, (100 * (loadavg()[0] ?? 0)) / ncpu),
    mem,
  };
  const perPid = pmon.code === 0 ? parsePmon(pmon.out) : new Map<number, { sm: number; fbMib: number }>();
  const totalKb = memTotalKb || 1;
  const jobs = jobPids.map((root): Usage => {
    const t = treeOf(ps.out, root);
    const g = t.pids.map((p) => perPid.get(p)).filter((x) => x !== undefined);
    return {
      // without per-process readings (pmon unsupported) each running job is taken to use an equal share of the GPU
      gpu: host.gpu === null ? null : pmon.code === 0 ? g.reduce((a, x) => a + x.sm, 0) : host.gpu / jobPids.length,
      gpuMem: host.gpuMem === null || !gpu?.memTotalMib ? null : (100 * g.reduce((a, x) => a + x.fbMib, 0)) / gpu.memTotalMib,
      cpu: t.cpuPct / ncpu,
      mem: memTotalKb ? (100 * t.rssKb) / totalKb : 0,
    };
  });
  return { host, unified, jobs, memTotalKb };
};

// macOS: memory_pressure -Q prints the free percentage
const macMemUsed = async (run: Runner): Promise<number> => {
  const mp = await run(["memory_pressure", "-Q"]);
  const free = Number(/free percentage: (\d+)%/.exec(mp.out)?.[1]);
  return Number.isFinite(free) ? 100 - free : 0;
};

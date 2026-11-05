import type { Backend, GuardThresholds } from "./config.ts";
import { parseMeminfo } from "./heavy-mem.ts";
import { listPanes } from "./panes.ts";
import type { Runner } from "./run.ts";

export type HostSample = {
  readonly load1: number;
  // null: neither memory_pressure nor /proc/meminfo could be read, so memory is unknown and holds nothing
  readonly memFreePct: number | null;
  readonly diskFreeGb: number;
  readonly swapFreeGb: number;
  readonly panes: number;
};

const num = (s: string | undefined, fallback: number): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
};

// macOS: memory_pressure -Q; Linux: MemAvailable over MemTotal in /proc/meminfo, where memory_pressure is missing and
// memory used to read as 100% free (https://github.com/sisyphuslabs/dori-superagent/issues/90)
const sampleMemFreePct = async (run: Runner): Promise<number | null> => {
  const mp = await run(["memory_pressure", "-Q"]);
  const mac = mp.code === 0 ? Number(/free percentage: (\d+)%/.exec(mp.out)?.[1]) : NaN;
  if (Number.isFinite(mac)) return mac;
  const mi = await run(["cat", "/proc/meminfo"]);
  const m = mi.code === 0 ? parseMeminfo(mi.out) : undefined;
  return m ? (100 * m.availKb) / m.totalKb : null;
};

// unrounded in the sample so 19.9% stays under a 20% floor; shown rounded down so the line never claims the floor
export const memFreeText = (pct: number | null): string => (pct === null ? "memory free unknown" : `memory free ${Math.floor(pct)}%`);

export const sampleHost = async (run: Runner, backend: Backend, dataPath = "/"): Promise<HostSample> => {
  const load = await run(["sysctl", "-n", "vm.loadavg"]);
  const loadLinux = load.code === 0 ? null : await run(["cat", "/proc/loadavg"]);
  const load1 = num((load.code === 0 ? load.out.replace(/[{}]/g, "").trim() : loadLinux?.out ?? "").split(/\s+/)[0], 0);
  const memFreePct = await sampleMemFreePct(run);
  const df = await run(["df", "-k", dataPath]);
  const diskFreeGb = num(df.out.split("\n").at(-1)?.trim().split(/\s+/)[3], 0) / 1_048_576;
  const swap = await run(["sysctl", "-n", "vm.swapusage"]);
  const swapFreeGb = num(/free = ([\d.]+)M/.exec(swap.out)?.[1], 0) / 1024;
  const panes = await listPanes(run, backend).then((p) => p.length, () => -1);
  return { load1, memFreePct, diskFreeGb, swapFreeGb, panes };
};

export const alertReasons = (s: HostSample, t: GuardThresholds): string[] => {
  const r: string[] = [];
  if (s.load1 > t.loadAlert) r.push(`load ${s.load1.toFixed(0)} > ${t.loadAlert}`);
  if (s.memFreePct !== null && s.memFreePct < t.memFreeMinPct) r.push(`${memFreeText(s.memFreePct)} < ${t.memFreeMinPct}%`);
  if (s.diskFreeGb < t.diskFreeMinGb) r.push(`disk free ${s.diskFreeGb.toFixed(0)} GB < ${t.diskFreeMinGb} GB`);
  if (t.panesMax > 0 && s.panes > t.panesMax) r.push(`panes ${s.panes} > ${t.panesMax}`);
  return r;
};

export type GuardState = { alerting: boolean; computeReady?: boolean };

export const guardTick = (s: HostSample, t: GuardThresholds, state: GuardState): string[] => {
  const out: string[] = [];
  const reasons = alertReasons(s, t);
  const alerting = reasons.length > 0;
  if (alerting !== state.alerting) {
    out.push(alerting
      ? `HOST_GUARD ALERT ${reasons.join(" | ")}`
      : `HOST_GUARD CLEAR load ${s.load1.toFixed(0)}, ${memFreeText(s.memFreePct)}, disk free ${s.diskFreeGb.toFixed(0)} GB, swap free ${s.swapFreeGb.toFixed(1)} GB`);
    state.alerting = alerting;
  }
  const ready = s.load1 < t.loadOk;
  if (ready !== state.computeReady) {
    out.push(ready ? `HOST_GUARD COMPUTE_READY load ${s.load1.toFixed(0)} < ${t.loadOk}` : `HOST_GUARD COMPUTE_BUSY load ${s.load1.toFixed(0)}`);
    state.computeReady = ready;
  }
  return out;
};

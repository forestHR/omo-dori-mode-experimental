import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { headroomVerdict, type UsageSample } from "./heavy-headroom.ts";
import { memVerdict } from "./heavy-mem.ts";
import type { Clock } from "./run.ts";

// More jobs beside the first `slots`: up to maxSlots at once, each only when every resource keeps `free` percent free with
// it added, and not while a job taken less than settleSec ago has not shown its load yet.
export type Headroom = {
  readonly maxSlots: number;
  readonly free: number;
  readonly settleSec: number;
  readonly usage: (jobPids: readonly number[]) => Promise<UsageSample>;
};

export type SlotDeps = {
  readonly dir: string;
  readonly slots: number;
  readonly maxLoad: number;
  readonly clock: Clock;
  readonly load: () => Promise<number>;
  // `since`: the slot was claimed then, so only a process started by then can be its holder (a pid reused later is not)
  readonly alive: (pid: number, since?: number) => boolean;
  readonly pid: number;
  readonly headroom?: Headroom;
  // one line per job when it is taken (HEAVY_ADMIT) and when it starts or changes why it waits (HEAVY_WAIT)
  readonly log?: (line: string) => void;
};

const ORPHAN_MS = 60_000;

// the owner line is "<pid> <label> <claimed ISO time>"
const parseOwner = (owner: string): { pid: number; label: string; since: number | undefined } => {
  const words = owner.trim().split(" ");
  const since = Date.parse(words.at(-1) ?? "");
  return { pid: Number(words[0]), label: words[1] ?? "", since: Number.isNaN(since) ? undefined : since };
};

// what this process wrote into each slot it took, so it frees a slot only while that slot is still its own
const taken = new Map<string, string>();

// a job's own memory estimate (dori heavy --mem), in KB, kept in its slot so later admissions count what it will still load
const MEM_FILE = "mem";
const slotMemKb = (deps: SlotDeps, n: number): number => {
  try {
    return Number(readFileSync(join(deps.dir, `slot.${n}`, MEM_FILE), "utf8")) || 0;
  } catch {
    return 0;
  }
};

const tryTake = (deps: SlotDeps, n: number, label: string, memKb?: number): string | null => {
  const slot = join(deps.dir, `slot.${n}`);
  const claim = (): string | null => {
    try {
      mkdirSync(slot);
    } catch {
      return null;
    }
    const owner = `${deps.pid} ${label} ${new Date(deps.clock.now()).toISOString()}`;
    if (memKb) writeFileSync(join(slot, MEM_FILE), String(Math.round(memKb)));
    writeFileSync(join(slot, "owner"), owner);
    taken.set(slot, owner);
    return slot;
  };
  const got = claim();
  if (got) return got;
  let owner = "";
  try {
    owner = readFileSync(join(slot, "owner"), "utf8");
  } catch {
    owner = "";
  }
  const { pid, since } = parseOwner(owner);
  const orphaned = owner ? !deps.alive(pid, since) : deps.clock.now() - statSync(slot).mtimeMs > ORPHAN_MS;
  if (!orphaned) return null;
  rmSync(slot, { recursive: true, force: true });
  return claim();
};

type Holder = { readonly n: number; readonly pid: number; readonly label: string; readonly since: number };

const holders = (deps: SlotDeps, max: number): Holder[] => {
  const out: Holder[] = [];
  for (let n = 1; n <= max; n++) {
    let owner: string;
    try {
      owner = readFileSync(join(deps.dir, `slot.${n}`, "owner"), "utf8").trim();
    } catch {
      continue;
    }
    const { pid, label, since } = parseOwner(owner);
    if (deps.alive(pid, since)) out.push({ n, pid, label, since: since ?? 0 });
  }
  return out;
};

const age = (ms: number): string => {
  const min = Math.max(0, Math.floor(ms / 60_000));
  return min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}m` : `${min}m`;
};

// which jobs hold the slots and for how long, so a waiter can see a job that should have ended
const heldBy = (deps: SlotDeps, running: readonly Holder[]): string =>
  running.map((r) => `slot.${r.n} ${r.label} pid ${r.pid} ${r.since ? age(deps.clock.now() - r.since) : "?"}`).join(", ");

// one admission decision at a time across processes, so two waiters never both take the same headroom
const withLock = async <T>(deps: SlotDeps, f: () => Promise<T>): Promise<T | null> => {
  const lock = join(deps.dir, "admit.lock");
  const take = (): boolean => {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "owner"), String(deps.pid));
      return true;
    } catch {
      return false;
    }
  };
  if (!take()) {
    let pid = NaN;
    try {
      pid = Number(readFileSync(join(lock, "owner"), "utf8"));
    } catch {
      pid = NaN;
    }
    const stale = Number.isInteger(pid) ? !deps.alive(pid) : deps.clock.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0) > ORPHAN_MS;
    if (!stale) return null;
    rmSync(lock, { recursive: true, force: true });
    if (!take()) return null;
  }
  try {
    return await f();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
};

export type Try = { readonly slot: string; readonly why: string } | { readonly wait: string; readonly why: string };

// Waiters stand in line: a ticket file per waiter in <dir>/queue named <enqueued ms, 15 digits>-<pid>-<label>, so names
// sort in arrival order. Only the first live ticket may take a slot; a ticket whose process died is dropped.
const QUEUE = "queue";
const ticketPid = (name: string): number => Number(name.split("-")[1]);

// a ticket's content says whether its job can run on another host ("any") or only waits for this one ("local")
const ticketKind = (deps: SlotDeps, name: string): string => {
  try {
    return readFileSync(join(deps.dir, QUEUE, name), "utf8");
  } catch {
    return "local";
  }
};

const enqueue = (deps: SlotDeps, label: string, since: number, kind: "any" | "local"): string => {
  const dir = join(deps.dir, QUEUE);
  mkdirSync(dir, { recursive: true });
  for (let at = since; ; at++) {
    const path = join(dir, `${String(at).padStart(15, "0")}-${deps.pid}-${label.replace(/[^\w.-]/g, "_")}`);
    try {
      writeFileSync(path, kind, { flag: "wx" });
      return path;
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;
    }
  }
};

// live tickets in line order (dead ones removed on the way)
const line = (deps: SlotDeps): string[] => {
  const dir = join(deps.dir, QUEUE);
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names.filter((n) => {
    if (deps.alive(ticketPid(n))) return true;
    rmSync(join(dir, n), { force: true });
    return false;
  });
};

// One admission try now, for a helper that serves another host's queue: a job waiting in this host's own line goes first.
export const admitOnce = async (deps: SlotDeps, label: string): Promise<Try | null> => {
  mkdirSync(deps.dir, { recursive: true });
  const waiting = line(deps).length;
  if (waiting) return { wait: "queue", why: `${waiting} job(s) wait in this host's queue` };
  return withLock(deps, () => tryAdmit(deps, label));
};

// memKb: the job's own estimate (dori heavy --mem). With it even the first slot waits until the memory it needs, beside
// what running jobs said they need and do not use yet, keeps headroom.free percent of the host free.
const tryAdmit = async (deps: SlotDeps, label: string, memKb?: number): Promise<Try> => {
  const load = await deps.load();
  if (load >= deps.maxLoad) return { wait: "load", why: `load ${load.toFixed(0)} >= ${deps.maxLoad}` };
  const h = deps.headroom;
  const max = Math.max(deps.slots, h?.maxSlots ?? 0);
  const running = holders(deps, max);
  let sample: UsageSample | undefined;
  const usage = async (u: Headroom): Promise<UsageSample> => (sample ??= await u.usage(running.map((r) => r.pid)));
  let memWhy = "";
  if (memKb && h) {
    const s = await usage(h);
    if (s.memTotalKb > 0) {
      const reservedKb = running.reduce((a, r, i) => a + Math.max(0, slotMemKb(deps, r.n) - ((s.jobs[i]?.mem ?? 0) * s.memTotalKb) / 100), 0);
      const v = memVerdict({ totalKb: s.memTotalKb, availKb: s.memTotalKb * (1 - s.host.mem / 100) }, memKb, reservedKb, h.free);
      if (!v.ok) return { wait: "memory", why: v.why };
      memWhy = `; ${v.why}`;
    }
  }
  if (running.length < deps.slots || !h) {
    for (let n = 1; n <= deps.slots; n++) {
      const slot = tryTake(deps, n, label, memKb);
      if (slot) return { slot, why: `${running.length} heavy job(s) running, load ${load.toFixed(0)} < ${deps.maxLoad}${memWhy}` };
    }
    if (!h) return { wait: "full", why: `all ${deps.slots} slot(s) busy: ${heldBy(deps, holders(deps, max))}` };
  }
  if (running.length >= max) return { wait: "full", why: `all ${max} slots busy: ${heldBy(deps, running)}` };
  const fresh = running.find((r) => deps.clock.now() - r.since < h.settleSec * 1000);
  if (fresh) return { wait: "settle", why: `slot.${fresh.n} was taken ${Math.round((deps.clock.now() - fresh.since) / 1000)}s ago; its load shows after ${h.settleSec}s` };
  // a job with its own estimate had memory checked above; the guess from running jobs is for the other resources
  const v = headroomVerdict(await usage(h), h.free, memKb ? ["mem"] : []);
  if (!v.ok) return { wait: `headroom ${v.short.join(",")}`, why: `${running.length} running; ${v.detail}` };
  for (let n = 1; n <= max; n++) {
    const slot = tryTake(deps, n, label, memKb);
    if (slot) return { slot, why: `${running.length} running beside it; ${v.detail}${memWhy}` };
  }
  return { wait: "full", why: `all ${max} slots busy: ${heldBy(deps, holders(deps, max))}` };
};

export type Acquired<T> = { readonly slot: string } | { readonly elsewhere: T };
export type AcquireOptions<T> = {
  readonly pollMs?: number;
  // when the job entered the line (a job sent back after its helper dropped keeps its place at the front)
  readonly since?: number;
  // the job at the front of the line, refused here for load, full slots or headroom (not while a new job settles), or a
  // job behind only jobs that wait for this host alone (plain dori heavy): a started run on another host, or null
  readonly elsewhere?: (wait: string) => Promise<T | null>;
  // the job's own memory estimate in KB (dori heavy --mem)
  readonly memKb?: number;
  // ask elsewhere also while this host only waits for a just-taken job to show its load (dori heavy --kind: the other
  // PC should not sit idle for heavySettleSec); the GPU line (--job) keeps waiting here then
  readonly elsewhereWhileSettling?: boolean;
};

export const acquire = async <T>(deps: SlotDeps, label: string, opts: AcquireOptions<T> = {}): Promise<Acquired<T>> => {
  mkdirSync(deps.dir, { recursive: true });
  const ticket = enqueue(deps, label, opts.since ?? deps.clock.now(), opts.elsewhere ? "any" : "local");
  try {
    let waiting = "";
    for (;;) {
      const names = line(deps);
      const ahead = names.slice(0, Math.max(0, names.indexOf(basename(ticket))));
      const t: Try | null = ahead.length ? { wait: "queue", why: `${ahead.length} job(s) ahead in the queue` } : await withLock(deps, () => tryAdmit(deps, label, opts.memKb));
      const localOnlyAhead = ahead.length > 0 && ahead.every((n) => ticketKind(deps, n) === "local");
      if (t && "slot" in t) {
        deps.log?.(`HEAVY_ADMIT ${label} ${basename(t.slot)}: ${t.why}`);
        return { slot: t.slot };
      }
      if (t && t.wait !== waiting) {
        deps.log?.(`HEAVY_WAIT ${label}: ${t.why}`);
        waiting = t.wait;
      }
      if (t && opts.elsewhere && (localOnlyAhead || (t.wait !== "queue" && (t.wait !== "settle" || opts.elsewhereWhileSettling)))) {
        const got = await opts.elsewhere(t.why);
        if (got !== null) return { elsewhere: got };
      }
      await deps.clock.sleep(opts.pollMs ?? 15_000);
    }
  } finally {
    rmSync(ticket, { force: true });
  }
};

export const acquireSlot = async (deps: SlotDeps, label: string, pollMs = 15_000, memKb?: number): Promise<string> => {
  const got = await acquire<never>(deps, label, { pollMs, ...(memKb ? { memKb } : {}) });
  return "slot" in got ? got.slot : got.elsewhere;
};

// frees the slot only while it is still the one this process took: a slot taken over by the next job (its holder looked
// dead) stays with that job
export const releaseSlot = (slot: string): void => {
  const mine = taken.get(slot);
  taken.delete(slot);
  if (mine !== undefined) {
    let now = "";
    try {
      now = readFileSync(join(slot, "owner"), "utf8");
    } catch {
      return;
    }
    if (now !== mine) return;
  }
  rmSync(slot, { recursive: true, force: true });
};

// alive and not a zombie; with `since`, also started by then (ps etimes is whole seconds, so 2 s of slack)
export const pidAlive = (pid: number, since?: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const [stat = "", etimes = ""] = Bun.spawnSync(["ps", "-o", "stat=,etimes=", "-p", String(pid)]).stdout.toString().trim().split(/\s+/);
  if (stat === "" || stat.startsWith("Z")) return false;
  return since === undefined || !/^\d+$/.test(etimes) || Date.now() - Number(etimes) * 1000 <= since + 2_000;
};

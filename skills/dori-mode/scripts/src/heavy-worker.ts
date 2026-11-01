import { mkdirSync, rmSync } from "node:fs";
import { basename } from "node:path";

import { newJobDir, onStop, packTo, RESULT_ENTRIES, requestProblem, runJob, stopWithCaller, sweepJobDirs, unpackFrom } from "./heavy-job.ts";
import type { HeavyCtx } from "./heavy-queue.ts";
import { admitOnce, pidAlive, releaseSlot } from "./heavy-slot.ts";
import { defaultTools, heavyExec } from "./heavy-spread.ts";

// dori heavy-worker: the forced command of the queue host's key on a helper. It reads the request from
// SSH_ORIGINAL_COMMAND, never a shell: "run [--rl] <label> <job> [args]" runs one job named in this host's own heavyQueue.jobs
// (an rl job only when this host's heavyQueue.rl allows rl jobs) when this host's heavy slots admit it now, "sweep" deletes job folders left by killed runs. Verdict
// lines on stderr (WORKER_ADMIT / WORKER_BUSY / WORKER_REFUSED) come before anything is read from stdin; after
// WORKER_ADMIT stdin is the inputs as tar, stdout the result as tar, and the job's folder is gone when it exits.
export const heavyWorker = async (ctx: HeavyCtx, command: string, caller?: string): Promise<number> => {
  const [verb, ...rest] = command.trim().split(/\s+/);
  // the heavy log lives here; a refusal on a host that never ran a heavy job still logs and says WORKER_REFUSED
  mkdirSync(ctx.deps.dir, { recursive: true });
  const refuse = (label: string, why: string): number => {
    ctx.deps.log?.(`HEAVY_WORKER_REFUSED ${label}: ${why}`);
    console.error(`WORKER_REFUSED ${why}`);
    return 3;
  };
  if (verb === "sweep") {
    console.error(`WORKER_SWEPT ${sweepJobDirs(ctx.q.jobDir, pidAlive)}`);
    return 0;
  }
  // exec: another host's own command in a bwrap box (heavy-spread.ts); caller: the account whose key it is (the forced
  // command's --caller), for the log
  if (verb === "exec") return heavyExec(ctx, rest, { refuse, caller: caller && /^[\w.-]{1,64}$/.test(caller) ? caller : "-", tools: defaultTools(), maxMin: ctx.q.execMaxMin });
  if (verb !== "run") return refuse("-", `unknown request "${verb ?? ""}"`);
  const rlAsked = rest.includes("--rl");
  const [label = "", kind = "", ...args] = rest.filter((a) => a !== "--rl");
  const job = ctx.q.jobs[kind];
  const problem = requestProblem({ label, kind, rl: rlAsked, args }) ?? (!job ? `no job "${kind}" on this host` : (rlAsked || job.rl) && !ctx.q.rl ? "rl jobs do not run on this host (heavyQueue.rl false)" : undefined);
  if (problem || !job) return refuse(label || "-", problem ?? "no job");
  sweepJobDirs(ctx.q.jobDir, pidAlive);
  const t = await admitOnce(ctx.deps, label);
  if (!t || !("slot" in t)) {
    console.error(`WORKER_BUSY ${t?.why ?? "another job is being admitted"}`);
    return 75;
  }
  ctx.deps.log?.(`HEAVY_WORKER_ADMIT ${label} ${kind} ${basename(t.slot)}: ${t.why}`);
  console.error(`WORKER_ADMIT ${basename(t.slot)}`);
  stopWithCaller(true);
  const dir = newJobDir(ctx.q.jobDir);
  const forget = onStop(() => {
    rmSync(dir, { recursive: true, force: true });
    releaseSlot(t.slot);
  });
  try {
    await unpackFrom("inherit", dir);
    const r = await runJob(job, dir, args, { label, free: ctx.deps.headroom?.free ?? 10, ...(ctx.deps.log ? { log: ctx.deps.log } : {}) });
    await packTo(dir, RESULT_ENTRIES, "inherit");
    ctx.deps.log?.(`HEAVY_WORKER_DONE ${label} ${kind}: exit ${r.code}`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    releaseSlot(t.slot);
    forget();
  }
};

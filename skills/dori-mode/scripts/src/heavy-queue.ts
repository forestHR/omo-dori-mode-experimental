import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { HeavyHelper, HeavyQueue } from "./config.ts";
import { newJobDir, onStop, packTo, readResult, RESULT_ENTRIES, runJob, stageInputs, stopWithCaller, TarError, unpackFrom, deliverOut, type JobRequest, type JobResult, requestProblem } from "./heavy-job.ts";
import { acquire, releaseSlot, type SlotDeps } from "./heavy-slot.ts";

// One line of GPU jobs across hosts. The queue host keeps the line (its heavy slots and tickets): the job at the front
// starts here when this host admits it, else on the first helper whose forced-command worker admits it under the same
// rules, else it waits. A helper that cannot be reached is skipped without a fuss; a run that breaks off on a helper goes
// back to the front of the line. Any other host sends its jobs to the queue host and runs them itself only while the
// queue host cannot be reached.

export type HeavyCtx = { readonly q: HeavyQueue; readonly deps: SlotDeps };

export class HeavyJobError extends Error {}

type Started = { readonly helper: string; readonly done: Promise<JobResult | null> };
type HelperTry = { readonly kind: "started"; readonly run: Started } | { readonly kind: "busy" | "down" | "refused"; readonly why: string };

const VERDICT = /^WORKER_(ADMIT|BUSY|REFUSED)\b ?(.*)$/;

export async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf) yield buf;
}

const clearResult = (dir: string): void => {
  for (const e of RESULT_ENTRIES) rmSync(join(dir, e), { recursive: true, force: true });
  mkdirSync(join(dir, "out"));
};

const takeResult = async (bytes: Uint8Array, dir: string): Promise<JobResult | null> => {
  if (!bytes.byteLength) return null;
  try {
    await unpackFrom(bytes, dir);
  } catch (e) {
    if (!(e instanceof TarError)) throw e;
    clearResult(dir);
    return null;
  }
  if (existsSync(join(dir, "code"))) return readResult(dir);
  clearResult(dir);
  return null;
};

const startOnHelper = async (h: HeavyHelper, req: JobRequest, dir: string): Promise<HelperTry> => {
  const p = Bun.spawn([...h.ssh, "run", ...(req.rl ? ["--rl"] : []), req.label, req.kind, ...req.args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const out = new Response(p.stdout).arrayBuffer();
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
  const forward = (async () => {
    for (let n = await lines.next(); !n.done; n = await lines.next()) process.stderr.write(`${n.value}\n`);
  })();
  const stop = onStop(() => p.kill("SIGKILL"));
  p.stdin.write(await packTo(dir, ["in"], "pipe"));
  await p.stdin.end();
  const done = (async () => {
    const [bytes, code] = await Promise.all([out, p.exited]);
    await forward;
    stop();
    return code === 0 ? takeResult(new Uint8Array(bytes), dir) : null;
  })();
  return { kind: "started", run: { helper: h.name, done } };
};

export const runQueued = async (ctx: HeavyCtx, req: JobRequest, dir: string): Promise<JobResult> => {
  const job = ctx.q.jobs[req.kind];
  if (!job) throw new HeavyJobError(`no heavyQueue.jobs.${req.kind} on this host`);
  const rl = req.rl || job.rl === true;
  if (rl && !ctx.q.rl) throw new HeavyJobError(`${req.kind} is an rl job and this host does not run rl jobs (heavyQueue.rl)`);
  const log = (line: string) => ctx.deps.log?.(line);
  const seen = new Map<string, string>();
  const helpers = async (why: string): Promise<Started | null> => {
    for (const h of ctx.q.helpers) {
      // an rl job goes as --rl: the helper runs it only where its own heavyQueue.rl allows rl jobs
      const t = await startOnHelper(h, { ...req, rl }, dir);
      if (t.kind === "started") {
        seen.delete(h.name);
        log(`HEAVY_HELPER ${req.label} ${h.name}: ${why}`);
        return t.run;
      }
      if (seen.get(h.name) !== t.kind) log(`HEAVY_HELPER_${t.kind.toUpperCase()} ${req.label} ${h.name}: ${t.why}`);
      seen.set(h.name, t.kind);
    }
    return null;
  };
  const since = ctx.deps.clock.now();
  for (;;) {
    const got = await acquire<Started>(ctx.deps, req.label, { since, elsewhere: helpers });
    if ("slot" in got) {
      try {
        const r = await runJob(job, dir, req.args, { label: req.label, free: ctx.deps.headroom?.free ?? 10, ...(ctx.deps.log ? { log: ctx.deps.log } : {}) });
        log(`HEAVY_DONE ${req.label} here: exit ${r.code}`);
        return r;
      } finally {
        releaseSlot(got.slot);
      }
    }
    const r = await got.elsewhere.done;
    if (r) {
      log(`HEAVY_DONE ${req.label} ${got.elsewhere.helper}: exit ${r.code}`);
      return r;
    }
    log(`HEAVY_HELPER_CUT ${req.label} ${got.elsewhere.helper}: the run broke off; the job goes back to the front of the line`);
    // a helper that keeps dropping runs is not retried in a tight loop; the job keeps its place (since)
    await ctx.deps.clock.sleep(15_000);
  }
};

// a host that is not the queue: send the job there; null when the queue host could not be reached or the run broke off
const viaQueue = async (ctx: HeavyCtx, req: JobRequest, dir: string): Promise<JobResult | null> => {
  const p = Bun.spawn([...ctx.q.queue, "heavy-serve", req.label, req.kind, ...(req.rl ? ["--rl"] : []), "--", ...req.args], { stdin: await packTo(dir, ["in"], "pipe"), stdout: "pipe", stderr: "inherit" });
  const stop = onStop(() => p.kill("SIGKILL"));
  const [bytes, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), p.exited]);
  stop();
  return code === 0 ? takeResult(new Uint8Array(bytes), dir) : null;
};

export type JobCommand = { readonly req: JobRequest; readonly files: readonly string[]; readonly out?: string };

// dori heavy <label> --job <kind> --in <file>...: print the job's stdout, copy its result files to --out, its exit code
export const heavyJobCommand = async (ctx: HeavyCtx, c: JobCommand): Promise<number> => {
  const problem = requestProblem(c.req) ?? c.files.map((f) => (existsSync(f) ? undefined : `no input file ${f}`)).find(Boolean);
  if (problem) throw new HeavyJobError(problem);
  stopWithCaller(false);
  const dir = newJobDir(ctx.q.jobDir);
  const forget = onStop(() => rmSync(dir, { recursive: true, force: true }));
  try {
    stageInputs(dir, c.files);
    let r = ctx.q.queue.length ? await viaQueue(ctx, c.req, dir) : await runQueued(ctx, c.req, dir);
    let said = false;
    while (!r) {
      const rl = c.req.rl || ctx.q.jobs[c.req.kind]?.rl === true;
      if (!said) ctx.deps.log?.(`HEAVY_QUEUE_DOWN ${c.req.label}: the queue host did not run it; ${rl && !ctx.q.rl ? "an rl job waits for it" : "running it here"}`);
      said = true;
      if (rl && !ctx.q.rl) {
        await ctx.deps.clock.sleep(30_000);
        r = await viaQueue(ctx, c.req, dir);
        continue;
      }
      r = await runQueued({ ...ctx, q: { ...ctx.q, helpers: [] } }, c.req, dir);
    }
    process.stdout.write(r.stdout);
    deliverOut(dir, c.out);
    return r.code;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    forget();
  }
};

// dori heavy-serve <label> <kind> [--rl] -- [args]: on the queue host, inputs as tar on stdin, the result as tar on stdout
export const heavyServe = async (ctx: HeavyCtx, req: JobRequest): Promise<number> => {
  const problem = requestProblem(req);
  if (problem) throw new HeavyJobError(problem);
  stopWithCaller(true);
  const dir = newJobDir(ctx.q.jobDir);
  const forget = onStop(() => rmSync(dir, { recursive: true, force: true }));
  try {
    await unpackFrom("inherit", dir);
    await runQueued(ctx, req, dir);
    await packTo(dir, RESULT_ENTRIES, "inherit");
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    forget();
  }
};

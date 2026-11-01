import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { HeavyQueue } from "../src/config.ts";
import { heavyJobCommand, runQueued, type HeavyCtx } from "../src/heavy-queue.ts";
import { newJobDir, stageInputs } from "../src/heavy-job.ts";
import { heavyWorker } from "../src/heavy-worker.ts";
import { acquireSlot, releaseSlot, type SlotDeps } from "../src/heavy-slot.ts";
import { withState } from "./fakes.ts";

// A queue host and a helper, each with its own state; the helper is the real CLI (`dori heavy-worker`) behind an argv
// that stands in for ssh, so jobs cross as tar between two processes the way they do between two hosts.
const CLI = join(import.meta.dir, "../src/cli.ts");
const HOLDER = 4243;
let state: ReturnType<typeof withState>;
let holderAlive: boolean;
let logs: string[];
let input: string;

const upper = (where: string) => ({ argv: ["sh", "-c", `tr a-z A-Z < "$0"; echo ${where} > "$1/where"`, "{in0}", "{out}"] });
const train = { argv: ["sh", "-c", "echo trained"], rl: true };

const helperArgv = (rl?: boolean): string[] => {
  const dir = join(state.dir, "helper");
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "config.json");
  const jobs = { upper: upper("helper"), train, rlprobe: { ...upper("helper"), rl: true } };
  writeFileSync(config, JSON.stringify({ stateDir: join(dir, "state"), heavyMaxLoad: 1e9, heavyQueue: { jobs, jobDir: join(dir, "jobs"), ...(rl === undefined ? {} : { rl }) } }));
  // env -i with this process's environment (no DORI_*, test/preload.ts): src spawns the stand-in without env, and Bun
  // then hands it the environment bun test started with, which in an aoe window names that Dori's live state dir
  const own = Object.entries(process.env).map(([k, v]) => `${k}=${v}`);
  return ["env", "-i", ...own, `DORI_CONFIG=${config}`, `DORI_ENV_FILE=${join(dir, "none.env")}`, process.execPath, CLI, "heavy-worker"];
};

const ctxWith = (q: Partial<HeavyQueue>, sleep: () => Promise<void> = () => new Promise((r) => setImmediate(r))): HeavyCtx => {
  // every reading of the clock a millisecond later, so jobs line up in the order they were started
  let tick = Date.now();
  const deps: SlotDeps = { dir: join(state.dir, "heavy"), slots: 1, maxLoad: 80, clock: { now: () => tick++, sleep }, pid: process.pid, load: async () => 10, alive: (p) => (p === HOLDER ? holderAlive : true), log: (l) => logs.push(l) };
  return { q: { jobs: { upper: upper("queue"), train, rlprobe: { ...upper("queue"), rl: true } }, helpers: [], queue: [], rl: true, jobDir: join(state.dir, "jobs"), exec: false, execMaxMin: 240, ...q }, deps };
};

const holdSlot = () => {
  mkdirSync(join(state.dir, "heavy", "slot.1"), { recursive: true });
  writeFileSync(join(state.dir, "heavy", "slot.1", "owner"), `${HOLDER} other-job ${new Date().toISOString()}`);
};

const queued = async (ctx: HeavyCtx, kind = "upper", rl = false, label = "t") => {
  const dir = newJobDir(ctx.q.jobDir);
  stageInputs(dir, [input]);
  const r = await runQueued(ctx, { label, kind, rl, args: [] }, dir);
  return { ...r, where: readFileSync(join(dir, "out", "where"), "utf8").trim() };
};

const stopAfter = (n: number) => {
  let polls = 0;
  return async () => {
    if (++polls >= n) throw new Error("stop");
    await new Promise((r) => setImmediate(r));
  };
};

beforeEach(() => {
  state = withState();
  holderAlive = true;
  logs = [];
  input = join(state.dir, "voice.txt");
  writeFileSync(input, "hello\n");
});
afterEach(() => state.done());

test("a job the queue host cannot start now runs on the helper, comes back the same, and leaves no file there", async () => {
  // Given
  holdSlot();
  const ctx = ctxWith({ helpers: [{ name: "second", ssh: helperArgv() }] });
  // When
  const r = await queued(ctx);
  // Then
  expect(r).toEqual({ code: 0, stdout: "HELLO\n", where: "helper" });
  expect(logs.some((l) => l.startsWith("HEAVY_HELPER t second:"))).toBe(true);
  expect(readdirSync(join(state.dir, "helper", "jobs"))).toEqual([]);
  expect(readFileSync(join(state.dir, "helper", "state", "heavy", "heavy.log"), "utf8")).toContain("HEAVY_WORKER_ADMIT t upper");
});

test("a job the queue host can start runs here and never reaches the helper", async () => {
  const ctx = ctxWith({ helpers: [{ name: "second", ssh: helperArgv() }] });
  expect((await queued(ctx)).where).toBe("queue");
  expect(existsSync(join(state.dir, "helper", "state", "heavy", "heavy.log"))).toBe(false);
});

test("an rl job the queue host cannot start now runs on a helper that runs rl jobs", async () => {
  // Given: the queue host busy, a helper with the default heavyQueue.rl (true)
  holdSlot();
  const ctx = ctxWith({ helpers: [{ name: "second", ssh: helperArgv() }] });
  // When
  const r = await queued(ctx, "rlprobe");
  // Then
  expect(r).toEqual({ code: 0, stdout: "HELLO\n", where: "helper" });
  expect(logs.some((l) => l.startsWith("HEAVY_HELPER t second:"))).toBe(true);
  expect(readFileSync(join(state.dir, "helper", "state", "heavy", "heavy.log"), "utf8")).toContain("HEAVY_WORKER_ADMIT t rlprobe");
});

test("a helper whose heavyQueue.rl is false refuses a job sent as --rl, and the job waits for the queue host", async () => {
  // Given: the queue host busy, a helper that runs no rl jobs, a job its own config calls plain but asked as --rl
  holdSlot();
  const ctx = ctxWith({ helpers: [{ name: "second", ssh: helperArgv(false) }] }, async () => {
    if (logs.some((l) => l.startsWith("HEAVY_HELPER_REFUSED"))) holderAlive = false;
    await new Promise((r) => setImmediate(r));
  });
  // When
  const r = await queued(ctx, "upper", true);
  // Then
  expect(r.where).toBe("queue");
  expect(logs.filter((l) => l.startsWith("HEAVY_HELPER_REFUSED t second"))).toHaveLength(1);
  expect(readFileSync(join(state.dir, "helper", "state", "heavy", "heavy.log"), "utf8")).toContain("HEAVY_WORKER_REFUSED t: rl jobs do not run on this host");
});

test("a job behind a plain dori heavy that waits for the queue host still goes to a free helper, without passing it here", async () => {
  // Given: the queue host busy, a plain dori heavy (this host only) at the front of the line
  holdSlot();
  const ctx = ctxWith({ helpers: [{ name: "second", ssh: helperArgv() }] });
  const plain = acquireSlot(ctx.deps, "plain");
  // When: a job comes in behind it
  const behind = await queued(ctx, "upper", false, "behind");
  // Then: it ran on the helper while the plain one still waits, and the plain one later starts on the queue host
  expect(behind.where).toBe("helper");
  expect(logs.some((l) => l.startsWith("HEAVY_ADMIT plain"))).toBe(false);
  holderAlive = false;
  releaseSlot(await plain);
  expect(logs.some((l) => l.startsWith("HEAVY_ADMIT plain"))).toBe(true);
});

test("a run that breaks off on the helper goes back to the front of the line and finishes on the queue host", async () => {
  // Given: a helper that admits the job, then drops the connection without a result
  holdSlot();
  const ctx = ctxWith({ helpers: [{ name: "second", ssh: ["sh", "-c", "echo WORKER_ADMIT slot.1 >&2; cat >/dev/null; exit 255"] }] }, async () => {
    if (logs.some((l) => l.startsWith("HEAVY_HELPER_CUT"))) holderAlive = false;
    await new Promise((r) => setImmediate(r));
  });
  // When
  const r = await queued(ctx);
  // Then
  expect(r).toEqual({ code: 0, stdout: "HELLO\n", where: "queue" });
  expect(logs.filter((l) => /^HEAVY_(HELPER_CUT|DONE)/.test(l)).map((l) => l.split(":")[0])).toEqual(["HEAVY_HELPER_CUT t second", "HEAVY_DONE t here"]);
});

test("a helper that cannot be reached is noted once and the job waits for the queue host", async () => {
  holdSlot();
  let pollsWhileDown = 0;
  const ctx = ctxWith({ helpers: [{ name: "second", ssh: ["false"] }] }, async () => {
    if (logs.some((l) => l.startsWith("HEAVY_HELPER_DOWN")) && ++pollsWhileDown >= 3) holderAlive = false;
    await new Promise((r) => setImmediate(r));
  });
  const r = await queued(ctx);
  expect(r.where).toBe("queue");
  expect(logs.filter((l) => l.startsWith("HEAVY_HELPER_DOWN t second"))).toHaveLength(1);
});

test("the worker refuses an rl job where heavyQueue.rl is false, an unknown job and an argument a shell would read, and takes no slot", async () => {
  const ctx = ctxWith({});
  const noRl = ctxWith({ rl: false });
  for (const request of ["run t train", "run --rl t upper", "run t upper --rl"]) expect(await heavyWorker(noRl, request)).toBe(3);
  for (const request of ["run t nojob", "run t upper $(id)", "exec sh"]) expect(await heavyWorker(ctx, request)).toBe(3);
  expect(existsSync(join(state.dir, "heavy", "slot.1"))).toBe(false);
});

test("a host cut off from the queue host runs the job itself, but holds an rl job when it runs none", async () => {
  const out = join(state.dir, "out");
  const ctx = ctxWith({ queue: ["false"] });
  expect(await heavyJobCommand(ctx, { req: { label: "t", kind: "upper", rl: false, args: [] }, files: [input], out })).toBe(0);
  expect(readFileSync(join(out, "where"), "utf8").trim()).toBe("queue");
  expect(logs.some((l) => l.startsWith("HEAVY_QUEUE_DOWN t:"))).toBe(true);
  const noRl = ctxWith({ queue: ["false"], rl: false }, stopAfter(2));
  await expect(heavyJobCommand(noRl, { req: { label: "r", kind: "train", rl: false, args: [] }, files: [input] })).rejects.toThrow("stop");
  expect(logs.filter((l) => l.startsWith("HEAVY_ADMIT r"))).toEqual([]);
});

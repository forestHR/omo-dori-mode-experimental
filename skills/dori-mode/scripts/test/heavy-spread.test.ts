import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";

import type { HeavyQueue } from "../src/config.ts";
import type { HeavyCtx } from "../src/heavy-queue.ts";
import { copyBack, heavySpread, pathsIn, spreadPlan, type SpreadJob } from "../src/heavy-spread.ts";
import type { SlotDeps } from "../src/heavy-slot.ts";
import { withState } from "./fakes.ts";

// The caller and a helper, each with its own state; the helper is the real CLI (`dori heavy-worker`) behind an argv that
// stands in for ssh, so the job's folder crosses as tar and the command runs in the real bwrap box.
const CLI = join(import.meta.dir, "../src/cli.ts");
const HOLDER = 4243;
const who = { uid: process.getuid?.() ?? -1, home: homedir() };
let state: ReturnType<typeof withState>;
let logs: string[];
let work: string;

const helperArgv = (exec = true): string[] => {
  const dir = join(state.dir, "helper");
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: join(dir, "state"), heavyMaxLoad: 1e9, heavyQueue: { exec, execMaxMin: 5, jobDir: join(dir, "jobs") } }));
  const own = Object.entries(process.env).map(([k, v]) => `${k}=${v}`);
  return ["env", "-i", ...own, `DORI_CONFIG=${config}`, `DORI_ENV_FILE=${join(dir, "none.env")}`, process.execPath, CLI, "heavy-worker", "--caller", "tester"];
};

// busy: this host's CPU percent as the caller sees it
const ctxWith = (q: Partial<HeavyQueue>, busy = 0): HeavyCtx => {
  const usage = async () => ({ host: { gpu: null, gpuMem: null, cpu: busy, mem: 10 }, unified: false, jobs: [], memTotalKb: 1e8 });
  const deps: SlotDeps = { dir: join(state.dir, "heavy"), slots: 1, maxLoad: 80, clock: { now: () => Date.now(), sleep: () => new Promise((r) => setImmediate(r)) }, pid: process.pid, load: async () => 10, alive: (p) => p === HOLDER || p === process.pid, headroom: { maxSlots: 1, free: 10, settleSec: 0, usage }, log: (l) => logs.push(l) };
  return { q: { jobs: {}, helpers: [], queue: [], rl: true, jobDir: join(state.dir, "jobs"), exec: false, execMaxMin: 240, ...q }, deps };
};

const holdSlot = () => {
  mkdirSync(join(state.dir, "heavy", "slot.1"), { recursive: true });
  writeFileSync(join(state.dir, "heavy", "slot.1", "owner"), `${HOLDER} other-job ${new Date().toISOString()}`);
};

const jobOf = (cmd: string[], extra: Partial<SpreadJob> = {}): SpreadJob => ({ label: "t", kind: "cpu", cmd, cwd: work, sync: [work], env: {}, ...extra });

const spread = async (ctx: HeavyCtx, job: SpreadJob) => {
  const plan = spreadPlan(job, who);
  if (!plan.ok) throw new Error(plan.why);
  return heavySpread(ctx, job, plan);
};

beforeEach(() => {
  state = withState();
  logs = [];
  work = join(state.dir, "work");
  mkdirSync(work);
  writeFileSync(join(work, "in.txt"), "hello\n");
});
afterEach(() => state.done());

test("a command this host cannot start now runs on the helper at the same paths, and its exit code and new files come back", async () => {
  // Given
  holdSlot();
  const ctx = ctxWith({ helpers: [{ name: "second", ssh: helperArgv() }] });
  const out = join(work, "out");
  // When
  const r = await spread(ctx, jobOf(["sh", "-c", `mkdir --parents ${out} && tr a-z A-Z < in.txt > ${out}/up.txt && pwd > ${out}/where && exit 7`]));
  // Then
  expect(r).toEqual({ code: 7 });
  expect(readFileSync(join(out, "up.txt"), "utf8")).toBe("HELLO\n");
  expect(readFileSync(join(out, "where"), "utf8").trim()).toBe(work);
  expect(logs.some((l) => l.startsWith("HEAVY_SPREAD t second"))).toBe(true);
  expect(logs.find((l) => l.startsWith("HEAVY_BACK t second"))).toContain("2 file(s)");
}, 60_000);

test("in the box the real home, the network, sudo and every path outside the job's own folder are out of reach", async () => {
  // Given
  holdSlot();
  const ctx = ctxWith({ helpers: [{ name: "second", ssh: helperArgv() }] });
  const probe = join(homedir(), `.dori-box-probe-${process.pid}`);
  // a TCP server of this test on the host's own LAN address: reachable from here, not from inside the box
  const ip = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address ?? "127.0.0.1";
  const server = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { data() {} } });
  const reach = async () => { const s = await Bun.connect({ hostname: ip, port: server.port, socket: { data() {} } }); s.end(); };
  await reach();
  writeFileSync(
    join(work, "probe.ts"),
    `import { readFileSync, writeFileSync, existsSync } from "node:fs";
const tries = {
  home: () => readFileSync(${JSON.stringify(join(homedir(), ".bashrc"))}),
  ssh: () => readFileSync(${JSON.stringify(join(homedir(), ".ssh", "id_ed25519"))}),
  writeHome: () => writeFileSync(${JSON.stringify(probe)}, "x"),
  writeHomeRoot: () => writeFileSync("/home/dori-box-probe", "x"),
  writeUsr: () => writeFileSync("/usr/dori-box-probe", "x"),
  writeVarTmp: () => writeFileSync("/var/tmp/dori-box-probe", "x"),
};
const out = [];
for (const [k, f] of Object.entries(tries)) { try { f(); out.push(k + "=open"); } catch { out.push(k + "=blocked"); } }
try { const s = await Promise.race([Bun.connect({ hostname: ${JSON.stringify(ip)}, port: ${server.port}, socket: { data() {} } }), new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 3000))]); s.end(); out.push("net=open"); } catch { out.push("net=blocked"); }
const sudo = Bun.spawnSync(["sudo", "-n", "true"]);
out.push(sudo.exitCode === 0 ? "sudo=open" : "sudo=blocked");
writeFileSync("box.txt", out.join(" "));
`,
  );
  // When
  const r = await spread(ctx, jobOf(["bun", join(work, "probe.ts")]));
  server.stop(true);
  // Then
  expect(r).toEqual({ code: 0 });
  expect(readFileSync(join(work, "box.txt"), "utf8")).toBe("home=blocked ssh=blocked writeHome=blocked writeHomeRoot=blocked writeUsr=blocked writeVarTmp=blocked net=blocked sudo=blocked");
  expect(existsSync(probe)).toBe(false);
}, 60_000);

test("a job waiting here only for a just-started job to show its load goes to a free helper instead of idling", async () => {
  // Given: this host's one slot is free in count (2 allowed) but its job started 0 s ago, so this host waits to settle
  holdSlot();
  const base = ctxWith({ helpers: [{ name: "second", ssh: helperArgv() }] });
  let polls = 0;
  const ctx: HeavyCtx = { ...base, deps: { ...base.deps, headroom: { ...base.deps.headroom!, maxSlots: 2, settleSec: 120 }, clock: { now: () => Date.now(), sleep: async () => { if (++polls > 3) throw new Error("stuck waiting to settle"); } } } };
  // When
  const r = await spread(ctx, jobOf(["true"]));
  // Then
  expect(r).toEqual({ code: 0 });
  expect(logs.some((l) => l.startsWith("HEAVY_WAIT t: slot.1 was taken"))).toBe(true);
  expect(logs.some((l) => l.startsWith("HEAVY_SPREAD t second"))).toBe(true);
}, 60_000);

test("a host much less busy than a helper keeps the job: the helper is not asked", async () => {
  // Given
  const ctx = ctxWith({ helpers: [{ name: "second", ssh: helperArgv() }] }, 10);
  // When
  const r = await spread(ctx, jobOf(["true"]));
  // Then
  expect("slot" in r).toBe(true);
  expect(logs.filter((l) => l.includes("second"))).toEqual([]);
});

test("a busy host asks the helper first, which takes the job only when it is clearly less busy", async () => {
  // Given: this host 100% busy, so the helper is asked to run it if it is under 85%
  const ctx = ctxWith({ helpers: [{ name: "second", ssh: helperArgv() }] }, 100);
  // When
  const r = await spread(ctx, jobOf(["true"]));
  // Then: it ran there, or the helper said it was busy and this host took it
  const asked = logs.find((l) => l.startsWith("HEAVY_SPREAD t second: this host is 100% busy (cpu), the helper less than 85%") || l.startsWith("HEAVY_HELPER_BUSY t second: this host is"));
  expect(asked).toBeDefined();
  expect("code" in r ? r.code : 0).toBe(0);
}, 60_000);

test("a helper without exec on refuses, and the job stays here", async () => {
  // Given
  holdSlot();
  const ctx = ctxWith({ helpers: [{ name: "second", ssh: helperArgv(false) }] });
  let polls = 0;
  const waiting = { ...ctx, deps: { ...ctx.deps, clock: { now: () => Date.now(), sleep: async () => { if (++polls > 2) throw new Error("stop"); } } } };
  // When
  const r = spread(waiting, jobOf(["true"]));
  // Then
  await expect(r).rejects.toThrow("stop");
  expect(logs).toContain("HEAVY_HELPER_REFUSED t second: exec is off on this host (heavyQueue.exec)");
}, 60_000);

test("a job that names a path outside its --sync paths, or links out of them, stays here and says which path", () => {
  // Given
  const outside = join(state.dir, "elsewhere");
  mkdirSync(outside);
  // When / Then
  const arg = spreadPlan(jobOf(["bun", "t.ts", `--clip=${outside}/c.webm`]), who);
  expect(arg).toEqual({ ok: false, why: `${outside}/c.webm (in "--clip=${outside}/c.webm") is not in a --sync path` });
  symlinkSync(outside, join(work, "node_modules"));
  const link = spreadPlan(jobOf(["true"]), who);
  expect(link.ok ? "" : link.why).toBe(`the link ${work}/node_modules points to ${outside}, which is not in a --sync path (add it with --sync)`);
  expect(spreadPlan(jobOf(["true"], { sync: [work, outside] }), who).ok).toBe(true);
  expect(spreadPlan(jobOf(["true"], { cwd: outside }), who)).toEqual({ ok: false, why: `the working folder ${outside} is not in a --sync path` });
  expect(spreadPlan(jobOf(["true"], { sync: [join(work, "node_modules")] , cwd: join(work, "node_modules") }), who).ok).toBe(false);
  expect(spreadPlan(jobOf(["true"], { sync: ["/etc"] }), who).ok).toBe(false);
});

test("an argument's paths are found after = , and : but a URL's // is not a path", () => {
  expect(pathsIn("--out=/tmp/a,/tmp/b")).toEqual(["/tmp/a", "/tmp/b"]);
  expect(pathsIn("http://127.0.0.1:9660/x")).toEqual([]);
  expect(pathsIn("/usr/bin/env")).toEqual(["/usr/bin/env"]);
});

test("files sent back land only inside the --sync paths, never through a link here that leads out of them", () => {
  // Given: the result holds a file under work/lnk, and here work/lnk is a link to a folder outside work
  const outside = join(state.dir, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(work, "lnk"));
  const back = join(state.dir, "back");
  mkdirSync(join(back, work, "lnk"), { recursive: true });
  mkdirSync(join(back, outside), { recursive: true });
  writeFileSync(join(back, work, "lnk", "f"), "x");
  writeFileSync(join(back, work, "ok.txt"), "y");
  writeFileSync(join(back, outside, "g"), "z");
  // When
  const n = copyBack(back, [work]);
  // Then
  expect(n).toEqual({ files: 1, bytes: 1, skipped: 2 });
  expect(readFileSync(join(work, "ok.txt"), "utf8")).toBe("y");
  expect(existsSync(join(outside, "f"))).toBe(false);
  expect(existsSync(join(outside, "g"))).toBe(false);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { canScope, memVerdict, neverFits, parseMem, spawnScoped } from "../src/heavy-mem.ts";
import { linesOf } from "../src/heavy-queue.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => (state = withState()));
afterEach(() => state.done());

const CLI = join(import.meta.dir, "../src/cli.ts");
const ownCgroup = (): string => readFileSync("/proc/self/cgroup", "utf8").trim();

test("a heavy command over its MemoryMax is killed alone in its own scope and the process that started it keeps running", async () => {
  const no = await canScope();
  const logs: string[] = [];
  const out = join(state.dir, "cgroup");
  // the job's cgroup is its own, not the caller's (2026-10-30: a lane's job shared the lane's aoe-session scope)
  expect(await spawnScoped({ label: "where", cmd: ["sh", "-c", `cat /proc/self/cgroup > ${out}`], free: 10, log: (l) => logs.push(l) }, { stdin: "ignore", stdout: "ignore", stderr: "inherit" })).toBe(0);
  if (no) {
    // a host without a systemd user manager (macOS) runs the job as before and says so
    expect(logs).toEqual([expect.stringMatching(/^HEAVY_NO_SCOPE where: /)]);
    return;
  }
  expect(readFileSync(out, "utf8")).toMatch(/dori-heavy-where-\d+-\d+\.scope/);
  expect(readFileSync(out, "utf8").trim()).not.toBe(ownCgroup());
  // 600M held in memory (tail keeps a line without a newline) against a 200M cap
  logs.length = 0;
  const code = await spawnScoped({ label: "oom", cmd: ["sh", "-c", "head -c 600M /dev/zero | tail -n 1 > /dev/null"], free: 10, needBytes: 200 * 1024 ** 2, log: (l) => logs.push(l) }, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  expect(code).not.toBe(0);
  expect(logs[0]).toMatch(/^HEAVY_SCOPE oom dori-heavy-oom-\d+-\d+\.scope MemoryMax=200M \(its --mem\)$/);
  expect(logs[1]).toMatch(/^HEAVY_OOM oom: killed at MemoryMax=200M in dori-heavy-oom-\d+-\d+\.scope \(exit \d+\); only the job stopped/);
  expect(ownCgroup()).not.toContain("dori-heavy-");
});

test("two jobs with one label in one process each get their own scope, while the first still runs", async () => {
  // 2026-11-02: the scope was named <label>-<pid>, so a second job of one label in one process (a job sent back from a
  // helper, two jobs of a queue host's test) met the first one's scope still loaded and systemd-run refused it (exit 1)
  const fifo = join(state.dir, "fifo");
  expect(await Bun.spawn(["mkfifo", fifo]).exited).toBe(0);
  let started: (out: ReadableStream<Uint8Array>) => void = () => {};
  const stdout = new Promise<ReadableStream<Uint8Array>>((r) => (started = r));
  // the first job says it runs (inside its scope, so the scope is loaded), then waits on the fifo
  const first = spawnScoped({ label: "same", cmd: ["sh", "-c", `echo up; cat ${fifo} > /dev/null`], free: 10 }, { stdin: "ignore", stdout: "pipe", stderr: "inherit" }, (_, p) => started(p.stdout as ReadableStream<Uint8Array>));
  expect((await linesOf(await stdout).next()).value).toBe("up");
  const second = await spawnScoped({ label: "same", cmd: ["sh", "-c", `echo go > ${fifo}`], free: 10 }, { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
  // a refused second job never opened the fifo: open it here so the first one ends either way
  if (second !== 0) writeFileSync(fifo, "go\n");
  expect(second).toBe(0);
  expect(await first).toBe(0);
});

test("dori heavy refuses at once a --mem that never fits on the host and a size it cannot read", async () => {
  const config = join(state.dir, "config.json");
  await Bun.write(config, JSON.stringify({ stateDir: join(state.dir, "state") }));
  const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DORI_")));
  const run = async (...args: string[]) => {
    const p = Bun.spawn([process.execPath, CLI, "heavy", ...args], { env: { ...own, DORI_CONFIG: config, DORI_ENV_FILE: join(state.dir, "none.env"), DORI_STATE_DIR: join(state.dir, "state") }, stdout: "pipe", stderr: "pipe" });
    return { code: await p.exited, err: await new Response(p.stderr).text() };
  };
  const huge = await run("huge", "--mem", "999T", "--", "true");
  expect(huge.code).toBe(2);
  expect(huge.err).toContain("HEAVY_REFUSED huge: --mem 999.0T never fits here");
  const bad = await run("bad", "--mem", "lots", "--", "true");
  expect(bad.code).not.toBe(0);
  expect(bad.err).toContain('dori heavy --mem takes a size like 70G or 200M, not "lots"');
});

test("memory sizes read as bytes and a fit keeps the free share", () => {
  expect(parseMem("70G")).toBe(70 * 1024 ** 3);
  expect(parseMem("200M")).toBe(200 * 1024 ** 2);
  expect(parseMem("1.5g")).toBe(1.5 * 1024 ** 3);
  expect(parseMem("lots")).toBeUndefined();
  const host = { totalKb: 100_000_000, availKb: 60_000_000 };
  expect(neverFits(95 * 1024 ** 3, host, 10)).toContain("never fits");
  expect(neverFits(80 * 1024 ** 3, host, 10)).toBeUndefined();
  expect(memVerdict(host, 50_000_000, 0, 10).ok).toBe(true);
  expect(memVerdict(host, 50_000_001, 0, 10).ok).toBe(false);
});

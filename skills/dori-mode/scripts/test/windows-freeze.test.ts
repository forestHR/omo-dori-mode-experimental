import { expect, test } from "bun:test";
import { userInfo } from "node:os";
import { accountHome, windowsDetachRefusal } from "../src/handover.ts";
import { agentStartOf, localChains } from "../src/lane-handover.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezePane, freezeSignal, readFrozen, thawFrozen, writeFrozen } from "../src/frozen.ts";
import { submitToPane } from "../src/panes.ts";
import { procTable, WIN_PROCS, winProcs } from "../src/session-id.ts";
import { run as nativeRun, type Runner } from "../src/run.ts";
import { winSignal } from "../src/win-suspend.ts";
import { depsFor, fakeClock, fakeRunner, newWorld } from "./fakes.ts";

const PANE = "w1:p1";
const BUSY = ["transcript", "── • Working (2s • esc to interrupt) ──────────", "❯ ", "────────────────────────", " ~/repo • main"].join("\n");
const sentKeys = (calls: readonly string[][]): string[][] =>
  calls.filter((c) => c[0] === "herdr" && c[1] === "pane" && (c[2] === "send-text" || c[2] === "send-keys"));

test("Windows suspend -> submit -> thaw sends neither text nor Enter before a replacement record exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dori-win-freeze-"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const world = newWorld();
  world.screen = BUSY;
  const base = fakeRunner(world);
  let suspended = 0;
  const signals: string[] = [];
  const osSignal = (pid: number, sig: "SIGSTOP" | "SIGCONT"): boolean => {
    signals.push(`${sig} ${pid}`);
    suspended += sig === "SIGSTOP" ? 1 : -1;
    return true;
  };
  const signal = freezeSignal(osSignal);
  const run: Runner = async (argv, opts) => {
    if (argv[0] === "powershell") return { code: 0, err: "", out: JSON.stringify([
      { ProcessId: 4000, ParentProcessId: 0, CommandLine: "pwsh.exe" },
      { ProcessId: 4001, ParentProcessId: 4000, CommandLine: '"C:\\Program Files\\omo.exe"', Stat: suspended > 0 ? "T" : "" },
    ]) };
    return base(argv, opts);
  };
  const config = depsFor(world, fakeClock(0), dir, { backend: "herdr", agentCommand: ["omo.exe"] }).config;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    // A lane first freezes its agent, then expands the same transaction to the pane's tree.
    expect(signal(4001, "SIGSTOP")).toBe(true);
    const ice = await freezePane({ run, signal, procs: () => procTable(run) }, PANE, process.pid);
    expect(ice).toEqual({ agentPid: 4001, pids: [4001] });
    expect(signals).toEqual(["SIGSTOP 4001"]);
    expect(readFrozen(dir)).toEqual([]);
    // The sender has only the OS process table, not the transaction's in-memory suspension tracker.
    const result = await submitToPane(run, fakeClock(0), config, PANE, "[REPORT] demo | milestone | done");
    expect(result.status).toBe("NOT_SUBMITTED");
    expect(result.reason).toContain("stopped (pid 4001, frozen)");
    expect(sentKeys(world.calls)).toEqual([]);
    writeFrozen(dir, { pane: PANE, aoeId: PANE, at: new Date(0).toISOString(), agentPid: 4001, pids: [4001, 4001] });
    // A fresh thaw invocation has no knowledge of the original freezeSignal wrapper.
    expect(thawFrozen({ signal: osSignal }, dir, PANE)).toContain("1/1 processes resumed");
    expect(signals).toEqual(["SIGSTOP 4001", "SIGCONT 4001"]);
    expect(suspended).toBe(0);
    expect(readFrozen(dir)).toEqual([]);
    world.calls = [];
    expect((await submitToPane(run, fakeClock(0), config, PANE, "[REPORT] resumed")).status).toBe("SUBMITTED");
    expect(sentKeys(world.calls).some((c) => c[2] === "send-text")).toBe(true);
    expect(sentKeys(world.calls).some((c) => c[2] === "send-keys" && c.at(-1) === "enter")).toBe(true);
  } finally {
    Object.defineProperty(process, "platform", platform);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows process state accepts only the suspended T state", async () => {
  expect(winProcs(JSON.stringify([
    { ProcessId: 1, Stat: "T" }, { ProcessId: 2, Stat: "" }, { ProcessId: 3 }, { ProcessId: 4, Stat: "running" },
  ])).map((p) => p.stat)).toEqual(["T", "", "", ""]);
  const calls: string[][] = [];
  await procTable(async (argv) => { calls.push([...argv]); return { code: 0, out: "[]", err: "" }; }, "win32");
  expect(calls).toEqual([WIN_PROCS]);
});

test.skipIf(process.platform !== "win32")("native Windows freeze blocks submit and a separate invocation thaws exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dori-native-freeze-"));
  // The command line is a real bundled-agent shape, so discovery and messaging use their normal agent recognition.
  const bundle = join(dir, "senpi", "dist", "bundle", "cli.js");
  mkdirSync(join(dir, "senpi", "dist", "bundle"), { recursive: true });
  writeFileSync(bundle, `process.on("message", message => { process.send(message); process.disconnect(); }); process.send("READY");`);
  const ready = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  const deadline = AbortSignal.timeout(40_000);
  const expired = new Promise<never>((_resolve, reject) => deadline.addEventListener("abort", () => reject(deadline.reason), { once: true }));
  const child = Bun.spawn([process.execPath, bundle], {
    stdout: "ignore", stderr: "pipe",
    ipc(message) {
      if (message === "READY") ready.resolve();
      if (message === "RESUMED") resumed.resolve();
    },
  });
  const world = newWorld();
  world.screen = BUSY;
  const base = fakeRunner(world);
  const run: Runner = async (argv, opts) => {
    if (argv[0] === "powershell") return nativeRun(argv, opts);
    if (argv[0] === "herdr" && argv[2] === "process-info") return {
      code: 0, err: "", out: JSON.stringify({ result: { process_info: { shell_pid: child.pid, foreground_processes: [{ pid: child.pid, cmdline: `bun ${bundle}` }] } } }),
    };
    return base(argv, opts);
  };
  const config = depsFor(world, fakeClock(0), dir, { backend: "herdr", agentCommand: ["omo.exe"] }).config;
  let suspended = false;
  try {
    await Promise.race([ready.promise, expired]);
    const signal = freezeSignal(winSignal);
    suspended = signal(child.pid, "SIGSTOP");
    expect(suspended).toBe(true);
    const ice = await freezePane({ run, signal, procs: () => procTable(nativeRun) }, PANE, process.pid);
    expect(ice.pids).toEqual([child.pid]);
    expect((await procTable(nativeRun)).find((p) => p.pid === child.pid)?.stat).toBe("T");
    expect(readFrozen(dir)).toEqual([]);
    const blocked = await submitToPane(run, fakeClock(0), config, PANE, "[REPORT] still frozen");
    expect(blocked.status).toBe("NOT_SUBMITTED");
    expect(blocked.reason).toContain(`stopped (pid ${child.pid}, frozen)`);
    expect(sentKeys(world.calls)).toEqual([]);
    writeFrozen(dir, { pane: PANE, aoeId: PANE, at: new Date(0).toISOString(), agentPid: child.pid, pids: [...ice.pids, ...ice.pids] });
    child.send("RESUMED");
    // Exercise the real CLI wiring as well as a fresh process's native resume handle.
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ backend: "herdr", stateDir: dir, watchLog: join(dir, "watch.log") }));
    const thawer = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "handover", "thaw", PANE], {
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DORI_"))),
        DORI_CONFIG: configPath, DORI_ENV_FILE: join(dir, "dori.env"), DORI_STATE_DIR: dir,
      },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([thawer.exited, new Response(thawer.stdout).text(), new Response(thawer.stderr).text()]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(out.trim()).toBe(`HANDOVER_OLD_THAWED ${PANE}: 1/1 processes resumed (agent ${child.pid})`);
    await Promise.race([resumed.promise, expired]);
    suspended = false;
    expect(await child.exited).toBe(0);
    expect(readFrozen(dir)).toEqual([]);
  } finally {
    if (suspended) winSignal(child.pid, "SIGCONT");
    child.kill();
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 50_000);

test.skipIf(process.platform !== "win32")("Windows cannot suspend the reserved system idle PID", () => {
  expect(winSignal(0, "SIGSTOP")).toBe(false);
});

test("a handover that must run detached is refused on native Windows with what to do instead, and allowed elsewhere", () => {
  const line = windowsDetachRefusal("win32");
  expect(line).toStartWith("HANDOVER_DETACH_UNSUPPORTED");
  expect(line).toContain("from another herdr pane");
  expect(windowsDetachRefusal("linux")).toBeUndefined();
});

test("the account home for task records does not depend on $HOME (native Windows sets USERPROFILE, not HOME)", () => {
  const saved = process.env.HOME;
  try {
    delete process.env.HOME;
    expect(accountHome()).toBe(userInfo().homedir);
  } finally {
    if (saved !== undefined) process.env.HOME = saved;
  }
});

test("on Windows an idle eval kernel named with backslashes is not a local chain, and work started under it is", () => {
  // Given a Windows-shaped tree: the pane's shell, omo.exe, its python kernel, and a job the kernel started.
  const kernel = "C:\\Python\\python.exe -u C:\\Users\\o\\node_modules\\@code-yeongyu\\senpi-codemode\\src\\kernels\\py\\prelude.py";
  const table = [
    { pid: 10, ppid: 1, cmd: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
    { pid: 11, ppid: 10, cmd: "C:\\Users\\o\\.omo\\bin\\omo.exe --model m" },
    { pid: 30, ppid: 11, cmd: kernel },
  ];
  // When the chains are read with the kernel idle, then with a job under it.
  const idle = localChains(table, 10, []);
  const busy = localChains([...table, { pid: 31, ppid: 30, cmd: "C:\\Python\\python.exe train.py" }], 10, []);
  // Then the idle kernel is no chain, and the job under it is one.
  expect(idle.agent?.pid).toBe(11);
  expect(idle.chains).toEqual([]);
  expect(busy.chains.map((c) => c.pid)).toEqual([31]);
});

test("on Windows the agent's start comes from its process table, not from ps", async () => {
  const calls: string[][] = [];
  const run = async (argv: readonly string[]) => { calls.push([...argv]); return { code: 1, out: "", err: "ps: not found" }; };
  const agent = { pid: 11, ppid: 10, cmd: "omo.exe", startedAt: "2026-11-03T09:00:00.000Z" };
  expect(await agentStartOf(run, agent, "win32")).toBe(Date.parse("2026-11-03T09:00:00.000Z"));
  expect(calls).toEqual([]);
});

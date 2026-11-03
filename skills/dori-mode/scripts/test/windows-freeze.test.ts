import { expect, test } from "bun:test";
import { winSignal } from "../src/win-suspend.ts";
import { freezePane, freezeSignal, writeFrozen } from "../src/frozen.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Runner } from "../src/run.ts";

test.skipIf(process.platform !== "win32")("Windows freezes every thread and resumes the child to completion", async () => {
  // Given an owned child with readiness and completion subscriptions armed before spawn.
  const ready = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  const timeout = AbortSignal.timeout(20_000);
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout.addEventListener("abort", () => reject(timeout.reason), { once: true });
  });
  const child = Bun.spawn([process.execPath, "-e", `
    process.on("message", (message) => {
      process.send(message);
      process.disconnect();
    });
    process.send("READY");
  `], {
    stdout: "ignore",
    stderr: "pipe",
    ipc(message) {
      if (message === "READY") ready.resolve();
      if (message === "RESUMED") resumed.resolve();
    },
  });
  let suspended = false;
  try {
    await Promise.race([ready.promise, deadline]);
    // When the native process suspension succeeds.
    suspended = winSignal(child.pid, "SIGSTOP");
    expect(suspended).toBe(true);
    // Then Windows reports every thread suspended (no timing-based heartbeat check).
    const query = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command",
      `@((Get-Process -Id ${child.pid}).Threads | ForEach-Object { if ($_.ThreadState -eq 'Wait') { $_.WaitReason.ToString() } else { $_.ThreadState.ToString() } }) | ConvertTo-Json -Compress`,
    ], { stdout: "pipe", stderr: "pipe" });
    const states: unknown = JSON.parse(await new Response(query.stdout).text());
    expect(await query.exited).toBe(0);
    expect(Array.isArray(states) && states.length > 0 && states.every((state: unknown) => state === "Suspended")).toBe(true);
    child.send("RESUMED");
    expect(winSignal(child.pid, "SIGCONT")).toBe(true);
    suspended = false;
    await Promise.race([resumed.promise, deadline]);
    expect(await child.exited).toBe(0);
  } finally {
    if (suspended) winSignal(child.pid, "SIGCONT");
    child.kill();
    await child.exited;
  }
}, 30_000);

test.skipIf(process.platform !== "win32")("Windows refuses to suspend an invalid process", () => {
  // Given the reserved system idle PID, which OpenProcess cannot open.
  const pid = 0;
  // When suspension is requested.
  const suspended = winSignal(pid, "SIGSTOP");
  // Then failure is reported without suspending anything.
  expect(suspended).toBe(false);
});

test.skipIf(process.platform !== "win32")("review 3 double handover freeze thaws from a separate invocation", async () => {
  // Given a running agent and one per-handover suspension tracker.
  const dir = mkdtempSync(join(tmpdir(), "dori-double-freeze-"));
  const ready = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  const timeout = AbortSignal.timeout(20_000);
  const deadline = new Promise<never>((_resolve, reject) => timeout.addEventListener("abort", () => reject(timeout.reason), { once: true }));
  const child = Bun.spawn([process.execPath, "--eval", `
    process.on("message", message => { process.send(message); process.disconnect(); });
    process.send("READY");
  `], {
    stdout: "ignore", stderr: "pipe",
    ipc(message) { if (message === "READY") ready.resolve(); if (message === "RESUMED") resumed.resolve(); },
  });
  const signal = freezeSignal(winSignal);
  const runner: Runner = async () => ({ code: 0, out: JSON.stringify({ result: { process_info: { shell_pid: child.pid } } }), err: "" });
  let suspended = false;
  try {
    await Promise.race([ready.promise, deadline]);
    suspended = signal(child.pid, "SIGSTOP");
    expect(suspended).toBe(true);
    // When handover expands its already-stopped agent into a complete pane freeze.
    const ice = await freezePane({ signal, run: runner, procs: async () => [{ pid: child.pid, ppid: process.pid, cmd: "omo.exe" }] }, "w1:p1", process.pid);
    expect(ice.pids).toEqual([child.pid]);
    writeFrozen(dir, { pane: "w1:p1", aoeId: "w1:p1", at: new Date(0).toISOString(), agentPid: child.pid, pids: [...ice.pids, ...ice.pids] });
    child.send("RESUMED");
    const receipt = join(dir, "thaw.json");
    const thawer = Bun.spawn([process.execPath, "--eval", `
      import { thawFrozen } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "../src/frozen.ts")).href)};
      import { winSignal } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "../src/win-suspend.ts")).href)};
      const signals = [];
      thawFrozen({ signal: (pid, sig) => { signals.push({ pid, sig }); return winSignal(pid, sig); } }, ${JSON.stringify(dir)}, "w1:p1");
      await Bun.write(${JSON.stringify(receipt)}, JSON.stringify(signals));
    `], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([thawer.exited, new Response(thawer.stdout).text(), new Response(thawer.stderr).text()]);
    expect({ code, out, err }).toMatchObject({ code: 0 });
    // Then a fresh process resumes the unique recorded PID once and the real agent runs again.
    expect(await Bun.file(receipt).json()).toEqual([{ pid: child.pid, sig: "SIGCONT" }]);
    await Promise.race([resumed.promise, deadline]);
    suspended = false;
    expect(await child.exited).toBe(0);
  } finally {
    if (suspended) winSignal(child.pid, "SIGCONT");
    child.kill();
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

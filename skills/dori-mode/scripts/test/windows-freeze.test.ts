import { expect, test } from "bun:test";
import { winSignal } from "../src/win-suspend.ts";

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

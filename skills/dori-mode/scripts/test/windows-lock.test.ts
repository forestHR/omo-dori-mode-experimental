import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointError, takeLock } from "../src/checkpoints.ts";

const onWindows = test.skipIf(process.platform !== "win32");

onWindows("a Windows lock refuses a second taker with the holder's pid, and is free again once released", () => {
  // Given a lock taken in a fresh directory.
  const dir = mkdtempSync(join(tmpdir(), "dori-win-lock-"));
  try {
    const lock = join(dir, "cost.lock");
    const release = takeLock(lock, Date.now(), "cost record", "lane");
    // When a second taker tries while it is held.
    // Then it is refused as busy, naming the holder.
    expect(() => takeLock(lock, Date.now(), "cost record", "lane")).toThrow(CheckpointError);
    expect(() => takeLock(lock, Date.now(), "cost record", "lane")).toThrow(`pid ${process.pid}`);
    // And after the release the file is gone and the lock can be taken again.
    release();
    expect(existsSync(lock)).toBe(false);
    takeLock(lock, Date.now(), "cost record", "lane")();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

onWindows("a Windows lock held by a process that is killed is free again, with no takeover by age", async () => {
  // Given another process that takes the lock and waits.
  const dir = mkdtempSync(join(tmpdir(), "dori-win-lock-"));
  try {
    const lock = join(dir, "cost.lock");
    const script = join(dir, "holder.ts");
    await Bun.write(script, `import { takeLock } from ${JSON.stringify(join(import.meta.dir, "..", "src", "checkpoints.ts"))};
takeLock(${JSON.stringify(lock)}, Date.now(), "cost record", "lane");
console.log("HELD");
await new Promise(() => {});`);
    const holder = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "inherit" });
    const reader = holder.stdout.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("HELD");
    expect(() => takeLock(lock, Date.now(), "cost record", "lane")).toThrow(`pid ${holder.pid}`);
    // When the holder is killed.
    holder.kill();
    await holder.exited;
    // Then the lock can be taken at once.
    takeLock(lock, Date.now(), "cost record", "lane")();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

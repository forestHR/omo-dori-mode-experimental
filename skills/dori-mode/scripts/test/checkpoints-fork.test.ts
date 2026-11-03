import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";

import { CheckpointError, Checkpoints, type CheckpointInput } from "../src/checkpoints.ts";
import { Registry } from "../src/registry.ts";
import { withState } from "./fakes.ts";

// The fork changes to the upstream journal (src/checkpoints.ts "Fork change"), from the reviews of orientpine#297.
const input: CheckpointInput = { step: "deploy", result: "ok", evidence: ["log"], remoteEffects: [] };
const next: CheckpointInput = { step: "next", result: "ok", evidence: ["log"], remoteEffects: [] };

// The path each descriptor names right now, so a descriptor number the kernel hands out again is not mistaken for an old one.
const trackFds = () => {
  const open = new Map<number, string>();
  const original = { open: fs.openSync, close: fs.closeSync };
  const opened = spyOn(fs, "openSync").mockImplementation(((file: string, ...rest: unknown[]) => {
    const fd = (original.open as (...a: unknown[]) => number)(file, ...rest);
    open.set(fd, String(file));
    return fd;
  }) as typeof fs.openSync);
  const closed = spyOn(fs, "closeSync").mockImplementation(((fd: number) => {
    open.delete(fd);
    original.close(fd);
  }) as typeof fs.closeSync);
  return { open, restore: () => { opened.mockRestore(); closed.mockRestore(); } };
};

describe("checkpoints (fork changes)", () => {
  // The holder takes the lock in another process with an owner record an hour old, and holds it until stdin gets a line.
  test("a live writer's lock is never taken over, however old its record; once its process dies the next writer locks at once", async () => {
    const state = withState();
    const source = join(import.meta.dir, "..", "src", "checkpoints.ts");
    const script = `import { Checkpoints } from ${JSON.stringify(source)};
      new Checkpoints(${JSON.stringify(state.dir)}).lock("demo-lane", Date.now() - 60 * 60_000);
      console.log("LOCKED");
      for await (const _ of console) break;`;
    const proc = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    try {
      const reader = proc.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("LOCKED");
      const journal = new Checkpoints(state.dir);
      expect(() => journal.write("demo-lane", input, Date.now())).toThrow(`writer locked: demo-lane (pid ${proc.pid}, 3600 s old)`);
      expect(() => journal.write("demo-lane", input, Date.now() + 24 * 60 * 60_000)).toThrow(CheckpointError);
      proc.kill("SIGKILL");
      await proc.exited;
      journal.write("demo-lane", input, Date.now());
      expect(journal.read("demo-lane").map((c) => c.step)).toEqual(["deploy"]);
    } finally { proc.kill(); state.done(); }
  });

  test("an identical replay of a record a killed writer appended before its fsync is flushed, with its directory, before it is acknowledged", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      const path = journal.path("demo-lane");
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify({ key: "demo-lane", at: new Date(1000).toISOString(), ...input })}\n`);
      const fds = trackFds();
      const flushed: string[] = [];
      const original = fs.fsyncSync;
      const synced = spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => {
        flushed.push(fds.open.get(fd) ?? "?");
        original(fd);
      }) as typeof fs.fsyncSync);
      try {
        expect(journal.write("demo-lane", input, 2000).unchanged).toBe(true);
      } finally {
        synced.mockRestore();
        fds.restore();
      }
      expect(flushed).toContain(path);
      expect(flushed).toContain(dirname(path));
    } finally { state.done(); }
  });

  test("a record the disk takes only part of is cut off again and refused: the journal keeps its lines and takes the next write", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      const path = journal.path("demo-lane");
      journal.write("demo-lane", input, 1000);
      const before = readFileSync(path, "utf8");
      const fds = trackFds();
      const original = fs.writeSync;
      let calls = 0;
      // The journal takes half of the record, then the disk is full.
      const write = spyOn(fs, "writeSync").mockImplementation(((fd: number, data: Buffer | string, ...rest: unknown[]) => {
        if (fds.open.get(fd) !== path) return (original as (...a: unknown[]) => number)(fd, data, ...rest);
        calls++;
        if (calls > 1) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        const bytes = Buffer.isBuffer(data) ? data.subarray(Number(rest[0] ?? 0)) : Buffer.from(data);
        return original(fd, bytes.subarray(0, Math.floor(bytes.length / 2)));
      }) as typeof fs.writeSync);
      try {
        expect(() => journal.write("demo-lane", next, 2000)).toThrow("ENOSPC");
      } finally {
        write.mockRestore();
        fds.restore();
      }
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(journal.read("demo-lane").map((c) => c.step)).toEqual(["deploy"]);
      journal.write("demo-lane", next, 3000);
      expect(journal.read("demo-lane").map((c) => c.step)).toEqual(["deploy", "next"]);
    } finally { state.done(); }
  });

  test("checkpoint state lives apart from the registry: lanes foo.json and foo both checkpoint, and the registry still lists both", async () => {
    const state = withState();
    try {
      const registry = new Registry(state.dir);
      for (const key of ["foo.json", "foo"]) await registry.write({ key, title: key, thread: "none", brief: "/b.md", done: "file x", openedAt: new Date(1000).toISOString() });
      const journal = new Checkpoints(state.dir);
      journal.write("foo.json", input, 2000);
      journal.write("foo", input, 2000);
      expect((await registry.list()).map((l) => l.key).sort()).toEqual(["foo", "foo.json"]);
      expect(journal.read("foo.json").map((c) => c.step)).toEqual(["deploy"]);
      expect(journal.read("foo").map((c) => c.step)).toEqual(["deploy"]);
    } finally { state.done(); }
  });

  test("a last record left without its newline gets one before the next record, so both stay readable", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      const path = journal.path("demo-lane");
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify({ key: "demo-lane", at: new Date(1000).toISOString(), ...input }));
      expect(journal.read("demo-lane").map((c) => c.step)).toEqual(["deploy"]);
      journal.write("demo-lane", next, 2000);
      expect(journal.read("demo-lane").map((c) => c.step)).toEqual(["deploy", "next"]);
      expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
    } finally { state.done(); }
  });
});

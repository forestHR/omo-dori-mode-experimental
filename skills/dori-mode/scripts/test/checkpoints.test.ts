// Ported unchanged from https://github.com/sisyphuslabs/omo-dori-mode-experimental/blob/90f02c19fd86ce70cfd6a74f521c9acd24428cc3/skills/dori-mode/scripts/test/checkpoints.test.ts
// (upstream PR #61 (4ea8bd1) with the PR #68 fix (90f02c1)). Keep the body byte-for-byte equal to upstream; fork wiring lives in cli.ts.
import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { CheckpointError, Checkpoints, type CheckpointInput } from "../src/checkpoints.ts";
import { Registry } from "../src/registry.ts";
import { withState } from "./fakes.ts";

// A separate process takes the journal lock through the real code, says LOCKED, and holds it until stdin gets a line.
const holder = (dir: string) => {
  const source = join(import.meta.dir, "..", "src", "checkpoints.ts");
  const script = `import { Checkpoints } from ${JSON.stringify(source)};
    const release = new Checkpoints(${JSON.stringify(dir)}).lock("demo-lane", Date.now());
    console.log("LOCKED");
    for await (const _ of console) break;
    release();`;
  const proc = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const locked = (async () => {
    let seen = "";
    for await (const chunk of proc.stdout) {
      seen += new TextDecoder().decode(chunk);
      if (seen.includes("LOCKED")) return;
    }
    throw new Error(`holder exited before locking: ${seen}`);
  })();
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("holder did not lock in 10 s")), 10_000).unref());
  return { proc, locked: Promise.race([locked, timeout]) };
};

const input: CheckpointInput = { step: "deploy", result: "completed", evidence: ["receipt:123"], remoteEffects: ["release:123"] };
const next: CheckpointInput = { ...input, step: "next", remoteEffects: ["release:456"] };

describe("checkpoints", () => {
  test("persists completion and returns identical replay unchanged after restart", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      const written = journal.write("demo-lane", input, 1000);
      expect(written.unchanged).toBe(false);
      const before = readFileSync(journal.path("demo-lane"), "utf8");
      const restarted = new Checkpoints(state.dir);
      expect(restarted.write("demo-lane", { remoteEffects: input.remoteEffects, evidence: input.evidence, result: input.result, step: input.step }, 2000))
        .toEqual({ checkpoint: written.checkpoint, unchanged: true });
      expect(readFileSync(journal.path("demo-lane"), "utf8")).toBe(before);
      expect(restarted.read("demo-lane")).toEqual([written.checkpoint]);
    } finally { state.done(); }
  });

  test("conflicting replay fails without overwriting or appending", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      const first = journal.write("demo-lane", input, 1000);
      const before = readFileSync(journal.path("demo-lane"), "utf8");
      expect(() => new Checkpoints(state.dir).write("demo-lane", { ...input, remoteEffects: ["release:other"] }, 2000))
        .toThrow("conflicting checkpoint step");
      expect(journal.read("demo-lane")).toEqual([first.checkpoint]);
      expect(readFileSync(journal.path("demo-lane"), "utf8")).toBe(before);
      expect(existsSync(`${journal.path("demo-lane")}.lock`)).toBe(false);
    } finally { state.done(); }
  });

  test("a remote-effect receipt already recorded under one step is refused under another", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      const first = journal.write("demo-lane", input, 1000);
      expect(() => journal.write("demo-lane", { ...input, step: "deploy-again" }, 2000))
        .toThrow("remote effect release:123 already recorded by step deploy");
      expect(journal.read("demo-lane")).toEqual([first.checkpoint]);
    } finally { state.done(); }
  });

  test("a corrupt record after a blank line is reported at its physical line", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      journal.write("demo-lane", input, 1000);
      appendFileSync(journal.path("demo-lane"), "\n{not json\n");
      expect(() => journal.read("demo-lane")).toThrow(`${journal.path("demo-lane")}:3:`);
    } finally { state.done(); }
  });

  test("a stored record whose timestamp is not a string is refused", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      const { checkpoint } = journal.write("demo-lane", input, 1000);
      writeFileSync(journal.path("demo-lane"), `${JSON.stringify({ ...checkpoint, at: 1000 })}\n`);
      expect(() => journal.read("demo-lane")).toThrow("invalid key, timestamp, or duplicate step");
    } finally { state.done(); }
  });

  test("dori checkpoint takes one receipt per --remote-effect and refuses a stray argument instead of dropping it", async () => {
    const state = withState();
    try {
      await new Registry(state.dir).write({ key: "demo-lane", title: "demo", thread: "none", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date().toISOString() });
      const cli = async (...args: string[]) => {
        const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "checkpoint", "demo-lane", "--result", "ok", "--evidence", "log", ...args], {
          env: { ...process.env, DORI_CONFIG: join(state.dir, "none.json"), DORI_STATE_DIR: state.dir }, stdout: "pipe", stderr: "pipe",
        });
        return { code: await proc.exited, err: await new Response(proc.stderr).text() };
      };
      const journal = new Checkpoints(state.dir);
      const refused = await cli("--step", "push", "--remote-effect", "push:a", "push:b");
      expect(refused.code).not.toBe(0);
      expect(refused.err).toContain("unexpected argument push:b");
      expect(journal.read("demo-lane")).toEqual([]);
      expect((await cli("--step", "push", "--remote-effect", "push:a", "--remote-effect", "push:b")).code).toBe(0);
      expect(journal.read("demo-lane").map((c) => c.remoteEffects)).toEqual([["push:a", "push:b"]]);
    } finally { state.done(); }
  });

  test("rejects malformed input, invalid keys, corrupt journals and duplicate stored steps", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      expect(journal.read("demo-lane")).toEqual([]);
      expect(() => journal.path("../escape")).toThrow(CheckpointError);
      expect(() => journal.write("demo-lane", { ...input, step: "" }, 1000)).toThrow(CheckpointError);
      const { checkpoint } = journal.write("demo-lane", input, 1000);
      appendFileSync(journal.path("demo-lane"), `${JSON.stringify(checkpoint)}\n`);
      expect(() => journal.read("demo-lane")).toThrow("duplicate step");
      expect(() => journal.write("demo-lane", next, 1000)).toThrow(CheckpointError);
    } finally { state.done(); }
  });

  test("a live writer in another process holds the lock; the next writer is refused, then writes once it is released", async () => {
    const state = withState();
    // Write before the holder starts: a write racing the holder's lock attempt can make the holder lose it and exit.
    const journal = new Checkpoints(state.dir);
    journal.write("demo-lane", input, Date.now());
    const { proc, locked } = holder(state.dir);
    try {
      await locked;
      const before = readFileSync(journal.path("demo-lane"), "utf8");
      expect(() => journal.write("demo-lane", next, Date.now())).toThrow(`writer locked: demo-lane (pid ${proc.pid}`);
      expect(readFileSync(journal.path("demo-lane"), "utf8")).toBe(before);
      proc.stdin.write("release\n");
      await proc.stdin.end();
      expect(await proc.exited).toBe(0);
      journal.write("demo-lane", next, Date.now());
      expect(journal.read("demo-lane").map((c) => c.step)).toEqual(["deploy", "next"]);
      expect(existsSync(`${journal.path("demo-lane")}.lock`)).toBe(false);
    } finally { proc.kill(); state.done(); }
  });

  test("a lock left by a writer killed mid-write is taken over at once", async () => {
    const state = withState();
    const { proc, locked } = holder(state.dir);
    try {
      const journal = new Checkpoints(state.dir);
      await locked;
      proc.kill("SIGKILL");
      await proc.exited;
      expect(existsSync(`${journal.path("demo-lane")}.lock`)).toBe(true);
      journal.write("demo-lane", input, Date.now());
      expect(journal.read("demo-lane").map((c) => c.step)).toEqual(["deploy"]);
      expect(existsSync(`${journal.path("demo-lane")}.lock`)).toBe(false);
    } finally { state.done(); }
  });

  // Fork change (reviews of orientpine#297): the writer lock is a kernel flock, so upstream's three cases of taking a
  // lock over by age (a live pid's lock after two minutes, an unreadable time aged by mtime, a release racing that
  // takeover) are replaced by what the flock guarantees instead.
  test("a held lock is refused however old its owner record says it is; released, the next writer locks at once", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      const release = journal.lock("demo-lane", 1000); // held by this process, on its own open file
      expect(() => journal.write("demo-lane", input, 1000 + 60 * 60_000)).toThrow(`writer locked: demo-lane (pid ${process.pid}, 3600 s old)`);
      expect(journal.read("demo-lane")).toEqual([]);
      release();
      journal.write("demo-lane", input, 2000);
      expect(journal.read("demo-lane").map((c) => c.step)).toEqual(["deploy"]);
      expect(existsSync(`${journal.path("demo-lane")}.lock`)).toBe(false);
    } finally { state.done(); }
  });

  test("a lock file no writer holds never blocks, whatever record it has", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      const lock = `${journal.path("demo-lane")}.lock`;
      mkdirSync(dirname(lock), { recursive: true });
      writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), nonce: "left" }));
      journal.write("demo-lane", input, Date.now());
      writeFileSync(lock, "not json");
      journal.write("demo-lane", next, Date.now());
      expect(journal.read("demo-lane").map((c) => c.step)).toEqual(["deploy", "next"]);
      expect(existsSync(lock)).toBe(false);
    } finally { state.done(); }
  });

  test("a second release is a no-op and never removes the lock another writer took after the first", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      const lock = `${journal.path("demo-lane")}.lock`;
      const first = journal.lock("demo-lane", 1000);
      first();
      const second = new Checkpoints(state.dir).lock("demo-lane", 2000);
      first();
      expect(JSON.parse(readFileSync(lock, "utf8")).at).toBe(new Date(2000).toISOString());
      expect(() => journal.write("demo-lane", input, 3000)).toThrow("writer locked: demo-lane");
      second();
      expect(readdirSync(dirname(lock))).toEqual([]);
    } finally { state.done(); }
  });
});

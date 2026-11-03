import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileLog, keep, type Running, serve, serveLoops, spawnLoop } from "../src/serve.ts";
import { fakeClock } from "./fakes.ts";

// dori serve keeps each loop up where no systemd does (native Windows): a loop that exits starts again after a pause that
// doubles while it keeps failing, and its lines go to the log tagged.
const once = (lines: string[], code: number): Running => ({ lines: (async function* () { yield* lines; })(), exited: Promise.resolve(code) });

test("a loop that exits starts again after 2, 4, 8 s, its lines tagged; stop ends it", async () => {
  const clock = fakeClock(0);
  const pauses: number[] = [];
  const log: string[] = [];
  let starts = 0;
  await keep({ tag: "watch", argv: ["bun", "cli.ts", "watch"] }, {
    start: () => once([`line ${++starts}`], 1),
    log: (l) => log.push(l),
    clock: { now: clock.now, sleep: async (ms) => { pauses.push(ms); clock.at += ms; } },
    stop: () => starts >= 4,
  });
  expect(pauses).toEqual([2_000, 4_000, 8_000]);
  expect(log.slice(0, 3)).toEqual(["watch SERVE_STARTED cli.ts watch", "watch line 1", "watch SERVE_EXITED code 1; again in 2 s"]);
});

test("a loop that ran 10 minutes before it exited starts again after the first pause", async () => {
  const clock = fakeClock(0);
  const pauses: number[] = [];
  let starts = 0;
  await keep({ tag: "inbound", argv: ["bun", "cli.ts", "inbound", "discord"] }, {
    start: () => {
      starts++;
      if (starts === 3) clock.at += 11 * 60_000;
      return once([], 1);
    },
    log: () => undefined,
    clock: { now: clock.now, sleep: async (ms) => { pauses.push(ms); clock.at += ms; } },
    stop: () => starts >= 4,
  });
  expect(pauses).toEqual([2_000, 4_000, 2_000]);
});

test("the loops are the sweeps of dori-lanes.sh, the listener and the session watcher", () => {
  expect(serveLoops("bun", "cli.ts", "sw.ts").map((l) => l.argv.slice(1).join(" "))).toEqual(["cli.ts watch", "cli.ts freshness --loop 2", "cli.ts dead-panes --loop 5", "cli.ts guard --loop 1", "cli.ts state-git loop", "cli.ts inbound discord", "sw.ts"]);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("review 1 serve starts and records real child output with a nonexistent state directory", async () => {
  // Given a fresh installation with no state directory.
  const root = mkdtempSync(join(tmpdir(), "dori-serve-review-"));
  roots.push(root);
  const log = join(root, "missing", "state", "serve.log");
  const output = join(root, "child.json");
  let finished = false;
  let exited = Promise.resolve(0);
  try {
    // When a real supervised child runs after logger preparation.
    await serve([{ tag: "fixture", argv: [process.execPath, "--eval", `await Bun.write(${JSON.stringify(output)}, '{"ran":true}'); console.log("REVIEW_CHILD_READY");`] }], {
      start: (argv) => {
        const child = spawnLoop(argv);
        exited = child.exited;
        void exited.then(() => { finished = true; });
        return child;
      },
      log: fileLog(log, fakeClock(0)), clock: fakeClock(0), stop: () => finished,
    });
    // Then the child completed and its output was persisted in the new directory.
    expect(await Bun.file(output).json()).toEqual({ ran: true });
    expect((await Bun.file(log).text()).split("\n").filter((line) => line.endsWith("fixture REVIEW_CHILD_READY"))).toHaveLength(1);
  } finally {
    await exited;
  }
});

test("review 1 serve refuses an unusable log directory before any child starts", async () => {
  // Given a file where the log's parent directory must be.
  const root = mkdtempSync(join(tmpdir(), "dori-serve-review-"));
  roots.push(root);
  const parent = join(root, "file");
  writeFileSync(parent, "occupied");
  let starts = 0;
  let exited = Promise.resolve(0);
  try {
    // When supervision prepares its logger.
    await expect((async () => serve([{ tag: "fixture", argv: [process.execPath, "--eval", "process.exit(0)"] }], {
      start: (argv) => {
        starts++;
        const child = spawnLoop(argv);
        exited = child.exited;
        return child;
      },
      log: fileLog(join(parent, "serve.log"), fakeClock(0)), clock: fakeClock(0),
    }))()).rejects.toThrow();
    // Then no process was started before the filesystem failure.
    expect(starts).toBe(0);
  } finally {
    await exited;
  }
});

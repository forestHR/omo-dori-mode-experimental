import { expect, test } from "bun:test";
import { join } from "node:path";

import { keep, type Running, serveLoops, taskArgv } from "../src/serve.ts";
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

test("the loops are the sweeps of dori-lanes.sh, the listener and the session watcher; the logon task runs dori serve", () => {
  expect(serveLoops("bun", "cli.ts", "sw.ts").map((l) => l.argv.slice(1).join(" "))).toEqual(["cli.ts watch", "cli.ts freshness --loop 2", "cli.ts dead-panes --loop 5", "cli.ts guard --loop 1", "cli.ts state-git loop", "cli.ts inbound discord", "sw.ts"]);
  expect(taskArgv("C:\\b\\bun.exe", "C:\\d\\cli.ts", "C:\\s").slice(-1)[0]).toBe(`"C:\\b\\bun.exe" "C:\\d\\cli.ts" serve --log "${join("C:\\s", "serve.log")}"`);
});

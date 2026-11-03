// Drive three real watcher ticks without wall-clock waits or live processes.
import { mock } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";

import * as realRun from "../src/run.ts";

const configFile = process.env.DORI_CONFIG ?? "";
const stateDir = process.env.DORI_STATE_DIR ?? "";
const sessions = [
  { id: "11111111-old", title: "old", path: "/repo" },
  { id: "22222222-new", title: "new", path: "/repo" },
  { id: "33333333-before", title: "before", path: "/repo" },
  { id: "44444444-after", title: "after", path: "/repo" },
];
let tick = 0;
// the rest of run.ts (iso, realClock) stays: the watcher's shared modules use it
mock.module("../src/run.ts", () => ({
  ...realRun,
  run: async (argv: readonly string[]) => {
    let out = "";
    // the watcher asks herdr for its panes too; no herdr server runs here
    if (argv[0] === "herdr") return { code: 1, out: "", err: "server is not running" };
    if (argv[0] === "aoe" && argv[1] === "list") out = JSON.stringify(sessions);
    else if (argv[0] === "aoe" && argv[1] === "ps") out = JSON.stringify(sessions.map((s) => ({ session: s.id, state: tick === 2 ? "waiting" : "running" })));
    else if (argv[0] === "tmux" && argv[1] === "ls") out = sessions.map((s) => `aoe_${s.title}_${s.id.slice(0, 8)}`).join("\n");
    else if (argv[0] === "tmux" && argv[1] === "capture-pane") {
      appendFileSync(`${stateDir}/captures.jsonl`, `${JSON.stringify({ tick, pane: argv.at(-1) })}\n`);
      out = "Ready\n❯ ";
    } else if (argv[0] !== "ps" && !(argv[0] === "tmux" && argv[1] === "display")) throw new Error(`unexpected watcher command: ${argv.join(" ")}`);
    return { code: 0, out, err: "" };
  },
}));
Object.defineProperty(Bun, "sleep", { value: async () => {
  tick++;
  if (tick === 3) process.exit(0);
  writeFileSync(configFile, JSON.stringify({ stateDir, leadPane: "aoe_new_22222222", ignorePanes: ["aoe_after_44444444"], update: { repo: stateDir } }));
} });

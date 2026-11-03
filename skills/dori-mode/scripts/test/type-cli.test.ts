import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

// dori type through the real CLI, against a fake herdr on PATH that logs every call: what reaches the pane is what the
// CLI made of --text / --text-file, and an option type does not take stops it before any pane is touched
const typeCli = async (args: readonly string[]) => {
  const state = withState();
  try {
    const calls = join(state.dir, "herdr.log");
    const bin = join(state.dir, "bin");
    await run(["mkdir", "-p", bin]);
    const herdr = join(bin, "herdr");
    writeFileSync(herdr, `#!/bin/bash
printf '%s\\0' "$@" >> ${JSON.stringify(calls)}; printf '\\n' >> ${JSON.stringify(calls)}
case "$1 $2" in
  "pane get") echo '{"result":{"pane":{"agent":"pi","agent_status":"idle"}}}' ;;
  "pane read") printf '── • Working (1s • esc to interrupt) ──────\\n❯ \\n──────────────────────────────\\n' ;;
esac
`);
    chmodSync(herdr, 0o755);
    const config = join(state.dir, "config.json");
    writeFileSync(config, JSON.stringify({ backend: "herdr", agentCommand: ["pi"], stateDir: state.dir, watchLog: join(state.dir, "lanes.log") }));
    const r = await run(["env", `PATH=${bin}:${process.env.PATH}`, `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`,
      "bun", join(import.meta.dir, "../src/cli.ts"), "type", "w9:p9", ...args]);
    const sent = existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => l.split("\0").filter(Boolean)).filter((a) => a[1] === "send-text").map((a) => a[3]) : [];
    return { code: r.code, out: r.out, err: r.err, sent, touched: existsSync(calls) };
  } finally {
    state.done();
  }
};

test("dori type keeps the space before a /text, so omo takes it as a message; trailing whitespace is dropped", async () => {
  const r = await typeCli(["--text", " /notacommand  "]);
  expect({ code: r.code, out: r.out, sent: r.sent }).toEqual({ code: 0, out: "SUBMITTED w9:p9", sent: [" /notacommand"] });
});

test("dori type --text-file keeps the space before a /text too, and drops blank lines before it", async () => {
  const state = withState();
  try {
    const file = join(state.dir, "text.txt");
    writeFileSync(file, "\n\n /notacommand\n");
    expect((await typeCli(["--text-file", file])).sent).toEqual([" /notacommand"]);
  } finally {
    state.done();
  }
});

test("dori type refuses an option it does not take (the removed --as-text) before any pane is touched", async () => {
  for (const args of [["--text", "/quit", "--as-text"], ["--as-text", "--text", "/notacommand"]]) {
    const r = await typeCli(args);
    expect({ code: r.code, refused: r.err.includes("UNKNOWN_OPTION type: --as-text"), touched: r.touched }).toEqual({ code: 2, refused: true, touched: false });
  }
});

test("dori type refuses a text of whitespace only", async () => {
  const r = await typeCli(["--text", "   "]);
  expect({ code: r.code, touched: r.touched }).toEqual({ code: 1, touched: false });
});

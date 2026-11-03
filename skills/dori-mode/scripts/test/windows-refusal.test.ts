import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDueFrozen, closeFrozen, freezePane, frozenFile, thawFrozen, writeFrozen } from "../src/frozen.ts";
import { handover, type HandoverDeps } from "../src/handover.ts";
import { laneHandover, type LaneHandoverDeps } from "../src/lane-handover.ts";
import { depsFor, fakeClock, newWorld } from "./fakes.ts";

const LANE = "HANDOVER_REFUSED demo: freezing panes is not supported on Windows yet; close the lane and start a new one (dori close demo, then dori launch <new-key> --title T --brief FILE --done CONDITION --no-thread REASON) instead of a handover";
const LEAD = "HANDOVER_REFUSED lead: freezing panes is not supported on Windows yet; close the old lead pane in herdr, start a new lead with omo in a new pane, and update leadPane in your config instead of a handover";
const PANE = "HANDOVER_REFUSED w1:p1: freezing panes is not supported on Windows yet; close the pane in herdr and start a new agent with omo instead of freezing or thawing it";
const unexpected = (): never => { throw new Error("refusal must not call a dependency"); };

test("Windows handover, freeze and thaw refuse before touching processes or files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dori-refuse-"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const printed: string[] = [];
  const base = depsFor(newWorld(), fakeClock(0), dir, { backend: "herdr" });
  const deps: LaneHandoverDeps & HandoverDeps = {
    ...base, run: unexpected, procs: unexpected, signal: unexpected,
    cardDir: join(dir, "cards"), home: dir, sessionOf: unexpected,
    envOf: unexpected, alive: unexpected, realpath: unexpected,
    nonce: unexpected, print: (line) => printed.push(line),
    configPath: join(dir, "config.json"), envPath: join(dir, "dori.env"),
    inbox: join(dir, "inbox.jsonl"), routedPane: unexpected, envLeadPane: "",
    timers: unexpected, restart: unexpected,
  };
  const rec = { pane: "w1:p1", aoeId: "", at: "2026-11-03T00:00:00Z", agentPid: 11, pids: [11, 12], closeAt: "2026-11-03T01:00:00Z" };
  writeFrozen(dir, rec);
  const before = readFileSync(frozenFile(dir, rec.pane), "utf8");
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(await laneHandover(deps, "demo", "", { approvedBy: "lead:test", waitIdleMin: 1 })).toEqual({ code: 2 });
    expect(await laneHandover(deps, "demo", "", { dryRun: true })).toEqual({ code: 2 });
    expect(await handover(deps, { approvedBy: "lead:test" })).toEqual({ code: 2 });
    expect(printed).toEqual([LANE, LANE, LEAD]);
    expect(await freezePane(deps, rec.pane, process.pid)).toEqual({ pids: [], why: PANE });
    expect(thawFrozen(deps, dir, rec.pane)).toBe(PANE);
    expect(await closeFrozen(deps, dir, rec)).toBe(PANE);
    expect(await closeDueFrozen(deps, dir, Date.parse("2026-11-04T00:00:00Z"))).toEqual([]);
    expect(readFileSync(frozenFile(dir, rec.pane), "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["handover"]);
    expect(readdirSync(join(dir, "handover"))).toEqual(["frozen"]);
  } finally {
    Object.defineProperty(process, "platform", platform);
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  { args: ["handover"], line: LEAD },
  { args: ["handover", "--lane", "demo"], line: LANE },
  { args: ["handover", "thaw", "w1:p1"], line: PANE },
])("Windows CLI refuses $args without creating state", async ({ args, line }) => {
  const dir = mkdtempSync(join(tmpdir(), "dori-cli-refuse-"));
  try {
    const cli = new URL("../src/cli.ts", import.meta.url).href;
    const child = Bun.spawn([process.execPath, "-e", `Object.defineProperty(process, "platform", {value:"win32"}); process.argv = ["bun", "cli", ...${JSON.stringify(args)}]; await import(${JSON.stringify(cli)});`], {
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DORI_"))),
        DORI_CONFIG: join(dir, "config.json"), DORI_ENV_FILE: join(dir, "dori.env"), DORI_STATE_DIR: join(dir, "state"),
      }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ out, err, code }).toEqual({ out: "", err: `${line}\n`, code: 2 });
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// allow: SIZE_OK - existing shared handover simulation; the new assertion checks one OS stop per agent.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { pauseLane } from "../src/done-flow.ts";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { autoReadyLine, freshnessTick, pidAlive, resumeArgs } from "../src/freshness.ts";
import { closeDueFrozen, readFrozen } from "../src/frozen.ts";
import { ackHandover, manifestPath } from "../src/handover.ts";
import { compactionStuckOn, type LaneFacts, laneHandover, type LaneHandoverDeps, type LaneHandoverOptions, markReady, missingFrom, pendingFile, readyFile, statusLine, trainingMark, waitingRequest } from "../src/lane-handover.ts";
import { appendRollover, approvalProblem, AUTO_GRANT_MS, mintAutoGrant, takeAutoGrant, compactionScan, holdTyped, inboxMessages, compactionsIn, crossed, ownerRolloverText, peerStuckLines, quietReason, readRollovers, rolloverCause, rolloverStats, sessionSignals } from "../src/rollover.ts";
import { stuckTop, stuckView } from "../src/explore.ts";
import { recordFix } from "../src/same-fix.ts";
import { QuestionStore } from "../src/messenger/discord-cards.ts";
import type { Lane } from "../src/registry.ts";
import type { Proc } from "../src/session-id.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { defaultConfig } from "../src/config.ts";
import { depsFor, fakeClock, launchReadyPath, NEW_AOE_ID, newWorld, RUNNING, sent, withState, type World } from "./fakes.ts";

const OLD_ID = "1a1a1a1a22223333";
const OLD = "aoe_demo_1a1a1a1a";
const NEW = `aoe_demo-10111635_${NEW_AOE_ID.slice(0, 8)}`;
const CWD = "/work/demo";
const MODEL = "anthropic-subscription/claude-opus-5-5:high";
const EVENTS = "tail -n 0 -F /tmp/events.log";

const status = (model: string, pct = "9.0", account = "x") => `old transcript line\n❯ \n────\n Claude·${account} ▕██▏ 60%\n~/work • CH85.0% • $0.5 • 90K/1M (${pct}%) (auto)    (anthropic-subscription@${account}) ${model} (shift+tab)\n(OmO) mem:x`;
const HIGH = status("claude-opus-5-5 • effort high", "72.0");
const OK = { approvedBy: "https://discord.com/channels/1/2/3" };
const OWNER = "280680578314010625";

// a restatement that covers the lane's goal under every heading the new session must write
const RESTATE = "## Goal\n레인에도 적용: ship it\n## Owner's words\nnone\n## Decisions\nnone\n## Next step\ntrain E7\n## Ruled out\nnone\n## Questions\nnone\n";

// keepSeed: the new session keeps what the handover wrote into its restatement and adds its own headings; otherwise it
// writes restate over it from scratch (wrote: the files it already wrote once)
// cancel: what the new session does with a HANDOVER_TASKS_CANCEL line: task_cancel each id (its record turns cancelled), or
// only ack it
type Sim = { cancel?: "cancel" | "ack-only"; keepSeed?: boolean; wrote?: string[]; fromNote?: boolean; arm: { description: string; command: string; filter?: string; pid: number }[]; thinking: string; ackPane: string; ack: boolean; restate?: string; supplement: "fix" | "ignore" | "silent"; handled: string[]; account: string; chainSurvives: boolean; grandchildSurvives?: boolean; doubleRun: boolean; restarted: boolean; endsAfterProbe?: number; busyFor?: number; probeWhileBusy?: boolean };

let state: { dir: string; done: () => void };
let w: World;
let sim: Sim;
let printed: string[];
let sigs: string[];
let live: Set<number>;
let table: Proc[];

const AGENT_CMD = `bun /g/senpi/dist/bundle/cli.js --model ${MODEL} --session-id old-sid`;
const baseTable = (): Proc[] => [
  { pid: 10, ppid: 1, cmd: "bash /tmp/aoe-pane-env" },
  { pid: 11, ppid: 10, cmd: AGENT_CMD },
  { pid: 12, ppid: 11, cmd: "bun /g/omo-ai/plugin/runtime/ast-grep-mcp/cli.js mcp" },
  { pid: 13, ppid: 11, cmd: "/r/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude --output-format stream-json" },
  { pid: 20, ppid: 11, cmd: "bun /r/dist/bundle/cli.js --internal-rpc-host-supervisor --socket /x.sock" },
  { pid: 21, ppid: 20, cmd: "bun /r/dist/bundle/cli.js --mode rpc --multi-session" },
  { pid: 14, ppid: 11, cmd: EVENTS },
  { pid: 15, ppid: 11, cmd: "bash -c sleep 7200; echo chain-done" },
  { pid: 16, ppid: 15, cmd: "sleep 7200" },
  { pid: 40, ppid: 1, cmd: "sleep 7201" },
  { pid: 41, ppid: 1, cmd: "sleep 9999" },
];

const monitor = (description: string, command: string, pid: number, extra: Record<string, unknown> = {}) => ({ description, command, filter: "^EV", persistent: true, suspended: false, expiresAt: Date.parse("2026-10-20T00:00:00Z"), runtime: { pid }, ...extra });

const writeManifest = (session: string, monitors: unknown[]) => {
  const file = manifestPath(join(state.dir, "sessions"), CWD, session);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, sessionId: session, monitors }));
};

const lane = (): Lane => ({ key: "demo", title: "Demo lane", thread: "discord:12345678", pane: OLD, brief: join(state.dir, "demo.md"), done: "merged o/r#1", cwd: CWD, model: MODEL, goal: "레인에도 적용", openedAt: "2026-10-11T00:00:00Z", status: "working", lastReport: "[REPORT] demo | milestone | half way" });

const firstMessageSent = () => w.calls.some((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`) && (c.at(-1) ?? "").includes("handover note"));

// The new session as the fake world sees it: once told to read the note it shows its status line and arms its monitors,
// and it acks the probe it receives.
const simulate = () => {
  if (!firstMessageSent()) return;
  // busyFor: the new session's first turn (reading the note) runs for that many sleeps of the handover
  w.screens[NEW] = status(`claude-opus-5-5 • effort ${sim.thinking}`, "9.0", sim.account) + ((sim.busyFor ?? 0) > 0 ? `\n${RUNNING}` : "");
  // the new session restarts the chain only when told the old one ended; both copies alive at once is a double run
  if (!sim.restarted && sent(w).some((x) => x.startsWith("[LEAD] HANDOVER_CHAINS_ENDED"))) {
    sim.restarted = true;
    live.add(301);
  }
  if (live.has(301) && live.has(15)) sim.doubleRun = true;
  if (sim.fromNote) sim.arm = armFromNote();
  writeManifest("new-sid", sim.arm.map((m) => monitor(m.description, m.command, m.pid, m.filter ? { filter: m.filter } : {})));
  const probe = w.calls.find((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`) && (c.at(-1) ?? "").includes("HANDOVER_PROBE n1"))?.at(-1);
  if (sim.ack && probe) {
    // the new session writes what it understood, then acks
    const file = /write what you understood to (\S+)/.exec(probe)?.[1];
    if (file && sim.restate !== "" && !(sim.wrote ?? []).includes(file)) {
      sim.wrote = [...(sim.wrote ?? []), file];
      writeFileSync(file, sim.keepSeed && existsSync(file) ? `${readFileSync(file, "utf8")}\n## Next step\ntrain E7\n## Questions\nnone\n` : (sim.restate ?? RESTATE));
    }
    ackHandover(state.dir, "n1", sim.ackPane, "2026-10-11T16:40:00Z");
    // a monitor that ran at the first check ends now (a remote tail whose ssh dropped)
    if (sim.endsAfterProbe) live.delete(sim.endsAfterProbe);
  }
  for (const line of sent(w)) {
    const c = /^\[LEAD\] HANDOVER_TASKS_CANCEL (\S+): .*\(task_id ([^)]+)\)/.exec(line);
    if (!c?.[1] || !c[2] || !sim.cancel || sim.handled.includes(c[1])) continue;
    sim.handled.push(c[1]);
    if (sim.cancel === "cancel") for (const id of c[2].split(", ")) {
      const file = join(state.dir, ".omo", "agent", "projects", "work-1", "senpi-task", "tasks", `${id}.json`);
      writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, "utf8")) as object), status: "cancelled" }));
    }
    ackHandover(state.dir, c[1], NEW, "2026-10-11T16:42:00Z");
  }
  // a supplement round: it adds the items under the headings named ("fix"), acks without adding ("ignore"), or stays silent
  for (const line of sent(w)) {
    const m = /^\[LEAD\] HANDOVER_SUPPLEMENT (\S+) .*Read (\S+), add them to (\S+), then run/.exec(line);
    if (!m?.[1] || !m[2] || !m[3] || sim.handled.includes(m[1])) continue;
    sim.handled.push(m[1]);
    if (sim.supplement === "silent") continue;
    if (sim.supplement === "fix") {
      let text = existsSync(m[3]) ? readFileSync(m[3], "utf8") : "";
      for (const it of readFileSync(m[2], "utf8").matchAll(/^## \d+\. ([^:\n]+): (.*)\nSource: .*Goes under: (.*)\.$/gm)) {
        const [, kind, item = "", under = ""] = it;
        if (!under.startsWith("## ")) text = RESTATE;
        else if (kind === "heading") text += `\n${under}\nnone\n`;
        else text = text.includes(`${under}\n`) ? text.replace(`${under}\n`, `${under}\n${item}\n`) : `${text}\n${under}\n${item}\n`;
      }
      writeFileSync(m[3], text);
    }
    ackHandover(state.dir, m[1], NEW, "2026-10-11T16:41:00Z");
  }
};

// A new session that does what the note's Monitors section says: each command again, except a LAUNCHES_WORK one, for
// which it arms the exact watch-only command the note gives or a tail of the first file the work writes, same description.
const armFromNote = (): Sim["arm"] => {
  const msg = w.calls.find((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`) && (c.at(-1) ?? "").includes("handover note"))?.at(-1) ?? "";
  const note = /(\/\S+\.md)/.exec(msg)?.[1];
  if (!note) return [];
  const lines = (readFileSync(note, "utf8").split("## Monitors")[1] ?? "").split("\n\n")[0]?.split("\n").filter((l) => l.startsWith("- ")) ?? [];
  const str = (l: string, key: string) => { const m = new RegExp(`${key} ("(?:[^"\\\\]|\\\\.)*")`).exec(l); return m?.[1] ? (JSON.parse(m[1]) as string) : undefined; };
  return lines.map((l, i) => {
    const description = l.slice(2, l.indexOf(": command "));
    const filter = str(l, "filter");
    if (!l.includes("LAUNCHES_WORK")) return { description, command: str(l, "command") ?? "", ...(filter ? { filter } : {}), pid: 201 + i };
    const exact = str(l, "arm exactly command");
    const file = /writes \(([^,)]+)/.exec(l)?.[1];
    return { description, command: exact ?? `tail -n 0 -F ${file}`, ...(filter ? { filter } : {}), pid: 201 + i };
  });
};

const setup = async (): Promise<LaneHandoverDeps> => {
  const clock = fakeClock(Date.parse("2026-10-11T16:35:00Z"));
  const base = depsFor(w, { ...clock, sleep: async () => simulate() }, state.dir, { backend: "aoe", sessionsDir: join(state.dir, "sessions") });
  w.aoe = [{ id: OLD_ID, title: "demo", path: CWD, tool: "omo", profile: "main" }];
  w.tmux = [OLD];
  w.screens[OLD] = HIGH;
  writeManifest("old-sid", [monitor("scratch events", EVENTS, 14), monitor("digest", "until false; do sleep 60; done", 17, { persistent: false, expiresAt: null })]);
  const dir = sessionDirFor(join(state.dir, "sessions"), CWD);
  writeFileSync(join(dir, "2026-10-11T10-00-00-000Z_old-sid.jsonl"), JSON.stringify({ type: "custom", customType: "senpi.todo-state", data: { phases: [{ name: "Work", tasks: [{ content: "done thing", status: "completed" }, { content: "train E7", status: "in_progress" }] }] } }));
  mkdirSync(join(dir, "extensions", "goal"), { recursive: true });
  writeFileSync(join(dir, "extensions", "goal", "old-sid.json"), JSON.stringify({ goal: { objective: "ship lane handover", status: "active" } }));
  writeFileSync(lane().brief, "Do the work.\n");
  // OK links the owner's message in the inbox (an approval link holds only for one the inbox has from the owner)
  writeFileSync(join(state.dir, "inbox.jsonl"), `${JSON.stringify({ id: "3", channel_id: "2", author_id: OWNER, content: "move the lane" })}\n`);
  await base.registry.write(lane());
  new QuestionStore(join(state.dir, "discord")).create("Which run?", ["a", "b"], "1", { thread: "12345678", tmux: OLD, session: "old-sid" }, "2026-10-11T00:00:00Z");
  let n = 0;
  return {
    ...base,
    run: async (argv, opts) => {
      if (argv[0] === "aoe" && argv[1] === "session" && argv[2] === "stop" && argv[3] === OLD_ID) {
        for (const pid of [11, 12, 13, 14, 20, 21, 17]) live.delete(pid);
        if (!sim.chainSurvives) for (const pid of sim.grandchildSurvives ? [15] : [15, 16]) live.delete(pid);
      }
      simulate();
      return base.run(argv, opts);
    },
    cardDir: join(state.dir, "discord"),
    inbox: join(state.dir, "inbox.jsonl"),
    ownerIds: [OWNER],
    home: "/home/test",
    sessionOf: async (pane) => (pane === OLD ? "old-sid" : pane === NEW ? "new-sid" : ""),
    procs: async () => table,
    envOf: (pid) => (pid === 40 ? "HOME=/home/test\nPI_SESSION_ID=old-sid" : pid === 41 ? "PI_SESSION_ID=other-sid" : ""),
    alive: (pid) => live.has(pid),
    signal: (pid, sig) => {
      sigs.push(`${sig} ${pid}`);
      return true;
    },
    realpath: (path) => path,
    nonce: () => `n${++n}`,
    print: (line) => printed.push(line),
  };
};

const opened = () => w.calls.some((c) => c[0] === "aoe" && c[1] === "add");
const stoppedIds = () => w.calls.filter((c) => c[0] === "aoe" && c[1] === "session" && c[2] === "stop").map((c) => c[3]);
const readLane = async (deps: LaneHandoverDeps) => (await deps.registry.read("demo")) as Lane;
const ready = (deps: LaneHandoverDeps, chains: number[], at = "2026-10-11T16:30:00Z", pane = OLD, note = "E7 seed 3 is mid-eval; rerun eval only") => {
  mkdirSync(join(deps.config.stateDir, "handover", "lanes"), { recursive: true });
  writeFileSync(readyFile(deps.config.stateDir, "demo"), JSON.stringify({ key: "demo", pane, at, chains, note }));
};
// a message of the old conversation, appended to its log (the log starts with one line, so this is line 2)
const oldSays = (text: string) => appendFileSync(join(sessionDirFor(join(state.dir, "sessions"), CWD), "2026-10-11T10-00-00-000Z_old-sid.jsonl"), `\n${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })}`);

let restorePath = () => {};
beforeEach(() => {
  restorePath = launchReadyPath();
  state = withState();
  w = newWorld();
  sim = { arm: [{ description: "scratch events", command: EVENTS, pid: 201 }, { description: "digest", command: "until false; do sleep 60; done", pid: 202 }], thinking: "high", ackPane: NEW, ack: true, supplement: "fix", handled: [], account: "x", chainSurvives: false, doubleRun: false, restarted: false };
  printed = [];
  sigs = [];
  live = new Set([14, 15, 16, 17, 40, 41, 201, 202]);
  table = baseTable();
});
afterEach(() => {
  state.done();
  restorePath();
});

test("the status line gives model, thinking and context use in both omo formats", () => {
  expect(statusLine(HIGH, MODEL)).toEqual({ model: "claude-opus-5-5", thinking: "high", contextPct: 72, account: "x" });
  expect(statusLine(status("claude-opus-5-5:medium", "43.9", "orientpine"), MODEL)).toEqual({ model: "claude-opus-5-5", thinking: "medium", contextPct: 43.9, account: "orientpine" });
  expect(statusLine("❯ claude-opus-5-5 effort high in the input\n────\n 1K/1M (1%) gpt-6", MODEL)).toEqual({ contextPct: 1 });
});

test("the note carries brief, goal, Done, todos, monitors, local chains, detached jobs, reports and model; --dry-run opens nothing", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  // Then
  expect(r.code).toBe(0);
  const note = readFileSync(r.note ?? "", "utf8");
  for (const part of [
    `Read your brief ${lane().brief} in full`,
    "- Done: merged o/r#1",
    '- Owner goal (owner words): "레인에도 적용"',
    "Work thread: discord:12345678",
    "- Model anthropic-subscription/claude-opus-5-5, thinking high; cwd /work/demo.",
    `- scratch events: command ${JSON.stringify(EVENTS)} filter "^EV"`,
    "- digest: command \"until false; do sleep 60; done\" filter \"^EV\" (was not persistent in the old session; arm it as persistent)",
    "## Goal\nship lane handover (active)",
    "- Work: train E7 (in_progress)",
    "- 15: `bash -c sleep 7200; echo chain-done`",
    "- 40: `sleep 7201`",
    "- Last report: [REPORT] demo | milestone | half way",
    "E7 seed 3 is mid-eval; rerun eval only",
  ]) expect(note).toContain(part);
  for (const absent of ["done thing", "ast-grep-mcp", "claude-agent-sdk", "--mode rpc", "sleep 9999", `- 14: \`${EVENTS}\``]) expect(note).not.toContain(absent);
  expect(printed.at(-1)).toStartWith(`HANDOVER_DRY_RUN demo would open aoe session "demo-10111635" in ${CWD} (--model anthropic-subscription/claude-opus-5-5 --thinking high)`);
  expect(opened()).toBe(false);
  expect((await readLane(deps)).pane).toBe(OLD);
});

test("refuses while a local chain would die, a turn runs or a question is open, and opens nothing", async () => {
  // Given
  const deps = await setup();
  // When
  const chain = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  table = baseTable().filter((p) => p.pid !== 15 && p.pid !== 16);
  w.screens[OLD] = `${HIGH}\n • Working (esc to interrupt)`;
  const turn = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  w.screens[OLD] = `${HIGH}\nAsk user · which seed?`;
  const question = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  const own = await laneHandover(deps, "demo", OLD, OK);
  // Then
  expect([chain.code, turn.code, question.code, own.code]).toEqual([2, 2, 2, 2]);
  expect(printed[0]).toStartWith("HANDOVER_REFUSED demo: 1 local chain(s) would die: 15 bash -c sleep 7200; echo chain-done");
  expect(printed.some((l) => l.includes("a turn is running"))).toBe(true);
  expect(printed.some((l) => l.includes("a question is open in the pane"))).toBe(true);
  expect(printed.at(-1)).toStartWith("HANDOVER_REFUSED demo: run it from the lead, not from the lane's own pane");
  expect(opened()).toBe(false);
});

test("a ready mark covers only the chains it listed, from the lane's pane, within readyMin; --force overrides", async () => {
  // Given
  const deps = await setup();
  // When
  ready(deps, [99]);
  const otherChain = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  ready(deps, [15], "2026-10-11T15:00:00Z");
  const stale = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  ready(deps, [15], "2026-10-11T16:30:00Z", "aoe_other_9");
  const otherPane = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  ready(deps, [15]);
  const covered = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  const forced = await laneHandover({ ...deps, registry: deps.registry }, "demo", "aoe_lead_x", { dryRun: true, force: true });
  // Then
  expect([otherChain.code, stale.code, otherPane.code, covered.code, forced.code]).toEqual([2, 2, 2, 0, 0]);
  expect(printed.filter((l) => l.startsWith("HANDOVER_READY_STALE")).length).toBe(2);
});

test("dori handover ready runs only in the lane's own pane and also covers the chain that runs it, which may stay alive", async () => {
  // Given
  const deps = await setup();
  table = [...baseTable(), { pid: 18, ppid: 11, cmd: "bash -lc dori handover ready demo" }, { pid: 19, ppid: 18, cmd: "bun cli.ts handover ready demo" }];
  const noteFile = join(state.dir, "lane-note.md");
  writeFileSync(noteFile, "## Owner's words and constraints\n\"레인에도 적용\"\n## Decisions and why\nseed 3 first\n## Ruled out\nlr too high\n## In progress\nseed 3 eval pending\n## Next step\nrerun eval\n");
  const bare = join(state.dir, "bare-note.md");
  writeFileSync(bare, "seed 3 eval pending");
  // When
  const elsewhere = await markReady(deps, lane(), "aoe_lead_x", 19);
  const r = await markReady(deps, lane(), OLD, 19, noteFile);
  // Then
  expect(elsewhere.code).toBe(2);
  expect(r.code).toBe(0);
  expect(r.line).toStartWith(`HANDOVER_READY demo pane=${OLD} chains=1 (15 bash -c sleep 7200; echo chain-done;`);
  expect(r.line).toContain("runner=18 (runs this command; covered too)");
  expect(JSON.parse(readFileSync(readyFile(state.dir, "demo"), "utf8"))).toMatchObject({ pane: OLD, chains: [15, 18], note: readFileSync(noteFile, "utf8") });
  // the conversation summary is required, with its headings
  expect((await markReady(deps, lane(), OLD, 19)).line).toStartWith("HANDOVER_READY_REFUSED demo: write the conversation summary first");
  expect((await markReady(deps, lane(), OLD, 19, bare)).line).toBe(`HANDOVER_READY_REFUSED demo: the summary ${bare} lacks ## Owner's words and constraints, ## Decisions and why, ## Ruled out, ## In progress, ## Next step (dori handover ready --template)`);
  // the runner (here a shell; in omo the eval kernel) is still alive when the lead moves the lane: not a blocker
  expect((await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true })).code).toBe(0);
});

const guardedHandover = async (useGpu: boolean) => {
  const base = await setup();
  const deps = { ...base, config: { ...base.config, launchEnv: { CUDA_VISIBLE_DEVICES: "" } } };
  if (useGpu) await deps.registry.patch("demo", { useGpu: true });
  ready(deps, [15]);
  return { deps, r: await laneHandover(deps, "demo", "aoe_lead_x", OK) };
};

test("launchEnv: a lane's new session starts with it", async () => {
  expect((await guardedHandover(false)).r).toMatchObject({ code: 0, to: NEW });
  expect(w.aoeEnv).toEqual([{ CUDA_VISIBLE_DEVICES: "" }]);
});

test("launchEnv: a --use-gpu lane's new session starts without it", async () => {
  expect((await guardedHandover(true)).r).toMatchObject({ code: 0, to: NEW });
  expect(w.aoeEnv).toEqual([{ CUDA_VISIBLE_DEVICES: undefined }]);
});

test("launchEnv: a new session tmux did not give it is closed and the old one stays the lane", async () => {
  w.dropEnv = true;
  const { deps, r } = await guardedHandover(false);
  expect(r).toMatchObject({ code: 3, to: NEW });
  expect(printed).toContain(`HANDOVER_FAIL demo: new session ${NEW} lacks launchEnv: CUDA_VISIBLE_DEVICES=(unset)`);
  expect(stoppedIds()).toEqual([NEW_AOE_ID]);
  expect((await readLane(deps)).pane).toBe(OLD);
});

test("the probe waits for the new session's first turn to end, so it comes as a message of its own, not a line typed into that turn", async () => {
  const deps = await setup();
  ready(deps, [15]);
  sim.busyFor = 3;
  const sleep = deps.clock.sleep;
  const run = deps.run;
  const r = await laneHandover({
    ...deps,
    // whether the new session's turn still ran at the moment the probe was typed
    run: async (argv, o) => {
      if (argv[1] === "send-keys" && argv.includes(`=${NEW}:`) && (argv.at(-1) ?? "").includes("HANDOVER_PROBE") && sim.probeWhileBusy === undefined) sim.probeWhileBusy = (sim.busyFor ?? 0) > 0;
      return run(argv, o);
    },
    clock: { ...deps.clock, sleep: async (ms) => { if (firstMessageSent() && (sim.busyFor ?? 0) > 0) sim.busyFor = (sim.busyFor ?? 0) - 1; await sleep(ms); } },
  }, "demo", "aoe_lead_x", OK);
  expect(r).toMatchObject({ code: 0, to: NEW });
  expect(sim.probeWhileBusy).toBe(false);
});

test("a first turn that never ends within the verify time gets no probe: the handover fails and goes back", async () => {
  const deps = await setup();
  ready(deps, [15]);
  sim.busyFor = 1_000_000;
  let probed = false;
  const run = deps.run;
  const r = await laneHandover({
    ...deps,
    run: async (argv, o) => {
      if (argv[1] === "send-keys" && argv.includes(`=${NEW}:`) && (argv.at(-1) ?? "").includes("HANDOVER_PROBE")) probed = true;
      return run(argv, o);
    },
  }, "demo", "aoe_lead_x", { ...OK, verifyMin: 1 });
  expect(r.code).not.toBe(0);
  expect(probed).toBe(false);
});

test("moves the lane: same cwd, model and thinking, registry and cards repointed, status, monitors and probe checked, then the old session closes", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r).toMatchObject({ code: 0, to: NEW });
  expect(readFileSync(r.note ?? "", "utf8")).toContain(`- Moved with the owner's approval: ${OK.approvedBy}`);
  expect(existsSync(pendingFile(state.dir, "demo"))).toBe(false);
  expect(existsSync(readyFile(state.dir, "demo"))).toBe(false);
  const add = w.calls.find((c) => c[0] === "aoe" && c[1] === "add") ?? [];
  expect(add.slice(0, 4)).toEqual(["aoe", "add", CWD, "-t"]);
  expect(add.at(-1)).toBe("--model anthropic-subscription/claude-opus-5-5 --thinking high");
  expect(sent(w).some((t) => t.startsWith("You are the demo lane in a new session") && t.includes(r.note ?? "?"))).toBe(true);
  const now = await readLane(deps);
  expect(now).toMatchObject({ pane: NEW, session: "new-sid", thread: "discord:12345678", brief: lane().brief });
  // the outgoing session found in the old pane stays on the lane (the registry had none, as for an adopted lane), so its
  // cost still counts (supervision.ts laneSessionUsage)
  expect(now.priorSessions).toEqual(["old-sid"]);
  expect(new QuestionStore(join(state.dir, "discord")).get("Q1")).toMatchObject({ tmux: NEW });
  expect(printed).toContain(`HANDOVER_STATUS_OK ${NEW} claude-opus-5-5 thinking high`);
  expect(printed).toContain(`HANDOVER_MONITORS_OK 2 in ${NEW} (session new-sid)`);
  const probeAt = w.calls.findIndex((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`) && (c.at(-1) ?? "").startsWith("[LEAD] HANDOVER_PROBE n1: once you have read the whole handover note, run dori handover ack n1"));
  const stopAt = w.calls.findIndex((c) => c[0] === "aoe" && c[1] === "session" && c[2] === "stop" && c[3] === OLD_ID);
  expect(probeAt).toBeGreaterThan(-1);
  expect(stopAt).toBeGreaterThan(probeAt);
  expect(stoppedIds()).toEqual([OLD_ID]);
  expect(w.calls.some((c) => c[0] === "kill")).toBe(false);
  expect(printed).toContain("HANDOVER_DETACHED_ALIVE 1/1 (40)");
  const note = readFileSync(r.note ?? "", "utf8");
  expect(note).toContain("Do NOT start these again now");
  const endedAt = w.calls.findIndex((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`) && (c.at(-1) ?? "").startsWith("[LEAD] HANDOVER_CHAINS_ENDED: the old session is closed and its local chains ended (15 bash -c sleep 7200"));
  expect(endedAt).toBeGreaterThan(stopAt);
  // the new session works only after the commit, which comes after the old session closed
  expect(note).toContain("4. Until a [LEAD] HANDOVER_COMMITTED line arrives, do nothing else");
  const commitAt = w.calls.findIndex((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`) && (c.at(-1) ?? "").startsWith("[LEAD] HANDOVER_COMMITTED: the handover is checked and the old session is closed"));
  expect(commitAt).toBeGreaterThan(stopAt);
  expect(endedAt).toBeGreaterThan(commitAt);
  expect(sim.restarted).toBe(true);
  expect(sim.doubleRun).toBe(false);
  expect(printed.some((l) => l.startsWith("HANDOVER_ACCOUNT"))).toBe(false);
  // the old agent is frozen while both sessions live, and resumed only to be closed
  expect(sigs).toEqual(["SIGSTOP 11", "SIGCONT 11"]);
  const firstAt = w.calls.findIndex((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`) && (c.at(-1) ?? "").startsWith("You are the demo lane"));
  expect(firstAt).toBeGreaterThan(-1);
  expect(printed).toContain(`HANDOVER_FROZEN demo agent 11 in ${OLD}`);
  expect(printed.indexOf("HANDOVER_THAWED demo agent 11")).toBeGreaterThan(printed.findIndex((l) => l.startsWith("HANDOVER_DONE")));
  // no restatement before the commit (owner Q476): the probe ack is enough
  expect(printed.some((l) => l.startsWith("HANDOVER_UNDERSTOOD") || l.startsWith("HANDOVER_SUPPLEMENT"))).toBe(false);
  expect(note).toContain("## Conversation summary (written by the old session)");
  expect(note).toContain(`Its full log is ${join(sessionDirFor(join(state.dir, "sessions"), CWD), "2026-10-11T10-00-00-000Z_old-sid.jsonl")}`);
});

test("rolls back when the new session runs at another thinking level: lane and cards back, the new session closed, the old one kept and told", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  sim.thinking = "medium";
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { ...OK, verifyMin: 1 });
  // Then
  expect(r.code).toBe(3);
  expect(printed.find((l) => l.startsWith("HANDOVER_VERIFY_FAIL"))).toContain(`${NEW} runs at thinking medium, not high`);
  expect((await readLane(deps)).pane).toBe(OLD);
  expect(new QuestionStore(join(state.dir, "discord")).get("Q1")).toMatchObject({ tmux: OLD });
  expect(stoppedIds()).toEqual([NEW_AOE_ID]);
  expect(sent(w).some((t) => t.startsWith("[LEAD] Handover of demo failed") && t.includes("You stay the demo lane"))).toBe(true);
  expect(sent(w).some((t) => t.startsWith("[LEAD] HANDOVER_COMMITTED"))).toBe(false);
  // the old agent was frozen for the switch and resumed when it stayed the lane
  expect(sigs).toEqual(["SIGSTOP 11", "SIGCONT 11"]);
});

test("a monitor that ran at the first check and ended before the move commits rolls it back, named with its ended process", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  sim.endsAfterProbe = 201;
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { ...OK, verifyMin: 1 });
  // Then
  expect(r.code).toBe(3);
  expect(printed.some((l) => l.startsWith("HANDOVER_MONITORS_OK"))).toBe(true);
  expect(printed.find((l) => l.startsWith("HANDOVER_VERIFY_FAIL"))).toContain(`monitors stopped in ${NEW} after the first check: scratch events (armed, but its process 201 ended`);
  expect((await readLane(deps)).pane).toBe(OLD);
  expect(sent(w).some((t) => t.startsWith("[LEAD] HANDOVER_COMMITTED"))).toBe(false);
});

test("rolls back when a monitor is not re-armed or the probe is acked from another pane", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  sim.arm = sim.arm.slice(0, 1);
  // When
  const noMonitor = await laneHandover(deps, "demo", "aoe_lead_x", { ...OK, verifyMin: 1 });
  // Then
  expect(noMonitor.code).toBe(3);
  expect(printed.find((l) => l.startsWith("HANDOVER_VERIFY_FAIL"))).toContain("monitors not running in");

  // Given
  printed = [];
  w = newWorld();
  const again = await setup();
  ready(again, [15]);
  sim.arm = [{ description: "scratch events", command: EVENTS, pid: 201 }, { description: "digest", command: "until false; do sleep 60; done", pid: 202 }];
  sim.ackPane = OLD;
  // When
  const wrongPane = await laneHandover(again, "demo", "aoe_lead_x", { ...OK, verifyMin: 1 });
  // Then
  expect(wrongPane.code).toBe(3);
  expect(printed.find((l) => l.startsWith("HANDOVER_VERIFY_FAIL"))).toContain(`the probe was acked from ${OLD}, not ${NEW}`);
  expect((await readLane(again)).pane).toBe(OLD);
  expect(stoppedIds()).toEqual([NEW_AOE_ID]);
});

test("freshness says a rollover is due once per pane for lanes and the lead, and starts one only with the auto key on", async () => {
  // Given
  const base = await setup();
  await base.registry.patch("demo", { lastReplyAt: base.clock.now() });
  const off = await freshnessTick(base, "/home/test", { signals: async () => ({ contextPct: 99, compactions: 99, ageH: 999 }) });
  const deps = { ...base, config: { ...base.config, handover: { ...base.config.handover, laneContextPct: 80, laneCompactions: 4, laneAgeH: 24, leadContextPct: 80, leadCompactions: 4, leadAgeH: 48 } } };
  await deps.registry.patch("demo", { lastReplyAt: deps.clock.now() });
  const signals: Record<string, { contextPct?: number; compactions?: number; ageH?: number }> = { [OLD]: { contextPct: 85 }, [deps.config.leadPane]: { compactions: 1, ageH: 50 } };
  const autoRuns: string[] = [];
  const hooks = { signals: async (pane: string) => signals[pane] ?? {}, auto: async (who: "lead" | "lane", key: string) => { autoRuns.push(`${who}:${key}`); return "started"; } };
  // When
  const first = await freshnessTick(deps, "/home/test", hooks);
  const second = await freshnessTick(deps, "/home/test", hooks);
  await deps.registry.patch("demo", { pane: "aoe_demo-2_77777777" });
  signals["aoe_demo-2_77777777"] = { contextPct: 79, compactions: 3, ageH: 23 };
  const below = await freshnessTick(deps, "/home/test", hooks);
  signals["aoe_demo-2_77777777"] = { contextPct: 40, compactions: 4, ageH: 5 };
  const auto = await freshnessTick({ ...deps, config: { ...deps.config, handover: { ...deps.config.handover, autoRolloverLanes: true } } }, "/home/test", hooks);
  // Then
  expect(off).toEqual([]);
  expect(first.map((a) => [a.kind, a.lane])).toEqual([["rollover_due", "demo"], ["rollover_due", "lead"]]);
  expect(first[0]?.detail).toStartWith(`context 85% >= 80% in ${OLD}: decide it (dori rollover-propose demo shows the note)`);
  expect(first[0]?.detail).toContain(`--approved-by "lead:<reason and this signal>"`);
  expect(first[1]?.detail).toStartWith(`age 50.0 h >= 48 h in ${deps.config.leadPane}: decide it (dori rollover-propose lead shows the note)`);
  expect(second).toEqual([]);
  expect(below).toEqual([]);
  expect(auto.map((a) => [a.kind, a.lane])).toEqual([["rollover_due", "demo"], ["rollover_auto", "demo"]]);
  expect(autoRuns).toEqual(["lane:demo"]);
  expect(w.calls.some((c) => c[0] === "aoe" && c[1] === "add")).toBe(false);
});

test("a paused lane gets no rollover proposal, and pausing does not make it safe to move: chain and turn checks still refuse", async () => {
  // Given
  const base = await setup();
  const deps = { ...base, config: { ...base.config, handover: { ...base.config.handover, laneContextPct: 80 } } };
  // its session has no omo goal (pause-goal.test.ts covers the goal step)
  await pauseLane({ ...deps, readGoal: async () => "none" }, await readLane(deps), "waits on the owner");
  // When
  const due = await freshnessTick(deps, "/home/test", { signals: async () => ({ contextPct: 99 }) });
  const chain = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  table = baseTable().filter((p) => p.pid !== 15 && p.pid !== 16);
  w.screens[OLD] = `${HIGH}\n • Working (esc to interrupt)`;
  const turn = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(due.filter((a) => a.lane === "demo")).toEqual([]);
  expect([chain.code, turn.code]).toEqual([2, 2]);
  expect(printed[0]).toStartWith("HANDOVER_REFUSED demo: 1 local chain(s) would die");
  // the lead's request waits after its refusal (HANDOVER_PENDING follows it)
  expect(printed.findLast((l) => l.startsWith("HANDOVER_REFUSED"))).toContain("a turn is running");
  expect(opened()).toBe(false);
});

test("a lane told not done keeps working and is moved like a working one; it gets no nudge it did not get before", async () => {
  // Given: cyto-p2-timers on 10-19, not-done, 306k after its 13th compaction, never started
  const base = await setup();
  const deps = { ...base, config: { ...base.config, handover: { ...base.config.handover, laneAfterCompactK: 300, autoRolloverLanes: true } } };
  await deps.registry.patch("demo", { status: "not-done", lastReplyAt: deps.clock.now() - 600 * 60_000 });
  const starts: string[] = [];
  // When
  const acts = await freshnessTick(deps, "/home/test", { signals: async (pane: string) => (pane === OLD ? { afterCompactK: 306 } : {}), auto: async (_who, key) => { starts.push(key); return "started"; } });
  // Then
  expect(acts.filter((a) => a.lane === "demo").map((a) => a.kind)).toEqual(["rollover_due", "rollover_auto"]);
  expect(starts).toEqual(["demo"]);
  expect(sent(w).some((t) => t.includes("no update for"))).toBe(false);
});

test("a lane's stuck rollover point is rung 4 of the ladder: its STUCK line, not a ROLLOVER_DUE of its own, and the rung goes into the handover log", async () => {
  // Given
  const deps = await setup();
  const fix = (at: string, hypothesis = "lr too high") => ({ at, metric: "loss", hypothesis, via: "report" as const });
  const quiet = { ...deps, config: { ...deps.config, explore: { ...deps.config.explore, sendResearchToLane: false } } };
  await recordFix(quiet, "demo", fix("2026-10-11T10:00:00Z"));
  await recordFix(quiet, "demo", fix("2026-10-11T11:00:00Z", "seed"));
  await recordFix(quiet, "demo", fix("2026-10-11T11:30:00Z"));
  const third = await recordFix(quiet, "demo", fix("2026-10-11T12:00:00Z"));
  await deps.registry.patch("demo", { lastReplyAt: deps.clock.now() });
  // When
  const due = await freshnessTick(deps, "/home/test", { signals: async () => ({ contextPct: 99, compactions: 99, ageH: 999 }) });
  const top = stuckTop(await readLane(deps));
  ready(deps, [15]);
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(third.notes[0]).toContain('"loss" rung 4 (tagged 4, inferred 0, hypotheses 2, fixated)');
  expect(due.filter((a) => a.kind === "rollover_due")).toEqual([]);
  expect(top).toEqual({ metric: "loss", n: 4, rung: 4 });
  expect(r.code).toBe(0);
  // the new session starts its own ladder
  expect(stuckTop(await readLane(deps))).toBeUndefined();
  expect(readRollovers(state.dir)[0]).toMatchObject({ kind: "rollover", signals: { stuck: { metric: "loss", n: 4, rung: 4 } } });
});

test("refuses without the owner's approval and opens nothing; --dry-run needs none", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  // When
  const bare = await laneHandover(deps, "demo", "aoe_lead_x");
  const blank = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: "  " });
  const dry = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  // Then
  expect([bare.code, blank.code, dry.code]).toEqual([2, 2, 0]);
  expect(printed[0]).toStartWith("HANDOVER_REFUSED demo: a lane moves to a new session only with an approval");
  expect(opened()).toBe(false);
});

test("a new session that does not start is closed and the lane stays where it was", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  w.screens[NEW] = "Error: usage limit reached for this account";
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(3);
  expect(printed.some((l) => l.startsWith(`HANDOVER_FAIL demo: new session ${NEW}: usage limit`))).toBe(true);
  expect((await readLane(deps)).pane).toBe(OLD);
  expect(stoppedIds()).toEqual([NEW_AOE_ID]);
  expect(sent(w).some((t) => t.startsWith("[LEAD] Handover of demo failed (the new session did not start"))).toBe(true);
  expect(existsSync(pendingFile(state.dir, "demo"))).toBe(false);
});

test("an error in the middle of the move is repaired: lane and cards back on the old session, the new one closed", async () => {
  // Given
  const deps = { ...(await setup()), nonce: () => { throw new Error("nonce source broke"); } };
  ready(deps, [15]);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(3);
  expect(printed).toContain("HANDOVER_FAIL demo: nonce source broke; repairing");
  expect(printed.find((l) => l.startsWith("HANDOVER_RECOVERED"))).toStartWith(`HANDOVER_RECOVERED demo back on ${OLD}; new session: aoe session ${NEW_AOE_ID}`);
  expect((await readLane(deps)).pane).toBe(OLD);
  expect(new QuestionStore(join(state.dir, "discord")).get("Q1")).toMatchObject({ tmux: OLD });
  expect(stoppedIds()).toEqual([NEW_AOE_ID]);
  expect(existsSync(pendingFile(state.dir, "demo"))).toBe(false);
});

const killedRun = async (deps: LaneHandoverDeps, pid: number) => {
  w.aoe.push({ id: NEW_AOE_ID, title: "demo-10111635", path: CWD, tool: "omo", profile: "main" });
  w.tmux.push(NEW);
  await deps.registry.patch("demo", { pane: NEW });
  new QuestionStore(join(state.dir, "discord")).retarget({ tmux: OLD }, { tmux: NEW });
  mkdirSync(join(state.dir, "handover", "lanes"), { recursive: true });
  writeFileSync(pendingFile(state.dir, "demo"), JSON.stringify({ key: "demo", pid, at: "2026-10-11T16:20:00Z", from: OLD, to: NEW, note: "/x.md", chains: [{ pid: 15, cmd: "bash -c sleep 7200; echo chain-done", pids: [15, 16] }], fromSession: "old-sid", cwd: CWD }));
};

test("a run killed midway (crash, reboot) is repaired by the next run: old session alive -> back to it, new one closed", async () => {
  // Given
  const deps = await setup();
  await killedRun(deps, 999);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(3);
  expect(printed[0]).toStartWith("HANDOVER_INTERRUPTED demo");
  expect((await readLane(deps)).pane).toBe(OLD);
  expect(new QuestionStore(join(state.dir, "discord")).get("Q1")).toMatchObject({ tmux: OLD });
  expect(stoppedIds()).toEqual([NEW_AOE_ID]);
  expect(sent(w).some((t) => t.startsWith("[LEAD] The handover of demo was stopped before it finished. You stay the demo lane"))).toBe(true);
  expect(existsSync(pendingFile(state.dir, "demo"))).toBe(false);
  expect(opened()).toBe(false);
});

test("a killed run whose old session is already gone keeps the lane on the new one; a live run's journal refuses", async () => {
  // Given
  const deps = await setup();
  await killedRun(deps, 999);
  live.add(777);
  w.aoe = w.aoe.filter((s) => s.id !== OLD_ID);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  await killedRun(deps, 777);
  const running = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(3);
  expect(printed).toContain(`HANDOVER_RECOVERED demo kept on ${NEW}: the old session ${OLD} is gone`);
  // the recovery records the lane's sessions like a finished move: the new one, and the outgoing one kept for its cost
  expect(await readLane(deps)).toMatchObject({ session: "new-sid", priorSessions: ["old-sid"] });
  // the new session is released, and told whether the old chains still run (here they do: no restart)
  expect(sent(w).some((t) => t.startsWith(`[LEAD] HANDOVER_COMMITTED: the handover was interrupted after the old session ${OLD} closed`))).toBe(true);
  expect(printed).toContain("HANDOVER_CHAIN_SURVIVED demo 15; the new session was told not to restart them");
  expect((await readLane(deps)).pane).toBe(NEW);
  expect(stoppedIds()).toEqual([]);
  expect(running.code).toBe(2);
  // a live run mid-move takes no request: refused the takeover way, with no rollover row of its own (review 320 round 8)
  expect(printed.at(-1)).toStartWith("HANDOVER_REFUSED demo: another handover is running (pid 777");
  expect(readRollovers(state.dir).filter((e) => e.kind === "rollover" && e.result === "refused")).toEqual([]);
});

test("--keep-old leaves the old session open and tells it it is no longer the lane", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { ...OK, keepOld: true });
  // Then
  expect(r).toMatchObject({ code: 0, to: NEW });
  expect(stoppedIds()).toEqual([]);
  expect(sent(w).some((t) => t.startsWith(`[LEAD] Handover of demo to ${NEW} is done and checked. You are no longer the lane`))).toBe(true);
  expect(sent(w).some((t) => t.startsWith(`[LEAD] HANDOVER_COMMITTED: the handover is checked and the old session ${OLD} stays open but idle`))).toBe(true);
  // the old session is still open, so it stays quiet until the mark expires
  expect(quietReason(state.dir, OLD, deps.clock.now())).toContain("the handover of demo");
});

test("a chain whose parent ended but whose child still runs counts as running: no restart", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  sim.grandchildSurvives = true;
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(0);
  expect(sent(w).some((x) => x.startsWith("[LEAD] HANDOVER_CHAINS_ENDED"))).toBe(false);
  expect(printed).toContain("HANDOVER_CHAIN_SURVIVED demo 15; the new session was told not to restart them");
  expect(sim.restarted).toBe(false);
});

test("a threshold is crossed at its value, not just above it, and 0 turns it off", () => {
  // Given
  const limits = { contextPct: 80, compactions: 4, ageH: 24 };
  // When / Then
  expect(crossed({ contextPct: 80, compactions: 4, ageH: 24 }, limits)).toEqual(["context 80% >= 80%", "compactions 4 >= 4", "age 24.0 h >= 24 h"]);
  expect(crossed({ contextPct: 79.9, compactions: 3, ageH: 23.9 }, limits)).toEqual([]);
  expect(crossed({ contextPct: 100, compactions: 99, ageH: 999 }, { contextPct: 0, compactions: 0, ageH: 0 })).toEqual([]);
  expect(crossed({}, limits)).toEqual([]);
  expect(crossed({ repeats: 9 }, limits)).toEqual([]);
});

test("the tagged half of the stuck count counts the lane's current session only, the way fix-attempt counts them", () => {
  // Given
  const fix = (at: string, hypothesis: string, via: "report" | "lead" = "report") => ({ at, metric: "loss", hypothesis, via });
  const moved = { ...lane(), history: [{ at: "2026-10-11T12:00:00Z", status: "working" as const, note: `pane moved aoe_old_1 -> ${OLD} (dori handover --lane)` }] };
  const cfg = { stuck: { hypothesesAt: 2, researchAt: 3, fixatedAfter: 3, rereadText: "" }, autoSignals: { aliases: {} } } as never;
  const view = (l: Lane) => stuckView(l, "loss", cfg);
  // When / Then
  expect(view({ ...lane(), fixes: [fix("2026-10-11T10:00:00Z", "lr"), fix("2026-10-11T11:00:00Z", "lr"), fix("2026-10-11T11:30:00Z", "lr"), fix("2026-10-11T11:40:00Z", "seed")] })).toMatchObject({ tagged: 4, hypotheses: 2, fixated: true });
  expect(view({ ...moved, fixes: [fix("2026-10-11T10:00:00Z", "lr"), fix("2026-10-11T11:00:00Z", "lr"), fix("2026-10-11T13:00:00Z", "lr")] })).toMatchObject({ tagged: 1, fixated: false });
  expect(view({ ...lane(), fixes: [fix("2026-10-11T10:00:00Z", "lr", "lead"), fix("2026-10-11T10:05:00Z", "lr")] }).tagged).toBe(1);
  // a fix marked improved (the one before it moved the metric) starts that metric's count again
  expect(view({ ...lane(), fixes: [fix("2026-10-11T10:00:00Z", "lr"), fix("2026-10-11T11:00:00Z", "lr"), { ...fix("2026-10-11T11:30:00Z", "lr"), improved: true }] })).toMatchObject({ tagged: 1, fixated: false });
  expect(view(lane()).n).toBe(0);
});

test("an approval is an answered rollover card for this lane's current session, a Discord message link, or auto only with the key on", () => {
  // Given
  const yes = { status: "answered", options: ["Yes, roll over", "Not yet"], answer: "Yes, roll over" };
  const cards: Record<string, object> = {
    Q1: { id: "Q1", ...yes },
    Q2: { id: "Q2", ...yes, answer: "Not yet" },
    Q3: { id: "Q3", status: "open", options: ["Yes, roll over", "Not yet"] },
    Q4: { id: "Q4", ...yes },
    Q5: { id: "Q5", status: "answered", options: ["Yes", "No"], answer: "Yes" },
    Q6: { id: "Q6", ...yes },
  };
  const card = (id: string) => cards[id] as never;
  const proposal = (key: string, id: string, pane = "p1") => ({ kind: "proposal" as const, who: "lane" as const, at: "2026-10-11T00:00:00Z", key, card: id, pane, signals: {}, crossed: [], blockers: "" });
  const log = [proposal("demo", "Q1"), proposal("demo", "Q2"), proposal("demo", "Q3"), proposal("other", "Q4"), proposal("demo", "Q6", "p0")];
  // a link holds only for a message the inbox has from the owner
  const inbox = join(mkdtempSync(join(tmpdir(), "dori-approval-")), "inbox.jsonl");
  writeFileSync(inbox, [{ id: "3", channel_id: "2", author_id: OWNER, content: "roll it over" }, { id: "4", channel_id: "2", author_id: "999", content: "roll it over" }].map((x) => JSON.stringify(x)).join("\n"));
  const check = (ref: string | undefined, on = false, canReport = false, granted = false) => approvalProblem(ref, card, { on, key: "handover.autoRolloverLanes", granted }, "demo", "p1", log, canReport, inboxMessages(inbox, [OWNER]));
  // When / Then
  expect(check("Q1")).toBeUndefined();
  expect(check("q1")).toBeUndefined();
  expect(check("Q2")).toBe('card Q2 was answered "Not yet", not "Yes, roll over"');
  expect(check("Q3")).toBe("card Q3 is not answered yet");
  expect(check("Q9")).toBe("card Q9 not found");
  expect(check("Q4")).toBe("card Q4 is not a rollover proposal for demo; post one with dori rollover-propose demo");
  expect(check("Q5")).toBe("card Q5 is not a rollover proposal for demo; post one with dori rollover-propose demo");
  expect(check("Q6")).toBe("card Q6 was about p0, not the session demo runs in now (p1); post a new one with dori rollover-propose demo");
  expect(check("https://discord.com/channels/1/2/3")).toBeUndefined();
  expect(check("https://discord.com/channels/1/2/4")).toContain("written by 999, not by the owner");
  expect(check("https://discord.com/channels/1/2/5")).toContain("message 5 is not in the inbox");
  expect(check("https://discord.com/channels/1/9/3")).toContain("is in channel 2 in the inbox, not in 9");
  for (const words of ["not approved", "owner said yes", "https://discord.com/channels/1/2", "https://example.com/channels/1/2/3"]) expect(check(words)).toContain("neither an answered rollover card");
  expect(check(undefined)).toStartWith("no approval");
  // the automatic string holds only with the grant of a run freshness started; typed by hand it is refused and says what to use
  expect(check("auto:handover.autoRolloverLanes", true, true)).toStartWith("HANDOVER_APPROVAL auto:handover.autoRolloverLanes is the approval of a run freshness starts by itself");
  expect(check("auto:handover.autoRolloverLanes", true, true)).toContain('--approved-by "lead:<reason and the signal behind it>" or "lead:<reason>, owner <link of the owner\'s message that asked for it>"');
  expect(check("auto:handover.autoRolloverLanes", false, false, true)).toContain("the automation key is off");
  expect(check("auto:handover.autoRolloverLanes", true, false, true)).toContain("an automatic rollover needs a way to tell the owner afterwards");
  expect(check("auto:handover.autoRolloverLanes", true, true, true)).toBeUndefined();
  expect(check("auto:anything", true)).toBe("auto:anything is not the automatic approval of this side; only auto:handover.autoRolloverLanes is");
  // the lead decides with a reason and the signal behind it, and only when the owner can be told afterwards
  expect(check("lead:STUCK rung 4 on loss, research did not help", false, true)).toBeUndefined();
  expect(check("lead:막힘 4단, 리서치 뒤에도 실패", false, true)).toBeUndefined();
  expect(check("lead:STUCK rung 4 on loss, research did not help")).toContain("needs a way to tell the owner afterwards");
  expect(check("lead:because", false, true)).toContain("does not say the reason and the signal behind it");
  expect(check("lead:it seems a good idea to me now", false, true)).toContain("does not say the reason and the signal behind it");
  // whole tokens only (challenge, grok-4.7): a word that only contains a signal name is no signal
  expect(check("lead:context is fine, the message page looks right", false, true)).toContain("does not say the reason");
  expect(check("lead:\ub2e8\uacc4\ub97c \ud310\ub2e8\ud574 \ubcf4\ub2c8 \uc62e\uae38 \ub54c", false, true)).toContain("does not say the reason");
  expect(check("lead:after the outage 3 h ago it looked off", false, true)).toContain("does not say the reason");
  expect(check("lead:context 85% after 6 compactions", false, true)).toBeUndefined();
});

test("auto approval borrowing: a hand-run that passes auto:handover.autoRolloverLanes is refused with HANDOVER_APPROVAL, logs no rollover row and opens nothing; the run given freshness's grant moves the lane", async () => {
  // Given: OkDori herdr-qa (05:09Z) and GongDori e7-beyond-eth (05:50Z, 25 s after an owner link was refused) on 2026-11-03,
  // hand-runs with the automatic string while the key was on
  const base = await setup();
  const deps: LaneHandoverDeps = { ...base, config: { ...base.config, handover: { ...base.config.handover, autoRolloverLanes: true } }, reportOwner: async () => "msg-1" };
  ready(deps, [15]);
  // When: by hand, with a made-up grant, then as freshness starts it
  const byHand = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: AUTO });
  const madeUp = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: AUTO, autoGrant: "0".repeat(32) });
  const handLines = printed.filter((l) => l.startsWith("HANDOVER_REFUSED demo"));
  const rows = readRollovers(state.dir).length;
  const openedByHand = opened();
  const r = await laneHandover(deps, "demo", "aoe_lead_x", autoRun(deps));
  // Then
  expect([byHand.code, madeUp.code]).toEqual([2, 2]);
  expect(handLines).toHaveLength(2);
  for (const l of handLines) expect(l).toContain(": HANDOVER_APPROVAL auto:handover.autoRolloverLanes is the approval of a run freshness starts by itself");
  expect(rows).toBe(0);
  expect(openedByHand).toBe(false);
  expect(r.code).toBe(0);
  expect(printed).toContain(`HANDOVER_COMMITTED demo ${NEW}`);
  expect(readRollovers(state.dir).at(-1)).toMatchObject({ result: "done", decidedBy: "auto" });
});

test("an automatic grant is taken once, only for the side and key it was minted for, within AUTO_GRANT_MS", () => {
  // Given
  const dir = mkdtempSync(join(tmpdir(), "dori-grant-"));
  const t0 = Date.parse("2026-11-03T12:00:00Z");
  const g = mintAutoGrant(dir, "lane", "demo", t0);
  // When / Then: once, then never again
  expect(takeAutoGrant(dir, "lane", "demo", g, t0 + 1_000)).toBe(true);
  expect(takeAutoGrant(dir, "lane", "demo", g, t0 + 2_000)).toBe(false);
  // another lane's or the lead's grant, a stale one, and anything that is no token hold nothing
  expect(takeAutoGrant(dir, "lane", "other", mintAutoGrant(dir, "lane", "demo", t0), t0)).toBe(false);
  expect(takeAutoGrant(dir, "lead", "demo", mintAutoGrant(dir, "lane", "demo", t0), t0)).toBe(false);
  expect(takeAutoGrant(dir, "lane", "demo", mintAutoGrant(dir, "lane", "demo", t0), t0 + AUTO_GRANT_MS + 1)).toBe(false);
  for (const bad of [undefined, "", "../../registry", AUTO]) expect(takeAutoGrant(dir, "lane", "demo", bad, t0)).toBe(false);
  // a grant no run took is dropped by the next mint once stale
  mintAutoGrant(dir, "lane", "demo", t0);
  mintAutoGrant(dir, "lane", "demo", t0 + AUTO_GRANT_MS + 1);
  expect(readdirSync(join(dir, "handover", "auto-grants"))).toHaveLength(1);
});

test("a borrowed auto: approval is refused with HANDOVER_APPROVAL before any other refusal, and no early refusal logs it as an automatic run (review 312)", async () => {
  // Given: a hand-run whose --note does not exist would be refused before the approval was read, and logged as auto:
  const base = await setup();
  const deps: LaneHandoverDeps = { ...base, config: { ...base.config, handover: { ...base.config.handover, autoRolloverLanes: true } }, reportOwner: async () => "msg-1" };
  // When
  const missingNote = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: AUTO, note: join(state.dir, "no-such-note.md") });
  const noLane = await laneHandover(deps, "nope", "aoe_lead_x", { approvedBy: AUTO });
  const otherSide = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: "auto:handover.autoRolloverLead" });
  // Then
  expect([missingNote.code, noLane.code, otherSide.code]).toEqual([2, 2, 2]);
  const lines = printed.filter((l) => l.startsWith("HANDOVER_REFUSED"));
  expect(lines[0]).toContain("demo: a lane moves to a new session only with an approval: HANDOVER_APPROVAL");
  expect(lines[1]).toContain("nope: a lane moves to a new session only with an approval: HANDOVER_APPROVAL");
  expect(lines[2]).toContain("is not the automatic approval of this side");
  // a hand-run with --wait-idle while another run holds the lane's lock: the approval refusal, not the lock's
  live.add(4242);
  mkdirSync(join(state.dir, "handover", "lanes"), { recursive: true });
  writeFileSync(join(state.dir, "handover", "lanes", "demo.lock"), JSON.stringify({ pid: 4242, at: "2026-10-11T16:30:00Z" }));
  const locked = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: AUTO, waitIdleMin: 20 });
  expect(locked.code).toBe(2);
  expect(printed.filter((l) => l.startsWith("HANDOVER_REFUSED")).at(-1)).toContain("demo: a lane moves to a new session only with an approval: HANDOVER_APPROVAL");
  expect(existsSync(join(state.dir, "handover", "lanes", "demo.lock"))).toBe(true);
  expect(readRollovers(state.dir)).toEqual([]);
});

test("two processes that present one grant at once: exactly one takes it (review 312)", async () => {
  // Given
  const dir = mkdtempSync(join(tmpdir(), "dori-grant-race-"));
  const token = mintAutoGrant(dir, "lane", "demo", Date.now());
  const code = `import { takeAutoGrant } from ${JSON.stringify(join(import.meta.dir, "../src/rollover.ts"))}; console.log(takeAutoGrant(${JSON.stringify(dir)}, "lane", "demo", ${JSON.stringify(token)}, Date.now()));`;
  // When: 12 separate processes, started together
  const procs = Array.from({ length: 12 }, () => Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" }));
  const outs = await Promise.all(procs.map(async (p) => { await p.exited; return (await new Response(p.stdout).text()).trim(); }));
  // Then
  expect(outs.filter((o) => o === "true")).toHaveLength(1);
  expect(outs.filter((o) => o === "false")).toHaveLength(11);
  expect(readdirSync(join(dir, "handover", "auto-grants"))).toEqual([]);
});

test("the ready mark's start again of a lead's refused handover goes through the real handover with the lead's approval and needs no grant", async () => {
  // Given: a lead's handover refused for the lane's chain 15
  const base: LaneHandoverDeps = { ...(await setup()), reportOwner: async () => "msg-1" };
  const LEAD_OK = "lead:STUCK rung 4 on loss after research";
  await laneHandover(base, "demo", "aoe_lead_x", { approvedBy: LEAD_OK });
  expect(readRollovers(state.dir).at(-1)).toMatchObject({ result: "refused", blocked: "work" });
  ready(base, [15], new Date(base.clock.now() + 1_000).toISOString());
  // When: freshness starts it again, the hook running the real lane handover with what it is given
  const codes: number[] = [];
  await freshnessTick(base, "/home/test", { signals: async () => ({}), alive: () => false, resume: async (key, approvedBy, request) => {
    codes.push((await laneHandover(base, key, "aoe_lead_x", { approvedBy, ...request })).code);
    return { started: true, line: "unit=u" };
  } });
  // Then
  expect(codes).toEqual([0]);
  expect(printed).toContain(`HANDOVER_COMMITTED demo ${NEW}`);
  expect(readRollovers(state.dir).at(-1)).toMatchObject({ result: "done", decidedBy: "lead", approvedBy: LEAD_OK });
});

test("a dry run checks a given approval the same way and says so, writing nothing to the rollover log", async () => {
  // Given
  const deps = await setup();
  // When
  await laneHandover(deps, "demo", "aoe_lead_x", { ...OK, dryRun: true });
  const bad = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: "https://discord.com/channels/1/2/5", dryRun: true });
  // Then
  expect(printed).toContain(`HANDOVER_APPROVAL_OK ${JSON.stringify(OK.approvedBy)}`);
  expect(bad.code).toBe(2);
  expect(printed.find((l) => l.startsWith("HANDOVER_REFUSED demo") && l.includes("message 5 is not in the inbox"))).toBeDefined();
  expect(readRollovers(state.dir)).toEqual([]);
});

test("a lead's approval may cite the owner's message instead of a signal, and holds only when the inbox has it from the owner", () => {
  // Given an inbox with the owner's message, someone else's, an answer row and a broken line
  const inbox = join(mkdtempSync(join(tmpdir(), "dori-owner-ref-")), "inbox.jsonl");
  writeFileSync(inbox, [
    JSON.stringify({ ts: "2026-10-17T04:45:38Z", id: "1560876422535577662", channel_id: "1558257428561137764", scope: "thread", author_id: "280680578314010625", content: "이 주제는 무조건 fable high로 열어" }),
    JSON.stringify({ ts: "2026-10-17T04:46:00Z", id: "1560876422535579999", channel_id: "1558257428561137764", scope: "pair-bot", author_id: "999999999999999999", content: "open it with fable" }),
    JSON.stringify({ ts: "2026-10-17T04:47:00Z", id: "Q7-answer", kind: "answer", qid: "Q7", answer: "yes" }),
    // the owner's button answer as the listener writes it (no author_id: it records only the owner's taps), one in a thread, one on a channel card
    JSON.stringify({ ts: "2026-10-20T10:25:04.293Z", id: "1562049001283395634", kind: "answer", qid: "Q5", answer: "지금 새로 켜 (추천)", answer_kind: "button", question: "E7 작업 세션을 새로 켜도 될까?", thread: "1561750689409933447", session: null, tmux: null }),
    JSON.stringify({ ts: "2026-10-20T10:26:00Z", id: "1562049001283390000", kind: "answer", qid: "Q6", answer: "응", answer_kind: "text", question: "옮길까?", thread: null, session: null, tmux: null }),
    "{not json",
  ].join("\n"));
  const owner = inboxMessages(inbox, ["280680578314010625"]);
  const check = (ref: string, o = owner, canReport = true) => approvalProblem(ref, () => undefined, { on: false, key: "handover.autoRolloverLanes" }, "demo", "p1", [], canReport, o);
  // When / Then: the owner's message, by id or by link, with a reason
  expect(check("lead:형 지시로 모델 변경, owner 1560876422535577662")).toBeUndefined();
  expect(check("lead:switch the model as asked, owner https://discord.com/channels/1/1558257428561137764/1560876422535577662")).toBeUndefined();
  expect(check("lead:모델을 fable high로 바꿈, 형 1560876422535577662")).toBeUndefined();
  // a made-up id, someone else's message, a link into another channel, no owner set up
  expect(check("lead:형 지시로 모델 변경, owner 1560876422535570000")).toContain("message 1560876422535570000 is not in the inbox");
  expect(check("lead:형 지시로 모델 변경, owner 1560876422535579999")).toContain("written by 999999999999999999, not by the owner");
  expect(check("lead:switch the model as asked, owner https://discord.com/channels/1/42/1560876422535577662")).toContain("is in channel 1558257428561137764 in the inbox, not in 42");
  expect(check("lead:형 지시로 모델 변경, owner 1560876422535577662", inboxMessages(inbox, []))).toContain("DORI_DISCORD_OWNER is not set");
  // a fake owner id does not ride on a real signal
  expect(check("lead:STUCK rung 4 on loss, owner 1560876422535570000")).toContain("is not in the inbox");
  // the reason is still needed, and the owner is still told afterwards
  expect(check("lead:owner 1560876422535577662")).toContain("does not say the reason");
  expect(check("lead:형 지시로 모델 변경, owner 1560876422535577662", owner, false)).toContain("needs a way to tell the owner afterwards");
  // the owner's card answer counts as his message, by id or link, with or without its card named; a wrong card or channel does not
  expect(check("lead:old session still sends [1m] after 1M patch, owner 1562049001283395634")).toBeUndefined();
  expect(check("lead:old session still sends [1m] after 1M patch, owner https://discord.com/channels/1528936606264856737/1561750689409933447/1562049001283395634")).toBeUndefined();
  expect(check("lead:old session still sends [1m] after 1M patch (PID 1571415), owner Q5 1562049001283395634")).toBeUndefined();
  expect(check("lead:형이 카드로 옮기라고 함, owner 1562049001283390000")).toBeUndefined();
  expect(check("lead:old session still sends [1m] after 1M patch, owner Q4 1562049001283395634")).toContain("is the owner's answer to card Q5, not to Q4");
  expect(check("lead:형 지시로 모델 변경, owner Q5 1560876422535577662")).toContain("is not a card answer, not to Q5");
  expect(check("lead:old session still sends [1m] after 1M patch, owner https://discord.com/channels/1/42/1562049001283395634")).toContain("is in channel 1561750689409933447 in the inbox, not in 42");
  expect(check("https://discord.com/channels/1528936606264856737/1561750689409933447/1562049001283395634")).toBeUndefined();
  // someone else's answer is never written as a row, so a made-up answer id stays unknown
  expect(check("lead:old session still sends [1m] after 1M patch, owner 1562049001283395999")).toContain("is not in the inbox");
  // without an owner reference nothing changed: a reason with no signal is refused, a signal passes
  expect(check("lead:형 지시로 모델 변경")).toContain("does not say the reason and the signal behind it");
  expect(check("lead:STUCK rung 4 on loss, research did not help")).toBeUndefined();
});

test("the old lane is quiet while it is replaced and may talk again after; every real attempt is logged with signals and steps", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  const quietSeen: (string | undefined)[] = [];
  const sleep = deps.clock.sleep;
  const watched = { ...deps, clock: { ...deps.clock, sleep: async (ms: number) => { quietSeen.push(quietReason(state.dir, OLD, deps.clock.now())); await sleep(ms); } } };
  // When
  const r = await laneHandover(watched, "demo", "aoe_lead_x", OK);
  await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(0);
  expect(quietSeen.some((q) => q?.startsWith(`HANDOVER_QUIET ${OLD}: the handover of demo to ${NEW} is running`))).toBe(true);
  expect(quietReason(state.dir, OLD, deps.clock.now())).toBeUndefined();
  const log = readRollovers(state.dir);
  expect(log[0]).toMatchObject({ kind: "rollover", who: "lane", key: "demo", from: OLD, to: NEW, approvedBy: OK.approvedBy, signals: { contextPct: 72 }, result: "done" });
  expect(log[0]?.kind === "rollover" && log[0].steps.map((s) => s.step)).toEqual(["open", "startup", "first-message", "verify", "close"]);
  expect(log[1]).toMatchObject({ kind: "rollover", who: "lane", result: "refused" });
});

test("rollover-stats gives counts, approval time, step times and the lane's quality signals before and after", () => {
  // Given
  const entries = [
    { kind: "proposal", who: "lane", at: "2026-10-11T10:00:00Z", key: "demo", pane: OLD, card: "Q4", signals: { contextPct: 75 }, crossed: ["context 75% >= 70%"], blockers: "" },
    { kind: "rollover", who: "lane", at: "2026-10-11T10:30:00Z", key: "demo", from: OLD, to: NEW, approvedBy: "Q4", proposedAt: "2026-10-11T10:00:00Z", approvalMin: 30, signals: { contextPct: 75, compactions: 2 }, steps: [{ step: "open", ms: 4000, ok: true }, { step: "verify", ms: 60000, ok: true }], result: "done", reasons: [] },
  ] as const;
  const watch = ["2026-10-11T09:00:00Z freshness NUDGED demo 16 min silent", "2026-10-11T09:30:00Z freshness NUDGED demo 20 min silent", "2026-10-11T09:40:00Z intent-check INTENT_CHECK demo OK 6 recent reports", "2026-10-11T09:45:00Z intent-check INTENT_CHECK demo GOAL_LOSS owner x", "2026-10-11T09:50:00Z stuck STUCK demo \"loss\" rung 3 (tagged 3)", "2026-10-11T11:00:00Z freshness NO-REPORT demo pane", "2026-10-11T11:00:00Z freshness NUDGED other 1"];
  // When
  const out = rolloverStats(entries as never, watch, Date.parse("2026-10-11T12:30:00Z"));
  // Then
  expect(out[0]).toBe("ROLLOVER_STATS proposals=1 rollovers=1 (done 1) approval_median_min=30 window=24h");
  expect(out[1]).toBe("ROLLOVER_STEPS open median 4s fail 0; verify median 60s fail 0");
  expect(out).toContain(`QUALITY demo 2026-10-11T10:30:00Z before 24h: NUDGED 2, INTENT_CHECK 1, STUCK 1 | after 2h: NO-REPORT 1`);
  const lead = rolloverStats([{ ...entries[1], approvedBy: "lead:STUCK rung 4", decidedBy: "lead", reason: "STUCK rung 4", ownerReport: { message: "m1" } }, { ...entries[1], decidedBy: "lead", ownerReport: { error: "429" } }] as never, [], Date.parse("2026-10-11T12:30:00Z"));
  expect(lead[2]).toContain("; decided by the lead (STUCK rung 4), owner told: m1");
  expect(lead[4]).toContain("owner told: MISSING (429)");
});

test("rollover-stats ends with each stuck rollover and what came of it: resolved, not resolved or unknown, in the lane's words", async () => {
  // Given: four stuck moves (one moved again, one closed by the lead without a line), a context move, and a refused stuck run
  const move = (key: string, at: string, extra: object = {}) => ({ kind: "rollover", who: "lane", at, key, from: OLD, to: NEW, decidedBy: "auto", signals: { stuck: { metric: "review", n: 4, rung: 4 } }, steps: [], result: "done", reasons: [], ...extra });
  const entries = [
    move("a", "2026-10-11T10:00:00Z"),
    { kind: "outcome", at: "2026-10-11T10:19:00Z", key: "a", rolloverAt: "2026-10-11T10:00:00Z", resolved: true, line: "read the reviewer's diff instead of the summary", by: "claim-done" },
    move("b", "2026-10-11T11:00:00Z", { decidedBy: "lead" }),
    { kind: "outcome", at: "2026-10-11T12:00:00Z", key: "b", rolloverAt: "2026-10-11T11:00:00Z", resolved: false, line: "same wall", by: "claim-done" },
    move("c", "2026-10-11T12:00:00Z"),
    { kind: "outcome", at: "2026-10-11T12:30:00Z", key: "c", rolloverAt: "2026-10-11T12:00:00Z", line: "owner dropped it", by: "close" },
    move("d", "2026-10-11T13:00:00Z"),
    move("d", "2026-10-11T14:00:00Z", { signals: { contextPct: 90 } }),
    move("e", "2026-10-11T15:00:00Z", { result: "refused" }),
  ];
  // When
  const out = rolloverStats(entries as never, [], Date.parse("2026-10-11T16:00:00Z"));
  // Then
  const at = out.findIndex((l) => l.startsWith("STUCK_OUTCOMES "));
  expect(out.slice(at)).toEqual([
    "STUCK_OUTCOMES here stuck_rollovers=4 (auto 3) resolved=1 not_resolved=1 unknown=2",
    `STUCK_ROLLOVER here a 2026-10-11T10:00:00Z by auto on "review" (4x) -> resolved 19 min after (claim-done): read the reviewer's diff instead of the summary`,
    `STUCK_ROLLOVER here b 2026-10-11T11:00:00Z by lead on "review" (4x) -> not resolved 60 min after (claim-done): same wall`,
    `STUCK_ROLLOVER here c 2026-10-11T12:00:00Z by auto on "review" (4x) -> unknown 30 min after (close): owner dropped it`,
    `STUCK_ROLLOVER here d 2026-10-11T13:00:00Z by auto on "review" (4x) -> moved again at 2026-10-11T14:00:00Z, no line`,
  ]);
  // and each other Dori's log is read as its account; one that cannot be read says so
  const log = entries.map((e) => JSON.stringify(e)).join("\n");
  const calls: string[][] = [];
  const peers = await peerStuckLines(async (argv) => {
    calls.push([...argv]);
    return argv[3] === "soodori" ? { code: 0, out: log, err: "" } : { code: 1, out: "", err: "sudo: a password is required" };
  }, ["soodori:/home/soodori/.soodori/state/rollover-log.jsonl", "okdori:/home/okdori/.okdori/state/rollover-log.jsonl", "bad"]);
  expect(calls[0]).toEqual(["sudo", "-n", "-u", "soodori", "cat", "/home/soodori/.soodori/state/rollover-log.jsonl"]);
  expect(peers[0]).toBe("STUCK_OUTCOMES soodori stuck_rollovers=4 (auto 3) resolved=1 not_resolved=1 unknown=2");
  expect(peers.slice(-2)).toEqual(["STUCK_OUTCOMES okdori UNREADABLE: sudo: a password is required", "STUCK_OUTCOMES bad UNREADABLE: give <user>:<absolute path of its rollover-log.jsonl>"]);
});

test("compactions are counted from the session log, reading only what was added since the last count", () => {
  // Given
  const dir = join(state.dir, "s");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "2026-10-11T10-00-00-000Z_abcdefab-0000-0000-0000-000000000000.jsonl");
  writeFileSync(file, '{"type":"message","text":"{\\"type\\":\\"compaction\\"}"}\n{"type":"compaction","id":"1"}\n');
  // When
  const one = compactionsIn(file);
  appendFileSync(file, '{"type":"compaction","id":"2"}\n{"type":"compac');
  const two = compactionsIn(file);
  appendFileSync(file, 'tion","id":"3"}\n');
  const signals = sessionSignals(dir, "abcdefab-0000-0000-0000-000000000000", Date.parse("2026-10-11T22:00:00Z"));
  // Then
  expect([one, two]).toEqual([1, 2]);
  expect(signals).toEqual({ compactions: 3, ageH: 12 });
});

test("a chain that outlives the close is not restarted, and a new account is logged", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  sim.chainSurvives = true;
  sim.account = "orientpine";
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(0);
  expect(sent(w).some((x) => x.startsWith("[LEAD] HANDOVER_CHAINS_ENDED"))).toBe(false);
  expect(sent(w).some((x) => x.startsWith("[LEAD] HANDOVER_CHAIN_SURVIVED: these local chains of the old session still run after it closed: 15 bash -c sleep 7200"))).toBe(true);
  expect(printed).toContain("HANDOVER_CHAIN_SURVIVED demo 15; the new session was told not to restart them");
  expect(sim.doubleRun).toBe(false);
  expect(printed).toContain("HANDOVER_ACCOUNT demo x -> orientpine (the account pool chose it for the new session)");
  expect(readRollovers(state.dir)[0]).toMatchObject({ accounts: { from: "x", to: "orientpine" } });
});

test("an owner's line with escaped quotes inside is one item, and it counts as restated either way", () => {
  // Given
  const facts = { lane: { ...lane(), goal: "" }, laneNote: `## Owner's words and constraints\n- Brief: "put only \\"none\\" under Ruled out on purpose"\n` } as unknown as LaneFacts;
  // Then
  expect(missingFrom(RESTATE, facts).map((m) => m.text)).toEqual(['put only "none" under Ruled out on purpose']);
  expect(missingFrom(`${RESTATE}- "put only \\"none\\" under Ruled out on purpose"\n`, facts)).toEqual([]);
  expect(missingFrom(`${RESTATE}- put only "none" under Ruled out on purpose\n`, facts)).toEqual([]);
});

test("a job started from the pane's shell dies with it too: it counts as a local chain", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  table = [...baseTable(), { pid: 50, ppid: 10, cmd: "sleep 300" }];
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(2);
  expect(printed[0]).toStartWith("HANDOVER_REFUSED demo: 1 local chain(s) would die: 50 sleep 300");
});

// aoe starts the agent through a launcher shell, and omo keeps its python eval kernel alive once a lane used it
const LAUNCHER = { pid: 9, ppid: 10, cmd: "/bin/bash /dev/fd/4" };
const KERNEL = { pid: 30, ppid: 11, cmd: "python3 -u /r/node_modules/@code-yeongyu/senpi-codemode/src/kernels/py/prelude.py" };
const aoeTable = (): Proc[] => [LAUNCHER, ...baseTable().map((p) => (p.pid === 11 ? { ...p, ppid: 9 } : p)), KERNEL];
const evalCell = (id: string, at: string, text = `Eval cell ${id} detached and is running in the background`) =>
  appendFileSync(join(sessionDirFor(join(state.dir, "sessions"), CWD), "2026-10-11T10-00-00-000Z_old-sid.jsonl"), `\n${JSON.stringify({ type: "message", timestamp: at, message: { role: "toolResult", toolName: "eval", toolCallId: id, content: [{ type: "text", text }] } })}`);

test("the lane's own launcher shell and an idle eval kernel are not local chains: an idle lane moves without a ready mark", async () => {
  // Given: the live tree of yoodori-gate-gaps (refused 6 times: 517160 /bin/bash /dev/fd/4; 584498 python3 -u ...prelude.py)
  const deps = await setup();
  table = aoeTable().filter((p) => p.pid !== 15 && p.pid !== 16);
  // an earlier (refused) dry run listed both as chains: they are still the session's own, not detached jobs
  mkdirSync(join(state.dir, "handover", "lanes"), { recursive: true });
  writeFileSync(join(state.dir, "handover", "lanes", "demo-20261011-120000.json"), JSON.stringify({ detached: [], chains: [{ pid: 9, cmd: LAUNCHER.cmd }, { pid: 30, cmd: KERNEL.cmd }] }));
  for (const pid of [9, 30]) live.add(pid);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  // Then
  expect(printed.filter((l) => l.startsWith("HANDOVER_REFUSED"))).toEqual([]);
  expect(r.code).toBe(0);
  expect(readFileSync(r.note ?? "", "utf8")).toContain("## Local chains of the old session (0)");
  expect(printed.at(-1)).toEndWith("detached jobs left alone: 40");
});

test("work under the lane's own processes still refuses: an agent child, a kernel child, a background eval cell still running", async () => {
  // Given
  const deps = await setup();
  // When: a real chain under the agent, with the launcher shell and the kernel present
  table = aoeTable();
  const chain = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  // a process an eval cell started dies with the kernel
  table = [...aoeTable().filter((p) => p.pid !== 15 && p.pid !== 16), { pid: 31, ppid: 30, cmd: "python3 train.py --seed 3" }];
  const kernelChild = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  // a detached cell computing inside the kernel has no process of its own
  table = aoeTable().filter((p) => p.pid !== 15 && p.pid !== 16);
  evalCell("toolu_c1", "2026-10-11T16:20:00Z");
  const cell = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  // a ready mark taken after the cell started covers it, like the chains it lists
  ready(deps, []);
  const covered = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  // Then
  expect([chain.code, kernelChild.code, cell.code, covered.code]).toEqual([2, 2, 2, 0]);
  const refused = printed.filter((l) => l.startsWith("HANDOVER_REFUSED"));
  expect(refused[0]).toStartWith("HANDOVER_REFUSED demo: 1 local chain(s) would die: 15 bash -c sleep 7200; echo chain-done. ");
  expect(refused[1]).toStartWith("HANDOVER_REFUSED demo: 1 local chain(s) would die: 31 python3 train.py --seed 3. ");
  expect(refused[2]).toStartWith("HANDOVER_REFUSED demo: 1 eval cell(s) still run in the background: toolu_c1. ");
  expect(refused.length).toBe(3);
});

test("a zombie the agent has not collected is no local chain: a lane with only zombies moves, one beside a real chain still refuses for the chain only", async () => {
  // Given: yoodori-gate-gaps on 10-19, refused 5 times for "3428606 [bash] <defunct>" under its agent
  const deps = await setup();
  const idle = aoeTable().filter((p) => p.pid !== 15 && p.pid !== 16);
  table = [...idle, { pid: 3428606, ppid: 11, stat: "Z", cmd: "[bash] <defunct>" }, { pid: 2548935, ppid: 30, cmd: "[git] <defunct>" }];
  // When
  const zombies = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  const zombieNote = readFileSync(zombies.note ?? "", "utf8");
  table = [...idle, { pid: 3428606, ppid: 11, stat: "Z", cmd: "[bash] <defunct>" }, { pid: 31, ppid: 11, stat: "S", cmd: "bash -c ./train.sh" }, { pid: 32, ppid: 31, stat: "Z", cmd: "[sh] <defunct>" }];
  const chain = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  // Then
  expect([zombies.code, chain.code]).toEqual([0, 2]);
  expect(zombieNote).toContain("## Local chains of the old session (0)");
  const refused = printed.filter((l) => l.startsWith("HANDOVER_REFUSED"));
  expect(refused).toEqual([expect.stringContaining("HANDOVER_REFUSED demo: 1 local chain(s) would die: 31 bash -c ./train.sh. ")]);
  expect(JSON.parse(readFileSync((chain.note ?? "").replace(/\.md$/, ".json"), "utf8")).chains).toEqual([{ pid: 31, cmd: "bash -c ./train.sh", pids: [31] }]);
});

test("a background eval cell that ended, or was started before a ready mark, does not refuse; one started after it does", async () => {
  // Given
  const deps = await setup();
  table = aoeTable().filter((p) => p.pid !== 15 && p.pid !== 16);
  evalCell("toolu_c1", "2026-10-11T16:00:00Z");
  appendFileSync(join(sessionDirFor(join(state.dir, "sessions"), CWD), "2026-10-11T10-00-00-000Z_old-sid.jsonl"), `\n${JSON.stringify({ type: "custom_message", timestamp: "2026-10-11T16:10:00Z", content: "Detached eval cell toolu_c1 (py) finished" })}`);
  // When
  const ended = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  ready(deps, [], "2026-10-11T16:30:00Z");
  evalCell("toolu_c2", "2026-10-11T16:31:00Z");
  const after = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  const forced = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true, force: true });
  // Then
  expect([ended.code, after.code, forced.code]).toEqual([0, 2, 0]);
  expect(printed.filter((l) => l.startsWith("HANDOVER_REFUSED"))).toEqual([expect.stringContaining("1 eval cell(s) still run in the background: toolu_c2. ")]);
});

test("an automatic rollover never moves a lane that watches a training chain: refused once, no more automatic starts in that pane; the lead's dry run passes", async () => {
  // Given: e7-beyond-eth on 10-19: its training runs on another node, only its watch runs here (a monitor), beside an idle kernel
  const base = await setup();
  const deps: LaneHandoverDeps = { ...base, config: { ...base.config, handover: { ...base.config.handover, autoRolloverLanes: true } }, reportOwner: async () => "msg-1" };
  const WATCH = "bash /w/rand_watch/q267_chain_watch.sh";
  writeManifest("old-sid", [monitor("scratch events", EVENTS, 14), monitor("Q267 chain s21 then s31", WATCH, 18)]);
  live.add(18);
  table = [...aoeTable().filter((p) => p.pid !== 15 && p.pid !== 16), { pid: 18, ppid: 11, cmd: WATCH }];
  await deps.registry.patch("demo", { rolloverDue: { pane: OLD, at: "2026-10-11T16:00:00Z", crossed: ["context after compaction 330k >= 300k"], autoAt: "2026-10-11T16:30:00Z", tries: 1 } });
  // When
  const auto = await laneHandover(deps, "demo", "aoe_lead_x", autoRun(deps));
  const byHand = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  // Then
  expect(auto.code).toBe(2);
  expect(printed[0]).toBe(`HANDOVER_REFUSED demo: an automatic rollover does not move a lane that runs or watches a training or eval chain (training chain watched: monitor "Q267 chain s21 then s31"); no more automatic starts in ${OLD}. The lead moves it by hand: dori handover --lane demo --approved-by "lead:<reason and signal>"`);
  expect((await readLane(deps)).rolloverDue).toMatchObject({ pane: OLD, tries: 1, leftToLead: 'training chain watched: monitor "Q267 chain s21 then s31"' });
  expect(readRollovers(state.dir).at(-1)).toMatchObject({ result: "refused", blocked: "training" });
  expect(opened()).toBe(false);
  expect(byHand.code).toBe(0);
  expect(printed.filter((l) => l.startsWith("HANDOVER_REFUSED"))).toHaveLength(1);
});

test("a lane tagged training is left to the lead as well; ordinary monitors and an empty trainingWatch hold nothing", async () => {
  // Given
  const base = await setup();
  const deps: LaneHandoverDeps = { ...base, config: { ...base.config, handover: { ...base.config.handover, autoRolloverLanes: true } }, reportOwner: async () => "msg-1" };
  await deps.registry.patch("demo", { tags: ["rl", "training"] });
  ready(deps, [15]);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", autoRun(deps));
  // Then
  expect(r.code).toBe(2);
  expect(printed[0]).toContain("a training or eval chain (tag training)");
  const h = deps.config.handover;
  const plain = [{ description: "scratch events", command: EVENTS, persistent: true }, { description: "digest", command: "until false; do sleep 60; done", persistent: true }, { description: "CI", command: "until grep -q '^LOCAL_CI_RC=' /q/ci.log; do sleep 30; done", persistent: true }];
  expect(trainingMark(lane(), plain, h)).toBeUndefined();
  expect(trainingMark(lane(), [{ description: "judge", command: "tail -n 0 -F /w/hr35-eth-v2-t1/runs/judge.log", persistent: true }], h)).toBe('training chain watched: monitor "judge"');
  expect(trainingMark(lane(), [{ description: "Q267 chain", command: "bash q267_chain_watch.sh", persistent: true }], { ...h, trainingWatch: "" })).toBeUndefined();
  // e7-beyond-eth on 10-19: a replay on another node, no chain word in the command, only its filter and description say eval
  const spark = { description: "Q267 s21 Spark replay on ori644d: progress/fail/done", command: "bash /home/oriclaw/work/rand_watch/q267_spark_watch.sh arch_cnngru_q267_s21_mn ori644d", filter: "Q267_EVAL", persistent: true };
  expect(trainingMark(lane(), [spark], h)).toBe('training chain watched: monitor "Q267 s21 Spark replay on ori644d: progress/fail/done"');
  expect(trainingMark(lane(), [{ ...spark, description: "s21" }], h)).toBe('training chain watched: monitor "s21"');
});

test("a ready mark covers chains only: a turn that started after it still refuses", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  w.screens[OLD] = `${HIGH}\n • Working (esc to interrupt)`;
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(2);
  expect(printed[0]).toContain("a turn is running");
  expect(opened()).toBe(false);
});

const AUTO = "auto:handover.autoRolloverLanes";
// what freshness gives the run it starts (cli.ts auto hook): the automatic approval and a one-use grant for this lane
const autoRun = (deps: LaneHandoverDeps, extra: Partial<LaneHandoverOptions> = {}, key = "demo"): LaneHandoverOptions => ({ approvedBy: AUTO, autoGrant: mintAutoGrant(deps.config.stateDir, "lane", key, deps.clock.now()), ...extra });
const BUSY = `${HIGH}\n • Working (esc to interrupt)`;

test("an automatic start waits for the lane's idle moment and freezes it right then, before the new session opens; a turn that slips in is thawed and waited for again", async () => {
  // Given: a lane in a turn (a goal continuation), no chain of its own
  const base = await setup();
  const c = fakeClock(Date.parse("2026-10-11T16:35:00Z"));
  let polls = 0;
  const order: string[] = [];
  const posted: string[] = [];
  const deps: LaneHandoverDeps = {
    ...base,
    clock: { now: () => c.at, sleep: async (ms: number) => { c.at += ms; polls++; if (polls === 4 || polls === 6) w.screens[OLD] = HIGH; simulate(); } },
    config: { ...base.config, handover: { ...base.config.handover, autoRolloverLanes: true } },
    reportOwner: async (_thread, text) => { posted.push(text); return "msg-9"; },
    signal: (pid, sig) => {
      order.push(`${sig} ${pid}${opened() ? " after open" : ""}`);
      // the first freeze lands just as a turn starts
      if (sig === "SIGSTOP" && order.length === 1) w.screens[OLD] = BUSY;
      return true;
    },
  };
  table = aoeTable().filter((p) => p.pid !== 15 && p.pid !== 16);
  w.screens[OLD] = BUSY;
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", autoRun(deps, { waitIdleMin: 20 }));
  // Then
  expect(r.code).toBe(0);
  expect(printed.filter((l) => l.startsWith("HANDOVER_WAIT_IDLE demo"))).toHaveLength(1);
  expect(printed).toContain("HANDOVER_THAWED demo agent 11: a turn started as it was frozen");
  expect(printed.find((l) => l.startsWith("HANDOVER_FROZEN demo"))).toContain("at its idle moment");
  expect(order.slice(0, 3)).toEqual(["SIGSTOP 11", "SIGCONT 11", "SIGSTOP 11"]);
  expect(order.filter((s) => s.startsWith("SIGSTOP"))).toHaveLength(2);
  expect(sent(w).some((t) => t.includes("Stop here"))).toBe(false);
  expect(printed).toContain(`HANDOVER_COMMITTED demo ${NEW}`);
  expect(posted).toHaveLength(1);
  expect(readRollovers(state.dir).at(-1)).toMatchObject({ result: "done", decidedBy: "auto" });
  expect(existsSync(join(state.dir, "handover", "lanes", "demo.lock"))).toBe(false);
});

test("an automatic start whose lane stays busy for the whole wait is refused as busy and opens nothing; work that would die refuses at once, without waiting, and names its pids", async () => {
  // Given
  const base = await setup();
  const c = fakeClock(Date.parse("2026-10-11T16:35:00Z"));
  let sleeps = 0;
  const deps: LaneHandoverDeps = { ...base, clock: { now: () => c.at, sleep: async (ms: number) => { c.at += ms; sleeps++; } }, config: { ...base.config, handover: { ...base.config.handover, autoRolloverLanes: true } }, reportOwner: async () => "msg-1" };
  table = aoeTable().filter((p) => p.pid !== 15 && p.pid !== 16);
  w.screens[OLD] = BUSY;
  // When
  const busy = await laneHandover(deps, "demo", "aoe_lead_x", autoRun(deps, { waitIdleMin: 20 }));
  const waited = sleeps;
  table = aoeTable();
  w.screens[OLD] = HIGH;
  const work = await laneHandover(deps, "demo", "aoe_lead_x", autoRun(deps, { waitIdleMin: 20 }));
  // Then
  expect([busy.code, work.code]).toEqual([2, 2]);
  expect(waited).toBe(400);
  expect(sleeps).toBe(waited);
  const log = readRollovers(state.dir).flatMap((e) => (e.kind === "rollover" ? [e] : []));
  expect(log.map((e) => [e.result, e.blocked, e.pids])).toEqual([["refused", "busy", undefined], ["refused", "work", [15, 16]]]);
  expect(log[0]?.reasons[0]).toStartWith("the lane stayed busy for 20 min: a turn is running (esc to interrupt on screen). ");
  expect(opened()).toBe(false);
  expect(sigs).toEqual([]);
  expect(existsSync(join(state.dir, "handover", "lanes", "demo.lock"))).toBe(false);
});

const LEAD_STUCK = "lead:STUCK rung 4 on loss after research";
const takeoverFile = (id = "4242-a") => join(state.dir, "handover", "lanes", `demo.takeover-${id}.json`);
const takeovers = () => readdirSync(join(state.dir, "handover", "lanes")).filter((n) => n.startsWith("demo.takeover-") && n.endsWith(".json"));

test("a lead's handover refused while the lane is busy asks the lane for its safe point itself and says the move waits: nothing more to type by hand", async () => {
  // Given: the lead typed "[LEAD] reach a safe point ..." by hand after each refusal (47 re-runs by hand in 3 weeks)
  const deps = await setup();
  table = aoeTable().filter((p) => p.pid !== 15 && p.pid !== 16);
  w.screens[OLD] = BUSY;
  // When
  const busy = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  table = aoeTable();
  w.screens[OLD] = HIGH;
  const work = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect([busy.code, work.code]).toEqual([2, 2]);
  const asks = sent(w).filter((t) => t.startsWith("[LEAD] The lead moves demo to a new session") && t.includes("dori handover ready demo --note <file>"));
  expect(asks).toHaveLength(2);
  const pending = printed.filter((l) => l.startsWith("HANDOVER_PENDING demo: "));
  expect(pending).toHaveLength(2);
  expect(pending[0]).toContain("starts by itself the moment the lane is idle");
  expect(pending[1]).toContain("starts by itself once the lane marks ready or the work it named ended");
  expect(opened()).toBe(false);
});

test("a run waiting for the lane's idle moment steps aside for the lead's --force: it logs no rollover row and ends, freeing the lock", async () => {
  // Given: ZzangDori herdr-switch 2026-11-03 09:10:45Z, a --force refused "another handover is running (pid 666199)"
  const base = await setup();
  const c = fakeClock(Date.parse("2026-10-11T16:35:00Z"));
  let polls = 0;
  const deps: LaneHandoverDeps = {
    ...base,
    clock: { now: () => c.at, sleep: async (ms: number) => { c.at += ms; polls++; if (polls === 2) writeFileSync(takeoverFile(), JSON.stringify({ pid: 4242, at: new Date(c.at).toISOString(), approvedBy: LEAD_STUCK, force: true })); simulate(); } },
    config: { ...base.config, handover: { ...base.config.handover, autoRolloverLanes: true } },
    reportOwner: async () => "msg-1",
  };
  live.add(4242);
  table = aoeTable().filter((p) => p.pid !== 15 && p.pid !== 16);
  w.screens[OLD] = BUSY;
  // When: the lane stays busy the whole time
  const r = await laneHandover(deps, "demo", "aoe_lead_x", autoRun(deps, { waitIdleMin: 20 }));
  // Then
  expect(r.code).toBe(2);
  expect(printed.find((l) => l.startsWith("HANDOVER_STEPPED_ASIDE demo: "))).toContain("pid 4242");
  expect(readRollovers(state.dir).filter((e) => e.kind === "rollover")).toEqual([]);
  expect(existsSync(join(state.dir, "handover", "lanes", "demo.lock"))).toBe(false);
  expect(takeovers()).toEqual([]);
  expect(opened()).toBe(false);
});

test("a run that finds the lane's lock held moves the lane itself once the waiting holder stepped aside or ended; a holder mid-move leaves it refused with no rollover row, so the waiting request stays the last", async () => {
  // Given
  const base = await setup();
  let holder: "moving" | "aside" | "ended" = "moving";
  const lanes = join(state.dir, "handover", "lanes");
  const deps: LaneHandoverDeps = {
    ...base,
    reportOwner: async () => "msg-1",
    clock: { ...base.clock, sleep: async () => {
      const mine = takeovers()[0];
      if (holder === "aside" && mine) {
        rmSync(join(lanes, mine));
        live.delete(77);
      }
      if (holder === "ended") live.delete(77);
      simulate();
    } },
  };
  mkdirSync(lanes, { recursive: true });
  writeFileSync(join(lanes, "demo.lock"), JSON.stringify({ pid: 77, at: "2026-10-11T16:30:00Z" }));
  live.add(77);
  appendRollover(state.dir, { kind: "rollover", who: "lane", at: "2026-10-11T16:20:00.000Z", key: "demo", from: OLD, approvedBy: LEAD_STUCK, signals: {}, steps: [], result: "refused", reasons: ["busy"], blocked: "busy", request: {} });
  // When: the holder is moving the lane and takes nothing
  const refused = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: LEAD_STUCK, force: true });
  const rowsAfterRefusal = readRollovers(state.dir).filter((e) => e.kind === "rollover").length;
  const leftover = takeovers().length;
  // the waiting holder steps aside
  holder = "aside";
  const moved = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: LEAD_STUCK, force: true });
  // Then
  expect(refused.code).toBe(2);
  expect(printed.some((l) => l.startsWith("HANDOVER_REFUSED demo: another handover is running (pid 77"))).toBe(true);
  // the refusal logged nothing: the lane's waiting request is still its last rollover row (review 320)
  expect(rowsAfterRefusal).toBe(1);
  expect(leftover).toBe(0);
  expect(printed.find((l) => l.startsWith("HANDOVER_TAKEN_OVER demo: "))).toContain("pid 77 that waited for the lane's idle moment");
  expect(moved.code).toBe(0);
  expect(printed).toContain(`HANDOVER_COMMITTED demo ${NEW}`);
  expect(readRollovers(state.dir).at(-1)).toMatchObject({ result: "done", approvedBy: LEAD_STUCK });
});

test("a holder whose wait ended without taking the request clears the way too: the run goes on and moves the lane", async () => {
  // Given: review 320, the holder's final busy check ended its wait while the request lay unclaimed
  const base = await setup();
  const lanes = join(state.dir, "handover", "lanes");
  const deps: LaneHandoverDeps = { ...base, reportOwner: async () => "msg-1", clock: { ...base.clock, sleep: async () => { live.delete(77); simulate(); } } };
  mkdirSync(lanes, { recursive: true });
  writeFileSync(join(lanes, "demo.lock"), JSON.stringify({ pid: 77, at: "2026-10-11T16:30:00Z" }));
  live.add(77);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: LEAD_STUCK, force: true });
  // Then
  expect(printed.find((l) => l.startsWith("HANDOVER_TAKEN_OVER demo: "))).toContain("the run of pid 77 ended");
  expect(r.code).toBe(0);
  expect(takeovers()).toEqual([]);
});

test("two runs that both find the lock held each leave a request of their own: the waiting run steps aside for the older one and leaves the other for its writer", async () => {
  // Given: two requests written while a run waits (review 320: one file overwritten by the other lost an approval)
  const base = await setup();
  const c = fakeClock(Date.parse("2026-10-11T16:35:00Z"));
  let polls = 0;
  const deps: LaneHandoverDeps = {
    ...base,
    clock: { now: () => c.at, sleep: async (ms: number) => { c.at += ms; polls++; if (polls === 2) {
      writeFileSync(takeoverFile("4243-b"), JSON.stringify({ pid: 4243, at: "2026-10-11T16:35:05.000Z", approvedBy: "lead:later, STUCK rung 4 on y", force: false, request: {} }));
      writeFileSync(takeoverFile("4242-a"), JSON.stringify({ pid: 4242, at: "2026-10-11T16:35:04.000Z", approvedBy: LEAD_STUCK, force: true, request: {} }));
    } simulate(); } },
    config: { ...base.config, handover: { ...base.config.handover, autoRolloverLanes: true } },
    reportOwner: async () => "msg-1",
  };
  live.add(4242).add(4243);
  table = aoeTable().filter((p) => p.pid !== 15 && p.pid !== 16);
  w.screens[OLD] = BUSY;
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", autoRun(deps, { waitIdleMin: 20 }));
  // Then
  expect(r.code).toBe(2);
  expect(printed.find((l) => l.startsWith("HANDOVER_STEPPED_ASIDE demo: "))).toContain("pid 4242");
  expect(takeovers()).toEqual(["demo.takeover-4243-b.json"]);
});

const WAITING = { kind: "rollover", who: "lane", at: "2026-10-11T16:20:00.000Z", key: "demo", from: OLD, approvedBy: LEAD_STUCK, signals: {}, steps: [], result: "refused", reasons: ["busy"], blocked: "busy", request: {} } as const;
const rolloverRows = () => readRollovers(state.dir).filter((e) => e.kind === "rollover");

test("a run that loses the lock to another caller after its checks writes no note and no rollover row: it goes the takeover way and is refused, so the waiting request stays the last (review 320 round 8)", async () => {
  // Given: two forcing callers restarted in the same second after the holder exited; the other one locks first
  const base = await setup();
  const lanes = join(state.dir, "handover", "lanes");
  let raced = false;
  const deps: LaneHandoverDeps = {
    ...base,
    reportOwner: async () => "msg-1",
    procs: async () => {
      if (!raced) {
        raced = true;
        mkdirSync(lanes, { recursive: true });
        writeFileSync(join(lanes, "demo.lock"), JSON.stringify({ pid: 77, at: "2026-10-11T16:35:01Z" }));
        live.add(77);
      }
      return table;
    },
  };
  appendRollover(state.dir, WAITING);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: LEAD_STUCK, force: true });
  // Then: nothing of this run is left for the winner's new session to read
  expect(r.code).toBe(2);
  expect(readdirSync(lanes).filter((n) => /^demo-\d{8}-\d{6}/.test(n))).toEqual([]);
  expect(rolloverRows()).toHaveLength(1);
  expect(printed.some((l) => l.startsWith("HANDOVER_REFUSED demo: another handover is running (pid 77"))).toBe(true);
  expect(opened()).toBe(false);
  expect(takeovers()).toEqual([]);
});

test("a forcing run that finds a live run mid-move (its pending journal) logs no rollover row: the waiting request outlives that run dying before it repointed (review 320 round 8)", async () => {
  // Given
  const base = await setup();
  const lanes = join(state.dir, "handover", "lanes");
  mkdirSync(lanes, { recursive: true });
  writeFileSync(pendingFile(state.dir, "demo"), JSON.stringify({ key: "demo", pid: 77, at: "2026-10-11T16:30:00Z", from: OLD, to: NEW, note: join(lanes, "demo-20261011-163000.md") }));
  writeFileSync(join(lanes, "demo.lock"), JSON.stringify({ pid: 77, at: "2026-10-11T16:30:00Z" }));
  live.add(77);
  appendRollover(state.dir, WAITING);
  // When: the forcing run gives up while the move runs, then the moving run dies before it repointed the lane
  const r = await laneHandover({ ...base, reportOwner: async () => "msg-1" }, "demo", "aoe_lead_x", { approvedBy: LEAD_STUCK, force: true });
  live.delete(77);
  // Then
  expect(r.code).toBe(2);
  expect(printed.some((l) => l.startsWith("HANDOVER_REFUSED demo: another handover is running (pid 77"))).toBe(true);
  expect(rolloverRows()).toHaveLength(1);
  expect(waitingRequest(readRollovers(state.dir), "demo", OLD)).toMatchObject({ approvedBy: LEAD_STUCK, blocked: "busy" });
  expect(takeovers()).toEqual([]);
});

test("a run that finds a dead journal while another run holds the lane's lock repairs nothing: the repair waits for the lock like any writer (review 320 round 12)", async () => {
  // Given: a dead run's journal, and a live run (77) that holds the lock and is repairing it
  const base = await setup();
  const lanes = join(state.dir, "handover", "lanes");
  mkdirSync(lanes, { recursive: true });
  const journal = { key: "demo", pid: 88, at: "2026-10-11T16:30:00Z", from: OLD, to: NEW, note: join(lanes, "demo-20261011-163000.md") };
  writeFileSync(pendingFile(state.dir, "demo"), JSON.stringify(journal));
  writeFileSync(join(lanes, "demo.lock"), JSON.stringify({ pid: 77, at: "2026-10-11T16:35:00Z" }));
  live.add(77);
  appendRollover(state.dir, WAITING);
  // When
  const r = await laneHandover({ ...base, reportOwner: async () => "msg-1" }, "demo", "aoe_lead_x", { approvedBy: LEAD_STUCK, force: true });
  // Then
  expect(r.code).toBe(2);
  expect(printed.some((l) => l.startsWith("HANDOVER_INTERRUPTED"))).toBe(false);
  expect(printed.some((l) => l.startsWith("HANDOVER_REFUSED demo: another handover is running (pid 77"))).toBe(true);
  expect(JSON.parse(readFileSync(pendingFile(state.dir, "demo"), "utf8"))).toMatchObject({ pid: 88 });
  expect(stoppedIds()).toEqual([]);
  expect(JSON.parse(readFileSync(join(lanes, "demo.lock"), "utf8"))).toMatchObject({ pid: 77 });
});

test("a safe-point request that did not reach the lane is kept on the waiting request, and freshness asks again once the pane takes text, once (review 320 round 8)", async () => {
  // Given: the lane's pane refuses the text (a herdr question open) while a long chain runs
  const base = await setup();
  let deliver = false;
  const asks = () => sent(w).filter((t) => t.startsWith("[LEAD] The lead moves demo to a new session"));
  const deps: LaneHandoverDeps = {
    ...base,
    run: async (argv, opts) => (!deliver && argv[0] === "tmux" && argv[1] === "send-keys" && argv.some((a) => a.startsWith("[LEAD] The lead moves demo")) ? { code: 1, out: "", err: "pane refused" } : base.run(argv, opts)),
  };
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  const row = rolloverRows().at(-1);
  const asksBefore = asks().length;
  // When: the pane takes text again; freshness sweeps twice
  deliver = true;
  const hooks = { signals: async () => ({}), alive: (pid: number) => live.has(pid), resume: async () => ({ started: false, line: "not now" }) };
  await deps.registry.patch("demo", { lastReplyAt: deps.clock.now() });
  await freshnessTick(deps, "/home/test", hooks);
  await freshnessTick(deps, "/home/test", hooks);
  // Then
  expect(r.code).toBe(2);
  expect(row).toMatchObject({ result: "refused", blocked: "work", safePoint: { told: false } });
  expect(asksBefore).toBe(0);
  expect(asks()).toHaveLength(1);
  expect(readFileSync(deps.config.watchLog, "utf8")).toContain("HANDOVER_SAFE_POINT_ASKED demo");
});

test("a run that waited twice keeps the pane it first found: the lane moved meanwhile by the run it waited on is not moved again (review 320 round 9)", async () => {
  // Given: this forcing run first found the lane in OLD; the winner repointed it to NEW and still finishes (its journal)
  const base = await setup();
  const lanes = join(state.dir, "handover", "lanes");
  mkdirSync(lanes, { recursive: true });
  await base.registry.patch("demo", { pane: NEW });
  writeFileSync(pendingFile(state.dir, "demo"), JSON.stringify({ key: "demo", pid: 77, at: "2026-10-11T16:30:00Z", from: OLD, to: NEW, note: join(lanes, "demo-20261011-163000.md") }));
  live.add(77);
  const deps: LaneHandoverDeps = { ...base, reportOwner: async () => "msg-1", clock: { ...base.clock, sleep: async () => {
    // the winner finishes within the wait: journal gone, process ended
    rmSync(pendingFile(state.dir, "demo"), { force: true });
    live.delete(77);
    simulate();
  } } };
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: LEAD_STUCK, force: true, boundPane: OLD });
  // Then
  expect(r.code).toBe(0);
  expect(printed).toContain(`HANDOVER_ALREADY_MOVED demo: the lane moved from ${OLD} to ${NEW} while this run waited; it is not moved again`);
  expect(opened()).toBe(false);
});

test("a run that first arrives after the lane was repointed waits on the move's source: a repair that rolled back leaves the request to run (review 320 round 13)", async () => {
  const outcome = "rolled-back" as "rolled-back" | "finished";
  // Given: a live run (77) repointed the lane OLD -> NEW and still holds its journal; this run is given no boundPane
  const base = await setup();
  const lanes = join(state.dir, "handover", "lanes");
  mkdirSync(lanes, { recursive: true });
  await base.registry.patch("demo", { pane: NEW });
  writeFileSync(pendingFile(state.dir, "demo"), JSON.stringify({ key: "demo", pid: 77, at: "2026-10-11T16:30:00Z", from: OLD, to: NEW, note: join(lanes, "demo-20261011-163000.md") }));
  live.add(77);
  let done = false;
  const deps: LaneHandoverDeps = { ...base, reportOwner: async () => "msg-1", clock: { ...base.clock, sleep: async () => {
    if (!done) {
      // the holder ends within the wait: its repair put the lane back on OLD, or its move finished on NEW
      done = true;
      if (outcome === "rolled-back") await base.registry.patch("demo", { pane: OLD });
      rmSync(pendingFile(state.dir, "demo"), { force: true });
      live.delete(77);
    }
    simulate();
  } } };
  // When
  await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: LEAD_STUCK, force: true });
  // Then
  const moved = printed.some((l) => l.startsWith("HANDOVER_ALREADY_MOVED demo"));
  expect([outcome, moved]).toEqual([outcome, outcome === "finished"]);
  if (outcome === "finished") expect(printed).toContain(`HANDOVER_ALREADY_MOVED demo: the lane moved from ${OLD} to ${NEW} while this run waited; it is not moved again`);
  expect([outcome, opened()]).toEqual([outcome, outcome === "rolled-back"]);
});

test("a run that first arrives after the lane was repointed waits on the move's source: a holder that finished the move makes it already moved, not moved again (review 320 round 13)", async () => {
  const outcome = "finished" as "rolled-back" | "finished";
  // Given: a live run (77) repointed the lane OLD -> NEW and still holds its journal; this run is given no boundPane
  const base = await setup();
  const lanes = join(state.dir, "handover", "lanes");
  mkdirSync(lanes, { recursive: true });
  await base.registry.patch("demo", { pane: NEW });
  writeFileSync(pendingFile(state.dir, "demo"), JSON.stringify({ key: "demo", pid: 77, at: "2026-10-11T16:30:00Z", from: OLD, to: NEW, note: join(lanes, "demo-20261011-163000.md") }));
  live.add(77);
  let done = false;
  const deps: LaneHandoverDeps = { ...base, reportOwner: async () => "msg-1", clock: { ...base.clock, sleep: async () => {
    if (!done) {
      // the holder ends within the wait: its repair put the lane back on OLD, or its move finished on NEW
      done = true;
      if (outcome === "rolled-back") await base.registry.patch("demo", { pane: OLD });
      rmSync(pendingFile(state.dir, "demo"), { force: true });
      live.delete(77);
    }
    simulate();
  } } };
  // When
  await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: LEAD_STUCK, force: true });
  // Then
  const moved = printed.some((l) => l.startsWith("HANDOVER_ALREADY_MOVED demo"));
  expect([outcome, moved]).toEqual([outcome, outcome === "finished"]);
  if (outcome === "finished") expect(printed).toContain(`HANDOVER_ALREADY_MOVED demo: the lane moved from ${OLD} to ${NEW} while this run waited; it is not moved again`);
  expect([outcome, opened()]).toEqual([outcome, outcome === "rolled-back"]);
});

test("a lead's request waiting for work keeps the lane from automatic rollovers, and an automatic refusal logged after it does not hide it: the request starts with its own options once the work ended (review 320 round 13)", async () => {
  // Given: the lane is past its context limit with the auto key on, and the lead's --keep-old request waits for chain 501
  const base = await setup();
  const deps = { ...base, config: { ...base.config, handover: { ...base.config.handover, laneContextPct: 80, autoRolloverLanes: true } } };
  const running = new Set<number>([501]);
  const autoRuns: string[] = [];
  const resumes: string[] = [];
  const hooks = {
    signals: async (pane: string) => (pane === OLD ? { contextPct: 85 } : {}),
    alive: (pid: number) => running.has(pid),
    auto: async (who: "lead" | "lane", key: string) => { autoRuns.push(`${who}:${key}`); return "started"; },
    resume: async (key: string, approvedBy: string, _request: unknown, serves?: { at: string; pane: string }) => { resumes.push(`${key} ${approvedBy} ${serves?.at}@${serves?.pane}`); return { started: true, line: "unit=u1" }; },
  };
  const tick = async () => {
    await deps.registry.patch("demo", { lastReplyAt: deps.clock.now() });
    return freshnessTick(deps, "/home/test", hooks);
  };
  appendRollover(state.dir, { kind: "rollover", who: "lane", at: "2026-10-11T16:20:00.000Z", key: "demo", from: OLD, approvedBy: LEAD_STUCK, signals: {}, steps: [], result: "refused", reasons: ["x"], blocked: "work", pids: [501], request: { keepOld: true } });
  // When: a sweep while the work runs; then an automatic run started before the request logs its own refusal; the work ends
  const first = await tick();
  appendRollover(state.dir, { kind: "rollover", who: "lane", at: "2026-10-11T16:21:00.000Z", key: "demo", from: OLD, approvedBy: "auto:handover.autoRolloverLanes", decidedBy: "auto", signals: {}, steps: [], result: "refused", reasons: ["x"], blocked: "work", pids: [501] });
  const second = await tick();
  running.delete(501);
  const third = await tick();
  // Then
  expect(autoRuns).toEqual([]);
  expect(first.some((a) => a.kind === "rollover_auto")).toBe(false);
  expect(second.some((a) => a.kind === "rollover_auto")).toBe(false);
  expect(third.filter((a) => a.kind === "ready_resume").map((a) => a.detail.split(":")[0])).toEqual(["started"]);
  expect(resumes).toEqual([`demo ${LEAD_STUCK} 2026-10-11T16:20:00.000Z@${OLD}`]);
});

test("an automatic run that holds the lane's lock gives way to a lead's request waiting for the lane: it moves nothing and logs no row (review 320 round 14)", async () => {
  // Given: the automatic run was dispatched before the lead's request was refused for chain 15; the lane then marked ready
  const base = await setup();
  const deps: LaneHandoverDeps = { ...base, config: { ...base.config, handover: { ...base.config.handover, autoRolloverLanes: true } }, reportOwner: async () => "msg-1" };
  appendRollover(state.dir, { kind: "rollover", who: "lane", at: new Date(deps.clock.now() - 60_000).toISOString(), key: "demo", from: OLD, approvedBy: LEAD_STUCK, signals: {}, steps: [], result: "refused", reasons: ["x"], blocked: "work", pids: [15], request: { keepOld: true } });
  ready(deps, [15]);
  const rows = rolloverRows().length;
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", autoRun(deps, { waitIdleMin: 5 }));
  // Then
  expect(r.code).toBe(2);
  expect(printed.some((l) => l.startsWith("HANDOVER_YIELDED demo"))).toBe(true);
  expect(opened()).toBe(false);
  expect(rolloverRows()).toHaveLength(rows);
});

test("a resumed run moves only for the request it was started for: one a --force already finished, with the lane in the new pane, moves nothing again (review 320 round 14)", async () => {
  // Given: the lead's request of 16:20 waited; a --force finished it meanwhile (done row, lane in NEW)
  const base = await setup();
  const deps: LaneHandoverDeps = { ...base, reportOwner: async () => "msg-1" };
  const at = "2026-10-11T16:20:00.000Z";
  appendRollover(state.dir, { ...WAITING, at });
  appendRollover(state.dir, { kind: "rollover", who: "lane", at: "2026-10-11T16:25:00.000Z", key: "demo", from: OLD, to: NEW, approvedBy: LEAD_STUCK, signals: {}, steps: [], result: "done", reasons: [] });
  await deps.registry.patch("demo", { pane: NEW });
  const rows = rolloverRows().length;
  // When: the run freshness started for the 16:20 request before it saw the move
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: LEAD_STUCK, waitIdleMin: 5, serves: { at, pane: OLD } });
  // Then
  expect(r.code).toBe(0);
  expect(printed.some((l) => l.startsWith(`HANDOVER_REQUEST_GONE demo: the request of ${at} in ${OLD}`))).toBe(true);
  expect(opened()).toBe(false);
  expect(rolloverRows()).toHaveLength(rows);
});

test("a resumed run whose request still waits, with the lane still in its pane, moves the lane (review 320 round 14)", async () => {
  // Given: the lead's request of 16:20 waits for chain 15, and the lane marked ready after it
  const base = await setup();
  const deps: LaneHandoverDeps = { ...base, reportOwner: async () => "msg-1" };
  const at = new Date(deps.clock.now() - 60_000).toISOString();
  appendRollover(state.dir, { ...WAITING, at, blocked: "work", pids: [15] });
  ready(deps, [15]);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: LEAD_STUCK, waitIdleMin: 5, serves: { at, pane: OLD } });
  // Then
  expect(r.code).toBe(0);
  expect(printed).toContain(`HANDOVER_COMMITTED demo ${NEW}`);
});

test("a safe-point ask whose cause quotes a backtick or $( still reaches the lane, and a sweep that cannot type it goes on with the other lanes (review 320 round 9)", async () => {
  // Given: a chain whose command line has a backtick and $( (an ordinary shell command)
  const base = await setup();
  table = aoeTable().map((p) => (p.pid === 15 ? { ...p, cmd: "bash -c echo `date` $(hostname); sleep 7200" } : p));
  // When
  const r = await laneHandover(base, "demo", "aoe_lead_x", OK);
  // Then: the ask went out with the characters written safely, and the row says so
  expect(r.code).toBe(2);
  const ask = sent(w).find((t) => t.startsWith("[LEAD] The lead moves demo to a new session"));
  expect(ask).toContain("echo 'date' $ (hostname)");
  expect(rolloverRows().at(-1)).toMatchObject({ blocked: "work", safePoint: { told: true } });
  // a row whose ask did not go out, its cause quoting them, is asked again without a throw
  appendRollover(state.dir, { ...WAITING, at: "2026-10-11T16:40:00.000Z", blocked: "work", pids: [15], safePoint: { why: "1 local chain(s) would die: 15 bash -c echo `date` $(hostname)", told: false } });
  await base.registry.patch("demo", { lastReplyAt: base.clock.now() });
  const hooks = { signals: async () => ({}), alive: (pid: number) => live.has(pid), resume: async () => ({ started: false, line: "not now" }) };
  await freshnessTick(base, "/home/test", hooks);
  expect(readFileSync(base.config.watchLog, "utf8")).toContain("HANDOVER_SAFE_POINT_ASKED demo");
});

test("an ask that did not reach the lane outlives the resumed run's own refusal: busy, then work on the --wait-idle path, and freshness asks once the pane takes text (review 320 round 9)", async () => {
  // Given: the lane's pane refuses text; the lead's request is refused busy
  const base = await setup();
  let deliver = false;
  const asks = () => sent(w).filter((t) => t.startsWith("[LEAD] The lead moves demo to a new session"));
  const deps: LaneHandoverDeps = {
    ...base,
    run: async (argv, opts) => (!deliver && argv[0] === "tmux" && argv[1] === "send-keys" && argv.some((a) => a.startsWith("[LEAD] The lead moves demo")) ? { code: 1, out: "", err: "pane refused" } : base.run(argv, opts)),
  };
  table = aoeTable().filter((p) => p.pid !== 15 && p.pid !== 16);
  w.screens[OLD] = BUSY;
  const busy = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // When: the resumed run (freshness starts it with --wait-idle) finds a long chain started meanwhile and is refused for work
  table = aoeTable();
  w.screens[OLD] = HIGH;
  const resumed = await laneHandover(deps, "demo", "aoe_lead_x", { ...OK, waitIdleMin: 20 });
  const row = rolloverRows().at(-1);
  deliver = true;
  const hooks = { signals: async () => ({}), alive: (pid: number) => live.has(pid), resume: async () => ({ started: false, line: "not now" }) };
  await deps.registry.patch("demo", { lastReplyAt: deps.clock.now() });
  await freshnessTick(deps, "/home/test", hooks);
  await freshnessTick(deps, "/home/test", hooks);
  // Then
  expect([busy.code, resumed.code]).toEqual([2, 2]);
  expect(row).toMatchObject({ result: "refused", blocked: "work", safePoint: { told: false } });
  expect(asks()).toHaveLength(1);
});

test("a newer facts snapshot written beside one of the same second is the one read next time: a job only it lists stays listed (review 320 round 10)", async () => {
  // Given: two runs in one second, the second wrote demo-<stamp>-<pid>.json
  const deps = await setup();
  const lanes = join(state.dir, "handover", "lanes");
  mkdirSync(lanes, { recursive: true });
  writeFileSync(join(lanes, "demo-20261010-120000.json"), JSON.stringify({ detached: [], chains: [] }));
  writeFileSync(join(lanes, "demo-20261010-120000-4242.json"), JSON.stringify({ detached: [{ pid: 41, cmd: "sleep 9999" }], chains: [] }));
  table = baseTable().filter((p) => p.pid !== 15 && p.pid !== 16);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  // Then
  expect(printed.at(-1)).toMatch(/detached jobs left alone: (?:\d+,)*41(?:,\d+)*$/);
  expect(r.note).toBeDefined();
});

// omo's input box sits between two ─ borders; the status lines under it can quote "esc to interrupt" (here the cwd and a
// session title), while omo's own running-turn mark is on the box's top border
const QUOTED = HIGH.replace("old transcript line\n❯ \n────", "old transcript line\n────\n❯ \n────").replace("~/work •", "~/work/esc to interrupt •").replace("(OmO) mem:x", "(OmO) Fix esc to interrupt indicator");
const BORDER_BUSY = QUOTED.replace("old transcript line\n────", "old transcript line\n── • Working (3s • esc to interrupt) ────");

test("busy mark scope: an idle lane whose status lines quote esc to interrupt is not refused as busy; the mark on the box's top border still refuses", async () => {
  // Given
  const deps = await setup();
  table = baseTable().filter((p) => p.pid !== 15 && p.pid !== 16);
  // When
  w.screens[OLD] = QUOTED;
  const idle = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  const idleLines = [...printed];
  w.screens[OLD] = BORDER_BUSY;
  const busy = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(idle.code).toBe(0);
  expect(idleLines.some((l) => l.includes("a turn is running"))).toBe(false);
  expect(idleLines.some((l) => l.startsWith("HANDOVER_DRY_RUN demo"))).toBe(true);
  expect(busy.code).toBe(2);
  expect(printed.findLast((l) => l.startsWith("HANDOVER_REFUSED"))).toContain("a turn is running");
  expect(opened()).toBe(false);
});

test("busy mark scope: an automatic start stops waiting once only the status lines quote esc to interrupt, and freezes the lane without thawing it", async () => {
  // Given: a turn runs (mark on the border), then ends at the second poll; the status lines keep quoting the words
  const base = await setup();
  const c = fakeClock(Date.parse("2026-10-11T16:35:00Z"));
  let polls = 0;
  const sigs: string[] = [];
  const deps: LaneHandoverDeps = {
    ...base,
    clock: { now: () => c.at, sleep: async (ms: number) => { c.at += ms; polls++; if (polls === 2) w.screens[OLD] = QUOTED; simulate(); } },
    config: { ...base.config, handover: { ...base.config.handover, autoRolloverLanes: true } },
    reportOwner: async () => "msg-9",
    signal: (pid, sig) => {
      sigs.push(`${sig} ${pid}`);
      return true;
    },
  };
  table = aoeTable().filter((p) => p.pid !== 15 && p.pid !== 16);
  w.screens[OLD] = BORDER_BUSY;
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", autoRun(deps, { waitIdleMin: 20 }));
  // Then
  expect(r.code).toBe(0);
  expect(printed.filter((l) => l.startsWith("HANDOVER_WAIT_IDLE demo"))).toHaveLength(1);
  expect(polls).toBeLessThan(10);
  expect(printed.some((l) => l.includes("a turn started as it was frozen"))).toBe(false);
  expect(printed.filter((l) => l.startsWith("HANDOVER_FROZEN demo"))).toHaveLength(1);
  expect(sigs[0]).toBe("SIGSTOP 11");
  expect(printed).toContain(`HANDOVER_COMMITTED demo ${NEW}`);
});

test("when the old session ends during the checks, the new one stays the lane instead of moving back to a dead pane", async () => {
  // Given
  const deps = await setup();
  ready(deps, [15]);
  sim.thinking = "medium";
  const run = deps.run;
  const dying = { ...deps, run: async (argv: readonly string[], opts?: never) => {
    if (firstMessageSent()) w.aoe = w.aoe.filter((s) => s.id !== OLD_ID);
    return run(argv, opts);
  } } as LaneHandoverDeps;
  // When
  const r = await laneHandover(dying, "demo", "aoe_lead_x", { ...OK, verifyMin: 1 });
  // Then
  expect(r).toMatchObject({ code: 1, to: NEW });
  expect(printed.find((l) => l.startsWith("HANDOVER_OLD_GONE demo"))).toBeDefined();
  expect((await readLane(deps)).pane).toBe(NEW);
  // the move is committed, so the lane's sessions are too: its cost counts the old session and the new one
  expect(await readLane(deps)).toMatchObject({ session: "new-sid", priorSessions: ["old-sid"] });
  expect(stoppedIds()).toEqual([]);
  expect(sent(w).some((x) => x.startsWith("[LEAD] HANDOVER_COMMITTED: the old session ended during the checks"))).toBe(true);
});

test("a job an earlier handover listed (detached, or a chain that outlived its session) is listed again while it runs", async () => {
  // Given
  const deps = await setup();
  mkdirSync(join(state.dir, "handover", "lanes"), { recursive: true });
  writeFileSync(join(state.dir, "handover", "lanes", "demo-20261010-120000.json"), JSON.stringify({ detached: [{ pid: 41, cmd: "sleep 9999" }], chains: [{ pid: 77, cmd: "gone" }] }));
  ready(deps, [15]);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  // Then
  const note = readFileSync(r.note ?? "", "utf8");
  expect(note).toContain("- 41: `sleep 9999`");
  expect(note).not.toContain("- 77:");
});

// ZzangDori herdr-switch, refused 2026-11-03 09:11:36Z: "2 local chain(s) would die: 726639 .../omo-ai; 727236 .../chrome-headless-"
const SUPERVISOR = { pid: 726639, ppid: 11, cmd: "/home/oriclaw/.bun/bin/bun /home/oriclaw/.bun/install/global/node_modules/omo-ai/plugin/extensions/memory-run-supervisor.mjs /home/oriclaw/.omo/memory/agents/src-72da2fba/runtime/reflection/runs/reflect-1" };
const LSP = { pid: 726700, ppid: 11, cmd: "/home/oriclaw/.bun/bin/bun /home/oriclaw/.bun/install/global/node_modules/omo-ai/plugin/runtime/lsp-daemon/dist/cli.js daemon" };
const BROWSER = { pid: 727236, ppid: 11, cmd: "/home/oriclaw/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell --disable-field-trial-config --headless --remote-debugging-pipe --user-data-dir=/tmp/playwright_chromiumdev_profile-x" };
// every process of the pane's terminal session (sid 10, the pane's shell) as herdr ends them all when it closes the tab
const inSession = (t: Proc[]): Proc[] => t.map((p) => ({ ...p, sid: p.pid === 40 ? 40 : p.pid === 41 ? 41 : 10 }));

test("omo-ai's own daemons are no local chains, and a headless browser the agent left is one the ready mark covers: nothing tells an idle browser from a working one", async () => {
  // Given: ZzangDori herdr-switch 09:11:36Z, refused for the memory run supervisor and a headless chrome
  const deps = await setup();
  table = [...baseTable().filter((p) => p.pid !== 15 && p.pid !== 16), SUPERVISOR, LSP, BROWSER];
  // When
  const refused = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  ready(deps, [BROWSER.pid]);
  const covered = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  // Then: only the browser holds the move (a driver can still be downloading after its cell returned: review 318 challenge)
  expect(refused.code).toBe(2);
  expect(printed[0]).toStartWith("HANDOVER_REFUSED demo: 1 local chain(s) would die: 727236 /home/oriclaw/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-");
  expect(covered.code).toBe(0);
  const note = readFileSync(covered.note ?? "", "utf8");
  expect(note).toContain("## Local chains of the old session (1)");
  expect(note).not.toContain("memory-run-supervisor");
  expect(note).not.toContain("lsp-daemon");
});

test("a headless browser a chain started is part of that chain, and a real chain beside the daemons still refuses for itself only", async () => {
  // Given
  const deps = await setup();
  table = [...baseTable(), SUPERVISOR, { ...BROWSER, ppid: 15 }];
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // a shell whose command names the browser and then more steps is a chain: the executable decides (review 318)
  table = [...baseTable().filter((p) => p.pid !== 15 && p.pid !== 16), { pid: 70, ppid: 11, cmd: "bash -c chrome-headless-shell --dump-dom https://x; ./postprocess.sh" }];
  const wrapped = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // so is a shell that names omo-ai's daemon path, and a browser doing a batch job itself, with no driver (review 318 round 2)
  table = [...baseTable().filter((p) => p.pid !== 15 && p.pid !== 16), { pid: 71, ppid: 11, cmd: "bash -c cat /g/omo-ai/plugin/runtime/lsp-daemon/dist/cli.js; ./long-job.sh" }];
  const named = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  table = [...baseTable().filter((p) => p.pid !== 15 && p.pid !== 16), { pid: 72, ppid: 11, cmd: "firefox --headless --screenshot /tmp/shot.png https://x" }];
  const batch = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // a driver flag beside a batch job does not make it idle (review 318 round 3)
  table = [...baseTable().filter((p) => p.pid !== 15 && p.pid !== 16), { pid: 74, ppid: 11, cmd: "firefox --headless --marionette --screenshot /tmp/shot.png https://x" }];
  const mixed = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect([r.code, wrapped.code, named.code, batch.code, mixed.code]).toEqual([2, 2, 2, 2, 2]);
  const refused = printed.filter((l) => l.startsWith("HANDOVER_REFUSED"));
  expect(refused[0]).toStartWith("HANDOVER_REFUSED demo: 1 local chain(s) would die: 15 bash -c sleep 7200; echo chain-done. ");
  expect(refused[1]).toStartWith("HANDOVER_REFUSED demo: 1 local chain(s) would die: 70 bash -c chrome-headless-shell --dump-dom https://x; ./postprocess.sh. ");
  expect(refused[2]).toStartWith("HANDOVER_REFUSED demo: 1 local chain(s) would die: 71 bash -c cat /g/omo-ai/plugin/runtime/lsp-daemon/dist/cli.js; ./long-job.sh. ");
  expect(refused[3]).toStartWith("HANDOVER_REFUSED demo: 1 local chain(s) would die: 72 firefox --headless --screenshot /tmp/shot.png https://x. ");
  expect(refused[4]).toStartWith("HANDOVER_REFUSED demo: 1 local chain(s) would die: 74 firefox --headless --marionette --screenshot /tmp/shot.png https://x. ");
});

test("a job that left the pane's process tree but stays in its terminal session dies with it: it is a local chain the ready mark covers, not a detached job", async () => {
  // Given: pingpong-analytics 2026-11-03 05:55Z, bun desk/worker.js listed as detached and dead after the close (0/1)
  const deps = await setup();
  const WORKER = { pid: 1530711, ppid: 1, cmd: "bun desk/worker.js" };
  table = inSession([...baseTable().filter((p) => p.pid !== 15 && p.pid !== 16), WORKER]);
  live.add(WORKER.pid);
  const env = deps.envOf;
  const sessionDeps: LaneHandoverDeps = { ...deps, envOf: (pid) => (pid === WORKER.pid ? "PI_SESSION_ID=old-sid" : env(pid)) };
  // When
  const refused = await laneHandover(sessionDeps, "demo", "aoe_lead_x", OK);
  ready(deps, [WORKER.pid]);
  const covered = await laneHandover(sessionDeps, "demo", "aoe_lead_x", { dryRun: true });
  // Then
  expect(refused.code).toBe(2);
  expect(printed[0]).toStartWith("HANDOVER_REFUSED demo: 1 local chain(s) would die: 1530711 bun desk/worker.js. ");
  expect(covered.code).toBe(0);
  const note = readFileSync(covered.note ?? "", "utf8");
  expect(note).toContain("## Local chains of the old session (1)");
  expect(note).toContain("- 1530711: `bun desk/worker.js`");
  // the job in a session of its own (setsid) survives the close and stays listed as detached
  expect(note).toContain("## Detached jobs (1)");
  expect(note).toContain("- 40: `sleep 7201`");
  expect(printed.at(-1)).toEndWith("detached jobs left alone: 40");
});

test("an orphan the eval kernel left is in the kernel's own session, which ends with the old session: a local chain too", async () => {
  // Given: QA lane qa-hsa 2026-11-03 13:12Z, the py kernel 982058 in a session of its own; its orphan sleep 6100 (ppid 1,
  // sid 982058) died at the close, a nohup job of omo's bash tool (sid of a session whose leader had ended) survived
  const deps = await setup();
  const ORPHAN = { pid: 60, ppid: 1, cmd: "sleep 6100", sid: 30 };
  const NOHUP = { pid: 61, ppid: 1, cmd: "sleep 6150", sid: 59 };
  table = [...inSession(aoeTable().filter((p) => p.pid !== 15 && p.pid !== 16)).map((p) => (p.pid === 30 ? { ...p, sid: 30 } : p)), ORPHAN, NOHUP];
  live.add(60).add(61);
  const env = deps.envOf;
  const marked: LaneHandoverDeps = { ...deps, envOf: (pid) => (pid === 60 || pid === 61 ? "PI_SESSION_ID=old-sid" : env(pid)) };
  // When
  const r = await laneHandover(marked, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(2);
  expect(printed[0]).toStartWith("HANDOVER_REFUSED demo: 1 local chain(s) would die: 60 sleep 6100. ");
  ready(deps, [60]);
  const covered = await laneHandover(marked, "demo", "aoe_lead_x", { dryRun: true });
  expect(printed.at(-1)).toEndWith("detached jobs left alone: 40,61");
  expect(covered.code).toBe(0);
});

test("what carries the lane's session in its environment but belongs to other sessions is no detached job of the lane: the herdr server it started and that server's panes", async () => {
  // Given: ZzangDori herdr-switch 2026-11-03 09:10Z listed 8 such processes (herdr server, its pane shells, other agents)
  const deps = await setup();
  const foreign = [
    { pid: 50, ppid: 1, cmd: "/home/oriclaw/.local/lib/herdr/herdr server" },
    { pid: 51, ppid: 50, cmd: "/bin/bash" },
    { pid: 52, ppid: 51, cmd: "bun /g/senpi/dist/bundle/cli.js --extension /g/omo-ai/plugin --session /x" },
  ];
  table = [...baseTable(), ...foreign];
  const env = deps.envOf;
  const marked: LaneHandoverDeps = { ...deps, envOf: (pid) => ([50, 51, 52].includes(pid) ? "PI_SESSION_ID=old-sid" : env(pid)) };
  // an earlier note already took them for the lane's (review 318): they are not carried on either
  mkdirSync(join(state.dir, "handover", "lanes"), { recursive: true });
  writeFileSync(join(state.dir, "handover", "lanes", "demo-20261010-120000.json"), JSON.stringify({ detached: foreign.map((p) => ({ pid: p.pid, cmd: p.cmd })), chains: [] }));
  for (const p of foreign) live.add(p.pid);
  ready(deps, [15]);
  // When
  const r = await laneHandover(marked, "demo", "aoe_lead_x", { dryRun: true });
  // Then
  expect(r.code).toBe(0);
  const note = readFileSync(r.note ?? "", "utf8");
  expect(note).toContain("## Detached jobs (1)");
  for (const pid of [50, 51, 52]) expect(note).not.toContain(`- ${pid}: `);
});

test("a lane whose omo session lives under the real path of a symlinked cwd is still found: monitors, todos and log", async () => {
  // Given
  const deps = await setup();
  const REAL = "/real/demo";
  const realDeps: LaneHandoverDeps = { ...deps, realpath: (p) => (p === CWD ? REAL : p), sessionOf: async (pane, cwd) => (pane === OLD && cwd === REAL ? "old-sid" : pane === NEW ? "new-sid" : "") };
  const file = manifestPath(join(state.dir, "sessions"), REAL, "old-sid");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, sessionId: "old-sid", monitors: [monitor("scratch events", EVENTS, 14)] }));
  writeFileSync(join(sessionDirFor(join(state.dir, "sessions"), REAL), "2026-10-11T10-00-00-000Z_old-sid.jsonl"), "");
  ready(deps, [15]);
  // When
  const r = await laneHandover(realDeps, "demo", "aoe_lead_x", { dryRun: true });
  // Then
  const note = readFileSync(r.note ?? "", "utf8");
  expect(note).toContain("## Monitors (1)");
  expect(note).toContain(`Its full log is ${join(sessionDirFor(join(state.dir, "sessions"), REAL), "2026-10-11T10-00-00-000Z_old-sid.jsonl")}`);
  expect(printed.some((l) => l.startsWith("HANDOVER_SESSION_UNSEEN"))).toBe(false);
});

// what the owner must never read in a rollover message: a pane, an arrow, a config key, a placeholder, a link, a signal token
const MACHINE = /aoe_|->|handover\.|[{}]|https?:|STUCK|rung|>=/;

test("a rollover the lead decided tells the owner afterwards in the lane's thread and logs that message id; a failed message is ROLLOVER_OWNER_REPORT_MISSING", async () => {
  // Given
  const posted: [string | null, string][] = [];
  const base = await setup();
  const deps: LaneHandoverDeps = { ...base, reportOwner: async (thread, text) => { posted.push([thread, text]); return "msg-1"; } };
  ready(deps, [15]);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: "lead:STUCK rung 4 on loss after research" });
  // Then
  expect(r.code).toBe(0);
  expect(posted.map(([thread]) => thread)).toEqual(["12345678"]);
  expect(posted[0]?.[1]).toContain("Demo lane");
  expect(posted[0]?.[1]).not.toMatch(MACHINE);
  expect(posted[0]?.[1]).not.toContain(OLD);
  expect(posted[0]?.[1]).not.toContain(NEW);
  expect(readRollovers(state.dir)[0]).toMatchObject({ kind: "rollover", result: "done", decidedBy: "lead", reason: "STUCK rung 4 on loss after research", ownerReport: { message: "msg-1" } });
  expect(printed).toContain("ROLLOVER_OWNER_REPORTED demo message msg-1");
});

test("a moved lane records what the move bought: the old session's last context, the new one's first and once checked; the owner hears it, rollover-stats adds the new session an hour later", async () => {
  // Given: the old session ended at 450k; the new one starts at 120k and is at 140k when it is checked, 300k an hour later
  const posted: string[] = [];
  const base = await setup();
  const deps: LaneHandoverDeps = { ...base, reportOwner: async (_thread, text) => { posted.push(text); return "msg-1"; } };
  ready(deps, [15]);
  const dir = sessionDirFor(join(state.dir, "sessions"), CWD);
  const call = (timestamp: string, k: number) => `\n${JSON.stringify({ type: "message", timestamp, message: { role: "assistant", content: [], usage: { input: 2, output: 9, cacheRead: 17_561, cacheWrite: k * 1000 - 17_563 } } })}`;
  appendFileSync(join(dir, "2026-10-11T10-00-00-000Z_old-sid.jsonl"), call("2026-10-11T16:20:00Z", 300) + call("2026-10-11T16:30:00Z", 450));
  writeFileSync(join(dir, "2026-10-11T16-34-00-000Z_new-sid.jsonl"), call("2026-10-11T16:34:10Z", 120) + call("2026-10-11T16:34:50Z", 140) + call("2026-10-11T17:20:00Z", 300) + call("2026-10-11T17:50:00Z", 400));
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: "lead:STUCK rung 4 on loss after research" });
  // Then
  expect(r.code).toBe(0);
  const sizes = { oldK: 450, firstK: 120, checkedK: 140, newLog: join(dir, "2026-10-11T16-34-00-000Z_new-sid.jsonl") };
  expect(JSON.parse(readFileSync((r.note ?? "").replace(/\.md$/, ".result.json"), "utf8"))).toMatchObject({ result: "done", sizes });
  expect(readRollovers(state.dir).at(-1)).toMatchObject({ result: "done", sizes });
  expect(printed).toContain("HANDOVER_SIZE demo old 450k -> new first 120k, checked 140k (31% of the old)");
  expect(posted).toHaveLength(1);
  expect(posted[0]).toContain("450k");
  expect(posted[0]).toContain("140k");
  expect(posted[0]).not.toMatch(MACHINE);
  const stats = (now: string) => rolloverStats(readRollovers(state.dir), [], Date.parse(now)).find((l) => l.startsWith("ROLLOVER ")) ?? "";
  expect(stats("2026-10-11T17:00:00Z")).toEndWith("; context 450k -> new session first 120k, checked 140k (31% of the old)");
  expect(stats("2026-10-11T18:00:00Z")).toEndWith("; context 450k -> new session first 120k, checked 140k (31% of the old), 1 h later 300k");
});

test("without a way to reach the owner a lead's rollover is refused before anything opens; a message that fails after the move is logged as missing", async () => {
  // Given
  const base = await setup();
  ready(base, [15]);
  // When
  const refused = await laneHandover(base, "demo", "aoe_lead_x", { approvedBy: "lead:STUCK rung 4 on loss" });
  const failing: LaneHandoverDeps = { ...base, reportOwner: async () => { throw new Error("429 rate limited"); } };
  const moved = await laneHandover(failing, "demo", "aoe_lead_x", { approvedBy: "lead:STUCK rung 4 on loss" });
  // Then
  expect(refused.code).toBe(2);
  expect(printed[0]).toContain("needs a way to tell the owner afterwards");
  expect(moved.code).toBe(0);
  const missing = printed.find((l) => l.startsWith("ROLLOVER_OWNER_REPORT_MISSING demo: 429 rate limited; tell the owner yourself: ")) ?? "";
  expect(missing).toContain("Demo lane");
  expect(missing.slice(missing.indexOf("yourself: "))).not.toMatch(MACHINE);
  expect(readRollovers(state.dir).at(-1)).toMatchObject({ decidedBy: "lead", ownerReport: { error: "429 rate limited" } });
});

test("an automatic start comes back from what its run logged, never on a clock alone and never giving up: busy is asked and started again at once, work waits for its ready mark or its chains, a failed move backs off doubling", async () => {
  // Given
  const base = await setup();
  const T0 = Date.parse("2026-10-11T16:35:00Z");
  const clock = fakeClock(T0);
  const deps = { ...base, clock, config: { ...base.config, handover: { ...base.config.handover, laneContextPct: 80, autoRolloverLanes: true, autoRetryMin: 30 } } };
  const running = new Set<number>([15]);
  // what the detached run of each start leaves in the rollover log
  let outcome: { result: string; blocked?: "work" | "busy"; pids?: number[]; reasons: string[] } = { result: "refused", blocked: "busy", reasons: ["the lane stayed busy for 20 min: a turn is running (esc to interrupt on screen). Ask the lane to reach a safe point and ..."] };
  const starts: number[] = [];
  const hooks = {
    signals: async (pane: string) => (pane === OLD ? { contextPct: 85 } : {}),
    alive: (pid: number) => running.has(pid),
    auto: async (_who: "lead" | "lane", key: string) => {
      starts.push(Math.round((clock.at - T0) / 60_000));
      appendRollover(state.dir, { kind: "rollover", who: "lane", at: new Date(clock.at).toISOString(), key, from: OLD, approvedBy: "auto:handover.autoRolloverLanes", signals: {}, steps: [], ...outcome });
      return "started";
    },
  };
  const tick = async (min: number): Promise<string[]> => {
    clock.at = T0 + min * 60_000;
    await deps.registry.patch("demo", { lastReplyAt: clock.at });
    return (await freshnessTick(deps, "/home/test", hooks)).filter((a) => a.lane === "demo" && a.kind.startsWith("rollover")).map((a) => `${a.kind} ${a.detail}`);
  };
  const asked = () => sent(w).filter((t) => t.startsWith("[LEAD] An automatic rollover of demo")).length;
  // When / Then: the first start found the lane busy for its whole wait: it is asked for a safe point and started again at once
  expect(await tick(0)).toEqual([expect.stringMatching(/^rollover_due /), "rollover_auto started"]);
  outcome = { result: "refused", blocked: "work", pids: [15, 16], reasons: ["1 local chain(s) would die: 15 bash -c sleep 7200; echo chain-done. Ask the lane to reach a safe point and ..."] };
  expect(await tick(2)).toEqual(["rollover_auto asked aoe_demo_1a1a1a1a to reach a safe point and write its summary (the lane stayed busy for 20 min: a turn is running (esc to interrupt on screen))", "rollover_auto start 2 (context 85% >= 80%; last: refused busy): started"]);
  expect(sent(w).find((t) => t.startsWith("[LEAD] An automatic rollover of demo"))).toContain("run dori handover ready demo --note <file>, then end your turn");
  // a chain would die: no new start while it runs, the request is not repeated within autoRetryMin
  expect(await tick(4)).toEqual([]);
  expect(asked()).toBe(1);
  // the lane marks ready after the refusal: the move starts again at once
  ready(deps, [15], new Date(T0 + 5 * 60_000).toISOString());
  outcome = { result: "refused", blocked: "work", pids: [99], reasons: ["1 eval cell(s) still run in the background: toolu_x. Ask ..."] };
  expect(await tick(6)).toEqual(["rollover_auto start 3 (context 85% >= 80%; last: refused work): started"]);
  // its chain ends: the move starts again although autoRetryMin has not passed; a handover still running holds it
  running.add(77);
  mkdirSync(join(state.dir, "handover", "lanes"), { recursive: true });
  writeFileSync(join(state.dir, "handover", "lanes", "demo.lock"), JSON.stringify({ pid: 77, at: "x" }));
  expect(await tick(8)).toEqual([]);
  running.delete(77);
  outcome = { result: "rolled-back", reasons: ["verify"] };
  expect(await tick(9)).toEqual(["rollover_auto start 4 (context 85% >= 80%; last: refused work): started"]);
  // failed moves back off: 30 min, then 60, then 120, 240 and 240 again; no last try
  expect(await tick(38)).toEqual([]);
  expect(await tick(39)).toEqual(["rollover_auto start 5 (context 85% >= 80%; last: rolled-back): started"]);
  expect(await tick(98)).toEqual([]);
  expect(await tick(99)).toEqual(["rollover_auto start 6 (context 85% >= 80%; last: rolled-back): started"]);
  expect(await tick(219)).toEqual(["rollover_auto start 7 (context 85% >= 80%; last: rolled-back): started"]);
  expect(await tick(459)).toEqual(["rollover_auto start 8 (context 85% >= 80%; last: rolled-back): started"]);
  expect(await tick(698)).toEqual([]);
  expect(await tick(699)).toEqual(["rollover_auto start 9 (context 85% >= 80%; last: rolled-back): started"]);
  expect(starts).toEqual([0, 2, 6, 9, 39, 99, 219, 459, 699]);
  expect((await readLane(deps)).rolloverDue).toMatchObject({ pane: OLD, tries: 9, failures: 5 });
  // a move to a new pane starts over
  await deps.registry.patch("demo", { pane: "aoe_demo-2_77777777" });
  expect(await tick(700)).toEqual([]);
});

test("a lane given up by an older version (gaveUp after autoMaxTries) is started again; a run that left no record is started again after autoRetryMin", async () => {
  // Given: yoodori-gate-gaps on 10-19 02:04, "gave up in ... after 6 automatic starts"
  const base = await setup();
  const T0 = Date.parse("2026-10-11T16:35:00Z");
  const clock = fakeClock(T0);
  const deps = { ...base, clock, config: { ...base.config, handover: { ...base.config.handover, laneContextPct: 80, autoRolloverLanes: true, autoRetryMin: 30 } } };
  await deps.registry.patch("demo", { rolloverDue: { pane: OLD, at: "2026-10-11T10:00:00.000Z", crossed: ["context 85% >= 80%"], autoAt: "2026-10-11T15:00:00.000Z", tries: 6, gaveUp: true } });
  const hooks = { signals: async (pane: string) => (pane === OLD ? { contextPct: 85 } : {}), alive: () => false, auto: async () => "started" };
  const tick = async (min: number): Promise<string[]> => {
    clock.at = T0 + min * 60_000;
    await deps.registry.patch("demo", { lastReplyAt: clock.at });
    return (await freshnessTick(deps, "/home/test", hooks)).filter((a) => a.lane === "demo").map((a) => `${a.kind} ${a.detail}`);
  };
  // When / Then: the old record has no run logged since its last start: one more start now, then none until autoRetryMin
  expect(await tick(0)).toEqual(["rollover_auto start 7 (context 85% >= 80%): started"]);
  expect(await tick(29)).toEqual([]);
  expect(await tick(30)).toEqual(["rollover_auto start 8 (context 85% >= 80%): started"]);
});

test("a lead's handover refused while the lane was busy starts again once, with the same approval, when the lane marks ready; a mark alone or past readyMin starts nothing", async () => {
  // Given: tournament-public on 2026-11-03 marked ready at 05:57Z after its lead's refused handover and waited until a hand-run
  const base = await setup();
  const T0 = Date.parse("2026-10-11T16:35:00Z");
  const clock = fakeClock(T0);
  const deps = { ...base, clock, config: { ...base.config, handover: { ...base.config.handover, readyMin: 30 } } };
  const LEAD_OK = "lead:STUCK rung 4 on loss after research";
  const running = new Set<number>();
  const resumes: string[] = [];
  let launches = true;
  const hooks = {
    signals: async () => ({}),
    alive: (pid: number) => running.has(pid),
    resume: async (key: string, approvedBy: string) => {
      resumes.push(`${key} ${approvedBy}`);
      return launches ? { started: true, line: "unit=u1" } : { started: false, line: "could not start: no bus" };
    },
  };
  const tick = async (min: number): Promise<string[]> => {
    clock.at = T0 + min * 60_000;
    await deps.registry.patch("demo", { lastReplyAt: clock.at });
    return (await freshnessTick(deps, "/home/test", hooks)).filter((a) => a.kind === "ready_resume").map((a) => `${a.lane} ${a.detail.split(":")[0]}`);
  };
  const refused = (min: number, approvedBy: string, blocked?: "work" | "busy", from = OLD, legacy = false) =>
    appendRollover(state.dir, { kind: "rollover", who: "lane", at: new Date(T0 + min * 60_000).toISOString(), key: "demo", from, approvedBy, signals: {}, steps: [], result: "refused", reasons: ["a turn is running"], ...(blocked ? { blocked, ...(legacy ? {} : { request: {} }) } : {}) });
  const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
  // When / Then: a ready mark with no request before it starts nothing
  ready(deps, [], at(1));
  expect(await tick(2)).toEqual([]);
  // nor after an automatic run (rolloverDue brings those back), a refusal for want of approval, or a lead request from another pane
  refused(3, "auto:handover.autoRolloverLanes", "busy");
  ready(deps, [], at(4));
  expect(await tick(5)).toEqual([]);
  refused(6, "lead:no signal");
  ready(deps, [], at(7));
  expect(await tick(8)).toEqual([]);
  refused(9, LEAD_OK, "busy", "aoe_demo_00000000");
  ready(deps, [], at(10));
  expect(await tick(11)).toEqual([]);
  // a lead request refused for work, with the mark written before it: nothing (that run already saw the mark)
  refused(12, LEAD_OK, "work");
  expect(await tick(13)).toEqual([]);
  // the mark from another pane: nothing
  ready(deps, [], at(14), "aoe_demo_00000000");
  expect(await tick(15)).toEqual([]);
  // the lane marks ready after the refused request: one start with the same approval, logged
  ready(deps, [], at(16));
  expect(await tick(17)).toEqual(["demo started"]);
  expect(resumes).toEqual([`demo ${LEAD_OK}`]);
  expect(readFileSync(deps.config.watchLog, "utf8")).toContain(`HANDOVER_READY_RESUMED demo started: the ready mark of ${at(16)} in ${OLD} follows the request of ${at(12)} (refused work); started again with the same approval "${LEAD_OK}": unit=u1`);
  // the same mark never starts it twice, in this sweep's process or the next one's
  expect(await tick(18)).toEqual([]);
  // the started run waits for the idle moment holding the lock: never started beside it
  running.add(78);
  writeFileSync(join(state.dir, "handover", "lanes", "demo.lock"), JSON.stringify({ pid: 78, at: "x" }));
  expect(await tick(25)).toEqual([]);
  expect(resumes).toHaveLength(1);
  // the restarted run was refused again (work would die): a new mark starts it again, but not while a handover holds the lock
  refused(26, LEAD_OK, "work");
  running.add(77);
  writeFileSync(join(state.dir, "handover", "lanes", "demo.lock"), JSON.stringify({ pid: 77, at: "x" }));
  ready(deps, [], at(27));
  expect(await tick(28)).toEqual([]);
  running.delete(77);
  // a start that could not be launched gives the mark back: the next sweep tries again
  launches = false;
  expect(await tick(29)).toEqual(["demo failed"]);
  launches = true;
  expect(await tick(30)).toEqual(["demo started"]);
  expect(resumes).toHaveLength(3);
  // a mark older than readyMin by the time a sweep sees it: no start, the lead hears of it once
  refused(31, LEAD_OK, "work");
  ready(deps, [], at(32));
  expect(await tick(63)).toEqual(["demo skipped"]);
  expect(await tick(64)).toEqual([]);
  expect(resumes).toHaveLength(3);
  expect(sent(w).filter((t) => t.startsWith("[DORI] demo: the handover you asked for"))).toHaveLength(1);
  expect(readFileSync(deps.config.watchLog, "utf8")).toContain(`HANDOVER_READY_RESUME_SKIPPED demo skipped: the ready mark of ${at(32)} in ${OLD} follows the request of ${at(31)} (refused work), not started again: the ready mark is older than 30 min`);
  // a refusal logged by an older version (no request: its --keep-old or --note unknown) is never started again; the lead
  // hears of it once and runs it again
  refused(65, LEAD_OK, "busy", OLD, true);
  ready(deps, [], at(66));
  expect(await tick(67)).toEqual(["demo skipped"]);
  expect(await tick(68)).toEqual([]);
  expect(resumes).toHaveLength(3);
  expect(sent(w).filter((t) => t.includes("that request was logged before its options were kept"))).toHaveLength(1);
});

test("a chain that ended as a zombie (its parent, an eval kernel, has not collected it) counts as ended for the waiting handover", async () => {
  // Given: a parent that waits for its child's exit without collecting it (WNOWAIT), then prints the child's pid
  const p = Bun.spawn(["python3", "-I", "-c", "import os,sys,time\npid=os.fork()\nif pid==0: os._exit(0)\nos.waitid(os.P_PID, pid, os.WEXITED|os.WNOWAIT)\nprint(pid, flush=True)\ntime.sleep(30)"], { stdout: "pipe" });
  const first = await p.stdout.getReader().read();
  const zombie = Number(new TextDecoder().decode(first.value).trim());
  // When / Then
  expect(zombie).toBeGreaterThan(0);
  expect(pidAlive(zombie)).toBe(false);
  expect(pidAlive(p.pid)).toBe(true);
  p.kill();
  await p.exited;
});

test("the lead's waiting handover starts again by itself: a busy refusal at the next sweep (the run waits for the idle moment), a work refusal once its chains ended; one start per refusal; a long wait is told to the lead once and goes on", async () => {
  // Given: 17 refusals for a running turn and 39 for chains on six Doris, each started again by hand
  const base = await setup();
  const T0 = Date.parse("2026-10-11T16:35:00Z");
  const clock = fakeClock(T0);
  const deps = { ...base, clock, config: { ...base.config, handover: { ...base.config.handover, readyMin: 30 } } };
  const running = new Set<number>([501]);
  const resumes: string[] = [];
  const hooks = { signals: async () => ({}), alive: (pid: number) => running.has(pid), resume: async (key: string, approvedBy: string) => { resumes.push(`${key} ${approvedBy}`); return { started: true, line: "unit=u1" }; } };
  const tick = async (min: number): Promise<string[]> => {
    clock.at = T0 + min * 60_000;
    await deps.registry.patch("demo", { lastReplyAt: clock.at });
    return (await freshnessTick(deps, "/home/test", hooks)).filter((a) => a.kind === "ready_resume").map((a) => `${a.lane} ${a.detail.split(":")[0]}`);
  };
  const refused = (min: number, blocked: "work" | "busy", pids?: number[]) =>
    appendRollover(state.dir, { kind: "rollover", who: "lane", at: new Date(T0 + min * 60_000).toISOString(), key: "demo", from: OLD, approvedBy: LEAD_STUCK, signals: {}, steps: [], result: "refused", reasons: ["x"], blocked, ...(pids ? { pids } : {}), request: {} });
  // When / Then: refused while a turn ran: started at the next sweep, no ready mark needed, once
  refused(0, "busy");
  expect(await tick(1)).toEqual(["demo started"]);
  expect(await tick(2)).toEqual([]);
  // the waiting run came back busy after its wait: started again
  refused(21, "busy");
  expect(await tick(22)).toEqual(["demo started"]);
  // refused for a chain: nothing while it runs, a start once it ended
  refused(23, "work", [501]);
  expect(await tick(24)).toEqual([]);
  running.delete(501);
  expect(await tick(25)).toEqual(["demo started"]);
  expect(resumes).toEqual([`demo ${LEAD_STUCK}`, `demo ${LEAD_STUCK}`, `demo ${LEAD_STUCK}`]);
  // refused for work with no ready mark coming: the lead hears once that it still waits, past readyMin since the first ask
  refused(26, "work", [502]);
  running.add(502);
  expect(await tick(27)).toEqual([]);
  expect(await tick(57)).toEqual(["demo waiting"]);
  expect(await tick(58)).toEqual([]);
  expect(sent(w).filter((t) => t.startsWith("[DORI] demo: the handover you asked for") && t.includes("still waits"))).toHaveLength(1);
  running.delete(502);
  expect(await tick(59)).toEqual(["demo started"]);
  expect(resumes).toHaveLength(4);
  // a ready mark too old to use is told once, and the request still starts on a fresh mark or once its work ended (review 320)
  refused(60, "work", [503]);
  running.add(503);
  ready(deps, [], new Date(T0 + 61 * 60_000).toISOString());
  expect(await tick(95)).toEqual(["demo skipped"]);
  expect(await tick(96)).toEqual([]);
  ready(deps, [], new Date(T0 + 97 * 60_000).toISOString());
  expect(await tick(98)).toEqual(["demo started"]);
  refused(99, "work", [504]);
  running.add(504);
  ready(deps, [], new Date(T0 + 100 * 60_000).toISOString());
  expect(await tick(140)).toEqual(["demo skipped"]);
  running.delete(504);
  expect(await tick(141)).toEqual(["demo started"]);
  expect(resumes).toHaveLength(6);
});

test("the lead's refusal of a busy lane says that the lane's ready mark starts it again, and that start is given the options the refused run was given", async () => {
  // Given
  const base: LaneHandoverDeps = { ...(await setup()), reportOwner: async () => "msg-1" };
  const cwd = process.cwd();
  process.chdir(state.dir);
  writeFileSync(join(state.dir, "lead-note.md"), "keep the old one open\n");
  // a refusal with no options still logs them (empty), so it is told apart from one an older version logged
  await laneHandover(base, "demo", "aoe_lead_x", { approvedBy: "lead:STUCK rung 4 on loss after research" });
  expect(readRollovers(state.dir).at(-1)).toMatchObject({ result: "refused", blocked: "work", request: {} });
  printed.length = 0;
  // When: the lane's chain 15 would die
  const r = await laneHandover(base, "demo", "aoe_lead_x", { approvedBy: "lead:STUCK rung 4 on loss after research", note: "lead-note.md", model: "anthropic/claude-x", thinking: "high", keepOld: true, verifyMin: 9 }).finally(() => process.chdir(cwd));
  // Then
  expect(r.code).toBe(2);
  expect(printed.find((l) => l.startsWith("HANDOVER_REFUSED demo"))).toContain("once it marks ready within 30 min, freshness starts this handover again by itself with the same approval");
  const request = { note: join(state.dir, "lead-note.md"), model: "anthropic/claude-x", thinking: "high", keepOld: true, verifyMin: 9 };
  expect(readRollovers(state.dir).at(-1)).toMatchObject({ result: "refused", blocked: "work", request });
  // the lane marks ready: the start again carries every option
  const given: unknown[] = [];
  const at = new Date(base.clock.now() + 60_000).toISOString();
  ready(base, [15], at);
  const clock = fakeClock(base.clock.now() + 120_000);
  await freshnessTick({ ...base, clock }, "/home/test", { signals: async () => ({}), alive: () => false, resume: async (_key, approvedBy, req) => { given.push(approvedBy, req); return { started: true, line: "unit=u" }; } });
  expect(given).toEqual(["lead:STUCK rung 4 on loss after research", request]);
  expect(resumeArgs(request)).toEqual(["--note", join(state.dir, "lead-note.md"), "--model", "anthropic/claude-x", "--thinking", "high", "--keep-old", "--minutes", "9"]);
});

test("an automatic lane rollover tells the owner afterwards with what it crossed; a refused one is only in the log", async () => {
  // Given
  const posted: [string | null, string][] = [];
  const base = await setup();
  const deps: LaneHandoverDeps = { ...base, config: { ...base.config, handover: { ...base.config.handover, autoRolloverLanes: true } }, reportOwner: async (thread, text) => { posted.push([thread, text]); return "msg-2"; } };
  // When: first with the lane's local chain still running (no ready mark), then at a safe point
  const refused = await laneHandover(deps, "demo", "aoe_lead_x", autoRun(deps));
  const postedAfterRefusal = posted.length;
  ready(deps, [15]);
  const r = await laneHandover(deps, "demo", "aoe_lead_x", autoRun(deps));
  // Then
  expect(refused.code).toBe(2);
  expect(printed.some((l) => l.startsWith("HANDOVER_REFUSED") && l.includes("would die"))).toBe(true);
  expect(postedAfterRefusal).toBe(0);
  expect(r.code).toBe(0);
  expect(posted).toHaveLength(1);
  expect(posted[0]?.[0]).toBe("12345678");
  expect(posted[0]?.[1]).toContain("Demo lane");
  expect(posted[0]?.[1]).not.toMatch(MACHINE);
  expect(readRollovers(state.dir).at(-1)).toMatchObject({ result: "done", decidedBy: "auto", ownerReport: { message: "msg-2" } });
});

test("freshness starts with one line that says whether rollovers start by themselves, on what, and how they are retried", () => {
  const h = defaultConfig("/home/test").handover;
  expect(autoReadyLine(h)).toBe("ROLLOVER_AUTO_OFF lanes off, lead off; rollovers wait for the lead's decision");
  expect(autoReadyLine({ ...h, autoRolloverLanes: true, autoRolloverLead: true, laneContextPct: 80, laneCompactions: 4, laneAgeH: 24, leadContextPct: 80, leadCompactions: 4, leadAgeH: 48 })).toBe(
    "ROLLOVER_AUTO_READY lanes on (context >= 80%, compactions >= 4, age >= 24 h, stuck rung 4), lead on (context >= 80%, compactions >= 4, age >= 48 h); a lane moves at its idle moment (waits up to 20 min), a busy lane is asked for a safe point first, a failed move is retried after 30 min (doubling), with no last try; the owner is told after each move",
  );
  expect(autoReadyLine({ ...h, autoRolloverLead: true })).toBe("ROLLOVER_AUTO_READY lanes off, lead on (no threshold set); a lane moves at its idle moment (waits up to 20 min), a busy lane is asked for a safe point first, a failed move is retried after 30 min (doubling), with no last try; the owner is told after each move");
});

test("a rollover due while the auto key was off starts automatically in the same pane once the key is on, once", async () => {
  // Given
  const base = await setup();
  const deps = { ...base, config: { ...base.config, handover: { ...base.config.handover, laneContextPct: 80 } } };
  await deps.registry.patch("demo", { lastReplyAt: deps.clock.now() });
  const starts: string[] = [];
  const hooks = { signals: async (pane: string) => (pane === OLD ? { contextPct: 85 } : {}), auto: async (who: "lead" | "lane", key: string) => { starts.push(`${who}:${key}`); return "started"; } };
  const on = { ...deps, config: { ...deps.config, handover: { ...deps.config.handover, autoRolloverLanes: true } } };
  const rollovers = async (d: typeof deps) => (await freshnessTick(d, "/home/test", hooks)).filter((a) => a.kind.startsWith("rollover")).map((a) => `${a.kind} ${a.lane} ${a.detail}`);
  // When
  const off = await rollovers(deps);
  const first = await rollovers(on);
  const again = await rollovers(on);
  // Then
  expect(off.map((l) => l.split(" ")[0])).toEqual(["rollover_due"]);
  expect(first).toEqual(["rollover_auto demo context 85% >= 80%: started"]);
  expect(again).toEqual([]);
  expect(starts).toEqual(["lane:demo"]);
});

test("the context after the last compaction is the first assistant turn after it (input + cache read + cache write), read incrementally; a threshold on it makes a rollover due", () => {
  // Given
  const dir = join(state.dir, "after-compact");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "2026-10-11T10-00-00-000Z_abcdefab-0000-0000-0000-000000000001.jsonl");
  const turn = (input: number, cacheRead: number, cacheWrite: number) => JSON.stringify({ type: "message", message: { role: "assistant", usage: { input, output: 10, cacheRead, cacheWrite } } });
  const compaction = JSON.stringify({ type: "compaction", tokensBefore: 790000, details: { tokenEstimate: 640000 } });
  writeFileSync(file, [turn(2, 700000, 5000), compaction, JSON.stringify({ type: "message", message: { role: "user", usage: { input: 1 } } }), turn(2, 17421, 180890), turn(2, 198311, 3125)].join("\n") + "\n");
  // When
  const first = compactionScan(file);
  appendFileSync(file, [compaction, turn(2, 17421, 300000)].join("\n") + "\n");
  const second = compactionScan(file);
  appendFileSync(file, compaction + "\n");
  const pending = compactionScan(file);
  // Then
  expect(first).toEqual({ count: 1, afterK: 198 });
  expect(second).toEqual({ count: 2, afterK: 317 });
  expect(pending).toEqual({ count: 3 });
  expect(sessionSignals(dir, "abcdefab-0000-0000-0000-000000000001", Date.parse("2026-10-11T12:00:00Z"))).toEqual({ compactions: 3, ageH: 2 });
  expect(crossed({ afterCompactK: 317 }, { contextPct: 0, compactions: 0, ageH: 0, afterCompactK: 300 })).toEqual(["context after compaction 317k >= 300k"]);
  expect(crossed({ afterCompactK: 299 }, { contextPct: 0, compactions: 0, ageH: 0, afterCompactK: 300 })).toEqual([]);
  expect(crossed({ afterCompactK: 900 }, { contextPct: 0, compactions: 0, ageH: 0, afterCompactK: 0 })).toEqual([]);
});

test("the owner's rollover message names one cause from the approval or the signals, in his language, with no pane, key or link", () => {
  // Given: the reasons the five Doris logged on 2026-10-19 and 20, and the signals of an automatic move
  const lane = { contextPct: 80, compactions: 3, ageH: 24, afterCompactK: 300 };
  const cases: [string, Parameters<typeof rolloverCause>[1], string][] = [
    ["lead:문맥 초과로 멈춤, context 317%", {}, "full"],
    ["lead:owner https://discord.com/channels/1/2/3 asked for it", {}, "owner"],
    ["lead:STUCK rung 4 on loss after research", {}, "stuck"],
    ["lead:INTENT_CHECK rung4 VIOLATION", {}, "drift"],
    ["lead:rollover due: context after compaction 596k >= 300k", {}, "afterCompact"],
    ["auto:handover.autoRolloverLanes", { afterCompactK: 323 }, "afterCompact"],
    ["auto:handover.autoRolloverLanes", { contextPct: 85 }, "context"],
    ["auto:handover.autoRolloverLanes", { stuck: { metric: "loss", n: 3, rung: 4 } }, "stuck"],
    ["auto:handover.autoRolloverLead", { compactionStuck: 16, contextPct: 131 }, "compactionStuck"],
    ["lead:rollover due: COMPACTION_STUCK (the engine's \"compaction did not complete\" error 3x on its screen)", {}, "compactionStuck"],
    ["lead:a good point after the merge", {}, "lead"],
  ];
  // When / Then
  for (const [ref, signals, kind] of cases) {
    const cause = rolloverCause(ref, signals, lane);
    expect([ref, cause.kind]).toEqual([ref, kind]);
    for (const n of [{ who: "lane" as const, title: "ETH 넘기", cause, sizes: { oldK: 603, checkedK: 112 } }, { who: "lead" as const, cause, frozenH: 24 }, { who: "lead" as const, cause, frozenH: null }]) {
      const ko = ownerRolloverText(n, "ko-KR");
      expect(ko).toMatch(/[가-힣]/);
      expect(ko).not.toMatch(MACHINE);
      expect(ko.split(/(?<=[.?!])\s/).length).toBeLessThanOrEqual(2);
      expect(ownerRolloverText(n, "en-US")).not.toMatch(MACHINE);
    }
  }
  // the numbers a move bought are in the message as they were measured
  expect(ownerRolloverText({ who: "lane", title: "ETH 넘기", cause: { kind: "full" }, sizes: { oldK: 603, checkedK: 112 } }, "ko-KR")).toContain("603k에서 112k");
});

// OkDori's lead on 2026-10-20: the engine refused every message for hours ("compaction did not complete", 16 times on its
// screen, 262K/200K) and no threshold fired, because no turn after a compaction ever came (owner "옥도리다 대답이 없어").
const engineError = (n: number) => Array.from({ length: n }, () => " Runtime error (send_message): Context remains above the compaction threshold because compaction\n did not complete").join("\n");
const box = (above: string) => `${above}\n────────────────\n❯ \n────────────────\n /work • master • 262K/200K (130.9%) (auto)    claude-opus-5-5:high\n(OmO)`;

test("a session whose compaction did not complete is read from its screen: the engine's error at least twice, the last thing above the input box", () => {
  // Given / When / Then
  expect(compactionStuckOn(box(`older work\n${engineError(16)}`))).toBe(16);
  expect(compactionStuckOn(box(`older work\n${engineError(1)}`))).toBe(0);
  // it went on working after the errors (a compaction that completed later), or never met one: not stuck
  expect(compactionStuckOn(box(`${engineError(3)}\n hi\n Hi! What would you like to work on?`))).toBe(0);
  expect(compactionStuckOn(box("normal output"))).toBe(0);
  // the context figure alone (a one-message spike) is no reason; the error is, whatever the thresholds
  const limits = { contextPct: 0, compactions: 0, ageH: 0, afterCompactK: 300 };
  expect(crossed({ contextPct: 151 }, limits)).toEqual([]);
  expect(crossed({ compactionStuck: 16, contextPct: 131 }, limits)).toEqual([`COMPACTION_STUCK (the engine's "compaction did not complete" error 16x on its screen, context 131%)`]);
});

test("a lead stuck in a compaction that did not complete is due, and the pair channel hears of it once while nothing moves it (auto key off)", async () => {
  // Given
  const base = await setup();
  const posts: string[] = [];
  const deps = { ...base, postLeadAlert: async (text: string) => { posts.push(text); return [`LEAD_ALERT_POSTED pair c1 m${posts.length}`]; } };
  const hooks = { signals: async (pane: string) => (pane === "lead:p1" ? { compactionStuck: 16, contextPct: 131 } : {}), auto: async () => "started" };
  const tick = async () => (await freshnessTick(deps, "/home/test", hooks)).filter((a) => a.lane === "lead").map((a) => `${a.kind} ${a.detail}`);
  // When
  const first = await tick();
  const again = await tick();
  // Then
  expect(first.map((l) => l.split(" ")[0])).toEqual(["rollover_due", "lead_compaction_stuck"]);
  expect(first[0]).toContain("COMPACTION_STUCK (the engine's \"compaction did not complete\" error 16x");
  expect(first[1]).toContain("handover.autoRolloverLead");
  expect(posts).toHaveLength(1);
  expect(posts[0]).toStartWith("LEAD_COMPACTION_STUCK lead:p1 16: The lead lead:p1 answers every message with");
  expect(again).toEqual([]);
});

test("with the auto key on a stuck lead's handover starts by itself; the pair channel hears of it only once that run is refused", async () => {
  // Given
  const base = await setup();
  const posts: string[] = [];
  const starts: string[] = [];
  const deps = { ...base, config: { ...base.config, handover: { ...base.config.handover, autoRolloverLead: true } }, postLeadAlert: async (text: string) => { posts.push(text); return ["LEAD_ALERT_POSTED pair c1 m1"]; } };
  const hooks = { signals: async (pane: string) => (pane === "lead:p1" ? { compactionStuck: 3 } : {}), auto: async (who: "lead" | "lane", key: string) => { starts.push(`${who}:${key}`); return "started"; } };
  const tick = async () => (await freshnessTick(deps, "/home/test", hooks)).filter((a) => a.lane === "lead").map((a) => `${a.kind} ${a.detail}`);
  // When
  const first = await tick();
  appendRollover(deps.config.stateDir, { kind: "rollover", who: "lead", at: new Date(deps.clock.now()).toISOString(), key: "lead", from: "lead:p1", approvedBy: "auto:handover.autoRolloverLead", signals: { compactionStuck: 3 }, steps: [], result: "refused", reasons: ["configured watchers not running for lead:p1: host guard"] });
  const refused = await tick();
  // Then
  expect(first.map((l) => l.split(" ")[0])).toEqual(["rollover_due", "rollover_auto"]);
  expect(first[0]).toStartWith(`rollover_due COMPACTION_STUCK (the engine's "compaction did not complete" error 3x on its screen) in lead:p1`);
  expect(starts).toEqual(["lead:lead"]);
  expect(refused.map((l) => l.split(" ")[0])).toEqual(["lead_compaction_stuck"]);
  expect(refused[0]).toContain("the automatic handover ended refused: configured watchers not running for lead:p1: host guard");
  expect(posts).toHaveLength(1);
});

test("E7 on 2026-10-20: a lane whose monitor starts its chain is moved with a watch-only re-arm and no second chain start; the same command armed again or none is a rollback", async () => {
  // Given: the old session watches its chain with a command that starts it unless pgrep finds it (GongDori's e7-beyond-eth)
  const CHAIN = `dori heavy e7-bs-chain -- ssh node 'cd w && if pgrep -f "^bash qa/chain.sh" >/dev/null; then echo CHAIN_ALREADY_RUNNING; else nohup setsid bash qa/chain.sh 400 > logs/chain.out 2>&1 & echo "CHAIN_PID=$!"; fi; sleep 3; tail -n +1 -F logs/chain.out | grep --line-buffered CHAIN_'`;
  const starts = () => sim.arm.filter((m) => m.command.includes("nohup setsid bash qa/chain.sh")).length;
  const oldMonitors = () => writeManifest("old-sid", [monitor("scratch events", EVENTS, 14), monitor("BS chain", CHAIN, 18, { filter: "CHAIN_" })]);
  const deps = await setup();
  oldMonitors();
  live.add(18);
  ready(deps, [15]);
  sim.fromNote = true;
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { ...OK, verifyMin: 1 });
  // Then
  const note = readFileSync(r.note ?? "", "utf8");
  expect(note).toContain("- BS chain: command ");
  expect(note).toContain("LAUNCHES_WORK (nohup): do not arm this command again");
  expect(note).toContain("only reads what the work writes (logs/chain.out)");
  expect(note).not.toContain(`- scratch events: command ${JSON.stringify(EVENTS)} filter "^EV" LAUNCHES_WORK`);
  expect(r.code).toBe(0);
  expect(starts()).toBe(0);
  expect(sim.arm.map((m) => m.command)).toEqual([EVENTS, "tail -n 0 -F logs/chain.out"]);
  expect(printed).toContain(`HANDOVER_MONITORS_OK 2 in ${NEW} (session new-sid)`);

  for (const [arm, reason] of [
    [[{ description: "scratch events", command: EVENTS, pid: 201 }, { description: "BS chain", command: CHAIN, filter: "CHAIN_", pid: 202 }], "BS chain (armed again with the command that starts work; arm a watch-only one instead)"],
    [[{ description: "scratch events", command: EVENTS, pid: 201 }], "BS chain (starts work: arm a watch-only one with the same description)"],
  ] as const) {
    // Given
    printed = [];
    w = newWorld();
    live.add(14).add(18);
    const again = await setup();
    oldMonitors();
    ready(again, [15]);
    sim = { ...sim, fromNote: false, arm: [...arm], handled: [] };
    // When
    const back = await laneHandover(again, "demo", "aoe_lead_x", { ...OK, verifyMin: 1 });
    // Then
    expect(back.code).toBe(3);
    expect(printed.find((l) => l.startsWith("HANDOVER_VERIFY_FAIL"))).toContain(reason);
    expect((await readLane(again)).pane).toBe(OLD);
  }
});

test("e7-leap on 2026-10-24: work a monitor of the old session started keeps running; the old session is frozen, not closed, and closes once that work ended", async () => {
  // Given: GongDori's monitor put its chain in the background and followed its log; the chain runs under the monitor's shell
  const LOG = "/tmp/x/e7-leap-cut-chain.log";
  const CUT = `cd w; dori heavy e7-leap-cut-chain -- ssh n "bash cut_chain_mn.sh 400" > ${LOG} 2>&1 & pid=$!; echo "PID cut-chain $pid"; tail --pid=$pid -n +1 -f ${LOG}; echo "EXIT cut-chain"`;
  table.push({ pid: 30, ppid: 11, cmd: `/bin/bash -c ${CUT}` }, { pid: 31, ppid: 30, cmd: "bun /h/dori/src/cli.ts heavy e7-leap-cut-chain -- ssh n bash cut_chain_mn.sh 400" }, { pid: 32, ppid: 31, cmd: "ssh n bash cut_chain_mn.sh 400" }, { pid: 33, ppid: 30, cmd: `tail --pid=31 -n +1 -f ${LOG}` });
  for (const pid of [30, 31, 32, 33]) live.add(pid);
  const base = await setup();
  writeManifest("old-sid", [monitor("scratch events", EVENTS, 14), monitor("cut chain s21 -> s31", CUT, 30, { filter: "PID|CUT_CHAIN|EXIT" })]);
  ready(base, [15]);
  sim.fromNote = true;
  // closing the old session ends everything in its process tree, the monitor's work with it
  const deps: LaneHandoverDeps = { ...base, run: async (argv, opts) => {
    if (argv[0] === "aoe" && argv[1] === "session" && argv[2] === "stop" && argv[3] === OLD_ID) for (const pid of [30, 31, 32, 33]) live.delete(pid);
    return base.run(argv, opts);
  }, signal: (pid, sig) => {
    if (pid === -14 && sig === "SIGTERM") {
      live.delete(14);
      table = table.filter((p) => p.pid !== 14);
    }
    return base.signal(pid, sig);
  } };
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { ...OK, verifyMin: 1 });
  // Then: moved, the old session not stopped, the chain alive and never signalled, the old agent left frozen
  expect(r).toMatchObject({ code: 0, to: NEW });
  expect(stoppedIds()).toEqual([]);
  expect(live.has(31) && live.has(32)).toBe(true);
  expect(sigs.filter((s) => / 3[0-3]$/.test(s))).toEqual([]);
  expect(sigs).toContain("SIGTERM -14");
  expect(sigs.indexOf("SIGTERM -14")).toBeLessThan(sigs.indexOf("SIGSTOP 12"));
  expect(sigs.filter((signal) => signal === "SIGSTOP 11")).toHaveLength(1);
  expect(readFrozen(state.dir)[0]?.pids).not.toContain(14);
  expect(sigs.filter((s) => s.endsWith(" 11")).at(-1)).toBe("SIGSTOP 11");
  const note = readFileSync(r.note ?? "", "utf8");
  expect(note).toContain("## Work the old session's monitors started (1)");
  expect(note).toContain('- monitor 30 "cut chain s21 -> s31": 31, 32');
  expect(printed.find((l) => l.startsWith("HANDOVER_MONITOR_WORK demo 1: monitor 30"))).toContain("runs 31,32");
  expect(printed.find((l) => l.startsWith(`HANDOVER_WORK_KEPT demo ${OLD}: the work its monitors started still runs (cut chain s21 -> s31: 31,32); the old session stays frozen (agent 11`))).toBeDefined();
  expect(printed).toContain(`HANDOVER_DONE demo ${OLD} -> ${NEW}; old session kept until the work its monitors started ends`);
  expect(sent(w).some((x) => x.startsWith(`[LEAD] HANDOVER_COMMITTED: the handover is checked; the old session ${OLD} stays open because work its monitors started still runs there`))).toBe(true);
  expect(sent(w).some((x) => x.startsWith("[LEAD] HANDOVER_CHAINS_ENDED"))).toBe(false);
  expect(readFrozen(state.dir)).toMatchObject([{ pane: OLD, agentPid: 11, keepFor: [31, 32], to: NEW }]);

  // When: a freshness tick while the chain still runs, then one after it ended (its zombie left behind)
  expect(await closeDueFrozen(deps, state.dir, deps.clock.now() + 48 * 3_600_000)).toEqual([]);
  expect(stoppedIds()).toEqual([]);
  table = table.filter((p) => p.pid !== 32).map((p) => (p.pid === 31 ? { ...p, stat: "Z" } : p));
  const closed = await closeDueFrozen(deps, state.dir, deps.clock.now());
  // Then
  expect(closed).toHaveLength(1);
  expect(closed[0]).toContain("HANDOVER_OLD_CLOSED");
  expect(closed[0]).toContain("(the work its monitors started ended: 31,32)");
  expect(stoppedIds()).toEqual([OLD_ID]);
  expect(readFrozen(state.dir)).toEqual([]);
});

// the task tool's result for a background task, as the old session logged it
const taskStarted = (id: string, at: string, what: string) =>
  appendFileSync(join(sessionDirFor(join(state.dir, "sessions"), CWD), "2026-10-11T10-00-00-000Z_old-sid.jsonl"), `\n${JSON.stringify({ type: "message", timestamp: at, message: { role: "toolResult", toolName: "task", toolCallId: `toolu_${id}`, content: [{ type: "text", text: `Started task ${what} (${id}, running), the task host is still admitting it.` }], details: { run_in_background: true, task_id: id, status: "running" } } })}`);
// a user line of the old conversation with its time
const oldSaysAt = (at: string, text: string) => appendFileSync(join(sessionDirFor(join(state.dir, "sessions"), CWD), "2026-10-11T10-00-00-000Z_old-sid.jsonl"), `\n${JSON.stringify({ type: "message", timestamp: at, message: { role: "user", content: [{ type: "text", text }] } })}`);

// senpi's record of a task of the old session, as it keeps it under <home>/.omo/agent/projects/<project>/senpi-task/tasks
const taskRecordAt = (home: string, id: string, status: string, extra: Record<string, unknown> = {}) => {
  const dir = join(home, ".omo", "agent", "projects", "work-1", "senpi-task", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ task_id: id, status, parent_session_id: "old-sid", root_session_id: "old-sid", ...extra }));
  return join(dir, `${id}.json`);
};
// the wake line senpi puts in the old conversation when a task's run completes
const taskWoke = (id: string, at: string) =>
  appendFileSync(join(sessionDirFor(join(state.dir, "sessions"), CWD), "2026-10-11T10-00-00-000Z_old-sid.jsonl"), `\n${JSON.stringify({ type: "custom_message", customType: "omo-senpi:wake", timestamp: at, content: `task completion (resumed turn) name:step3 id:${id} status:completed` })}`);

test("a background task of the old session that still runs refuses the move, whether it started before or after the ready mark, and also when it woke itself after its completion line; one that ended does not; a forced move lists the running ones in the note with their records", async () => {
  // Given: GongDori e7-ledger-replay 2026-10-27: its ready mark (05:36:47Z) covered st_01a17bcf and st_01a17bd9, started
  // before it, so the 05:37:57Z start moved the lane, and st_01a17b36, whose last line in the log was a completion but
  // whose record said running, was not even listed; all three went on editing the repository until 06:51Z
  const deps = { ...(await setup()), home: state.dir };
  table = aoeTable().filter((p) => p.pid !== 15 && p.pid !== 16);
  const records = join(state.dir, ".omo", "agent", "projects", "work-1", "senpi-task");
  taskRecordAt(state.dir, "st_01aaa", "running");
  taskRecordAt(state.dir, "st_01ccc", "running", { started_at: "2026-10-11T14:00:00Z", task_summary: "step3: collect the Spark results" });
  taskRecordAt(state.dir, "st_01ddd", "completed");
  taskRecordAt(state.dir, "st_01eee", "cancelled", { parent_session_id: "other-sid", root_session_id: "other-sid" });
  ready(deps, [], "2026-10-11T16:30:00Z");
  taskStarted("st_01ccc", "2026-10-11T14:00:00Z", "step3: collect the Spark results");
  taskWoke("st_01ccc", "2026-10-11T15:00:00Z");
  taskStarted("st_01aaa", "2026-10-11T16:20:00Z", "deep-high: is the m200 STOP a sync bias");
  taskStarted("st_01ddd", "2026-10-11T16:21:00Z", "quick: count the boards");
  taskStarted("st_01bbb", "2026-10-11T16:31:00Z", "deep-low: survey the cut chain logs");
  // When
  const after = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true });
  const forced = await laneHandover(deps, "demo", "aoe_lead_x", { dryRun: true, force: true });
  // Then
  expect([after.code, forced.code]).toEqual([2, 0]);
  const refused = printed.filter((l) => l.startsWith("HANDOVER_REFUSED"));
  expect(refused).toHaveLength(1);
  expect(/still run, and their answers go to the old session: ([^.]*)\. /.exec(refused[0] ?? "")?.[1]?.split(", ").sort()).toEqual(["st_01aaa", "st_01bbb", "st_01ccc"]);
  const note = readFileSync(forced.note ?? "", "utf8");
  expect(note).toContain("## Background tasks of the old session (3)");
  expect(note).not.toContain("st_01ddd");
  expect(note).not.toContain("st_01eee");
  expect(note).toContain(`- st_01ccc (started 2026-10-11T14:00Z): step3: collect the Spark results; record ${join(records, "tasks", "st_01ccc.json")}`);
  expect(note).toContain(`- st_01aaa (started 2026-10-11T16:20Z): deep-high: is the m200 STOP a sync bias; record ${join(records, "tasks", "st_01aaa.json")}, transcript ${join(records, "children", "st_01aaa", "sessions", "st_01aaa")}`);
  expect(note).toContain("- st_01bbb (started 2026-10-11T16:31Z): deep-low: survey the cut chain logs; no record found under ~/.omo/agent/projects");
});

test("an automatic start held by the old session's running tasks never moves the lane: the start after its ready mark and the one after autoRetryMin refuse again, the lead hears of it once, and the move goes through at the first sweep after the tasks ended", async () => {
  // Given: GongDori e7-ledger-replay 2026-10-27: refused at 05:33Z for its tasks, asked for a safe point, marked ready at
  // 05:36:47Z, and moved by the start of 05:37:57Z while the tasks ran
  const base = await setup();
  // the last sweep (minute 37) comes at 16:35, the stamp the fake world names the new session by
  const T0 = Date.parse("2026-10-11T15:58:00Z");
  const clock = fakeClock(T0);
  const deps: LaneHandoverDeps = { ...base, clock, home: state.dir, config: { ...base.config, handover: { ...base.config.handover, laneContextPct: 80, autoRolloverLanes: true, autoRetryMin: 30 } }, reportOwner: async () => "msg-1" };
  table = aoeTable().filter((p) => p.pid !== 15 && p.pid !== 16);
  taskRecordAt(state.dir, "st_01bcf", "running");
  taskRecordAt(state.dir, "st_01bd9", "running");
  taskStarted("st_01bcf", "2026-10-11T15:45:00Z", "E7 pilot prep");
  taskStarted("st_01bd9", "2026-10-11T15:56:00Z", "E7 pilot correctness fix");
  // each automatic start runs the real lane handover
  const hooks = {
    signals: async (pane: string) => (pane === OLD ? { contextPct: 85 } : {}),
    alive: (pid: number) => live.has(pid),
    auto: async (_who: "lead" | "lane", key: string) => `code ${(await laneHandover(deps, key, "aoe_lead_x", autoRun(deps, {}, key))).code}`,
  };
  const tick = async (min: number): Promise<string[]> => {
    clock.at = T0 + min * 60_000;
    await deps.registry.patch("demo", { lastReplyAt: clock.at });
    return (await freshnessTick(deps, state.dir, hooks)).filter((a) => a.lane === "demo" && a.kind.startsWith("rollover")).map((a) => `${a.kind} ${a.detail}`);
  };
  const results = () => readRollovers(state.dir).filter((e) => e.kind === "rollover" && e.key === "demo").map((e) => (e.kind === "rollover" ? `${e.result}${e.blocked ? ` ${e.blocked}` : ""}` : ""));
  const toLead = () => sent(w).filter((t) => t.startsWith("[DORI] demo: the automatic rollover is held"));
  // When / Then: the first start is refused for the two tasks, and the lane is asked for a safe point
  expect(await tick(0)).toEqual([expect.stringMatching(/^rollover_due /), "rollover_auto code 2"]);
  expect(readRollovers(state.dir).at(-1)).toMatchObject({ result: "refused", blocked: "work", tasks: ["st_01bcf", "st_01bd9"] });
  expect(await tick(1)).toEqual([expect.stringMatching(/^rollover_auto asked aoe_demo_1a1a1a1a to reach a safe point .*background task\(s\) still run/)]);
  expect(sent(w).find((t) => t.startsWith("[LEAD] An automatic rollover of demo"))).toContain("The ready mark does not cover your background tasks: the move waits until they end");
  // the lane marks ready: the start that follows is refused again, and the lead is told once
  ready(deps, [], new Date(T0 + 2 * 60_000).toISOString());
  expect(await tick(3)).toEqual(["rollover_auto start 2 (context 85% >= 80%; last: refused work): code 2"]);
  expect(await tick(4)).toEqual(["rollover_auto held by the old session's background tasks st_01bcf, st_01bd9; lead told"]);
  expect(toLead()).toHaveLength(1);
  expect(toLead()[0]).toContain("It moves by itself once they end.");
  // autoRetryMin later it is started again and refused again; the lead is not told a second time
  expect(await tick(10)).toEqual([]);
  expect(await tick(34)).toEqual([expect.stringMatching(/^rollover_auto asked /), "rollover_auto start 3 (context 85% >= 80%; last: refused work): code 2"]);
  expect(await tick(35)).toEqual([]);
  expect(toLead()).toHaveLength(1);
  expect(results()).toEqual(["refused work", "refused work", "refused work"]);
  expect(opened()).toBe(false);
  // one task ends: still held; the other ends: the next sweep starts the move at once and it goes through
  taskRecordAt(state.dir, "st_01bcf", "completed");
  expect(await tick(36)).toEqual([]);
  taskRecordAt(state.dir, "st_01bd9", "cancelled");
  expect(await tick(37)).toEqual(["rollover_auto start 4 (context 85% >= 80%; last: refused work): code 0"]);
  expect(results()).toEqual(["refused work", "refused work", "refused work", "done"]);
  expect(toLead()).toHaveLength(1);
});

test("the lead's instructions reach the new session as typed: those of the old conversation in the note, those that reached the old session during the move at its end", async () => {
  // Given: GongDori e7-leap 2026-10-24, the lead typed the card Q39 instruction into the frozen old pane at 04:03:28Z; the old
  // agent logged it at 04:05:09Z when thawed to be closed, and the note written at 04:03:12Z never had it
  const base = await setup();
  const before = "[LEAD] 형(1563321331590631587): 'Gpu학습까지 해서 검증해'. 계획을 문서로만 내지 말고\n학습으로 검증까지 해.";
  oldSaysAt("2026-10-11T12:00:00Z", before);
  oldSaysAt("2026-10-11T12:10:00Z", "[LEAD] your work thread has had no update for 16 min. Post a 1-2 sentence progress line (done since last, next) and keep its status true.");
  const logged = "[LEAD] m200 STOP을 형에게 카드 Q39로 물었어: 답 전엔 학습은 그대로 둬.";
  const typedOnly = "[LEAD] m300 판정은 규칙 그대로야.";
  const deps: LaneHandoverDeps = {
    ...base,
    signal: (pid, sig) => {
      sigs.push(`${sig} ${pid}`);
      // the lead types into the old pane while it is frozen (dori type keeps the text: the pane has a quiet mark), and the
      // old agent logs the first line once it is thawed to be closed
      if (sig === "SIGSTOP") for (const t of [logged, typedOnly]) holdTyped(state.dir, OLD, base.clock.now(), t);
      if (sig === "SIGCONT") oldSaysAt(new Date(base.clock.now() + 1000).toISOString(), logged);
      return true;
    },
  };
  ready(deps, [15]);
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then
  expect(r.code).toBe(0);
  const note = readFileSync(r.note ?? "", "utf8");
  expect(note).toContain("## The lead's instructions in the old conversation since the last handover (1)\n");
  expect(note).toContain("  > [LEAD] 형(1563321331590631587): 'Gpu학습까지 해서 검증해'. 계획을 문서로만 내지 말고\n  > 학습으로 검증까지 해.");
  expect(note).not.toContain("your work thread has had no update");
  const late = note.split("## The lead's instructions that reached the old session after this note was written (2)\n")[1] ?? "";
  expect(late).toContain(`  > ${logged}`);
  expect(late).toContain(`(typed into the old pane while the handover ran):\n  > ${typedOnly}`);
  expect(sent(w).filter((l) => l.startsWith("[LEAD] HANDOVER_LEAD_LATE 2:"))).toHaveLength(1);
  expect(printed.find((l) => l.startsWith("HANDOVER_LEAD_LATE demo 2: old log line"))).toBeDefined();
  expect(existsSync(join(state.dir, "handover", "quiet", `${OLD}.typed.jsonl`))).toBe(false);
});


test("once the move commits, the old session's tasks in the shared task host are ended through the new session with task_cancel and listed in the note; a task of another session on the same host and one hosted by the closed old agent are left alone", async () => {
  // Given: GongDori's e7-ledger-replay of 2026-10-27: its tasks ran in the account's shared task host (execution mode
  // "process"), which neither the freeze nor the close of the old session reaches; another lane's task runs on that host too
  const deps = { ...(await setup()), home: state.dir };
  table = [...aoeTable().filter((p) => p.pid !== 15 && p.pid !== 16), { pid: 50, ppid: 1, cmd: "bun /r/dist/bundle/cli.js --mode rpc --multi-session" }];
  live.add(50);
  const mine = taskRecordAt(state.dir, "st_01bd9", "running", { host_pid: 50, execution_mode: "process", task_summary: "E7 pilot correctness fix" });
  taskRecordAt(state.dir, "st_01b36", "running", { host_pid: 11, execution_mode: "in-process" });
  const other = taskRecordAt(state.dir, "st_01fff", "running", { host_pid: 50, execution_mode: "process", parent_session_id: "other-sid", root_session_id: "other-sid", task_summary: "another lane reads old-sid's log" });
  sim.cancel = "cancel";
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { ...OK, force: true });
  // Then
  expect(r.code).toBe(0);
  const lines = sent(w);
  const ask = lines.findIndex((l) => l.startsWith("[LEAD] HANDOVER_TASKS_CANCEL"));
  expect(lines[ask]).toContain("1 background task(s) of the old session still run after the move: st_01bd9 (E7 pilot correctness fix).");
  expect(lines[ask]).toContain("(task_id st_01bd9)");
  expect(lines.findIndex((l) => l.startsWith("[LEAD] HANDOVER_COMMITTED"))).toBeLessThan(ask);
  expect(printed).toContain(`HANDOVER_TASKS_CANCELLED demo st_01bd9 "E7 pilot correctness fix" -> ${r.note}`);
  expect(printed.find((l) => l.startsWith("HANDOVER_TASK_ALIVE"))).toBeUndefined();
  expect(JSON.parse(readFileSync(mine, "utf8"))).toMatchObject({ status: "cancelled" });
  expect(JSON.parse(readFileSync(other, "utf8"))).toMatchObject({ status: "running" });
  expect(readFileSync(r.note ?? "", "utf8")).toContain(`## Background tasks of the old session ended at the handover (1)\nAdded after the commit. Each one's record and transcript stay readable; run one again as your own task if its work is still needed.\n- st_01bd9: E7 pilot correctness fix; cancelled; record ${mine}\n`);
});

test("an old-session task the new session does not end stays a HANDOVER_TASK_ALIVE line and is marked still running in the note", async () => {
  // Given
  const deps = { ...(await setup()), home: state.dir };
  table = [...aoeTable().filter((p) => p.pid !== 15 && p.pid !== 16), { pid: 50, ppid: 1, cmd: "bun /r/dist/bundle/cli.js --mode rpc --multi-session" }];
  live.add(50);
  const mine = taskRecordAt(state.dir, "st_01bd9", "running", { host_pid: 50, execution_mode: "process", task_summary: "E7 pilot correctness fix" });
  sim.cancel = "ack-only";
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { ...OK, force: true });
  // Then
  expect(r.code).toBe(0);
  expect(printed).toContain("HANDOVER_TASK_ALIVE demo st_01bd9: still open after the new session's task_cancel; they can still change files: end each with task_cancel <id> from any session of this account");
  expect(readFileSync(r.note ?? "", "utf8")).toContain(`- st_01bd9: E7 pilot correctness fix; running (still running); record ${mine}`);
});

test("an old-session task that finishes by itself before the new session ends it is not called cancelled", async () => {
  // Given: the task's record says completed by the time the new session acks
  const deps = { ...(await setup()), home: state.dir };
  table = [...aoeTable().filter((p) => p.pid !== 15 && p.pid !== 16), { pid: 50, ppid: 1, cmd: "bun /r/dist/bundle/cli.js --mode rpc --multi-session" }];
  live.add(50);
  const mine = taskRecordAt(state.dir, "st_01bd9", "running", { host_pid: 50, execution_mode: "process", task_summary: "E7 pilot correctness fix" });
  sim.cancel = "ack-only";
  const sendKeys = deps.run;
  const finishing: LaneHandoverDeps = { ...deps, run: async (argv, opts) => {
    if (sent(w).some((l) => l.startsWith("[LEAD] HANDOVER_TASKS_CANCEL"))) writeFileSync(mine, JSON.stringify({ ...(JSON.parse(readFileSync(mine, "utf8")) as object), status: "completed" }));
    return sendKeys(argv, opts);
  } };
  // When
  const r = await laneHandover(finishing, "demo", "aoe_lead_x", { ...OK, force: true });
  // Then
  expect(r.code).toBe(0);
  expect(printed.find((l) => l.startsWith("HANDOVER_TASKS_CANCELLED"))).toBeUndefined();
  expect(printed).toContain(`HANDOVER_TASKS_ENDED demo st_01bd9 completed: ended by themselves before the cancel -> ${r.note}`);
});

test("review 320 round 3: after the holder is gone the run starts over (an interrupted move is repaired first), and a lane another run moved meanwhile is not moved again", async () => {
  // Given
  const base = await setup();
  const lanes = join(state.dir, "handover", "lanes");
  let crash = true;
  const deps: LaneHandoverDeps = { ...base, reportOwner: async () => "msg-1", clock: { ...base.clock, sleep: async () => {
    if (crash && live.has(77)) writeFileSync(pendingFile(state.dir, "demo"), JSON.stringify({ key: "demo", pid: 77, at: "2026-10-11T16:34:00Z", from: OLD, to: NEW, note: "n" }));
    live.delete(77);
    simulate();
  } } };
  mkdirSync(lanes, { recursive: true });
  const lock = () => { writeFileSync(join(lanes, "demo.lock"), JSON.stringify({ pid: 77, at: "2026-10-11T16:30:00Z" })); live.add(77); };
  // When: the holder opened a new session and died while this run waited
  lock();
  const repaired = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: LEAD_STUCK, force: true });
  // another run that waited beside this one moved the lane while this one waited (plan challenge 2026-11-03 14:24Z)
  crash = false;
  rmSync(pendingFile(state.dir, "demo"), { force: true });
  const moves = () => w.calls.filter((c) => c[0] === "aoe" && c[1] === "add").length;
  const before = moves();
  lock();
  const moving: LaneHandoverDeps = { ...deps, clock: { ...base.clock, sleep: async () => { if (live.has(77)) { await base.registry.patch("demo", { pane: "aoe_demo_moved_1" }); live.delete(77); } simulate(); } } };
  const other = await laneHandover(moving, "demo", "aoe_lead_x", { approvedBy: LEAD_STUCK, force: true });
  // Then
  expect(repaired.code).toBe(3);
  expect(printed.some((l) => l.startsWith("HANDOVER_INTERRUPTED demo: "))).toBe(true);
  expect(other.code).toBe(0);
  expect(printed.at(-1)).toBe("HANDOVER_ALREADY_MOVED demo: the lane moved from aoe_demo_1a1a1a1a to aoe_demo_moved_1 while this run waited; it is not moved again");
  expect(moves()).toBe(before);
});

test("review 320 round 3: a request that keeps coming back busy past readyMin is told to the lead once and goes on", async () => {
  // Given
  const base = await setup();
  const T0 = Date.parse("2026-10-11T16:35:00Z");
  const clock = fakeClock(T0);
  const deps = { ...base, clock, config: { ...base.config, handover: { ...base.config.handover, readyMin: 30 } } };
  const resumes: string[] = [];
  const hooks = { signals: async () => ({}), alive: () => false, resume: async (key: string) => { resumes.push(key); return { started: true, line: "unit=u" }; } };
  // each row after the first is the refusal of the run started again for the one before it (it names that request)
  let last = "";
  const busy = (min: number) => {
    const at = new Date(T0 + min * 60_000).toISOString();
    appendRollover(state.dir, { kind: "rollover", who: "lane", at, key: "demo", from: OLD, approvedBy: LEAD_STUCK, signals: {}, steps: [], result: "refused", reasons: ["x"], blocked: "busy", request: {}, ...(last ? { resumes: last } : {}) });
    last = at;
  };
  const tick = async (min: number) => { clock.at = T0 + min * 60_000; await deps.registry.patch("demo", { lastReplyAt: clock.at }); await freshnessTick(deps, "/home/test", hooks); };
  // When
  for (const m of [0, 21, 42, 63]) { busy(m); await tick(m + 1); }
  // Then
  expect(resumes).toHaveLength(4);
  expect(sent(w).filter((x) => x.startsWith("[DORI] demo: the handover you asked for") && x.includes("stayed busy"))).toHaveLength(1);
});

test("review 320 round 5: a holder that repointed the lane and died before its commit is repaired, never read as moved", async () => {
  // Given
  const base = await setup();
  const lanes = join(state.dir, "handover", "lanes");
  const mode = "crash";
  const deps: LaneHandoverDeps = { ...base, reportOwner: async () => "msg-1", clock: { ...base.clock, sleep: async () => {
    if (mode === "crash" && live.has(77)) {
      writeFileSync(pendingFile(state.dir, "demo"), JSON.stringify({ key: "demo", pid: 77, at: "2026-10-11T16:34:00Z", from: OLD, to: NEW, note: "n" }));
      await base.registry.patch("demo", { pane: NEW });
    }
    live.delete(77);
    simulate();
  } } };
  mkdirSync(lanes, { recursive: true });
  const lock = () => { writeFileSync(join(lanes, "demo.lock"), JSON.stringify({ pid: 77, at: "2026-10-11T16:30:00Z" })); live.add(77); };
  // When
  lock();
  const crashed = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: LEAD_STUCK, force: true });
  const crashLines = [...printed];
  // Then
  expect(crashed.code).toBe(3);
  expect(crashLines.some((l) => l.startsWith("HANDOVER_INTERRUPTED demo: "))).toBe(true);
  expect(crashLines.some((l) => l.startsWith("HANDOVER_ALREADY_MOVED"))).toBe(false);
});

test("review 320 round 6: a waiting run that was started and died without another row is started again after its grace with no new ready mark, not left waiting for good", async () => {
  // Given
  const base = await setup();
  const T0 = Date.parse("2026-10-11T16:35:00Z");
  const clock = fakeClock(T0);
  const deps = { ...base, clock };
  const resumes: string[] = [];
  const hooks = { signals: async () => ({}), alive: () => false, resume: async (key: string) => { resumes.push(key); return { started: true, line: "unit=u" }; } };
  appendRollover(state.dir, { kind: "rollover", who: "lane", at: new Date(T0).toISOString(), key: "demo", from: OLD, approvedBy: LEAD_STUCK, signals: {}, steps: [], result: "refused", reasons: ["x"], blocked: "busy", request: {} });
  const tick = async (min: number) => { clock.at = T0 + min * 60_000; await deps.registry.patch("demo", { lastReplyAt: clock.at }); await freshnessTick(deps, "/home/test", hooks); };
  const ready = (min: number) => writeFileSync(readyFile(state.dir, "demo"), JSON.stringify({ pane: OLD, at: new Date(T0 + min * 60_000).toISOString() }));
  // When: started at minute 1 by a ready mark, the run dies (no lock, no row); swept again, then the lane marks ready again
  mkdirSync(join(state.dir, "handover", "lanes"), { recursive: true });
  ready(0.5);
  await tick(1);
  await tick(2);
  const inGrace = resumes.length;
  await tick(5);
  // Then: nothing within the 2 min grace, then started again by the sweep alone (plan challenge 14:48Z)
  expect(inGrace).toBe(1);
  expect(resumes).toHaveLength(2);
});

test("plan challenge 14:48Z: a request that waited while another run moved the lane with other options is a conflict, not a success", async () => {
  // Given
  const base = await setup();
  const lanes = join(state.dir, "handover", "lanes");
  const deps: LaneHandoverDeps = { ...base, reportOwner: async () => "msg-1", clock: { ...base.clock, sleep: async () => {
    if (live.has(77)) {
      await base.registry.patch("demo", { pane: "aoe_demo_moved_2" });
      appendRollover(state.dir, { kind: "rollover", who: "lane", at: "2026-10-11T16:36:00Z", key: "demo", from: OLD, to: "aoe_demo_moved_2", approvedBy: LEAD_STUCK, signals: {}, steps: [], result: "done", reasons: [] });
      live.delete(77);
    }
    simulate();
  } } };
  mkdirSync(lanes, { recursive: true });
  writeFileSync(join(lanes, "demo.lock"), JSON.stringify({ pid: 77, at: "2026-10-11T16:30:00Z" }));
  live.add(77);
  // When: this request asked to keep the old session; the run that won closed it
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: LEAD_STUCK, force: true, keepOld: true });
  // Then
  expect(r.code).toBe(2);
  expect(printed.at(-1)).toBe(`HANDOVER_CONFLICT demo: the lane moved from ${OLD} to aoe_demo_moved_2 while this run waited, by a run that closed the old session; this request asked to keep it and is not moved again`);
});

test("a new request with the same approval as one that moved the lane starts its own wait: it inherits neither the age nor the told note of the request before it (review 320 round 15)", async () => {
  // Given: the lead's request of T0 was started again and moved the lane to NEW; an hour later the lead asks again, same approval
  const base = await setup();
  const T0 = Date.parse("2026-10-11T16:35:00Z");
  const clock = fakeClock(T0);
  const deps = { ...base, clock, config: { ...base.config, handover: { ...base.config.handover, readyMin: 30 } } };
  const resumes: string[] = [];
  const hooks = { signals: async () => ({}), alive: () => false, resume: async (key: string) => { resumes.push(key); return { started: true, line: "unit=u" }; } };
  const tick = async (min: number) => { clock.at = T0 + min * 60_000; await deps.registry.patch("demo", { lastReplyAt: clock.at }); await freshnessTick(deps, "/home/test", hooks); };
  appendRollover(state.dir, { kind: "rollover", who: "lane", at: new Date(T0).toISOString(), key: "demo", from: OLD, approvedBy: LEAD_STUCK, signals: {}, steps: [], result: "refused", reasons: ["x"], blocked: "busy", request: {} });
  await tick(1);
  appendRollover(state.dir, { kind: "rollover", who: "lane", at: new Date(T0 + 2 * 60_000).toISOString(), key: "demo", from: OLD, to: NEW, approvedBy: LEAD_STUCK, signals: {}, steps: [], result: "done", reasons: [] });
  await deps.registry.patch("demo", { pane: NEW });
  appendRollover(state.dir, { kind: "rollover", who: "lane", at: new Date(T0 + 60 * 60_000).toISOString(), key: "demo", from: NEW, approvedBy: LEAD_STUCK, signals: {}, steps: [], result: "refused", reasons: ["x"], blocked: "busy", request: {} });
  // When: the sweep a minute after the new request
  await tick(61);
  // Then: started again, and no note that it has waited an hour
  expect(resumes).toHaveLength(2);
  expect(sent(w).filter((x) => x.startsWith("[DORI] demo: the handover you asked for"))).toEqual([]);
});

test("a lead's request refused busy after another run took the lane's lock logs no refusal row outside the lock and asks the lane nothing: it goes the takeover way (review 320 round 15)", async () => {
  // Given: the lane is busy; a run freshness started takes the lane's lock after this run's first look at it
  const base = await setup();
  const lanes = join(state.dir, "handover", "lanes");
  table = aoeTable().filter((p) => p.pid !== 15 && p.pid !== 16);
  w.screens[OLD] = BUSY;
  let raced = false;
  const deps: LaneHandoverDeps = {
    ...base,
    procs: async () => {
      if (!raced) {
        raced = true;
        mkdirSync(lanes, { recursive: true });
        writeFileSync(join(lanes, "demo.lock"), JSON.stringify({ pid: 77, at: "2026-10-11T16:35:01Z" }));
        live.add(77);
      }
      return table;
    },
  };
  // When
  const r = await laneHandover(deps, "demo", "aoe_lead_x", OK);
  // Then: the holder's request stays the lane's waiting one; this run left its own for the holder instead
  expect(r.code).toBe(2);
  expect(rolloverRows()).toEqual([]);
  expect(printed.some((l) => l.startsWith("HANDOVER_PENDING demo"))).toBe(false);
  expect(sent(w).filter((x) => x.startsWith("[LEAD] The lead moves demo to a new session"))).toEqual([]);
  expect(printed.some((l) => l.startsWith("HANDOVER_REFUSED demo: another handover is running (pid 77"))).toBe(true);
});

test("a waiting request whose start again failed keeps its age and its told note: the next sweep tells the lead nothing twice (review 320 round 16)", async () => {
  // Given: request A started again and refused again (B names A); the lead was told at minute 41; that start failed
  const base = await setup();
  const T0 = Date.parse("2026-10-11T16:35:00Z");
  const clock = fakeClock(T0);
  const deps = { ...base, clock, config: { ...base.config, handover: { ...base.config.handover, readyMin: 30 } } };
  let fail = false;
  const hooks = { signals: async () => ({}), alive: () => false, resume: async () => (fail ? { started: false, line: "systemd-run failed" } : { started: true, line: "unit=u" }) };
  const tick = async (min: number) => { clock.at = T0 + min * 60_000; await deps.registry.patch("demo", { lastReplyAt: clock.at }); await freshnessTick(deps, "/home/test", hooks); };
  const a = new Date(T0).toISOString();
  appendRollover(state.dir, { kind: "rollover", who: "lane", at: a, key: "demo", from: OLD, approvedBy: LEAD_STUCK, signals: {}, steps: [], result: "refused", reasons: ["x"], blocked: "busy", request: {} });
  await tick(1);
  appendRollover(state.dir, { kind: "rollover", who: "lane", at: new Date(T0 + 40 * 60_000).toISOString(), key: "demo", from: OLD, approvedBy: LEAD_STUCK, signals: {}, steps: [], result: "refused", reasons: ["x"], blocked: "busy", request: {}, resumes: a });
  fail = true;
  await tick(41);
  fail = false;
  // When: the next sweeps start it again, and the started run dies with no row
  await tick(42);
  await tick(75);
  // Then
  expect(sent(w).filter((x) => x.startsWith("[DORI] demo: the handover you asked for") && x.includes("stayed busy"))).toHaveLength(1);
});

test("a run started again for a request the lead has since replaced leaves before any refusal of its own: its missing note logs no row, so the newer request still waits (review 320 round 16)", async () => {
  // Given: request A (with a note) waited; the lead replaced it with request B and removed A's note
  const base = await setup();
  const deps: LaneHandoverDeps = { ...base, reportOwner: async () => "msg-1" };
  const a = "2026-10-11T16:20:00.000Z";
  const b = "2026-10-11T16:30:00.000Z";
  appendRollover(state.dir, { ...WAITING, at: a, request: { note: "/tmp/gone-note-a.md" } });
  appendRollover(state.dir, { ...WAITING, at: b, request: { keepOld: true } });
  const rows = rolloverRows().length;
  // When: A's delayed run starts
  const r = await laneHandover(deps, "demo", "aoe_lead_x", { approvedBy: LEAD_STUCK, waitIdleMin: 5, note: "/tmp/gone-note-a.md", serves: { at: a, pane: OLD } });
  // Then
  expect(r.code).toBe(2);
  expect(printed.some((l) => l.startsWith(`HANDOVER_REQUEST_GONE demo: the request of ${a} in ${OLD}`))).toBe(true);
  expect(rolloverRows()).toHaveLength(rows);
  expect(waitingRequest(readRollovers(state.dir), "demo", OLD)?.at).toBe(b);
});

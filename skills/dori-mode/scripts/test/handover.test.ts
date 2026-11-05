import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ackHandover, handover, type HandoverDeps, launchOf, manifestPath, missingMonitors } from "../src/handover.ts";
import { quietReason, readRollovers, appendRollover, mintAutoGrant } from "../src/rollover.ts";
import { readFrozen } from "../src/frozen.ts";
import { QuestionStore } from "../src/messenger/discord-cards.ts";
import type { Lane } from "../src/registry.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { Worklog } from "../src/worklog.ts";
import { depsFor, fakeClock, NEW_AOE_ID, newWorld, RUNNING, sent, withState, type World } from "./fakes.ts";

const OLD = "aoe_lead_0a0a0a0a";
const OLD_ID = "0a0a0a0a11112222";
const NEW = `aoe_lead2_${NEW_AOE_ID.slice(0, 8)}`;
const CWD = "/work/lead";
const LINK = "/work/lead-link";
const GUARD = { name: "host guard", check: ["guard-check", "{pane}"], arm: "systemctl --user start dori-lanes" };
const INBOX_CMD = "tail -n 0 -F /home/test/.dori/inbox.jsonl";
const APPROVED = "https://discord.com/channels/1/2/3";
const OWNER = "280680578314010625";
const LANES_CMD = "tail -n 0 -F ~/.dori/lanes.log | grep --line-buffered LANE_";

type Sim = { arm: { command: string; description: string; pid: number }[]; ackPane: string; ackReport: boolean; ackInbox: boolean; guardFor: Set<string>; restate: "full" | "omit-lane" | "silent" | "keep-seed"; supplement: "fix" | "ignore"; handled: Set<string> };

// what the fake new lead understood: every open lane, todo, card and timer of the setup under its own heading
const RESTATEMENT = (lanes = "- demo: working, half way") =>
  ["## Goal", "none", "## Owner's words", "none", "## Open lanes", lanes, "## Open work", "- watch the E7 run", "## Open cards", "- Q1: Ship it?", "## Timers", "- dori-remind-droneshow.timer", "## Promised follow-ups", "none", "## Decisions", "none", "## Next step", "watch the lanes", "## Questions", "none", ""].join("\n");
const SUMMARY = ["## Owner's words and constraints", '- "keep the eval seed fixed at three" (owner, 10-11)', "## Decisions and why", "- moved the digest to the morning because the owner reads it then", "## Promised follow-ups", "- report the E7 render to the owner by 22:00 KST", "## In progress", "- none", "## Next step", "- watch the E7 run", ""].join("\n");

let state: { dir: string; done: () => void };
let w: World;
let sim: Sim;
let printed: string[];
let restarted: string[];
let live: Set<number>;
let sigs: string[];
// the old lead's pane: shell 10 (the fake tmux pane pid), the agent 11, a monitor 12 under it and its grep 13
const TREE = [{ pid: 10, ppid: 1, cmd: "bash" }, { pid: 11, ppid: 10, cmd: "node /x/senpi/dist/bundle/cli.js" }, { pid: 12, ppid: 11, cmd: "tail -n 0 -F /home/test/.dori/inbox.jsonl" }, { pid: 13, ppid: 12, cmd: "grep --line-buffered x" }];

const monitor = (description: string, command: string, extra: Record<string, unknown> = {}) => ({ description, command, filter: "^\\{", persistent: true, suspended: false, expiresAt: Date.parse("2026-10-20T00:00:00Z"), runtime: { pid: 101 }, ...extra });

const writeManifest = (session: string, monitors: unknown[], cwd = CWD) => {
  const file = manifestPath(join(state.dir, "sessions"), cwd, session);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, sessionId: session, monitors }));
};

const lane = (): Lane => ({ key: "demo", title: "Demo", thread: "discord:12345678", pane: "aoe_demo_12345678", brief: join(state.dir, "demo.md"), done: "merged o/r#1", openedAt: "2026-10-11T00:00:00Z", status: "working", lastReport: "[REPORT] demo | milestone | half way" });

const setup = async (): Promise<HandoverDeps> => {
  const clock = fakeClock(Date.parse("2026-10-11T16:35:00Z"));
  const base = depsFor(w, { ...clock, sleep: async () => simulate() }, state.dir, { backend: "aoe", leadPane: OLD, sessionsDir: join(state.dir, "sessions"), update: { repo: "/repo", branch: "main", services: [{ unit: "dori-lanes", paths: [], log: "", ready: "" }], readyTimeoutSec: 5, alertPane: OLD, announce: "", maintainer: false, maintainerAnnounce: "" } });
  w.aoe = [{ id: OLD_ID, title: "lead", path: CWD, tool: "omo", profile: "main" }];
  w.tmux = [OLD];
  writeManifest("old-sid", [
    monitor("inbox", INBOX_CMD),
    monitor("lanes", LANES_CMD, { runtime: { pid: 102 } }),
    monitor("paused watch", "tail -F /tmp/suspended", { suspended: true }),
    monitor("expired watch", "tail -F /tmp/expired", { expiresAt: Date.parse("2026-10-01T00:00:00Z") }),
    monitor("digest due", "until false; do sleep 60; done", { persistent: false }),
    monitor("ended watch", "tail -F /tmp/ended", { persistent: false, runtime: { pid: 999 } }),
  ]);
  const sessionDir = sessionDirFor(join(state.dir, "sessions"), CWD);
  writeFileSync(join(sessionDir, "2026-10-08T08-13-21-349Z_old-sid.jsonl"), [
    JSON.stringify({ type: "custom", customType: "senpi.todo-state", data: { phases: [{ name: "Old", tasks: [{ content: "stale task", status: "pending" }] }] } }),
    JSON.stringify({ type: "custom", customType: "senpi.todo-state", data: { phases: [{ name: "Work", tasks: [{ content: "finished task", status: "completed" }, { content: "watch the E7 run", status: "in_progress" }] }] } }),
  ].join("\n"));
  writeFileSync(join(state.dir, "config.json"), JSON.stringify({ backend: "aoe", leadPane: OLD, update: { alertPane: OLD } }));
  // APPROVED links the owner's message in the inbox (an approval link holds only for one the inbox has from the owner)
  writeFileSync(join(state.dir, "inbox.jsonl"), `${JSON.stringify({ id: "3", channel_id: "2", author_id: OWNER, content: "move the lead" })}\n`);
  writeFileSync(join(state.dir, "dori.env"), `DORI_DISCORD_CHANNEL=1\nDORI_LEAD_AOE_ID=${OLD_ID}\nDORI_LEAD_TMUX=${OLD}\n`);
  writeFileSync(lane().brief, `Do the work.\n- Report ... sent to pane ${OLD} as an argv array.\n- run ["tmux","send-keys","-t","=${OLD}:","-l","--","<report line>"]\n`);
  await base.registry.write(lane());
  new QuestionStore(join(state.dir, "discord")).create("Ship it?", ["yes", "no"], "1", { thread: "12345678", tmux: OLD, session: "old-sid" }, "2026-10-11T00:00:00Z");
  let n = 0;
  return {
    ...base,
    // a configured watcher's check: ["guard-check", <pane>] exits 0 while the guard runs for that pane
    run: async (argv, opts) => {
      if (argv[0] !== "guard-check") return base.run(argv, opts);
      w.calls.push([...argv]);
      return { code: sim.guardFor.has(argv[1] ?? "") ? 0 : 1, out: "", err: "" };
    },
    configPath: join(state.dir, "config.json"),
    envPath: join(state.dir, "dori.env"),
    cardDir: join(state.dir, "discord"),
    inbox: join(state.dir, "inbox.jsonl"),
    ownerIds: [OWNER],
    home: "/home/test",
    sessionOf: async (pane) => (pane === OLD ? "old-sid" : pane === NEW ? "new-sid" : ""),
    routedPane: async () => (JSON.parse(readFileSync(join(state.dir, "config.json"), "utf8")) as { leadPane: string }).leadPane,
    envLeadPane: "",
    alive: (pid) => live.has(pid),
    procs: async () => TREE,
    signal: (pid, sig) => {
      sigs.push(`${sig} ${pid}`);
      return true;
    },
    realpath: (path) => (path === LINK ? CWD : path),
    timers: async () => ["Sat 2026-10-17 08:30:00 UTC 5 days - - dori-remind-droneshow.timer dori-remind-droneshow.service"],
    restart: async (unit) => {
      restarted.push(unit);
      return undefined;
    },
    nonce: () => `n${++n}`,
    print: (line) => printed.push(line),
  };
};

// The new session as the fake world sees it: once prompted it arms its monitors, and it acks the probes it receives.
const simulate = () => {
  if (!w.calls.some((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`) && (c.at(-1) ?? "").includes("handover note"))) return;
  writeManifest("new-sid", sim.arm.map((m) => monitor(m.description, m.command, { runtime: { pid: m.pid } })));
  const at = "2026-10-11T16:40:00Z";
  if (sim.ackReport && w.calls.some((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`) && (c.at(-1) ?? "").includes("HANDOVER_PROBE n1"))) ackHandover(state.dir, "n1", sim.ackPane, at);
  const inbox = join(state.dir, "inbox.jsonl");
  if (sim.ackInbox && existsSync(inbox) && readFileSync(inbox, "utf8").includes("HANDOVER_PROBE n2")) ackHandover(state.dir, "n2", sim.ackPane, at);
  for (const c of w.calls) {
    const text = c[1] === "send-keys" && c.includes(`=${NEW}:`) ? (c.at(-1) ?? "") : "";
    const ask = /HANDOVER_UNDERSTAND (\S+): write what you understood to (\S+)/.exec(text);
    if (ask?.[1] && ask[2] && !sim.handled.has(ask[1]) && sim.restate !== "silent") {
      sim.handled.add(ask[1]);
      // keep-seed: the new lead keeps what the handover wrote and adds only its next step and questions
      writeFileSync(ask[2], sim.restate === "keep-seed" ? `${readFileSync(ask[2], "utf8")}\n## Next step\nwatch the lanes\n## Questions\nnone\n` : RESTATEMENT(sim.restate === "omit-lane" ? "none" : undefined));
      ackHandover(state.dir, ask[1], sim.ackPane, at);
    }
    // a supplement round: the fake lead adds each item under the heading named ("fix") or acks without adding ("ignore")
    // the new lead ends the old session's tasks it is asked to end (their records turn cancelled)
    const cancel = /HANDOVER_TASKS_CANCEL (\S+): .*\(task_id ([^)]+)\)/.exec(text);
    if (cancel?.[1] && cancel[2] && !sim.handled.has(cancel[1])) {
      sim.handled.add(cancel[1]);
      for (const id of cancel[2].split(", ")) {
        const file = join(state.dir, ".omo", "agent", "projects", "lead-1", "senpi-task", "tasks", `${id}.json`);
        writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, "utf8")) as object), status: "cancelled" }));
      }
      ackHandover(state.dir, cancel[1], sim.ackPane, at);
    }
    const sup = /HANDOVER_SUPPLEMENT (\S+) .*Read (\S+), add them to (\S+), then/.exec(text);
    if (sup?.[1] && sup[2] && sup[3] && !sim.handled.has(sup[1])) {
      sim.handled.add(sup[1]);
      if (sim.supplement === "fix") {
        let body = readFileSync(sup[3], "utf8");
        for (const m of readFileSync(sup[2], "utf8").matchAll(/^## \d+\. [^:]+: (.*)\nSource: .*Goes under: ## (.+?)\.$/gm)) body = body.replace(`## ${m[2]}\n`, `## ${m[2]}\n- "${m[1]}"\n`);
        writeFileSync(sup[3], body);
      }
      ackHandover(state.dir, sup[1], sim.ackPane, at);
    }
  }
};

const stopped = () => w.calls.some((c) => c[0] === "aoe" && c[1] === "session" && c[2] === "stop");
const leadPaneInConfig = () => (JSON.parse(readFileSync(join(state.dir, "config.json"), "utf8")) as { leadPane: string }).leadPane;

beforeEach(() => {
  state = withState();
  w = newWorld();
  sim = { arm: [{ description: "inbox", command: INBOX_CMD, pid: 201 }, { description: "lanes", command: LANES_CMD.replace("~/", "/home/test/"), pid: 202 }, { description: "digest due", command: "until false; do sleep 60; done", pid: 203 }], ackPane: NEW, ackReport: true, ackInbox: true, guardFor: new Set([OLD, NEW]), restate: "full", supplement: "fix", handled: new Set() };
  printed = [];
  restarted = [];
  live = new Set([101, 102, 201, 202, 203]);
  sigs = [];
});
afterEach(() => state.done());

test("the note lists open lanes, the running monitors, open cards, unfinished todos and timers; --dry-run moves nothing", async () => {
  // Given
  const deps = await setup();
  // When
  const r = await handover(deps, { dryRun: true });
  // Then
  expect(r.code).toBe(0);
  const note = readFileSync(r.note ?? "", "utf8");
  expect(note).toContain("| demo | working | aoe_demo_12345678 | discord:12345678 | [REPORT] demo / milestone / half way |");
  expect(note).toContain(`- inbox: command ${JSON.stringify(INBOX_CMD)} filter "^\\\\{"`);
  expect(note).toContain(`- lanes: command ${JSON.stringify(LANES_CMD)}`);
  expect(note).not.toContain("/tmp/suspended");
  expect(note).not.toContain("/tmp/expired");
  expect(note).toContain(`- digest due: command "until false; do sleep 60; done" filter "^\\\\{" (was not persistent in the old session; arm it as persistent)`);
  expect(note).not.toContain("/tmp/ended");
  expect(note).toContain("- Q1: Ship it?");
  expect(note).toContain("- Work: watch the E7 run (in_progress)");
  expect(note).not.toContain("finished task");
  expect(note).not.toContain("stale task");
  expect(note).toContain("dori-remind-droneshow.timer");
  expect(printed.some((l) => l.startsWith("HANDOVER_DRY_RUN would open aoe session \"lead-10111635\""))).toBe(true);
  expect(w.calls.some((c) => c[0] === "aoe" && c[1] === "add")).toBe(false);
  expect(leadPaneInConfig()).toBe(OLD);
});

test("refuses before changing anything when the old lead runs no monitor", async () => {
  // Given
  const deps = await setup();
  writeManifest("old-sid", [monitor("paused watch", "tail -F /tmp/suspended", { suspended: true })]);
  // When
  const r = await handover(deps, { approvedBy: APPROVED, title: "lead2" });
  // Then
  expect(r.code).toBe(2);
  expect(printed[0]).toStartWith(`HANDOVER_REFUSED no running monitor found for aoe_lead_0a0a0a0a in ${manifestPath(join(state.dir, "sessions"), CWD, "old-sid")}`);
  expect(w.calls.some((c) => c[0] === "aoe" && c[1] === "add")).toBe(false);
  expect(leadPaneInConfig()).toBe(OLD);
});

test("refuses while DORI_LEAD_PANE overrides the config, since lanes would keep reporting to the old pane", async () => {
  // Given
  const deps = { ...(await setup()), envLeadPane: OLD };
  // When
  const r = await handover(deps, { approvedBy: APPROVED, title: "lead2" });
  // Then
  expect(r.code).toBe(2);
  expect(printed[0]).toStartWith(`HANDOVER_REFUSED DORI_LEAD_PANE=${OLD} is set`);
  expect(w.calls.some((c) => c[0] === "aoe" && c[1] === "add")).toBe(false);
});

test("refuses while another handover holds the lock, and takes over a lock whose process is gone", async () => {
  // Given
  const deps = await setup();
  mkdirSync(join(state.dir, "handover"), { recursive: true });
  writeFileSync(join(state.dir, "handover", "lock"), JSON.stringify({ pid: 101, at: "2026-10-11T16:30:00Z" }));
  // When
  const busy = await handover(deps, { approvedBy: APPROVED, title: "lead2" });
  live.delete(101);
  const after = await handover(deps, { approvedBy: APPROVED, title: "lead2", noMonitors: true, verifyMin: 1 });
  // Then
  expect(busy.code).toBe(2);
  expect(printed.find((l) => l.startsWith("HANDOVER_REFUSED another handover is running (pid 101"))).toBeDefined();
  expect(after.to).toBe(NEW);
  expect(existsSync(join(state.dir, "handover", "lock"))).toBe(false);
});

test("moves config, env, lanes and cards to the new session, checks monitors and both probes, and only then freezes the old one", async () => {
  // Given
  const deps = await setup();
  // When
  const summary = join(state.dir, "summary.md");
  writeFileSync(summary, SUMMARY);
  const r = await handover(deps, { approvedBy: APPROVED, title: "lead2", note: summary });
  // Then
  expect(r).toMatchObject({ code: 0, to: NEW });
  expect(leadPaneInConfig()).toBe(NEW);
  expect((JSON.parse(readFileSync(join(state.dir, "config.json"), "utf8")) as { update: { alertPane: string } }).update.alertPane).toBe(NEW);
  expect(readFileSync(join(state.dir, "dori.env"), "utf8")).toBe(`DORI_DISCORD_CHANNEL=1\nDORI_LEAD_AOE_ID=${NEW_AOE_ID}\nDORI_LEAD_TMUX=${NEW}\n`);
  const brief = readFileSync(lane().brief, "utf8");
  expect(brief).toContain(`"=${NEW}:"`);
  expect(brief).not.toContain(OLD);
  expect(sent(w).some((t) => t.startsWith(`[LEAD] The lead moved to tmux session ${NEW}.`))).toBe(true);
  const card = new QuestionStore(join(state.dir, "discord")).get("Q1");
  expect(card).toMatchObject({ tmux: NEW, session: "new-sid" });
  expect(restarted).toEqual(["dori-lanes"]);
  const probeAt = w.calls.findIndex((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`) && (c.at(-1) ?? "") === `[REPORT] handover-probe | milestone | HANDOVER_PROBE n1: run dori handover ack n1 --state ${state.dir}`);
  expect(probeAt).toBeGreaterThan(-1);
  // committed: the old lead's agent and everything under it is stopped, not closed; its log stays
  expect(sigs).toEqual(["SIGSTOP 11", "SIGSTOP 12", "SIGSTOP 13"]);
  expect(stopped()).toBe(false);
  expect(w.calls.some((c) => c[0] === "aoe" && c[1] === "rm")).toBe(false);
  const oldLog = join(sessionDirFor(join(state.dir, "sessions"), CWD), "2026-10-08T08-13-21-349Z_old-sid.jsonl");
  expect(existsSync(oldLog)).toBe(true);
  expect(readFrozen(state.dir)).toEqual([{ pane: OLD, aoeId: OLD_ID, at: "2026-10-11T16:35:00.000Z", agentPid: 11, pids: [11, 12, 13], closeAt: "2026-10-12T16:35:00.000Z", to: NEW, session: "old-sid", oldLog }]);
  expect(printed).toContain("HANDOVER_MONITORS_OK 3 in aoe_lead2_5e5e5e5e (session new-sid)");
  expect(printed.some((l) => l.startsWith(`HANDOVER_DONE ${OLD} -> ${NEW}`))).toBe(true);
  expect(readFileSync(r.note ?? "", "utf8")).toContain(`## The old lead's notes\n${SUMMARY.trim()}`);
  // the new lead acts only after the commit, which comes once the old session is closed
  expect(readFileSync(r.note ?? "", "utf8")).toContain("Until a [LEAD] HANDOVER_COMMITTED line arrives answer no one");
  expect(sent(w).some((t) => t.startsWith(`[LEAD] HANDOVER_COMMITTED: the handover is checked and the old session ${OLD} is frozen`))).toBe(true);
  const frozenAt = printed.findIndex((l) => l.startsWith(`HANDOVER_OLD_FROZEN ${OLD} agent 11: 3 processes stopped (11,12,13)`));
  expect(frozenAt).toBeGreaterThan(-1);
  expect(printed.findIndex((l) => l === `HANDOVER_COMMITTED lead ${NEW}`)).toBeGreaterThan(frozenAt);
});

test("a lane that does not take the lead notice is kept for the freshness retry instead of being left told=no", async () => {
  // Given: the lane's pane keeps the typed text in its box, as a pane that takes nothing does
  const deps = await setup();
  w.screens[lane().pane ?? ""] = "❯ [LEAD] The lead moved";
  // When
  const r = await handover(deps, { approvedBy: APPROVED, title: "lead2" });
  // Then
  expect(r).toMatchObject({ code: 0, to: NEW });
  expect(printed).toContain("HANDOVER_LANE demo brief=rewritten told=no (freshness retries it)");
  expect(JSON.parse(readFileSync(join(state.dir, "handover", "lane-tells.json"), "utf8"))).toEqual({ demo: { pane: "aoe_demo_12345678", lead: NEW, at: "2026-10-11T16:35:00.000Z", tries: 1 } });
});

for (const exitsOn of ["SIGTERM", "SIGKILL", "never"] as const) {
  test(`ends old monitor chains before freezing the committed lead when the monitor exits on ${exitsOn}`, async () => {
    // Given: the manifest's monitor owns a shell tree beneath the old lead's agent.
    const base = await setup();
    let table = [...TREE];
    writeManifest("old-sid", [monitor("inbox", INBOX_CMD, { runtime: { pid: 12 } })]);
    live.add(12);
    const committed: boolean[] = [];
    const deps: HandoverDeps = {
      ...base,
      procs: async () => table,
      signal: (pid, sig) => {
        if (pid === -12) {
          committed.push(leadPaneInConfig() === NEW && new QuestionStore(base.cardDir).get("Q1")?.session === "new-sid");
          if (sig === exitsOn) table = table.filter((p) => p.pid !== 12 && p.pid !== 13);
        }
        return base.signal(pid, sig);
      },
    };
    // When
    const result = await handover(deps, { approvedBy: APPROVED, title: "lead2" });
    // Then: the process group ends after commit, before the agent and remaining children stop.
    expect(result).toMatchObject({ code: 0, to: NEW });
    expect(committed).toEqual(exitsOn === "SIGTERM" ? [true] : [true, true]);
    expect(sigs).toEqual([
      "SIGTERM -12",
      ...(exitsOn === "SIGTERM" ? [] : ["SIGKILL -12"]),
      ...(exitsOn === "never" ? ["SIGKILL 12", "SIGKILL 13"] : []),
      "SIGSTOP 11",
      ...(exitsOn === "never" ? ["SIGSTOP 12", "SIGSTOP 13"] : []),
    ]);
    expect(readFrozen(state.dir)).toMatchObject([{ agentPid: 11, pids: exitsOn === "never" ? [11, 12, 13] : [11] }]);
    expect(printed).toContain(`HANDOVER_OLD_MONITORS_ENDED ${exitsOn === "never" ? "0 ()" : "1 (12)"}`);
    expect(printed.some((line) => line.startsWith("HANDOVER_OLD_MONITORS_END_FAIL"))).toBe(exitsOn === "never");
  });
}

test("kills a captured reader in another group after its monitor root exits", async () => {
  // Given: shell job control puts the reader in a separate group that ignores the shell group's signals.
  const base = await setup();
  const command = `set -m; trap '' HUP TERM; ${INBOX_CMD} & wait`;
  let table = TREE.map((p) => p.pid === 12 ? { ...p, cmd: `bash -c "${command}"` } : p);
  writeManifest("old-sid", [monitor("inbox", command, { runtime: { pid: 12 } })]);
  live.add(12);
  sim.arm = [{ description: "inbox", command, pid: 201 }];
  const deps: HandoverDeps = {
    ...base,
    procs: async () => table,
    signal: (pid, sig) => {
      if (pid === -12 && sig === "SIGKILL") {
        table = table.filter((p) => p.pid !== 12).map((p) => p.pid === 13 ? { ...p, ppid: 1 } : p);
      }
      if (pid === 13 && sig === "SIGKILL") table = table.filter((p) => p.pid !== 13);
      return base.signal(pid, sig);
    },
  };
  // When
  const result = await handover(deps, { approvedBy: APPROVED, title: "lead2" });
  // Then: the reparented reader is gone before the agent freezes, despite escaping its original process group.
  expect(result).toMatchObject({ code: 0, to: NEW });
  expect(table.some((p) => p.pid === 13)).toBe(false);
  expect(sigs).toEqual(["SIGTERM -12", "SIGKILL -12", "SIGKILL 13", "SIGSTOP 11"]);
  expect(readFrozen(state.dir)).toMatchObject([{ agentPid: 11, pids: [11] }]);
  expect(printed).toContain("HANDOVER_OLD_MONITORS_ENDED 1 (12)");
});

test("leaves old monitor chains running when lead verification rolls back", async () => {
  // Given
  const deps = await setup();
  writeManifest("old-sid", [monitor("inbox", INBOX_CMD, { runtime: { pid: 12 } })]);
  live.add(12);
  sim.ackInbox = false;
  // When
  const result = await handover(deps, { approvedBy: APPROVED, title: "lead2", verifyMin: 1 });
  // Then
  expect(result.code).toBe(3);
  expect(leadPaneInConfig()).toBe(OLD);
  expect(sigs).toEqual([]);
});

test("writes channel scope when sending the inbox probe", async () => {
  // Given
  const deps = await setup();
  // When
  await handover(deps, { approvedBy: APPROVED, title: "lead2" });
  // Then
  const rows: unknown[] = readFileSync(deps.inbox, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const probe = rows.find((row) => typeof row === "object" && row !== null && "kind" in row && row.kind === "handover-probe");
  expect(probe).toMatchObject({ scope: "channel" });
});

test("rewrites instance alert panes when they target the old lead, preserving every other byte", async () => {
  // Given
  const deps = await setup();
  const instances = ["ok", "moo", "yoo"].map((name) => ({ config: join(state.dir, `${name}.json`) }));
  const text = `{\r\n\t"leadPane": "${OLD}",\r\n\t"alertPane": "${OLD}",\r\n\t"update": { "services": [{"alertPane":"${OLD}"}], "alertPane" : "${OLD}" }\r\n}\r\n`;
  for (const ref of instances) writeFileSync(ref.config, text);
  // When
  const result = await handover({ ...deps, config: { ...deps.config, instances } }, { approvedBy: APPROVED, title: "lead2" });
  // Then
  expect(result.code).toBe(0);
  for (const ref of instances) {
    expect(readFileSync(ref.config, "utf8")).toBe(text.replace(`"alertPane" : "${OLD}"`, `"alertPane" : "${NEW}"`));
    expect(printed).toContain(`HANDOVER_ALERTPANE ${ref.config} ${OLD} -> ${NEW}`);
  }
});

test("leaves instance alert panes unchanged when they target another pane", async () => {
  // Given
  const deps = await setup();
  const config = join(state.dir, "other.json");
  const text = '{ "update" : { "alertPane": "aoe_other_12345678" }, "keep": true }\n';
  writeFileSync(config, text);
  // When
  await handover({ ...deps, config: { ...deps.config, instances: [{ config }] } }, { approvedBy: APPROVED, title: "lead2" });
  // Then
  expect(readFileSync(config, "utf8")).toBe(text);
  expect(printed.some((line) => line.startsWith(`HANDOVER_ALERTPANE ${config} `))).toBe(false);
});

test("restores instance alert panes when handover verification rolls back", async () => {
  // Given
  const deps = await setup();
  const config = join(state.dir, "rollback.json");
  const text = `{\n\t"update": { "alertPane" : "${OLD}" }, "leadPane": "own-lead"\n}\n`;
  writeFileSync(config, text);
  sim.ackInbox = false;
  // When
  const result = await handover({ ...deps, config: { ...deps.config, instances: [{ config }] } }, { approvedBy: APPROVED, title: "lead2", verifyMin: 1 });
  // Then
  expect(result.code).toBe(3);
  expect(printed.some((line) => line.startsWith("HANDOVER_VERIFY_FAIL"))).toBe(true);
  expect(printed).toContain(`HANDOVER_ALERTPANE ${config} ${OLD} -> ${NEW}`);
  expect(printed).toContain(`HANDOVER_ALERTPANE ${config} ${NEW} -> ${OLD}`);
  expect(readFileSync(config, "utf8")).toBe(text);
});

test("leaves instance alert panes unchanged on rollback when they already target the new pane", async () => {
  // Given
  const deps = await setup();
  const config = join(state.dir, "already-new.json");
  const text = `{ "update": {"alertPane": "${NEW}"} }\n`;
  writeFileSync(config, text);
  sim.ackInbox = false;
  // When
  await handover({ ...deps, config: { ...deps.config, instances: [{ config }] } }, { approvedBy: APPROVED, title: "lead2", verifyMin: 1 });
  // Then
  expect(readFileSync(config, "utf8")).toBe(text);
  expect(printed.some((line) => line.startsWith(`HANDOVER_ALERTPANE ${config} `))).toBe(false);
});

test("an old lead that cannot be frozen (no agent under its pane) is closed as before, and --keep-old freezes it with no close time", async () => {
  // Given
  const deps = await setup();
  const noAgent: HandoverDeps = { ...deps, procs: async () => [TREE[0] ?? { pid: 10, ppid: 1, cmd: "bash" }] };
  // When
  const failed = await handover(noAgent, { approvedBy: APPROVED, title: "lead2" });
  // Then
  expect(failed).toMatchObject({ code: 0, to: NEW });
  expect(printed.some((l) => l.startsWith(`HANDOVER_FREEZE_FAIL ${OLD}: no agent process under ${OLD}`) && l.endsWith("closing it instead"))).toBe(true);
  expect(sigs).toEqual([]);
  expect(stopped()).toBe(true);
  expect(readFrozen(state.dir)).toEqual([]);
  // Given a fresh world with the agent, kept open
  state.done();
  state = withState();
  w = newWorld();
  printed = [];
  sim.handled = new Set();
  const kept = await setup();
  // When
  const r = await handover(kept, { approvedBy: APPROVED, title: "lead2", keepOld: true });
  // Then
  expect(r).toMatchObject({ code: 0, to: NEW });
  expect(sigs).toEqual(["SIGSTOP 11", "SIGSTOP 12", "SIGSTOP 13"]);
  expect(stopped()).toBe(false);
  expect(readFrozen(state.dir)[0]?.closeAt).toBeUndefined();
  expect(printed.some((l) => l.startsWith(`HANDOVER_OLD_FROZEN ${OLD}`) && l.includes("kept until closed by hand"))).toBe(true);
});

test("an inbox probe acked by the old lead does not count: nothing is closed and everything moves back", async () => {
  // Given
  const deps = await setup();
  sim.ackInbox = false;
  const original = deps.nonce;
  let acked = false;
  const withOldAck: HandoverDeps = {
    ...deps,
    nonce: () => {
      const id = original();
      if (id === "n2" && !acked) {
        acked = true;
        ackHandover(state.dir, "n2", OLD, "2026-10-11T16:40:00Z");
      }
      return id;
    },
  };
  // When
  const r = await handover(withOldAck, { approvedBy: APPROVED, title: "lead2", verifyMin: 1 });
  // Then
  expect(r.code).toBe(3);
  expect(printed.find((l) => l.startsWith("HANDOVER_VERIFY_FAIL"))).toContain(`the inbox probe was acked from ${OLD}, not ${NEW}`);
  expect(stopped()).toBe(false);
  expect(leadPaneInConfig()).toBe(OLD);
  expect(readFileSync(join(state.dir, "dori.env"), "utf8")).toContain(`DORI_LEAD_TMUX=${OLD}\n`);
  expect(readFileSync(lane().brief, "utf8")).not.toContain(NEW);
  expect(new QuestionStore(join(state.dir, "discord")).get("Q1")?.tmux).toBe(OLD);
  expect(sent(w).some((t) => t.startsWith(`[LEAD] Handover to ${NEW} failed`))).toBe(true);
  expect(printed.some((l) => l.startsWith(`HANDOVER_ROLLED_BACK ${OLD} stays the lead`))).toBe(true);
  expect(sent(w).some((t) => t.startsWith("[LEAD] HANDOVER_ROLLED_BACK: the handover failed") && t.includes("You are not the lead"))).toBe(true);
  expect(sent(w).some((t) => t.includes("HANDOVER_COMMITTED:"))).toBe(false);
  // rolled back: the old lead is never stopped, it goes on as the lead
  expect(sigs).toEqual([]);
  expect(readFrozen(state.dir)).toEqual([]);
});

test("a monitor whose process died in the new session counts as missing, so the old lead stays", async () => {
  // Given
  const deps = await setup();
  live.delete(202);
  // When
  const r = await handover(deps, { approvedBy: APPROVED, title: "lead2", verifyMin: 1 });
  // Then
  expect(r.code).toBe(3);
  expect(printed.find((l) => l.startsWith("HANDOVER_VERIFY_FAIL"))).toContain("monitors not running in aoe_lead2_5e5e5e5e: lanes");
  expect(stopped()).toBe(false);
  expect(leadPaneInConfig()).toBe(OLD);
  expect(w.calls.some((c) => c[1] === "send-keys" && (c.at(-1) ?? "").startsWith("[REPORT] handover-probe"))).toBe(false);
  expect(readFileSync(join(state.dir, "inbox.jsonl"), "utf8")).not.toContain("HANDOVER_PROBE");
});

const withWatcher = (deps: HandoverDeps, patch: Partial<HandoverDeps["config"]["handover"]> = {}): HandoverDeps => ({ ...deps, config: { ...deps.config, handover: { ...deps.config.handover, watchers: [GUARD], ...patch } } });

test("a lead whose monitors are all non-persistent (as OkDori's were) still hands them over, each listed and checked", async () => {
  // Given
  const deps = await setup();
  // as omo writes a monitor that is not persistent: no expiry (null) and a deadline
  writeManifest("old-sid", [monitor("inbox", INBOX_CMD, { persistent: false, expiresAt: null, durabilityClass: "ephemeral", deadlineMs: Date.parse("2026-10-11T16:40:00Z") })]);
  sim.arm = [{ description: "inbox", command: INBOX_CMD, pid: 201 }];
  // When
  const r = await handover(deps, { approvedBy: APPROVED, title: "lead2" });
  // Then
  expect(r).toMatchObject({ code: 0, to: NEW });
  expect(readFileSync(r.note ?? "", "utf8")).toContain("## Monitors (1)\n- inbox: command");
  expect(printed).toContain("HANDOVER_MONITORS_OK 1 in aoe_lead2_5e5e5e5e (session new-sid)");
});

test("a configured watcher is listed in the note and checked for the old lead first: one that is down refuses before anything moves", async () => {
  // Given
  const deps = withWatcher(await setup());
  sim.guardFor = new Set();
  // When
  const r = await handover(deps, { approvedBy: APPROVED, title: "lead2" });
  // Then
  expect(r.code).toBe(2);
  expect(printed[0]).toStartWith(`HANDOVER_REFUSED configured watchers not running for ${OLD}: host guard (["guard-check","${OLD}"] exit 1)`);
  expect(w.calls.some((c) => c[0] === "aoe" && c[1] === "add")).toBe(false);
  expect(leadPaneInConfig()).toBe(OLD);
});

test("a configured watcher counts as a watch, and it must run for the new session before the old one closes", async () => {
  // Given
  const deps = withWatcher(await setup());
  writeManifest("old-sid", []);
  // When
  const dry = await handover(deps, { dryRun: true });
  const r = await handover(deps, { approvedBy: APPROVED, title: "lead2" });
  // Then
  expect(dry.code).toBe(0);
  expect(readFileSync(dry.note ?? "", "utf8")).toContain('## Watchers (1, from handover.watchers)\n- host guard: check ["guard-check","{pane}"]; to start it: systemctl --user start dori-lanes');
  expect(printed.find((l) => l.startsWith("HANDOVER_DRY_RUN"))).toContain("0 monitors (none), 1 watchers (host guard)");
  expect(r).toMatchObject({ code: 0, to: NEW });
  expect(printed).toContain(`HANDOVER_WATCHERS_OK host guard for ${NEW}`);
  expect(w.calls).toContainEqual(["guard-check", NEW]);
});

test("a configured watcher that does not run for the new session moves everything back", async () => {
  // Given
  const deps = withWatcher(await setup());
  sim.guardFor = new Set([OLD]);
  // When
  const r = await handover(deps, { approvedBy: APPROVED, title: "lead2", verifyMin: 1 });
  // Then
  expect(r.code).toBe(3);
  expect(printed.find((l) => l.startsWith("HANDOVER_VERIFY_FAIL"))).toContain(`watchers not running for ${NEW}: host guard`);
  expect(stopped()).toBe(false);
  expect(leadPaneInConfig()).toBe(OLD);
});

test("an old lead running from a symlinked path is warned about, and the new session opens (and is checked) in the real path", async () => {
  // Given
  const deps = await setup();
  w.aoe[0] = { ...w.aoe[0], path: LINK } as World["aoe"][number];
  const oldManifest = manifestPath(join(state.dir, "sessions"), CWD, "old-sid");
  writeManifest("old-sid", JSON.parse(readFileSync(oldManifest, "utf8")).monitors, LINK);
  rmSync(oldManifest);
  // When
  const r = await handover(deps, { approvedBy: APPROVED, title: "lead2" });
  // Then
  expect(printed[0]).toBe(`HANDOVER_CWD_SYMLINK the old lead runs from ${LINK}, a symlink to ${CWD}; the new session opens in ${CWD} (set handover.cwd to choose another)`);
  expect(w.calls.find((c) => c[0] === "aoe" && c[1] === "add")?.[2]).toBe(CWD);
  expect(r).toMatchObject({ code: 0, to: NEW });
  expect(readFileSync(r.note ?? "", "utf8")).toContain(`cwd ${LINK}). You are the new lead session, opened in ${CWD}:`);
});

test("handover.cwd picks where the new session opens", async () => {
  // Given
  const deps = withWatcher(await setup(), { watchers: [], cwd: "/work/elsewhere" });
  // When
  await handover(deps, { dryRun: true });
  // Then
  expect(printed.find((l) => l.startsWith("HANDOVER_DRY_RUN"))).toStartWith('HANDOVER_DRY_RUN would open aoe session "lead-10111635" in /work/elsewhere (');
});

test("dori.env without DORI_LEAD_* lines gets them, so the listener learns the new lead", async () => {
  // Given
  const deps = await setup();
  writeFileSync(join(state.dir, "dori.env"), "DORI_DISCORD_CHANNEL=1");
  // When
  const r = await handover(deps, { approvedBy: APPROVED, title: "lead2" });
  // Then
  expect(r.code).toBe(0);
  expect(readFileSync(join(state.dir, "dori.env"), "utf8")).toBe(`DORI_DISCORD_CHANNEL=1\nDORI_LEAD_TMUX=${NEW}\nDORI_LEAD_AOE_ID=${NEW_AOE_ID}\n`);
});

test("refuses without the owner's approval before opening anything; an approval card must be answered yes", async () => {
  // Given
  const deps = await setup();
  // When
  const bare = await handover(deps, { title: "lead2" });
  const notProposed = await handover(deps, { title: "lead2", approvedBy: "Q1" });
  appendRollover(state.dir, { kind: "proposal", who: "lead", at: "2026-10-11T00:00:00Z", key: "lead", card: "Q1", pane: deps.config.leadPane, signals: {}, crossed: [], blockers: "" });
  const openCard = await handover(deps, { title: "lead2", approvedBy: "Q1" });
  // Then
  expect([bare.code, notProposed.code, openCard.code]).toEqual([2, 2, 2]);
  expect(printed[0]).toStartWith("HANDOVER_REFUSED the lead moves to a new session only with an approval: no approval");
  expect(printed[1]).toContain("card Q1 is not a rollover proposal for lead");
  expect(printed[2]).toContain("card Q1 is not answered yet");
  expect(w.calls.some((c) => c[0] === "aoe" && c[1] === "add")).toBe(false);
  expect(readRollovers(state.dir).map((e) => (e.kind === "rollover" ? e.result : e.kind))).toEqual(["refused", "proposal", "refused"]);
});

test("the lead's own approval without a signal gets the one freshness measured for its pane (lead-due.json), or the last proposal; none measured, refused as before", async () => {
  // Given
  const deps = { ...(await setup()), reportOwner: async () => "msg-1" };
  const reason = "lead:moving myself to a fresh session";
  // When
  const bare = await handover(deps, { title: "lead2", approvedBy: reason, dryRun: true });
  mkdirSync(join(state.dir, "handover"), { recursive: true });
  writeFileSync(join(state.dir, "handover", "lead-due.json"), JSON.stringify({ pane: deps.config.leadPane, at: "2026-10-11T00:00:00Z", crossed: ["context after compaction 320k >= 300k"] }));
  const due = await handover(deps, { title: "lead2", approvedBy: reason, dryRun: true });
  // Then
  expect(bare.code).toBe(2);
  expect(printed.some((l) => l.includes("does not say the reason and the signal behind it"))).toBe(true);
  const filled = `${reason}, context after compaction 320k >= 300k (measured)`;
  expect(printed).toContain(`HANDOVER_APPROVAL_FILLED lead: ${JSON.stringify(filled)} (the signal read from the records)`);
  expect(printed).toContain(`HANDOVER_APPROVAL_OK ${JSON.stringify(filled)}`);
  expect(due.code).not.toBe(2);
});

test("the old lead is quiet from the moment the new lead takes over until the checks end, then the log has the rollover", async () => {
  // Given
  const deps = await setup();
  const quietSeen: (string | undefined)[] = [];
  const sleep = deps.clock.sleep;
  const watched = { ...deps, clock: { ...deps.clock, sleep: async (ms: number) => { quietSeen.push(quietReason(state.dir, OLD, deps.clock.now())); await sleep(ms); } } };
  // When
  const r = await handover(watched, { title: "lead2", approvedBy: APPROVED });
  // Then
  expect(r).toMatchObject({ code: 0, to: NEW });
  expect(quietSeen.length).toBeGreaterThan(0);
  expect(quietSeen.every((q) => q?.startsWith(`HANDOVER_QUIET ${OLD}: the handover of the lead to ${NEW} is running`))).toBe(true);
  expect(quietReason(state.dir, OLD, deps.clock.now())).toBeUndefined();
  expect(quietReason(state.dir, NEW, deps.clock.now())).toBeUndefined();
  const log = readRollovers(state.dir);
  expect(log[0]).toMatchObject({ kind: "rollover", who: "lead", key: "lead", from: OLD, to: NEW, approvedBy: APPROVED, result: "done-frozen", frozen: { pids: 3, closeAt: "2026-10-12T16:35:00.000Z" } });
  expect(log[0]?.kind === "rollover" && log[0].steps.map((s) => s.step)).toEqual(["open", "startup", "repoint", "verify", "freeze"]);
});

test("a monitor counts as re-armed only with the same command and filter, or the same path; a name alone is enough only without either", () => {
  // Given
  const entry = (e: Record<string, unknown>) => ({ persistent: true, suspended: false, expiresAt: null, runtime: { pid: 1 }, ...e }) as never;
  const events = { description: "events", command: "tail -n 0 -F /x/events.log", filter: "^EV", persistent: true };
  const check = (wanted: object, entries: object[]) => missingMonitors([wanted as never], entries as never, () => true, "/home/test", 0);
  // When / Then
  expect(check(events, [entry({ description: "events", command: "sleep 3600", filter: "^EV" })])).toEqual(['events (a monitor runs another command, from char 0: "tail -n 0 -F /x/events.l" wanted, "sleep 3600" armed; arm it with the command and filter of the note\'s Monitors line)']);
  expect(check(events, [entry({ description: "x", command: "tail -n 0 -F /x/events.log", filter: "^ANY" })])).toEqual(['events (a monitor runs its command with filter "^ANY", not "^EV"; arm it with the command and filter of the note\'s Monitors line)']);
  expect(check(events, [entry({ description: "x", command: "tail -n 0 -F /x/events.log", filter: "^EV" })])).toEqual([]);
  expect(check({ description: "inbox", path: "/x/inbox", persistent: true }, [entry({ description: "inbox", path: "/x/other" })])).toEqual(["inbox"]);
  expect(check({ description: "inbox", path: "/x/inbox", persistent: true }, [entry({ description: "y", path: "/x/inbox" })])).toEqual([]);
  expect(check({ description: "named", persistent: true }, [entry({ description: "named", command: "anything" })])).toEqual([]);
});

// GongDori's E7 chain watch (2026-10-20): it starts the chain unless pgrep finds it, then tails the chain's log
const E7 = `dori heavy e7-bs-chain -- ssh node 'cd w && if pgrep -f "^bash qa/chain.sh" >/dev/null; then echo CHAIN_ALREADY_RUNNING; else nohup setsid bash qa/chain.sh 400 > logs/chain.out 2>&1 & echo "CHAIN_PID=$!"; fi; sleep 3; tail -n +1 -F logs/chain.out | grep --line-buffered CHAIN_'`;

test("a monitor command that starts work is told from one that only watches; a script that honours SENPI_MONITOR_RESTORED gets its watch-only form", () => {
  // Given
  const script = 'if [ -n "${SENPI_MONITOR_RESTORED:-}" ]; then exec tail -F /x/chain.out; fi\nnohup setsid bash chain.sh > /x/chain.out 2>&1 &\n';
  const read = (p: string) => (p === "/home/test/w/watch.sh" ? script : undefined);
  // When / Then
  expect(launchOf(E7, "/home/test")).toEqual({ why: "nohup", writes: ["logs/chain.out"] });
  expect(launchOf("python train.py > /x/run.log 2>&1 &", "/home/test")?.why).toBe("a background job writing a file");
  expect(launchOf("until [ -f /x/done ]; do sleep 5; done && dori send discord pair done", "/home/test")?.why).toBe("dori send");
  expect(launchOf("bash ~/w/watch.sh 2>&1 | tee -a /x/w.log", "/home/test", read)).toEqual({ why: "nohup", writes: ["/x/w.log"], rearm: "export SENPI_MONITOR_RESTORED=1; bash ~/w/watch.sh 2>&1 | tee -a /x/w.log" });
  for (const watch of [
    "export SENPI_MONITOR_RESTORED=1; bash ~/w/watch.sh 2>&1 | tee -a /x/w.log",
    "tail -n 0 -F ~/.dori/lanes.log | grep --line-buffered LANE_",
    "ssh node 'tail -n +1 -F w/logs/chain.out | grep --line-buffered CHAIN_'",
    "until ! kill -0 1234; do sleep 5; done; echo GONE",
    'curl -s "http://x/a?b=1&c=2" >/dev/null 2>&1; echo $?',
    // the lead's listener alert: a backgrounded check that only reads
    "tail -n 0 -F $L | while read -r l; do case \"$l\" in *CLOSED*) ( sleep 60; tail -n 40 $L | awk '/R/{r=NR} END{exit !(r>c)}' || echo NO-RECONNECT ) & ;; esac; done",
  ]) expect(launchOf(watch, "/home/test", read)).toBeUndefined();
});

test("a monitor that starts work counts as re-armed only by a watch-only one with its description or filter; the same command armed again does not count", () => {
  // Given
  const entry = (e: Record<string, unknown>) => ({ persistent: true, suspended: false, expiresAt: null, runtime: { pid: 1 }, ...e }) as never;
  const chain = { description: "BS chain", command: E7, filter: "CHAIN_", persistent: true };
  const check = (entries: object[]) => missingMonitors([chain as never], entries as never, () => true, "/home/test", 0);
  const tailOnly = "ssh node 'tail -n +1 -F w/logs/chain.out | grep --line-buffered CHAIN_'";
  // When / Then
  expect(check([entry({ description: "BS chain", command: E7, filter: "CHAIN_" })])).toEqual(["BS chain (armed again with the command that starts work; arm a watch-only one instead)"]);
  expect(check([])).toEqual(["BS chain (starts work: arm a watch-only one with the same description)"]);
  expect(check([entry({ description: "other", command: tailOnly, filter: "^X" })])).toHaveLength(1);
  expect(check([entry({ description: "BS chain", command: "nohup bash qa/chain.sh > logs/chain.out &" })])).toHaveLength(1);
  expect(check([entry({ description: "BS chain", command: tailOnly, filter: "CHAIN_" })])).toEqual([]);
  expect(check([entry({ description: "chain tail", command: tailOnly, filter: "CHAIN_" })])).toEqual([]);
  expect(check([entry({ description: "BS chain", path: "/x/chain.out" })])).toEqual([]);
  // a monitor that only watches still needs its own command, as before
  expect(missingMonitors([{ description: "tail", command: tailOnly, filter: "CHAIN_", persistent: true }], [entry({ description: "tail", command: "tail -F /other", filter: "CHAIN_" })], () => true, "/home/test", 0)).toHaveLength(1);
});

// GongDori's E7 lane (2026-10-20 23:39Z): the old session's remote tail and the one its new session armed, as the two
// manifests hold them; the new one has \\| for \| inside the remote double quotes, the same sed argument
const E7_OLD = `ssh ori644d 'tail -n +1 -F workspace/hr35_rand/logs/bs_chain.out | grep --line-buffered -E "BS_CHAIN_|ARCH_MN_|MULTINODE_END|Traceback" | sed -u "/BS_CHAIN_DONE\\|BS_CHAIN_ABORT/q"'`;
const E7_NEW = `ssh ori644d 'tail -n +1 -F workspace/hr35_rand/logs/bs_chain.out | grep --line-buffered -E "BS_CHAIN_|ARCH_MN_|MULTINODE_END|Traceback" | sed -u "/BS_CHAIN_DONE\\\\|BS_CHAIN_ABORT/q"'`;

test("a remote tail re-armed in another spelling the shell runs the same way counts; one that runs something else, or ended, does not and says why", () => {
  // Given
  const entry = (e: Record<string, unknown>) => ({ persistent: true, suspended: false, expiresAt: null, runtime: { pid: 1 }, ...e }) as never;
  const wanted = { description: "BS chain tail-only (safe to re-arm; never launches): ori644d logs/bs_chain.out", command: E7_OLD, filter: "BS_CHAIN_|ARCH_MN_|MULTINODE_END|Traceback", persistent: true };
  const check = (entries: object[], alive = (_pid: number) => true) => missingMonitors([wanted as never], entries as never, alive, "/home/test", 0);
  const armed = (command: string, extra: Record<string, unknown> = {}) => entry({ description: "BS chain tail", command, filter: wanted.filter, ...extra });
  // When / Then
  expect(E7_NEW).not.toBe(E7_OLD);
  expect(check([armed(E7_NEW)])).toEqual([]);
  expect(check([armed(`ssh   ori644d "tail -n +1 -F workspace/hr35_rand/logs/bs_chain.out | grep --line-buffered -E 'BS_CHAIN_|ARCH_MN_|MULTINODE_END|Traceback' | sed -u '/BS_CHAIN_DONE\\|BS_CHAIN_ABORT/q'"`)])).toEqual([]);
  expect(check([armed("ssh -o BatchMode=yes ori644d 'tail -n +1 -F workspace/hr35_rand/logs/bs_chain.out'")])[0]).toContain("a monitor runs another command");
  // another host, another log, a pipe turned into a quoted word: another watch
  for (const other of [E7_NEW.replace("ori644d", "ori4b69"), E7_NEW.replace("bs_chain.out", "bs_chain2.out"), E7_OLD.replace('-E "BS_CHAIN_|ARCH_MN_|MULTINODE_END|Traceback" |', '-E "BS_CHAIN_|ARCH_MN_|MULTINODE_END|Traceback" "|"')])
    expect(check([armed(other)])).toHaveLength(1);
  expect(check([armed(E7_NEW, { runtime: { pid: 71817 } })], () => false)).toEqual([`${wanted.description} (armed, but its process 71817 ended (a remote tail whose ssh failed or whose log ended exits at once))`]);
  expect(check([armed(E7_NEW, { persistent: false })])).toEqual([`${wanted.description} (armed, but it is not persistent)`]);
  expect(check([])).toEqual([wanted.description]);
});

test("an automatic lead rollover tells the owner afterwards with what it crossed; with the key off it is refused and nobody is told", async () => {
  // Given
  const posted: string[] = [];
  const base = await setup();
  const off: HandoverDeps = { ...base, reportOwner: async (_thread, text) => { posted.push(text); return "msg-9"; } };
  const on: HandoverDeps = { ...off, config: { ...off.config, handover: { ...off.config.handover, autoRolloverLead: true } } };
  // When
  const grant = () => mintAutoGrant(state.dir, "lead", "lead", base.clock.now());
  const refused = await handover(off, { approvedBy: "auto:handover.autoRolloverLead", autoGrant: grant(), title: "lead2" });
  // typed by hand with the key on (the string alone): refused with what to use, and not logged as an automatic run
  const rowsBefore = readRollovers(state.dir).length;
  const byHand = await handover(on, { approvedBy: "auto:handover.autoRolloverLead", title: "lead2" });
  const handRows = readRollovers(state.dir).length - rowsBefore;
  const r = await handover(on, { approvedBy: "auto:handover.autoRolloverLead", autoGrant: grant(), title: "lead2" });
  // Then
  expect(refused.code).toBe(2);
  expect(byHand.code).toBe(2);
  expect(printed.find((l) => l.includes("HANDOVER_APPROVAL"))).toStartWith("HANDOVER_REFUSED the lead moves to a new session only with an approval: HANDOVER_APPROVAL auto:handover.autoRolloverLead is the approval of a run freshness starts by itself");
  expect(handRows).toBe(0);
  // an early refusal (a note that does not exist) of a borrowed string is the approval refusal, and is not logged either (review 312)
  const rowsBeforeEarly = readRollovers(state.dir).length;
  const early = await handover(on, { approvedBy: "auto:handover.autoRolloverLead", note: join(state.dir, "no-such-note.md"), title: "lead2" });
  expect(early.code).toBe(2);
  expect(printed.filter((l) => l.includes("HANDOVER_APPROVAL"))).toHaveLength(2);
  expect(readRollovers(state.dir).length).toBe(rowsBeforeEarly);
  expect(r).toMatchObject({ code: 0, to: NEW });
  expect(posted).toHaveLength(1);
  // the owner's notice says how long the old session is kept, with no pane, arrow or key; the thaw command is in the watch log
  expect(posted[0]).toContain("24 hours");
  for (const token of [OLD, NEW, "->", "handover.", "{"]) expect(posted[0]).not.toContain(token);
  expect(readRollovers(state.dir).at(-1)).toMatchObject({ decidedBy: "auto", ownerReport: { message: "msg-9" } });
});

test("the owner's recent messages and the old lead's summary go into the note word for word, and the move commits on the probes alone: no restatement, no supplement round before the commit", async () => {
  // Given
  const deps = await setup();
  const withOwner: HandoverDeps = { ...deps, ownerIds: [OWNER, "owner1"] };
  writeFileSync(join(state.dir, "inbox.jsonl"), readFileSync(join(state.dir, "inbox.jsonl"), "utf8") + [
    { ts: "2026-10-11T16:20:00Z", id: "m1", scope: "thread", channel_id: "777", author_id: "owner1", content: "auto rollover loses no context, right?" },
    { ts: "2026-10-10T10:00:00Z", id: "m0", scope: "thread", channel_id: "777", author_id: "owner1", content: "an old message from yesterday morning" },
    { ts: "2026-10-11T16:21:00Z", id: "m2", scope: "kakao", room: "friends", author_id: "someone", content: "not the owner talking here" },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  const log = join(sessionDirFor(join(state.dir, "sessions"), CWD), "2026-10-08T08-13-21-349Z_old-sid.jsonl");
  writeFileSync(log, `${readFileSync(log, "utf8")}\n${JSON.stringify({ type: "message", message: { role: "user", content: "and keep the eval seed fixed at three for every run" } })}`);
  const summary = join(state.dir, "summary.md");
  writeFileSync(summary, SUMMARY);
  // When
  const r = await handover(withOwner, { approvedBy: APPROVED, title: "lead2", note: summary });
  // Then
  expect(r).toMatchObject({ code: 0, to: NEW });
  const note = readFileSync(r.note ?? "", "utf8");
  expect(note).toContain("## The owner's recent messages (1, last 24 h, newest last)\n- 2026-10-11T16:20:00Z (thread 777, message m1): \"auto rollover loses no context, right?\"");
  expect(note).toContain(`Its full log is ${log}`);
  // the summary goes into the note word for word, and no restatement is asked before the commit (owner Q476)
  expect(note).toContain("report the E7 render to the owner by 22:00 KST");
  expect(printed.filter((l) => l.startsWith("HANDOVER_UNDERSTAND") || l.startsWith("HANDOVER_SUPPLEMENT"))).toEqual([]);
  expect(existsSync((r.note ?? "").replace(/\.md$/, ".supplement-1.md"))).toBe(false);
  expect(readRollovers(state.dir).at(-1)).not.toHaveProperty("supplementRounds");
});

test("the quotes in the old lead's conversation that its summary does not hold go into the note, the owner's only with proof", async () => {
  // Given: the old lead got a line quoting the owner without a message id, and one quoting the summary's own words
  const deps = await setup();
  const log = join(sessionDirFor(join(state.dir, "sessions"), CWD), "2026-10-08T08-13-21-349Z_old-sid.jsonl");
  writeFileSync(log, `${readFileSync(log, "utf8")}\n${[
    { type: "message", timestamp: "2026-10-11T12:45:00Z", message: { role: "user", content: '[REPORT] pingpong | milestone | 형이 말한 "영상 전체 위에 오버레이" 그대로 두고 고침' } },
    { type: "message", timestamp: "2026-10-11T12:46:00Z", message: { role: "user", content: 'owner said "keep the eval seed fixed at three" again' } },
  ].map((x) => JSON.stringify(x)).join("\n")}`);
  const summary = join(state.dir, "summary.md");
  writeFileSync(summary, SUMMARY);
  // When
  const r = await handover(deps, { approvedBy: APPROVED, title: "lead2", note: summary });
  // Then
  expect(r).toMatchObject({ code: 0, to: NEW });
  const note = readFileSync(r.note ?? "", "utf8");
  expect(note).toContain("## Quotes in the old conversation (1)\n");
  expect(note).toMatch(/- 2026-10-11T12:45Z lead's words \(old log line \d+\): "영상 전체 위에 오버레이"/);
  expect(printed.find((l) => l.startsWith("HANDOVER_NOTE"))).toContain("1 quotes from the old conversation");
});

test("the open worklog items go into the note with their Next line, closed ones stay out, and a damaged line is named (upstream dori-superagent#96)", async () => {
  // Given one open item with a next step, one closed item, and a line that is no record (line 9: each append starts with its own newline)
  const deps = await setup();
  const log = new Worklog(state.dir);
  const open = log.add("Ship the release notes", "discord:777/m1", Date.parse("2026-10-11T16:00:00Z"));
  log.next(open.id, "wait for CI on #12, then merge", Date.parse("2026-10-11T16:01:00Z"));
  const done = log.add("Rename the bot", "discord:777/m2", Date.parse("2026-10-11T16:02:00Z"));
  log.close(done.id, "renamed", Date.parse("2026-10-11T16:03:00Z"));
  writeFileSync(log.path, `${readFileSync(log.path, "utf8")}garbage\n`);
  const summary = join(state.dir, "summary.md");
  writeFileSync(summary, SUMMARY);
  // When
  const r = await handover(deps, { approvedBy: APPROVED, title: "lead2", note: summary });
  // Then the new lead reads the open item and its Next line in the note, and the count is printed
  expect(r).toMatchObject({ code: 0, to: NEW });
  const note = readFileSync(r.note ?? "", "utf8");
  expect(note).toContain(`## Open worklog items (1, dori worklog list --open; ${log.markdownPath})\n- OPEN ${open.id} "Ship the release notes" source="discord:777/m1" next="wait for CI on #12, then merge"\n- WORKLOG damaged ${log.path}:9: JSON Parse error`);
  expect(note).not.toContain(done.id);
  expect(printed.find((l) => l.startsWith("HANDOVER_NOTE"))).toContain("1 open worklog items");
});

test("an old lead's summary without its headings is refused before anything opens", async () => {
  // Given
  const deps = await setup();
  // When
  const r = await handover(deps, { approvedBy: APPROVED, title: "lead2", note: lane().brief });
  // Then
  expect(r.code).toBe(2);
  expect(printed.find((l) => l.startsWith("HANDOVER_REFUSED"))).toContain("lacks ## Owner's words and constraints, ## Decisions and why, ## Promised follow-ups, ## In progress, ## Next step (dori handover --template prints the headings)");
  expect(w.calls.some((c) => c[0] === "aoe" && c[1] === "add")).toBe(false);
});

test("work a monitor of the old lead started is not stopped with it: the old lead freezes around it and its record waits for that work", async () => {
  // Given: a monitor (pid 103) that put a chain (104) in the background and follows its log (105)
  const CUT = "cd w; bash qa/chain.sh > /tmp/x/chain.log 2>&1 & pid=$!; tail --pid=$pid -n +1 -f /tmp/x/chain.log";
  const tree = [...TREE, { pid: 103, ppid: 11, cmd: `/bin/bash -c ${CUT}` }, { pid: 104, ppid: 103, cmd: "bash qa/chain.sh" }, { pid: 105, ppid: 103, cmd: "tail --pid=104 -n +1 -f /tmp/x/chain.log" }];
  const base = await setup();
  const deps: HandoverDeps = { ...base, procs: async () => tree };
  writeManifest("old-sid", [monitor("inbox", INBOX_CMD), monitor("lanes", LANES_CMD, { runtime: { pid: 102 } }), monitor("chain", CUT, { runtime: { pid: 103 } })]);
  sim.arm = [...sim.arm.slice(0, 2), { description: "chain", command: "tail -n 0 -F /tmp/x/chain.log", pid: 204 }];
  for (const pid of [103, 104, 105, 204]) live.add(pid);
  // When
  const r = await handover(deps, { approvedBy: APPROVED, title: "lead2" });
  // Then
  expect(r).toMatchObject({ code: 0, to: NEW });
  expect(sigs).toEqual(["SIGSTOP 11", "SIGSTOP 12", "SIGSTOP 13"]);
  expect(stopped()).toBe(false);
  expect(printed).toContain(`HANDOVER_WORK_KEPT ${OLD}: the work its monitors started still runs (chain: 104); those monitors are left running and the old session closes once that work ended`);
  expect(readFrozen(state.dir)).toMatchObject([{ pane: OLD, agentPid: 11, pids: [11, 12, 13], keepFor: [104] }]);
});

test("once the lead's move commits, the old lead's tasks in the shared task host are ended through the new lead; a task in the frozen old agent is stopped with it and left alone, and another session's task on the same host too", async () => {
  // Given
  // the task records live under the home: the fake new lead arms its monitors with ~ there too
  const deps: HandoverDeps = { ...(await setup()), home: state.dir };
  sim.arm = sim.arm.map((m) => (m.description === "lanes" ? { ...m, command: LANES_CMD.replace("~/", `${state.dir}/`) } : m));
  live.add(11);
  live.add(50);
  const dir = join(state.dir, ".omo", "agent", "projects", "lead-1", "senpi-task", "tasks");
  mkdirSync(dir, { recursive: true });
  const rec = (id: string, extra: Record<string, unknown>) => {
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ task_id: id, status: "running", parent_session_id: "old-sid", root_session_id: "old-sid", ...extra }));
    return join(dir, `${id}.json`);
  };
  const shared = rec("st_01aaa", { host_pid: 50, execution_mode: "process", task_summary: "survey the lane logs" });
  const frozen = rec("st_01bbb", { host_pid: 11, execution_mode: "in-process" });
  const other = rec("st_01ccc", { host_pid: 50, execution_mode: "process", parent_session_id: "lane-sid", root_session_id: "lane-sid", task_summary: "read old-sid's log for the lane" });
  // When
  const r = await handover(deps, { approvedBy: APPROVED, title: "lead2" });
  // Then
  expect(r).toMatchObject({ code: 0, to: NEW });
  expect(sent(w).find((l) => l.startsWith("[LEAD] HANDOVER_TASKS_CANCEL"))).toContain("1 background task(s) of the old session still run after the move: st_01aaa (survey the lane logs).");
  expect(printed).toContain(`HANDOVER_TASKS_CANCELLED lead st_01aaa "survey the lane logs" -> ${r.note}`);
  expect([shared, frozen, other].map((f) => (JSON.parse(readFileSync(f, "utf8")) as { status: string }).status)).toEqual(["cancelled", "running", "running"]);
  expect(readFileSync(r.note ?? "", "utf8")).toContain(`- st_01aaa: survey the lane logs; cancelled; record ${shared}`);
});

test("a new lead whose first turn outlasts the verify time gets no probe: the handover fails and moves back", async () => {
  const deps = await setup();
  const run = deps.run;
  let probed = false;
  const r = await handover({
    ...deps,
    run: async (argv, o) => {
      if (argv[1] === "send-keys" && argv.includes(`=${NEW}:`) && (argv.at(-1) ?? "").includes("HANDOVER_PROBE")) probed = true;
      const got = await run(argv, o);
      return argv[1] === "capture-pane" && argv.includes(`=${NEW}:`) ? { ...got, out: `${got.out}\n${RUNNING}` } : got;
    },
  }, { approvedBy: APPROVED, title: "lead2", verifyMin: 1 });
  expect(r.code).not.toBe(0);
  expect(probed).toBe(false);
  const inbox = (() => { try { return readFileSync(deps.inbox, "utf8"); } catch { return ""; } })();
  expect(inbox).not.toContain("handover-probe");
});

test("on herdr an agentCommand that picks its session itself is refused before anything opens", async () => {
  const deps = await setup();
  const r = await handover({ ...deps, config: { ...deps.config, backend: "herdr", agentCommand: ["omo", "--continue", "--model", "{model}", "{prompt}"] } }, { approvedBy: APPROVED, title: "lead2" });
  expect(r.code).not.toBe(0);
  expect(JSON.stringify(readRollovers(state.dir).at(-1))).toContain("without a session selector");
  expect(w.calls.some((c) => c[0] === "herdr" || c[1] === "add")).toBe(false);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deadPaneTick, newDeadPaneState } from "../src/dead-panes.ts";
import { closeAoeSession, herdrAgentArgv, isClosedLine, liveSessions, paneActivity, paneLife, sessionFor } from "../src/aoe.ts";
import { interactiveShellInFront, openHerdrSession } from "../src/herdr.ts";
import { leadAlive } from "../src/lead-down.ts";
import { readScreen, submitToPane } from "../src/panes.ts";
import { resolveSession, shellPidOf, topAgent } from "../src/session-id.ts";
import { agentTree } from "../src/frozen.ts";
import { agentAlive, localChains } from "../src/lane-handover.ts";
import { closeLane } from "../src/done-flow.ts";
import { launchLane } from "../src/launch.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, RUNNING, sent, type World } from "./fakes.ts";

// The herdr side of the session primitives (herdr.ts): a pane id with ":" goes to herdr, a tmux name to tmux, so one Dori
// can hold lanes of both while it moves.
let world: World;
let dir: string;
beforeEach(() => {
  world = newWorld();
  dir = mkdtempSync(join(tmpdir(), "herdr-backend-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const omo = (patch = {}) => depsFor(world, fakeClock(0), dir, { backend: "herdr", ...patch });


test("a herdr pane is live while an agent runs in it, dead once only its shell is left, gone when herdr has no such pane", async () => {
  const run = fakeRunner(world);
  world.herdrDead = ["w1:p2"];
  world.herdrGone = ["w1:p3"];
  expect([await paneLife(run, "w1:p1"), await paneLife(run, "w1:p2"), await paneLife(run, "w1:p3")]).toEqual([{ live: true }, { live: false, how: "dead", status: -1 }, { live: false, how: "gone" }]);
  expect(await leadAlive(run, "w1:p2")).toBe(false);
  expect(world.calls.some((c) => c[0] === "tmux")).toBe(false);
});

test("text for a herdr omo pane gets the aoe checks: a gone or dead pane is named and nothing typed; a live one waits for the prompt, is typed in pieces and submitted", async () => {
  const deps = omo();
  world.herdrGone = ["w1:p3"];
  world.herdrDead = ["w1:p2"];
  expect(await submitToPane(deps.run, deps.clock, deps.config, "w1:p3", "[LEAD] hi")).toMatchObject({ status: "NOT_SUBMITTED", reason: "PANE_GONE: there is no herdr pane w1:p3 (it ended, or the name is wrong); nothing was typed" });
  expect(await submitToPane(deps.run, deps.clock, deps.config, "w1:p2", "[LEAD] hi")).toMatchObject({ status: "NOT_SUBMITTED", reason: "PANE_DEAD: the program in w1:p2 exited (no agent runs in it); nothing was typed" });
  expect(sent(world)).toEqual([]);
  const long = "가".repeat(3000);
  expect((await submitToPane(deps.run, deps.clock, deps.config, "w1:p1", long)).status).toBe("SUBMITTED");
  expect(sent(world).length).toBeGreaterThan(1);
  expect(sent(world).join("")).toBe(long);
});

test("live sessions join aoe's and the herdr server's, and each pane name finds only its own backend's session", async () => {
  world.aoe = [{ id: "8d4297370000", title: "lead", path: "/home/a" }];
  world.tmux = ["aoe_lead_8d429737"];
  world.panes = [{ pane_id: "w1:p4", workspace_id: "w1", cwd: "/home/h" }];
  const sessions = await liveSessions(fakeRunner(world));
  expect(sessionFor(sessions, "aoe_lead_8d429737")?.path).toBe("/home/a");
  expect(sessionFor(sessions, "w1:p4")?.path).toBe("/home/h");
  expect(sessionFor(sessions, "w1:p9")).toBeUndefined();
});

test("closing a herdr session closes its tab when the pane is all it holds, and the line reads as closed", async () => {
  const line = await closeAoeSession(fakeRunner(world), "w1:p4");
  expect(line).toBe("herdr tab w1:t-p4 (w1:p4) stopped and closed");
  expect(isClosedLine(line)).toBe(true);
  expect(world.calls.at(-1)).toEqual(["herdr", "tab", "close", "w1:t-p4"]);
  world.herdrGone = ["w1:p5"];
  expect(isClosedLine(await closeAoeSession(fakeRunner(world), "w1:p5"))).toBe(false);
});

test("a herdr pane's activity comes from its screen; a pane with no agent is left out", async () => {
  world.herdrDead = ["w1:p2"];
  world.screens = { "w1:p1": `${RUNNING}\n❯ `, "w1:p3": "❯ \n ◉ watching 1: ci" };
  expect([...(await paneActivity(fakeRunner(world), ["w1:p1", "w1:p2", "w1:p3"]))]).toEqual([["w1:p1", "busy"], ["w1:p3", "running"]]);
});

test("a session opened on a fresh herdr server, which has no workspace yet, gets one first", async () => {
  const calls: string[][] = [];
  let made = false;
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    if (argv[1] === "tab" && argv[2] === "create") return made ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w1:p2", tab_id: "w1:t2" } } }), err: "" } : { code: 1, out: JSON.stringify({ error: { code: "workspace_not_found", message: "no active workspace" } }), err: "" };
    if (argv[1] === "workspace" && argv[2] === "create") return (made = true), { code: 0, out: JSON.stringify({ result: { workspace: { workspace_id: "w1" } } }), err: "" };
    if (argv[2] === "read") return { code: 0, out: "$ ", err: "" };
    return fakeRunner(world)(argv);
  };
  expect(await openHerdrSession(run, fakeClock(0), { title: "lane", cwd: "/tmp", argv: ["omo"] })).toEqual({ pane: "w1:p2", tab: "w1:t2" });
  expect(calls.filter((c) => c[2] === "create").map((c) => c.slice(1, 5))).toEqual([["tab", "create", "--cwd", "/tmp"], ["workspace", "create", "--label", "dori"], ["tab", "create", "--workspace", "w1"]]);
});


test("while a Dori moves (config herdr), its aoe lanes keep going through tmux: screen, shell pid and close", async () => {
  const deps = omo();
  world.aoe = [{ id: "abcdef0011223344", title: "old", path: "/repo" }];
  world.tmux = ["aoe_old_abcdef00"];
  await readScreen(deps.run, "herdr", "aoe_old_abcdef00");
  await shellPidOf("aoe_old_abcdef00", { run: deps.run, sessionsDir: dir, backend: "herdr" });
  expect(world.calls.filter((c) => c[0] === "herdr").map((c) => c.slice(1, 3).join(" "))).toEqual([]);
  expect(world.calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["tmux capture-pane", "tmux display-message"]);
  await Bun.write(join(dir, "done"), "ok");
  await deps.registry.write({ key: "old", title: "old", thread: "none", brief: "/b", done: `file ${join(dir, "done")}`, openedAt: "2026-01-01T00:00:00Z", pane: "aoe_old_abcdef00", status: "working" });
  await closeLane({ ...deps, exists: () => true }, (await deps.registry.read("old"))!, "QA");
  expect(world.calls.filter((c) => c[0] === "aoe" && (c[1] === "rm" || c[1] === "session")).map((c) => c.slice(0, 3).join(" "))).toEqual(["aoe session stop", "aoe rm abcdef0011223344"]);
  expect(world.calls.some((c) => c[0] === "herdr" && c[2] === "close")).toBe(false);
});

test("launch on a fresh herdr server (no workspace yet) opens the lane in a workspace it made", async () => {
  const brief = join(dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const deps = omo({ agentCommand: ["claude", "{prompt}"] });
  const base = deps.run;
  let made = false;
  const r = await launchLane({ ...deps, readGoal: async () => ({ status: "active" }), run: async (argv, o) => {
    if (argv[1] === "tab" && argv[2] === "create") return made ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w1:p2", tab_id: "w1:t2" } } }), err: "" } : { code: 1, out: JSON.stringify({ error: { code: "workspace_not_found" } }), err: "" };
    if (argv[1] === "workspace" && argv[2] === "create") return (made = true), { code: 0, out: JSON.stringify({ result: { workspace: { workspace_id: "w1" } } }), err: "" };
    return base(argv, o);
  } }, { noThread: "QA", key: "fresh", title: "fresh", brief, done: "file /x", cwd: "/tmp" });
  expect(r.lane).toMatchObject({ pane: "w1:p2", tab: "w1:t2" });
});


test("under a herdr config a tmux session of any name (no aoe_ prefix) still goes to tmux: screen and shell pid", async () => {
  const deps = omo();
  await readScreen(deps.run, "herdr", "lead");
  await shellPidOf("lead", { run: deps.run, sessionsDir: dir, backend: "herdr" });
  expect(world.calls.some((c) => c[0] === "herdr")).toBe(false);
  expect(world.calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["tmux capture-pane", "tmux display-message"]);
});

test("a herdr launch of an agent that is no omo needs no node: it starts with the server's PATH", async () => {
  const brief = join(dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  const deps = omo({ agentCommand: ["claude", "{prompt}"] });
  const path = process.env.PATH;
  const nvm = process.env.NVM_DIR;
  process.env.PATH = "/nonexistent";
  process.env.NVM_DIR = join(dir, "no-nvm");
  try {
    const base = deps.run;
    const run: Runner = async (argv, o) => (argv[1] === "tab" && argv[2] === "create" ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w1:p3", tab_id: "w1:t3" } } }), err: "" } : base(argv, o));
    const r = await launchLane({ ...deps, run, readGoal: async () => ({ status: "active" }) }, { noThread: "QA", key: "nonode", title: "nonode", brief, done: "file /x", cwd: "/tmp" });
    expect(r.startup).not.toContain("NO_NODE");
    expect(world.calls.find((c) => c[2] === "run")?.[4] ?? "").not.toContain("PATH=");
  } finally {
    process.env.PATH = path;
    if (nvm === undefined) delete process.env.NVM_DIR;
    else process.env.NVM_DIR = nvm;
  }
});

test("the agent of a herdr lane keyed mcp-fix (its prompt on the command line) is found for handover, freeze and its session", async () => {
  const table = [
    { pid: 4000, ppid: 1, cmd: "-bash", stat: "S" },
    { pid: 4001, ppid: 4000, cmd: "omo --session-id 11111111-2222-4333-8444-555555555555 --model m ulw. Read the lane brief at /tmp/mcp.md. You are the mcp-fix lane", stat: "S" },
    { pid: 4002, ppid: 4001, cmd: "bun /x/mcp-server.js", stat: "S" },
  ];
  expect(topAgent(table, 4000)?.pid).toBe(4001);
  expect(localChains(table, 4000, []).agent?.pid).toBe(4001);
  expect(agentTree(table, 4000, 999).agent?.pid).toBe(4001);
  const run: Runner = async (argv) => ({ code: 0, out: argv[2] === "process-info" ? JSON.stringify({ result: { process_info: { shell_pid: 4000 } } }) : "", err: "" });
  expect((await resolveSession("w1:p1", "/tmp", table, { run, sessionsDir: dir, backend: "herdr" })).id).toBe("11111111-2222-4333-8444-555555555555");
});

test("upstream #66/#70 on herdr: an omo pane with a question open, and a bare-agent pane with only its shell or a blocked agent, get nothing", async () => {
  const deps = omo();
  world.screens = { "w1:p1": "Ask user · Which one?\n❯ " };
  const q = await submitToPane(deps.run, deps.clock, deps.config, "w1:p1", "[LEAD] hi");
  expect((q as { reason: string }).reason).toStartWith("PANE_BLOCKED: a question is open in w1:p1");
  const bare = omo({ agentCommand: ["claude", "{prompt}"] });
  const pane = (p: Record<string, unknown>): Runner => async (argv, o) => (argv[2] === "get" ? { code: 0, out: JSON.stringify({ result: { pane: { pane_id: "w1:p2", ...p } } }), err: "" } : fakeRunner(world)(argv, o));
  const shell = await submitToPane(pane({}), bare.clock, bare.config, "w1:p2", "rm -rf /tmp/x");
  expect((shell as { reason: string }).reason).toStartWith("PANE_DEAD: no agent runs in w1:p2");
  const blocked = await submitToPane(pane({ agent: "claude", agent_status: "blocked" }), bare.clock, bare.config, "w1:p2", "yes");
  expect((blocked as { reason: string }).reason).toStartWith("PANE_BLOCKED: the agent in w1:p2 waits on a confirmation");
  expect(sent(world)).toEqual([]);
});

// upstream dori-superagent #69 (https://github.com/sisyphuslabs/dori-superagent/pull/69): herdr keeps calling an agent
// suspended with Ctrl+Z idle while its shell is in front, and that shell would run the text as a command
test("upstream #69 on herdr: a bare-agent pane with a shell in front (sh -c included), an unreadable or empty foreground, or an agent in no running state gets nothing; an agent alone in front is typed into", async () => {
  const bare = omo({ agentCommand: ["claude", "{prompt}"] });
  const pane = (p: Record<string, unknown> = {}): Runner => async (argv, o) => (argv[2] === "get" ? { code: 0, out: JSON.stringify({ result: { pane: { pane_id: "w1:p2", agent: "claude", agent_status: "idle", ...p } } }), err: "" } : fakeRunner(world)(argv, o));
  const submit = (p?: Record<string, unknown>) => submitToPane(pane(p), bare.clock, bare.config, "w1:p2", "rm -rf /tmp/x");
  world.herdrFront = { "w1:p2": [{ name: "zsh", argv: ["-zsh"] }] };
  expect(await submit()).toMatchObject({ status: "NOT_SUBMITTED", reason: "the agent in w1:p2 is not in front: a shell (zsh) is, after the agent exited or was suspended with Ctrl+Z, or as its child, and it could run the text; nothing was typed" });
  world.herdrFront = { "w1:p2": [{ name: "claude", argv: ["claude"] }, { name: "bash", argv: ["bash", "-c", "while read -r l; do eval \"$l\"; done"] }] };
  expect((await submit()).status).toBe("NOT_SUBMITTED");
  world.herdrFront = { "w1:p2": [] };
  expect(await submit()).toMatchObject({ status: "NOT_SUBMITTED", reason: "herdr pane process-info shows nothing readable in front of w1:p2, so a shell in front cannot be ruled out; nothing was typed" });
  world.herdrFront = { "w1:p2": [{ name: "claude", argv: ["claude"] }, {}] };
  expect((await submit()).status).toBe("NOT_SUBMITTED");
  world.herdrFront = { "w1:p2": null };
  expect(await submit()).toMatchObject({ status: "NOT_SUBMITTED", reason: "herdr pane process-info could not be read for w1:p2, so a shell in front cannot be ruled out; nothing was typed" });
  world.herdrFront = { "w1:p2": [{ name: "claude", argv: ["claude"] }] };
  expect(await submit({ agent_status: "unknown" })).toMatchObject({ status: "NOT_SUBMITTED", reason: "the agent in w1:p2 is in state unknown, not idle, working, blocked or done, so it may not be reading; nothing was typed" });
  expect(sent(world)).toEqual([]);
  expect(world.calls.filter((c) => c[2] === "send-keys")).toEqual([]);
  await submit();
  expect(sent(world)).toEqual(["rm -rf /tmp/x"]);
});

// upstream #69's table from its test/herdr.test.ts, and the cases reviews 1-3 of #347 and the dori challenge of its plan
// raised. Upstream lets a shell running a command (-c, -lc, pwsh -Command, -File) through; here every shell in front
// holds, since its command line proves nothing about who reads the input.
test.each([
  ["login shell", [{ name: "-bash", argv: ["-bash"] }], true],
  ["interactive zsh by path, upper case", [{ name: "/bin/ZSH", argv: ["/bin/zsh", "-i"] }], true],
  ["busybox sh applet", [{ name: "busybox", argv: ["busybox", "sh"] }], true],
  ["shell entry without argv", [{ name: "fish" }], true],
  ["bash --rcfile FILE", [{ name: "bash", argv: ["bash", "--rcfile", "/tmp/rc"] }], true],
  ["zsh -oemacs -i (review 3)", [{ name: "zsh", argv: ["zsh", "-oemacs", "-i"] }], true],
  ["fish -C cmd", [{ name: "fish", argv: ["fish", "-C", "set x 1"] }], true],
  ["pwsh -NoExit -Command", [{ name: "pwsh", argv: ["pwsh", "-NoExit", "-Command", "ls"] }], true],
  ["pwsh -NoEx -Command (review 2)", [{ name: "pwsh", argv: ["pwsh", "-NoEx", "-Command", "ls"] }], true],
  // upstream dori-superagent #94 (https://github.com/sisyphuslabs/dori-superagent/pull/94, issue #93): its keepsPrompt
  // matched only -noe and -noexit; every other prefix PowerShell takes for -NoExit, with one or two dashes, also keeps a
  // prompt. Here they hold without that list, as every shell in front does.
  ["pwsh -noex -c keeps a prompt (upstream #94)", [{ name: "pwsh", argv: ["pwsh", "-noex", "-c", "ls"] }], true],
  ["pwsh --noexi -Command keeps a prompt (upstream #94)", [{ name: "pwsh", argv: ["pwsh", "--noexi", "-Command", "ls"] }], true],
  ["pwsh -File - (review 1)", [{ name: "pwsh", argv: ["pwsh", "-File", "-"] }], true],
  ["cmd /k cmd /c (review 2)", [{ name: "cmd.exe", argv: ["cmd.exe", "/k", "cmd", "/c", "echo ready"] }], true],
  ["pwsh.exe by Windows path (review 1)", [{ name: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", argv: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe"] }], true],
  ["cmd.exe prompt", [{ name: "cmd.exe", argv: ["C:\\Windows\\System32\\cmd.exe"] }], true],
  ["agent with a sh -c child: held, upstream delivers", [{ name: "omo", argv: ["omo"] }, { name: "sh", argv: ["sh", "-c", "sleep 1"] }], true],
  ["bash -lc make: held, upstream delivers", [{ name: "bash", argv: ["bash", "-lc", "make"] }], true],
  ["pwsh -Command ls: held, upstream delivers", [{ name: "pwsh", argv: ["pwsh", "-Command", "ls"] }], true],
  ["cmd /c dir: held", [{ name: "cmd.exe", argv: ["cmd.exe", "/C", "dir"] }], true],
  ["bash -c read/eval loop (challenge)", [{ name: "bash", argv: ["bash", "-c", "while read -r l; do eval \"$l\"; done"] }], true],
  ["a shell by argv[0] under another name", [{ name: "x", argv: ["/bin/bash"] }], true],
  ["an empty foreground group is doubt", [], true],
  ["an entry with no name is doubt (challenge)", [{ name: "omo", argv: ["omo"] }, {}], true],
  ["exec'd agent", [{ name: "bun", argv: ["bun", "omo.js"] }], false],
  ["agent with a non-shell child", [{ name: "claude", argv: ["claude"] }, { name: "git", argv: ["git", "status"] }], false],
] as const)("interactiveShellInFront (upstream #69): %s", (_, procs, want) => {
  expect(interactiveShellInFront({ foreground_processes: procs })).toBe(want);
});

test("on herdr, /goal pause that empties the box with no turn is SUBMITTED in an omo pane only: another agent may take it as a prompt", async () => {
  world.screens = { "w1:p2": ["transcript", "─".repeat(40), "❯ ", "─".repeat(40), " ~/repo"].join("\n") };
  // the box empties and no turn starts, as with a command omo runs itself
  const noTurn = (run: Runner): Runner => async (argv, o) => { const r = await run(argv, o); world.started = []; return r; };
  const bare = omo({ agentCommand: ["claude", "{prompt}"] });
  const other = await submitToPane(noTurn(bare.run), bare.clock, bare.config, "w1:p2", "/goal pause");
  expect(other.status).toBe("NOT_SUBMITTED");
  expect(other.reason).toStartWith("input box empty but no running turn");
  const deps = omo();
  const own = await submitToPane(noTurn(deps.run), deps.clock, deps.config, "w1:p2", "/goal pause");
  expect(own).toMatchObject({ status: "SUBMITTED", reason: "input box empty: omo took the command from it to run it" });
  expect(sent(world)).toEqual(["/goal pause", "/goal pause"]);
});

test("a handover's new herdr session keeps agentCommand's own options, opens a new session and runs the handover's model and thinking", () => {
  const argv = herdrAgentArgv(["omo", "--session-dir", "/s", "--model", "{model}", "{prompt}"], "m/x", "high");
  expect(argv.slice(0, 2)).toEqual(["omo", "--session-id"]);
  expect(argv[2]).toMatch(/^[0-9a-f-]{36}$/);
  expect(argv.slice(3)).toEqual(["--session-dir", "/s", "--model", "m/x", "--thinking", "high"]);
  // a literal model and a thinking of the template give way, in either flag form (a session selector is refused earlier)
  for (const t of [["omo", "--model", "a/old", "--thinking", "low"], ["omo", "--model=a/old", "--thinking=low"]]) expect(herdrAgentArgv(t, "b/new", "high").slice(3)).toEqual(["--model", "b/new", "--thinking", "high"]);
});

test("recovery and the verify rollback count a herdr pane with only its shell left as gone, not as the old session to go back to", async () => {
  world.herdrDead = ["w1:p1"];
  const run = fakeRunner(world);
  expect(await agentAlive(run, [], "w1:p1")).toBe(false);
  expect(await agentAlive(run, [], "w1:p2")).toBe(true);
});

test("a herdr pane whose agent ended is checked for its dead marker though its screen still shows the old ❯ prompt", async () => {
  const deps = omo({ deadPanePatterns: ["process exited"], workspaces: [] });
  world.panes = [{ pane_id: "w1:p5", workspace_id: "w1", cwd: dir }];
  world.herdrDead = ["w1:p5"];
  world.screens = { "w1:p5": "────────\n❯ \n────────\nprocess exited" };
  const seen = new Set<string>();
  const state = newDeadPaneState();
  await deadPaneTick(deps.run, deps.config, seen, "h1", [], state);
  const lines = await deadPaneTick(deps.run, deps.config, seen, "h1", [], state);
  expect(lines.join("\n")).toContain("w1:p5");
});

import { mkdtempSync, rmSync } from "node:fs";
import { sessionPath, withPi } from "../src/aoe.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DoriConfig, defaultConfig } from "../src/config.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { Registry } from "../src/registry.ts";
import type { Clock, Ran, Runner } from "../src/run.ts";

// A launch adds nvm's node and the agent's pi to the PATH aoe add runs with when the caller's PATH lacks them (a systemd
// unit's bare PATH, as dori watch runs a lane's Done command). A test that checks what aoe add got sets PATH to what the
// launch would make, so the result does not hang on the PATH of the shell that runs it; the returned function restores it.
export const launchReadyPath = (): (() => void) => {
  const caller = process.env.PATH;
  const p = caller ?? "";
  process.env.PATH = withPi(sessionPath(p, process.env.NVM_DIR || join(process.env.HOME ?? "", ".nvm")) ?? p, "omo");
  return () => {
    process.env.PATH = caller;
  };
};

export type World = {
  prState: string;
  issueState: string;
  aheadCount: string;
  dirty: string;
  // per checkout path (git -C <path>): its own status / ahead answer, over dirty and aheadCount
  dirtyIn?: Record<string, string>;
  aheadIn?: Record<string, string>;
  // git worktree list --porcelain as the lane's repo prints it (default: /repo on main plus the lane's own worktree)
  worktreeList?: string;
  // false: the checked path is no git checkout, and every git -C there fails as git would
  inGit?: boolean;
  // set: git rev-parse fails with this stderr (a repository git cannot read, not a missing one)
  revParseErr?: string;
  stuckReads: number;
  screen: string;
  screens: Record<string, string>;
  aoePs: { session: string; state: string }[];
  panes: { pane_id: string; workspace_id: string; agent?: string; title?: string; cwd?: string }[];
  aoe: { id: string; title: string; path: string; tool?: string; profile?: string }[];
  tmux: string[];
  calls: string[][];
  // panes that got an Enter: their next screen read shows a running turn, the one after it does not
  started: string[];
  // tmux's update-environment option, the env each aoe add ran with, and the session env tmux built from it
  // (dropEnv: tmux carries nothing over, as before update-environment named the variables)
  updateEnv: string[];
  aoeEnv: (Readonly<Record<string, string | undefined>> | undefined)[];
  sessionEnv: Record<string, Record<string, string | undefined>>;
  dropEnv: boolean;
  // ps -A -o pid=,ppid=,command= ("pid ppid command" lines; asked with stat= the fake adds state S, as the host prints it)
  // and ps -o lstart= (the agent's start) as the host would print them
  ps: string;
  agentStart: string;
  // herdr panes the fake server does not have (pane get fails), and those where no agent runs any more (a bare shell)
  herdrGone?: string[];
  herdrDead?: string[];
  // herdr pane run starts the agent (it leaves herdrDead and draws its own screen) unless herdrNoStart
  herdrNoStart?: boolean;
};

export const RUNNING = " • Working (esc to interrupt)";

export const NEW_AOE_ID = "5e5e5e5e00aa11bb";

export const WT = "/repo/.wt/demo-lane";

export const newWorld = (): World => ({ prState: "MERGED", issueState: "CLOSED", aheadCount: "0", dirty: "", stuckReads: 0, screen: "❯ ", screens: {}, aoePs: [], panes: [], aoe: [], tmux: [], calls: [], started: [], updateEnv: ["DISPLAY", "SSH_AUTH_SOCK"], aoeEnv: [], sessionEnv: {}, dropEnv: false, ps: "", agentStart: "" });

export const fakeRunner = (w: World): Runner => async (argv, opts) => {
  w.calls.push([...argv]);
  const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
  const [cmd, a1, a2] = argv;
  if ((cmd === "herdr" && a1 === "pane" && a2 === "read") || (cmd === "tmux" && a1 === "capture-pane")) {
    if (w.stuckReads > 0) {
      w.stuckReads--;
      return ok("❯ [LEAD] stuck text still here");
    }
    const pane = cmd === "tmux" ? (argv[argv.indexOf("-t") + 1] ?? "").replace(/^=|:$/g, "") : (a2 === "read" ? argv[3] : "") ?? "";
    const screen = w.screens[pane] ?? w.screen;
    if (!w.started.includes(pane)) return ok(screen);
    w.started = w.started.filter((p) => p !== pane);
    // omo draws the running turn right above its input box, above the status lines under it
    const lines = screen.split("\n");
    const top = lines.flatMap((l, i) => (l.trimStart().startsWith("─") ? [i] : [])).at(-2);
    return ok(top === undefined ? `${screen}\n${RUNNING}` : [...lines.slice(0, top), RUNNING, ...lines.slice(top)].join("\n"));
  }
  if (cmd === "tmux" && a1 === "send-keys" && argv.at(-1) === "Enter") w.started.push((argv[argv.indexOf("-t") + 1] ?? "").replace(/^=|:$/g, ""));
  if (cmd === "herdr" && a1 === "pane" && a2 === "send-keys" && argv.at(-1) === "enter") w.started.push(argv[3] ?? "");
  if (cmd === "herdr" && a1 === "pane" && a2 === "run" && !w.herdrNoStart) {
    const pane = argv[3] ?? "";
    w.herdrDead = w.herdrDead?.filter((p) => p !== pane);
    w.screens[pane] = "omo · session started\n────────\n❯ \n────────";
  }
  if (cmd === "herdr" && a1 === "pane" && a2 === "list") return ok(JSON.stringify({ result: { panes: w.panes } }));
  if (cmd === "herdr" && a1 === "pane" && (a2 === "get" || a2 === "process-info")) {
    const pane = (a2 === "get" ? argv[3] : argv[argv.indexOf("--pane") + 1]) ?? "";
    if (w.herdrGone?.includes(pane)) return { code: 1, out: JSON.stringify({ error: { code: "pane_not_found", message: `pane ${pane} not found` } }), err: "" };
    // herdr names the agent it detects in a pane and leaves the field out over a bare shell
    if (a2 === "get") return ok(JSON.stringify({ result: { pane: { pane_id: pane, tab_id: `${pane.split(":")[0]}:t-${pane.split(":")[1] ?? ""}`, ...(w.herdrDead?.includes(pane) ? {} : { agent: "claude", agent_status: "idle" }) } } }));
    const fg = w.herdrDead?.includes(pane) ? [{ pid: 4000, cmdline: "-bash" }] : [{ pid: 4001, cmdline: "omo --model m" }];
    return ok(JSON.stringify({ result: { process_info: { pane_id: pane, shell_pid: 4000, foreground_processes: fg } } }));
  }
  if (cmd === "herdr" && a1 === "tab" && a2 === "get") return ok(JSON.stringify({ result: { tab: { tab_id: argv[3], pane_count: 1 } } }));
  if (cmd === "herdr") return ok();
  if (cmd === "aoe" && a1 === "list") return ok(JSON.stringify(w.aoe));
  if (cmd === "aoe" && a1 === "ps") return ok(JSON.stringify(w.aoePs));
  if (cmd === "aoe" && a1 === "add") {
    const title = argv[argv.indexOf("-t") + 1] ?? "";
    const name = `aoe_${title}_${NEW_AOE_ID.slice(0, 8)}`;
    w.aoe.push({ id: NEW_AOE_ID, title, path: a2 ?? "", tool: "omo", profile: "main" });
    w.tmux.push(name);
    w.aoeEnv.push(opts?.env);
    w.sessionEnv[name] = w.dropEnv ? {} : Object.fromEntries(w.updateEnv.map((n) => [n, opts?.env?.[n]]));
    return ok();
  }
  if (cmd === "tmux" && a1 === "show-options" && argv.at(-1) === "update-environment") return ok(w.updateEnv.join("\n"));
  if (cmd === "tmux" && a1 === "set-option" && argv.includes("update-environment")) {
    w.updateEnv.push(argv.at(-1) ?? "");
    return ok();
  }
  if (cmd === "tmux" && a1 === "show-environment") {
    const name = argv.at(-1) ?? "";
    const value = w.sessionEnv[(argv[argv.indexOf("-t") + 1] ?? "").replace(/^=/, "")]?.[name];
    return value === undefined ? { code: 1, out: "", err: `unknown variable: ${name}` } : ok(`${name}=${value}`);
  }
  if (cmd === "aoe") return ok();
  if (cmd === "tmux" && a1 === "ls") return ok(w.tmux.join("\n"));
  if (cmd === "tmux" && a1 === "display-message") return ok("10");
  if (cmd === "tmux") return ok();
  if (cmd === "git" && w.inGit === false) return { code: 128, out: "", err: "fatal: not a git repository (or any of the parent directories): .git" };
  if (cmd === "git" && argv.includes("worktree") && argv.includes("list")) return ok(w.worktreeList ?? `worktree /repo\nbranch refs/heads/main\n\nworktree ${WT}\nbranch refs/heads/demo-lane`);
  if (cmd === "git" && argv.includes("rev-parse") && w.revParseErr) return { code: 128, out: "", err: w.revParseErr };
  if (cmd === "git" && argv.includes("rev-parse") && argv.includes("--is-inside-work-tree")) return ok("true\n");
  if (cmd === "git" && argv.includes("status")) return ok(w.dirtyIn?.[argv[2] ?? ""] ?? w.dirty);
  if (cmd === "git" && argv.includes("rev-list")) return ok(w.aheadIn?.[argv[2] ?? ""] ?? w.aheadCount);
  if (cmd === "git" && argv[3] === "remote" && argv.length === 4) return ok("origin\n");
  if (cmd === "git") return ok();
  if (cmd === "gh" && a1 === "pr") return ok(JSON.stringify({ state: w.prState, headRefOid: "f".repeat(40), mergedAt: w.prState === "MERGED" ? "2026-01-01T11:00:00Z" : null, mergeCommit: w.prState === "MERGED" ? { oid: "abc1234567890" } : null }));
  if (cmd === "gh" && a1 === "issue") return ok(JSON.stringify({ state: w.issueState }));
  if (cmd === "notify") return ok();
  if (cmd === "pwsh" && argv.includes("$PSVersionTable.PSVersion.ToString()")) return ok("7.4.0");
  if (cmd === "powershell" && argv.includes("-Command")) return ok(JSON.stringify([
    { ProcessId: 4000, ParentProcessId: 1, CommandLine: "pwsh.exe", ExecutablePath: "pwsh" },
    ...w.ps.split("\n").flatMap((line) => {
    const row = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return row && Number(row[1]) !== 4000 ? [{ ProcessId: Number(row[1]), ParentProcessId: Number(row[2]), CommandLine: row[3] ?? "" }] : [];
  })]));
  if (cmd === "ps" && a1 === "-A") return ok(argv.some((a) => a.includes("stat=")) ? w.ps.replace(/^(\s*\d+\s+\d+)\s+/gm, "$1 S+ ") : w.ps);
  if (cmd === "ps" && argv.includes("lstart=")) return ok(w.agentStart);
  return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` };
};

export const fakeClock = (start: number): Clock & { at: number } => {
  const c = { at: start, now: () => c.at, sleep: async () => {} };
  return c;
};

export const withState = (): { dir: string; done: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "dori-test-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
};

export const depsFor = (w: World, clock: Clock, stateDir: string, patch: Partial<DoriConfig> = {}): FlowDeps => {
  // no directive ledger unless a test asks for one (directives.test.ts): other tests launch briefs without the four fields
  const config: DoriConfig = { ...defaultConfig("/home/test"), stateDir, watchLog: join(stateDir, "lanes.log"), defaultCwd: "/repo", leadPane: "lead:p1", directives: { common: "", local: "" }, ...patch };
  return { run: fakeRunner(w), clock, registry: new Registry(stateDir), config, exists: () => true };
};

export const sent = (w: World): string[] => w.calls.flatMap((c) => (c[0] === "herdr" && c[2] === "send-text" ? [c[4] ?? ""] : c[0] === "tmux" && c[1] === "send-keys" && c.includes("-l") ? [c.at(-1) ?? ""] : []));

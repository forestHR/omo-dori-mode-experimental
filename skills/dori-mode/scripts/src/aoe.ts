import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { Pane } from "./panes.ts";
import type { Clock, Runner } from "./run.ts";
import { turnRunning } from "./submit.ts";

export type AoeSession = { readonly id: string; readonly title: string; readonly path: string; readonly tool?: string; readonly profile?: string };

// "=name:" makes tmux match the session name exactly instead of by prefix
export const target = (name: string): string => `=${name}:`;

export const aoeSessions = async (run: Runner): Promise<AoeSession[]> => {
  const r = await run(["aoe", "list", "--json", "--state", "live"]);
  if (r.code !== 0) throw new Error(`aoe list failed: ${r.err || r.out}`);
  return JSON.parse(r.out) as AoeSession[];
};

const tmuxNames = async (run: Runner): Promise<string[]> => {
  const r = await run(["tmux", "ls", "-F", "#S"]);
  return r.code === 0 ? r.out.split("\n").filter(Boolean) : [];
};

const suffixOf = (s: AoeSession): string => `_${s.id.slice(0, 8)}`;

export const tmuxNameFor = (s: AoeSession, names: readonly string[]): string | undefined =>
  names.find((n) => n === `aoe_${s.title}${suffixOf(s)}`) ?? names.find((n) => n.startsWith("aoe_") && !n.startsWith("aoe_term_") && n.endsWith(suffixOf(s)));

export const listAoePanes = async (run: Runner): Promise<Pane[]> => {
  const sessions = await aoeSessions(run);
  const names = await tmuxNames(run);
  return sessions.flatMap((s) => {
    const name = tmuxNameFor(s, names);
    return name ? [{ pane_id: name, workspace_id: s.profile ?? "aoe", agent: s.tool, title: s.title, cwd: s.path }] : [];
  });
};

export const sessionFor = (sessions: readonly AoeSession[], pane: string): AoeSession | undefined =>
  sessions.find((s) => pane === `aoe_${s.title}${suffixOf(s)}`) ?? sessions.find((s) => pane.endsWith(suffixOf(s)));

const idFor = (sessions: readonly AoeSession[], pane: string): string | undefined => sessionFor(sessions, pane)?.id;

export const aoeIdFor = async (run: Runner, pane: string): Promise<string | undefined> => idFor(await aoeSessions(run), pane);

// aoe's runtime state per session id: idle, running, waiting (a question or approval is open) or error
export const aoeStates = async (run: Runner): Promise<Map<string, string>> => {
  const r = await run(["aoe", "ps", "--json"]);
  if (r.code !== 0) throw new Error(`aoe ps failed: ${r.err || r.out}`);
  return new Map((JSON.parse(r.out) as { session: string; state: string }[]).map((p) => [p.session, p.state]));
};

// omo prints "esc to interrupt" while its main turn runs, on its input box's top border (turnRunning reads only there: the
// status lines under the box may quote the words in the cwd, session title or goal objective). Between turns its status line shows what will wake it:
// a monitor ("◉ watching ..."), wake sources on duty, a scheduled goal continuation, an active goal.
// aoe's state lags behind all of these, and shows an open omo question ("Ask user · ...") as idle.
export const BUSY_MARK = "esc to interrupt";
export const WAKE_MARKS = ["◉ watching", "wake source", "goal continues in", "Pursuing goal"];
export const QUESTION_MARK = /Ask user ·|\(\d+\/\d+ answered\)/;

export type Activity = "busy" | "running" | "waiting" | "error" | "question" | "idle";

// What each live pane's agent is doing, from aoe ps plus its screen. Panes aoe does not list are left out.
export const paneActivity = async (run: Runner, panes: readonly string[]): Promise<Map<string, Activity>> => {
  const out = new Map<string, Activity>();
  if (!panes.length) return out;
  const [sessions, states] = await Promise.all([aoeSessions(run), aoeStates(run)]);
  for (const pane of panes) {
    const id = idFor(sessions, pane);
    const state = id ? states.get(id) : undefined;
    if (!state) continue;
    const screen = await captureTmux(run, pane);
    if (turnRunning(screen)) out.set(pane, "busy");
    else if (state === "waiting" || state === "error") out.set(pane, state);
    else if (QUESTION_MARK.test(screen)) out.set(pane, "question");
    else if (WAKE_MARKS.some((m) => screen.includes(m))) out.set(pane, "running");
    else out.set(pane, state === "idle" ? "idle" : "running");
  }
  return out;
};

export const captureTmux = async (run: Runner, pane: string, lines?: number): Promise<string> => {
  const out = (await run(["tmux", "capture-pane", "-p", "-J", "-t", target(pane), ...(lines ? ["-S", `-${lines}`] : [])])).out;
  return lines ? out.split("\n").slice(-lines).join("\n") : out;
};

export type PaneLife = { readonly live: true } | { readonly live: false; readonly how: "gone" } | { readonly live: false; readonly how: "dead"; readonly status: number };

// gone: no tmux session of that name; dead: the session is there, its pane's program exited (remain-on-exit)
export const paneLife = async (run: Runner, pane: string): Promise<PaneLife> => {
  if ((await run(["tmux", "has-session", "-t", `=${pane}`])).code !== 0) return { live: false, how: "gone" };
  const r = await run(["tmux", "display-message", "-p", "-t", `=${pane}:`, "#{pane_dead} #{pane_dead_status}"]);
  const [dead = "", status = ""] = r.out.trim().split(" ");
  return r.code === 0 && dead === "1" ? { live: false, how: "dead", status: Number(status) } : { live: true };
};

export const tmuxPanePid = async (run: Runner, pane: string): Promise<number> => {
  const r = await run(["tmux", "display-message", "-p", "-t", target(pane), "#{pane_pid}"]);
  return r.code === 0 ? Number(r.out.trim()) || 0 : 0;
};

// omo's input line is the last line starting with ❯; transcript lines above it are not input
export const inputLine = (screen: string): string | undefined => screen.split("\n").findLast((l) => l.trimStart().startsWith("❯"));

export const waitForPrompt = async (run: Runner, clock: Clock, pane: string, tries: number, everyMs: number): Promise<boolean> => {
  for (let i = 0; i < tries; i++) {
    if (inputLine(await captureTmux(run, pane)) !== undefined) return true;
    await clock.sleep(everyMs);
  }
  return false;
};

export class AoeError extends Error {}

// What a lane's session starts with: config launchEnv, or for a lane launched with --use-gpu none of its keys (an
// undefined value removes the variable, so a caller that has it does not hand it on). {} when launchEnv is empty.
export const laneEnv = (launchEnv: Readonly<Record<string, string>>, useGpu: boolean | undefined): Record<string, string | undefined> =>
  Object.fromEntries(Object.keys(launchEnv).map((name) => [name, useGpu ? undefined : launchEnv[name]]));

// aoe does not pass its own environment to the session it opens: tmux copies only the variables named in its
// update-environment option from the client (aoe add, aoe session restart) into the new session. Each name goes in once;
// a client without the variable then leaves it out of the session.
export const forwardEnv = async (run: Runner, names: readonly string[]): Promise<void> => {
  if (!names.length) return;
  const shown = await run(["tmux", "show-options", "-gv", "update-environment"]);
  if (shown.code !== 0) throw new AoeError(`tmux update-environment unreadable (${shown.err || shown.out}); the session would start without launchEnv`);
  const have = new Set(shown.out.split("\n").map((l) => l.trim()));
  for (const name of names.filter((n) => !have.has(n))) {
    const set = await run(["tmux", "set-option", "-g", "-a", "update-environment", name]);
    if (set.code !== 0) throw new AoeError(`tmux update-environment could not take ${name} (${set.err || set.out}); the session would start without launchEnv`);
  }
};

// The launchEnv variables a session did not get as asked, as "NAME=want(got)" (empty when all match).
export const envMismatch = async (run: Runner, pane: string, env: Readonly<Record<string, string | undefined>>): Promise<string[]> => {
  const out: string[] = [];
  for (const [name, want] of Object.entries(env)) {
    const r = await run(["tmux", "show-environment", "-t", `=${pane}`, name]);
    const got = r.code === 0 && r.out.startsWith(`${name}=`) ? r.out.slice(name.length + 1) : undefined;
    if (got !== want) out.push(`${name}=${want ?? "(unset)"}(${got ?? "unset"})`);
  }
  return out;
};

const runnable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
};
const newestFirst = (a: string, b: string): number => {
  const [x, y] = [a, b].map((v) => v.replace(/^v/, "").split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((x?.[i] ?? 0) !== (y?.[i] ?? 0)) return (y?.[i] ?? 0) - (x?.[i] ?? 0);
  return 0;
};

// nvm's node bin dir the way setups/discord-aoe/self-restart.sh node_bin() picks it: the default alias (followed through
// lts/* -> lts/<name> -> vX.Y.Z), else the newest installed version; the first whose node is executable wins.
export const nvmNodeBin = (nvmDir: string): string | undefined => {
  let v = "default";
  for (let i = 0; i < 5 && existsSync(join(nvmDir, "alias", v)); i++) v = readFileSync(join(nvmDir, "alias", v), "utf8").replace(/\s/g, "");
  let versions: string[] = [];
  try {
    versions = readdirSync(join(nvmDir, "versions", "node")).filter((n) => n.startsWith("v")).sort(newestFirst);
  } catch {
    return undefined;
  }
  const want = `v${v.replace(/^v/, "")}`;
  return [...versions.filter((n) => n.startsWith(want)), ...versions].map((n) => join(nvmDir, "versions", "node", n, "bin")).find((d) => runnable(join(d, "node")));
};

// The PATH a new session gets. tmux gives a pane the PATH of the client that opened it (aoe add), so a lane launched from
// a systemd unit or timer with a bare PATH had no node, and senpi task's model probe and omo's hooks
// (#!/usr/bin/env node) exited 127 (GongDori 2026-10-26). A PATH whose node is real stays as it is; otherwise nvm's node
// (nvmNodeBin) goes in front of the dir whose node is only a link to bun, or at the end when there is no node, so it
// shadows nothing else; a bun link without nvm stays. undefined: no node anywhere.
export const sessionPath = (path: string, nvmDir: string): string | undefined => {
  const dirs = path.split(":").filter(Boolean);
  const at = dirs.findIndex((d) => runnable(join(d, "node")));
  const isBun = at >= 0 && basename(realpathSync(join(dirs[at] ?? "", "node"))) === "bun";
  if (at >= 0 && !isBun) return path;
  const nvm = nvmNodeBin(nvmDir);
  if (!nvm) return at >= 0 ? path : undefined;
  const cut = at >= 0 ? at : dirs.length;
  return [...dirs.slice(0, cut), nvm, ...dirs.slice(cut).filter((d) => d !== nvm)].join(":");
};

// aoe pins an omo session (it puts --session-id <id> in the agent's command line and remembers the id, so dori launch reads
// the lane's session exactly and a restart resumes that same session) only when a `pi` command is on the PATH aoe add runs
// with. A systemd unit's PATH has none, and a lane its sweeps launched started with no id at all (aoe 1.20.0, 2026-11-02).
// A PATH without pi gets, at its end, the node_modules/.bin that holds the pi of the agent's own install (found walking
// up from the real path of `tool` on that PATH); a PATH that has one, or no such install, stays as it is.
export const withPi = (path: string, tool: string): string => {
  const dirs = path.split(":").filter(Boolean);
  if (dirs.some((d) => runnable(join(d, "pi")))) return path;
  const bin = dirs.map((d) => join(d, tool)).find(runnable);
  if (!bin) return path;
  for (let d = dirname(realpathSync(bin)); d !== dirname(d); d = dirname(d)) {
    const pi = join(d, "node_modules", ".bin", "pi");
    if (runnable(pi)) return [...dirs, dirname(pi)].join(":");
  }
  return path;
};

// aoe add refuses a title+path pair that already exists, even in the trash (aoe rm --purge clears it).
// thinking goes in as its own --thinking flag: omo 5.1.30 can start a session at medium although the model id ends in :high.
// env: laneEnv for the session (see forwardEnv); left out or {} touches neither tmux nor aoe's environment.
// PATH: sessionPath of this process's PATH, with withPi, passed to aoe add only when it differs; no node at all refuses (NO_NODE).
export const openAoeSession = async (run: Runner, clock: Clock, opts: { readonly title: string; readonly cwd: string; readonly tool: string; readonly model: string; readonly thinking?: string; readonly env?: Readonly<Record<string, string | undefined>> }): Promise<string> => {
  const env = opts.env && Object.keys(opts.env).length ? opts.env : undefined;
  const callerPath = process.env.PATH ?? "";
  const nvmDir = process.env.NVM_DIR || join(process.env.HOME ?? "", ".nvm");
  const node = sessionPath(callerPath, nvmDir);
  const path = node === undefined ? undefined : withPi(node, opts.tool);
  if (path === undefined) throw new AoeError(`NO_NODE no node on PATH (${callerPath}) or in ${nvmDir}: the session's senpi task model probe and omo hooks run #!/usr/bin/env node and would exit 127; install node with nvm or put it on the caller's PATH`);
  if (env) await forwardEnv(run, Object.keys(env));
  const addEnv = path === callerPath ? env : { ...env, PATH: path };
  const added = await run(["aoe", "add", opts.cwd, "-t", opts.title, "--tool", opts.tool, "-l", "--extra-args", `--model ${opts.model}${opts.thinking ? ` --thinking ${opts.thinking}` : ""}`], addEnv ? { env: addEnv } : undefined);
  if (added.code !== 0) throw new AoeError(`aoe add failed: ${added.err || added.out}`);
  for (let i = 0; i < 30; i++) {
    const s = (await aoeSessions(run)).find((x) => x.title === opts.title && x.path === opts.cwd);
    const name = s ? tmuxNameFor(s, await tmuxNames(run)) : undefined;
    if (name) return name;
    await clock.sleep(1_000);
  }
  throw new AoeError(`aoe session ${opts.title} has no tmux session after aoe add`);
};

// stop the agent and move the session to the aoe trash (restorable; never --purge here)
export const closeAoeSession = async (run: Runner, pane: string): Promise<string> => {
  const id = await aoeIdFor(run, pane);
  if (!id) return `aoe session for ${pane} not found`;
  const stopped = await run(["aoe", "session", "stop", id]);
  const removed = await run(["aoe", "rm", id]);
  return removed.code === 0 ? `aoe session ${id} (${pane}) stopped and trashed` : `aoe session ${id} not trashed: ${(removed.err || removed.out || stopped.err).slice(0, 160)}`;
};

export const currentTmuxSession = async (run: Runner): Promise<string> => {
  if (!process.env.TMUX) return "";
  const r = await run(["tmux", "display-message", "-p", "#S"]);
  return r.code === 0 ? r.out.trim() : "";
};

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { DoriConfig } from "./config.ts";
import { agentPath, herdrAgentArgv } from "./aoe.ts";
import { agentLine, herdrAgentPid, herdrSessions, herdrShellPid, HerdrShellError, requireHerdrPwsh } from "./herdr.ts";
import type { Clock, Runner } from "./run.ts";
import { splitModel } from "./lane-handover.ts";
import { argvSessionId, descendants, hasSessionSelector, type Proc, procTable, resolveSession, sessionDirFor, winArgv } from "./session-id.ts";

// A herdr server that stops ends every agent in its panes and gives back the same pane ids with fresh shells (herdr 0.9.5,
// measured 2026-11-03), unlike an aoe session, which aoe starts again in its conversation. So the omo session a herdr lead
// runs is kept here while it runs (dori lead, dori watch's lead check), and the lead is started again in that conversation
// from it (reviveHerdr) when its agent is gone. log: the session's log file, when it was found (sessionLog).
export type HerdrSessionRecord = { readonly session: string; readonly cwd: string; readonly model?: string; readonly log?: string; readonly at: string };

const file = (stateDir: string): string => join(stateDir, "herdr-sessions.json");

export const readHerdrSessions = (stateDir: string): Record<string, HerdrSessionRecord> => {
  try {
    return JSON.parse(readFileSync(file(stateDir), "utf8")) as Record<string, HerdrSessionRecord>;
  } catch {
    return {};
  }
};

export const recordHerdrSession = (stateDir: string, pane: string, rec: HerdrSessionRecord): void => {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(file(stateDir), JSON.stringify({ ...readHerdrSessions(stateDir), [pane]: rec }, null, 1), { mode: 0o600 });
};

const modelOf = (cmd: string): string | undefined => {
  const words = cmd.split(/\s+/);
  const at = words.indexOf("--model");
  return at >= 0 ? words[at + 1] : words.find((w) => w.startsWith("--model="))?.slice("--model=".length);
};

const flagValue = (argv: readonly string[], flag: string): string | undefined => {
  const at = argv.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
  return at < 0 ? undefined : argv[at]?.startsWith(`${flag}=`) ? argv[at]?.slice(flag.length + 1) : argv[at + 1];
};

// The log file of session id for an agent started with argv in cwd: its --session <file>, else the file in its own
// --session-dir (omo writes the logs right in it, measured 2026-11-04), else in sessionsDir's folder for cwd. undefined
// when none is there.
export const argvSessionLog = (argv: readonly string[], sessionsDir: string, cwd: string, id: string): string | undefined => {
  const file = flagValue(argv, "--session");
  if (file?.endsWith(`_${id}.jsonl`) && existsSync(resolve(cwd, file))) return resolve(cwd, file);
  const own = flagValue(argv, "--session-dir");
  const dir = own ? resolve(cwd, own) : sessionDirFor(sessionsDir, cwd);
  try {
    const name = readdirSync(dir).find((n) => n.endsWith(`_${id}.jsonl`));
    return name ? join(dir, name) : undefined;
  } catch {
    return undefined;
  }
};

// a child's PI_SESSION_FILE in ps eww: the value runs up to its .jsonl, so a path with spaces stays whole
const ENV_FILE = /(?:^|\s)PI_SESSION_FILE=(.+?\.jsonl)(?=\s|$)/;

// The agent's own arguments with their word boundaries: a Windows command line split as Windows does (winArgv), Linux's
// /proc cmdline when it is the same process the table shows; undefined when they cannot be told (never a whitespace split),
// so on macOS, whose ps loses them, no log is looked for from them (KERN_PROCARGS2 would keep them: docs/follow-ups.md).
const agentArgv = async (run: Runner, pid: number, cmd: string): Promise<string[] | undefined> => {
  if (process.platform === "win32") return winArgv(cmd);
  if (process.platform !== "linux") return undefined;
  const ran = await run(["cat", `/proc/${pid}/cmdline`]);
  if (ran.code !== 0) return undefined;
  const argv = ran.out.split("\0").filter((a, i, all) => a || i < all.length - 1);
  // one word with spaces is a process that rewrote its title, not its arguments
  return argv.length > 1 && argv.join(" ") === cmd.trim() ? argv : undefined;
};

// The log file of session id that the agent at pid runs now: the exact path omo hands its children (PI_SESSION_FILE, read
// as resolveSession reads their PI_SESSION_ID; Windows has no such read; only bash and eval children get it), else what
// the agent's arguments name (argvSessionLog; a --session to another copy of the session goes over the one recorded),
// else the log recorded before for this session (kept): on macOS only the first and the last, the paths known exactly.
export const sessionLog = async (run: Runner, table: readonly Proc[], pid: number, id: string, sessionsDir: string, cwd: string, kept?: string): Promise<string | undefined> => {
  for (const child of process.platform === "win32" ? [] : descendants(table, pid).slice(0, 40)) {
    const file = ENV_FILE.exec((await run(["ps", "eww", "-o", "command=", "-p", String(child.pid)])).out)?.[1];
    if (file?.endsWith(`_${id}.jsonl`) && existsSync(file)) return file;
  }
  const argv = await agentArgv(run, pid, table.find((p) => p.pid === pid)?.cmd ?? "");
  const named = argv ? argvSessionLog(argv, sessionsDir, cwd, id) : undefined;
  if (named) return named;
  return kept?.endsWith(`_${id}.jsonl`) && existsSync(kept) ? kept : undefined;
};

// The model and thinking a session runs now, "<provider>/<model>:<level>", from its log file: omo writes a model_change for
// /model and a thinking_level_change for /thinking (and both at its start), which its command line never shows. undefined
// when the log or those entries cannot be read.
export const sessionModel = (log: string): string | undefined => {
  let text: string;
  try {
    text = readFileSync(log, "utf8");
  } catch {
    return undefined;
  }
  let model: string | undefined;
  let level: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes('"model_change"') && !line.includes('"thinking_level_change"')) continue;
    let e: { type?: unknown; provider?: unknown; modelId?: unknown; thinkingLevel?: unknown };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue;
    }
    if (e.type !== "model_change" && e.type !== "thinking_level_change") continue;
    if (typeof e.provider === "string" && typeof e.modelId === "string") model = `${e.provider}/${e.modelId}`;
    if (e.type === "thinking_level_change" && typeof e.thinkingLevel === "string") level = e.thinkingLevel;
  }
  return model ? `${model}${level ? `:${level}` : ""}` : undefined;
};

// The omo session of a herdr pane: read from its running agent (and recorded) when live, else the recorded one; "" when
// neither tells.
export const herdrLeadSession = async (run: Runner, config: Partial<Pick<DoriConfig, "stateDir" | "sessionsDir">>, pane: string, live: boolean): Promise<string> => {
  const kept = config.stateDir ? readHerdrSessions(config.stateDir)[pane] : undefined;
  if (!live || !config.sessionsDir) return kept?.session ?? "";
  const cwd = (await herdrSessions(run)).find((s) => s.pane === pane)?.path ?? kept?.cwd ?? "";
  const table = await procTable(run);
  const hit = await resolveSession(pane, cwd, table, { run, sessionsDir: config.sessionsDir, backend: "herdr" });
  if (!hit.id) return kept?.session ?? "";
  // what the session runs now (its log), else the model recorded for this same session (a log that cannot be read does not
  // send it back to the launch one), else what its agent was started with
  const cmd = table.find((p) => p.pid === hit.pid)?.cmd ?? "";
  const same = kept?.session === hit.id ? kept : undefined;
  const log = hit.pid ? await sessionLog(run, table, hit.pid, hit.id, config.sessionsDir, cwd, same?.log) : same?.log;
  const model = (log ? sessionModel(log) : undefined) ?? same?.model ?? modelOf(cmd);
  // recorded on every read, unchanged or not: its time is when it was last checked (lead-down reads again after 10 min)
  if (config.stateDir) recordHerdrSession(config.stateDir, pane, { session: hit.id, cwd, ...(model ? { model } : {}), ...(log ? { log } : {}), at: new Date().toISOString() });
  return hit.id;
};

const omoInputBox = (screen: string): boolean => {
  const lines = screen.split("\n");
  return lines.some((l, i) => l.trimStart().startsWith("❯") && lines.slice(Math.max(0, i - 2), i).some((u) => u.trimStart().startsWith("─")));
};

// Starts the recorded conversation of a herdr pane again in that pane, whose agent is gone (its shell stayed or herdr
// gave the pane back after a restart): omo --session-id resumes an existing session exactly. Waits for omo's ❯ prompt,
// then types prompt (when not "") through type. A line saying what happened.
// A server that just started spawns its restored panes a second or two later (pane_not_found until then), and herdr 0.9.5
// itself starts an omo it recognised (as pi) again with --session <its file> (measured 2026-11-03): the pane is waited
// for, and an agent already running there only gets the prompt.
export const reviveHerdr = async (run: Runner, clock: Clock, config: Pick<DoriConfig, "stateDir" | "sessionsDir" | "agentCommand" | "defaultModel">, pane: string, prompt: string, type: (pane: string, text: string) => Promise<boolean>): Promise<string> => {
  const rec = readHerdrSessions(config.stateDir)[pane];
  if (!rec || !argvSessionId(["--session-id", rec.session])) return `REVIVE_FAIL ${pane}: no omo session recorded for this pane (${file(config.stateDir)})`;
  if (!(await herdrSessions(run)).some((s) => s.pane === pane)) return `REVIVE_FAIL ${pane}: herdr has no such pane (its tab was closed); open a new session instead`;
  for (let i = 0; i < 20 && !(await herdrShellPid(run, pane)); i++) await clock.sleep(1_000);
  const restored = await herdrAgentPid(run, pane);
  const read = async () => (await run(["herdr", "pane", "read", pane, "--source", "visible"])).out;
  if (!restored) {
    try {
      await requireHerdrPwsh(run, pane);
    } catch (error) {
      if (error instanceof HerdrShellError) return `REVIVE_FAIL ${pane}: ${error.message}`;
      throw error;
    }
    // the configured agentCommand with its own options (a --session-dir included), the recorded session, and the model and
    // thinking the session ran last (its log, read now: a /thinking after the last record counts), else the recorded model.
    // The level goes in as its own --thinking (aoe.ts herdrAgentArgv: omo can start at another level than a :suffix says).
    if (hasSessionSelector(config.agentCommand.slice(1))) return `REVIVE_FAIL ${pane}: agentCommand picks its session itself (${config.agentCommand.join(" ")}); revive needs one without a session selector`;
    const tool = config.agentCommand[0] ?? "omo";
    const log = rec.log && existsSync(rec.log) ? rec.log : argvSessionLog(config.agentCommand, config.sessionsDir, rec.cwd, rec.session);
    const { base, thinking } = splitModel((log ? sessionModel(log) : undefined) || rec.model || config.defaultModel);
    const argv = herdrAgentArgv(config.agentCommand, base, thinking, rec.session);
    // the screen is cleared first, so a ❯ the ended agent left there is gone before the new one draws
    const clear = process.platform === "win32" ? "Clear-Host; " : "clear && ";
    const ran = await run(["herdr", "pane", "run", pane, `${clear}${agentLine(argv, { PATH: agentPath(tool) })}`], { cwd: existsSync(rec.cwd) ? rec.cwd : undefined });
    if (ran.code !== 0) return `REVIVE_FAIL ${pane}: herdr pane run failed: ${(ran.err || ran.out).slice(0, 160)}`;
  }
  const how = restored ? ` (herdr had started it again, pid ${restored})` : "";
  for (let i = 0; i < 90; i++) {
    // ready once an agent runs in the pane and shows omo's own input box: a ❯ line with the box's ─ border right above it
    // (an echoed command line or a shell prompt drawn as ❯ has no box)
    const screen = (await herdrAgentPid(run, pane)) ? await read() : "";
    if (screen && omoInputBox(screen)) {
      if (!prompt) return `REVIVE_OK ${pane} session ${rec.session}${how}`;
      return (await type(pane, prompt)) ? `REVIVE_OK ${pane} session ${rec.session}${how} (prompt submitted)` : `REVIVE_PROMPT_NOT_SUBMITTED ${pane} session ${rec.session}${how}`;
    }
    await clock.sleep(2_000);
  }
  return `REVIVE_FAIL ${pane}: no running agent with its ❯ prompt within 3 minutes of starting session ${rec.session}`;
};


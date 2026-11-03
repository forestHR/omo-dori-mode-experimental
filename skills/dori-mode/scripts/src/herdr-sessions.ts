import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DoriConfig } from "./config.ts";
import { agentPath, herdrAgentArgv } from "./aoe.ts";
import { agentLine, herdrAgentPid, herdrSessions, herdrShellPid, HerdrShellError, requireHerdrPwsh } from "./herdr.ts";
import type { Clock, Runner } from "./run.ts";
import { argvSessionId, hasSessionSelector, procTable, resolveSession } from "./session-id.ts";

// A herdr server that stops ends every agent in its panes and gives back the same pane ids with fresh shells (herdr 0.9.5,
// measured 2026-11-03), unlike an aoe session, which aoe starts again in its conversation. So the omo session a herdr lead
// runs is kept here while it runs (dori lead, dori watch's lead check), and the lead is started again in that conversation
// from it (reviveHerdr) when its agent is gone.
export type HerdrSessionRecord = { readonly session: string; readonly cwd: string; readonly model?: string; readonly at: string };

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

// The omo session of a herdr pane: read from its running agent (and recorded) when live, else the recorded one; "" when
// neither tells.
export const herdrLeadSession = async (run: Runner, config: Partial<Pick<DoriConfig, "stateDir" | "sessionsDir">>, pane: string, live: boolean): Promise<string> => {
  const kept = config.stateDir ? readHerdrSessions(config.stateDir)[pane] : undefined;
  if (!live || !config.sessionsDir) return kept?.session ?? "";
  const cwd = (await herdrSessions(run)).find((s) => s.pane === pane)?.path ?? kept?.cwd ?? "";
  const table = await procTable(run);
  const hit = await resolveSession(pane, cwd, table, { run, sessionsDir: config.sessionsDir, backend: "herdr" });
  if (!hit.id) return kept?.session ?? "";
  const model = modelOf(table.find((p) => p.pid === hit.pid)?.cmd ?? "");
  // recorded on every read, unchanged or not: its time is when it was last checked (lead-down reads again after 10 min)
  if (config.stateDir) recordHerdrSession(config.stateDir, pane, { session: hit.id, cwd, ...(model ? { model } : {}), at: new Date().toISOString() });
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
export const reviveHerdr = async (run: Runner, clock: Clock, config: Pick<DoriConfig, "stateDir" | "agentCommand" | "defaultModel">, pane: string, prompt: string, type: (pane: string, text: string) => Promise<boolean>): Promise<string> => {
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
    // the configured agentCommand with its own options (a --session-dir included), the recorded session and model
    if (hasSessionSelector(config.agentCommand.slice(1))) return `REVIVE_FAIL ${pane}: agentCommand picks its session itself (${config.agentCommand.join(" ")}); revive needs one without a session selector`;
    const tool = config.agentCommand[0] ?? "omo";
    const argv = herdrAgentArgv(config.agentCommand, rec.model || config.defaultModel, undefined, rec.session);
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


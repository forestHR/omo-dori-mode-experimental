import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DoriConfig } from "./config.ts";
import { agentLine, herdrSessions } from "./herdr.ts";
import type { Clock, Runner } from "./run.ts";
import { argvSessionId, procTable, resolveSession } from "./session-id.ts";

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
  if (config.stateDir && (kept?.session !== hit.id || kept.cwd !== cwd || kept.model !== model)) recordHerdrSession(config.stateDir, pane, { session: hit.id, cwd, ...(model ? { model } : {}), at: new Date().toISOString() });
  return hit.id;
};

// Starts the recorded conversation of a herdr pane again in that pane, whose agent is gone (its shell stayed or herdr
// gave the pane back after a restart): omo --session-id resumes an existing session exactly. Waits for omo's ❯ prompt,
// then types prompt (when not "") through type. A line saying what happened.
export const reviveHerdr = async (run: Runner, clock: Clock, config: Pick<DoriConfig, "stateDir" | "agentCommand" | "defaultModel">, pane: string, prompt: string, type: (pane: string, text: string) => Promise<boolean>): Promise<string> => {
  const rec = readHerdrSessions(config.stateDir)[pane];
  if (!rec || !argvSessionId(["--session-id", rec.session])) return `REVIVE_FAIL ${pane}: no omo session recorded for this pane (${file(config.stateDir)})`;
  if (!(await herdrSessions(run)).some((s) => s.pane === pane)) return `REVIVE_FAIL ${pane}: herdr has no such pane (its tab was closed); open a new session instead`;
  const tool = config.agentCommand[0] ?? "omo";
  const ran = await run(["herdr", "pane", "run", pane, agentLine([tool, "--session-id", rec.session, "--model", rec.model || config.defaultModel])], { cwd: existsSync(rec.cwd) ? rec.cwd : undefined });
  if (ran.code !== 0) return `REVIVE_FAIL ${pane}: herdr pane run failed: ${(ran.err || ran.out).slice(0, 160)}`;
  for (let i = 0; i < 90; i++) {
    const screen = (await run(["herdr", "pane", "read", pane, "--source", "visible"])).out;
    if (screen.split("\n").some((l) => l.trimStart().startsWith("❯"))) {
      if (!prompt) return `REVIVE_OK ${pane} session ${rec.session}`;
      return (await type(pane, prompt)) ? `REVIVE_OK ${pane} session ${rec.session} (prompt submitted)` : `REVIVE_PROMPT_NOT_SUBMITTED ${pane} session ${rec.session}`;
    }
    await clock.sleep(2_000);
  }
  return `REVIVE_FAIL ${pane}: no ❯ prompt within 3 minutes of starting session ${rec.session}`;
};

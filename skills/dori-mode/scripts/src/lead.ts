import { paneLife, sessionFor, type AoeSession } from "./aoe.ts";
import type { DoriConfig } from "./config.ts";
import { isHerdrPane } from "./herdr.ts";
import { herdrLeadSession } from "./herdr-sessions.ts";
import type { Runner } from "./run.ts";

export class LeadError extends Error {}

// The lead as "<aoe-id> <tmux-session>", and " stopped" when its tmux session is not running (at boot it is not yet:
// dori-lead.service and dori.sh start it from this id). The tmux name comes from DORI_LEAD_TMUX, else leadPane.
// aoe names a session's tmux aoe_<title>_<first 8 of the id>, so DORI_LEAD_AOE_ID is used only when its first eight
// characters are the name's last eight (a handover keeps the old id when it cannot tell the new one); otherwise the id
// comes from `aoe list --json`, which lists stopped sessions too.
export const findLead = async (run: Runner, config: Pick<DoriConfig, "leadPane"> & Partial<Pick<DoriConfig, "stateDir" | "sessionsDir">>, env: Readonly<Record<string, string | undefined>> = process.env): Promise<string> => {
  const tmux = env.DORI_LEAD_TMUX?.trim() || config.leadPane;
  if (!tmux) throw new LeadError("no DORI_LEAD_TMUX or leadPane configured");
  // a herdr lead (a pane id with ":"): "<omo session id> <pane>", the session its agent runs (or ran: herdr-sessions.ts
  // keeps it, so a lead whose agent ended or whose server restarted is started again in the same conversation)
  if (isHerdrPane(tmux)) {
    const life = await paneLife(run, tmux);
    const session = await herdrLeadSession(run, config, tmux, life.live);
    if (!session) throw new LeadError(`no omo session known for the herdr lead ${tmux}`);
    return `${session} ${tmux}${life.live ? "" : " stopped"}`;
  }
  const live = (await run(["tmux", "has-session", "-t", `=${tmux}`])).code === 0;
  const state = live ? "" : " stopped";
  const short = tmux.slice(-8);
  const configured = env.DORI_LEAD_AOE_ID?.trim();
  if (configured && tmux.endsWith(`_${short}`) && configured.slice(0, 8) === short) return `${configured} ${tmux}${state}`;
  const listed = await run(["aoe", "list", "--json"]);
  if (listed.code !== 0) throw new LeadError(`aoe list failed: ${listed.err || listed.out}`);
  const session = sessionFor(JSON.parse(listed.out) as AoeSession[], tmux);
  if (!session) throw new LeadError(`no aoe session matches ${tmux}`);
  return `${session.id} ${tmux}${state}`;
};

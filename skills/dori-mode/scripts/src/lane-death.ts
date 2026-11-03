import { paneLife } from "./aoe.ts";
import { isHerdrPane } from "./herdr.ts";
import type { FlowDeps } from "./done-flow.ts";
import { submitToPane } from "./panes.ts";
import type { Submitted } from "./submit.ts";
import { type LaneDied, statusOf } from "./registry.ts";
import type { Runner } from "./run.ts";

// 2026-10-30 02:33 UTC: a lane's omo died with its OOM-killed job (systemd stopped its aoe-session scope; the pane stayed
// dead with status 143). dead-panes read only screen words every 5 minutes and printed nothing; the lead heard of it about
// three hours later, from the owner. dori watch (every 30 s) now checks each open lane's pane:
// - LANE_DIED <key> <pane>: <why> once its tmux session is gone or its pane is dead on two checks CONFIRM_MS apart (a
//   handover or close that swaps the pane is seen live again or out of the registry by then);
// - the lead pane gets one line "[DORI] 레인 <key> 꺼짐(<이유>) — 이어서 살릴지 정해", typed once (LANE_DIED_TOLD, or
//   LANE_DIED_NOT_TOLD when the submit check could not see it taken: no retry, so the lead never gets it twice; the
//   LANE_DIED line stays in the watch log); never the owner (the lead decides);
// - the reason is 메모리 부족 when this user's journal shows an oom-kill for the lane's aoe-session scope (the lane user can
//   read its own journal, not the kernel log), else the pane's exit status or the gone session.
// A lane whose pane is live again (revived) loses its mark, so a second death is told again.

const CONFIRM_MS = 25_000;
const JOURNAL_BACK_MS = 30 * 60_000;

// first check that found each pane not live, for the second check (in memory: a restart of the watch only delays it a tick)
const notLive = new Map<string, number>();

// the journal line that says the lane's aoe-session scope (aoe-session-<first 8 of the aoe id>...) met the OOM killer
export const oomLine = async (run: Runner, pane: string, sinceMs: number): Promise<string | undefined> => {
  const id = /_([0-9a-f]{8})$/.exec(pane)?.[1];
  if (!id) return undefined;
  const r = await run(["journalctl", "--user", "--since", `@${Math.floor(sinceMs / 1000)}`, "--no-pager", "-o", "cat", "-g", `aoe-session-${id}`], { timeoutMs: 10_000 });
  if (r.code !== 0) return undefined;
  return r.out.split("\n").find((l) => /oom-kill|killed by the OOM killer/i.test(l))?.trim().slice(0, 200);
};

export const laneDiedText = (key: string, reason: string): string => `[DORI] 레인 ${key} 꺼짐(${reason}) — 이어서 살릴지 정해`;

export const laneDeathTick = async (deps: FlowDeps): Promise<string[]> => {
  const out: string[] = [];
  const now = deps.clock.now();
  const skip = new Set([deps.config.leadPane, ...deps.config.ignorePanes]);
  for (const lane of await deps.registry.open()) {
    const pane = lane.pane;
    if (!pane || skip.has(pane) || statusOf(lane) === "paused") continue;
    const life = await paneLife(deps.run, pane);
    if (life.live) {
      notLive.delete(pane);
      if (lane.died) await deps.registry.patch(lane.key, { died: undefined });
      continue;
    }
    if (lane.died?.pane === pane) continue;
    const first = notLive.get(pane);
    if (first === undefined) {
      notLive.set(pane, now);
      continue;
    }
    if (now - first < CONFIRM_MS) continue;
    const oom = await oomLine(deps.run, pane, first - JOURNAL_BACK_MS).catch(() => undefined);
    // a herdr pane keeps no exit status (herdr.ts herdrLife: status -1)
    const herdr = isHerdrPane(pane);
    const reason = oom ? "메모리 부족" : life.how === "dead" ? (life.status < 0 ? "에이전트 꺼짐" : `종료 코드 ${life.status}`) : herdr ? "herdr pane 없음" : "tmux 세션 없음";
    const why = oom ? `oom-kill (journal: ${oom})` : life.how === "dead" ? (life.status < 0 ? "pane dead, no agent runs in it" : `pane dead, status ${life.status}`) : herdr ? "herdr pane gone" : "tmux session gone";
    out.push(`LANE_DIED ${lane.key} ${pane}: ${why}`);
    const lead = deps.config.leadPane;
    const sent: Submitted = lead ? await submitToPane(deps.run, deps.clock, deps.config, lead, laneDiedText(lane.key, reason)) : { status: "NOT_SUBMITTED", reason: "no leadPane" };
    const told = sent.status === "SUBMITTED";
    out.push(told ? `LANE_DIED_TOLD ${lane.key} ${lead}` : `LANE_DIED_NOT_TOLD ${lane.key}: ${sent.reason}`);
    const died: LaneDied = { pane, at: new Date(now).toISOString(), reason, why, told };
    await deps.registry.patch(lane.key, { died });
  }
  return out;
};

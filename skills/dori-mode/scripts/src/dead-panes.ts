import { BUSY_MARK, inputLine } from "./aoe.ts";
import type { DoriConfig } from "./config.ts";
import { frozenPanes } from "./frozen.ts";
import { listPanes, readScreen } from "./panes.ts";
import type { Runner } from "./run.ts";

// A pane is judged from what positively shows, never from one screen read (ported from dori-superagent 40034ad, #7, MIT,
// https://github.com/sisyphuslabs/dori-superagent/commit/40034ad1a557b92a34aa1450565adcafd3352c96; herdr's agent_status
// there is the agent's own ❯ input line or its running-turn mark here). A pane whose agent shows either is alive, whatever
// words its transcript holds ("the job has stopped" in a lane's own output). Otherwise it is DEAD_PANE only when its last
// lines carry a deadPanePatterns word and read the same as on the previous tick, a loop interval earlier, so a screen
// mid-redraw never counts. An aoe pane that shows neither is counted, and named once (UNRECOGNISED_PANE) after
// UNRECOGNISED_ALERT_AFTER ticks in a row.
export const UNRECOGNISED_ALERT_AFTER = 3;

// per-pane memory across ticks; the dead-panes loop keeps one for its whole life
export type DeadPaneState = { readonly unknown: Map<string, number>; readonly lastTail: Map<string, string> };
export const newDeadPaneState = (): DeadPaneState => ({ unknown: new Map(), lastTail: new Map() });

const agentShows = (screen: string): boolean => inputLine(screen) !== undefined || screen.toLowerCase().includes(BUSY_MARK);

// pausedPanes: panes of paused lanes, which the lead parked on purpose
export const deadPaneTick = async (run: Runner, config: DoriConfig, seen: Set<string>, hourKey: string, pausedPanes: readonly string[] = [], state: DeadPaneState = newDeadPaneState()): Promise<string[]> => {
  const out: string[] = [];
  const watch = new Set(config.workspaces);
  // a frozen old lead shows a still screen on purpose
  const skip = new Set([config.leadPane, ...config.ignorePanes, ...pausedPanes, ...frozenPanes(config.stateDir)].filter(Boolean));
  for (const pane of await listPanes(run, config.backend)) {
    const id = pane.pane_id;
    if (skip.has(id) || (watch.size > 0 && !watch.has(pane.workspace_id))) continue;
    const screen = await readScreen(run, config.backend, id, config.backend === "aoe" ? undefined : 6);
    if (config.backend === "aoe" && agentShows(screen)) {
      state.unknown.delete(id);
      state.lastTail.delete(id);
      continue;
    }
    const tail = screen.split("\n").slice(-6).join("\n").toLowerCase();
    const previous = state.lastTail.get(id);
    state.lastTail.set(id, tail);
    if (config.deadPanePatterns.some((p) => tail.includes(p.toLowerCase()))) {
      state.unknown.delete(id);
      if (previous !== tail) continue;
      const mark = `${id} ${hourKey}`;
      if (seen.has(mark)) continue;
      seen.add(mark);
      out.push(`DEAD_PANE ${id}`);
      continue;
    }
    // herdr panes give no alive evidence here, so only aoe panes can be unrecognised
    if (config.backend !== "aoe") continue;
    const n = (state.unknown.get(id) ?? 0) + 1;
    state.unknown.set(id, n);
    if (n === UNRECOGNISED_ALERT_AFTER) out.push(`UNRECOGNISED_PANE ${id} dead-panes: no agent prompt, running turn or dead marker for ${n} ticks`);
  }
  return out;
};

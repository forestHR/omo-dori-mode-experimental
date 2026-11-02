import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { paneLife } from "./aoe.ts";
import { pendingBackground, restoredMonitors } from "./background.ts";
import type { FlowDeps } from "./done-flow.ts";
import { type GoalRead, laneGoal } from "./goal.ts";
import { readScreen, submitToPane } from "./panes.ts";
import { statusOf } from "./registry.ts";
import { AGENT, descendants, ended, procTable, sessionDirFor, shellPidOf } from "./session-id.ts";
import { turnRunning } from "./submit.ts";

// A started lane has to set its goal (dori-superagent issue #50 reproduced here (MIT):
// https://github.com/sisyphuslabs/dori-superagent/issues/50), but not within a fixed time: on 213 real lanes of four
// Dori accounts (2026-11-02) a ulw lane read its brief and ran a discovery wave first, so 81% set their goal later than
// 80 s; 201 set it before their first turn ended (median 146 s, p90 260 s, p99 849 s, longest 1383 s), 11 only after a
// user's nudge, one after a 19 s idle gap between turns. Waiting that long would hold up the lead's dori launch and the
// backlog pass, so the judgement is split: dori launch reads the lane's first turn briefly (right after its 20 s check,
// then every 10 s while the turn is idle) and dori watch, every 30 s, finishes it for a lane launch left pending.
// Either way a turn counts as ended without a goal only after three idle reads in a row, so a gap between tool calls or
// turns is no end.
// a mark still pending after 25 minutes (the longest first turn measured took 1383 s) is told once even with background
// work, so no lane stays pending forever
export const GOAL_WAIT = { everyMs: 10_000, idleChecks: 3, maxPendingMs: 25 * 60_000 } as const;

export const lastLines = (screen: string): string =>
  screen.split("\n").map((s) => s.trim()).filter(Boolean).slice(-3).join(" / ").replace(/\/(Users|home|Volumes|private|tmp)\/\S+/g, "(local path)").slice(0, 240) || "(blank)";

export const noGoalWhy = (goal: GoalRead): string => (goal === "none" ? "no goal in its session" : "no goal found for its session");

// The goal of the lane's own session: the exact id its agent runs under (goal.ts laneGoal)
export const goalReader = (deps: FlowDeps, cwd: string, session: string): ((pane: string) => Promise<GoalRead>) =>
  deps.readGoal ?? (async () => laneGoal(deps.config.sessionsDir, cwd, session));

export const agentGone = async (deps: FlowDeps, pane: string): Promise<string | undefined> => {
  if (deps.config.backend === "aoe") {
    const life = await paneLife(deps.run, pane);
    return life.live ? undefined : life.how === "gone" ? "the tmux session is gone" : `the agent exited (status ${life.status})`;
  }
  // whether any agent still runs under the pane's shell, which is not the same question as which session it is:
  // resolveSession skips a command holding the word mcp (an MCP server of the agent), and a herdr lane carries its own
  // prompt in the agent's command line, so a lane keyed mcp-fix or briefed /tmp/mcp.md would read as dead
  const shell = await shellPidOf(pane, { run: deps.run, sessionsDir: deps.config.sessionsDir, backend: deps.config.backend });
  const table = shell ? await procTable(deps.run) : [];
  const live = [...table.filter((p) => p.pid === shell), ...descendants(table, shell)].some((p) => AGENT.test(p.cmd) && !ended(p));
  return live ? undefined : "no agent runs in the pane any more";
};

// A first turn is still on while its turn runs on screen, and while the agent waits on background work of its own: a
// job it detached (an eval or a bash the harness moved to the background, a task, a monitor) wakes it when it ends, and
// such a lane often sets its goal then (QA 2026-11-02: a sleep 150 detached after 5 s, the turn ended, the goal came when
// the job did). The jobs are read the way done-flow reads them (background.ts pendingBackground, laneBackground's own
// parser) from the transcript of the lane's exact session, under the cwd or its real path; laneBackground's own lookup
// finds the session by the pane's process and only on aoe. A read that fails counts as none.
// jobs started before the agent itself are not its own: a restarted session keeps its transcript, and a job the old agent
// left unfinished died with it (laneBackground has the same cutoff); a persistent monitor the restart restored counts while
// the session's monitor manifest says it runs (handover.ts liveMonitors), as in laneBackground
export const firstTurnRuns = async (deps: FlowDeps, pane: string, cwd: string, session: string, screen: string): Promise<boolean> =>
  turnRunning(screen) || (await ownOrRestored(deps, pane, cwd, session));

const ownOrRestored = async (deps: FlowDeps, pane: string, cwd: string, session: string): Promise<boolean> => {
  const since = await agentStart(deps, pane);
  return ownJobs(deps.config.sessionsDir, cwd, session, since) > 0 || restoredIn(deps.config.sessionsDir, cwd, session, since, deps.clock.now()) > 0;
};

const restoredIn = (sessionsDir: string, cwd: string, session: string, since: number, now: number): number => {
  if (!session) return 0;
  const at = resolve(cwd);
  let real = at;
  try {
    real = realpathSync(at);
  } catch {}
  return Math.max(...[...new Set([at, real])].map((dir) => restoredMonitors(sessionsDir, dir, session, since, now).length));
};

const agentStart = async (deps: FlowDeps, pane: string): Promise<number> => {
  const shell = await shellPidOf(pane, { run: deps.run, sessionsDir: deps.config.sessionsDir, backend: deps.config.backend });
  const table = shell ? await procTable(deps.run) : [];
  const agent = [...table.filter((p) => p.pid === shell), ...descendants(table, shell)].find((p) => AGENT.test(p.cmd) && !ended(p));
  const at = agent ? Date.parse((await deps.run(["ps", "-o", "lstart=", "-p", String(agent.pid)])).out.trim()) : Number.NaN;
  return Number.isNaN(at) ? 0 : at;
};

const ownJobs = (sessionsDir: string, cwd: string, session: string, since: number): number => {
  if (!session) return 0;
  const at = resolve(cwd);
  let real = at;
  try {
    real = realpathSync(at);
  } catch {}
  for (const dir of new Set([sessionDirFor(sessionsDir, at), sessionDirFor(sessionsDir, real)])) {
    try {
      const name = readdirSync(dir).find((n) => n.endsWith(`_${session}.jsonl`));
      if (name) return pendingBackground(readFileSync(join(dir, name), "utf8"), since).length;
    } catch {}
  }
  return 0;
};

const tellLead = async (deps: FlowDeps, key: string, text: string): Promise<string> => {
  const lead = deps.config.leadPane;
  const sent = lead ? await submitToPane(deps.run, deps.clock, deps.config, lead, text) : { status: "NOT_SUBMITTED" as const, reason: "no leadPane" };
  return sent.status === "SUBMITTED" ? `LANE_NO_GOAL_TOLD ${key} ${lead}` : `LANE_NO_GOAL_NOT_TOLD ${key}: ${sent.reason}`;
};

export const noGoalText = (key: string): string => `[DORI] LANE_NO_GOAL ${key}: 첫 턴이 goal 없이 끝남 — pane 보고 goal 세우라고 해`;

// dori watch: each lane dori launch marked pending (STARTUP_PENDING_GOAL) is read again. A goal clears the mark
// (LANE_GOAL_SET); a running turn or a background job of its own resets the idle count kept on the mark; the third idle
// read in a row says LANE_NO_GOAL and types one line into the lead's pane, once (no retry, like a lane's death:
// LANE_NO_GOAL_TOLD or _NOT_TOLD), and clears the mark. A lane whose agent is gone is left to the lane death check on aoe;
// on herdr, which has none, it is LANE_NO_GOAL_AGENT_GONE, told once the same way. Working and not-done lanes are read;
// paused, claimed and closed ones, and a lane that names no session, are skipped.
export const pendingGoalTick = async (deps: FlowDeps): Promise<string[]> => {
  const out: string[] = [];
  for (const lane of await deps.registry.list()) {
    const mark = lane.pendingGoal;
    if (!mark || !lane.pane || !["working", "not-done"].includes(statusOf(lane)) || (!lane.session && !deps.readGoal)) continue;
    const gone = await agentGone(deps, lane.pane);
    if (gone && deps.config.backend === "aoe") continue;
    if (gone) {
      await deps.registry.patch(lane.key, { pendingGoal: undefined });
      out.push(`LANE_NO_GOAL_AGENT_GONE ${lane.key} ${lane.pane}: ${gone} before it set a goal`);
      out.push(await tellLead(deps, lane.key, `[DORI] LANE_NO_GOAL ${lane.key}: 에이전트가 goal 없이 꺼짐(${gone}) — pane 확인`));
      continue;
    }
    const cwd = lane.cwd ?? deps.config.defaultCwd;
    const goal = await goalReader(deps, cwd, lane.session ?? "")(lane.pane);
    if (typeof goal === "object") {
      await deps.registry.patch(lane.key, { pendingGoal: undefined });
      out.push(`LANE_GOAL_SET ${lane.key} ${lane.pane}: its session holds a goal now; the pending-goal mark is cleared`);
      continue;
    }
    const screen = await readScreen(deps.run, deps.config.backend, lane.pane, 40);
    if (mark.at !== undefined && deps.clock.now() - mark.at >= GOAL_WAIT.maxPendingMs) {
      await deps.registry.patch(lane.key, { pendingGoal: undefined });
      out.push(`LANE_NO_GOAL ${lane.key} ${lane.pane}: still pending 25 minutes after launch with ${noGoalWhy(goal)}; last lines: ${lastLines(screen)}`);
      out.push(await tellLead(deps, lane.key, noGoalText(lane.key)));
      continue;
    }
    const idle = (await firstTurnRuns(deps, lane.pane, cwd, lane.session ?? "", screen)) ? 0 : mark.idle + 1;
    if (idle < GOAL_WAIT.idleChecks) {
      if (idle !== mark.idle) await deps.registry.patch(lane.key, { pendingGoal: { ...mark, idle } });
      continue;
    }
    await deps.registry.patch(lane.key, { pendingGoal: undefined });
    out.push(`LANE_NO_GOAL ${lane.key} ${lane.pane}: its first turn ended with ${noGoalWhy(goal)}; last lines: ${lastLines(screen)}`);
    out.push(await tellLead(deps, lane.key, noGoalText(lane.key)));
  }
  return out;
};

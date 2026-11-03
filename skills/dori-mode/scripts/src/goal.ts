import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { captureTmux, paneLife } from "./aoe.ts";
import type { FlowDeps } from "./done-flow.ts";
import { paneTranscript, typeLine } from "./panes.ts";
import { sessionDirFor } from "./session-id.ts";

// A paused lane must not keep working through its omo goal: between turns omo starts the next one on its own while the
// goal is active, so a lane the lead paused kept spending turns (ported from dori-superagent 0057f49, #12, MIT,
// https://github.com/sisyphuslabs/dori-superagent/commit/0057f49de9ae32f1bd0e38fe097d7430224bcb29). `dori pause` types
// `/goal pause` into the lane's session and reads the result back, `dori resume` types `/goal resume` for a goal the
// pause paused. omo keeps a session's goal in <session dir>/extensions/goal/<session id>.json ({"goal":{"status"}}),
// next to the transcript; when that file cannot be found the screen is read instead: omo prints "Goal paused" / "Goal
// active" at the start of a line (a side panel may follow on the same row), or "cannot update goal: no goal exists".

export type GoalRead = { readonly status: string } | "none" | "unknown";
export type GoalAct = "pause" | "resume";
export type GoalOutcome = { readonly outcome: "confirmed" | "no-goal" | "not-active" | "unconfirmed" | "failed"; readonly detail: string };

const WANT: Record<GoalAct, string> = { pause: "paused", resume: "active" };
// the goal status that can be changed by the command; anything else (complete, blocked, already paused) is left alone
const FROM: Record<GoalAct, string> = { pause: "active", resume: "paused" };
const SHOWN: Record<GoalAct, RegExp> = { pause: /^\s*Goal paused\b/, resume: /^\s*Goal active\b/ };
const NO_GOAL = /^\s*cannot update goal: no goal exists\b/;
const READ_BACK_TRIES = 10;

export const goalFileOf = (sessionPath: string): string | undefined => {
  const id = /_([^_]+)\.jsonl$/.exec(basename(sessionPath))?.[1];
  return id ? join(dirname(sessionPath), "extensions", "goal", `${encodeURIComponent(id)}.json`) : undefined;
};

export const readGoalFile = (file: string): GoalRead => {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "unknown";
  }
  try {
    const status = (JSON.parse(text) as { goal?: { status?: unknown } }).goal?.status;
    return typeof status === "string" ? { status } : "none";
  } catch {
    return "unknown";
  }
};

export const sessionGoal = async (deps: FlowDeps, pane: string): Promise<GoalRead> => {
  const path = await paneTranscript(deps.run, deps.config.sessionsDir, pane).catch(() => undefined);
  const file = path ? goalFileOf(path) : undefined;
  return file ? readGoalFile(file) : "unknown";
};

// The goal of the lane's session `id`, the exact id its agent runs under (dori launch reads it from the agent's command
// line: aoe's own --session-id, or the one launch gave a herdr omo), so no other session can lend its goal and nothing is
// inferred. omo keeps it in <session dir>/extensions/goal/<id>.json, the session dir named after the cwd or, for a
// symlinked cwd, its real path. No goal file: "none" once the session's transcript is there, else "unknown" (not
// written yet, or unreadable).
export const laneGoal = (sessionsDir: string, cwd: string, id: string): GoalRead => {
  const at = resolve(cwd);
  let real = at;
  try {
    real = realpathSync(at);
  } catch {}
  const dirs = [...new Set([sessionDirFor(sessionsDir, at), sessionDirFor(sessionsDir, real)])];
  for (const dir of dirs) {
    const goal = readGoalFile(join(dir, "extensions", "goal", `${encodeURIComponent(id)}.json`));
    if (goal !== "none") return goal;
  }
  const held = dirs.some((dir) => {
    try {
      return readdirSync(dir).some((n) => n.endsWith(`_${id}.jsonl`));
    } catch {
      return false;
    }
  });
  return held ? "none" : "unknown";
};

const count = (screen: string, re: RegExp): number => screen.split("\n").filter((l) => re.test(l)).length;

// Types /goal pause or /goal resume and reads the result back: the goal file's status, or (no file found) one more
// "Goal paused"/"Goal active" line on screen than before. A goal that is not in the state the command changes is left alone.
export const goalCommand = async (deps: FlowDeps, pane: string, act: GoalAct): Promise<GoalOutcome> => {
  const read = deps.readGoal ?? ((p: string) => sessionGoal(deps, p));
  const before = await read(pane);
  if (before === "none") return { outcome: "no-goal", detail: "no goal in its session" };
  if (before !== "unknown" && before.status !== FROM[act]) return { outcome: "not-active", detail: `its goal is ${before.status}, left as it is` };
  const screen = await captureTmux(deps.run, pane);
  const shownBefore = count(screen, SHOWN[act]);
  const noneBefore = count(screen, NO_GOAL);
  const why = await typeLine(deps.run, deps.clock, deps.config, pane, `/goal ${act}`);
  if (why) return { outcome: "failed", detail: `/goal ${act} not typed: ${why}` };
  for (let i = 0; i < READ_BACK_TRIES; i++) {
    await deps.clock.sleep(1_000);
    const now = await read(pane);
    if (now === "none") return { outcome: "no-goal", detail: "no goal in its session" };
    if (now !== "unknown") {
      if (now.status === WANT[act]) return { outcome: "confirmed", detail: `goal store reads ${now.status}` };
      continue;
    }
    const shown = await captureTmux(deps.run, pane);
    if (count(shown, SHOWN[act]) > shownBefore) return { outcome: "confirmed", detail: `screen shows Goal ${WANT[act]}` };
    if (count(shown, NO_GOAL) > noneBefore) return { outcome: "no-goal", detail: "omo says no goal exists" };
  }
  return { outcome: "unconfirmed", detail: `/goal ${act} typed but the goal was not read back ${WANT[act]} within ${READ_BACK_TRIES} s` };
};

export const liveSession = async (deps: FlowDeps, pane: string): Promise<string | undefined> => {
  const life = await paneLife(deps.run, pane);
  return life.live ? undefined : life.how === "gone" ? (pane.includes(":") ? "no herdr pane" : "no tmux session") : life.status < 0 ? "no agent runs in its pane" : `its program exited (status ${life.status})`;
};

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
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

// Every user message of a transcript, what was typed into that session (a lane's launch prompt is one), with when.
// A pane one agent captured and quoted to another is a tool result (role toolResult), never a user message.
const userMessages = (transcript: string): { readonly text: string; readonly at: number }[] =>
  transcript.split("\n").flatMap((line) => {
    if (!line.includes('"user"')) return [];
    let entry: { type?: unknown; timestamp?: unknown; message?: { role?: unknown; content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      return [];
    }
    if (entry.type !== "message" || entry.message?.role !== "user") return [];
    const content = entry.message.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (p as { text?: unknown }).text).filter((t): t is string => typeof t === "string").join("\n") : "";
    return [{ text, at: typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN }];
  });

// The goal of the one session a launch typed its prompt into: a transcript written since `since` holding a user
// message with `marker` (the lane's key and that launch's own token) typed since then. Every user message counts, not
// only the first: with an `agentCommand` that resumes a session the prompt follows its earlier messages. A lead or
// sibling that captured the lane's pane holds the prompt in a tool result, which is not one; and when several sessions
// hold the token (a prompt sent again by hand) none of them is known to be this lane's, so no goal is read from any.
// Both the cwd and its real path are searched: omo may keep a symlinked cwd's sessions under either. Reading the pane's
// own session instead would pick a sibling lane opened seconds apart in the same directory, since omo's child processes
// carry no PI_SESSION_ID and the session is then found by start time.
export const laneGoal = (sessionsDir: string, cwd: string, marker: string, since: number): GoalRead => {
  const at = resolve(cwd);
  let real = at;
  try {
    real = realpathSync(at);
  } catch {}
  const goals = new Map<string, GoalRead>();
  for (const dir of new Set([sessionDirFor(sessionsDir, at), sessionDirFor(sessionsDir, real)])) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        if (statSync(path).mtimeMs < since) continue;
        if (!userMessages(readFileSync(path, "utf8")).some((m) => m.text.includes(marker) && m.at >= since)) continue;
      } catch {
        continue;
      }
      const file = goalFileOf(path);
      goals.set(name, file ? readGoalFile(file) : "unknown");
    }
  }
  return goals.size === 1 ? ([...goals.values()][0] as GoalRead) : "unknown";
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
  return life.live ? undefined : life.how === "gone" ? "no tmux session" : `its program exited (status ${life.status})`;
};

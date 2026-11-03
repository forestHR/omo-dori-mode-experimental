import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { liveSessions, sessionFor } from "./aoe.ts";
import { sessionFile } from "./background.ts";
import type { FlowDeps } from "./done-flow.ts";
import { sendVerified } from "./panes.ts";
import { type AutoturnMark, type Lane, statusOf } from "./registry.ts";
import { iso } from "./run.ts";
import { procTable } from "./session-id.ts";

// omo (senpi) stops starting turns on its own once it started engineTurns.maxPerUserInput (150) of them since the last
// user message, or engineTurns.maxToolFreePerMinute (12) without a tool call in a minute: goal continuations, monitor
// and task notifications all count. Each refused start appends a custom "engine-turn-limit" entry to the session
// transcript and shows "Paused: the agent started N turns on its own ... Send any message to continue." A user message
// (or a "." manual continue / continue-from-leaf) lifts it; an engine turn that starts after it means the limit no longer
// holds (raised settings). A paused session still shows its monitors (◉ watching), so its screen looks busy.
export type AutoturnPause = { readonly since: string; readonly last: string; readonly turns: number; readonly reason: string };

type Entry = { readonly type?: string; readonly customType?: string; readonly timestamp?: string; readonly data?: { readonly reason?: string; readonly sinceUserInput?: number }; readonly message?: { readonly role?: string } };

const USER_DIRECTED = new Set(["manual-continue", "continue-from-leaf"]);
// a line without any of these can neither pause nor lift a pause; it is not parsed
const HINT = /"role":"user"|engine-turn-(?:limit|start)|manual-continue|continue-from-leaf/;

// The pause the transcript ends in, or undefined when its last turn limit was lifted (or there is none).
export const autoturnPause = (transcript: string): AutoturnPause | undefined => {
  let pause: AutoturnPause | undefined;
  for (const line of transcript.split("\n")) {
    if (!HINT.test(line)) continue;
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    const lifted = (e.type === "message" && e.message?.role === "user") || (e.type === "custom_message" && USER_DIRECTED.has(e.customType ?? "")) || (e.type === "custom" && e.customType === "engine-turn-start");
    if (lifted) pause = undefined;
    else if (e.type === "custom" && e.customType === "engine-turn-limit") {
      const at = e.timestamp ?? "";
      const turns = Number(e.data?.sinceUserInput ?? 0);
      pause = pause ? { ...pause, last: at, turns: Math.max(pause.turns, turns) } : { since: at, last: at, turns, reason: String(e.data?.reason ?? "") };
    }
  }
  return pause;
};

// How long the session has run on its own: the engine turns started since the last user message (a lead message typed
// into the pane is one too; so are a "." manual continue and continue-from-leaf), and that message's time ("" when
// the text has none).
export type AutoturnRun = { readonly turns: number; readonly lastUser: string };
export const autoturnRun = (transcript: string): AutoturnRun => {
  let turns = 0;
  let lastUser = "";
  for (const line of transcript.split("\n")) {
    if (!HINT.test(line)) continue;
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if ((e.type === "message" && e.message?.role === "user") || (e.type === "custom_message" && USER_DIRECTED.has(e.customType ?? ""))) {
      turns = 0;
      lastUser = e.timestamp ?? "";
    } else if (e.type === "custom" && e.customType === "engine-turn-start") turns += 1;
  }
  return { turns, lastUser };
};

// the end of the transcript is enough for a pause: a lift always comes after the limit entries it lifts; a run is
// counted from the whole file when the end holds no user message
const TAIL_BYTES = 2 * 1024 * 1024;
const readTranscript = (path: string): { readonly tail: string; readonly whole: string } => {
  const whole = readFileSync(path, "utf8");
  return { tail: whole.length > TAIL_BYTES ? whole.slice(-TAIL_BYTES) : whole, whole };
};
const runOf = (t: { readonly tail: string; readonly whole: string }): AutoturnRun => {
  const run = autoturnRun(t.tail);
  return run.lastUser || t.tail.length === t.whole.length ? run : autoturnRun(t.whole);
};

const DAY_MS = 24 * 60 * 60_000;
const leadMarkPath = (deps: FlowDeps): string => join(deps.config.stateDir, "autoturn-lead.json");
const readLeadMark = (deps: FlowDeps): AutoturnMark | undefined => {
  const path = leadMarkPath(deps);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AutoturnMark;
  } catch {
    return undefined;
  }
};

const laneText = (lane: Lane, pause: AutoturnPause, n: number, max: number): string =>
  `[LEAD] autoturn: omo paused this session after it started ${pause.turns} turns on its own since the last message (senpi engine turn limit, ${pause.reason}). This message lifts the pause: continue from where it stopped${statusOf(lane) === "paused" ? "; the lead paused this lane, so keep waiting and start no new work" : ""}. If you only wait for a set time, wait on one monitor gate for it instead of goal continuations or repeated wakes. (watch resume ${n}/${max} in 24h)`;
const leadText = (pause: AutoturnPause, n: number, max: number): string =>
  `[DORI] LANE_AUTOTURN_PAUSED lead: omo paused this session after it started ${pause.turns} turns on its own since the last message (${pause.reason}); this message lifts it. Read the lanes log and the inbox for what arrived while it was paused. (watch resume ${n}/${max} in 24h)`;

// A runaway lead may never read its own watch log or pane, so its LANE_AUTOTURN_LONG and LANE_AUTOTURN_PAUSED also go
// out as one bot post each (deps.postLeadAlert) to the pair channel, where the other Dori's listener makes it a pair-bot
// inbox row, and to the owner's channel: a fixed head the other Dori acts on, then the configured words. A lane's alerts
// stay with its lead. The other Dori checks on the lead once per LEAD_ALERT_REPEAT_MIN: an alert within that time of the
// last one that asked for a check is posted as "<head> repeat:" with discord.leadRepeatText, which asks for nothing, so a
// pause right after a runaway post (the same event) does not depend on the other Dori remembering the first one.
export const LEAD_ALERT_REPEAT_MIN = 30;
const stamp = (deps: FlowDeps, at: string): string =>
  at ? new Date(at).toLocaleString(deps.config.discord.locale, { timeZone: deps.config.discord.timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "-";
const fillWords = (template: string, values: Readonly<Record<string, string>>): string => template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
export type LeadAlert = { readonly head: string; readonly pane: string; readonly turns: number; readonly template: string; readonly since: string; readonly reason: string };
export const leadRunawayPost = (deps: FlowDeps, pane: string, run: AutoturnRun): LeadAlert => ({ head: "LEAD_RUNAWAY", pane, turns: run.turns, template: deps.config.discord.leadRunawayText, since: run.lastUser, reason: "" });
export const leadPausedPost = (deps: FlowDeps, pane: string, pause: AutoturnPause): LeadAlert => ({ head: "LEAD_AUTOTURN_PAUSED", pane, turns: pause.turns, template: deps.config.discord.leadPausedText, since: pause.since, reason: pause.reason });
const alertMarkPath = (deps: FlowDeps): string => join(deps.config.stateDir, "autoturn-lead-alert.json");
const readAlertMark = (deps: FlowDeps): { readonly pane?: string; readonly at?: string } => {
  try {
    return JSON.parse(readFileSync(alertMarkPath(deps), "utf8")) as { pane?: string; at?: string };
  } catch {
    return {};
  }
};
export const leadAlert = async (deps: FlowDeps, a: LeadAlert): Promise<readonly string[]> => {
  if (!deps.postLeadAlert) return [];
  const now = deps.clock.now();
  const last = readAlertMark(deps);
  const ago = last.pane === a.pane && last.at ? (now - Date.parse(last.at)) / 60_000 : Number.POSITIVE_INFINITY;
  const values = { pane: a.pane, turns: String(a.turns), since: stamp(deps, a.since), reason: a.reason };
  const text =
    ago < LEAD_ALERT_REPEAT_MIN
      ? `${a.head} ${a.pane} ${a.turns} repeat: ${fillWords(deps.config.discord.leadRepeatText, { ...values, min: String(Math.max(0, Math.floor(ago))), at: stamp(deps, last.at ?? "") })}`
      : `${a.head} ${a.pane} ${a.turns}: ${fillWords(a.template, values)}`;
  const lines = await deps.postLeadAlert(text).catch((e: unknown) => [`LEAD_ALERT_WARN ${String(e).slice(0, 160)}`]);
  // the window starts at the post that asked for a check, and only once it reached a channel
  if (ago >= LEAD_ALERT_REPEAT_MIN && lines.some((l) => l.startsWith("LEAD_ALERT_POSTED "))) writeFileSync(alertMarkPath(deps), `${JSON.stringify({ pane: a.pane, at: new Date(now).toISOString() })}\n`);
  return lines;
};

// cli's postLeadAlert: one post per configured channel (pair first, then the owner's), each answered by its own line
export const leadAlertPoster =
  (send: (channel: string, text: string) => Promise<string>, channels: { readonly pair: string; readonly owner: string }) =>
  async (text: string): Promise<string[]> =>
    Promise.all(
      // The owner's channel only when there is no pair channel: the alert is for the other Dori, the owner has nothing to
      // do with it (owner 2026-10-18 21:43 KST "경고 코드를 바로 나에게 보여주지 말고", 2026-10-20 00:10 KST).
      ([["pair", channels.pair], ["owner", channels.pair ? "" : channels.owner]] as const)
        .filter(([, id]) => id)
        .map(([name, id]) => send(id, text).then((m) => `LEAD_ALERT_POSTED ${name} ${id} ${m}`, (e: unknown) => `LEAD_ALERT_WARN ${name} ${id} ${String(e).slice(0, 160)}`)),
    );

// LANE_AUTOTURN_PAUSED once per pause of a lane's session (working, not-done or paused by the lead) or the lead's; up to
// autoturnResumeMax times in 24 hours per session it also types a short message that lifts the pause (to the lead its
// monitors cannot do that: a monitor notification is one more engine turn). Past the cap it only reports.
// LANE_AUTOTURN_LONG <key> <turns> <last user message time> each time the same session passes another autoturnLongTurns
// (300) turns started on its own since its last user message: the runaway alert once omo's own limit is off
// (engineTurns.maxPerUserInput 0). It is only a line in the watch log; nothing is typed or stopped.
export const autoturnTick = async (deps: FlowDeps): Promise<string[]> => {
  const lanes = (await deps.registry.open()).filter((l) => l.pane && ["working", "not-done", "paused"].includes(statusOf(l)));
  const lead = deps.config.leadPane;
  if (!lanes.length && !lead) return [];
  const [sessions, table] = await Promise.all([liveSessions(deps.run), procTable(deps.run)]);
  const now = deps.clock.now();
  const max = deps.config.autoturnResumeMax;
  const every = deps.config.autoturnLongTurns;
  const out: string[] = [];
  const targets: { readonly lane?: Lane; readonly pane: string; readonly cwd: string }[] = [
    ...lanes.map((lane) => ({ lane, pane: lane.pane ?? "", cwd: lane.cwd ?? sessionFor(sessions, lane.pane ?? "")?.path ?? "" })),
    ...(lead && !lanes.some((l) => l.pane === lead) ? [{ pane: lead, cwd: sessionFor(sessions, lead)?.path ?? "" }] : []),
  ];
  for (const t of targets) {
    if (!t.cwd || !sessionFor(sessions, t.pane)) continue;
    const key = t.lane?.key ?? "lead";
    let pause: AutoturnPause | undefined;
    let run: AutoturnRun | undefined;
    try {
      const file = await sessionFile(deps.run, deps.config.sessionsDir, t.pane, t.cwd, table);
      const text = file ? readTranscript(file.path) : undefined;
      pause = text ? autoturnPause(text.tail) : undefined;
      run = text && every > 0 ? runOf(text) : undefined;
    } catch (e) {
      out.push(`LANE_WATCH_WARN autoturn check ${key}: ${String(e).slice(0, 160)}`);
      continue;
    }
    const mark = t.lane ? t.lane.autoturn : readLeadMark(deps);
    const save = async (next: AutoturnMark): Promise<void> => {
      if (t.lane) await deps.registry.patch(t.lane.key, { autoturn: next });
      else writeFileSync(leadMarkPath(deps), `${JSON.stringify({ pane: t.pane, ...next })}\n`);
    };
    let long = mark?.long;
    if (run && run.turns >= every) {
      const step = Math.floor(run.turns / every) * every;
      if (long?.user !== run.lastUser || step > (long?.at ?? 0)) {
        long = { user: run.lastUser, at: step };
        out.push(`LANE_AUTOTURN_LONG ${key} ${run.turns} ${run.lastUser || "none"}`);
        if (!t.lane) out.push(...(await leadAlert(deps, leadRunawayPost(deps, t.pane, run))));
        if (!pause || mark?.since === pause.since) await save({ ...mark, long });
      }
    }
    if (!pause || mark?.since === pause.since) continue;
    const resumes = (mark?.resumes ?? []).filter((at) => now - Date.parse(at) < DAY_MS);
    const head = `LANE_AUTOTURN_PAUSED ${key} ${t.pane} ${pause.turns} turns on its own (${pause.reason}) since ${pause.since}`;
    let tail: string;
    if (resumes.length >= max) tail = `not resumed: ${resumes.length} resumes in 24h already (autoturnResumeMax ${max}), the lead decides`;
    else {
      const n = resumes.length + 1;
      const ok = await sendVerified(deps.run, deps.clock, deps.config, t.pane, t.lane ? laneText(t.lane, pause, n, max) : leadText(pause, n, max));
      if (ok) resumes.push(iso(deps.clock));
      tail = ok ? `resumed ${n}/${max} in 24h` : "resume NOT_SUBMITTED: the message did not reach the pane";
    }
    await save({ since: pause.since, resumes, ...(long ? { long } : {}) });
    out.push(`${head}; ${tail}`);
    if (!t.lane) out.push(...(await leadAlert(deps, leadPausedPost(deps, t.pane, pause))));
  }
  return out;
};

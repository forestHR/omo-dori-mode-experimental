#!/usr/bin/env bun
// Watches the other agent sessions (aoe/tmux, and herdr panes an agent runs in) and appends an event when one stops for a
// human: aoe reports `waiting` or `error`, a turn ended and the pane stayed idle (no goal continuation),
// or a briefed session printed a new `MILESTONE <id>:` line. Each event carries the pane's last
// 20 lines, the lane's thread from the dori registry and what the session last said (from its transcript),
// so the Dori can answer or ask the owner.
// Output: <stateDir>/session-events.jsonl, one JSON object per line, also printed to stdout.
import { appendFileSync, existsSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { aoeStates, captureTmux, liveSessions, paneLife, tmuxNameFor } from "../../scripts/src/aoe.ts";
import { sessionFile as paneSessionFile } from "../../scripts/src/background.ts";
import { loadConfig, loadEnvFile, envFilePath } from "../../scripts/src/config.ts";
import { Registry } from "../../scripts/src/registry.ts";
import { run } from "../../scripts/src/run.ts";
import { byStartTime, clockFree, dropSidePanel, lastSaid, sessionDir, watchContext, type Said } from "./session-watch-lib.ts";

const INTERVAL_MS = 15_000;
const IDLE_SETTLE_MS = 45_000;

await loadEnvFile(envFilePath());
const config = await loadConfig();
const registry = new Registry(config.stateDir);
const out = join(config.stateDir, "session-events.jsonl");

type Listed = { id: string; title: string; path: string };
type Seen = { busy: boolean; idleSince: number; notified: boolean; aoeState: string; body: string; milestone: string };
const seen = new Map<string, Seen>();

const sh = async (argv: string[]): Promise<string> => {
  const r = await run(argv);
  if (r.code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed: ${r.err.slice(0, 200)}`);
  return r.out;
};

// The screen is for state only; what a session last said comes from its own transcript, which no panel or wrap can hide.
// A resumed omo carries `--session <file>` in its argv; otherwise its tool children carry PI_SESSION_FILE;
// a fresh idle omo has neither, so fall back to the transcript in its cwd's session dir created closest to its start.
// Every way tells apart sessions sharing a cwd.
const sessionFile = async (tmux: string): Promise<string | null> => {
  const panePid = (await sh(["tmux", "display", "-p", "-t", `=${tmux}:`, "#{pane_pid}"])).trim();
  const kids = new Map<string, string[]>();
  for (const row of (await sh(["ps", "-eo", "pid=,ppid="])).split("\n")) {
    const [pid, ppid] = row.trim().split(/\s+/);
    if (pid && ppid) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  }
  const queue = [panePid];
  for (let pid = queue.shift(); pid; pid = queue.shift()) {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      const at = argv.indexOf("--session");
      const file = at >= 0 ? argv[at + 1] : undefined;
      if (file?.endsWith(".jsonl")) return file;
      const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find((v) => v.startsWith("PI_SESSION_FILE="));
      if (env) return env.slice("PI_SESSION_FILE=".length);
    } catch {
      // the process exited or belongs to another user; its children are still walked
    }
    queue.push(...(kids.get(pid) ?? []));
  }
  const omo = (kids.get(panePid) ?? []).find((pid) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("senpi");
    } catch {
      return false;
    }
  });
  if (!omo) return null;
  const startedMs = Date.now() - Number((await sh(["ps", "-o", "etimes=", "-p", omo])).trim()) * 1000;
  return byStartTime(sessionDir(join(homedir(), ".omo", "agent", "sessions"), readlinkSync(`/proc/${omo}/cwd`)), startedMs);
};

// a herdr pane's transcript: the session its agent runs (background.ts sessionFile, from its command line or start time)
const herdrSessionFile = async (pane: string, cwd: string): Promise<string | null> => (await paneSessionFile(run, config.sessionsDir, pane, cwd))?.path ?? null;

const said = async (tmux: string, cwd = ""): Promise<Said | null> => {
  try {
    const file = tmux.includes(":") ? await herdrSessionFile(tmux, cwd) : await sessionFile(tmux);
    return file && existsSync(file) ? lastSaid(file) : null;
  } catch (e) {
    console.error(`SESSION-WATCH-SAID-FAIL ${tmux} ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

const emit = (row: Record<string, unknown>): void => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...row });
  appendFileSync(out, `${line}\n`, { mode: 0o600 });
  console.log(line);
};

const tick = async (): Promise<void> => {
  const listed = await liveSessions(run);
  const aoeListed = listed.some((x) => !x.pane);
  const ps = aoeListed ? await aoeStates(run) : new Map<string, string>();
  const tmuxNames = aoeListed ? (await sh(["tmux", "ls", "-F", "#S"])).split("\n").filter(Boolean) : [];
  const lanes = await registry.open();
  const context = await watchContext(loadConfig, lanes);
  const now = Date.now();
  for (const s of listed) {
    // a herdr pane counts while an agent runs in it, as "running" (herdr has no waiting/error state for omo)
    const herdr = !!s.pane;
    const tmux = herdr ? s.pane : tmuxNameFor(s, tmuxNames);
    const aoeState = herdr ? (tmux && (await paneLife(run, tmux)).live ? "running" : undefined) : ps.get(s.id);
    if (!aoeState || !tmux || tmux.startsWith("aoe_term_") || context.skip.has(tmux)) {
      seen.delete(s.id);
      continue;
    }
    // -S -40: the omo side panel (5.1.27+) stacks under the transcript on narrow panes and can push the last report into scrollback
    const pane = herdr ? await captureTmux(run, tmux, 40) : await sh(["tmux", "capture-pane", "-p", "-S", "-40", "-t", `=${tmux}:`]);
    // state is judged on the visible screen only; scrollback can hold an old "esc to interrupt"
    const visible = pane.split("\n").slice(-24).join("\n");
    // omo shows "esc to interrupt" only while the main turn runs; aoe says `running` even when only background children do
    const busy = visible.includes("esc to interrupt");
    const goalContinuing = visible.includes("goal continues in");
    const lines = dropSidePanel(pane.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() && !/^[─━\s]+$/.test(l)));
    const promptAt = lines.findLastIndex((l) => l.startsWith("❯"));
    const body = clockFree((promptAt >= 0 ? lines.slice(0, promptAt) : lines).join("\n"));
    // the milestone id ("3", "4-auth") is the identity: sessions restate the same milestone in new words on each wake
    const milestone = lines.findLast((l) => /^\s*MILESTONE\b/.test(l) && !/in progress/i.test(l))?.match(/MILESTONE\s+([^\s:(]+)/)?.[1] ?? "";
    const base = { session: s.id, title: s.title, path: s.path, tmux, thread: context.thread(s.id, tmux), tail: lines.slice(-20).map((l) => l.slice(0, 200)) };
    const prev = seen.get(s.id);
    if (!prev) {
      seen.set(s.id, { busy, idleSince: now, notified: true, aoeState, body, milestone });
      continue;
    }
    if (milestone && milestone !== prev.milestone && !busy && goalContinuing) {
      emit({ kind: "session-milestone", ...base, said: await said(tmux, s.path) });
      prev.notified = true;
    }
    if (!busy) prev.milestone = milestone;
    if ((aoeState === "waiting" || aoeState === "error") && prev.aoeState !== aoeState) {
      emit({ kind: `session-${aoeState}`, ...base, said: await said(tmux, s.path) });
      prev.notified = true;
    }
    if (busy) prev.notified = false;
    else if (prev.busy || body !== prev.body) {
      prev.idleSince = now;
      prev.notified = false;
    }
    if (!busy && !prev.notified && !goalContinuing && now - prev.idleSince >= IDLE_SETTLE_MS) {
      emit({ kind: "session-idle", ...base, said: await said(tmux, s.path) });
      prev.notified = true;
    }
    prev.busy = busy;
    prev.aoeState = aoeState;
    prev.body = body;
  }
};

console.log("SESSION_WATCH_READY");
for (;;) {
  await tick().catch((e: unknown) => console.error(`SESSION-WATCH-FAIL ${e instanceof Error ? e.message : String(e)}`));
  await Bun.sleep(INTERVAL_MS);
}

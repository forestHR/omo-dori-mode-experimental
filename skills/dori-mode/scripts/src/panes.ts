import { readFileSync } from "node:fs";

import { aoeSessions, captureTmux, listAoePanes, paneLife, sessionFor, target, tmuxPanePid, waitForPrompt } from "./aoe.ts";
import { sessionFile } from "./background.ts";
import type { Backend, DoriConfig } from "./config.ts";
import { replacementOf } from "./frozen.ts";
import type { Clock, Runner } from "./run.ts";
import { AGENT, descendants, procTable } from "./session-id.ts";
import { type PaneKeys, submitText, type Submitted } from "./submit.ts";
import { watchLog } from "./watch-log.ts";

export type Pane = {
  readonly pane_id: string;
  readonly workspace_id: string;
  readonly tab_id?: string;
  readonly agent?: string;
  readonly agent_status?: string;
  readonly title?: string;
  readonly cwd?: string;
};

export class UnsafeTextError extends Error {}

export const listPanes = async (run: Runner, backend: Backend): Promise<Pane[]> => {
  if (backend === "aoe") return listAoePanes(run);
  const r = await run(["herdr", "pane", "list"]);
  if (r.code !== 0) throw new Error(`herdr pane list failed: ${r.err || r.out}`);
  return (JSON.parse(r.out) as { result: { panes: Pane[] } }).result.panes;
};

export const readScreen = async (run: Runner, backend: Backend, pane: string, lines?: number): Promise<string> =>
  backend === "aoe"
    ? captureTmux(run, pane, lines)
    : (await run(["herdr", "pane", "read", pane, "--source", lines ? "recent" : "visible", ...(lines ? ["--lines", String(lines)] : [])])).out;

// tmux refuses one send-keys argument much longer than 16 KB (2026-10-19: 15,000 bytes typed, 20,000 refused), so a long
// text (a directive block, a report) is typed in pieces of at most this many bytes, whole characters only, before the Enter.
export const SEND_CHUNK_BYTES = 4_000;

export const sendChunks = (text: string, max = SEND_CHUNK_BYTES): string[] => {
  const out: string[] = [];
  let part = "";
  let bytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > max && part) {
      out.push(part);
      [part, bytes] = ["", 0];
    }
    part += ch;
    bytes += n;
  }
  return part ? [...out, part] : out;
};

// The session's transcript holds the text as a user message at or after since (ms). A long text is matched by its first
// line, which omo keeps as typed; a paste-folded text shows up whole in the transcript.
export const transcriptHas = (transcript: string, text: string, since: number): boolean => {
  const head = (text.split("\n")[0] ?? "").trim().slice(0, 80);
  if (!head) return false;
  return transcript.split("\n").some((line) => {
    if (!line.includes('"user"')) return false;
    try {
      const o = JSON.parse(line) as { timestamp?: string; message?: { role?: string; content?: unknown } };
      if (o.message?.role !== "user" || !(Date.parse(o.timestamp ?? "") >= since)) return false;
      const c = o.message.content;
      const said = typeof c === "string" ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? "").join("\n") : "";
      return said.includes(head);
    } catch {
      return false;
    }
  });
};

export const paneTranscript = async (run: Runner, sessionsDir: string, pane: string): Promise<string | undefined> => {
  const cwd = sessionFor(await aoeSessions(run), pane)?.path;
  return cwd ? (await sessionFile(run, sessionsDir, pane, cwd))?.path : undefined;
};

export const paneTranscriptHas = async (run: Runner, sessionsDir: string, pane: string, text: string, since: number): Promise<boolean> => {
  const path = await paneTranscript(run, sessionsDir, pane).catch(() => undefined);
  try {
    return !!path && transcriptHas(readFileSync(path, "utf8"), text, since);
  } catch {
    return false;
  }
};

// Whether an aoe pane's omo session recorded the text since the send; the transcript file is looked up once per send.
const transcriptCheck = (run: Runner, clock: Clock, sessionsDir: string, pane: string, text: string): (() => Promise<boolean>) => {
  const since = clock.now() - 1_000;
  let file: Promise<string | undefined> | undefined;
  return async () => {
    file ??= paneTranscript(run, sessionsDir, pane).catch(() => undefined);
    const path = await file;
    if (!path) return false;
    try {
      return transcriptHas(readFileSync(path, "utf8"), text, since);
    } catch {
      return false;
    }
  };
};

// A stopped agent (SIGSTOP, state T: frozen by a handover) reads nothing, while its screen keeps whatever it showed, a
// running turn included, so the screen would pass a text typed there as taken. Its pid when stopped, else undefined.
export const stoppedAgent = async (run: Runner, pane: string): Promise<number | undefined> => {
  const shell = await tmuxPanePid(run, pane);
  if (!shell) return undefined;
  const table = await procTable(run);
  // the pane's own process counts too: a pane started with the agent as its command has no shell above it
  const agent = [...table.filter((p) => p.pid === shell), ...descendants(table, shell)].find((p) => AGENT.test(p.cmd) && !/\bmcp\b/.test(p.cmd));
  return agent?.stat?.startsWith("T") ? agent.pid : undefined;
};

const paneKeys = (run: Runner, clock: Clock, config: DoriConfig, pane: string, text: string): PaneKeys =>
  config.backend === "aoe"
    ? {
        type: async (text) => {
          // named, so a lead does not read a missing pane as a busy one (the prompt check below would say "no ❯ prompt")
          const life = await paneLife(run, pane);
          if (!life.live) return life.how === "gone" ? `PANE_GONE: there is no tmux session ${pane} (it ended, or the name is wrong); nothing was typed` : `PANE_DEAD: the program in ${pane} exited (status ${life.status}); nothing was typed`;
          const stopped = await stoppedAgent(run, pane);
          if (stopped) return `the agent in the pane is stopped (pid ${stopped}, frozen): nothing would read the text, so it was not typed`;
          if (!(await waitForPrompt(run, clock, pane, 10, 1_000))) return "no ❯ prompt in the pane";
          for (const part of sendChunks(text)) if ((await run(["tmux", "send-keys", "-t", target(pane), "-l", "--", part])).code !== 0) return "tmux send-keys failed";
          return undefined;
        },
        enter: async () => { await run(["tmux", "send-keys", "-t", target(pane), "Enter"]); },
        read: () => captureTmux(run, pane),
        delivered: transcriptCheck(run, clock, config.sessionsDir, pane, text),
      }
    : {
        type: async (text) => ((await run(["herdr", "pane", "send-text", pane, text])).code === 0 ? undefined : "herdr send-text failed"),
        enter: async () => { await run(["herdr", "pane", "send-keys", pane, "enter"]); },
        read: () => readScreen(run, config.backend, pane),
      };

// A slash command (/goal pause) runs in omo itself and never becomes a user message of the transcript, so it cannot be
// confirmed the way submitToPane confirms a text; the caller reads its effect back instead. Typed into a live aoe pane
// only: undefined when typed and entered, else why not.
export const typeLine = async (run: Runner, clock: Clock, config: DoriConfig, pane: string, text: string): Promise<string | undefined> => {
  const keys = paneKeys(run, clock, config, pane, text);
  const why = await keys.type(text);
  if (why) return why;
  await clock.sleep(500);
  await keys.enter();
  return undefined;
};

// Every text the scripts type into a pane goes through here; NOT_SUBMITTED lands in the watch log for the lead. A pane a
// handover froze reads nothing, so the text goes to the session that replaced it (pane: where it went; FORWARDED in the
// watch log).
export const submitToPane = async (run: Runner, clock: Clock, config: DoriConfig, pane: string, text: string): Promise<Submitted & { readonly pane: string }> => {
  if (/`|\$\(/.test(text)) throw new UnsafeTextError("refusing to send text containing a backtick or $(");
  const to = replacementOf(config.stateDir, pane) ?? pane;
  if (to !== pane) watchLog(config.watchLog, clock, { source: "submit", line: `FORWARDED ${pane} -> ${to}: ${pane} was frozen by a handover; the text goes to the session that replaced it` });
  const result = await submitText(paneKeys(run, clock, config, to, text), clock, text);
  if (result.status === "NOT_SUBMITTED") watchLog(config.watchLog, clock, { source: "submit", line: `NOT_SUBMITTED ${to} ${result.reason}` });
  return { ...result, pane: to };
};

export const sendVerified = async (run: Runner, clock: Clock, config: DoriConfig, pane: string, text: string): Promise<boolean> =>
  (await submitToPane(run, clock, config, pane, text)).status === "SUBMITTED";

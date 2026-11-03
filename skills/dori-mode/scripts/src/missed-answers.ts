import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { liveSessions, sessionFor } from "./aoe.ts";
import { sessionFile } from "./background.ts";
import type { FlowDeps } from "./done-flow.ts";
import type { Question } from "./messenger/discord-cards.ts";
import { sendVerified } from "./panes.ts";
import { iso } from "./run.ts";
import { procTable } from "./session-id.ts";

// A card's answer reaches the session that asked only as one inbox row its monitor turns into an event. An event that
// arrives while omo compacts the session's context is lost (2026-10-19: Q305 answered 20:37:23Z during the lead's
// compaction 20:37:03-31Z never reached it, and the lead kept waiting). So the watch reads each card answered in the last
// MISSED_ANSWER_WINDOW_MS, at least MISSED_ANSWER_GRACE_MS ago, and looks in the transcript of the session that asked
// (the card's tmux, else the lead's pane) for that answer: the inbox row ("qid":"Qn" in a monitor event or a tool result)
// or this sweep's own line. Missing, and answered after that session started: the answer is typed into that pane once.
// Nothing goes to the owner's channel: CARD_ANSWER_REDELIVERED / _NOT_SUBMITTED / _GAVE_UP are watch log lines.
export const MISSED_ANSWER_GRACE_MS = 3 * 60_000;
export const MISSED_ANSWER_WINDOW_MS = 2 * 60 * 60_000;
const MAX_TRIES = 3;

type Marks = Record<string, { readonly at: string; readonly tries: number; readonly sent: boolean }>;
const marksPath = (deps: FlowDeps): string => join(deps.config.stateDir, "answers-redelivered.json");
const readMarks = (deps: FlowDeps): Marks => {
  const path = marksPath(deps);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Marks;
  } catch {
    return {};
  }
};

export const answerLine = (q: Question): string =>
  `[DORI] ANSWER ${q.id} (${q.answerKind ?? "button"}, ${q.answeredAt}): ${q.answer ?? ""}\nquestion: ${q.text}\n(the inbox monitor's event for this answer never reached this session, e.g. it came during a context compaction; this is that answer)`;

// The transcript holds the answer: its inbox row (raw or escaped inside an event or a tool result) or this sweep's line.
export const sawAnswer = (transcript: string, qid: string): boolean =>
  new RegExp(`\\\\*"qid\\\\*"\\s*:\\s*\\\\*"${qid}\\\\*"`).test(transcript) || transcript.includes(`[DORI] ANSWER ${qid} (`);

const sessionStart = (transcript: string): number => {
  const first = transcript.slice(0, transcript.indexOf("\n") >>> 0);
  try {
    return Date.parse((JSON.parse(first) as { timestamp?: string }).timestamp ?? "");
  } catch {
    return Number.NaN;
  }
};

export const missedAnswersTick = async (deps: FlowDeps): Promise<string[]> => {
  const now = deps.clock.now();
  const cards = (deps.answeredCards?.() ?? []).filter((q) => {
    const at = Date.parse(q.answeredAt ?? "");
    return q.status === "answered" && now - at >= MISSED_ANSWER_GRACE_MS && now - at < MISSED_ANSWER_WINDOW_MS;
  });
  const marks = readMarks(deps);
  const due = cards.filter((q) => !marks[q.id]?.sent && (marks[q.id]?.tries ?? 0) < MAX_TRIES && (q.tmux || deps.config.leadPane));
  if (!due.length) return [];
  const [sessions, table] = await Promise.all([liveSessions(deps.run), procTable(deps.run)]);
  const out: string[] = [];
  const transcripts = new Map<string, string | undefined>();
  for (const q of due) {
    const pane = q.tmux || deps.config.leadPane;
    const cwd = sessionFor(sessions, pane)?.path;
    if (!cwd) continue;
    if (!transcripts.has(pane)) {
      const file = await sessionFile(deps.run, deps.config.sessionsDir, pane, cwd, table);
      transcripts.set(pane, file ? readFileSync(file.path, "utf8") : undefined);
    }
    const text = transcripts.get(pane);
    // a session that started after the answer (a rollover) did not ask: the handover carries what it needs
    if (!text || sawAnswer(text, q.id) || !(sessionStart(text) < Date.parse(q.answeredAt ?? ""))) continue;
    const ok = await sendVerified(deps.run, deps.clock, deps.config, pane, answerLine(q));
    const tries = (marks[q.id]?.tries ?? 0) + 1;
    marks[q.id] = { at: iso(deps.clock), tries, sent: ok };
    out.push(
      ok
        ? `CARD_ANSWER_REDELIVERED ${q.id} ${pane}: answered ${q.answeredAt}, not in that session's transcript; typed it there (SUBMITTED)`
        : tries >= MAX_TRIES
          ? `CARD_ANSWER_GAVE_UP ${q.id} ${pane}: ${tries} tries did not reach the pane; read it with dori questions`
          : `CARD_ANSWER_NOT_SUBMITTED ${q.id} ${pane}: answered ${q.answeredAt}, not in that session's transcript; the message did not reach the pane (try ${tries}/${MAX_TRIES})`,
    );
  }
  writeFileSync(marksPath(deps), `${JSON.stringify(marks, null, 1)}\n`);
  return out;
};

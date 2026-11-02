import { BUSY_MARK } from "./aoe.ts";
import type { Clock } from "./run.ts";

// Typing into an agent pane only counts once the agent took it: a long or multi-line text folds into
// "[paste #1 +13 lines]" and an Enter sent right after it can be lost, leaving the text unsent while the
// old "is the start of the text still on the ❯ line" check passed (okdori, 2026-10-11).
export type Submitted = { readonly status: "SUBMITTED" | "NOT_SUBMITTED"; readonly reason: string };

export type PaneKeys = {
  // types the text without Enter; a returned string is why it could not
  readonly type: (text: string) => Promise<string | undefined>;
  readonly enter: () => Promise<void>;
  readonly read: () => Promise<string>;
  // the agent's own record: true once the session's transcript holds the text as a user message. omo can empty the input
  // box without a visible running turn either way: a short turn ends between two screen reads, while a text typed when
  // the main turn waits on its children sits in omo's input queue, undelivered, until that turn's prompt returns
  // (pingpong-analytics, 2026-10-31: three lead texts never reached its transcript)
  readonly delivered?: () => Promise<boolean>;
  // deletes the input box's text before the cursor, one line per call (omo's ctrl+u; at a line start it joins the line
  // above), so a text that was not submitted is not left behind for the next one to be typed after
  readonly clear?: () => Promise<void>;
};

export type SubmitTiming = { readonly settleMs: number; readonly pollMs: number; readonly clearPolls: number; readonly busyPolls: number };
export const SUBMIT_TIMING: SubmitTiming = { settleMs: 1_500, pollMs: 500, clearPolls: 6, busyPolls: 30 };

const isBorder = (line: string): boolean => line.trimStart().startsWith("─");

// senpi draws a side panel (FILES, TOOLS, MEMORY) right of the input box on a wide pane, on the same rows:
// the ─ border stops where the panel starts, so a row cut at the border's width holds only the box's own text
// (e7-beyond-eth, 2026-10-15: "?? fp_clay_101.log" from the FILES panel read as unsent text six times).
// (a top border may carry the running-turn status inside it, so the box ends after the border's last ─)
const borderWidth = (line: string): number => Bun.stringWidth(line.slice(0, line.lastIndexOf("─") + 1));
const cutAt = (line: string, width: number): string => {
  let out = "";
  let used = 0;
  for (const ch of line) {
    used += Bun.stringWidth(ch);
    if (used > width) break;
    out += ch;
  }
  return out;
};

// The agent's input box: the lines between the last two ─ borders (a tall box scrolls its ❯ line out of
// view, so "from ❯ down" misses text), cut at the borders' width. A screen without two borders falls back
// to the last ❯ line.
const inputBox = (screen: string): { readonly top: number; readonly width: number; readonly lines: readonly string[] } => {
  const lines = screen.split("\n");
  const borders = lines.flatMap((line, i) => (isBorder(line) ? [i] : []));
  const top = borders.at(-2);
  const bottom = borders.at(-1);
  if (top !== undefined && bottom !== undefined) {
    const width = Math.min(borderWidth(lines[top] ?? ""), borderWidth(lines[bottom] ?? ""));
    return { top, width, lines: lines.slice(top + 1, bottom).map((line) => cutAt(line, width)) };
  }
  const prompt = lines.findLastIndex((line) => line.trimStart().startsWith("❯"));
  return prompt < 0 ? { top: lines.length, width: Infinity, lines: [] } : { top: prompt, width: Infinity, lines: [lines[prompt] ?? ""] };
};

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

// A text sent while a turn runs waits in senpi's queue above the input box as "Steering: <text>" (one line,
// cut to the box): the agent took it. Only a queue line that starts like the sent text counts.
export const steeringQueued = (screen: string, text: string): boolean => {
  const head = squash(text.split("\n")[0] ?? "").slice(0, 24);
  if (!head) return false;
  const box = inputBox(screen);
  return screen.split("\n").slice(0, box.top).some((line) => {
    const shown = cutAt(line, box.width).trimStart();
    if (!shown.startsWith("Steering: ")) return false;
    const queued = squash(shown.slice("Steering: ".length)).replace(/…$/, "");
    return queued.startsWith(head) || (queued.length >= 8 && head.startsWith(queued));
  });
};

// What is still unsent in the input box, the ❯ and whitespace folded away; "" when the box is empty
export const editorText = (screen: string): string =>
  inputBox(screen).lines.map((line) => line.replace(/^\s*❯/, "")).join(" ").replace(/\s+/g, " ").trim();

// The running-turn mark sits on or just above the input box; the transcript higher up may quote it
export const turnRunning = (screen: string): boolean => {
  const lines = screen.split("\n");
  return lines.slice(Math.max(0, inputBox(screen).top - 3)).some((line) => line.toLowerCase().includes(BUSY_MARK));
};

// A text the Enters did not submit stays in the box, and the next text typed there lands after it (dori-superagent issue
// #13, https://github.com/sisyphuslabs/dori-superagent/issues/13, MIT: a stranded prompt held up every later one). Only
// a box that was empty before this text is cleared: then all of it is ours, a paste-collapsed "[paste #1 ...]" too.
const clearOwn = async (keys: PaneKeys, clock: Clock, timing: SubmitTiming, text: string, emptyBefore: boolean): Promise<string> => {
  if (!keys.clear) return "left in the box";
  if (!emptyBefore) return "left in the box: it held other text before this one";
  // a line takes one press to empty and one more to join the line above: 2 per line, and 2 spare
  for (let i = 0; i < 2 * text.split("\n").length + 2; i++) {
    await keys.clear();
    await clock.sleep(timing.pollMs);
    if (!editorText(await keys.read())) return "cleared from the box";
  }
  return "could not be cleared from the box";
};

export const submitText = async (keys: PaneKeys, clock: Clock, text: string, timing: SubmitTiming = SUBMIT_TIMING): Promise<Submitted> => {
  const failed = (reason: string): Submitted => ({ status: "NOT_SUBMITTED", reason });
  const emptyBefore = keys.clear ? !editorText(await keys.read()) : false;
  const typed = await keys.type(text);
  if (typed) return failed(typed);
  await clock.sleep(timing.settleMs); // let the agent take the whole text (a long one arrives as a paste) before Enter
  let screen = "";
  let left = "";
  for (let enter = 1; enter <= 2; enter++) {
    await keys.enter();
    for (let poll = 0; poll < timing.clearPolls; poll++) {
      await clock.sleep(timing.pollMs);
      screen = await keys.read();
      left = editorText(screen);
      if (!left) break;
    }
    if (!left) break;
  }
  if (left) return failed(`text still in the input box after 2 Enters: ${left.slice(0, 60)}; ${await clearOwn(keys, clock, timing, text, emptyBefore)}`);
  for (let poll = 0; poll < timing.busyPolls; poll++) {
    if (turnRunning(screen)) return { status: "SUBMITTED", reason: "input box empty and the turn runs" };
    if (steeringQueued(screen, text)) return { status: "SUBMITTED", reason: "input box empty and the text waits in the Steering queue" };
    if (keys.delivered && (await keys.delivered())) return { status: "SUBMITTED", reason: "input box empty and the session's transcript has the text" };
    await clock.sleep(timing.pollMs);
    screen = await keys.read();
  }
  const within = `within ${(timing.busyPolls * timing.pollMs) / 1000}s`;
  return failed(keys.delivered
    ? `input box empty but no running turn ("${BUSY_MARK}") and the text is not in the session's transcript ${within} (omo holds a text typed while the main turn waits on its children; it may arrive when that turn ends)`
    : `input box empty but no running turn ("${BUSY_MARK}") ${within}`);
};

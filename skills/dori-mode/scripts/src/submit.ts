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
  // the pane runs omo, so a command omo runs itself counts as taken once omo empties the box (isOmoCommand); another
  // agent may take the same /text as an ordinary prompt
  readonly runsOmoCommands?: boolean;
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

// A slash command (/thinking low, /goal pause) runs in omo itself and never becomes a user message of the transcript (/goal
// pause writes nothing there at all), and its notice above the box is no proof either: omo rewrites the last status line in
// place, so a repeated /thinking low changes nothing on screen. What omo does is empty the box as it dispatches the command:
// senpi's onSubmit runs these built-ins, and omo's /goal extension command, before the compaction queue and the streaming
// steer that can hold a plain text (senpi dist/modes/interactive/interactive-mode.js, omo 5.1.5x). Any other /text (a
// skill, a prompt template, a command omo does not know) is ordinary input omo can hold, so it keeps the plain-text checks
// (test pane w1:p17 on 2026-11-03: /thinking low applied, yet read NOT_SUBMITTED for want of a transcript message).
const OMO_COMMANDS = new Set(["/settings", "/favorite-models", "/scoped-models", "/model", "/thinking", "/export", "/import", "/share", "/copy", "/rename", "/name", "/session", "/changelog", "/keybindings", "/answer", "/hotkeys", "/fork", "/clone", "/tree", "/trust", "/login", "/logout", "/new", "/compact", "/reload", "/debug", "/resume", "/sessions", "/quit", "/exit", "/goal"]);
// the ones omo also runs with an argument after a space; the rest only as the whole text
const WITH_ARGS = new Set(["/model", "/thinking", "/export", "/import", "/rename", "/name", "/answer", "/login", "/compact", "/goal"]);
export const isOmoCommand = (text: string): boolean => {
  if (text.includes("\n")) return false;
  const name = text.split(" ")[0] ?? "";
  return OMO_COMMANDS.has(name) && (name === text || WITH_ARGS.has(name));
};

// omo refuses a /word it has no command for (a typo, a skill that is not there): it puts the text back into the box and
// shows "Unknown command /x." with "Enter again sends it as a message" (senpi interactive-mode.js
// reportUnknownCommandRejection, unknown-command-feedback.js), so a second Enter would send the text to the agent. Only a
// refusal that names this text's command counts, with that text back in the box; the warning can sit lines above the box,
// and omo wraps it on a narrow pane (even inside the name), so the rows above the box are read as one run with every
// whitespace taken out. A path (/usr/bin/ls) is no command to omo and goes as a message on the first Enter, and so does
// a text typed with a space before the / (unknown-command-feedback.js submitsCommandAsText: raw text starting with whitespace).
const COMMAND_TOKEN = /^\/[A-Za-z][A-Za-z0-9:_-]*$/;
type Refusal = { readonly name: string };
const refusedUnknown = (screen: string, text: string): Refusal | undefined => {
  const name = text.split(/\s/, 1)[0] ?? "";
  // the box shows the text again, or the part of it a wrapped or scrolled box shows (wrapped rows read as spaces)
  const shown = editorText(screen).replace(/\s/g, "");
  if (!COMMAND_TOKEN.test(name) || !shown || !text.replace(/\s/g, "").includes(shown)) return undefined;
  const box = inputBox(screen);
  const run = screen.split("\n").slice(0, box.top).map((line) => cutAt(line, box.width)).join("").replace(/\s/g, "");
  if (!run.includes(`Unknowncommand${name}.`) && !run.includes(`${name}isaninteractivecommand`)) return undefined;
  return run.includes("againsendsitasamessage") ? { name } : undefined;
};

// The box is on screen with its ❯ line: an empty box read off a screen that shows none (the pane went away, a read
// that failed) proves nothing
const promptShown = (screen: string): boolean => inputBox(screen).lines.some((line) => line.trimStart().startsWith("❯"));

// What is still unsent in the input box, the ❯ and whitespace folded away; "" when the box is empty
export const editorText = (screen: string): string =>
  inputBox(screen).lines.map((line) => line.replace(/^\s*❯/, "")).join(" ").replace(/\s+/g, " ").trim();

// omo draws the running-turn mark ("── • Working (4s • esc to interrupt) ──") on the input box's top border, right above
// the ❯ line (15 real captures, omo 5.1.51). Only that border and the 3 lines above it are read: the transcript higher
// up may quote the words, and so may the status lines under the box (a session title omo made from the prompt, the goal
// objective, the cwd), which once kept an idle lane's first turn "on" (STARTUP_PENDING_GOAL) with no goal set. A screen
// without the box's borders shows no such line between the box and the status lines, so there it is read to the end
export const turnRunning = (screen: string): boolean => {
  const lines = screen.split("\n");
  const top = inputBox(screen).top;
  const end = isBorder(lines[top] ?? "") ? top + 1 : lines.length;
  return lines.slice(Math.max(0, top - 3), end).some((line) => line.toLowerCase().includes(BUSY_MARK));
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
  const command = !!keys.runsOmoCommands && isOmoCommand(text);
  const first = keys.clear || command ? await keys.read() : "";
  const emptyBefore = keys.clear ? !editorText(first) : false;
  // only into a box seen empty is the typed text all that omo gets (after a draft it is one ordinary message)
  const commandAlone = command && promptShown(first) && !editorText(first);
  const typed = await keys.type(text);
  if (typed) return failed(typed);
  await clock.sleep(timing.settleMs); // let the agent take the whole text (a long one arrives as a paste) before Enter
  let screen = "";
  let left = "";
  let refused: Refusal | undefined;
  const waitEmpty = async (): Promise<void> => {
    for (let poll = 0; poll < timing.clearPolls; poll++) {
      await clock.sleep(timing.pollMs);
      screen = await keys.read();
      left = editorText(screen);
      if (!left) return;
      refused = keys.runsOmoCommands ? refusedUnknown(screen, text) : undefined;
      if (refused) return;
    }
  };
  for (let enter = 1; enter <= 2 && !refused; enter++) {
    await keys.enter();
    await waitEmpty();
    if (!left) break;
  }
  // no other key after omo's refusal: the text is taken out of a box that was empty before, as for any text left there.
  // omo keeps the refusal armed until Esc or its next submit (taking it back from here is a follow-up).
  if (refused)
    return failed(`SLASH_UNKNOWN: omo has no command ${refused.name} and asked for one more Enter to send the text to the agent as a message; dori type did not press it, so nothing was sent; ${await clearOwn(keys, clock, timing, text, emptyBefore)}. To send it as a message, put a space before the / (--text " ${text}")`);
  if (left) return failed(`text still in the input box after 2 Enters: ${left.slice(0, 60)}; ${await clearOwn(keys, clock, timing, text, emptyBefore)}`);
  if (commandAlone && promptShown(screen)) return { status: "SUBMITTED", reason: "input box empty: omo took the command from it to run it" };
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

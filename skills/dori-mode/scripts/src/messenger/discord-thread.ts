import type { DiscordWords } from "../config.ts";
import type { Discord } from "./discord.ts";
import type { DiscordFile } from "./upload-files.ts";

export class ThreadRefError extends Error {}

export const discordThreadId = (ref: string): string => {
  const id = /^discord:(\d{5,25})$/.exec(ref.trim())?.[1];
  if (!id) throw new ThreadRefError(`not a Discord thread ref: "${ref}" (expected discord:<thread id>)`);
  return id;
};

export const withoutEmoji = (text: string): string =>
  text
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

export type ThreadStatus = "working" | "waiting" | "done";

// A standing thread (thread-map.ts) wears its own mark whatever the status events ask; it is not one of the statuses.
export type ThreadMark = ThreadStatus | "standing";

export const STATUS_EMOJI: Readonly<Record<ThreadMark, string>> = { working: "🔄", waiting: "⏸️", done: "✅", standing: "📌" };

// either style's mark, so switching statusStyle never leaves two marks on one name
const STATUS_PREFIX = /^(?:\[[^\]]{1,20}\]|(?:🔄|⏸|✅|⏳)\uFE0F?)\s*/u;
const EMOJI_PREFIX = /^(?:🔄|⏸|✅|⏳)\uFE0F?\s*/u;

export const statusMark = (status: ThreadMark, words: DiscordWords): string => (words.statusStyle === "emoji" ? STATUS_EMOJI[status] : `[${words[status]}]`);

// The name without any leading status marks: "🔄 🔄 x" and "✅ 🔄 x" both give "x". A title passed in with its own
// mark, or an earlier rename that kept one, would otherwise stack marks. Any one bracket in front goes (an older
// words setting); after that only emoji and this setting's [word] marks do, so a title's own "[tag]" stays.
// The closing word an approval thread of Autophagy (Yoodori) gets from its own code ("✅ 완료 · ", "⛔ 취소 · "):
// one mark too. It is stripped like ours, so neither side stacks on the other ("✅ ⛔ 취소 · x", "🔄 완료 · x").
const OUTCOME_PREFIX = /^(?:✅ 완료|⛔ 취소|⌛ 만료|❗ 실패) · /u;

const splitMarks = (name: string, words: DiscordWords): { readonly outcome?: string; readonly rest: string } => {
  const marks = new Set<string>(["working", "waiting", "done"].map((s) => `[${words[s as ThreadStatus]}]`));
  let outcome: string | undefined;
  let rest = name.trimStart();
  let first = true;
  for (;;) {
    const closing = OUTCOME_PREFIX.exec(rest)?.[0];
    const word = /^\[[^\]]{1,20}\]/u.exec(rest)?.[0];
    const next = closing
      ? rest.slice(closing.length).trimStart()
      : first
        ? rest.replace(STATUS_PREFIX, "")
        : word && marks.has(word)
          ? rest.slice(word.length).trimStart()
          : rest.replace(EMOJI_PREFIX, "");
    if (closing) outcome ??= closing.slice(0, -" · ".length);
    if (next === rest && !first) return { outcome, rest };
    first = false;
    rest = next;
  }
};

export const bareThreadName = (name: string, words: DiscordWords): string => splitMarks(name, words).rest;

// 📌 is not a status mark to every other name, so a title of its own that starts with one stays: only a standing mark
// being set (one 📌, not two) or released (unpin) takes it off.
export const unpinnedName = (name: string, words: DiscordWords): string => bareThreadName(name, words).replace(/^(?:📌\uFE0F?\s*)+/u, "");

// Done keeps how an Autophagy request ended (⛔ 취소 stays ⛔ 취소, ❗ 실패 never turns into ✅); every other status replaces it.
export const threadName = (status: ThreadMark, title: string, words: DiscordWords, unpin = false): string => {
  const outcome = status === "done" ? splitMarks(title, words).outcome : undefined;
  const rest = unpin || status === "standing" ? unpinnedName(title, words) : bareThreadName(title, words);
  return outcome ? `${outcome} · ${rest}` : `${statusMark(status, words)} ${rest}`;
};

export const isDoneName = (name: string, words: DiscordWords): boolean => name.startsWith(STATUS_EMOJI.done) || name.startsWith(`[${words.done}]`);

export const progressText = (status: "working" | "done", text: string, words: DiscordWords): string =>
  words.statusStyle === "emoji" ? (status === "working" ? `⏳ · ${text}` : `${STATUS_EMOJI.done} ${text}`) : `${words[status]}: ${text}`;

export type ThreadInfo = { readonly name?: string; readonly type?: number; readonly thread_metadata?: { readonly archived?: boolean } };

// Discord channel types that are threads (announcement, public, private). Only these get a status mark: a text
// channel, forum or category passed in as a "thread" (a card asked with --thread pointing at the channel) keeps its name.
const THREAD_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);

export class NotAThreadError extends ThreadRefError {}

// The status a thread should show, from the truth rather than the last event: a closed lane is done; otherwise a lane
// still working on the thread makes it working (waiting means nothing is left on our side, so neither an open card nor a
// wait shows it while a lane works); otherwise any open question card makes it waiting; otherwise the event's own status
// (working, or an explicit wait).
export const desiredStatus = (hint: ThreadStatus, openCards: readonly string[], workingLanes: readonly string[] = []): ThreadStatus =>
  hint === "done" ? "done" : workingLanes.length ? "working" : openCards.length ? "waiting" : hint;

// Discord rate-limits thread renames (about two per ten minutes), so nothing is sent when the status already holds.
// Resolves true when it sent a change.
export const setThreadStatus = async (dc: Discord, threadId: string, status: ThreadMark, words: DiscordWords, current?: ThreadInfo, unpin = false): Promise<boolean> => {
  const info = current ?? (await dc.call<ThreadInfo>("GET", `/channels/${threadId}`));
  if (info.type === undefined || !THREAD_TYPES.has(info.type)) throw new NotAThreadError(`channel ${threadId} is not a thread (type ${info.type ?? "unknown"}); its name is left alone`);
  const name = info.name ?? "";
  const next = threadName(status, name, words, unpin);
  const archived = info.thread_metadata?.archived === true;
  if (status === "done") {
    if (next === name && archived) return false;
    if (next !== name) {
      // Discord refuses to rename an archived thread (50083), so it is opened, renamed, then archived again
      if (archived) await dc.setThread(threadId, { archived: false });
      await dc.setThread(threadId, { name: next });
    }
    await dc.setThread(threadId, { archived: true });
    return true;
  }
  if (next === name && !archived) return false;
  await dc.setThread(threadId, { ...(next !== name ? { name: next } : {}), ...(archived ? { archived: false } : {}) });
  return true;
};

export type ThreadVerb = "reply" | "wait" | "done";
export const VERB_STATUS: Readonly<Record<ThreadVerb, ThreadStatus>> = { reply: "working", wait: "waiting", done: "done" };

// dori launch writes the lane's first message in its work thread, so a thread opened for a lane never sits empty;
// a thread that already has a message (the lead wrote first, or it was started from a message) is left as it is.
export const postLaneStart = async (dc: Discord, ref: string, text: string): Promise<string> => {
  const id = discordThreadId(ref);
  const existing = await dc.call<readonly unknown[]>("GET", `/channels/${id}/messages?limit=1`);
  if (existing.length) return `THREAD_START_SKIP ${ref}: the thread already has a message`;
  return `THREAD_START_POSTED ${ref} message=${await dc.send(id, text)}`;
};

// Posts in a work thread (typing first, emoji removed) and leaves its status mark alone: a lane closing in a thread
// that another open lane or an open card still uses. With files the text may be empty.
export const postInThread = async (dc: Discord, ref: string, text: string, files: readonly DiscordFile[] = []): Promise<string> => {
  const id = discordThreadId(ref);
  const plain = withoutEmoji(text);
  if (!plain && !files.length) throw new ThreadRefError("nothing to post after removing emoji");
  await dc.typing(id).catch(() => {});
  return dc.send(id, plain, false, undefined, undefined, files);
};

// With `mark` (the thread status queue) the status goes through it, so it is coalesced, survives a 429 and an open
// question card keeps the thread waiting; without it the status is set directly.
export const threadHook = async (dc: Discord, verb: ThreadVerb, ref: string, text: string, words: DiscordWords, mark?: (thread: string, status: ThreadStatus) => Promise<unknown>, files: readonly DiscordFile[] = []): Promise<string> => {
  const id = discordThreadId(ref);
  const posted = await postInThread(dc, ref, text, files);
  await (mark ? mark(id, VERB_STATUS[verb]) : setThreadStatus(dc, id, VERB_STATUS[verb], words));
  return posted;
};

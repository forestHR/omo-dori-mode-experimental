// upstream dori-superagent #76 (https://github.com/sisyphuslabs/dori-superagent/pull/76, closes its issue #74), as merged there
import { mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import type { Telegram } from "./telegram.ts";

export type TgInbound = {
  readonly source: "dm" | "topic";
  readonly chat: number;
  readonly thread?: number;
  readonly updateId: number;
  readonly from: number;
  readonly username?: string;
  readonly text?: string;
};

/**
 * Owner-gated Telegram inbound: DMs from the configured owner and, when a group topic is
 * configured, that owner's messages in that topic only. Everything else is dropped.
 */
export type TgInboundOptions = {
  readonly ownerId: number;
  readonly groupChatId?: number;
  readonly topicId?: number;
};

export type TgInboundStore = { load(): number; save(offset: number): void };

export const fileTgInboundStore = (path: string): TgInboundStore => ({
  load(): number {
    try {
      return Number(readFileSync(path, "utf8").trim()) || 0;
    } catch {
      return 0;
    }
  },
  save(offset: number): void {
    // The state dir may not exist yet on a fresh install; without this the first save
    // fails with ENOENT and the same update is re-printed every tick.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(offset));
  },
});

/**
 * Write a whole line to `fd` before returning (the fork's addition, reviews 1-2 of orientpine#350): console.log drops a
 * failed write, and writeSync may take only part of the bytes on a nonblocking fd or a full file system. No progress or
 * an error throws, so an `emit` built on it never lets the offset pass a message whose line is not out.
 */
export const writeLineSync = (
  line: string,
  fd = 1,
  write: (fd: number, buf: Uint8Array, off: number, len: number) => number = writeSync,
): number => {
  const buf = Buffer.from(line, "utf8");
  for (let off = 0; off < buf.length; ) {
    const n = write(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw new Error(`stdout took no bytes of a line (${off} of ${buf.length} written)`);
    off += n;
  }
  return buf.length;
};

type TgUser = { readonly id: number; readonly is_bot?: boolean; readonly username?: string; readonly first_name?: string };
type TgMessage = {
  readonly message_id?: number;
  readonly from?: TgUser;
  readonly chat?: { readonly id: number; readonly type?: string };
  readonly is_topic_message?: boolean;
  readonly message_thread_id?: number;
  readonly text?: string;
  readonly caption?: string;
};
type TgUpdate = { readonly update_id: number; readonly message?: TgMessage };

/**
 * The topic a message belongs to, when it is a topic message. `message_thread_id` alone
 * is not it: for a reply in a forum's General topic Telegram puts the reply root's id
 * there, not the topic id (telegram-bot-api#447), and in a private chat run with topics
 * it only marks topic messages. `is_topic_message` is the reliable signal, so General
 * (replies included) resolves to no thread — callers treat it as topic 1 — and a
 * private-chat topic message keeps its thread.
 */
const threadOf = (m: TgMessage): number | undefined => (m.is_topic_message === true ? m.message_thread_id ?? 1 : undefined);

/**
 * Poll `getUpdates` once and hand every kept message to `emit` as it is processed.
 *
 * Delivery is at-least-once: the stored offset advances past a message only after `emit`
 * returned for it (a throwing `emit` aborts the batch with the offset left before the
 * message, so the next poll returns it again — duplicates carry the same `updateId`).
 * Updates that are dropped by the gates advance the offset immediately: there is nothing
 * to deliver for them, and `getUpdates` cannot replay a message a bot has consumed.
 */
export const pollTelegramInbound = async (
  tg: Telegram,
  store: TgInboundStore,
  opts: TgInboundOptions,
  emit: (inbound: TgInbound) => void = () => {},
): Promise<TgInbound[]> => {
  const updates = await tg.call<readonly TgUpdate[]>("getUpdates", { offset: store.load(), timeout: 25, allowed_updates: ["message"] });
  const out: TgInbound[] = [];
  for (const u of updates) {
    const m = u.message;
    let keep = false;
    if (m?.from && !m.from.is_bot && m.from.id === opts.ownerId) {
      if (m.chat?.type === "private" && Number(m.chat.id) === opts.ownerId) keep = true;
      else if ((m.chat?.type === "group" || m.chat?.type === "supergroup") && opts.groupChatId !== undefined && Number(m.chat.id) === opts.groupChatId) {
        // De-conflict: in a forum group the Dori only ever listens to its own topic.
        // General counts as topic 1 — including replies there, whose reply-root id in
        // message_thread_id is not a topic id.
        const topic = threadOf(m) ?? 1;
        keep = opts.topicId === undefined || topic === opts.topicId;
      }
    }
    if (!keep) {
      store.save(u.update_id + 1);
      continue;
    }
    const source = m!.chat!.type === "private" ? "dm" : "topic";
    const thread = source === "topic" ? threadOf(m!) ?? 1 : threadOf(m!);
    const inbound: TgInbound = {
      source,
      chat: Number(m!.chat!.id),
      ...(thread === undefined ? {} : { thread }),
      updateId: u.update_id,
      from: m!.from!.id,
      ...(m!.from!.username === undefined ? {} : { username: m!.from!.username }),
      ...(m!.text === undefined && m!.caption === undefined ? {} : { text: m!.text ?? m!.caption }),
    };
    emit(inbound); // may throw: offset stays before this update, so it is polled again
    out.push(inbound);
    store.save(u.update_id + 1);
  }
  return out;
};

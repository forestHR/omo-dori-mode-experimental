import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

// The same post twice in a row is a slip, never news (owner 2026-10-20 "왜 두번씩 말해!": one reply of the lead carried two
// identical tool calls, both ran `dori send` at the same moment and the thread got the message twice). A new message with
// the same place, reply target and text as one sent in the last SEND_DEDUPE_MS is not sent again; the caller is told the
// first message's id instead. Edits are never checked, and --again sends a repeat on purpose.
// The window alone let a stale text through (https://github.com/sisyphuslabs/dori-superagent/issues/88): a call refused
// by a hook left the earlier text in a kernel variable, a later call posted that variable 7 and 15 minutes after the
// first, and the new id was read as proof the new text went out. So the last post of each place is kept too, with no
// age: a new message equal to it is never posted again either. A post prints what the service answered it holds
// (sentLine), so the report can be written from the receipt, not from what the caller meant to send.
export const SEND_DEDUPE_MS = 10 * 60_000;
// a claim without an id this old belongs to a sender that died before it finished; it is taken over
const PENDING_MS = 60_000;
const POLL_MS = 200;
const KEEP_MS = 24 * 60 * 60_000;

type Mark = { readonly at: number; readonly id?: string };
type Last = { readonly at: number; readonly key: string; readonly id: string };
// what a post returned: its id and the content the service answered it holds (undefined when the answer had none)
export type Sent = { readonly id: string; readonly content?: string };
// last: the place's last post had this content (any age); otherwise the same content went there within the window
export type SendOnceResult = { readonly id: string; readonly duplicate: false; readonly content?: string } | { readonly id: string; readonly duplicate: true; readonly ageMs: number; readonly last: boolean };
export type SendOnceOptions = { readonly again?: boolean; readonly windowMs?: number; readonly now?: () => number; readonly sleep?: (ms: number) => Promise<void> };

const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;
const ignoreMissing = (e: unknown): void => {
  if (code(e) !== "ENOENT") throw e;
};

// the place a message goes (platform, channel or thread), what it replies to, who it pings and its text
export const sendKey = (parts: readonly (string | undefined)[]): string => createHash("sha256").update(JSON.stringify(parts.map((p) => p ?? ""))).digest("hex").slice(0, 32);

const readMark = (path: string): Mark | undefined => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    ignoreMissing(e);
    return undefined;
  }
  try {
    const m = JSON.parse(raw) as Mark;
    if (typeof m.at === "number") return m;
  } catch {
    // a claim being written right now is empty for a moment: it counts as pending since the file appeared
  }
  try {
    return { at: statSync(path).mtimeMs };
  } catch (e) {
    ignoreMissing(e);
    return undefined;
  }
};

const writeMark = (path: string, mark: Mark | Last): void => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(mark));
  renameSync(tmp, path);
};

// A record per post, kept with no age (the last post must still count a week later), named so that the newest message
// of a place sorts last: Discord snowflakes, Slack ts and Telegram message ids grow with time. Which post finished
// writing first does not matter (review of #338: a thread reply posts, then waits for its status while a later send
// posts and records), and no lock is needed, since every post writes its own file; older ones are removed on read.
const LAST_PREFIX = "last-";
const lastPrefix = (place: string): string => `${LAST_PREFIX}${sendKey([place])}-`;
const order = (id: string, at: number): string => {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(id);
  // an id that is no number (test fakes only) sorts by the time it was recorded, after every numeric one
  return m ? `${(m[1] ?? "").padStart(24, "0")}.${(m[2] ?? "").padEnd(9, "0")}` : `~${String(at).padStart(16, "0")}`;
};

const readLast = (dir: string, place: string): (Last & { readonly file: string }) | undefined => {
  const prefix = lastPrefix(place);
  const files = readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith(".json")).sort();
  const newest = files.at(-1);
  if (newest === undefined) return undefined;
  for (const older of files.slice(0, -1)) {
    try {
      unlinkSync(join(dir, older));
    } catch (e) {
      ignoreMissing(e);
    }
  }
  const file = join(dir, newest);
  try {
    const l = JSON.parse(readFileSync(file, "utf8")) as Last;
    return typeof l.key === "string" && typeof l.id === "string" && typeof l.at === "number" ? { ...l, file } : undefined;
  } catch (e) {
    // written by rename, so a file is whole or absent; anything else unreadable is no record
    if (e instanceof SyntaxError) return undefined;
    ignoreMissing(e);
    return undefined;
  }
};

const writeLast = (dir: string, place: string, last: Last): void => writeMark(join(dir, `${lastPrefix(place)}${order(last.id, last.at)}.json`), last);

const prune = (dir: string, now: number): void => {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(LAST_PREFIX)) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > KEEP_MS) unlinkSync(path);
    } catch (e) {
      ignoreMissing(e);
    }
  }
};

// Sends once per key and window, and never when the place's last post has the same key. place names where the message
// goes (platform, channel or thread); key is sendKey of the place and the content. The claim is a file created with
// O_EXCL, so of two senders started together exactly one sends; the other waits for its id. A send that fails removes
// its claim and leaves the last post as it was, so a retry after a real failure still goes out.
export const sendOnce = async (dir: string, place: string, key: string, send: () => Promise<Sent>, opts: SendOnceOptions = {}): Promise<SendOnceResult> => {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const windowMs = opts.windowMs ?? SEND_DEDUPE_MS;
  mkdirSync(dir, { recursive: true });
  prune(dir, now());
  const path = join(dir, `${key}.json`);
  const posted = (sent: Sent): SendOnceResult => {
    writeMark(path, { at: now(), id: sent.id });
    writeLast(dir, place, { at: now(), key, id: sent.id });
    return { id: sent.id, duplicate: false, content: sent.content };
  };
  if (opts.again) return posted(await send());
  const last = readLast(dir, place);
  if (last?.key === key) return { id: last.id, duplicate: true, ageMs: Math.max(0, now() - last.at), last: true };
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx");
    } catch (e) {
      if (code(e) !== "EEXIST") throw e;
    }
    if (fd !== undefined) {
      try {
        writeSync(fd, JSON.stringify({ at: now() }));
      } finally {
        closeSync(fd);
      }
      let sent: Sent;
      try {
        sent = await send();
      } catch (e) {
        try {
          unlinkSync(path);
        } catch (u) {
          ignoreMissing(u);
        }
        throw e;
      }
      return posted(sent);
    }
    const mark = readMark(path);
    if (!mark) continue;
    const age = now() - mark.at;
    if (mark.id !== undefined && age < windowMs) return { id: mark.id, duplicate: true, ageMs: Math.max(0, age), last: false };
    if (mark.id !== undefined || age > PENDING_MS) {
      try {
        unlinkSync(path);
      } catch (e) {
        ignoreMissing(e);
      }
      continue;
    }
    await sleep(POLL_MS);
  }
};

// a repeat is not posted; the CLI exits SEND_DUPLICATE_EXIT so a caller cannot read it as a new post
export const SEND_DUPLICATE_EXIT = 3;
// a hook command (dori thread reply) that posted nothing because the text is already there: not a failure to retry
export const isRepeat = (r: { readonly code: number; readonly out: string }): boolean => r.code === SEND_DUPLICATE_EXIT && /^SEND_DUPLICATE /m.test(r.out);

const ago = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
};

export const duplicateLine = (place: string, r: { readonly id: string; readonly ageMs: number; readonly last: boolean }): string =>
  r.last
    ? `SEND_DUPLICATE ${place} ${r.id}: the last post in ${place} (${r.id}, ${ago(r.ageMs)} ago) has this same text; not sent again (build the text in the call that sends it; --again sends it once more)`
    : `SEND_DUPLICATE ${place} ${r.id}: the same text went to ${place} ${ago(r.ageMs)} ago as ${r.id}; not sent again (--again sends it once more)`;

// SENT <id> / POSTED <id> first, as every reader expects, then what the service answered the message holds
export const sentLine = (verb: "SENT" | "POSTED", sent: Sent): string => {
  if (sent.content === undefined) return `${verb} ${sent.id} content=not-returned`;
  const chars = [...sent.content];
  return `${verb} ${sent.id} len=${chars.length} sha=${createHash("sha256").update(sent.content).digest("hex").slice(0, 8)} first=${JSON.stringify(chars.slice(0, 40).join(""))}`;
};

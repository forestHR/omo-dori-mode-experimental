import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

// The same post twice in a row is a slip, never news (owner 2026-10-20 "왜 두번씩 말해!": one reply of the lead carried two
// identical tool calls, both ran `dori send` at the same moment and the thread got the message twice). A new message with
// the same place, reply target and text as one sent in the last SEND_DEDUPE_MS is not sent again; the caller is told the
// first message's id instead. Edits are never checked, and --again sends a repeat on purpose.
export const SEND_DEDUPE_MS = 10 * 60_000;
// a claim without an id this old belongs to a sender that died before it finished; it is taken over
const PENDING_MS = 60_000;
const POLL_MS = 200;
const KEEP_MS = 24 * 60 * 60_000;

type Mark = { readonly at: number; readonly id?: string };
export type SendOnceResult = { readonly id: string; readonly duplicate: false } | { readonly id: string; readonly duplicate: true; readonly ageMs: number };
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

const writeMark = (path: string, mark: Mark): void => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(mark));
  renameSync(tmp, path);
};

const prune = (dir: string, now: number): void => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > KEEP_MS) unlinkSync(path);
    } catch (e) {
      ignoreMissing(e);
    }
  }
};

// Sends once per key and window. The claim is a file created with O_EXCL, so of two senders started together exactly one
// sends; the other waits for its id. A send that fails removes its claim, so a retry after a real failure still goes out.
export const sendOnce = async (dir: string, key: string, send: () => Promise<string>, opts: SendOnceOptions = {}): Promise<SendOnceResult> => {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const windowMs = opts.windowMs ?? SEND_DEDUPE_MS;
  mkdirSync(dir, { recursive: true });
  prune(dir, now());
  const path = join(dir, `${key}.json`);
  if (opts.again) {
    const id = await send();
    writeMark(path, { at: now(), id });
    return { id, duplicate: false };
  }
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
      let id: string;
      try {
        id = await send();
      } catch (e) {
        try {
          unlinkSync(path);
        } catch (u) {
          ignoreMissing(u);
        }
        throw e;
      }
      writeMark(path, { at: now(), id });
      return { id, duplicate: false };
    }
    const mark = readMark(path);
    if (!mark) continue;
    const age = now() - mark.at;
    if (mark.id !== undefined && age < windowMs) return { id: mark.id, duplicate: true, ageMs: Math.max(0, age) };
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

export const duplicateLine = (r: { readonly id: string; readonly ageMs: number }): string =>
  `SEND_DUPLICATE ${r.id}: the same text went to the same place ${Math.round(r.ageMs / 1000)}s ago as ${r.id}; not sent again (--again sends it once more)`;

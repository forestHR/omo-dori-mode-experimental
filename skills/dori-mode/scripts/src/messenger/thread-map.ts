import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// directives and openedAt: a thread dori thread open opened after reading the ledger (the ids it printed, maybe none, and
// when); dori directive-audit reads a lead thread without them as opened with no directives
// standing: the thread a kind of work always lives in (dori thread set <ref> standing); closing its last lane leaves it
// open, not done, its name wears the standing mark (📌) through every status event, and it ends with
// dori thread set <ref> unstanding or a forced done mark (which drops the entry)
export type ThreadEntry = { readonly session: string | null; readonly title: string; readonly directives?: readonly string[]; readonly openedAt?: string; readonly standing?: boolean };
export type ThreadMap = Record<string, ThreadEntry>;

export const threads = (dir: string): ThreadMap => {
  const file = join(dir, "threads.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
};

const save = (dir: string, all: ThreadMap): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "threads.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 1), { mode: 0o600 });
  renameSync(tmp, file);
};

export const mapThread = (dir: string, id: string, session: string | null, title?: string, opened?: { readonly directives: readonly string[]; readonly openedAt: string }): void => {
  const all = threads(dir);
  all[id] = { ...all[id], session, title: title ?? all[id]?.title ?? "", ...opened };
  save(dir, all);
};

export const standThread = (dir: string, id: string): void => {
  const all = threads(dir);
  all[id] = { session: null, title: "", ...all[id], standing: true };
  save(dir, all);
};

// Resolves whether the thread was standing; the rest of its entry stays.
export const unstandThread = (dir: string, id: string): boolean => {
  const all = threads(dir);
  const entry = all[id];
  if (!entry?.standing) return false;
  const { standing: _, ...rest } = entry;
  all[id] = rest;
  save(dir, all);
  return true;
};

export const dropThread = (dir: string, id: string): void => {
  const all = threads(dir);
  if (!all[id]) return;
  delete all[id];
  save(dir, all);
};

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { DiscordWords } from "../config.ts";
import type { Discord } from "./discord.ts";
import { desiredStatus, setThreadStatus, type ThreadMark, type ThreadStatus } from "./discord-thread.ts";
import { MessengerError } from "./http.ts";
import { dropThread, threads } from "./thread-map.ts";

// One entry per thread: the status the latest event asked for, the earliest time the rename may run, and how many
// rate-limited tries it took so far. `rev` grows with every request, so a rename that finishes after a newer request
// arrived leaves the newer one in place.
export type PendingStatus = { readonly status: ThreadStatus; readonly due: number; readonly tries: number; readonly rev: number };
type Pending = Record<string, PendingStatus>;

export type FlushResult = "applied" | "unchanged" | "pending" | "dropped" | "none";

export type QueueTimers = { readonly setTimeout: (cb: () => void, ms: number) => unknown; readonly setInterval: (cb: () => void, ms: number) => unknown };

export type QueueDeps = {
  readonly dc: Discord;
  readonly words: DiscordWords;
  // shared by every process that renames threads (the listener and one-shot commands), next to questions.json
  readonly file: string;
  // ids of the question cards still open in a thread: any of them keeps the thread waiting
  readonly openCards: (thread: string) => readonly string[];
  // keys of the open lanes working in a thread: any of them keeps it working, past an open card or a wait (none: the cards
  // and the event decide)
  readonly workingLanes?: (thread: string) => Promise<readonly string[]>;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly jitterMs?: () => number;
};

export const DEBOUNCE_MS = 1_500;
const RESCAN_MS = 30_000;
const MAX_TRIES = 8;
// a 5xx carries no retry_after
const SERVER_ERROR_WAIT_S = 30;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

// Thread status renames, coalesced per thread and safe against Discord's rename limit (about two per ten minutes
// per thread). Each event records the status it wants; the rename that runs uses the latest one, decided against the
// open question cards at that moment. A 429 keeps the entry on disk with the time Discord gave, so the long-running
// listener applies it later, also after a restart.
export class ThreadStatusQueue {
  private timers: QueueTimers | undefined;
  private readonly scheduled = new Map<string, number>();
  private readonly running = new Map<string, Promise<FlushResult>>();

  constructor(private readonly d: QueueDeps) {}

  private load(): Pending {
    return existsSync(this.d.file) ? (JSON.parse(readFileSync(this.d.file, "utf8")) as Pending) : {};
  }

  // temp file + rename, so another process never reads a half-written file
  private edit(thread: string, change: (e: PendingStatus | undefined) => PendingStatus | undefined): PendingStatus | undefined {
    const all = this.load();
    const next = change(all[thread]);
    if (next) all[thread] = next;
    else delete all[thread];
    mkdirSync(dirname(this.d.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.d.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 1), { mode: 0o600 });
    renameSync(tmp, this.d.file);
    return next;
  }

  // Records the status an event asks for. With timers (the listener) the rename runs a moment later, so a burst of
  // events makes one rename; without (a one-shot command) it runs now and resolves with the outcome. A rename still
  // waiting out a 429 is never tried early: the newer status just replaces the one it will apply.
  async request(thread: string, hint: ThreadStatus): Promise<FlushResult | "scheduled"> {
    const now = this.d.now();
    const e = this.edit(thread, (old) => ({ status: hint, due: Math.max(old?.due ?? 0, this.timers ? now + DEBOUNCE_MS : now), tries: old?.tries ?? 0, rev: (old?.rev ?? 0) + 1 })) as PendingStatus;
    if (!this.timers) return this.flush(thread);
    this.schedule(thread, e.due);
    return "scheduled";
  }

  // The status still waiting to be applied for a thread (a rename held back by a 429, or inside its short wait).
  pending(thread: string): ThreadStatus | undefined {
    return this.load()[thread]?.status;
  }

  flush(thread: string): Promise<FlushResult> {
    const next = (this.running.get(thread) ?? Promise.resolve<FlushResult>("none")).then(() => this.apply(thread));
    this.running.set(thread, next);
    void next.finally(() => this.running.get(thread) === next && this.running.delete(thread));
    return next;
  }

  async settled(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()]);
  }

  // Puts every stored rename on a timer: at start, so one that was waiting out a 429 before a restart still runs, and
  // then every 30 s, to pick up what a one-shot command left behind.
  watch(timers: QueueTimers, everyMs = RESCAN_MS): void {
    this.timers = timers;
    this.resume();
    timers.setInterval(() => this.resume(), everyMs);
  }

  private resume(): void {
    for (const [thread, e] of Object.entries(this.load())) this.schedule(thread, e.due);
  }

  private schedule(thread: string, due: number): void {
    if (!this.timers) return;
    const at = this.scheduled.get(thread);
    if (at !== undefined && at <= due) return;
    this.scheduled.set(thread, due);
    this.timers.setTimeout(() => {
      if (this.scheduled.get(thread) === due) this.scheduled.delete(thread);
      void this.flush(thread);
    }, Math.max(0, due - this.d.now()));
  }

  private forget(thread: string, rev: number): void {
    this.edit(thread, (cur) => (cur && cur.rev === rev ? undefined : cur));
  }

  private async apply(thread: string): Promise<FlushResult> {
    const e = this.load()[thread];
    if (!e) return "none";
    const now = this.d.now();
    if (e.due > now) {
      // still inside a burst's short wait is not worth a line; waiting out a 429 is
      if (e.tries > 0) this.d.log(`THREAD_STATUS_PENDING ${thread} ${e.status} retry_in=${Math.ceil((e.due - now) / 1000)}s`);
      this.schedule(thread, e.due);
      return "pending";
    }
    const cards = this.d.openCards(thread);
    const lanes = e.status === "done" ? [] : ((await this.d.workingLanes?.(thread)) ?? []);
    const asked = desiredStatus(e.status, cards, lanes);
    // a standing thread keeps its mark through every event, a released one (false) loses its 📌 at every rename; read
    // here, so a one-shot command's change counts and a failed rename leaves it for the next
    const standing = threads(dirname(this.d.file))[thread]?.standing;
    const status: ThreadMark = standing === true ? "standing" : asked;
    // what decided it, when not the event: the open cards, the lanes that kept it working past them
    const why = asked !== e.status || (cards.length && lanes.length) ? [cards.length ? ` open=${cards.join(",")}` : "", lanes.length ? ` working=${lanes.join(",")}` : ""].join("") : "";
    try {
      const changed = await setThreadStatus(this.d.dc.once(), thread, status, this.d.words, undefined, standing === false);
      if (status === "done") dropThread(dirname(this.d.file), thread);
      this.forget(thread, e.rev);
      this.d.log(`THREAD_STATUS_APPLIED ${thread} ${status}${changed ? "" : " unchanged"}${why}`);
      return changed ? "applied" : "unchanged";
    } catch (err) {
      const status429 = err instanceof MessengerError && err.status === 429;
      const waitS = status429 ? (err.retryAfterS ?? SERVER_ERROR_WAIT_S) : err instanceof MessengerError && err.status >= 500 ? SERVER_ERROR_WAIT_S : undefined;
      if (waitS !== undefined && e.tries + 1 < MAX_TRIES) {
        const due = this.d.now() + Math.ceil(waitS * 1000) + (this.d.jitterMs?.() ?? Math.floor(Math.random() * 2_000));
        const kept = this.edit(thread, (cur) => cur && { ...cur, due: Math.max(cur.due, due), tries: cur.tries + 1 });
        this.d.log(`THREAD_STATUS_PENDING ${thread} ${status} retry_in=${Math.ceil(((kept?.due ?? due) - this.d.now()) / 1000)}s try=${e.tries + 1} ${errText(err)}`);
        if (kept) this.schedule(thread, kept.due);
        return "pending";
      }
      this.forget(thread, e.rev);
      this.d.log(`THREAD_STATUS_DROPPED ${thread} ${status} ${errText(err)}`);
      return "dropped";
    }
  }
}

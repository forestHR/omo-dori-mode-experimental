// The backlog (dori backlog): work the owner or the lead put on a list by hand, started as lanes (bl-<id>) by the dori-lanes
// freshness loop as soon as there is room: by priority, within backlog.maxLanes backlog lanes of this Dori,
// backlog.maxStarts starts a pass, backlog.hostMaxLanes backlog lanes of every Dori on the host, a free model account and a
// host that is not busy. An item that needs the owner's word first (--ask) is never started before that word is in (dori
// backlog decide): the pass puts one row in the lead's inbox and the lead asks with a card. backlog.everyMin is the sweep.
// The idea is dori-superagent's hourly loop (#23, https://github.com/sisyphuslabs/dori-superagent/pull/23, MIT), rewritten
// here for aoe and dori launch: no GitHub issue import (owner 2026-11-02 23:14 KST "github 이슈는 필요없고"), the start goes
// through the same launch as the lead's (directives, eight steps, work thread), and it never merges, pushes or closes.
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import type { BacklogSettings } from "./config.ts";
import { doneSyntaxErrors } from "./done-signals.ts";
import { LANE_KEY, type Lane, NO_THREAD, statusOf, threadRefProblem } from "./registry.ts";

export type ItemStatus = "open" | "running" | "done" | "dropped";
export type ItemLog = { readonly at: string; readonly what: string };
export type BacklogItem = {
  readonly id: string;
  readonly title: string;
  // the stored copy of the brief (the file given to add is not read again)
  readonly brief: string;
  readonly done: string;
  // 1 first .. 9 last
  readonly priority: number;
  readonly cwd?: string;
  // a work thread ref, "new" (opened in this Dori's channel at start), or none with noThread's reason
  readonly thread?: string;
  readonly noThread?: string;
  readonly whyNew?: string;
  readonly goal?: string;
  readonly tags?: readonly string[];
  // who put it on the list (owner or lead), for the list
  readonly by: string;
  // the lead says the work only reads; the owner's message link the work rests on (checked when it was added)
  readonly readOnly?: boolean;
  readonly ownerLink?: string;
  // the lane key of its last start (bl-<id>)
  readonly lane?: string;
  // what to ask the owner before it may start; cleared by decide
  readonly ask?: string;
  readonly askedAt?: string;
  // why a pass stopped trying to start it (a refused launch, two failed starts), for the lead; cleared by add again
  readonly held?: string;
  readonly startFailures?: number;
  readonly status: ItemStatus;
  readonly pane?: string;
  readonly addedAt: string;
  readonly log: readonly ItemLog[];
};

export class BacklogError extends Error {}
// A launch the item itself makes impossible (a refused key, thread or directive): held at once, not tried again.
export class StartRefused extends Error {}

export const MAX_FAILED_STARTS = 2;

const dir = (stateDir: string): string => join(stateDir, "backlog");
const itemFile = (stateDir: string, id: string): string => join(dir(stateDir), "items", `${id}.json`);
const briefFile = (stateDir: string, id: string): string => join(dir(stateDir), "items", `${id}.md`);
const runFile = (stateDir: string): string => join(dir(stateDir), "last-run.json");

// a fresh temp file (unguessable name, created exclusively: never through a link someone planted) renamed into place
const writeAtomic = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text, { flag: "wx", mode: 0o644 });
  renameSync(tmp, file);
};

const save = (stateDir: string, item: BacklogItem): void => writeAtomic(itemFile(stateDir, item.id), JSON.stringify(item, null, 1));

const logged = (item: BacklogItem, at: string, what: string, patch: Partial<BacklogItem> = {}): BacklogItem => ({ ...item, ...patch, log: [...item.log, { at, what }] });

export const readItem = (stateDir: string, id: string): BacklogItem | undefined => {
  const file = itemFile(stateDir, id);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as BacklogItem) : undefined;
};

export const listItems = (stateDir: string): BacklogItem[] => {
  const d = join(dir(stateDir), "items");
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(d, f), "utf8")) as BacklogItem);
};

// first by priority, then the older item, then the id: the order a pass starts them in
export const byTurn = (a: BacklogItem, b: BacklogItem): number => a.priority - b.priority || a.addedAt.localeCompare(b.addedAt) || a.id.localeCompare(b.id);

export type AddInput = {
  readonly id: string;
  readonly title: string;
  readonly brief: string;
  readonly done: string;
  readonly priority?: string;
  readonly cwd?: string;
  readonly thread?: string;
  readonly noThread?: string;
  readonly whyNew?: string;
  readonly goal?: string;
  readonly tags?: readonly string[];
  readonly ask?: string;
  readonly by?: string;
  readonly readOnly?: boolean;
  readonly ownerLink?: string;
};

// backlog.writeNeedsOwnerLink: work that may write starts on its own only with the owner's message behind it
export const OWNER_LINK_ASK = "형 원문 링크가 확인되지 않은 쓰기 일이야({why}). 시작해도 될까?";

/**
 * Puts an item on the list, or replaces one that is not running (a held item's fix). Its brief is copied now.
 * ownerProblem: why the owner link does not hold (undefined when it was checked and holds, or no check is needed).
 */
export const addItem = (stateDir: string, input: AddInput, ctx: { readonly registered: boolean; readonly at: string; readonly needOwnerLink?: boolean; readonly ownerProblem?: string }): { readonly item: BacklogItem; readonly replaced: boolean } => {
  if (!LANE_KEY.test(input.id)) throw new BacklogError(`item id must match ${LANE_KEY} (it becomes the lane key)`);
  const priority = input.priority === undefined ? 5 : Number(input.priority);
  if (!Number.isInteger(priority) || priority < 1 || priority > 9) throw new BacklogError(`--priority must be 1 (first) to 9 (last), not ${input.priority}`);
  if (!existsSync(input.brief)) throw new BacklogError(`no brief file ${input.brief}`);
  const doneErrors = doneSyntaxErrors(input.done);
  if (doneErrors.length) throw new BacklogError(`Done line is not checkable: ${doneErrors.join("; ")}`);
  if (input.noThread !== undefined && !input.noThread.trim()) throw new BacklogError(`--no-thread needs the reason the lane has no work thread`);
  if (input.noThread !== undefined && input.thread !== undefined) throw new BacklogError(`give --thread or --no-thread, not both`);
  const thread = input.noThread !== undefined ? undefined : (input.thread ?? "new");
  if (thread !== undefined && thread !== "new") {
    const problem = thread === NO_THREAD ? `--thread ${NO_THREAD} is not a thread; give --no-thread "<reason>"` : threadRefProblem(thread);
    if (problem) throw new BacklogError(problem);
  }
  if (input.ask !== undefined && !input.ask.trim()) throw new BacklogError(`--ask needs the question for the owner`);
  // dori launch refuses a key the registry has, closed lanes too: say it now, not at the first pass
  if (ctx.registered) throw new BacklogError(`lane ${laneKeyOf(input.id)} is already registered; pick another id`);
  const old = readItem(stateDir, input.id);
  if (old?.status === "running") throw new BacklogError(`item ${input.id} is running as a lane (${old.pane ?? "?"}); close the lane first`);
  const replaced = old?.status === "open";
  const linkAsk = ctx.needOwnerLink && !input.readOnly && (!input.ownerLink || ctx.ownerProblem) ? OWNER_LINK_ASK.replace("{why}", input.ownerLink ? (ctx.ownerProblem ?? "") : "링크 없음") : undefined;
  const ask = [input.ask?.trim(), linkAsk].filter(Boolean).join(" / ");
  mkdirSync(join(dir(stateDir), "items"), { recursive: true });
  copyFileSync(input.brief, briefFile(stateDir, input.id));
  const by = input.by?.trim() || "lead";
  const item: BacklogItem = {
    id: input.id,
    title: input.title,
    brief: briefFile(stateDir, input.id),
    done: input.done,
    priority,
    ...(input.cwd ? { cwd: resolve(input.cwd) } : {}),
    ...(thread !== undefined ? { thread } : { noThread: input.noThread?.trim() }),
    ...(input.whyNew?.trim() ? { whyNew: input.whyNew.trim() } : {}),
    ...(input.goal?.trim() ? { goal: input.goal.trim() } : {}),
    ...(input.tags?.length ? { tags: input.tags } : {}),
    ...(input.readOnly ? { readOnly: true } : {}),
    ...(input.ownerLink ? { ownerLink: input.ownerLink } : {}),

    ...(ask ? { ask } : {}),
    by,
    status: "open",
    addedAt: replaced && old ? old.addedAt : ctx.at,
    log: [...(replaced && old ? old.log : []), { at: ctx.at, what: `${replaced ? "replaced" : "added"} by ${by} from ${resolve(input.brief)}` }],
  };
  save(stateDir, item);
  return { item, replaced };
};

const knownItem = (stateDir: string, id: string): BacklogItem => {
  const item = readItem(stateDir, id);
  if (!item) throw new BacklogError(`no backlog item ${id}`);
  return item;
};

export const dropItem = (stateDir: string, id: string, why: string, at: string): BacklogItem => {
  const item = knownItem(stateDir, id);
  if (item.status === "running") throw new BacklogError(`item ${id} is running as a lane (${item.pane ?? "?"}); close the lane first (dori close ${item.lane ?? laneKeyOf(id)})`);
  const dropped = logged(item, at, `dropped: ${why}`, { status: "dropped" });
  save(stateDir, dropped);
  return dropped;
};

/** The owner's answer to the item's question: added to its brief, the question cleared, so the next pass may start it. */
/** The owner's answer to the item's question: added to its brief, the question cleared, so the next pass may start it. */
export const decideItem = (stateDir: string, id: string, answer: string, at: string, kst: string): BacklogItem => {
  if (!answer.trim()) throw new BacklogError("decide needs --text with the owner's answer");
  const item = knownItem(stateDir, id);
  if (item.status !== "open") throw new BacklogError(`item ${id} is ${item.status}, not open`);
  if (!item.ask) throw new BacklogError(`item ${id} has no open question; change it with dori backlog add ${id} ...`);
  appendFileSync(item.brief, `\n\n## 형 결정 (${kst})\n질문: ${item.ask}\n형 답: ${answer.trim()}\n`);
  const { ask: _ask, askedAt: _asked, ...rest } = item;
  const decided = logged(rest, at, `decided: ${answer.trim()}`);
  save(stateDir, decided);
  return decided;
};

export const itemLine = (item: BacklogItem): string => {
  const state = item.status === "running" ? `lane ${item.pane ?? "?"}`
    : item.status !== "open" ? (item.log.at(-1)?.what ?? "")
    : item.ask ? `asks the owner${item.askedAt ? " (lead told)" : ""}: ${item.ask}`
    : item.held ? `held: ${item.held}`
    : "waits for the next pass";
  return [item.id, item.status, `p${item.priority}`, item.by, item.title, state].join(" | ");
};

// One file per backlog lane a Dori started, in a directory every account can write (mode 1777, sticky: only the owner
// removes its file). A file whose mtime is older than this belongs to a Dori whose loop stopped touching it.
export const HOST_STALE_MS = 6 * 3_600_000;
// instance: this Dori among those of one account (a hash of its state directory), so two Doris of one user keep apart
export type HostSlots = { readonly dir: string; readonly user: string; readonly instance: string; readonly max: number };
export const instanceOf = (stateDir: string): string => createHash("sha256").update(resolve(stateDir)).digest("hex").slice(0, 8);

const mine = (h: HostSlots): string => `${h.user}.${h.instance}.`;
const slotFile = (h: HostSlots, key: string): string => join(h.dir, `${mine(h)}${key}.json`);

// why the shared directory is unsafe to write in (a link, not a directory, no sticky bit), or undefined; made when missing
const hostDirProblem = (h: HostSlots): string | undefined => {
  if (!existsSync(h.dir)) {
    mkdirSync(h.dir, { recursive: true });
    chmodSync(h.dir, 0o1777);
  }
  const st = lstatSync(h.dir);
  if (st.isSymbolicLink() || !st.isDirectory()) return "is not a plain directory";
  if (!(st.mode & 0o1000)) return "has no sticky bit (another account could remove or replace this Dori's files)";
  return undefined;
};

const regularFile = (file: string): boolean => {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
};

/** The host's live backlog lanes, oldest start first: [file name, start time]. */
export const hostLanes = (h: HostSlots, now: number): { readonly name: string; readonly at: string }[] => {
  if (!existsSync(h.dir)) return [];
  return readdirSync(h.dir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((name) => {
      const file = join(h.dir, name);
      let mtime: number;
      try {
        if (!regularFile(file)) return [];
        mtime = lstatSync(file).mtimeMs;
      } catch {
        return [];
      }
      if (now - mtime >= HOST_STALE_MS) return [];
      // a fresh slot counts even when it cannot be read (another account's file under a strict umask): its time then orders it
      try {
        return [{ name, at: String((JSON.parse(readFileSync(file, "utf8")) as { at?: string }).at ?? new Date(mtime).toISOString()) }];
      } catch {
        return [{ name, at: new Date(mtime).toISOString() }];
      }
    })
    .sort((a, b) => a.at.localeCompare(b.at) || a.name.localeCompare(b.name));
};

// this Dori's files follow its running items: touched while running, removed once not
const hostRefresh = (h: HostSlots, running: ReadonlySet<string>, now: number): void => {
  if (!existsSync(h.dir)) return;
  for (const name of readdirSync(h.dir).filter((f) => f.startsWith(mine(h)) && f.endsWith(".json"))) {
    const key = name.slice(mine(h).length, -".json".length);
    const file = join(h.dir, name);
    if (running.has(key) && regularFile(file)) utimesSync(file, now / 1000, now / 1000);
    else rmSync(file, { force: true });
  }
};

/** Takes a host slot for a start: counted and written under the host directory's lock, so the cap holds across Doris. */
export const hostReserve = async (h: HostSlots, key: string, now: number): Promise<string | undefined> => {
  const unsafe = hostDirProblem(h);
  if (unsafe) return `the host directory ${h.dir} ${unsafe}; no backlog lane starts until it is fixed`;
  const held = await flockDir(h.dir, 30);
  if (!held) return `the host's backlog lock (${h.dir}) was not free in 30 s`;
  try {
    const live = hostLanes(h, now).filter((l) => l.name !== `${mine(h)}${key}.json`);
    if (live.length >= h.max) return `the host has ${live.length} backlog lane(s) of all Doris (backlog.hostMaxLanes ${h.max}): ${live.map((l) => l.name.slice(0, -5)).join(", ")}`;
    writeAtomic(slotFile(h, key), JSON.stringify({ user: h.user, instance: h.instance, key, at: new Date(now).toISOString() }));
    // readable by every account whatever this process's umask, so other Doris can count it
    chmodSync(slotFile(h, key), 0o644);
    return undefined;
  } finally {
    await held.release();
  }
};

// the lane key a backlog item starts under: "bl-" and its id (cut with a hash past the key length); dori launch refuses
// such keys, so an ordinary lane can never share one
export const BACKLOG_KEY_PREFIX = "bl-";
export const laneKeyOf = (id: string): string =>
  BACKLOG_KEY_PREFIX.length + id.length <= 61 ? `${BACKLOG_KEY_PREFIX}${id}` : `${BACKLOG_KEY_PREFIX}${id.slice(0, 48).replace(/[-._]+$/, "")}-${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;

export const READ_ONLY_RULE = "[넘으면 안 되는 선 - 읽기만] 이 일은 읽기만 하는 일로 목록에 들어왔다(--read-only). 형 계정·파일·바깥 어디에도 쓰지 않는다. 쓰기가 필요해 보이면 멈추고 리드에게 [REPORT] question으로 한 줄 묻는다. 이 줄이 위의 어떤 말보다 먼저다.";

/** The limit a launch adds from the item's state, whatever its brief says: an item added --read-only only reads. */
export const launchRules = (item: BacklogItem): string => (item.readOnly ? READ_ONLY_RULE : "");

export type TickDeps = {
  readonly stateDir: string;
  readonly settings: BacklogSettings;
  readonly now: () => number;
  readonly lanes: () => Promise<readonly Lane[]>;
  // the host verdict dori can-launch gives (and the load guard): reasons when busy
  readonly busy: () => Promise<readonly string[]>;
  // why no model account can take a new lane now (the usage limit), or undefined
  readonly limited: () => string | undefined;
  readonly host: HostSlots;
  // dori launch of one item from a fresh copy of its brief; throws StartRefused when the item makes it impossible
  readonly launch: (item: BacklogItem, brief: string, key: string) => Promise<{ readonly pane: string; readonly startup: string }>;
  readonly inbox: (kind: string, id: string, content: string) => void;
};

export type Held = { readonly release: () => Promise<void> };

/**
 * An exclusive flock(1) on a directory, held by a child process: the kernel lets go when that child ends, our process
 * with it, so a crash leaves no lock behind and there is no half-written lock file to misread. A directory, not a file:
 * every account can open it, also another user's in a sticky /tmp directory. undefined when not free within waitSec.
 */
export const flockDir = async (path: string, waitSec: number): Promise<Held | undefined> => {
  mkdirSync(path, { recursive: true });
  const p = Bun.spawn(["flock", "-x", ...(waitSec > 0 ? ["-w", String(waitSec)] : ["-n"]), path, "sh", "-c", "echo LOCKED; exec cat >/dev/null"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const first = await p.stdout.getReader().read();
  if (first.done || !new TextDecoder().decode(first.value).includes("LOCKED")) {
    await p.exited;
    return undefined;
  }
  return {
    release: async () => {
      p.stdin.end();
      await p.exited;
    },
  };
};

/** add, drop and decide run under the pass's lock, so a pass never starts what was just dropped or given a question. */
export const withBacklogLock = async <T>(stateDir: string, waitSec: number, fn: () => T): Promise<T> => {
  const held = await flockDir(dir(stateDir), waitSec);
  if (!held) throw new BacklogError(`a backlog pass held ${dir(stateDir)} for more than ${waitSec} s; try again`);
  try {
    return fn();
  } finally {
    await held.release();
  }
};

const isOpenLane = (l: Lane): boolean => statusOf(l) !== "closed";

export const lastRun = (stateDir: string): { readonly at: string; readonly lines: readonly string[]; readonly quiet?: readonly string[] } | undefined => {
  const file = runFile(stateDir);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { at: string; lines: string[]; quiet?: string[] }) : undefined;
};

/**
 * One pass, run on every freshness tick: running items follow their lanes (closed -> done), questions go to the lead once, and the next open items start at once by priority while the limits allow.
 * What happened is always said; why nothing starts (HOLD, WAIT, IDLE) only when it changed or at the sweep every
 * backlog.everyMin minutes, so the log does not repeat it each tick.
 */
export const backlogTick = async (d: TickDeps, opts: { readonly force?: boolean } = {}): Promise<string[]> => {
  const held = await flockDir(dir(d.stateDir), 0);
  if (!held) return opts.force ? [`BACKLOG_SKIPPED another pass holds ${dir(d.stateDir)}`] : [];
  try {
    const last = lastRun(d.stateDir);
    const at = new Date(d.now()).toISOString();
    const sweep = Boolean(opts.force) || !last || d.now() - Date.parse(last.at) >= d.settings.everyMin * 60_000;
    const lines: string[] = [];
    const quiet: string[] = [];
    const lanes = await d.lanes();
    const laneOf = (id: string): Lane | undefined => lanes.find((l) => l.key === id);

    // 1. running items follow their lanes
    for (const item of listItems(d.stateDir).filter((i) => i.status === "running")) {
      const lane = laneOf(item.lane ?? laneKeyOf(item.id));
      if (lane && !isOpenLane(lane)) {
        const note = lane.history?.at(-1)?.note ?? "closed";
        save(d.stateDir, logged(item, at, `done: lane closed (${note})`, { status: "done" }));
        lines.push(`BACKLOG_DONE ${item.id}: its lane closed (${note.slice(0, 120)})`);
      } else if (!lane) {
        const why = "its lane record is gone; add it again under a new id, or drop it";
        save(d.stateDir, logged(item, at, `held: ${why}`, { status: "open", held: why }));
        d.inbox("backlog-held", `backlog-held-${item.id}-${at}`, `BACKLOG_HELD ${item.id}: ${why} (dori backlog)`);
        lines.push(`BACKLOG_HELD ${item.id}: ${why}`);
      }
    }
    const runningIds = new Set(listItems(d.stateDir).filter((i) => i.status === "running").map((i) => i.id));
    hostRefresh(d.host, runningIds, d.now());

    // 2. questions for the owner go to the lead, once per question
    for (const item of listItems(d.stateDir).filter((i) => i.status === "open" && i.ask && !i.askedAt)) {
      const content = `BACKLOG_ASK ${item.id} (${item.title}): before it starts the owner has to answer: ${item.ask} -> ask him with a card (dori ask), then dori backlog decide ${item.id} --text "<his answer>", or dori backlog drop ${item.id} if he says no`;
      d.inbox("backlog-ask", `backlog-ask-${item.id}-${at}`, content);
      save(d.stateDir, logged(item, at, "asked the lead to ask the owner", { askedAt: at }));
      lines.push(`BACKLOG_ASK ${item.id}: in the lead's inbox; not started before dori backlog decide`);
    }

    // 3. the next items start at once, by priority, within the limits
    const waiting = listItems(d.stateDir).filter((i) => i.status === "open" && !i.ask && !i.held).sort(byTurn);
    const room = Math.max(0, Math.min(d.settings.maxLanes - runningIds.size, d.settings.maxStarts));
    let tried = 0;
    for (const queued of waiting.slice(0, room)) {
      // checked again before each start: the start before it may have used the last pane, memory or account
      const hold = [...(await d.busy()), ...[d.limited()].filter((x): x is string => Boolean(x))];
      if (hold.length) {
        quiet.push(`BACKLOG_HOLD ${hold.join(" | ")}; ${waiting.length - tried} item(s) wait`);
        break;
      }
      const item = readItem(d.stateDir, queued.id);
      if (!item || item.status !== "open" || item.ask || item.held) continue;
      const full = await hostReserve(d.host, item.id, d.now());
      if (full) {
        quiet.push(`BACKLOG_HOLD ${full}; ${waiting.length - tried} item(s) wait`);
        break;
      }
      tried++;
      const copy = join(dir(d.stateDir), "launched", `${item.id}.md`);
      mkdirSync(dirname(copy), { recursive: true });
      copyFileSync(item.brief, copy);
      // the write limit, worked out now from the item's state, whatever its brief says (a lead's replacement included)
      const rules = launchRules(item);
      if (rules) appendFileSync(copy, `\n\n${rules}\n`);
      const key = laneKeyOf(item.id);
      save(d.stateDir, logged(item, at, "starting", { status: "running", pane: "starting", lane: key }));
      try {
        const r = await d.launch(item, copy, key);
        save(d.stateDir, logged(item, at, `started: ${r.startup}`, { status: "running", pane: r.pane, lane: key }));
        d.inbox("backlog-start", `backlog-start-${item.id}-${at}`, `BACKLOG_STARTED ${item.id} (${item.title}, p${item.priority}) in ${r.pane}: ${r.startup}`);
        lines.push(`BACKLOG_STARTED ${item.id} p${item.priority} ${r.pane}: ${r.startup}`);
      } catch (e) {
        const why = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300);
        // a launch that registered the lane before failing (a startup error) still runs as that lane
        // a refused launch is never a start; another failure is one only when the lane under this key was opened from this
        // attempt's own launch copy
        const lane = e instanceof StartRefused ? undefined : (await d.lanes()).find((l) => l.key === key);
        if (lane && isOpenLane(lane) && resolve(lane.brief) === resolve(copy)) {
          save(d.stateDir, logged(item, at, `started with an error: ${why}`, { status: "running", pane: lane.pane ?? "?", lane: key }));
          d.inbox("backlog-start", `backlog-start-${item.id}-${at}`, `BACKLOG_STARTED ${item.id} (${item.title}) in ${lane.pane ?? "?"} with an error: ${why}`);
          lines.push(`BACKLOG_STARTED ${item.id} p${item.priority} ${lane.pane ?? "?"} with an error: ${why}`);
          continue;
        }
        rmSync(slotFile(d.host, item.id), { force: true });
        const failures = (item.startFailures ?? 0) + 1;
        const heldWhy = e instanceof StartRefused ? `dori launch refused it: ${why}` : failures >= MAX_FAILED_STARTS ? `start failed ${failures} times, last: ${why}` : undefined;
        // a launch that opened its work thread before the session failed: the next try continues in that thread
        const opened = (e as { thread?: unknown }).thread;
        const keep = typeof opened === "string" ? { thread: opened, whyNew: undefined } : {};
        save(d.stateDir, logged(item, at, `start failed: ${why}`, { status: "open", pane: undefined, startFailures: failures, ...keep, ...(heldWhy ? { held: heldWhy } : {}) }));
        if (heldWhy) d.inbox("backlog-held", `backlog-held-${item.id}-${at}`, `BACKLOG_HELD ${item.id} (${item.title}): ${heldWhy} -> fix it with dori backlog add ${item.id} ... (replaces it), or dori backlog drop ${item.id}`);
        lines.push(heldWhy ? `BACKLOG_HELD ${item.id}: ${heldWhy}` : `BACKLOG_START_FAILED ${item.id} (${failures}/${MAX_FAILED_STARTS}): ${why}`);
      }
    }
    if (!quiet.length && waiting.length > room) quiet.push(`BACKLOG_WAIT ${waiting.length - room} item(s): ${runningIds.size} backlog lane(s) of this Dori run (backlog.maxLanes ${d.settings.maxLanes}), at most ${d.settings.maxStarts} start(s) a pass`);
    if (sweep && !lines.length && !quiet.length) quiet.push(`BACKLOG_IDLE ${waiting.length} waiting, ${runningIds.size} running`);
    const out = [...lines, ...(sweep || quiet.join("\n") !== (last?.quiet ?? []).join("\n") ? quiet : [])];
    writeAtomic(runFile(d.stateDir), JSON.stringify({ at: sweep ? at : (last?.at ?? at), lines: out.length ? out : (last?.lines ?? []), quiet }));
    return out;
  } finally {
    await held.release();
  }
};

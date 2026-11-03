import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { defaultDiscordWords } from "../src/config.ts";
import { Discord } from "../src/messenger/discord.ts";
import { type Interaction, openCardIds, QuestionCards, QuestionStore } from "../src/messenger/discord-cards.ts";
import { type DiscordMessage, DiscordListener } from "../src/messenger/discord-listener.ts";
import type { Http, HttpResponse } from "../src/messenger/http.ts";
import { DEBOUNCE_MS, ThreadStatusQueue } from "../src/messenger/thread-status-queue.ts";
import { mapThread, threads } from "../src/messenger/thread-map.ts";
import { fakeClock, withState } from "./fakes.ts";

const OWNER = "100000000000000001";
const CHANNEL = "200000000000000002";
const THREAD = "300000000000000003";
const GUILD = "400000000000000004";
const T0 = Date.parse("2026-10-11T10:12:00Z");
const WORDS = { ...defaultDiscordWords, statusStyle: "emoji" as const };

let state: ReturnType<typeof withState>;
afterEach(() => state?.done());

const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify(body) });

// One Discord work thread with a clock and timers the test moves by hand. `limited` holds the retry_after (seconds)
// the next thread PATCHes are refused with, as Discord does past about two renames per ten minutes.
const world = (name: string) => {
  state = withState();
  const w = { t: T0, name, archived: false, limited: [] as number[], patches: [] as Record<string, unknown>[], timers: [] as { at: number; cb: () => void }[], logs: [] as string[] };
  const http: Http = async (req) => {
    const path = req.url.replace("https://discord.com/api/v10", "");
    if (path === `/channels/${THREAD}` && req.method === "GET") return ok({ name: w.name, parent_id: CHANNEL, type: 11, thread_metadata: { archived: w.archived } });
    if (path === `/channels/${THREAD}` && req.method === "PATCH") {
      const wait = w.limited.shift();
      if (wait !== undefined) return { status: 429, headers: {}, body: JSON.stringify({ message: "You are being rate limited.", retry_after: wait, global: false }) };
      const body = JSON.parse(String(req.body)) as { name?: string; archived?: boolean };
      w.patches.push(body);
      if (body.name) w.name = body.name;
      if (body.archived !== undefined) w.archived = body.archived;
      return ok({});
    }
    return ok(req.method === "POST" && path.endsWith("/messages") ? { id: "900" } : {});
  };
  const dc = new Discord(http, fakeClock(0), "bot");
  const store = new QuestionStore(`${state.dir}/discord`);
  const file = `${state.dir}/discord/thread-status.json`;
  const queue = (workingLanes?: (t: string) => Promise<readonly string[]>) => new ThreadStatusQueue({ dc, words: WORDS, file, openCards: (t) => openCardIds(store, t), ...(workingLanes ? { workingLanes } : {}), now: () => w.t, log: (l) => w.logs.push(l), jitterMs: () => 500 });
  const timers = { setTimeout: (cb: () => void, ms: number) => w.timers.push({ at: w.t + ms, cb }), setInterval: () => 0 };
  // runs every timer due within `ms`, in order, letting each rename finish before the next
  const advance = async (q: ThreadStatusQueue, ms: number) => {
    const end = w.t + ms;
    for (;;) {
      const next = w.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      w.timers.splice(w.timers.indexOf(next), 1);
      w.t = Math.max(w.t, next.at);
      next.cb();
      await q.settled();
    }
    w.t = end;
  };
  const pending = () => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {});
  return { w, dc, store, queue, timers, advance, pending };
};

test("a burst of three status changes within a second makes exactly one rename, to the last status", async () => {
  const { w, queue, timers, advance } = world("🔄 fix login");
  const q = queue();
  q.watch(timers);
  await q.request(THREAD, "working");
  w.t += 400;
  await q.request(THREAD, "done");
  w.t += 500;
  await q.request(THREAD, "waiting");
  expect(w.patches).toEqual([]);
  await advance(q, DEBOUNCE_MS + 1_000);
  expect(w.patches).toEqual([{ name: "🔔 fix login" }]);
  expect(w.logs).toEqual([`THREAD_STATUS_APPLIED ${THREAD} waiting`]);
});

test("a rename refused with 429 waits out retry_after plus jitter, then one retry applies it", async () => {
  const { w, queue, timers, advance, pending } = world("🔄 fix login");
  w.limited.push(339.98);
  const q = queue();
  q.watch(timers);
  await q.request(THREAD, "waiting");
  await advance(q, DEBOUNCE_MS);
  expect(w.name).toBe("🔄 fix login");
  expect(w.logs[0]).toStartWith(`THREAD_STATUS_PENDING ${THREAD} waiting retry_in=341s try=1`);
  expect(Object.keys(pending())).toEqual([THREAD]);
  await advance(q, 339_000);
  expect(w.patches).toEqual([]);
  await advance(q, 2_000);
  expect(w.patches).toEqual([{ name: "🔔 fix login" }]);
  expect(w.logs.at(-1)).toBe(`THREAD_STATUS_APPLIED ${THREAD} waiting`);
  expect(pending()).toEqual({});
});

test("a rename left pending by a one-shot command is applied by a listener started after it, also after a restart", async () => {
  const { w, queue, timers, advance, pending } = world("🔔 fix login");
  w.limited.push(120);
  // the command (no timers) hits the limit and leaves the rename on disk instead of waiting
  expect(await queue().request(THREAD, "working")).toBe("pending");
  expect(Object.keys(pending())).toEqual([THREAD]);
  // a fresh process, as after a restart, picks it up from the file and runs it when Discord allows
  w.t += 60_000;
  const listener = queue();
  listener.watch(timers);
  await advance(listener, 30_000);
  expect(w.patches).toEqual([]);
  await advance(listener, 31_000);
  expect(w.patches).toEqual([{ name: "🔄 fix login" }]);
  expect(pending()).toEqual({});
});

test("done keeps its mapping while rate limited and drops it when the listener archives the thread", async () => {
  const { w, queue, timers, advance } = world("🔄 fix login");
  const dir = `${state.dir}/discord`;
  mapThread(dir, THREAD, "session-1", "fix login");
  w.limited.push(120);
  const result = await queue().request(THREAD, "done");
  const waiting = threads(dir);
  const listener = queue();
  listener.watch(timers);
  await advance(listener, 121_000);
  expect({ result, waiting, archived: w.archived, finished: threads(dir) }).toEqual({
    result: "pending", waiting: { [THREAD]: { session: "session-1", title: "fix login" } }, archived: true, finished: {},
  });
});

// the listener and cards as `dori inbound discord` builds them, sharing one queue
const live = (name: string, workingLanes?: (t: string) => Promise<readonly string[]>) => {
  const wd = world(name);
  const q = wd.queue(workingLanes);
  const cards = new QuestionCards(wd.dc, wd.store, { channel: CHANNEL, owner: OWNER, words: WORDS }, () => wd.w.t, q);
  const inboxFile = `${state.dir}/discord/inbox.jsonl`;
  const listener = new DiscordListener({ dc: wd.dc, cards, open: () => { throw new Error("no gateway in this test"); }, token: "BOT", guild: GUILD, channel: CHANNEL, owner: OWNER, words: WORDS, inboxFile, timers: { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0 }, now: () => wd.w.t, log: (l) => wd.w.logs.push(l), fatal: () => {} });
  const inbox = () => readFileSync(inboxFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const tap = (qid: string, option = 0): Interaction => ({ id: `i-${qid}`, token: "tok", type: 3, channel_id: THREAD, member: { user: { id: OWNER } }, data: { custom_id: `q:${qid}:${option}` } });
  const say = (id: string, content: string): DiscordMessage => ({ id, channel_id: THREAD, guild_id: GUILD, content, timestamp: "2026-10-11T10:12:00Z", author: { id: OWNER } });
  return { ...wd, q, cards, listener, inbox, tap, say };
};

test("the owner replying in text while a card is open keeps the thread 🔔 and tells the lead the card is still open", async () => {
  const { w, cards, listener, inbox, say } = live("🔄 fix login");
  await cards.ask("Ship to prod?", ["Yes", "No"], { thread: THREAD });
  expect(w.name).toBe("🔔 fix login");
  const renames = w.patches.length;
  await listener.onMessage(say("1001", "yes, ship it"));
  expect(w.name).toBe("🔔 fix login");
  expect(w.patches.length).toBe(renames);
  expect(inbox()[0]).toMatchObject({ id: "1001", scope: "thread", open_cards: ["Q1"], note: 'card Q1 still open, owner replied in text: resolve it with dori resolve Q1 --answer "<the answer, short>" so the card folds' });
  expect(w.logs).toContain(`CARD_STILL_OPEN Q1 thread=${THREAD} card Q1 still open, owner replied in text: resolve it with dori resolve Q1 --answer "<the answer, short>" so the card folds`);
  expect(cards.store.get("Q1")?.status).toBe("open");
});

test("three cards answered out of step stay 🔔 until the last open one is resolved, which gives 🔄", async () => {
  const { w, cards, listener, tap, say } = live("🔄 fix login");
  for (const text of ["Q70?", "Q71?", "Q72?"]) await cards.ask(text, ["Yes", "No"], { thread: THREAD });
  expect(w.name).toBe("🔔 fix login");
  await listener.onInteraction(tap("Q1"));
  expect(w.name).toBe("🔔 fix login");
  await listener.onInteraction(tap("Q2"));
  expect(w.name).toBe("🔔 fix login");
  await listener.onMessage(say("1002", "the third one: no"));
  expect(w.name).toBe("🔔 fix login");
  expect(await cards.resolve("Q3")).toBe("folded");
  expect(w.name).toBe("🔄 fix login");
});

test("a lane still working in the thread keeps it 🔄 past an open card and a wait; 🔔 only once no lane works there (feature-verify 2026-10-12, follow-up a)", async () => {
  const working = new Set(["lane-a"]);
  const { w, q, cards, listener, say } = live("🔄 fix login", async () => [...working]);
  await cards.ask("Ship to prod?", ["Yes", "No"], { thread: THREAD });
  // waiting means nothing is left on our side: the card does not show it while lane-a works (challenge, gpt-6-astra and grok-4.7)
  expect(w.name).toBe("🔄 fix login");
  expect(w.patches).toEqual([]);
  await q.request(THREAD, "waiting");
  expect(w.name).toBe("🔄 fix login");
  expect(w.logs).toContain(`THREAD_STATUS_APPLIED ${THREAD} working unchanged open=Q1 working=lane-a`);
  // no lane works there any more: the open card makes it waiting
  working.clear();
  await listener.onMessage(say("1003", "still thinking"));
  expect(w.name).toBe("🔔 fix login");
});

// 2026-10-16: a card asked with --thread pointing at the owner's text channel renamed the channel "🔔-zzangdori" and its
// answer queued "🔄". A status mark goes only on a thread (Discord types 10-12); the channel keeps its name, a real thread
// in the same run still gets its mark.
test("a status for a text channel never renames it; a thread next to it still gets its mark", async () => {
  state = withState();
  const chans: Record<string, { name: string; type: number }> = { [CHANNEL]: { name: "zzangdori", type: 0 }, [THREAD]: { name: "🔄 fix login", type: 11 } };
  const patched: string[] = [];
  const http: Http = async (req) => {
    const id = /\/channels\/(\d+)$/.exec(req.url)?.[1];
    if (id && chans[id] && req.method === "GET") return ok({ ...chans[id], thread_metadata: { archived: false } });
    if (id && chans[id] && req.method === "PATCH") {
      patched.push(id);
      const body = JSON.parse(String(req.body)) as { name?: string };
      if (body.name) chans[id].name = body.name;
      return ok({});
    }
    return ok(req.method === "POST" && req.url.endsWith("/messages") ? { id: "900" } : {});
  };
  const dc = new Discord(http, fakeClock(0), "bot");
  const store = new QuestionStore(`${state.dir}/discord`);
  const logs: string[] = [];
  const q = new ThreadStatusQueue({ dc, words: WORDS, file: `${state.dir}/discord/thread-status.json`, openCards: (t) => openCardIds(store, t), now: () => T0, log: (l) => logs.push(l) });
  const cards = new QuestionCards(dc, store, { channel: CHANNEL, owner: OWNER, words: WORDS }, () => T0, q);
  await cards.ask("Which way?", ["A", "B"], { thread: CHANNEL });
  expect(await cards.resolve("Q1")).toBe("folded");
  for (const s of ["waiting", "working", "done"] as const) expect(await q.request(CHANNEL, s)).toBe("dropped");
  expect(chans[CHANNEL]?.name).toBe("zzangdori");
  expect(logs.filter((l) => l.startsWith(`THREAD_STATUS_DROPPED ${CHANNEL}`)).length).toBe(5);
  expect(logs[0]).toContain("is not a thread (type 0); its name is left alone");
  expect(await q.request(THREAD, "waiting")).toBe("applied");
  expect(chans[THREAD]?.name).toBe("🔔 fix login");
  expect(patched).toEqual([THREAD]);
});

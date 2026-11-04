import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { defaultDiscordWords } from "../src/config.ts";
import { Discord } from "../src/messenger/discord.ts";
import { type Interaction, QuestionCards, QuestionError, QuestionStore } from "../src/messenger/discord-cards.ts";
import { setThreadStatus, progressText, threadHook, ThreadRefError } from "../src/messenger/discord-thread.ts";
import { type Http, type HttpRequest, type HttpResponse, UnsafeMessageError } from "../src/messenger/http.ts";
import { fakeClock, withState } from "./fakes.ts";

const OWNER = "100000000000000001";
const CHANNEL = "200000000000000002";

const fakeDiscord = (route: (req: HttpRequest) => unknown = () => ({})) => {
  const seen: HttpRequest[] = [];
  const http: Http = async (req): Promise<HttpResponse> => {
    seen.push(req);
    const body = req.url.includes("/interactions/") ? "" : JSON.stringify(route(req));
    return { status: body ? 200 : 204, headers: {}, body };
  };
  const calls = () => seen.map((r) => `${r.method} ${r.url.replace("https://discord.com/api/v10", "")}`);
  const json = (n: number) => JSON.parse(String(seen[n]?.body));
  return { dc: new Discord(http, fakeClock(0), "bot"), seen, calls, json };
};

let state: ReturnType<typeof withState>;
afterEach(() => state?.done());

const setup = (route?: (req: HttpRequest) => unknown) => {
  state = withState();
  const f = fakeDiscord(route ?? ((req) => (req.method === "POST" && req.url.endsWith("/messages") ? { id: "900" } : req.method === "GET" ? { type: 11 } : {})));
  const store = new QuestionStore(`${state.dir}/discord`);
  const cards = new QuestionCards(f.dc, store, { channel: CHANNEL, owner: OWNER, words: defaultDiscordWords }, () => Date.parse("2026-01-02T03:04:00Z"));
  return { ...f, store, cards };
};

const tap = (customId: string, user = OWNER): Interaction => ({ id: "i1", token: "tok", type: 3, channel_id: CHANNEL, member: { user: { id: user } }, data: { custom_id: customId } });

type Button = { style: number; label: string; custom_id: string };
type Part = { type: number; content?: string; components?: (Button & { type: number; content?: string })[]; accessory?: Button };
const parts = (card: unknown) => (card as { components: Part[] }[])[0]?.components ?? [];
// every button in order: an option's pick button beside its section text, then the write-my-own row
const rows = (card: unknown) => parts(card).flatMap((c) => (c.type === 9 ? [c.accessory] : c.type === 1 ? [c.components?.[0]] : []));
const optionTexts = (card: unknown) => parts(card).filter((c) => c.type === 9).map((c) => c.components?.[0]?.content);

test("a question card is a V2 message that pings only the owner, recommended option first and primary, write-my-own last", async () => {
  const { cards, store, calls, json } = setup();
  const q = await cards.ask("Ship the fix today?", ["Ship it", "Wait for review"], { session: "sess-1", tmux: "aoe_demo_1234abcd" });
  expect(q.id).toBe("Q1");
  expect(calls()).toEqual([`POST /channels/${CHANNEL}/messages`]);
  const body = json(0);
  expect(body.flags).toBe(1 << 15);
  expect(body.allowed_mentions).toEqual({ users: [OWNER] });
  expect(body.components[0].type).toBe(17);
  expect(body.components[0].components[0].content).toBe(`<@${OWNER}> **Q1** Ship the fix today?`);
  expect(body.components[0].components.map((c: Part) => c.type)).toEqual([10, 9, 9, 1]);
  expect(optionTexts(body.components)).toEqual(["**1.** Ship it", "**2.** Wait for review"]);
  expect(rows(body.components)).toEqual([
    { type: 2, style: 1, label: "Pick 1 (recommended)", custom_id: "q:Q1:0" },
    { type: 2, style: 2, label: "Pick 2", custom_id: "q:Q1:1" },
    { type: 2, style: 2, label: "Write my own", custom_id: "q:Q1:other" },
  ] as never);
  expect(store.get("Q1")).toMatchObject({ status: "open", message: "900", session: "sess-1", tmux: "aoe_demo_1234abcd" });
});

test("a long option is shown in full in its section text, not clipped into a button label, and its tap answers with the full text", async () => {
  const { cards, store, json } = setup();
  const long = `Keep the old session cookie for thirty days, then log everyone out on the next deploy and send a notice ${"x".repeat(40)}`;
  expect(long.length).toBeGreaterThan(100);
  await cards.ask("Ship?", ["Yes", long]);
  const card = json(0).components;
  expect(optionTexts(card)[1]).toBe(`**2.** ${long}`);
  expect(rows(card).every((b) => (b?.label.length ?? 0) <= 80)).toBe(true);
  expect(rows(card)[1]).toMatchObject({ label: "Pick 2", custom_id: "q:Q1:1" });
  await cards.handle(tap("q:Q1:1"));
  expect(store.get("Q1")?.answer).toBe(long);
});

test("pick-button wording comes from the discord words", async () => {
  const { dc, store, json } = setup();
  const words = { ...defaultDiscordWords, pick: "{n} 선택", recommended: "추천", other: "직접 입력" };
  await new QuestionCards(dc, store, { channel: CHANNEL, owner: OWNER, words }, () => 0).ask("배포?", ["예", "아니오"]);
  expect(rows(json(0).components).map((b) => b?.label)).toEqual(["1 선택 (추천)", "2 선택", "직접 입력"]);
});

test("the owner's tap folds the card into a record in the same response and logs the answer once; a second tap changes nothing", async () => {
  const { cards, store, calls, json } = setup();
  await cards.ask("Ship the fix today?", ["Ship it", "Wait for review"]);
  const first = await cards.handle(tap("q:Q1:1"));
  expect(first.kind).toBe("answered");
  expect(calls()[1]).toBe("POST /interactions/i1/tok/callback");
  const update = json(1);
  expect(update.type).toBe(7);
  expect(update.data.components[0].components).toHaveLength(1);
  expect(update.data.components[0].components[0].content).toBe("[answered] **Q1** Ship the fix today?\n→ **Wait for review**\n-# button · 1/2, 03:04");
  expect(store.get("Q1")).toMatchObject({ status: "answered", answer: "Wait for review", answerKind: "button" });
  const again = await cards.handle(tap("q:Q1:0"));
  expect(again).toEqual({ kind: "stale", qid: "Q1" });
  expect(json(2).type).toBe(7);
  expect(store.get("Q1")?.answer).toBe("Wait for review");
  expect(readFileSync(store.answersFile, "utf8").trim().split("\n")).toHaveLength(1);
});

test("anyone but the owner gets a private refusal and the question stays open", async () => {
  const { cards, store, json } = setup();
  await cards.ask("Ship?", ["Yes"]);
  expect(await cards.handle(tap("q:Q1:0", "555"))).toEqual({ kind: "refused", user: "555" });
  expect(json(1)).toEqual({ type: 4, data: { content: "Only the owner can answer this.", flags: 64 } });
  expect(store.get("Q1")?.status).toBe("open");
  expect(existsSync(store.answersFile)).toBe(false);
});

test("write-my-own opens a modal, and its typed text becomes the answer", async () => {
  const { cards, store, json } = setup();
  await cards.ask("When should it ship?", ["Today"]);
  expect(await cards.handle(tap("q:Q1:other"))).toEqual({ kind: "modal", qid: "Q1" });
  const modal = json(1);
  expect(modal.type).toBe(9);
  expect(modal.data.custom_id).toBe("m:Q1");
  expect(store.get("Q1")?.status).toBe("open");
  const submit: Interaction = { id: "i2", token: "t2", type: 5, channel_id: CHANNEL, user: { id: OWNER }, data: { custom_id: "m:Q1", components: [{ type: 18, component: { type: 4, custom_id: "answer", value: "  next monday  " } }] } };
  const done = await cards.handle(submit);
  expect(done.kind).toBe("answered");
  expect(store.get("Q1")).toMatchObject({ answer: "next monday", answerKind: "text" });
  expect(json(2).data.components[0].components[0].content).toContain("-# typed");
});

test("reopen puts the buttons back on the posted card; resolve forgets the question", async () => {
  const { cards, store, calls, json } = setup();
  await cards.ask("Ship?", ["Yes", "No"]);
  await cards.handle(tap("q:Q1:0"));
  const q = await cards.reopen("Q1");
  expect(q.status).toBe("open");
  expect(calls()[2]).toBe(`PATCH /channels/${CHANNEL}/messages/900`);
  expect(rows(json(2).components).map((b) => b?.custom_id)).toEqual(["q:Q1:0", "q:Q1:1", "q:Q1:other"]);
  expect(store.get("Q1")?.answer).toBeUndefined();
  expect(await cards.resolve("Q1")).toBe("folded");
  expect(store.all()).toEqual([]);
  await expect(cards.reopen("Q1")).rejects.toBeInstanceOf(QuestionError);
});

test("a question with no options or with shell-substitution text is refused before anything is posted", async () => {
  const { cards, seen } = setup();
  await expect(cards.ask("Ship?", [])).rejects.toBeInstanceOf(QuestionError);
  await expect(cards.ask("Ship $(whoami)?", ["Yes"])).rejects.toBeInstanceOf(UnsafeMessageError);
  expect(seen).toHaveLength(0);
});

// a work thread whose name the fake keeps current, so each status change is one rename
const threadCards = (name = "🔄 fix login") => {
  const thread = { name };
  const f = setup((req) => {
    if (req.method === "GET") return { name: thread.name, type: 11 };
    if (req.method === "PATCH" && req.url.endsWith("/channels/300")) thread.name = JSON.parse(String(req.body)).name ?? thread.name;
    return req.method === "POST" && req.url.endsWith("/messages") ? { id: "900" } : {};
  });
  const cards = new QuestionCards(f.dc, f.store, { channel: CHANNEL, owner: OWNER, words: { ...defaultDiscordWords, statusStyle: "emoji" } }, () => Date.parse("2026-01-02T03:04:00Z"));
  return { ...f, cards, thread };
};
const threadTap = (customId: string): Interaction => ({ ...tap(customId), channel_id: "300" });

test("with a work thread the card is posted inside it, with no link back, and the thread is marked 🔔", async () => {
  const { cards, store, calls, json, thread } = threadCards();
  await cards.ask("Ship?", ["Yes", "No"], { thread: "300" });
  expect(calls()).toEqual(["POST /channels/300/messages", "GET /channels/300", "PATCH /channels/300"]);
  expect(json(0).components[0].components[0].content).toBe(`<@${OWNER}> **Q1** Ship?`);
  expect(json(2)).toEqual({ name: "🔔 fix login" });
  expect(thread.name).toBe("🔔 fix login");
  expect(store.get("Q1")).toMatchObject({ channel: "300", thread: "300", message: "900" });
});

test("an answer to a card inside its thread posts no record line and marks the thread 🔄 again", async () => {
  const { cards, calls, json } = threadCards();
  await cards.ask("Ship?", ["Yes"], { thread: "300" });
  const out = await cards.handle(threadTap("q:Q1:0"));
  if (out.kind !== "answered") throw new Error(out.kind);
  await cards.afterAnswer(out.question);
  expect(calls().slice(3)).toEqual(["POST /interactions/i1/tok/callback", "GET /channels/300", "PATCH /channels/300"]);
  expect(json(5)).toEqual({ name: "🔄 fix login" });
});

test("while another question in the same thread is still open, an answer leaves the thread 🔔", async () => {
  const { cards, calls, thread } = threadCards();
  await cards.ask("Ship?", ["Yes"], { thread: "300" });
  await cards.ask("Deploy where?", ["Staging"], { thread: "300" });
  const out = await cards.handle(threadTap("q:Q1:0"));
  if (out.kind !== "answered") throw new Error(out.kind);
  const before = calls().length;
  await cards.afterAnswer(out.question);
  expect(calls().slice(before).filter((c) => c.startsWith("PATCH"))).toEqual([]);
  expect(thread.name).toBe("🔔 fix login");
});

test("a card posted in the channel for a work thread leaves a silent record line there, then marks the thread 🔄", async () => {
  const { cards, store, calls, json } = threadCards("🔔 fix login");
  const asked = store.create("Ship?", ["Yes"], CHANNEL, { thread: "300" }, "2026-01-02T03:00:00Z");
  store.setMessage(asked.id, "900");
  const out = await cards.handle(tap("q:Q1:0"));
  if (out.kind !== "answered") throw new Error(out.kind);
  await cards.afterAnswer(out.question);
  expect(calls()).toEqual(["POST /interactions/i1/tok/callback", "POST /channels/300/messages", "GET /channels/300", "PATCH /channels/300"]);
  expect(json(1)).toEqual({ content: "Q1 Ship?\n→ Yes (1/2, 03:04)", flags: 1 << 12, allowed_mentions: { parse: [] } });
  expect(json(3)).toEqual({ name: "🔄 fix login" });
});

test("reopening a card inside its thread patches it there and marks the thread 🔔 again", async () => {
  const { cards, calls, thread } = threadCards();
  await cards.ask("Ship?", ["Yes"], { thread: "300" });
  const out = await cards.handle(threadTap("q:Q1:0"));
  if (out.kind !== "answered") throw new Error(out.kind);
  await cards.afterAnswer(out.question);
  expect(thread.name).toBe("🔄 fix login");
  const before = calls().length;
  await cards.reopen("Q1");
  expect(calls().slice(before)).toEqual(["PATCH /channels/300/messages/900", "GET /channels/300", "PATCH /channels/300"]);
  expect(thread.name).toBe("🔔 fix login");
});

test("resolving the last open card in a thread without an answer marks the thread 🔄", async () => {
  const { cards, thread } = threadCards();
  await cards.ask("Ship?", ["Yes"], { thread: "300" });
  await cards.ask("Deploy where?", ["Staging"], { thread: "300" });
  const out = await cards.handle(threadTap("q:Q2:0"));
  if (out.kind !== "answered") throw new Error(out.kind);
  await cards.afterAnswer(out.question);
  expect(thread.name).toBe("🔔 fix login");
  expect(await cards.resolve("Q1")).toBe("folded");
  expect(thread.name).toBe("🔄 fix login");
});

test("with word status the same resolve marks the thread [working]", async () => {
  const { dc, store, thread } = threadCards("[waiting] fix login");
  const cards = new QuestionCards(dc, store, { channel: CHANNEL, owner: OWNER, words: defaultDiscordWords }, () => 0);
  await cards.ask("Ship?", ["Yes"], { thread: "300" });
  expect(await cards.resolve("Q1")).toBe("folded");
  expect(thread.name).toBe("[working] fix login");
});

test("resolving an open card while another card in the thread is still open leaves the thread 🔔", async () => {
  const { cards, calls, thread } = threadCards();
  await cards.ask("Ship?", ["Yes"], { thread: "300" });
  await cards.ask("Deploy where?", ["Staging"], { thread: "300" });
  const before = calls().length;
  expect(await cards.resolve("Q1")).toBe("folded");
  expect(calls().slice(before).filter((c) => c.startsWith("PATCH"))).toEqual(["PATCH /channels/300/messages/900"]);
  expect(thread.name).toBe("🔔 fix login");
});

test("resolving an answered card does not touch the thread status", async () => {
  const { cards, calls, thread } = threadCards();
  await cards.ask("Ship?", ["Yes"], { thread: "300" });
  await cards.handle(threadTap("q:Q1:0"));
  thread.name = "🔔 fix login";
  const before = calls().length;
  expect(await cards.resolve("Q1", "no")).toBe("kept");
  expect(calls().slice(before)).toEqual([]);
  expect(thread.name).toBe("🔔 fix login");
  expect(await cards.resolve("Q9")).toBeNull();
});

const content = (card: unknown) => parts(card)[0]?.content;

test("resolving a card the owner answered in text folds it into the record a tap leaves, logs the answer once, and a second resolve changes nothing", async () => {
  const { cards, store, calls, json } = setup();
  await cards.ask("Ship?", ["Yes", "No"]);
  expect(await cards.resolve("Q1", "  ship it monday  ")).toBe("folded");
  expect(calls()).toEqual([`POST /channels/${CHANNEL}/messages`, `PATCH /channels/${CHANNEL}/messages/900`]);
  expect(parts(json(1).components)).toHaveLength(1);
  expect(content(json(1).components)).toBe("[answered] **Q1** Ship?\n→ **ship it monday**\n-# reply · 1/2, 03:04");
  const logged = readFileSync(store.answersFile, "utf8").trim().split("\n");
  expect(logged).toHaveLength(1);
  expect(JSON.parse(logged[0] ?? "")).toMatchObject({ id: "Q1", status: "answered", answer: "ship it monday", answerKind: "reply" });
  expect(store.all()).toEqual([]);
  expect(await cards.resolve("Q1", "ship it monday")).toBe("already");
  expect(calls()).toHaveLength(2);
  expect(readFileSync(store.answersFile, "utf8").trim().split("\n")).toHaveLength(1);
});

test("without --answer the folded card reads the repliedInText word, marked byReply", async () => {
  const { dc, store, json } = setup();
  const words = { ...defaultDiscordWords, statusStyle: "emoji", byReply: "글", repliedInText: "형 글로 답함" } as const;
  const cards = new QuestionCards(dc, store, { channel: CHANNEL, owner: OWNER, words }, () => Date.parse("2026-01-02T03:04:00Z"));
  await cards.ask("Ship?", ["Yes"]);
  expect(await cards.resolve("Q1")).toBe("folded");
  expect(content(json(1).components)).toBe("✅ **Q1** Ship?\n→ **형 글로 답함**\n-# 글 · 1/2, 03:04");
});

test("resolving a card inside its thread folds it there, then marks the thread 🔄", async () => {
  const { cards, calls, json, thread } = threadCards();
  await cards.ask("Ship?", ["Yes"], { thread: "300" });
  const before = calls().length;
  expect(await cards.resolve("Q1", "yes, today")).toBe("folded");
  expect(calls().slice(before)).toEqual(["PATCH /channels/300/messages/900", "GET /channels/300", "PATCH /channels/300"]);
  expect(content(json(before).components)).toBe("✅ **Q1** Ship?\n→ **yes, today**\n-# reply · 1/2, 03:04");
  expect(thread.name).toBe("🔄 fix login");
});

test("a card in a thread that archived itself is folded by opening the thread and editing it again", async () => {
  const thread = { archived: false };
  const { cards, calls, json } = setup((req) => {
    if (req.method === "PATCH" && req.url.endsWith("/channels/300")) thread.archived = JSON.parse(String(req.body)).archived ?? thread.archived;
    if (req.method === "PATCH" && req.url.includes("/messages/") && thread.archived) throw new Error('discord PATCH /channels/300/messages/900: 400 {"message": "Thread is archived", "code": 50083}');
    if (req.method === "GET") return { name: "🔔 fix login", type: 11, thread_metadata: { archived: thread.archived } };
    return req.method === "POST" && req.url.endsWith("/messages") ? { id: "900" } : {};
  });
  await cards.ask("Ship?", ["Yes"], { thread: "300" });
  thread.archived = true;
  const before = calls().length;
  expect(await cards.resolve("Q1", "yes")).toBe("folded");
  expect(calls().slice(before, before + 3)).toEqual(["PATCH /channels/300/messages/900", "PATCH /channels/300", "PATCH /channels/300/messages/900"]);
  expect(json(before + 1)).toEqual({ archived: false });
  expect(content(json(before + 2).components)).toBe("[answered] **Q1** Ship?\n→ **yes**\n-# reply · 1/2, 03:04");
  expect(readFileSync(cards.store.answersFile, "utf8").trim().split("\n")).toHaveLength(1);
});

test("a failed card edit keeps the question open and unlogged, so resolve can be run again", async () => {
  const { cards, store } = setup((req) => {
    if (req.method === "PATCH") throw new Error("discord down");
    return req.method === "POST" && req.url.endsWith("/messages") ? { id: "900" } : {};
  });
  await cards.ask("Ship?", ["Yes"]);
  await expect(cards.resolve("Q1", "yes")).rejects.toThrow();
  expect(store.get("Q1")?.status).toBe("open");
  expect(existsSync(store.answersFile)).toBe(false);
});

test("a failed thread rename does not fail the ask: the card is already posted", async () => {
  const { cards, store } = setup((req) => {
    if (req.method === "GET") throw new Error("rate limited");
    return req.method === "POST" && req.url.endsWith("/messages") ? { id: "900" } : {};
  });
  const q = await cards.ask("Ship?", ["Yes"], { thread: "300" });
  expect(q.message).toBe("900");
  expect(store.get("Q1")?.status).toBe("open");
});

test("the done thread hook posts without emoji, swaps the status word in the thread name, then archives", async () => {
  const f = fakeDiscord((req) => (req.method === "GET" ? { name: "[working] fix login", type: 11 } : req.method === "POST" && req.url.endsWith("/messages") ? { id: "901" } : {}));
  const t = "300000000000000003";
  expect((await threadHook(f.dc, "done", `discord:${t}`, "merged 🎉 abc123", defaultDiscordWords)).id).toBe("901");
  expect(f.calls()).toEqual([`POST /channels/${t}/typing`, `POST /channels/${t}/messages`, `GET /channels/${t}`, `PATCH /channels/${t}`, `PATCH /channels/${t}`]);
  expect(f.json(1).content).toBe("merged abc123");
  expect(f.json(3)).toEqual({ name: "[done] fix login" });
  expect(f.json(4)).toEqual({ archived: true });
  await expect(threadHook(f.dc, "reply", "telegram:1", "x", defaultDiscordWords)).rejects.toBeInstanceOf(ThreadRefError);
});

const emoji = { ...defaultDiscordWords, statusStyle: "emoji" } as const;
const T = "300000000000000003";
const threadAs = (name: string, archived = false) => fakeDiscord((req) => (req.method === "GET" ? { name, type: 11, thread_metadata: { archived } } : req.method === "POST" && req.url.endsWith("/messages") ? { id: "901" } : {}));

test("with emoji status the done hook swaps the word mark for ✅ and archives; the posted note still has no emoji", async () => {
  const f = threadAs("[working] fix login");
  await threadHook(f.dc, "done", `discord:${T}`, "merged 🎉 abc123", emoji);
  expect(f.json(1).content).toBe("merged abc123");
  expect(f.json(3)).toEqual({ name: "✅ fix login" });
  expect(f.json(4)).toEqual({ archived: true });
});

test("a reply with no lane working leaves the thread to the owner (🔔) and wait marks it waiting, opening an archived thread in the same request", async () => {
  const done = threadAs("✅ fix login", true);
  await threadHook(done.dc, "reply", `discord:${T}`, "picking this up again", emoji);
  expect(done.calls().slice(2)).toEqual([`GET /channels/${T}`, `PATCH /channels/${T}`]);
  expect(done.json(3)).toEqual({ name: "🔔 fix login", archived: false });
  const working = threadAs("🔄 fix login");
  await threadHook(working.dc, "wait", `discord:${T}`, "Q2 is waiting on you", emoji);
  expect(working.json(3)).toEqual({ name: "🔔 fix login" });
});

test("a thread named with the old ⏸ (no U+FE0F) mark is still recognized: its mark is replaced, never doubled", async () => {
  const legacy = threadAs("\u23F8 fix login");
  await setThreadStatus(legacy.dc, T, "working", emoji);
  expect(legacy.json(1)).toEqual({ name: "🔄 fix login" });
  const waiting = threadAs("\u23F8\uFE0F fix login");
  await threadHook(waiting.dc, "wait", `discord:${T}`, "still waiting", emoji);
  expect(waiting.json(3)).toEqual({ name: "🔔 fix login" });
});

test("a status that already holds sends no rename, since Discord allows only about two per ten minutes", async () => {
  const f = threadAs("🔔 fix login");
  await threadHook(f.dc, "reply", `discord:${T}`, "tests are green", emoji);
  expect(f.calls().filter((c) => c.startsWith("PATCH"))).toEqual([]);
  const words = threadAs("fix login");
  await threadHook(words.dc, "reply", `discord:${T}`, "started", defaultDiscordWords);
  expect(words.json(3)).toEqual({ name: "[waiting] fix login" });
});

test("the progress message reads working:/done: in words, ⏳ · / ✅ with emoji", () => {
  expect(progressText("working", "14:05 edited", defaultDiscordWords)).toBe("working: 14:05 edited");
  expect(progressText("done", "login fixed", defaultDiscordWords)).toBe("done: login fixed");
  expect(progressText("working", "14:05 edited", emoji)).toBe("⏳ · 14:05 edited");
  expect(progressText("done", "login fixed", emoji)).toBe("✅ login fixed");
});

test("with emoji status a folded card starts with ✅ instead of the answered word", async () => {
  state = withState();
  const f = fakeDiscord((req) => (req.method === "POST" && req.url.endsWith("/messages") ? { id: "900" } : {}));
  const cards = new QuestionCards(f.dc, new QuestionStore(`${state.dir}/discord`), { channel: CHANNEL, owner: OWNER, words: emoji }, () => Date.parse("2026-01-02T03:04:00Z"));
  await cards.ask("Ship?", ["Yes"]);
  await cards.handle(tap("q:Q1:0"));
  expect(f.json(1).data.components[0].components[0].content).toBe("✅ **Q1** Ship?\n→ **Yes**\n-# button · 1/2, 03:04");
});

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { defaultDiscordWords } from "../src/config.ts";
import { Discord } from "../src/messenger/discord.ts";
import { QuestionCards, QuestionStore } from "../src/messenger/discord-cards.ts";
import { audioAttachment, type DiscordMessage, DiscordListener, eyesOff, type GatewayConnection, type ListenerDeps, LISTENER_INTENTS, webhookVerdict } from "../src/messenger/discord-listener.ts";
import type { Http, HttpRequest, HttpResponse } from "../src/messenger/http.ts";
import { fakeClock, withState } from "./fakes.ts";

const OWNER = "100000000000000001";
const GUILD = "400000000000000004";
const CHANNEL = "200000000000000002";
const THREAD = "300000000000000003";
const SELF = "600000000000000006";
const OTHER_BOT = "700000000000000007";
const DM = "800000000000000008";

const fakeGateway = () => {
  const sent: string[] = [];
  const closed: number[] = [];
  let onMsg: (d: string) => void = () => {};
  let onClose: (code: number) => void = () => {};
  const conn: GatewayConnection = { send: (d) => sent.push(d), close: (code = 1000) => { closed.push(code); }, onMessage: (cb) => { onMsg = cb; }, onClose: (cb) => { onClose = cb; } };
  return { conn, sent, closed, push: (p: object) => onMsg(JSON.stringify(p)), drop: (code: number) => onClose(code) };
};

const fakeTimers = () => {
  const intervals = new Set<() => void>();
  const timeouts: number[] = [];
  const reconnects: (() => void)[] = [];
  return {
    intervals,
    timeouts,
    timers: { setInterval: (cb: () => void) => { intervals.add(cb); return cb; }, clearInterval: (h: unknown) => { intervals.delete(h as () => void); }, setTimeout: (cb: () => void, ms: number) => { timeouts.push(ms); reconnects.push(cb); return ms; } },
    beat: () => { for (const cb of intervals) cb(); },
    reconnect: () => { const cb = reconnects.shift(); if (!cb) throw new Error("no reconnect scheduled"); cb(); },
  };
};

let state: ReturnType<typeof withState>;
afterEach(() => state?.done());

const setup = (route: (req: HttpRequest) => unknown = () => ({}), opts: { inbox?: string; transcribe?: (url: string) => Promise<string>; respond?: (req: HttpRequest) => HttpResponse | undefined; autoUnEye?: boolean; ownerWebhook?: string; pairChannel?: string; pairBots?: readonly string[]; watchChannels?: string[]; watchBots?: string[]; watchMatch?: RegExp; shadow?: boolean; mentionRoleIds?: string[]; callNames?: string[]; gate?: (req: HttpRequest) => Promise<void> | undefined; hints?: (text: string) => readonly string[] } = {}) => {
  state = withState();
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    await opts.gate?.(req);
    const special = opts.respond?.(req);
    if (special) return special;
    const result = req.method === "POST" && req.url.endsWith("/users/@me/channels") ? { id: DM } : route(req);
    const body = req.url.includes("/interactions/") || req.method === "PUT" ? "" : JSON.stringify(
      req.url.includes("/messages?") && !Array.isArray(result) ? [] : result,
    );
    return { status: body ? 200 : 204, headers: {}, body };
  };
  const sleeps: number[] = [];
  const dc = new Discord(http, { ...fakeClock(0), sleep: async (ms: number) => { sleeps.push(ms); } }, "bot");
  // one words setting for the cards and the listener, as the CLI builds them from one config
  const words = { ...defaultDiscordWords, statusStyle: "emoji" as const, autoUnEye: opts.autoUnEye ?? true, mentionRoleIds: opts.mentionRoleIds ?? [], callNames: opts.callNames ?? [] };
  const cards = new QuestionCards(dc, new QuestionStore(`${state.dir}/discord`), { channel: CHANNEL, owner: OWNER, words }, () => Date.parse("2026-01-02T03:04:00Z"));
  const inboxFile = `${state.dir}/discord/inbox.jsonl`;
  if (opts.inbox) {
    mkdirSync(`${state.dir}/discord`, { recursive: true });
    writeFileSync(inboxFile, opts.inbox);
  }
  const gw = fakeGateway();
  const t = fakeTimers();
  const logs: string[] = [];
  const fatal: number[] = [];
  const deps: ListenerDeps = { dc, cards, open: () => gw.conn, token: "BOT", guild: GUILD, channel: CHANNEL, owner: OWNER, ...(opts.ownerWebhook !== undefined ? { ownerWebhook: opts.ownerWebhook } : {}), ...(opts.pairChannel ? { pairChannel: opts.pairChannel, pairBots: opts.pairBots ?? [] } : {}), ...(opts.watchChannels ? { watchChannels: opts.watchChannels, watchBots: opts.watchBots ?? [] } : {}), ...(opts.watchMatch ? { watchMatch: opts.watchMatch } : {}), ...(opts.shadow ? { shadow: true } : {}), words, inboxFile, timers: t.timers, now: () => Date.parse("2026-01-02T03:04:00Z"), log: (l) => logs.push(l), fatal: (c) => fatal.push(c), ...(opts.transcribe ? { transcribe: opts.transcribe } : {}), ...(opts.hints ? { hints: opts.hints } : {}) };
  const listener = new DiscordListener(deps);
  const inbox = () => (existsSync(inboxFile) ? readFileSync(inboxFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const calls = () => seen.map((r) => `${r.method} ${r.url.replace("https://discord.com/api/v10", "")}`);
  const eyesFile = () => JSON.parse(readFileSync(`${state.dir}/discord/eyes.json`, "utf8"));
  return { listener, restart: () => new DiscordListener(deps), cards, gw, t, logs, fatal, inbox, calls, seen, sleeps, eyesFile, dc, eyesPath: `${state.dir}/discord/eyes.json` };
};

const unreacts = (calls: () => string[]) => calls().filter((c) => c.startsWith("DELETE")).map((c) => c.replace("DELETE /channels/", "").replace("/reactions/%F0%9F%91%80/@me", ""));

const msg = (id: string, patch: Partial<DiscordMessage> = {}): DiscordMessage => ({ id, channel_id: CHANNEL, guild_id: GUILD, content: `hello ${id}`, timestamp: "2026-01-02T03:00:00Z", author: { id: OWNER }, ...patch });

test.each([7, 9])("gateway opcode %i requests a reconnect without impersonating an upstream unknown-opcode error", (op) => {
  const { listener, gw } = setup();
  listener.start();
  gw.push({ op, d: null });
  expect(gw.closed).toEqual([4000]);
});

test("an owner DM sent while the socket is down is backfilled after reconnect and the scan cursor survives restart", async () => {
  const history: DiscordMessage[] = [];
  const route = (req: HttpRequest) => {
    if (!req.url.includes(`/channels/${DM}/messages?`)) return [];
    const after = new URL(req.url).searchParams.get("after") ?? "0";
    return history.filter((m) => BigInt(m.id) > BigInt(after)).slice(0, 100).reverse();
  };
  const { listener, restart, gw, t, inbox, calls } = setup(route, {
    inbox: `${JSON.stringify({ id: "2000", channel_id: CHANNEL, scope: "channel" })}\n`,
    transcribe: async () => "test transcript",
  });
  listener.start();
  gw.push({ op: 0, s: 1, t: "READY", d: { user: { id: SELF } } });
  await listener.settled();
  gw.drop(1006);
  history.push(
    msg("1001", { channel_id: DM, guild_id: undefined }),
    msg("1002", { channel_id: DM, guild_id: undefined, author: { id: "555" } }),
    msg("1003", { channel_id: DM, guild_id: undefined, author: { id: OTHER_BOT, bot: true } }),
    msg("1004", { channel_id: DM, guild_id: undefined, content: "", attachments: [{ url: "https://cdn.example/a.ogg", filename: "a.ogg" }] }),
  );
  t.reconnect();
  gw.push({ op: 0, s: 1, t: "READY", d: { user: { id: SELF } } });
  await listener.settled();
  expect(inbox().map((r) => [r.id, r.scope])).toEqual([["2000", "channel"], ["1001", "dm"], ["1004", "dm"]]);
  expect(inbox().at(-1)?.transcript).toBe("test transcript");
  await restart().backfill();
  expect(calls().at(-1)).toBe(`GET /channels/${DM}/messages?after=1004&limit=100`);
  expect(JSON.parse(readFileSync(`${state.dir}/discord/backfill.json`, "utf8"))[DM]).toBe("1004");
});

test("backfill paginates skipped bot messages and advances beyond them without accepting them", async () => {
  const history = Array.from({ length: 102 }, (_, i) => msg(String(1001 + i), { author: { id: OTHER_BOT, bot: true } }));
  history.push(msg("1103"));
  const { listener, inbox, calls } = setup((req) => {
    if (!req.url.includes(`/channels/${CHANNEL}/messages?`)) return [];
    const after = new URL(req.url).searchParams.get("after") ?? "0";
    return history.filter((m) => BigInt(m.id) > BigInt(after)).slice(0, 100).reverse();
  }, { inbox: `${JSON.stringify({ id: "1000", channel_id: CHANNEL, scope: "channel" })}\n` });
  await listener.backfill();
  await listener.backfill();
  expect(inbox().map((r) => r.id)).toEqual(["1000", "1103"]);
  expect(calls()).toContain(`GET /channels/${CHANNEL}/messages?after=1100&limit=100`);
  expect(calls()).toContain(`GET /channels/${CHANNEL}/messages?after=1103&limit=100`);
});

test("a skipped-only scan is durable and a newer live event does not hide a reconnect gap", async () => {
  const history: DiscordMessage[] = [msg("1001", { author: { id: OTHER_BOT, bot: true } })];
  const { listener, restart, inbox, calls } = setup((req) => {
    if (!req.url.includes(`/channels/${CHANNEL}/messages?`)) return [];
    const after = new URL(req.url).searchParams.get("after") ?? "0";
    return history.filter((m) => BigInt(m.id) > BigInt(after));
  }, { inbox: `${JSON.stringify({ id: "1000", channel_id: CHANNEL, scope: "channel" })}\n` });
  await listener.backfill();
  history.push(msg("1002"));
  // The live socket wins the race to a newer message. The scan still owes the gap.
  await listener.onMessage(msg("1003"));
  await restart().backfill();
  expect(calls()).toContain(`GET /channels/${CHANNEL}/messages?after=1001&limit=100`);
  expect(inbox().map((r) => r.id)).toEqual(["1000", "1003", "1002"]);
});

test("a failed history page keeps its cursor for the next reconnect", async () => {
  let fail = true;
  const { listener, restart, inbox, calls } = setup((req) => {
    if (req.url.includes(`/channels/${CHANNEL}/messages?`)) {
      if (fail) throw new Error("history unavailable");
      return [msg("1001")];
    }
    return [];
  }, { inbox: `${JSON.stringify({ id: "1000", channel_id: CHANNEL, scope: "channel" })}\n` });
  await expect(listener.backfill()).rejects.toThrow("history unavailable");
  fail = false;
  await restart().backfill();
  expect(calls().filter((c) => c === `GET /channels/${CHANNEL}/messages?after=1000&limit=100`)).toHaveLength(2);
  expect(inbox().map((r) => r.id)).toEqual(["1000", "1001"]);
});

test("the listener identifies with the message-content intents after hello, heartbeats, and drops a zombie connection", () => {
  const { listener, gw, t } = setup();
  listener.start();
  gw.push({ op: 10, d: { heartbeat_interval: 41250 } });
  const identify = JSON.parse(gw.sent[0] ?? "{}");
  expect(identify).toMatchObject({ op: 2, d: { token: "BOT", intents: LISTENER_INTENTS } });
  expect(LISTENER_INTENTS & (1 << 15)).toBeTruthy();
  gw.push({ op: 0, s: 5, t: "TYPING_START", d: {} });
  t.beat();
  expect(JSON.parse(gw.sent[1] ?? "{}")).toEqual({ op: 1, d: 5 });
  t.beat();
  expect(gw.closed).toEqual([4000]);
});

test("an owner message in the channel gets the eyes reaction and an inbox row; other authors, bots and other guilds are skipped", async () => {
  const { listener, gw, inbox, calls, logs } = setup();
  listener.start();
  gw.push({ op: 0, s: 1, t: "MESSAGE_CREATE", d: msg("1001") });
  gw.push({ op: 0, s: 2, t: "MESSAGE_CREATE", d: msg("1002", { author: { id: "555" } }) });
  gw.push({ op: 0, s: 3, t: "MESSAGE_CREATE", d: msg("1003", { author: { id: OWNER, bot: true } }) });
  gw.push({ op: 0, s: 4, t: "MESSAGE_CREATE", d: msg("1004", { guild_id: "999" }) });
  gw.push({ op: 0, s: 5, t: "MESSAGE_CREATE", d: msg("1001") });
  await listener.settled();
  expect(calls()).toEqual([`PUT /channels/${CHANNEL}/messages/1001/reactions/%F0%9F%91%80/@me`]);
  expect(inbox()).toEqual([{ ts: "2026-01-02T03:00:00Z", id: "1001", channel_id: CHANNEL, scope: "channel", author_id: OWNER, content: "hello 1001", transcript: null, attachments: [], reply_to: null }]);
  expect(logs).toContain(`INBOUND discord-channel ${CHANNEL} 1001 ${OWNER} "hello 1001"`);
});

// 2026-11-02: an owner message reached MooDori's lead as a bare inbox line, with none of the directives it was about
test("the owner's message carries the directives its words call; a pair-bot post does not; a ledger that cannot be read still writes the row", async () => {
  let broken = false;
  const hints = (text: string) => {
    if (broken) throw new Error("ledger.json is not readable JSON");
    return text.includes("카드") ? ["[형 지침 card-docs, 2026-10-19] 카드 미결재 항목이 올라오면 서류를 준비한다."] : [];
  };
  const { listener, inbox, logs } = setup(() => ({}), { pairChannel: "900000000000000009", pairBots: [OTHER_BOT], hints });
  await listener.onMessage(msg("1001", { content: "그리고 카드처리해 서류 준비하고 있어" }));
  await listener.onMessage(msg("1002", { content: "점심 먹자" }));
  await listener.onMessage(msg("1003", { channel_id: "900000000000000009", author: { id: OTHER_BOT, bot: true }, content: "카드 건 넘겨" }));
  broken = true;
  await listener.onMessage(msg("1004", { content: "카드 다시" }));
  expect(inbox().map((r) => [r.id, r.directives ?? null, r.directives_error ?? null])).toEqual([
    ["1001", ["[형 지침 card-docs, 2026-10-19] 카드 미결재 항목이 올라오면 서류를 준비한다."], null],
    ["1002", null, null],
    ["1003", null, null],
    ["1004", null, "ledger.json is not readable JSON; read the ledger with dori directives"],
  ]);
  expect(logs).toContain("DISCORD_DIRECTIVES_FAIL 1004 ledger.json is not readable JSON");
});

test("a message in a thread under the channel counts, one under another channel does not, and DMs count", async () => {
  const { listener, inbox } = setup((req) => (req.url.endsWith(`/channels/${THREAD}`) ? { parent_id: CHANNEL } : { parent_id: "777" }));
  await listener.onMessage(msg("1001", { channel_id: THREAD }));
  await listener.onMessage(msg("1002", { channel_id: "888" }));
  await listener.onMessage(msg("1003", { channel_id: "dm1", guild_id: undefined }));
  expect(inbox().map((r) => [r.id, r.scope])).toEqual([["1001", "thread"], ["1003", "dm"]]);
});

test("the owner writing in a closed thread reopens it as working; an open thread is left alone", async () => {
  const names: Record<string, string> = { "501": "✅ fix login", "502": "[done] old thread", "503": "🔄 still going" };
  const { listener, calls, seen, logs } = setup((req) => {
    const id = /\/channels\/(\d+)$/.exec(req.url)?.[1] ?? "";
    return id in names ? { parent_id: CHANNEL, name: names[id], type: 11, thread_metadata: { archived: id !== "503" } } : {};
  });
  for (const [n, thread] of ["501", "502", "503"].entries()) await listener.onMessage(msg(`100${n}`, { channel_id: thread }));
  const patches = seen.filter((r) => r.method === "PATCH");
  expect(patches.map((r) => [r.url.replace("https://discord.com/api/v10", ""), JSON.parse(String(r.body))])).toEqual([
    ["/channels/501", { name: "🔄 fix login", archived: false }],
    ["/channels/502", { name: "🔄 old thread", archived: false }],
  ]);
  expect(calls().some((c) => c === "PATCH /channels/503")).toBe(false);
  expect(logs.filter((l) => l.startsWith("THREAD_REOPENED"))).toEqual(["THREAD_REOPENED 501", "THREAD_REOPENED 502"]);
});

test("the owner answering a thread that showed his turn (🔔 with no card, the old ⏸️, ❗) makes it ours again, and one that ended ⛔ or 💤 reopens", async () => {
  const names: Record<string, string> = { "511": "🔔 asked you", "512": "⏸️ old wait", "513": "❗ 🔐 share failed", "514": "⛔ ✉️ cancelled mail", "515": "💤 ✉️ replaced draft" };
  const { listener, seen, logs } = setup((req) => {
    const id = /\/channels\/(\d+)$/.exec(req.url)?.[1] ?? "";
    return id in names ? { parent_id: CHANNEL, name: names[id], type: 11, thread_metadata: { archived: id === "514" || id === "515" } } : {};
  });
  for (const [n, thread] of Object.keys(names).entries()) await listener.onMessage(msg(`200${n}`, { channel_id: thread }));
  const patches = seen.filter((r) => r.method === "PATCH").map((r) => [r.url.replace("https://discord.com/api/v10", ""), JSON.parse(String(r.body)).name]);
  expect(patches).toEqual([
    ["/channels/511", "🔄 asked you"],
    ["/channels/512", "🔄 old wait"],
    ["/channels/513", "🔄 🔐 share failed"],
    ["/channels/514", "🔄 ✉️ cancelled mail"],
    ["/channels/515", "🔄 ✉️ replaced draft"],
  ]);
  expect(logs.filter((l) => /^THREAD_(REOPENED|ANSWERED)/.test(l))).toEqual(["THREAD_ANSWERED 511", "THREAD_ANSWERED 512", "THREAD_ANSWERED 513", "THREAD_REOPENED 514", "THREAD_REOPENED 515"]);
});

test("a voice note is transcribed into the inbox row; a failed transcription still records the message", async () => {
  let fail = false;
  const { listener, inbox, logs } = setup(() => ({}), { transcribe: async () => { if (fail) throw new Error("stt down"); return "ship it"; } });
  const voice = { attachments: [{ url: "https://cdn.example/v.ogg", filename: "v.ogg", content_type: "audio/ogg" }] };
  await listener.onMessage(msg("1001", { content: "", ...voice }));
  fail = true;
  await listener.onMessage(msg("1002", { content: "", ...voice }));
  expect(inbox().map((r) => r.transcript)).toEqual(["ship it", null]);
  expect(logs.some((l) => l.startsWith("DISCORD_TRANSCRIBE_FAIL 1002"))).toBe(true);
});

test("webhookVerdict: the registered webhook in the channel is the owner, other webhooks and channels are ignored, an unset one is unknown", () => {
  const cfg = { guild: GUILD, channel: CHANNEL, ownerWebhook: "w1" };
  expect(webhookVerdict({ webhook_id: "w1", channel_id: CHANNEL, guild_id: GUILD }, cfg)).toBe("owner");
  expect(webhookVerdict({ webhook_id: "w2", channel_id: CHANNEL, guild_id: GUILD }, cfg)).toBe("ignore");
  expect(webhookVerdict({ webhook_id: "w1", channel_id: THREAD, guild_id: GUILD }, cfg)).toBe("ignore");
  expect(webhookVerdict({ webhook_id: "w1", channel_id: CHANNEL, guild_id: "999" }, cfg)).toBe("ignore");
  expect(webhookVerdict({ webhook_id: "w9", channel_id: CHANNEL, guild_id: GUILD }, { ...cfg, ownerWebhook: "" })).toBe("unknown");
  expect(webhookVerdict({ channel_id: CHANNEL, guild_id: GUILD }, cfg)).toBeNull();
});

test.each([
  ["voice-message.ogg", "audio/ogg"],
  ["Recording.m4a", "audio/x-m4a"],
  ["Recording.m4a", "audio/mp4"],
  ["Recording.m4a", "video/mp4"],
  ["Recording.m4a", undefined],
  ["rec.mp4", "video/mp4"],
  ["rec.caf", "application/octet-stream"],
  ["a.wav", "audio/wav"],
])("audioAttachment: %s (%p) is audio", (filename, content_type) => {
  expect(audioAttachment([{ url: "u", filename, ...(content_type ? { content_type } : {}) }])?.filename).toBe(filename);
});

test("audioAttachment: images and text are not audio", () => {
  expect(audioAttachment([{ url: "u", filename: "a.png", content_type: "image/png" }, { url: "u", filename: "n.txt" }])).toBeUndefined();
});

const hook = (id: string, webhook_id: string) => msg(id, { content: "", webhook_id, author: { id: webhook_id, bot: true, username: "Voice" }, attachments: [{ url: "https://cdn.example/r.m4a", filename: "Recording.m4a", content_type: "video/mp4" }] });

test("the owner's webhook posting an iOS Shortcut recording (video/mp4 .m4a) is the owner's voice note; another webhook is not", async () => {
  const { listener, inbox, logs } = setup(() => ({}), { ownerWebhook: "800000000000000008", transcribe: async () => "ship it" });
  await listener.onMessage(hook("1001", "800000000000000008"));
  await listener.onMessage(hook("1002", "900000000000000009"));
  await listener.onMessage(hook("1003", "800000000000000008"));
  expect(inbox()).toEqual([
    expect.objectContaining({ id: "1001", scope: "channel", author_id: OWNER, transcript: "ship it", via: "owner-webhook", webhook_id: "800000000000000008" }),
    expect.objectContaining({ id: "1003", author_id: OWNER, via: "owner-webhook" }),
  ]);
  expect(logs.some((l) => l.startsWith("DISCORD_WEBHOOK_UNKNOWN"))).toBe(false);
});

// 2026-10-30: the owner moved his Shortcut webhook to another Dori's channel, where no id was registered, and four recordings vanished
test("with no owner webhook set, a webhook recording in the channel lands transcribed with a note to register its id, not as the owner's; a webhook text post is only logged", async () => {
  const { listener, inbox, logs } = setup(() => ({}), { transcribe: async () => "ship it" });
  await listener.onMessage(hook("1004", "800000000000000008"));
  await listener.onMessage(msg("1005", { content: "build failed", webhook_id: "900000000000000009", author: { id: "900000000000000009", bot: true, username: "CI" } }));
  await listener.onMessage(msg("1006", { content: "", author: { id: "555" }, attachments: [{ url: "https://cdn.example/r.m4a", filename: "Recording.m4a", content_type: "video/mp4" }] }));
  expect(inbox()).toEqual([
    expect.objectContaining({ id: "1004", scope: "channel", author_id: "800000000000000008", transcript: "ship it", via: "unknown-webhook", webhook_id: "800000000000000008", note: expect.stringContaining("DORI_DISCORD_OWNER_WEBHOOK=800000000000000008") }),
  ]);
  expect(logs).toContain(`DISCORD_WEBHOOK_UNKNOWN id=800000000000000008 name="Voice" message=1004`);
  expect(logs).toContain(`DISCORD_WEBHOOK_UNKNOWN id=900000000000000009 name="CI" message=1005`);
});

test("a tap on a card inside its work thread is taken, lands in the inbox with its session and tmux, and turns the thread working; a tap from an unrelated channel is ignored", async () => {
  const { listener, cards, gw, inbox, calls } = setup((req) => (req.method === "GET" ? { name: "🔔 fix login", type: 11 } : req.method === "POST" && req.url.endsWith(`/channels/${THREAD}/messages`) ? { id: "900" } : {}));
  await cards.ask("Ship?", ["Yes", "No"], { thread: THREAD, session: "sess-1", tmux: "aoe_demo_1234abcd" });
  expect(calls()[0]).toBe(`POST /channels/${THREAD}/messages`);
  const before = calls().length;
  listener.start();
  gw.push({ op: 0, s: 1, t: "INTERACTION_CREATE", d: { id: "5001", token: "tok", type: 3, channel_id: "777", member: { user: { id: OWNER } }, data: { custom_id: "q:Q1:0" } } });
  gw.push({ op: 0, s: 2, t: "INTERACTION_CREATE", d: { id: "5002", token: "tok", type: 3, channel_id: THREAD, member: { user: { id: OWNER } }, data: { custom_id: "q:Q1:1" } } });
  await listener.settled();
  expect(inbox()).toEqual([{ ts: "2026-01-02T03:04:00.000Z", id: "5002", kind: "answer", qid: "Q1", answer: "No", answer_kind: "button", question: "Ship?", thread: THREAD, session: "sess-1", tmux: "aoe_demo_1234abcd" }]);
  expect(calls().slice(before)).toEqual(["POST /interactions/5002/tok/callback", `GET /channels/${THREAD}`, `PATCH /channels/${THREAD}`]);
});

test("a tap in the configured channel is still taken, and a tap on an unknown question from another channel is ignored", async () => {
  const { listener, cards, inbox, calls } = setup((req) => (req.method === "POST" && req.url.endsWith(`/channels/${CHANNEL}/messages`) ? { id: "900" } : {}));
  await cards.ask("Ship?", ["Yes"]);
  await listener.onInteraction({ id: "5003", token: "tok", type: 3, channel_id: THREAD, member: { user: { id: OWNER } }, data: { custom_id: "q:Q9:0" } });
  await listener.onInteraction({ id: "5004", token: "tok", type: 3, channel_id: CHANNEL, member: { user: { id: OWNER } }, data: { custom_id: "q:Q1:0" } });
  expect(inbox().map((r) => r.id)).toEqual(["5004"]);
  expect(calls().filter((c) => c.includes("/interactions/"))).toEqual(["POST /interactions/5004/tok/callback"]);
});

test("on READY it backfills owner messages newer than the inbox from the channel and its active threads, oldest first", async () => {
  const route = (req: HttpRequest) => {
    if (req.url.endsWith(`/guilds/${GUILD}/threads/active`)) return { threads: [{ id: THREAD, parent_id: CHANNEL }, { id: "666", parent_id: "777" }] };
    if (req.url.includes(`/channels/${CHANNEL}/messages?after=1000`)) return [msg("1002", { guild_id: undefined }), msg("1001", { guild_id: undefined })];
    if (req.url.includes(`/channels/${THREAD}/messages?after=0`)) return [msg("1003", { channel_id: THREAD, guild_id: undefined })];
    return {};
  };
  const { listener, gw, inbox, calls, logs } = setup(route, { inbox: `${JSON.stringify({ id: "1000", ts: "x", channel_id: CHANNEL, scope: "channel" })}\n${JSON.stringify({ id: "5000", kind: "answer" })}\n` });
  listener.start();
  gw.push({ op: 0, s: 1, t: "READY", d: {} });
  await listener.settled();
  expect(inbox().map((r) => r.id)).toEqual(["1000", "5000", "1001", "1002", "1003"]);
  expect(calls().filter((c) => c.startsWith("GET")).some((c) => c.includes("/channels/666/"))).toBe(false);
  expect(logs).toContain("DISCORD_BACKFILL since=1000 added=3");
});

// the listener learns its own bot id from READY; only that bot's messages clear eyes
const ready = (gw: ReturnType<typeof fakeGateway>) => gw.push({ op: 0, s: 1, t: "READY", d: { user: { id: SELF } } });
const fromBot = (id: string, patch: Partial<DiscordMessage> = {}) => msg(id, { author: { id: SELF, bot: true }, ...patch });

test("our bot's reply takes the eyes off the message it answers, tracked or marked before the state file existed", async () => {
  const { listener, gw, calls, eyesFile, logs } = setup();
  listener.start();
  ready(gw);
  await listener.onMessage(msg("1001"));
  expect(eyesFile()).toEqual({ [CHANNEL]: ["1001"] });
  await listener.onMessage(fromBot("1002", { message_reference: { message_id: "1001" } }));
  expect(unreacts(calls)).toEqual([`${CHANNEL}/messages/1001`]);
  expect(eyesFile()).toEqual({});
  expect(logs).toContain(`EYES_CLEARED ${CHANNEL} by=1002 1001`);
  await listener.onMessage(fromBot("1003", { message_reference: { message_id: "0999" } }));
  expect(unreacts(calls)).toEqual([`${CHANNEL}/messages/1001`, `${CHANNEL}/messages/0999`]);
});

test("any message from our bot clears every earlier eyed owner message in that channel, but not a later one", async () => {
  const { listener, gw, calls, eyesFile } = setup();
  listener.start();
  ready(gw);
  for (const id of ["1001", "1002", "1005"]) await listener.onMessage(msg(id));
  gw.push({ op: 0, s: 2, t: "MESSAGE_CREATE", d: fromBot("1004") });
  await listener.settled();
  expect(unreacts(calls)).toEqual([`${CHANNEL}/messages/1001`, `${CHANNEL}/messages/1002`]);
  expect(eyesFile()).toEqual({ [CHANNEL]: ["1005"] });
});

test("a bot message in one channel leaves the eyes in another channel", async () => {
  const { listener, gw, calls, eyesFile } = setup();
  listener.start();
  ready(gw);
  await listener.onMessage(msg("1001"));
  await listener.onMessage(msg("1002", { channel_id: "dm1", guild_id: undefined }));
  await listener.onMessage(fromBot("1003", { channel_id: "dm1", guild_id: undefined }));
  expect(unreacts(calls)).toEqual(["dm1/messages/1002"]);
  expect(eyesFile()).toEqual({ [CHANNEL]: ["1001"] });
});

test("a bot message inside a thread clears only that thread, and one in the channel only the channel", async () => {
  const { listener, gw, calls } = setup((req) => (req.url.endsWith(`/channels/${THREAD}`) ? { parent_id: CHANNEL, name: "🔄 work" } : {}));
  listener.start();
  ready(gw);
  await listener.onMessage(msg("1001", { channel_id: THREAD }));
  await listener.onMessage(msg("1002"));
  await listener.onMessage(fromBot("1003", { channel_id: THREAD }));
  expect(unreacts(calls)).toEqual([`${THREAD}/messages/1001`]);
  await listener.onMessage(fromBot("1004"));
  expect(unreacts(calls)).toEqual([`${THREAD}/messages/1001`, `${CHANNEL}/messages/1002`]);
});

test("with discord.autoUnEye off the eyes stay", async () => {
  const { listener, gw, calls } = setup(() => ({}), { autoUnEye: false });
  listener.start();
  ready(gw);
  await listener.onMessage(msg("1001"));
  await listener.onMessage(fromBot("1002", { message_reference: { message_id: "1001" } }));
  expect(unreacts(calls)).toEqual([]);
});

test("a rate-limited unreact waits out retry_after and is retried", async () => {
  let limited = 0;
  const respond = (req: HttpRequest): HttpResponse | undefined => (req.method === "DELETE" && limited++ === 0 ? { status: 429, headers: {}, body: JSON.stringify({ retry_after: 2.5 }) } : undefined);
  const { listener, gw, calls, sleeps, eyesFile, logs } = setup(() => ({}), { respond });
  listener.start();
  ready(gw);
  await listener.onMessage(msg("1001"));
  await listener.onMessage(fromBot("1002"));
  expect(unreacts(calls)).toEqual([`${CHANNEL}/messages/1001`, `${CHANNEL}/messages/1001`]);
  expect(sleeps).toEqual([2500]);
  expect(eyesFile()).toEqual({});
  expect(logs).toContain(`EYES_CLEARED ${CHANNEL} by=1002 1001`);
});

test("another bot writing in the channel, or any message before READY names our bot, clears nothing", async () => {
  const { listener, gw, calls, eyesFile } = setup();
  listener.start();
  await listener.onMessage(msg("1001"));
  await listener.onMessage(fromBot("1002"));
  ready(gw);
  await listener.onMessage(msg("1003", { author: { id: OTHER_BOT, bot: true }, message_reference: { message_id: "1001" } }));
  expect(unreacts(calls)).toEqual([]);
  expect(eyesFile()).toEqual({ [CHANNEL]: ["1001"] });
});

test("rows other listeners share the inbox with, however large their ids, do not move the backfill cursor", async () => {
  const route = (req: HttpRequest) => {
    if (req.url.endsWith(`/guilds/${GUILD}/threads/active`)) return { threads: [] };
    if (req.url.includes(`/channels/${CHANNEL}/messages?after=1000`)) return [msg("1001", { guild_id: undefined })];
    return [];
  };
  const rows = [
    { id: "1000", ts: "x", channel_id: CHANNEL, scope: "channel" },
    { id: "9000000000000000001", ts: "x", channel_id: "12345", scope: "kakao" },
    { id: "2000", ts: "x", channel_id: "888", scope: "shared" },
  ];
  const { listener, gw, inbox, calls, logs } = setup(route, { inbox: rows.map((r) => `${JSON.stringify(r)}\n`).join("") });
  listener.start();
  gw.push({ op: 0, s: 1, t: "READY", d: {} });
  await listener.settled();
  expect(calls().filter((c) => c.includes("/messages?"))).toEqual([`GET /channels/${CHANNEL}/messages?after=1000&limit=100`, `GET /channels/${DM}/messages?after=0&limit=100`]);
  expect(inbox().map((r) => r.id)).toEqual(["1000", "9000000000000000001", "2000", "1001"]);
  expect(logs).toContain("DISCORD_BACKFILL since=1000 added=1");
});

const PAIR = "110000000000000011";
const PAIR_BOT = "120000000000000012";

test("in the pair channel the owner's messages are pair rows with the eyes reaction and the paired Dori's bot's are pair-bot rows without it; other bots are skipped", async () => {
  const { listener, inbox, calls } = setup(() => ({}), { pairChannel: PAIR, pairBots: [PAIR_BOT] });
  await listener.onMessage(msg("1001", { channel_id: PAIR }));
  await listener.onMessage(msg("1002", { channel_id: PAIR, author: { id: PAIR_BOT, bot: true } }));
  await listener.onMessage(msg("1003", { channel_id: PAIR, author: { id: OTHER_BOT, bot: true } }));
  await listener.onMessage(msg("1004", { author: { id: PAIR_BOT, bot: true } }));
  expect(inbox().map((r) => [r.id, r.scope, r.author_id])).toEqual([["1001", "pair", OWNER], ["1002", "pair-bot", PAIR_BOT]]);
  expect(calls()).toEqual([`PUT /channels/${PAIR}/messages/1001/reactions/%F0%9F%91%80/@me`]);
});

test("a pair-bot post written as plain sentences without a [REPORT] head is still a pair-bot row with its text (owner Q304)", async () => {
  const { listener, inbox } = setup(() => ({}), { pairChannel: PAIR, pairBots: [PAIR_BOT] });
  const text = "짱돌, 신청서 두 개 고친 판으로 드라이브에 다시 올렸어(md5 27a71993…). 남은 건 형 결재뿐이야.";
  await listener.onMessage(msg("2001", { channel_id: PAIR, author: { id: PAIR_BOT, bot: true }, content: text }));
  expect(inbox().map((r) => [r.id, r.scope, r.content])).toEqual([["2001", "pair-bot", text]]);
});

test("without a pair channel set, a channel that is not the Dori's or under it is skipped", async () => {
  const { listener, inbox } = setup((req) => (req.url.endsWith(`/channels/${PAIR}`) ? { parent_id: "777" } : {}));
  await listener.onMessage(msg("1001", { channel_id: PAIR }));
  expect(inbox()).toEqual([]);
});

test("two listed pair bots become pair-bot rows without eyes while a third bot is skipped", async () => {
  const secondBot = "150000000000000015";
  const { listener, inbox, calls } = setup(() => ({}), { pairChannel: PAIR, pairBots: [PAIR_BOT, secondBot] });
  await listener.onMessage(msg("1001", { channel_id: PAIR, author: { id: PAIR_BOT, bot: true } }));
  await listener.onMessage(msg("1002", { channel_id: PAIR, author: { id: secondBot, bot: true } }));
  await listener.onMessage(msg("1003", { channel_id: PAIR, author: { id: OTHER_BOT, bot: true } }));
  expect(inbox().map((r) => [r.id, r.scope, r.author_id])).toEqual([["1001", "pair-bot", PAIR_BOT], ["1002", "pair-bot", secondBot]]);
  expect(calls()).toEqual([]);
});

// owner 2026-11-03 09:58 KST: a Dori that read the owner's pair message and does not answer it takes its eyes off at once
const NAMES = ["짱돌", "ZzangDori"];
const pairBot = (id: string, patch: Partial<DiscordMessage> = {}) => msg(id, { channel_id: PAIR, author: { id: PAIR_BOT, bot: true }, ...patch });

test("another Dori's reply to an owner pair message that did not call this Dori takes our eyes off it, and only ours", async () => {
  const { listener, gw, inbox, calls, eyesFile, logs } = setup(() => ({}), { pairChannel: PAIR, pairBots: [PAIR_BOT], callNames: NAMES });
  listener.start();
  ready(gw);
  await listener.onMessage(msg("2001", { channel_id: PAIR, content: "수돌아 이거 해" }));
  await listener.onMessage(msg("2002", { channel_id: PAIR, content: "무돌아 이것도" }));
  expect(inbox().map((r) => [r.id, r.called, r.note])).toEqual([["2001", false, expect.stringContaining("dori eyes off 2001")], ["2002", false, expect.stringContaining("dori eyes off 2002")]]);
  await listener.onMessage(pairBot("2003", { message_reference: { message_id: "2001" }, referenced_message: { author: { id: OWNER } } }));
  expect(unreacts(calls)).toEqual([`${PAIR}/messages/2001`]);
  expect(eyesFile()).toEqual({ [PAIR]: ["2002"] });
  expect(logs).toContain(`EYES_CLEARED_ANSWERED ${PAIR} by=2003 bot=${PAIR_BOT} 2001`);
  // a link to the owner's message in another Dori's post counts as its answer too
  await listener.onMessage(pairBot("2004", { content: `내가 할게 https://discord.com/channels/${GUILD}/${PAIR}/2002` }));
  expect(unreacts(calls)).toEqual([`${PAIR}/messages/2001`, `${PAIR}/messages/2002`]);
  expect(eyesFile()).toEqual({});
});

test("an owner pair message that names this Dori, in text or voice, mentions its bot or replies to its post keeps our eyes when another Dori answers", async () => {
  const transcribe = async () => "짱돌아 이것좀 봐";
  const { listener, gw, inbox, calls, eyesFile } = setup(() => ({}), { pairChannel: PAIR, pairBots: [PAIR_BOT], callNames: NAMES, transcribe });
  listener.start();
  ready(gw);
  await listener.onMessage(msg("3001", { channel_id: PAIR, content: "짱돌이랑 수돌이 둘 다" }));
  await listener.onMessage(msg("3002", { channel_id: PAIR, content: "zzangdori, check" }));
  await listener.onMessage(msg("3003", { channel_id: PAIR, content: "너 이거", mentions: [{ id: SELF }] }));
  await listener.onMessage(msg("3004", { channel_id: PAIR, content: "그거 맞아", message_reference: { message_id: "2999" }, referenced_message: { author: { id: SELF } } }));
  await listener.onMessage(msg("3005", { channel_id: PAIR, content: "", attachments: [{ url: "https://cdn/v.ogg", filename: "voice-message.ogg", content_type: "audio/ogg" }] }));
  expect(inbox().map((r) => [r.id, r.called, r.note])).toEqual(["3001", "3002", "3003", "3004", "3005"].map((id) => [id, true, undefined]));
  for (const [i, id] of ["3001", "3002", "3003", "3004", "3005"].entries()) await listener.onMessage(pairBot(`310${i}`, { message_reference: { message_id: id } }));
  expect(unreacts(calls)).toEqual([]);
  expect(eyesFile()).toEqual({ [PAIR]: ["3001", "3002", "3003", "3004", "3005"] });
});

test("a reply from a bot that is not a paired Dori, or any reply while discord.callNames is empty, leaves the eyes on", async () => {
  const named = setup(() => ({}), { pairChannel: PAIR, pairBots: [PAIR_BOT], callNames: NAMES });
  named.listener.start();
  ready(named.gw);
  await named.listener.onMessage(msg("4001", { channel_id: PAIR, content: "수돌아" }));
  await named.listener.onMessage(msg("4002", { channel_id: PAIR, author: { id: OTHER_BOT, bot: true }, message_reference: { message_id: "4001" } }));
  expect(unreacts(named.calls)).toEqual([]);
  const unnamed = setup(() => ({}), { pairChannel: PAIR, pairBots: [PAIR_BOT] });
  unnamed.listener.start();
  ready(unnamed.gw);
  await unnamed.listener.onMessage(msg("4001", { channel_id: PAIR, content: "수돌아" }));
  await unnamed.listener.onMessage(pairBot("4003", { message_reference: { message_id: "4001" } }));
  expect(unreacts(unnamed.calls)).toEqual([]);
  // the lead is still told how to take them off itself; no called flag is written without names to judge by
  expect(unnamed.inbox().filter((r) => r.scope === "pair").map((r) => [r.id, r.called, r.note])).toEqual([["4001", undefined, expect.stringContaining("dori eyes off 4001")]]);
});

test("after a restart another Dori's answer still clears an uncalled message, while a pair row written before callNames keeps its eyes", async () => {
  const rows = [{ id: "5001", ts: "x", channel_id: PAIR, scope: "pair", author_id: OWNER }, { id: "5002", ts: "x", channel_id: PAIR, scope: "pair", author_id: OWNER, called: false }];
  const { restart, gw, calls, eyesPath } = setup(() => ({}), { pairChannel: PAIR, pairBots: [PAIR_BOT], callNames: NAMES, inbox: rows.map((r) => `${JSON.stringify(r)}\n`).join("") });
  writeFileSync(eyesPath, JSON.stringify({ [PAIR]: ["5001", "5002"] }));
  const listener = restart();
  listener.start();
  ready(gw);
  await listener.onMessage(pairBot("5003", { message_reference: { message_id: "5001" } }));
  await listener.onMessage(pairBot("5004", { message_reference: { message_id: "5002" } }));
  expect(unreacts(calls)).toEqual([`${PAIR}/messages/5002`]);
});

test("dori eyes off takes only this bot's eyes off one message, by link or by an id eyes.json tracks, never writes eyes.json, and refuses anything else", async () => {
  const { listener, dc, calls, eyesPath, eyesFile } = setup(() => ({}), { pairChannel: PAIR, pairBots: [PAIR_BOT] });
  await listener.onMessage(msg("6001", { channel_id: PAIR }));
  expect(await eyesOff(dc, eyesPath, "600000000000009", "").catch((e: Error) => e.message)).toContain("is not in");
  expect(await eyesOff(dc, eyesPath, `https://discord.com/channels/${GUILD}/${PAIR}/6001`, "")).toBe(`EYES_OFF ${PAIR} 6001`);
  writeFileSync(eyesPath, JSON.stringify({ [PAIR]: ["600200000000000002"] }));
  expect(await eyesOff(dc, eyesPath, "600200000000000002", "")).toBe(`EYES_OFF ${PAIR} 600200000000000002`);
  expect(await eyesOff(dc, eyesPath, "not-an-id", PAIR).catch((e: Error) => e.message)).toContain("needs a message id");
  expect(unreacts(calls)).toEqual([`${PAIR}/messages/6001`, `${PAIR}/messages/600200000000000002`]);
  expect(eyesFile()).toEqual({ [PAIR]: ["600200000000000002"] });
});

test("while the listener records another owner message during a manual removal, that message stays tracked after a restart", async () => {
  let release = (): void => {};
  const gate = (req: HttpRequest) => (req.method === "DELETE" ? new Promise<void>((r) => { release = r; }) : undefined);
  const { listener, restart, dc, eyesPath } = setup(() => ({}), { pairChannel: PAIR, pairBots: [PAIR_BOT], gate });
  await listener.onMessage(msg("6101", { channel_id: PAIR }));
  const off = eyesOff(dc, eyesPath, `https://discord.com/channels/${GUILD}/${PAIR}/6101`, "");
  await listener.onMessage(msg("6102", { channel_id: PAIR }));
  release();
  await off;
  restart();
  expect(JSON.parse(readFileSync(eyesPath, "utf8"))[PAIR]).toContain("6102");
});

test("another Dori's reply that comes while the owner's voice note is still being transcribed clears it once its row is written uncalled", async () => {
  let finish = (_: string): void => {};
  const text = new Promise<string>((r) => { finish = r; });
  const transcribe = () => text;
  const { listener, gw, calls, logs } = setup(() => ({}), { pairChannel: PAIR, pairBots: [PAIR_BOT], callNames: NAMES, transcribe });
  listener.start();
  ready(gw);
  const owner = listener.onMessage(msg("7001", { channel_id: PAIR, content: "", attachments: [{ url: "https://cdn/v.ogg", filename: "voice-message.ogg", content_type: "audio/ogg" }] }));
  const reply = listener.onMessage(pairBot("7002", { message_reference: { message_id: "7001" } }));
  finish("수돌아 이거 봐");
  await Promise.all([owner, reply]);
  expect(unreacts(calls)).toEqual([`${PAIR}/messages/7001`]);
  expect(logs).toContain(`EYES_CLEARED_ANSWERED ${PAIR} by=7002 bot=${PAIR_BOT} 7001`);
});

test("another Dori's reply that comes before the owner's message is taken in (backfill brings it later) still clears it once it is uncalled, also across a restart", async () => {
  const { listener, gw, calls, logs } = setup(() => ({}), { pairChannel: PAIR, pairBots: [PAIR_BOT], callNames: NAMES });
  listener.start();
  ready(gw);
  await listener.onMessage(pairBot("9002", { message_reference: { message_id: "9001" } }));
  expect(unreacts(calls)).toEqual([]);
  await listener.onMessage(msg("9001", { channel_id: PAIR, content: "수돌아 이거" }));
  expect(unreacts(calls)).toEqual([`${PAIR}/messages/9001`]);
  expect(logs).toContain(`EYES_CLEARED_ANSWERED ${PAIR} by=9002 bot=${PAIR_BOT} 9001`);
  const rows = [{ id: "9102", ts: "x", channel_id: PAIR, scope: "pair-bot", author_id: PAIR_BOT, reply_to: "9101", content: "" }];
  const later = setup(() => ({}), { pairChannel: PAIR, pairBots: [PAIR_BOT], callNames: NAMES, inbox: rows.map((r) => `${JSON.stringify(r)}\n`).join("") });
  later.listener.start();
  ready(later.gw);
  await later.listener.onMessage(msg("9101", { channel_id: PAIR, content: "무돌아" }));
  expect(unreacts(later.calls)).toEqual([`${PAIR}/messages/9101`]);
});

test("eyes still on a message that was already uncalled and answered when the listener stopped come off at start, with no new message", async () => {
  const rows = [
    { id: "9301", ts: "x", channel_id: PAIR, scope: "pair", author_id: OWNER, called: false },
    { id: "9302", ts: "x", channel_id: PAIR, scope: "pair-bot", author_id: PAIR_BOT, reply_to: "9301", content: "" },
    { id: "9303", ts: "x", channel_id: PAIR, scope: "pair", author_id: OWNER, called: false },
  ];
  const { restart, calls, eyesPath, logs } = setup(() => ({}), { pairChannel: PAIR, pairBots: [PAIR_BOT], callNames: NAMES, inbox: rows.map((r) => `${JSON.stringify(r)}\n`).join("") });
  writeFileSync(eyesPath, JSON.stringify({ [PAIR]: ["9301", "9303"] }));
  const listener = restart();
  listener.start();
  await listener.settled();
  expect(unreacts(calls)).toEqual([`${PAIR}/messages/9301`]);
  expect(logs).toContain(`EYES_CLEARED_ANSWERED ${PAIR} by=9302 bot=${PAIR_BOT} 9301`);
});

test("an owner voice note whose text calls this Dori by name is called even when its transcript does not name it", async () => {
  const transcribe = async () => "이 녹음 내용 확인";
  const { listener, gw, inbox, calls } = setup(() => ({}), { pairChannel: PAIR, pairBots: [PAIR_BOT], callNames: NAMES, transcribe });
  listener.start();
  ready(gw);
  await listener.onMessage(msg("9401", { channel_id: PAIR, content: "짱돌아 이 녹음 확인해", attachments: [{ url: "https://cdn/v.ogg", filename: "voice-message.ogg", content_type: "audio/ogg" }] }));
  await listener.onMessage(pairBot("9402", { message_reference: { message_id: "9401" } }));
  expect(inbox().find((r) => r.id === "9401")?.called).toBe(true);
  expect(unreacts(calls)).toEqual([]);
});

test("an owner voice note in the pair channel whose words did not come through is not uncalled: no transcriber, a failed or an empty transcript", async () => {
  const voice = { content: "", attachments: [{ url: "https://cdn/v.ogg", filename: "voice-message.ogg", content_type: "audio/ogg" }] };
  for (const transcribe of [undefined, async () => { throw new Error("whisper down"); }, async () => "  "]) {
    const { listener, gw, inbox, calls } = setup(() => ({}), { pairChannel: PAIR, pairBots: [PAIR_BOT], callNames: NAMES, ...(transcribe ? { transcribe } : {}) });
    listener.start();
    ready(gw);
    await listener.onMessage(msg("9201", { channel_id: PAIR, ...voice }));
    await listener.onMessage(pairBot("9202", { message_reference: { message_id: "9201" } }));
    expect(inbox().find((r) => r.id === "9201")?.called).toBeUndefined();
    expect(unreacts(calls)).toEqual([]);
  }
});

test("an owner pair message mentioning one of this bot's roles is called once the roles are read; while they cannot be read it is not uncalled", async () => {
  const ROLE = "130000000000000013";
  const members = (req: HttpRequest) => (req.url.endsWith(`/guilds/${GUILD}/members/${SELF}`) ? { roles: [ROLE] } : {});
  const ok = setup(members, { pairChannel: PAIR, pairBots: [PAIR_BOT], callNames: NAMES });
  ok.listener.start();
  ready(ok.gw);
  await ok.listener.onMessage(msg("8001", { channel_id: PAIR, content: "이거 봐", mention_roles: [ROLE] }));
  await ok.listener.onMessage(pairBot("8002", { message_reference: { message_id: "8001" } }));
  expect(ok.inbox().find((r) => r.id === "8001")?.called).toBe(true);
  expect(unreacts(ok.calls)).toEqual([]);
  const respond = (req: HttpRequest): HttpResponse | undefined => (req.url.includes("/members/") ? { status: 500, headers: {}, body: "{}" } : undefined);
  const failed = setup(() => ({}), { pairChannel: PAIR, pairBots: [PAIR_BOT], callNames: NAMES, respond });
  failed.listener.start();
  ready(failed.gw);
  await failed.listener.onMessage(msg("8003", { channel_id: PAIR, content: "이거 봐", mention_roles: [ROLE] }));
  await failed.listener.onMessage(pairBot("8004", { message_reference: { message_id: "8003" } }));
  expect(failed.inbox().find((r) => r.id === "8003")?.called).toBeUndefined();
  expect(unreacts(failed.calls)).toEqual([]);
  // a message that comes while READY's role read is still on its way waits for it
  let release = (): void => {};
  const held = new Promise<void>((r) => { release = r; });
  const gate = (req: HttpRequest) => (req.url.includes("/members/") ? held : undefined);
  // the read is let go only when the owner's message is about to be judged (its ledger hints are read just before)
  const hints = () => (release(), []);
  const pending = setup(members, { pairChannel: PAIR, pairBots: [PAIR_BOT], callNames: NAMES, gate, hints });
  pending.listener.start();
  ready(pending.gw);
  await pending.listener.onMessage(msg("8005", { channel_id: PAIR, content: "이거 봐", mention_roles: [ROLE] }));
  expect(pending.inbox().find((r) => r.id === "8005")?.called).toBe(true);
});

test("backfill reads the pair channel too, after the newest pair row", async () => {
  const route = (req: HttpRequest) => {
    if (req.url.endsWith(`/guilds/${GUILD}/threads/active`)) return { threads: [] };
    if (req.url.includes(`/channels/${PAIR}/messages?after=1500`)) return [msg("1601", { channel_id: PAIR, guild_id: undefined, author: { id: PAIR_BOT, bot: true } })];
    return [];
  };
  const rows = [{ id: "1000", ts: "x", channel_id: CHANNEL, scope: "channel" }, { id: "1500", ts: "x", channel_id: PAIR, scope: "pair-bot" }];
  const { listener, gw, inbox, calls } = setup(route, { pairChannel: PAIR, pairBots: [PAIR_BOT], inbox: rows.map((r) => `${JSON.stringify(r)}\n`).join("") });
  listener.start();
  gw.push({ op: 0, s: 1, t: "READY", d: {} });
  await listener.settled();
  expect(calls().filter((c) => c.includes("/messages?"))).toEqual([`GET /channels/${CHANNEL}/messages?after=1000&limit=100`, `GET /channels/${PAIR}/messages?after=1500&limit=100`, `GET /channels/${DM}/messages?after=0&limit=100`]);
  expect(inbox().map((r) => [r.id, r.scope])).toEqual([["1000", "channel"], ["1500", "pair-bot"], ["1601", "pair-bot"]]);
});

const NOTIFY = "130000000000000013";
const MONITOR_BOT = "140000000000000014";
const ALERT = "**📊 [doctor 연결·동작 점검]**\n> 새로 확인된 문제 1건:\n> - 확인 · 정기 작업(워처): 최근 실패·중지: calendar-confirm-watch";

test("in a watched channel the monitoring bot's problem alert is a watch row with a link and no eyes; recoveries, other bots and other channels are skipped", async () => {
  const { listener, inbox, calls, logs } = setup(() => ({}), { watchChannels: [NOTIFY], watchBots: [MONITOR_BOT] });
  const bot = { id: MONITOR_BOT, bot: true };
  await listener.onMessage(msg("1001", { channel_id: NOTIFY, author: bot, content: ALERT }));
  await listener.onMessage(msg("1002", { channel_id: NOTIFY, author: bot, content: "사실: 신규 실패: 없음; 회복: embedding" }));
  await listener.onMessage(msg("1003", { channel_id: NOTIFY, author: bot, content: "사실: 신규 실패: rag embedding" }));
  await listener.onMessage(msg("1004", { channel_id: NOTIFY, author: { id: OTHER_BOT, bot: true }, content: ALERT }));
  await listener.onMessage(msg("1005", { author: bot, content: ALERT }));
  expect(inbox().map((r) => [r.id, r.scope, r.author_id])).toEqual([["1001", "watch", MONITOR_BOT], ["1003", "watch", MONITOR_BOT]]);
  expect(inbox()[0]?.link).toBe(`https://discord.com/channels/${GUILD}/${NOTIFY}/1001`);
  expect(inbox()[0]?.note).toContain("do not post in the watched channel");
  expect(calls()).toEqual([]);
  expect(logs.filter((l) => l.startsWith("INBOUND discord-watch"))).toHaveLength(2);
});

test("a watch match from the settings replaces the default one, and without watch bots the channel is skipped", async () => {
  const custom = setup(() => ({}), { watchChannels: [NOTIFY], watchBots: [MONITOR_BOT], watchMatch: /FAILED/ });
  await custom.listener.onMessage(msg("1001", { channel_id: NOTIFY, author: { id: MONITOR_BOT, bot: true }, content: ALERT }));
  await custom.listener.onMessage(msg("1002", { channel_id: NOTIFY, author: { id: MONITOR_BOT, bot: true }, content: "job FAILED" }));
  expect(custom.inbox().map((r) => r.id)).toEqual(["1002"]);
  const noBots = setup((req) => (req.url.endsWith(`/channels/${NOTIFY}`) ? { parent_id: "777" } : {}), { watchChannels: [NOTIFY] });
  await noBots.listener.onMessage(msg("1003", { channel_id: NOTIFY, author: { id: MONITOR_BOT, bot: true }, content: ALERT }));
  expect(noBots.inbox()).toEqual([]);
});

test("backfill reads the watched channels too, after the newest own row", async () => {
  const route = (req: HttpRequest) => {
    if (req.url.endsWith(`/guilds/${GUILD}/threads/active`)) return { threads: [] };
    if (req.url.includes(`/channels/${NOTIFY}/messages?after=1500`)) return [msg("1601", { channel_id: NOTIFY, guild_id: undefined, author: { id: MONITOR_BOT, bot: true }, content: ALERT })];
    return [];
  };
  const rows = [{ id: "1500", ts: "x", channel_id: NOTIFY, scope: "watch" }];
  const { listener, gw, inbox, calls } = setup(route, { watchChannels: [NOTIFY], watchBots: [MONITOR_BOT], inbox: rows.map((r) => `${JSON.stringify(r)}\n`).join("") });
  listener.start();
  gw.push({ op: 0, s: 1, t: "READY", d: {} });
  await listener.settled();
  expect(calls().filter((c) => c.includes("/messages?"))).toEqual([`GET /channels/${CHANNEL}/messages?after=0&limit=100`, `GET /channels/${NOTIFY}/messages?after=1500&limit=100`, `GET /channels/${DM}/messages?after=0&limit=100`]);
  expect(inbox().map((r) => [r.id, r.scope])).toEqual([["1500", "watch"], ["1601", "watch"]]);
});

test("a deleted watched channel drops its cursor with one log line, is not asked again, and the other channels are still scanned", async () => {
  const route = (req: HttpRequest) => (req.url.endsWith(`/guilds/${GUILD}/threads/active`) ? { threads: [] } : []);
  const respond = (req: HttpRequest): HttpResponse | undefined =>
    req.url.includes(`/channels/${NOTIFY}/messages?`) ? { status: 404, headers: {}, body: '{"message": "Unknown Channel", "code": 10003}' } : undefined;
  const rows = [{ id: "1500", ts: "x", channel_id: NOTIFY, scope: "watch" }];
  const { listener, inbox, calls, logs } = setup(route, { respond, watchChannels: [NOTIFY], watchBots: [MONITOR_BOT], inbox: rows.map((r) => `${JSON.stringify(r)}\n`).join("") });
  await listener.backfill();
  await listener.backfill();
  expect(calls().filter((c) => c.includes(`/channels/${NOTIFY}/messages?`))).toHaveLength(1);
  expect(calls().filter((c) => c === `GET /channels/${DM}/messages?after=0&limit=100`)).toHaveLength(2);
  expect(logs.filter((l) => l.startsWith(`DISCORD_BACKFILL_GONE channel=${NOTIFY}`))).toHaveLength(1);
  expect(NOTIFY in JSON.parse(readFileSync(`${state.dir}/discord/backfill.json`, "utf8"))).toBe(false);
  expect(inbox().map((r) => r.id)).toEqual(["1500"]);
});

test("a 404 that is not Unknown Channel still fails the scan and keeps the cursor", async () => {
  const respond = (req: HttpRequest): HttpResponse | undefined =>
    req.url.includes(`/channels/${NOTIFY}/messages?`) ? { status: 404, headers: {}, body: '{"message": "Unknown Message", "code": 10008}' } : undefined;
  const route = (req: HttpRequest) => (req.url.endsWith(`/guilds/${GUILD}/threads/active`) ? { threads: [] } : []);
  const { listener, logs } = setup(route, { respond, watchChannels: [NOTIFY], watchBots: [MONITOR_BOT] });
  await expect(listener.backfill()).rejects.toThrow("404");
  expect(logs.some((l) => l.startsWith("DISCORD_BACKFILL_GONE"))).toBe(false);
});

// a thread under a channel this Dori does not own (another agent's), and this Dori's bot member with its managed role
const AGENT_CHAT = "800000000000000008";
const AGENT_THREAD = "810000000000000081";
const MY_ROLE = "900000000000000009";
const OTHER_ROLE = "910000000000000091";
const elsewhere = (req: HttpRequest) =>
  req.url.endsWith(`/channels/${AGENT_THREAD}`) ? { id: AGENT_THREAD, parent_id: AGENT_CHAT, type: 11 } : req.url.endsWith(`/guilds/${GUILD}/members/${SELF}`) ? { roles: [MY_ROLE] } : { parent_id: "777" };
const eyesOn = (calls: () => string[]) => calls().filter((c) => c.startsWith("PUT"));

test("the owner mentioning this Dori's role in a thread of another channel is a mention row with a link and the eyes; the role comes from the bot member at READY", async () => {
  const { listener, gw, inbox, calls, logs } = setup(elsewhere);
  listener.start();
  ready(gw);
  await listener.settled();
  expect(logs).toContain(`DISCORD_MENTION_IDS user=${SELF} roles=${MY_ROLE}`);
  await listener.onMessage(msg("1001", { channel_id: AGENT_THREAD, content: `<@&${MY_ROLE}> review this`, mentions: [], mention_roles: [MY_ROLE] }));
  expect(inbox()).toMatchObject([{ id: "1001", channel_id: AGENT_THREAD, scope: "mention", author_id: OWNER, content: `<@&${MY_ROLE}> review this`, link: `https://discord.com/channels/${GUILD}/${AGENT_THREAD}/1001` }]);
  expect(eyesOn(calls)).toEqual([`PUT /channels/${AGENT_THREAD}/messages/1001/reactions/%F0%9F%91%80/@me`]);
  expect(logs.some((l) => l.startsWith(`INBOUND discord-mention ${AGENT_THREAD} 1001 ${OWNER}`))).toBe(true);
});

test("a mention of this Dori's bot user, or of a role set in discord.mentionRoleIds, counts in any channel too", async () => {
  const { listener, gw, inbox } = setup(elsewhere, { mentionRoleIds: ["920000000000000092"] });
  listener.start();
  ready(gw);
  await listener.settled();
  await listener.onMessage(msg("1001", { channel_id: "888", content: `<@${SELF}> look`, mentions: [{ id: SELF }] }));
  await listener.onMessage(msg("1002", { channel_id: "888", content: "<@&920000000000000092> look", mention_roles: ["920000000000000092"] }));
  expect(inbox().map((r) => [r.id, r.scope])).toEqual([["1001", "mention"], ["1002", "mention"]]);
});

test("outside its own channel, an owner message that does not call this Dori, or someone else calling it, is skipped with no eyes", async () => {
  const { listener, gw, inbox, calls } = setup(elsewhere);
  listener.start();
  ready(gw);
  await listener.settled();
  await listener.onMessage(msg("1001", { channel_id: AGENT_THREAD, content: "just talking here", mentions: [], mention_roles: [] }));
  await listener.onMessage(msg("1002", { channel_id: AGENT_THREAD, author: { id: "555" }, mention_roles: [MY_ROLE] }));
  await listener.onMessage(msg("1003", { channel_id: AGENT_THREAD, author: { id: OTHER_BOT, bot: true }, mentions: [{ id: SELF }] }));
  expect(inbox()).toEqual([]);
  expect(eyesOn(calls)).toEqual([]);
});

test("the owner calling the other Dori (its bot or its role) is not this Dori's mention", async () => {
  const { listener, gw, inbox, calls } = setup(elsewhere);
  listener.start();
  ready(gw);
  await listener.settled();
  await listener.onMessage(msg("1001", { channel_id: AGENT_THREAD, content: `<@&${OTHER_ROLE}> you`, mention_roles: [OTHER_ROLE] }));
  await listener.onMessage(msg("1002", { channel_id: AGENT_THREAD, content: `<@${OTHER_BOT}> you`, mentions: [{ id: OTHER_BOT }] }));
  expect(inbox()).toEqual([]);
  expect(eyesOn(calls)).toEqual([]);
});

test("a role mention that comes while the bot's roles are still being read waits for them", async () => {
  let release = () => {};
  const held = new Promise<void>((r) => { release = r; });
  const { listener, gw, inbox } = setup(elsewhere, { gate: (req) => (req.url.includes("/members/") ? held : undefined) });
  listener.start();
  ready(gw);
  let finished = false;
  const pending = listener.onMessage(msg("1001", { channel_id: AGENT_THREAD, mention_roles: [MY_ROLE] })).then(() => { finished = true; });
  // a macrotask turn runs every queued microtask: the fake Discord does no I/O, so only the held read can still be pending
  await new Promise((r) => setImmediate(r));
  expect([finished, inbox()]).toEqual([false, []]);
  release();
  await pending;
  expect(inbox().map((r) => [r.id, r.scope])).toEqual([["1001", "mention"]]);
});

test("a failed read of the bot's roles is tried again by the next mention, and each READY reads them afresh", async () => {
  let roles: string[] | null = null;
  const respond = (req: HttpRequest): HttpResponse | undefined => (req.url.includes("/members/") && !roles ? { status: 500, headers: {}, body: "{}" } : undefined);
  const { listener, gw, inbox, logs } = setup((req) => (req.url.includes("/members/") ? { roles } : elsewhere(req)), { respond });
  listener.start();
  ready(gw);
  await listener.settled();
  expect(logs.some((l) => l.startsWith("DISCORD_MENTION_IDS_FAIL"))).toBe(true);
  roles = [MY_ROLE];
  await listener.onMessage(msg("1001", { channel_id: AGENT_THREAD, mention_roles: [MY_ROLE] }));
  roles = [OTHER_ROLE];
  ready(gw);
  await listener.settled();
  await listener.onMessage(msg("1002", { channel_id: AGENT_THREAD, mention_roles: [MY_ROLE] }));
  expect(inbox().map((r) => [r.id, r.scope])).toEqual([["1001", "mention"]]);
});

test("a mention in a channel the bot cannot look up still lands; the failed lookup is logged", async () => {
  const respond = (req: HttpRequest): HttpResponse | undefined => (req.url.endsWith(`/channels/${AGENT_THREAD}`) ? { status: 403, headers: {}, body: "{}" } : undefined);
  const { listener, gw, inbox, logs } = setup(elsewhere, { respond });
  listener.start();
  ready(gw);
  await listener.settled();
  await listener.onMessage(msg("1001", { channel_id: AGENT_THREAD, mention_roles: [MY_ROLE] }));
  expect(inbox().map((r) => [r.id, r.scope])).toEqual([["1001", "mention"]]);
  expect(logs.some((l) => l.startsWith(`DISCORD_PARENT_FAIL ${AGENT_THREAD}`))).toBe(true);
});

test("our bot posting a link to a mention elsewhere takes the eyes off it there", async () => {
  const { listener, gw, calls, eyesFile } = setup(elsewhere);
  listener.start();
  ready(gw);
  await listener.settled();
  await listener.onMessage(msg("1001", { channel_id: AGENT_THREAD, mention_roles: [MY_ROLE] }));
  await listener.onMessage(fromBot("1002", { content: `on it: https://discord.com/channels/${GUILD}/${AGENT_THREAD}/1001` }));
  expect(unreacts(calls)).toEqual([`${AGENT_THREAD}/messages/1001`]);
  expect(eyesFile()).toEqual({});
});

test("a shadow listener writes the same inbox row but never writes to Discord: no eyes, no reopen, no card answer, no unreact", async () => {
  const { listener, gw, inbox, seen, logs } = setup((req) => (req.url.endsWith(`/channels/${THREAD}`) ? { parent_id: CHANNEL, name: "✅ fix login", type: 11, thread_metadata: { archived: true } } : {}), { shadow: true });
  listener.start();
  ready(gw);
  await listener.onMessage(msg("1001"));
  await listener.onMessage(msg("1002", { channel_id: THREAD }));
  await listener.onMessage(fromBot("1003", { message_reference: { message_id: "1001" } }));
  await listener.onInteraction({ id: "5001", token: "tok", type: 3, channel_id: CHANNEL, member: { user: { id: OWNER } }, data: { custom_id: "q:Q1:0" } });
  expect(inbox()).toEqual([
    { ts: "2026-01-02T03:00:00Z", id: "1001", channel_id: CHANNEL, scope: "channel", author_id: OWNER, content: "hello 1001", transcript: null, attachments: [], reply_to: null },
    { ts: "2026-01-02T03:00:00Z", id: "1002", channel_id: THREAD, scope: "thread", author_id: OWNER, content: "hello 1002", transcript: null, attachments: [], reply_to: null },
  ]);
  expect(seen.filter((r) => r.method !== "GET")).toEqual([]);
  expect(existsSync(`${state.dir}/discord/eyes.json`)).toBe(false);
  expect(logs).toContain("DISCORD_LISTENER_READY shadow");
  expect(logs).toContain("SHADOW_INTERACTION_SKIPPED 5001 q:Q1:0");
});

test("a shadow listener writes the answer row the live one would for a tap or a typed answer, without answering Discord or touching the card store", async () => {
  const { listener, cards, inbox, seen } = setup(() => ({}), { shadow: true });
  const q = cards.store.create("Ship?", ["Yes", "No"], THREAD, { thread: THREAD, session: "sess-1", tmux: "aoe_demo_1234abcd" }, "2026-01-02T03:00:00Z");
  cards.store.answer(q.id, "No", "button", "2026-01-02T03:03:59Z");
  const before = JSON.stringify(cards.store.all());
  const tap = (id: string, custom_id: string, user = OWNER, components?: unknown[]) => listener.onInteraction({ id, token: "tok", type: custom_id.startsWith("m:") ? 5 : 3, channel_id: THREAD, member: { user: { id: user } }, data: { custom_id, ...(components ? { components } : {}) } });
  await tap("5001", "q:Q1:1");
  await tap("5002", "q:Q1:other");
  await tap("5003", "m:Q1", OWNER, [{ type: 1, components: [{ type: 4, custom_id: "answer", value: " next week " }] }]);
  await tap("5004", "q:Q1:0", "555");
  expect(inbox()).toEqual([
    { ts: "2026-01-02T03:04:00.000Z", id: "5001", kind: "answer", qid: "Q1", answer: "No", answer_kind: "button", question: "Ship?", thread: THREAD, session: "sess-1", tmux: "aoe_demo_1234abcd" },
    { ts: "2026-01-02T03:04:00.000Z", id: "5003", kind: "answer", qid: "Q1", answer: "next week", answer_kind: "text", question: "Ship?", thread: THREAD, session: "sess-1", tmux: "aoe_demo_1234abcd" },
  ]);
  expect(seen).toEqual([]);
  expect(JSON.stringify(cards.store.all())).toBe(before);
});

test("a dropped connection reconnects with growing backoff; a rejected token or intent stops the listener", () => {
  const { listener, gw, t, fatal, logs } = setup();
  listener.start();
  for (let i = 0; i < 6; i++) gw.drop(1006);
  expect(t.timeouts).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
  gw.drop(4014);
  expect(fatal).toEqual([4014]);
  expect(t.timeouts).toHaveLength(6);
  expect(logs).toContain("DISCORD_LISTENER_FATAL close=4014");
});

test("every close code Discord marks do-not-reconnect stops the listener instead of retrying", () => {
  for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) {
    const { listener, gw, t, fatal } = setup();
    listener.start();
    gw.drop(code);
    expect(fatal).toEqual([code]);
    expect(t.timeouts).toEqual([]);
  }
});

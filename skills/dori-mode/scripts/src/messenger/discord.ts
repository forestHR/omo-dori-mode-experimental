import type { Clock } from "../run.ts";
import { DEFAULT_RETRY, guardText, type Http, MessengerError, type RetryPolicy, withBackoff } from "./http.ts";
import { nameThreadLinks } from "./thread-links.ts";
import type { DiscordFile } from "./upload-files.ts";

const retryAfter = (body: string): number | undefined => {
  try {
    const n = (JSON.parse(body) as { retry_after?: number }).retry_after;
    return typeof n === "number" ? n : undefined;
  } catch {
    return undefined;
  }
};

// A bot token starts with the bot's user id in base64, up to the first dot; undefined when it does not.
export const tokenBotId = (token: string): string | undefined => {
  const id = Buffer.from(token.trim().split(".")[0] ?? "", "base64").toString("utf8");
  return /^\d{15,22}$/.test(id) ? id : undefined;
};

export class Discord {
  constructor(
    private readonly http: Http,
    private readonly clock: Clock,
    private readonly botToken: string,
    private readonly base = "https://discord.com/api/v10",
    private readonly policy: RetryPolicy = DEFAULT_RETRY,
  ) {}

  // One attempt and no waiting: a 429 comes back at once as a MessengerError carrying retry_after, for a caller
  // that schedules its own retry (a thread rename can be told to wait several minutes).
  once(): Discord {
    return new Discord(this.http, this.clock, this.botToken, this.base, { ...this.policy, attempts: 1 });
  }

  // a FormData body is multipart: fetch writes its Content-Type with the boundary
  async call<T = unknown>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: Record<string, unknown> | FormData): Promise<T> {
    const form = body instanceof FormData;
    const res = await withBackoff(this.http, this.clock, { method, url: `${this.base}${path}`, headers: { Authorization: `Bot ${this.botToken}`, ...(form ? {} : { "Content-Type": "application/json" }) }, ...(body ? { body: form ? body : JSON.stringify(body) } : {}) }, this.policy, retryAfter);
    if (res.status >= 300) {
      const header = Number(res.headers["retry-after"]);
      const wait = res.status === 429 ? (retryAfter(res.body) ?? (Number.isFinite(header) && header > 0 ? header : undefined)) : undefined;
      throw new MessengerError(`discord ${method} ${path}: ${res.status} ${res.body.slice(0, 160)}`, res.status, undefined, wait);
    }
    return (res.body ? JSON.parse(res.body) : {}) as T;
  }

  // reply: the id of a message in the same channel this one answers (shown as a Discord reply; no ping to its author)
  // files: attachments of this one message (payload_json + files[n]); with files the text may be empty
  async send(channelId: string, content: string, typing = false, ping?: string, reply?: string, files: readonly DiscordFile[] = []): Promise<string> {
    return (await this.post(channelId, content, typing, ping, reply, files)).id;
  }

  // send, with the content Discord answered the new message holds (dori send prints it: send-dedupe.ts sentLine)
  async post(channelId: string, content: string, typing = false, ping?: string, reply?: string, files: readonly DiscordFile[] = []): Promise<{ id: string; content?: string }> {
    guardText(content);
    if (ping !== undefined && (ping.length === 0 || /[^0-9]/.test(ping))) throw new MessengerError("--ping takes a digits-only user id", 400);
    if (ping !== undefined && !content.includes(`<@${ping}>`)) content = `<@${ping}> ${content}`;
    content = await this.namedLinks(content);
    if (typing) {
      await this.once().typing(channelId).catch((e: unknown) => {
        console.error(`DISCORD_TYPING_FAIL ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    const payload = { ...(content || !files.length ? { content: guardText(content) } : {}), allowed_mentions: { parse: [], ...(ping !== undefined ? { users: [ping] } : {}) }, ...(reply !== undefined ? { message_reference: { message_id: reply, fail_if_not_exists: false } } : {}) };
    const posted = (m: { id: string; content?: unknown }) => ({ id: m.id, ...(typeof m.content === "string" ? { content: m.content } : {}) });
    if (!files.length) return posted(await this.call<{ id: string; content?: unknown }>("POST", `/channels/${channelId}/messages`, payload));
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ ...payload, attachments: files.map((f, id) => ({ id, filename: f.filename })) }));
    for (const [i, f] of files.entries()) form.append(`files[${i}]`, new Blob([f.bytes], { type: f.type }), f.filename);
    return posted(await this.call<{ id: string; content?: unknown }>("POST", `/channels/${channelId}/messages`, form));
  }

  async edit(channelId: string, messageId: string, content: string): Promise<void> {
    await this.call("PATCH", `/channels/${channelId}/messages/${messageId}`, { content: guardText(await this.namedLinks(guardText(content))) });
  }

  // a thread link the owner's client has not loaded shows as "unknown"; it goes out as [name](<url>) (thread-links.ts)
  private namedLinks(content: string): Promise<string> {
    return nameThreadLinks(content, (id) => this.once().call("GET", `/channels/${id}`));
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.call("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  async unreact(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.call("DELETE", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  async typing(channelId: string): Promise<void> {
    await this.call("POST", `/channels/${channelId}/typing`);
  }

  async startThread(channelId: string, messageId: string | undefined, name: string): Promise<string> {
    const path = messageId ? `/channels/${channelId}/messages/${messageId}/threads` : `/channels/${channelId}/threads`;
    return (await this.call<{ id: string }>("POST", path, { name: guardText(name).slice(0, 100), ...(!messageId ? { type: 11, auto_archive_duration: 10080 } : {}) })).id;
  }

  async setThread(threadId: string, patch: { readonly name?: string; readonly archived?: boolean }): Promise<void> {
    await this.call("PATCH", `/channels/${threadId}`, { ...(patch.name ? { name: guardText(patch.name).slice(0, 100) } : {}), ...(patch.archived !== undefined ? { archived: patch.archived } : {}) });
  }
}

export type GatewaySocket = { send(data: string): void; close(): void; onMessage(cb: (data: string) => void): void };

export const DISCORD_INTENTS_GUILD_MESSAGES = 1 << 9;

export const discordPresence = (open: () => GatewaySocket, token: string, clock: { setInterval: (cb: () => void, ms: number) => unknown; clearInterval: (h: unknown) => void }) => {
  const ws = open();
  let seq: number | null = null;
  let beat: unknown;
  ws.onMessage((raw) => {
    const m = JSON.parse(raw) as { op: number; s?: number | null; d?: { heartbeat_interval?: number } };
    if (typeof m.s === "number") seq = m.s;
    if (m.op === 10 && m.d?.heartbeat_interval) {
      beat = clock.setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), m.d.heartbeat_interval);
      ws.send(JSON.stringify({ op: 2, d: { token, intents: DISCORD_INTENTS_GUILD_MESSAGES, properties: { os: process.platform, browser: "dori", device: "dori" }, presence: { status: "online", since: null, activities: [], afk: false } } }));
    }
  });
  return {
    close() {
      if (beat !== undefined) clock.clearInterval(beat);
      ws.close();
    },
  };
};

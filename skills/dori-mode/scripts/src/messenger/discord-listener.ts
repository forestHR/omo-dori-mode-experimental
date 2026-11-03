import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DiscordWords } from "../config.ts";
import type { Discord } from "./discord.ts";
import { type Interaction, modalValue, openCardIds, type QuestionCards } from "./discord-cards.ts";
import { isDoneName, type ThreadInfo } from "./discord-thread.ts";
import { MessengerError } from "./http.ts";
import type { Timers } from "./typing.ts";

export const EYES = "👀";
// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT (a privileged intent: turn it on in the Developer Portal)
export const LISTENER_INTENTS = 1 | (1 << 9) | (1 << 12) | (1 << 15);
// 4004 bad token, 4013/4014 invalid or disallowed intents: reconnecting cannot fix these
// Discord's close codes marked "Reconnect: false" (auth, shard, API version, intents).
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
// Short cap: a dead network fails each try at once, so a long wait only delays READY after the link is back.
const MAX_BACKOFF_MS = 10_000;

export type GatewayConnection = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: (code: number) => void): void;
};

export type ListenerTimers = Timers & { readonly setTimeout: (cb: () => void, ms: number) => unknown };

export type DiscordMessage = {
  readonly id: string;
  readonly channel_id: string;
  readonly guild_id?: string;
  readonly content: string;
  readonly timestamp: string;
  readonly author: { readonly id: string; readonly bot?: boolean; readonly username?: string };
  readonly webhook_id?: string;
  readonly attachments?: readonly Attachment[];
  readonly message_reference?: { readonly message_id?: string; readonly channel_id?: string };
  // the message a reply answers, as Discord sends it with the reply (null when it is gone)
  readonly referenced_message?: { readonly author?: { readonly id: string } } | null;
  readonly mentions?: readonly { readonly id: string }[];
  readonly mention_roles?: readonly string[];
};

export type Attachment = { readonly url: string; readonly filename: string; readonly content_type?: string };

// "owner": the owner's registered webhook posting in the Dori's channel (e.g. an iOS Shortcut voice upload).
// "unknown": a webhook post there while no owner webhook is registered; log its id so it can be registered.
// "ignore": any other webhook post. null: not a webhook post.
export function webhookVerdict(
  m: Pick<DiscordMessage, "webhook_id" | "channel_id" | "guild_id">,
  cfg: { readonly guild: string; readonly channel: string; readonly ownerWebhook: string },
): "owner" | "unknown" | "ignore" | null {
  if (!m.webhook_id) return null;
  if (m.guild_id !== cfg.guild || m.channel_id !== cfg.channel) return "ignore";
  if (!cfg.ownerWebhook) return "unknown";
  return m.webhook_id === cfg.ownerWebhook ? "owner" : "ignore";
}

const AUDIO_EXT = /\.(m4a|mp4|caf|wav|mp3|ogg|oga|opus|aac|flac|webm)$/i;

// Discord voice notes are audio/ogg; an iOS Shortcuts recording arrives as a .m4a with audio/x-m4a, audio/mp4,
// video/mp4 or no content type at all, so fall back to the file extension.
export function audioAttachment(atts: readonly Attachment[] = []): Attachment | undefined {
  return atts.find((a) => (a.content_type ?? "").startsWith("audio/") || AUDIO_EXT.test(a.filename));
}

export type InboxMessage = {
  readonly ts: string;
  readonly id: string;
  readonly channel_id: string;
  // mention: the owner called this Dori (its bot or one of its roles) in a channel or thread it does not own
  // watch: a monitoring bot's problem alert in a watched channel (information for the lead to act on, not the owner's request)
  readonly scope: "dm" | "channel" | "thread" | "pair" | "pair-bot" | "mention" | "watch";
  readonly author_id: string;
  readonly content: string;
  readonly transcript: string | null;
  readonly attachments: readonly { readonly url: string; readonly filename: string; readonly content_type: string | null }[];
  readonly reply_to: string | null;
  // unknown-webhook: a recording an unregistered webhook posted in the Dori's channel (information, not the owner's request)
  readonly via?: "owner-webhook" | "unknown-webhook";
  readonly webhook_id?: string;
  // a thread message while question cards are still open there: the owner may have answered in text, so the lead
  // resolves the card (dori resolve <Qn>); the listener never resolves it on a guess
  readonly open_cards?: readonly string[];
  readonly note?: string;
  readonly link?: string;
  // a pair row while discord.callNames is set: whether the owner called this Dori there (one of its names in his words, its
  // bot or role mentioned, or a reply to its post). Only a row with called false loses its eyes when another Dori answers it.
  readonly called?: boolean;
  // the owner's message: the directive ledger's entries it is about, one line each (tag and text), so the lead reads them
  // with the message even when no lane brief carries them; directives_error when the ledger could not be read
  readonly directives?: readonly string[];
  readonly directives_error?: string;
};

export type InboxAnswer = {
  readonly ts: string;
  readonly id: string;
  readonly kind: "answer";
  readonly qid: string;
  readonly answer: string;
  readonly answer_kind: string;
  readonly question: string;
  readonly thread: string | null;
  readonly session: string | null;
  readonly tmux: string | null;
};

export type ListenerDeps = {
  readonly dc: Discord;
  readonly cards: QuestionCards;
  readonly open: () => GatewayConnection;
  readonly token: string;
  readonly guild: string;
  readonly channel: string;
  readonly owner: string;
  // id of the owner's own webhook in the channel; its posts count as the owner's. Empty or unset: webhook posts are only logged.
  readonly ownerWebhook?: string;
  // a channel shared with other Doris: the owner's messages there are "pair" rows, bots in pairBots are "pair-bot" rows
  // (information, not requests). Unset: no pair channel.
  readonly pairChannel?: string;
  readonly pairBots?: readonly string[];
  // channels where another app posts problem alerts (e.g. a monitoring bot's notification channel, same guild): a message
  // there from one of watchBots whose text matches watchMatch (default WATCH_MATCH) is a "watch" row without eyes, for the
  // lead to act on. Other messages there are skipped. Unset or no bots: those channels are skipped like any other.
  readonly watchChannels?: readonly string[];
  readonly watchBots?: readonly string[];
  readonly watchMatch?: RegExp;
  // shadow: write inbox rows only, never to Discord (no reaction, no thread reopen, no card answers), to compare with a live listener
  readonly shadow?: boolean;
  readonly words: DiscordWords;
  readonly inboxFile: string;
  readonly timers: ListenerTimers;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly fatal: (closeCode: number) => void;
  readonly transcribe?: (url: string, filename: string) => Promise<string>;
  // the ledger lines an owner message is about (dori inbound discord: textDirectives, at most HINT_LIMIT); it may throw
  readonly hints?: (text: string) => readonly string[];
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);
// Discord's 10003 means the channel was deleted, so retrying its history can never succeed.
const unknownChannel = (e: unknown): boolean => e instanceof MessengerError && e.status === 404 && /"code":\s*10003\b/.test(e.message);
const newer = (a: string, b: string): boolean => BigInt(a) > BigInt(b);
// the inbox may be shared with other listeners (other messengers, other channels); only rows this listener writes set its cursors
const OWN_SCOPES = new Set(["dm", "channel", "thread", "pair", "pair-bot", "mention", "watch"]);
// a problem alert: a new problem found, a new failure that is not "none", or a repeated failure (Korean monitoring copy)
export const WATCH_MATCH = /새로 확인된 문제|신규 실패: (?!없음)|반복 실패/;
const WATCH_NOTE = "a problem alert another app posted in a watched channel: check what failed and why, fix it or open a lane to fix it, and tell the owner in your own channel with this link; do not post in the watched channel";
// the owner's Shortcut webhook may move to this Dori's channel without its id being registered: keep the recording, ask for the id
const unknownHookNote = (id: string): string => `an unregistered webhook posted this recording in your channel; it is not counted as the owner's request. If it is the owner's (e.g. his iOS Shortcut), register it: put DORI_DISCORD_OWNER_WEBHOOK=${id} in this Dori's dori.env and restart its inbound listener`;
const MENTION_NOTE = "the owner called this Dori in a channel it does not own: answer in your own channel or work thread and include this link (that takes the eyes off); do not post there";
// a Discord message link in the bot's own post: the eyes come off the message it points to
const MESSAGE_LINK = /discord(?:app)?\.com\/channels\/\d+\/(\d+)\/(\d+)/g;
// the owner's message in the pair channel that did not call this Dori: it may be another Dori's (owner 2026-11-03 09:58 KST)
// the owner messages a pair post answers: the one it replies to and those in the same channel it links to
const answeredIds = (channel: string, replyTo: string | null | undefined, content: string | undefined): string[] =>
  [...new Set([replyTo ?? "", ...[...(content ?? "").matchAll(MESSAGE_LINK)].filter(([, ch]) => ch === channel).map(([, , id]) => id ?? "")])].filter(Boolean);
const pairNote = (id: string): string => `the owner wrote in the pair channel without calling you: if it is another Dori's work, do not answer and take your eyes off at once with dori eyes off ${id}`;

// dori eyes off <message id | link>: the lead read an owner message that is not its own and will not answer it, so this
// Dori's eyes come off it at once (owner 2026-11-03 09:58 KST). The channel comes from the link, else the eyes.json entry
// that tracks the id, else fallbackChannel (the pair channel). Only this bot's own reaction is removed (@me). eyes.json
// is only read: the running listener owns it, so the id stays listed until the listener's next sweep there drops it
// (that removal finds nothing left to remove).
export async function eyesOff(dc: Discord, eyesFile: string, ref: string, fallbackChannel: string): Promise<string> {
  const link = [...ref.matchAll(MESSAGE_LINK)][0];
  const id = link?.[2] ?? (/^\d{15,}$/.test(ref.trim()) ? ref.trim() : "");
  if (!id) throw new Error(`eyes off needs a message id or a Discord message link, not ${JSON.stringify(ref)}`);
  const eyes = existsSync(eyesFile) ? (JSON.parse(readFileSync(eyesFile, "utf8")) as Record<string, string[]>) : {};
  const channel = link?.[1] ?? Object.keys(eyes).find((ch) => eyes[ch]?.includes(id)) ?? fallbackChannel;
  if (!channel) throw new Error(`eyes off: ${id} is not in ${eyesFile} and no pair channel is set; give its link`);
  await dc.unreact(channel, id, EYES);
  return `EYES_OFF ${channel} ${id}`;
}

export class DiscordListener {
  private readonly seen = new Set<string>();
  private readonly parents = new Map<string, string>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly sweeps = new Map<string, Promise<void>>();
  private readonly eyesFile: string;
  private readonly backfillFile: string;
  private readonly scanCursors: Record<string, string> = {};
  private readonly goneChannels = new Set<string>();
  private backfilling: Promise<number> | null = null;
  private dmChannel = "";
  // channel or thread id -> owner messages that still carry our eyes reaction
  private eyes: Record<string, string[]> = {};
  // owner pair messages that did not call this Dori (rows with called false): another Dori's answer takes our eyes off them
  private readonly uncalled = new Set<string>();
  // owner pair messages another Dori answered (its reply or link) -> that answer. The eyes come off once a message is both
  // uncalled and answered, whichever of the two is known first (a reply can come before the owner's row is written: a
  // voice note still being transcribed, or a missed message backfill brings later); rebuilt from the pair-bot rows
  private readonly answered = new Map<string, { readonly by: string; readonly bot: string }>();
  private self = "";
  // role ids that call this Dori: discord.mentionRoleIds, plus its bot member's roles, read again at every READY
  private roles: Set<string>;
  private rolesStale = true;
  private rolesRead: Promise<void> | null = null;
  // Summary watermark only; independent per-channel cursors own history progress.
  private cursor = "0";
  private seq: number | null = null;
  private backoff = 1_000;

  constructor(private readonly d: ListenerDeps) {
    mkdirSync(dirname(d.inboxFile), { recursive: true, mode: 0o700 });
    this.roles = new Set(d.words.mentionRoleIds);
    this.eyesFile = join(dirname(d.inboxFile), "eyes.json");
    this.backfillFile = d.shadow ? `${d.inboxFile}.backfill.json` : join(dirname(d.inboxFile), "backfill.json");
    if (existsSync(this.eyesFile)) this.eyes = JSON.parse(readFileSync(this.eyesFile, "utf8")) as Record<string, string[]>;
    for (const line of existsSync(d.inboxFile) ? readFileSync(d.inboxFile, "utf8").split("\n") : []) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { id: string; kind?: string; scope?: string; channel_id?: string; called?: boolean; author_id?: string; reply_to?: string | null; content?: string };
      this.seen.add(row.id);
      if (row.scope === "pair" && row.called === false) this.uncalled.add(row.id);
      if (row.scope === "pair-bot" && row.channel_id)
        for (const id of answeredIds(row.channel_id, row.reply_to, row.content)) this.answered.set(id, { by: row.id, bot: row.author_id ?? "" });
      if (!row.kind && OWN_SCOPES.has(row.scope ?? "")) {
        if (newer(row.id, this.cursor)) this.cursor = row.id;
        if (row.scope === "dm" && row.channel_id) this.dmChannel = row.channel_id;
        if (row.scope !== "dm" && row.channel_id && newer(row.id, this.scanCursors[row.channel_id] ?? "0"))
          this.scanCursors[row.channel_id] = row.id;
      }
    }
    // DM history starts at zero once: a missed first DM can predate every recorded DM.
    if (existsSync(this.backfillFile)) Object.assign(this.scanCursors, JSON.parse(readFileSync(this.backfillFile, "utf8")));
  }

  private append(row: InboxMessage | InboxAnswer): void {
    appendFileSync(this.d.inboxFile, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  }

  private track(p: Promise<void>, tag: string): void {
    const t = p.catch((e: unknown) => this.d.log(`DISCORD_LISTENER_FAIL ${tag} ${errText(e)}`)).finally(() => this.inflight.delete(t));
    this.inflight.add(t);
  }

  async settled(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  private async parentOf(channelId: string): Promise<string> {
    const known = this.parents.get(channelId);
    if (known !== undefined) return known;
    const c = await this.d.dc.call<{ parent_id?: string | null }>("GET", `/channels/${channelId}`);
    this.parents.set(channelId, c.parent_id ?? "");
    return c.parent_id ?? "";
  }

  private saveEyes(): void {
    if (this.d.shadow) return;
    writeFileSync(this.eyesFile, JSON.stringify(this.eyes), { mode: 0o600 });
  }

  // our bot wrote in a channel: take the eyes off the owner's earlier messages there, and off the message it replies to.
  // Sweeps of one channel run one after another; Discord.call waits out a 429's retry_after.
  private clearEyes(m: DiscordMessage, sweep: (m: DiscordMessage) => Promise<void> = (x) => this.sweep(x)): Promise<void> {
    const prev = this.sweeps.get(m.channel_id) ?? Promise.resolve();
    const next = prev.then(() => sweep(m));
    const tail = next.catch(() => {});
    this.sweeps.set(m.channel_id, tail);
    void tail.then(() => this.sweeps.get(m.channel_id) === tail && this.sweeps.delete(m.channel_id));
    return next;
  }

  private async sweep(m: DiscordMessage): Promise<void> {
    const targets = (this.eyes[m.channel_id] ?? []).filter((id) => newer(m.id, id)).map((id) => [m.channel_id, id] as const);
    const ref = m.message_reference?.message_id;
    if (ref && !targets.some(([, id]) => id === ref)) {
      const tracked = Object.keys(this.eyes).find((ch) => this.eyes[ch]?.includes(ref));
      targets.push([tracked ?? m.message_reference?.channel_id ?? m.channel_id, ref]);
    }
    for (const [, ch, id] of (m.content ?? "").matchAll(MESSAGE_LINK))
      if (ch && id && this.eyes[ch]?.includes(id) && !targets.some(([, t]) => t === id)) targets.push([ch, id]);
    const cleared = await this.unEye(targets);
    if (cleared.length) this.d.log(`EYES_CLEARED ${m.channel_id} by=${m.id} ${cleared.join(",")}`);
  }

  // another Dori answered the owner in the pair channel (a reply to his message, or a link to it): our eyes come off that
  // message when it did not call this Dori, since this Dori will not answer it; a message that called it keeps them
  private async sweepAnswered(channel: string, ids: readonly string[]): Promise<void> {
    const targets = ids.filter((id) => this.answered.has(id) && this.uncalled.has(id) && this.eyes[channel]?.includes(id)).map((id) => [channel, id] as const);
    for (const id of await this.unEye(targets)) {
      const a = this.answered.get(id);
      this.d.log(`EYES_CLEARED_ANSWERED ${channel} by=${a?.by ?? "-"} bot=${a?.bot ?? "-"} ${id}`);
    }
  }

  private answersClear(): boolean {
    return this.d.words.autoUnEye && !this.d.shadow && this.d.words.callNames.length > 0;
  }

  private async unEye(targets: readonly (readonly [string, string])[]): Promise<string[]> {
    const cleared: string[] = [];
    for (const [ch, id] of targets) {
      await this.d.dc.unreact(ch, id, EYES).then(
        () => cleared.push(id),
        (e: unknown) => this.d.log(`DISCORD_UNREACT_FAIL ${id} ${errText(e)}`),
      );
      // a message deleted or already cleared by hand is dropped too, so it is not retried forever
      const left = (this.eyes[ch] ?? []).filter((x) => x !== id);
      if (left.length) this.eyes[ch] = left;
      else delete this.eyes[ch];
      this.uncalled.delete(id);
      this.saveEyes();
    }
    return cleared;
  }

  async onMessage(m: DiscordMessage): Promise<void> {
    if (this.self && m.author.id === this.self) {
      if (this.d.words.autoUnEye && !this.d.shadow) await this.clearEyes(m);
      return;
    }
    const pair = this.d.pairChannel ?? "";
    const fromPairBot = !!pair && m.channel_id === pair && !!this.d.pairBots?.includes(m.author.id);
    const fromWatch = !!this.d.watchChannels?.includes(m.channel_id) && !!this.d.watchBots?.includes(m.author.id) && (this.d.watchMatch ?? WATCH_MATCH).test(m.content ?? "");
    const hook = webhookVerdict(m, { guild: this.d.guild, channel: this.d.channel, ownerWebhook: this.d.ownerWebhook ?? "" });
    if (hook === "unknown" && !this.seen.has(m.id)) this.d.log(`DISCORD_WEBHOOK_UNKNOWN id=${m.webhook_id} name=${JSON.stringify(m.author.username ?? "")} message=${m.id}`);
    const viaWebhook = hook === "owner";
    const unknownRecording = hook === "unknown" && !!audioAttachment(m.attachments);
    if (this.seen.has(m.id) || (!viaWebhook && !unknownRecording && !fromPairBot && !fromWatch && (m.author.bot || m.author.id !== this.d.owner))) return;
    let scope: InboxMessage["scope"];
    if (!m.guild_id) {
      scope = "dm";
      this.dmChannel = m.channel_id;
    }
    else if (m.guild_id !== this.d.guild) return;
    else if (m.channel_id === this.d.channel) scope = "channel";
    else if (pair && m.channel_id === pair) scope = fromPairBot ? "pair-bot" : "pair";
    else if (fromWatch) scope = "watch";
    // a channel it cannot look up is not one of its threads, but the owner may still have called it there
    else if ((await this.parentOf(m.channel_id).catch((e: unknown) => (this.d.log(`DISCORD_PARENT_FAIL ${m.channel_id} ${errText(e)}`), ""))) === this.d.channel) scope = "thread";
    else {
      await this.readRoles();
      if (!this.addressed(m)) return;
      scope = "mention";
    }
    this.seen.add(m.id);
    // the other Dori's posts are information the Dori rarely answers, so eyes there would never come off
    if (!this.d.shadow && scope !== "pair-bot" && scope !== "watch")
      await this.d.dc.react(m.channel_id, m.id, EYES).then(
      () => {
        this.eyes[m.channel_id] = [...(this.eyes[m.channel_id] ?? []), m.id];
        this.saveEyes();
      },
      (e: unknown) => this.d.log(`DISCORD_REACT_FAIL ${m.id} ${errText(e)}`),
    );
    let transcript: string | null = null;
    const audio = audioAttachment(m.attachments);
    if (audio && this.d.transcribe) transcript = await this.d.transcribe(audio.url, audio.filename).catch((e: unknown) => (this.d.log(`DISCORD_TRANSCRIBE_FAIL ${m.id} ${errText(e)}`), null));
    const open = scope === "thread" ? openCardIds(this.d.cards.store, m.channel_id) : [];
    // the owner's own words only: another Dori's post, an alert or an unregistered webhook's recording is not his request
    const said = (transcript ?? m.content ?? "").trim();
    const owners = Boolean(said) && scope !== "pair-bot" && scope !== "watch" && !unknownRecording;
    const hints = this.d.hints && owners ? this.hintsFor(m.id, said) : {};
    // a role mention can only be judged once this bot's roles are read: while they are not, the message is not uncalled
    if (scope === "pair" && this.d.words.callNames.length) await this.readRoles();
    // so can a voice note whose words did not come through (no transcriber, a failed or empty transcript)
    const unheard = !!audio && !transcript?.trim();
    const called = scope === "pair" && this.d.words.callNames.length ? (this.calledHere(m, said) ? true : this.rolesStale || unheard ? undefined : false) : undefined;
    if (called === false) this.uncalled.add(m.id);
    const note = open.length ? `card ${open.join(", ")} still open, owner replied in text: resolve it with dori resolve ${open[0]} --answer "<the answer, short>" so the card folds` : "";
    this.append({
      ts: m.timestamp,
      id: m.id,
      channel_id: m.channel_id,
      scope,
      author_id: viaWebhook ? this.d.owner : m.author.id,
      content: m.content,
      transcript,
      attachments: (m.attachments ?? []).map((a) => ({ url: a.url, filename: a.filename, content_type: a.content_type ?? null })),
      reply_to: m.message_reference?.message_id ?? null,
      ...(viaWebhook ? { via: "owner-webhook" as const, webhook_id: m.webhook_id } : {}),
      ...(unknownRecording ? { via: "unknown-webhook" as const, webhook_id: m.webhook_id, note: unknownHookNote(m.webhook_id ?? "") } : {}),
      ...(open.length ? { open_cards: open, note } : {}),
      ...(scope === "mention" ? { note: MENTION_NOTE, link: `https://discord.com/channels/${this.d.guild}/${m.channel_id}/${m.id}` } : {}),
      ...(scope === "watch" ? { note: WATCH_NOTE, link: `https://discord.com/channels/${this.d.guild}/${m.channel_id}/${m.id}` } : {}),
      ...(scope === "pair" && !called ? { note: pairNote(m.id) } : {}),
      ...(called !== undefined ? { called } : {}),
      ...hints,
    });
    if (scope === "pair-bot") {
      const ids = answeredIds(m.channel_id, m.message_reference?.message_id, m.content);
      for (const id of ids) this.answered.set(id, { by: m.id, bot: m.author.id });
      if (ids.length && this.answersClear()) await this.clearEyes(m, () => this.sweepAnswered(m.channel_id, ids));
    }
    if (called === false && this.answered.has(m.id) && this.answersClear()) await this.clearEyes(m, () => this.sweepAnswered(m.channel_id, [m.id]));
    if (newer(m.id, this.cursor)) this.cursor = m.id;
    this.d.log(`INBOUND discord-${scope} ${m.channel_id} ${m.id} ${viaWebhook ? `${this.d.owner} via=owner-webhook` : m.author.id} ${JSON.stringify((transcript ?? m.content).slice(0, 200))}`);
    if (open.length) this.d.log(`CARD_STILL_OPEN ${open.join(",")} thread=${m.channel_id} ${note}`);
    if (scope === "thread" && !this.d.shadow) await this.recheckThread(m.channel_id, open).catch((e: unknown) => this.d.log(`DISCORD_REOPEN_FAIL ${m.channel_id} ${errText(e)}`));
  }

  // a ledger that cannot be read never holds the message back: the row says so and the log has the line
  private hintsFor(id: string, text: string): { directives?: readonly string[]; directives_error?: string } {
    try {
      const lines = this.d.hints?.(text) ?? [];
      return lines.length ? { directives: lines } : {};
    } catch (e) {
      this.d.log(`DISCORD_DIRECTIVES_FAIL ${id} ${errText(e)}`);
      return { directives_error: `${errText(e)}; read the ledger with dori directives` };
    }
  }

  // the owner mentioned this Dori's bot or one of its roles (another Dori's bot or role is not this one)
  // the owner called this Dori in the pair channel: one of discord.callNames in his words, its bot or role mentioned, or a
  // reply to its own post
  private calledHere(m: DiscordMessage, said: string): boolean {
    if (this.addressed(m) || (!!this.self && m.referenced_message?.author?.id === this.self)) return true;
    const text = said.toLowerCase();
    return this.d.words.callNames.some((n) => n.trim() && text.includes(n.trim().toLowerCase()));
  }

  private addressed(m: DiscordMessage): boolean {
    if (this.self && (m.mentions ?? []).some((u) => u.id === this.self)) return true;
    return (m.mention_roles ?? []).some((r) => this.roles.has(r));
  }

  // the roles the bot member has in the guild (a bot's managed role is what the owner picks when typing @<Dori>)
  // A mention that comes while they are being read waits for them; a failed read is tried again by the next mention.
  private readRoles(): Promise<void> {
    if (!this.rolesStale || !this.self) return Promise.resolve();
    this.rolesRead ??= this.loadRoles()
      .catch((e: unknown) => this.d.log(`DISCORD_MENTION_IDS_FAIL ${errText(e)}`))
      .finally(() => {
        this.rolesRead = null;
      });
    return this.rolesRead;
  }

  private async loadRoles(): Promise<void> {
    const me = await this.d.dc.call<{ roles?: string[] }>("GET", `/guilds/${this.d.guild}/members/${this.self}`);
    this.roles = new Set([...this.d.words.mentionRoleIds, ...(me.roles ?? [])]);
    this.rolesStale = false;
    this.d.log(`DISCORD_MENTION_IDS user=${this.self} roles=${[...this.roles].join(",") || "-"}`);
  }

  // The owner writing in a closed thread brings the work back: unarchive it and mark it working again. Writing in a
  // thread with an open question card re-checks its mark, which follows the card (waiting) unless a lane in the thread
  // is working, not the reply.
  private async recheckThread(threadId: string, openCards: readonly string[]): Promise<void> {
    if (openCards.length) {
      await this.d.cards.statuses.request(threadId, "working");
      return;
    }
    const info = await this.d.dc.call<ThreadInfo>("GET", `/channels/${threadId}`);
    if (!isDoneName(info.name ?? "", this.d.words)) return;
    await this.d.cards.statuses.request(threadId, "working");
    this.d.log(`THREAD_REOPENED ${threadId}`);
  }

  async onInteraction(i: Interaction): Promise<void> {
    // a card sits in the channel or inside its work thread: take a tap only where its card was posted,
    // looked up locally since the interaction must be answered within 3 seconds
    const qid = /^[qm]:([^:]+)/.exec(i.data?.custom_id ?? "")?.[1];
    if (i.channel_id !== this.d.channel && (!qid || i.channel_id !== this.d.cards.store.get(qid)?.channel)) return;
    if (this.d.shadow) return this.shadowAnswer(i);
    const outcome = await this.d.cards.handle(i);
    if (outcome.kind === "refused") this.d.log(`CARD_REFUSED ${outcome.user}`);
    if (outcome.kind !== "answered") return;
    const q = outcome.question;
    this.append({ ts: new Date(this.d.now()).toISOString(), id: i.id, kind: "answer", qid: q.id, answer: q.answer ?? "", answer_kind: q.answerKind ?? "button", question: q.text, thread: q.thread, session: q.session, tmux: q.tmux });
    this.d.log(`ANSWER ${q.id} ${q.answerKind} ${JSON.stringify(q.answer ?? "")} thread=${q.thread ?? "-"} session=${q.session ?? "-"} tmux=${q.tmux ?? "-"}`);
    await this.d.cards.afterAnswer(q).catch((e: unknown) => this.d.log(`DISCORD_ECHO_FAIL ${q.id} ${errText(e)}`));
  }

  // A shadow listener writes the answer row the live one would, read-only: no response to Discord and no change to the
  // shared card store (the live listener may already have marked the question answered). Opening the text box writes nothing.
  private shadowAnswer(i: Interaction): void {
    const cid = i.data?.custom_id ?? "";
    const option = /^q:([^:]+):(\d+)$/.exec(cid);
    const modal = /^m:(.+)$/.exec(cid);
    const q = this.d.cards.store.get(option?.[1] ?? modal?.[1] ?? "");
    const value = option ? q?.options[Number(option[2])] : modal ? modalValue(i.data?.components).trim() : undefined;
    if ((i.member?.user.id ?? i.user?.id) !== this.d.owner || !q || !value) return this.d.log(`SHADOW_INTERACTION_SKIPPED ${i.id} ${cid}`);
    this.append({ ts: new Date(this.d.now()).toISOString(), id: i.id, kind: "answer", qid: q.id, answer: value, answer_kind: option ? "button" : "text", question: q.text, thread: q.thread, session: q.session, tmux: q.tmux });
    this.d.log(`SHADOW_ANSWER ${q.id} ${JSON.stringify(value)}`);
  }

  // A live event must not jump a history scan past another channel's reconnect gap.
  backfill(): Promise<number> {
    this.backfilling ??= this.scanHistory().finally(() => { this.backfilling = null; });
    return this.backfilling;
  }

  private async scanHistory(): Promise<number> {
    const since = this.cursor;
    const dm = this.d.shadow ? this.dmChannel : (await this.d.dc.call<{ id: string }>("POST", "/users/@me/channels", { recipient_id: this.d.owner })).id;
    const active = await this.d.dc.call<{ threads?: { id: string; parent_id: string }[] }>("GET", `/guilds/${this.d.guild}/threads/active`);
    const watched = this.d.watchBots?.length ? (this.d.watchChannels ?? []) : [];
    const channels = [this.d.channel, ...(this.d.pairChannel ? [this.d.pairChannel] : []), ...watched, ...(active.threads ?? []).filter((t) => t.parent_id === this.d.channel).map((t) => t.id), ...(dm ? [dm] : [])];
    for (const t of active.threads ?? []) this.parents.set(t.id, t.parent_id);
    let added = 0;
    for (const ch of new Set(channels)) {
      if (this.goneChannels.has(ch)) continue;
      let after = this.scanCursors[ch] ?? "0";
      const start = after;
      let scanned = 0;
      let accepted = 0;
      let gone = false;
      for (;;) {
        let msgs: DiscordMessage[];
        try {
          msgs = await this.d.dc.call<DiscordMessage[]>("GET", `/channels/${ch}/messages?after=${after}&limit=100`);
        } catch (e) {
          if (!unknownChannel(e)) throw e;
          this.goneChannels.add(ch);
          if (ch in this.scanCursors) {
            delete this.scanCursors[ch];
            this.saveScanCursors();
          }
          this.d.log(`DISCORD_BACKFILL_GONE channel=${ch} (404 Unknown Channel: cursor dropped, not retried; remove it from the settings)`);
          gone = true;
          break;
        }
        for (const m of [...msgs].sort((a, b) => (newer(b.id, a.id) ? -1 : 1))) {
          const before = this.seen.size;
          await this.onMessage({ ...m, guild_id: ch === dm ? undefined : this.d.guild });
          if (this.seen.size > before) { added++; accepted++; }
          if (newer(m.id, after)) after = m.id;
          scanned++;
        }
        // Persist only a fully processed page, including skipped authors. Never advance on a failed page.
        this.scanCursors[ch] = after;
        this.saveScanCursors();
        if (newer(after, this.cursor)) this.cursor = after;
        if (msgs.length < 100) break;
      }
      if (!gone) this.d.log(`DISCORD_BACKFILL_SCAN channel=${ch} since=${start} cursor=${after} scanned=${scanned} added=${accepted}`);
    }
    this.d.log(`DISCORD_BACKFILL since=${since} added=${added}`);
    return added;
  }

  private saveScanCursors(): void {
    writeFileSync(`${this.backfillFile}.tmp`, JSON.stringify(this.scanCursors), { mode: 0o600 });
    renameSync(`${this.backfillFile}.tmp`, this.backfillFile);
  }

  private dispatch(type: string | null, data: Record<string, unknown>): void {
    if (type === "READY") {
      this.backoff = 1_000;
      this.self = String((data.user as { id?: string } | undefined)?.id ?? "");
      this.d.log(this.d.shadow ? "DISCORD_LISTENER_READY shadow" : "DISCORD_LISTENER_READY");
      this.track(this.backfill().then(() => {}), "backfill");
      this.rolesStale = true;
      this.track(this.readRoles(), "roles");
    } else if (type === "GUILD_CREATE" && data.id === this.d.guild) {
      for (const t of (data.threads as { id: string; parent_id: string }[] | undefined) ?? []) this.parents.set(t.id, t.parent_id);
    } else if (type === "THREAD_CREATE" || type === "THREAD_UPDATE") this.parents.set(String(data.id), String(data.parent_id ?? ""));
    else if (type === "MESSAGE_CREATE") this.track(this.onMessage(data as unknown as DiscordMessage), "message");
    else if (type === "INTERACTION_CREATE") this.track(this.onInteraction(data as unknown as Interaction), "interaction");
  }

  start(): void {
    const ws = this.d.open();
    this.seq = null;
    let beat: unknown;
    let acked = true;
    ws.onMessage((raw) => {
      const p = JSON.parse(raw) as { op: number; d: Record<string, unknown> | null; s?: number | null; t?: string | null };
      if (typeof p.s === "number") this.seq = p.s;
      if (p.op === 10) {
        beat = this.d.timers.setInterval(() => {
          if (!acked) return ws.close(4000, "zombie");
          acked = false;
          ws.send(JSON.stringify({ op: 1, d: this.seq }));
        }, Number(p.d?.heartbeat_interval));
        ws.send(JSON.stringify({ op: 2, d: { token: this.d.token, intents: LISTENER_INTENTS, properties: { os: process.platform, browser: "dori", device: "dori" } } }));
      } else if (p.op === 11) acked = true;
      else if (p.op === 1) ws.send(JSON.stringify({ op: 1, d: this.seq }));
      else if (p.op === 7 || p.op === 9) {
        this.d.log(`DISCORD_LISTENER_RECONNECT op=${p.op}`);
        ws.close(4000, "reconnect");
      }
      else if (p.op === 0) this.dispatch(p.t ?? null, p.d ?? {});
    });
    ws.onClose((code) => {
      if (beat !== undefined) this.d.timers.clearInterval(beat);
      if (FATAL_CLOSE.has(code)) {
        this.d.log(`DISCORD_LISTENER_FATAL close=${code}`);
        this.d.fatal(code);
        return;
      }
      this.d.log(`DISCORD_LISTENER_CLOSED code=${code} retry_in=${this.backoff}ms`);
      this.d.timers.setTimeout(() => this.start(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    });
  }
}

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Clock } from "../run.ts";
import { guardText, type Http, MessengerError, withBackoff } from "./http.ts";
import { type ThreadLedger, tsAfter } from "./thread-ledger.ts";

export type SlackAuth = { readonly token: string; readonly cookie?: string };
export type Posted = { readonly channel: string; readonly ts: string };
// read() gives the bytes only when that file's turn comes, so a send of several big files holds one at a time
export type UploadFile = { readonly filename: string; readonly length: number; readonly read: () => Promise<Uint8Array<ArrayBuffer>>; readonly title?: string };

export class Slack {
  constructor(
    private readonly http: Http,
    private readonly clock: Clock,
    private readonly auth: SlackAuth,
    private readonly base = "https://slack.com/api",
    private readonly ledger?: ThreadLedger,
  ) {}

  private headers(json: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.auth.token}`,
      ...(json ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...(this.auth.cookie ? { Cookie: `d=${this.auth.cookie}` } : {}),
    };
  }

  async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await withBackoff(this.http, this.clock, { method: "POST", url: `${this.base}/${method}`, headers: this.headers(true), body: JSON.stringify(params) });
    const body = JSON.parse(res.body || "{}") as Record<string, unknown>;
    if (res.status !== 200 || body.ok !== true) throw new MessengerError(`slack ${method}: ${String(body.error ?? res.status)}`, res.status, String(body.error ?? ""));
    if (this.ledger && method === "chat.postMessage" && typeof body.ts === "string") {
      const channel = String(body.channel ?? params.channel);
      await this.ledger.record(channel, typeof params.thread_ts === "string" ? params.thread_ts : body.ts, body.ts);
    }
    return body;
  }

  async post(channel: string, text: string, threadTs?: string): Promise<Posted> {
    const r = await this.call("chat.postMessage", { channel, text: guardText(text), ...(threadTs ? { thread_ts: threadTs } : {}) });
    return { channel: String(r.channel), ts: String(r.ts) };
  }

  async edit(channel: string, ts: string, text: string): Promise<void> {
    await this.call("chat.update", { channel, ts, text: guardText(text) });
  }

  // Every file gets its own upload URL and bytes, then one completeUploadExternal shares them all as one message, with
  // the comment as its text (initial_comment) and in the thread when threadTs is given. The comment is checked before
  // any request. Returns the file ids in order and the share's ts. The share is recorded in the thread ledger like a
  // post, so a reply under it wakes the lead: in a thread that thread; in the channel the share's own ts, which the
  // complete call does not name, so files.info is asked until it lists the share (untracked says why it could not).
  async upload(channel: string, files: readonly UploadFile[], threadTs?: string, comment?: string): Promise<{ ids: string[]; ts?: string; untracked?: string }> {
    const text = comment ? guardText(comment) : undefined;
    const done: { id: string; title: string }[] = [];
    for (const f of files) {
      const slot = await this.call("files.getUploadURLExternal", { filename: f.filename, length: f.length });
      const put = await withBackoff(this.http, this.clock, { method: "POST", url: String(slot.upload_url), body: await f.read() });
      if (put.status !== 200) throw new MessengerError(`slack upload ${f.filename}: ${put.status}`, put.status);
      done.push({ id: String(slot.file_id), title: f.title ?? f.filename });
    }
    await this.call("files.completeUploadExternal", { files: done, channel_id: channel, ...(threadTs ? { thread_ts: threadTs } : {}), ...(text ? { initial_comment: text } : {}) });
    const ids = done.map((f) => f.id);
    if (threadTs) {
      await this.ledger?.record(channel, threadTs, (this.clock.now() / 1000).toFixed(6));
      return { ids };
    }
    let ts: string | undefined;
    try {
      ts = await this.shareTs(ids[0] ?? "", channel);
    } catch (e) {
      if (!(e instanceof MessengerError)) throw e;
      return { ids, untracked: e.message };
    }
    if (!ts) return { ids, untracked: `slack files.info listed no share of ${ids[0]} in ${channel} yet` };
    await this.ledger?.record(channel, ts, ts);
    return { ids, ts };
  }

  // the ts of a file's share in a channel (public or private), once Slack has posted it; tries times, a second apart
  async shareTs(fileId: string, channel: string, tries = 4): Promise<string | undefined> {
    for (let i = 0; i < tries; i++) {
      if (i) await this.clock.sleep(1000);
      const shares = ((await this.call("files.info", { file: fileId })).file as { shares?: Record<string, Record<string, { ts?: string }[]>> } | undefined)?.shares;
      const ts = shares?.public?.[channel]?.[0]?.ts ?? shares?.private?.[channel]?.[0]?.ts;
      if (ts) return ts;
    }
    return undefined;
  }

  async setPresence(presence: "auto" | "away"): Promise<void> {
    await this.call("users.setPresence", { presence });
  }
}

// Takes the bot's own eyes off one message: one request, no retry, abortable (the answer is already out, so nothing
// may hold the command after it).
export type Unreact = (channel: string, ts: string, signal: AbortSignal) => Promise<void>;
export const slackUnreact = (token: string, base = "https://slack.com/api"): Unreact => async (channel, ts, signal) => {
  const res = await fetch(`${base}/reactions.remove`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ channel, timestamp: ts, name: "eyes" }), signal });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status !== 200 || body.ok !== true) throw new MessengerError(`slack reactions.remove: ${String(body.error ?? res.status)}`, res.status, String(body.error ?? ""));
};

// One record shared by dori send slack and the watcher, append-only: every process only appends whole lines and reads
// the lot, so concurrent writers never lose each other's facts and no lock is needed. Lines are
// "<fact> <channel>:<ts> <attempt>": "answered" opens an attempt before its removal is asked (eyes that land later see
// it), "done" closes that attempt once Slack said the eyes are off. A message is done when its latest attempt is
// closed: the done of an older attempt (a slow answer overtaken by a newer one) closes nothing, and an attempt whose
// removal failed, stalled or whose process died stays open, so the next answer there asks again.
export const newAttempt = (): string => crypto.randomUUID().slice(0, 8);
export const noteUneyed = (file: string, fact: "answered" | "done", key: string, attempt: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${fact} ${key} ${attempt}\n`, { mode: 0o600 });
};
export const readUneyed = (file: string): { readonly answered: ReadonlySet<string>; readonly done: ReadonlySet<string> } => {
  const latest = new Map<string, string>();
  const closed = new Set<string>();
  for (const line of existsSync(file) ? readFileSync(file, "utf8").split("\n") : []) {
    const [fact, key, attempt] = line.split(" ");
    if (!key || !attempt) continue;
    if (fact === "answered") latest.set(key, attempt);
    else if (fact === "done") closed.add(`${key} ${attempt}`);
  }
  return { answered: new Set(latest.keys()), done: new Set([...latest].filter(([k, a]) => closed.has(`${k} ${a}`)).map(([k]) => k)) };
};

// The eyes read receipt slack-watch.ts puts on an addressed message comes off once the Dori answers it, as on Discord.
// The watcher's inbox rows say which messages got eyes (addressed) and where their answer goes (reply_thread); a post
// there, or in a thread under the message itself, answers every earlier one of them; a post with no thread answers
// every earlier one in that channel that is not inside a thread (a DM, or a channel message answered in the channel
// itself, as the owner asked OkDori to do: 2026-11-03 10:52 KST, the eyes stayed). reactions.remove with the bot
// token only ever takes off the bot's own reaction, never a person's or another app's. Each removal is one attempt in
// the shared record (see noteUneyed), so a later answer in the same place asks Slack nothing again and the watcher
// takes off eyes that land after the answer. Each removal has ms to answer: a
// stalled one is aborted and it and the rest stay for the next answer. Returns the lines to print: one
// SLACK_UNEYE_SKIPPED when the app has no reactions:write, one SLACK_UNEYE_FAIL per other failure (retried next time).
export const clearEyes = async (unreact: Unreact, files: { readonly inbox: string; readonly uneyed: string }, posted: Posted, thread?: string, ms = 3000): Promise<string[]> => {
  if (!existsSync(files.inbox)) return [];
  const { done } = readUneyed(files.uneyed);
  const targets: string[] = [];
  for (const line of readFileSync(files.inbox, "utf8").split("\n")) {
    if (!line.includes('"scope":"slack"')) continue;
    let row: { scope?: string; id?: string; channel_id?: string; thread_ts?: string | null; reply_thread?: string | null; addressed?: string | null };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.scope !== "slack" || !row.addressed || !row.id || row.channel_id !== posted.channel || !tsAfter(posted.ts, row.id)) continue;
    const answers = thread ? (row.reply_thread ?? null) === thread || row.id === thread : (row.reply_thread ?? null) === null || (row.thread_ts ?? null) === null;
    if (!answers) continue;
    if (!done.has(`${posted.channel}:${row.id}`) && !targets.includes(row.id)) targets.push(row.id);
  }
  const lines: string[] = [];
  for (const ts of targets) {
    const key = `${posted.channel}:${ts}`;
    const attempt = newAttempt();
    noteUneyed(files.uneyed, "answered", key, attempt);
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), ms);
    try {
      await unreact(posted.channel, ts, stop.signal);
    } catch (e) {
      if (stop.signal.aborted) {
        lines.push(`SLACK_UNEYE_FAIL ${posted.channel} ${ts} slack reactions.remove: no answer within ${ms / 1000}s`);
        break;
      }
      const code = e instanceof MessengerError ? e.code : undefined;
      if (code === "missing_scope" || code === "not_allowed_token_type" || code === "no_permission") {
        lines.push(`SLACK_UNEYE_SKIPPED slack reactions.remove: ${code}: the app has no reactions:write, so the eyes stay until it is added and the app reinstalled`);
        break;
      }
      // no_reaction: the eyes never went on or someone took them off; a message or channel that is gone has none left
      if (code !== "no_reaction" && code !== "message_not_found" && code !== "channel_not_found") {
        lines.push(`SLACK_UNEYE_FAIL ${posted.channel} ${ts} ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
    noteUneyed(files.uneyed, "done", key, attempt);
  }
  return lines;
};

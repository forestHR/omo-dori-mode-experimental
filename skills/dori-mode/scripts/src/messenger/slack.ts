import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Clock } from "../run.ts";
import { guardText, type Http, MessengerError, withBackoff } from "./http.ts";
import { type ThreadLedger, tsAfter } from "./thread-ledger.ts";

export type SlackAuth = { readonly token: string; readonly cookie?: string };
export type Posted = { readonly channel: string; readonly ts: string };

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

  async upload(channel: string, filename: string, bytes: Uint8Array<ArrayBuffer>, threadTs?: string, title?: string): Promise<string> {
    const slot = await this.call("files.getUploadURLExternal", { filename, length: bytes.byteLength });
    const put = await withBackoff(this.http, this.clock, { method: "POST", url: String(slot.upload_url), body: bytes });
    if (put.status !== 200) throw new MessengerError(`slack upload: ${put.status}`, put.status);
    await this.call("files.completeUploadExternal", { files: [{ id: slot.file_id, title: title ?? filename }], channel_id: channel, ...(threadTs ? { thread_ts: threadTs } : {}) });
    return String(slot.file_id);
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

export const readUneyed = (file: string): Set<string> => new Set(existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as string[]) : []);

// The eyes read receipt slack-watch.ts puts on an addressed message comes off once the Dori answers it, as on Discord.
// The watcher's inbox rows say which messages got eyes (addressed) and where their answer goes (reply_thread); a post
// there, or in a thread under the message itself, answers every earlier one of them. reactions.remove with the bot
// token only ever takes off the bot's own reaction, never a person's or another app's. Messages already done are kept in
// the done file (every one, so the whole inbox can be read again without asking twice) so a later answer in the same
// place asks Slack nothing again; the watcher reads it too, for eyes that land after the answer. Each removal has ms to
// answer: a stalled one is aborted and it and the rest stay for the next answer. Returns the lines to print: one
// SLACK_UNEYE_SKIPPED when the app has no reactions:write, one SLACK_UNEYE_FAIL per other failure (retried next time).
export const clearEyes = async (unreact: Unreact, files: { readonly inbox: string; readonly done: string }, posted: Posted, thread?: string, ms = 3000): Promise<string[]> => {
  if (!existsSync(files.inbox)) return [];
  const done = readUneyed(files.done);
  const targets: string[] = [];
  for (const line of readFileSync(files.inbox, "utf8").split("\n")) {
    if (!line.includes('"scope":"slack"')) continue;
    let row: { scope?: string; id?: string; channel_id?: string; reply_thread?: string | null; addressed?: string | null };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.scope !== "slack" || !row.addressed || !row.id || row.channel_id !== posted.channel || !tsAfter(posted.ts, row.id)) continue;
    if ((row.reply_thread ?? null) !== (thread ?? null) && row.id !== thread) continue;
    if (!done.has(`${posted.channel}:${row.id}`) && !targets.includes(row.id)) targets.push(row.id);
  }
  const lines: string[] = [];
  let changed = false;
  for (const ts of targets) {
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
    done.add(`${posted.channel}:${ts}`);
    changed = true;
  }
  if (changed) {
    mkdirSync(dirname(files.done), { recursive: true });
    const tmp = `${files.done}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify([...done]), { mode: 0o600 });
    renameSync(tmp, files.done);
  }
  return lines;
};

// dori gcal: the owner's default Google Calendar through the Apps Script web app in setups/gcal-apps-script/Code.gs.
// The web app's address and secret come from dori.env (DORI_GCAL_URL, DORI_GCAL_SECRET) and never reach a line this
// prints or logs. A write (create, update, delete) needs the approval the owner answered: an answered card id (Q<n>) or
// a Discord message link; without one nothing is sent. The web app checks the same again, plus the 도리 mark.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { Question } from "./messenger/discord-cards.ts";

export type GcalAction = "read" | "create" | "update" | "delete";
export const GCAL_ACTIONS: readonly GcalAction[] = ["read", "create", "update", "delete"];

export class GcalError extends Error {
  constructor(readonly code: "GCAL_REFUSED" | "GCAL_FAIL" | "GCAL_NOT_CONFIGURED" | "GCAL_USAGE", message: string) {
    super(`${code} ${message}`);
  }
}

export type Approval = { ref: string; kind: "card" | "link" };

const CARD = /^Q\d+$/;
const DISCORD_LINK = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d+)\/(\d+)$/;
// an answer that says no (or not now): the card was answered, but not with an approval
const REFUSAL = /^\s*(?:아니|아뇨|안\s*돼|안\s*해|하지\s*마|거절|취소|보류|싫|기다려|no\b|nope|reject|cancel|wait)/i;

const refused = (why: string): never => {
  throw new GcalError("GCAL_REFUSED", `${why}; nothing was sent`);
};

const answeredYes = (q: Question, named: string): Approval["kind"] => {
  if (q.status !== "answered") refused(`approval_open: ${named} is not answered yet`);
  if (REFUSAL.test(q.answer ?? "")) refused(`approval_declined: ${named} was answered ${JSON.stringify(q.answer ?? "")}, not an approval`);
  return "card";
};

// The author of one Discord message, read from Discord itself; undefined when this Dori cannot look it up.
export type MessageAuthor = (channel: string, message: string) => Promise<string | undefined>;

// The owner's approval for a write: a card he answered with something other than a no (dori ask), or a link to a
// message Discord says he wrote. A link to a card is judged as that card. A link that cannot be checked is refused.
export const checkApproval = async (ref: string | undefined, cards: readonly Question[], owner = "", author?: MessageAuthor): Promise<Approval> => {
  const r = ref?.trim() ?? "";
  if (!r) refused("no_approval: a write needs --approval <answered card id | Discord link of the owner's approval>");
  if (CARD.test(r)) {
    const q = cards.find((c) => c.id === r) ?? refused(`approval_unknown: no card ${r} in this Dori's card records`);
    return { ref: r, kind: answeredYes(q, `card ${r}`) };
  }
  const [, channel = "", message = ""] = DISCORD_LINK.exec(r) ?? refused("approval_malformed: --approval takes a card id (Q12) or a Discord message link");
  const card = cards.find((c) => c.message === message);
  if (card) return { ref: r, kind: answeredYes(card, `that link is card ${card.id}, which`) };
  if (!owner || !author) refused("approval_unverifiable: this Dori cannot read that message's author (DORI_DISCORD_TOKEN and DORI_DISCORD_OWNER)");
  const who = await author!(channel, message).catch(() => undefined);
  if (who === undefined) refused("approval_unverifiable: Discord did not show that message to this Dori's bot");
  if (who !== owner) refused("approval_not_owner: that message is not the owner's");
  return { ref: r, kind: "link" };
};

// Every secret value and any URL in a text that may be printed: an error from fetch names the address it tried.
export const redact = (text: string, secrets: readonly string[]): string => {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("<hidden>");
  return out.replace(/https?:\/\/[^\s"'<>]+/g, "<url>");
};

const time = (value: string | undefined, name: string): string => {
  const v = value?.trim() ?? "";
  const d = new Date(v);
  if (!v || Number.isNaN(d.getTime())) throw new GcalError("GCAL_USAGE", `--${name} is not a time (ISO, e.g. 2026-11-12T10:00+09:00)`);
  return d.toISOString();
};

const minutes = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 40320) throw new GcalError("GCAL_USAGE", "--reminder is whole minutes from 0 to 40320");
  return n;
};

export type GcalOptions = {
  id?: string; from?: string; to?: string; start?: string; end?: string; title?: string; location?: string;
  description?: string; reminder?: string; approval?: string; requestId?: string;
};

// The request body without the secret, checked here so a bad call is refused before anything is sent.
export const gcalBody = (action: GcalAction, o: GcalOptions, newId: () => string): Record<string, unknown> => {
  if (action === "read") return { action, start: time(o.from, "from"), end: time(o.to, "to") };
  if (action === "create") {
    if (!o.title?.trim()) throw new GcalError("GCAL_USAGE", "create needs --title");
    return {
      action, title: o.title.trim(), start: time(o.start, "start"), end: time(o.end, "end"), request_id: o.requestId?.trim() || newId(),
      ...(o.location !== undefined ? { location: o.location } : {}), ...(o.description !== undefined ? { description: o.description } : {}),
      ...(o.reminder !== undefined ? { reminder_minutes: minutes(o.reminder) } : {}),
    };
  }
  if (!o.id?.trim()) throw new GcalError("GCAL_USAGE", `${action} needs the event id (dori gcal ${action} <id>)`);
  if (action === "delete") return { action, id: o.id.trim() };
  const body: Record<string, unknown> = { action, id: o.id.trim() };
  if (o.title !== undefined) body.title = o.title;
  if (o.start !== undefined) body.start = time(o.start, "start");
  if (o.end !== undefined) body.end = time(o.end, "end");
  if (o.location !== undefined) body.location = o.location;
  if (o.description !== undefined) body.description = o.description;
  if (o.reminder !== undefined) body.reminder_minutes = minutes(o.reminder);
  if (Object.keys(body).length === 2) throw new GcalError("GCAL_USAGE", "update needs at least one of --title --start --end --location --description --reminder");
  return body;
};

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// POST to the web app. Apps Script answers a POST with 302 to a one-time address that serves the reply; a browser (and
// fetch's own follow) fetches it with GET, so does this, by hand, so the hop is visible and capped.
export const postWebApp = async (url: string, secret: string, body: Record<string, unknown>, f: Fetch = fetch): Promise<Record<string, unknown>> => {
  const hide = (e: unknown): string => redact(e instanceof Error ? e.message : String(e), [secret, url]);
  let res: Response;
  try {
    res = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, secret }), redirect: "manual" });
    for (let hop = 0; res.status === 301 || res.status === 302 || res.status === 303; hop++) {
      const location = res.headers.get("location");
      if (hop >= 5 || !location) throw new Error(hop >= 5 ? "more than 5 redirects" : `redirect ${res.status} without a location`);
      await res.body?.cancel();
      res = await f(new URL(location, url).toString(), { method: "GET", redirect: "manual" });
    }
  } catch (e) {
    throw new GcalError("GCAL_FAIL", `web app not reached: ${hide(e)}`);
  }
  const text = await res.text();
  if (res.status !== 200) throw new GcalError("GCAL_FAIL", `web app answered HTTP ${res.status}`);
  try {
    const out = JSON.parse(text) as Record<string, unknown>;
    if (out && typeof out === "object") return out;
  } catch {}
  // a sign-in page: the deployment's access is not "Anyone" (모든 사용자), or the address is not the /exec one
  throw new GcalError("GCAL_FAIL", `web app answered ${/<html/i.test(text) ? "an HTML page" : "something"} instead of JSON; check the deployment (실행: 나, 액세스: 모든 사용자)`);
};

export type WriteRecord = {
  at: string; action: Exclude<GcalAction, "read">; approval: string; approval_kind: Approval["kind"]; outcome: string;
  request_id?: string; event_id?: string; title?: string; start?: string; end?: string; reminder_minutes?: number; duplicate?: boolean;
};

export const appendWrite = (file: string, rec: WriteRecord): void => {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(rec)}\n`);
};

export type GcalDeps = {
  url?: string; secret?: string; envFile: string; cards: () => readonly Question[]; writesFile: string;
  now: () => Date; newId: () => string; fetch?: Fetch; owner?: string; author?: MessageAuthor;
};

// One dori gcal call: the lines to print. Throws GcalError for a refusal or failure (its message is safe to print).
export const gcalRun = async (action: GcalAction, o: GcalOptions, d: GcalDeps): Promise<string[]> => {
  const url = d.url?.trim() ?? "";
  const secret = d.secret?.trim() ?? "";
  const missing = [url ? "" : "DORI_GCAL_URL", secret ? "" : "DORI_GCAL_SECRET"].filter(Boolean);
  if (missing.length) throw new GcalError("GCAL_NOT_CONFIGURED", `${missing.join(" and ")} not set in ${d.envFile} (the owner puts them there; see setups/gcal-apps-script/README.md)`);
  const approval = action === "read" ? undefined : await checkApproval(o.approval, d.cards(), d.owner?.trim() ?? "", d.author);
  const body = gcalBody(action, o, d.newId);
  if (approval) body.approval = approval.ref;
  // whatever the web app echoes back (titles, details) is printed and logged with the secret and address taken out
  const hide = (text: string): string => [secret, url].reduce((t, s) => t.split(s).join("<hidden>"), text);
  const write = (outcome: string, event?: Record<string, unknown>): void => {
    if (!approval || action === "read") return;
    const e = event ?? {};
    const pick = (k: string): string | undefined => (typeof e[k] === "string" ? (e[k] as string) : typeof body[k] === "string" ? (body[k] as string) : undefined);
    appendWrite(d.writesFile, JSON.parse(hide(JSON.stringify({
      at: d.now().toISOString(), action, approval: approval.ref, approval_kind: approval.kind, outcome,
      ...(typeof body.request_id === "string" ? { request_id: body.request_id } : {}),
      ...(pick("id") ? { event_id: pick("id") } : {}), ...(pick("title") ? { title: pick("title") } : {}),
      ...(pick("start") ? { start: pick("start") } : {}), ...(pick("end") ? { end: pick("end") } : {}),
      ...(typeof e.reminder_minutes === "number" ? { reminder_minutes: e.reminder_minutes } : {}),
      ...(e.duplicate === true ? { duplicate: true } : {}),
    }))) as WriteRecord);
  };
  let out: Record<string, unknown>;
  try {
    out = await postWebApp(url, secret, body, d.fetch);
  } catch (e) {
    // the write may have landed before the reply was lost: kept as unknown, never as done
    write(`fail: ${e instanceof Error ? e.message : String(e)}`);
    // the same request id finds the event a lost reply made instead of making a second one
    if (action === "create" && e instanceof GcalError) throw new GcalError(e.code, `${e.message.slice(e.code.length + 1)}; the event may exist: run the same create again with --request-id ${String(body.request_id)}`);
    throw e;
  }
  if (out.ok !== true) {
    const code = typeof out.error === "string" ? redact(out.error, [secret, url]) : "unknown";
    const detail = typeof out.detail === "string" ? `: ${redact(out.detail, [secret, url])}` : "";
    write(`refused: ${code}`);
    throw new GcalError(code === "internal" ? "GCAL_FAIL" : "GCAL_REFUSED", `web app: ${code}${detail}`);
  }
  if (action === "read") {
    const events = Array.isArray(out.events) ? (out.events as Record<string, unknown>[]) : [];
    return [`GCAL_EVENTS ${events.length}`, ...events.map((e) => hide(JSON.stringify(e)))];
  }
  const event = (action === "delete" ? out.deleted : out.event) as Record<string, unknown> | undefined;
  write("ok", event);
  const verb = { create: event?.duplicate === true ? "GCAL_CREATED_BEFORE" : "GCAL_CREATED", update: "GCAL_UPDATED", delete: "GCAL_DELETED" }[action];
  return [hide(`${verb} ${String(event?.id ?? body.id ?? "")} ${JSON.stringify(event ?? {})}`)];
};

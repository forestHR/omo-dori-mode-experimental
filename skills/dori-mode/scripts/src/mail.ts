// dori mail: the owner's NAVER WORKS mailbox (skku.edu) over IMAP. list and read show the mail of the senders in
// DORI_MAIL_SENDERS only, without marking anything read (EXAMINE, a read-only open, and BODY.PEEK); draft puts a reply
// to one of those mails into the drafts folder with IMAP APPEND, and the owner sends it herself. Nothing is sent (no
// SMTP), deleted, moved or flagged: a command outside the read-only set below never leaves this file. The account and
// its app password come from dori.env (DORI_MAIL_IMAP_USER, DORI_MAIL_IMAP_PASSWORD) and the password never reaches a
// line this prints.
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

export type MailAction = "list" | "read" | "draft";
export const MAIL_ACTIONS: readonly MailAction[] = ["list", "read", "draft"];

export class MailError extends Error {
  constructor(readonly code: "MAIL_REFUSED" | "MAIL_FAIL" | "MAIL_NOT_CONFIGURED" | "MAIL_USAGE", message: string) {
    super(`${code} ${message}`);
  }
}

// DORI_MAIL_SENDERS: comma (or space) separated addresses (a@b.kr) and domains (@skku.edu, exactly that domain)
export type Senders = { addresses: Set<string>; domains: Set<string> };

export const parseSenders = (value: string | undefined): Senders => {
  const s: Senders = { addresses: new Set(), domains: new Set() };
  for (const raw of (value ?? "").split(/[,\s]+/)) {
    const v = raw.trim().toLowerCase();
    if (!v) continue;
    if (/^@[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) s.domains.add(v.slice(1));
    else if (/^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) s.addresses.add(v);
    else throw new MailError("MAIL_USAGE", `DORI_MAIL_SENDERS has ${JSON.stringify(raw)}, which is neither an address (a@b.kr) nor a domain (@skku.edu)`);
  }
  return s;
};

export const allowed = (address: string, s: Senders): boolean => {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  return at > 0 && (s.addresses.has(a) || s.domains.has(a.slice(at + 1)));
};

// DORI_MAIL_SUBJECT_KEYWORDS: comma separated words; a mail whose decoded subject holds one (any case) passes too. The
// match is made here on the decoded subject, not by the server's SEARCH SUBJECT, which servers handle unevenly for Korean.
export const parseKeywords = (value: string | undefined): string[] =>
  (value ?? "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);

export type Filter = { senders: Senders; keywords: string[] };
export const passes = (mail: { from: string; subject: string }, f: Filter): boolean =>
  allowed(mail.from, f.senders) || f.keywords.some((k) => mail.subject.toLowerCase().includes(k));

// every form a secret can take in a text: raw, JSON-escaped, IMAP-quoted
const forms = (secret: string): string[] =>
  secret ? [...new Set([secret, JSON.stringify(secret).slice(1, -1), secret.replace(/(["\\])/g, "\\$1")])].sort((a, b) => b.length - a.length) : [];
export const redact = (text: string, secrets: readonly string[]): string =>
  secrets.flatMap(forms).reduce((t, s) => t.split(s).join("<hidden>"), text);

const CHARSET_ALIAS: Record<string, string> = {
  "ks_c_5601-1987": "euc-kr", ks_c_5601: "euc-kr", cp949: "euc-kr", "x-windows-949": "euc-kr", "windows-949": "euc-kr", uhc: "euc-kr",
  utf8: "utf-8", ascii: "utf-8", "us-ascii": "utf-8", latin1: "iso-8859-1",
};
export const decodeBytes = (bytes: Uint8Array, charset = "utf-8"): string => {
  const cs = charset.trim().toLowerCase().replace(/^["']|["']$/g, "");
  try {
    return new TextDecoder((CHARSET_ALIAS[cs] ?? (cs || "utf-8")) as ConstructorParameters<typeof TextDecoder>[0]).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
};
const latin1 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const fromLatin1 = (b: Uint8Array): string => Array.from(b, (x) => String.fromCharCode(x)).join("");

export const decodeQP = (text: string, header = false): Uint8Array => {
  const t = header ? text.replace(/_/g, " ") : text.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < t.length; i++) {
    const hex = t[i] === "=" ? t.slice(i + 1, i + 3) : "";
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
    } else out.push(t.charCodeAt(i) & 0xff);
  }
  return Uint8Array.from(out);
};

// bytes of a header as sent: UTF-8 when they are valid UTF-8, else the Korean legacy set (a mailer that put raw EUC-KR in)
const rawHeaderText = (s: string): string => {
  const bytes = latin1(s);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return decodeBytes(bytes, "euc-kr");
  }
};

// RFC 2047 encoded words (=?charset?B|Q?...?=); whitespace between two encoded words is dropped
export const decodeWords = (value: string): string =>
  rawHeaderText(value)
    .replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)/g, "$1")
    .replace(/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g, (_m, cs: string, enc: string, data: string) => {
      const bytes = enc.toUpperCase() === "B" ? Uint8Array.from(Buffer.from(data, "base64")) : decodeQP(data, true);
      return decodeBytes(bytes, cs.replace(/\*.*$/, ""));
    });

// modified UTF-7 (RFC 3501 5.1.3) mailbox names: "&ycDGtA-" <-> 한글
export const decodeMailbox = (name: string): string =>
  name.replace(/&([^-]*)-/g, (_m, b: string) => {
    if (!b) return "&";
    const bytes = Buffer.from(b.replace(/,/g, "/"), "base64");
    let s = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
    return s;
  });
export const encodeMailbox = (name: string): string => {
  let out = "";
  let run = "";
  const flush = (): void => {
    if (!run) return;
    const bytes = Buffer.alloc(run.length * 2);
    for (let i = 0; i < run.length; i++) bytes.writeUInt16BE(run.charCodeAt(i), i * 2);
    out += `&${bytes.toString("base64").replace(/=+$/, "").replace(/\//g, ",")}-`;
    run = "";
  };
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    if (c >= 0x20 && c <= 0x7e) {
      flush();
      out += ch === "&" ? "&-" : ch;
    } else run += ch;
  }
  flush();
  return out;
};

// an IMAP value: an atom or quoted string (text), a literal (bytes), NIL (null) or a parenthesized list
export type ImapValue = string | Uint8Array | null | ImapValue[];

// One response (its literals inline, one char per byte) parsed into values, from position `at`.
export const parseValues = (s: string, at = 0): ImapValue[] => {
  let i = at;
  const one = (): ImapValue | undefined => {
    while (s[i] === " ") i++;
    if (i >= s.length || s[i] === ")") return undefined;
    const c = s[i]!;
    if (c === "(") {
      i++;
      const list: ImapValue[] = [];
      for (let v = one(); v !== undefined; v = one()) list.push(v);
      if (s[i] === ")") i++;
      return list;
    }
    if (c === '"') {
      let out = "";
      for (i++; i < s.length && s[i] !== '"'; i++) out += s[i] === "\\" ? s[++i] : s[i];
      i++;
      return rawHeaderText(out);
    }
    const lit = /^\{(\d+)\+?\}\r\n/.exec(s.slice(i, i + 24));
    if (lit) {
      i += lit[0].length;
      const bytes = latin1(s.slice(i, i + Number(lit[1])));
      i += Number(lit[1]);
      return bytes;
    }
    // an atom, which may hold a bracketed section with spaces (BODY[HEADER.FIELDS (FROM DATE)]) and a <partial>
    let atom = "";
    let depth = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === "[") depth++;
      if (ch === "]") depth--;
      if (depth <= 0 && (ch === " " || ch === "(" || ch === ")" || ch === "\r" || ch === "\n")) break;
      atom += ch;
      i++;
    }
    if (!atom) {
      i++;
      return one();
    }
    return atom.toUpperCase() === "NIL" ? null : atom;
  };
  const out: ImapValue[] = [];
  for (let v = one(); v !== undefined; v = one()) out.push(v);
  return out;
};

const text = (v: ImapValue | undefined): string => (typeof v === "string" ? v : v instanceof Uint8Array ? rawHeaderText(fromLatin1(v)) : "");
const bytesOf = (v: ImapValue | undefined): Uint8Array => (v instanceof Uint8Array ? v : typeof v === "string" ? latin1(v) : new Uint8Array());

// Only these commands ever go out. EXAMINE opens a mailbox read-only, so even a FETCH cannot set \Seen; a FETCH of a
// body part must be BODY.PEEK. STORE, COPY, MOVE, EXPUNGE, DELETE, SELECT and every other command are refused here.
const ALLOWED = /^(CAPABILITY|LOGIN|LIST|EXAMINE|UID SEARCH|UID FETCH|APPEND|NOOP|LOGOUT)( |$)/;
export const commandProblem = (command: string): string | undefined => {
  if (!ALLOWED.test(command)) return `command ${command.split(" ").slice(0, 2).join(" ")} is not one dori mail sends`;
  if (/^UID FETCH /.test(command) && (/(^|[\s(])BODY\[/i.test(command) || /(^|[\s(])RFC822(\.TEXT)?([\s)]|$)/i.test(command))) return "a FETCH that would mark the mail read (BODY[ or RFC822 without PEEK)";
  return undefined;
};

export type Socket = { write(data: string | Uint8Array): unknown; on(event: string, cb: (...a: any[]) => void): unknown; end(): unknown; destroy(): unknown; setTimeout?(ms: number, cb?: () => void): unknown };
export type Opener = (host: string, port: number) => Socket;
export const tlsOpener: Opener = (host, port) => tlsConnect({ host, port, servername: host });
// plain TCP, for a local test server only
export const plainOpener: Opener = (host, port) => netConnect({ host, port });

type Tagged = { status: string; text: string; untagged: string[] };

class Imap {
  private buf = Buffer.alloc(0);
  private waiters: ((line: string | Error) => void)[] = [];
  private queue: (string | Error)[] = [];
  private n = 0;

  constructor(private readonly sock: Socket, private readonly secrets: readonly string[], timeoutMs: number) {
    sock.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.drain();
    });
    const fail = (e: unknown): void => this.push(new MailError("MAIL_FAIL", `connection: ${redact(e instanceof Error ? e.message : String(e), secrets)}`));
    sock.on("error", fail);
    sock.on("close", () => fail("closed by the server"));
    sock.setTimeout?.(timeoutMs, () => {
      fail(`no answer in ${Math.round(timeoutMs / 1000)}s`);
      sock.destroy();
    });
  }

  private push(item: string | Error): void {
    const w = this.waiters.shift();
    if (w) w(item);
    else this.queue.push(item);
  }

  // one complete response: lines joined with their literals, as one char per byte
  private drain(): void {
    for (;;) {
      let at = 0;
      let done = -1;
      for (;;) {
        const eol = this.buf.indexOf("\r\n", at);
        if (eol < 0) break;
        const lit = /\{(\d+)\+?\}$/.exec(this.buf.subarray(Math.max(at, eol - 16), eol).toString("latin1"));
        if (!lit) {
          done = eol + 2;
          break;
        }
        const next = eol + 2 + Number(lit[1]);
        if (this.buf.length < next) break;
        at = next;
      }
      if (done < 0) return;
      this.push(this.buf.subarray(0, done).toString("latin1"));
      this.buf = this.buf.subarray(done);
    }
  }

  private next(): Promise<string> {
    const item = this.queue.shift();
    if (item !== undefined) return item instanceof Error ? Promise.reject(item) : Promise.resolve(item);
    return new Promise((ok, no) => this.waiters.push((x) => (x instanceof Error ? no(x) : ok(x))));
  }

  async greeting(): Promise<void> {
    const line = await this.next();
    if (!/^\* (OK|PREAUTH)/i.test(line)) throw new MailError("MAIL_FAIL", `server greeting: ${redact(line.trim(), this.secrets).slice(0, 120)}`);
  }

  // one command; `literal` goes after the server's + (APPEND). `shown` is the command as an error may name it.
  async run(command: string, literal?: Uint8Array, shown = command): Promise<Tagged> {
    const problem = commandProblem(command);
    if (problem) throw new MailError("MAIL_REFUSED", `${problem}; nothing was sent`);
    const tag = `D${String(++this.n).padStart(3, "0")}`;
    this.sock.write(`${tag} ${command}${literal ? ` {${literal.length}}` : ""}\r\n`);
    const untagged: string[] = [];
    for (;;) {
      const line = await this.next();
      if (line.startsWith("+") && literal) {
        this.sock.write(literal);
        this.sock.write("\r\n");
        literal = undefined;
        continue;
      }
      if (line.startsWith(`${tag} `)) {
        const [, status = "", rest = ""] = /^\S+ (\S+) ?(.*)\r\n$/s.exec(line) ?? [];
        const t = { status: status.toUpperCase(), text: rest, untagged };
        if (t.status !== "OK") throw new MailError("MAIL_FAIL", `${shown.split(" ").slice(0, 2).join(" ")}: ${t.status} ${redact(rest, this.secrets).slice(0, 200)}`);
        return t;
      }
      if (line.startsWith("* BYE")) throw new MailError("MAIL_FAIL", `server closed: ${redact(line.trim(), this.secrets).slice(0, 120)}`);
      untagged.push(line);
    }
  }

  close(): void {
    try {
      this.sock.write(`D${String(++this.n).padStart(3, "0")} LOGOUT\r\n`);
      this.sock.end();
    } catch {}
  }
}

// an IMAP string: quoted when it can be, else a literal is needed (callers keep to the quotable)
const quote = (s: string): string => `"${s.replace(/(["\\])/g, "\\$1")}"`;
const quotable = (s: string): boolean => /^[\x20-\x7e]*$/.test(s);

export type Part = { section: string; type: string; subtype: string; params: Record<string, string>; encoding: string; size: number; disposition: string; filename: string };

const paramsOf = (v: ImapValue | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!Array.isArray(v)) return out;
  for (let i = 0; i + 1 < v.length; i += 2) out[text(v[i]).toLowerCase()] = text(v[i + 1]);
  return out;
};

// a file name from Content-Disposition / Content-Type parameters: RFC 2231 (name*=utf-8''..., name*0*=...) or 2047
export const fileName = (...sets: Record<string, string>[]): string => {
  for (const p of sets) {
    for (const key of ["filename", "name"]) {
      const parts = Object.keys(p).filter((k) => k === `${key}*` || new RegExp(`^${key}\\*\\d+\\*?$`).test(k))
        .sort((a, b) => Number(a.replace(/\D/g, "") || 0) - Number(b.replace(/\D/g, "") || 0));
      if (parts.length) {
        const joined = parts.map((k) => (k.endsWith("*") ? p[k]! : encodeURIComponent(p[k]!))).join("");
        const [, cs = "utf-8", , data = joined] = /^([^']*)'([^']*)'(.*)$/s.exec(joined) ?? [];
        const bytes = latin1(data.replace(/%([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))));
        return decodeBytes(bytes, cs || "utf-8");
      }
      if (p[key]) return decodeWords(p[key]!);
    }
  }
  return "";
};

// the leaf parts of a BODYSTRUCTURE with their section numbers ("1", "2.1"; a single-part mail is "1")
export const partsOf = (bs: ImapValue | undefined, section = ""): Part[] => {
  if (!Array.isArray(bs)) return [];
  if (Array.isArray(bs[0])) {
    const end = bs.findIndex((v) => !Array.isArray(v));
    const children = (end < 0 ? bs : bs.slice(0, end)) as ImapValue[][];
    return children.flatMap((c, i) => partsOf(c, section ? `${section}.${i + 1}` : String(i + 1)));
  }
  const type = text(bs[0]).toLowerCase();
  const subtype = text(bs[1]).toLowerCase();
  const params = paramsOf(bs[2]);
  // extension data starts after the basic fields: text has lines, message/rfc822 envelope + body + lines
  const ext = type === "text" ? 8 : type === "message" && subtype === "rfc822" ? 10 : 7;
  const disp = bs[ext + 1];
  const disposition = Array.isArray(disp) ? text(disp[0]).toLowerCase() : "";
  const dparams = Array.isArray(disp) ? paramsOf(disp[1]) : {};
  return [{
    section: section || "1", type, subtype, params, encoding: text(bs[5]).toLowerCase(), size: Number(text(bs[6])) || 0, disposition,
    filename: fileName(dparams, params) || (type === "message" && subtype === "rfc822" ? "message.eml" : ""),
  }];
};

const isAttachment = (p: Part): boolean => p.disposition === "attachment" || !!p.filename || (p.type !== "text" && p.type !== "multipart");
// the size of an attachment once decoded: base64 holds 3 bytes in 4 characters, with a line break every 76
const decodedSize = (p: Part): number => (p.encoding === "base64" ? Math.floor((p.size * 76) / 78 / 4) * 3 : p.size);

export const decodePart = (raw: Uint8Array, p: Pick<Part, "encoding" | "params">): string => {
  const s = fromLatin1(raw);
  const bytes = p.encoding === "base64" ? Uint8Array.from(Buffer.from(s.replace(/[^A-Za-z0-9+/=]/g, ""), "base64"))
    : p.encoding === "quoted-printable" ? decodeQP(s) : raw;
  return decodeBytes(bytes, p.params.charset ?? "utf-8");
};

export const htmlToText = (html: string): string =>
  html.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d|blockquote)>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

export type Headers = Record<string, string>;
// header block -> lowercased name -> unfolded, decoded value (the first of each name)
export const parseHeaders = (raw: Uint8Array): Headers => {
  const out: Headers = {};
  for (const line of fromLatin1(raw).replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const [, name, value] = /^([!-9;-~]+):\s*(.*)$/.exec(line) ?? [];
    if (name && !(name.toLowerCase() in out)) out[name.toLowerCase()] = value!.trim();
  }
  return out;
};

// "이름 <a@b.kr>" -> address and decoded name
export const addressOf = (value: string | undefined): { address: string; name: string } => {
  const v = value ?? "";
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(v);
  const address = (angle?.[1] ?? /[^\s<>"',;]+@[^\s<>"',;]+/.exec(v)?.[0] ?? "").toLowerCase();
  const name = decodeWords(angle ? v.slice(0, angle.index) : "").trim().replace(/^"(.*)"$/, "$1").trim();
  return { address, name };
};

export type MailOptions = { uid?: string; since?: string; until?: string; from?: string; limit?: string; text?: string };
export type MailDeps = {
  host?: string; port?: string; user?: string; password?: string; senders?: string; keywords?: string; envFile: string;
  now: () => Date; open?: Opener; timeoutMs?: number; newId: () => string;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const imapDate = (d: Date): string => `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
const day = (value: string | undefined, name: string): Date | undefined => {
  if (value === undefined) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : undefined;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value.trim()) throw new MailError("MAIL_USAGE", `--${name} is a day (YYYY-MM-DD)`);
  return d;
};

const uidOf = (value: string | undefined, action: string): string => {
  const v = value?.trim() ?? "";
  if (!/^[1-9]\d{0,9}$/.test(v)) throw new MailError("MAIL_USAGE", `${action} needs the mail's uid (dori mail ${action} <uid>, from dori mail list)`);
  return v;
};

// FETCH responses -> uid -> its data items (BODY[...] keys as the server wrote them, upper-cased)
const fetched = (untagged: string[]): Map<string, Record<string, ImapValue>> => {
  const out = new Map<string, Record<string, ImapValue>>();
  for (const line of untagged) {
    const m = /^\* \d+ FETCH /i.exec(line);
    if (!m) continue;
    const [items] = parseValues(line, m[0].length);
    if (!Array.isArray(items)) continue;
    const rec: Record<string, ImapValue> = {};
    for (let i = 0; i + 1 < items.length; i += 2) rec[text(items[i]).toUpperCase().replace(/\.PEEK/, "")] = items[i + 1]!;
    const uid = text(rec.UID);
    if (uid) out.set(uid, { ...(out.get(uid) ?? {}), ...rec });
  }
  return out;
};
const bodyItem = (rec: Record<string, ImapValue>, prefix: string): Uint8Array =>
  bytesOf(Object.entries(rec).find(([k]) => k.startsWith(prefix))?.[1] ?? null);

const HEADER_FIELDS = "FROM TO CC SUBJECT DATE MESSAGE-ID REFERENCES";
const summaryFetch = `(UID FLAGS INTERNALDATE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})])`;

type Summary = { uid: string; date: string; from: string; name: string; to: string; cc: string; subject: string; seen: boolean; messageId: string; references: string; parts: Part[] };
const summarize = (uid: string, rec: Record<string, ImapValue>): Summary => {
  const h = parseHeaders(bodyItem(rec, "BODY[HEADER"));
  const from = addressOf(h.from);
  const internal = new Date(text(rec.INTERNALDATE).replace(/^(\d+)-(\w+)-(\d+)/, "$2 $1 $3"));
  const sent = new Date(h.date ?? "");
  const date = !Number.isNaN(sent.getTime()) ? sent : internal;
  return {
    uid, date: Number.isNaN(date.getTime()) ? "" : date.toISOString(), from: from.address, name: from.name, to: decodeWords(h.to ?? ""), cc: decodeWords(h.cc ?? ""),
    subject: decodeWords(h.subject ?? ""), seen: Array.isArray(rec.FLAGS) && rec.FLAGS.some((f) => text(f).toLowerCase() === "\\seen"),
    messageId: (/<[^<>\s]+>/.exec(h["message-id"] ?? "")?.[0] ?? ""), references: (h.references ?? "").match(/<[^<>\s]+>/g)?.join(" ") ?? "",
    parts: partsOf(rec.BODYSTRUCTURE),
  };
};

const attachmentsOf = (s: Summary): { name: string; size: number }[] =>
  s.parts.filter(isAttachment).map((p) => ({ name: p.filename || `(${p.type}/${p.subtype})`, size: decodedSize(p) }));

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const encodeWord = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const wrap76 = (s: string): string => s.replace(/.{1,76}/g, "$&\r\n");
const rfc2822 = (d: Date): string => d.toUTCString().replace(/GMT$/, "+0000");

// the reply as one RFC 5322 message, CRLF lines, UTF-8 base64 body: the text, then the original quoted
export const replyMessage = (o: { user: string; to: { address: string; name: string }; subject: string; messageId: string; references: string; text: string; quote: string; quotedDate: string; date: Date; id: string }): string => {
  const subject = /^\s*(re|회신|답장)\s*:/i.test(o.subject) ? o.subject : `Re: ${o.subject}`;
  const domain = o.user.split("@")[1] || "dori.local";
  const refs = [o.references, o.messageId].filter(Boolean).join(" ").trim();
  const quoted = o.quote.trim() ? `\n\n${o.quotedDate}, ${o.to.name ? `${o.to.name} ` : ""}<${o.to.address}> 작성:\n${o.quote.trim().split(/\r?\n/).map((l) => `> ${l}`).join("\n")}\n` : "\n";
  const body = `${o.text.replace(/\r\n/g, "\n").trimEnd()}${quoted}`.replace(/\n/g, "\r\n");
  const headers = [
    `From: ${o.user}`,
    `To: ${o.to.name ? `${encodeWord(o.to.name.replace(/["\\]/g, ""))} ` : ""}<${o.to.address}>`,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${rfc2822(o.date)}`,
    `Message-ID: <${o.id}@${domain}>`,
    ...(o.messageId ? [`In-Reply-To: ${o.messageId}`] : []),
    ...(refs ? [`References: ${refs}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${wrap76(b64(body))}`;
};

// the drafts folder from LIST: the one marked \Drafts (RFC 6154), else one named 임시보관함 / Drafts
const DRAFT_NAMES = ["임시보관함", "임시 보관함", "임시저장함", "drafts", "draft", "보낼 편지함"];
type Box = { raw: string; name: string; leaf: string; attrs: string[] };
export const mailboxes = (untagged: string[]): Box[] =>
  untagged.flatMap((line) => {
    const m = /^\* LIST /i.exec(line);
    if (!m) return [];
    const [attrs, delim, name] = parseValues(line, m[0].length);
    const raw = text(name);
    const d = text(delim);
    return [{ raw, name: decodeMailbox(raw), leaf: decodeMailbox(d ? raw.split(d).at(-1) ?? raw : raw), attrs: Array.isArray(attrs) ? attrs.map((a) => text(a).toLowerCase()) : [] }];
  });
export const draftsFolder = (all: Box[]): { raw: string; name: string } | undefined => {
  const boxes = all.filter((b) => !b.attrs.includes("\\noselect"));
  const hit = boxes.find((b) => b.attrs.includes("\\drafts")) ?? DRAFT_NAMES.map((n) => boxes.find((b) => b.leaf.toLowerCase() === n)).find(Boolean);
  return hit && { raw: hit.raw, name: hit.name };
};

export const mailRun = async (action: MailAction, o: MailOptions, d: MailDeps): Promise<string[]> => {
  const password = d.password ?? "";
  try {
    return await mailCall(action, o, d);
  } catch (e) {
    if (e instanceof MailError) throw new MailError(e.code, redact(e.message.slice(e.code.length + 1), [password]));
    throw new MailError("MAIL_FAIL", redact(e instanceof Error ? e.message : String(e), [password]));
  }
};

const mailCall = async (action: MailAction, o: MailOptions, d: MailDeps): Promise<string[]> => {
  const user = d.user?.trim() ?? "";
  const password = d.password ?? "";
  const filter: Filter = { senders: parseSenders(d.senders), keywords: parseKeywords(d.keywords) };
  const noFilter = !filter.senders.addresses.size && !filter.senders.domains.size && !filter.keywords.length;
  const missing = [user ? "" : "DORI_MAIL_IMAP_USER", password ? "" : "DORI_MAIL_IMAP_PASSWORD", noFilter ? "DORI_MAIL_SENDERS or DORI_MAIL_SUBJECT_KEYWORDS" : ""].filter(Boolean);
  if (missing.length) throw new MailError("MAIL_NOT_CONFIGURED", `${missing.join(", ")} not set in ${d.envFile} (the owner puts them there; see setups/naverworks-mail/README.md)`);
  // check every option before connecting
  const uid = action === "list" ? "" : uidOf(o.uid, action);
  const since = action === "list" ? day(o.since, "since") ?? new Date(d.now().getTime() - 7 * 86400_000) : undefined;
  const until = action === "list" ? day(o.until, "until") : undefined;
  const limit = o.limit === undefined ? 30 : Number(o.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new MailError("MAIL_USAGE", "--limit is a whole number from 1 to 500");
  // --from only narrows: a mail it names still has to pass the configured filter
  const only = o.from?.trim() ? parseSenders(o.from) : undefined;
  if (action === "draft" && !o.text?.trim()) throw new MailError("MAIL_USAGE", "draft needs --text TEXT or --text-file FILE");
  if (!quotable(user) || !quotable(password)) throw new MailError("MAIL_USAGE", "DORI_MAIL_IMAP_USER or DORI_MAIL_IMAP_PASSWORD has a character IMAP LOGIN cannot carry (outside printable ASCII)");

  const host = d.host?.trim() || "imap.worksmobile.com";
  const port = Number(d.port?.trim() || 993);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MailError("MAIL_USAGE", "DORI_MAIL_IMAP_PORT is not a port");
  let imap: Imap;
  try {
    imap = new Imap((d.open ?? tlsOpener)(host, port), [password], d.timeoutMs ?? 30_000);
  } catch (e) {
    throw new MailError("MAIL_FAIL", `could not connect to ${host}:${port}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await imap.greeting();
    await imap.run(`LOGIN ${quote(user)} ${quote(password)}`, undefined, "LOGIN");
    await imap.run(`EXAMINE INBOX`);

    if (action === "list") {
      // the server narrows by day only; sender and subject are matched here on the decoded headers
      const search = await imap.run(`UID SEARCH SINCE ${imapDate(since!)}${until ? ` BEFORE ${imapDate(until)}` : ""}`);
      const uids = search.untagged.flatMap((l) => (/^\* SEARCH/i.test(l) ? l.replace(/^\* SEARCH/i, "").trim().split(/\s+/).filter(Boolean) : []))
        .map(Number).filter((n) => n > 0).sort((a, b) => b - a);
      const rows: Summary[] = [];
      // newest first, in batches, until the limit is filled with mail the exact list allows
      for (let at = 0; at < uids.length && rows.length < limit; at += 100) {
        const got = fetched((await imap.run(`UID FETCH ${uids.slice(at, at + 100).join(",")} ${summaryFetch}`)).untagged);
        for (const u of uids.slice(at, at + 100)) {
          const rec = got.get(String(u));
          if (!rec) continue;
          const s = summarize(String(u), rec);
          if (passes(s, filter) && (!only || allowed(s.from, only)) && rows.length < limit) rows.push(s);
        }
      }
      return [`MAIL_LIST ${rows.length}`, ...rows.map((s) => JSON.stringify({ uid: Number(s.uid), date: s.date, from: s.from, name: s.name, subject: s.subject, seen: s.seen, attachments: attachmentsOf(s).map((a) => a.name) }))];
    }

    const rec = fetched((await imap.run(`UID FETCH ${uid} ${summaryFetch}`)).untagged).get(uid);
    if (!rec) throw new MailError("MAIL_FAIL", `no mail with uid ${uid} in INBOX`);
    const s = summarize(uid, rec);
    if (!passes(s, filter)) throw new MailError("MAIL_REFUSED", `uid ${uid} is neither from a sender in DORI_MAIL_SENDERS nor has a DORI_MAIL_SUBJECT_KEYWORDS word in its subject; nothing was ${action === "read" ? "read" : "written"}`);
    // the body: the first text/plain part that is not an attachment, else the first text/html one
    const body = s.parts.find((p) => p.type === "text" && p.subtype === "plain" && !isAttachment(p)) ?? s.parts.find((p) => p.type === "text" && p.subtype === "html" && !isAttachment(p));
    let bodyText = "";
    if (body) {
      const got = fetched((await imap.run(`UID FETCH ${uid} (UID BODY.PEEK[${body.section}])`)).untagged).get(uid) ?? {};
      bodyText = decodePart(bodyItem(got, `BODY[${body.section}]`), body);
      if (body.subtype === "html") bodyText = htmlToText(bodyText);
    }
    bodyText = bodyText.replace(/\r\n/g, "\n").trim();

    if (action === "read") {
      return [
        `MAIL_READ ${uid}`,
        JSON.stringify({ uid: Number(uid), date: s.date, from: s.from, name: s.name, to: s.to, cc: s.cc, subject: s.subject, seen: s.seen, attachments: attachmentsOf(s) }),
        "",
        bodyText,
      ];
    }

    const listed = mailboxes((await imap.run(`LIST "" "*"`)).untagged);
    // a server may give the \Drafts attribute only when asked for special-use folders (RFC 6154)
    const special = draftsFolder(listed) ? [] : mailboxes((await imap.run(`LIST (SPECIAL-USE) "" "*"`).catch(() => ({ untagged: [] }))).untagged);
    const box = draftsFolder(listed) ?? draftsFolder(special);
    if (!box) throw new MailError("MAIL_FAIL", `no drafts folder found (none marked \\Drafts or named 임시보관함 / Drafts among ${listed.map((b) => JSON.stringify(b.name)).join(", ") || "no folders"}); nothing was written`);
    const message = replyMessage({
      user, to: { address: s.from, name: s.name }, subject: s.subject, messageId: s.messageId, references: s.references, text: o.text!,
      quote: bodyText, quotedDate: s.date ? new Date(s.date).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "", date: d.now(), id: d.newId(),
    });
    const appended = await imap.run(`APPEND ${quote(box.raw)} (\\Draft)`, Buffer.from(message, "utf8"));
    const newUid = /\[APPENDUID \d+ (\d+)\]/i.exec(appended.text)?.[1];
    return [`MAIL_DRAFTED ${JSON.stringify({ folder: box.name, uid: newUid ? Number(newUid) : null, reply_to: Number(uid), to: s.from, in_reply_to: s.messageId || null })}`];
  } finally {
    imap.close();
  }
};

import { afterEach, expect, test } from "bun:test";

import { commandProblem, decodeMailbox, decodeWords, encodeMailbox, MailError, mailRun, plainOpener, type MailDeps } from "../src/mail.ts";
import { DRAFTS_RAW, type FakeImap, fixtureMails, startFakeImap } from "./fake-imap.ts";

const USER = "hyerin@skku.edu";
const PASSWORD = 'app-"pw"\\Secret-77';
let server: FakeImap | undefined;
afterEach(() => server?.stop());

const deps = (port: number, over: Partial<MailDeps> = {}): MailDeps => ({
  host: "127.0.0.1", port: String(port), user: USER, password: PASSWORD, senders: "prof@lab.example, @skku.edu", envFile: "dori.env",
  now: () => new Date("2026-11-13T12:00:00Z"), open: plainOpener, timeoutMs: 5000, newId: () => "draft-id-1", ...over,
});
const start = (echoPasswordOnFail = false): FakeImap => (server = startFakeImap({ user: USER, password: PASSWORD, mails: fixtureMails(), echoPasswordOnFail }));
const flagsOf = (s: FakeImap) => s.mails.map((m) => [m.uid, [...m.flags]]);
const err = (p: Promise<unknown>): Promise<string> => p.then(() => "no error", (e: Error) => `${e instanceof MailError ? "" : "NOT_MAILERROR "}${e.message}`);

test("list: the last week's mail from the senders only, newest first, decoded, with attachment names; nothing marked read", async () => {
  const s = start();
  const before = flagsOf(s);
  const lines = await mailRun("list", {}, deps(s.port));
  expect(lines[0]).toBe("MAIL_LIST 2");
  expect(lines.slice(1).map((l) => JSON.parse(l))).toEqual([
    { uid: 12, date: "2026-11-12T23:00:00.000Z", from: "office@skku.edu", name: "", subject: "안녕", seen: true, attachments: [] },
    { uid: 11, date: "2026-11-12T01:00:00.000Z", from: "prof@lab.example", name: "송자연", subject: "보고서 검토 요청", seen: false, attachments: ["보고서.pdf"] },
  ]);
  expect(flagsOf(s)).toEqual(before);
  expect(s.log.find((c) => /^SELECT /i.test(c))).toBeUndefined();
  expect(s.log).toContain("EXAMINE INBOX");
});

test("list --since/--until/--from/--limit narrow the window, the sender and the count", async () => {
  const s = start();
  const old = await mailRun("list", { since: "2026-09-30", until: "2026-10-02" }, deps(s.port));
  expect(old.map((l) => (l.startsWith("{") ? JSON.parse(l).uid : l))).toEqual(["MAIL_LIST 1", 9]);
  const prof = await mailRun("list", { from: "prof@lab.example" }, deps(s.port));
  expect(prof.map((l) => (l.startsWith("{") ? JSON.parse(l).uid : l))).toEqual(["MAIL_LIST 1", 11]);
  // --from naming a sender outside the filter narrows to nothing: it never widens the filter
  expect(await mailRun("list", { from: "ads@outside.example" }, deps(s.port))).toEqual(["MAIL_LIST 0"]);
  expect((await mailRun("list", { limit: "1" }, deps(s.port)))[0]).toBe("MAIL_LIST 1");
  for (const [o, msg] of [[{ since: "2026-13-01" }, "--since is a day"], [{ limit: "0" }, "--limit"], [{ until: "tomorrow" }, "--until is a day"]] as const)
    expect(await err(mailRun("list", o, deps(s.port)))).toContain(`MAIL_USAGE ${msg}`);
});

test("a subject keyword lets a mail from outside the senders through; without one it stays out of list, read and draft", async () => {
  const s = start();
  const kw = await mailRun("list", {}, deps(s.port, { keywords: " Buy now ,세미나" }));
  expect(kw.slice(1).map((l) => JSON.parse(l).uid)).toEqual([13, 12, 11]);
  expect(await err(mailRun("read", { uid: "13" }, deps(s.port)))).toContain("MAIL_REFUSED uid 13 is neither from a sender");
  expect(await err(mailRun("draft", { uid: "13", text: "no" }, deps(s.port)))).toContain("MAIL_REFUSED uid 13");
  expect(s.appended).toEqual([]);
  expect((await mailRun("read", { uid: "13" }, deps(s.port, { keywords: "buy" })))[0]).toBe("MAIL_READ 13");
  // only keywords set (no senders) is a working filter too
  expect((await mailRun("list", {}, deps(s.port, { senders: "", keywords: "buy" })))[0]).toBe("MAIL_LIST 1");
});

test("subject keywords match the decoded subject: a Korean word inside it, and FW: in any case", async () => {
  const b64 = (t: string): string => Buffer.from(t, "utf8").toString("base64");
  const extra = (uid: number, subject: string) => ({
    uid, internal: "13-Nov-2026 10:00:00 +0900", flags: [] as string[], sections: { "1": Buffer.from("x") },
    headers: `From: someone@other.example\r\nSubject: ${subject}\r\nDate: Fri, 13 Nov 2026 10:00:00 +0900\r\nMessage-ID: <x${uid}@other.example>\r\n\r\n`,
    bodystructure: `("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 1 1 NIL NIL NIL NIL)`,
  });
  const s = (server = startFakeImap({ user: USER, password: PASSWORD, mails: [...fixtureMails(), extra(20, `=?UTF-8?B?${b64("[산학협력단] 2026 연차보고서 제출 안내")}?=`), extra(21, "Fw: meeting notes"), extra(22, "fwd notes"), extra(23, `=?UTF-8?B?${b64("과 제출")}?=`)] }));
  const lines = await mailRun("list", {}, deps(s.port, { senders: "", keywords: "과제,연차보고서,회신 요청,성균관대학교,FW:,산학협력단" }));
  expect(lines.slice(1).map((l) => [JSON.parse(l).uid, JSON.parse(l).subject])).toEqual([[21, "Fw: meeting notes"], [20, "[산학협력단] 2026 연차보고서 제출 안내"]]);
});

test("read: decoded text (UTF-8 base64 and EUC-KR quoted-printable HTML), attachment name and size; PEEK only, flags unchanged", async () => {
  const s = start();
  const before = flagsOf(s);
  const prof = await mailRun("read", { uid: "11" }, deps(s.port));
  expect(prof[0]).toBe("MAIL_READ 11");
  expect(JSON.parse(prof[1]!)).toEqual({
    uid: 11, date: "2026-11-12T01:00:00.000Z", from: "prof@lab.example", name: "송자연", to: "hyerin@skku.edu", cc: "", subject: "보고서 검토 요청", seen: false,
    attachments: [{ name: "보고서.pdf", size: 3000 }],
  });
  expect(prof.slice(2)).toEqual(["", "혜린 씨, 보고서 확인 부탁해요.\n감사합니다."]);
  const school = await mailRun("read", { uid: "12" }, deps(s.port));
  expect(school[3]).toBe("안녕 & welcome\nline2");
  expect(flagsOf(s)).toEqual(before);
  const fetches = s.log.filter((c) => /^UID FETCH/i.test(c));
  expect(fetches.length).toBeGreaterThan(0);
  expect(fetches.filter((c) => /(^|[\s(])BODY\[/i.test(c) || /RFC822[\s)]/i.test(c))).toEqual([]);
  expect(await err(mailRun("read", { uid: "77" }, deps(s.port)))).toContain("MAIL_FAIL no mail with uid 77");
  expect(await err(mailRun("read", { uid: "1:*" }, deps(s.port)))).toContain("MAIL_USAGE read needs the mail's uid");
});

test("draft: an APPEND with \\Draft to the drafts folder LIST names 임시보관함, a reply to the sender with In-Reply-To and References", async () => {
  const s = start();
  const before = flagsOf(s);
  const lines = await mailRun("draft", { uid: "11", text: "교수님, 확인했습니다.\n수요일까지 보내드리겠습니다." }, deps(s.port));
  expect(lines).toEqual([`MAIL_DRAFTED ${JSON.stringify({ folder: "임시보관함", uid: 101, reply_to: 11, to: "prof@lab.example", in_reply_to: "<m11@lab.example>" })}`]);
  expect(s.appended.length).toBe(1);
  const { box, flags, message } = s.appended[0]!;
  expect([box, flags]).toEqual([DRAFTS_RAW, "\\Draft"]);
  const raw = message.toString("utf8");
  const [head = "", body = ""] = raw.split("\r\n\r\n");
  const h = Object.fromEntries(head.split("\r\n").map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
  expect(decodeWords(h.to!)).toBe("송자연 <prof@lab.example>");
  expect(h.from).toBe(USER);
  expect(decodeWords(h.subject!)).toBe("Re: 보고서 검토 요청");
  expect(h["in-reply-to"]).toBe("<m11@lab.example>");
  expect(h.references).toBe("<m10@lab.example> <m11@lab.example>");
  expect(h["message-id"]).toBe("<draft-id-1@skku.edu>");
  const text = Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
  expect(text.startsWith("교수님, 확인했습니다.\r\n수요일까지 보내드리겠습니다.\r\n\r\n")).toBe(true);
  expect(text).toContain("> 혜린 씨, 보고서 확인 부탁해요.\r\n> 감사합니다.");
  expect(raw.split("\r\n").every((l) => l.length <= 998)).toBe(true);
  // the mailbox itself is untouched: same mails, same flags; the only write is that one APPEND
  expect(flagsOf(s)).toEqual(before);
  expect(s.log.filter((c) => !/^(LOGIN|EXAMINE|UID SEARCH|UID FETCH|LIST|APPEND|LOGOUT)\b/i.test(c))).toEqual([]);
  expect(await err(mailRun("draft", { uid: "11", text: "  " }, deps(s.port)))).toContain("MAIL_USAGE draft needs --text");
});

test("draft finds a drafts folder LIST (SPECIAL-USE) marks when plain LIST gives no attribute or known name, and names the folders when none is found", async () => {
  const boxes = ['* LIST () "/" "INBOX"', '* LIST () "/" "Box9"'];
  let s = (server = startFakeImap({ user: USER, password: PASSWORD, mails: fixtureMails(), boxes, specialUse: ['* LIST (\\Drafts) "/" "Box9"'] }));
  expect(JSON.parse((await mailRun("draft", { uid: "11", text: "ok" }, deps(s.port)))[0]!.slice("MAIL_DRAFTED ".length)).folder).toBe("Box9");
  expect(s.appended.map((a) => a.box)).toEqual(["Box9"]);
  s.stop();
  s = server = startFakeImap({ user: USER, password: PASSWORD, mails: fixtureMails(), boxes });
  expect(await err(mailRun("draft", { uid: "11", text: "ok" }, deps(s.port)))).toBe('MAIL_FAIL no drafts folder found (none marked \\Drafts or named 임시보관함 / Drafts among "INBOX", "Box9"); nothing was written');
  expect(s.appended).toEqual([]);
});

test("only read-only commands and APPEND leave: STORE, COPY, MOVE, EXPUNGE, SELECT and a FETCH without PEEK are refused", () => {
  for (const ok of ["LOGIN \"a\" \"b\"", "EXAMINE INBOX", "UID SEARCH SINCE 1-Nov-2026", "UID FETCH 1 (UID BODY.PEEK[1])", 'LIST "" "*"', "APPEND \"x\" (\\Draft)", "LOGOUT"])
    expect([ok, commandProblem(ok)]).toEqual([ok, undefined]);
  for (const bad of ["UID STORE 1 +FLAGS (\\Seen)", "STORE 1 -FLAGS (\\Seen)", "UID COPY 1 Trash", "UID MOVE 1 Trash", "EXPUNGE", "UID EXPUNGE 1", "SELECT INBOX",
    "DELETE Drafts", "UID FETCH 1 (BODY[1])", "UID FETCH 1 (UID BODY[])", "UID FETCH 1 RFC822", "UID FETCH 1 (RFC822.TEXT)", "AUTHENTICATE PLAIN"])
    expect([bad, typeof commandProblem(bad)]).toEqual([bad, "string"]);
});

test("the password shows in no line or error, also when the server echoes it back on a failed login", async () => {
  const s = start(true);
  const wrong = 'wrong-"pw"\\Other-88';
  const e1 = await err(mailRun("list", {}, deps(s.port, { password: wrong })));
  expect(e1).toContain("MAIL_FAIL LOGIN: NO");
  expect(e1).toContain(USER);
  for (const leak of [wrong, JSON.stringify(wrong).slice(1, -1), wrong.replace(/(["\\])/g, "\\$1"), "Other-88"]) expect([leak, e1.includes(leak)]).toEqual([leak, false]);
  const ok = (await mailRun("list", {}, deps(s.port))).join("\n") + (await mailRun("read", { uid: "11" }, deps(s.port))).join("\n");
  expect(ok.includes("Secret-77")).toBe(false);
  const refused = await err(mailRun("read", { uid: "13" }, deps(s.port)));
  expect(refused.includes("Secret-77")).toBe(false);
});

test("not configured or unreachable: MAIL_NOT_CONFIGURED names the missing keys, a dead port is MAIL_FAIL, neither shows the password", async () => {
  expect(await err(mailRun("list", {}, deps(1, { user: "", senders: " ", keywords: "" })))).toBe(
    "MAIL_NOT_CONFIGURED DORI_MAIL_IMAP_USER, DORI_MAIL_SENDERS or DORI_MAIL_SUBJECT_KEYWORDS not set in dori.env (the owner puts them there; see setups/naverworks-mail/README.md)");
  expect(await err(mailRun("list", {}, deps(1, { senders: "not-an-address" })))).toContain("MAIL_USAGE DORI_MAIL_SENDERS has");
  const dead = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = dead.port;
  dead.stop(true);
  const e = await err(mailRun("list", {}, deps(port)));
  expect(e).toStartWith("MAIL_FAIL");
  expect(e.includes("Secret-77")).toBe(false);
});

test("modified UTF-7 mailbox names decode and encode both ways", () => {
  expect(decodeMailbox(DRAFTS_RAW)).toBe("임시보관함");
  expect(encodeMailbox("임시보관함")).toBe(DRAFTS_RAW);
  expect(decodeMailbox("&vPSwuNO4ycDVaA-")).toBe("보낸편지함");
  expect([encodeMailbox("A&B 메일"), decodeMailbox(encodeMailbox("A&B 메일"))]).toEqual(["A&-B &ulTHfA-", "A&B 메일"]);
});

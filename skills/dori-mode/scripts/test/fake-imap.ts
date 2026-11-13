// A local IMAP server for dori mail tests: one INBOX, a drafts folder found by its name only (no \Drafts attribute, as
// NAVER WORKS answers), real \Seen semantics (a FETCH of BODY[...] without PEEK in a SELECTed mailbox marks the mail
// read) and a log of every command it was sent. Plain TCP, or TLS when given a certificate.
export type FakeMail = {
  uid: number; internal: string; flags: string[]; headers: string; bodystructure: string; sections: Record<string, Buffer>;
};
export type Appended = { box: string; flags: string; message: Buffer };
export type FakeImap = { port: number; log: string[]; mails: FakeMail[]; appended: Appended[]; stop: () => void };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const imapDay = (s: string): number => {
  const [d, m, y] = s.split("-");
  return Date.UTC(Number(y), MONTHS.indexOf(m!), Number(d));
};

export const DRAFTS_RAW = "&x4TC3Lz0rQDVaA-"; // 임시보관함 in modified UTF-7
export const BOXES = [`* LIST (\\HasNoChildren) "/" "INBOX"`, `* LIST (\\HasNoChildren) "/" "&vPSwuNO4ycDVaA-"`, `* LIST (\\HasNoChildren) "/" "${DRAFTS_RAW}"`];

export const startFakeImap = (o: { user: string; password: string; mails: FakeMail[]; echoPasswordOnFail?: boolean; tls?: { cert: string; key: string }; boxes?: string[]; specialUse?: string[] }): FakeImap => {
  const log: string[] = [];
  const appended: Appended[] = [];
  type State = { buf: Buffer; box: string; readOnly: boolean; auth: boolean; pending?: { tag: string; box: string; flags: string; size: number } };
  const answer = (sock: { write(d: string | Buffer): number; data: State }, line: string): void => {
    const st = sock.data;
    const [, tag = "*", rest = ""] = /^(\S+) (.*)$/.exec(line) ?? [];
    log.push(rest);
    const cmd = rest.toUpperCase();
    if (cmd.startsWith("LOGIN ")) {
      const [, u, p] = /^LOGIN "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/i.exec(rest) ?? [];
      const unq = (s = ""): string => s.replace(/\\(.)/g, "$1");
      if (unq(u) === o.user && unq(p) === o.password) {
        st.auth = true;
        sock.write(`${tag} OK LOGIN completed\r\n`);
      } else sock.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials${o.echoPasswordOnFail ? ` for ${unq(u)} ${unq(p)}` : ""}\r\n`);
      return;
    }
    if (!st.auth && !cmd.startsWith("LOGOUT") && !cmd.startsWith("CAPABILITY")) return void sock.write(`${tag} NO not logged in\r\n`);
    if (cmd.startsWith("EXAMINE ") || cmd.startsWith("SELECT ")) {
      st.box = "INBOX";
      st.readOnly = cmd.startsWith("EXAMINE");
      sock.write(`* ${o.mails.length} EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n${tag} OK [${st.readOnly ? "READ-ONLY" : "READ-WRITE"}] done\r\n`);
      return;
    }
    if (cmd.startsWith("LIST (SPECIAL-USE)")) return void sock.write(o.specialUse ? `${o.specialUse.map((l) => `${l}\r\n`).join("")}${tag} OK LIST done\r\n` : `${tag} BAD unknown LIST option\r\n`);
    if (cmd.startsWith("LIST ")) return void sock.write(`${(o.boxes ?? BOXES).map((l) => `${l}\r\n`).join("")}${tag} OK LIST done\r\n`);
    if (cmd.startsWith("UID SEARCH ")) {
      const since = /SINCE (\S+)/i.exec(rest)?.[1];
      const before = /BEFORE (\S+)/i.exec(rest)?.[1];
      const hits = o.mails.filter((m) => {
        const t = imapDay(m.internal.split(" ")[0]!);
        return (!since || t >= imapDay(since)) && (!before || t < imapDay(before));
      });
      return void sock.write(`* SEARCH ${hits.map((m) => m.uid).join(" ")}\r\n${tag} OK SEARCH done\r\n`);
    }
    if (cmd.startsWith("UID FETCH ")) {
      const [, set = "", items = ""] = /^UID FETCH (\S+) \((.*)\)$/i.exec(rest) ?? [];
      const uids = set.split(",").map(Number);
      const out: Buffer[] = [];
      o.mails.forEach((m, i) => {
        if (!uids.includes(m.uid)) return;
        const parts: (string | Buffer)[] = [`UID ${m.uid}`];
        const sectionRe = /BODY(\.PEEK)?\[([^\]]*)\]/gi;
        for (const [, peek, section = ""] of items.matchAll(sectionRe)) {
          if (!peek && !st.readOnly && !m.flags.includes("\\Seen")) m.flags.push("\\Seen");
          const data = section.startsWith("HEADER.FIELDS") ? Buffer.from(m.headers) : m.sections[section] ?? Buffer.alloc(0);
          parts.push(` BODY[${section}] {${data.length}}\r\n`, data);
        }
        if (/\bFLAGS\b/i.test(items)) parts.push(` FLAGS (${m.flags.join(" ")})`);
        if (/\bINTERNALDATE\b/i.test(items)) parts.push(` INTERNALDATE "${m.internal}"`);
        if (/\bBODYSTRUCTURE\b/i.test(items)) parts.push(` BODYSTRUCTURE ${m.bodystructure}`);
        out.push(Buffer.from(`* ${i + 1} FETCH (`), ...parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p)), Buffer.from(")\r\n"));
      });
      sock.write(Buffer.concat([...out, Buffer.from(`${tag} OK FETCH done\r\n`)]));
      return;
    }
    if (cmd.startsWith("APPEND ")) {
      const [, box = "", flags = "", size = "0"] = /^APPEND "([^"]*)" \(([^)]*)\) \{(\d+)\}$/i.exec(rest) ?? [];
      st.pending = { tag, box, flags, size: Number(size) };
      return void sock.write("+ Ready for literal data\r\n");
    }
    if (cmd.startsWith("LOGOUT")) return void sock.write(`* BYE bye\r\n${tag} OK LOGOUT done\r\n`);
    sock.write(`${tag} BAD unknown command\r\n`);
  };
  const handlers = {
    open(sock: { write(d: string): number; data: State }) {
      sock.data = { buf: Buffer.alloc(0), box: "", readOnly: false, auth: false };
      sock.write("* OK [CAPABILITY IMAP4rev1] fake ready\r\n");
    },
    data(sock: { write(d: string | Buffer): number; data: State }, chunk: Buffer) {
      const st = sock.data;
      st.buf = Buffer.concat([st.buf, chunk]);
      for (;;) {
        if (st.pending) {
          if (st.buf.length < st.pending.size + 2) return;
          const message = Buffer.from(st.buf.subarray(0, st.pending.size));
          st.buf = st.buf.subarray(st.pending.size + 2);
          appended.push({ box: st.pending.box, flags: st.pending.flags, message });
          sock.write(`${st.pending.tag} OK [APPENDUID 7 ${100 + appended.length}] APPEND completed\r\n`);
          st.pending = undefined;
          continue;
        }
        const eol = st.buf.indexOf("\r\n");
        if (eol < 0) return;
        const line = st.buf.subarray(0, eol).toString("utf8");
        st.buf = st.buf.subarray(eol + 2);
        answer(sock, line);
      }
    },
  };
  const server = Bun.listen<State>({ hostname: "127.0.0.1", port: 0, socket: handlers as never, ...(o.tls ? { tls: o.tls } : {}) });
  return { port: server.port, log, mails: o.mails, appended, stop: () => server.stop(true) };
};

// The test mails: a professor's mail with a Korean subject, body and attachment name (RFC 2231), a school mail in
// EUC-KR quoted-printable HTML, a mail from outside the senders, and an old mail outside the default week.
export const fixtureMails = (): FakeMail[] => {
  const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
  const profText = Buffer.from(`${b64("혜린 씨, 보고서 확인 부탁해요.\n감사합니다.")}\r\n`);
  const pdf = Buffer.from(`${Buffer.alloc(3000, 7).toString("base64").replace(/.{76}/g, "$&\r\n")}\r\n`);
  const euckr = Buffer.from([0xbe, 0xc8, 0xb3, 0xe7]); // 안녕 in EUC-KR
  const qp = [...euckr].map((b) => `=${b.toString(16).toUpperCase()}`).join("");
  const schoolHtml = Buffer.from(`<html><body><p>${qp}&nbsp;&amp; welcome</p><p>line2</p></body></html>\r\n`);
  return [
    {
      uid: 9, internal: "01-Oct-2026 09:00:00 +0900", flags: [],
      headers: "From: Prof <prof@lab.example>\r\nSubject: old\r\nDate: Thu, 01 Oct 2026 09:00:00 +0900\r\nMessage-ID: <m9@lab.example>\r\n\r\n",
      bodystructure: `("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 3 1 NIL NIL NIL NIL)`, sections: { "1": Buffer.from("old") },
    },
    {
      uid: 11, internal: "12-Nov-2026 10:00:00 +0900", flags: [],
      headers: `From: =?UTF-8?B?${b64("송자연")}?= <Prof@Lab.example>\r\nTo: hyerin@skku.edu\r\nSubject: =?UTF-8?B?${b64("보고서 검토")}?=\r\n =?UTF-8?B?${b64(" 요청")}?=\r\nDate: Thu, 12 Nov 2026 10:00:00 +0900\r\nMessage-ID: <m11@lab.example>\r\nReferences: <m10@lab.example>\r\n\r\n`,
      bodystructure: `(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "BASE64" ${profText.length} 1 NIL NIL NIL NIL)("APPLICATION" "PDF" ("NAME" "report.pdf") NIL NIL "BASE64" ${pdf.length} NIL ("ATTACHMENT" ("FILENAME*" "UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C.pdf")) NIL NIL) "MIXED" ("BOUNDARY" "b1") NIL NIL NIL)`,
      sections: { "1": profText, "2": pdf },
    },
    {
      uid: 12, internal: "13-Nov-2026 08:00:00 +0900", flags: ["\\Seen"],
      headers: `From: office@skku.edu\r\nSubject: =?ks_c_5601-1987?B?${euckr.toString("base64")}?=\r\nDate: Fri, 13 Nov 2026 08:00:00 +0900\r\nMessage-ID: <m12@skku.edu>\r\n\r\n`,
      bodystructure: `("TEXT" "HTML" ("CHARSET" "ks_c_5601-1987") NIL NIL "QUOTED-PRINTABLE" ${schoolHtml.length} 1 NIL NIL NIL NIL)`, sections: { "1": schoolHtml },
    },
    {
      uid: 13, internal: "13-Nov-2026 09:00:00 +0900", flags: [],
      headers: "From: Ads <ads@outside.example>\r\nSubject: buy now\r\nDate: Fri, 13 Nov 2026 09:00:00 +0900\r\nMessage-ID: <m13@outside.example>\r\n\r\n",
      bodystructure: `("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 7 1 NIL NIL NIL NIL)`, sections: { "1": Buffer.from("buy now") },
    },
  ];
};

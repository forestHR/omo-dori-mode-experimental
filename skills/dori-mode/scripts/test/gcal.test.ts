import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkApproval, gcalRun, isYes, redact } from "../src/gcal.ts";
import type { Question } from "../src/messenger/discord-cards.ts";

const SECRET = "gcal-secret-XYZ-never-printed";
const card = (id: string, status: Question["status"], message?: string, answer = "넣어"): Question => ({
  id, text: "일정 넣을까?", options: [], channel: "c", thread: null, session: null, tmux: null, created: "2026-11-11T00:00:00Z", status,
  ...(message ? { message } : {}), ...(status === "answered" ? { answer, answerKind: "button" as const, answeredAt: "2026-11-11T00:01:00Z" } : {}),
});
const CARDS = [card("Q1", "answered", "111"), card("Q2", "open", "222"), card("Q3", "answered", "555", "아니, 다음에")];
const OWNER = "900000000000000001";
const authors: Record<string, string> = { "8/333": OWNER, "8/444": "900000000000000002" };
const author = async (c: string, m: string) => authors[`${c}/${m}`];

test("approval: an answered yes card, a link to one, or a link Discord says the owner wrote passes; anything else is refused", async () => {
  expect(await checkApproval("Q1", CARDS)).toEqual({ ref: "Q1", kind: "card" });
  expect(await checkApproval("https://discord.com/channels/9/8/111", CARDS)).toEqual({ ref: "https://discord.com/channels/9/8/111", kind: "card" });
  expect(await checkApproval("https://discord.com/channels/9/8/333", CARDS, OWNER, author)).toEqual({ ref: "https://discord.com/channels/9/8/333", kind: "link" });
  for (const [ref, code, who] of [[undefined, "no_approval"], ["  ", "no_approval"], ["Q2", "approval_open"], ["Q9", "approval_unknown"], ["Q3", "approval_declined"],
    ["https://discord.com/channels/9/8/222", "approval_open"], ["https://discord.com/channels/9/8/555", "approval_declined"], ["yes", "approval_malformed"],
    ["https://evil.example/channels/1/2/3", "approval_malformed"],
    ["https://discord.com/channels/9/8/333", "approval_unverifiable", "none"], ["https://discord.com/channels/9/8/777", "approval_unverifiable"],
    ["https://discord.com/channels/9/8/444", "approval_not_owner"]] as const) {
    const lookup = who === "none" ? undefined : author;
    await expect(checkApproval(ref, CARDS, OWNER, lookup)).rejects.toThrow(`GCAL_REFUSED ${code}`);
  }
  await expect(checkApproval("https://discord.com/channels/9/8/333", CARDS, OWNER, async () => { throw new Error("403"); })).rejects.toThrow("GCAL_REFUSED approval_unverifiable");
});

test("only a plain yes approves: an answer with a negation anywhere, or no yes at its start, does not", async () => {
  for (const yes of ["네", "네, 넣어줘", "승인", "넣어", "지워", "응 해줘", "좋아요", "OK", "yes"]) expect([yes, isYes(yes)]).toEqual([yes, true]);
  for (const no of ["지우지 마", "안 넣어", "넣지 마세요", "아니", "네 아니 잠깐", "나중에", "보류", "no", "yes but not now", "몰라", ""]) expect([no, isYes(no)]).toEqual([no, false]);
  const dont = [...CARDS, card("Q4", "answered", "666", "지우지 마")];
  await expect(checkApproval("Q4", dont)).rejects.toThrow("GCAL_REFUSED approval_declined");
});

test("a secret with a quote or backslash is hidden in printed lines, the log and every error", async () => {
  // Xuo and Wte sit between the characters JSON escapes, so they show in the raw and the escaped secret alike
  const secret = 'Zq"Xuo\\Wte\nVline';
  const file = join(mkdtempSync(join(tmpdir(), "gcal-hide-")), "w.jsonl");
  const fetchFake = async (_u: string, init: RequestInit) => init.method === "POST"
    ? new Response(null, { status: 302, headers: { location: "https://echo.example/x" } })
    : Response.json({ ok: true, event: { id: "ev", title: `t ${secret}`, start: "s", end: "e", location: "", dori: true } });
  const deps = { url: "https://script.example/exec", secret, envFile: "env", cards: () => CARDS, writesFile: file, now: () => new Date(0), newId: () => "r", fetch: fetchFake };
  const lines = await gcalRun("create", { title: "t", start: "2026-11-12T10:00+09:00", end: "2026-11-12T11:00+09:00", approval: "Q1" }, deps);
  expect(lines.join("\n")).toContain("<hidden>");
  expect([lines.join("\n"), readFileSync(file, "utf8")].some((t) => t.includes(JSON.stringify(secret).slice(1, -1)) || t.includes(secret))).toBe(false);
  const bad = [...CARDS, card("Q5", "answered", "777", `말고 ${secret}`)];
  const err = await gcalRun("delete", { id: "ev", approval: "Q5" }, { ...deps, cards: () => bad }).catch((e: Error) => e.message);
  expect(String(err)).toContain("approval_declined");
  expect([String(err).includes("Xuo"), String(err).includes("Wte")]).toEqual([false, false]);
});

test("redact hides every secret value and any URL", () => {
  expect(redact(`fetch https://script.google.com/macros/s/AKfy/exec failed with ${SECRET}`, [SECRET])).toBe("fetch <url> failed with <hidden>");
});

// A fake web app shaped like Apps Script: POST /exec answers 302 to a one-time echo address served on GET.
type Hit = { method: string; path: string; body?: Record<string, unknown> };
let dir = "";
let hits: Hit[] = [];
let reply: (body: Record<string, unknown>) => Record<string, unknown> = () => ({ ok: true, events: [] });
let server: ReturnType<typeof Bun.serve>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gcal-test-"));
  hits = [];
  const replies = new Map<string, string>();
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
    const u = new URL(req.url);
    const msg = /^\/api\/channels\/(\d+)\/messages\/(\d+)$/.exec(u.pathname);
    if (req.method === "GET" && msg) {
      hits.push({ method: "GET", path: "discord message" });
      const who = authors[`${msg[1]}/${msg[2]}`];
      return who ? Response.json({ id: msg[2], author: { id: who } }) : Response.json({ message: "Unknown Message" }, { status: 404 });
    }
    if (req.method === "POST" && u.pathname === "/macros/s/DEPLOY/exec") {
      const body = (await req.json()) as Record<string, unknown>;
      hits.push({ method: "POST", path: u.pathname, body });
      const key = String(replies.size + 1);
      replies.set(key, JSON.stringify(reply(body)));
      return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${server.port}/macros/echo?user_content_key=${key}` } });
    }
    hits.push({ method: req.method, path: u.pathname });
    const out = req.method === "GET" && u.pathname === "/macros/echo" ? replies.get(u.searchParams.get("user_content_key") ?? "") : undefined;
    return out ? new Response(out, { headers: { "content-type": "application/json" } }) : new Response("<html>sign in</html>", { status: 200 });
  } });
  mkdirSync(join(dir, "discord"), { recursive: true });
  writeFileSync(join(dir, "discord", "questions.json"), JSON.stringify({ seq: 2, questions: CARDS }));
});
afterEach(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const url = () => `http://127.0.0.1:${server.port}/macros/s/DEPLOY/exec`;
const withDiscord = () => ({ DORI_GCAL_URL: url(), DORI_GCAL_SECRET: SECRET, DORI_DISCORD_TOKEN: `${Buffer.from("123456789012345678").toString("base64")}.x.y`,
  DORI_DISCORD_API: `http://127.0.0.1:${server.port}/api`, DORI_DISCORD_OWNER: OWNER });
const posts = () => hits.filter((h) => h.method === "POST").length;
const dori = async (args: string[], env: Record<string, string> = { DORI_GCAL_URL: url(), DORI_GCAL_SECRET: SECRET }) => {
  // the address and secret reach the CLI only through its dori.env, as on a Dori
  writeFileSync(join(dir, "dori.env"), Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join(""));
  const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "gcal", ...args], {
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TEMP: tmpdir(), TMP: tmpdir(), DORI_CONFIG: join(dir, "missing.json"), DORI_STATE_DIR: dir, DORI_ENV_FILE: join(dir, "dori.env") },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const shown = out + err;
  expect(shown).not.toContain(SECRET);
  expect(shown).not.toContain(`127.0.0.1:${server.port}`);
  return { out, err, code };
};
const writes = (): Record<string, unknown>[] => {
  const f = join(dir, "gcal", "writes.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};

test("read posts the secret in the body, follows the 302 with GET and prints the events", async () => {
  reply = () => ({ ok: true, events: [{ id: "e1", title: "랩미팅", start: "2026-11-12T01:00:00.000Z", end: "2026-11-12T02:00:00.000Z", location: "", dori: false }] });
  const r = await dori(["read", "--from", "2026-11-12T00:00+09:00", "--to", "2026-11-13T00:00+09:00"]);
  expect(r.code).toBe(0);
  expect(r.out.trim().split("\n")).toEqual(["GCAL_EVENTS 1", JSON.stringify({ id: "e1", title: "랩미팅", start: "2026-11-12T01:00:00.000Z", end: "2026-11-12T02:00:00.000Z", location: "", dori: false })]);
  expect(hits.map((h) => `${h.method} ${h.path}`)).toEqual(["POST /macros/s/DEPLOY/exec", "GET /macros/echo"]);
  expect(hits[0]!.body).toEqual({ action: "read", start: "2026-11-11T15:00:00.000Z", end: "2026-11-12T15:00:00.000Z", secret: SECRET });
  expect(writes()).toEqual([]);
});

test("whatever the web app echoes back is printed and logged without the secret or address", async () => {
  reply = (b) => ({ ok: true, event: { id: "ev2", title: `${b.title} ${SECRET} ${url()}`, start: b.start, end: b.end, location: "", dori: true } });
  const r = await dori(["create", "--title", "echo", "--start", "2026-11-12T10:00+09:00", "--end", "2026-11-12T10:30+09:00", "--approval", "Q1"]);
  expect(r.out).toContain("<hidden>");
  expect(readFileSync(join(dir, "gcal", "writes.jsonl"), "utf8")).not.toContain(SECRET);
  reply = () => ({ ok: true, events: [{ id: "e1", title: SECRET, start: "2026-11-12T01:00:00.000Z", end: "2026-11-12T02:00:00.000Z", location: url(), dori: false }] });
  expect((await dori(["read", "--from", "2026-11-12", "--to", "2026-11-13"])).out).toContain('"title":"<hidden>"');
});

test("create with an answered card sends it, prints the event and logs the write without the secret", async () => {
  reply = (b) => ({ ok: true, event: { id: "ev1", title: b.title, start: b.start, end: b.end, location: "", dori: true, reminder_minutes: b.reminder_minutes ?? 30 } });
  const r = await dori(["create", "--title", "도리 시험", "--start", "2026-11-12T10:00+09:00", "--end", "2026-11-12T10:30+09:00", "--reminder", "10", "--approval", "Q1", "--request-id", "req-1"]);
  expect(r.code).toBe(0);
  expect(r.out).toStartWith("GCAL_CREATED ev1 ");
  expect(hits[0]!.body).toEqual({ action: "create", title: "도리 시험", start: "2026-11-12T01:00:00.000Z", end: "2026-11-12T01:30:00.000Z", request_id: "req-1", reminder_minutes: 10, approval: "Q1", secret: SECRET });
  const [w] = writes();
  expect(w).toMatchObject({ action: "create", approval: "Q1", approval_kind: "card", outcome: "ok", request_id: "req-1", event_id: "ev1", title: "도리 시험", reminder_minutes: 10 });
  expect(readFileSync(join(dir, "gcal", "writes.jsonl"), "utf8")).not.toContain(SECRET);
});

test("a write without approval, or with an open card, is refused before anything is sent", async () => {
  for (const extra of [[], ["--approval", "Q2"], ["--approval", "Q7"]]) {
    const r = await dori(["create", "--title", "x", "--start", "2026-11-12T10:00+09:00", "--end", "2026-11-12T11:00+09:00", ...extra]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("GCAL_REFUSED");
  }
  expect((await dori(["delete", "ev1"])).err).toContain("GCAL_REFUSED no_approval");
  expect(hits).toEqual([]);
  expect(writes()).toEqual([]);
});

test("a made-up Discord link is refused with no POST: unreadable without Discord, or not the owner's message", async () => {
  const create = ["create", "--title", "x", "--start", "2026-11-12T10:00+09:00", "--end", "2026-11-12T11:00+09:00", "--approval"];
  const blind = await dori([...create, "https://discord.com/channels/9/8/333"]);
  expect({ code: blind.code, refused: blind.err.includes("GCAL_REFUSED approval_unverifiable") }).toEqual({ code: 1, refused: true });
  const fake = await dori([...create, "https://discord.com/channels/9/8/777"], withDiscord());
  const other = await dori([...create, "https://discord.com/channels/9/8/444"], withDiscord());
  expect([fake.err.includes("approval_unverifiable"), other.err.includes("approval_not_owner")]).toEqual([true, true]);
  expect(posts()).toBe(0);
  expect(writes()).toEqual([]);
});

test("the web app's refusal of an event without the 도리 mark is printed and logged as refused", async () => {
  reply = () => ({ ok: false, error: "not_dori", detail: "this event has no 도리 mark; only events 도리 made can be changed" });
  const r = await dori(["delete", "owner@google.com", "--approval", "https://discord.com/channels/9/8/333"], withDiscord());
  expect(r.code).toBe(1);
  expect(r.err).toContain("GCAL_REFUSED web app: not_dori");
  expect(hits.map((h) => `${h.method} ${h.path}`)).toEqual(["GET discord message", "POST /macros/s/DEPLOY/exec", "GET /macros/echo"]);
  expect(writes()).toMatchObject([{ action: "delete", approval_kind: "link", outcome: "refused: not_dori", event_id: "owner@google.com" }]);
});

test("missing env, a sign-in page and an unreachable web app never print the address or secret", async () => {
  const none = await dori(["read", "--from", "2026-11-12", "--to", "2026-11-13"], {});
  expect({ code: none.code, line: none.err.trim() }).toMatchObject({ code: 2 });
  expect(none.err).toContain("GCAL_NOT_CONFIGURED DORI_GCAL_URL and DORI_GCAL_SECRET not set");
  const html = await dori(["read", "--from", "2026-11-12", "--to", "2026-11-13"], { DORI_GCAL_URL: `http://127.0.0.1:${server.port}/other`, DORI_GCAL_SECRET: SECRET });
  expect(html.code).toBe(1);
  expect(html.err).toContain("GCAL_FAIL web app answered an HTML page instead of JSON");
  const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const dead = `http://127.0.0.1:${closed.port}/macros/s/${SECRET}/exec`;
  closed.stop(true);
  const gone = await dori(["delete", "ev1", "--approval", "Q1"], { DORI_GCAL_URL: dead, DORI_GCAL_SECRET: SECRET });
  expect(gone.code).toBe(1);
  expect(gone.err).toContain("GCAL_FAIL web app not reached");
  const lost = await dori(["create", "--title", "x", "--start", "2026-11-12T10:00+09:00", "--end", "2026-11-12T11:00+09:00", "--approval", "Q1", "--request-id", "req-9"], { DORI_GCAL_URL: dead, DORI_GCAL_SECRET: SECRET });
  expect(lost.err).toContain("run the same create again with --request-id req-9");
  expect(gone.err).not.toContain(String(closed.port));
  expect(writes()).toMatchObject([{ action: "delete", outcome: expect.stringContaining("fail: GCAL_FAIL web app not reached") }, { action: "create", request_id: "req-9" }]);
  expect(readFileSync(join(dir, "gcal", "writes.jsonl"), "utf8")).not.toContain(SECRET);
});

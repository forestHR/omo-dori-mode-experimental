import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkApproval, redact } from "../src/gcal.ts";
import type { Question } from "../src/messenger/discord-cards.ts";

const SECRET = "gcal-secret-XYZ-never-printed";
const card = (id: string, status: Question["status"], message?: string): Question => ({
  id, text: "일정 넣을까?", options: [], channel: "c", thread: null, session: null, tmux: null, created: "2026-11-11T00:00:00Z", status,
  ...(message ? { message } : {}), ...(status === "answered" ? { answer: "넣어", answerKind: "button" as const, answeredAt: "2026-11-11T00:01:00Z" } : {}),
});
const CARDS = [card("Q1", "answered", "111"), card("Q2", "open", "222")];

test("approval: an answered card or an owner link passes; no reference, an open or unknown card, a link to an open card is refused", () => {
  expect(checkApproval("Q1", CARDS)).toEqual({ ref: "Q1", kind: "card" });
  expect(checkApproval("https://discord.com/channels/9/8/111", CARDS)).toEqual({ ref: "https://discord.com/channels/9/8/111", kind: "link" });
  expect(checkApproval("https://discord.com/channels/9/8/333", CARDS).kind).toBe("link");
  for (const [ref, code] of [[undefined, "no_approval"], ["  ", "no_approval"], ["Q2", "approval_open"], ["Q9", "approval_unknown"],
    ["https://discord.com/channels/9/8/222", "approval_open"], ["yes", "approval_malformed"], ["https://evil.example/channels/1/2/3", "approval_malformed"]] as const) {
    expect(() => checkApproval(ref, CARDS)).toThrow(`GCAL_REFUSED ${code}`);
  }
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

test("the web app's refusal of an event without the 도리 mark is printed and logged as refused", async () => {
  reply = () => ({ ok: false, error: "not_dori", detail: "this event has no 도리 mark; only events 도리 made can be changed" });
  const r = await dori(["delete", "owner@google.com", "--approval", "https://discord.com/channels/9/8/333"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("GCAL_REFUSED web app: not_dori");
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
  expect(gone.err).not.toContain(String(closed.port));
  expect(writes()).toMatchObject([{ action: "delete", outcome: expect.stringContaining("fail: GCAL_FAIL web app not reached") }]);
  expect(readFileSync(join(dir, "gcal", "writes.jsonl"), "utf8")).not.toContain(SECRET);
});

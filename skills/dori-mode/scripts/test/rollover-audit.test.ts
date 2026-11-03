import { readFrozen, writeFrozen } from "../src/frozen.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { freshnessTick } from "../src/freshness.ts";
import { ackHandover, manifestPath } from "../src/handover.ts";
import { type LaneFacts, type LaneHandoverDeps, renderLaneNote } from "../src/lane-handover.ts";
import type { Lane } from "../src/registry.ts";
import { QuestionStore } from "../src/messenger/discord-cards.ts";
import { appendRollover, ownerMessagesFor } from "../src/rollover.ts";
import { auditDue, auditHandover, auditLog, type Classify, committedHandovers, markerFile, ownerQuotes, readAudit, reportGap, scrubSecrets, sendAuditSummary, summaryWeek, userLines, weeklyDue } from "../src/rollover-audit.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const NEW = "aoe_demo-10191000_5e5e5e5e";
const CWD = "/work/demo";
const STAMP = "demo-20261019-100000";
const COMMIT = "2026-10-19T10:01:00.000Z";
const QUOTE = "표는 받은 메일에서도 꼭 보여야 해";
const OWNER_MSG = "1561666271257436232";
// a restatement under every heading the new session writes, with the lane's goal quoted
const RESTATE = "## Goal\n레인에도 적용: ship it\n## Owner's words\nnone\n## Decisions\nnone\n## Next step\nship it\n## Ruled out\nnone\n## Questions\nnone\n";

let state: { dir: string; done: () => void };
let w: World;
let handled: string[];
let fix: boolean;

const dir = (): string => join(state.dir, "handover", "lanes");
const stem = (): string => join(dir(), STAMP);
const sessionDir = (): string => sessionDirFor(join(state.dir, "sessions"), CWD);

const lane = (): Lane => ({ key: "demo", title: "Demo lane", thread: "discord:1", pane: NEW, session: "new-sid", brief: join(state.dir, "demo-brief.md"), done: "merged o/r#1", cwd: CWD, model: "anthropic-subscription/claude-opus-5-5:high", goal: "레인에도 적용", openedAt: "2026-10-18T00:00:00Z", status: "working" });

const said = (at: string, text: string): string => JSON.stringify({ type: "message", timestamp: at, message: { role: "user", content: [{ type: "text", text }] } });

// One committed lane handover on disk: the old session's log, the note, the facts, the result and the restatement.
const handover = (o: { readonly log: readonly string[]; readonly restate?: string; readonly todos?: readonly string[]; readonly newTodos?: readonly string[]; readonly monitors?: readonly unknown[]; readonly newMonitors?: readonly unknown[] }) => {
  mkdirSync(dir(), { recursive: true });
  mkdirSync(sessionDir(), { recursive: true });
  const oldLog = join(sessionDir(), "2026-10-18T00-00-00-000Z_old-sid.jsonl");
  writeFileSync(oldLog, o.log.join("\n"));
  writeFileSync(lane().brief, "Do the work. Done: merged o/r#1.\n");
  writeFileSync(`${stem()}.md`, "# Lane handover demo\n## Conversation summary\n(none)\n");
  writeFileSync(`${stem()}.json`, JSON.stringify({ lane: lane(), from: { pane: "aoe_demo_old", aoeId: "1a", session: "old-sid", title: "demo", cwd: CWD }, cwd: CWD, model: "anthropic-subscription/claude-opus-5-5", monitors: o.monitors ?? [], todos: o.todos ?? ["Work: ship it (in_progress)"], chains: [], detached: [], laneNote: "", signals: {}, oldLog }));
  writeFileSync(`${stem()}.result.json`, JSON.stringify({ at: COMMIT, key: "demo", from: {}, to: NEW, note: `${stem()}.md`, result: "done", reasons: [] }));
  writeFileSync(`${stem()}.understood.md`, o.restate ?? RESTATE);
  const todos = (o.newTodos ?? ["ship it"]).map((content) => ({ content, status: "in_progress" }));
  writeFileSync(join(sessionDir(), "2026-10-19T10-00-00-000Z_new-sid.jsonl"), JSON.stringify({ type: "custom", customType: "senpi.todo-state", data: { phases: [{ name: "Work", tasks: todos }] } }));
  const manifest = manifestPath(join(state.dir, "sessions"), CWD, "new-sid");
  mkdirSync(join(manifest, ".."), { recursive: true });
  writeFileSync(manifest, JSON.stringify({ version: 1, sessionId: "new-sid", monitors: o.newMonitors ?? [] }));
};

// The new session as the fake world sees it: a supplement line makes it add the items to its restatement (fix) and ack.
const simulate = () => {
  for (const line of sent(w)) {
    const m = /^\[LEAD\] HANDOVER_SUPPLEMENT (\S+) .*Read (\S+), add them to (\S+), then run/.exec(line);
    if (!m?.[1] || !m[2] || !m[3] || handled.includes(m[1])) continue;
    handled.push(m[1]);
    if (fix) {
      const items = [...readFileSync(m[2], "utf8").matchAll(/^## \d+\. [^:\n]+: (.*)$/gm)].map((x) => x[1] ?? "");
      writeFileSync(m[3], `${readFileSync(m[3], "utf8")}\n## Owner's words\n${items.map((t) => `"${t}"`).join("\n")}\n`);
    }
    ackHandover(state.dir, m[1], NEW, "2026-10-19T10:12:00Z");
  }
};

const setup = async (): Promise<LaneHandoverDeps & { printed: string[] }> => {
  const clock = fakeClock(Date.parse("2026-10-19T10:11:00Z"));
  const base = depsFor(w, { ...clock, sleep: async () => simulate() }, state.dir, { backend: "aoe", sessionsDir: join(state.dir, "sessions") });
  w.tmux = [NEW];
  w.screens[NEW] = "❯ ";
  await base.registry.write(lane());
  // the owner's own message, so a quote that cites its id is his
  writeFileSync(join(state.dir, "inbox.jsonl"), `${JSON.stringify({ id: OWNER_MSG, author_id: "owner-1", channel_id: "9", content: QUOTE })}\n`);
  const printed: string[] = [];
  let n = 0;
  return {
    ...base,
    printed,
    cardDir: join(state.dir, "discord"),
    home: "/home/test",
    sessionOf: async (pane) => (pane === NEW ? "new-sid" : ""),
    procs: async () => [],
    envOf: () => "",
    alive: () => false,
    signal: () => true,
    realpath: (p) => p,
    nonce: () => `s${++n}`,
    print: (line) => printed.push(line),
    inbox: join(state.dir, "inbox.jsonl"),
    ownerIds: ["owner-1"],
  };
};

const sorter = (verdicts: Record<string, "STANDING" | "CARRIED" | "DONE" | "CHATTER">, risk: "HIGH" | "MEDIUM" | "LOW" = "HIGH"): Classify => async (items) => ({ verdicts: items.map((it) => { const v = verdicts[it.text] ?? "CHATTER"; return v === "STANDING" ? { verdict: v, risk, why: "still holds" } : { verdict: v, why: "test" }; }), model: "test/model" });

beforeEach(() => {
  state = withState();
  w = newWorld();
  handled = [];
  fix = true;
});
afterEach(() => state.done());

test("an owner quote only the old conversation held is recorded, sent once through the supplement path and fixed by the new session's ack", async () => {
  handover({ log: [said("2026-10-18T09:04:00Z", `[LEAD] 형(18:04 KST, 1561666271257436232): "${QUOTE}" — 원인 찾아서 고쳐`), said("2026-10-18T09:05:00Z", `[LEAD] 형 "네가 빨리 보내"`), said("2026-10-18T09:06:00Z", `[LEAD] 형 "릴리스 카드는 짧게 써 줘"`)] });
  appendRollover(state.dir, { kind: "rollover", who: "lane", at: "2026-10-19T10:00:00.000Z", key: "demo", from: "aoe_demo_old", to: NEW, signals: {}, steps: [], result: "done", reasons: [], supplementRounds: 1, supplements: [{ round: 1, items: [{ kind: "tried fix", text: "raise the timeout" }], evidence: 1, file: `${stem()}.supplement-1.md` }] });
  const deps = await setup();
  const r = await auditHandover(deps, committedHandovers(state.dir)[0] ?? (() => { throw new Error("no handover"); })(), { classify: sorter({ [QUOTE]: "STANDING", "네가 빨리 보내": "DONE", "릴리스 카드는 짧게 써 줘": "CARRIED" }) });
  const rows = readAudit(state.dir);
  expect(rows.map((x) => [x.stage, x.kind, x.text, x.fixed])).toEqual([["supplement", "tried fix", "raise the timeout", true], ["audit", "owner's words", QUOTE, true]]);
  expect(rows[1]?.handover).toBe(STAMP);
  const supplements = sent(w).filter((l) => l.startsWith("[LEAD] HANDOVER_SUPPLEMENT"));
  expect(supplements).toHaveLength(1);
  expect(supplements[0]).toContain("AGENTS.md");
  expect(readFileSync(`${stem()}.audit-supplement-1.md`, "utf8")).toContain(QUOTE);
  expect(r.line).toMatch(/^HANDOVER_AUDIT demo demo-20261019-100000: 2 left out .*fixed 2.*standing 1, carried 1, done 1, chatter 0/);
  expect(JSON.parse(readFileSync(markerFile(`${stem()}.md`), "utf8")).status).toBe("done");
  // a second run does nothing: the handover is audited once
  expect((await auditHandover(deps, committedHandovers(state.dir)[0] ?? (() => { throw new Error("no handover"); })())).line).toMatch(/^HANDOVER_AUDIT_DONE/);
  expect(readAudit(state.dir)).toHaveLength(2);
});

test("a handover where everything reached the new session leaves no ledger line and sends nothing", async () => {
  handover({ log: [said("2026-10-19T09:00:00Z", `[LEAD] 형(18:04 KST, ${OWNER_MSG}): "${QUOTE}" — 고쳐`)], restate: `${RESTATE}\n## Owner's words\n"${QUOTE}"\n` });
  const deps = await setup();
  const r = await auditHandover(deps, committedHandovers(state.dir)[0] ?? (() => { throw new Error("no handover"); })(), { classify: async () => { throw new Error("nothing should need sorting"); } });
  expect(r.line).toBe(`HANDOVER_AUDIT_OK demo ${STAMP}: nothing left out`);
  expect(existsSync(auditLog(state.dir))).toBe(false);
  expect(sent(w).filter((l) => l.includes("HANDOVER_SUPPLEMENT"))).toEqual([]);
});

test("a gap the new session does not take in stays unfixed, a LOW one is recorded but not sent, and a lost todo is a gap of its own", async () => {
  fix = false;
  handover({ log: [said("2026-10-19T09:00:00Z", `[LEAD] 형(18:04 KST, ${OWNER_MSG}): "${QUOTE}"`), said("2026-10-19T09:30:00Z", `[LEAD] 형 Q9: "로그 보관은 두 주만 하자"`)], todos: ["Work: ship it (in_progress)", "Report: send the release notes to the lead (pending)"] });
  const deps = await setup();
  const low: Classify = async (items) => ({ verdicts: items.map((it) => ({ verdict: "STANDING", risk: it.text === QUOTE ? "HIGH" : "LOW", why: "x" })) });
  await auditHandover(deps, committedHandovers(state.dir)[0] ?? (() => { throw new Error("no handover"); })(), { classify: low });
  const rows = readAudit(state.dir);
  expect(rows.map((x) => [x.kind, x.risk ?? "-", x.fixed])).toEqual([["owner's words", "HIGH", false], ["lead's words", "LOW", false], ["todo", "-", false]]);
  expect(rows[1]?.note).toBe("low risk: recorded, not sent");
  const file = readFileSync(`${stem()}.audit-supplement-1.md`, "utf8");
  expect(file).toContain("send the release notes");
  expect(file).not.toContain("두 주만");
});

test("conversation items no reviewer sorts are not recorded, and the line says so", async () => {
  handover({ log: [said("2026-10-19T09:00:00Z", `[LEAD] 형(18:04 KST, ${OWNER_MSG}): "${QUOTE}"`)] });
  const deps = await setup();
  const r = await auditHandover(deps, committedHandovers(state.dir)[0] ?? (() => { throw new Error("no handover"); })(), { classify: async () => ({ error: "no reviewer" }) });
  expect(deps.printed.some((l) => l.startsWith("HANDOVER_AUDIT_UNSORTED demo"))).toBe(true);
  expect(r.rows).toEqual([]);
});

test("--dry-run prints the rows and writes, marks and sends nothing", async () => {
  handover({ log: [said("2026-10-19T09:00:00Z", `[LEAD] 형(18:04 KST, ${OWNER_MSG}): "${QUOTE}"`)] });
  const deps = await setup();
  const r = await auditHandover(deps, committedHandovers(state.dir)[0] ?? (() => { throw new Error("no handover"); })(), { dryRun: true, classify: sorter({ [QUOTE]: "STANDING" }) });
  expect(r.rows).toHaveLength(1);
  expect(deps.printed.some((l) => l.startsWith("AUDIT_ROW "))).toBe(true);
  expect(existsSync(auditLog(state.dir))).toBe(false);
  expect(existsSync(markerFile(`${stem()}.md`))).toBe(false);
  expect(sent(w)).toEqual([]);
});

test("freshness queues each committed handover's audit once, after auditAfterMin and within auditWindowH", async () => {
  handover({ log: [] });
  const deps = await setup();
  const started: string[] = [];
  const hooks = { signals: async () => ({}), audit: async (c: { stamp: string }) => (started.push(c.stamp), "started unit=x") };
  const audits = async (iso: string) => (await freshnessTick({ ...deps, clock: fakeClock(Date.parse(iso)) }, "/home/test", hooks)).filter((a) => a.kind === "rollover_audit");
  expect(await audits("2026-10-19T10:05:00Z")).toEqual([]);
  expect(await audits("2026-10-19T10:12:00Z")).toEqual([{ kind: "rollover_audit", lane: "demo", detail: `${STAMP}: started unit=x` }]);
  expect(await audits("2026-10-19T10:20:00Z")).toEqual([]);
  expect(started).toEqual([STAMP]);
  expect(auditDue(state.dir, Date.parse("2026-10-21T10:00:00Z"), { auditAfterMin: 10, auditWindowH: 24 })).toEqual([]);
});

test("dori handover gap records what a session did not know against its latest handover", async () => {
  handover({ log: [] });
  const deps = await setup();
  const { row, line } = reportGap(deps, "demo", "owner's words", "형이 카드 E 이름을 정해 둔 걸 몰라 다시 물음 token=abc123secret", "lane");
  expect(row).toMatchObject({ stage: "reported", kind: "owner's words", handover: STAMP, fixed: false });
  expect(line).toStartWith("HANDOVER_GAP demo owner's words: ");
  expect(readAudit(state.dir)[0]?.text).toBe("형이 카드 E 이름을 정해 둔 걸 몰라 다시 물음 token=[masked]");
  expect(readFileSync(join(state.dir, "lanes.log"), "utf8")).toContain("HANDOVER_GAP demo");
});

test("the ledger never holds a secret value", () => {
  // token-shaped strings are put together here, so the source itself holds none (push protection reads it)
  const bot = ["MTIzNDU2Nzg5MDEyMzQ1Njc4", "GhIjKl", "abcdefghijklmnopqrstuvwxyz012"].join(".");
  const gh = ["ghp", "abcdefghijklmnop1234"].join("_");
  expect(scrubSecrets(`bot ${bot} and ${gh} and password: hunter22`)).toBe("bot [masked] and [masked] and password: [masked]");
});

test("the week's summary goes to the lead's inbox once, after Monday 08:30 in the scorecard's time zone", async () => {
  handover({ log: [] });
  const deps = await setup();
  reportGap(deps, "demo", "todo", "the release notes todo was lost", "lead");
  const tz = "Asia/Seoul";
  // Monday 2026-10-19 08:29 KST is still the week before; 08:30 starts the week of 10-19
  expect(summaryWeek(Date.parse("2026-10-18T23:29:00Z"), tz, "Mon 08:30")).toBe("2026-10-12");
  expect(summaryWeek(Date.parse("2026-10-18T23:30:00Z"), tz, "Mon 08:30")).toBe("2026-10-19");
  expect(summaryWeek(Date.parse("2026-10-25T14:00:00Z"), tz, "Mon 08:30")).toBe("2026-10-19");
  const inbox = join(state.dir, "discord", "inbox.jsonl");
  const week = weeklyDue(state.dir, Date.parse("2026-10-19T10:30:00Z"), tz, "Mon 08:30") ?? "";
  expect(week).toBe("2026-10-19");
  const line = sendAuditSummary({ ...deps, clock: fakeClock(Date.parse("2026-10-19T10:30:00Z")) }, inbox, week);
  expect(line).toStartWith("ROLLOVER_AUDIT_WEEKLY 2026-10-19");
  const row = JSON.parse(readFileSync(inbox, "utf8").trim()) as { kind: string; id: string; content: string };
  expect(row.kind).toBe("rollover-audit");
  expect(row.id).toBe("rollover-audit-2026-10-19");
  expect(row.content).toContain("교대 1번");
  expect(row.content).toContain("todo 1");
  expect(weeklyDue(state.dir, Date.parse("2026-10-20T10:30:00Z"), tz, "Mon 08:30")).toBeUndefined();
  expect(weeklyDue(state.dir, Date.parse("2026-10-26T00:00:00Z"), tz, "Mon 08:30")).toBe("2026-10-26");
  expect(weeklyDue(state.dir, Date.parse("2026-10-26T00:00:00Z"), tz, "")).toBeUndefined();
});

test("a quote is the owner's only with proof: his message id in the inbox or an answered card; what the lead told him is the lead's words", async () => {
  handover({ log: [] });
  await setup();
  const cards = new QuestionStore(join(state.dir, "discord"));
  const q = cards.create("Which name?", ["zzangdori-ops", "yoodori-ops"], "9", { thread: null, tmux: null, session: null }, "2026-10-18T14:48:00Z");
  cards.answer(q.id, "zzangdori-ops", "button", "2026-10-18T14:49:00Z");
  const said = userLines(undefined).concat([
    { line: 1, at: "2026-10-18T09:04:00Z", text: `[LEAD] 형(18:04 KST, ${OWNER_MSG}): "${QUOTE}" — 고쳐` },
    { line: 2, at: "2026-10-18T14:49:00Z", text: `[LEAD] 형 ${q.id}(23:49 KST 버튼): "zzangdori-ops" — 최종` },
    { line: 3, at: "2026-10-18T01:42:00Z", text: '[LEAD] X3 README가 그렇게 말했고 내가 형에게도 "유돌이 자기 게이트 못 건드리게"라고 말했어' },
    { line: 4, at: "2026-10-18T01:50:00Z", text: '[LEAD] 형 "네가 빨리 보내" — 바로' },
    { line: 5, at: "2026-10-18T01:51:00Z", text: '[LEAD] 형(1561000000000000000): "다른 사람이 쓴 글이라 형 것이 아님"' },
  ]);
  const inbox = new Set([OWNER_MSG]);
  const got = ownerQuotes(said, { message: (id) => inbox.has(id), card: (id) => cards.get(id)?.status === "answered" }).map((c) => [c.kind, c.text]);
  expect(got).toEqual([
    ["owner's words", QUOTE],
    ["owner's words", "zzangdori-ops"],
    ["lead's words", "유돌이 자기 게이트 못 건드리게"],
    ["lead's words", "네가 빨리 보내"],
    ["lead's words", "다른 사람이 쓴 글이라 형 것이 아님"],
  ]);
});

test("the lane handover note carries the owner's own messages since the last handover, with id and link; the lead's and others' do not count", () => {
  state = state ?? withState();
  const inbox = join(state.dir, "inbox-note.jsonl");
  const row = (id: string, author: string, channel: string, ts: string, content: string) => JSON.stringify({ id, author_id: author, channel_id: channel, ts, content });
  writeFileSync(inbox, [
    row("1561000000000000001", "owner-1", "555", "2026-10-19T09:00:00.000000+00:00", "카드 E 이름은 zzangdori-ops로"),
    row("1561000000000000002", "owner-1", "777", "2026-10-19T09:10:00.000000+00:00", "이 lane은 \"표\"를 꼭 살려"),
    row("1561000000000000003", "lead-bot", "777", "2026-10-19T09:20:00.000000+00:00", "리드가 쓴 글"),
    row("1561000000000000004", "owner-1", "999", "2026-10-19T09:30:00.000000+00:00", "다른 곳의 형 글, 인용 안 됨"),
    row("1561000000000000005", "owner-1", "777", "2026-10-18T01:00:00.000000+00:00", "지난 교대 전의 글"),
  ].join("\n"));
  const log = join(state.dir, "old.jsonl");
  writeFileSync(log, [said("2026-10-19T09:01:00Z", "[LEAD] 형(18:00 KST, 1561000000000000001): \"카드 E 이름은 zzangdori-ops로\""), said("2026-10-19T09:21:00Z", "[LEAD] 1561000000000000003 참고")].join("\n"));
  const got = ownerMessagesFor({ inbox, ownerIds: ["owner-1"], oldLog: log, thread: "777", since: "2026-10-19T00:00:00Z", guild: "42" });
  expect(got.map((m) => [m.id, m.link])).toEqual([["1561000000000000001", "https://discord.com/channels/42/555/1561000000000000001"], ["1561000000000000002", "https://discord.com/channels/42/777/1561000000000000002"]]);
  const facts = { lane: lane(), from: { pane: "aoe_demo_old", aoeId: "1a", session: "old-sid", title: "demo", cwd: CWD }, cwd: CWD, model: "m", monitors: [], todos: [], chains: [], detached: [], laneNote: "", signals: {}, ownerMessages: got } as unknown as LaneFacts;
  const note = renderLaneNote(facts, "2026-10-19T10:00:00Z", state.dir);
  expect(note).toContain("## The owner's messages since the last handover (2)");
  expect(note).toContain('https://discord.com/channels/42/555/1561000000000000001: "카드 E 이름은 zzangdori-ops로"');
  expect(note).toContain('1561000000000000002: "이 lane은 \\"표\\"를 꼭 살려"');
  expect(note).not.toContain("리드가 쓴 글");
  expect(note).not.toContain("다른 곳의 형 글");
  expect(note).not.toContain("지난 교대 전의 글");
});

test("a handover whose new session was replaced by a later one is not charged with the todos it cannot read", async () => {
  handover({ log: [], todos: ["Work: ship it (in_progress)", "Report: send the release notes to the lead (pending)"] });
  const deps = await setup();
  await deps.registry.write({ ...lane(), pane: "aoe_demo-later_77777777", session: "later-sid" });
  const r = await auditHandover(deps, committedHandovers(state.dir)[0] ?? (() => { throw new Error("no handover"); })(), { classify: async () => ({ verdicts: [] }) });
  expect(r.line).toBe(`HANDOVER_AUDIT_OK demo ${STAMP}: nothing left out`);
  expect(readAudit(state.dir)).toEqual([]);
});

test("a monitor that starts work, re-armed watch-only as the note asks, is no gap; one never re-armed is sent back without its launching command", async () => {
  // GongDori e7-leap 2026-10-24 04:15Z: the new session followed the cut chain watch-only, and the audit called the monitor
  // never armed and sent the launching tool.monitor call back to it, the step that starts a finished chain again
  const chain = { description: "chain s21 -> s31", command: "cd /w; dori heavy cut-chain -- ssh n 'bash qa/cut.sh 400' > /tmp/cut.log 2>&1 & pid=$!; tail --pid=$pid -n +1 -f /tmp/cut.log", filter: "CUT_CHAIN|EXIT", persistent: true };
  handover({ log: [], monitors: [chain], newMonitors: [{ description: chain.description, command: "tail -n +1 -F /tmp/cut.log", filter: chain.filter, persistent: true, runtime: { pid: 4242 } }] });
  const deps = await setup();
  await auditHandover(deps, committedHandovers(state.dir)[0] ?? (() => { throw new Error("no handover"); })(), { classify: sorter({}) });
  expect(readAudit(state.dir).filter((x) => x.kind === "monitor")).toEqual([]);
  expect(sent(w).filter((l) => l.startsWith("[LEAD] HANDOVER_SUPPLEMENT"))).toEqual([]);

  state.done();
  state = withState();
  w = newWorld();
  handover({ log: [], monitors: [chain] });
  await auditHandover(await setup(), committedHandovers(state.dir)[0] ?? (() => { throw new Error("no handover"); })(), { classify: sorter({}) });
  const rows = readAudit(state.dir).filter((x) => x.kind === "monitor");
  expect(rows.map((x) => x.text)).toEqual([chain.description]);
  expect(rows[0]?.source).toContain("arm the watch-only monitor its line in the note describes, never this command");
});

// A committed lead handover on disk, its old lead frozen until the audit (owner Q476)
const LEAD_OLD = "aoe_lead_1b1b1b1b";
const leadHandover = (log: readonly string[]) => {
  const top = join(state.dir, "handover");
  mkdirSync(top, { recursive: true });
  mkdirSync(sessionDir(), { recursive: true });
  const oldLog = join(sessionDir(), "2026-10-18T00-00-00-000Z_old-lead.jsonl");
  writeFileSync(oldLog, log.join("\n"));
  const note = join(top, "20261019-100000.md");
  writeFileSync(note, "# Lead handover\n");
  writeFileSync(join(top, "20261019-100000.json"), JSON.stringify({ cwd: CWD, oldLog, todos: [], monitors: [], leadNote: "" }));
  writeFileSync(join(top, "20261019-100000.result.json"), JSON.stringify({ at: COMMIT, note, to: { pane: NEW, session: "new-sid" }, result: "done-frozen", reasons: [] }));
  writeFileSync(join(sessionDir(), "2026-10-19T10-00-00-000Z_new-sid.jsonl"), "");
  writeFrozen(state.dir, { pane: LEAD_OLD, aoeId: "1b1b1b1b00001111", at: COMMIT, agentPid: 11, pids: [11, 12], closeAt: "2026-10-20T10:01:00.000Z", to: NEW });
  w.aoe.push({ id: "1b1b1b1b00001111", title: "lead", path: CWD, tool: "omo", profile: "main" });
  w.tmux.push(LEAD_OLD);
};
const leadAudit = async (deps: LaneHandoverDeps, classify: Classify) => auditHandover(deps, committedHandovers(state.dir).find((c) => c.who === "lead") ?? (() => { throw new Error("no lead handover"); })(), { classify });

test("an audit that passes closes the frozen old lead at once, and says what it cost: its time, model calls and tokens", async () => {
  // Given: owner Q476, 17 old leads frozen 24 h and none thawed
  leadHandover([said("2026-10-19T09:00:00Z", `[LEAD] 형(18:04 KST, ${OWNER_MSG}): "${QUOTE}" — 고쳐`)]);
  const deps = { ...(await setup()), config: { ...(await setup()).config, leadPane: NEW } };
  const sorted: Classify = async (items) => ({ verdicts: items.map(() => ({ verdict: "DONE" as const, why: "done" })), model: "test/model", cost: { calls: 1, chars: 4000 } });
  // When
  await leadAudit(deps, sorted);
  // Then
  expect(deps.printed.find((l) => l.startsWith("HANDOVER_AUDIT_COST lead "))).toMatch(/: \d+ s, 1 model call\(s\), ~1000 tokens \(estimated from the text size\)$/);
  expect(deps.printed.find((l) => l.startsWith("HANDOVER_OLD_CLOSED"))).toContain("(the audit after the handover passed)");
  expect(readFrozen(state.dir)).toEqual([]);
  expect(JSON.parse(readFileSync(markerFile(join(state.dir, "handover", "20261019-100000.md")), "utf8"))).toMatchObject({ status: "done", calls: 1, tokensEst: 1000 });
});

test("an audit that leaves something out keeps the old lead frozen until frozenCloseH, and says so", async () => {
  // Given
  leadHandover([said("2026-10-19T09:00:00Z", `[LEAD] 형(18:04 KST, ${OWNER_MSG}): "${QUOTE}" — 고쳐`)]);
  fix = false;
  const deps = { ...(await setup()), config: { ...(await setup()).config, leadPane: NEW } };
  // When
  await leadAudit(deps, sorter({ [QUOTE]: "STANDING" }));
  // Then
  expect(deps.printed.find((l) => l.startsWith(`HANDOVER_OLD_KEPT_FROZEN ${LEAD_OLD}: the audit left 1 item(s) not filled in`))).toContain("2026-10-20T10:01:00.000Z");
  expect(readFrozen(state.dir).map((r) => r.pane)).toEqual([LEAD_OLD]);
});

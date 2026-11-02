import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addItem, type BacklogItem, BacklogError, backlogTick, dayReport, decideItem, dropItem, feedIntake, type InboxRow, listItems, orderIntake, pairIntake, readItem, StartRefused, type TickDeps } from "../src/backlog.ts";
import { type BacklogSettings, loadConfig } from "../src/config.ts";
import type { Lane } from "../src/registry.ts";

const SETTINGS: BacklogSettings = { enabled: true, everyMin: 60, maxLanes: 3, maxStarts: 1, hostMaxLanes: 2, hostDir: "", pairRepairPattern: "", pairRequestPattern: "", intakeDone: "file {stateDir}/backlog/reports/{id}.md", writeNeedsOwnerLink: false, orderKinds: [], feedCommand: [], dayReportAt: "", timeZone: "UTC" };
const T0 = Date.parse("2026-11-02T15:00:00Z");

let root: string;
let state: string;
let brief: string;
let lanes: Lane[];
let launched: string[];
let rows: { kind: string; id: string; content: string }[];
let now: number;

const lane = (key: string, closed = false): Lane => ({ key, title: key, thread: "none", brief: "/b", done: "file /d", openedAt: "2026-11-02T00:00:00Z", ...(closed ? { closedAt: "2026-11-02T14:00:00Z", history: [{ at: "2026-11-02T14:00:00Z", status: "closed", note: "verified done" }] } : {}) });

const deps = (patch: Partial<TickDeps> = {}, settings: Partial<BacklogSettings> = {}): TickDeps => ({
  stateDir: state,
  settings: { ...SETTINGS, hostDir: join(root, "host"), ...settings },
  now: () => now,
  lanes: async () => lanes,
  busy: async () => [],
  limited: () => undefined,
  host: { dir: join(root, "host"), user: "me", max: settings.hostMaxLanes ?? SETTINGS.hostMaxLanes },
  launch: async (item) => {
    launched.push(item.id);
    lanes.push(lane(item.id));
    return { pane: `aoe_${item.id}`, startup: `STARTUP_OK ${item.id}` };
  },
  inbox: (kind, id, content) => rows.push({ kind, id, content }),
  ...patch,
});

const add = (id: string, extra: Partial<Parameters<typeof addItem>[1]> = {}): BacklogItem =>
  addItem(state, { id, title: id, brief, done: "file /tmp/x", ...extra }, { registered: false, at: new Date(now).toISOString() }).item;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "backlog-test-"));
  state = join(root, "state");
  brief = join(root, "brief.md");
  writeFileSync(brief, "ulw\n\n[목표] read a file\n");
  lanes = [];
  launched = [];
  rows = [];
  now = T0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("add refuses what a launch would refuse, and copies the brief; add again replaces an open item; drop and decide change it", () => {
  // Given / When / Then
  expect(() => add("x1", { priority: "0" })).toThrow(BacklogError);
  expect(() => add("x1", { brief: join(root, "missing.md") })).toThrow(/no brief file/);
  expect(() => add("Bad Id")).toThrow(/item id/);
  expect(() => add("x1", { done: "" })).toThrow(/Done line/);
  expect(() => add("x1", { thread: "none" })).toThrow(/--no-thread/);
  expect(() => addItem(state, { id: "x1", title: "x1", brief, done: "file /tmp/x" }, { registered: true, at: "2026-11-02T15:00:00Z" })).toThrow(/already registered/);
  const item = add("x1", { ask: "형, 이거 해도 돼?" });
  writeFileSync(brief, "changed after add\n");
  expect(readFileSync(item.brief, "utf8")).toContain("read a file");
  expect(item.thread).toBe("new");
  const replaced = addItem(state, { id: "x1", title: "x1 again", brief, done: "file /tmp/x", priority: "2" }, { registered: false, at: "2026-11-02T16:00:00Z" });
  expect(replaced.replaced).toBe(true);
  expect(replaced.item.addedAt).toBe(item.addedAt);
  expect(() => decideItem(state, "x1", "응", "t", "k")).toThrow(/no question/);
  add("x2", { ask: "형, 이거 해도 돼?" });
  const decided = decideItem(state, "x2", "응 해", "2026-11-02T16:00:00Z", "2026-11-03 01:00 KST");
  expect(decided.ask).toBeUndefined();
  expect(readFileSync(decided.brief, "utf8")).toContain("형 답: 응 해");
  expect(dropItem(state, "x2", "no", "t").status).toBe("dropped");
});

test("a pass starts the first item by priority, one a pass, and the next tick starts the next without waiting for the hour", async () => {
  // Given: the lead's own lanes do not take the backlog's room
  add("late", { priority: "5" });
  add("first", { priority: "1" });
  add("second", { priority: "3" });
  lanes.push(lane("other"), lane("other2"), lane("other3"));
  // When
  const one = await backlogTick(deps());
  now += 2 * 60_000;
  const two = await backlogTick(deps());
  // Then
  expect(launched).toEqual(["first", "second"]);
  expect(one[0]).toStartWith("BACKLOG_STARTED first p1 aoe_first");
  expect(one).toContain("BACKLOG_WAIT 2 item(s): 0 backlog lane(s) of this Dori run (backlog.maxLanes 3), at most 1 start(s) a pass");
  expect(readItem(state, "first")?.status).toBe("running");
  expect(rows.filter((r) => r.kind === "backlog-start").length).toBe(2);
  expect(two[0]).toStartWith("BACKLOG_STARTED second");
});

test("why nothing starts is said once until it changes or the hourly sweep comes; maxLanes counts this Dori's backlog lanes", async () => {
  // Given: two backlog lanes of this Dori run, maxLanes 2
  add("r1");
  add("r2");
  await backlogTick(deps({}, { maxStarts: 2, maxLanes: 2 }));
  add("aa");
  // When
  now += 2 * 60_000;
  const first = await backlogTick(deps({}, { maxLanes: 2 }));
  now += 2 * 60_000;
  const same = await backlogTick(deps({}, { maxLanes: 2 }));
  now += 60 * 60_000;
  const sweep = await backlogTick(deps({}, { maxLanes: 2 }));
  // Then
  expect(launched).toEqual(["r1", "r2"]);
  expect(first).toEqual(["BACKLOG_WAIT 1 item(s): 2 backlog lane(s) of this Dori run (backlog.maxLanes 2), at most 1 start(s) a pass"]);
  expect(same).toEqual([]);
  expect(sweep).toEqual(first);
});

test("an item that asks the owner is never started: one inbox row, then it starts after decide", async () => {
  // Given
  add("asks", { ask: "형 메일함을 읽어도 될까?" });
  // When
  const one = await backlogTick(deps());
  const again = await backlogTick(deps(), { force: true });
  decideItem(state, "asks", "응", new Date(now).toISOString(), "k");
  const after = await backlogTick(deps(), { force: true });
  // Then
  expect(one).toContain("BACKLOG_ASK asks: in the lead's inbox; not started before dori backlog decide");
  expect(again.some((l) => l.startsWith("BACKLOG_ASK"))).toBe(false);
  expect(rows.filter((r) => r.kind === "backlog-ask").map((r) => r.content)).toEqual([expect.stringContaining("dori backlog decide asks --text")]);
  expect(launched).toEqual(["asks"]);
  expect(after[0]).toStartWith("BACKLOG_STARTED asks");
});

test("a busy host or a usage limit holds every start", async () => {
  // Given
  add("aa");
  // When
  const busy = await backlogTick(deps({ busy: async () => ["memory free 5% < 20%"] }));
  const limited = await backlogTick(deps({ limited: () => "usage limit: no anthropic-subscription account is free" }), { force: true });
  // Then
  expect(busy).toEqual(["BACKLOG_HOLD memory free 5% < 20%; 1 item(s) wait"]);
  expect(limited[0]).toStartWith("BACKLOG_HOLD usage limit");
  expect(launched).toEqual([]);
});

test("backlog lanes of all Doris on the host count toward hostMaxLanes; a stale file does not; a closed lane frees its slot", async () => {
  // Given: two live lanes of other Doris and one whose loop stopped touching its file seven hours ago
  const host = join(root, "host");
  mkdirSync(host, { recursive: true });
  for (const [name, at] of [["ok.a", "2026-11-02T10:00:00Z"], ["moo.b", "2026-11-02T11:00:00Z"], ["gone.c", "2026-11-02T05:00:00Z"]] as const) writeFileSync(join(host, `${name}.json`), JSON.stringify({ at }));
  utimesSync(join(host, "gone.c.json"), (T0 - 7 * 3_600_000) / 1000, (T0 - 7 * 3_600_000) / 1000);
  for (const name of ["ok.a", "moo.b"]) utimesSync(join(host, `${name}.json`), T0 / 1000, T0 / 1000);
  add("mine");
  // When
  const full = await backlogTick(deps());
  rmSync(join(host, "moo.b.json"));
  const free = await backlogTick(deps(), { force: true });
  lanes = [lane("mine", true)];
  const done = await backlogTick(deps(), { force: true });
  // Then
  expect(full[0]).toStartWith("BACKLOG_HOLD the host has 2 backlog lane(s) of all Doris (backlog.hostMaxLanes 2): ok.a, moo.b");
  expect(free[0]).toStartWith("BACKLOG_STARTED mine");
  expect(existsSync(join(host, "me.mine.json"))).toBe(false);
  expect(done).toEqual(["BACKLOG_DONE mine: its lane closed (verified done)"]);
  expect(readdirSync(host).sort()).toEqual(["gone.c.json", "ok.a.json"]);
});

test("a refused launch holds the item at once; another failure holds it after the second try", async () => {
  // Given
  add("refused", { priority: "1" });
  add("flaky", { priority: "2" });
  const failing = deps({
    launch: async (item) => {
      throw item.id === "refused" ? new StartRefused("LAUNCH_RELATED_THREAD 123: related thread") : new Error("aoe add failed");
    },
  }, { maxStarts: 2 });
  // When
  const one = await backlogTick(failing);
  const two = await backlogTick(failing, { force: true });
  // Then
  expect(one).toEqual(["BACKLOG_HELD refused: dori launch refused it: LAUNCH_RELATED_THREAD 123: related thread", "BACKLOG_START_FAILED flaky (1/2): aoe add failed"]);
  expect(two).toEqual(["BACKLOG_HELD flaky: start failed 2 times, last: aoe add failed"]);
  expect(rows.map((r) => r.kind)).toEqual(["backlog-held", "backlog-held"]);
  expect(readdirSync(join(root, "host"))).toEqual([]);
});

test("#dori-pair intake: only the other Doris' posts that match, a request only with an owner link that holds", async () => {
  // Given
  const inbox: InboxRow[] = [{ id: "1000", scope: "pair-bot", author_id: "B1", content: "도리야, 수리 요청: 옛 글" }];
  const checked: string[] = [];
  const intake = (extra: InboxRow[]) => {
    inbox.push(...extra);
    return pairIntake({
      stateDir: state,
      settings: { ...SETTINGS, pairRepairPattern: "^도리야, 수리 요청", pairRequestPattern: "^도리야," },
      rows: () => inbox,
      pairBots: ["B1", "B2"],
      guild: "G",
      ownerLink: async (url, maxAge) => {
        checked.push(`${url} ${maxAge}`);
        return url.endsWith("/77") ? undefined : "the message is not the owner's";
      },
      now: () => now,
    });
  };
  // When
  const first = await intake([]);
  const next = await intake([
    { id: "1001", scope: "pair-bot", author_id: "B1", channel_id: "P", content: "도리야, 수리 요청: 파일 배달이 하위 폴더를 지워" },
    { id: "1002", scope: "pair-bot", author_id: "X9", channel_id: "P", content: "도리야, 수리 요청: 모르는 봇" },
    { id: "1003", scope: "pair", author_id: "H1", channel_id: "P", content: "도리야, 수리 요청: 사람 글" },
    { id: "1004", scope: "pair-bot", author_id: "B2", channel_id: "P", content: "도리야, 메일 하나 보내 줘 https://discord.com/channels/1/2/66" },
    { id: "1005", scope: "pair-bot", author_id: "B2", channel_id: "P", content: "도리야, 형이 시켰어 https://discord.com/channels/1/2/77" },
    { id: "1006", scope: "pair-bot", author_id: "B2", channel_id: "P", content: "고마워, 받았어" },
  ]);
  const again = await intake([]);
  // Then
  expect(first).toEqual(["BACKLOG_INTAKE_FROM 1000: #dori-pair posts after this one are read"]);
  expect(next).toEqual([
    "BACKLOG_INTAKE pair-1001 (repair) from B1: 수리: 파일 배달이 하위 폴더를 지워",
    "BACKLOG_INTAKE_SKIPPED 1004: a request with no owner message link that holds (https://discord.com/channels/1/2/66: the message is not the owner's); not on the list",
    "BACKLOG_INTAKE pair-1005 (request) from B2: 부탁: 형이 시켰어 https://discord.com/channels/1/2/77",
  ]);
  expect(again).toEqual([]);
  expect(readItem(state, "pair-1000")).toBeUndefined();
  expect(readItem(state, "pair-1001")).toMatchObject({ noThread: "#dori-pair 수리 요청 https://discord.com/channels/G/P/1001", by: "pair:B1", done: `file ${state}/backlog/reports/pair-1001.md` });
  expect(readItem(state, "pair-1005")).toMatchObject({ thread: "new", ownerLink: "https://discord.com/channels/1/2/77" });
  expect(readFileSync(readItem(state, "pair-1001")?.brief ?? "", "utf8")).toContain("파일 배달이 하위 폴더를 지워");
  expect(checked).toEqual(["https://discord.com/channels/1/2/66 86400000", "https://discord.com/channels/1/2/77 86400000"]);
});

test("backlog.writeNeedsOwnerLink: an item that may write asks the owner first unless an owner link holds or it only reads", () => {
  // Given
  const ctx = { registered: false, at: "2026-11-02T15:00:00Z", needOwnerLink: true };
  // When
  const bare = addItem(state, { id: "w1", title: "w1", brief, done: "file /tmp/x" }, ctx).item;
  const bad = addItem(state, { id: "w2", title: "w2", brief, done: "file /tmp/x", ownerLink: "https://discord.com/channels/1/2/1" }, { ...ctx, ownerProblem: "the message is not the owner's" }).item;
  const linked = addItem(state, { id: "w3", title: "w3", brief, done: "file /tmp/x", ownerLink: "https://discord.com/channels/1/2/2" }, ctx).item;
  const reads = addItem(state, { id: "w4", title: "w4", brief, done: "file /tmp/x", readOnly: true }, ctx).item;
  // Then
  expect(bare.ask).toBe("형 원문 링크가 확인되지 않은 쓰기 일이야(링크 없음). 시작해도 될까?");
  expect(bad.ask).toContain("the message is not the owner's");
  expect(linked.ask).toBeUndefined();
  expect(reads.ask).toBeUndefined();
});

test("the backlog is off unless a Dori's config turns it on", async () => {
  // Given
  const file = join(root, "config.json");
  writeFileSync(file, JSON.stringify({ backlog: { enabled: true, maxLanes: 2 } }));
  // When
  const off = await loadConfig(join(root, "none.json"), root);
  const on = await loadConfig(file, root);
  // Then
  expect(off.backlog.enabled).toBe(false);
  expect(on.backlog).toMatchObject({ enabled: true, maxLanes: 2, maxStarts: 1, hostMaxLanes: 3, writeNeedsOwnerLink: false, pairRepairPattern: "", orderKinds: [], feedCommand: [], dayReportAt: "" });
});

test("the owner's orders (backlog.orderKinds) become items at once; rows before the first pass are not taken", () => {
  // Given
  const rows: InboxRow[] = [{ id: "dashboard-order-8", ts: "2026-10-29T14:20:51.634Z", kind: "dashboard-order", content: "[대시보드 지시 #8] 옛 지시" }];
  const intake = () => orderIntake({ stateDir: state, settings: { ...SETTINGS, orderKinds: ["dashboard-order"] }, rows: () => rows, now: () => now });
  // When
  const first = intake();
  rows.push({ id: "dashboard-order-10", ts: "2026-11-02T15:05:00.000Z", kind: "dashboard-order", content: "[대시보드 지시 #10] 보안교육 이수했는지 확인해 줘\n관련: 할 일 ..." }, { id: "x1", ts: "2026-11-02T15:06:00.000Z", kind: "answer", content: "응" });
  const next = intake();
  const again = intake();
  // Then
  expect(first).toEqual(["BACKLOG_ORDERS_FROM 2026-11-02T15:00:00.000Z: dashboard-order rows after this are taken"]);
  expect(next).toEqual(["BACKLOG_INTAKE dashboard-order-10 (owner order): [대시보드 지시 #10] 보안교육 이수했는지 확인해 줘"]);
  expect(again).toEqual([]);
  expect(readItem(state, "dashboard-order-8")).toBeUndefined();
  expect(readItem(state, "dashboard-order-10")).toMatchObject({ by: "owner", priority: 2 });
  expect(readItem(state, "dashboard-order-10")?.ask).toBeUndefined();
});

test("the feed (backlog.feedCommand): open entries become draft-only items, a done entry drops its open item, a missing command is one line", async () => {
  // Given
  const settings = { ...SETTINGS, feedCommand: ["node-read", "todo-list", "--json"] };
  let todos: { todo_id: string; title: string; status: string }[] = [{ todo_id: "pb-1697b943644f-1", title: "보안교육 이수", status: "진행" }];
  const run = (feed: Parameters<typeof feedIntake>[0]["feed"]) => feedIntake({ stateDir: state, settings, feed, now: () => now });
  // When
  const missing = await run(async () => ({ why: "YOODORI-GATE-REFUSED unknown command: todo-list" }));
  const one = await run(async () => ({ todos }));
  todos = [{ ...todos[0]!, status: "완료" }];
  const done = await run(async () => ({ todos }));
  // Then
  expect(missing).toEqual(["BACKLOG_FEED_SKIPPED node-read todo-list --json: YOODORI-GATE-REFUSED unknown command: todo-list"]);
  expect(one).toEqual(["BACKLOG_INTAKE todo-pb-1697b943644f-1 (feed, draft only): 보안교육 이수"]);
  expect(readFileSync(join(state, "backlog", "items", "todo-pb-1697b943644f-1.md"), "utf8")).toContain("읽기와 초안까지만 한다");
  expect(done).toEqual(["BACKLOG_FEED_DONE todo-pb-1697b943644f-1: done on the source, dropped from the list"]);
  expect(listItems(state).map((i) => [i.id, i.status, i.draftOnly])).toEqual([["todo-pb-1697b943644f-1", "dropped", true]]);
});

test("the day report comes once a day after backlog.dayReportAt in its time zone, with what waits on the owner", async () => {
  // Given: 15:00 UTC is 00:00 KST of the next day
  const settings = { ...SETTINGS, dayReportAt: "21:00", timeZone: "Asia/Seoul" };
  add("asks", { ask: "형, 해도 돼?", title: "메일 정리" });
  // When
  const before = dayReport(state, settings, Date.parse("2026-11-02T11:59:00Z"));
  const after = dayReport(state, settings, Date.parse("2026-11-02T12:01:00Z"));
  const twice = dayReport(state, settings, Date.parse("2026-11-02T13:00:00Z"));
  // Then
  expect(before).toBeUndefined();
  expect(after?.split("\n")).toContain("형 답 기다림: 메일 정리");
  expect(after).toStartWith("BACKLOG_DAY 2026-11-02:");
  expect(twice).toBeUndefined();
});

test("a feed entry the owner approved by card runs within its own scope; one without approved_at only drafts", async () => {
  // Given
  const settings = { ...SETTINGS, feedCommand: ["node-read", "todo-list", "--json"] };
  const todos = [
    { todo_id: "pb-aaaaaaaaaaaa-1", title: "시뮬레이터 문제 3건 회신", status: "진행", approved_at: "2026-10-30T01:00:00Z" },
    { todo_id: "pb-bbbbbbbbbbbb-1", title: "회의록에서 뽑힌 일", status: "진행" },
  ];
  // When
  const lines = await feedIntake({ stateDir: state, settings, feed: async () => ({ todos }), now: () => now });
  const approved = readItem(state, "todo-pb-aaaaaaaaaaaa-1");
  const draft = readItem(state, "todo-pb-bbbbbbbbbbbb-1");
  // Then
  expect(lines).toEqual(["BACKLOG_INTAKE todo-pb-aaaaaaaaaaaa-1 (feed, owner-approved): 시뮬레이터 문제 3건 회신", "BACKLOG_INTAKE todo-pb-bbbbbbbbbbbb-1 (feed, draft only): 회의록에서 뽑힌 일"]);
  expect([approved?.draftOnly, approved?.by, approved?.ask]).toEqual([undefined, "feed:approved", undefined]);
  expect(readFileSync(approved?.brief ?? "", "utf8")).toContain("[쓰기 범위]");
  expect([draft?.draftOnly, draft?.by]).toEqual([true, "feed"]);
  expect(readFileSync(draft?.brief ?? "", "utf8")).toContain("[넘으면 안 되는 선] 읽기와 초안까지만");
});

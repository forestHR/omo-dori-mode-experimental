import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addItem, type BacklogItem, BacklogError, backlogTick, dayReport, decideItem, dropItem, feedIntake, feedItemId, DRAFT_ONLY_RULE, APPROVED_RULE, laneKeyOf, writeLimit, type FeedTodo, flockDir, followUpId, hostReserve, type InboxRow, listItems, orderIntake, pairIntake, readItem, StartRefused, type TickDeps, withBacklogLock } from "../src/backlog.ts";
import { type BacklogSettings, loadConfig } from "../src/config.ts";
import type { Lane } from "../src/registry.ts";
import { validateLaunch } from "../src/launch.ts";

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

const gated = () => {
  let open = (): void => {};
  const gate = new Promise<void>((r) => {
    open = r;
  });
  return { gate, open };
};

const deps = (patch: Partial<TickDeps> = {}, settings: Partial<BacklogSettings> = {}): TickDeps => ({
  stateDir: state,
  settings: { ...SETTINGS, hostDir: join(root, "host"), ...settings },
  now: () => now,
  lanes: async () => lanes,
  busy: async () => [],
  limited: () => undefined,
  host: { dir: join(root, "host"), user: "me", instance: "i1", max: settings.hostMaxLanes ?? SETTINGS.hostMaxLanes },
  launch: async (item, _brief, key) => {
    launched.push(item.id);
    lanes.push(lane(key));
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
  chmodSync(host, 0o1777);
  for (const [name, at] of [["ok.a", "2026-11-02T10:00:00Z"], ["moo.b", "2026-11-02T11:00:00Z"], ["gone.c", "2026-11-02T05:00:00Z"]] as const) writeFileSync(join(host, `${name}.json`), JSON.stringify({ at }));
  utimesSync(join(host, "gone.c.json"), (T0 - 7 * 3_600_000) / 1000, (T0 - 7 * 3_600_000) / 1000);
  for (const name of ["ok.a", "moo.b"]) utimesSync(join(host, `${name}.json`), T0 / 1000, T0 / 1000);
  add("mine");
  // When
  const full = await backlogTick(deps());
  rmSync(join(host, "moo.b.json"));
  const free = await backlogTick(deps(), { force: true });
  lanes = [lane("bl-mine", true)];
  const done = await backlogTick(deps(), { force: true });
  // Then
  expect(full[0]).toStartWith("BACKLOG_HOLD the host has 2 backlog lane(s) of all Doris (backlog.hostMaxLanes 2): ok.a, moo.b");
  expect(free[0]).toStartWith("BACKLOG_STARTED mine");
  expect(existsSync(join(host, "me.i1.mine.json"))).toBe(false);
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
  expect(readFileSync(join(state, "backlog", "items", "todo-pb-1697b943644f-1.md"), "utf8")).toContain("보안교육 이수");
  expect(done).toEqual(["BACKLOG_FEED_DONE todo-pb-1697b943644f-1: done on the source, dropped from the list"]);
  expect(listItems(state).map((i) => [i.id, i.status, writeLimit(i)])).toEqual([["todo-pb-1697b943644f-1", "dropped", "draft"]]);
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

test("two Doris of one account keep their own host slots: one Dori's pass never removes the other's", async () => {
  // Given: Dori 1 runs a backlog lane; Dori 2 of the same user has its own state
  add("one");
  await backlogTick(deps());
  const other = join(root, "state2");
  // When
  await backlogTick({ ...deps(), stateDir: other, lanes: async () => [], host: { dir: join(root, "host"), user: "me", instance: "i2", max: 3 } }, { force: true });
  // Then
  expect(readdirSync(join(root, "host")).filter((f) => f.endsWith(".json"))).toEqual(["me.i1.one.json"]);
});

test("two Doris starting at the same moment with one host slot left: exactly one starts", async () => {
  // Given: two Doris, each with one item, hostMaxLanes 1; whoever gets the slot waits inside its launch
  const g = gated();
  const doriB = join(root, "stateB");
  addItem(doriB, { id: "bee", title: "bee", brief, done: "file /tmp/x" }, { registered: false, at: "2026-11-02T15:00:00Z" });
  add("ay");
  const slow = (d: TickDeps): TickDeps => ({ ...d, launch: async (item, b, key) => {
    await g.gate;
    return d.launch(item, b, key);
  } });
  // When: the Dori that did not get the slot finishes first; only then the launch goes on
  const a = backlogTick(slow(deps({}, { hostMaxLanes: 1 })));
  const b = backlogTick(slow({ ...deps({}, { hostMaxLanes: 1 }), stateDir: doriB, host: { dir: join(root, "host"), user: "me", instance: "iB", max: 1 } }));
  const first = await Promise.race([a, b]);
  g.open();
  const lines = [...(await a), ...(await b)];
  // Then
  expect(first).toEqual([expect.stringMatching(/^BACKLOG_HOLD the host has 1 backlog lane\(s\)/)]);
  expect(lines.filter((l) => l.startsWith("BACKLOG_STARTED")).length).toBe(1);
});

test("a second pass while one runs is skipped, a change to the list cannot run inside a pass, and a drop after it sees the item running", async () => {
  // Given: a pass suspended inside the launch of its item
  const g = gated();
  let entered = (): void => {};
  const inLaunch = new Promise<void>((r) => {
    entered = r;
  });
  add("slow");
  const running = backlogTick(deps({ launch: async (_item, _b, key) => {
    entered();
    await g.gate;
    lanes.push(lane(key));
    return { pane: "aoe_slow", startup: "STARTUP_OK slow" };
  } }), { force: true });
  await inLaunch;
  // When
  const second = await backlogTick(deps(), { force: true });
  const during = readItem(state, "slow");
  const blocked = await withBacklogLock(state, 0, () => dropItem(state, "slow", "lead", "t")).then(() => "ran", (e: unknown) => String(e));
  g.open();
  await running;
  const after = await withBacklogLock(state, 10, () => dropItem(state, "slow", "lead", "t")).then(() => "ran", (e: unknown) => String(e));
  // Then
  expect(second[0]).toStartWith("BACKLOG_SKIPPED");
  expect([during?.status, during?.pane]).toEqual(["running", "starting"]);
  expect(blocked).toContain("a backlog pass held");
  expect(after).toContain("is running as a lane");
  expect(readItem(state, "slow")).toMatchObject({ status: "running", pane: "aoe_slow" });
});

test("a host slot is counted and written only under the host directory's lock that every Dori takes", async () => {
  // Given: another Dori holds the host lock
  const hostDir = join(root, "host");
  mkdirSync(hostDir);
  chmodSync(hostDir, 0o1777);
  const other = await flockDir(hostDir, 5);
  const h = { dir: hostDir, user: "me", instance: "i1", max: 1 };
  // When
  const reserving = hostReserve(h, "ay", now);
  const writtenWhileHeld = existsSync(join(hostDir, "me.i1.ay.json"));
  await other?.release();
  const result = await reserving;
  // Then
  expect(other).toBeDefined();
  expect(writtenWhileHeld).toBe(false);
  expect(result).toBeUndefined();
  expect(existsSync(join(hostDir, "me.i1.ay.json"))).toBe(true);
});

test("an approved follow-up has its own Done line, is dropped when the source finishes first, and gets its own id for the longest draft ids", async () => {
  // Given: a draft whose lane finished, with an id of the longest lane-key length
  const settings = { ...SETTINGS, feedCommand: ["node-read", "todo-list", "--json"] };
  const ref = `pb-${"a".repeat(54)}`;
  const draftId = feedItemId(ref);
  const entry = (status: string, approved: boolean) => ({ todo_id: ref, title: "긴 할 일", status, ...(approved ? { approved_at: "2026-11-02T15:00:00Z", auto_applied: false } : {}) });
  const sweep = (todos: FeedTodo[]) => feedIntake({ stateDir: state, settings, feed: async () => ({ todos }), now: () => now });
  await sweep([entry("진행", false)]);
  writeFileSync(join(state, "backlog", "items", `${draftId}.json`), JSON.stringify({ ...readItem(state, draftId)!, status: "done" }));
  // When
  const approved = await sweep([entry("진행", true)]);
  const follow = readItem(state, followUpId(draftId));
  const finished = await sweep([entry("완료", true)]);
  // Then
  expect(draftId.length).toBeLessThanOrEqual(61);
  expect(followUpId(draftId)).not.toBe(draftId);
  expect(followUpId(draftId).length).toBeLessThanOrEqual(61);
  expect(approved[0]).toStartWith(`BACKLOG_INTAKE ${followUpId(draftId)} (feed, owner-approved, after draft ${draftId})`);
  expect(follow?.done).toBe(`file ${state}/backlog/reports/${followUpId(draftId)}.md`);
  expect(follow?.done).not.toBe(readItem(state, draftId)?.done);
  expect(finished).toEqual([`BACKLOG_FEED_DONE ${followUpId(draftId)}: done on the source, dropped from the list`]);
  expect(readItem(state, followUpId(draftId))?.status).toBe("dropped");
});

test("finishing a feed entry drops only its own follow-up, never an independent entry whose name looks like one", async () => {
  // Given: two independent feed entries x and x-ok, both open
  const settings = { ...SETTINGS, feedCommand: ["node-read", "todo-list", "--json"] };
  const sweep = (todos: FeedTodo[]) => feedIntake({ stateDir: state, settings, feed: async () => ({ todos }), now: () => now });
  await sweep([{ todo_id: "x1", title: "x", status: "진행" }, { todo_id: "x1-ok", title: "x-ok", status: "진행" }]);
  // When
  const lines = await sweep([{ todo_id: "x1", title: "x", status: "완료" }, { todo_id: "x1-ok", title: "x-ok", status: "진행" }]);
  // Then
  expect(lines).toEqual(["BACKLOG_FEED_DONE todo-x1: done on the source, dropped from the list"]);
  expect(readItem(state, "todo-x1-ok")?.status).toBe("open");
});

test("an unsafe shared host directory is refused, and a link planted at a slot's name is replaced, never followed", async () => {
  // Given: a victim file, a host dir that is a link, one without the sticky bit, and a sticky one with a planted link
  const victim = join(root, "victim.txt");
  writeFileSync(victim, "keep");
  const real = join(root, "realdir");
  mkdirSync(real);
  symlinkSync(real, join(root, "linkdir"));
  const plain = join(root, "plain");
  mkdirSync(plain);
  chmodSync(plain, 0o777);
  const sticky = join(root, "sticky");
  mkdirSync(sticky);
  chmodSync(sticky, 0o1777);
  symlinkSync(victim, join(sticky, "me.i1.ay.json"));
  const at = (dir: string) => ({ dir, user: "me", instance: "i1", max: 3 });
  // When
  const viaLink = await hostReserve(at(join(root, "linkdir")), "ay", now);
  const noSticky = await hostReserve(at(plain), "ay", now);
  const planted = await hostReserve(at(sticky), "ay", now);
  // Then
  expect(viaLink).toContain("is not a plain directory");
  expect(noSticky).toContain("has no sticky bit");
  expect(planted).toBeUndefined();
  expect(readFileSync(victim, "utf8")).toBe("keep");
  expect(readdirSync(real)).toEqual([]);
});

test("a follow-up the lead replaces (the fix of a held one) still belongs to its draft and is dropped with it", async () => {
  // Given: an approved follow-up of a finished draft
  const settings = { ...SETTINGS, feedCommand: ["node-read", "todo-list", "--json"] };
  const sweep = (todos: FeedTodo[]) => feedIntake({ stateDir: state, settings, feed: async () => ({ todos }), now: () => now });
  await sweep([{ todo_id: "pb-dddddddddddd-1", title: "d", status: "진행" }]);
  writeFileSync(join(state, "backlog", "items", "todo-pb-dddddddddddd-1.json"), JSON.stringify({ ...readItem(state, "todo-pb-dddddddddddd-1")!, status: "done" }));
  await sweep([{ todo_id: "pb-dddddddddddd-1", title: "d", status: "진행", approved_at: "2026-11-02T15:00:00Z", auto_applied: false }]);
  // When: the lead replaces it, then the source finishes
  addItem(state, { id: "appr-pb-dddddddddddd-1", title: "d (고침)", brief, done: "file /tmp/x" }, { registered: false, at: "2026-11-02T16:00:00Z" });
  const done = await sweep([{ todo_id: "pb-dddddddddddd-1", title: "d", status: "완료" }]);
  // Then
  expect(readItem(state, "appr-pb-dddddddddddd-1")?.followUpOf).toBe("todo-pb-dddddddddddd-1");
  expect(done).toEqual(["BACKLOG_FEED_DONE appr-pb-dddddddddddd-1: done on the source, dropped from the list"]);
});

test("feed entries that cleaning or cutting would merge keep their own items, and finishing one leaves the other", async () => {
  // Given
  const settings = { ...SETTINGS, feedCommand: ["node-read", "todo-list", "--json"] };
  const sweep = (todos: FeedTodo[]) => feedIntake({ stateDir: state, settings, feed: async () => ({ todos }), now: () => now });
  const long = (tail: string) => `pb-${"e".repeat(70)}-${tail}`;
  // When
  const added = await sweep([{ todo_id: "mail/A", title: "a1", status: "진행" }, { todo_id: "mail:A", title: "a2", status: "진행" }, { todo_id: long("1"), title: "l1", status: "진행" }, { todo_id: long("2"), title: "l2", status: "진행" }]);
  const done = await sweep([{ todo_id: "mail/A", title: "a1", status: "완료" }, { todo_id: long("1"), title: "l1", status: "완료" }]);
  // Then
  expect(new Set([feedItemId("mail/A"), feedItemId("mail:A"), feedItemId(long("1")), feedItemId(long("2"))]).size).toBe(4);
  expect(added.length).toBe(4);
  expect(done).toEqual([`BACKLOG_FEED_DONE ${feedItemId("mail/A")}: done on the source, dropped from the list`, `BACKLOG_FEED_DONE ${feedItemId(long("1"))}: done on the source, dropped from the list`]);
  expect([readItem(state, feedItemId("mail:A"))?.status, readItem(state, feedItemId(long("2")))?.status]).toEqual(["open", "open"]);
  expect(readItem(state, feedItemId("mail:A"))?.source).toBe("mail:A");
  expect(feedItemId("pb-1697b943644f-1")).toBe("todo-pb-1697b943644f-1");
});

test("a pair repair starts without an owner link even where writes need one (the owner's standing repair rule), and config loading says so once", async () => {
  // Given
  const file = join(root, "both.json");
  writeFileSync(file, JSON.stringify({ backlog: { pairRepairPattern: "^도리야, 수리 요청", writeNeedsOwnerLink: true } }));
  const warned: string[] = [];
  const settings = { ...SETTINGS, pairRepairPattern: "^도리야, 수리 요청", pairRequestPattern: "^도리야,", writeNeedsOwnerLink: true };
  const inbox: InboxRow[] = [{ id: "2000", scope: "pair-bot", author_id: "B1", content: "옛 글" }];
  const intake = () => pairIntake({ stateDir: state, settings, rows: () => inbox, pairBots: ["B1"], guild: "1", ownerLink: async () => undefined, now: () => now });
  // When
  await loadConfig(file, root, (line) => warned.push(line));
  await intake();
  inbox.push({ id: "2001", scope: "pair-bot", author_id: "B1", channel_id: "3", content: "도리야, 수리 요청: 감시가 멈췄어" });
  await intake();
  // Then
  expect(warned.filter((w) => w.startsWith("CONFIG_BACKLOG_REPAIR_EXEMPT")).length).toBe(1);
  expect(readItem(state, "pair-2001")?.ask).toBeUndefined();
});

test("the host and account guards are checked again before each start, so the second start of a pass waits when the first used the room", async () => {
  // Given: room for two starts, but the host is full after the first
  add("g1", { priority: "1" });
  add("g2", { priority: "2" });
  let busyCalls = 0;
  // When
  const lines = await backlogTick(deps({ busy: async () => (busyCalls++ === 0 ? [] : ["panes 20 >= 20"]) }, { maxStarts: 2 }));
  // Then
  expect(launched).toEqual(["g1"]);
  expect(lines).toEqual([expect.stringMatching(/^BACKLOG_STARTED g1/), "BACKLOG_HOLD panes 20 >= 20; 1 item(s) wait"]);
});

test("a feed entry never changes an item the lead added by hand under the same id", async () => {
  // Given
  const settings = { ...SETTINGS, feedCommand: ["node-read", "todo-list", "--json"] };
  addItem(state, { id: "todo-x9", title: "손으로 넣은 일", brief, done: "file /tmp/x" }, { registered: false, at: "2026-11-02T15:00:00Z" });
  // When
  const lines = await feedIntake({ stateDir: state, settings, feed: async () => ({ todos: [{ todo_id: "x9", title: "x9", status: "완료" }] }), now: () => now });
  // Then
  expect(lines).toEqual(["BACKLOG_FEED_CLASH todo-x9: held by an item lead added, not feed entry x9; left alone"]);
  expect(readItem(state, "todo-x9")?.status).toBe("open");
});

const feedSettings = { ...SETTINGS, feedCommand: ["node-read", "todo-list", "--json"] };
const feedSweep = (todos: FeedTodo[]) => feedIntake({ stateDir: state, settings: feedSettings, feed: async () => ({ todos }), now: () => now });
const sentBrief = (id: string) => readFileSync(join(state, "backlog", "launched", `${id}.md`), "utf8");

test("only the owner's card approves a feed entry: approved_at with auto_applied false; auto-applied or unknown only drafts", async () => {
  // Given / When
  await feedSweep([
    { todo_id: "c1", title: "card", status: "진행", approved_at: "2026-10-30T01:00:00Z", auto_applied: false },
    { todo_id: "a1", title: "auto", status: "진행", approved_at: "2026-10-30T01:00:00Z", auto_applied: true },
    { todo_id: "u1", title: "unknown", status: "진행", approved_at: "2026-10-30T01:00:00Z" },
  ]);
  // Then
  expect(["todo-c1", "todo-a1", "todo-u1"].map((id) => writeLimit(readItem(state, id)!))).toEqual(["approved", "draft", "draft"]);
});

test("the write limit comes from the item's state at each launch: a draft the lead replaced with a plain brief still launches draft-only", async () => {
  // Given: a feed draft the lead replaces with an ordinary brief
  await feedSweep([{ todo_id: "pb-565656565656-1", title: "d", status: "진행" }]);
  addItem(state, { id: "todo-pb-565656565656-1", title: "d (고침)", brief, done: "file /tmp/x" }, { registered: false, at: "2026-11-02T16:00:00Z" });
  // When
  await backlogTick(deps(), { force: true });
  // Then
  expect(writeLimit(readItem(state, "todo-pb-565656565656-1")!)).toBe("draft");
  expect(sentBrief("todo-pb-565656565656-1").trimEnd().endsWith(DRAFT_ONLY_RULE)).toBe(true);
});

test("an approval is bound to the content it was given for: changed content voids it and asks again; the owner's answer approves the new content", async () => {
  // Given: an approved entry about file A, not yet started (no room)
  await feedSweep([{ todo_id: "pb-343434343434-1", title: "파일 A 고치기", status: "진행", approved_at: "2026-11-02T15:00:00Z", auto_applied: false }]);
  // When: the content changes to file B
  const changed = await feedSweep([{ todo_id: "pb-343434343434-1", title: "파일 B 고치기", status: "진행", approved_at: "2026-11-02T15:00:00Z", auto_applied: false }]);
  const asked = readItem(state, "todo-pb-343434343434-1")!;
  const pass = await backlogTick(deps(), { force: true });
  decideItem(state, "todo-pb-343434343434-1", "응, B로 해", new Date(now).toISOString(), "k");
  await backlogTick(deps(), { force: true });
  // Then
  expect(changed).toEqual(["BACKLOG_FEED_CHANGED todo-pb-343434343434-1: its content changed after the owner approved it; the approval is void and he is asked again"]);
  expect([writeLimit(asked), Boolean(asked.ask)]).toEqual(["draft", true]);
  expect(pass).toContain("BACKLOG_ASK todo-pb-343434343434-1: in the lead's inbox; not started before dori backlog decide");
  expect(launched).toEqual(["todo-pb-343434343434-1"]);
  const sent = sentBrief("todo-pb-343434343434-1");
  expect(sent).toContain(APPROVED_RULE);
  expect(sent.slice(sent.indexOf("[승인된 할 일 내용]"))).toContain("파일 B 고치기");
});

test("backlog lanes run under bl-<id>; an ordinary lane registered under that key during the pass is never taken as the start", async () => {
  // Given: while the pass launches, another lane takes the key and the backlog launch is refused
  add("race1");
  const keys: string[] = [];
  const d = deps({ launch: async (_item, _b, key) => {
    keys.push(key);
    lanes.push({ ...lane(key), brief: "/elsewhere/brief.md" });
    throw new StartRefused(`lane ${key} is already registered`);
  } });
  // When
  const pass = await backlogTick(d);
  // Then
  expect(keys).toEqual([laneKeyOf("race1")]);
  expect(laneKeyOf("race1")).toBe("bl-race1");
  expect(pass).toEqual(["BACKLOG_HELD race1: dori launch refused it: lane bl-race1 is already registered"]);
  expect(readItem(state, "race1")?.status).toBe("open");
});

test("dori launch refuses a bl- key unless the backlog starts it", async () => {
  // Given
  const fake = { registry: { read: async () => null } } as unknown as Parameters<typeof validateLaunch>[0];
  const input = { key: "bl-x1", title: "x", brief, done: "file /tmp/x" };
  // When
  const ordinary = await validateLaunch(fake, input).then(() => "ok", (e: unknown) => String(e));
  const backlog = await validateLaunch(fake, { ...input, backlog: true }).then(() => "ok", (e: unknown) => String(e));
  // Then
  expect(ordinary).toContain("keys starting with bl- belong to the backlog");
  expect(backlog).toBe("ok");
});

test("an entry the owner approves after its draft lane finished gets one approved follow-up", async () => {
  // Given: a draft whose lane finished
  await feedSweep([{ todo_id: "pb-bbbbbbbbbbbb-1", title: "b", status: "진행" }]);
  writeFileSync(join(state, "backlog", "items", "todo-pb-bbbbbbbbbbbb-1.json"), JSON.stringify({ ...readItem(state, "todo-pb-bbbbbbbbbbbb-1")!, status: "done" }));
  // When
  const lines = await feedSweep([{ todo_id: "pb-bbbbbbbbbbbb-1", title: "b", status: "진행", approved_at: "2026-11-02T15:00:00Z", auto_applied: false }]);
  const again = await feedSweep([{ todo_id: "pb-bbbbbbbbbbbb-1", title: "b", status: "진행", approved_at: "2026-11-02T15:00:00Z", auto_applied: false }]);
  // Then
  expect(lines).toEqual(["BACKLOG_INTAKE appr-pb-bbbbbbbbbbbb-1 (feed, owner-approved, after draft todo-pb-bbbbbbbbbbbb-1): b"]);
  expect(again).toEqual([]);
  expect(writeLimit(readItem(state, "appr-pb-bbbbbbbbbbbb-1")!)).toBe("approved");
});

test("an approval given for other content never counts, whatever else the item says", () => {
  // Given
  const base = { id: "z1", title: "z", brief, done: "file /tmp/x", priority: 5, by: "feed", status: "open" as const, addedAt: "t", log: [], source: "z1", feedHash: "new" };
  // When / Then
  expect(writeLimit({ ...base, approval: { at: "t", hash: "old", by: "card" } })).toBe("draft");
  expect(writeLimit({ ...base, approval: { at: "t", hash: "new", by: "card" } })).toBe("approved");
  expect(writeLimit({ ...base, source: undefined })).toBe("none");
});

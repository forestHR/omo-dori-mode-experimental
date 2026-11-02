import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addItem, APPROVED_RULE, type BacklogItem, BacklogError, backlogTick, dayReport, decideItem, DRAFT_ONLY_RULE, dropItem, feedIntake, feedItemId, type FeedTodo, inboxReader, type InboxRow, orderIntake, readLines, pairIntake, isPairItem, flockDir, followUpId, hostReserve, laneKeyOf, listItems, READ_ONLY_RULE, rowItemId, readItem, StartRefused, todoOf, type TickDeps, withBacklogLock, writeLimit } from "../src/backlog.ts";
import { type BacklogSettings, loadConfig } from "../src/config.ts";
import type { Lane } from "../src/registry.ts";
import { briefGaps, COMMON_LEDGER, loadLedger } from "../src/directives.ts";
import { asStartFailure, eightSteps, LaunchError, LaunchFailed, launchLane, uiSteps, validateLaunch } from "../src/launch.ts";
import { depsFor, fakeClock, fakeRunner, newWorld } from "./fakes.ts";

const SETTINGS: BacklogSettings = { enabled: true, everyMin: 60, maxLanes: 3, maxStarts: 1, hostMaxLanes: 2, hostDir: "", pairRepairPattern: "", intakeDone: "file {stateDir}/backlog/reports/{id}.md", writeNeedsOwnerLink: false, feedCommand: [], orderKinds: [], dayReportAt: "", timeZone: "UTC" };
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

const sentBrief = (id: string) => readFileSync(join(state, "backlog", "launched", `${id}.md`), "utf8");

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
  expect(() => decideItem(state, "x1", "응", "t", "k")).toThrow(/no open question/);
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
  expect(on.backlog).toMatchObject({ enabled: true, maxLanes: 2, maxStarts: 1, hostMaxLanes: 3, writeNeedsOwnerLink: false });
  expect(Object.keys(on.backlog).sort()).toEqual(["dayReportAt", "enabled", "everyMin", "feedCommand", "hostDir", "hostMaxLanes", "intakeDone", "maxLanes", "maxStarts", "orderKinds", "pairRepairPattern", "timeZone", "writeNeedsOwnerLink"]);
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

test("an item added --read-only launches with the read-only rule, whatever its brief says", async () => {
  // Given
  addItem(state, { id: "ro1", title: "ro", brief, done: "file /tmp/x", readOnly: true }, { registered: false, at: "2026-11-02T15:00:00Z", needOwnerLink: true });
  // When
  await backlogTick(deps());
  // Then
  expect(sentBrief("ro1")).toContain(READ_ONLY_RULE);
});

test("a backend failure of a launch is tried again; a refusal of the launch input holds the item", async () => {
  // Given: the launch errors as dori launch raises them, through the same conversion the CLI uses
  add("op1", { priority: "1" });
  add("bad1", { priority: "2" });
  const d = deps({ launch: async (item) => {
    throw asStartFailure(item.id === "op1" ? new LaunchFailed("aoe add failed: exit 1") : new LaunchError("Done line is not checkable: x"));
  } }, { maxStarts: 2 });
  // When
  const lines = await backlogTick(d);
  // Then
  expect(lines).toEqual(["BACKLOG_START_FAILED op1 (1/2): aoe add failed: exit 1", "BACKLOG_HELD bad1: dori launch refused it: Done line is not checkable: x"]);
});

test("a launch whose session failed after it opened the work thread is tried again in that same thread (real launchLane)", async () => {
  // Given: the real launch with fakes: the first aoe add fails, the second works; threads opened are counted
  const world = newWorld();
  const base = depsFor(world, fakeClock(T0), join(root, "launch-state"), { backend: "aoe", leadPane: "aoe_Dori_0a1b2c3d", watchLog: join(root, "watch.log") });
  let adds = 0;
  const opened: string[] = [];
  const run: typeof base.run = async (argv, o) => (argv[0] === "aoe" && argv[1] === "add" && adds++ === 0 ? { code: 1, out: "", err: "aoe: tmux server busy" } : fakeRunner(world)(argv, o));
  const ld = { ...base, run, openThread: async (title: string) => (opened.push(title), `discord:10000000000000010${opened.length}`) };
  add("thr1");
  const d = deps({ launch: async (item, b, key) => {
    const r = await launchLane(ld, { key, backlog: true, title: item.title, brief: b, done: item.done, thread: item.thread, noThread: item.noThread, cwd: item.cwd }).catch((e: unknown) => {
      throw asStartFailure(e);
    });
    lanes.push(lane(key));
    return { pane: r.lane.pane ?? "?", startup: r.startup };
  } });
  // When
  const first = await backlogTick(d);
  const afterFirst = readItem(state, "thr1")!;
  const second = await backlogTick(d, { force: true });
  // Then
  expect(first[0]).toStartWith("BACKLOG_START_FAILED thr1 (1/2):");
  expect(afterFirst.thread).toBe("discord:100000000000000101");
  expect(second[0]).toStartWith("BACKLOG_STARTED thr1");
  expect(opened.length).toBe(1);
  expect((await ld.registry.read("bl-thr1"))?.thread).toBe("discord:100000000000000101");
});

test("dropping a running item names the lane to close by its real key", async () => {
  // Given
  add("dr1");
  await backlogTick(deps());
  // When
  const msg = (() => { try { dropItem(state, "dr1", "lead", "t"); return "dropped"; } catch (e) { return String(e); } })();
  // Then
  expect(msg).toContain("dori close bl-dr1");
});

test("a fresh host slot another account's umask made unreadable still counts toward hostMaxLanes, and our own slots are written readable", async () => {
  // Given: one live slot of another Dori that this account cannot read, hostMaxLanes 1
  const host = join(root, "host");
  mkdirSync(host, { recursive: true });
  chmodSync(host, 0o1777);
  writeFileSync(join(host, "other.ab12cd34.x.json"), JSON.stringify({ at: "2026-11-02T14:00:00Z" }));
  chmodSync(join(host, "other.ab12cd34.x.json"), 0o000);
  utimesSync(join(host, "other.ab12cd34.x.json"), T0 / 1000, T0 / 1000);
  add("um1");
  // When
  const full = await backlogTick(deps({}, { hostMaxLanes: 1 }));
  rmSync(join(host, "other.ab12cd34.x.json"));
  const old = process.umask(0o077);
  try {
    await backlogTick(deps({}, { hostMaxLanes: 1 }), { force: true });
  } finally {
    process.umask(old);
  }
  // Then
  expect(full[0]).toStartWith("BACKLOG_HOLD the host has 1 backlog lane(s)");
  expect(lstatSync(join(host, "me.i1.um1.json")).mode & 0o777).toBe(0o644);
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

test("an approved follow-up has its own Done line, is dropped when the source finishes first, and gets its own id for the longest draft ids", async () => {
  // Given: a draft whose lane finished, with an id of the longest lane-key length
  const settings = { ...SETTINGS, feedCommand: ["node-read", "todo-list", "--json"] };
  const ref = `pb-${"a".repeat(54)}`;
  const draftId = feedItemId(ref);
  const entry = (status: string, approved: boolean) => ({ todo_id: ref, title: "긴 할 일", status, ...(approved ? { approved_at: "2026-11-02T15:00:00Z", auto_applied: false } : {}) });
  const sweep = (todos: FeedTodo[]) => feedIntake({ stateDir: state, settings, feed: async () => ({ todos }), now: () => now });
  await sweep([entry("진행", false)]);
  writeFileSync(join(state, "backlog", "items", `${draftId}.json`), JSON.stringify({ ...readItem(state, draftId)!, status: "done", ranAs: "draft" }));
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

test("feed entries that cleaning or cutting would merge keep their own items, and finishing one leaves the other", async () => {
  // Given
  const settings = { ...SETTINGS, feedCommand: ["node-read", "todo-list", "--json"] };
  const sweep = (todos: FeedTodo[]) => feedIntake({ stateDir: state, settings, feed: async () => ({ todos }), now: () => now });
  const long = (tail: string) => `pb-${"e".repeat(70)}-${tail}`;
  // When
  const added = await sweep([{ todo_id: "mail/A", title: "a1", status: "진행" }, { todo_id: "mail:A", title: "a2", status: "진행" }, { todo_id: long("1"), title: "l1", status: "진행" }, { todo_id: long("2"), title: "l2", status: "진행" }]);
  const done = await sweep([{ todo_id: "mail/A", title: "a1", status: "완료" }, { todo_id: "mail:A", title: "a2", status: "진행" }, { todo_id: long("1"), title: "l1", status: "완료" }, { todo_id: long("2"), title: "l2", status: "진행" }]);
  // Then
  expect(new Set([feedItemId("mail/A"), feedItemId("mail:A"), feedItemId(long("1")), feedItemId(long("2"))]).size).toBe(4);
  expect(added.length).toBe(4);
  expect(done).toEqual([`BACKLOG_FEED_DONE ${feedItemId("mail/A")}: done on the source, dropped from the list`, `BACKLOG_FEED_DONE ${feedItemId(long("1"))}: done on the source, dropped from the list`]);
  expect([readItem(state, feedItemId("mail:A"))?.status, readItem(state, feedItemId(long("2")))?.status]).toEqual(["open", "open"]);
  expect(readItem(state, feedItemId("mail:A"))?.source).toBe("mail:A");
  expect(feedItemId("pb-1697b943644f-1")).toBe("todo-pb-1697b943644f-1");
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
  expect(sentBrief("todo-pb-565656565656-1").indexOf(DRAFT_ONLY_RULE)).toBeGreaterThan(sentBrief("todo-pb-565656565656-1").indexOf("read a file"));
});

test("an approval is bound to the content it was given for: changed content voids it and asks again; the owner's answer approves the new content", async () => {
  // Given: an approved entry about file A, not yet started (no room)
  await feedSweep([{ todo_id: "pb-343434343434-1", title: "파일 A 고치기", status: "진행", approved_at: "2026-11-02T15:00:00Z", auto_applied: false }]);
  // When: the content changes to file B
  const changed = await feedSweep([{ todo_id: "pb-343434343434-1", title: "파일 B 고치기", status: "진행", approved_at: "2026-11-02T15:00:00Z", auto_applied: false }]);
  const asked = readItem(state, "todo-pb-343434343434-1")!;
  const pass = await backlogTick(deps(), { force: true });
  const q = readItem(state, "todo-pb-343434343434-1")!.approvalAsk!;
  decideItem(state, "todo-pb-343434343434-1", "응, B로 해", new Date(now).toISOString(), "k", q.id, q.hash);
  await backlogTick(deps(), { force: true });
  // Then
  expect(changed).toEqual(["BACKLOG_FEED_CHANGED todo-pb-343434343434-1: its content changed; approvals and open questions about the old content are void and asked again"]);
  expect([writeLimit(asked), asked.approvalAsk?.id]).toEqual(["draft", "q1"]);
  expect(pass.some((l) => l.startsWith("BACKLOG_ASK todo-pb-343434343434-1 q1: content"))).toBe(true);
  expect(launched).toEqual(["todo-pb-343434343434-1"]);
  const sent = sentBrief("todo-pb-343434343434-1");
  expect(sent).toContain(APPROVED_RULE);
  expect(sent.slice(sent.indexOf("[지금 할 일 내용"))).toContain("파일 B 고치기");
});

test("an entry the owner approves after its draft lane finished gets one approved follow-up", async () => {
  // Given: a draft whose lane finished
  await feedSweep([{ todo_id: "pb-bbbbbbbbbbbb-1", title: "b", status: "진행" }]);
  writeFileSync(join(state, "backlog", "items", "todo-pb-bbbbbbbbbbbb-1.json"), JSON.stringify({ ...readItem(state, "todo-pb-bbbbbbbbbbbb-1")!, status: "done", ranAs: "draft" }));
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

test("a question the lead was told of, then a content change: a new question id is told again and the old answer does nothing", async () => {
  // Given: an approved feed item the lead replaced with his own question, told to him
  await feedSweep([{ todo_id: "pb-777777777777-1", title: "v1", status: "진행", approved_at: "2026-11-02T15:00:00Z", auto_applied: false }]);
  addItem(state, { id: "todo-pb-777777777777-1", title: "v", brief, done: "file /tmp/x", ask: "어느 폴더?" }, { registered: false, at: "2026-11-02T15:10:00Z" });
  const first = await backlogTick(deps(), { force: true });
  const old = readItem(state, "todo-pb-777777777777-1")!;
  // When: the content changes
  await feedSweep([{ todo_id: "pb-777777777777-1", title: "v2", status: "진행", approved_at: "2026-11-02T15:00:00Z", auto_applied: false }]);
  const oldAnswer = (() => { try { decideItem(state, "todo-pb-777777777777-1", "폴더 A", "t", "k", old.askId, old.askHash); return "recorded"; } catch (e) { return String(e); } })();
  const oldIdNewHash = (() => { try { decideItem(state, "todo-pb-777777777777-1", "폴더 A", "t", "k", old.askId, readItem(state, "todo-pb-777777777777-1")!.feedHash); return "recorded"; } catch (e) { return String(e); } })();
  const second = await backlogTick(deps(), { force: true });
  const now2 = readItem(state, "todo-pb-777777777777-1")!;
  // Then
  expect(first).toContain(`BACKLOG_ASK todo-pb-777777777777-1: in the lead's inbox; not started before dori backlog decide`);
  expect(oldAnswer).toContain("is not the open one");
  expect(oldIdNewHash).toContain("is not the open one");
  expect([now2.askId === old.askId, now2.approvalAsk?.id === undefined, Boolean(now2.askedAt)]).toEqual([false, false, true]);
  expect(rows.filter((r) => r.kind === "backlog-ask").length).toBe(3);
  expect(second.filter((l) => l.startsWith("BACKLOG_ASK")).length).toBe(2);
  expect(launched).toEqual([]);
});

test("content that changes again while the owner is being asked (A, B, C): only an answer about C counts", async () => {
  // Given: approved A, changed to B (asked), changed to C before the answer
  const entry = (title: string) => ({ todo_id: "pb-888888888888-1", title, status: "진행", approved_at: "2026-11-02T15:00:00Z", auto_applied: false });
  await feedSweep([entry("A")]);
  await feedSweep([entry("B")]);
  await backlogTick(deps(), { force: true });
  const askedB = readItem(state, "todo-pb-888888888888-1")!.approvalAsk!;
  await feedSweep([entry("C")]);
  const askedC = readItem(state, "todo-pb-888888888888-1")!.approvalAsk!;
  // When
  const late = (() => { try { decideItem(state, "todo-pb-888888888888-1", "B로 해", "t", "k", askedB.id, askedB.hash); return "recorded"; } catch (e) { return String(e); } })();
  const currentIdOldHash = (() => { try { decideItem(state, "todo-pb-888888888888-1", "B로 해", "t", "k", askedC.id, askedB.hash); return "recorded"; } catch (e) { return String(e); } })();
  const held = await backlogTick(deps());
  decideItem(state, "todo-pb-888888888888-1", "C로 해", new Date(now).toISOString(), "k", askedC.id, askedC.hash);
  await backlogTick(deps(), { force: true });
  // Then
  expect(askedC.id).not.toBe(askedB.id);
  expect(askedC.hash).not.toBe(askedB.hash);
  expect(late).toContain("Nothing was recorded");
  expect(currentIdOldHash).toContain("Nothing was recorded");
  expect(held.some((l) => l.startsWith("BACKLOG_STARTED"))).toBe(false);
  expect(launched).toEqual(["todo-pb-888888888888-1"]);
  expect(sentBrief("todo-pb-888888888888-1").slice(sentBrief("todo-pb-888888888888-1").indexOf("[지금 할 일 내용"))).toContain('"title": "C"');
});

test("read-only is the strongest limit: an approved feed item replaced --read-only gets no write permission, before or after approval", async () => {
  // Given: one approved item replaced read-only, one draft replaced read-only and approved afterwards
  await feedSweep([{ todo_id: "r1", title: "r1", status: "진행", approved_at: "2026-11-02T15:00:00Z", auto_applied: false }, { todo_id: "r2", title: "r2", status: "진행" }]);
  for (const id of ["todo-r1", "todo-r2"]) addItem(state, { id, title: id, brief, done: "file /tmp/x", readOnly: true }, { registered: false, at: "2026-11-02T16:00:00Z" });
  await feedSweep([{ todo_id: "r1", title: "r1", status: "진행", approved_at: "2026-11-02T15:00:00Z", auto_applied: false }, { todo_id: "r2", title: "r2", status: "진행", approved_at: "2026-11-02T16:30:00Z", auto_applied: false }]);
  // When
  await backlogTick(deps({}, { maxStarts: 2 }), { force: true });
  // Then
  for (const id of ["todo-r1", "todo-r2"]) {
    expect(sentBrief(id)).toContain(READ_ONLY_RULE);
    expect(sentBrief(id)).not.toContain(APPROVED_RULE);
  }
});

test("a draft whose content changed while it waited launches with the content as it is now", async () => {
  // Given: draft A waits (no room), then the feed changes it to B
  await feedSweep([{ todo_id: "pb-909090909090-1", title: "내용 A", status: "진행" }]);
  await backlogTick(deps({}, { maxStarts: 0 }), { force: true });
  await feedSweep([{ todo_id: "pb-909090909090-1", title: "내용 B", status: "진행" }]);
  // When
  await backlogTick(deps(), { force: true });
  // Then
  const sent = sentBrief("todo-pb-909090909090-1");
  expect(sent).toContain(DRAFT_ONLY_RULE);
  expect(sent.slice(sent.indexOf("[지금 할 일 내용"))).toContain('"title": "내용 B"');
});

test("the day report counts content questions as waiting on the owner", () => {
  // Given: an item waiting on a content question only
  mkdirSync(join(state, "backlog", "items"), { recursive: true });
  writeFileSync(join(state, "backlog", "items", "cq1.json"), JSON.stringify({ id: "cq1", title: "바뀐 할 일", brief, done: "file /tmp/x", priority: 5, by: "feed", status: "open", addedAt: "t", log: [], approvalAsk: { id: "q1", hash: "h" } }));
  // When
  const report = dayReport(state, { ...SETTINGS, dayReportAt: "00:00", timeZone: "UTC" }, now);
  // Then
  expect(report?.split("\n")).toContain("형 답 기다림: 바뀐 할 일");
});

test("an approval seen while the draft ran, then a content change: the follow-up asks again instead of taking the old card", async () => {
  // Given: draft A runs; the owner's card for A arrives while it runs; the content changes to B; the draft finishes
  const entry = (title: string, approved: boolean) => ({ todo_id: "pb-454545454545-1", title, status: "진행", ...(approved ? { approved_at: "2026-11-02T15:00:00Z", auto_applied: false } : {}) });
  await feedSweep([entry("A", false)]);
  await backlogTick(deps(), { force: true });
  await feedSweep([entry("A", true)]);
  await feedSweep([entry("B", true)]);
  lanes = [lane(laneKeyOf("todo-pb-454545454545-1"), true)];
  await backlogTick(deps(), { force: true });
  // When
  const lines = await feedSweep([entry("B", true)]);
  const follow = readItem(state, "appr-pb-454545454545-1")!;
  // Then
  expect(readItem(state, "todo-pb-454545454545-1")?.ranAs).toBe("draft");
  expect(lines).toEqual(["BACKLOG_INTAKE appr-pb-454545454545-1 (feed, asks again: approved content changed, after draft todo-pb-454545454545-1): B"]);
  expect([writeLimit(follow), follow.approvalAsk?.hash === follow.feedHash]).toEqual(["draft", true]);
});

test("a draft the lead made read-only stays read-only in its approved follow-up", async () => {
  // Given: a feed draft replaced --read-only runs, the owner's card comes, the lane closes
  const entry = (approved: boolean) => ({ todo_id: "pb-676767676767-1", title: "ro", status: "진행", ...(approved ? { approved_at: "2026-11-02T15:00:00Z", auto_applied: false } : {}) });
  await feedSweep([entry(false)]);
  addItem(state, { id: "todo-pb-676767676767-1", title: "ro", brief, done: "file /tmp/x", readOnly: true }, { registered: false, at: "2026-11-02T16:00:00Z" });
  await backlogTick(deps(), { force: true });
  await feedSweep([entry(true)]);
  lanes = [lane(laneKeyOf("todo-pb-676767676767-1"), true)];
  await backlogTick(deps(), { force: true });
  // When
  await feedSweep([entry(true)]);
  await backlogTick(deps(), { force: true });
  // Then
  expect(readItem(state, "appr-pb-676767676767-1")?.readOnly).toBe(true);
  expect(sentBrief("appr-pb-676767676767-1")).toContain(READ_ONLY_RULE);
  expect(sentBrief("appr-pb-676767676767-1")).not.toContain(APPROVED_RULE);
});


// an entry as the dashboard's todo-list --open --json gives it (cytoplasm automation/project_board/agent_read.py)
const boardTodo = (n: string, patch: Partial<Record<string, unknown>> = {}): FeedTodo => ({ todo_id: `pb-0123456789ab-${n}`, project: "사무처리", title: `할 일 ${n}`, owner: "형", due: null, status: "열림", progress: 0, source_kind: "mail", source_id: "m1", source_subject: "제목", approved_at: "2026-11-01T01:00:00Z", auto_applied: true, card_approved_at: null, updated_at: "2026-11-01T01:00:00Z", grade: "과제내부", note: "", note_truncated: false, ...patch });

test("the dashboard's card mark and a note that grows past its cut are not new content: an approved todo stays approved", async () => {
  // Given: the owner approved todo 1 by card
  await feedSweep([boardTodo("1", { auto_applied: false, card_approved_at: "2026-11-01T01:00:00Z" })]);
  expect(writeLimit(readItem(state, "todo-pb-0123456789ab-1")!)).toBe("approved");
  // When: the board only rewrites its bookkeeping (a longer note, cut, and a new update time)
  const lines = await feedSweep([boardTodo("1", { auto_applied: false, card_approved_at: "2026-11-01T01:00:00Z", note: "x".repeat(199) + "…", note_truncated: true, updated_at: "2026-11-02T09:00:00Z", progress: 30, status: "진행" })]);
  // Then: no question, still approved
  expect(lines).toEqual([]);
  const item = readItem(state, "todo-pb-0123456789ab-1")!;
  expect([writeLimit(item), item.approvalAsk]).toEqual(["approved", undefined]);
});

test("a todo on hold (보류) gets no item and holds its open one; open again, it starts", async () => {
  // Given: todo 1 waits on the list, todo 2 is on hold from the start
  await feedSweep([boardTodo("1"), boardTodo("2", { status: "보류" })]);
  expect(readItem(state, "todo-pb-0123456789ab-2")).toBeUndefined();
  // When: the owner puts todo 1 on hold before a pass
  const held = await feedSweep([boardTodo("1", { status: "보류" }), boardTodo("2", { status: "보류" })]);
  await backlogTick(deps(), { force: true });
  // Then: nothing starts
  expect(held).toEqual(["BACKLOG_FEED_PAUSED todo-pb-0123456789ab-1: on hold on the source; not started until it is open again"]);
  expect(launched).toEqual([]);
  // When: open again
  const back = await feedSweep([boardTodo("1", { status: "진행" }), boardTodo("2", { status: "보류" })]);
  await backlogTick(deps(), { force: true });
  // Then
  expect(back).toEqual(["BACKLOG_FEED_RESUMED todo-pb-0123456789ab-1: open again on the source"]);
  expect(launched).toEqual(["todo-pb-0123456789ab-1"]);
});

test("a todo no longer listed (finished or deleted on the dashboard) never starts, a running one is left to its lane, and one listed again comes back", async () => {
  // Given: todo 1 runs, todos 2 and 3 wait
  await feedSweep([boardTodo("1")]);
  await backlogTick(deps(), { force: true });
  await feedSweep([boardTodo("1"), boardTodo("2"), boardTodo("3")]);
  // When: the open list no longer has 1 and 2
  const gone = await feedSweep([boardTodo("3")]);
  await backlogTick(deps({}, { maxStarts: 2 }), { force: true });
  // Then: 2 is dropped and never starts, 1 still runs, 3 starts
  expect(gone).toEqual(["BACKLOG_FEED_GONE todo-pb-0123456789ab-2: no longer on the source (finished or removed there), dropped from the list"]);
  expect(readItem(state, "todo-pb-0123456789ab-1")?.status).toBe("running");
  expect(launched).toEqual(["todo-pb-0123456789ab-1", "todo-pb-0123456789ab-3"]);
  // When: todo 2 is listed open again (the list had been cut, or the owner reopened it)
  const back = await feedSweep([boardTodo("2"), boardTodo("3")]);
  // Then
  expect(back).toEqual(["BACKLOG_FEED_REOPENED todo-pb-0123456789ab-2: open again on the source"]);
  expect(readItem(state, "todo-pb-0123456789ab-2")?.status).toBe("open");
});

test("a dashboard todo's launch copy carries the four fields dori launch requires, approved or draft (a missing one held every todo)", async () => {
  // Given: one card-approved todo and one taken in without a card
  await feedSweep([boardTodo("1", { auto_applied: false, card_approved_at: "2026-11-01T01:00:00Z" }), boardTodo("2")]);
  // When
  await backlogTick(deps({}, { maxStarts: 2 }), { force: true });
  // Then: the fork ledger's four-fields check finds no gap in either copy
  const ledger = loadLedger({ directives: { common: COMMON_LEDGER, local: "" } });
  const blocks = { "eight-steps": await eightSteps(), "ui-steps": await uiSteps() };
  const gaps = ["todo-pb-0123456789ab-1", "todo-pb-0123456789ab-2"].map((id) => briefGaps({ key: laneKeyOf(id) }, sentBrief(id), ledger, "", blocks).map((g) => g.id));
  expect(launched).toEqual(["todo-pb-0123456789ab-1", "todo-pb-0123456789ab-2"]);
  expect(gaps.map((g) => g.includes("four-fields"))).toEqual([false, false]);
});

test("a todo the lead dropped stays dropped when the feed lists it again", async () => {
  // Given: todo 1 left the list (dropped, may come back), then the lead cancels it
  await feedSweep([boardTodo("1"), boardTodo("2")]);
  await feedSweep([boardTodo("2")]);
  dropItem(state, "todo-pb-0123456789ab-1", "the owner cancelled it", new Date(now).toISOString());
  // When: the feed lists it again
  const lines = await feedSweep([boardTodo("1"), boardTodo("2")]);
  // Then
  expect(lines).toEqual([]);
  expect(readItem(state, "todo-pb-0123456789ab-1")?.status).toBe("dropped");
});

test("a feed list with a bad entry is not read at all, and a failing intake never stops the pass", async () => {
  // Given: todo 1 waits on the list; a hand item waits too
  await feedSweep([boardTodo("1")]);
  add("hand1");
  // When: the feed gives a null, a row without an id, and a non-object
  const skipped = await Promise.all([[null], [{ title: "no id" }], ["x"]].map((todos) => feedSweep(todos as unknown as FeedTodo[])));
  const pass = await backlogTick(deps({ intake: async () => { throw new Error("feed blew up"); } }, { maxStarts: 2 }), { force: true });
  // Then: nothing on the list changed, the pass still started the waiting work
  expect(skipped.map((l) => l.map((x) => x.split(":")[0]))).toEqual([["BACKLOG_FEED_SKIPPED node-read todo-list --json"], ["BACKLOG_FEED_SKIPPED node-read todo-list --json"], ["BACKLOG_FEED_SKIPPED node-read todo-list --json"]]);
  expect(readItem(state, "todo-pb-0123456789ab-1")?.status).not.toBe("dropped");
  expect(pass[0]).toBe("BACKLOG_INTAKE_FAILED feed blew up");
  expect(launched.sort()).toEqual(["hand1", "todo-pb-0123456789ab-1"]);
});

// an order row as the board writes it to YooDori's inbox (cytoplasm automation/project_board)
const orderRow = (n: number, ts: string, todo = "pb-0123456789ab-1"): InboxRow => ({ ts, id: `dashboard-order-${n}`, kind: "dashboard-order", order: n, todo_id: todo, url: `https://board/#order/${n}`, content: `[대시보드 지시 #${n}] 이거 한거 아니야?\n관련: 할 일 「보안교육」 (id ${todo})\n형이 대시보드에 쓴 지시다. 할 일·일정·메일 일이면 유돌이 바로 처리하고, 나머지는 도리 방에 넘긴다. 진행은 order-status로 적는다.` });
const orderSettings = { ...SETTINGS, orderKinds: ["dashboard-order"] };
const orderPass = (list: InboxRow[]) => orderIntake({ stateDir: state, settings: orderSettings, rows: () => list, now: () => now });

// a pass as the dori-lanes loop runs it: the inbox file read from where the last pass stopped, kept once the orders are taken
const inboxFile = (): string => join(root, "inbox.jsonl");
const filePass = (): string[] => {
  const inbox = inboxReader(state, inboxFile());
  const lines = orderIntake({ stateDir: state, settings: orderSettings, rows: inbox.rows, now: () => now });
  inbox.commit();
  return lines;
};
const otherRows = (bytes: number): string => {
  const one = `${JSON.stringify({ ts: "2026-11-02T16:00:00.000Z", id: "watch-x", kind: "watch", content: "x".repeat(900) })}\n`;
  return one.repeat(Math.ceil(bytes / one.length));
};

test("an order the backlog has not read is taken behind more than 2 MB of other inbox rows written while it did not run, and read once", () => {
  // Given: the start is set; then an order comes in, and 3 MB of other rows after it before the next pass
  writeFileSync(inboxFile(), otherRows(64 * 1024));
  filePass();
  appendFileSync(inboxFile(), `${JSON.stringify(orderRow(70, new Date(now + 60_000).toISOString()))}\n`);
  appendFileSync(inboxFile(), otherRows(3 * 1024 * 1024));
  // When
  const lines = filePass();
  const again = filePass();
  // Then
  expect(lines).toEqual([expect.stringMatching(/^BACKLOG_INTAKE dashboard-order-70 \(owner order\)/)]);
  expect(readItem(state, "dashboard-order-70")?.status).toBe("open");
  expect(again).toEqual([]);
});

test("an order written between the first pass's start and its commit is the next pass's: the commit keeps only what was read before the start", () => {
  // Given: the first pass reads the inbox, sets the start, and an order lands before it commits
  writeFileSync(inboxFile(), otherRows(4 * 1024));
  const inbox = inboxReader(state, inboxFile());
  const first = orderIntake({ stateDir: state, settings: orderSettings, rows: inbox.rows, now: () => now });
  appendFileSync(inboxFile(), `${JSON.stringify(orderRow(73, new Date(now + 60_000).toISOString()))}\n`);
  inbox.commit();
  // When
  const next = filePass();
  // Then
  expect(first[0]).toStartWith("BACKLOG_ORDERS_FROM");
  expect(next.map((l) => l.split(" ")[1])).toEqual(["dashboard-order-73"]);
});

test("reading an inbox that got shorter after its size was taken ends with what was read, never waits on bytes that are gone", () => {
  // Given: two whole lines and a size that still counts 1 MB the file no longer has (cut while it was read)
  writeFileSync(inboxFile(), '{"id":"a"}\n{"id":"b"}\n');
  const fd = openSync(inboxFile(), "r");
  // When
  const read = (() => {
    try {
      return readLines(fd, 0, 22 + 1024 * 1024);
    } finally {
      closeSync(fd);
    }
  })();
  // Then
  expect(read).toEqual({ lines: ['{"id":"a"}', '{"id":"b"}', ""], at: 22 });
});

test("an inbox rotated between a pass's read and its commit is read from its start by the next pass", () => {
  // Given: the start is set; an order is read by a pass; the file is rotated before that pass commits
  writeFileSync(inboxFile(), "");
  filePass();
  appendFileSync(inboxFile(), `${JSON.stringify(orderRow(74, new Date(now + 60_000).toISOString()))}\n`);
  const inbox = inboxReader(state, inboxFile());
  const read = orderIntake({ stateDir: state, settings: orderSettings, rows: inbox.rows, now: () => now });
  writeFileSync(join(root, "inbox.new"), `${JSON.stringify(orderRow(75, new Date(now + 120_000).toISOString()))}\n`);
  renameSync(join(root, "inbox.new"), inboxFile());
  inbox.commit();
  // When
  const next = filePass();
  // Then
  expect(read.map((l) => l.split(" ")[1])).toEqual(["dashboard-order-74"]);
  expect(next.map((l) => l.split(" ")[1])).toEqual(["dashboard-order-75"]);
});

test("the inbox read leaves a line not yet ended for the next pass, and reads a new (rotated) inbox file from its start", () => {
  // Given: the start is set; then half of an order's line is written
  writeFileSync(inboxFile(), "");
  filePass();
  const line = `${JSON.stringify(orderRow(71, new Date(now + 60_000).toISOString()))}\n`;
  appendFileSync(inboxFile(), line.slice(0, 40));
  // When: a pass, the line is ended, a pass; then the file is replaced by a new one holding another order, a pass
  const half = filePass();
  appendFileSync(inboxFile(), line.slice(40));
  const whole = filePass();
  writeFileSync(join(root, "inbox.new"), `${JSON.stringify(orderRow(72, new Date(now + 120_000).toISOString()))}\n`);
  renameSync(join(root, "inbox.new"), inboxFile());
  const rotated = filePass();
  // Then
  expect(half).toEqual([]);
  expect(whole.map((l) => l.split(" ")[1])).toEqual(["dashboard-order-71"]);
  expect(rotated.map((l) => l.split(" ")[1])).toEqual(["dashboard-order-72"]);
});

test("the owner's orders (backlog.orderKinds) become items at once; rows before the first pass stay the lead's", () => {
  // Given: an order before the first pass
  const list: InboxRow[] = [orderRow(8, "2026-10-29T14:20:51.634Z")];
  // When
  const first = orderPass(list);
  list.push(orderRow(10, "2026-11-02T15:05:00.000Z", "pb-0123456789ab-2"), { id: "x1", ts: "2026-11-02T15:06:00.000Z", kind: "answer", content: "응" });
  const next = orderPass(list);
  const again = orderPass(list);
  // Then: only the new order is the backlog's; the earlier one has no item, so dori backlog show leaves it to the lead
  expect(first).toEqual(["BACKLOG_ORDERS_FROM 2026-11-02T15:00:00.000Z: dashboard-order rows after this are taken; earlier ones are the lead's"]);
  expect(next).toEqual(["BACKLOG_INTAKE dashboard-order-10 (owner order): [대시보드 지시 #10] 이거 한거 아니야?"]);
  expect(again).toEqual([]);
  expect(readItem(state, "dashboard-order-8")).toBeUndefined();
  expect(readItem(state, "dashboard-order-10")).toMatchObject({ by: "owner", priority: 2, row: "dashboard-order-10" });
});

test("an order about a todo whose lane runs goes to the lead at once, so a stop or a change reaches that lane now; the backlog never starts it", async () => {
  // Given: todo 1 runs as a feed lane
  await feedSweep([boardTodo("1")]);
  await backlogTick(deps(), { force: true });
  orderPass([]);
  // When: the owner writes an order about todo 1
  orderPass([orderRow(11, "2026-11-02T15:10:00.000Z", "pb-0123456789ab-1")]);
  const pass = await backlogTick(deps(), { force: true });
  lanes = lanes.map((l) => (l.key === "bl-todo-pb-0123456789ab-1" ? lane(l.key, true) : l));
  await backlogTick(deps(), { force: true });
  // Then: handed to the lead in the same pass, one backlog-held row, never started even after the todo's lane closed
  expect(pass).toContain("BACKLOG_ORDER_TO_LEAD dashboard-order-11: todo pb-0123456789ab-1 runs in lane bl-todo-pb-0123456789ab-1; the lead puts the order into that lane");
  expect(rows.filter((r) => r.kind === "backlog-held").map((r) => r.content.split(" ").slice(0, 2).join(" "))).toEqual(["BACKLOG_ORDER_TO_LEAD dashboard-order-11"]);
  expect(readItem(state, "dashboard-order-11")?.status).toBe("dropped");
  expect(launched).toEqual(["todo-pb-0123456789ab-1"]);
});
test("an order and a feed entry about one todo taken in by the same sweep never run at once, and a running approved follow-up counts as that todo's lane", async () => {
  // Given: an order and a new feed entry for todo 2 in the same pass, room for two starts
  orderPass([]);
  orderPass([orderRow(12, "2026-11-02T15:11:00.000Z", "pb-0123456789ab-2")]);
  await feedSweep([boardTodo("2")]);
  // When
  await backlogTick(deps({}, { maxStarts: 2 }), { force: true });
  // Then: the order (priority 2) starts, the feed item waits for it
  expect(launched).toEqual(["dashboard-order-12"]);
  expect(readItem(state, "todo-pb-0123456789ab-2")?.status).toBe("open");
  // Given: an approved follow-up of todo 3 runs
  writeFileSync(join(state, "backlog", "items", "appr-pb-0123456789ab-3.json"), JSON.stringify({ id: "appr-pb-0123456789ab-3", title: "f", brief, done: "file /tmp/x", priority: 4, by: "feed", source: "pb-0123456789ab-3", followUpOf: "todo-pb-0123456789ab-3", status: "running", lane: "bl-appr-pb-0123456789ab-3", addedAt: "t", log: [] }));
  lanes.push(lane("bl-appr-pb-0123456789ab-3"));
  orderPass([orderRow(13, "2026-11-02T15:12:00.000Z", "pb-0123456789ab-3")]);
  const pass = await backlogTick(deps({}, { maxStarts: 2 }), { force: true });
  // Then: the order about todo 3 goes to the lead for that lane
  expect(pass).toContain("BACKLOG_ORDER_TO_LEAD dashboard-order-13: todo pb-0123456789ab-3 runs in lane bl-appr-pb-0123456789ab-3; the lead puts the order into that lane");
  expect(launched).not.toContain("dashboard-order-13");
});
test("an order with no room waits on the list and starts when room comes; it is never handed to the lead for that", async () => {
  // Given: an order while the host is busy, for a long time
  orderPass([]);
  orderPass([orderRow(13, "2026-11-02T15:01:00.000Z")]);
  now = T0 + 60 * 60_000;
  const busy = await backlogTick(deps({ busy: async () => ["2 lanes over the guard"] }), { force: true });
  // When: room comes
  const free = await backlogTick(deps(), { force: true });
  // Then
  expect(busy.some((l) => l.includes("TO_LEAD"))).toBe(false);
  expect(rows.filter((r) => r.kind === "backlog-held")).toEqual([]);
  expect(free.some((l) => l.startsWith("BACKLOG_STARTED dashboard-order-13"))).toBe(true);
});
test("an order's launch copy carries the four fields dori launch requires", async () => {
  // Given
  orderPass([]);
  orderPass([orderRow(14, "2026-11-02T15:01:00.000Z")]);
  // When
  await backlogTick(deps(), { force: true });
  // Then
  const ledger = loadLedger({ directives: { common: COMMON_LEDGER, local: "" } });
  const gaps = briefGaps({ key: laneKeyOf("dashboard-order-14") }, sentBrief("dashboard-order-14"), ledger, "", { "eight-steps": await eightSteps(), "ui-steps": await uiSteps() }).map((g) => g.id);
  expect(launched).toEqual(["dashboard-order-14"]);
  expect(gaps).not.toContain("four-fields");
  expect(sentBrief("dashboard-order-14")).toContain("[대시보드 지시 #14] 이거 한거 아니야?");
});

test("a todo renamed on the board is listed, started and reported under its new title", async () => {
  // Given: todo 1 waits under its first title
  await feedSweep([boardTodo("1", { title: "fix A" })]);
  // When: the owner renames it, then a pass starts it
  await feedSweep([boardTodo("1", { title: "fix B" })]);
  await backlogTick(deps(), { force: true });
  // Then
  expect(readItem(state, "todo-pb-0123456789ab-1")?.title).toBe("fix B");
  expect(rows.find((r) => r.kind === "backlog-start")?.content).toContain("(fix B, p6)");
});

test("an item waiting on its todo's lane does not use the start of an unrelated item behind it", async () => {
  // Given: an order about todo 4 runs; the feed then lists todo 4, and a hand item waits; one start a pass
  orderPass([]);
  orderPass([orderRow(31, "2026-11-02T15:31:00.000Z", "pb-0123456789ab-4")]);
  await backlogTick(deps(), { force: true });
  await feedSweep([boardTodo("4", { auto_applied: false, card_approved_at: "x" })]);
  add("hand9", { priority: "7" });
  // When
  const pass = await backlogTick(deps(), { force: true });
  // Then: the feed item (priority 4) waits for the order's lane; the hand item behind it starts
  expect(pass).toContain("BACKLOG_WAIT todo-pb-0123456789ab-4: todo pb-0123456789ab-4 is worked on by lane bl-dashboard-order-31 now");
  expect(launched).toEqual(["dashboard-order-31", "hand9"]);
});

test("an order the lead replaced without --by is still an order: about a todo whose lane runs it goes to the lead at once", async () => {
  // Given: an order waits (no room); the lead replaces it (a new brief, by defaults to lead); then todo 1's lane runs
  orderPass([]);
  orderPass([orderRow(40, "2026-11-02T15:40:00.000Z", "pb-0123456789ab-1")]);
  addItem(state, { id: "dashboard-order-40", title: "fixed", brief, done: "file /tmp/x", priority: "2" }, { registered: false, at: new Date(now).toISOString() });
  await feedSweep([boardTodo("1")]);
  writeFileSync(join(state, "backlog", "items", "todo-pb-0123456789ab-1.json"), JSON.stringify({ ...readItem(state, "todo-pb-0123456789ab-1"), status: "running", lane: "bl-todo-pb-0123456789ab-1" }));
  lanes.push(lane("bl-todo-pb-0123456789ab-1"));
  // When
  const pass = await backlogTick(deps(), { force: true });
  // Then
  expect(readItem(state, "dashboard-order-40")).toMatchObject({ status: "dropped", by: "lead", row: "dashboard-order-40" });
  expect(pass).toContain("BACKLOG_ORDER_TO_LEAD dashboard-order-40: todo pb-0123456789ab-1 runs in lane bl-todo-pb-0123456789ab-1; the lead puts the order into that lane");
});

test("an order row is taken once by its id, whatever its time: one stamped like a row already seen, or reaching the inbox after a later one", () => {
  // Given: the start is set, then order 51 (15:51) is taken
  orderPass([]);
  const list: InboxRow[] = [orderRow(51, "2026-11-02T15:51:00.000Z")];
  orderPass(list);
  // When: order 52 with the same time, and order 50 stamped earlier but delivered later, come in; then a pass again
  list.push(orderRow(52, "2026-11-02T15:51:00.000Z"), orderRow(50, "2026-11-02T15:50:00.000Z"));
  const lines = orderPass(list);
  const again = orderPass(list);
  // Then
  expect(lines.map((l) => l.split(" ")[1])).toEqual(["dashboard-order-52", "dashboard-order-50"]);
  expect(again).toEqual([]);
});

const MODEL_SEEDS = Number(process.env.BACKLOG_MODEL_SEEDS ?? 40);
// a seeded PRNG (mulberry32), so a failing run names its seed and replays exactly
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

test("model: random orders, feed sweeps, passes, lane closes, replacements and drops keep one owner per order and one running lane per todo", async () => {
  for (let seed = 1; seed <= MODEL_SEEDS; seed++) {
    const rnd = prng(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    root = mkdtempSync(join(tmpdir(), "backlog-model-"));
    state = join(root, "state");
    brief = join(root, "brief.md");
    writeFileSync(brief, "ulw\n\n[목표] model\n");
    lanes = [];
    launched = [];
    rows = [];
    now = T0;
    const steps: string[] = [];
    const list: InboxRow[] = [];
    const handed = new Set<string>();
    // #dori-pair repair posts: some reach the inbox after a later one (a lower id), some reply to an earlier post, some reply
    // to a parent that reaches the inbox only later (a reply's id is always above its parent's, as in Discord)
    const pairList: InboxRow[] = [{ id: "9000", scope: "pair-bot", author_id: "B1", content: "옛 글" }];
    const owed: string[] = [];
    let n = 0;
    let p = 0;
    const fail = (why: string): never => {
      throw new Error(`seed ${seed}: ${why}\nsteps: ${steps.join(" ; ")}`);
    };
    const pass = async (busy: boolean, maxStarts: number) => {
      const before = rows.length;
      const startedBefore = launched.length;
      await backlogTick(deps({ busy: async () => (busy ? ["busy"] : []), intake: async () => [...orderPass(list), ...(await pairPass(pairList))] }, { maxStarts }), { force: true });
      // I8: every #dori-pair post past the start has an item after a pass (its own, or a dropped one when it went into a waiting request)
      for (const r of pairList.filter((x) => Number(x.id) > 9000)) if (!readItem(state, `pair-${r.id}`)) fail(`pair post ${r.id} has no item after a pass`);
      // I10: at most one running lane per #dori-pair request (the first post of a reply chain), whatever order the posts came in
      const up = new Map(pairList.map((x) => [x.id, x.reply_to] as const));
      const root = (id: string): string => {
        let x = id;
        for (let i = 0; i < 100 && up.get(x); i++) x = up.get(x) as string;
        return x;
      };
      const roots = listItems(state).filter((i) => i.status === "running" && isPairItem(i) && i.row !== undefined).map((i) => root(i.row as string));
      if (roots.length !== new Set(roots).size) fail(`two running lanes of one #dori-pair request: ${roots.join(",")}`);
      // I9: a #dori-pair request is the backlog's alone: never handed to the lead
      for (const r of rows.slice(before)) if (r.kind === "backlog-held" && /pair-\d/.test(r.content)) fail(`a pair item went to the lead: ${r.content}`);
      for (const r of rows.slice(before).filter((x) => x.content.startsWith("BACKLOG_ORDER_TO_LEAD"))) {
        const [, row, , , , , , lane0] = r.content.split(" ");
        if (handed.has(row ?? "")) fail(`${row} handed to the lead twice`);
        handed.add(row ?? "");
        const named = r.content.match(/by lane (\S+)/)?.[1];
        // I4: the named lane runs now
        if (!lanes.some((l) => l.key === named && !l.closedAt)) fail(`${row} handed for lane ${named ?? lane0}, which does not run`);
      }
      // I3: nothing handed to the lead is ever started
      for (const id of launched.slice(startedBefore)) if (handed.has(id)) fail(`${id} started after it was handed to the lead`);
      // I7: a pass that was not busy and had room starts something when an item may start (no scheduler that starts nothing)
      if (!busy && launched.length === startedBefore) {
        const all = listItems(state);
        const running = all.filter((i) => i.status === "running");
        const runningTodos7 = new Set(running.map(todoOf).filter((k): k is string => k !== undefined));
        const room = Math.min(SETTINGS.maxLanes - running.length, maxStarts, SETTINGS.hostMaxLanes - running.length);
        const startable = all.filter((i) => i.status === "open" && !i.ask && !i.approvalAsk && !i.held && !i.paused && !(todoOf(i) !== undefined && runningTodos7.has(todoOf(i) as string)));
        if (room > 0 && startable.length) fail(`a free pass started nothing while ${startable.map((i) => i.id).join(", ")} could start`);
      }
      // I6: after a pass no open order waits while its todo's lane runs (the lead's rule: it went to the lead for that lane)
      const runningTodos = new Set(listItems(state).filter((i) => i.status === "running").map(todoOf).filter((k): k is string => k !== undefined));
      for (const o of listItems(state).filter((i) => i.status === "open" && i.row !== undefined && !isPairItem(i))) {
        const k = todoOf(o);
        if (k !== undefined && runningTodos.has(k)) fail(`order ${o.id} waits while its todo ${k} has a running lane`);
      }
    };
    orderPass(list);
    await pairPass(pairList);
    for (let step = 0; step < 40; step++) {
      now += 60_000;
      const op = pick(["order", "order", "pair", "pair", "feed", "pass", "pass", "pass", "close", "replace", "drop"] as const);
      if (op === "pair") {
        p++;
        const late = owed.length && rnd() < 0.5 ? owed.shift() : undefined;
        // ids: 9000 + 4p (or 6 lower: delivered after a later one); a parent owed is 9000 + 4p - 1, never another post's id
        const id = late ?? String(9000 + 4 * p + pick([0, 0, -6]));
        const earlier = pairList.filter((x) => x.id !== "9000" && Number(x.id) < Number(id));
        const ahead = !late && rnd() < 0.15 ? String(9000 + 4 * p - 1) : undefined;
        if (ahead) owed.push(ahead);
        const reply = late ? undefined : (ahead ?? (earlier.length && rnd() < 0.4 ? pick(earlier).id : undefined));
        pairList.push({ id, scope: "pair-bot", author_id: "B1", channel_id: "P", content: `수돌, 수리 요청: m${p}`, ...(reply ? { reply_to: reply } : {}) });
        steps.push(`pair ${id}${reply ? `>${reply}` : ""}${late ? " (parent, late)" : ""}`);
      } else if (op === "order") {
        n++;
        const ts = new Date(T0 + pick([n, n, n - 1, 0]) * 60_000 + 1).toISOString();
        list.push(orderRow(100 + n, ts, pick(["pb-0123456789ab-1", "pb-0123456789ab-2", "pb-0123456789ab-3"])));
        steps.push(`order ${100 + n}@${ts.slice(11, 16)}`);
      } else if (op === "feed") {
        const todos = ["1", "2", "3"].filter(() => rnd() < 0.6).map((k) => boardTodo(k, { status: pick(["열림", "진행", "보류"]), auto_applied: rnd() < 0.5 }));
        await feedSweep(todos);
        steps.push(`feed ${todos.map((x) => `${String(x.todo_id).slice(-1)}:${x.status}`).join(",")}`);
      } else if (op === "pass") {
        const busy = rnd() < 0.2;
        const maxStarts = pick([1, 2]);
        steps.push(`pass busy=${busy} starts=${maxStarts}`);
        await pass(busy, maxStarts);
      } else if (op === "close") {
        const open = lanes.filter((l) => !l.closedAt);
        if (open.length) {
          const l = pick(open);
          lanes = lanes.map((x) => (x.key === l.key ? lane(x.key, true) : x));
          steps.push(`close ${l.key}`);
        }
      } else if (op === "replace") {
        const orders = listItems(state).filter((i) => i.status === "open" && i.row !== undefined);
        if (orders.length) {
          const o = pick(orders);
          addItem(state, { id: o.id, title: "replaced", brief, done: "file /tmp/x", priority: "2" }, { registered: false, at: new Date(now).toISOString() });
          steps.push(`replace ${o.id}`);
        }
      } else {
        const open = listItems(state).filter((i) => i.status === "open");
        if (open.length) {
          const o = pick(open);
          dropItem(state, o.id, "model", new Date(now).toISOString());
          steps.push(`drop ${o.id}`);
        }
      }
      // I1: at most one running item per todo
      const running = listItems(state).filter((i) => i.status === "running");
      const perTodo = new Map<string, number>();
      for (const i of running) {
        const k = todoOf(i);
        if (k !== undefined) perTodo.set(k, (perTodo.get(k) ?? 0) + 1);
      }
      for (const [k, c] of perTodo) if (c > 1) fail(`${c} running items for todo ${k}`);
      // I2: every order row the passes saw has exactly one item, which never disappears
      if (steps.some((s) => s.startsWith("pass"))) {
        const seen = list.filter((r) => (r.ts ?? "") > new Date(T0).toISOString());
        const lastPass = steps.map((s, i) => (s.startsWith("pass") ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
        const before = steps.slice(0, lastPass + 1).filter((s) => s.startsWith("order")).length;
        for (const r of seen.slice(0, before)) if (!readItem(state, rowItemId(r.id))) fail(`order ${r.id} has no item after a pass`);
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("an order handed to the lead whose row could not be written stays on the list and is handed over again, never lost", async () => {
  // Given: todo 1 runs; an order about it comes in; the inbox fails once as the hand-over row is written
  await feedSweep([boardTodo("1")]);
  await backlogTick(deps(), { force: true });
  orderPass([]);
  orderPass([orderRow(60, "2026-11-02T15:30:00.000Z", "pb-0123456789ab-1")]);
  let broken = true;
  const flaky = deps({ inbox: (kind, id, content) => {
    if (broken && content.startsWith("BACKLOG_ORDER_TO_LEAD")) {
      broken = false;
      throw new Error("disk full");
    }
    rows.push({ kind, id, content });
  } });
  // When: the pass is cut off, then the next one runs
  const cut = await backlogTick(flaky, { force: true }).catch((e: unknown) => String(e));
  const kept = readItem(state, "dashboard-order-60")?.status;
  await backlogTick(flaky, { force: true });
  // Then
  expect(cut).toContain("disk full");
  expect(kept).toBe("open");
  expect(readItem(state, "dashboard-order-60")?.status).toBe("dropped");
  expect(rows.filter((r) => r.content.startsWith("BACKLOG_ORDER_TO_LEAD dashboard-order-60")).length).toBe(1);
});

test("#dori-pair intake: only the other Doris' posts that start a repair request", async () => {
  // Given
  const inbox: InboxRow[] = [{ id: "1000", scope: "pair-bot", author_id: "B1", content: "도리야, 수리 요청: 옛 글" }];
  const intake = (extra: InboxRow[]) => {
    inbox.push(...extra);
    return pairIntake({ stateDir: state, settings: { ...SETTINGS, pairRepairPattern: "^도리야, 수리 요청" }, rows: () => inbox, pairBots: ["B1", "B2"], guild: "G", now: () => now });
  };
  // When
  const first = await intake([]);
  const next = await intake([
    { id: "1001", scope: "pair-bot", author_id: "B1", channel_id: "P", content: "도리야, 수리 요청: 파일 배달이 하위 폴더를 지워" },
    { id: "1002", scope: "pair-bot", author_id: "X9", channel_id: "P", content: "도리야, 수리 요청: 모르는 봇" },
    { id: "1003", scope: "pair", author_id: "H1", channel_id: "P", content: "도리야, 수리 요청: 사람 글" },
    { id: "1004", scope: "pair-bot", author_id: "B2", channel_id: "P", content: "도리야, 메일 하나 보내 줘 https://discord.com/channels/1/2/66" },
    { id: "1006", scope: "pair-bot", author_id: "B2", channel_id: "P", content: "고마워, 받았어" },
  ]);
  const again = await intake([]);
  // Then
  expect(first).toEqual(["BACKLOG_INTAKE_FROM 1000: #dori-pair posts after this one are read"]);
  expect(next).toEqual(["BACKLOG_INTAKE pair-1001 (repair) from B1: 수리: 파일 배달이 하위 폴더를 지워"]);
  expect(again).toEqual([]);
  expect(["pair-1000", "pair-1002", "pair-1003", "pair-1004", "pair-1006"].map((id) => readItem(state, id))).toEqual([undefined, undefined, undefined, undefined, undefined]);
  expect(readItem(state, "pair-1001")).toMatchObject({ noThread: "#dori-pair 수리 요청 https://discord.com/channels/G/P/1001", by: "pair:B1", done: `file ${state}/backlog/reports/pair-1001.md` });
  expect(readFileSync(readItem(state, "pair-1001")?.brief ?? "", "utf8")).toContain("파일 배달이 하위 폴더를 지워");
});

test("a pair repair starts without an owner link even where writes need one (the owner's standing repair rule), and config loading says so once", async () => {
  // Given
  const file = join(root, "both.json");
  writeFileSync(file, JSON.stringify({ backlog: { pairRepairPattern: "^도리야, 수리 요청", writeNeedsOwnerLink: true } }));
  const warned: string[] = [];
  const settings = { ...SETTINGS, pairRepairPattern: "^도리야, 수리 요청", writeNeedsOwnerLink: true };
  const inbox: InboxRow[] = [{ id: "2000", scope: "pair-bot", author_id: "B1", content: "옛 글" }];
  const intake = () => pairIntake({ stateDir: state, settings, rows: () => inbox, pairBots: ["B1"], guild: "1", now: () => now });
  // When
  await loadConfig(file, root, (line) => warned.push(line));
  await intake();
  inbox.push({ id: "2001", scope: "pair-bot", author_id: "B1", channel_id: "3", content: "도리야, 수리 요청: 감시가 멈췄어" });
  await intake();
  // Then
  expect(warned.filter((w) => w.startsWith("CONFIG_BACKLOG_REPAIR_EXEMPT")).length).toBe(1);
  expect(readItem(state, "pair-2001")?.ask).toBeUndefined();
});

// SooDori's repair pattern (its config): a relay head and the old name in brackets may come first; plain chatter does not match
const SOODORI_REPAIR = "^(?:\\[.*?\\]\\s*)?(?:수돌|고돌)(?:\\([^)]*\\))?\\s*[,，]\\s*수리\\s*요청";
const pairPass = (list: InboxRow[], settings: Partial<BacklogSettings> = {}) => pairIntake({ stateDir: state, settings: { ...SETTINGS, pairRepairPattern: SOODORI_REPAIR, ...settings }, rows: () => list, pairBots: ["B1"], guild: "G", now: () => now });

test("a #dori-pair post written between the first pass's start and its commit is the next pass's", async () => {
  // Given: the first pass reads the inbox and sets its start; a repair post lands before it commits
  const pairFile = async () => {
    const inbox = inboxReader(state, inboxFile());
    const lines = await pairIntake({ stateDir: state, settings: { ...SETTINGS, pairRepairPattern: SOODORI_REPAIR }, rows: inbox.rows, pairBots: ["B1"], guild: "G", now: () => now });
    return { lines, commit: inbox.commit };
  };
  writeFileSync(inboxFile(), `${JSON.stringify({ id: "8000", scope: "pair-bot", author_id: "B1", content: "옛 글" })}\n`);
  const first = await pairFile();
  appendFileSync(inboxFile(), `${JSON.stringify({ id: "8001", scope: "pair-bot", author_id: "B1", channel_id: "P", content: "수돌, 수리 요청: 사이에 온 글" })}\n`);
  first.commit();
  // When
  const next = await pairFile();
  next.commit();
  // Then
  expect(first.lines).toEqual(["BACKLOG_INTAKE_FROM 8000: #dori-pair posts after this one are read"]);
  expect(next.lines.map((l) => l.split(" ").slice(0, 3).join(" "))).toEqual(["BACKLOG_INTAKE pair-8001 (repair)"]);
});

test("a #dori-pair repair post the backlog has not read is taken behind more than 2 MB of other inbox rows, and read once", async () => {
  // Given: the start is set; then a repair post comes in, and 3 MB of other rows after it before the next pass
  const pairFile = async () => {
    const inbox = inboxReader(state, inboxFile());
    const lines = await pairIntake({ stateDir: state, settings: { ...SETTINGS, pairRepairPattern: SOODORI_REPAIR }, rows: inbox.rows, pairBots: ["B1"], guild: "G", now: () => now });
    inbox.commit();
    return lines;
  };
  writeFileSync(inboxFile(), `${JSON.stringify({ id: "7000", scope: "pair-bot", author_id: "B1", content: "옛 글" })}\n`);
  await pairFile();
  appendFileSync(inboxFile(), `${JSON.stringify({ id: "7001", scope: "pair-bot", author_id: "B1", channel_id: "P", content: "수돌, 수리 요청: 감시가 멈췄어" })}\n`);
  appendFileSync(inboxFile(), otherRows(3 * 1024 * 1024));
  // When
  const lines = await pairFile();
  const again = await pairFile();
  // Then
  expect(lines.map((l) => l.split(" ").slice(0, 3).join(" "))).toEqual(["BACKLOG_INTAKE pair-7001 (repair)"]);
  expect(again).toEqual([]);
});


test("SooDori takes the other Doris' '수돌, 수리 요청' posts, with a relay head or its old name too, and leaves their other words to its lead", async () => {
  // Given
  const list: InboxRow[] = [{ id: "3000", scope: "pair-bot", author_id: "B1", content: "옛 글" }];
  await pairPass(list);
  list.push(
    { id: "3001", scope: "pair-bot", author_id: "B1", channel_id: "P", content: "수돌, 수리 요청: 유돌 감시가 멈췄어" },
    { id: "3002", scope: "pair-bot", author_id: "B1", channel_id: "P", content: "[도리 대리 · 소유자 요청 https://discord.com/channels/1/2/3] 수돌(고돌), 수리 요청: 파일 배달이 안 돼" },
    { id: "3003", scope: "pair-bot", author_id: "B1", channel_id: "P", content: "수돌, 이름 바뀐 거 확인했어" },
    { id: "3004", scope: "pair-bot", author_id: "B1", channel_id: "P", content: "공돌, 수리 요청: 남의 일" },
  );
  // When
  const lines = await pairPass(list);
  // Then
  expect(lines.map((l) => l.split(" ").slice(0, 3).join(" "))).toEqual(["BACKLOG_INTAKE pair-3001 (repair)", "BACKLOG_INTAKE pair-3002 (repair)"]);
  expect(readItem(state, "pair-3003")).toBeUndefined();
  expect(readItem(state, "pair-3004")).toBeUndefined();
  expect(readItem(state, "pair-3001")).toMatchObject({ by: "pair:B1", row: "3001", priority: 5 });
});

test("a repair's launch copy carries the four fields, and a repair that cannot start waits on the list, never handed back to the lead", async () => {
  // Given
  const list: InboxRow[] = [{ id: "4000", scope: "pair-bot", author_id: "B1", content: "옛 글" }];
  await pairPass(list);
  list.push({ id: "4001", scope: "pair-bot", author_id: "B1", channel_id: "P", content: "수돌, 수리 요청: 감시가 멈췄어" }, { id: "4002", scope: "pair-bot", author_id: "B1", channel_id: "P", content: "수돌, 수리 요청: 알림이 안 와" });
  await pairPass(list);
  // When: one starts, the host is then busy for the other for an hour
  await backlogTick(deps(), { force: true });
  now = T0 + 60 * 60_000;
  await backlogTick(deps({ busy: async () => ["load"] }), { force: true });
  // Then
  const ledger = loadLedger({ directives: { common: COMMON_LEDGER, local: "" } });
  const gaps = briefGaps({ key: laneKeyOf("pair-4001") }, sentBrief("pair-4001"), ledger, "", { "eight-steps": await eightSteps(), "ui-steps": await uiSteps() }).map((g) => g.id);
  expect(launched).toEqual(["pair-4001"]);
  expect(gaps).not.toContain("four-fields");
  expect(readItem(state, "pair-4002")?.status).toBe("open");
  expect(rows.filter((r) => r.kind === "backlog-held")).toEqual([]);
});

test("a #dori-pair post is taken once by its id from a start that never moves: one reaching the inbox after a later one is not lost", async () => {
  // Given: the start is set at 6000, then post 6002 is taken
  const list: InboxRow[] = [{ id: "6000", scope: "pair-bot", author_id: "B1", content: "옛 글" }];
  await pairPass(list);
  list.push({ id: "6002", scope: "pair-bot", author_id: "B1", channel_id: "P", content: "수돌, 수리 요청: 두 번째" });
  await pairPass(list);
  // When: post 6001 (earlier id) arrives late; then two passes
  list.push({ id: "6001", scope: "pair-bot", author_id: "B1", channel_id: "P", content: "수돌, 수리 요청: 첫 번째" });
  const late = await pairPass(list);
  const again = await pairPass(list);
  // Then
  expect(late.map((l) => l.split(":")[0])).toEqual(["BACKLOG_INTAKE pair-6001 (repair) from B1"]);
  expect(again).toEqual([]);
  expect(readItem(state, "pair-6000")).toBeUndefined();
});

// the openings of the six repair requests the other Doris really posted in #dori-pair (2026-10-30..11-02, addressed then to
// ZzangDori), now addressed to SooDori; a relay head with a link inside its brackets, as relayed posts have it
const REAL_REPAIRS: readonly string[] = ["수돌, 수리 요청 + 형 지시 전달(형 원문","수돌, 수리 요청: node-read mai","수돌, 수리 요청: 옥돌 카톡 2.40.0 ","수돌, 수리 요청: 형 아이폰 단축어 웹훅(","수돌, 수리 요청: 드라이브 PARA 단계 ","수돌, 수리 요청(형 지침: 도리 기반 문제"];
const RELAY_HEAD = "[도리 대리 · 소유자 요청 [원본 코드 적용](<https://discord.com/channels/1/2/3>)] ";

test("the Doris' real repair posts all match SooDori's pattern, behind a relay head with a link in it too; a handover and chatter do not", () => {
  const re = new RegExp(SOODORI_REPAIR, "u");
  expect(REAL_REPAIRS.map((p) => re.test(p))).toEqual(REAL_REPAIRS.map(() => true));
  expect([re.test(`${RELAY_HEAD}수돌, 수리 요청: QA`), re.test(`${RELAY_HEAD}고돌(수돌), 수리 요청: QA`)]).toEqual([true, true]);
  expect([re.test(`${RELAY_HEAD}고돌, 할 일 목록 루프 2단계 맡아 줘`), re.test("이제부터 도리 기반 고장 수리 요청은 짱돌 말고 고돌에게 여기서 해 줘"), re.test("짱돌, 수리 요청: 옛 이름"), re.test("수돌, 고마워")]).toEqual([false, false, false, false]);
});

test("a reply to a #dori-pair repair post is not taken: one BACKLOG_INTAKE_SKIPPED reply line, kept once, never a lane of its own", async () => {
  // Given: repair 5001 waits; repair 5002 runs
  const list: InboxRow[] = [{ id: "5000", scope: "pair-bot", author_id: "B1", content: "옛 글" }];
  await pairPass(list);
  list.push({ id: "5001", scope: "pair-bot", author_id: "B1", channel_id: "P", content: "수돌, 수리 요청: 배달 하위 폴더가 지워져" }, { id: "5002", scope: "pair-bot", author_id: "B1", channel_id: "P", content: "수돌, 수리 요청: 감시가 멈췄어" });
  await pairPass(list);
  // When: a repair post replies to each (one before its parent reaches the list too), then two intakes and a pass
  list.push({ id: "5004", scope: "pair-bot", author_id: "B1", channel_id: "P", reply_to: "5002", content: "수돌, 수리 요청: 지금도 멈춰 있어" }, { id: "5003", scope: "pair-bot", author_id: "B1", channel_id: "P", reply_to: "5001", content: "수돌, 수리 요청: 나도 같은 일 겪었어" }, { id: "5006", scope: "pair-bot", author_id: "B1", channel_id: "P", reply_to: "5005", content: "수돌, 수리 요청: 부모보다 먼저 온 답글" });
  const lines = await pairPass(list);
  const again = await pairPass(list);
  const pass = await backlogTick(deps({}, { maxStarts: 3 }), { force: true });
  // Then
  expect(lines.map((l) => l.split(":")[0])).toEqual(["BACKLOG_INTAKE_SKIPPED reply 5004", "BACKLOG_INTAKE_SKIPPED reply 5003", "BACKLOG_INTAKE_SKIPPED reply 5006"]);
  expect(again).toEqual([]);
  expect(readItem(state, "pair-5003")).toMatchObject({ status: "dropped", row: "5003" });
  expect(readFileSync(readItem(state, "pair-5001")!.brief, "utf8")).not.toContain("나도 같은 일 겪었어");
  expect(launched.sort()).toEqual(["pair-5001", "pair-5002"]);
  expect(pass).not.toContain("pair-5003");
  expect(rows.filter((r) => r.kind === "backlog-held")).toEqual([]);
});


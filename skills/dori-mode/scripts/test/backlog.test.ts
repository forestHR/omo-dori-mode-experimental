import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addItem, type BacklogItem, BacklogError, backlogTick, decideItem, dropItem, flockDir, hostReserve, laneKeyOf, READ_ONLY_RULE, readItem, StartRefused, type TickDeps, withBacklogLock } from "../src/backlog.ts";
import { type BacklogSettings, loadConfig } from "../src/config.ts";
import type { Lane } from "../src/registry.ts";
import { asStartFailure, LaunchError, LaunchFailed, launchLane, validateLaunch } from "../src/launch.ts";
import { depsFor, fakeClock, fakeRunner, newWorld } from "./fakes.ts";

const SETTINGS: BacklogSettings = { enabled: true, everyMin: 60, maxLanes: 3, maxStarts: 1, hostMaxLanes: 2, hostDir: "", writeNeedsOwnerLink: false };
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
  expect(Object.keys(on.backlog).sort()).toEqual(["enabled", "everyMin", "hostDir", "hostMaxLanes", "maxLanes", "maxStarts", "writeNeedsOwnerLink"]);
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

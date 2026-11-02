import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { closeLane, claimDone, watchTick } from "../src/done-flow.ts";
import { defaultDiscordWords } from "../src/config.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { laneStartText, launchLane, LaunchError, setThread, ThreadMissingError } from "../src/launch.ts";
import { Discord } from "../src/messenger/discord.ts";
import { discordThreadId, postLaneStart } from "../src/messenger/discord-thread.ts";
import { ThreadStatusQueue } from "../src/messenger/thread-status-queue.ts";
import type { HttpRequest } from "../src/messenger/http.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
const THREAD = "discord:100000000000000001";
const lane: Lane = { key: "demo-lane", title: "demo", thread: THREAD, pane: "w:p1", brief: "/briefs/demo.md", done: "merged acme/app#1", cwd: "/repo", openedAt: new Date(T0 - MIN).toISOString() };

let state: ReturnType<typeof withState>;
let world: World;
const at = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadDone: ["notify", "{thread}", "{text}"] } });
const hookCalls = () => world.calls.filter((c) => c[0] === "notify");

beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const aoeDeps = (): FlowDeps => depsFor(world, fakeClock(T0), state.dir, { backend: "aoe", leadPane: "aoe_Dori_0a1b2c3d", watchLog: join(state.dir, "watch.log") });
const launch = async (thread: string | undefined, extra: { readonly noThread?: string } = {}, deps: FlowDeps = aoeDeps(), warn?: (line: string) => void) => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# brief\n");
  return launchLane(deps, { key: "new-lane", title: "new", brief, done: "merged acme/app#1", ...(thread === undefined ? {} : { thread }), ...extra }, warn);
};
const aoeAdds = () => world.calls.filter((c) => c[0] === "aoe" && c[1] === "add");

for (const [why, ref] of [["an empty id", "discord:"], ["an empty id on another adapter", "chat:"], ["an empty ref", ""], ["no adapter", "100000000000000001"], ["a non-numeric Discord id", "discord:abc"], ["whitespace in the id", "chat:team 1"]] as const) {
  test(`launch refuses a thread ref with ${why} and registers nothing`, async () => {
    await expect(launch(ref)).rejects.toBeInstanceOf(LaunchError);
    expect(await at(T0).registry.read("new-lane")).toBeNull();
    expect(world.calls).toEqual([]);
  });
}

for (const thread of [undefined, "none"]) {
  test(`launch with ${thread === undefined ? "no --thread" : "--thread none"} is refused (LAUNCH_NO_THREAD): nothing opened, written or registered`, async () => {
    const r = await launch(thread).catch((e: unknown) => e);
    expect(r).toBeInstanceOf(ThreadMissingError);
    expect((r as Error).message).toStartWith("LAUNCH_NO_THREAD new-lane: ");
    expect((r as Error).message).toContain('--no-thread "<reason>"');
    expect(await at(T0).registry.read("new-lane")).toBeNull();
    expect(world.calls).toEqual([]);
    expect(await Bun.file(join(state.dir, "brief.md")).text()).toBe("# brief\n");
    expect(await Bun.file(join(state.dir, "watch.log")).text()).toMatch(/^\S+ launch LAUNCH_NO_THREAD new-lane: /m);
  });
}

test("--no-thread with a reason opens a lane without a thread and keeps the reason; an empty reason or both flags are refused", async () => {
  const warned: string[] = [];
  const r = await launch(undefined, { noThread: "an internal check the owner did not ask for" }, aoeDeps(), (l) => warned.push(l));
  expect(r.lane.thread).toBe("none");
  expect((await at(T0).registry.read("new-lane"))?.noThread).toBe("an internal check the owner did not ask for");
  expect(warned).toContain("LAUNCH_THREADLESS new-lane: no work thread, on the lead's word: an internal check the owner did not ask for");
  expect(aoeAdds()).toHaveLength(1);
  for (const [thread, noThread] of [[undefined, "  "], [THREAD, "why"]] as const) {
    world = newWorld();
    const e = await launch(thread, { noThread }, depsFor(world, fakeClock(T0), join(state.dir, "fresh"), { backend: "aoe", leadPane: "aoe_Dori_0a1b2c3d" })).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LaunchError);
    expect(e).not.toBeInstanceOf(ThreadMissingError);
    expect(world.calls).toEqual([]);
  }
});

test("--thread new opens one thread in this Dori's channel named for the title and the lane works there; without a channel it is refused", async () => {
  const opened: string[] = [];
  const warned: string[] = [];
  const deps = { ...aoeDeps(), openThread: async (title: string) => (opened.push(title), "discord:100000000000000077") };
  const r = await launch("new", {}, deps, (l) => warned.push(l));
  expect(opened).toEqual(["new"]);
  expect(r.lane.thread).toBe("discord:100000000000000077");
  expect((await at(T0).registry.read("new-lane"))?.thread).toBe("discord:100000000000000077");
  expect(await Bun.file(join(state.dir, "brief.md")).text()).toContain("- Key: new-lane. Work thread: discord:100000000000000077.");
  expect(warned.find((l) => l.startsWith("THREAD_OPENED new-lane discord:100000000000000077"))).toBeDefined();
  world = newWorld();
  const e = await launch("new", {}, depsFor(world, fakeClock(T0), join(state.dir, "fresh"), { backend: "aoe", leadPane: "aoe_Dori_0a1b2c3d" })).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(LaunchError);
  expect((e as Error).message).toContain("DORI_DISCORD_CHANNEL");
  expect(world.calls).toEqual([]);
});

test("a channel id as --thread is refused (LAUNCH_THREAD_IS_CHANNEL) and nothing is opened; a thread id still launches", async () => {
  const deps = { ...aoeDeps(), channels: ["100000000000000001"] };
  const e = await launch(THREAD, {}, deps).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ThreadMissingError);
  expect((e as Error).message).toStartWith(`LAUNCH_THREAD_IS_CHANNEL new-lane: ${THREAD} is a channel`);
  expect(world.calls).toEqual([]);
  expect((await launch("discord:100000000000000002", {}, deps)).lane.thread).toBe("discord:100000000000000002");
});

// 2026-10-20: the lead passed a bare thread id, launch failed and the turn was run again (send-dedupe); the refusal names the ref that works
test("a bare Discord id as --thread is refused with the discord:<id> ref to pass instead", async () => {
  const e = await launch("1561963113488842792").catch((x: unknown) => x);
  expect(e).toBeInstanceOf(LaunchError);
  expect((e as Error).message).toContain("(a Discord thread is --thread discord:1561963113488842792)");
  expect(world.calls).toEqual([]);
});

test("launch keeps a well-formed thread ref", async () => {
  expect((await launch(THREAD)).lane.thread).toBe(THREAD);
});

test("set-thread points a lane registered with an empty thread at a real one", async () => {
  await at(T0).registry.write({ ...lane, thread: "discord:" });
  expect(await setThread(at(T0), { ...lane, thread: "discord:" }, THREAD)).toBe(`THREAD_SET demo-lane discord: -> ${THREAD}`);
  expect((await at(T0).registry.read("demo-lane"))?.thread).toBe(THREAD);
});

test("set-thread refuses a malformed ref and leaves the lane as it was", async () => {
  await at(T0).registry.write(lane);
  await expect(setThread(at(T0), lane, "discord:")).rejects.toBeInstanceOf(LaunchError);
  await expect(setThread(at(T0), lane, "nothread")).rejects.toBeInstanceOf(LaunchError);
  expect((await at(T0).registry.read("demo-lane"))?.thread).toBe(THREAD);
});

for (const thread of ["discord:", "none", ""]) {
  test(`close with thread ${JSON.stringify(thread)} warns THREAD_MISSING instead of skipping the hook silently`, async () => {
    const r = await closeLane(at(T0), { ...lane, thread }, "manual");
    expect(r.closed).toBe(true);
    expect(r.lines.some((l) => l.startsWith("THREAD_MISSING demo-lane "))).toBe(true);
    expect(hookCalls()).toEqual([]);
  });
}

test("close with a thread runs the threadDone hook and warns nothing", async () => {
  const deps = at(T0);
  const envs: unknown[] = [];
  const r = await closeLane({ ...deps, run: (argv, opts) => (argv[0] === "notify" && envs.push(opts?.env), deps.run(argv, opts)) }, lane, "manual", "SSO is on the login page now.");
  // the thread gets the summary for the owner, not the lead's note
  expect(hookCalls()).toEqual([["notify", THREAD, "SSO is on the login page now."]]);
  // the closing lane is still open while its hook runs; dori thread done must not count it as another user of the thread
  expect(envs).toEqual([{ DORI_CLOSING_LANE: "demo-lane" }]);
  expect(r.lines.some((l) => l.startsWith("THREAD_MISSING"))).toBe(false);
});

test("the claim-done auto close also prints THREAD_MISSING for a lane with an empty thread", async () => {
  const empty = { ...lane, thread: "discord:" };
  await at(T0).registry.write(empty);
  await claimDone(at(T0), empty, "merged acme/app#1");
  const lines = await watchTick(at(T0 + 6 * MIN));
  expect(lines.find((l) => l.startsWith("THREAD_MISSING"))).toStartWith("THREAD_MISSING demo-lane ");
  expect(lines.at(-1)).toStartWith("LANE_CLOSED demo-lane");
  expect(hookCalls()).toEqual([]);
});

const BRIEF = "# Lane brief: fix login\n\nOwner asked for the login page to accept SSO.\n\nDo:\n1. Add the SSO button.\n2. Keep password login.\n3. Tests.\n";
// a Discord whose thread holds `messages`; every request is kept
const threadDiscord = (messages: readonly unknown[]) => {
  const seen: HttpRequest[] = [];
  const dc = new Discord(async (req) => {
    seen.push(req);
    return { status: 200, headers: {}, body: JSON.stringify(req.method === "GET" ? messages : { id: "900" }) };
  }, fakeClock(0), "bot");
  return { dc, seen };
};

test("launch posts the lane's first message in an empty work thread: title, goal, brief lines, Done, key and pane", async () => {
  const r = await launch(THREAD);
  const text = laneStartText(defaultDiscordWords.laneStartText, { ...r.lane, goal: "SSO on the login page" }, BRIEF);
  expect(text.split("\n")).toEqual(["new", "Goal, in your words: SSO on the login page", "Owner asked for the login page to accept SSO.", "Do:", "1. Add the SSO button.", "2. Keep password login.", "Done when: merged acme/app#1", `Lane new-lane, pane ${r.lane.pane}`]);
  const { dc, seen } = threadDiscord([]);
  expect(await postLaneStart(dc, THREAD, text)).toBe(`THREAD_START_POSTED ${THREAD} message=900`);
  expect(seen.map((q) => `${q.method} ${q.url.replace(/^.*\/api\/v10/, "")}`)).toEqual(["GET /channels/100000000000000001/messages?limit=1", "POST /channels/100000000000000001/messages"]);
  expect(JSON.parse(String(seen[1]?.body ?? "{}")).content).toBe(text);
});

// owner 2026-11-02 15:43 KST "이건 고쳐": a lane launched on the thread a closed lane had left ✅ and archived kept it that way
test("launch on a thread a closed lane left ✅ and archived opens it again as 🔄, past an open card, through the status queue", async () => {
  const thread = { name: "✅ demo", archived: true };
  const patches: unknown[] = [];
  const dc = new Discord(async (req) => {
    if (req.method === "PATCH") {
      const body = JSON.parse(String(req.body)) as { name?: string; archived?: boolean };
      patches.push(body);
      Object.assign(thread, body);
    }
    return { status: 200, headers: {}, body: JSON.stringify(req.method === "GET" ? { name: thread.name, type: 11, thread_metadata: { archived: thread.archived } } : {}) };
  }, fakeClock(0), "bot");
  const base = aoeDeps();
  // as cli wires it: an open card would keep the thread waiting, a lane registered there makes it working
  const queue = new ThreadStatusQueue({ dc, words: { ...defaultDiscordWords, statusStyle: "emoji" }, file: join(state.dir, "thread-status.json"), openCards: () => ["Q1"], workingLanes: async (t) => (await base.registry.open()).filter((l) => l.thread === `discord:${t}`).map((l) => l.key), now: () => T0, log: () => {} });
  const warned: string[] = [];
  await launch(THREAD, {}, { ...base, reopenThread: async (ref) => String(await queue.request(discordThreadId(ref), "working")) }, (l) => warned.push(l));
  expect({ thread, patches, line: warned.find((l) => l.startsWith("THREAD_REOPEN")) }).toEqual({
    thread: { name: "🔄 demo", archived: false }, patches: [{ name: "🔄 demo", archived: false }], line: `THREAD_REOPEN new-lane ${THREAD}: working requested: applied`,
  });
});

test("a work thread that already has a message is left as it is, and a lane without --goal has no goal line", async () => {
  const { dc, seen } = threadDiscord([{ id: "1", content: "the lead wrote first" }]);
  expect(await postLaneStart(dc, THREAD, "x")).toBe(`THREAD_START_SKIP ${THREAD}: the thread already has a message`);
  expect(seen.map((q) => q.method)).toEqual(["GET"]);
  expect(laneStartText(defaultDiscordWords.laneStartText, lane, BRIEF)).not.toContain("Goal");
});

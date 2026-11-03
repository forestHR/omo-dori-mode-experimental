import { afterEach, beforeEach, expect, test } from "bun:test";

import { claimDone, type FlowDeps, typeIntoPane, watchTick } from "../src/done-flow.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, RUNNING, sent, withState, type World } from "./fakes.ts";

// Moodori 2026-10-31: dori-promo claimed done at 07:16:55Z, the lead typed new work into it at 07:19:13Z and 07:22:00Z, and
// the watch closed it at 07:22:29Z mid-rework; the lead's next dori type got only "no ❯ prompt in the pane".
const T0 = Date.parse("2026-10-31T07:16:55.000Z");
const S = 1_000;
const MIN = 60_000;
const PANE = "aoe_dori-promo_d13a7f99";
const AOE_ID = "d13a7f9900112233";
const lane: Lane = { key: "dori-promo", title: "dori-promo", thread: "none", pane: PANE, brief: "/b.md", done: "file /etc/hostname", cwd: "/repo", openedAt: new Date(T0 - 60 * MIN).toISOString() };

let state: ReturnType<typeof withState>;
let world: World;
const at = (ms: number, patch: Partial<FlowDeps> = {}): FlowDeps => ({ ...depsFor(world, fakeClock(ms), state.dir, { backend: "aoe", leadPane: "aoe_Dori_0a1b2c3d" }), ...patch });
const read = async () => (await at(T0).registry.read(lane.key)) ?? lane;
const watchLog = async () => (await Bun.file(at(T0).config.watchLog).exists() ? await Bun.file(at(T0).config.watchLog).text() : "");
const closed = () => world.calls.some((c) => c[0] === "aoe" && c[1] === "rm");
const typed = () => world.calls.filter((c) => c[0] === "tmux" && c[1] === "send-keys" && c.includes("-l"));
const idle = () => {
  world.aoePs = [{ session: AOE_ID, state: "idle" }];
  world.screen = "❯ ";
};
const busy = () => {
  world.aoePs = [{ session: AOE_ID, state: "running" }];
  world.screen = `❯ \n${RUNNING}`;
};

beforeEach(async () => {
  state = withState();
  world = newWorld();
  world.aoe = [{ id: AOE_ID, title: "dori-promo", path: "/repo", tool: "omo", profile: "main" }];
  world.tmux = [PANE];
  await at(T0).registry.write(lane);
});
afterEach(() => state.done());

test("Moodori's order: claim, the lead types new work 2 minutes later, 5 minutes pass: the lane is working, not closed", async () => {
  await claimDone(at(T0), lane, "promo.mp4 done");
  expect(await watchTick(at(T0 + 29 * S))).toEqual([`LANE_DONE_CLAIMED dori-promo ${PANE} promo.mp4 done`]);
  const r = await typeIntoPane(at(T0 + 138 * S), PANE, "[LEAD] 형 피드백: 자막을 더 크게 다시 만들어");
  expect(r.status).toBe("SUBMITTED");
  expect(r.notes).toEqual([`LANE_CLAIM_REOPENED dori-promo ${PANE} the lead typed a new instruction into the lane (dori type)`]);
  expect(await watchLog()).toContain(`type LANE_CLAIM_REOPENED dori-promo ${PANE} the lead typed`);
  // the lead's text first, then the lane hears its claim was taken back and to claim again
  expect(sent(world).slice(-2)).toEqual(["[LEAD] 형 피드백: 자막을 더 크게 다시 만들어", expect.stringContaining("[LEAD] your done claim for dori-promo is taken back")]);
  const ticks = [...(await watchTick(at(T0 + 334 * S))), ...(await watchTick(at(T0 + 20 * MIN)))];
  expect(ticks.some((l) => l.startsWith("LANE_CLOSED"))).toBe(false);
  expect(closed()).toBe(false);
  expect(statusOf(await read())).toBe("working");
  expect((await read()).history?.at(-1)?.note).toBe("REOPENED: the lead typed a new instruction into the lane (dori type)");

  // the close rule still holds for the next claim: five quiet minutes after it the lane closes
  await claimDone(at(T0 + 30 * MIN), await read(), "promo.mp4 v2");
  await watchTick(at(T0 + 30 * MIN + 10 * S));
  expect((await watchTick(at(T0 + 35 * MIN + S))).at(-1)).toStartWith("LANE_CLOSED dori-promo");
});

test("a claimed lane that sat idle and then runs a new turn is working again; the watch log and the lane say so", async () => {
  await claimDone(at(T0), lane, "promo.mp4 done");
  idle();
  await watchTick(at(T0 + 30 * S));
  await watchTick(at(T0 + 60 * S));
  busy();
  const lines = await watchTick(at(T0 + 138 * S));
  expect(lines).toContain(`LANE_CLAIM_REOPENED dori-promo ${PANE} the lane ran a new turn after it sat idle since ${new Date(T0 + 30 * S).toISOString()}`);
  expect(sent(world).at(-1)).toStartWith("[LEAD] your done claim for dori-promo is taken back");
  expect((await watchTick(at(T0 + 6 * MIN))).some((l) => l.startsWith("LANE_CLOSED"))).toBe(false);
  expect(statusOf(await read())).toBe("working");
});

test("a turn right after going idle (the claim's [LEAD] line, a goal wake) does not reopen: the lane still closes after 5 minutes", async () => {
  await claimDone(at(T0), lane, "promo.mp4 done");
  idle();
  expect(await watchTick(at(T0 + 30 * S))).toEqual([`LANE_DONE_CLAIMED dori-promo ${PANE} promo.mp4 done`]);
  busy();
  expect(await watchTick(at(T0 + 60 * S))).toEqual([]);
  idle();
  await watchTick(at(T0 + 90 * S));
  expect((await watchTick(at(T0 + 5 * MIN + S))).at(-1)).toStartWith("LANE_CLOSED dori-promo");
  expect(closed()).toBe(true);
});

test("dori type into a closed lane's pane names the lane, when and who closed it; nothing is typed, NOT_SUBMITTED", async () => {
  const closedAt = "2026-10-31T07:22:29.000Z";
  await at(T0).registry.write({ ...lane, status: "closed", closedAt, history: [{ at: closedAt, status: "verified-done", note: "Done signals read back live" }, { at: closedAt, status: "closed", note: "Done: promo.mp4" }] });
  const r = await typeIntoPane(at(T0 + 6 * MIN), PANE, "[LEAD] 다시 해줘");
  expect(r.status).toBe("NOT_SUBMITTED");
  expect(r.reason).toStartWith(`LANE_IS_CLOSED dori-promo closed at ${closedAt} by the watch (automatic close after the done claim): nothing was typed`);
  expect(typed()).toEqual([]);
  expect(await watchLog()).toContain(`type NOT_SUBMITTED ${PANE} LANE_IS_CLOSED dori-promo`);
});

test("dori type into a pane whose tmux session is gone is PANE_GONE, and a dead pane PANE_DEAD; nothing is typed", async () => {
  const base = at(T0).run;
  const gone: Runner = async (argv, opts) => (argv[0] === "tmux" && argv[1] === "has-session" ? { code: 1, out: "", err: "can't find session" } : base(argv, opts));
  const r = await typeIntoPane(at(T0, { run: gone }), "aoe_nobody_0000aaaa", "[LEAD] hello");
  expect(r).toMatchObject({ status: "NOT_SUBMITTED", reason: "PANE_GONE: there is no tmux session aoe_nobody_0000aaaa (it ended, or the name is wrong); nothing was typed" });
  const dead: Runner = async (argv, opts) => (argv[0] === "tmux" && argv[1] === "display-message" && argv.at(-1)?.startsWith("#{pane_dead}") ? { code: 0, out: "1 143", err: "" } : base(argv, opts));
  expect((await typeIntoPane(at(T0, { run: dead }), PANE, "[LEAD] hello")).reason).toBe(`PANE_DEAD: the program in ${PANE} exited (status 143); nothing was typed`);
  expect(typed()).toEqual([]);
});

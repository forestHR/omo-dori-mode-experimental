import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { LANE_TELL_LEAD_AFTER_MS, laneTellsFile, leadMovedText, noteLaneTell, retryLaneTells } from "../src/lane-tells.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

const PANE = "aoe_analytics_801ad431";
const NEW = "aoe_lead2_b1bc2f63";
const AT = "2026-10-31T07:01:48.000Z";
const BORDER = "────────────────────────────────────────";
// the lane's main turn waits on its children: an empty box and no running turn
const IDLE = ["transcript", BORDER, "❯ ", BORDER, " ⠏ child · category:quick · running"].join("\n");
// a turn runs: omo draws its mark on the box's top border
const BUSY = ["transcript", `── • Working (2s • esc to interrupt) ${BORDER}`, "❯ ", BORDER, " ⠏ child · category:quick · running"].join("\n");

let state: { dir: string; done: () => void };
let w: World;
beforeEach(() => {
  state = withState();
  w = newWorld();
});
afterEach(() => state.done());

const lane = (): Lane => ({ key: "analytics", title: "A", thread: "discord:1", pane: PANE, brief: "/tmp/b.md", done: "x", openedAt: AT, status: "working" });

const setup = async (minutesLater: number, delivered = false) => {
  const clock = fakeClock(Date.parse(AT) + minutesLater * 60_000);
  const base = depsFor(w, clock, state.dir, { backend: "aoe", leadPane: NEW });
  await base.registry.write(lane());
  noteLaneTell(state.dir, "analytics", PANE, NEW, AT, false);
  return { ...base, delivered: async () => delivered };
};

test("a lane that took no lead notice is told again once a turn runs in it, and the wait ends", async () => {
  // Given
  const deps = await setup(3);
  w.screens[PANE] = BUSY;
  // When
  const lines = await retryLaneTells(deps);
  // Then
  expect(sent(w)).toEqual([leadMovedText(NEW)]);
  expect(lines).toEqual([`HANDOVER_LANE_TOLD analytics ${PANE}: told the lead is ${NEW} (try 2, while its turn ran)`]);
  expect(JSON.parse(readFileSync(laneTellsFile(state.dir), "utf8"))).toEqual({});
});

test("while the lane's main turn only waits on its children nothing is typed, and after the wait the lead is told once", async () => {
  // Given
  w.screens[PANE] = IDLE;
  // When: a few minutes in, and again past the wait
  const early = await retryLaneTells(await setup(3));
  const due = await setup(LANE_TELL_LEAD_AFTER_MS / 60_000);
  const late = await retryLaneTells(due);
  const again = await retryLaneTells(due);
  // Then
  expect(early).toEqual([]);
  expect(sent(w).filter((t) => t.startsWith("[LEAD]"))).toEqual([]);
  expect(late).toEqual([`HANDOVER_LANE_UNTOLD analytics ${PANE}: 20 min without the lead notice; the lead was told`]);
  expect(sent(w).filter((t) => t.startsWith("[DORI] HANDOVER_LANE_UNTOLD analytics"))).toHaveLength(1);
  expect(w.calls.some((c) => c[1] === "send-keys" && c.includes(`=${NEW}:`))).toBe(true);
  expect(again).toEqual([]);
});

test("a held copy that reached the lane's transcript later counts as told: nothing is typed again", async () => {
  // Given
  const deps = await setup(5, true);
  w.screens[PANE] = BUSY;
  // When
  const lines = await retryLaneTells(deps);
  // Then
  expect(sent(w)).toEqual([]);
  expect(lines).toEqual([`HANDOVER_LANE_TOLD analytics ${PANE}: the lead notice reached the lane's transcript late (omo held it)`]);
});

test("a closed lane or one moved to a new session drops its wait without typing anything", async () => {
  // Given
  const deps = await setup(30);
  await deps.registry.write({ ...lane(), pane: "aoe_analytics_new" });
  // When
  const lines = await retryLaneTells(deps);
  // Then
  expect(lines).toEqual([]);
  expect(sent(w)).toEqual([]);
  expect(existsSync(laneTellsFile(state.dir)) && JSON.parse(readFileSync(laneTellsFile(state.dir), "utf8"))).toEqual({});
});

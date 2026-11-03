import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { closeLane } from "../src/done-flow.ts";
import { renderBrief } from "../src/launch.ts";
import { Lessons } from "../src/lessons.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-11-03T00:00:00.000Z");
const lane: Lane = { key: "lesson-flow", title: "QA", thread: "none", brief: "/b.md", done: "merged acme/app#1", cwd: "/repo", openedAt: new Date(T0).toISOString() };
const lesson = { rule: "Subscribe before triggering", evidence: "/evidence/test.txt" };
let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("a successful close keeps the lesson for the lane's repo", async () => {
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
  const r = await closeLane(deps, lane, "verified", undefined, undefined, lesson);
  expect(r.closed).toBe(true);
  const kept = new Lessons(state.dir).read().lessons;
  expect(kept.map(({ rule, evidence, lane: key, cwd, outcome }) => ({ rule, evidence, lane: key, cwd, outcome }))).toEqual([{ ...lesson, lane: lane.key, cwd: "/repo", outcome: "pending" }]);
  expect(r.lines).toContain(`LESSON ${kept[0]?.id}`);
});

test("a refused close keeps no lesson", async () => {
  const world = newWorld();
  world.prState = "OPEN";
  const r = await closeLane(depsFor(world, fakeClock(T0), state.dir), lane, "not ready", undefined, undefined, lesson);
  expect(r.closed).toBe(false);
  expect(new Lessons(state.dir).read().lessons).toEqual([]);
});

test("a lesson that cannot be kept is a warning and the close still happens", async () => {
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
  mkdirSync(join(state.dir, "lessons.jsonl"));
  const r = await closeLane(deps, lane, "verified", undefined, undefined, lesson);
  expect(r.closed).toBe(true);
  expect((await deps.registry.read(lane.key))?.status).toBe("closed");
  expect(r.lines.some((l) => l.startsWith(`LESSON_WARNING ${lane.key}: `))).toBe(true);
});

test("a close without --lesson leaves the journal alone", async () => {
  writeFileSync(join(state.dir, "lessons.jsonl"), "invalid\n");
  const r = await closeLane(depsFor(newWorld(), fakeClock(T0), state.dir), lane, "verified");
  expect(r.closed).toBe(true);
  expect(readFileSync(join(state.dir, "lessons.jsonl"), "utf8")).toBe("invalid\n");
});

test("the brief carries the repo's current lessons before Past signals and the footer, and never repeats the brief's own words", async () => {
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
  const lessons = new Lessons(state.dir);
  const kept = lessons.add({ ...lesson, lane: "earlier", cwd: "/repo" }, T0);
  const retired = lessons.add({ rule: "Retired rule", evidence: "/e", lane: "earlier", cwd: "/repo" }, T0 + 1);
  lessons.mark(retired.id, "harmful");
  lessons.add({ rule: "Other repo rule", evidence: "/e", lane: "earlier", cwd: "/elsewhere" }, T0 + 2);
  lessons.add({ rule: "Run the big tests through dori heavy", evidence: "/e", lane: "earlier", cwd: "/repo" }, T0 + 3);
  appendFileSync(lessons.path, "not json\n");
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# Port it\nRun the big tests through dori heavy.\n");
  const r = await renderBrief(deps, { key: "lesson-next", title: "next", brief, done: "merged acme/app#2", cwd: "/repo" });
  const at = r.text.indexOf("## Lessons for this repo (written by dori launch)");
  expect(at).toBeGreaterThan(r.text.indexOf("# Port it"));
  expect(at).toBeLessThan(r.text.indexOf("## Lane footer"));
  expect(r.text).toContain(`- [pending; earlier; ${kept.id}] Subscribe before triggering`);
  expect(r.text).not.toContain("Retired rule");
  expect(r.text).not.toContain("Other repo rule");
  expect(r.text.split("Run the big tests through dori heavy").length).toBe(2);
  expect(r.lines.some((l) => l.startsWith(`LESSON_WARNING ${lessons.path}:`))).toBe(true);
});

test("a repo with no lessons gets no lessons section", async () => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# Port it\n");
  const r = await renderBrief(depsFor(newWorld(), fakeClock(T0), state.dir), { key: "lesson-none", title: "none", brief, done: "merged acme/app#2", cwd: "/repo" });
  expect(r.text).not.toContain("## Lessons for this repo");
});

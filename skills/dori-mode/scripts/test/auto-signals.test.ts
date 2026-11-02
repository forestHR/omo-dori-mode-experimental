import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { failedMetrics, inferRepeats, type LaneEvent, passedMetrics, readReports, suspects } from "../src/auto-signals.ts";
import { loadTree, researchDone, stuckView } from "../src/explore.ts";
import { eightSteps } from "../src/launch.ts";
import { defaultConfig } from "../src/config.ts";
import { freshnessTick } from "../src/freshness.ts";
import { briefForCheck, claimCheck, groundFindings, linkedWords, ownerDecisions, ownerDue, ownerWords, parseOwnerReply, quoted, runOwnerCheck, sendReread, tieDecisions } from "../src/owner-check.ts";
import type { Lane } from "../src/registry.ts";
import { crossed, dueReasons } from "../src/rollover.ts";
import { recordFix } from "../src/same-fix.ts";
import type { Runner } from "../src/run.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, sent, withState, type World } from "./fakes.ts";

const cfg = defaultConfig("/home/test").autoSignals;
const T0 = Date.parse("2026-10-10T00:00:00Z");
const at = (min: number): string => new Date(T0 + min * 60_000).toISOString();
const ev = (min: number, text: string, source: LaneEvent["source"] = "report"): LaneEvent => ({ at: at(min), source, text });

test("a gate line's failure is read from the item that holds FAIL and from the bare list after it, not from test suites or ids", () => {
  expect(failedMetrics("e7st1g model_795 F1 \ubd88\ud569\uaca9 3/8: \ub364\ud504 \uc131\uacf5 0.6875 FAIL(\u22650.76; 44/64), \uad50\ucc29 554 FAIL(\u22642), \uba48\ucda4 \ud310 8 FAIL(0)", cfg).sort()).toEqual(["\ub364\ud504 \uc131\uacf5", "\uba48\ucda4", "\uad50\ucc29"].sort());
  expect(failedMetrics("6/10 \u2014 FAIL \ub3c4\ub791 \uc704 \ub364\ud504 1\u00b7\uad50\ucc29 58(\ubcbd 2/\ud55c\uacc4 56)\u00b7\ud0c8\ucd9c 0.40 %\u00b7frozen 2.4 %.", cfg).sort()).toEqual(["frozen", "\ub3c4\ub791 \uc704 \ub364\ud504", "\uad50\ucc29", "\ud0c8\ucd9c"].sort());
  // a dash ends the list: \ub364\ud504 is not one of the failed lines
  expect(failedMetrics("7/8 PASS, FAIL \uad50\ucc29 145 \u2014 \ub364\ud504 0.837(123/147), \uc804\ub2ec 0.460", cfg)).toEqual(["\uad50\ucc29"]);
  expect(failedMetrics("suite 48: 381 passed, 13 failed = suite 47 cuda-only list", cfg)).toEqual([]);
  expect(failedMetrics("model_1625 0.5 FAIL, GPU-13 4 FAIL", cfg)).toEqual([]);
  expect(passedMetrics("\ub364\ud504 \uc131\uacf5 0.885 \u2713, \uba48\ucda4 \ud310 0 PASS, \uad50\ucc29 145 FAIL", cfg).sort()).toEqual(["\ub364\ud504 \uc131\uacf5", "\uba48\ucda4"].sort());
});

const loop: LaneEvent[] = [
  ev(0, "model_498 F1: \uad50\ucc29 487 FAIL(\u22642)"),
  ev(10, "\uc870\uc815 1 \uc2dc\uc791: \uad50\ucc29 \uc9c4\uc785 \ubc8c\uc810 rew_limit_push -0.03"),
  ev(100, "model_597 F1: \uad50\ucc29 584 FAIL"),
  ev(110, "\uc870\uc815 2 \uc2dc\uc791: \ud3c9\uade0 \ud589\ub3d9 \uad50\ucc29 \ubc8c\uc810"),
  ev(200, "model_697 F1: \uad50\ucc29 554 FAIL"),
  ev(210, "\uc870\uc815 3: \uad50\ucc29 \uc7ac\uc9c4\uc785 \ubc8c\uc810 \ucd94\uac00"),
];

test("three cycles of a failed gate line re-targeted by a new prescription count 3, the third and not the second", () => {
  expect(suspects(inferRepeats(loop.slice(0, 4), cfg), 3)).toEqual([]);
  const hit = suspects(inferRepeats(loop, cfg), 3);
  expect(hit.map((r) => [r.metric, r.n])).toEqual([["\uad50\ucc29", 3]]);
  expect(hit[0]?.evidence.map((e) => e.role)).toEqual(["fail", "attempt", "fail", "attempt", "fail", "attempt"]);
});

test("an attempt counts only after a new failure, outside the duplicate gap, when it is not negated, a pure diagnosis, or after a PASS", () => {
  // attempts with no failure in between are one cycle
  expect(inferRepeats([loop[0] as LaneEvent, ev(40, "\uc870\uc815 1: \uad50\ucc29 \ubc8c\uc810"), ev(80, "\uc870\uc815 1b: \uad50\ucc29 \ubc8c\uc810 \uc218\uc815"), ev(120, "\uc870\uc815 1c: \uad50\ucc29 \ubc8c\uc810 \uc218\uc815")], cfg).counts.get("\uad50\ucc29")?.n).toBe(1);
  // a commit and its report 5 minutes apart are one attempt
  expect(inferRepeats([loop[0] as LaneEvent, ev(10, "fix(rl): \uad50\ucc29 penalty", "commit"), ev(12, "model_x \uad50\ucc29 9 FAIL"), ev(15, "\uc870\uc815: \uad50\ucc29 \ubc8c\uc810 \ubc18\uc601")], cfg).counts.get("\uad50\ucc29")?.n).toBe(1);
  const negated = [loop[0] as LaneEvent, ev(10, "\uad50\ucc29 \ubc8c\uc810 \uc870\uc815 \uc548 \ud568, \uc6d0\uc778 \uc9c4\ub2e8 \uba3c\uc800")];
  expect(inferRepeats(negated, cfg).counts.size).toBe(0);
  const diagnosis = [loop[0] as LaneEvent, ev(10, "\uad50\ucc29 \uc7ac\uc0dd \ud0d0\uce68 \uc2dc\uc791")];
  expect(inferRepeats(diagnosis, cfg).counts.size).toBe(0);
  // "\uc2dc\uc791" alone starts evals too; it is no attempt without a prescription word
  expect(inferRepeats([loop[0] as LaneEvent, ev(40, "F1 24\ud310 \uc2dc\uc791, \uad50\ucc29 \ub2e4\uc2dc \uc7ac\uae30")], cfg).counts.size).toBe(0);
  // an eval report that states the FAIL and plans the next adjustment is not yet a new attempt (challenge, grok-4.7)
  expect(inferRepeats([ev(0, "model_993 F1: \uad50\ucc29 136 FAIL. \ub2e4\uc74c \uc870\uc815: \uad50\ucc29 \uc9c4\uc785 \ubc8c\uc810")], cfg).counts.size).toBe(0);
  const passed = [...loop.slice(0, 4), ev(150, "model_600 F1: \uad50\ucc29 2 PASS"), ...loop.slice(4)];
  expect(inferRepeats(passed, cfg).counts.get("\uad50\ucc29")?.n).toBe(1);
});

test("clause scope needs the metric next to the attempt word; sentence scope and aliases widen what counts", () => {
  const context = [ev(0, "\uad50\ucc29 9 FAIL"), ev(40, "\uc7ac\uc0dd(model_795, \uad50\ucc29 \uad6c\uac04) 09:20Z \uc2dc\uc791, \ubc8c\uc810 \uc5c6\uc774")];
  expect(inferRepeats(context, { ...cfg, targetScope: "clause" }).counts.size).toBe(0);
  const near = [ev(0, "\uad50\ucc29 9 FAIL"), ev(40, "e7st1j \uc2dc\uc791 \u2014 \uc870\uc815 4\ub294 \ud3c9\uade0 \ud589\ub3d9 \uc9c4\uc785 \uc81c\ud55c, \ub300\uc0c1 \uad50\ucc29 \uc904\uc774\uae30")];
  expect(inferRepeats(near, { ...cfg, targetScope: "clause" }).counts.size).toBe(0);
  expect(inferRepeats(near, { ...cfg, targetScope: "sentence" }).counts.get("\uad50\ucc29")?.n).toBe(1);
  const english = [ev(0, "\uad50\ucc29 9 FAIL"), ev(40, "feat(rl): stage-1 tuning, deadlocks entry penalty", "commit")];
  expect(inferRepeats(english, cfg).counts.size).toBe(0);
  expect(inferRepeats(english, { ...cfg, aliases: { "\uad50\ucc29": ["deadlock", "deadlocks"] } }).counts.get("\uad50\ucc29")?.n).toBe(1);
});

test("a prescription verdict (REJECTED, \uae30\uac01, \ud310\uc815 \ubd88\uac00) fails the known metrics its sentence names", () => {
  const events = [ev(0, "\uba48\ucda4 \ud310 8 FAIL"), ev(10, "HL1 \ucc98\ubc29: \uc2a4\uc719 \u03c3 \ud558\ud55c 0.20, \ub300\uc0c1 \uba48\ucda4"), ev(100, "n1 \ud6a8\uacfc \ud310\uc815 = \ud310\uc815 \ubd88\uac00, \uba48\ucda4 16 \u2192 15"), ev(110, "T-explore \ucc98\ubc29 \ucd94\uac00, \ub300\uc0c1 \uba48\ucda4")];
  expect(inferRepeats(events, cfg).counts.get("\uba48\ucda4")?.n).toBe(2);
});

test("a stuck rung 4 makes a rollover due as a reason, never a measured crossing; with the auto key on it starts an automatic rollover, with it off the STUCK line is the only notice", async () => {
  const limits = { contextPct: 0, compactions: 0, ageH: 0 };
  expect(dueReasons({ stuck: { metric: "교착", n: 4, rung: 4 } }, limits)).toEqual(['stuck rung 4 on "교착" (4 attempts)']);
  expect(dueReasons({ stuck: { metric: "교착", n: 3, rung: 3 } }, limits)).toEqual([]);
  expect(crossed({ stuck: { metric: "교착", n: 4, rung: 4 } }, limits)).toEqual([]);
  const state = withState();
  try {
    const w = newWorld();
    const off = depsFor(w, fakeClock(T0 + 60_000), state.dir, { backend: "aoe" });
    await off.registry.write({ ...lane(state.dir), pane: "aoe_rl_1", lastReplyAt: T0 + 60_000, stuck: { "교착": { rung: 4, n: 4, at: at(0), pane: "aoe_rl_1" } } });
    let started = 0;
    const hooks = { signals: async () => ({}), auto: async () => `started ${++started}` };
    expect(await freshnessTick(off, "/home/test", hooks)).toEqual([]);
    expect(started).toBe(0);
    const deps = depsFor(w, fakeClock(T0 + 60_000), state.dir, { backend: "aoe", handover: { ...defaultConfig("/home/test").handover, autoRolloverLanes: true } });
    const acts = await freshnessTick(deps, "/home/test", hooks);
    expect(acts.map((a) => [a.kind, a.lane, a.detail.split(" in ")[0]])).toEqual([["rollover_due", "rl-e7", 'stuck rung 4 on "교착" (4 attempts)'], ["rollover_auto", "rl-e7", "started 1"]]);
    expect(started).toBe(1);
  } finally {
    state.done();
  }
});

test("the stuck count is the larger of the tagged and the inferred count, under one alias name", async () => {
  const st = withState();
  try {
    const aliases = { "교착": ["deadlock", "deadlocks"] };
    const deps = depsFor(newWorld(), fakeClock(T0), st.dir, { autoSignals: { ...cfg, aliases }, explore: { ...defaultConfig("/home/test").explore, sendResearchToLane: false } });
    await deps.registry.write({ ...lane(st.dir), inferred: { at: at(0), counts: { "교착": 4 } } });
    const r = await recordFix(deps, "rl-e7", { at: at(1), metric: "deadlocks", hypothesis: "reward", via: "report" });
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toStartWith('STUCK rl-e7 "교착" rung 3 (tagged 1, inferred 4, hypotheses 1, inferred only, first count) -> ulw research');
    expect(r.notes[0]).toEndWith("[HYPOTHESES_REQUIRED RESEARCH_DUE REPEAT_SUSPECT]");
    const saved = (await deps.registry.read("rl-e7")) as Lane;
    expect(stuckView(saved, "deadlock", deps.config)).toMatchObject({ metric: "교착", tagged: 1, inferred: 4, n: 4 });
    // a PASS the reports showed after the tagged attempt starts the tagged half again too
    expect(stuckView({ ...saved, inferred: { at: at(2), counts: {}, passedAt: { "교착": at(2) } } }, "deadlocks", deps.config)).toMatchObject({ tagged: 0, inferred: 0, n: 0 });
  } finally {
    st.done();
  }
});

const lane = (dir: string): Lane => ({ key: "rl-e7", title: "E7", thread: "none", pane: "w:p1", brief: join(dir, "brief.md"), done: "x", cwd: "/repo", openedAt: at(-60), model: "anthropic/claude-opus-5-5" });

const sessionLine = (min: number, role: "assistant" | "user", text: string): string =>
  JSON.stringify(role === "assistant" ? { type: "message", timestamp: at(min), message: { role, content: [{ type: "toolCall", arguments: { command: `tmux send-keys -t =lead: -l -- "${text}"` } }] } } : { type: "message", timestamp: at(min), message: { role, content: [{ type: "text", text }] } });

let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const writeSession = (lines: readonly string[], cwd = "/repo"): string => {
  const dir = sessionDirFor(join(state.dir, "sessions"), cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "2026-10-10T00-00-00-000Z_00000000-0000-0000-0000-000000000000.jsonl");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
};

test("freshness turns the untagged loop into one STUCK rung 3 and types the ulw research text into the lane; a later report adds nothing", async () => {
  writeSession(loop.map((e) => sessionLine((Date.parse(e.at) - T0) / 60_000, "assistant", `[REPORT] rl-e7 | milestone | ${e.text}`)));
  const deps = depsFor(world, fakeClock(T0 + 220 * 60_000), state.dir, { sessionsDir: join(state.dir, "sessions") });
  await deps.registry.write(lane(state.dir));
  world.screens["lead:p1"] = ` [REPORT] rl-e7 | milestone | ${loop.at(-1)?.text}\n\n❯ `;
  const acts = (await freshnessTick(deps, "/home/test")).filter((a) => a.kind === "stuck");
  expect(acts.map((a) => a.detail.split(" -> ")[0])).toEqual(['"교착" rung 3 (tagged 0, inferred 3, hypotheses 0, inferred only, first count)']);
  // the first scan of a long loop jumps: the line carries the skipped rung's name too (challenge, grok-4.7)
  expect(acts[0]?.detail).toEndWith("ulw research sent to the lane [HYPOTHESES_REQUIRED RESEARCH_DUE REPEAT_SUSPECT]");
  expect(await Bun.file(deps.config.watchLog).text()).toMatch(/ stuck STUCK rl-e7 "교착" rung 3 /);
  expect(sent(world)).toHaveLength(1);
  expect(sent(world)[0]).toStartWith("ulw research ");
  expect((await deps.registry.read("rl-e7"))?.inferred?.counts).toEqual({ "교착": 3 });
  expect(await Bun.file(join(state.dir, "auto-signals", "rl-e7.md")).text()).toContain('"교착" 3');
  world.screens["lead:p1"] = " [REPORT] rl-e7 | milestone | 다음 run 준비 중\n\n❯ ";
  expect((await freshnessTick(deps, "/home/test")).filter((a) => a.kind === "stuck")).toEqual([]);
});

test("a PASS between two sweeps ends the run: no STUCK line, and the PASS time is kept for the tagged half", async () => {
  const line = (e: LaneEvent) => sessionLine((Date.parse(e.at) - T0) / 60_000, "assistant", `[REPORT] rl-e7 | milestone | ${e.text}`);
  const file = writeSession(loop.slice(0, 2).map(line));
  const deps = depsFor(world, fakeClock(T0 + 20 * 60_000), state.dir, { sessionsDir: join(state.dir, "sessions") });
  await deps.registry.write(lane(state.dir));
  world.screens["lead:p1"] = ` [REPORT] rl-e7 | milestone | ${loop[1]?.text}\n\n❯ `;
  expect((await freshnessTick(deps, "/home/test")).filter((a) => a.kind === "stuck")).toEqual([]);
  const pass = ev(260, "model_800 F1: 교착 1 PASS");
  writeFileSync(file, `${[...loop, pass].map(line).join("\n")}\n`);
  world.screens["lead:p1"] = ` [REPORT] rl-e7 | milestone | ${pass.text}\n\n❯ `;
  const later = { ...deps, clock: fakeClock(T0 + 270 * 60_000) };
  expect((await freshnessTick(later, "/home/test")).filter((a) => a.kind === "stuck")).toEqual([]);
  const after = (await deps.registry.read("rl-e7")) as Lane;
  expect(after.inferred?.counts).toEqual({});
  expect(after.inferred?.passedAt).toEqual({ "교착": at(260) });
  expect(sent(world)).toEqual([]);
});

// rung 3 already done: the lane's own read of the ulw-research skill, its research folder, its dori challenge
const skillReadLine = (min: number): string => JSON.stringify({ type: "message", timestamp: at(min), message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "/opt/omo-ai/plugin/skills/ulw-research/SKILL.md" } }] } });
const reportLine = (e: LaneEvent): string => sessionLine((Date.parse(e.at) - T0) / 60_000, "assistant", `[REPORT] rl-e7 | milestone | ${e.text}`);
const planFile = (name: string, text: string): string => {
  const p = join(state.dir, name);
  writeFileSync(p, text);
  return p;
};
const cycle4 = [ev(300, "model_797 F1: 교착 500 FAIL"), ev(310, "조정 4: 교착 벌점 구간 추가")];

test("rung 3 is already done when the lane ran ulw research and a dori challenge on the symptom after the third repeat: nothing is typed and the ladder waits; one more failed cycle is rung 4 (hr35-e7 정지, 2026-10-12 14:33Z)", async () => {
  const file = writeSession([...loop.map(reportLine), skillReadLine(215)]);
  const deps = depsFor(world, fakeClock(T0 + 240 * 60_000), state.dir, { sessionsDir: join(state.dir, "sessions") });
  const plan = planFile("plan.md", "# 교착 처방 설계");
  await deps.registry.write({ ...lane(state.dir), challenges: [{ at: at(230), model: "openai/gpt-x", plan, file: "c.md" }] });
  world.screens["lead:p1"] = ` [REPORT] rl-e7 | milestone | ${loop.at(-1)?.text}\n\n❯ `;
  const acts = (await freshnessTick(deps, "/home/test")).filter((a) => a.kind === "stuck");
  expect(acts.map((a) => a.detail)).toEqual([
    `"교착" rung 3 (tagged 0, inferred 3, hypotheses 0, inferred only, first count) -> already done after attempt 3: ulw research (ulw-research/SKILL.md read ${at(215)}, ${file.split("/").at(-1)}) and dori challenge (openai/gpt-x ${at(230)}, plan ${plan}); nothing sent, wait for the next attempt's result (one more failed attempt is rung 4) [HYPOTHESES_REQUIRED RESEARCH_DONE REPEAT_SUSPECT]`,
  ]);
  expect(sent(world)).toEqual([]);
  expect((await loadTree(state.dir, { cwd: "/repo" })).nodes.filter((n) => n.kind === "research")).toEqual([]);
  expect((await deps.registry.read("rl-e7"))?.stuck?.["교착"]).toMatchObject({ rung: 3, n: 3 });
  writeFileSync(file, `${[...loop.map(reportLine), skillReadLine(215), ...cycle4.map(reportLine)].join("\n")}\n`);
  world.screens["lead:p1"] = ` [REPORT] rl-e7 | milestone | ${cycle4[1]?.text}\n\n❯ `;
  const next = (await freshnessTick({ ...deps, clock: fakeClock(T0 + 320 * 60_000) }, "/home/test")).filter((a) => a.kind === "stuck");
  expect(next.map((a) => a.detail.split(" -> ")[0])).toEqual(['"교착" rung 4 (tagged 0, inferred 4, hypotheses 0, inferred only)']);
  expect(next[0]?.detail).toEndWith("[ROLLOVER_DUE REPEAT_SUSPECT]");
  expect(sent(world)).toEqual([]);
});

test("a failed cycle after research the lane already did (its research folder) and a challenge is rung 4 at the first scan, not a second research; the folder's brief names the symptom", async () => {
  const cwd = join(state.dir, "repo");
  const started = new Date(T0 + 250 * 60_000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  // the ulw-research skill names its folder by the local time (date +%Y%m%d-%H%M%S)
  const folder = join(cwd, ".omo", "ulw-research", `${started.getFullYear()}${pad(started.getMonth() + 1)}${pad(started.getDate())}-${pad(started.getHours())}${pad(started.getMinutes())}${pad(started.getSeconds())}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "brief.md"), "# 교착 루프의 원인");
  writeSession([...loop, ...cycle4].map(reportLine), cwd);
  const deps = depsFor(world, fakeClock(T0 + 320 * 60_000), state.dir, { sessionsDir: join(state.dir, "sessions") });
  await deps.registry.write({ ...lane(state.dir), cwd, challenges: [{ at: at(260), model: "openai/gpt-x", plan: planFile("plan.md", "# next run"), file: "c.md" }] });
  world.screens["lead:p1"] = ` [REPORT] rl-e7 | milestone | ${cycle4[1]?.text}\n\n❯ `;
  const acts = (await freshnessTick(deps, "/home/test")).filter((a) => a.kind === "stuck");
  expect(acts.map((a) => a.detail.split(" -> ")[0])).toEqual(['"교착" rung 4 (tagged 0, inferred 4, hypotheses 0, inferred only, first count)']);
  expect(acts[0]?.detail).toContain(`-> 1 failed attempt after the ulw research (${folder}) and dori challenge (openai/gpt-x ${at(260)}`);
  expect(acts[0]?.detail).toEndWith("[HYPOTHESES_REQUIRED RESEARCH_DONE ROLLOVER_DUE REPEAT_SUSPECT]");
  expect(sent(world)).toEqual([]);
});

test("research read before the third repeat is not rung 3 done: the ulw research text is typed as before", async () => {
  writeSession([...loop.slice(0, 4).map(reportLine), skillReadLine(150), ...loop.slice(4).map(reportLine)]);
  const deps = depsFor(world, fakeClock(T0 + 240 * 60_000), state.dir, { sessionsDir: join(state.dir, "sessions") });
  await deps.registry.write({ ...lane(state.dir), challenges: [{ at: at(230), model: "openai/gpt-x", plan: planFile("plan.md", "# 교착 처방"), file: "c.md" }] });
  world.screens["lead:p1"] = ` [REPORT] rl-e7 | milestone | ${loop.at(-1)?.text}\n\n❯ `;
  const acts = (await freshnessTick(deps, "/home/test")).filter((a) => a.kind === "stuck");
  expect(acts[0]?.detail).toEndWith("ulw research sent to the lane [HYPOTHESES_REQUIRED RESEARCH_DUE REPEAT_SUSPECT]");
  expect(sent(world)).toHaveLength(1);
});

test("rung 3 done needs both research and a challenge after the repeat, on the symptom (the metric or an alias)", () => {
  const config = { ...defaultConfig("/home/test"), sessionsDir: join(state.dir, "sessions"), autoSignals: { ...cfg, aliases: { "정지": ["멈춤", "hold"] } } };
  writeSession([skillReadLine(215)]);
  const base = { ...lane(state.dir), cwd: "/repo" };
  const challenge = (plan: string) => [{ at: at(230), model: "m", plan, file: "c.md" }];
  expect(researchDone(config, base, "정지", at(210))).toBeUndefined();
  expect(researchDone(config, { ...base, challenges: challenge(planFile("a.md", "# 교착 처방")) }, "정지", at(210))).toBeUndefined();
  expect(researchDone(config, { ...base, challenges: challenge(planFile("b.md", "한 번 퍼 담고 멈춤")) }, "정지", at(210))?.at).toBe(at(230));
  expect(researchDone(config, { ...base, challenges: challenge(planFile("c.md", "early holds")) }, "정지", at(210))).toBeUndefined();
  expect(researchDone(config, { ...base, challenges: challenge(planFile("d.md", "the hold loop")) }, "정지", at(220))).toBeUndefined();
  // done when the challenge on the symptom was, not at an earlier one of another plan (challenge, gpt-6-astra)
  const two = [{ at: at(220), model: "m", plan: planFile("e.md", "# 교착 처방"), file: "c.md" }, { at: at(230), model: "m", plan: planFile("f.md", "한 번 퍼 담고 멈춤"), file: "c.md" }];
  expect(researchDone(config, { ...base, challenges: two }, "정지", at(210))?.at).toBe(at(230));
});

test("a fix the lead records (dori fix-attempt) sees the research and challenge done after the inferred cycles too: rung 3 done, nothing typed (challenge, gpt-6-astra)", async () => {
  writeSession([skillReadLine(215)]);
  const deps = depsFor(world, fakeClock(T0 + 240 * 60_000), state.dir, { sessionsDir: join(state.dir, "sessions") });
  const cycles = { "교착": [at(10), at(110), at(210)] };
  await deps.registry.write({ ...lane(state.dir), inferred: { at: at(220), counts: { "교착": 3 }, cycles }, challenges: [{ at: at(230), model: "openai/gpt-x", plan: planFile("plan.md", "# 교착 처방 설계"), file: "c.md" }] });
  const r = await recordFix(deps, "rl-e7", { at: at(235), metric: "교착", hypothesis: "벌점 구간", via: "lead" });
  expect(r.notes[0]).toStartWith('STUCK rl-e7 "교착" rung 3 (tagged 1, inferred 3, hypotheses 1, inferred only, first count) -> already done after attempt 3:');
  expect(r.notes[0]).toEndWith("[HYPOTHESES_REQUIRED RESEARCH_DONE REPEAT_SUSPECT]");
  expect(sent(world)).toEqual([]);
});

test("owner-check reads every report since the last check, not only the newest six (challenge, gpt-6-astra)", async () => {
  writeFileSync(join(state.dir, "brief.md"), "# \ube0c\ub9ac\ud504\n\ud615: \"\ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0\"");
  const reports = Array.from({ length: 9 }, (_, i) => sessionLine(10 + i, "assistant", `[REPORT] rl-e7 | milestone | \uc9c4\ud589 ${i}: ${i === 0 ? "\ud559\uc2b5\uc744 \uba48\ucda4" : "\uc815\uc0c1 \uc9c4\ud589"}`));
  const file = writeSession([sessionLine(1, "assistant", "[REPORT] rl-e7 | milestone | \uc2dc\uc791"), ...reports]);
  const prompts: string[] = [];
  const base = fakeRunner(world);
  const run: Runner = async (argv, opts) => {
    if (argv[0] !== "omo") return base(argv, opts);
    prompts.push(argv.at(-1) ?? "");
    return { code: 0, out: "VERDICT: OK", err: "" };
  };
  const explore = { ...defaultConfig("/home/test").explore, modelsCommand: [] };
  const deps = { ...depsFor(world, fakeClock(T0 + 60 * 60_000), state.dir, { sessionsDir: join(state.dir, "sessions"), explore }), run };
  const checked = { ...lane(state.dir), ownerCheck: { at: at(5), lastReportAt: at(1), day: at(0).slice(0, 10), today: 1, model: "m", kinds: ["OK"] } };
  await deps.registry.write(checked);
  const r = await runOwnerCheck(deps, checked, { files: [file] });
  expect(r.lines[0]).toContain("OWNER_CHECK rl-e7 OK 9 recent reports");
  expect(prompts[0]).toContain("\uc9c4\ud589 0: \ud559\uc2b5\uc744 \uba48\ucda4");
});

test("reports are read once each, from the lane's typing and the lead's copy, without template leftovers", async () => {
  const file = writeSession([
    sessionLine(1, "assistant", "[REPORT] rl-e7 | milestone | \uc9c4\ud589(09:01 KST): \uad50\ucc29 9 FAIL"),
    sessionLine(2, "user", "[REPORT] rl-e7 | milestone | \uc9c4\ud589(09:02 KST): \uad50\ucc29 9 FAIL"),
    sessionLine(3, "assistant", "[REPORT] rl-e7 | milestone | \uc9c4\ud589(${kst()}): \uad50\ucc29 9 FAIL"),
    sessionLine(4, "assistant", "[REPORT] rl-e7 | milestone | <what, with links>"),
  ]);
  expect((await readReports([file], "rl-e7")).map((r) => r.at)).toEqual([at(1)]);
  // two reports in Korean only, each starting with 진행, are two reports (Hangul is not a separator)
  const korean = writeSession([sessionLine(5, "assistant", "[REPORT] rl-e7 | milestone | 진행: 학습 멈춤, 선택 기다림"), sessionLine(6, "assistant", "[REPORT] rl-e7 | milestone | 진행: 학습 다시 시작")]);
  expect((await readReports([korean], "rl-e7")).map((r) => r.at)).toEqual([at(5), at(6)]);
});

const VIOLATION = 'VERDICT: VIOLATION\nOWNER: "\ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0"\nREPORT: "\ud559\uc2b5\uc744 \uba48\ucd94\uace0 \ube44\uad50\ud45c\ub97c \ub9cc\ub4e6"\nWHY: the owner said keep training running.';

test("an owner-check reply is parsed in its fixed format, and a quote not in the inputs is marked unverified", () => {
  const owner = "[LEAD] \ud615 \uc9c8\ubb38(\uc6d0\ubb38 https://discord.com/channels/1/2/3): \ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0 \ube44\uad50\ud45c\ub97c \ub9cc\ub4e4\uc5b4\ub77c";
  const reports = "\uc9c4\ud589: \ud559\uc2b5\uc744 \uba48\ucd94\uace0 \ube44\uad50\ud45c\ub97c \ub9cc\ub4e6";
  expect(parseOwnerReply(VIOLATION, owner, reports)).toEqual([{ kind: "VIOLATION", owner: "\ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0", report: "\ud559\uc2b5\uc744 \uba48\ucd94\uace0 \ube44\uad50\ud45c\ub97c \ub9cc\ub4e6", why: "the owner said keep training running.", verified: true }]);
  expect(parseOwnerReply(VIOLATION, owner, "\ub2e4\ub978 \ubcf4\uace0")?.[0]?.verified).toBe(false);
  expect(parseOwnerReply("VERDICT: OK", owner, reports)).toEqual([]);
  expect(parseOwnerReply("I would need to read the files first.", owner, reports)).toBeUndefined();
  expect(quoted("\ud559\uc2b5\uc740 \uba48\ucd94\uc9c0\u2026\ube44\uad50\ud45c\ub97c \ub9cc\ub4e4\uc5b4\ub77c", owner)).toBe(true);
});

test("owner-check runs only on a newer report, past the interval and under the daily limit", () => {
  const limits = { minIntervalMin: 30, maxPerDay: 2 };
  const st = { at: at(0), lastReportAt: at(0), day: at(0).slice(0, 10), today: 1, model: "m", kinds: ["OK"] };
  expect(ownerDue(undefined, undefined, T0, limits)).toBe("no report on record");
  expect(ownerDue(st, at(0), T0 + 60 * 60_000, limits)).toContain("no new report");
  expect(ownerDue(st, at(5), T0 + 29 * 60_000, limits)).toContain("rate limit");
  expect(ownerDue(st, at(5), T0 + 30 * 60_000, limits)).toBeUndefined();
  expect(ownerDue({ ...st, today: 2 }, at(5), T0 + 31 * 60_000, limits)).toContain("daily limit");
});

test("owner-check asks a reviewer of another family from the one reviewers list, ownerCheck.first in front, and skips the next run until a new report", async () => {
  writeFileSync(join(state.dir, "brief.md"), "# \ube0c\ub9ac\ud504\n\ud615: \"\ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0 \ube44\uad50\ud45c\ub97c \ub9cc\ub4e4\uc5b4\ub77c\"\n\n## Past signals (written by dori launch)\n- \uc9c0\ub09c lane \uae30\ub85d");
  const file = writeSession([sessionLine(1, "assistant", "[REPORT] rl-e7 | milestone | \uc9c4\ud589: \ud559\uc2b5\uc744 \uba48\ucd94\uace0 \ube44\uad50\ud45c\ub97c \ub9cc\ub4e6"), sessionLine(2, "user", "[LEAD] \ud615 \uc9c0\uc2dc(\uc6d0\ubb38 https://discord.com/channels/1/2/3): \ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0")]);
  const asked: string[][] = [];
  const base = fakeRunner(world);
  const run: Runner = async (argv, opts) => {
    if (argv[0] !== "omo") return base(argv, opts);
    asked.push([...argv]);
    const model = argv[argv.indexOf("--model") + 1] ?? "";
    return model.includes("6.1-sol") ? { code: 1, out: "", err: "error: rate limited" } : { code: 0, out: VIOLATION, err: "" };
  };
  const config = { ...defaultConfig("/home/test"), explore: { ...defaultConfig("/home/test").explore, modelsCommand: [] } };
  const deps = { ...depsFor(world, fakeClock(T0 + 10 * 60_000), state.dir, { sessionsDir: join(state.dir, "sessions"), explore: config.explore }), run };
  await deps.registry.write(lane(state.dir));
  const r = await runOwnerCheck(deps, lane(state.dir), { files: [file] });
  expect(asked.map((a) => a[a.indexOf("--model") + 1])).toEqual(["chatgpt-subscription/gpt-6.1-sol", "chatgpt-subscription/gpt-6-astra"]);
  const prompt = asked[1]?.at(-1) ?? "";
  expect(prompt).toContain("\ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0 \ube44\uad50\ud45c\ub97c \ub9cc\ub4e4\uc5b4\ub77c");
  expect(prompt).not.toContain("\uc9c0\ub09c lane \uae30\ub85d");
  expect(prompt).toContain("[LEAD] \ud615 \uc9c0\uc2dc(\uc6d0\ubb38 https://discord.com/channels/1/2/3)");
  expect(r.lines).toHaveLength(2);
  expect(r.lines[0]).toMatch(/^OWNER_CHECK rl-e7 VIOLATION owner "\ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0" vs report .*\[reviewer chatgpt-subscription\/gpt-6-astra\]$/);
  // the finding is the stuck ladder's context rung: one STUCK line in the log, and the lead confirms before the lane re-reads
  expect(r.lines[1]).toMatch(/^STUCK rl-e7 "@context" rung context \(VIOLATION: owner .*-> confirm the finding, then dori owner-check rl-e7 --reread .*\[OWNER_CHECK_VIOLATION\]$/);
  const log = await Bun.file(deps.config.watchLog).text();
  expect(log).toContain('stuck STUCK rl-e7 "@context" rung context');
  expect(log).not.toContain("owner-check OWNER_CHECK rl-e7 VIOLATION");
  expect(sent(world)).toEqual([]);
  const after = (await deps.registry.read("rl-e7")) as Lane;
  expect(after.ownerCheck?.kinds).toEqual(["VIOLATION"]);
  const again = await runOwnerCheck(deps, after, { files: [file], force: true });
  expect(again.skipped).toContain("OWNER_CHECK_SKIP rl-e7 no new report");
  expect(asked).toHaveLength(2);
});

test("intent-check's call needs no new report; a finding again in the next check is rung 4, a clean check ends the context rung, and --reread sends the lane its brief only on a finding", async () => {
  writeFileSync(join(state.dir, "brief.md"), "# 브리프\n형: \"학습은 멈추지 말고\"");
  const file = writeSession([sessionLine(1, "assistant", "[REPORT] rl-e7 | milestone | 진행: 학습을 멈추고 비교표를 만듦")]);
  let reply = VIOLATION;
  const base = fakeRunner(world);
  const run: Runner = async (argv, opts) => (argv[0] !== "omo" ? base(argv, opts) : { code: 0, out: reply, err: "" });
  const explore = { ...defaultConfig("/home/test").explore, modelsCommand: [] };
  const clock = fakeClock(T0 + 10 * 60_000);
  const deps = { ...depsFor(world, clock, state.dir, { sessionsDir: join(state.dir, "sessions"), explore }), run };
  const l = { ...lane(state.dir), direction: { at: at(2), text: "비교표 만들기", next: "학습 재개" } };
  await deps.registry.write(l);
  expect((await sendReread(deps, l)).line).toStartWith("REREAD_REFUSED rl-e7: the last owner check found nothing");
  const first = await runOwnerCheck(deps, l, { files: [file] });
  expect(first.lines.at(-1)).toContain('"@context" rung context');
  // no new report since: a regular check skips, the intent-check call (direction) runs anyway
  expect((await runOwnerCheck(deps, (await deps.registry.read("rl-e7")) as Lane, { files: [file], force: true })).skipped).toContain("no new report");
  // the same report flagged again by the intent-check call: it was read by the first check, so it is dropped (STALE) and
  // the context rung and the finding on record stay as they were
  const second = await runOwnerCheck(deps, (await deps.registry.read("rl-e7")) as Lane, { files: [file], direction: true });
  expect(second.lines).toHaveLength(1);
  expect(second.lines[0]).toStartWith("OWNER_CHECK_STALE rl-e7 VIOLATION report");
  const reread = await sendReread(deps, (await deps.registry.read("rl-e7")) as Lane);
  expect(reread.ok).toBe(true);
  expect(sent(world)).toHaveLength(1);
  // after the confirmed re-read (minute 10) a new report (minute 15) is still off the owner's words: rung 4
  clock.at = T0 + 20 * 60_000;
  const file2 = writeSession([sessionLine(1, "assistant", "[REPORT] rl-e7 | milestone | 진행: 학습을 멈추고 비교표를 만듦"), sessionLine(15, "assistant", "[REPORT] rl-e7 | milestone | n3: 학습을 다시 멈추고 표를 고침")]);
  reply = 'VERDICT: VIOLATION\nOWNER: "학습은 멈추지 말고"\nREPORT: "학습을 다시 멈추고 표를 고침"\nWHY: still stopped.';
  const third = await runOwnerCheck(deps, (await deps.registry.read("rl-e7")) as Lane, { files: [file2], direction: true });
  expect(third.lines.at(-1)).toMatch(/^STUCK rl-e7 "@context" rung 4 \(VIOLATION: .*the owner check found the lane off the owner's words again \(2 checks in a row\).*\[OWNER_CHECK_VIOLATION ROLLOVER_DUE\]$/);
  expect(sent(world)[0]).toStartWith("[LEAD] Your last report breaks what the owner asked (VIOLATION owner");
  expect(sent(world)[0]).toContain(join(state.dir, "brief.md"));
  reply = "VERDICT: OK";
  const clean = await runOwnerCheck(deps, (await deps.registry.read("rl-e7")) as Lane, { files: [file2], direction: true });
  expect(clean.lines).toHaveLength(1);
  expect(clean.lines[0]).toStartWith("OWNER_CHECK rl-e7 OK");
  expect(((await deps.registry.read("rl-e7")) as Lane).stuck?.["@context"]).toBeUndefined();
  expect((await sendReread(deps, (await deps.registry.read("rl-e7")) as Lane)).line).toStartWith("REREAD_REFUSED rl-e7: the last owner check found nothing");
  expect(sent(world)).toHaveLength(1);
});

// hr35-e7, 2026-10-12: the relay of 10-11 21:46 quotes the owner's question, then goes on in the lead's words; the reviewer
// quoted that lead text as the owner's, against a report the owner's card Q96 ("학습 전 형 확인") had asked for
const E7_RELAY = '[LEAD] 형 질문(원문 https://discord.com/channels/1528936606264856737/1558257428561137764/1558958668404232243): "정지한 상태에서 목표 지형으로 가는 걸 학습하는 게 이렇게 어려운가? E6까지만 해도 이동을 넣었을 때 어느 정도 굴착이 잘 됐는데 이번엔 왜 진도가 안 나가는지 알려줘". 학습은 멈추지 말고, 이미 있는 기록·문서만으로(새 GPU 없이) 짧은 비교표를 만들어라';
const E7_WAIT = "진행(17:34 KST): Q96 설계 한 장 완료·보고(88328e5). 진행 중인 GPU 작업·감시 없음, 학습 없음. 다음: 형의 (가) 노출+P4 시험 학습 / (나) H8 진단 / (다) 쏟기 경로+장부 비교 선택을 기다림 — 고르시면 바로 착수.";
const E7_LINE1 = 'VERDICT: VIOLATION\nOWNER: "학습은 멈추지 말고"\nREPORT: "진행 중인 GPU 작업·감시 없음, 학습 없음."\nWHY: 학습을 멈추지 말라는 지시와 달리, 작업자는 자신이 제시한 선택지의 결정을 기다리며 학습이 중단된 상태라고 보고했다.';
const E7_LINE2 = 'VERDICT: VIOLATION\nOWNER: "학습은 멈추지 말고"\nREPORT: "진행 중인 GPU 작업·감시 없음, 학습 없음. 다음: 형의 (가) 노출+P4 시험 학습 / (나) H8 진단 / (다) 쏟기 경로+장부 비교 선택을 기다림 — 고르시면 바로 착수."\nWHY: 학습을 멈추지 말라는 지시와 달리, 학습 없이 선택을 기다리고 있다고 보고했다.';

const ownerCheckDeps = (minute: number, reply: string, prompts: string[]) => {
  const base = fakeRunner(world);
  const run: Runner = async (argv, opts) => {
    if (argv[0] !== "omo") return base(argv, opts);
    prompts.push(argv.at(-1) ?? "");
    return { code: 0, out: reply, err: "" };
  };
  const explore = { ...defaultConfig("/home/test").explore, modelsCommand: [] };
  return { ...depsFor(world, fakeClock(T0 + minute * 60_000), state.dir, { sessionsDir: join(state.dir, "sessions"), explore }), run };
};

test("replay hr35-e7 09:46:57Z: an owner quote that is only the lead's words around a relayed quote is dropped as OWNER_CHECK_UNGROUNDED, no rung, and the reviewer gets the owner's later card answer", async () => {
  writeFileSync(join(state.dir, "brief.md"), "# HR35 E7\n\"정지된 상태에서 작업을 잘 한 후에 이동하는 거를 한번 만들어 보자\"");
  const file = writeSession([sessionLine(10, "user", E7_RELAY), sessionLine(30, "assistant", `[REPORT] rl-e7 | milestone | ${E7_WAIT}`)]);
  const inbox = join(state.dir, "inbox.jsonl");
  writeFileSync(inbox, [
    { ts: "2026-10-10T00:20:00.123000+00:00", kind: "answer", qid: "Q96", answer: "두 처방 접고, \"관절 한계로 미는 교착\"을 겨냥한 처방을 설계(학습 전 형 확인) (추천)", question: "E7 다음 방향 어떻게 할까?", thread: "1558257428561137764" },
    { ts: "2026-10-10T00:21:00.000000+00:00", channel_id: "1558257428561137764", author_id: "owner-1", content: "설계 먼저 보여줘" },
    { ts: "2026-10-10T00:22:00.000000+00:00", channel_id: "1558257428561137764", author_id: "bot-2", content: "봇 메시지" },
  ].map((e) => JSON.stringify(e)).join("\n"));
  const prompts: string[] = [];
  const deps = ownerCheckDeps(40, E7_LINE1, prompts);
  // on record: the live 09:46 finding (the fake quote), from a check before this report
  const l: Lane = { ...lane(state.dir), thread: "discord:1558257428561137764", ownerCheck: { at: at(5), lastReportAt: at(1), day: at(5).slice(0, 10), today: 1, model: "m", kinds: ["VIOLATION"], finding: 'OWNER_CHECK rl-e7 VIOLATION owner "학습은 멈추지 말고" vs report "진행 중인 GPU 작업·감시 없음, 학습 없음.": ... [reviewer m]' } };
  await deps.registry.write(l);
  // another lane in the same cwd got a relay that quotes the phrase: not this lane's
  const other = join(file, "..", "2026-10-10T00-00-00-000Z_11111111-1111-1111-1111-111111111111.jsonl");
  writeFileSync(other, `${sessionLine(12, "user", '[LEAD] 형 원문 https://discord.com/channels/1/2/3: "학습은 멈추지 말고 계속 돌려"')}\n${sessionLine(13, "assistant", "[REPORT] rl-other | milestone | 진행")}\n`);
  const r = await runOwnerCheck(deps, l, { files: [file, other], inbox, owner: "owner-1" });
  expect(r.lines).toHaveLength(1);
  expect(r.lines[0]).toStartWith('OWNER_CHECK_UNGROUNDED rl-e7 VIOLATION owner "학습은 멈추지 말고"');
  expect(r.findings).toEqual([]);
  const log = await Bun.file(deps.config.watchLog).text();
  expect(log).toContain("owner-check OWNER_CHECK_UNGROUNDED rl-e7");
  expect(log).not.toContain("STUCK");
  const after = (await deps.registry.read("rl-e7")) as Lane;
  expect(after.stuck?.["@context"]).toBeUndefined();
  // the earlier finding rests on the same fake quote: it is not kept as pending, so no re-read can deliver it
  expect(after.ownerCheck?.kinds).toEqual(["OK"]);
  expect((await sendReread(deps, after)).line).toStartWith("REREAD_REFUSED rl-e7");
  // the owner's own decisions in the lane's thread, dated, and only the owner's
  expect(prompts[0]).toContain("[2026-10-10T00:20:00.123Z] card Q96");
  expect(prompts[0]).toContain("(학습 전 형 확인)");
  expect(prompts[0]).toContain("[2026-10-10T00:21:00.000Z] 설계 먼저 보여줘");
  expect(prompts[0]).not.toContain("봇 메시지");
  // the owner's words inside the relay's quote still ground a finding
  const quotedOwner = await runOwnerCheck(ownerCheckDeps(41, E7_LINE1.replace("학습은 멈추지 말고", "왜 진도가 안 나가는지 알려줘"), []), { ...l, ownerCheck: undefined }, { files: [file], inbox, owner: "owner-1" });
  expect(quotedOwner.findings.map((f) => f.verified)).toEqual([true]);
});

test("replay pingpong-false-point 2026-11-01T09:50:30Z: a finding on the owner's eight steps in the brief stands; a line in parentheses under a step is the lead's and is OWNER_CHECK_UNGROUNDED", async () => {
  writeFileSync(join(state.dir, "brief.md"), `ulw\n\n[목표] 헛점 판정\n\n${await eightSteps()}\n`);
  const file = writeSession([sessionLine(30, "assistant", "[REPORT] rl-e7 | question | 기준점을 A로 할지 B로 할지 골라 주세요")]);
  const reply = (owner: string) => `VERDICT: VIOLATION\nOWNER: "${owner}"\nREPORT: "기준점을 A로 할지 B로 할지 골라 주세요"\nWHY: 미리 허가한 계획 선택을 다시 물었다.`;
  const step = await runOwnerCheck(ownerCheckDeps(40, reply("plan approval은 모두 허가하니 더 이상 질문하지 말고 바로 진행하라."), []), lane(state.dir), { files: [file] });
  expect(step.findings.map((f) => [f.kind, f.verified])).toEqual([["VIOLATION", true]]);
  expect(step.lines.join("\n")).not.toContain("OWNER_CHECK_UNGROUNDED");
  const rule = await runOwnerCheck(ownerCheckDeps(41, reply("질문은 [넘으면 안 되는 선]을 넘어야 하거나 오너만 정할 수 있는 선택일 때만"), []), lane(state.dir), { files: [file] });
  expect(rule.findings).toEqual([]);
  expect(rule.lines[0]).toStartWith("OWNER_CHECK_UNGROUNDED rl-e7 VIOLATION");
});

test("replay hr35-e7 11:18:41Z: a finding on a report an earlier check already read is OWNER_CHECK_STALE and moves no rung, even after a confirmed re-read", async () => {
  // the owner's quote is made to hold here, so only the superseded report decides
  writeFileSync(join(state.dir, "brief.md"), "# HR35 E7\n형: \"학습은 멈추지 말고\"");
  const file = writeSession([
    sessionLine(30, "assistant", `[REPORT] rl-e7 | milestone | ${E7_WAIT}`),
    sessionLine(44, "assistant", "[REPORT] rl-e7 | milestone | Q99 n3 학습 시작(19:46 KST): 등록·코드 fb96b1c"),
    sessionLine(46, "assistant", "[REPORT] rl-e7 | milestone | Q99 n3 시작 보고(20:02 KST, 문서 0e76616)"),
  ]);
  const deps = ownerCheckDeps(80, E7_LINE2, []);
  // the 09:46 finding is the context rung, the lead confirmed a re-read, and the 10:48 check read up to the 19:46 report
  const context = { rung: 1, n: 1, at: at(32), pane: "w:p1" };
  // and the lane states, after that check, that it waits for the owner's choice (a piece of the old report; challenge, grok-4.7)
  const l: Lane = { ...lane(state.dir), direction: { at: at(49), text: "형의 선택을 기다림" }, stuck: { "@context": context }, ownerCheck: { at: at(48), lastReportAt: at(44), day: at(48).slice(0, 10), today: 13, model: "m", kinds: ["VIOLATION"], finding: "OWNER_CHECK rl-e7 VIOLATION owner ...", rereadAt: at(35) } };
  await deps.registry.write(l);
  const r = await runOwnerCheck(deps, l, { files: [file], inbox: join(state.dir, "none.jsonl") });
  expect(r.lines).toHaveLength(1);
  expect(r.lines[0]).toStartWith("OWNER_CHECK_STALE rl-e7 VIOLATION report");
  expect(r.lines.join("\n")).not.toContain("ROLLOVER_DUE");
  expect(await Bun.file(deps.config.watchLog).text()).not.toContain("STUCK");
  const after = (await deps.registry.read("rl-e7")) as Lane;
  expect(after.stuck?.["@context"]).toEqual(context);
  expect(after.ownerCheck?.lastReportAt).toBe(at(46));
});

test("a finding on the same stated direction moves the context rung once; a new direction after a confirmed re-read is rung 4", async () => {
  writeFileSync(join(state.dir, "brief.md"), "# 브리프\n형: \"학습은 멈추지 말고\"");
  const reply = 'VERDICT: VIOLATION\nOWNER: "학습은 멈추지 말고"\nREPORT: "학습을 멈추고 비교표만 만든다"\nWHY: stops training.';
  const deps = ownerCheckDeps(10, reply, []);
  const l = { ...lane(state.dir), direction: { at: at(2), text: "학습을 멈추고 비교표만 만든다" } };
  await deps.registry.write(l);
  const opts = { files: [], inbox: join(state.dir, "none.jsonl"), direction: true };
  expect((await runOwnerCheck(deps, l, opts)).lines.at(-1)).toContain('"@context" rung context');
  expect((await sendReread(deps, (await deps.registry.read("rl-e7")) as Lane)).ok).toBe(true);
  // the same direction again: the report under the finding did not change, so no rung 4
  const same = await runOwnerCheck(deps, (await deps.registry.read("rl-e7")) as Lane, opts);
  // the direction was read by the first check: stale
  expect(same.lines[0]).toStartWith("OWNER_CHECK_STALE rl-e7 VIOLATION");
  expect(same.lines.join("\n")).not.toContain("STUCK");
  expect(((await deps.registry.read("rl-e7")) as Lane).stuck?.["@context"]?.n).toBe(1);
  // restated at minute 8, before the re-read of minute 10: not evidence that the lane ignored the re-read
  const early = { ...((await deps.registry.read("rl-e7")) as Lane), direction: { at: at(8), text: "학습을 멈추고 비교표만 만든다" } };
  await deps.registry.write(early);
  expect((await runOwnerCheck(deps, early, opts)).lines.join("\n")).not.toContain("rung 4");
  // restated at minute 15, after the re-read: rung 4
  (deps.clock as ReturnType<typeof fakeClock>).at = T0 + 20 * 60_000;
  const restated = { ...((await deps.registry.read("rl-e7")) as Lane), direction: { at: at(15), text: "학습을 멈추고 비교표만 만든다" } };
  await deps.registry.write(restated);
  expect((await runOwnerCheck(deps, restated, opts)).lines.at(-1)).toMatch(/^STUCK rl-e7 "@context" rung 4 .*ROLLOVER_DUE\]$/);
});

test("only the owner's own words ground a quote, and a report quote stitched from already-read reports is stale (challenge, gpt-6-astra)", () => {
  // curly and straight single quotes are quotes too; a 1-word mark is not the owner's sentence, and text outside quote marks
  // is never his (no whole-relay fallback)
  expect(ownerWords("[LEAD] 형 원문 <link>: ‘왜 진도가 안 나가는지 알려줘’. 학습은 멈추지 말고")).toBe("왜 진도가 안 나가는지 알려줘");
  expect(ownerWords("[LEAD] 형 원문 <link>: '왜 진도가 안 나가는지 알려줘'. 학습은 멈추지 말고")).toBe("왜 진도가 안 나가는지 알려줘");
  expect(ownerWords('[LEAD] 형 원문 <link>: "표" 부터 고치고 학습은 그대로 두자')).toBe("");
  // a relay's link resolves to the owner's message in the inbox: his words even with no quote marks
  const inbox = [JSON.stringify({ id: "555", author_id: "owner-1", content: "학습은 그대로 두자" }), JSON.stringify({ id: "556", author_id: "bot-2", content: "봇이 쓴 문장 여섯 자 넘음" })].join("\n");
  expect(linkedWords("[LEAD] 원문 https://discord.com/channels/1/2/555: 학습은 그대로 두자, 그리고 표 고쳐", inbox, "owner-1")).toEqual(["학습은 그대로 두자"]);
  expect(linkedWords("[LEAD] 원문 https://discord.com/channels/1/2/556", inbox, "owner-1")).toEqual([]);
  // the launch footer is not the brief's text
  expect(briefForCheck('# b\n형: "정지 상태 작업"\n\n## Lane footer (written by dori launch)\n- Goal (owner words): "x"')).not.toContain("Lane footer");
  // the brief's prose grounds a CONTRADICTION (a fact it states), never a VIOLATION (an order the owner gave)
  const prose = [{ kind: "VIOLATION", owner: "GPU 두 대를 함께 쓴다", report: "n3 학습 시작", why: "x", verified: true }, { kind: "CONTRADICTION", owner: "GPU 두 대를 함께 쓴다", report: "n3 학습 시작", why: "x", verified: true }] as const;
  const pg = groundFindings(prose, { ownerSource: "", briefSource: "GPU 두 대를 함께 쓴다", reports: [{ at: at(30), text: "n3 학습 시작" }] });
  expect([pg.kept.map((f) => f.kind), pg.dropped.map((d) => d.why)]).toEqual([["CONTRADICTION"], ["UNGROUNDED"]]);
  // a card's question is the lead's text: only the owner's choice grounds
  const card = JSON.stringify({ ts: "2026-10-10T00:20:00.000000+00:00", kind: "answer", qid: "Q1", question: "학습을 멈추지 말고 계속할까?", answer: "아니, 먼저 설계부터", thread: "9" });
  expect(ownerDecisions(card, "discord:9", "", at(0), 8).map((d) => d.words)).toEqual(["아니, 먼저 설계부터"]);
  // two reports read by the last check (up to minute 20) and one fresh one; the quote joins a piece of each old report
  const reports = [{ at: at(10), text: "진행 중인 GPU 작업 없음" }, { at: at(20), text: "형의 선택을 기다림" }, { at: at(30), text: "n3 학습 시작" }];
  const reply = 'VERDICT: VIOLATION\nOWNER: "학습은 멈추지 말고"\nREPORT: "진행 중인 GPU 작업 없음 … 형의 선택을 기다림"\nWHY: x';
  const parsed = parseOwnerReply(reply, "학습은 멈추지 말고", reports.map((r) => r.text).join("\n")) ?? [];
  expect(parsed.map((f) => f.verified)).toEqual([true]);
  const g = groundFindings(parsed, { ownerSource: "학습은 멈추지 말고", reports, checkedUpTo: at(20) });
  expect(g.kept).toEqual([]);
  expect(g.dropped.map((d) => d.why)).toEqual(["STALE"]);
});

test("a quoted report template is no report, and a CONTRADICTION that only names claim-done with no claim on record stays off the ladder (live false alarm, 2026-10-12 00:48:02Z)", async () => {
  writeFileSync(join(state.dir, "brief.md"), "# 로컨 정리\nDone = steps 0, 7a, 6, 5, 7b done and verified");
  // the lane's goal quoted its own report template; the reader took it for a done report
  const template = "[REPORT] rl-e7 | done | ...` (KST) is sent to the lead pane via tmux send-keys argv, and `dori claim-done rl-e7 --evidence ...` ran.";
  const file = writeSession([sessionLine(1, "assistant", template), sessionLine(2, "assistant", "[REPORT] rl-e7 | milestone | 7a 완료, 남은 일: 5단계. 끝나면 dori claim-done rl-e7 --evidence ... 실행 예정")]);
  expect((await readReports([file], "rl-e7")).map((r) => r.text)).toEqual(["7a 완료, 남은 일: 5단계. 끝나면 dori claim-done rl-e7 --evidence ... 실행 예정"]);
  const reply = 'VERDICT: CONTRADICTION\nOWNER: "Done = steps 0, 7a, 6, 5, 7b done and verified"\nREPORT: "끝나면 dori claim-done rl-e7 --evidence ... 실행 예정"\nWHY: 완료를 선언했지만 직전 보고에서 5단계를 남은 작업으로 명시했다.';
  const prompts: string[] = [];
  const base = fakeRunner(world);
  const run: Runner = async (argv, opts) => {
    if (argv[0] !== "omo") return base(argv, opts);
    prompts.push(argv.at(-1) ?? "");
    return { code: 0, out: reply, err: "" };
  };
  const explore = { ...defaultConfig("/home/test").explore, modelsCommand: [] };
  const deps = { ...depsFor(world, fakeClock(T0 + 10 * 60_000), state.dir, { sessionsDir: join(state.dir, "sessions"), explore }), run };
  await deps.registry.write(lane(state.dir));
  const r = await runOwnerCheck(deps, lane(state.dir), { files: [file] });
  expect(prompts[0]).toContain("Done claim on record: none: the lane has not run dori claim-done (status working)");
  expect(prompts[0]).not.toContain("| done | ...");
  expect(r.findings[0]).toMatchObject({ kind: "CONTRADICTION", verified: false });
  expect(r.lines).toHaveLength(1);
  const log = await Bun.file(deps.config.watchLog).text();
  expect(log).toContain("owner-check OWNER_CHECK rl-e7 CONTRADICTION");
  expect(log).toContain("[no done claim is on record; the quote only names the claim-done command]");
  expect(log).not.toContain("STUCK");
  expect(((await deps.registry.read("rl-e7")) as Lane).stuck).toBeUndefined();
  // with a claim on record the same finding stands
  const claimed = { claim: { at: at(3), evidence: "merged o/r#1" } };
  expect(claimCheck({ kind: "CONTRADICTION", owner: "x", report: "dori claim-done rl-e7 ran", why: "w", verified: true }, claimed).verified).toBe(true);
  expect(claimCheck({ kind: "CONTRADICTION", owner: "x", report: "dori claim-done rl-e7 ran", why: "w", verified: true }, {}).verified).toBe(false);
});

test("a PASS in a report lowers a tagged-only metric's rung, and clears an --improved baseline (challenge, gpt-6-astra)", async () => {
  const deps = depsFor(world, fakeClock(T0 + 220 * 60_000), state.dir, { sessionsDir: join(state.dir, "sessions"), explore: { ...defaultConfig("/home/test").explore, sendResearchToLane: false } });
  await deps.registry.write({ ...lane(state.dir), inferred: { at: at(0), counts: {}, baseline: { "\uad50\ucc29": 3 } } });
  for (let i = 0; i < 3; i++) await recordFix(deps, "rl-e7", { at: at(i), metric: "\uad50\ucc29", hypothesis: `h${i}`, via: "report" });
  expect(((await deps.registry.read("rl-e7")) as Lane).stuck?.["\uad50\ucc29"]).toMatchObject({ rung: 3, n: 3 });
  writeSession([sessionLine(200, "assistant", "[REPORT] rl-e7 | milestone | model_800 F1: \uad50\ucc29 1 PASS")]);
  world.screens["lead:p1"] = " [REPORT] rl-e7 | milestone | model_800 F1: \uad50\ucc29 1 PASS\n\n\u276f ";
  expect((await freshnessTick(deps, "/home/test")).filter((a) => a.kind === "stuck")).toEqual([]);
  const after = (await deps.registry.read("rl-e7")) as Lane;
  expect(after.stuck?.["\uad50\ucc29"]).toMatchObject({ rung: 0, n: 0 });
  expect(after.inferred?.baseline).toBeUndefined();
});

test("intent-check's direction is evidence: a finding that quotes it is verified and climbs the ladder (challenge, gpt-6-astra)", async () => {
  writeFileSync(join(state.dir, "brief.md"), "# \ube0c\ub9ac\ud504\n\ud615: \"\ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0\"");
  const reply = 'VERDICT: VIOLATION\nOWNER: "\ud559\uc2b5\uc740 \uba48\ucd94\uc9c0 \ub9d0\uace0"\nREPORT: "\ud559\uc2b5\uc744 \uba48\ucd94\uace0 \ube44\uad50\ud45c\ub9cc \ub9cc\ub4e0\ub2e4"\nWHY: the owner said keep training.';
  const base = fakeRunner(world);
  const run: Runner = async (argv, opts) => (argv[0] !== "omo" ? base(argv, opts) : { code: 0, out: reply, err: "" });
  const explore = { ...defaultConfig("/home/test").explore, modelsCommand: [] };
  const deps = { ...depsFor(world, fakeClock(T0 + 10 * 60_000), state.dir, { sessionsDir: join(state.dir, "sessions"), explore }), run };
  const l = { ...lane(state.dir), direction: { at: at(1), text: "\ud559\uc2b5\uc744 \uba48\ucd94\uace0 \ube44\uad50\ud45c\ub9cc \ub9cc\ub4e0\ub2e4", next: "\ud45c \uc815\ub9ac" } };
  await deps.registry.write(l);
  const r = await runOwnerCheck(deps, l, { files: [], direction: true });
  expect(r.findings[0]?.verified).toBe(true);
  expect(r.lines.at(-1)).toContain('"@context" rung context');
});

test("a report is read only where one is sent or received: a template in a goal's arguments or in the agent's own text is none (challenge, grok-4.7)", async () => {
  const goalCall = JSON.stringify({ type: "message", timestamp: at(1), message: { role: "assistant", content: [{ type: "toolCall", name: "create_goal", arguments: { objective: "stop when [REPORT] rl-e7 | done | merged, claim-done ran" } }] } });
  const ownText = JSON.stringify({ type: "message", timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: "I will send [REPORT] rl-e7 | done | all checks green" }] } });
  const typed = JSON.stringify({ type: "message", timestamp: at(3), message: { role: "assistant", content: [{ type: "toolCall", name: "eval", arguments: { code: 'await run(["dori","type","lead","--text","[REPORT] rl-e7 | milestone | step 2 done"])' } }] } });
  const file = writeSession([goalCall, ownText, typed, sessionLine(4, "user", "[REPORT] rl-e7 | milestone | lead copy of step 3")]);
  expect((await readReports([file], "rl-e7")).map((r) => r.text)).toEqual(['step 2 done"])', "lead copy of step 3"].map((t) => t.replace(/"\]\)$/, "")));
});

test("a condition name is no metric, and a failure investigated by hypothesis discrimination is no repeat (live false alarm REPEAT_SUSPECT hr35-e7 \"양토\" 3, 2026-10-12 01:05:19Z)", async () => {
  const chain = (await Bun.file(join(import.meta.dir, "fixtures/hr35-e7-yangto-chain.json")).json()) as LaneEvent[];
  const state = inferRepeats(chain, cfg);
  expect([...state.counts.keys()]).not.toContain("\uc591\ud1a0");
  expect(failedMetrics("FAIL 2: \uad50\ucc29 113(\uc591\ud1a0 1.0 61\u00b7\uc591\ud1a0 0.8 33\u00b7\uc810\ud1a0 0.8 14)", cfg)).toEqual(["\uad50\ucc29"]);
  // without the condition list the old reading comes back: the soil type becomes a metric counted 3 times
  expect(inferRepeats(chain, { ...cfg, conditionWords: [], discriminationPattern: "$^" }).counts.get("\uc591\ud1a0")?.n).toBe(3);
  // a fail, then a discrimination (dori tree H1~H6), then an attempt: not a cycle; a new fail and a new attempt are
  const loop = [ev(0, "\uad50\ucc29 9 FAIL"), ev(40, "\uac00\uc124 \ud310\ubcc4(dori tree H1~H3): H1 \uae30\uac01"), ev(80, "\uc870\uc815 5: \uad50\ucc29 \ubc8c\uc810")];
  expect(inferRepeats(loop, cfg).counts.size).toBe(0);
  expect(inferRepeats([...loop, ev(120, "\uad50\ucc29 7 FAIL"), ev(160, "\uc870\uc815 6: \uad50\ucc29 \ubc8c\uc810")], cfg).counts.get("\uad50\ucc29")?.n).toBe(1);
});

test("replay hr35-e7 2026-10-11..12: a discrimination that prescribes again in the same report is an attempt, so the owner-confirmed 정지 loop is caught; the registered probes X1'-X5 that made no new attempt stay exempt (feature-verify 2026-10-12, defect 1)", async () => {
  const chain = (await Bun.file(join(import.meta.dir, "fixtures/hr35-e7-hold-chain.json")).json()) as LaneEvent[];
  const aliases = { "\uad50\ucc29": ["deadlock", "deadlocks"], "\uc815\uc9c0": ["\ubb34\uc791\uc5c5", "\uba48\ucda4", "hold", "idle"] };
  const fired = (c: typeof cfg): string[] => {
    const out: string[] = [];
    inferRepeats(chain, c, (r, e) => r.n >= 3 && out.push(`${e.at.slice(0, 16)} ${r.metric} ${r.n}`));
    return out;
  };
  expect(fired({ ...cfg, aliases })).toEqual(["2026-10-11T20:53 \uc815\uc9c0 3"]);
  // the X-probe reports are what keeps the design report after them from counting
  expect(fired({ ...cfg, aliases, discriminationPattern: "$^" })).toContain("2026-10-12T08:13 \uc815\uc9c0 4");
  // "\ucc98\ubc29\uc548 \ud55c \uc7a5 \ud655\uc815" is a prescription; "\ucc98\ubc29 \uc548 \ub744\uc6c0" says none is made
  expect(inferRepeats([ev(0, "\uc815\uc9c0 9 FAIL"), ev(40, "\ucc98\ubc29\uc548 \ud55c \uc7a5 \ud655\uc815: \uc815\uc9c0 \ubc8c\uc810")], cfg).counts.get("\uc815\uc9c0")?.n).toBe(1);
  expect(inferRepeats([ev(0, "\uc815\uc9c0 9 FAIL"), ev(40, "\uc815\uc9c0 \ubc8c\uc810 \ucc98\ubc29 \uc548 \ub744\uc6c0")], cfg).counts.size).toBe(0);
});

// spark-oss-4eae, 2026-10-20 12:30:06Z (T0 stands for 12:00Z): three lanes share the GPU thread, and the owner's answer to
// the lead about jev-local's search (relayed to jev-local) was read as spark-oss-4eae's new goal: GOAL_LOSS, the context rung
const GPU = "1561963113488842792";
const GPU_LINK = "https://discord.com/channels/1528936606264856737/" + GPU + "/";
const JEV_WORDS = "그래 좋아. 로컬에서 볼 수 있는 오픈소스 JEV-like 모델이 있었던 것 같으니까 그거 한번 찾아봐.";
const SPARK_REPORT = "목표 연결: 형 질문 그거 성능이 낮은거 아니야에 같은 시험 숫자로 답하려는 단계";
const SPARK_GOAL_LOSS = 'VERDICT: GOAL_LOSS\nOWNER: "' + JEV_WORDS + '"\nREPORT: "' + SPARK_REPORT + '"\nWHY: 오너가 최신 지시에서 로컬 오픈소스 JEV-like 모델 탐색으로 목적을 바꿨다.';
const gpuLane = (key: string, openMin: number, pane: string): Lane => {
  writeFileSync(join(state.dir, key + ".md"), "# " + key);
  return { key, title: key, thread: "discord:" + GPU, pane, brief: join(state.dir, key + ".md"), done: "x", cwd: "/repo", openedAt: at(openMin), model: "anthropic/claude-opus-5-5" };
};
const gpuSession = (name: string, lines: readonly string[]): string => {
  const dir = sessionDirFor(join(state.dir, "sessions"), "/repo");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "2026-10-10T00-00-00-000Z_" + name + ".jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
};
const gpuInbox = (extra: readonly object[] = []): string => {
  const file = join(state.dir, "gpu-inbox.jsonl");
  writeFileSync(file, [
    { ts: "2026-10-10T00:25:41.029000+00:00", id: "1562079358212907050", channel_id: GPU, author_id: "owner-1", reply_to: "1562078865881436201", content: "근데 내 원래 목적은 제브와 같이 지금 토큰 생성하는 LLM 말고 제브 같은 모델 중에 로컬 모델이 있는지 확인하고 그걸 쓰기를 원한 거였는데 그거는 결과는 없어?" },
    { ts: "2026-10-10T00:28:07.312000+00:00", id: "1562079971768279060", channel_id: GPU, author_id: "owner-1", reply_to: "1562079526840700932", content: JEV_WORDS },
    ...extra,
  ].map((e) => JSON.stringify(e)).join("\n"));
  return file;
};

test("replay spark-oss-4eae 2026-10-20 12:30:06Z: in a thread three lanes share, the owner's answer relayed to jev-local is not spark-oss-4eae's goal (OWNER_CHECK_SHARED, no rung); before any relay it is tied to no lane, and still not raised", async () => {
  const spark = gpuLane("spark-oss-4eae", 25, "aoe_spark");
  const sparkFile = gpuSession("spark", [sessionLine(29.9, "assistant", "[REPORT] spark-oss-4eae | milestone | " + SPARK_REPORT)]);
  const jevFile = gpuSession("jev", [sessionLine(27, "assistant", "[REPORT] jev-local | milestone | 시작"), sessionLine(29.3, "user", "[LEAD] 형 추가(음성 " + GPU_LINK + "1562079971768279060): '" + JEV_WORDS + "' 그걸 1순위로 찾아 줘.")]);
  const prompts: string[] = [];
  const deps = ownerCheckDeps(30, SPARK_GOAL_LOSS, prompts);
  for (const l of [spark, gpuLane("jev-local", 26.7, "aoe_jev"), gpuLane("moodori-shadow-judge", 19.5, "aoe_moodori")]) await deps.registry.write(l);
  const opts = { files: [sparkFile, jevFile], inbox: gpuInbox(), owner: "owner-1", cards: join(state.dir, "no-cards.json") };
  const r = await runOwnerCheck(deps, spark, opts);
  expect(r.findings).toEqual([]);
  expect(r.lines).toHaveLength(1);
  expect(r.lines[0]).toMatch(/^OWNER_CHECK_SHARED spark-oss-4eae GOAL_LOSS owner "그래 좋아\. .*" is the owner's message in a thread other lanes share, message 1562079971768279060 at 2026-10-10T00:28:07\.312Z: for another lane \(the lead relayed it to jev-local\); not this lane's instruction, dropped, no rung \[reviewer /);
  // the message for jev-local is left out; the one tied to no lane is context only, never a decision of this lane
  expect(prompts[0]).not.toContain("JEV-like 모델이 있었던");
  expect(prompts[0]).toMatch(/<<<OWNER DECISIONS[^\n]*\n\(none\)\nOWNER DECISIONS>>>\n<<<SHARED THREAD[^\n]*\n\[2026-10-10T00:25:41\.029Z\] 근데 내 원래 목적은/);
  const log = await Bun.file(deps.config.watchLog).text();
  expect(log).toContain("owner-check OWNER_CHECK_SHARED spark-oss-4eae GOAL_LOSS");
  expect(log).not.toContain("STUCK");
  const after = (await deps.registry.read("spark-oss-4eae")) as Lane;
  expect(after.stuck?.["@context"]).toBeUndefined();
  expect(after.ownerCheck?.kinds).toEqual(["OK"]);
  // at 12:28, before the lead relayed it anywhere: no sign it is for spark-oss-4eae while two other lanes have the thread open
  const early = await runOwnerCheck(ownerCheckDeps(31, SPARK_GOAL_LOSS, []), spark, { ...opts, files: [sparkFile] });
  expect(early.findings).toEqual([]);
  expect(early.lines[0]).toStartWith("OWNER_CHECK_SHARED spark-oss-4eae GOAL_LOSS");
  expect(early.lines[0]).toContain("not tied to this lane (no sign it is for this lane; other lanes open in the thread: ");
  expect(early.lines[0]).toContain("jev-local");
  expect(early.lines[0]).toContain("moodori-shadow-judge");
});

test("in a shared thread the owner's real redirect still counts: his reply to the lane's own post is its decision and the finding climbs the ladder; a relay to it, its card, its key name or an empty thread tie a message to it too", async () => {
  const STOP = "gpt-oss 비교는 그만하고 지금까지 숫자만 정리해";
  const spark = gpuLane("spark-oss-4eae", 25, "aoe_spark");
  const posted = JSON.stringify({ type: "message", timestamp: at(27.5), message: { role: "toolResult", content: [{ type: "text", text: "POSTED 1562080000000000001" }] } });
  const sparkFile = gpuSession("spark", [sessionLine(27, "assistant", "[REPORT] spark-oss-4eae | milestone | 비교 시작"), posted, sessionLine(29.9, "assistant", "[REPORT] spark-oss-4eae | milestone | gpt-oss 비교 2회차 시작")]);
  const prompts: string[] = [];
  const deps = ownerCheckDeps(30, 'VERDICT: VIOLATION\nOWNER: "' + STOP + '"\nREPORT: "gpt-oss 비교 2회차 시작"\nWHY: 형이 멈추라고 했다.', prompts);
  for (const l of [spark, gpuLane("jev-local", 26.7, "aoe_jev")]) await deps.registry.write(l);
  const inbox = gpuInbox([{ ts: "2026-10-10T00:29:00.000000+00:00", id: "1562080100000000002", channel_id: GPU, author_id: "owner-1", reply_to: "1562080000000000001", content: STOP }]);
  const r = await runOwnerCheck(deps, spark, { files: [sparkFile], inbox, owner: "owner-1", cards: join(state.dir, "no-cards.json") });
  expect(r.findings.map((f) => [f.kind, f.verified])).toEqual([["VIOLATION", true]]);
  expect(r.lines.at(-1)).toMatch(/^STUCK spark-oss-4eae "@context" rung context \(VIOLATION: /);
  expect(prompts[0]).toContain(STOP + " (for this lane: a reply to this lane's post)");
  const me = { key: "spark-oss-4eae", openedAt: at(25), pane: "aoe_spark", posts: new Set(["p1"]), relayed: new Set(["m1"]) };
  const jev = { key: "jev-local", openedAt: at(26), pane: "aoe_jev", posts: new Set(["p2"]), relayed: new Set(["m1", "m9"]) };
  const d = (id: string, extra: object = {}) => ({ at: at(28), text: "x", words: "x", id, ...extra });
  const tied = tieDecisions([d("m1"), d("m2", { pane: "aoe_spark" }), d("m3", { replyTo: "p2" }), d("m4", { replyTo: "p1", pane: "aoe_jev" }), d("m5"), { ...d("m6"), at: at(25.5) }, d("m7", { words: "spark-oss-4eae 결과 줘" }), d("m9")], me, [jev]);
  expect(tied.map((t) => t.to)).toEqual(["lane", "lane", "other", "unknown", "unknown", "lane", "lane", "other"]);
});

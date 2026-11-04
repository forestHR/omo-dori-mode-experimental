import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { eightSteps, launchLane, renderBrief, uiSteps } from "../src/launch.ts";
import { run } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const fields = "ulw\n\n[목표] 로그인 고침\n[끝난 상태] x\n[사용자와 장면] y\n[넘으면 안 되는 선] 없음\n\n위치: ~/app\n";
const briefFile = async (text: string) => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, text);
  return brief;
};
const input = (brief: string, ui?: boolean) => ({ key: "eight", title: "t", brief, done: 'command ["bun","test"]', cwd: "/work/app", goal: "g", noThread: "test lane", ...(ui ? { ui } : {}) });
const count = (text: string, s: string) => text.split(s).length - 1;

test("a brief without the eight steps gets the block from references/sessions.md after the four fields, once; a brief with them is left alone", async () => {
  const steps = await eightSteps();
  expect(steps.startsWith("1. 조사: 결정을 위한 정보를 ulw explore로 모두 수집하라.")).toBe(true);
  expect(steps.split("\n").at(-1)).toBe("8. 보고: [끝난 상태]와 QA 항목마다 증거(캡처, 출력, 파일 경로)를 붙여라.");
  const deps = depsFor(world, fakeClock(Date.parse("2026-10-16T05:00:00Z")), state.dir);
  const added = await renderBrief(deps, input(await briefFile(fields)));
  expect(added.text.startsWith(`ulw\n\n[목표] 로그인 고침\n[끝난 상태] x\n[사용자와 장면] y\n[넘으면 안 되는 선] 없음\n\n${steps}\n\n위치: ~/app\n`)).toBe(true);
  expect(added.steps).toContain("LAUNCH_STEPS_ADDED eight:");
  const full = await renderBrief(deps, input(await briefFile(added.text)));
  expect(count(full.text, "1. 조사:")).toBe(1);
  expect(full.steps).toBeUndefined();
  const noFields = await renderBrief(deps, input(await briefFile("ulw\n\nfix it\n")));
  expect(noFields.text.startsWith(`ulw\n\n${steps}\n\nfix it\n`)).toBe(true);
  // a real launch prints the line, writes it to the watch log and leaves the steps in the brief file the lane reads
  const warned: string[] = [];
  const brief = await briefFile(fields);
  const aoe = depsFor(world, fakeClock(Date.parse("2026-10-16T05:00:00Z")), state.dir, { backend: "aoe", leadPane: "aoe_Dori_0a1b2c3d" });
  await launchLane(aoe, input(brief), (l) => warned.push(l));
  expect(warned.filter((l) => l.startsWith("LAUNCH_STEPS_ADDED eight:"))).toHaveLength(1);
  expect(await Bun.file(aoe.config.watchLog).text()).toMatch(/^\S+ launch LAUNCH_STEPS_ADDED eight:/m);
  expect(count(await Bun.file(brief).text(), steps)).toBe(1);
});

test("a brief with only some of the steps is an edited frame: nothing added, LAUNCH_STEPS_PARTIAL names the missing ones", async () => {
  const deps = depsFor(world, fakeClock(Date.parse("2026-10-16T05:00:00Z")), state.dir);
  const edited = `${fields}\n1. 조사: 로그만 본다.\n8. 보고: 캡처를 붙여라.\n`;
  const r = await renderBrief(deps, input(await briefFile(edited)));
  expect(r.text.startsWith(edited.trimEnd())).toBe(true);
  expect(count(r.text, "2. 이상적인 상태:")).toBe(0);
  expect(r.steps).toContain("LAUNCH_STEPS_PARTIAL eight: the brief has only some of the owner's eight steps (missing 2, 3, 4, 5, 6, 7)");
});

test("dori launch --dry-run --ui orders ulw, the UI steps, the four fields, then the eight steps, and prints LAUNCH_STEPS_ADDED", async () => {
  const config = join(state.dir, "config.json");
  await Bun.write(config, JSON.stringify({ stateDir: state.dir, watchLog: join(state.dir, "watch.log"), defaultCwd: "/home/test", directives: { pickModel: "" } }));
  const brief = await briefFile(fields);
  const r = await run(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`, "bun", join(import.meta.dir, "../src/cli.ts"), "launch", "eight", "--title", "t", "--brief", brief, "--done", 'command ["bun","test"]', "--goal", "g", "--no-thread", "test lane", "--dry-run", "--ui"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("LAUNCH_STEPS_ADDED eight:");
  expect(r.out).toContain(`ulw\n\n${await uiSteps()}\n\n[목표] 로그인 고침\n[끝난 상태] x\n[사용자와 장면] y\n[넘으면 안 되는 선] 없음\n\n${await eightSteps()}\n\n위치: ~/app\n`);
  expect(await Bun.file(brief).text()).toBe(fields);
});

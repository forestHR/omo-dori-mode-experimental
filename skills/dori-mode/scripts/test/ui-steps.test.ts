import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { eightSteps, renderBrief, uiSteps, uiWarning } from "../src/launch.ts";
import { run } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const lead = "ulw\n\n[목표] 대시보드 화면을 고친다\n[끝난 상태] x\n";
const briefFile = async (text: string) => {
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, text);
  return brief;
};
const input = (brief: string, ui?: boolean) => ({ key: "pmd-ui", title: "ui", brief, done: 'command ["bun","test"]', cwd: "/work/app", goal: "UI", ...(ui ? { ui } : {}) });

test("--ui puts the seven steps from references/ui-work.md right after the ulw line, once; without it the brief is the lead's text", async () => {
  const steps = await uiSteps();
  expect(steps.startsWith("[UI 지침]\n1) Apple HIG(https://developer.apple.com/design/human-interface-guidelines)")).toBe(true);
  expect(steps).toContain("7) 이후 형에게 묻지 않고 mass ulw loop + ulw execute로");
  const deps = depsFor(world, fakeClock(Date.parse("2026-10-16T05:00:00Z")), state.dir);
  const brief = await briefFile(lead);
  const on = (await renderBrief(deps, input(brief, true))).text;
  expect(on.startsWith(`ulw\n\n${steps}\n\n[목표] 대시보드 화면을 고친다\n`)).toBe(true);
  expect(on.split("[UI 지침]").length).toBe(2);
  const off = (await renderBrief(deps, input(brief))).text;
  expect(off.startsWith(lead.trimEnd())).toBe(true);
  expect(off).not.toContain("[UI 지침]");
  expect(await Bun.file(brief).text()).toBe(lead);
  const again = (await renderBrief(deps, input(await briefFile(`ulw\n\n${steps}\n\n[목표] y`), true))).text;
  expect(again.split("[UI 지침]").length).toBe(2);
  const top = (await renderBrief(deps, input(await briefFile("# 대시보드 고치기\n"), true))).text;
  expect(top.startsWith(`${steps}\n\n${await eightSteps()}\n\n# 대시보드 고치기`)).toBe(true);
});

test("LAUNCH_UI_HINT warns on a brief that reads like UI work without --ui, and stays quiet otherwise", () => {
  const key = { key: "k", title: "t", brief: "/b", done: "x" };
  expect(uiWarning(key, lead)).toContain("LAUNCH_UI_HINT k:");
  expect(uiWarning(key, "Build the frontend login page and the UI for it")).toContain("LAUNCH_UI_HINT");
  expect(uiWarning({ ...key, ui: true }, lead)).toBeUndefined();
  // the brief template's QA line, a terminal screen, a lane key with a UI word, a single mention
  expect(uiWarning(key, "QA는 테스트 통과가 아니라 실제 화면·호출·출력.\nsenpi 화면 오른쪽 FILES 패널, 화면 폭")).toBeUndefined();
  expect(uiWarning(key, "Do NOT restart cytoplasm-pm-dashboard or pmd-ui-fix")).toBeUndefined();
  expect(uiWarning(key, "Found by the dashboard lane: the inbox misses mail")).toBeUndefined();
});

test("dori launch --dry-run --ui prints the brief with the steps; without --ui the directive ledger puts them in too, with LAUNCH_UI_HINT", async () => {
  const config = join(state.dir, "config.json");
  await Bun.write(config, JSON.stringify({ stateDir: state.dir, watchLog: join(state.dir, "watch.log"), defaultCwd: "/home/test", directives: { pickModel: "" } }));
  // the four fields: the ledger's four-fields directive stops a launch without them
  const brief = await briefFile(`${lead}[사용자와 장면] y\n[넘으면 안 되는 선] 없음\n`);
  const cli = (extra: string[]) =>
    run(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`, "bun", join(import.meta.dir, "../src/cli.ts"), "launch", "pmd-ui", "--title", "ui", "--brief", brief, "--done", 'command ["bun","test"]', "--goal", "UI", "--no-thread", "test lane", "--dry-run", ...extra]);
  const on = await cli(["--ui"]);
  expect(on.code).toBe(0);
  expect(on.out).toContain(`ulw\n\n${await uiSteps()}\n\n[목표]`);
  expect(on.out).not.toContain("LAUNCH_UI_HINT");
  const off = await cli([]);
  expect(off.code).toBe(0);
  expect(off.out).toContain("LAUNCH_UI_HINT pmd-ui:");
  expect(off.out).toContain("the owner's seven UI steps (references/ui-work.md, directive ui-steps) were put in");
  expect(off.out).toContain(`ulw\n\n${await uiSteps()}\n\n[목표]`);
  // --waive ui-steps keeps a brief that is not UI work as written
  const waived = await cli(["--waive", "ui-steps", "not UI work"]);
  expect(waived.code).toBe(0);
  expect(waived.out).toContain("LAUNCH_DIRECTIVE_WAIVED pmd-ui ui-steps:");
  expect(waived.out).not.toContain("[UI 지침]");
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHerdrSessions, recordHerdrSession, reviveHerdr } from "../src/herdr-sessions.ts";
import { findLead } from "../src/lead.ts";
import { leadDownTick } from "../src/lead-down.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, type World } from "./fakes.ts";

// The herdr side of the session primitives (herdr.ts): a pane id with ":" goes to herdr, a tmux name to tmux, so one Dori
// can hold lanes of both while it moves.
let world: World;
let dir: string;
beforeEach(() => {
  world = newWorld();
  dir = mkdtempSync(join(tmpdir(), "herdr-backend-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const omo = (patch = {}) => depsFor(world, fakeClock(0), dir, { backend: "herdr", ...patch });


test("a herdr lead whose agent is gone is named stopped with the session recorded for its pane, and revived in that session", async () => {
  const deps = omo({ leadPane: "w1:p1" });
  recordHerdrSession(dir, "w1:p1", { session: "11111111-2222-4333-8444-555555555555", cwd: dir, model: "m/x", at: new Date(0).toISOString() });
  world.herdrDead = ["w1:p1"];
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  expect(await findLead(deps.run, deps.config)).toBe("11111111-2222-4333-8444-555555555555 w1:p1 stopped");
  const typed: string[] = [];
  const line = await reviveHerdr(deps.run, deps.clock, deps.config, "w1:p1", "[DORI] back", async (_p, t) => (typed.push(t), true));
  expect(line).toBe("REVIVE_OK w1:p1 session 11111111-2222-4333-8444-555555555555 (prompt submitted)");
  const ran = world.calls.find((c) => c[2] === "run") ?? [];
  expect(ran.slice(0, 4)).toEqual(["herdr", "pane", "run", "w1:p1"]);
  // the checked PATH goes first (a herdr pane takes the server's environment), then the recorded session and model
  expect(ran[4]).toMatch(process.platform === "win32"
    ? /^Clear-Host; \$PSNativeCommandArgumentPassing = 'Standard'; \$env:PATH = '[^']+'; & 'omo' '--session-id' '11111111-2222-4333-8444-555555555555' '--model' 'm\/x'$/
    : /^clear && env PATH=\S+ omo --session-id 11111111-2222-4333-8444-555555555555 --model m\/x$/);
  expect(typed).toEqual(["[DORI] back"]);
  expect(await reviveHerdr(deps.run, deps.clock, deps.config, "w1:p9", "", async () => true)).toStartWith("REVIVE_FAIL w1:p9: no omo session recorded");
  expect(readHerdrSessions(dir)["w1:p1"]?.model).toBe("m/x");
});

test("a revive right after a server restart waits for herdr to spawn the pane, and an omo herdr already started again only gets the prompt", async () => {
  const deps = omo({ leadPane: "w1:p1" });
  recordHerdrSession(dir, "w1:p1", { session: "11111111-2222-4333-8444-555555555555", cwd: dir, at: new Date(0).toISOString() });
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.herdrGone = ["w1:p1"];
  const base = fakeRunner(world);
  let reads = 0;
  // pane list has it at once; process-info answers pane_not_found for the first two reads, then herdr has restored omo
  const run: Runner = async (argv, o) => {
    if (argv[2] === "process-info" && ++reads > 2) world.herdrGone = [];
    return base(argv, o);
  };
  world.screens = { "w1:p1": "omo\n────────\n❯ \n────────" };
  const typed: string[] = [];
  const line = await reviveHerdr(run, deps.clock, deps.config, "w1:p1", "[DORI] back", async (_p, t) => (typed.push(t), true));
  expect(line).toBe("REVIVE_OK w1:p1 session 11111111-2222-4333-8444-555555555555 (herdr had started it again, pid 4001) (prompt submitted)");
  expect(world.calls.some((c) => c[2] === "run")).toBe(false);
  expect(typed).toEqual(["[DORI] back"]);
});

test("a herdr lead with no record yet (just handed over) is recorded on the first live check", async () => {
  const deps = omo({ leadPane: "w1:p1", leadReviveMin: 5, sessionsDir: dir });
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/repo" }];
  world.ps = "4000 1 -bash\n4001 4000 omo --session-id 11111111-2222-4333-8444-555555555555 --model m/x";
  expect(readHerdrSessions(dir)["w1:p1"]).toBeUndefined();
  expect(await leadDownTick(deps)).toEqual([]);
  expect(readHerdrSessions(dir)["w1:p1"]).toMatchObject({ session: "11111111-2222-4333-8444-555555555555", model: "m/x" });
});

test("an unchanged herdr lead record gets its check time on each read, so the next read waits its ten minutes", async () => {
  const deps = omo({ leadPane: "w1:p1", leadReviveMin: 5, sessionsDir: dir });
  // checked 11 minutes before the (fake) clock: due again
  const old = new Date(-11 * 60_000).toISOString();
  recordHerdrSession(dir, "w1:p1", { session: "11111111-2222-4333-8444-555555555555", cwd: "/repo", model: "m/x", at: old });
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/repo" }];
  world.ps = "4000 1 -bash\n4001 4000 omo --session-id 11111111-2222-4333-8444-555555555555 --model m/x";
  await leadDownTick(deps);
  expect(readHerdrSessions(dir)["w1:p1"]?.at).not.toBe(old);
});

test("a herdr lead revived after leadReviveMin tells the owner once, as an aoe lead does", async () => {
  recordHerdrSession(dir, "w1:p1", { session: "11111111-2222-4333-8444-555555555555", cwd: dir, at: new Date(0).toISOString() });
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.herdrDead = ["w1:p1"];
  const posts: string[] = [];
  const inbox = join(dir, "inbox.jsonl");
  await Bun.write(inbox, `${JSON.stringify({ ts: new Date(0).toISOString(), author_id: "owner", channel_id: "c1", content: "hi" })}\n`);
  const at = (ms: number) => ({ ...omo({ leadPane: "w1:p1", leadReviveMin: 5 }), clock: fakeClock(ms), ownerInbox: { path: inbox, ownerId: "owner", ownerChannel: "c1" }, postOwner: async (_c: string, t: string) => (posts.push(t), "m1") });
  expect((await leadDownTick(at(0)))[0]).toStartWith("LEAD_DOWN w1:p1 no live herdr agent");
  // herdr starts omo again during the revive (its pane answers as live from the next process-info)
  const run = at(6 * 60_000).run;
  const deps = { ...at(6 * 60_000), run: async (argv: readonly string[], o?: Parameters<Runner>[1]) => { if (argv[2] === "run") world.herdrDead = []; return run(argv, o); } };
  const lines = await leadDownTick(deps);
  expect(lines[0]).toStartWith("LEAD_REVIVE_STARTED w1:p1");
  expect(lines.some((l) => l.startsWith("LEAD_DOWN_NOTICE w1:p1 POSTED"))).toBe(true);
  expect(posts).toHaveLength(1);
});

test("a revive is OK only once an agent runs and draws its own prompt: a ❯ left by the ended agent is no sign, and agentCommand's options stay", async () => {
  const deps = omo({ leadPane: "w1:p1", agentCommand: ["omo", "--session-dir", "/s", "--model", "{model}", "{prompt}"] });
  recordHerdrSession(dir, "w1:p1", { session: "11111111-2222-4333-8444-555555555555", cwd: dir, model: "m/x", at: new Date(0).toISOString() });
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.herdrDead = ["w1:p1"];
  world.screens = { "w1:p1": "❯ old prompt of the ended agent" };
  world.herdrNoStart = true;
  expect(await reviveHerdr(deps.run, deps.clock, deps.config, "w1:p1", "", async () => true)).toStartWith("REVIVE_FAIL w1:p1: no running agent with its ❯ prompt");
  world.herdrNoStart = false;
  expect(await reviveHerdr(deps.run, deps.clock, deps.config, "w1:p1", "", async () => true)).toBe("REVIVE_OK w1:p1 session 11111111-2222-4333-8444-555555555555");
  const ran = world.calls.filter((c) => c[2] === "run").at(-1)?.[4] ?? "";
  expect(ran).toMatch(process.platform === "win32"
    ? / & 'omo' '--session-id' '11111111-2222-4333-8444-555555555555' '--session-dir' '\/s' '--model' 'm\/x'$/
    : / omo --session-id 11111111-2222-4333-8444-555555555555 --session-dir \/s --model m\/x$/);
  const selector = omo({ leadPane: "w1:p1", agentCommand: ["omo", "--continue", "{prompt}"] });
  world.herdrDead = ["w1:p1"];
  expect(await reviveHerdr(selector.run, selector.clock, selector.config, "w1:p1", "", async () => true)).toStartWith("REVIVE_FAIL w1:p1: agentCommand picks its session itself");
});

test("a revived agent that runs but has not drawn omo's input box yet is not ready: an echoed command and a shell ❯ are no sign", async () => {
  const deps = omo({ leadPane: "w1:p1" });
  recordHerdrSession(dir, "w1:p1", { session: "11111111-2222-4333-8444-555555555555", cwd: dir, model: "m/x", at: new Date(0).toISOString() });
  world.panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: dir }];
  world.herdrDead = ["w1:p1"];
  world.herdrNoStart = true;
  let reads = 0;
  const base = deps.run;
  const run: Runner = async (argv, o) => {
    if (argv[2] === "run") world.herdrDead = [];
    if (argv[2] === "read" && world.herdrDead?.length === 0) world.screens["w1:p1"] = ++reads < 4 ? "user$ clear && omo --session-id 11111111-2222-4333-8444-555555555555\n❯ " : "omo\n────────\n❯ \n────────";
    return base(argv, o);
  };
  const typed: string[] = [];
  expect(await reviveHerdr(run, deps.clock, deps.config, "w1:p1", "[DORI] back", async (_p, t) => (typed.push(t), true))).toBe("REVIVE_OK w1:p1 session 11111111-2222-4333-8444-555555555555 (prompt submitted)");
  expect(reads).toBeGreaterThanOrEqual(4);
  expect(world.calls.find((c) => c[2] === "run")?.[4] ?? "").toStartWith(process.platform === "win32" ? "Clear-Host; " : "clear && ");
});

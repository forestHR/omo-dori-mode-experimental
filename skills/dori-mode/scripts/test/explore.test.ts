import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { ChallengeError, challengeMissing, checkReviewers, familyOf, REVIEWER_SYSTEM, reviewers, runChallenge } from "../src/challenge.ts";
import { defaultConfig } from "../src/config.ts";
import { mkdirSync, writeFileSync } from "node:fs";

import { addNode, formatTree, gateFix, intentView, laneArea, loadTree, metricAttempts, parseResearchStart, researchCheck, researchHint, saveTree, setStatus, type Tree } from "../src/explore.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { branchesFrom, forkExplore, parseBranch } from "../src/fork-explore.ts";
import { freshnessTick } from "../src/freshness.ts";
import { footer, renderBrief } from "../src/launch.ts";
import type { FixAttempt, Lane } from "../src/registry.ts";
import { type Ran, run, type Runner } from "../src/run.ts";
import { recordFix } from "../src/same-fix.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, sent, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const lane: Lane = { key: "rl-e7", title: "E7 dump policy", thread: "none", pane: "w:p7", brief: "/b.md", done: "merged acme/app#1", cwd: "/work/rl", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };
const fix = (hypothesis: string, extra: Partial<FixAttempt> = {}): FixAttempt => ({ at: "t", metric: "dumps", hypothesis, via: "lead", ...extra });
const three = { hypotheses: ["reward too small", "exploration collapsed", "critic undervalues post-dump states"], tests: ["double the reward", "log swing sigma", "compare V before/after dump"] };

const cli = (stateDir: string, config: string, args: string[]) =>
  run(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${stateDir}`, `DORI_ENV_FILE=${join(stateDir, "missing.env")}`, "bun", join(import.meta.dir, "../src/cli.ts"), ...args]);

test("the second fix on one metric with no improvement is refused without three hypotheses and tests, and recorded with them", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await deps.registry.write({ ...lane, pane: undefined });
  const config = join(state.dir, "config.json");
  await Bun.write(config, JSON.stringify({ stateDir: state.dir, watchLog: deps.config.watchLog, defaultCwd: "/home/test" }));
  const base = ["fix-attempt", "rl-e7", "--metric", "dumps", "--hypothesis"];
  expect((await cli(state.dir, config, [...base, "reward too small"])).code).toBe(0);
  const refused = await cli(state.dir, config, [...base, "reward still too small"]);
  expect(refused.code).toBe(5);
  expect(refused.err).toContain("HYPOTHESES_REQUIRED rl-e7 attempt 2");
  expect((await deps.registry.read("rl-e7"))?.fixes).toHaveLength(1);
  const args = three.hypotheses.flatMap((h, i) => ["--hypotheses", h, "--test", three.tests[i] ?? ""]);
  const ok = await cli(state.dir, config, [...base, "exploration collapsed", ...args]);
  expect(ok.code).toBe(0);
  expect(ok.out).toContain("STUCK_BRANCH rl-e7 attempt 2");
  expect(ok.out).toContain("FIX_RECORDED rl-e7");
  const log = await Bun.file(deps.config.watchLog).text();
  expect(log).toMatch(/fix-attempt HYPOTHESES_REQUIRED rl-e7/);
  expect(log).toMatch(/fix-attempt STUCK_BRANCH rl-e7/);
  const tree = await loadTree(state.dir, { cwd: "/work/rl" });
  expect(tree.nodes.filter((n) => n.kind === "hypothesis" && n.status === "open").map((n) => n.test)).toEqual(three.tests);
  const override = await cli(state.dir, config, [...base, "one more try", "--no-hypotheses", "owner asked for this exact patch"]);
  expect(override.code).toBe(0);
  expect(await Bun.file(deps.config.watchLog).text()).toMatch(/HYPOTHESES_OVERRIDE rl-e7 attempt 3 .*owner asked for this exact patch/);
});

test("the gate counts the ladder's own way: across hypotheses, once per lead-asked-then-reported fix, inferred cycles too, alias names, the last PASS and --improved", () => {
  const config = defaultConfig();
  const at = (fixes: FixAttempt[], extra: Partial<Lane> = {}): Lane => ({ ...lane, fixes, ...extra });
  const none = { hypotheses: [], tests: [] };
  expect(gateFix(at([]), fix("a"), none, config).verdict).toBe("ok");
  expect(gateFix(at([fix("a")]), fix("b"), none, config).verdict).toBe("required");
  expect(gateFix(at([fix("a")]), fix("b"), { hypotheses: three.hypotheses, tests: three.tests.slice(0, 2) }, config).verdict).toBe("required");
  expect(gateFix(at([fix("a")]), fix("b"), three, config).verdict).toBe("branch");
  expect(gateFix(at([fix("a")]), fix("b", { improved: true }), none, config).verdict).toBe("ok");
  expect(metricAttempts([fix("a"), fix("a", { via: "report" }), fix("b")], "dumps")).toBe(2);
  // untagged repeats count as attempts: the first lead-asked fix after two inferred cycles already needs hypotheses
  expect(gateFix(at([], { inferred: { at: "t", counts: { dumps: 2 } } }), fix("a"), none, config).verdict).toBe("required");
  expect(gateFix(at([], { inferred: { at: "t", counts: { dumps: 1 } } }), fix("a"), none, config).verdict).toBe("ok");
  // the same gate under another name counts (aliases), and a PASS the reports showed starts it again (challenge, gpt-6-astra)
  const aliased = { ...config, autoSignals: { ...config.autoSignals, aliases: { dumps: ["dump count"] } } };
  expect(gateFix(at([fix("a", { metric: "dump count" })]), fix("b"), none, aliased).verdict).toBe("required");
  expect(gateFix(at([fix("a", { at: "t1" })], { inferred: { at: "t", counts: {}, passedAt: { dumps: "t2" } } }), fix("b", { at: "t3" }), none, config).verdict).toBe("ok");
});

test("the tree keeps one entry per idea, records falsified and supported results, and a new brief carries it before the footer", async () => {
  let t: Tree = { area: "cwd /work/rl", nodes: [] };
  t = addNode(t, { kind: "hypothesis", text: "Reward too small", test: "double it", source: "x" }, "t1").tree;
  const again = addNode(t, { kind: "hypothesis", text: "reward  too small", source: "x" }, "t2");
  expect(again.added).toBe(false);
  t = addNode(again.tree, { kind: "direction", text: "curriculum on soil hardness", source: "x" }, "t2").tree;
  t = setStatus(t, "H1", "falsified", "reward x2 changed nothing", "t3").tree;
  expect(formatTree(t)).toContain("Falsified (do not retry):\n  H1 Reward too small (test: double it) -> reward x2 changed nothing");
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await saveTree(state.dir, laneArea(lane, deps.config), t);
  const brief = join(state.dir, "brief.md");
  await Bun.write(brief, "# Do the thing\n");
  const { text } = await renderBrief(deps, { key: "rl-e8", title: "e8", brief, done: 'command ["bun","test"]', cwd: "/work/rl", goal: "dump into the bank" });
  expect(text).toContain("## Hypothesis tree (written by dori launch)");
  expect(text).toContain("Untried directions: D1 curriculum on soil hardness");
  expect(text.indexOf("## Hypothesis tree")).toBeLessThan(text.indexOf("## Lane footer"));
  expect(text).toContain('Goal (owner words): "dump into the bank"');
  expect(await Bun.file(brief).text()).toBe("# Do the thing\n");
});

test("rung 3 (the third failed attempt) sends the lane an external-search step and puts it in the tree; research-hint plans the search", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await deps.registry.write(lane);
  let ruledOut: Tree = { area: "cwd /work/rl", nodes: [] };
  ruledOut = addNode(ruledOut, { kind: "hypothesis", text: "reward too small", test: "double it", metric: "dumps", source: "x" }, "t1").tree;
  await saveTree(state.dir, { cwd: "/work/rl" }, setStatus(ruledOut, "H1", "falsified", "x2 reward changed nothing", "t2").tree);
  expect((await recordFix(deps, "rl-e7", fix("a"))).notes).toEqual([]);
  expect((await recordFix(deps, "rl-e7", fix("b"))).notes[0]).toContain('"dumps" rung 2 ');
  expect(sent(world)).toEqual([]);
  const third = await recordFix(deps, "rl-e7", fix("c"));
  expect(third.notes[0]).toStartWith('STUCK rl-e7 "dumps" rung 3 (tagged 3, inferred 0, hypotheses 3) -> ulw research on the exact symptom and a dori challenge of the next plan');
  expect(third.notes[0]).toEndWith("; ulw research sent to the lane [RESEARCH_DUE]");
  // omo starts its ulw-research skill only for typed text that begins with "ulw research"; the rest is the lane's own question
  const typed = sent(world)[0] ?? "";
  expect(typed).toStartWith("ulw research ");
  for (const part of ['Exact symptom: "dumps" does not improve after 3 fix attempts', "Tried: a; b; c.", "Ruled out by a test: reward too small (x2 reward changed nothing).", "papers", "GitHub issues", "repos", "read the ulw-research SKILL.md", "dori tree add --lane rl-e7 --kind finding", "dori challenge rl-e7 --plan <file>"]) expect(typed).toContain(part);
  expect(typed).not.toContain("\n");
  expect(((await deps.registry.read("rl-e7")) as Lane).research).toEqual({ at: new Date(T0).toISOString(), sentAt: T0, probe: typed.slice(0, 80), metric: "dumps", signal: 3 });
  const tree = await loadTree(state.dir, { cwd: "/work/rl" });
  expect(tree.nodes.filter((n) => n.kind === "research").length).toBe(1);
  expect(tree.nodes.filter((n) => n.kind === "tried").map((n) => n.text)).toEqual(["a", "b", "c"]);
  const hint = researchHint((await deps.registry.read("rl-e7")) as Lane, tree);
  expect(hint[0]).toBe('RESEARCH_HINT rl-e7 on "dumps": 3 attempts, 3 hypotheses tried, 1 falsified, 0 open');
  expect(hint.some((l) => l.includes("dori tree add --lane rl-e7 --kind finding"))).toBe(true);
});

test("a paused lane at rung 3 gets nothing typed: the STUCK line says so and how to send it after resume", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await deps.registry.write({ ...lane, status: "paused" });
  await recordFix(deps, "rl-e7", fix("a"));
  await recordFix(deps, "rl-e7", fix("b"));
  const third = await recordFix(deps, "rl-e7", fix("c"));
  expect(third.notes[0]).toEndWith("; the lane is paused, so nothing was typed (after dori resume: dori research-hint rl-e7 --send) [RESEARCH_DUE]");
  expect(sent(world)).toEqual([]);
  expect(((await deps.registry.read("rl-e7")) as Lane).research).toBeUndefined();
});

// session log lines as omo writes them: the typed message, the skill pointer it attaches, the lane reading the skill
const PROBE = "ulw research Lane rl-e7 (E7 dump policy, repo rl) is stuck.";
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const userLine = (s: number, text: string) => JSON.stringify({ type: "message", id: `u${s}`, timestamp: at(s), message: { role: "user", content: [{ type: "text", text }] } });
const pointerLine = (s: number) => JSON.stringify({ type: "custom_message", customType: "omo-ulw-research:skill-pointer", content: "<omo-ulw-research-pointer>This message mentions ulw-research.</omo-ulw-research-pointer>", display: false, id: `p${s}`, timestamp: at(s) });
const readLine = (s: number) => JSON.stringify({ type: "message", id: `r${s}`, timestamp: at(s), message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/opt/omo-ai/plugin/skills/ulw-research/SKILL.md" } }] } });

test("the research check reads the lane's session log: pointer and SKILL.md read give RESEARCH_STARTED, else RESEARCH_NOT_STARTED after the limit", async () => {
  const sessions = join(state.dir, "sessions");
  const dir = sessionDirFor(sessions, "/work/rl");
  mkdirSync(dir, { recursive: true });
  const research = { at: at(0), sentAt: T0, probe: PROBE, metric: "dumps", signal: 2 };
  // a pointer from an earlier message (before the send) does not count
  const without = [pointerLine(-60), readLine(-59), userLine(1, `${PROBE} Exact symptom: dumps.`), readLine(5)].join("\n");
  const started = [userLine(1, `${PROBE} Exact symptom: dumps.`), pointerLine(1), readLine(8), '{"type":"message","timest'].join("\n");
  expect(parseResearchStart(without, PROBE, T0)).toEqual({ seen: true, pointer: false, read: true, readEarlier: true });
  expect(parseResearchStart(started, PROBE, T0)).toEqual({ seen: true, pointer: true, read: true, readEarlier: false });
  // omo appends the pointer to the typed message itself when the agent was busy
  expect(parseResearchStart(userLine(2, `${PROBE}\n<omo-ulw-research-pointer>x</omo-ulw-research-pointer>`), PROBE, T0).pointer).toBe(true);

  const clock = fakeClock(T0 + 60_000);
  const deps = depsFor(world, clock, state.dir, { sessionsDir: sessions });
  await deps.registry.write({ ...lane, research });
  writeFileSync(join(dir, "2026-01-01T12-00-00-000Z_aaaaaaaa-0000-0000-0000-000000000000.jsonl"), started);
  const acts = await freshnessTick(deps, "/home/test");
  expect(acts.filter((a) => a.kind === "research_started").map((a) => a.lane)).toEqual(["rl-e7"]);
  expect(((await deps.registry.read("rl-e7")) as Lane).research?.result).toBe("started");
  expect(await Bun.file(deps.config.watchLog).text()).toMatch(/research RESEARCH_STARTED rl-e7 failed attempt 2 on "dumps": the session log shows the omo-ulw-research:skill-pointer/);

  writeFileSync(join(dir, "2026-01-01T12-00-00-000Z_aaaaaaaa-0000-0000-0000-000000000000.jsonl"), without);
  await deps.registry.write({ ...lane, research });
  expect((await researchCheck(deps, (await deps.registry.read("rl-e7")) as Lane)).verdict).toBe("pending");
  expect(await Bun.file(deps.config.watchLog).text()).not.toContain("RESEARCH_NOT_STARTED");
  clock.at = T0 + 6 * 60_000;
  const late = await researchCheck(deps, (await deps.registry.read("rl-e7")) as Lane);
  expect(late.verdict).toBe("not-started");
  expect(late.line).toStartWith("RESEARCH_NOT_STARTED rl-e7 6 min after the ulw research text: omo attached no omo-ulw-research:skill-pointer");
  expect(await Bun.file(deps.config.watchLog).text()).toMatch(/research RESEARCH_NOT_STARTED rl-e7 /);
  expect(((await deps.registry.read("rl-e7")) as Lane).research?.result).toBe("not-started");

  // a second send in one session: the pointer comes, the lane holds the skill from before and does not read it again
  writeFileSync(join(dir, "2026-01-01T12-00-00-000Z_aaaaaaaa-0000-0000-0000-000000000000.jsonl"), [readLine(-59), pointerLine(1), userLine(1, `${PROBE} again`)].join("\n"));
  await deps.registry.write({ ...lane, research });
  const again = await researchCheck(deps, (await deps.registry.read("rl-e7")) as Lane);
  expect(again.verdict).toBe("not-started");
  expect(again.line).toContain("did not read ulw-research/SKILL.md again (it read it earlier in this session)");
});

const SKILL = "/opt/omo-ai/plugin/skills/ulw-research/SKILL.md";
const callLine = (s: number, name: string, args: Record<string, unknown>) =>
  JSON.stringify({ type: "message", id: `c${s}`, timestamp: at(s), message: { role: "assistant", content: [{ type: "toolCall", id: `t${s}`, name, arguments: args }] } });
// the eval cell a lane runs to read the skill (seen live: the path in a template literal, read with Bun.file)
const evalRead = (s: number) => callLine(s, "eval", { language: "js", code: 'const base = "/opt/omo-ai/plugin/skills";\nconst text = await Bun.file(`${base}/ulw-research/SKILL.md`).text();' });
// the live false positive: after a re-send the lane did not read the skill, it recorded a finding whose text quotes the path
const treeMention = (s: number) =>
  callLine(s, "eval", { language: "js", code: "const findings = [\"the lane's session log shows ulw-research/SKILL.md was read\"];\nfor (const text of findings) await Bun.$`dori tree add --kind finding --text ${text}`;" });

test("only a real read of ulw-research/SKILL.md counts as the skill starting, not a mention of the path", async () => {
  const after = (call: string) => parseResearchStart([userLine(1, PROBE), pointerLine(1), call].join("\n"), PROBE, T0).read;
  // reads: the read tool, an eval cell reading the file, a shell read command on the path or on a variable holding it
  expect(after(readLine(8))).toBe(true);
  expect(after(callLine(8, "read", { file_path: SKILL }))).toBe(true);
  expect(after(evalRead(8))).toBe(true);
  expect(after(callLine(8, "bash", { command: `sed -n 1,200p ${SKILL}` }))).toBe(true);
  expect(after(callLine(8, "eval", { code: `const sh = (c) => Bun.$\`bash -lc \${c}\`.text();\nawait sh('cat ${SKILL}');` }))).toBe(true);
  expect(after(callLine(8, "eval", { code: `const skill = '${SKILL}';\nconsole.log(await Bun.$\`cat \${skill}\`.text());` }))).toBe(true);
  // mentions: a finding text, an echo into notes, a memory note, a log search for the bare name, a pipe through tail
  expect(after(treeMention(8))).toBe(false);
  expect(after(callLine(8, "bash", { command: `echo "read ${SKILL} first" >> notes.md` }))).toBe(false);
  expect(after(callLine(8, "memory", { command: "create", file_text: `the lane read ${SKILL}` }))).toBe(false);
  expect(after(callLine(8, "eval", { code: 'const log = await Bun.file("s.jsonl").text();\nconsole.log(log.includes("ulw-research/SKILL.md"));' }))).toBe(false);
  expect(after(callLine(8, "bash", { command: `dori can-launch | tail -1; echo ${SKILL}` }))).toBe(false);

  const sessions = join(state.dir, "sessions");
  const dir = sessionDirFor(sessions, "/work/rl");
  mkdirSync(dir, { recursive: true });
  const deps = depsFor(world, fakeClock(T0 + 6 * 60_000), state.dir, { sessionsDir: sessions });
  const check = async (lines: string[]) => {
    writeFileSync(join(dir, "2026-01-01T11-58-00-000Z_bbbbbbbb-0000-0000-0000-000000000000.jsonl"), lines.join("\n"));
    await deps.registry.write({ ...lane, research: { at: at(0), sentAt: T0, probe: PROBE, metric: "dumps", signal: 2 } });
    return researchCheck(deps, (await deps.registry.read("rl-e7")) as Lane);
  };
  const firstSend = [pointerLine(-60), userLine(-60, `${PROBE} first`), evalRead(-50)];
  const resend = userLine(1, `${PROBE} again\n<omo-ulw-research-pointer>x</omo-ulw-research-pointer>`);
  // the re-send seen live (negB): the pointer came, the lane only quoted the path in a finding -> not started
  const negB = await check([...firstSend, resend, treeMention(60)]);
  expect(negB.verdict).toBe("not-started");
  expect(negB.line).toContain("did not read ulw-research/SKILL.md again (it read it earlier in this session)");
  // the same re-send with a real read (read tool, or eval Bun.file) -> started
  expect((await check([...firstSend, resend, readLine(60)])).verdict).toBe("started");
  expect((await check([...firstSend, resend, evalRead(60)])).verdict).toBe("started");
  // seen live: the lane, still busy with the first send, read the skill after the re-send but before the re-sent text
  // reached the session, then only quoted the path in a finding -> that read belongs to the first send
  const busy = await check([...firstSend, pointerLine(1), readLine(5), userLine(6, `${PROBE} again`), treeMention(20)]);
  expect(busy.verdict).toBe("not-started");
  expect(busy.line).toContain("it read it earlier in this session");
  // the pointer only from the earlier send: a read now does not make this send started
  const oldPointer = await check([...firstSend, userLine(1, `${PROBE} again`), evalRead(60)]);
  expect(oldPointer.verdict).toBe("not-started");
  expect(oldPointer.line).toContain("omo attached no omo-ulw-research:skill-pointer");
});

test("a lane's own unbranched second fix report is rung 2: the lead is told hypotheses come before the next patch", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await deps.registry.write(lane);
  await recordFix(deps, "rl-e7", fix("a", { via: "report" }));
  const note = (await recordFix(deps, "rl-e7", fix("b", { via: "report" }))).notes[0];
  expect(note).toStartWith('STUCK rl-e7 "dumps" rung 2 (tagged 2, inferred 0, hypotheses 2) -> branch before the next patch: 3 competing hypotheses');
  expect(note).toEndWith("[HYPOTHESES_REQUIRED]");
});

const REVIEW = "## Reasons this will fail\nx\n## Missing alternatives\ny\n## Cheapest falsifying test\nz";
const PREAMBLE = "계획 문서와 관련 파일을 확인한 뒤 세 절만 쓰겠다.";
const PLAN_REPO = "/work/plans";
const LISTED = ["provider model context", "chatgpt-subscription gpt-6-astra 600K", "chatgpt-subscription gpt-6.1-sol 400K", "anthropic-subscription claude-fable-5-1 1M", "anthropic-subscription claude-opus-5-5 1M", "xai grok-4.7 500K", "xai grok-4.6 500K", "chatgpt-subscription gpt-6-luna 400K", "github-copilot gpt-6-astra 600K", "google gemini-3.1-pro-preview 1M"].join("\n");
// what omo auth check --json said on the host the reviewers failed on (anthropic-subscription: provider_not_found, yet logged in)
const AUTH: Record<string, object> = {
  "chatgpt-subscription": { status: "ready", accounts: [{ name: "default", blocked: false }] },
  xai: { status: "ready", accounts: [{ name: "default", blocked: false }] },
  "anthropic-subscription": { status: "not_ready", reason: "provider_not_found", accounts: [{ name: "default", source: "login", blocked: false }] },
  "github-copilot": { status: "not_ready", reason: "credentials_not_configured", accounts: [] },
  google: { status: "not_ready", reason: "credentials_not_configured", accounts: [] },
};
// the model a fake reviewer was called with
const modelOf = (argv: readonly string[]): string => argv[argv.indexOf("--model") + 1] ?? "";
type Call = { readonly model: string; readonly argv: readonly string[]; readonly cwd?: string };
// A fake host: omo --list-models, omo auth check, git, and reviewers that act as the real ones did on a plan that cites
// evidence: run with no tools, the reply is only an announcement that it will read the files; with read-only tools in the
// plan's repository it reads them and writes the review. A provider that is not logged in exits 1.
const hostRunner = (calls: Call[], reviewer?: (model: string) => Ran | undefined): Runner => async (argv, opts) => {
  if (argv[0] === "git") return { code: 0, out: PLAN_REPO, err: "" };
  if (argv[1] === "--list-models") return { code: 0, out: LISTED, err: "" };
  if (argv[1] === "auth") return { code: 0, out: JSON.stringify(AUTH[argv[argv.indexOf("--provider") + 1] ?? ""] ?? { status: "not_ready", accounts: [] }), err: "" };
  const model = modelOf(argv);
  calls.push({ model, argv, ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
  const own = reviewer?.(model);
  if (own) return own;
  if (!(AUTH[model.split("/")[0] ?? ""] as { accounts?: unknown[] } | undefined)?.accounts?.length) return { code: 1, out: "", err: "No API key found.\nUse /login to log into a provider via OAuth or API key. See:\n  /rt/docs/models.md" };
  const readOnly = argv.includes("--tools") && (argv[argv.indexOf("--tools") + 1] ?? "").split(",").includes("read") && !argv.includes("--no-tools");
  return { code: 0, out: readOnly && opts?.cwd === PLAN_REPO ? REVIEW : PREAMBLE, err: "" };
};
const challengeWorld = async (fake: Runner, models?: readonly string[], laneModel = "anthropic/claude-opus-5-5") => {
  const base = depsFor(world, fakeClock(T0), state.dir);
  const deps = { ...base, run: fake, config: { ...base.config, ...(models ? { reviewers: { ...base.config.reviewers, models } } : {}) } };
  const l: Lane = { ...lane, model: laneModel, challengeBefore: ["the full 9-seed run"] };
  await deps.registry.write(l);
  const plan = join(state.dir, "plan.md");
  await Bun.write(plan, "Raise the dump reward to 3x (see docs/reward.md and the B2 eval) and run 9 seeds.");
  return { deps, l, plan };
};

test("by default the best GPT, then Claude, then Grok model reviews; on a Claude lane GPT goes first", () => {
  const order = defaultConfig("/home/test").reviewers.models;
  expect(order.slice(0, 3).map(familyOf)).toEqual(["openai", "anthropic", "xai"]);
  expect(reviewers("anthropic-subscription/claude-opus-5-5:medium", order)[0]).toBe("chatgpt-subscription/gpt-6-astra");
  expect(familyOf("github-copilot/gpt-6.1-sol")).toBe("openai");
  expect(reviewers("anthropic/claude-opus-5-5", ["github-copilot/claude-opus-5.5", "xai/grok-4", "google/gemini-3"])).toEqual(["xai/grok-4", "google/gemini-3"]);
});

test("reviewers.allowSameFamily keeps a same-family reviewer for challenge (not the lane's own model); without it the lane's family is skipped", async () => {
  const list = ["chatgpt-subscription/gpt-6-astra:xhigh", "anthropic-subscription/claude-fable-5-1:xhigh", "anthropic-subscription/claude-opus-5-5"];
  const own = "anthropic-subscription/claude-opus-5-5:medium";
  expect(defaultConfig("/home/test").reviewers.allowSameFamily).toBe(false);
  expect(reviewers(own, list)).toEqual(["chatgpt-subscription/gpt-6-astra:xhigh"]);
  expect(reviewers(own, list, true)).toEqual(["chatgpt-subscription/gpt-6-astra:xhigh", "anthropic-subscription/claude-fable-5-1:xhigh"]);
  const calls: Call[] = [];
  const off = await challengeWorld(hostRunner(calls), list, own);
  await expect(runChallenge(off.deps, off.l, off.plan, { model: "anthropic-subscription/claude-fable-5-1:xhigh" })).rejects.toThrow("the lane's own family");
  expect((await runChallenge(off.deps, off.l, off.plan, { all: true })).reviews.map((v) => v.record.model)).toEqual(["chatgpt-subscription/gpt-6-astra:xhigh"]);
  const deps = { ...off.deps, config: { ...off.deps.config, reviewers: { ...off.deps.config.reviewers, models: list, allowSameFamily: true } } };
  expect((await runChallenge(deps, off.l, off.plan, { all: true })).reviews.map((v) => v.record.model)).toEqual(["chatgpt-subscription/gpt-6-astra:xhigh", "anthropic-subscription/claude-fable-5-1:xhigh"]);
  expect((await runChallenge(deps, off.l, off.plan, { model: "anthropic-subscription/claude-fable-5-1:xhigh" })).reviews.map((v) => v.record.model)).toEqual(["anthropic-subscription/claude-fable-5-1:xhigh"]);
  await expect(runChallenge(deps, off.l, off.plan, { model: "anthropic-subscription/claude-opus-5-5" })).rejects.toThrow("the lane's own model");
});

test("the reviewer reads the plan's repository with read-only tools and writes the review in its first run", async () => {
  const calls: Call[] = [];
  const { deps, l, plan } = await challengeWorld(hostRunner(calls));
  expect(challengeMissing(l)).toStartWith("CHALLENGE_MISSING rl-e7");
  const r = await runChallenge(deps, l, plan);
  expect(calls.map((c) => c.model)).toEqual(["chatgpt-subscription/gpt-6-astra"]);
  expect(calls[0]?.cwd).toBe(PLAN_REPO);
  expect(calls[0]?.argv).toContain(REVIEWER_SYSTEM);
  expect(calls[0]?.argv.at(-1)).toContain("Raise the dump reward to 3x");
  expect(r.failures).toEqual([]);
  const file = await Bun.file(r.reviews[0]?.record.file ?? "").text();
  for (const h of ["## Reasons this will fail", "## Missing alternatives", "## Cheapest falsifying test", `- Read access: ${PLAN_REPO}`]) expect(file).toContain(h);
  const saved = (await deps.registry.read("rl-e7")) as Lane;
  expect(saved.challenges?.[0]?.file).toBe(r.reviews[0]?.record.file);
  expect(challengeMissing(saved)).toBeUndefined();
  expect(await Bun.file(deps.config.watchLog).text()).toMatch(/challenge CHALLENGE rl-e7 reviewer=chatgpt-subscription\/gpt-6-astra /);
  await expect(runChallenge(deps, l, plan, { model: "github-copilot/claude-sonnet-5" })).rejects.toThrow("the lane's own family");
});

test("an explicit own-model opt-in saves a challenge on a single-model host while the default refuses it", async () => {
  const model = "chatgpt-subscription/gpt-6-astra";
  const off = await challengeWorld(hostRunner([]), [model], model);
  await expect(runChallenge(off.deps, off.l, off.plan)).rejects.toThrow("no reviewer");
  const deps = { ...off.deps, config: { ...off.deps.config, reviewers: { ...off.deps.config.reviewers, allowOwnModel: true } } };
  const result = await runChallenge(deps, off.l, off.plan);
  expect(result.reviews.map((review) => review.record.model)).toEqual([model]);
  expect((await deps.registry.read(off.l.key))?.challenges).toEqual(result.reviews.map((review) => review.record));
});

test("reviewer ids the host cannot call are skipped before any call; one on a provider that is not logged in is called on one that is", async () => {
  const calls: Call[] = [];
  const { deps, l, plan } = await challengeWorld(hostRunner(calls), ["google/gemini-3.1-pro-preview", "nosuch/model-x", "github-copilot/gpt-6-astra", "anthropic-subscription/claude-fable-5-1:high"], "xai/grok-4.7");
  const checks = await checkReviewers(deps, deps.config.reviewers.models);
  expect(checks.map((c) => c.call)).toEqual([undefined, undefined, "chatgpt-subscription/gpt-6-astra", "anthropic-subscription/claude-fable-5-1:high"]);
  expect(checks[0]?.note).toBe("google is not logged in, and no logged-in provider offers gemini-3.1-pro-preview");
  expect(checks[1]?.note).toBe("omo knows no provider nosuch, and no logged-in provider offers model-x");
  const r = await runChallenge(deps, l, plan);
  expect(calls.map((c) => c.model)).toEqual(["chatgpt-subscription/gpt-6-astra"]);
  expect(r.failures.map((f) => f.split(":")[0])).toEqual(["google/gemini-3.1-pro-preview", "nosuch/model-x"]);
  expect((await Bun.file(deps.config.watchLog).text()).match(/CHALLENGE_SKIP rl-e7 \S+: not callable on this host/g)).toHaveLength(2);
});

test("--all collects one review per family in list order, the next model of a family standing in for one that fails", async () => {
  const calls: Call[] = [];
  const order = defaultConfig("/home/test").reviewers.models;
  const { deps, l, plan } = await challengeWorld(hostRunner(calls, (m) => (m.endsWith("claude-fable-5-1") ? { code: 124, out: "", err: "killed by SIGKILL (timeout)" } : undefined)), order, "qwen/qwen3.8-max");
  const r = await runChallenge(deps, l, plan, { all: true });
  expect(calls.map((c) => c.model)).toEqual(["chatgpt-subscription/gpt-6-astra", "anthropic-subscription/claude-fable-5-1", "anthropic-subscription/claude-opus-5-5", "xai/grok-4.7"]);
  expect(r.reviews.map((v) => v.record.model)).toEqual(["chatgpt-subscription/gpt-6-astra", "anthropic-subscription/claude-opus-5-5", "xai/grok-4.7"]);
  expect(new Set(r.reviews.map((v) => v.record.file)).size).toBe(3);
  expect(r.failures).toEqual(["anthropic-subscription/claude-fable-5-1: exit 124 killed by SIGKILL (timeout)"]);
  expect(((await deps.registry.read("rl-e7")) as Lane).challenges).toHaveLength(3);
  const one = await runChallenge(deps, l, plan, { all: true, model: "xai/grok-4.6" });
  expect(one.reviews.map((v) => v.record.model)).toEqual(["xai/grok-4.6"]);
});

test("a reviewer that ends with only an announcement gets one stricter retry, then fails clearly with its raw replies saved", async () => {
  const calls: Call[] = [];
  const { deps, l, plan } = await challengeWorld(hostRunner(calls, () => ({ code: 0, out: PREAMBLE, err: "" })));
  const err = await runChallenge(deps, l, plan, { model: "xai/grok-4.7" }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ChallengeError);
  expect(calls.map((c) => c.model)).toEqual(["xai/grok-4.7", "xai/grok-4.7"]);
  expect(calls[1]?.argv.at(-1)).toContain("ended with a reply that was not the review");
  expect(calls[1]?.argv.at(-1)).toContain(PREAMBLE);
  const message = (err as Error).message;
  expect(message).toContain("no reviewer wrote a complete review: xai/grok-4.7: no complete review after a stricter retry");
  const raw = /raw replies: (\S+)/.exec(message)?.[1] ?? "";
  expect(raw).toEndWith("-xai-grok-4.7-raw.md");
  expect((await Bun.file(raw).text()).split(PREAMBLE)).toHaveLength(3);
  expect(((await deps.registry.read("rl-e7")) as Lane).challenges).toBeUndefined();
  expect(await Bun.file(deps.config.watchLog).text()).toMatch(/challenge CHALLENGE_FAILED rl-e7 /);
});

test("a stricter retry that writes the three sections is saved as the review", async () => {
  let n = 0;
  const { deps, l, plan } = await challengeWorld(hostRunner([], () => ({ code: 0, out: n++ ? REVIEW : PREAMBLE, err: "" })));
  const r = await runChallenge(deps, l, plan);
  expect(n).toBe(2);
  expect(r.reviews[0]?.record.model).toBe("chatgpt-subscription/gpt-6-astra");
  expect(r.reviews[0]?.text).toBe(REVIEW);
  expect(await Bun.file(r.reviews[0]?.record.file ?? "").text()).toContain("- Attempts: 2");
});

test("fork-explore runs CPU branches at once, queues GPU branches on the slot, prints one table and feeds the tree", async () => {
  let gpuActive = 0;
  let gpuMax = 0;
  let held = Promise.resolve();
  const slotLabels: string[] = [];
  const takeSlot = async (label: string) => {
    slotLabels.push(label);
    const prev = held;
    let free = () => {};
    held = new Promise<void>((r) => { free = r; });
    await prev;
    return free;
  };
  const fake: Runner = async (argv) => {
    const cmd = argv.at(-1) ?? "";
    const gpu = cmd.includes("gpu");
    if (gpu) gpuMax = Math.max(gpuMax, ++gpuActive);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    if (gpu) gpuActive--;
    return { code: 0, out: cmd.includes("swing") ? "METRIC: sigma 0.007\nVERDICT: supports\nEVIDENCE: log shows collapse" : "METRIC: 0 dumps\nVERDICT: falsifies\nEVIDENCE: x2 reward no change", err: "" };
  };
  const deps = { ...depsFor(world, fakeClock(T0), state.dir), run: fake };
  await deps.registry.write(lane);
  const branches = branchesFrom(["reward too small", "swing exploration collapsed", "value gap"], ["gpu reward x2", "gpu swing sigma log", "cpu value probe"], [1, 2], false);
  const r = await forkExplore(deps, lane, { metric: "dumps", branches, mode: "cmd", minutes: 1 }, takeSlot);
  expect(slotLabels).toHaveLength(2);
  expect(gpuMax).toBe(1);
  expect(r.table.split("\n")).toHaveLength(5);
  expect(r.table).toContain("| 2 | swing exploration collapsed | sigma 0.007 | supports |");
  const tree = await loadTree(state.dir, { cwd: "/work/rl" });
  expect(tree.nodes.map((n) => `${n.text}=${n.status}`)).toEqual(["reward too small=falsified", "swing exploration collapsed=supported", "value gap=falsified"]);
  expect(((await deps.registry.read("rl-e7")) as Lane).explorations?.[0]?.branches).toBe(3);
  expect(parseBranch("done\nVERDICT: refuted").verdict).toBe("falsifies");
  expect(() => branchesFrom(["a"], ["t"], [], false)).toThrow("at least 2");
});

// 2026-11-02 (owner card Q442): freshness no longer has a reviewer read lane reports; only dori intent-check asks one
test("intent-check shows the owner's goal, the lane's direction and next step; a freshness sweep, a stage-change milestone included, asks no reviewer and writes no INTENT line", async () => {
  const empty: Tree = { area: "x", nodes: [] };
  const goal = "굴착기가 흙을 퍼서 적치띠에 덤프하는 정책을 학습";
  expect(intentView({ ...lane, goal, direction: { at: "t", text: "적치띠 덤프 보상 정책 학습 재개", next: "9-seed 평가" } }, empty)).toEqual({ goal, direction: "적치띠 덤프 보상 정책 학습 재개", next: "9-seed 평가" });
  expect(intentView({ ...lane, lastReport: "[REPORT] rl-e7 | milestone | swing floor added; next: count dumps" }, empty)).toEqual({ direction: "swing floor added; next: count dumps", next: "count dumps" });
  const checked: string[] = [];
  const omo: Runner = async (argv, opts) => {
    if (argv[0] !== "omo") return fakeRunner(world)(argv, opts);
    checked.push((argv.at(-1) ?? "").match(/Lane: (\S+)/)?.[1] ?? "");
    return { code: 0, out: "VERDICT: OK", err: "" };
  };
  const sessions = join(state.dir, "sessions");
  for (const [key, cwd] of [["rl-a", "/work/a"], ["rl-b", "/work/b"]] as const) {
    const dir = sessionDirFor(sessions, cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `2026-01-01T11-00-00-000Z_00000000-0000-0000-0000-00000000000${key === "rl-a" ? 1 : 2}.jsonl`), `${JSON.stringify({ type: "message", timestamp: new Date(T0 + 30_000).toISOString(), message: { role: "user", content: [{ type: "text", text: `[REPORT] ${key} | milestone | working` }] } })}\n`);
  }
  for (const staged of ["rl-a", "rl-b"]) {
    const dir = join(state.dir, `st-${staged}`);
    checked.length = 0;
    const base = depsFor(world, fakeClock(T0 + 60_000), dir, { sessionsDir: sessions, explore: { ...defaultConfig().explore, modelsCommand: [] } });
    const deps = { ...base, run: omo };
    await deps.registry.write({ ...lane, key: "rl-a", pane: "w:pa", cwd: "/work/a", goal });
    await deps.registry.write({ ...lane, key: "rl-b", pane: "w:pb", cwd: "/work/b", goal });
    const line = (k: string) => ` [REPORT] ${k} | milestone | ${k === staged ? "phase 2 starts: switch to curriculum training" : "still tuning"}`;
    world.screens["lead:p1"] = `${line("rl-a")}\n${line("rl-b")}\n\n❯ `;
    await freshnessTick(deps, "/home/test");
    expect(checked).toEqual([]);
    const log = Bun.file(deps.config.watchLog);
    expect((await log.exists()) ? await log.text() : "").not.toMatch(/INTENT_/);
  }
  expect(footer({ ...lane, goal }, "lead:p1")).toContain(`Goal (owner words): "${goal}"`);
});

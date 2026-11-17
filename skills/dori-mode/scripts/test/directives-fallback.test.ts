import { afterEach, beforeEach, expect, test } from "bun:test";

import { checkMeaning } from "../src/directive-audit.ts";
import { COMMON_LEDGER, loadLedger } from "../src/directives.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, withState, type World } from "./fakes.ts";

let state: ReturnType<typeof withState>;
let world: World;

beforeEach(() => {
  state = withState();
  world = newWorld();
});

afterEach(() => state.done());

const T0 = Date.parse("2026-10-16T06:00:00Z");

const meaningFixture = async (models: readonly string[], run: Runner) => {
  const base = depsFor(world, fakeClock(T0), state.dir, { directives: { common: COMMON_LEDGER, local: "" } });
  const config = {
    ...base.config,
    defaultModel: "anthropic/claude-opus-5-5",
    reviewers: { ...base.config.reviewers, models, first: models[0] ?? "" },
    explore: { ...base.config.explore, modelsCommand: [] },
  };
  const deps = { ...base, run, config };
  const ledger = loadLedger(config);
  const skill = ledger.entries.find((entry) => entry.id === "skill-check" && entry.by === "owner" && entry.words && entry.prompt);
  if (!skill) throw new Error("common ledger fixture lacks skill-check");
  return { deps, ledger: { ...ledger, entries: [skill] } };
};

test("checkMeaning tries the next reviewer after an empty nonzero reply and reports the successful model", async () => {
  const models = ["openai/gpt-6-astra", "openai/gpt-6.1-sol"];
  const asked: string[] = [];
  const run: Runner = async (argv, opts) => {
    if (argv[0] !== "omo") return fakeRunner(world)(argv, opts);
    const model = argv[argv.indexOf("--model") + 1] ?? "";
    asked.push(model);
    return asked.length === 1 ? { code: 1, out: "", err: "" } : { code: 0, out: "VERDICT: SAME", err: "" };
  };
  const { deps, ledger } = await meaningFixture(models, run);

  const result = await checkMeaning(deps, ledger);

  expect(result.ok).toBe(true);
  expect(asked).toEqual(models);
  expect(result.lines).toEqual(["DIRECTIVES_MEANING_OK skill-check [openai/gpt-6.1-sol]"]);
});

test("checkMeaning names failed reviewers, distinguishes timeout, and stops after three candidates", async () => {
  const models = ["openai/gpt-6-astra", "openai/gpt-6.1-sol", "openai/gpt-6-luna", "openai/gpt-6-codex"];
  const replies = [
    { code: 1, out: "", err: "" },
    { code: 124, out: "", err: "killed by SIGKILL (timeout)" },
    { code: 0, out: "No verdict", err: "" },
    { code: 0, out: "VERDICT: SAME", err: "" },
  ];
  const asked: string[] = [];
  const run: Runner = async (argv, opts) => {
    if (argv[0] !== "omo") return fakeRunner(world)(argv, opts);
    const model = argv[argv.indexOf("--model") + 1] ?? "";
    const reply = replies[asked.length] ?? { code: 0, out: "VERDICT: SAME", err: "" };
    asked.push(model);
    return reply;
  };
  const { deps, ledger } = await meaningFixture(models, run);

  const result = await checkMeaning(deps, ledger);
  const failure = result.lines[0] ?? "";

  expect(result.ok).toBe(false);
  expect(asked).toEqual(models.slice(0, 3));
  expect(failure).toStartWith("DIRECTIVES_MEANING_FAILED skill-check");
  expect(failure).toContain("openai/gpt-6-astra: exit 1");
  expect(failure).toContain("openai/gpt-6.1-sol: timeout (exit 124)");
  expect(failure).toContain("openai/gpt-6-luna: no VERDICT line");
  expect(failure).not.toContain("openai/gpt-6-codex");
});

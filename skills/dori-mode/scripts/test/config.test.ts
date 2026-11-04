import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ConfigError, defaultConfig, fill, loadConfig, loadEnvFile } from "../src/config.ts";
import { run } from "../src/run.ts";
import { configKeys, knownConfigKeys } from "../src/config-keys.ts";
import { withState } from "./fakes.ts";

const state = withState();
afterEach(() => {
  delete process.env.DORI_STATE_DIR;
});

test("the shipped example config loads, with ~ paths expanded and unset fields defaulted", async () => {
  const c = await loadConfig(join(import.meta.dir, "../../references/config.example.json"), "/home/ana");
  expect(c.stateDir).toBe("/home/ana/.dori/state");
  expect(c.defaultCwd).toBe("/home/ana/code/my-project");
  expect(c.closeAfterMin).toBe(5);
  expect(c.guard.diskFreeMinGb).toBe(50);
});

test("a missing config file falls back to defaults and DORI_STATE_DIR wins over the file", async () => {
  process.env.DORI_STATE_DIR = state.dir;
  const c = await loadConfig("/nonexistent/config.json", "/home/ana");
  expect(c.stateDir).toBe(state.dir);
  expect(c.agentCommand).toEqual(["omo", "--model", "{model}", "{prompt}"]);
});

test("the scorecard counts sessionsDir unless scorecard.sessions names one Dori's own sessions", async () => {
  expect((await loadConfig("/nonexistent/config.json", "/home/ana")).scorecard.sessions).toBe("/home/ana/.omo/agent/sessions");
  const path = join(state.dir, "second-dori.json");
  writeFileSync(path, JSON.stringify({ scorecard: { sessions: "~/.omo/agent/sessions/--home-ana-second--" } }));
  expect((await loadConfig(path, "/home/ana")).scorecard.sessions).toBe("/home/ana/.omo/agent/sessions/--home-ana-second--");
});

test("the discord-aoe setup's config loads as the aoe backend with built-in thread hooks, and unset Discord words keep their defaults", async () => {
  const c = await loadConfig(join(import.meta.dir, "../../setups/discord-aoe/config.json"), "/home/ana");
  expect(c.backend).toBe("aoe");
  expect(c.hooks.threadDone).toEqual(["dori", "thread", "done", "{thread}", "{text}"]);
  expect(c.discord.done).toBe("done");
  expect(c.discord.timeZone).toBe("UTC");
  expect(c.discord.statusStyle).toBe("emoji");
  expect((await loadConfig("/nonexistent/config.json", "/home/ana")).discord.statusStyle).toBe("words");
});

test("the env file fills unset variables only, skips comments and strips quotes", async () => {
  const file = join(state.dir, "dori.env");
  writeFileSync(file, "# Discord\nDORI_DISCORD_OWNER=111\nDORI_DISCORD_CHANNEL='222'\nexport_me=x\nDORI_DISCORD_TOKEN=from-file\n");
  const env: Record<string, string | undefined> = { DORI_DISCORD_OWNER: "from-env" };
  await loadEnvFile(file, env);
  expect(env).toEqual({ DORI_DISCORD_OWNER: "from-env", DORI_DISCORD_CHANNEL: "222", DORI_DISCORD_TOKEN: "from-file" });
  await loadEnvFile(join(state.dir, "missing.env"), env);
});

test("a researchText that does not start with 'ulw research ' or lacks {question} is refused, and dori says why", async () => {
  expect(defaultConfig().explore.researchText).toStartWith("ulw research {question} ");
  const path = join(state.dir, "research.json");
  writeFileSync(path, JSON.stringify({ explore: { researchText: "[LEAD] ulw research {question}" } }));
  await expect(loadConfig(path, "/home/ana")).rejects.toThrow(ConfigError);
  await expect(loadConfig(path, "/home/ana")).rejects.toThrow('must start with "ulw research "');
  writeFileSync(path, JSON.stringify({ explore: { researchText: "ulw research the symptom" } }));
  await expect(loadConfig(path, "/home/ana")).rejects.toThrow("must contain {question}");
  const cli = await run(["env", `DORI_CONFIG=${path}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`, "bun", join(import.meta.dir, "../src/cli.ts"), "signals"]);
  expect(cli.code).toBe(2);
  expect(cli.err).toContain("CONFIG_INVALID");
});

test("launchEnv defaults to none, loads a name with an empty value, and a value that is not a string is refused", async () => {
  const path = join(state.dir, "env.json");
  expect((await loadConfig(join(state.dir, "missing.json"), "/home/ana")).launchEnv).toEqual({});
  writeFileSync(path, JSON.stringify({ launchEnv: { CUDA_VISIBLE_DEVICES: "" } }));
  expect((await loadConfig(path, "/home/ana")).launchEnv).toEqual({ CUDA_VISIBLE_DEVICES: "" });
  writeFileSync(path, JSON.stringify({ launchEnv: { CUDA_VISIBLE_DEVICES: 0 } }));
  await expect(loadConfig(path, "/home/ana")).rejects.toThrow("launchEnv must map variable names to strings");
  writeFileSync(path, JSON.stringify({ launchEnv: ["CUDA_VISIBLE_DEVICES="] }));
  await expect(loadConfig(path, "/home/ana")).rejects.toThrow(ConfigError);
});

test("hook templates fill each argument separately, so text with spaces or quotes stays one argument", () => {
  const argv = fill(["notify", "--thread", "{thread}", "--text", "{text}"], { thread: "chat:1/2", text: `it's "done"; rm -rf /` });
  expect(argv).toEqual(["notify", "--thread", "chat:1/2", "--text", `it's "done"; rm -rf /`]);
});

test("documents every configuration field when defaultConfig defines it", async () => {
  // Given
  const defaults = defaultConfig();
  const text = await Bun.file(join(import.meta.dir, "../../references/scripts.md")).text();
  const documented = new Set([...text.matchAll(/`([a-zA-Z][\w.]*)`/g)].map((match) => match[1]));
  const required = [
    ...Object.keys(defaults),
    ...configKeys({ scorecard: defaults.scorecard, update: defaults.update, stuck: defaults.stuck, reviewers: defaults.reviewers, signals: defaults.signals, explore: defaults.explore, autoSignals: defaults.autoSignals, handover: defaults.handover }),
  ];
  // When
  const missing = required.filter((key) => !documented.has(key));
  // Then
  expect(missing).toEqual([]);
});

test("every key the config loader knows is documented, and every DORI_ variable the code reads is in dori.env.example or the settings section", async () => {
  // Given
  const root = join(import.meta.dir, "../..");
  const scripts = await Bun.file(join(root, "references/scripts.md")).text();
  const documented = new Set([...scripts.matchAll(/`([a-zA-Z][\w.]*)`/g)].map((match) => match[1]));
  const example = await Bun.file(join(root, "setups/discord-aoe/dori.env.example")).text();
  const readme = await Bun.file(join(root, "setups/discord-aoe/README.md")).text();
  const settings = readme.slice(readme.indexOf("## Settings per Dori"), readme.indexOf("## Optional local helpers"));
  const sources = ["scripts/src/**/*.ts", "setups/**/*.{ts,sh,service}"].flatMap((pattern) => [...new Bun.Glob(pattern).scanSync(root)]);
  const read = new Set<string>();
  for (const file of sources) for (const m of (await Bun.file(join(root, file)).text()).matchAll(/\bDORI_[A-Z0-9_]*[A-Z0-9]\b/g)) read.add(m[0]);
  // log-line tags, not variables
  for (const tag of ["DORI_ENV_FOREIGN", "DORI_SHELL_CHECK_PASS"]) read.delete(tag);
  // When
  // instances is [] by default, so its entry fields come from a sample; the discord words are documented by their bare names in the discord row
  const keys = [...knownConfigKeys(), ...configKeys({ instances: [{ config: "", envFile: "" }] })];
  const discordRow = scripts.split("\n").find((line) => line.startsWith("| `discord` |")) ?? "";
  const discordWords = new Set([...discordRow.matchAll(/`([a-zA-Z]\w*)`/g)].map((match) => `discord.${match[1]}`));
  const keysMissing = keys.filter((key) => !documented.has(key) && !discordWords.has(key));
  const listed = new Set([...example.matchAll(/\bDORI_[A-Z0-9_]*[A-Z0-9]\b/g), ...settings.matchAll(/`(DORI_[A-Z0-9_]*[A-Z0-9])`/g)].map((m) => m[1] ?? m[0]));
  const varsMissing = [...read].filter((name) => !listed.has(name)).sort();
  // Then
  expect(sources.length).toBeGreaterThan(10);
  expect(read.has("DORI_DISCORD_TOKEN")).toBe(true);
  expect(keysMissing).toEqual([]);
  expect(varsMissing).toEqual([]);
});

test("expands update paths and defaults watchLog and alertPane when config overrides state and lead", async () => {
  // Given
  const fixture = withState();
  try {
    const file = join(fixture.dir, "config.json");
    writeFileSync(file, JSON.stringify({ stateDir: "~/custom-state", leadPane: "lead", update: { repo: "~/clone", services: [{ unit: "test", log: "~/service.log" }] } }));
    // When
    const config = await loadConfig(file, "/home/ana");
    // Then
    expect(config.watchLog).toBe("/home/ana/custom-state/lanes.log");
    expect(config.update.repo).toBe("/home/ana/clone");
    expect(config.update.alertPane).toBe("lead");
    expect(config.update.services).toEqual([{ unit: "test", log: "/home/ana/service.log", paths: ["skills/dori-mode/scripts/src/"], ready: "" }]);
    expect(config.update.readyTimeoutSec).toBe(60);
  } finally { fixture.done(); }
});

test("old keys of the stuck ladder, the reviewer list and the attempt patterns still work, each with one CONFIG_OLD_KEY line; a key with no new home is ignored", async () => {
  // Given
  const fixture = withState();
  try {
    const file = join(fixture.dir, "config.json");
    writeFileSync(file, JSON.stringify({
      sameFix: { after: 4, sendToLane: true },
      explore: { hypothesesFrom: 3, researchAt: 2, driftBelow: 0.2, stagePattern: "phase", challengeModels: ["xai/grok-4.7"] },
      handover: { laneRepeats: 3, reportText: "I moved {who} ({from} -> {to})", frozenText: "{from} frozen", sizeText: "{old}k -> {now}k" },
      signals: { attemptPattern: "try (\\d)" },
      autoSignals: { repeatAfter: 5, attemptPattern: "처방", ownerCheck: { models: ["chatgpt-subscription/gpt-6-luna"], minutes: 2, reports: 4, enabled: true, perTick: 1 } },
      stuck: { fixatedAfter: 5 },
    }));
    const warned: string[] = [];
    // When
    const config = await loadConfig(file, "/home/ana", (line) => warned.push(line));
    // Then
    expect(config.stuck).toMatchObject({ hypothesesAt: 3, researchAt: 4, fixatedAfter: 5 });
    expect(config.signals.numberedAttemptPattern).toBe("try (\\d)");
    expect(config.autoSignals.inferAttemptPattern).toBe("처방");
    // both old lists: one list holding both, the challenge order first (challenge, grok-4.7)
    expect(config.reviewers.models).toEqual(["xai/grok-4.7", "chatgpt-subscription/gpt-6-luna"]);
    // the removed periodic check (2026-11-02): its reviewer settings move to reviewers, what intent-check reads to
    // autoSignals.intentCheck, its schedule keys are dropped
    expect(config.reviewers).toMatchObject({ first: "chatgpt-subscription/gpt-6-luna", minutes: 2 });
    expect(config.autoSignals.intentCheck).toEqual({ reports: 4, maxReports: 20, relays: 8 });
    expect(Object.keys(config.autoSignals)).not.toContain("ownerCheck");
    expect("stagePattern" in config.explore).toBe(false);
    expect("laneRepeats" in config.handover).toBe(false);
    expect(["reportText", "frozenText", "sizeText"].filter((k) => k in config.handover)).toEqual([]);
    expect(warned.map((w) => w.split(" ")[1])).toEqual(["sameFix.after", "sameFix.sendToLane", "explore.hypothesesFrom", "explore.researchAt", "explore.driftBelow", "explore.stagePattern", "handover.laneRepeats", "handover.reportText", "handover.frozenText", "handover.sizeText", "autoSignals.repeatAfter", "signals.attemptPattern", "autoSignals.attemptPattern", "explore.challengeModels", "autoSignals.ownerCheck.models", "autoSignals.ownerCheck.minutes", "autoSignals.ownerCheck.reports", "autoSignals.ownerCheck.enabled", "autoSignals.ownerCheck.perTick"]);
    expect(warned[0]).toBe(`CONFIG_OLD_KEY sameFix.after -> stuck.fixatedAfter (both set: the new key wins); rename it in the config (${file})`);
    expect(warned.every((w) => w.startsWith("CONFIG_OLD_KEY "))).toBe(true);
    // a config without old keys loads quietly, and scorecard.lanesLog defaults to the watch log
    writeFileSync(file, JSON.stringify({ watchLog: "~/w.log" }));
    const clean: string[] = [];
    expect((await loadConfig(file, "/home/ana", (line) => clean.push(line))).scorecard.lanesLog).toBe("/home/ana/w.log");
    expect(clean).toEqual([]);
  } finally {
    fixture.done();
  }
});

test("discord.quietText and discord.postRawReports load with one CONFIG_OLD_KEY line each and are not kept; the other discord words stay", async () => {
  // Given the words a Dori set when freshness still posted a status line in the owner's thread (before 2026-11-04).
  const fixture = withState();
  try {
    const file = join(fixture.dir, "config.json");
    writeFileSync(file, JSON.stringify({ discord: { quietText: "진행 중이야 — 마지막 보고는 {min}분 전.", postRawReports: false, locale: "ko-KR" } }));
    const warned: string[] = [];
    // When
    const config = await loadConfig(file, "/home/ana", (line) => warned.push(line));
    // Then
    expect(warned.map((w) => w.split(" ").slice(0, 6).join(" "))).toEqual(["CONFIG_OLD_KEY discord.quietText is no longer read:", "CONFIG_OLD_KEY discord.postRawReports is no longer read:"]);
    expect(["quietText", "postRawReports"].filter((k) => k in config.discord)).toEqual([]);
    expect(config.discord.locale).toBe("ko-KR");
  } finally {
    fixture.done();
  }
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig } from "../src/config.ts";
import { readHerdrSessions, recordHerdrSession } from "../src/herdr-sessions.ts";
import { withState } from "./fakes.ts";

const DATE = "2026-11-16";
const PANE = "w1:p1";
const OLD_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_DORI_KEY = "metdol";
const handoverPath = (stateDir: string): string => join(stateDir, "handover", `${DATE}.md`);

let state: { readonly dir: string; readonly done: () => void };

beforeEach(() => {
  state = withState();
});

afterEach(() => state.done());

test("rejects another Dori's key before reading or changing the caller's lead pane", async () => {
  // Given
  const base = defaultConfig(state.dir);
  const config = {
    ...base,
    backend: "herdr" as const,
    stateDir: state.dir,
    watchLog: join(state.dir, "lanes.log"),
    leadPane: PANE,
    sessionsDir: join(state.dir, "sessions"),
    agentCommand: ["omo", "--model", "{model}", "{prompt}"],
    update: { ...base.update, repo: join(import.meta.dir, "..") },
  };
  const configPath = join(state.dir, "config.json");
  const envPath = join(state.dir, "dori.env");
  const bin = join(state.dir, "bin");
  mkdirSync(join(state.dir, "handover"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(handoverPath(state.dir), "Fake note for key-guard QA.\n");
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(envPath, "");
  recordHerdrSession(state.dir, PANE, { session: OLD_ID, cwd: state.dir, at: new Date(0).toISOString() });
  const before = readHerdrSessions(state.dir)[PANE];
  const env: Record<string, string | undefined> = { ...process.env, DORI_CONFIG: configPath, DORI_STATE_DIR: state.dir, DORI_ENV_FILE: envPath, PATH: bin, TMUX: "fake,1,0" };
  delete env.HERDR_PANE_ID;
  // When
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "handover", "--key", OTHER_DORI_KEY, "--date", DATE], {
    cwd: join(import.meta.dir, ".."),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  // Then
  expect(code).toBe(2);
  expect(stdout.trim()).toBe(`HANDOVER_FAIL --key ${OTHER_DORI_KEY} does not match this Dori's fixed key lead-handover; no pane was accessed`);
  expect(stderr).toBe("");
  expect(readHerdrSessions(state.dir)[PANE]).toEqual(before);
  expect(readFileSync(handoverPath(state.dir), "utf8")).toBe("Fake note for key-guard QA.\n");
  expect(readFileSync(join(state.dir, "herdr-sessions.json"), "utf8")).toContain(OLD_ID);
  expect(existsSync(join(state.dir, "handover", "lock"))).toBe(false);
  expect(existsSync(join(state.dir, "lanes.log"))).toBe(false);
});

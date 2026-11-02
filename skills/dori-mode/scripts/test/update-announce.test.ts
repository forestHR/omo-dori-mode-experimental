import { expect, test } from "bun:test";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { knownConfigKeys } from "../src/config-keys.ts";
import { applyUpdate } from "../src/update.ts";
import { announceChange, mergeTitles } from "../src/update-announce.ts";
import { fakeClock, withState } from "./fakes.ts";

test("sends one summary to leadPane when a merge changes a reference", async () => {
  // Given
  const state = withState();
  try {
    const sent: { pane: string; text: string }[] = [];
    const config = { ...defaultConfig(), stateDir: state.dir, watchLog: join(state.dir, "lanes.log"), leadPane: "lead", update: { ...defaultConfig().update, alertPane: "alerts" } };
    await Bun.write(join(state.dir, "update.json"), JSON.stringify({ applied: "old", keys: knownConfigKeys() }));
    // When
    await applyUpdate({
      config, configPath: join(state.dir, "missing.json"), clock: fakeClock(0),
      git: async (args) => ({ code: args.includes("merge-base") ? 1 : 0, err: "", out: args.includes("symbolic-ref") ? "main" : args.includes("rev-parse") ? "new" : args.includes("diff") ? "skills/dori-mode/references/sessions.md" : args.includes("--merges") ? "Merge pull request #23 from acme/change\n\nExplain new lane behaviour\n" : "" }),
      systemctl: async () => ({ code: 0, out: "", err: "" }),
      send: async (pane, text) => { sent.push({ pane, text }); return true; }, print: () => {},
    }, { pull: false, dryRun: false });
    // Then
    expect(sent).toHaveLength(1);
    expect(sent[0]?.pane).toBe("lead");
    expect(sent[0]?.text).toContain("Explain new lane behaviour");
    expect(sent[0]?.text).toContain("skills/dori-mode/references/sessions.md");
    expect((await Bun.file(config.watchLog).text()).split("\n").filter((line) => line.includes(" ANNOUNCED lead"))).toHaveLength(1);
  } finally { state.done(); }
});

test("sends one guidance notification when notify-change is requested", async () => {
  // Given
  const state = withState();
  try {
    const sent: string[] = [];
    const config = { ...defaultConfig(), leadPane: "lead", watchLog: join(state.dir, "lanes.log"), update: { ...defaultConfig().update, announce: "Review your guidance." } };
    // When
    expect(await announceChange({ config, clock: fakeClock(0), print: () => {}, send: async (pane, text) => { sent.push(`${pane} ${text}`); return true; } }, { summary: "Guidance updated", files: ["AGENTS.md"] })).toBe(true);
    // Then
    expect(sent).toHaveLength(1);
    expect(sent[0]).toStartWith("lead [UPDATE] ");
    expect(sent[0]).toContain("AGENTS.md");
    expect(sent[0]?.endsWith(config.update.announce)).toBe(true);
    expect(await Bun.file(config.watchLog).text()).toContain("update ANNOUNCED lead");
  } finally { state.done(); }
});

// owner 2026-11-03 (ledger update-notice-once): every Dori repeated each update to the owner; only the maintenance Dori
// reports an update, once, after checking every Dori applied it
test("an update ends with maintainerAnnounce on the maintenance Dori only, and notify-change keeps announce there", async () => {
  // Given
  const state = withState();
  try {
    const base = defaultConfig();
    const update = { ...base.update, announce: "Do not tell the owner.", maintainerAnnounce: "Check every Dori, then tell the owner once." };
    const run = async (maintainer: boolean): Promise<string> => {
      const sent: string[] = [];
      const dir = join(state.dir, String(maintainer));
      const config = { ...base, stateDir: dir, watchLog: join(dir, "lanes.log"), leadPane: "lead", update: { ...update, maintainer } };
      await Bun.write(join(dir, "update.json"), JSON.stringify({ applied: "old", keys: knownConfigKeys() }));
      await applyUpdate({
        config, configPath: join(dir, "missing.json"), clock: fakeClock(0),
        git: async (args) => ({ code: args.includes("merge-base") ? 1 : 0, err: "", out: args.includes("symbolic-ref") ? "main" : args.includes("rev-parse") ? "new" : "" }),
        systemctl: async () => ({ code: 0, out: "", err: "" }),
        send: async (_pane, text) => { sent.push(text); return true; }, print: () => {},
      }, { pull: false, dryRun: false });
      return sent.join("\n---\n");
    };
    const maintainerConfig = { ...base, leadPane: "lead", watchLog: join(state.dir, "notify.log"), update: { ...update, maintainer: true } };
    const notified: string[] = [];
    // When
    const [other, maintenance] = [await run(false), await run(true)];
    await announceChange({ config: maintainerConfig, clock: fakeClock(0), print: () => {}, send: async (_pane, text) => { notified.push(text); return true; } }, { summary: "Own guidance", files: [] });
    // Then
    expect({ other: other.split("\n\n").at(-1), maintenance: maintenance.split("\n\n").at(-1), notify: notified[0]?.split("\n\n").at(-1) })
      .toEqual({ other: update.announce, maintenance: update.maintainerAnnounce, notify: update.announce });
  } finally { state.done(); }
});

test("logs ANNOUNCE_FAIL when pane delivery fails", async () => {
  // Given
  const state = withState();
  try {
    const config = { ...defaultConfig(), leadPane: "lead", watchLog: join(state.dir, "lanes.log") };
    // When
    expect(await announceChange({ config, clock: fakeClock(0), print: () => {}, send: async () => false }, { summary: "Changed", files: [] })).toBe(false);
    // Then
    expect(await Bun.file(config.watchLog).text()).toContain("update ANNOUNCE_FAIL lead message was not submitted");
  } finally { state.done(); }
});

// 2026-10-22: #170's title had `dori send` in backticks and every lead got ANNOUNCE_FAIL instead of the notice
test("a commit title with a backtick or $( still reaches the lead, defused, as the pane send refuses both", async () => {
  // Given
  const state = withState();
  try {
    const sent: string[] = [];
    const config = { ...defaultConfig(), leadPane: "lead", watchLog: join(state.dir, "lanes.log") };
    const send = async (_pane: string, text: string) => {
      if (/`|\$\(/.test(text)) throw new Error("refusing to send text containing a backtick or $(");
      sent.push(text);
      return true;
    };
    // When
    const ok = await announceChange({ config, clock: fakeClock(0), print: () => {}, send }, { summary: "tmux: a bare `dori send` works, $(id) stays text", files: [] });
    // Then
    expect({ ok, first: sent[0]?.split("\n")[0] }).toEqual({ ok: true, first: "[UPDATE] tmux: a bare 'dori send' works, $ (id) stays text" });
    expect(await Bun.file(config.watchLog).text()).toContain("update ANNOUNCED lead");
  } finally { state.done(); }
});

test("uses each PR title when the git merge log contains multiple bodies", () => {
  // Given
  const log = "Merge pull request #1 from a/b\n\nFirst title\n\nMore detail\0Merge pull request #2 from a/c\n\nSecond title\n";
  // When
  const titles = mergeTitles(log);
  // Then
  expect(titles).toEqual(["First title", "Second title"]);
});

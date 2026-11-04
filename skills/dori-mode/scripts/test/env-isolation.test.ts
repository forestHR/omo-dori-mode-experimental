import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadEnvFile } from "../src/config.ts";
import { childEnv, run } from "../src/run.ts";
import { withState } from "./fakes.ts";

// a bot token starts with the bot's user id in base64
const tok = (bot: string): string => `${Buffer.from(bot).toString("base64").replace(/=+$/, "")}.fake.token`;
const ZZANG = "111111111111111111";
const OK = "222222222222222222";

// What a tmux server started by the first Dori's boot unit (EnvironmentFile=dori.env) hands to every pane, the second
// Dori's included (2026-10-13 after a power outage: OkDori posted as ZzangDori).
const zzangEnv = (home: string): Record<string, string> => ({
  DORI_DISCORD_TOKEN: tok(ZZANG),
  DORI_DISCORD_CHANNEL: "zzang-channel",
  DORI_DISCORD_INBOX: join(home, "zzang/inbox.jsonl"),
  DORI_DISCORD_STATE_DIR: join(home, "zzang"),
  DORI_DISCORD_PAIR_BOT: OK,
  DORI_LEAD_TMUX: "aoe_zzangdori_1",
});

// the second Dori: config and dori.env in ~/.okdori, its directory ~/Documents/okdori, the old name kakaodori a symlink
const okdoriHome = (home: string, envFile: string, botId = OK): void => {
  mkdirSync(join(home, ".okdori"), { recursive: true });
  mkdirSync(join(home, "Documents/okdori"), { recursive: true });
  symlinkSync(join(home, "Documents/okdori"), join(home, "Documents/kakaodori"));
  writeFileSync(join(home, ".okdori/config.json"), JSON.stringify({ stateDir: "~/.okdori/state", defaultCwd: "~/Documents/okdori", discord: { botId } }));
  writeFileSync(join(home, ".okdori/dori.env"), envFile);
  mkdirSync(join(home, ".dori"), { recursive: true });
  writeFileSync(join(home, ".dori/config.json"), JSON.stringify({ instances: [{ config: "~/.okdori/config.json" }] }));
};

const okSelectors = (home: string): Record<string, string> => ({ DORI_CONFIG: join(home, ".okdori/config.json"), DORI_ENV_FILE: join(home, ".okdori/dori.env"), DORI_STATE_DIR: join(home, ".okdori/state") });

const sendFrom = async (home: string, env: Record<string, string>) => {
  const http = join(home, "http.json");
  const r = await run(["env", "-i", `PATH=${process.env.PATH}`, `HOME=${home}`, `DORI_TEST_HTTP=${http}`, ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
    "bun", "--preload", join(import.meta.dir, "discord-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"), "send", "discord", "--to", "pair-channel", "--text", "hello", "--no-typing"], { cwd: join(home, "Documents/kakaodori") });
  const auth: string[] = existsSync(`${http}.auth`) ? (JSON.parse(readFileSync(`${http}.auth`, "utf8")) as string[]) : [];
  return { code: r.code, out: r.out, err: r.err, auth };
};

test("a Dori whose wrapper names its own dori.env posts with its own token under another Dori's inherited environment", async () => {
  const state = withState();
  try {
    okdoriHome(state.dir, `DORI_DISCORD_TOKEN=${tok(OK)}\nDORI_DISCORD_CHANNEL=ok-channel\nDORI_DISCORD_PAIR_BOT=${ZZANG}\n`);
    const r = await sendFrom(state.dir, { ...zzangEnv(state.dir), ...okSelectors(state.dir) });
    expect({ code: r.code, out: r.out.split(" ").slice(0, 2).join(" "), auth: r.auth }).toEqual({ code: 0, out: "SENT 900", auth: [`Bot ${tok(OK)}`] });
    expect(r.err).toContain("DORI_ENV_FOREIGN");
    expect(r.err).toContain("DORI_DISCORD_INBOX");
  } finally {
    state.done();
  }
});

test("a bare dori in the second Dori's directory (through its symlinked old name) acts as that Dori", async () => {
  const state = withState();
  try {
    okdoriHome(state.dir, `DORI_DISCORD_TOKEN=${tok(OK)}\nDORI_DISCORD_CHANNEL=ok-channel\n`);
    const r = await sendFrom(state.dir, zzangEnv(state.dir));
    expect({ code: r.code, out: r.out.split(" ").slice(0, 2).join(" "), auth: r.auth }).toEqual({ code: 0, out: "SENT 900", auth: [`Bot ${tok(OK)}`] });
  } finally {
    state.done();
  }
});

for (const [label, envFile, botId, inheritedAll, reason] of [
  ["the configured bot", "DORI_DISCORD_CHANNEL=ok-channel\n", OK, true, `is bot ${ZZANG}, but this Dori is bot ${OK}`],
  ["the pair Dori's bot", `DORI_DISCORD_PAIR_BOT=${ZZANG}\n`, "", false, `is the pair Dori's bot ${ZZANG}`],
  ["the second pair Dori's bot in a comma list", `DORI_DISCORD_PAIR_BOT=${OK},${ZZANG}\n`, "", false, `is the pair Dori's bot ${ZZANG}`],
  ["the second pair Dori's bot in a whitespace list", `DORI_DISCORD_PAIR_BOT= ${OK} \t ${ZZANG} \n`, "", false, `is the pair Dori's bot ${ZZANG}`],
] as const) {
  test(`dori send refuses, before any request, a token that is not ${label}`, async () => {
    const state = withState();
    try {
      okdoriHome(state.dir, envFile, botId);
      const inherited = inheritedAll ? zzangEnv(state.dir) : { DORI_DISCORD_TOKEN: tok(ZZANG) };
      const r = await sendFrom(state.dir, { ...inherited, ...okSelectors(state.dir) });
      expect({ code: r.code, out: r.out, auth: r.auth }).toEqual({ code: 2, out: "", auth: [] });
      expect(r.err).toContain(`DISCORD_BOT_MISMATCH DORI_DISCORD_TOKEN ${reason}`);
    } finally {
      state.done();
    }
  });
}

test("an inherited value of the same Dori (a rotated token of the same bot included) still wins over its file; another Dori's instance values are dropped", async () => {
  const state = withState();
  try {
    const file = join(state.dir, "dori.env");
    writeFileSync(file, `DORI_DISCORD_TOKEN=${tok(OK)}\nDORI_DISCORD_CHANNEL=ok-channel\n`);
    const rotated = tok(OK).replace(".fake.token", ".rotated.secret");
    const same: Record<string, string | undefined> = { DORI_DISCORD_TOKEN: rotated, DORI_DISCORD_INBOX: "/override/inbox.jsonl" };
    const sameDropped = await loadEnvFile(file, same);
    const other: Record<string, string | undefined> = { ...zzangEnv(state.dir), DORI_KAKAO_SELF_ID: "another-account", DORI_CONFIG: "/ok/config.json", DORI_LEAD_PANE: "aoe_okdori_1", DORI_CLOSING_LANE: "lane", DORI_DISCORD_SHADOW_INBOX: "/shadow.jsonl" };
    const otherDropped = await loadEnvFile(file, other);
    expect({ same, sameDropped, other, otherDropped: otherDropped.sort() }).toEqual({
      same: { DORI_DISCORD_TOKEN: rotated, DORI_DISCORD_INBOX: "/override/inbox.jsonl", DORI_DISCORD_CHANNEL: "ok-channel" },
      sameDropped: [],
      other: { DORI_DISCORD_TOKEN: tok(OK), DORI_DISCORD_CHANNEL: "ok-channel", DORI_CONFIG: "/ok/config.json", DORI_LEAD_PANE: "aoe_okdori_1", DORI_CLOSING_LANE: "lane", DORI_DISCORD_SHADOW_INBOX: "/shadow.jsonl" },
      otherDropped: [...Object.keys(zzangEnv(state.dir)), "DORI_KAKAO_SELF_ID"].sort(),
    });
  } finally {
    state.done();
  }
});

test("aoe and tmux, which can start the tmux server every pane inherits from, run without any DORI_* variable", () => {
  const env = { PATH: "/bin", DORI_DISCORD_TOKEN: "t", DORI_CONFIG: "/c" };
  expect([childEnv(["tmux", "new-session"], env), childEnv(["/usr/bin/tmux", "ls"], env), childEnv(["aoe", "session", "start", "x"], env), childEnv(["git", "status"], env)]).toEqual([{ PATH: "/bin" }, { PATH: "/bin" }, { PATH: "/bin" }, env]);
});

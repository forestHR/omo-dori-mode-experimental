import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findLead, LeadError } from "../src/lead.ts";
import type { Runner } from "../src/run.ts";
import { fakeRunner, newWorld, withState } from "./fakes.ts";

const ID = "12345678-abcd";
const TMUX = "aoe_Dori_12345678";

test("lead uses a matching env id and env tmux before configured leadPane", async () => {
  const world = newWorld();
  const lead = await findLead(fakeRunner(world), { leadPane: "other-pane" }, { DORI_LEAD_TMUX: TMUX, DORI_LEAD_AOE_ID: ID });
  expect({ lead, calls: world.calls }).toEqual({ lead: `${ID} ${TMUX}`, calls: [["tmux", "has-session", "-t", `=${TMUX}`]] });
});

test("lead resolves a stale env id from aoe list using the configured pane", async () => {
  const world = newWorld();
  world.aoe = [{ id: ID, title: "Dori", path: "/repo" }];
  const lead = await findLead(fakeRunner(world), { leadPane: TMUX }, { DORI_LEAD_AOE_ID: "deadbeef-old" });
  expect({ lead, calls: world.calls }).toEqual({ lead: `${ID} ${TMUX}`, calls: [["tmux", "has-session", "-t", `=${TMUX}`], ["aoe", "list", "--json"]] });
});

test("lead refuses a missing pane or an unmatched aoe session", async () => {
  const world = newWorld();
  const missing = await findLead(fakeRunner(world), { leadPane: "" }, {}).catch((e: unknown) => e instanceof LeadError);
  const unmatched = await findLead(fakeRunner(world), { leadPane: TMUX }, {}).catch((e: unknown) => e instanceof LeadError);
  expect({ missing, unmatched }).toEqual({ missing: true, unmatched: true });
});

// at boot the lead's tmux session does not exist yet; dori-lead.service and dori.sh start it from this id
test("a lead whose tmux session is not running still resolves, marked stopped, from a matching env id or from aoe list", async () => {
  const noTmux = (aoe: object[]): Runner => async (argv) => (argv[0] === "tmux" ? { code: 1, out: "", err: "can't find session" } : argv[0] === "aoe" ? { code: 0, out: JSON.stringify(aoe), err: "" } : { code: 2, out: "", err: "" });
  const repro = "aoe_zzangdori_00000000";
  expect(await findLead(noTmux([{ id: "00000000aaaa", title: "zzangdori", path: "/home" }]), { leadPane: "" }, { DORI_LEAD_TMUX: repro, DORI_LEAD_AOE_ID: "8d429737ddd245c8" })).toBe(`00000000aaaa ${repro} stopped`);
  expect(await findLead(noTmux([]), { leadPane: TMUX }, { DORI_LEAD_AOE_ID: ID })).toBe(`${ID} ${TMUX} stopped`);
  expect(await findLead(noTmux([]), { leadPane: TMUX }, {}).catch((e: unknown) => (e as Error).message)).toBe(`no aoe session matches ${TMUX}`);
});

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

const executable = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
};

const leadCli = async (live: boolean, override = "") => {
  const bin = join(state.dir, "bin");
  mkdirSync(bin);
  executable(join(bin, "tmux"), `case "$*" in 'has-session -t =${TMUX}') exit ${live ? 0 : 1};; *) exit 2;; esac`);
  executable(join(bin, "aoe"), `case "$*" in 'list --json') printf '%s\\n' '[{"id":"${ID}","title":"Dori","path":"/repo"}]';; *) exit 2;; esac`);
  const config = join(state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ leadPane: override ? "wrong-pane" : TMUX }));
  const envFile = join(state.dir, "dori.env");
  writeFileSync(envFile, "DORI_LEAD_AOE_ID=deadbeef-old\n");
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DORI_CONFIG: config, DORI_ENV_FILE: envFile, DORI_STATE_DIR: state.dir, DORI_LEAD_TMUX: "", DORI_LEAD_AOE_ID: "" };
  // The env file must supply the stale id, not the host environment.
  delete env.DORI_LEAD_AOE_ID;
  if (override) env.DORI_LEAD_PANE = override;
  else delete env.DORI_LEAD_PANE;
  const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "lead"], { env, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out: out.trim(), err: err.trim() };
};

test("dori lead resolves a stale env-file id with fake aoe and tmux and honors DORI_LEAD_PANE", async () => {
  expect(await leadCli(true, TMUX)).toEqual({ code: 0, out: `${ID} ${TMUX}`, err: "" });
});

test("dori lead prints the stopped lead with exit 0 when fake tmux has no live session (boot)", async () => {
  expect(await leadCli(false)).toEqual({ code: 0, out: `${ID} ${TMUX} stopped`, err: "" });
});

test("the boot service executes the existing self-restart script in start mode", async () => {
  const bin = join(state.dir, "bin");
  mkdirSync(bin);
  const log = join(state.dir, "commands");
  const script = join(state.dir, ".dori/src/skills/dori-mode/setups/discord-aoe/self-restart.sh");
  mkdirSync(join(script, ".."), { recursive: true });
  executable(script, `printf '%s\\n' "self-restart.sh $*" >> "${log}"`);
  const service = readFileSync(join(import.meta.dir, "../../setups/discord-aoe/systemd/dori-lead.service"), "utf8");
  const command = (/^ExecStart=(.*)$/m.exec(service)?.[1] ?? "").replaceAll("%h", state.dir);
  const p = Bun.spawn(["bash", "-c", command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DORI_LEAD_AOE_ID: "stale" }, stdout: "pipe", stderr: "pipe" });
  expect({ code: await p.exited, commands: readFileSync(log, "utf8").trim().split("\n") }).toEqual({ code: 0, commands: ["self-restart.sh --start"] });
});

// a fake ~/.nvm: node in each version's bin, ~/.nvm/alias files as nvm writes them
const fakeNvm = (versions: string[], aliases: Record<string, string> = {}) => {
  const nvm = join(state.dir, ".nvm");
  for (const v of versions) {
    mkdirSync(join(nvm, "versions/node", v, "bin"), { recursive: true });
    executable(join(nvm, "versions/node", v, "bin/node"), "exit 0");
  }
  mkdirSync(join(nvm, "alias/lts"), { recursive: true });
  for (const [name, target] of Object.entries(aliases)) writeFileSync(join(nvm, "alias", name), `${target}\n`);
  return nvm;
};

const startScript = async (stopped: boolean, args: string[] = []) => {
  const bin = join(state.dir, ".bun/bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(state.dir, ".dori"));
  const log = join(state.dir, "commands");
  executable(join(bin, "dori"), `printf '%s\\n' "dori $*" >> "${log}"\n[ "$1" != lead ] || printf '%s\\n' '${ID} ${TMUX}${stopped ? " stopped" : ""}'`);
  executable(join(bin, "aoe"), `printf '%s\\n' "aoe $*" >> "${log}"`);
  executable(join(bin, "tmux"), `printf '%s\\n' '❯'`);
  executable(join(bin, "sleep"), "exit 0");
  executable(join(bin, "systemctl"), "exit 1");
  executable(join(bin, "agent"), "exit 0");
  fakeNvm(["v24.15.0"]);
  const p = Bun.spawn(["bash", join(import.meta.dir, "../../setups/discord-aoe/self-restart.sh"), ...args], {
    env: { ...process.env, HOME: state.dir, NVM_DIR: "", DORI_ENV_FILE: join(state.dir, "missing.env"), DORI_AGENT_BIN: "agent", DORI_LEAD_AOE_ID: "stale", DORI_LEAD_TMUX: "wrong" }, stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out: out.trim(), err: err.trim(), commands: readFileSync(log, "utf8").trim().split("\n"), logged: existsSync(join(state.dir, ".dori/self-restart.log")) };
};

test("start mode leaves an already running lead untouched", async () => {
  expect(await startScript(false, ["--start"])).toEqual({ code: 0, out: `LEAD_ALREADY_RUNNING ${TMUX}`, err: "", commands: ["dori lead"], logged: false });
});

test("start mode starts a stopped lead then submits the default first message", async () => {
  const result = await startScript(true, ["--start"]);
  expect(result).toEqual({ code: 0, out: "", err: "", commands: ["dori lead", `dori launch-env ${TMUX}`, `aoe session start ${ID}`, `dori type ${TMUX} --text Dori mode`], logged: true });
});

test("default mode still restarts the lead and submits an explicit first message", async () => {
  const result = await startScript(false, [ID, TMUX, "configured first message"]);
  expect(result).toEqual({ code: 0, out: "", err: "", commands: [`dori launch-env ${TMUX}`, `aoe session restart ${ID}`, `dori type ${TMUX} --text configured first message`], logged: true });
});

test("self-restart restarts the session with what dori launch-env prints: a launchEnv value set, another name removed even when the caller has it", async () => {
  const bin = join(state.dir, ".bun/bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(state.dir, ".dori"));
  const log = join(state.dir, "commands");
  executable(join(bin, "dori"), `[ "$1" != launch-env ] || printf '%s\\n' --unset=HIDE_ME CUDA_VISIBLE_DEVICES=`);
  executable(join(bin, "aoe"), `printf '%s\\n' "aoe $* cuda=\${CUDA_VISIBLE_DEVICES-unset} hide=\${HIDE_ME-unset}" >> "${log}"`);
  executable(join(bin, "tmux"), `printf '%s\\n' '❯'`);
  executable(join(bin, "sleep"), "exit 0");
  executable(join(bin, "systemctl"), "exit 1");
  executable(join(bin, "agent"), "exit 0");
  const p = Bun.spawn(["bash", join(import.meta.dir, "../../setups/discord-aoe/self-restart.sh"), ID, TMUX, ""], {
    env: { ...process.env, HOME: state.dir, DORI_ENV_FILE: join(state.dir, "missing.env"), DORI_AGENT_BIN: "agent", HIDE_ME: "from-caller" }, stdout: "pipe", stderr: "pipe",
  });
  expect({ code: await p.exited, commands: readFileSync(log, "utf8").trim().split("\n") }).toEqual({ code: 0, commands: [`aoe session restart ${ID} cuda= hide=unset`] });
});

test("self-restart gives the session no DORI_* variable and drops them from the tmux server's global environment first, all but the unit's config, env-file and state-dir paths", async () => {
  const bin = join(state.dir, ".bun/bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(state.dir, ".dori"));
  const log = join(state.dir, "commands");
  const envFile = join(state.dir, "dori.env");
  writeFileSync(envFile, "DORI_DISCORD_TOKEN=from-file\nDORI_DISCORD_INBOX=/zzang/inbox.jsonl\n");
  executable(join(bin, "dori"), `printf '%s\\n' "dori $*" >> "${log}"`);
  executable(join(bin, "aoe"), `printf '%s\\n' "aoe $* dori-vars=$(env | grep -c '^DORI_')" >> "${log}"`);
  executable(join(bin, "tmux"), `case "$1" in\n  show-environment) printf '%s\\n' DORI_CONFIG=/g/config.json DORI_DISCORD_TOKEN=leaked DORI_ENV_FILE=/g/dori.env DORI_LEAD_TMUX=aoe_zzangdori_1 DORI_STATE_DIR=/g/state PATH=/bin ;;\n  set-environment) printf '%s\\n' "tmux $*" >> "${log}" ;;\n  *) printf '%s\\n' '❯' ;;\nesac`);
  executable(join(bin, "sleep"), "exit 0");
  executable(join(bin, "systemctl"), "exit 1");
  executable(join(bin, "agent"), "exit 0");
  const p = Bun.spawn(["bash", join(import.meta.dir, "../../setups/discord-aoe/self-restart.sh"), ID, TMUX, ""], {
    env: { ...process.env, HOME: state.dir, DORI_ENV_FILE: envFile, DORI_AGENT_BIN: "agent", DORI_DISCORD_TOKEN: "inherited", DORI_DISCORD_STATE_DIR: "/zzang" }, stdout: "pipe", stderr: "pipe",
  });
  expect({ code: await p.exited, commands: readFileSync(log, "utf8").trim().split("\n") }).toEqual({
    code: 0,
    commands: [`dori launch-env ${TMUX}`, "tmux set-environment -g -u DORI_DISCORD_TOKEN", "tmux set-environment -g -u DORI_LEAD_TMUX", `aoe session restart ${ID} dori-vars=0`],
  });
});

// 2026-10-22: a GongDori lane window had no DORI_*, and a bare `dori send` found no ~/.dori/dori.env ("DORI_DISCORD_TOKEN is not set")
test("tmux-server gives the server the unit's DORI_CONFIG, DORI_ENV_FILE and DORI_STATE_DIR, started or adopted, and no other DORI_*", async () => {
  const log = join(state.dir, "commands");
  const fake = join(state.dir, "tmux");
  const holder = Bun.spawn(["cat"], { stdin: "pipe", stdout: "ignore" });
  executable(fake, `case "$1" in\n  display-message) [ -n "$SERVER" ] && printf '%s\\n' "$SERVER" ;;\n  -D) printf '%s\\n' "tmux -D $(env | grep '^DORI_' | sort | tr '\\n' ' ')" >> "${log}" ;;\n  *) printf '%s\\n' "tmux $*" >> "${log}" ;;\nesac`);
  const env = { PATH: process.env.PATH ?? "", TMUX_SERVER_BIN: fake, DORI_CONFIG: "/g/config.json", DORI_ENV_FILE: "/g/dori.env", DORI_STATE_DIR: "/g/state", DORI_DISCORD_TOKEN: "from-unit", DORI_LEAD_TMUX: "aoe_x" };
  const server = (pid: string) => Bun.spawn(["bash", join(import.meta.dir, "../../setups/discord-aoe/tmux-server")], { env: { ...env, SERVER: pid }, stdout: "pipe", stderr: "pipe" });
  const started = server("");
  const startedOut = { code: await started.exited, out: await new Response(started.stdout).text() };
  // the adopted server (holder) ends only after tmux-server has set the environment and is following it
  const adopted = server(String(holder.pid));
  const reader = adopted.stdout.getReader();
  let out = "";
  while (!out.includes("DORI_STATE_DIR\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    out += new TextDecoder().decode(chunk.value);
  }
  holder.stdin.end();
  const adoptedOut = { code: await adopted.exited, out };
  expect({ startedOut, adoptedOut, commands: readFileSync(log, "utf8").trim().split("\n") }).toEqual({
    startedOut: { code: 0, out: "TMUX_SERVER_START DORI_CONFIG DORI_ENV_FILE DORI_STATE_DIR\n" },
    adoptedOut: { code: 0, out: "TMUX_ENV_SET DORI_CONFIG\nTMUX_ENV_SET DORI_ENV_FILE\nTMUX_ENV_SET DORI_STATE_DIR\n" },
    commands: [
      "tmux -D DORI_CONFIG=/g/config.json DORI_ENV_FILE=/g/dori.env DORI_STATE_DIR=/g/state ",
      "tmux set-environment -g DORI_CONFIG /g/config.json",
      "tmux set-environment -g DORI_ENV_FILE /g/dori.env",
      "tmux set-environment -g DORI_STATE_DIR /g/state",
    ],
  });
});

test("self-restart starts the account's own tmux unit before aoe when that unit exists, so the server does not start in the caller's unit", async () => {
  const bin = join(state.dir, ".bun/bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(state.dir, ".dori"));
  const log = join(state.dir, "commands");
  executable(join(bin, "aoe"), `printf '%s\\n' "aoe $*" >> "${log}"`);
  executable(join(bin, "tmux"), `printf '%s\\n' '❯'`);
  executable(join(bin, "sleep"), "exit 0");
  executable(join(bin, "agent"), "exit 0");
  executable(join(bin, "systemctl"), `printf '%s\\n' "systemctl $*" >> "${log}"\n[ "$2" != cat ] || [ "$3" = qa-own-tmux.service ]`);
  const restart = async (unit: string) => {
    const p = Bun.spawn(["bash", join(import.meta.dir, "../../setups/discord-aoe/self-restart.sh"), ID, TMUX, ""], {
      env: { ...process.env, HOME: state.dir, DORI_ENV_FILE: join(state.dir, "missing.env"), DORI_AGENT_BIN: "agent", DORI_TMUX_UNIT: unit }, stdout: "pipe", stderr: "pipe",
    });
    return p.exited;
  };
  expect({ withUnit: await restart("qa-own-tmux.service"), without: await restart("qa-missing-tmux.service"), commands: readFileSync(log, "utf8").trim().split("\n") }).toEqual({
    withUnit: 0,
    without: 0,
    commands: ["systemctl --user cat qa-own-tmux.service", "systemctl --user start qa-own-tmux.service", `aoe session restart ${ID}`, "systemctl --user cat qa-missing-tmux.service", `aoe session restart ${ID}`],
  });
});

// 2026-11-04: the herdr branch started only dori-herdr.service (ZzangDori's name), so `--start` on SooDori, OkDori and
// the other accounts, whose server unit is <user>-herdr.service, left the herdr server down after a reboot
test("self-restart starts the account's herdr unit: DORI_HERDR_UNIT, else dori-herdr.service, else the one *-herdr.service; several or none start nothing and are logged", async () => {
  const run = async (name: string, units: string, env: Record<string, string> = {}) => {
    const home = join(state.dir, name);
    const bin = join(home, ".bun/bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(home, ".dori"));
    const log = join(home, "commands");
    writeFileSync(log, "");
    executable(join(bin, "systemctl"), `printf '%s\\n' "systemctl $*" >> "${log}"\ncase "$2" in\n  cat) for u in ${units}; do [ "$u" = "$3" ] && exit 0; done; exit 1 ;;\n  list-unit-files) for a; do p=$a; done; for u in ${units}; do case "$u" in $p) printf '%s enabled enabled\\n' "$u" ;; esac; done ;;\nesac`);
    executable(join(bin, "herdr"), "exit 0");
    executable(join(bin, "dori"), `printf '%s\\n' "dori $*" >> "${log}"`);
    executable(join(bin, "sleep"), "exit 0");
    const p = Bun.spawn(["bash", join(import.meta.dir, "../../setups/discord-aoe/self-restart.sh"), "--start", "sess-1", "w1:p1", ""], {
      env: { ...process.env, HOME: home, DORI_ENV_FILE: join(home, "missing.env"), DORI_HERDR_UNIT: "", ...env }, stdout: "pipe", stderr: "pipe",
    });
    const code = await p.exited;
    const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n") : []);
    return {
      code,
      started: lines(log).filter((l) => l.startsWith("systemctl --user start ")).map((l) => l.slice("systemctl --user start ".length)),
      logged: lines(join(home, ".dori/self-restart.log")).filter((l) => l.includes("HERDR_UNIT")).map((l) => l.replace(/^\S+ /, "")),
      revived: lines(log).includes("dori revive w1:p1 --text "),
    };
  };
  expect({
    env: await run("env", "qa-env-herdr.service dori-herdr.service", { DORI_HERDR_UNIT: "qa-env-herdr.service" }),
    envMissing: await run("env-missing", "dori-herdr.service", { DORI_HERDR_UNIT: "qa-missing.service" }),
    dori: await run("dori", "dori-herdr.service soodori-herdr.service"),
    own: await run("own", "herdr-web@.service herdr-web-yoodori.service okdori-herdr.service"),
    several: await run("several", "okdori-herdr.service moodori-herdr.service"),
    none: await run("none", "herdr-web@.service"),
  }).toEqual({
    env: { code: 0, started: ["qa-env-herdr.service"], logged: [], revived: true },
    envMissing: { code: 0, started: [], logged: ["HERDR_UNIT_MISSING qa-missing.service (DORI_HERDR_UNIT)"], revived: true },
    dori: { code: 0, started: ["dori-herdr.service"], logged: [], revived: true },
    own: { code: 0, started: ["okdori-herdr.service"], logged: [], revived: true },
    several: { code: 0, started: [], logged: ["HERDR_UNIT_AMBIGUOUS okdori-herdr.service moodori-herdr.service: set DORI_HERDR_UNIT"], revived: true },
    none: { code: 0, started: [], logged: ["HERDR_UNIT_NONE no dori-herdr.service or *-herdr.service"], revived: true },
  });
});

// omo runs memory reflection with #!/usr/bin/env node, and the pinned PATH has no nvm (it is set up in ~/.bashrc only)
test("self-restart puts nvm's default node on the session's PATH through the alias chain, else the newest version whose node runs", async () => {
  const bin = join(state.dir, ".bun/bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(state.dir, ".dori"));
  const log = join(state.dir, "commands");
  executable(join(bin, "aoe"), `printf '%s\\n' "aoe $* node=$(command -v node)" >> "${log}"`);
  executable(join(bin, "tmux"), `printf '%s\\n' '❯'`);
  executable(join(bin, "sleep"), "exit 0");
  executable(join(bin, "systemctl"), "exit 1");
  executable(join(bin, "agent"), "exit 0");
  const nvm = fakeNvm(["v22.22.2", "v24.15.0", "v25.1.0"], { default: "lts/*", "lts/*": "lts/krypton", "lts/krypton": "v24.15.0" });
  const restart = async () => {
    const p = Bun.spawn(["bash", join(import.meta.dir, "../../setups/discord-aoe/self-restart.sh"), ID, TMUX, ""], {
      env: { ...process.env, HOME: state.dir, NVM_DIR: "", DORI_ENV_FILE: join(state.dir, "missing.env"), DORI_AGENT_BIN: "agent" }, stdout: "pipe", stderr: "pipe",
    });
    return { code: await p.exited, err: (await new Response(p.stderr).text()).trim() };
  };
  const byAlias = await restart();
  rmSync(join(nvm, "alias/default"));
  const newest = await restart();
  chmodSync(join(nvm, "versions/node/v25.1.0/bin/node"), 0o600);
  const newestWorking = await restart();
  expect({ byAlias, newest, newestWorking, commands: readFileSync(log, "utf8").trim().split("\n") }).toEqual({
    byAlias: { code: 0, err: "" },
    newest: { code: 0, err: "" },
    newestWorking: { code: 0, err: "" },
    commands: [
      `aoe session restart ${ID} node=${nvm}/versions/node/v24.15.0/bin/node`,
      `aoe session restart ${ID} node=${nvm}/versions/node/v25.1.0/bin/node`,
      `aoe session restart ${ID} node=${nvm}/versions/node/v24.15.0/bin/node`,
    ],
  });
});

test("dori.sh starts and attaches the lead with aoe given no DORI_* variable", async () => {
  const bin = join(state.dir, "bin");
  mkdirSync(bin);
  const log = join(state.dir, "commands");
  executable(join(bin, "dori"), `printf '%s\\n' '${ID} ${TMUX}'`);
  executable(join(bin, "systemctl"), "exit 0");
  executable(join(bin, "aoe"), `printf '%s\\n' "aoe $* dori-vars=$(env | grep -c '^DORI_')" >> "${log}"`);
  const p = Bun.spawn(["bash", join(import.meta.dir, "../../setups/discord-aoe/dori.sh")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DORI_DISCORD_TOKEN: "inherited", DORI_CONFIG: "/c" }, stdout: "pipe", stderr: "pipe" });
  expect({ code: await p.exited, commands: readFileSync(log, "utf8").trim().split("\n") }).toEqual({ code: 0, commands: [`aoe session start ${ID} dori-vars=0`, `aoe session attach ${ID} dori-vars=0`] });
});

test("no-argument self-restart resolves dori lead before checking the agent, without restarting in the check", async () => {
  const bin = join(state.dir, ".bun/bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(state.dir, ".dori"));
  const log = join(state.dir, "commands");
  executable(join(bin, "dori"), `printf '%s\\n' "dori $*" >> "${log}"\n[ "$1" != lead ] || printf '%s\\n' '${ID} ${TMUX}'`);
  executable(join(bin, "aoe"), `printf '%s\\n' "aoe $*" >> "${log}"\nexit 2`);
  const p = Bun.spawn(["bash", join(import.meta.dir, "../../setups/discord-aoe/self-restart.sh")], {
    env: { ...process.env, HOME: state.dir, DORI_ENV_FILE: join(state.dir, "missing.env"), DORI_AGENT_BIN: "nonexistent-dori-test-agent", DORI_LEAD_AOE_ID: "stale", DORI_LEAD_TMUX: "wrong", DORI_DISCORD_CHANNEL: "fake" }, stdout: "pipe", stderr: "pipe",
  });
  const code = await p.exited;
  expect({ code, commands: readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" --")[0]) }).toEqual({ code: 1, commands: ["dori lead", "dori send discord"] });
});

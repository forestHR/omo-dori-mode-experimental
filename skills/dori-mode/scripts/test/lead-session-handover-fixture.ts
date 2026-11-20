import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { HandoverDeps } from "../src/handover.ts";
import { recordHerdrSession } from "../src/herdr-sessions.ts";
import type { Runner } from "../src/run.ts";
import { turnRunning } from "../src/submit.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

export const PANE = "w1:p1";
export const DATE = "2026-11-16";
export const OLD_ID = "11111111-2222-4333-8444-555555555555";
export const NEW_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const notePath = (stateDir: string): string => join(stateDir, "handover", `${DATE}.md`);
export const handoverLock = (stateDir: string): string => join(stateDir, "handover", "lock");

const sessionIdFrom = (line: string): string | undefined => {
  const encoded = [...line.matchAll(/FromBase64String\('([^']*)'\)/g)].map((match) => Buffer.from(match[1] ?? "", "base64").toString("utf8"));
  const at = encoded.indexOf("--session-id");
  if (at >= 0) return encoded[at + 1];
  return /(?:^|\s)--session-id\s+([0-9a-f-]+)/i.exec(line)?.[1];
};

export const createLeadSessionHandoverFixture = () => {
  const state = withState();
  const world: World = newWorld();
  let currentSession = OLD_ID;
  let rejectFreshStart = false;
  let rejectedFreshStart = false;
  let keepNewAgentAliveAfterCtrlD = false;
  let keepNewAgentTurnBusy = true;
  let changeNoteAfterFirstInput = false;
  const started: string[] = [];
  const printed: string[] = [];
  const stopEvents: { key: string; session: string }[] = [];

  const setup = (): HandoverDeps => {
    mkdirSync(join(state.dir, "handover"), { recursive: true });
    writeFileSync(notePath(state.dir), "Open work and next steps.\n");
    recordHerdrSession(state.dir, PANE, { session: OLD_ID, cwd: state.dir, model: "provider/model:high", at: new Date(0).toISOString() });
    world.panes = [{ pane_id: PANE, workspace_id: "w1", agent: "omo", cwd: state.dir }];
    world.screen = "────────\n❯ \n────────";
    world.ps = `4001 4000 omo --session-id ${OLD_ID} --model provider/model`;
    const base = depsFor(world, fakeClock(0), state.dir, {
      backend: "herdr",
      leadPane: PANE,
      sessionsDir: join(state.dir, "sessions"),
      agentCommand: ["omo", "--model", "{model}", "{prompt}"],
      defaultModel: "provider/model",
    });
    const baseRun = base.run;
    const run: Runner = async (argv, options) => {
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "send-keys" && argv.at(-1) === "esc") {
        stopEvents.push({ key: "esc", session: currentSession });
        world.started = world.started.filter((pane) => pane !== PANE);
        world.screens[PANE] = "────────\n❯ \n────────";
      }
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "send-keys" && argv.at(-1) === "ctrl+d") {
        stopEvents.push({ key: "ctrl+d", session: currentSession });
        if (!(keepNewAgentAliveAfterCtrlD && currentSession !== OLD_ID) && !turnRunning(world.screens[PANE] ?? world.screen)) {
          world.herdrDead = [PANE];
          world.ps = "4000 1 pwsh.exe";
        }
      }
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "run") {
        const session = sessionIdFrom(argv[4] ?? "");
        if (session) started.push(session);
        if (rejectFreshStart && !rejectedFreshStart && session !== OLD_ID) {
          rejectedFreshStart = true;
          world.calls.push([...argv]);
          return { code: 1, out: "", err: "injected new-session start failure" };
        }
        if (session) {
          currentSession = session;
          world.ps = `4001 4000 omo --session-id ${session} --model provider/model`;
        }
      }
      const result = await baseRun(argv, options);
      if (keepNewAgentTurnBusy && turnRunning(result.out)) world.screens[PANE] = result.out;
      if (changeNoteAfterFirstInput && argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "send-text") {
        changeNoteAfterFirstInput = false;
        writeFileSync(notePath(state.dir), "Changed during the session switch.\n");
      }
      return result;
    };
    return {
      ...base,
      run,
      configPath: join(state.dir, "config.json"),
      envPath: join(state.dir, "dori.env"),
      cardDir: join(state.dir, "discord"),
      inbox: join(state.dir, "inbox.jsonl"),
      home: state.dir,
      sessionOf: async (pane) => pane === PANE ? currentSession : "",
      routedPane: async () => PANE,
      envLeadPane: "",
      alive: (pid) => pid === process.pid,
      procs: async () => [],
      signal: () => true,
      realpath: (path) => path,
      timers: async () => [],
      restart: async () => undefined,
      nonce: () => "handover-test",
      print: (line) => printed.push(line),
    };
  };

  return {
    state,
    world,
    started,
    printed,
    stopEvents,
    setup,
    get currentSession(): string {
      return currentSession;
    },
    set rejectFreshStart(value: boolean) {
      rejectFreshStart = value;
    },
    set keepNewAgentAliveAfterCtrlD(value: boolean) {
      keepNewAgentAliveAfterCtrlD = value;
    },
    set busyNewSession(value: boolean) {
      keepNewAgentTurnBusy = value;
    },
    set changeNoteAfterFirstInput(value: boolean) {
      changeNoteAfterFirstInput = value;
    },
  };
};

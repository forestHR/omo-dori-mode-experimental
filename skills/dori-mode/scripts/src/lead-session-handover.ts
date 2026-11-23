import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { agentPath, herdrAgentArgv } from "./aoe.ts";
import type { HandoverDeps } from "./handover.ts";
import { takeLock } from "./handover-lock.ts";
import { alertMissingLeadSessionNote } from "./lead-session-missing-alert.ts";
import { liveMonitors, manifestPath, missingMonitors, readManifest } from "./handover.ts";
import { agentLine, herdrAgentPid, herdrSessions, requireHerdrPwsh } from "./herdr.ts";
import { argvSessionLog, omoInputBox, readHerdrSessions, recordHerdrSession, reviveHerdr } from "./herdr-sessions.ts";
import { expandHome } from "./config.ts";
import { memoryRepoFor } from "./directive-audit.ts";
import { splitModel } from "./lane-handover.ts";
import { omoSession, sendVerified } from "./panes.ts";
import { awaitPrompt } from "./launch.ts";
import { hasSessionSelector, argvSessionId } from "./session-id.ts";
import { appendRollover, COMMITTED, limitsFor, ownerRolloverText, reportToOwner, rolloverCause } from "./rollover.ts";
import { editorText, turnRunning } from "./submit.ts";
import { watchLog } from "./watch-log.ts";

export const LEAD_SESSION_HANDOVER_KEY = "lead-handover";

export type LeadSessionHandoverOptions = { readonly date: string; readonly dryRun: boolean; readonly originPane?: string };
export type LeadSessionHandoverResult = { readonly code: number };

export const leadSessionHandover = async (deps: HandoverDeps, opts: LeadSessionHandoverOptions): Promise<LeadSessionHandoverResult> => {
  const { config } = deps;
  const pane = config.leadPane;
  const at = new Date(deps.clock.now()).toISOString();
  const dir = join(config.stateDir, "handover");
  const file = join(dir, `${opts.date}.md`);
  const emit = (line: string): void => {
    deps.print(line);
    if (!opts.dryRun) watchLog(config.watchLog, deps.clock, { source: "handover", line });
  };
  const refuse = (reason: string): LeadSessionHandoverResult => {
    emit(`HANDOVER_FAIL ${reason}`);
    return { code: 2 };
  };
  const dateTime = Date.parse(`${opts.date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date) || !Number.isFinite(dateTime) || new Date(dateTime).toISOString().slice(0, 10) !== opts.date) {
    return refuse("--date must be a valid YYYY-MM-DD date");
  }
  let note: string;
  try {
    note = readFileSync(file, "utf8");
  } catch {
    emit(`HANDOVER_MISSING ${file}`);
    return { code: 2 };
  }
  if (!note.trim()) {
    emit(`HANDOVER_MISSING ${file} is empty`);
    return { code: 2 };
  }
  if (config.backend !== "herdr" || !pane.includes(":")) return refuse("weekly session handover requires the configured herdr lead pane");
  if (!omoSession(config)) return refuse("weekly session handover needs omo as the agent");
  if (deps.envLeadPane && deps.envLeadPane !== pane) return refuse(`DORI_LEAD_PANE=${deps.envLeadPane} does not match configured leadPane ${pane}`);
  if (!opts.dryRun && opts.originPane === pane) return refuse(`run this command from the Dori wrapper outside its target pane ${pane}`);
  if (hasSessionSelector(config.agentCommand.slice(1))) return refuse(`agentCommand selects its own session (${config.agentCommand.join(" ")}); handover needs an agentCommand without a session selector`);
  const old = readHerdrSessions(config.stateDir)[pane];
  if (!old || !argvSessionId(["--session-id", old.session])) return refuse(`no valid omo session is recorded for ${pane}`);
  const oldManifest = manifestPath(config.sessionsDir, old.cwd, old.session);
  const monitors = liveMonitors(readManifest(oldManifest), deps.clock.now(), deps.alive, deps.home);
  const check = async (): Promise<string | undefined> => {
    if (!(await herdrSessions(deps.run)).some((session) => session.pane === pane)) return `herdr has no pane ${pane}`;
    if (!(await herdrAgentPid(deps.run, pane))) return `no live omo agent in ${pane}`;
    const liveId = await deps.sessionOf(pane, old.cwd);
    if (liveId !== old.session) return `the recorded session ${old.session} does not match the live session ${liveId || "unknown"} in ${pane}`;
    const screen = await deps.run(["herdr", "pane", "read", pane, "--source", "visible"]);
    if (screen.code !== 0) return `could not read the OMO input screen in ${pane}; refusing to stop the session`;
    if (!omoInputBox(screen.out)) return `no recognizable OMO input box is visible in ${pane}; refusing to stop the session`;
    if (turnRunning(screen.out)) return `the lead has an active turn in ${pane}`;
    if (editorText(screen.out)) return `the input box in ${pane} is not empty`;
    return undefined;
  };
  const verified = await check().catch((error: unknown) => error instanceof Error ? error.message : String(error));
  if (verified) return refuse(verified);
  if (opts.dryRun) {
    deps.print(`HANDOVER_DRY_RUN would replace session ${old.session} with a new session id in ${pane}, then submit the handover file ${file}`);
    return { code: 0 };
  }
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "lock");
  const busy = takeLock(lock, deps.alive, at, "lead session handover");
  if (busy) return refuse(busy);
  let stopAttempted = false;
  const waitForAgentExit = async (): Promise<boolean> => {
    for (let i = 0; i < 40; i++) {
      if (!(await herdrAgentPid(deps.run, pane))) return true;
      await deps.clock.sleep(250);
    }
    return !(await herdrAgentPid(deps.run, pane));
  };
  const restoreOld = async (reason: string): Promise<LeadSessionHandoverResult> => {
    let recovery = "";
    try {
      const liveSession = await deps.sessionOf(pane, old.cwd);
      if (liveSession && liveSession !== old.session) {
        let stopped = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!(await herdrAgentPid(deps.run, pane))) { stopped = true; break; }
          const screen = await deps.run(["herdr", "pane", "read", pane, "--source", "visible"]);
          if (screen.code !== 0) throw new Error(`could not read the OMO input screen in ${pane}`);
          if (!omoInputBox(screen.out)) throw new Error(`no recognizable OMO input box is visible in ${pane}`);
          if (turnRunning(screen.out)) {
            const interrupted = await deps.run(["herdr", "pane", "send-keys", pane, "esc"]);
            if (interrupted.code !== 0) throw new Error(`could not interrupt the new OMO turn: ${interrupted.err || interrupted.out}`);
            let idle = false;
            for (let i = 0; i < 40; i++) {
              if (!(await herdrAgentPid(deps.run, pane))) { stopped = true; break; }
              const afterInterrupt = await deps.run(["herdr", "pane", "read", pane, "--source", "visible"]);
              if (afterInterrupt.code !== 0) throw new Error(`could not read the OMO input screen in ${pane}`);
              if (!omoInputBox(afterInterrupt.out)) throw new Error(`no recognizable OMO input box is visible in ${pane}`);
              if (!turnRunning(afterInterrupt.out)) { idle = true; break; }
              await deps.clock.sleep(250);
            }
            if (stopped) break;
            if (!idle) continue;
          }
          const exited = await deps.run(["herdr", "pane", "send-keys", pane, "ctrl+d"]);
          if (exited.code !== 0) throw new Error(`could not exit the new OMO session: ${exited.err || exited.out}`);
          if (await waitForAgentExit()) { stopped = true; break; }
        }
        if (!stopped && await herdrAgentPid(deps.run, pane)) throw new Error("the new OMO session did not stop after 3 bounded Esc and Ctrl+D attempts");
      }
      if (readHerdrSessions(config.stateDir)[pane]?.session !== old.session) recordHerdrSession(config.stateDir, pane, old);
      const revived = await reviveHerdr(
        deps.run,
        deps.clock,
        config,
        pane,
        "",
        (target, text) => sendVerified(deps.run, deps.clock, config, target, text),
      );
      if (!revived.startsWith(`REVIVE_OK ${pane} session ${old.session}`)) throw new Error(revived);
      if (await deps.sessionOf(pane, old.cwd) !== old.session) throw new Error("the resumed pane does not run the recorded old session");
      recovery = `; old session ${old.session} restored`;
    } catch (error) {
      const recordedSession = readHerdrSessions(config.stateDir)[pane]?.session ?? "missing";
      recovery = `; old session recovery failed: ${error instanceof Error ? error.message : String(error)}; record now names ${recordedSession}`;
    }
    emit(`HANDOVER_FAIL ${reason}${recovery}`);
    return { code: 3 };
  };
  try {
    let lockedNote: string;
    try {
      lockedNote = readFileSync(file, "utf8");
    } catch {
      emit(`HANDOVER_MISSING ${file}`);
      return { code: 2 };
    }
    if (!lockedNote.trim()) {
      emit(`HANDOVER_MISSING ${file} is empty`);
      return { code: 2 };
    }
    if (lockedNote !== note) return refuse(`the handover file ${file} changed during preflight; retry with the final note`);
    await requireHerdrPwsh(deps.run, pane);
    const model = old.model ?? config.defaultModel;
    const { base, thinking } = splitModel(model);
    const session = randomUUID();
    const argv = herdrAgentArgv(config.agentCommand, base, thinking, session);
    const clear = process.platform === "win32" ? "Clear-Host; " : "clear && ";
    const agent = `${clear}${agentLine(argv, { PATH: agentPath(config.agentCommand[0] ?? "omo") })}`;
    const stillSafe = await check().catch((error: unknown) => error instanceof Error ? error.message : String(error));
    if (stillSafe) return refuse(stillSafe);
    stopAttempted = true;
    const launch = await deps.run(["herdr", "pane", "send-keys", pane, "ctrl+d"]);
    if (launch.code !== 0) return await restoreOld(`could not end the old agent in ${pane}: ${launch.err || launch.out}`);
    const oldStopped = await waitForAgentExit();
    if (!oldStopped) return await restoreOld(`the old agent did not stop in ${pane}; no new session was started`);
    const started = await deps.run(["herdr", "pane", "run", pane, agent]);
    if (started.code !== 0) return await restoreOld(`could not start the new session in ${pane}: ${started.err || started.out}`);
    const startup = await awaitPrompt(deps, pane);
    if (startup) return await restoreOld(`the new session did not become ready: ${startup}`);
    if (await deps.sessionOf(pane, old.cwd) !== session) return await restoreOld(`the live session id in ${pane} did not become ${session}`);
    const worklog = join(config.stateDir, "worklog.md");
    const memory = config.directives.memory ? expandHome(config.directives.memory, deps.home) : memoryRepoFor(old.cwd, deps.home);
    const ledgers = [config.directives.common, config.directives.local, config.directives.links].filter((path): path is string => typeof path === "string" && path.length > 0).map((path) => expandHome(path, deps.home));
    const ledger = ledgers.length ? ` (${ledgers.join(", ")})` : " with dori directives";
    const monitorInstruction = monitors.length
      ? ` If the old session had live OMO monitors, read its manifest at ${oldManifest} and re-arm them as persistent watches; do not restart launched work, use watch-only monitors for it, and check the watches before continuing.`
      : "";
    const firstInput = `Read the handover file at ${file} in full. Before responding or acting, first read the directive ledger${ledger}, memory (${memory}), and work records (${worklog}; run dori worklog list --open).${monitorInstruction}`;
    if (!(await sendVerified(deps.run, deps.clock, config, pane, firstInput))) return await restoreOld(`the first message did not register in ${pane}`);
    let committedNote: string;
    try {
      committedNote = readFileSync(file, "utf8");
    } catch {
      return await restoreOld(`the handover file ${file} disappeared before commit`);
    }
    if (!committedNote.trim() || committedNote !== lockedNote) return await restoreOld(`the handover file ${file} changed before commit`);
    if (monitors.length) {
      const newManifest = manifestPath(config.sessionsDir, old.cwd, session);
      let missing = monitors.map((monitor) => monitor.description || monitor.command || monitor.path || "unknown");
      const tries = Math.max(1, Math.ceil((config.handover.verifyMin * 60_000) / 5_000));
      for (let i = 0; i < tries; i++) {
        missing = missingMonitors(monitors, readManifest(newManifest), deps.alive, deps.home, deps.clock.now());
        if (!missing.length) break;
        await deps.clock.sleep(5_000);
      }
      if (missing.length) return await restoreOld(`new session monitors are not running: ${missing.join(", ")}`);
    }
    const log = argvSessionLog(argv, config.sessionsDir, old.cwd, session);
    const newRecord = { session, cwd: old.cwd, model: `${base}${thinking ? `:${thinking}` : ""}`, ...(log ? { log } : {}), at: new Date(deps.clock.now()).toISOString() };
    recordHerdrSession(config.stateDir, pane, newRecord);
    emit(`HANDOVER_OK ${LEAD_SESSION_HANDOVER_KEY} ${old.session} -> ${session} ${file}`);
    return { code: 0 };
  } catch (error) {
    if (stopAttempted) return await restoreOld(error instanceof Error ? error.message : String(error));
    return refuse(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(lock, { force: true });
  }
};

export type AutomaticLeadSessionHandoverResult = { readonly code: number; readonly line: string };

export const automaticLeadSessionHandover = async (deps: HandoverDeps, originPane?: string): Promise<AutomaticLeadSessionHandoverResult> => {
  const at = new Date(deps.clock.now()).toISOString();
  const date = at.slice(0, 10);
  const lines: string[] = [];
  const automaticDeps = { ...deps, print: (line: string) => lines.push(line) };
  const result = await leadSessionHandover(automaticDeps, { date, dryRun: false, ...(originPane ? { originPane } : {}) });
  const statusLine = lines.find((line) => line.startsWith("HANDOVER_OK") || line.startsWith("HANDOVER_FAIL") || line.startsWith("HANDOVER_MISSING"))
    ?? `HANDOVER_FAIL automatic handover for ${date} returned ${result.code} without a status line`;
  const failedLine = result.code === 0 ? undefined : statusLine;
  if (failedLine?.startsWith("HANDOVER_MISSING")) await alertMissingLeadSessionNote(deps, date);
  const ownerReport = result.code === 0
    ? await reportToOwner(
      automaticDeps,
      "lead",
      null,
      ownerRolloverText({ who: "lead", cause: rolloverCause("auto:handover.autoRolloverLead", {}, limitsFor("lead", deps.config.handover)) }, deps.config.discord.locale),
      (line) => lines.push(line),
    )
    : undefined;
  appendRollover(deps.config.stateDir, {
    kind: "rollover",
    who: "lead",
    at: new Date(deps.clock.now()).toISOString(),
    key: "lead",
    from: deps.config.leadPane,
    ...(result.code === 0 ? { to: deps.config.leadPane } : {}),
    approvedBy: "auto:handover.autoRolloverLead",
    decidedBy: "auto",
    signals: {},
    steps: [],
    result: result.code === 0 ? COMMITTED : result.code === 2 ? "refused" : "rolled-back",
    reasons: failedLine ? [failedLine] : [],
    ...(ownerReport ? { ownerReport } : {}),
  });
  return { code: result.code, line: statusLine };
};

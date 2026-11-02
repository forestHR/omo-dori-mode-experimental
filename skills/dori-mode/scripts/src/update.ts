import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DoriConfig } from "./config.ts";
import { takeLock } from "./handover.ts";
import { pidAlive } from "./heavy-slot.ts";
import { configKeys, knownConfigKeys } from "./config-keys.ts";
import type { Clock, Runner } from "./run.ts";
import { restartService } from "./update-ready.ts";
import { watchLog } from "./watch-log.ts";
import { announceChange, guidanceFiles, mergeTitles } from "./update-announce.ts";

export type UpdateState = { readonly applied: string; readonly keys: readonly string[] };
export type UpdateDeps = {
  readonly config: DoriConfig;
  readonly configPath: string;
  readonly git: Runner;
  readonly systemctl: Runner;
  readonly clock: Clock;
  readonly send: (pane: string, text: string) => Promise<boolean>;
  readonly print: (line: string) => void;
};
export type UpdateOptions = { readonly pull: boolean; readonly dryRun: boolean };
export class UpdateError extends Error {}

const readState = async (path: string): Promise<UpdateState | undefined> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  const value: unknown = await file.json();
  if (value !== null && typeof value === "object" && "applied" in value && "keys" in value &&
      typeof value.applied === "string" && Array.isArray(value.keys) && value.keys.every((key: unknown) => typeof key === "string")) {
    return { applied: value.applied, keys: value.keys };
  }
  throw new UpdateError(`invalid update state: ${path}`);
};

// One update at a time per stateDir: a manual `dori update --pull` moves the branch ref, which starts
// dori-update.service at the same moment (10-16 12:02Z: both read the old applied SHA, restarted twice
// and announced twice). A run waits for state/update.lock (a dead holder's lock is taken over), then
// reads HEAD and update.json; HEAD already applied by the run it waited for prints UPDATE_SKIP, a newer
// HEAD is applied, so no commit is missed. Returns true when it had to wait.
const waitForLock = async (deps: UpdateDeps, file: string): Promise<boolean> => {
  const { config, clock } = deps;
  const deadline = clock.now() + (config.update.readyTimeoutSec * config.update.services.length + 300) * 1000;
  for (let waited = false; ; waited = true) {
    const busy = takeLock(file, pidAlive, new Date(clock.now()).toISOString(), "dori update");
    if (!busy) return waited;
    if (clock.now() >= deadline) throw new UpdateError(`update lock: ${busy}`);
    await clock.sleep(250);
  }
};

export const applyUpdate = async (deps: UpdateDeps, options: UpdateOptions): Promise<boolean> => {
  const { config } = deps;
  if (options.dryRun) return applyLocked(deps, options, false);
  mkdirSync(config.stateDir, { recursive: true });
  const lock = join(config.stateDir, "update.lock");
  let waited: boolean;
  try {
    waited = await waitForLock(deps, lock);
  } catch (error) {
    if (!(error instanceof UpdateError)) throw error;
    return applyLocked(deps, options, false, error);
  }
  try {
    return await applyLocked(deps, options, waited);
  } finally {
    rmSync(lock, { force: true });
  }
};

const applyLocked = async (deps: UpdateDeps, options: UpdateOptions, waited: boolean, lockError?: UpdateError): Promise<boolean> => {
  const { config } = deps;
  const emit = (line: string): void => {
    deps.print(options.dryRun ? `DRY_RUN ${line}` : line);
    if (!options.dryRun) watchLog(config.watchLog, deps.clock, { source: "update", line });
  };
  const git = async (args: readonly string[]): Promise<string> => {
    const result = await deps.git(["git", "-C", config.update.repo, ...args], { timeoutMs: 60_000 });
    if (result.code !== 0) throw new UpdateError(`git ${args[0]}: ${result.err || result.out || `exit ${result.code}`}`);
    return result.out;
  };
  try {
    if (lockError) throw lockError;
    // The path unit also fires when a lane checks out another branch or an old commit in this clone (10-24: a lane's
    // switch to 909b014 restarted dori-inbound and dori-lanes on code without #179). Only update.branch is applied,
    // and it is not pulled from elsewhere; back on that branch the next run applies its HEAD as usual.
    const onBranch = await deps.git(["git", "-C", config.update.repo, "symbolic-ref", "-q", "--short", "HEAD"], { timeoutMs: 60_000 });
    if (onBranch.code > 1) throw new UpdateError(`git symbolic-ref: ${onBranch.err || onBranch.out || `exit ${onBranch.code}`}`);
    const current = onBranch.code === 0 ? onBranch.out : "";
    if (current !== config.update.branch) {
      emit(`UPDATE_SKIPPED off-main ${current || "detached"} at ${(await git(["rev-parse", "HEAD"])).slice(0, 7)}: only ${config.update.branch} is applied`);
      return true;
    }
    if (options.pull && !options.dryRun) await git(["pull", "--ff-only"]);
    if (options.pull && options.dryRun) deps.print("DRY_RUN git pull --ff-only (not executed)");
    const head = await git(["rev-parse", "HEAD"]);
    const path = join(config.stateDir, "update.json");
    const state = await readState(path);
    const keys = knownConfigKeys();
    if (state?.applied === head && waited) { emit(`UPDATE_SKIP ${head.slice(0, 7)} already applied by the dori update this run waited for`); return true; }
    if (state?.applied === head) { deps.print("UP_TO_DATE"); return true; }
    // A branch moved back (a reset, or the path unit reading a ref mid-switch) never runs older code than it applied.
    if (state && (await deps.git(["git", "-C", config.update.repo, "merge-base", "--is-ancestor", head, state.applied], { timeoutMs: 60_000 })).code === 0) {
      emit(`UPDATE_SKIPPED behind ${head.slice(0, 7)} is an ancestor of applied ${state.applied.slice(0, 7)}`);
      return true;
    }
    const save = async (): Promise<void> => {
      if (options.dryRun) return;
      mkdirSync(config.stateDir, { recursive: true });
      await Bun.write(path, `${JSON.stringify({ applied: head, keys }, null, 2)}\n`);
    };
    if (!state) {
      await save();
      emit(`UPDATED first-run ${head.slice(0, 7)}`);
      return true;
    }
    const file = Bun.file(deps.configPath);
    const raw: unknown = await file.exists() ? await file.json() : {};
    const set = new Set(configKeys(raw));
    const newKeys = keys.filter((key) => !state.keys.includes(key) && !set.has(key));
    const notices = newKeys.map((key) => `CONFIG_NEW_KEY ${key} unset in ${deps.configPath} (default used)`);
    const changed = (await git(["diff", "--name-only", state.applied, head])).split("\n").filter(Boolean);
    const range = `${state.applied}..${head}`;
    const titles = mergeTitles(await git(["log", "--merges", "--format=%s%n%b", "-z", range]));
    const summary = (titles.length ? titles : (await git(["log", "--format=%s", range])).split("\n").filter(Boolean)).join("\n");
    const restarted: string[] = [];
    const failures: string[] = [];
    const results: string[] = [];
    for (const line of notices) emit(line);
    for (const service of config.update.services) {
      if (!service.paths.some((prefix) => changed.some((name) => name.startsWith(prefix)))) continue;
      if (options.dryRun) { deps.print(`DRY_RUN restart ${service.unit} ${head.slice(0, 7)}`); continue; }
      let reason: string | undefined;
      try {
        reason = await restartService({ systemctl: deps.systemctl, clock: deps.clock, timeoutSec: config.update.readyTimeoutSec }, service);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        reason = error.message;
      }
      if (reason) {
        const line = `RESTART_FAIL ${service.unit} ${reason}`;
        failures.push(line);
        results.push(line);
        emit(line);
      } else {
        restarted.push(service.unit);
        const line = `RESTARTED ${service.unit} ${head.slice(0, 7)}`;
        results.push(line);
        emit(line);
      }
    }
    await save();
    emit(`UPDATED ${state.applied.slice(0, 7)}..${head.slice(0, 7)} changed=${changed.length} restarted=${restarted.join(",") || "-"}`);
    if (!options.dryRun) await announceChange(deps, { summary: summary || `${state.applied.slice(0, 7)}..${head.slice(0, 7)}`, files: guidanceFiles(changed), keys: newKeys, restarts: results.length ? results : ["No configured services matched changed paths."], shared: true });
    if (failures.length && config.update.alertPane) {
      const text = `[ALERT] dori update: ${[...failures, ...notices].join("; ")}`;
      if (!(await deps.send(config.update.alertPane, text))) emit(`UPDATE_FAIL alert did not reach ${config.update.alertPane}`);
    }
    return failures.length === 0;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const line = `UPDATE_FAIL ${error.message}`;
    emit(line);
    if (!options.dryRun && config.update.alertPane) {
      try {
        if (!(await deps.send(config.update.alertPane, `[ALERT] dori update: ${line}`))) emit(`UPDATE_FAIL alert did not reach ${config.update.alertPane}`);
      } catch (sendError) {
        if (!(sendError instanceof Error)) throw sendError;
        emit(`UPDATE_FAIL alert: ${sendError.message}`);
      }
    }
    return false;
  }
};

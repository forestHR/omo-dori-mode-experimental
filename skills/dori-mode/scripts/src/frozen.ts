// A lead replaced by dori handover is frozen once the move is committed: SIGSTOP on its agent and every process under it,
// so it spends no tokens and does nothing, while its pane and its conversation log (JSONL) stay for the next supplement or
// a look back. One record per frozen pane says what was stopped. dori handover thaw <pane> resumes it (frozen by mistake),
// dori handover close-frozen closes it, and freshness closes each one handover.frozenCloseH hours after it was frozen.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { closeAoeSession, isClosedLine, liveSessions, sessionFor, tmuxPanePid } from "./aoe.ts";
import type { Runner } from "./run.ts";
import { descendants, ended, type Proc, topAgent } from "./session-id.ts";

export type Sig = "SIGSTOP" | "SIGCONT";

export type FrozenRecord = {
  readonly pane: string;
  readonly aoeId: string;
  readonly at: string;
  readonly agentPid: number;
  // the agent first, then every process under it
  readonly pids: readonly number[];
  // when freshness closes it; absent: it stays until closed by hand (--keep-old, or handover.frozenCloseH 0)
  readonly closeAt?: string;
  // work a monitor of the old session started (handover.ts monitorWork): it runs on, left unstopped, and the session closes
  // on the first freshness tick after every one of these pids ended, whatever closeAt says; closing it earlier ends them
  readonly keepFor?: readonly number[];
  // the lead that replaced it
  readonly to?: string;
  readonly session?: string;
  readonly oldLog?: string;
};

export type FreezeDeps = {
  readonly run: Runner;
  readonly procs: () => Promise<Proc[]>;
  readonly signal: (pid: number, sig: Sig) => boolean;
};

// One transaction may stop the agent before expanding the freeze to its children.
// Native Windows stop counts stack, so only the first successful stop reaches the OS.
export const freezeSignal = <S extends string>(signal: (pid: number, sig: S) => boolean): ((pid: number, sig: S) => boolean) => {
  const suspended = new Set<number>();
  return (pid, sig) => {
    if (sig === "SIGSTOP" && suspended.has(pid)) return true;
    const sent = signal(pid, sig);
    if (sent && sig === "SIGSTOP") suspended.add(pid);
    if (sent && sig === "SIGCONT") suspended.delete(pid);
    return sent;
  };
};

const frozenDir = (stateDir: string): string => join(stateDir, "handover", "frozen");
export const frozenFile = (stateDir: string, pane: string): string => join(frozenDir(stateDir), `${pane.replace(/[^\w.-]/g, "_")}.json`);

export const readFrozen = (stateDir: string): FrozenRecord[] => {
  const dir = frozenDir(stateDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".json")).flatMap((n) => {
    try {
      return [JSON.parse(readFileSync(join(dir, n), "utf8")) as FrozenRecord];
    } catch {
      return [];
    }
  });
};

// panes sync and dead-panes leave alone: a frozen old lead is neither an unregistered session nor a dead one
export const frozenPanes = (stateDir: string): string[] => readFrozen(stateDir).map((r) => r.pane);

// The session that replaced a frozen pane, followed through later handovers (a lead replaced twice), else undefined. A
// text typed into a frozen agent lands in its tty and is read by no one, so dori type sends it here instead
// (2026-10-31: a lane told nothing of a lead handover sent two reports into the frozen old lead).
// A frozen session closed before its close time (the audit passed, or closed by hand) keeps forwarding until that time:
// a lane told of the lead change only by the 20-minute escalation still reaches the new lead (review #321).
export const replacementOf = (stateDir: string, pane: string, now = Date.now()): string | undefined => {
  const next = new Map([...readForwards(stateDir).filter((f) => Date.parse(f.until) > now), ...readFrozen(stateDir)].flatMap((r) => (r.to ? [[r.pane, r.to] as const] : [])));
  let at = next.get(pane);
  for (const seen = new Set([pane]); at && next.has(at) && !seen.has(at); at = next.get(at)) seen.add(at);
  return at;
};

// pane -> the session that replaced it, until the closed frozen record's own close time
type Forward = { readonly pane: string; readonly to: string; readonly until: string };
const forwardDir = (stateDir: string): string => join(stateDir, "handover", "forward");
const forwardFile = (stateDir: string, pane: string): string => join(forwardDir(stateDir), `${pane.replace(/[^\w.-]/g, "_")}.json`);
const readForwards = (stateDir: string): Forward[] => {
  const dir = forwardDir(stateDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".json")).flatMap((n) => {
    try {
      return [JSON.parse(readFileSync(join(dir, n), "utf8")) as Forward];
    } catch {
      return [];
    }
  });
};

// Written before any close attempt, so neither a failed close nor its retry (which sets closeAt to now) can lose it:
// the forwarding lasts until the record would have been closed by the clock (review #321).
const keepForwarding = (stateDir: string, rec: FrozenRecord, now: number): void => {
  if (!rec.to || !rec.closeAt || Date.parse(rec.closeAt) <= now || existsSync(forwardFile(stateDir, rec.pane))) return;
  mkdirSync(forwardDir(stateDir), { recursive: true });
  writeFileSync(forwardFile(stateDir, rec.pane), JSON.stringify({ pane: rec.pane, to: rec.to, until: rec.closeAt } satisfies Forward));
};

export const writeFrozen = (stateDir: string, rec: FrozenRecord): void => {
  mkdirSync(frozenDir(stateDir), { recursive: true });
  writeFileSync(frozenFile(stateDir, rec.pane), JSON.stringify(rec, null, 1));
};

// The agent of a pane and every process under it, the agent first. The caller and its ancestors are left out, so a run
// inside that pane does not stop itself, and so is spare (monitors whose work must go on) with everything under it.
export const agentTree = (table: readonly Proc[], shellPid: number, self: number, spare: readonly number[] = []): { readonly agent?: Proc; readonly pids: number[] } => {
  const agent = topAgent(table, shellPid);
  if (!agent) return { pids: [] };
  const mine = new Set<number>();
  const parent = new Map(table.map((p) => [p.pid, p.ppid]));
  for (let p: number | undefined = self; p && !mine.has(p); p = parent.get(p)) mine.add(p);
  for (const root of spare) for (const p of [root, ...descendants(table, root).map((d) => d.pid)]) mine.add(p);
  return { agent, pids: [agent.pid, ...descendants(table, agent.pid).map((p) => p.pid)].filter((p) => !mine.has(p)) };
};

// Stops the pane's agent and everything under it. pids: those stopped; why: the reason nothing could be stopped.
export const freezePane = async (deps: FreezeDeps, pane: string, self: number, spare: readonly number[] = []): Promise<{ readonly agentPid?: number; readonly pids: number[]; readonly why?: string }> => {
  const shell = await tmuxPanePid(deps.run, pane);
  if (!shell) return { pids: [], why: `no tmux pane ${pane}` };
  const { agent, pids } = agentTree(await deps.procs(), shell, self, spare);
  if (!agent) return { pids: [], why: `no agent process under ${pane} (shell ${shell})` };
  if (!pids.includes(agent.pid)) return { pids: [], why: `the agent ${agent.pid} runs this command, so it cannot stop itself` };
  // the agent first: once it is stopped it cannot start anything new while its children are stopped
  const stopped = pids.filter((p) => deps.signal(p, "SIGSTOP"));
  return stopped.includes(agent.pid) ? { agentPid: agent.pid, pids: stopped } : { pids: stopped, why: `SIGSTOP to the agent ${agent.pid} failed` };
};

// Resumes in reverse order: the children before the agent, so the agent finds them running.
const resume = (deps: Pick<FreezeDeps, "signal">, rec: FrozenRecord): number => [...new Set(rec.pids)].reverse().filter((p) => deps.signal(p, "SIGCONT")).length;

export const thawFrozen = (deps: Pick<FreezeDeps, "signal">, stateDir: string, pane: string): string => {
  // Thaw does not restore ended monitors: the new lead already owns their replacements.
  const rec = readFrozen(stateDir).find((r) => r.pane === pane);
  if (!rec) return `FROZEN_NONE ${pane}: no frozen session recorded for this pane (dori handover frozen lists them)`;
  const n = resume(deps, rec);
  rmSync(frozenFile(stateDir, pane), { force: true });
  // running again: texts for it stay with it
  rmSync(forwardFile(stateDir, pane), { force: true });
  return `HANDOVER_OLD_THAWED ${pane}: ${n}/${new Set(rec.pids).size} processes resumed (agent ${rec.agentPid})`;
};

// Closes a frozen session: resumed first (a stopped process does not act on the hangup), then stopped and trashed with
// aoe. Its conversation log is not touched. A close that fails stops it again, so the old and the new lead never both run,
// and one the clock closes is due again at once, so the next freshness tick tries again (review #321).
export const closeFrozen = async (deps: FreezeDeps, stateDir: string, rec: FrozenRecord, now = Date.now()): Promise<string> => {
  keepForwarding(stateDir, rec, now);
  const due = (): void => {
    if (rec.closeAt) writeFrozen(stateDir, { ...rec, closeAt: new Date(now).toISOString() });
  };
  const retry = rec.closeAt ? "the next freshness tick tries again" : `dori handover close-frozen ${rec.pane} tries again`;
  let open;
  try {
    open = sessionFor(await liveSessions(deps.run), rec.pane);
  } catch (e) {
    due();
    return `HANDOVER_OLD_CLOSE_FAIL ${rec.pane}: the sessions could not be listed (${e instanceof Error ? e.message : String(e)}); still frozen, ${retry}`;
  }
  if (!open) {
    rmSync(frozenFile(stateDir, rec.pane), { force: true });
    return `HANDOVER_OLD_GONE ${rec.pane}: the frozen session is no longer open; record removed`;
  }
  resume(deps, rec);
  // from here on the old session runs: a close that throws is met like one that failed
  const closed = await closeAoeSession(deps.run, rec.pane).catch((e: unknown) => `close threw: ${e instanceof Error ? e.message : String(e)}`);
  if (!isClosedLine(closed)) {
    const pids = [...new Set(rec.pids)];
    const stopped = pids.filter((p) => deps.signal(p, "SIGSTOP")).length;
    due();
    return `HANDOVER_OLD_CLOSE_FAIL ${rec.pane}: ${closed}; stopped again (${stopped}/${pids.length} processes), ${retry}`;
  }
  rmSync(frozenFile(stateDir, rec.pane), { force: true });
  return `HANDOVER_OLD_CLOSED ${closed}${rec.oldLog ? `; its log stays at ${rec.oldLog}` : ""}`;
};

// The frozen sessions whose closeAt has passed are closed (freshness runs this every tick); one kept for its monitors' work
// once that work ended (a zombie its stopped parent has not collected counts as ended).
export const closeDueFrozen = async (deps: FreezeDeps, stateDir: string, now: number): Promise<string[]> => {
  const out: string[] = [];
  const recs = readFrozen(stateDir);
  const table = recs.some((r) => r.keepFor?.length) ? await deps.procs() : [];
  const runs = (pid: number): boolean => table.some((p) => p.pid === pid && !ended(p));
  for (const rec of recs) {
    if (rec.keepFor?.length) {
      if (!rec.keepFor.some(runs)) out.push(`${await closeFrozen(deps, stateDir, rec, now)} (the work its monitors started ended: ${rec.keepFor.join(",")})`);
    } else if (rec.closeAt && Date.parse(rec.closeAt) <= now) out.push(await closeFrozen(deps, stateDir, rec, now));
  }
  for (const f of readForwards(stateDir)) if (Date.parse(f.until) <= now) rmSync(forwardFile(stateDir, f.pane), { force: true });
  return out;
};

export const frozenLine = (rec: FrozenRecord): string => `FROZEN ${rec.pane} since ${rec.at} (agent ${rec.agentPid}, ${rec.pids.length} processes; ${rec.keepFor?.length ? `closes once the work its monitors started ends (${rec.keepFor.join(",")})` : rec.closeAt ? `closes at ${rec.closeAt}` : "kept until closed by hand"}; replaced by ${rec.to ?? "-"}; log ${rec.oldLog ?? "-"})`;

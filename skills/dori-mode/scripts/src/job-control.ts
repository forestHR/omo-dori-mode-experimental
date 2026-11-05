// An agent typed into a pane's interactive shell (herdr pane run, aoe) is that shell's foreground job. A freeze that sent
// SIGSTOP to the agent alone let the shell see its job stop: bash took the tty back, printed "[1]+ Stopped", cooked the tty
// (icanon, echo) and made the job a background one, so the SIGCONT of a thaw left omo running in the background, where the
// first key typed into the pane stopped it again with SIGTTIN (handover-simplify, w1:p26, 2026-11-03 15:41Z: the rollback
// thawed it, it stayed T for 18 hours behind its last "esc to interrupt" and freshness refused 54 rollovers as busy).
// Measured on herdr 0.9.5 (2026-11-04, pane w2:p2): with the shell stopped before the agent and resumed after it, the tty
// stays with the agent and its mode is untouched. jobSignal does that for every SIGSTOP and SIGCONT; resumeAgent brings
// back what it can of an agent stopped some other way, without typing into its pane.
import { readFileSync, readlinkSync } from "node:fs";

import type { Clock, Runner } from "./run.ts";

// /proc/<pid>/stat fields 3-8: state, parent, process group, session, tty foreground process group (tpgid, -1: no tty)
export type JobStat = { readonly pid: number; readonly state: string; readonly ppid: number; readonly pgrp: number; readonly session: number; readonly tpgid: number };
export type StatOf = (pid: number) => JobStat | undefined;

// undefined where there is no /proc (macOS, Windows): there nothing is bracketed or repaired
export const readStat: StatOf = (pid) => {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    // the command name in field 2 may hold spaces and parentheses: the fields after it start past its last ")"
    const f = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return { pid, state: f[0] ?? "", ppid: Number(f[1]), pgrp: Number(f[2]), session: Number(f[3]), tpgid: Number(f[5]) };
  } catch {
    return undefined;
  }
};

// The interactive shell that takes the tty back when pid stops: pid is the tty's foreground job in its own process group,
// and its parent leads the session (a pane's shell). An agent leading its own session (a tmux pane running it directly) or
// a child of the agent has none.
const jobShell = (stat: StatOf, pid: number): JobStat | undefined => {
  const p = stat(pid);
  if (!p || p.tpgid <= 0 || p.pgrp !== p.tpgid || p.session === p.pid) return undefined;
  const shell = stat(p.ppid);
  return shell && shell.pid === p.session && shell.pgrp !== p.pgrp ? shell : undefined;
};

// stopped: state T; background: running, but another process group holds its tty, as its shell's background job
export type Hold = "stopped" | "background";
export const holdOf = (stat: StatOf, pid: number): Hold | undefined => {
  const p = stat(pid);
  if (!p) return undefined;
  if (p.state === "T") return "stopped";
  return p.tpgid > 0 && p.pgrp !== p.tpgid && p.session !== p.pid && stat(p.ppid)?.pid === p.session ? "background" : undefined;
};

// kill(0) signals the caller's own process group, kill(-1) every process it may signal: a pid 0 in a QA frozen record
// stopped handover-simplify's omo itself (w1:p2D, 2026-11-04 09:41Z, two hours T with no frozen record). No signal goes to
// 0, 1 or -1, a non-integer, this process or its own process group (as pid or -pid); another group (-pgid) still may.
export type SelfIds = { readonly pid: number; readonly pgrp?: number };
const refusedTarget = (pid: number, self: SelfIds): string | undefined => {
  if (!Number.isInteger(pid)) return "not an integer pid";
  if (Math.abs(pid) <= 1) return pid === 0 ? "0 is the caller's own process group" : pid === 1 ? "1 is init" : "-1 is every process";
  if (Math.abs(pid) === self.pid) return "this process";
  if (self.pgrp !== undefined && Math.abs(pid) === self.pgrp) return "this process's own process group";
  return undefined;
};

// kill() returns before a SIGSTOP has stopped its target (Linux delivers it asynchronously): the job is stopped only once its
// shell reads T, checked every 10 ms for up to ms. A synchronous nap, since a signal path is synchronous.
export type StopWait = { readonly sleep: (ms: number) => void; readonly ms: number };
const nap = new Int32Array(new SharedArrayBuffer(4));
const realWait: StopWait = { sleep: (ms) => void Atomics.wait(nap, 0, 0, ms), ms: 1_000 };
const reachesStop = (stat: StatOf, pid: number, wait: StopWait): boolean => {
  for (let waited = 0; ; waited += 10) {
    if (stat(pid)?.state === "T") return true;
    if (waited >= wait.ms) return false;
    wait.sleep(10);
  }
};

// SIGSTOP to a shell's foreground job stops the shell first and waits for it to read stopped; SIGCONT to it resumes the
// shell after it. A shell that does not stop in time is resumed and the job is left running (false: the freeze fails, it
// never half-happens). Other signals and other processes pass through as they are, past the target guard above
// (SIGNAL_REFUSED on stderr, false).
export const jobSignal = <S extends string>(raw: (pid: number, sig: S) => boolean, stat: StatOf = readStat, self: SelfIds = { pid: process.pid, pgrp: readStat(process.pid)?.pgrp }, wait: StopWait = realWait): ((pid: number, sig: S) => boolean) => (pid, sig) => {
  const signal = (p: number, s: S): boolean => {
    const why = refusedTarget(p, self);
    if (!why) return raw(p, s);
    console.error(`SIGNAL_REFUSED ${s} ${p}: ${why}`);
    return false;
  };
  if (sig !== "SIGSTOP" && sig !== "SIGCONT") return signal(pid, sig);
  const shell = jobShell(stat, pid);
  if (sig === "SIGSTOP") {
    if (shell && !signal(shell.pid, sig)) return false;
    if (shell && !reachesStop(stat, shell.pid, wait)) {
      signal(shell.pid, "SIGCONT" as S);
      console.error(`SIGNAL_REFUSED ${sig} ${pid}: its shell ${shell.pid} did not read stopped within ${wait.ms} ms, so the job was not stopped`);
      return false;
    }
    const sent = signal(pid, sig);
    if (!sent && shell) signal(shell.pid, "SIGCONT" as S);
    return sent;
  }
  const sent = signal(pid, sig);
  if (shell && stat(shell.pid)?.state === "T") signal(shell.pid, sig);
  return sent;
};

export type ResumeIO = {
  readonly run: Runner;
  readonly clock: Clock;
  readonly signal: (pid: number, sig: "SIGSTOP" | "SIGCONT") => boolean;
  readonly stat?: StatOf;
  // the agent's tty (/dev/pts/N)
  readonly tty?: (pid: number) => string | undefined;
};

const ttyOf = (pid: number): string | undefined => {
  try {
    const t = readlinkSync(`/proc/${pid}/fd/0`);
    return t.startsWith("/dev/") ? t : undefined;
  } catch {
    return undefined;
  }
};

// libuv's raw mode (uv_tty_set_mode UV_TTY_MODE_RAW), the mode omo runs its tty in: measured equal, stty -g for stty -g
const RAW = ["-brkint", "-icrnl", "-inpck", "-istrip", "-ixon", "-isig", "-icanon", "-iexten", "-echo", "cs8", "opost", "onlcr"];
const REDRAW_MS = 500;

const foreground = (s: JobStat | undefined): boolean => !!s && s.state !== "T" && s.tpgid > 0 && s.pgrp === s.tpgid;
const where = (s: JobStat | undefined): string => (s ? `state ${s.state}, tty foreground group ${s.tpgid}, its group ${s.pgrp}` : "gone");

// Brings a pane's agent back as far as it can without typing anything: a stopped foreground job is continued (and a
// stopped shell after it), and an agent that runs in the foreground on a tty bash left cooked gets libuv's raw mode back
// with a width change that makes omo paint its whole screen again (no key goes to the pane: stty sets the tty's mode).
// An agent its shell holds as a background job is not typed into: only a fg typed in that shell can give it the tty back
// (tcsetpgrp works only inside the tty's session, TIOCSTI needs CAP_SYS_ADMIN since Linux 6.2), and a typed line races
// whoever else types there (review of #332, round 5). The line says what to type instead.
// AGENT_RUNNING (nothing to do), AGENT_RESUMED, AGENT_RESUME_FAIL or AGENT_GONE.
export const resumeAgent = async (io: ResumeIO, pane: string, pid: number): Promise<string> => {
  const stat = io.stat ?? readStat;
  const first = stat(pid);
  if (!first) return `AGENT_GONE ${pane} agent ${pid}`;
  const done: string[] = [];
  if (first.state === "T" && first.pgrp === first.tpgid) {
    io.signal(-first.pgrp, "SIGCONT");
    done.push("its process group continued");
  }
  const shell = stat(first.ppid);
  if (shell && shell.pid === first.session && shell.state === "T") {
    io.signal(shell.pid, "SIGCONT");
    done.push("its shell continued");
  }
  const now = stat(pid);
  if (!foreground(now)) {
    if (now && now.tpgid <= 0 && now.state !== "T") return done.length ? `AGENT_RESUMED ${pane} agent ${pid}: ${done.join(", ")}` : `AGENT_RUNNING ${pane} agent ${pid}`;
    return `AGENT_RESUME_FAIL ${pane} agent ${pid}: ${done.length ? `${done.join(", ")}, but ` : ""}its shell holds the tty and it is a background job; type fg in ${pane} (${where(now)})`;
  }
  // in the foreground: a tty bash cooked when it took it (icanon) is given back to omo's raw mode
  const tty = (io.tty ?? ttyOf)(pid);
  if (tty) {
    const mode = await io.run(["stty", "-F", tty, "-a"]);
    if (mode.code === 0 && /(^|\s)icanon(\s|$)/.test(mode.out)) {
      await io.run(["stty", "-F", tty, ...RAW]);
      done.push("raw tty mode given back");
      // a width change makes omo lay out and paint its whole screen again (a height change repaints only changed lines)
      const cols = Number((await io.run(["stty", "-F", tty, "size"])).out.trim().split(/\s+/)[1]);
      if (cols > 1) {
        await io.run(["stty", "-F", tty, "cols", String(cols - 1)]);
        // omo must see the narrower width before it gets the old one back, or the two changes read as none
        await io.clock.sleep(REDRAW_MS);
        await io.run(["stty", "-F", tty, "cols", String(cols)]);
        done.push("redrawn");
      }
    }
  }
  return done.length ? `AGENT_RESUMED ${pane} agent ${pid}: ${done.join(", ")}` : `AGENT_RUNNING ${pane} agent ${pid}`;
};

// the check after a thaw (dori handover thaw): nothing to say where the agent cannot be read (no /proc: macOS, native
// Windows), where the thaw line alone is the outcome
export const resumeAfterThaw = async (io: ResumeIO, pane: string, pid: number): Promise<string> => ((io.stat ?? readStat)(pid) ? resumeAgent(io, pane, pid) : "");

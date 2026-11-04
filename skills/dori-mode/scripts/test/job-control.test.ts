import { existsSync, readFileSync } from "node:fs";

import { expect, test } from "bun:test";


import { holdOf, type JobStat, jobSignal, type ResumeIO, resumeAfterThaw, resumeAgent } from "../src/job-control.ts";

// A herdr pane as measured on 2026-11-04 (pane w2:p2): its interactive bash 100 leads session 100 on the tty, and omo 200
// is that shell's foreground job (its own process group 200), with a child 201 in the same group.
type Row = { -readonly [K in keyof JobStat]: JobStat[K] };
const pane = (): Map<number, Row> =>
  new Map([
    [100, { pid: 100, state: "S", ppid: 50, pgrp: 100, session: 100, tpgid: 200 }],
    [200, { pid: 200, state: "S", ppid: 100, pgrp: 200, session: 100, tpgid: 200 }],
    [201, { pid: 201, state: "S", ppid: 200, pgrp: 200, session: 100, tpgid: 200 }],
  ]);

// The kernel's job control in a few lines: a stopped foreground job hands the tty back to its shell, unless the shell is
// stopped itself and cannot take it; SIGCONT resumes a process and leaves the tty where it is.
const kernel = (rows: Map<number, Row>) => {
  const sent: string[] = [];
  const setTpgid = (g: number) => {
    for (const r of rows.values()) r.tpgid = g;
  };
  const signal = (pid: number, sig: "SIGSTOP" | "SIGCONT"): boolean => {
    sent.push(`${sig} ${pid}`);
    const group = pid < 0 ? [...rows.values()].filter((r) => r.pgrp === -pid) : [rows.get(pid)].filter((r): r is Row => !!r);
    if (!group.length) return false;
    for (const r of group) r.state = sig === "SIGSTOP" ? "T" : "S";
    const shell = rows.get(100);
    const job = rows.get(200);
    if (sig === "SIGSTOP" && job?.state === "T" && shell && shell.state !== "T" && job.tpgid === job.pgrp) setTpgid(shell.pgrp);
    return true;
  };
  return { sent, signal, stat: (pid: number) => (rows.get(pid) ? { ...rows.get(pid)! } : undefined), setTpgid };
};

test("a freeze of a shell's foreground job stops the shell first and resumes it last, so the tty stays with the job", () => {
  // Given: omo is the foreground job of the pane's interactive shell
  const rows = pane();
  const k = kernel(rows);
  const signal = jobSignal(k.signal, k.stat);
  // When: it is frozen and thawed as a handover does (children last on the way in, first on the way out)
  expect(signal(200, "SIGSTOP")).toBe(true);
  expect(signal(201, "SIGSTOP")).toBe(true);
  expect(rows.get(200)?.tpgid).toBe(200);
  expect(signal(201, "SIGCONT")).toBe(true);
  expect(signal(200, "SIGCONT")).toBe(true);
  // Then: the shell never took the tty, and everything runs again
  expect(k.sent).toEqual(["SIGSTOP 100", "SIGSTOP 200", "SIGSTOP 201", "SIGCONT 201", "SIGCONT 200", "SIGCONT 100"]);
  expect([...rows.values()].map((r) => `${r.pid} ${r.state} ${r.tpgid}`)).toEqual(["100 S 200", "200 S 200", "201 S 200"]);
  expect(holdOf(k.stat, 200)).toBeUndefined();
});

test("without the shell bracket the same freeze leaves omo a background job (the 2026-11-03 handover-simplify state)", () => {
  const rows = pane();
  const k = kernel(rows);
  k.signal(200, "SIGSTOP");
  k.signal(200, "SIGCONT");
  expect(rows.get(200)?.tpgid).toBe(100);
  expect(holdOf(k.stat, 200)).toBe("background");
  rows.get(200)!.state = "T";
  expect(holdOf(k.stat, 200)).toBe("stopped");
});

test("an agent that leads its own session (a tmux pane running it directly) gets no bracket: its parent is no job shell", () => {
  const rows = new Map<number, Row>([
    [10, { pid: 10, state: "S", ppid: 1, pgrp: 10, session: 10, tpgid: -1 }],
    [20, { pid: 20, state: "S", ppid: 10, pgrp: 20, session: 20, tpgid: 20 }],
  ]);
  const sent: string[] = [];
  const signal = jobSignal((pid, sig) => (sent.push(`${sig} ${pid}`), true), (pid) => rows.get(pid));
  signal(20, "SIGSTOP");
  signal(20, "SIGCONT");
  expect(sent).toEqual(["SIGSTOP 20", "SIGCONT 20"]);
});

test("a failed stop of the agent resumes the shell it stopped first", () => {
  const rows = pane();
  const k = kernel(rows);
  const signal = jobSignal((pid, sig: "SIGSTOP" | "SIGCONT") => pid !== 200 && k.signal(pid, sig), k.stat);
  expect(signal(200, "SIGSTOP")).toBe(false);
  expect(k.sent).toEqual(["SIGSTOP 100", "SIGCONT 100"]);
  expect(rows.get(100)?.state).toBe("S");
});

// Linux delivers a SIGSTOP asynchronously: kill() returns before the shell is stopped. Stopping its job before then lets
// bash, still running, see the job stop and take the tty back.
const lateKernel = (rows: Map<number, Row>, reads: number) => {
  const k = kernel(rows);
  let left = -1;
  const order: string[] = [];
  const signal = (pid: number, sig: "SIGSTOP" | "SIGCONT"): boolean => {
    order.push(`${sig} ${pid} (shell ${rows.get(100)?.state})`);
    if (pid === 100 && sig === "SIGSTOP") {
      k.sent.push(`${sig} ${pid}`);
      left = reads;
      return true;
    }
    if (pid === 100) left = -1;
    return k.signal(pid, sig);
  };
  const stat = (pid: number) => {
    if (pid === 100 && left > 0 && --left === 0) rows.get(100)!.state = "T";
    return k.stat(pid);
  };
  return { ...k, signal, stat, order };
};

test("the job is stopped only once its shell reads stopped: a late stop of the shell is waited for, so the tty stays with the job", () => {
  // Given: the shell's stop lands only after a few reads of its state
  const rows = pane();
  const k = lateKernel(rows, 4);
  const naps: number[] = [];
  const signal = jobSignal(k.signal, k.stat, { pid: 1, pgrp: 1 }, { sleep: (ms) => naps.push(ms), ms: 1_000 });
  // When
  expect(signal(200, "SIGSTOP")).toBe(true);
  // Then: the agent's stop went after the shell read T, and the shell never took the tty
  expect(k.order).toEqual(["SIGSTOP 100 (shell S)", "SIGSTOP 200 (shell T)"]);
  expect(naps.length).toBeGreaterThan(0);
  expect(rows.get(200)?.tpgid).toBe(200);
});

test("a shell that does not stop in time is resumed and its job is not stopped (the freeze fails safe)", () => {
  // Given: the shell's stop never lands
  const rows = pane();
  const k = lateKernel(rows, Number.POSITIVE_INFINITY);
  let slept = 0;
  const signal = jobSignal(k.signal, k.stat, { pid: 1, pgrp: 1 }, { sleep: (ms) => (slept += ms), ms: 200 });
  // When / Then
  expect(signal(200, "SIGSTOP")).toBe(false);
  expect(k.order).toEqual(["SIGSTOP 100 (shell S)", "SIGCONT 100 (shell S)"]);
  expect(rows.get(200)?.state).toBe("S");
  expect(slept).toBeGreaterThanOrEqual(200);
  expect(slept).toBeLessThan(400);
});

const io = (rows: Map<number, Row>, k: ReturnType<typeof kernel>, opts: { cooked?: boolean } = {}) => {
  const calls: string[][] = [];
  let cooked = opts.cooked ?? true;
  const r: ResumeIO = {
    clock: { now: () => 0, sleep: async () => {} },
    signal: k.signal,
    stat: k.stat,
    tty: () => "/dev/pts/17",
    run: async (argv) => {
      calls.push([...argv]);
      if (argv[0] === "stty" && argv[3] === "-a") return { code: 0, out: cooked ? "isig icanon iexten echo" : "-isig -icanon -iexten -echo", err: "" };
      if (argv[0] === "stty" && argv[3] === "size") return { code: 0, out: "40 119\n", err: "" };
      if (argv[0] === "stty" && argv.includes("-icanon")) cooked = false;
      return { code: 0, out: "", err: "" };
    },
  };
  return { r, calls };
};
const typed = (calls: string[][]): string[][] => calls.filter((c) => c[0] !== "stty");

test("resume of a background omo types nothing into its shell and says the fg to type by hand", async () => {
  // Given: the unbracketed freeze left omo a background job of its shell (stopped, or running)
  for (const stopped of [true, false]) {
    const rows = pane();
    const k = kernel(rows);
    k.signal(200, "SIGSTOP");
    k.signal(200, "SIGCONT");
    if (stopped) rows.get(200)!.state = "T";
    const { r, calls } = io(rows, k);
    // When
    const line = await resumeAgent(r, "w2:p2", 200);
    // Then: no key and no signal goes anywhere; the line names what to type
    expect(line).toBe(`AGENT_RESUME_FAIL w2:p2 agent 200: its shell holds the tty and it is a background job; type fg in w2:p2 (state ${stopped ? "T" : "S"}, tty foreground group 100, its group 200)`);
    expect(calls).toEqual([]);
    expect(k.sent.slice(2)).toEqual([]);
  }
});

test("resume of a stopped foreground omo only continues it; a running one on a raw tty is left alone", async () => {
  const rows = pane();
  const k = kernel(rows);
  rows.get(200)!.state = "T";
  rows.get(201)!.state = "T";
  const { r, calls } = io(rows, k, { cooked: false });
  expect(await resumeAgent(r, "w2:p2", 200)).toBe("AGENT_RESUMED w2:p2 agent 200: its process group continued");
  expect(typed(calls)).toEqual([]);
  expect(k.sent).toEqual(["SIGCONT -200"]);
  expect(await resumeAgent(r, "w2:p2", 200)).toBe("AGENT_RUNNING w2:p2 agent 200");
});

test("an omo brought forward by a typed fg gets the raw mode bash took away, and a full repaint, without a key typed", async () => {
  // Given: omo runs in the foreground again but bash left the tty cooked (icanon, echo)
  const rows = pane();
  const k = kernel(rows);
  const { r, calls } = io(rows, k, { cooked: true });
  // When
  const line = await resumeAgent(r, "w2:p2", 200);
  // Then: only stty touches the tty (its mode and width), nothing is sent to the pane
  expect(line).toBe("AGENT_RESUMED w2:p2 agent 200: raw tty mode given back, redrawn");
  expect(typed(calls)).toEqual([]);
  expect(calls.some((c) => c.includes("-icanon") && c.includes("-echo"))).toBe(true);
  expect(calls.filter((c) => c[3] === "cols").map((c) => c[4])).toEqual(["118", "119"]);
});

test("a signal to pid 0, 1 or -1, a non-integer, this process or its own process group is refused and sent nowhere; another group still gets it", () => {
  // Given: dori runs as pid 300 in process group 301 (kill(0) or kill(-301) would stop dori itself, as a pid 0 in a frozen
  // record did to handover-simplify's omo on 2026-11-04 09:41Z, two hours stopped with no record)
  const sent: string[] = [];
  const signal = jobSignal((pid, sig: "SIGSTOP" | "SIGCONT" | "SIGTERM") => (sent.push(`${sig} ${pid}`), true), () => undefined, { pid: 300, pgrp: 301 });
  // When / Then
  for (const pid of [0, 1, -1, 1.5, Number.NaN, 300, -300, 301, -301]) {
    for (const sig of ["SIGSTOP", "SIGCONT", "SIGTERM"] as const) expect(signal(pid, sig)).toBe(false);
  }
  expect(sent).toEqual([]);
  // another process group (a stopped job continued as a whole, a monitor chain ended) is still signalled
  expect(signal(-200, "SIGCONT")).toBe(true);
  expect(signal(200, "SIGSTOP")).toBe(true);
  expect(sent).toEqual(["SIGCONT -200", "SIGSTOP 200"]);
});

test("by default the guard knows the real process: its own pid is refused on every platform", () => {
  const sent: string[] = [];
  const signal = jobSignal((pid, sig: "SIGSTOP") => (sent.push(`${sig} ${pid}`), true), () => undefined);
  expect(signal(process.pid, "SIGSTOP")).toBe(false);
  expect(signal(0, "SIGSTOP")).toBe(false);
  expect(sent).toEqual([]);
});

// its own group is read from /proc (Linux); macOS and native Windows have none to read
test.skipIf(!existsSync("/proc/self/stat"))("by default the guard knows the real process group where /proc has it: its own group is refused", () => {
  const sent: string[] = [];
  const signal = jobSignal((pid, sig: "SIGSTOP") => (sent.push(`${sig} ${pid}`), true), () => undefined);
  const own = Number(readFileSync("/proc/self/stat", "utf8").split(") ")[1]?.split(" ")[2]);
  expect(signal(-own, "SIGSTOP")).toBe(false);
  expect(sent).toEqual([]);
});

test("the resume check after a thaw says nothing where the agent cannot be read (no /proc), and runs it where it can", async () => {
  const rows = pane();
  const k = kernel(rows);
  const { r } = io(rows, k, { cooked: false });
  expect(await resumeAfterThaw({ ...r, stat: () => undefined }, "w2:p2", 200)).toBe("");
  expect(await resumeAfterThaw(r, "w2:p2", 200)).toBe("AGENT_RUNNING w2:p2 agent 200");
});

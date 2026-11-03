import { appendFileSync, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { configPath, envFilePath } from "./config.ts";
import { powershellLiteral } from "./powershell.ts";
import type { Clock } from "./run.ts";

// dori serve: one process that keeps a Dori's long-running loops up where there is no systemd and no bash (native
// Windows, where the owner wants a Dori without WSL): the sweeps dori-lanes.sh runs (watch, freshness, dead-panes, guard,
// state-git), the Discord listener (dori-inbound.service) and the session watcher (dori-session-watch.service). Each loop
// is a child; its output lines go to the log stamped and tagged as dori-lanes.sh does it, and a child that exits is
// started again after a pause that doubles while it keeps failing (2 s up to 5 min, back to 2 s once it ran 10 min).
export type Loop = { readonly tag: string; readonly argv: readonly string[] };

export const serveLoops = (bun: string, cli: string, sessionWatch: string): Loop[] => [
  { tag: "watch", argv: [bun, cli, "watch"] },
  { tag: "freshness", argv: [bun, cli, "freshness", "--loop", "2"] },
  { tag: "dead-panes", argv: [bun, cli, "dead-panes", "--loop", "5"] },
  { tag: "guard", argv: [bun, cli, "guard", "--loop", "1"] },
  { tag: "state-git", argv: [bun, cli, "state-git", "loop"] },
  { tag: "inbound", argv: [bun, cli, "inbound", "discord"] },
  { tag: "session-watch", argv: [bun, sessionWatch] },
];

export type Running = { readonly lines: AsyncIterable<string>; readonly exited: Promise<number> };
export type ServeDeps = { readonly start: (argv: readonly string[]) => Running; readonly log: (line: string) => void; readonly clock: Clock; readonly stop?: () => boolean };

const FIRST_PAUSE_MS = 2_000;
const MAX_PAUSE_MS = 5 * 60_000;
const HEALTHY_MS = 10 * 60_000;

// Keeps one loop running until stop() says so; resolves then.
export const keep = async (loop: Loop, deps: ServeDeps): Promise<void> => {
  let pause = FIRST_PAUSE_MS;
  while (!deps.stop?.()) {
    const at = deps.clock.now();
    const child = deps.start(loop.argv);
    deps.log(`${loop.tag} SERVE_STARTED ${loop.argv.slice(1).join(" ")}`);
    const read = (async () => {
      for await (const line of child.lines) deps.log(`${loop.tag} ${line}`);
    })();
    const code = await child.exited;
    await read.catch(() => undefined);
    if (deps.stop?.()) return;
    if (deps.clock.now() - at >= HEALTHY_MS) pause = FIRST_PAUSE_MS;
    deps.log(`${loop.tag} SERVE_EXITED code ${code}; again in ${Math.round(pause / 1000)} s`);
    await deps.clock.sleep(pause);
    pause = Math.min(pause * 2, MAX_PAUSE_MS);
  }
};

export const serve = (loops: readonly Loop[], deps: ServeDeps): Promise<void[]> => Promise.all(loops.map((l) => keep(l, deps)));

// the lines of a child's stdout and stderr, split at line ends
const linesOf = async function* (streams: readonly ReadableStream<Uint8Array>[]): AsyncIterable<string> {
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let open = streams.length;
  for (const s of streams)
    void (async () => {
      let rest = "";
      for await (const chunk of s) {
        const parts = (rest + new TextDecoder().decode(chunk)).split(/\r?\n/);
        rest = parts.pop() ?? "";
        queue.push(...parts.filter((p) => p.trim()));
        wake?.();
      }
      if (rest.trim()) queue.push(rest);
      open--;
      wake?.();
    })();
  for (;;) {
    while (queue.length) yield queue.shift() ?? "";
    if (!open) return;
    await new Promise<void>((r) => (wake = r));
    wake = undefined;
  }
};

export const spawnLoop = (argv: readonly string[]): Running => {
  const p = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  return { lines: linesOf([p.stdout, p.stderr]), exited: p.exited };
};

export const fileLog = (file: string, clock: Clock): ((line: string) => void) => {
  mkdirSync(dirname(file), { recursive: true });
  closeSync(openSync(file, "a"));
  return (line) => appendFileSync(file, `${new Date(clock.now()).toISOString().slice(0, 19)}Z ${line}\n`);
};

// Windows: a Task Scheduler entry that starts dori serve at the user's logon, in place of the systemd units
export const TASK_NAME = "Dori serve";
export const taskArgv = (bun: string, cli: string, stateDir: string): string[] => {
  const state = resolve(stateDir);
  const entry = join(state, "serve-task.ps1");
  mkdirSync(state, { recursive: true });
  writeFileSync(entry, `\uFEFF$env:DORI_CONFIG = ${powershellLiteral(resolve(configPath()))}
$env:DORI_ENV_FILE = ${powershellLiteral(resolve(envFilePath()))}
$env:DORI_STATE_DIR = ${powershellLiteral(state)}
& ${powershellLiteral(bun)} ${powershellLiteral(cli)} serve --log ${powershellLiteral(join(state, "serve.log"))}
exit $LASTEXITCODE
`);
  const registration = [
    "$ErrorActionPreference = 'Stop'",
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${powershellLiteral(`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${entry}"`)}`,
    "$trigger = New-ScheduledTaskTrigger -AtLogOn",
    "$settings = New-ScheduledTaskSettingsSet",
    "$settings.ExecutionTimeLimit = 'PT0S'",
    `Register-ScheduledTask -TaskName ${powershellLiteral(TASK_NAME)} -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null`,
  ].join("; ");
  return ["powershell", "-NoProfile", "-NonInteractive", "-Command", registration];
};

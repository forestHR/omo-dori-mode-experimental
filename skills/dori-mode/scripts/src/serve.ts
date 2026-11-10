import { appendFileSync, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { configPath, envFilePath } from "./config.ts";
import { powershellData as data } from "./powershell.ts";
import type { Clock } from "./run.ts";

// dori serve: one process that keeps a Dori's long-running loops up where there is no systemd and no bash (native
// Windows, where the owner wants a Dori without WSL): the sweeps dori-lanes.sh runs (watch, freshness, dead-panes, guard,
// state-git), the Discord listener (dori-inbound.service) and the session watcher (dori-session-watch.service). Each loop
// is a child; its output lines go to the log stamped and tagged as dori-lanes.sh does it, and a child that exits is
// started again after a pause that doubles while it keeps failing (2 s up to 5 min, back to 2 s once it ran 10 min).
export type Loop = { readonly tag: string; readonly argv: readonly string[] };

// The host guard samples load, memory and disk with Unix tools (host-guard.ts); on native Windows it would read made-up
// values, so it is left out there until it has a Windows sampler.
export const serveLoops = (bun: string, cli: string, sessionWatch: string, platform: string = process.platform): Loop[] => [
  { tag: "watch", argv: [bun, cli, "watch"] },
  { tag: "freshness", argv: [bun, cli, "freshness", "--loop", "2"] },
  { tag: "dead-panes", argv: [bun, cli, "dead-panes", "--loop", "5"] },
  ...(platform === "win32" ? [] : [{ tag: "guard", argv: [bun, cli, "guard", "--loop", "1"] }]),
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
export const linesOf = async function* (streams: readonly ReadableStream<Uint8Array>[]): AsyncIterable<string> {
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let open = streams.length;
  for (const s of streams)
    void (async () => {
      let rest = "";
      // one decoder per stream: a character whose bytes span two chunks is joined, not replaced
      const decoder = new TextDecoder();
      for await (const chunk of s) {
        const parts = (rest + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
        rest = parts.pop() ?? "";
        queue.push(...parts.filter((p) => p.trim()));
        wake?.();
      }
      rest += decoder.decode();
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
  // the environment as it is now (the instance serve resolved and its env file), not as this process started
  const p = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env } });
  return { lines: linesOf([p.stdout, p.stderr]), exited: p.exited };
};

export const fileLog = (file: string, clock: Clock): ((line: string) => void) => {
  mkdirSync(dirname(file), { recursive: true });
  closeSync(openSync(file, "a"));
  return (line) => appendFileSync(file, `${new Date(clock.now()).toISOString().slice(0, 19)}Z ${line}\n`);
};

// The logon task always runs every loop with the default log; --only or --log with --install-task is refused, not dropped,
// and so is a blank --task-name (Task Scheduler has no task without a name).
export const installTaskRefusal = (only: readonly string[], log: string | undefined, name?: string): string | undefined =>
  only.length || log ? "SERVE_TASK_REFUSED --install-task registers every loop with the default log; run it without --only and --log"
  : name !== undefined && !name.trim() ? "SERVE_TASK_REFUSED --task-name needs a name, for example --task-name \"Dori serve (mydori)\""
  : undefined;

// Windows: a Task Scheduler entry that starts dori serve at the user's logon, in place of the systemd units
export const TASK_NAME = "Dori serve";

// The names of the tasks whose action runs this instance's entry point, each as base64 of its UTF-8 so no console
// encoding changes them. Asked before taskArgv rewrites that entry point.
export const entryTasksArgv = (stateDir: string): string[] => ["powershell", "-NoProfile", "-NonInteractive", "-Command", [
  "$ErrorActionPreference = 'Stop'",
  `$entry = ${data(join(resolve(stateDir), "serve-task.ps1"))}`,
  "Get-ScheduledTask | Where-Object { @($_.Actions | Where-Object { ([string]$_.Arguments).IndexOf($entry, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count } | ForEach-Object { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.TaskName)) }",
].join("; ")];
export const entryTasksOf = (out: string): string[] =>
  out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => Buffer.from(l, "base64").toString("utf8"));

// One task per instance: a task under another name already runs this entry point, and registering a second one would
// rewrite the launcher it runs and start the same Dori twice. Task Scheduler names ignore case.
export const entryTaskRefusal = (name: string, owners: readonly string[]): string | undefined => {
  const other = owners.find((o) => o.toLowerCase() !== name.toLowerCase());
  return other === undefined ? undefined
    : `SERVE_TASK_REFUSED this instance already runs as the task "${other}"; register it again under that name (--task-name "${other}") or remove that task first (Unregister-ScheduledTask -TaskName "${other}")`;
};
export const taskArgv = (bun: string, cli: string, stateDir: string, name: string = TASK_NAME): string[] => {
  const state = resolve(stateDir);
  const entry = join(state, "serve-task.ps1");
  mkdirSync(state, { recursive: true });
  // paths and names go in as data (powershellData), never as PowerShell text
  writeFileSync(entry, `\uFEFF$env:DORI_CONFIG = ${data(resolve(configPath()))}
$env:DORI_ENV_FILE = ${data(resolve(envFilePath()))}
$env:DORI_STATE_DIR = ${data(state)}
$doriArgv = @(${[bun, cli, "serve", "--log", join(state, "serve.log")].map(data).join(", ")})
$doriRest = @($doriArgv | Select-Object -Skip 1)
& $doriArgv[0] @doriRest
exit $LASTEXITCODE
`);
  const registration = [
    "$ErrorActionPreference = 'Stop'",
    // conhost --headless gives the task a console with no window
    `$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\\conhost.exe') -Argument ${data(`--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${entry}"`)}`,
    // a logon trigger for this user only: an all-users trigger needs an elevated caller
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)",
    // keep supervising on a laptop that runs on battery, start again up to 3 times a minute apart when it fails,
    // and never run a second copy next to a running one
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew",
    "$settings.ExecutionTimeLimit = 'PT0S'",
    `Register-ScheduledTask -TaskName ${data(name)} -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null`,
  ].join("; ");
  return ["powershell", "-NoProfile", "-NonInteractive", "-Command", registration];
};

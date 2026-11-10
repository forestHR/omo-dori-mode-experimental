import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { powershellLiteral as quote } from "../src/powershell.ts";
import { taskArgv, TASK_NAME } from "../src/serve.ts";

const execute = async (argv: readonly string[]) => {
  const env = Object.fromEntries(Object.entries(Bun.env).filter(([name]) => !name.startsWith("DORI_")));
  const child = Bun.spawn([...argv], { env, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, out, err }).toMatchObject({ code: 0 });
  return out;
};

const taskFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "dori-task-review2-"));
  const dir = join(root, "O'\u2018\u2019\u201a\u201bConnor & semi; $name");
  mkdirSync(dir);
  const state = join(dir, "chosen state");
  const config = join(dir, "chosen.json");
  const envFile = join(dir, "chosen.env");
  const capture = join(root, "task.json");
  const cli = join(dir, "task-child.ts");
  // written whole, then renamed into place, so its appearance means it is complete
  writeFileSync(cli, `await Bun.write(${JSON.stringify(`${capture}.tmp`)}, JSON.stringify({
    config: process.env.DORI_CONFIG, env: process.env.DORI_ENV_FILE, state: process.env.DORI_STATE_DIR,
    argv: process.argv.slice(2),
  }));
  require("node:fs").renameSync(${JSON.stringify(`${capture}.tmp`)}, ${JSON.stringify(capture)});`);
  const previousConfig = process.env.DORI_CONFIG;
  const previousEnv = process.env.DORI_ENV_FILE;
  let argv: string[];
  const name = `Dori-test-${crypto.randomUUID()}`;
  try {
    process.env.DORI_CONFIG = config;
    process.env.DORI_ENV_FILE = envFile;
    argv = taskArgv(process.execPath, cli, state, name);
  } finally {
    if (previousConfig === undefined) delete process.env.DORI_CONFIG;
    else process.env.DORI_CONFIG = previousConfig;
    if (previousEnv === undefined) delete process.env.DORI_ENV_FILE;
    else process.env.DORI_ENV_FILE = previousEnv;
  }
  let registered = false;
  return {
    name, state, capture, expected: { config, env: envFile, state, argv: ["serve", "--log", join(state, "serve.log")] },
    async register() { await execute(argv); registered = true; },
    async query() {
      const output = await execute(["powershell", "-NoProfile", "-NonInteractive", "-Command", `
        $task = Get-ScheduledTask -TaskName ${quote(name)} -ErrorAction Stop
        @{ limit = $task.Settings.ExecutionTimeLimit; execute = $task.Actions[0].Execute; arguments = $task.Actions[0].Arguments;
           user = [string]$task.Triggers[0].UserId; me = [Security.Principal.WindowsIdentity]::GetCurrent().Name;
           noBatteryStart = [bool]$task.Settings.DisallowStartIfOnBatteries; batteryStop = [bool]$task.Settings.StopIfGoingOnBatteries;
           name = $task.TaskName; runLevel = [string]$task.Principal.RunLevel; restartCount = [int]$task.Settings.RestartCount;
           restartInterval = [string]$task.Settings.RestartInterval; instances = [string]$task.Settings.MultipleInstances;
           windir = $env:WINDIR } | ConvertTo-Json -Compress
      `]);
      const value: unknown = JSON.parse(output);
      if (typeof value !== "object" || value === null ||
          !("limit" in value) || typeof value.limit !== "string" ||
          !("execute" in value) || typeof value.execute !== "string" ||
          !("arguments" in value) || typeof value.arguments !== "string" ||
          !("user" in value) || typeof value.user !== "string" || !("me" in value) || typeof value.me !== "string" ||
          !("noBatteryStart" in value) || typeof value.noBatteryStart !== "boolean" ||
          !("batteryStop" in value) || typeof value.batteryStop !== "boolean" ||
          !("name" in value) || typeof value.name !== "string" || !("runLevel" in value) || typeof value.runLevel !== "string" ||
          !("restartCount" in value) || typeof value.restartCount !== "number" ||
          !("restartInterval" in value) || typeof value.restartInterval !== "string" ||
          !("instances" in value) || typeof value.instances !== "string" ||
          !("windir" in value) || typeof value.windir !== "string") throw new TypeError("Invalid registered task settings");
      return { limit: value.limit, execute: value.execute, arguments: value.arguments, user: value.user, me: value.me, noBatteryStart: value.noBatteryStart, batteryStop: value.batteryStop,
        name: value.name, runLevel: value.runLevel, restartCount: value.restartCount, restartInterval: value.restartInterval, instances: value.instances, windir: value.windir };
    },
    async [Symbol.asyncDispose]() {
      try {
        // Unregister-ScheduledTask leaves a started task running: end every process naming this fixture's folder, and their
        // descendants, first
        if (registered) await execute(["powershell", "-NoProfile", "-NonInteractive", "-Command", `
          $all = @(Get-CimInstance Win32_Process); $ids = [Collections.Generic.HashSet[uint32]]::new()
          $all | Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${quote(root)}) -and $_.ProcessId -ne $PID } | ForEach-Object { [void]$ids.Add($_.ProcessId) }
          do { $grew = $false; foreach ($p in $all) { if ($ids.Contains($p.ParentProcessId) -and $ids.Add($p.ProcessId)) { $grew = $true } } } while ($grew)
          foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
          Unregister-ScheduledTask -TaskName ${quote(name)} -Confirm:$false -ErrorAction Stop`]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  } as const;
};

test("the task script and its registration carry paths and names only as data, never as PowerShell text", () => {
  // Given instance paths holding quotes, curly quotes and shell metacharacters.
  const root = mkdtempSync(join(tmpdir(), "dori-task-data-"));
  const dir = join(root, "O'\u2019Connor & semi; $name");
  const previous = process.env.DORI_CONFIG;
  try {
    process.env.DORI_CONFIG = join(dir, "chosen.json");
    // When the task script and its registration are generated.
    const argv = taskArgv("bun", join(dir, "cli.ts"), join(dir, "state"));
    const script = readFileSync(join(dir, "state", "serve-task.ps1"), "utf8");
    // Then no path text appears in either, only base64 decoded in the shell.
    for (const text of [script, argv.join(" ")]) {
      expect(text).not.toContain("Connor");
      expect(text).not.toContain("semi;");
      expect(text).toContain("FromBase64String");
    }
  } finally {
    if (previous === undefined) delete process.env.DORI_CONFIG;
    else process.env.DORI_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "win32")("review 2 registers an unlimited supervisor execution time", async () => {
  // Given isolated task files and a unique registration name.
  await using task = taskFixture();
  // When the production registration command creates the actual Windows task.
  await task.register();
  // Then Task Scheduler stores PT0S rather than its finite default.
  expect((await task.query()).limit).toBe("PT0S");
}, 40_000);

test.skipIf(process.platform !== "win32")("review 1 of #306 the logon trigger is this user's, and the task runs and keeps running on battery", async () => {
  // Given the production registration of an actual Windows task.
  await using task = taskFixture();
  await task.register();
  // When its trigger and settings are read back.
  const got = await task.query();
  // Then the trigger is scoped to the registering user and battery power neither blocks nor stops it.
  expect(got.user.toLowerCase().split("\\").pop()).toBe(got.me.toLowerCase().split("\\").pop());
  expect({ noBatteryStart: got.noBatteryStart, batteryStop: got.batteryStop }).toEqual({ noBatteryStart: false, batteryStop: false });
}, 40_000);

test.skipIf(process.platform !== "win32")("the task registers under the given name with the helper's settings: no window, Limited, 3 restarts a minute apart, no second copy", async () => {
  // Given the production registration of an actual Windows task under a chosen name.
  await using task = taskFixture();
  await task.register();
  // When it is read back by that name.
  const got = await task.query();
  // Then it is the name given, run through a headless conhost, without elevation, restarted 3 times a minute apart, never twice at once.
  expect(got.name).toBe(task.name);
  expect(got.execute.toLowerCase()).toBe(join(got.windir, "System32", "conhost.exe").toLowerCase());
  expect(got.arguments).toBe(`--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${join(task.state, "serve-task.ps1")}"`);
  expect({ runLevel: got.runLevel, restartCount: got.restartCount, restartInterval: got.restartInterval, instances: got.instances })
    .toEqual({ runLevel: "Limited", restartCount: 3, restartInterval: "PT1M", instances: "IgnoreNew" });
}, 40_000);

test.skipIf(process.platform !== "win32")("dori serve --install-task --task-name registers that name and prints it; --task-name alone or blank registers nothing", async () => {
  // Given a throwaway instance and a unique task name.
  const root = mkdtempSync(join(tmpdir(), "dori-task-cli-"));
  const state = join(root, "state");
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: state }));
  const name = `Dori-test-${crypto.randomUUID()}`;
  const env = { ...Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !key.startsWith("DORI_"))), DORI_CONFIG: config, DORI_STATE_DIR: state, DORI_ENV_FILE: join(root, "dori.env") };
  const cli = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "serve", ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, text: out + err };
  };
  const registered = async (task = name) => (await execute(["powershell", "-NoProfile", "-NonInteractive", "-Command",
    `[bool](Get-ScheduledTask -TaskName ${quote(task)} -ErrorAction SilentlyContinue)`])).trim();
  const defaultBefore = await registered(TASK_NAME);
  try {
    // When --task-name comes without --install-task, or blank, then nothing is registered.
    expect(await cli("--task-name", name)).toMatchObject({ code: 1, text: expect.stringContaining("SERVE_TASK_REFUSED") });
    expect(await cli("--install-task", "--task-name", " ")).toMatchObject({ code: 1, text: expect.stringContaining("SERVE_TASK_REFUSED") });
    expect({ named: await registered(), defaultTask: await registered(TASK_NAME) }).toEqual({ named: "False", defaultTask: defaultBefore });
    // When it comes with --install-task, then the task is registered under it and the line names it.
    expect(await cli("--install-task", "--task-name", name)).toMatchObject({ code: 0, text: expect.stringContaining(`SERVE_TASK_INSTALLED "${name}" at logon`) });
    expect({ named: await registered(), defaultTask: await registered(TASK_NAME) }).toEqual({ named: "True", defaultTask: defaultBefore });
  } finally {
    await execute(["powershell", "-NoProfile", "-NonInteractive", "-Command",
      `Get-ScheduledTask -TaskName ${quote(name)} -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false`]);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test.skipIf(process.platform !== "win32")("review 2 registered action preserves quoted instance paths without inherited environment", async () => {
  // Given an actual registered task with curly quotes and shell metacharacters in its paths.
  await using task = taskFixture();
  await task.register();
  // conhost --headless runs its child only under Task Scheduler (started from a pipe it returns at once), so the task itself is started
  let done = () => {};
  const written = new Promise<void>((resolve) => { done = resolve; });
  const watcher = watch(dirname(task.capture), (_event, file) => { if (file === basename(task.capture)) done(); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("the task wrote no capture in 30 s")), 30_000); });
  try {
    // When Task Scheduler starts it with its own logon environment, none of this process's DORI_ variables.
    await execute(["powershell", "-NoProfile", "-NonInteractive", "-Command", `Start-ScheduledTask -TaskName ${quote(task.name)} -ErrorAction Stop`]);
    await Promise.race([written, late]);
  } finally {
    clearTimeout(timer);
    watcher.close();
  }
  // Then the real child receives the selected instance and exact arguments.
  expect(await Bun.file(task.capture).json()).toEqual(task.expected);
}, 40_000);

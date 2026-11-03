import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  writeFileSync(cli, `await Bun.write(${JSON.stringify(capture)}, JSON.stringify({
    config: process.env.DORI_CONFIG, env: process.env.DORI_ENV_FILE, state: process.env.DORI_STATE_DIR,
    argv: process.argv.slice(2),
  }));`);
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
    capture, expected: { config, env: envFile, state, argv: ["serve", "--log", join(state, "serve.log")] },
    async register() { await execute(argv); registered = true; },
    async query() {
      const output = await execute(["powershell", "-NoProfile", "-NonInteractive", "-Command", `
        $task = Get-ScheduledTask -TaskName ${quote(name)} -ErrorAction Stop
        @{ limit = $task.Settings.ExecutionTimeLimit; execute = $task.Actions[0].Execute; arguments = $task.Actions[0].Arguments;
           user = [string]$task.Triggers[0].UserId; me = [Security.Principal.WindowsIdentity]::GetCurrent().Name;
           noBatteryStart = [bool]$task.Settings.DisallowStartIfOnBatteries; batteryStop = [bool]$task.Settings.StopIfGoingOnBatteries } | ConvertTo-Json -Compress
      `]);
      const value: unknown = JSON.parse(output);
      if (typeof value !== "object" || value === null ||
          !("limit" in value) || typeof value.limit !== "string" ||
          !("execute" in value) || typeof value.execute !== "string" ||
          !("arguments" in value) || typeof value.arguments !== "string" ||
          !("user" in value) || typeof value.user !== "string" || !("me" in value) || typeof value.me !== "string" ||
          !("noBatteryStart" in value) || typeof value.noBatteryStart !== "boolean" ||
          !("batteryStop" in value) || typeof value.batteryStop !== "boolean") throw new TypeError("Invalid registered task settings");
      return { limit: value.limit, execute: value.execute, arguments: value.arguments, user: value.user, me: value.me, noBatteryStart: value.noBatteryStart, batteryStop: value.batteryStop };
    },
    async [Symbol.asyncDispose]() {
      try {
        if (registered) await execute(["powershell", "-NoProfile", "-NonInteractive", "-Command",
          `Unregister-ScheduledTask -TaskName ${quote(name)} -Confirm:$false -ErrorAction Stop`]);
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

test.skipIf(process.platform !== "win32")("review 2 registered action preserves quoted instance paths without inherited environment", async () => {
  // Given an actual registered task with curly quotes and shell metacharacters in its paths.
  await using task = taskFixture();
  await task.register();
  const action = await task.query();
  const env = Object.fromEntries(Object.entries(Bun.env).filter(([name]) => !name.startsWith("DORI_")));
  // When its registered action executes under a clean logon-like environment.
  const child = Bun.spawn(["cmd", "/d", "/s", "/c", `"${action.execute} ${action.arguments}"`], {
    env, stdout: "pipe", stderr: "pipe", windowsVerbatimArguments: true,
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  // Then the real child receives the selected instance and exact arguments.
  expect({ code, out, err }).toMatchObject({ code: 0 });
  expect(await Bun.file(task.capture).json()).toEqual(task.expected);
}, 40_000);

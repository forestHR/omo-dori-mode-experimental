import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { powershellLiteral as quote } from "../src/powershell.ts";
import { command, installFixture, prepareInstanceProbe } from "./windows-install-fixture.ts";

test.skipIf(process.platform !== "win32").each(["fresh", "existing"] as const)("Windows installer creates a working shim with %s config", async (mode) => {
  // Given an isolated local upstream and no inherited instance selectors.
  using f = await installFixture();
  const preserved = { backend: "herdr", leadPane: "w9:p9", defaultModel: "preserved/model" };
  if (mode === "existing") {
    await command(["git", "clone", "-q", "--branch", "fixture", f.upstream, join(f.home, "src")]);
    writeFileSync(f.config, JSON.stringify(preserved));
  }
  // When the actual installer runs, including its generated launcher's smoke check.
  await f.shell(f.install);
  // Then it installs a herdr config or preserves the existing one.
  const actual: unknown = await Bun.file(f.config).json();
  expect(actual).toMatchObject(mode === "existing" ? preserved : { backend: "herdr", agentCommand: ["omo", "--model", "{model}", "{prompt}"] });
}, 60_000);

test.skipIf(process.platform !== "win32").each(["config", "env", "state", "all"] as const)("review 2 launcher preserves explicit %s overrides", async (selection) => {
  // Given installation defaults and independently different caller-selected locations.
  using f = await installFixture();
  await f.shell(f.install);
  const capture = prepareInstanceProbe(f);
  const config = join(f.root, "override.json");
  const envFile = join(f.root, "override.env");
  const state = join(f.root, "override-state");
  writeFileSync(config, JSON.stringify({ backend: "herdr", defaultModel: "override/model" }));
  writeFileSync(envFile, "DORI_REVIEW_MARKER=override-env\n");
  const useConfig = selection === "all" || selection === "config";
  const useEnv = selection === "all" || selection === "env";
  const useState = selection === "all" || selection === "state";
  // When a clean caller deliberately selects some or all of the override variables.
  await f.shell(`
    ${useConfig ? `$env:DORI_CONFIG = ${quote(config)}` : ""}
    ${useEnv ? `$env:DORI_ENV_FILE = ${quote(envFile)}` : ""}
    ${useState ? `$env:DORI_STATE_DIR = ${quote(state)}` : ""}
    ${f.dori("instance-probe")}
  `);
  // Then explicit values win and only the unset locations receive installation defaults.
  expect(await Bun.file(capture).json()).toEqual({
    config: useConfig ? config : f.config,
    env: useEnv ? envFile : join(f.home, "dori.env"),
    state: useState ? state : join(f.home, "state"),
    model: useConfig ? "override/model" : "review/model",
    marker: useEnv ? "override-env" : "chosen-env",
    argv: ["instance-probe"],
  });
}, 60_000);

test.skipIf(process.platform !== "win32")("review 1 installer aborts a failed checkout instead of pulling the old branch", async () => {
  // Given an existing fixture branch and a requested branch that does not exist.
  using f = await installFixture();
  const src = join(f.home, "src");
  await command(["git", "clone", "-q", "--branch", "fixture", f.upstream, src]);
  const receipt = join(f.root, "failure.json");
  // When the real git checkout fails inside the installer.
  await f.shell(`
    $failed = $false
    try { ${f.install.replace("-Branch fixture", "-Branch missing-branch")} } catch { $failed = $true }
    [IO.File]::WriteAllText(${quote(receipt)}, (@{ failed = $failed } | ConvertTo-Json -Compress))
  `);
  // Then installation was aborted before a launcher could be published.
  expect(await Bun.file(receipt).json()).toEqual({ failed: true });
  expect(existsSync(f.launcher)).toBe(false);
  expect((await command(["git", "-C", src, "branch", "--show-current"])).trim()).toBe("fixture");
}, 60_000);

test.skipIf(process.platform !== "win32")("review 1 installer aborts a failed native dependency install", async () => {
  // Given a native bun.cmd that succeeds at --version but fails its install operation.
  using f = await installFixture();
  const bin = join(f.root, "tools");
  mkdirSync(bin);
  writeFileSync(join(bin, "bun.cmd"), `@echo off\r\nif "%~1"=="install" exit /b 23\r\n"${process.execPath}" %*\r\n`);
  const receipt = join(f.root, "failure.json");
  // When the dependency install exits nonzero.
  await f.shell(`
    $env:PATH = ${quote(bin)} + ";" + $env:PATH
    $failed = $false
    try { ${f.install} } catch { $failed = $true }
    [IO.File]::WriteAllText(${quote(receipt)}, (@{ failed = $failed } | ConvertTo-Json -Compress))
  `);
  // Then the failure is surfaced before creating the launcher.
  expect(await Bun.file(receipt).json()).toEqual({ failed: true });
  expect(existsSync(f.launcher)).toBe(false);
}, 60_000);

test.skipIf(process.platform !== "win32").each(["chosen home", "설치-試験"] as const)("review 1 launcher selects its config env and state from clean environment at %s", async (homeName) => {
  // Given a completed installation, a distinctive config/env, and a CLI probe using the real config loaders.
  using f = await installFixture(homeName);
  await f.shell(f.install);
  const capture = prepareInstanceProbe(f);
  // When the real generated launcher starts without DORI_CONFIG, DORI_ENV_FILE or DORI_STATE_DIR.
  await f.shell(f.dori("instance-probe"));
  // Then the selected installation supplies all locations and values, even under a Unicode path.
  expect(await Bun.file(capture).json()).toEqual({
    config: f.config, env: join(f.home, "dori.env"), state: join(f.home, "state"),
    model: "review/model", marker: "chosen-env", argv: ["instance-probe"],
  });
}, 60_000);

// The account's pwsh script policy (the one dori.ps1 runs under), set for a test and put back after it (the installer must see a known starting policy).
const withPolicy = async (policy: string, body: () => Promise<void>) => {
  const before = (await command(["pwsh", "-NoProfile", "-Command", "Remove-Item Env:PSExecutionPolicyPreference -ErrorAction SilentlyContinue; [string](Get-ExecutionPolicy -Scope CurrentUser)"])).trim();
  await command(["pwsh", "-NoProfile", "-Command", `Remove-Item Env:PSExecutionPolicyPreference -ErrorAction SilentlyContinue; Set-ExecutionPolicy -ExecutionPolicy ${policy} -Scope CurrentUser -Force`]);
  try { await body(); } finally {
    await command(["pwsh", "-NoProfile", "-Command", `Remove-Item Env:PSExecutionPolicyPreference -ErrorAction SilentlyContinue; Set-ExecutionPolicy -ExecutionPolicy ${before} -Scope CurrentUser -Force`]);
  }
};
const currentUserPolicy = async () => (await command(["pwsh", "-NoProfile", "-Command", "Remove-Item Env:PSExecutionPolicyPreference -ErrorAction SilentlyContinue; [string](Get-ExecutionPolicy -Scope CurrentUser)"])).trim();

test.skipIf(process.platform !== "win32")("review 2 of #306 a script policy already RemoteSigned is left alone and nothing is asked", async () => {
  using f = await installFixture();
  await withPolicy("RemoteSigned", async () => {
    // When the installer runs where it could ask.
    const out = await f.shell(f.install, { interactive: true, stdin: "y\n" });
    // Then it asks nothing and changes nothing.
    expect(out).toContain("EXECUTION_POLICY_OK RemoteSigned");
    expect(out).not.toContain("[y/N]");
    expect(await currentUserPolicy()).toBe("RemoteSigned");
  });
}, 90_000);

test.skipIf(process.platform !== "win32").each([["y", "RemoteSigned", "EXECUTION_POLICY_SET"], ["n", "Restricted", "EXECUTION_POLICY_UNCHANGED"]] as const)("review 2 of #306 a Restricted policy is changed only after the user answers yes (answer %s)", async (answer, after, line) => {
  using f = await installFixture();
  await withPolicy("Restricted", async () => {
    // When the installer asks and the user answers.
    const out = await f.shell(f.install, { interactive: true, stdin: `${answer}\n` });
    // Then it showed the change and why before asking, applied it only on yes, and finished the install either way.
    expect(out).toContain("Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser");
    expect(out).toContain("[y/N]");
    expect(out).toContain(line);
    expect(out).toContain("DORI_INSTALLED");
    expect(await currentUserPolicy()).toBe(after);
    if (answer === "n") expect(out).toContain("pwsh -NoProfile -ExecutionPolicy Bypass -File");
  });
}, 90_000);

test.skipIf(process.platform !== "win32")("review 2 of #306 a run that cannot ask changes no policy and says how to run Dori", async () => {
  using f = await installFixture();
  await withPolicy("Restricted", async () => {
    // When the installer runs with -NonInteractive.
    const out = await f.shell(f.install);
    // Then nothing was asked or changed, the commands are shown, and the install finished.
    expect(out).not.toContain("[y/N]");
    expect(out).toContain("EXECUTION_POLICY_UNCHANGED Restricted");
    expect(out).toContain("Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser");
    expect(out).toContain("pwsh -NoProfile -ExecutionPolicy Bypass -File");
    expect(out).toContain("DORI_INSTALLED");
    expect(await currentUserPolicy()).toBe("Restricted");
  });
}, 90_000);

test.skipIf(process.platform !== "win32")("review 2 of #306 the launcher hands & | quotes and empty arguments to Dori as they are, and runs nothing else", async () => {
  // Given an installation, a CLI probe, and a marker file a smuggled command would create.
  using f = await installFixture();
  await f.shell(f.install);
  const capture = prepareInstanceProbe(f);
  const marker = join(f.root, "smuggled.txt");
  // When pwsh runs the launcher as a user types it, with metacharacters, embedded quotes and an empty argument.
  const script = join(f.root, "args.ps1");
  writeFileSync(script, `\uFEFF& ${quote(f.launcher)} instance-probe 'hello&echo x>${marker}' 'a|b' 'say "hi"' '' 'two words'
if ($LASTEXITCODE -ne 0) { throw "launcher failed: $LASTEXITCODE" }`);
  await command(["pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], f.root);
  // Then Dori got exactly those arguments and nothing else ran.
  expect(((await Bun.file(capture).json()) as { argv: string[] }).argv).toEqual(["instance-probe", `hello&echo x>${marker}`, "a|b", 'say "hi"', "", "two words"]);
  expect(existsSync(marker)).toBe(false);
}, 90_000);

test.skipIf(process.platform !== "win32")("review 3 of #306 a hook naming dori runs through the installed runner without PowerShell", async () => {
  // Given an installation and a CLI probe in it.
  using f = await installFixture();
  await f.shell(f.install);
  const capture = prepareInstanceProbe(f);
  // When the installed runner runs a hook argv that names dori, as freshness runs threadReply.
  const runTs = join(f.home, "src", "skills", "dori-mode", "scripts", "src", "run.ts");
  const out = await command([process.execPath, "-e", `const { run } = await import(${JSON.stringify(runTs)}); const r = await run(["dori", "instance-probe", "a&b | c", ""]); console.log(JSON.stringify(r.code));`], f.root);
  // Then it ran the CLI with the arguments as they are.
  expect(out.trim()).toBe("0");
  expect(((await Bun.file(capture).json()) as { argv: string[] }).argv).toEqual(["instance-probe", "a&b | c", ""]);
}, 90_000);

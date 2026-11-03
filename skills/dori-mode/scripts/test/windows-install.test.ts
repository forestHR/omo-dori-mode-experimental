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
    & ${quote(join(f.home, "bin", "dori.cmd"))} instance-probe
    if ($LASTEXITCODE -ne 0) { throw "launcher failed: $LASTEXITCODE" }
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
  expect(existsSync(join(f.home, "bin", "dori.cmd"))).toBe(false);
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
  expect(existsSync(join(f.home, "bin", "dori.cmd"))).toBe(false);
}, 60_000);

test.skipIf(process.platform !== "win32").each(["chosen home", "설치-試験"] as const)("review 1 launcher selects its config env and state from clean environment at %s", async (homeName) => {
  // Given a completed installation, a distinctive config/env, and a CLI probe using the real config loaders.
  using f = await installFixture(homeName);
  await f.shell(f.install);
  const capture = prepareInstanceProbe(f);
  // When the real generated launcher starts without DORI_CONFIG, DORI_ENV_FILE or DORI_STATE_DIR.
  await f.shell(`& ${quote(join(f.home, "bin", "dori.cmd"))} instance-probe; if ($LASTEXITCODE -ne 0) { throw "launcher failed: $LASTEXITCODE" }`);
  // Then the selected installation supplies all locations and values, even under a Unicode path.
  expect(await Bun.file(capture).json()).toEqual({
    config: f.config, env: join(f.home, "dori.env"), state: join(f.home, "state"),
    model: "review/model", marker: "chosen-env", argv: ["instance-probe"],
  });
}, 60_000);

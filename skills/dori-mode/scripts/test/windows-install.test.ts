import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
const cleanEnv = () => Object.fromEntries(Object.entries(Bun.env).filter(([name]) => !name.startsWith("DORI_")));
const command = async (argv: string[]) => {
  const child = Bun.spawn(argv, { env: cleanEnv(), stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, out, err }).toMatchObject({ code: 0 });
  return out;
};

const fixture = async (homeName = "home") => {
  const root = mkdtempSync(join(tmpdir(), "dori-win-install-"));
  roots.push(root);
  const upstream = join(root, "upstream");
  const home = join(root, homeName);
  const repo = resolve(import.meta.dir, "../../../..");
  await command(["git", "clone", "-q", "--no-hardlinks", repo, upstream]);
  await command(["git", "-C", upstream, "checkout", "-qb", "fixture"]);
  mkdirSync(home);
  const config = join(home, "config.json");
  const install = `& ${quote(join(repo, "install.ps1"))} -Repo ${quote(upstream)} -Branch fixture -DoriHome ${quote(home)}`;
  const shell = async (body: string) => {
    const script = join(root, "install-test.ps1");
    writeFileSync(script, `\uFEFF
      $ErrorActionPreference = "Stop"
      $oldPath = [Environment]::GetEnvironmentVariable("Path", "User")
      function herdr { $global:LASTEXITCODE = 0; "fixture-herdr" }
      function omo { $global:LASTEXITCODE = 0; "fixture-omo" }
      try { ${body} } finally { [Environment]::SetEnvironmentVariable("Path", $oldPath, "User") }
    `);
    return command(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script]);
  };
  return { root, home, repo, upstream, config, install, shell };
};

test.skipIf(process.platform !== "win32").each(["fresh", "existing"] as const)("Windows installer creates a working shim with %s config", async (mode) => {
  // Given an isolated local upstream and no inherited instance selectors.
  const f = await fixture();
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

test.skipIf(process.platform !== "win32")("review 1 installer aborts a failed checkout instead of pulling the old branch", async () => {
  // Given an existing fixture branch and a requested branch that does not exist.
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture(homeName);
  await f.shell(f.install);
  writeFileSync(f.config, JSON.stringify({ backend: "herdr", defaultModel: "review/model" }));
  writeFileSync(join(f.home, "dori.env"), "DORI_REVIEW_MARKER=chosen-env\n");
  const capture = join(f.root, "instance.json");
  writeFileSync(join(f.home, "src", "skills", "dori-mode", "scripts", "src", "cli.ts"), `
    import { resolve } from "node:path";
    import { configPath, envFilePath, loadConfig, loadEnvFile } from "./config.ts";
    await loadEnvFile(envFilePath());
    const config = await loadConfig();
    await Bun.write(${JSON.stringify(capture)}, JSON.stringify({
      config: resolve(configPath()), env: resolve(envFilePath()), state: resolve(config.stateDir),
      model: config.defaultModel, marker: process.env.DORI_REVIEW_MARKER, argv: process.argv.slice(2),
    }));
  `);
  // When the real generated launcher starts without DORI_CONFIG, DORI_ENV_FILE or DORI_STATE_DIR.
  await f.shell(`& ${quote(join(f.home, "bin", "dori.cmd"))} instance-probe; if ($LASTEXITCODE -ne 0) { throw "launcher failed: $LASTEXITCODE" }`);
  // Then the selected installation supplies all locations and values, even under a Unicode path.
  expect(await Bun.file(capture).json()).toEqual({
    config: f.config, env: join(f.home, "dori.env"), state: join(f.home, "state"),
    model: "review/model", marker: "chosen-env", argv: ["instance-probe"],
  });
}, 60_000);

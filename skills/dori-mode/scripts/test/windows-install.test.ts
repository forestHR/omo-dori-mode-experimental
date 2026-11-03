import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const command = async (argv: string[]) => {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, err }).toMatchObject({ code: 0 });
  return out;
};

test.skipIf(process.platform !== "win32").each(["fresh", "existing"] as const)("Windows installer creates a working shim with %s config", async (mode) => {
  // Given a local upstream and isolated install home; external tools are already installed.
  const root = mkdtempSync(join(tmpdir(), "dori-win-install-"));
  roots.push(root);
  const upstream = join(root, "upstream");
  const home = join(root, "home");
  const repo = resolve(import.meta.dir, "../../../..");
  await command(["git", "clone", "-q", "--no-hardlinks", repo, upstream]);
  await command(["git", "-C", upstream, "checkout", "-qb", "fixture"]);
  mkdirSync(home);
  const config = join(home, "config.json");
  const preserved = { backend: "herdr", leadPane: "w9:p9", defaultModel: "preserved/model" };
  if (mode === "existing") {
    await command(["git", "clone", "-q", "--branch", "fixture", upstream, join(home, "src")]);
    writeFileSync(config, JSON.stringify(preserved));
  }
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const script = join(root, "install-test.ps1");
  writeFileSync(script, `
    $ErrorActionPreference = "Stop"
    $oldPath = [Environment]::GetEnvironmentVariable("Path", "User")
    function herdr { "fixture-herdr" }
    function omo { "fixture-omo" }
    $env:DORI_CONFIG = ${quote(config)}
    $env:DORI_STATE_DIR = ${quote(join(home, "state"))}
    $env:DORI_ENV_FILE = ${quote(join(home, "dori.env"))}
    try {
      & ${quote(join(repo, "install.ps1"))} -Repo ${quote(upstream)} -Branch fixture -DoriHome ${quote(home)}
      if ($LASTEXITCODE -ne 0) { throw "install failed: $LASTEXITCODE" }
      & ${quote(join(home, "bin", "dori.cmd"))} serve --help
      if ($LASTEXITCODE -ne 0) { throw "shim failed: $LASTEXITCODE" }
    } finally {
      [Environment]::SetEnvironmentVariable("Path", $oldPath, "User")
    }
  `);
  // When the actual native installer runs (including the generated dori.cmd).
  await command(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script]);
  // Then it installs a herdr config or preserves the existing config.
  const actual: unknown = await Bun.file(config).json();
  expect(actual).toMatchObject(mode === "existing" ? preserved : { backend: "herdr", agentCommand: ["omo", "--model", "{model}", "{prompt}"] });
}, 60_000);

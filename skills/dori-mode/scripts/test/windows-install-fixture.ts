import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { powershellLiteral as quote } from "../src/powershell.ts";

const cleanEnv = () => Object.fromEntries(Object.entries(Bun.env).filter(([name]) => !name.startsWith("DORI_")));
export const command = async (argv: readonly string[], cwd?: string) => {
  const child = Bun.spawn([...argv], { cwd, env: cleanEnv(), stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, out, err }).toMatchObject({ code: 0 });
  return out;
};

export const installFixture = async (homeName = "home") => {
  const root = mkdtempSync(join(tmpdir(), "dori-win-install-"));
  const upstream = join(root, "upstream");
  const home = join(root, homeName);
  const skills = join(root, "configured-skills");
  const profile = join(root, "profile");
  const repo = resolve(import.meta.dir, "../../../..");
  await command(["git", "clone", "-q", "--no-hardlinks", repo, upstream]);
  await command(["git", "-C", upstream, "checkout", "-qb", "fixture"]);
  mkdirSync(home);
  mkdirSync(profile);
  const config = join(home, "config.json");
  const install = `& ${quote(join(repo, "install.ps1"))} -Repo ${quote(upstream)} -Branch fixture -DoriHome ${quote(home)}`;
  const shell = async (body: string) => {
    const script = join(root, "install-test.ps1");
    writeFileSync(script, `\uFEFF
      $ErrorActionPreference = "Stop"
      $oldPath = [Environment]::GetEnvironmentVariable("Path", "User")
      $env:SKILLS_DIR = ${quote(skills)}
      function herdr { $global:LASTEXITCODE = 0; "fixture-herdr" }
      function omo { $global:LASTEXITCODE = 0; "fixture-omo" }
      try { ${body} } finally { [Environment]::SetEnvironmentVariable("Path", $oldPath, "User") }
    `);
    return command(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], root);
  };
  return {
    root, home, repo, upstream, config, skills, profile, install, shell,
    [Symbol.dispose]() { rmSync(root, { recursive: true, force: true }); },
  } as const;
};

export type InstallFixture = Awaited<ReturnType<typeof installFixture>>;

export const prepareInstanceProbe = (fixture: InstallFixture): string => {
  writeFileSync(fixture.config, JSON.stringify({ backend: "herdr", defaultModel: "review/model" }));
  writeFileSync(join(fixture.home, "dori.env"), "DORI_REVIEW_MARKER=chosen-env\n");
  const capture = join(fixture.root, "instance.json");
  writeFileSync(join(fixture.home, "src", "skills", "dori-mode", "scripts", "src", "cli.ts"), `
    import { resolve } from "node:path";
    import { configPath, envFilePath, loadConfig, loadEnvFile } from "./config.ts";
    await loadEnvFile(envFilePath());
    const config = await loadConfig();
    await Bun.write(${JSON.stringify(capture)}, JSON.stringify({
      config: resolve(configPath()), env: resolve(envFilePath()), state: resolve(config.stateDir),
      model: config.defaultModel, marker: process.env.DORI_REVIEW_MARKER, argv: process.argv.slice(2),
    }));
  `);
  return capture;
};

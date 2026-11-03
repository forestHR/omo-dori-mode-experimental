import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { powershellLiteral as quote } from "../src/powershell.ts";
import { installFixture, type InstallFixture } from "./windows-install-fixture.ts";

const discover = async (executable: string, fixture: InstallFixture, configuredRoot?: string) => {
  const outside = join(fixture.root, "outside-checkout");
  mkdirSync(outside, { recursive: true });
  const clean = Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !/^(DORI_|OMO_|PI_)/.test(key)));
  const child = Bun.spawn([executable, "--mode", "rpc", "--offline", "--no-session", "--no-extensions",
    "--no-context-files", "--no-prompt-templates", "--no-themes", "--provider", "openai", "--model", "gpt-4o-mini",
    ...(configuredRoot ? ["--skill", configuredRoot] : []),
  ], {
    cwd: outside,
    env: { ...clean, HOME: fixture.profile, USERPROFILE: fixture.profile,
      OMO_CODING_AGENT_DIR: join(fixture.profile, ".omo", "agent"), OPENAI_API_KEY: "fixture-not-used" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const errors = new Response(child.stderr).text();
  const timeout = AbortSignal.timeout(20_000);
  const deadline = new Promise<never>((_resolve, reject) =>
    timeout.addEventListener("abort", () => reject(new TypeError("Skill RPC discovery timed out")), { once: true }));
  const inventory = (async () => {
    let rest = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      const lines = (rest + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
      rest = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        const response: unknown = JSON.parse(line);
        if (typeof response !== "object" || response === null || !("id" in response) || response.id !== "skills") continue;
        if (!("success" in response) || response.success !== true || !("data" in response) ||
            typeof response.data !== "object" || response.data === null ||
            !("commands" in response.data) || !Array.isArray(response.data.commands)) {
          throw new TypeError(`Invalid skill inventory response: ${JSON.stringify(response)}`);
        }
        return response.data.commands.flatMap((command: unknown) =>
          typeof command === "object" && command !== null && "name" in command && typeof command.name === "string" &&
          "source" in command && typeof command.source === "string" ? [{ name: command.name, source: command.source }] : []);
      }
    }
    throw new TypeError(`Agent exited before skill discovery: ${await errors}`);
  })();
  try {
    // Subscribe before sending a read-only inventory request; no prompt or model call is made.
    child.stdin.write('{"id":"skills","type":"get_commands"}\n');
    await child.stdin.flush();
    return await Promise.race([inventory, deadline]);
  } finally {
    child.stdin.end();
    child.kill();
    await child.exited;
    await errors;
  }
};

describe.skipIf(process.platform !== "win32")("native Windows skill discovery", () => {
  let download: string;
  let executable: string;
  beforeAll(async () => {
    download = mkdtempSync(join(tmpdir(), "dori-skill-agent-"));
    executable = join(download, "omo.exe");
    // Immutable public release fixture, not the installer stub used by the other tests.
    const response = await fetch("https://github.com/code-yeongyu/oh-my-openagent/releases/download/v5.1.58/omo-windows-x64.exe", {
      signal: AbortSignal.timeout(60_000),
    });
    expect(response.status).toBe(200);
    await Bun.write(executable, response);
  }, 120_000);
  afterAll(() => rmSync(download, { recursive: true, force: true }));

  test("review 2 a fresh agent discovers the default skill junction outside the checkout", async () => {
    // Given an isolated Windows profile with no configured skill-path override.
    using f = await installFixture();
    expect((await discover(executable, f)).find((command) => command.name === "skill:dori-mode")).toBeUndefined();
    // When the real installer registers the default global skill.
    await f.shell(`$env:USERPROFILE = ${quote(f.profile)}; Remove-Item Env:SKILLS_DIR; ${f.install}`);
    // Then the real agent discovers it from an unrelated working directory.
    expect((await discover(executable, f)).find((command) => command.name === "skill:dori-mode")?.source).toBe("skill");
  }, 60_000);

  test("review 2 an agent discovers the configured skill search directory outside the checkout", async () => {
    // Given an agent configured to search the same custom SKILLS_DIR used by the installer.
    using f = await installFixture();
    mkdirSync(f.skills, { recursive: true });
    expect((await discover(executable, f, f.skills)).find((command) => command.name === "skill:dori-mode")).toBeUndefined();
    // When installation creates its skill junction there.
    await f.shell(f.install);
    // Then real skill discovery loads it without relying on the checkout as cwd.
    expect((await discover(executable, f, f.skills)).find((command) => command.name === "skill:dori-mode")?.source).toBe("skill");
  }, 60_000);

  test("review 2 installation preserves an existing local skill", async () => {
    // Given a discoverable local skill that belongs to the caller, not this installer.
    using f = await installFixture();
    const dir = join(f.skills, "dori-mode");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "SKILL.md");
    const original = "---\nname: dori-mode\ndescription: Preserved local Dori skill for this fixture.\n---\n# Local skill\n";
    writeFileSync(file, original);
    const digest = new Bun.CryptoHasher("sha256").update(original).digest("hex");
    // When installing into that existing skill directory.
    await f.shell(f.install);
    // Then its bytes remain untouched and the real agent still discovers the local skill.
    expect(new Bun.CryptoHasher("sha256").update(await Bun.file(file).bytes()).digest("hex")).toBe(digest);
    expect((await discover(executable, f, f.skills)).find((command) => command.name === "skill:dori-mode")?.source).toBe("skill");
  }, 60_000);
});

import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentLine } from "../src/herdr.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.skipIf(process.platform !== "win32").each(["pwsh", "powershell"])("review 2 preserves quote delimiters and path metacharacters in %s", async (shell) => {
  // Given a real executable under every single-quote delimiter and shell metacharacters.
  const root = mkdtempSync(join(tmpdir(), "dori-quote-review2-"));
  roots.push(root);
  const quotes = "'\u2018\u2019\u201a\u201b";
  const dir = join(root, `O${quotes}Connor & semi; $name`);
  mkdirSync(dir);
  const executable = join(dir, "agent.exe");
  copyFileSync(process.execPath, executable);
  const capture = join(root, "capture.json");
  const marker = join(root, "injected");
  const value = `${quotes}; [IO.File]::WriteAllText($env:INJECTION_MARKER,'injected'); #`;
  const program = `await Bun.write(process.env.QUOTE_CAPTURE, JSON.stringify({ arg: process.argv.at(-1), value: process.env.QUOTE_VALUE }));`;
  const line = agentLine([executable, "--eval", program, "--", value], { QUOTE_CAPTURE: capture, QUOTE_VALUE: value });
  // When the generated agent command is parsed and executed by PowerShell.
  const child = Bun.spawn([shell, "-NoProfile", "-NonInteractive", "-Command", line], {
    env: { ...Bun.env, INJECTION_MARKER: marker }, stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  // Then both values reach the real process verbatim, without executing the payload.
  expect({ code, out, err }).toMatchObject({ code: 0 });
  expect(await Bun.file(capture).json()).toEqual({ arg: value, value });
  expect(existsSync(marker)).toBe(false);
}, 30_000);

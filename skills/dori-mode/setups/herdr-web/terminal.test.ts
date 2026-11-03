import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { focusLead } from "./terminal.ts";
import type { Runner } from "../../scripts/src/run.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("focuses the configured lead's tab before attaching with a fake herdr", async () => {
  // Given: a different focused shell tab must not decide the initial browser tab.
  const dir = mkdtempSync(join(tmpdir(), "herdr-web-terminal-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".bun/bin"), { recursive: true });
  symlinkSync(process.execPath, join(dir, ".bun/bin/bun"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ leadPane: "w1:p7" }));
  writeFileSync(join(dir, "herdr"), `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/calls"
case "$*" in
  "pane get w1:p7") printf '%s\\n' '{"result":{"pane":{"tab_id":"w1:t3"}}}';;
  "tab focus w1:t3") printf '%s\\n' '{"result":{}}';;
  "") exit 17;;
  *) exit 1;;
esac
`, { mode: 0o700 });
  // When: run the same per-client wrapper ttyd invokes, using DORI_CONFIG.
  const child = Bun.spawn(["/bin/sh", join(import.meta.dir, "terminal.sh")], {
    env: { ...Bun.env, HOME: dir, PATH: `${dir}:${Bun.env.PATH}`, DORI_CONFIG: join(dir, "config.json"), DORI_LEAD_PANE: undefined },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  // Then: attach is last and its exit status is preserved by exec.
  expect(err).toBe("");
  expect(code).toBe(17);
  expect((await Bun.file(join(dir, "calls")).text()).split("\n")).toEqual([
    "pane get w1:p7", "tab focus w1:t3", "", "",
  ]);
});

test("does not attach through a failed lead-tab focus", async () => {
  // Given
  const runner: Runner = async (argv) => argv[1] === "pane"
    ? { code: 0, out: '{"result":{"pane":{"tab_id":"w1:t3"}}}', err: "" }
    : { code: 1, out: "", err: "missing tab" };
  // When
  const result = focusLead(runner, "w1:p7");
  // Then
  await expect(result).rejects.toThrow("Cannot focus lead tab");
});

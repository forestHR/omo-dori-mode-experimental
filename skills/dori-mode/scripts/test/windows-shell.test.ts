import { expect, test } from "bun:test";
import { openHerdrSession, requireHerdrPwsh } from "../src/herdr.ts";
import { run, type Runner } from "../src/run.ts";
import { fakeClock } from "./fakes.ts";

test.skipIf(process.platform !== "win32")("review 3 refuses a real Windows PowerShell pane before launching its agent", async () => {
  // Given an actual legacy shell kept alive by its input stream.
  const shell = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", "[Console]::ReadLine()"], {
    stdin: "pipe", stdout: "ignore", stderr: "ignore",
  });
  let launches = 0;
  const runner: Runner = async (argv, options) => {
    if (argv[0] !== "herdr") return run(argv, options);
    if (argv[2] === "read") return { code: 0, out: "PS> ", err: "" };
    if (argv[2] === "run") launches++;
    const result = argv[2] === "create"
      ? { root_pane: { pane_id: "w1:p1" } }
      : { process_info: { shell_pid: shell.pid } };
    return { code: 0, out: JSON.stringify({ result }), err: "" };
  };
  try {
    // When opening the agent would use the pane's real legacy executable.
    await expect(openHerdrSession(runner, fakeClock(0), { title: "unsupported", cwd: process.cwd(), argv: ["omo"] })).rejects.toMatchObject({
      code: "HERDR_SHELL_UNSUPPORTED", pane: "w1:p1",
    });
    // Then no launch command is sent to that pane.
    expect(launches).toBe(0);
  } finally {
    shell.stdin.end();
    shell.kill();
    await shell.exited;
  }
}, 30_000);

test("review 3 refuses pwsh versions without standard native argument passing", async () => {
  // Given a discovered pwsh 7.2 executable.
  const runner: Runner = async (argv) => ({
    code: 0, err: "",
    out: argv[0] === "herdr" ? '{"result":{"process_info":{"shell_pid":7}}}'
      : argv[0] === "powershell" ? '[{"ProcessId":7,"ParentProcessId":1,"CommandLine":"pwsh.exe","ExecutablePath":"pwsh.exe"}]'
      : "7.2.24",
  });
  // When the pane's shell capability is checked.
  await expect(requireHerdrPwsh(runner, "w1:p1", "win32")).rejects.toMatchObject({
    code: "HERDR_SHELL_UNSUPPORTED", version: "7.2.24",
  });
});

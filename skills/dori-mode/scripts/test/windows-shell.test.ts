import { expect, test } from "bun:test";
import { agentLine, HerdrShellError, openHerdrSession, requireHerdrPwsh } from "../src/herdr.ts";
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

const pwshAt = (version: string): Runner => async (argv) => ({
  code: 0, err: "",
  out: argv[0] === "herdr" ? '{"result":{"process_info":{"shell_pid":7}}}'
    : argv[0] === "powershell" ? '[{"ProcessId":7,"ParentProcessId":1,"CommandLine":"pwsh.exe","ExecutablePath":"pwsh.exe"}]'
    : version,
});

test("review 6 refuses an empty environment value on pwsh before 7.5", async () => {
  // Given pwsh 7.4, which removes a variable assigned an empty string.
  // When a launch sets CUDA_VISIBLE_DEVICES to "" (no GPU), it is refused and names the variable.
  await expect(requireHerdrPwsh(pwshAt("7.4.6"), "w1:p1", "win32", ["CUDA_VISIBLE_DEVICES"])).rejects.toThrow(/CUDA_VISIBLE_DEVICES needs pwsh 7\.5\+/);
  // Then a launch without empty values, or on 7.5, goes ahead.
  await expect(requireHerdrPwsh(pwshAt("7.4.6"), "w1:p1", "win32", [])).resolves.toBeUndefined();
  await expect(requireHerdrPwsh(pwshAt("7.5.0"), "w1:p1", "win32", ["CUDA_VISIBLE_DEVICES"])).resolves.toBeUndefined();
});

test.skipIf(process.platform !== "win32")("review 6 a real pwsh child sees an empty value as empty, or the launch is refused", async () => {
  // Given the runner's real pwsh and a launch that sets DORI_EMPTY to "" and removes DORI_ABSENT.
  const version = (await run(["pwsh", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"])).out.trim();
  const shell = Bun.spawn(["pwsh", "-NoProfile", "-NonInteractive", "-Command", "[Console]::ReadLine()"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  const runner: Runner = async (argv, options) => argv[0] === "herdr" ? { code: 0, err: "", out: JSON.stringify({ result: { process_info: { shell_pid: shell.pid } } }) } : run(argv, options);
  try {
    const probe = "console.log(JSON.stringify([process.env.DORI_EMPTY ?? null, process.env.DORI_ABSENT ?? null]))";
    const line = agentLine([process.execPath, "-e", probe], { DORI_EMPTY: "", DORI_ABSENT: undefined }, "win32");
    const [major = 0, minor = 0] = version.split(".").map(Number);
    if (major > 7 || (major === 7 && minor >= 5)) {
      // When it runs under pwsh 7.5+, the child sees DORI_EMPTY present and empty, and DORI_ABSENT absent.
      await expect(requireHerdrPwsh(runner, "w1:p1", "win32", ["DORI_EMPTY"])).resolves.toBeUndefined();
      const out = await run(["pwsh", "-NoProfile", "-NonInteractive", "-Command", line], { env: { ...Bun.env, DORI_ABSENT: "x" } });
      expect(JSON.parse(out.out.trim())).toEqual(["", null]);
    } else {
      // When pwsh is older, the launch is refused before anything runs.
      await expect(requireHerdrPwsh(runner, "w1:p1", "win32", ["DORI_EMPTY"])).rejects.toBeInstanceOf(HerdrShellError);
    }
  } finally {
    shell.stdin.end();
    shell.kill();
    await shell.exited;
  }
}, 30_000);

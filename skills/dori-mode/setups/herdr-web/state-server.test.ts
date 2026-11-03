import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStateServer } from "./state-server.ts";

const children: { kill(): void; readonly exited: Promise<number> }[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const child of children) child.kill();
  await Promise.all(children.splice(0).map((child) => child.exited));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test.each(["", "Bearer wrong-secret"])("refuses helper state without its shared secret (%s)", async (authorization) => {
  // Given
  let calls = 0;
  const server = startStateServer({ port: 0, secret: "account-local-secret" }, async () => {
    calls++;
    return { code: 0, out: "", err: "" };
  });
  try {
    // When
    const response = await fetch(`${server.url}state`, { headers: { authorization } });
    // Then
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
    expect(calls).toBe(0);
  } finally {
    server.stop(true);
  }
});

async function accountService(source: string, env: Readonly<Record<string, string | undefined>>) {
  const ready = Promise.withResolvers<number>();
  const child = Bun.spawn([process.execPath, "--eval", source], {
    env, stdout: "pipe", stderr: "pipe",
    ipc(message: unknown) {
      if (typeof message === "number") ready.resolve(message);
      else ready.reject(new TypeError("Expected the service port"));
    },
    onExit(_child, code, _signal, error) {
      ready.reject(error ?? new TypeError(`Service exited before readiness (${code})`));
    },
  });
  children.push(child);
  const timer = setTimeout(() => ready.reject(new TypeError("Service startup timed out")), 5000);
  return ready.promise.finally(() => clearTimeout(timer));
}

test("collects from the terminal account when the proxy has a different home and herdr server", async () => {
  // Given: separate service processes, account environments and distinguishable herdr data.
  const dir = mkdtempSync(join(tmpdir(), "herdr-web-accounts-"));
  dirs.push(dir);
  for (const account of ["terminal-account", "proxy-account"]) mkdirSync(join(dir, account));
  writeFileSync(join(dir, "herdr"), `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/herdr-calls"
case "$1 $2" in
  "pane list") printf '%s\\n' '{"result":{"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1"}]}}';;
  "tab list") printf '{"result":{"tabs":[{"tab_id":"w1:t1","label":"%s","focused":true}]}}\\n' "$ACCOUNT_LABEL";;
  "pane get") printf '%s\\n' '{"result":{"pane":{"pane_id":"w1:p1"}}}';;
  "pane process-info") printf '%s\\n' '{"result":{"process_info":{"foreground_processes":[]}}}';;
  *) exit 1;;
esac
`, { mode: 0o700 });
  const base = Object.fromEntries(Object.entries(Bun.env).filter(([key]) =>
    !key.startsWith("HERDR_") && !key.startsWith("TMUX") && !key.startsWith("DORI_")));
  const accountEnv = (name: string) => ({
    ...base, HOME: join(dir, name), XDG_CONFIG_HOME: join(dir, name, "config"),
    PATH: `${dir}:/usr/bin:/bin`, ACCOUNT_LABEL: name,
  });
  const helperPort = await accountService(`
import { startStateServer } from ${JSON.stringify(join(import.meta.dir, "state-server.ts"))};
const server = startStateServer({ port: 0, secret: "shared-account-secret" });
process.send(server.port);
`, accountEnv("terminal-account"));
  const proxyPort = await accountService(`
import { startProxy } from ${JSON.stringify(join(import.meta.dir, "proxy.ts"))};
const server = startProxy({ port: 0, upstreamPort: 1, passphrase: "test-login",
  origin: "http://127.0.0.1", statePort: ${helperPort}, stateSecret: "shared-account-secret" });
process.send(server.port);
`, accountEnv("proxy-account"));
  const origin = `http://127.0.0.1:${proxyPort}`;
  const login = await fetch(`${origin}/login`, {
    method: "POST", body: new URLSearchParams({ passphrase: "test-login" }), redirect: "manual",
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  // When: use the public cookie-protected endpoint, not the collector directly.
  const response = await fetch(`${origin}/__dori/state`, { headers: { cookie } });
  // Then: the proxy's different herdr data must never be read.
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([
    { pane: "w1:p1", label: "terminal-account", state: "none", focused: true },
  ]);
  expect(await Bun.file(join(dir, "terminal-account", "herdr-calls")).exists()).toBe(true);
  expect(await Bun.file(join(dir, "proxy-account", "herdr-calls")).exists()).toBe(false);
}, 15000);

import { afterEach, expect, test } from "bun:test";
import { passphraseFrom, startProxy } from "./proxy.ts";
import { cachedState } from "./state.ts";
import { startStateServer } from "./state-server.ts";
import type { Runner } from "../../scripts/src/run.ts";

const servers: Pick<ReturnType<typeof startProxy>, "stop">[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

function fixture(upstreamPort = 1, runner?: Runner) {
  const helper = startStateServer({ port: 0, secret: "test-state-secret" }, runner);
  servers.push(helper);
  if (helper.port === undefined) throw new TypeError("Expected a TCP port");
  // Reserve an ephemeral port; no real Dori endpoint is touched.
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port;
  reservation.stop(true);
  if (port === undefined) throw new TypeError("Expected a TCP port");
  const origin = `http://127.0.0.1:${port}`;
  const server = startProxy({ port, upstreamPort, passphrase: "test-only-passphrase", origin,
    statePort: helper.port, stateSecret: "test-state-secret" });
  servers.push(server);
  return { origin, port };
}

test("takes HERDR_WEB_PASSPHRASE first, else the old aoe serve passphrase, else none", () => {
  expect(passphraseFrom({ HERDR_WEB_PASSPHRASE: "own", AOE_SERVE_PASSPHRASE: "aoe" })).toBe("own");
  expect(passphraseFrom({ AOE_SERVE_PASSPHRASE: "aoe" })).toBe("aoe");
  expect(passphraseFrom({ HERDR_WEB_PASSPHRASE: "", AOE_SERVE_PASSPHRASE: "aoe" })).toBe("aoe");
  expect(passphraseFrom({})).toBeUndefined();
});

test("refuses the wrong passphrase", async () => {
  // Given
  const { origin } = fixture();
  // When
  const response = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ passphrase: "wrong" }), redirect: "manual" });
  // Then
  expect(response.status).toBe(401);
  expect(response.headers.has("set-cookie")).toBe(false);
});

const screens: Readonly<Record<string, string>> = {
  "w1:p1": " • Working (esc to interrupt)\n❯ ",
  "w1:p2": "Ask user · Pick an option\n❯ ",
  "w1:p3": "❯ ",
  "w1:p4": "shell$ ",
  "w1:p5": "❯ \n ◉ watching 1: ci",
};
const stateRunner: Runner = async (argv) => {
  const pane = argv[argv[2] === "process-info" ? 4 : 3] ?? "";
  let result: object = {};
  switch (argv[2]) {
    case "list":
      result = argv[1] === "pane"
        ? { panes: Object.keys(screens).map((pane_id, i) => ({ pane_id, tab_id: `w1:t${i + 1}` })) }
        : { tabs: Object.keys(screens).map((_, i) => ({ tab_id: `w1:t${i + 1}`, label: `Tab ${i + 1}`, focused: i === 0 })) };
      break;
    case "get": result = { pane: { pane_id: pane } }; break;
    case "process-info":
      result = { process_info: { foreground_processes: pane === "w1:p4" ? [] : [{ pid: 123, cmdline: "omo" }] } };
      break;
    case "read": return { code: 0, out: screens[pane] ?? "", err: "" };
    default: throw new TypeError(`Unexpected command ${argv.join(" ")}`);
  }
  return { code: 0, out: JSON.stringify({ result }), err: "" };
};

async function cookieFor(origin: string) {
  const response = await fetch(`${origin}/login`, {
    method: "POST", body: new URLSearchParams({ passphrase: "test-only-passphrase" }), redirect: "manual",
  });
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

test("does not read or expose pane states without this proxy's cookie", async () => {
  // Given
  let calls = 0;
  const { origin } = fixture(1, async (argv) => { calls++; return stateRunner(argv); });
  // When
  const response = await fetch(`${origin}/__dori/state`, { headers: { cookie: "herdr_session_1=forged" } });
  // Then
  expect(response.status).toBe(401);
  expect(await response.text()).toBe("Unauthorized");
  expect(calls).toBe(0);
});

test("maps live omo screens and shell panes to public states behind the cookie", async () => {
  // Given
  const { origin } = fixture(1, stateRunner);
  const cookie = await cookieFor(origin);
  // When
  const response = await fetch(`${origin}/__dori/state`, { headers: { cookie } });
  // Then
  expect(await response.json()).toEqual([
    { pane: "w1:p1", label: "Tab 1", state: "working", focused: true },
    { pane: "w1:p2", label: "Tab 2", state: "waiting", focused: false },
    { pane: "w1:p3", label: "Tab 3", state: "idle", focused: false },
    { pane: "w1:p4", label: "Tab 4", state: "none", focused: false },
    { pane: "w1:p5", label: "Tab 5", state: "working", focused: false },
  ]);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("shares one state read across clients and refreshes after two seconds", async () => {
  // Given
  let now = 0;
  let lists = 0;
  const state = cachedState(async (argv) => {
    if (argv[1] === "pane" && argv[2] === "list") lists++;
    return stateRunner(argv);
  }, () => now);
  await Promise.all([state(), state()]);
  const initial = lists;
  now = 2000;
  // When
  await state();
  // Then
  expect(initial).toBe(1);
  expect(lists).toBe(2);
});

test("injects a state bar and poll into terminal HTML", async () => {
  // Given
  const terminal = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () =>
    new Response('<html><head></head><body><div id="terminal-container"></div></body></html>', { headers: { "content-type": "text/html" } }) });
  try {
    if (terminal.port === undefined) throw new TypeError("Expected a TCP port");
    const { origin } = fixture(terminal.port, stateRunner);
    const cookie = await cookieFor(origin);
    // When
    const response = await fetch(origin, { headers: { cookie } });
    const html = await response.text();
    // Then: shipped DOM hooks, endpoint and timer, not display prose.
    expect(html).toContain('id="dori-state"');
    expect(html).toContain('fetch("/__dori/state"');
    expect(html).toContain("setInterval(update, 3000)");
    expect(html).toContain("ResizeObserver");
    expect(html).toContain("#terminal-container{");
    expect(html).toContain('name="viewport"');
  } finally {
    terminal.stop(true);
  }
});

test("sets a private per-port cookie for the correct passphrase", async () => {
  // Given
  const { origin, port } = fixture();
  // When
  const response = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ passphrase: "test-only-passphrase" }), redirect: "manual" });
  // Then
  expect(response.status).toBe(303);
  expect(response.headers.get("set-cookie")).toMatch(new RegExp(`^herdr_session_${port}=[a-f0-9]{64}; Path=/; HttpOnly; Secure; SameSite=Strict$`));
});

test("serves the login form without a valid cookie", async () => {
  // Given
  const { origin } = fixture();
  // When
  const response = await fetch(origin, { headers: { cookie: "herdr_session_8182=forged" } });
  // Then
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(await response.text()).toContain('action="/login"');
});

test("refuses websocket upgrades without the cookie", async () => {
  // Given
  const { origin } = fixture();
  // When
  const response = await fetch(`${origin}/ws`, { headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
  // Then
  expect(response.status).toBe(401);
});

test("refuses cross-origin login requests", async () => {
  // Given
  const { origin } = fixture();
  // When
  const response = await fetch(`${origin}/login`, { method: "POST", headers: { origin: "https://attacker.invalid" }, body: new URLSearchParams({ passphrase: "test-only-passphrase" }) });
  // Then
  expect(response.status).toBe(403);
});

test("does not accept another Dori's cookie", async () => {
  // Given
  const first = fixture();
  const second = fixture();
  const login = await fetch(`${first.origin}/login`, { method: "POST", body: new URLSearchParams({ passphrase: "test-only-passphrase" }), redirect: "manual" });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  // When
  const response = await fetch(`${second.origin}/ws`, { headers: { cookie, upgrade: "websocket" } });
  // Then
  expect(response.status).toBe(401);
});

test("relays compressed terminal HTML without corrupting its encoding", async () => {
  // Given
  const terminal = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
    Bun.gzipSync("terminal fixture"), { headers: { "content-encoding": "gzip" } },
  ) });
  try {
    if (terminal.port === undefined) throw new TypeError("Expected a TCP port");
    const { origin } = fixture(terminal.port);
    const login = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ passphrase: "test-only-passphrase" }), redirect: "manual" });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    // When
    const response = await fetch(origin, { headers: { cookie } });
    // Then
    expect(await response.text()).toBe("terminal fixture");
    expect(response.headers.has("content-encoding")).toBe(false);
  } finally {
    terminal.stop(true);
  }
});

test("relays authenticated terminal websocket input and binary output", async () => {
  // Given
  const terminal = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { headers: { "sec-websocket-protocol": "tty" } })) return;
      return new Response(null, { status: 400 });
    },
    websocket: { message(socket, message) { socket.send(new TextEncoder().encode(`terminal:${message}`)); } },
  });
  try {
    if (terminal.port === undefined) throw new TypeError("Expected a TCP port");
    const { origin } = fixture(terminal.port);
    const login = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ passphrase: "test-only-passphrase" }), redirect: "manual" });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const socket = new WebSocket(origin.replace("http", "ws") + "/ws", { headers: { cookie }, protocols: ["tty"] });
    socket.binaryType = "arraybuffer";
    try {
      // When: subscribe before sending input.
      const output = await new Promise<ArrayBuffer>((resolve, reject) => {
        const timeout = AbortSignal.timeout(2000);
        timeout.addEventListener("abort", () => reject(timeout.reason), { once: true });
        socket.onerror = reject;
        socket.onmessage = (event) => resolve(event.data);
        socket.onopen = () => socket.send("typed-input");
      });
      // Then
      expect(new TextDecoder().decode(output)).toBe("terminal:typed-input");
      expect(socket.protocol).toBe("tty");
    } finally {
      socket.close();
    }
  } finally {
    terminal.stop(true);
  }
});

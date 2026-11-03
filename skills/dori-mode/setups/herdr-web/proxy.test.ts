import { afterEach, expect, test } from "bun:test";
import { startProxy } from "./proxy.ts";

const servers: ReturnType<typeof startProxy>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

function fixture(upstreamPort = 1) {
  // Reserve an ephemeral port; no real Dori endpoint is touched.
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port;
  reservation.stop(true);
  if (port === undefined) throw new TypeError("Expected a TCP port");
  const origin = `http://127.0.0.1:${port}`;
  const server = startProxy({ port, upstreamPort, passphrase: "test-only-passphrase", origin });
  servers.push(server);
  return { origin, port };
}

test("refuses the wrong passphrase", async () => {
  // Given
  const { origin } = fixture();
  // When
  const response = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ passphrase: "wrong" }), redirect: "manual" });
  // Then
  expect(response.status).toBe(401);
  expect(response.headers.has("set-cookie")).toBe(false);
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

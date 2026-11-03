import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

type Config = {
  readonly port: number;
  readonly upstreamPort: number;
  readonly passphrase: string;
  readonly origin: string;
};

const loginPage = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dori herdr login</title><style>
body{background:#151923;color:#eee;font:18px system-ui;margin:0;display:grid;min-height:100vh;place-items:center}
main{width:min(85vw,360px)}input,button{box-sizing:border-box;width:100%;padding:14px;margin-top:16px;font:inherit}
button{background:#9dd5c4;border:0;border-radius:6px}label{display:block}
</style><main><h1>Dori herdr</h1><p>Sign in to your sessions.</p>
<form method="post" action="/login"><label>Passphrase
<input name="passphrase" type="password" autocomplete="current-password" required></label>
<button>Sign in</button></form></main></html>`;

const digest = (value: string) => createHash("sha256").update(value).digest();
const hopHeaders = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"] as const;

export function startProxy(config: Config) {
  const cookieName = `herdr_session_${config.port}`;
  const token = randomBytes(32).toString("hex");
  const authorized = (request: Request) =>
    request.headers.get("cookie")?.split(";").some((part) => part.trim() === `${cookieName}=${token}`) ?? false;
  const login = () => new Response(loginPage, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
  return Bun.serve<{ readonly upstream: WebSocket }>({
    hostname: "127.0.0.1",
    port: config.port,
    maxRequestBodySize: 4096,
    async fetch(request, server) {
      const url = new URL(request.url);
      const origin = request.headers.get("origin");
      if (origin && origin !== config.origin) return new Response("Forbidden origin", { status: 403 });
      if (url.pathname === "/login" && request.method === "POST") {
        if (Number(request.headers.get("content-length") ?? 0) > 4096) {
          return new Response("Request too large", { status: 413 });
        }
        const form = await request.formData();
        const passphrase = form.get("passphrase");
        if (typeof passphrase !== "string" || !timingSafeEqual(digest(passphrase), digest(config.passphrase))) {
          return new Response("Wrong passphrase", { status: 401, headers: { "cache-control": "no-store" } });
        }
        return new Response(null, { status: 303, headers: {
          location: "/",
          "cache-control": "no-store",
          "set-cookie": `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`,
        } });
      }
      const upgrading = request.headers.get("upgrade")?.toLowerCase() === "websocket";
      if (!authorized(request)) return upgrading ? new Response("Unauthorized", { status: 401 }) : login();
      const target = `http://127.0.0.1:${config.upstreamPort}${url.pathname}${url.search}`;
      if (upgrading) {
        const upstream = new WebSocket(target.replace(/^http/, "ws"), request.headers.get("sec-websocket-protocol")?.split(",").map((p) => p.trim()) ?? []);
        upstream.binaryType = "arraybuffer";
        const opened = await new Promise<boolean>((resolve) => {
          upstream.onopen = () => resolve(true);
          upstream.onerror = () => resolve(false);
          upstream.onclose = () => resolve(false);
        });
        if (!opened) {
          upstream.close();
          return new Response("Terminal unavailable", { status: 502 });
        }
        const headers = new Headers();
        if (upstream.protocol) headers.set("sec-websocket-protocol", upstream.protocol);
        if (server.upgrade(request, { data: { upstream }, headers })) return;
        upstream.close();
        return new Response("Upgrade failed", { status: 400 });
      }
      const headers = new Headers(request.headers);
      headers.delete("cookie");
      headers.delete("host");
      for (const header of hopHeaders) headers.delete(header);
      // A transparent local HTTP relay needs native streaming, not a retrying API client.
      const response = await fetch(target, {
        method: request.method, headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        signal: AbortSignal.timeout(10_000),
        redirect: "manual",
      });
      const resultHeaders = new Headers(response.headers);
      // fetch decodes ttyd's gzipped HTML; do not label the decoded stream gzip.
      resultHeaders.delete("content-encoding");
      resultHeaders.delete("content-length");
      for (const header of hopHeaders) resultHeaders.delete(header);
      resultHeaders.set("cache-control", "no-store");
      // ttyd 1.7.7 omits a viewport declaration and otherwise renders a 980px phone page.
      const body = response.headers.get("content-type")?.includes("text/html")
        ? (await response.text()).replace("<head>", '<head><meta name="viewport" content="width=device-width,initial-scale=1">')
        : response.body;
      return new Response(body, { status: response.status, headers: resultHeaders });
    },
    websocket: {
      idleTimeout: 0,
      open(socket) {
        const upstream = socket.data.upstream;
        upstream.onmessage = (event) => socket.send(event.data);
        upstream.onclose = () => socket.close();
        upstream.onerror = () => socket.close(1011, "Terminal unavailable");
      },
      message(socket, message) { socket.data.upstream.send(message); },
      close(socket) { socket.data.upstream.close(); },
    },
  });
}

// The login passphrase: HERDR_WEB_PASSPHRASE from the web env file (an install that never ran aoe), else the account's
// old aoe serve passphrase, so a Dori that moved from aoe keeps logging in with the same one.
export const passphraseFrom = (env: Readonly<Record<string, string | undefined>>): string | undefined =>
  env.HERDR_WEB_PASSPHRASE || env.AOE_SERVE_PASSPHRASE || undefined;

if (import.meta.main) {
  const port = Number(process.env.HERDR_WEB_PORT);
  const upstreamPort = Number(process.env.HERDR_TTYD_PORT);
  const passphrase = passphraseFrom(process.env);
  const origin = process.env.HERDR_WEB_ORIGIN;
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535 ||
      port === upstreamPort || !passphrase || !origin ||
      !["http:", "https:"].includes(new URL(origin).protocol) || new URL(origin).origin !== origin) {
    throw new TypeError("Set valid HERDR_WEB_PORT, HERDR_TTYD_PORT, HERDR_WEB_ORIGIN and HERDR_WEB_PASSPHRASE (or AOE_SERVE_PASSPHRASE)");
  }
  startProxy({ port, upstreamPort, passphrase, origin });
}

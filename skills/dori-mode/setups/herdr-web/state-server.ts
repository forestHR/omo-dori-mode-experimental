import { createHash, timingSafeEqual } from "node:crypto";
import { run, type Runner } from "../../scripts/src/run.ts";
import { cachedState } from "./state.ts";

type Config = { readonly port: number; readonly secret: string };
const digest = (value: string) => createHash("sha256").update(value).digest();

// This process belongs to the terminal account, even when the browser proxy does not.
export function startStateServer(config: Config, runner: Runner = run) {
  const state = cachedState(runner);
  const authorization = digest(`Bearer ${config.secret}`);
  return Bun.serve({
    hostname: "127.0.0.1",
    port: config.port,
    maxRequestBodySize: 0,
    async fetch(request) {
      const headers = { "cache-control": "no-store" };
      if (!timingSafeEqual(digest(request.headers.get("authorization") ?? ""), authorization)) {
        return new Response("Unauthorized", { status: 401, headers });
      }
      if (request.method !== "GET" || new URL(request.url).pathname !== "/state") {
        return new Response("Not found", { status: 404, headers });
      }
      return Response.json(await state(), { headers });
    },
  });
}

if (import.meta.main) {
  const port = Number(process.env.HERDR_STATE_PORT);
  const secret = process.env.HERDR_STATE_SECRET;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !secret) {
    throw new TypeError("Set valid HERDR_STATE_PORT and HERDR_STATE_SECRET");
  }
  startStateServer({ port, secret });
}

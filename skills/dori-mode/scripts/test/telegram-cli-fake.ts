// HTTP boundary fake for `dori inbound telegram` subprocesses: every request is logged to DORI_TEST_TG_LOG and answered
// with the updates in DORI_TEST_TG_BATCH; with DORI_TEST_TG_AFTER set, the answer waits (up to 5 s) for that file, which
// the test's stdout reader creates once it has closed its end.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  appendFileSync(process.env.DORI_TEST_TG_LOG ?? "", `${JSON.stringify({ url: String(input), body: String(init?.body ?? "") })}\n`);
  if (!String(input).startsWith("https://api.telegram.org/botfake/")) throw new Error(`unexpected request ${String(input)}`);
  const after = process.env.DORI_TEST_TG_AFTER;
  for (let waited = 0; after && !existsSync(after); waited += 10) {
    if (waited > 5000) throw new Error(`${after} never appeared`);
    await Bun.sleep(10);
  }
  return Response.json({ ok: true, result: JSON.parse(readFileSync(process.env.DORI_TEST_TG_BATCH ?? "", "utf8")) });
}, { preconnect: () => {} }) as typeof fetch;

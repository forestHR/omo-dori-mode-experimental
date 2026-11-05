// HTTP boundary fake for CLI subprocesses; thread state survives separate commands.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const file = process.env.DORI_TEST_HTTP ?? "";
type State = { name: string; archived: boolean; calls: { method: string; path: string; body: Record<string, unknown>; files?: { field: string; name: string; type: string; text: string }[] }[] };
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const state: State = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { name: "", archived: false, calls: [] };
  const path = String(input).replace("https://discord.com/api/v10", "");
  const method = init?.method ?? "GET";
  // a message with attachments is multipart: its payload_json is the body, each files[n] part is kept as written
  const form = init?.body instanceof FormData ? init.body : undefined;
  const body: Record<string, unknown> = JSON.parse(form ? String(form.get("payload_json")) : String(init?.body ?? "{}"));
  const files = form ? await Promise.all([...form.entries()].filter(([k]) => k !== "payload_json").map(async ([field, v]) => {
    const part: unknown = v;
    if (!(part instanceof File)) throw new Error(`multipart part ${field} is not a file`);
    return { field, name: part.name, type: part.type, text: await part.text() };
  })) : undefined;
  if (form && new Headers(init?.headers).has("content-type")) throw new Error("a multipart request must let fetch set its own content-type (with the boundary)");
  state.calls.push({ method, path, body, ...(files ? { files } : {}) });
  // <file>.auth: the Authorization header of each request, in order (which bot token went out)
  const auth = `${file}.auth`;
  writeFileSync(auth, JSON.stringify([...(existsSync(auth) ? (JSON.parse(readFileSync(auth, "utf8")) as string[]) : []), new Headers(init?.headers).get("authorization") ?? ""]));
  let result: unknown = {};
  if (method === "POST" && path.endsWith("/threads")) {
    state.name = String(body.name);
    result = { id: "300000000000000003" };
  } else if (method === "GET" && path === "/channels/300000000000000003") {
    // DORI_TEST_THREAD_PARENT: the channel the thread is in (unset: none given, as before)
    result = { name: state.name, type: 11, parent_id: process.env.DORI_TEST_THREAD_PARENT, thread_metadata: { archived: state.archived } };
  } else if (method === "PATCH" && path === "/channels/300000000000000003") {
    // DORI_TEST_PATCH_FAIL: thread PATCHes are refused (403), the call still recorded
    if (process.env.DORI_TEST_PATCH_FAIL) {
      writeFileSync(file, JSON.stringify(state));
      return Response.json({ message: "Missing Access", code: 50001 }, { status: 403 });
    }
    if (typeof body.name === "string") state.name = body.name;
    if (typeof body.archived === "boolean") state.archived = body.archived;
  // as Discord does: the new message comes back with the content it holds (empty for files alone)
  } else if (method === "POST" && path.endsWith("/messages")) result = { id: "900", content: typeof body.content === "string" ? body.content : "" };
  else if (method !== "POST" || !path.endsWith("/typing")) throw new Error(`unexpected Discord request: ${method} ${path}`);
  writeFileSync(file, JSON.stringify(state));
  return Response.json(result);
}, { preconnect: () => {} });

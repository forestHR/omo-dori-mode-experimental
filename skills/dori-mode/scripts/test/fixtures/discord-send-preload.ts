// Wire-level fake for the CLI subprocess: no Discord request leaves this process.
const fakeFetch = async (input: string | Request | URL, init?: RequestInit) => {
  const url = String(input);
  console.log(`REQUEST ${url.split("/").pop()}`);
  // as Discord does: a new message comes back with the content it holds
  const content = typeof init?.body === "string" ? (JSON.parse(init.body) as { content?: unknown }).content : undefined;
  return new Response(JSON.stringify({ id: "fake-message", ...(typeof content === "string" ? { content } : {}) }), { status: 200 });
};
globalThis.fetch = Object.assign(fakeFetch, { preconnect: fetch.preconnect });

// omo extension for a gated Dori: omo's own web_search and webfetch tools, by the same names, go through the gate's web
// window (owner 2026-10-29 14:55 KST Q379: "쓰는 법은 똑같고 데이터 새는 길만 막음"). A user extension's tool replaces a
// builtin tool of the same name. Enable per account with one file, ~/.omo/agent/extensions/dori-web-window.js:
//   export { default } from "file:///home/<account>/.dori/src/skills/dori-mode/setups/egress-gate/omo-web-window.js";
import http from "node:http";

const WINDOW = () => new URL(process.env.DORI_WEB_WINDOW || "http://127.0.0.1:3131");
const OWNER_MESSAGE = {
	type: "string",
	description: "The owner's Discord message this work is for, as '<channel id>/<message id>' (the same value as the " +
		"X-Dori-Owner-Message header), 'order:<n>' for a dashboard order or 'todo:<todo id>' for a todo the owner approved " +
		"by card. Required: the gate opens the web only inside " +
		"an owner task, and links it returned open only within the same task.",
};

function ownerHeaders(ownerMessage) {
	const value = String(ownerMessage || process.env.DORI_OWNER_MESSAGE || "").trim();
	const order = value.match(/^order:([1-9][0-9]{0,8})$/);
	if (order) return { "X-Dori-Owner-Order": order[1] };
	const todo = value.match(/^todo:(pb-[0-9a-f]{12}-[1-9][0-9]{0,3})$/);
	if (todo) return { "X-Dori-Owner-Todo": todo[1] };
	if (/^\d+\/\d+$/.test(value)) return { "X-Dori-Owner-Message": value };
	throw new Error("owner_message is required: pass the owner's message as '<channel id>/<message id>' (or 'order:<n>', 'todo:<todo id>').");
}

// node:http straight to the loopback window: fetch would follow HTTP(S)_PROXY to the CONNECT-only port.
function ask(path, query, ownerMessage, timeoutSeconds, signal) {
	const headers = ownerHeaders(ownerMessage);
	const base = WINDOW();
	const target = `${path}?${new URLSearchParams(query)}`;
	return new Promise((resolve, reject) => {
		const request = http.request({ host: base.hostname, port: base.port || 80, path: target, method: "GET", headers, signal,
			timeout: Math.min(Math.max(timeoutSeconds || 60, 1), 120) * 1000 }, (response) => {
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () => {
				const body = Buffer.concat(chunks).toString("utf8");
				if (response.statusCode === 200) return resolve(body);
				let reason = `window answered ${response.statusCode}`;
				try {
					const data = JSON.parse(body);
					reason = data.message ? `${data.error}: ${data.message}` : String(data.error || reason);
				} catch {}
				reject(new Error(`gate web window refused (${response.statusCode}) ${reason}`));
			});
		});
		request.on("timeout", () => request.destroy(new Error("gate web window timed out")));
		request.on("error", reject);
		request.end();
	});
}

const done = (text) => ({ content: [{ type: "text", text }], details: {} });

export default function (pi) {
	// The model companies' own server-side search would run outside the gate; omo reads these at every request.
	process.env.PI_ANTHROPIC_WEB_SEARCH = "0";
	process.env.PI_OPENAI_WEB_SEARCH = "0";
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web through the gate's web window. Results come back wrapped as someone else's text; " +
			"their links can then be opened with webfetch in the same owner task. Queries carrying the owner's contacts, " +
			"mail addresses, phone or account numbers, or keys are refused.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", minLength: 2, description: "The search query to use" },
				allowed_domains: { type: "array", items: { type: "string" }, description: "Only include search results from these domains" },
				blocked_domains: { type: "array", items: { type: "string" }, description: "Never include search results from these domains" },
				owner_message: OWNER_MESSAGE,
			},
			required: ["query"],
		},
		async execute(_id, params, signal) {
			const filters = [...(params.allowed_domains ?? []).map((d) => `site:${d}`), ...(params.blocked_domains ?? []).map((d) => `-site:${d}`)];
			const q = [params.query, ...filters].join(" ");
			return done(await ask("/search", { q }, params.owner_message, 60, signal));
		},
	});
	pi.registerTool({
		name: "webfetch",
		label: "Web Fetch",
		description: "Fetch a web page as text through the gate's web window. Only a URL from the owner's message, from a " +
			"search result or page link the window returned in this task, or a public reference site without '?' opens; " +
			"anything else is refused with '출처 없는 주소. 검색으로 찾아' (search for it instead of making up an address).",
		parameters: {
			type: "object",
			properties: {
				url: { type: "string", description: "The URL to fetch content from" },
				format: { type: "string", enum: ["markdown", "text", "html"], description: "Ignored: the window always returns text" },
				timeout: { type: "number", description: "Optional timeout in seconds. Maximum 120." },
				owner_message: OWNER_MESSAGE,
			},
			required: ["url"],
		},
		async execute(_id, params, signal) {
			return done(await ask("/fetch", { url: params.url }, params.owner_message, params.timeout, signal));
		},
	});
}

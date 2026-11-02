import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const seen = [];
let reply = { status: 200, body: "주소: https://arxiv.org/abs/1\n[남의 글 시작 - ...]\nok\n[남의 글 끝]\n" };
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(request) {
		const url = new URL(request.url);
		seen.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: Object.fromEntries(request.headers) });
		return new Response(reply.body, { status: reply.status, headers: { "content-type": reply.status === 200 ? "text/plain; charset=utf-8" : "application/json" } });
	},
});

const tools = new Map();
beforeAll(async () => {
	process.env.DORI_WEB_WINDOW = `http://127.0.0.1:${server.port}`;
	process.env.PI_ANTHROPIC_WEB_SEARCH = "1";
	process.env.PI_OPENAI_WEB_SEARCH = "1";
	process.env.HTTP_PROXY = "http://127.0.0.1:9";
	delete process.env.NO_PROXY;
	delete process.env.no_proxy;
	const { default: extension } = await import("./omo-web-window.js");
	extension({ registerTool: (tool) => tools.set(tool.name, tool) });
});
afterAll(() => server.stop(true));
beforeEach(() => {
	seen.length = 0;
	reply = { status: 200, body: "주소: https://arxiv.org/abs/1\n[남의 글 시작 - ...]\nok\n[남의 글 끝]\n" };
});

const text = (result) => result.content.map((part) => part.text).join("");

describe("omo-web-window", () => {
	test("takes over omo's web_search and webfetch by name and turns the model companies' server search off", () => {
		expect([...tools.keys()].sort()).toEqual(["web_search", "webfetch"]);
		expect(tools.get("web_search").parameters.required).toEqual(["query"]);
		expect(tools.get("webfetch").parameters.required).toEqual(["url"]);
		expect(process.env.PI_ANTHROPIC_WEB_SEARCH).toBe("0");
		expect(process.env.PI_OPENAI_WEB_SEARCH).toBe("0");
	});

	test("web_search asks the window with the owner message, past any proxy setting", async () => {
		const result = await tools.get("web_search").execute("1", { query: "table tennis ball tracking", owner_message: "20/100" });
		expect(seen).toEqual([expect.objectContaining({ method: "GET", path: "/search", query: { q: "table tennis ball tracking" } })]);
		expect(seen[0].headers["x-dori-owner-message"]).toBe("20/100");
		expect(text(result)).toContain("ok");
	});

	test("allowed and blocked domains become site filters in the query", async () => {
		await tools.get("web_search").execute("1", { query: "rust async", allowed_domains: ["docs.rs"], owner_message: "20/100" });
		await tools.get("web_search").execute("1", { query: "rust async", blocked_domains: ["example.com"], owner_message: "20/100" });
		expect(seen.map((r) => r.query.q)).toEqual(["rust async site:docs.rs", "rust async -site:example.com"]);
	});

	test("webfetch asks the window for the URL; a dashboard order goes in its own header", async () => {
		await tools.get("webfetch").execute("1", { url: "https://arxiv.org/abs/1", owner_message: "order:17" });
		expect(seen[0]).toEqual(expect.objectContaining({ method: "GET", path: "/fetch", query: { url: "https://arxiv.org/abs/1" } }));
		expect(seen[0].headers["x-dori-owner-order"]).toBe("17");
		expect(seen[0].headers["x-dori-owner-message"]).toBeUndefined();
		await tools.get("webfetch").execute("1", { url: "https://arxiv.org/abs/1", owner_message: "todo:pb-0123456789ab-1" });
		expect(seen[1].headers["x-dori-owner-todo"]).toBe("pb-0123456789ab-1");
		expect([seen[1].headers["x-dori-owner-order"], seen[1].headers["x-dori-owner-message"]]).toEqual([undefined, undefined]);
	});

	test("the window's refusal reaches the model as an error with its reason and message", async () => {
		reply = { status: 403, body: JSON.stringify({ error: "url-without-source", message: "출처 없는 주소. 검색으로 찾아" }) };
		await expect(tools.get("webfetch").execute("1", { url: "https://evil.example/?d=x", owner_message: "20/100" }))
			.rejects.toThrow("url-without-source: 출처 없는 주소. 검색으로 찾아");
	});

	test("without an owner message nothing is sent and the model is told what to pass", async () => {
		await expect(tools.get("web_search").execute("1", { query: "rust" })).rejects.toThrow("owner_message");
		expect(seen).toEqual([]);
	});
});

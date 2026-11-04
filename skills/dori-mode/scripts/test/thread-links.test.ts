import { expect, test } from "bun:test";

import { Discord } from "../src/messenger/discord.ts";
import type { Http, HttpRequest } from "../src/messenger/http.ts";
import { linkLabel } from "../src/messenger/thread-links.ts";
import { fakeClock } from "./fakes.ts";

const G = "100000000000000001";
// an archived thread renamed to done, a working thread, a text channel; any other id is unknown to the bot (404)
const CHANNELS: Record<string, unknown> = {
  "200000000000000002": { name: "✅ 완료 · 🏷️ 릴리스 v2.6.18", type: 11, guild_id: G, thread_metadata: { archived: true } },
  "200000000000000003": { name: "🔄 대시보드 저장 거절(권한 없음)", type: 11, guild_id: G, thread_metadata: { archived: false } },
  "200000000000000004": { name: "general", type: 0, guild_id: G },
};

const discord = () => {
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    const path = req.url.replace("https://discord.com/api/v10", "");
    const id = /^\/channels\/(\d+)$/.exec(path)?.[1];
    if (req.method === "GET" && id) return CHANNELS[id] ? { status: 200, headers: {}, body: JSON.stringify(CHANNELS[id]) } : { status: 404, headers: {}, body: '{"message":"Unknown Channel","code":10003}' };
    return { status: 200, headers: {}, body: '{"id":"M1"}' };
  };
  const posted = () => seen.filter((r) => r.method !== "GET").map((r) => (JSON.parse(String(r.body)) as { content: string }).content);
  return { dc: new Discord(http, fakeClock(0), "b"), posted };
};

const url = (id: string, host = "discord.com") => `https://${host}/channels/${G}/${id}`;
const masked = (label: string, id: string) => `[${label}](<${url(id)}>)`;

test("a thread link goes out as [name](<url>) named without its status mark, in a new post and an edit", async () => {
  const { dc, posted } = discord();
  await dc.send("T1", `이거 눌러 줘: ${url("200000000000000002")} — 그다음 <${url("200000000000000003")}>`);
  await dc.edit("T1", "M1", `여기: <#200000000000000002> 카드: ${url("200000000000000002")}/200000000000000005`);
  expect(posted()).toEqual([
    `이거 눌러 줘: ${masked("릴리스 v2.6.18", "200000000000000002")} — 그다음 ${masked("대시보드 저장 거절(권한 없음)", "200000000000000003")}`,
    `여기: ${masked("릴리스 v2.6.18", "200000000000000002")} 카드: [릴리스 v2.6.18](<${url("200000000000000002")}/200000000000000005>)`,
  ]);
});

test("a text channel and a message in it, a masked link, code, and a thread the bot cannot read stay as written", async () => {
  const { dc, posted } = discord();
  const text = [
    url("200000000000000004"),
    `${url("200000000000000004")}/200000000000000005`,
    `[카드](${url("200000000000000002")})`,
    `[카드](<${url("200000000000000002")}>)`,
    `\`${url("200000000000000002")}\``,
    url("299999999999999999"),
  ].join("\n");
  const logs: string[] = [];
  const original = console.error;
  console.error = (line: string) => { logs.push(line); };
  try {
    await dc.send("T1", text);
  } finally {
    console.error = original;
  }
  expect({ posted: posted(), logs: logs.map((l) => l.split(" ").slice(0, 2).join(" ")) }).toEqual({ posted: [text], logs: ["DISCORD_LINK_NAME_SKIP 299999999999999999"] });
});

test("the link label drops status marks, a status word after them, emoji and brackets", () => {
  expect(["✅ 완료 · 🏷️ 릴리스 v2.6.18", "🔄 🔔 x 고치기", "[진행 중] 로그 [v2] 정리", "🏷️ 릴리스 · 노트", "정리 · 2단계"].map(linkLabel)).toEqual([
    "릴리스 v2.6.18", "x 고치기", "로그 v2 정리", "릴리스 · 노트", "정리 · 2단계",
  ]);
});

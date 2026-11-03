import { expect, test } from "bun:test";

import { defaultDiscordWords } from "../src/config.ts";
import { Discord } from "../src/messenger/discord.ts";
import type { Http, HttpResponse } from "../src/messenger/http.ts";
import { archiveDoneThreads, type ArchiveDeps } from "../src/messenger/thread-archive.ts";
import { fakeClock } from "./fakes.ts";

const GUILD = "400000000000000004";
const CHANNEL = "200000000000000002";
const OTHER_CHANNEL = "200000000000000009";
const NOW = Date.parse("2026-10-17T14:00:00Z");
const WORDS = { ...defaultDiscordWords, statusStyle: "emoji" as const };

const snowflake = (ms: number): string => String((BigInt(ms) - 1_420_070_400_000n) << 22n);
const minAgo = (min: number): number => NOW - min * 60_000;

type Fake = { id: string; name: string; parent?: string; lastMin: number; archived?: boolean };

const thread = (t: Fake) => ({
  id: t.id,
  parent_id: t.parent ?? CHANNEL,
  name: t.name,
  type: 11,
  last_message_id: snowflake(minAgo(t.lastMin)),
  thread_metadata: { archived: t.archived ?? false, archive_timestamp: new Date(minAgo(t.lastMin + 5)).toISOString(), create_timestamp: new Date(minAgo(t.lastMin + 60)).toISOString() },
});

const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify(body) });

const world = (threads: Fake[], refuse: ReadonlySet<string> = new Set()) => {
  const w = { gets: 0, patches: [] as { id: string; body: Record<string, unknown> }[] };
  const http: Http = async (req) => {
    const path = req.url.replace("https://discord.com/api/v10", "");
    if (req.method === "GET" && path === `/guilds/${GUILD}/threads/active`) {
      w.gets++;
      return ok({ threads: threads.map(thread), members: [], has_more: false });
    }
    const id = /^\/channels\/(\d+)$/.exec(path)?.[1];
    if (req.method === "PATCH" && id) {
      if (refuse.has(id)) return { status: 403, headers: {}, body: JSON.stringify({ message: "Missing Permissions", code: 50013 }) };
      w.patches.push({ id, body: JSON.parse(String(req.body)) as Record<string, unknown> });
      return ok({});
    }
    return { status: 404, headers: {}, body: JSON.stringify({ message: `unexpected ${req.method} ${path}` }) };
  };
  return { w, dc: new Discord(http, fakeClock(0), "bot") };
};

const deps = (dc: Discord, patch: Partial<ArchiveDeps> = {}): ArchiveDeps => ({
  dc,
  guild: GUILD,
  channel: CHANNEL,
  words: WORDS,
  afterMin: 30,
  now: () => NOW,
  laneThreads: async () => new Set(),
  openCards: () => [],
  pendingStatus: () => false,
  ...patch,
});

test("a quiet done thread in the owner's channel is archived; working, waiting, recent and other-channel threads are left alone", async () => {
  const { w, dc } = world([
    { id: "301", name: "✅ 도리 상태 파일 깃 관리", lastMin: 40 },
    { id: "302", name: "🔄 완료 스레드 자동 보관", lastMin: 120 },
    { id: "303", name: "🔔 HR35 ETH 기준선 대비 개선 실험", lastMin: 3000 },
    { id: "304", name: "✅ 방금 닫은 일", lastMin: 10 },
    { id: "305", name: "✅ 완료 · 메일 발신", parent: OTHER_CHANNEL, lastMin: 3000 },
    { id: "306", name: "다이제스트 캘린더", lastMin: 3000 },
  ]);
  const lines = await archiveDoneThreads(deps(dc));
  expect(w.patches).toEqual([{ id: "301", body: { archived: true } }]);
  expect(lines).toEqual(['THREAD_AUTO_ARCHIVED 301 quiet=40m "✅ 도리 상태 파일 깃 관리"']);
});

test("a quiet Yoodori thread that ended ⛔ or 💤 is archived like a done one; ❗ waits for the owner and stays open", async () => {
  const { w, dc } = world([
    { id: "341", name: "⛔ ✉️ 취소한 메일", lastMin: 60 },
    { id: "342", name: "💤 ✉️ 새 초안으로 바뀐 메일", lastMin: 60 },
    { id: "343", name: "❗ 🔐 실패한 공유", lastMin: 600 },
  ]);
  await archiveDoneThreads(deps(dc));
  expect(w.patches).toEqual([{ id: "341", body: { archived: true } }, { id: "342", body: { archived: true } }]);
});

test("a done thread an open lane, an open question card or a pending status rename still holds stays open", async () => {
  const { w, dc } = world([
    { id: "311", name: "✅ shared with an open lane", lastMin: 600 },
    { id: "312", name: "✅ card still open", lastMin: 600 },
    { id: "313", name: "✅ rename pending", lastMin: 600 },
    { id: "314", name: "[done] words style", lastMin: 600 },
  ]);
  const lines = await archiveDoneThreads(
    deps(dc, {
      words: defaultDiscordWords,
      laneThreads: async () => new Set(["311"]),
      openCards: (t) => (t === "312" ? ["q1"] : []),
      pendingStatus: (t) => t === "313",
    }),
  );
  expect(w.patches).toEqual([{ id: "314", body: { archived: true } }]);
  expect(lines).toEqual(['THREAD_AUTO_ARCHIVED 314 quiet=600m "[done] words style"']);
});

test("autoArchiveMin 0 turns it off; a refused archive is a warning and the next thread still goes", async () => {
  const off = world([{ id: "321", name: "✅ old", lastMin: 600 }]);
  expect(await archiveDoneThreads(deps(off.dc, { afterMin: 0 }))).toEqual([]);
  expect(off.w.gets).toBe(0);

  const { w, dc } = world(
    [
      { id: "322", name: "✅ not ours", lastMin: 600 },
      { id: "323", name: "✅ ours", lastMin: 600 },
    ],
    new Set(["322"]),
  );
  const lines = await archiveDoneThreads(deps(dc));
  expect(w.patches).toEqual([{ id: "323", body: { archived: true } }]);
  expect(lines[0]).toStartWith("THREAD_AUTO_ARCHIVE_WARN 322 ");
  expect(lines[1]).toBe('THREAD_AUTO_ARCHIVED 323 quiet=600m "✅ ours"');
});

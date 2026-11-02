import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { memoryRepoFor, MemoryRecallError, recallNotes, safeLine } from "../src/memory-recall.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

const note = (repo: string, path: string, description: string, body: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), `---\ndescription: ${description}\n---\n${body}\n`);
};
// a lead's memory like MooDori's on 2026-11-02: the card note among others, plus files recall must not read
const repo = () => {
  const r = join(state.dir, "repo");
  note(r, "reference/kimm-card-ai-billing.md", "카드 미결재 중 Claude·GPT 건 결재문서 정리 절차(형 2026-10-19 지시, 기계연_결재 폴더 짜임, 로그인 경로)", "형 2026-10-19: 카드 미결재 항목이 Claude나 GPT면 invoice·receipt를 받고 심야·휴무일이면 hwp도 쓴다.");
  note(r, "notes/kimm-vpn.md", "KIMM VPN 접속 유지 알림과 재접속 순서", "VPN이 끊기면 다시 붙는다. 준비하고 있어도 알림이 온다.");
  note(r, "notes/trip-purpose.md", "출장 신청 목적은 짧게 쓴다", "출장 신청서 목적 칸은 한 줄.");
  note(r, "reference/portal-login.md", "업무포털 로그인 순서와 PUSH 번호", "로그인하고 있어 PUSH 번호를 형에게 묻는다.");
  note(r, "people/owner/card.md", "Person - owner", "형은 짧은 답을 좋아한다.");
  note(r, "people/owner/observations.md", "카드 서류 관찰 기록", "카드 카드 카드");
  note(r, "system/human.md", "카드 서류는 시스템 블록", "카드 서류");
  note(r, "reference/self/observations.md", "카드 서류 자기 관찰", "카드 서류 카드 서류");
  return r;
};

// 2026-11-02 14:06 KST: MooDori's lead got this message and answered as if the owner prepared the papers
test("an owner message recalls the lead's own note it points at first: the card note for the card message; system blocks and observations are not read", () => {
  const r = repo();
  const got = recallNotes("그리고 카드처리해 서류 준비하고 있어", r);
  expect(got[0]?.line).toBe("reference/kimm-card-ai-billing.md: 카드 미결재 중 Claude·GPT 건 결재문서 정리 절차(형 2026-10-19 지시, 기계연_결재 폴더 짜임, 로그인 경로)");
  expect(got.length).toBeLessThanOrEqual(3);
  expect(got.map((n) => n.path).filter((p) => p.startsWith("system/") || p.endsWith("observations.md"))).toEqual([]);
  // a dated facts file matches by its body: the row shows the line that matched, not "Explicit facts for 2026-10"
  note(r, "notes/facts/2026-10.md", "Explicit facts for 2026-10", "- 2026-10-12 출장 신청은 이틀 전에 한다.\n- 2026-10-19 형: 출장 정산 영수증은 출장 신청 폴더에 둔다.");
  expect(recallNotes("출장 영수증 어디 둬", r).map((x) => x.line)).toEqual(["notes/trip-purpose.md: 출장 신청 목적은 짧게 쓴다", "notes/facts/2026-10.md: - 2026-10-19 형: 출장 정산 영수증은 출장 신청 폴더에 둔다."]);
  // a message that points at nothing recalls nothing
  expect(recallNotes("응 좋아", r)).toEqual([]);
});

test("a recalled line never carries a secret, and a repo that is not there is an error, not an empty recall", () => {
  expect(safeLine("reference/login.md: 포털 password: hunter2 와 토큰=abc 그리고 ghp_0123456789abcdefghijABCDEFGHIJ0123456789")).toBe("reference/login.md: 포털 password: [가림] 와 토큰=[가림] 그리고 [가림]");
  expect(() => recallNotes("카드", join(state.dir, "none"))).toThrow(MemoryRecallError);
});

test("the memory repo of a lead is its own account's: <cwd name>-<sha256(cwd) 8>/repo under that home", () => {
  expect(memoryRepoFor("/home/moodori/Documents/moodori", "/home/moodori")).toBe("/home/moodori/.omo/memory/agents/moodori-c8186be9/repo");
  expect(memoryRepoFor("/home/oriclaw/Documents/zzangdori", "/home/oriclaw")).toBe("/home/oriclaw/.omo/memory/agents/zzangdori-eccee897/repo");
});

// 2026-11-02 QA: dori recall "<text>" printed only its usage line, reading the text one argument too far
test("dori recall prints the notes of the configured memory repo the text points at", async () => {
  const r = repo();
  writeFileSync(join(state.dir, "config.json"), JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, directives: { memory: r } }));
  const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "recall", "그리고 카드처리해 서류 준비하고 있어"], { env: { ...process.env, DORI_CONFIG: join(state.dir, "config.json"), DORI_ENV_FILE: join(state.dir, "missing.env"), DORI_STATE_DIR: state.dir }, stdout: "pipe", stderr: "pipe" });
  const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
  expect({ code, first: out.split("\n")[0] }).toEqual({ code: 0, first: "MEMORY_RECALL reference/kimm-card-ai-billing.md: 카드 미결재 중 Claude·GPT 건 결재문서 정리 절차(형 2026-10-19 지시, 기계연_결재 폴더 짜임, 로그인 경로)" });
});

// 2026-11-02 live QA on OkDori, YooDori and GongDori: the card message recalled notes that only shared 그리고 and 있어 with it
test("words that carry no meaning (그리고, 있어, 해줘 ...) recall nothing by themselves", () => {
  const r = repo();
  note(r, "reference/dongdori.md", "Relayed rules from ZzangDori", "그리고 앞으로 그건 그냥 해도 돼. 지금 그 방에 글이 있어.");
  expect(recallNotes("그리고 카드처리해 서류 준비하고 있어", r).map((n) => n.path)).toEqual(["reference/kimm-card-ai-billing.md"]);
  expect(recallNotes("그리고 지금 있어 해줘", r)).toEqual([]);
});

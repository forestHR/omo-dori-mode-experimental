import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { applyDirectives, auditOrReport, auditStampPath, checkMeaning, dailyAuditSince, linkRows, meaningCachePath, pushLinks, runDirectiveAudit, withApplied } from "../src/directive-audit.ts";
import { freshnessTick } from "../src/freshness.ts";
import { run as realRun } from "../src/run.ts";
import { APPLIED_HEADING, briefGaps, COMMON_LEDGER, DirectiveError, directiveText, ledgerProblems, loadLedger, requireMissing, scopeContext, trimProblem } from "../src/directives.ts";
import type { Runner } from "../src/run.ts";
import { DirectiveMissingError, eightSteps, launchLane, renderBrief, uiSteps } from "../src/launch.ts";
import { depsFor, fakeClock, fakeRunner, newWorld, sent, withState, type World } from "./fakes.ts";

let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const T0 = Date.parse("2026-10-16T06:00:00Z");
const fields = "ulw\n\n[목표] 로그인 고침\n[끝난 상태] x\n[사용자와 장면] y\n[넘으면 안 되는 선] 없음\n\n위치: ~/app\n";
const write = async (name: string, text: string) => {
  const path = join(state.dir, name);
  await Bun.write(path, text);
  return path;
};
// a host layer like the owner's: a repo directive, a learning one, and the names the lead uses for them
const local = {
  entries: [
    { id: "options-ledger", name: "옵션 장부·순서 기록", by: "owner", basis: "fixture basis line", words: "내가 이것저것 시도하는 옵션들이 실제로 얼마나 학습에 유용했는지 내가 요청할 때마다 다 표로 정리되어 있었으면 좋겠어", prompt: "형이 시도하는 옵션들이 학습에 얼마나 유용했는지 형이 요청할 때마다 모두 표로 정리되어 있게 한다.", rule: "같은 커밋에서 옵션 장부 줄을 갱신한다.", date: "2026-10-16", source: "https://discord.com/channels/1/2/3", scope: { repos: ["hr35-isaac"] }, mode: "inject" },
    { id: "no-rl-here", name: "이 PC 학습 금지", by: "owner", basis: "fixture basis line", words: "이 PC에서는 강화학습 자체는 하지 말고 테스트 같은 거는 가끔 가끔 돌려도 돼", prompt: "이 PC에서는 강화학습 자체는 하지 않는다. 테스트 같은 것은 가끔 돌려도 된다.", date: "2026-10-15", source: "https://discord.com/channels/1/2/4", scope: { kinds: ["learning", "gpu"] }, mode: "inject" },
    { id: "gpu-rule", name: "GPU 규칙", by: "owner", basis: "fixture basis line", words: "Gpu제한 같은거 모두 없애", prompt: "GPU 제한 같은 것은 모두 없앤다.", date: "2026-10-15", source: "x", scope: { kinds: ["gpu"] }, mode: "inject" },
    { id: "docs-same-pr", source: "https://discord.com/channels/1/2/5" },
  ],
  reviewed: ["900"],
};
const ledgerDeps = async (patch = {}) => depsFor(world, fakeClock(T0), state.dir, { directives: { common: COMMON_LEDGER, local: await write("local.json", JSON.stringify(local)) }, watchLog: join(state.dir, "watch.log"), ...patch });
const input = (brief: string, extra = {}) => ({ key: "lane-a", title: "t", brief, done: 'command ["bun","test"]', cwd: "/work/hr35-isaac", goal: "g", noThread: "test lane", ...extra });
const count = (text: string, s: string) => text.split(s).length - 1;

test("the fork ledger validates, carries the template's directives and holds no links, paths or ids; a local entry overrides by id", async () => {
  const fork = loadLedger({ directives: { common: COMMON_LEDGER, local: "" } });
  expect(ledgerProblems(fork)).toEqual([]);
  expect(fork.entries.map((e) => e.id)).toEqual(expect.arrayContaining(["eight-steps", "four-fields", "ui-steps", "docs-same-pr", "lane-thread", "ledger-same-day"]));
  expect(await Bun.file(COMMON_LEDGER).text()).not.toMatch(/discord(?:app)?\.com|\/home\/|~\/|\d{15,}/);
  const both = loadLedger((await ledgerDeps()).config);
  expect(ledgerProblems(both)).toEqual([]);
  const docs = both.entries.find((e) => e.id === "docs-same-pr");
  expect(docs?.source).toBe("https://discord.com/channels/1/2/5");
  expect(docs?.words).toBe("세션에서 작업 시 문서를 업데이트 하게 해당 프로젝트 지침에 추가해");
  expect(docs?.layer).toBe("common");
  // a rule the lead set never carries the owner's words: what he said that led to it is its trigger
  expect(both.entries.filter((e) => e.by === "lead").every((e) => !e.words && e.rule)).toBe(true);
  const lead = both.entries.find((e) => e.by === "lead")!;
  expect(ledgerProblems({ ...both, entries: [{ ...lead, words: "형 말처럼 붙인 문장" }] })).toEqual([`directive ${lead.id}: a lead rule has no owner words (put what he said in trigger)`]);
  // his words are never cut short: an ellipsis in words is refused, and no entry of either layer has one
  expect(ledgerProblems({ ...both, entries: [{ ...both.entries.find((e) => e.by === "owner" && e.words)!, words: "앞부분 … 뒷부분" }] })[0]).toContain("words cut with an ellipsis");
  expect(ledgerProblems({ ...both, entries: [{ ...both.entries.find((e) => e.by === "owner" && e.words)!, words: "앞부분... 뒷부분" }] })[0]).toContain("words cut with an ellipsis");
  expect(both.entries.filter((e) => /…|\.\.\./.test(e.words ?? "")).map((e) => e.id)).toEqual([]);
  expect(directiveText(lead)).toBe(`[리드 규칙 ${lead.id}]\n${lead.rule}`);
  expect(ledgerProblems({ ...both, entries: [...both.entries, { ...both.entries[0], id: "Bad Id", mode: "inject", scope: { kinds: ["nope"] } } as never] })).toEqual(["directive Bad Id: id must be lowercase words with -", "directive Bad Id: unknown kind nope"]);
});

test("words are his original with only fillers and whole sentences left out: a reworded, reordered, added or half-cut sentence fails the check", async () => {
  const both = loadLedger((await ledgerDeps()).config);
  const fillers = ["알겠어", "아 그리고", "짱돌아"];
  const original = "짱돌아 알겠어 이건 꼭 해줘. 아 그리고 저것도 정리해 너무 원문 그대로다…..모든 지침은 유지해 / 오늘은 쉬어";
  const trim = (words: string) => trimProblem(original, words, fillers);
  // fillers, the ellipsis and his last message left out; or his first sentence
  expect(trim("이건 꼭 해줘. 저것도 정리해 너무 원문 그대로다 모든 지침은 유지해")).toBeUndefined();
  expect(trim("저것도 정리해 너무 원문 그대로다 모든 지침은 유지해 / 오늘은 쉬어")).toBeUndefined();
  for (const bad of [
    "이건 해줘. 저것도 정리해 너무 원문 그대로다 모든 지침은 유지해", // a word of his (꼭) left out
    "이건 꼭 해줘. 저것도 정리해 모든 지침은 유지해", // part of a sentence left out
    "이건 꼭 해줘. 저것도 정리해 너무 원문 그대로다 모든 지침은 반드시 유지해", // a word added
    "저것도 정리해 이건 꼭 해줘. 모든 지침은 유지해", // reordered
    "이건 꼭 해 줘. 저것도 정리해 너무 원문 그대로다 모든 지침은 유지해", // a word of his rewritten
  ])
    expect(trim(bad)).toContain("words is not his original");
  // the ledger check holds every entry with an original to it, with the ledger's fillers
  const owner = both.entries.find((e) => e.by === "owner" && e.words)!;
  expect(ledgerProblems({ ...both, fillers, entries: [{ ...owner, original, words: "이건 꼭 해줘. 저것도 정리해 모든 지침은 유지해" }] })[0]).toContain("words is not his original");
  expect(ledgerProblems({ ...both, fillers, entries: [{ ...owner, original, words: "이건 꼭 해줘. 저것도 정리해 너무 원문 그대로다 모든 지침은 유지해" }] })).toEqual([]);
  // a speech-to-text error is corrected only through fixes, each one found in original
  expect(trimProblem("기간 내 다이제스트 붙여줄게요", "기관메일 다이제스트 붙여줘", [], [["기간 내", "기관메일"], ["붙여줄게요", "붙여줘"]])).toBeUndefined();
  expect(trimProblem("기간 내 다이제스트 붙여줄게요", "기관메일 다이제스트 붙여줘", [])).toContain("words is not his original");
});

test("launch puts an inject directive in scope into the brief as the ledger writes it, once; LAUNCH_DIRECTIVE_ADDED says which and why", async () => {
  const deps = await ledgerDeps();
  const options = loadLedger(deps.config).entries.find((e) => e.id === "options-ledger");
  const r = await renderBrief(deps, input(await write("brief.md", fields)));
  expect(r.missing).toEqual([]);
  expect(count(r.text, directiveText(options!))).toBe(1);
  // the prompt written from his words under a one-line tag (his spoken words stay in the ledger); never the rule or a summary
  expect(r.text).toContain(`\n[형 지침 options-ledger, 2026-10-16]\n${options?.prompt}\n`);
  expect(r.text).not.toContain(options?.words ?? "-");
  expect(r.text).not.toContain(options?.rule ?? "-");
  for (const e of loadLedger(deps.config).entries) {
    if (e.basis) expect(r.text).not.toContain(e.basis);
    if (e.trigger) expect(r.text).not.toContain(e.trigger);
  }
  expect(r.text.indexOf("## 형 지침 (지침 장부에서 dori launch가 넣음)")).toBeGreaterThan(r.text.indexOf("8. 보고:"));
  expect(r.text.indexOf("## 형 지침")).toBeLessThan(r.text.indexOf("## Lane footer"));
  expect(r.lines.find((l) => l.startsWith("LAUNCH_DIRECTIVE_ADDED lane-a:"))).toContain("options-ledger (repo hr35-isaac)");
  // another repo: not in scope
  expect((await renderBrief(deps, input(await write("b2.md", fields), { cwd: "/work/app" }))).text).not.toContain("[지침 options-ledger]");
  // a relaunch of the written brief adds nothing again
  const again = await renderBrief(deps, input(await write("b3.md", r.text)));
  expect(count(again.text, "[형 지침 options-ledger,")).toBe(1);
  expect(again.lines.some((l) => l.startsWith("LAUNCH_DIRECTIVE_ADDED"))).toBe(false);
});

test("entries with via stay in the ledger and in scope but go into a brief as their one pointer; the pointer counts for them", async () => {
  const repoRule = (id: string, rule: string) => ({ id, name: id, by: "owner", basis: "fixture basis line", words: "", rule, date: "2026-07-14", source: "x", scope: { repos: ["hr35-isaac"] }, mode: "inject", via: "repo-rules" });
  const pointer = { id: "repo-rules", name: "저장소 규칙", by: "lead", basis: "fixture basis line", rule: "이 저장소 AGENTS.md의 규칙을 읽고 그대로 따른다.", date: "2026-10-20", source: "x", scope: { repos: ["hr35-isaac"] }, mode: "inject" };
  const withPointer = { ...local, entries: [...local.entries, repoRule("rule-a", "규칙 A 원문"), repoRule("rule-b", "규칙 B 원문"), pointer] };
  const deps = await ledgerDeps({ directives: { common: COMMON_LEDGER, local: await write("pointer.json", JSON.stringify(withPointer)) }, backend: "aoe" });
  const ledger = loadLedger(deps.config);
  expect(ledgerProblems(ledger)).toEqual([]);
  const r = await renderBrief(deps, input(await write("p.md", fields)));
  expect(count(r.text, "[리드 규칙 repo-rules]")).toBe(1);
  expect(r.text).not.toContain("규칙 A 원문");
  expect(r.text).not.toContain("규칙 B 원문");
  expect(r.lines.find((l) => l.startsWith("LAUNCH_DIRECTIVE_ADDED"))).toContain("repo-rules (repo hr35-isaac, for rule-a)");
  // in another repo neither goes in
  expect((await renderBrief(deps, input(await write("p2.md", fields), { cwd: "/work/app" }))).text).not.toContain("repo-rules");
  const blocks = { "eight-steps": await eightSteps(), "ui-steps": await uiSteps() };
  expect(briefGaps({ key: "p" }, r.text, ledger, "hr35-isaac", blocks)).toEqual([]);
  // a brief launched before the pointer still carries the full texts: no gap either, the pointer included
  const old = `${fields}\n[형 결정 rule-a, 2026-07-14, 원문 없음: 리드 기록]\n규칙 A 원문\n\n[형 결정 rule-b, 2026-07-14, 원문 없음: 리드 기록]\n규칙 B 원문\n`;
  expect(briefGaps({ key: "p" }, old, ledger, "hr35-isaac", blocks).filter((g) => /rule/.test(g.id))).toEqual([]);
  // with only one of the texts the pointer is still sent
  const half = `${fields}\n[형 결정 rule-a, 2026-07-14, 원문 없음: 리드 기록]\n규칙 A 원문\n`;
  expect(briefGaps({ key: "p" }, half, ledger, "hr35-isaac", blocks).filter((g) => /rule/.test(g.id)).map((g) => g.id)).toEqual(["repo-rules"]);
  // a brief with neither: one gap, the pointer, and apply sends the pointer only
  const lane = await laneOf(deps, "pl", await write("pl.md", fields));
  expect(briefGaps(lane, fields, ledger, "hr35-isaac", blocks).filter((g) => /rule/.test(g.id)).map((g) => g.id)).toEqual(["repo-rules"]);
  const dry = await applyDirectives(deps, lane, { dryRun: true });
  expect(dry.added).toContain("repo-rules");
  expect(dry.added).not.toContain("rule-a");
  expect(dry.message).not.toContain("규칙 A 원문");
  // a retired pointer: the entries go in as their own texts again
  const retired = { ...ledger, entries: ledger.entries.map((e) => (e.id === "repo-rules" ? { ...e, retired: "2026-10-21: test" } : e)) };
  expect(briefGaps({ key: "p" }, fields, retired, "hr35-isaac", blocks).map((g) => g.id)).toEqual(expect.arrayContaining(["rule-a", "rule-b"]));
  // via must name another inject entry with its own text
  const bad = (via: string) => ledgerProblems({ ...ledger, entries: ledger.entries.map((e) => (e.id === "rule-a" ? { ...e, via } : e)) });
  expect(bad("nope")).toEqual(["directive rule-a: via nope must name another inject entry with its own text and no via"]);
  expect(bad("rule-b")).toEqual(["directive rule-a: via rule-b must name another inject entry with its own text and no via"]);
});

test("a brief without the four fields stops the launch (LAUNCH_DIRECTIVE_MISSING, nothing opened); --waive with a reason lets it through and records it", async () => {
  const deps = await ledgerDeps({ backend: "aoe", leadPane: "aoe_Dori_0a1b2c3d" });
  const bare = "ulw\n\nfix the login loop\n";
  const brief = await write("bare.md", bare);
  const warned: string[] = [];
  const stopped = await launchLane(deps, input(brief), (l) => warned.push(l)).catch((e: unknown) => e);
  expect(stopped).toBeInstanceOf(DirectiveMissingError);
  expect(warned.find((l) => l.startsWith("LAUNCH_DIRECTIVE_MISSING lane-a four-fields:"))).toContain('--waive four-fields "<reason>"');
  expect(await deps.registry.read("lane-a")).toBeNull();
  expect(world.calls.some((c) => c[0] === "aoe" && c[1] === "add")).toBe(false);
  expect(await Bun.file(brief).text()).toBe(bare);
  expect(await Bun.file(deps.config.watchLog).text()).toMatch(/^\S+ launch LAUNCH_DIRECTIVE_MISSING lane-a four-fields:/m);
  // --thread new opens its thread only once nothing else stops the launch: a stopped launch leaves no empty thread
  const opened: string[] = [];
  const withOpen = { ...deps, openThread: async (title: string) => (opened.push(title), "discord:100000000000000009") };
  expect(await launchLane(withOpen, input(brief, { noThread: undefined, thread: "new" })).catch((e: unknown) => e)).toBeInstanceOf(DirectiveMissingError);
  expect(opened).toEqual([]);
  await expect(launchLane(deps, input(brief, { waive: { "four-feilds": "typo" } }))).rejects.toBeInstanceOf(DirectiveError);
  const r = await launchLane(deps, input(brief, { waive: { "four-fields": "a one-line ops fix" } }));
  expect(r.lane.directives?.waived).toEqual([{ id: "four-fields", reason: "a one-line ops fix", at: new Date(T0).toISOString() }]);
  expect((await deps.registry.read("lane-a"))?.directives?.applied).toContain("docs-same-pr");
  expect(await Bun.file(deps.config.watchLog).text()).toMatch(/^\S+ launch LAUNCH_DIRECTIVE_WAIVED lane-a four-fields: 네 칸 left out on the lead's word: a one-line ops fix/m);
});

test("scope comes from the work, not from names or quotes: a brief about directives is not UI, learning, GPU or autophagy work", async () => {
  const ledger = loadLedger((await ledgerDeps()).config);
  // the brief that opened this feature's lane: it names the UI steps, the PC rule and the scopes, and does none of that work
  const meta = [
    "[목표] 형 10/16 13:56 KST 원문: \"앞으로 내가 설정한 지침이 절대로 빠지지 않도록 강제하는 프로세스 만들고 도리에도 푸쉬해줘\". 형이 정한 지침이 lane 브리프에서 빠지지 않게 기계로 강제하는 프로세스를 dori 포크에 만들고 푸시.",
    "[끝난 상태] (1) 지침 장부: 적용 범위(모든 lane / UI / 학습 / 릴리스·외부효과 / 노드·GPU / 오토파지 / 특정 저장소 등). 지금 지침에서 채움: 8단계 틀, UI 7단계, 이 PC 학습 금지, GPU 규칙, 관문 통과 시 미룬 결정 찾기, 승인 표 \"코드에 있음\" 열, 결과 본 뒤 바꾼 정의 표시, 문서 갱신 규칙, 옵션 장부·순서 기록 등 — 출처는 각 저장소 AGENTS.md(hr35·cytoplasm). (2) 강제: dori launch가 --ui·--cwd 저장소로 판정. (5) 시험, 문서, PR 머지·푸시, 재시작.",
  ].join("\n");
  const ctx = scopeContext(meta, ledger, { repo: "src" });
  expect(ctx.ui).toBe(false);
  expect(ctx.kinds).toEqual({});
  // the same words as work
  expect(scopeContext("[목표] 대시보드 화면을 고친다. 프론트엔드 디자인", ledger, { repo: "app" }).ui).toBe(true);
  const rl = scopeContext("E7 강화학습 학습을 노드에서 돌리고 보상 항을 고친다. 체크포인트는 iter 400.", ledger, { repo: "x" });
  expect(Object.keys(rl.kinds).sort()).toEqual(["learning"]);
  const r = await renderBrief(await ledgerDeps(), input(await write("meta.md", `ulw\n\n${meta}\n[사용자와 장면] x\n[넘으면 안 되는 선] 없음\n`), { cwd: "/work/src" }));
  expect(r.lines.some((l) => l.startsWith("LAUNCH_UI_HINT"))).toBe(false);
  expect(r.text).not.toContain("[UI 지침]");
  expect(r.text).not.toContain("no-rl-here");
  expect(r.text).not.toContain("gate-deferred");
});

test("directive-audit: gaps of the day go to the watch log and one summary to the lead; a day without gaps stays quiet", async () => {
  const deps = await ledgerDeps();
  const full = (await renderBrief(deps, input(await write("full.md", fields)))).text;
  const clean = { key: "clean", title: "c", thread: "discord:42", brief: await write("clean.md", full), done: "x", cwd: "/work/hr35-isaac", openedAt: "2026-10-16T05:00:00.000Z" };
  await deps.registry.write(clean);
  // an older lane is outside the window
  await deps.registry.write({ ...clean, key: "old", thread: "none", brief: "/nope.md", openedAt: "2026-10-14T00:00:00.000Z" });
  const inbox = await write("inbox.jsonl", "");
  const quiet = await runDirectiveAudit(deps, { since: "2026-10-15T06:00:00.000Z", inbox, owner: "7" });
  expect(quiet.lines).toEqual(["DIRECTIVE_AUDIT_OK since 2026-10-15T06:00:00.000Z: 1 lanes and the owner's messages read against 32 directives, no gap"]);
  expect(await Bun.file(deps.config.watchLog).exists()).toBe(false);
  expect(sent(world)).toEqual([]);
  // a lane whose brief lacks a directive and has no thread, and a standing directive of the owner nobody put in the ledger
  // opened after every ledger entry (long-work-thread is dated 2026-10-19): an entry newer than the lane is not its gap
  const afterLedger = "2099-01-01T00:00:00.000Z";
  await deps.registry.write({ ...clean, key: "gappy", thread: "none", brief: await write("gappy.md", fields), cwd: "/work/hr35-isaac", openedAt: afterLedger });
  await Bun.write(inbox, [
    JSON.stringify({ ts: "2026-10-16T04:00:00.123456+00:00", id: "777", guild_id: "1", channel_id: "2", author_id: "7", content: "앞으로 lane 보고는 항상 표로 해" }),
    JSON.stringify({ ts: "2026-10-16T04:01:00+00:00", id: "900", author_id: "7", content: "앞으로 이건 지침 아님" }),
    JSON.stringify({ ts: "2026-10-16T04:02:00+00:00", id: "901", author_id: "8", content: "앞으로 항상 이렇게" }),
    JSON.stringify({ ts: "2026-10-16T04:03:00+00:00", id: "902", author_id: "7", content: "밥 먹었어?" }),
  ].join("\n"));
  const r = await runDirectiveAudit(deps, { since: "2026-10-15T06:00:00.000Z", inbox, owner: "7" });
  const kinds = r.gaps.map((g) => `${g.lane} ${g.id}`);
  expect(kinds).toEqual(expect.arrayContaining(["gappy docs-same-pr", "gappy options-ledger", "gappy lane-thread", "gappy long-work-thread", "- 777"]));
  expect(kinds.some((k) => k.startsWith("clean ") || k === "- 900" || k === "- 901" || k === "- 902")).toBe(false);
  expect(r.lines.find((l) => l.startsWith("DIRECTIVE_UNLEDGERED"))).toContain("https://discord.com/channels/1/2/777");
  const log = await Bun.file(deps.config.watchLog).text();
  expect(log).toMatch(/^\S+ directive-audit DIRECTIVE_GAP gappy docs-same-pr:/m);
  expect(sent(world).filter((t) => t.startsWith("[DIRECTIVE_AUDIT] "))).toHaveLength(1);
  // a waiver on record is not a gap
  await deps.registry.write({ ...clean, key: "gappy", thread: "none", openedAt: afterLedger, brief: await write("gappy.md", fields), directives: { applied: [], waived: [{ id: "lane-thread", reason: "ops", at: "t" }] } });
  expect((await runDirectiveAudit(deps, { since: "2026-10-15T06:00:00.000Z", inbox, owner: "7", dryRun: true })).gaps.some((g) => g.id === "lane-thread")).toBe(false);
  // a lane launched with --no-thread "<reason>" has no thread on the lead's word: not a thread gap
  await deps.registry.write({ ...clean, key: "gappy", thread: "none", openedAt: afterLedger, noThread: "an internal check", brief: await write("gappy.md", fields) });
  const threadGaps = (await runDirectiveAudit(deps, { since: "2026-10-15T06:00:00.000Z", inbox, owner: "7", dryRun: true })).gaps.filter((g) => g.lane === "gappy" && (g.id === "lane-thread" || g.id === "long-work-thread"));
  expect(threadGaps).toEqual([]);
});

test("directive-audit: a directive that entered the ledger after the lane opened, or that the lead relayed to the lane in a [LEAD] line, is not its gap; one it never got still is", async () => {
  const sessions = join(state.dir, "sessions");
  const repo = join(state.dir, "ledger-repo");
  mkdirSync(repo, { recursive: true });
  // both ledger files in one real repo: the fork's as it is now, and the host's
  const forkText = await Bun.file(COMMON_LEDGER).text();
  const commonFile = join(repo, "common.json");
  const localFile = join(repo, "local.json");
  await Bun.write(commonFile, forkText);
  await Bun.write(localFile, JSON.stringify(local));
  const base = await ledgerDeps({ sessionsDir: sessions, directives: { common: commonFile, local: localFile } });
  // git on that repo is real; the rest is the fake world
  const run: Runner = (argv, opts) => (argv[0] === "git" && argv.includes(repo) ? realRun(argv, opts) : base.run(argv, opts));
  const deps = { ...base, run };
  const inbox = await write("inbox.jsonl", "");
  const lane = { key: "gappy", title: "g", thread: "discord:42", brief: await write("gappy.md", fields), done: "x", cwd: "/work/hr35-isaac", openedAt: "2026-10-16T05:00:00.000Z" };
  await deps.registry.write(lane);
  // opened 2026-10-15 19:00 KST, before the day options-ledger is dated (2026-10-16)
  await deps.registry.write({ ...lane, key: "early", brief: await write("early.md", fields), openedAt: "2026-10-15T10:00:00.000Z" });
  const audit = async () => {
    const r = await runDirectiveAudit(deps, { since: "2026-10-15T06:00:00.000Z", inbox, owner: "7", dryRun: true });
    return { ids: r.gaps.map((g) => `${g.lane} ${g.id}`), lines: r.lines };
  };
  // the ledger's date: an entry dated after the day the lane opened is not its gap; an entry of the same day still is
  let r = await audit();
  expect(r.ids).toEqual(expect.arrayContaining(["gappy options-ledger", "gappy docs-same-pr", "early docs-same-pr"]));
  expect(r.ids).not.toContain("early options-ledger");
  expect(r.lines.some((l) => l.startsWith("DIRECTIVE_LATE early options-ledger:"))).toBe(true);
  // the commits that put eight-steps (fork, dated 2026-10-14) and options-ledger (local) into the ledger came an hour after
  // gappy opened
  expect(r.ids).toContain("gappy eight-steps");
  const git = (args: string[], at: string) => Bun.$`git -C ${repo} -c user.name=t -c user.email=t@t ${args}`.env({ ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }).quiet();
  await git(["init", "-q"], "2026-10-15T00:00:00Z");
  const fork = JSON.parse(forkText) as { entries: { id: string }[] };
  await Bun.write(commonFile, JSON.stringify({ ...fork, entries: fork.entries.filter((e) => e.id !== "eight-steps") }, null, 2));
  await Bun.write(localFile, JSON.stringify({ ...local, entries: local.entries.filter((e) => e.id !== "options-ledger") }, null, 2));
  await git(["add", "common.json", "local.json"], "2026-10-15T00:00:00Z");
  await git(["commit", "-qm", "before"], "2026-10-15T00:00:00Z");
  await Bun.write(commonFile, forkText);
  await Bun.write(localFile, JSON.stringify(local, null, 2));
  await git(["commit", "-qam", "eight-steps, options-ledger"], "2026-10-16T06:00:00Z");
  r = await audit();
  // the fork ledger is read as committed: its commit time counts
  expect(r.ids).not.toContain("gappy eight-steps");
  expect(r.lines.some((l) => l.startsWith("DIRECTIVE_LATE gappy eight-steps:") && l.includes("2026-10-16T06:00:00.000Z"))).toBe(true);
  // the local ledger is read live and committed later (often in batches): only its date counts, so a same-day entry stays a gap
  expect(r.ids).toContain("gappy options-ledger");
  // an entry already in the ledger when the lane opened and in neither its brief nor a relay: still a gap
  expect(r.ids).toEqual(expect.arrayContaining(["gappy docs-same-pr", "early docs-same-pr"]));
  // a [LEAD] line that names it, typed into another lane's session, does not supply it to gappy
  const folder = join(sessions, "--work-hr35-isaac--");
  mkdirSync(folder, { recursive: true });
  const user = (at: string, text: string) => JSON.stringify({ type: "message", timestamp: at, message: { role: "user", content: [{ type: "text", text }] } });
  const relay = "[LEAD] 지침 보충(docs-same-pr): 세션은 작업할 때 관련 문서도 같이 업데이트한다.";
  await Bun.write(join(folder, "other.jsonl"), [user("2026-10-16T05:30:00.000Z", relay), user("2026-10-16T05:40:00.000Z", "[REPORT] other | milestone | x")].join("\n"));
  expect((await audit()).ids).toContain("gappy docs-same-pr");
  // nor does one typed before the lane opened (the session was another lane's then)
  await Bun.write(join(folder, "gappy.jsonl"), [user("2026-10-16T04:30:00.000Z", relay), user("2026-10-16T05:40:00.000Z", "[REPORT] gappy | milestone | x")].join("\n"));
  expect((await audit()).ids).toContain("gappy docs-same-pr");
  // the lead's [LEAD] line in gappy's own session after it opened, by id: supplied
  await Bun.write(join(folder, "gappy.jsonl"), [user("2026-10-16T05:30:00.000Z", relay), user("2026-10-16T05:40:00.000Z", "[REPORT] gappy | milestone | x")].join("\n"));
  r = await audit();
  expect(r.ids).not.toContain("gappy docs-same-pr");
  expect(r.lines.some((l) => l.startsWith("DIRECTIVE_RELAYED gappy docs-same-pr:"))).toBe(true);
  // by its text without the id: supplied too; early, which got neither, keeps the gap
  await Bun.write(join(folder, "gappy.jsonl"), [user("2026-10-16T05:30:00.000Z", "[LEAD] 이것도 따른다: 세션은 작업할 때 관련 문서도 같이 업데이트한다."), user("2026-10-16T05:40:00.000Z", "[REPORT] gappy | milestone | x")].join("\n"));
  r = await audit();
  expect(r.ids).not.toContain("gappy docs-same-pr");
  expect(r.ids).toContain("early docs-same-pr");
});

test("an owner entry with words goes into briefs as its prompt: a prompt is required, may not ask, and is only for owner words", async () => {
  const both = loadLedger((await ledgerDeps()).config);
  expect(both.entries.filter((e) => e.by === "owner" && e.words && !e.prompt).map((e) => e.id)).toEqual([]);
  const owner = both.entries.find((e) => e.id === "docs-same-pr")!;
  const lead = both.entries.find((e) => e.by === "lead")!;
  expect(ledgerProblems({ ...both, entries: [{ ...owner, prompt: undefined }] })[0]).toContain("owner words without prompt");
  for (const asks of ["문서를 갱신해야 하지 않아?", "문서를 갱신하지 않아.", "문서도 같이 고칠까."])
    expect(ledgerProblems({ ...both, entries: [{ ...owner, prompt: asks }] })[0]).toContain("prompt is a question");
  expect(ledgerProblems({ ...both, entries: [{ ...lead, prompt: "무언가 한다." }] })[0]).toContain("prompt is for an owner entry with words");
  expect(directiveText(owner)).toBe(`[형 지침 docs-same-pr, 2026-10-10]\n${owner.prompt}`);
  // a field with a note after its name ("[끝난 상태 — 2단계]") is that field; a missing one is not
  const four = both.entries.find((e) => e.id === "four-fields")!;
  expect(requireMissing(fields.replace("[끝난 상태]", "[끝난 상태 — 2단계]"), four)).toEqual([]);
  expect(requireMissing(fields.replace("[끝난 상태] x\n", ""), four)).toHaveLength(1);
});

const laneOf = async (deps: Awaited<ReturnType<typeof ledgerDeps>>, key: string, brief: string) => {
  const lane = { key, title: "t", thread: "discord:42", brief, done: "x", cwd: "/work/hr35-isaac", pane: `aoe_${key}_0a1b2c3d`, openedAt: "2026-10-16T05:00:00.000Z" };
  await deps.registry.write(lane);
  return lane;
};

test("directives apply: a lane launched before the ledger gets what its brief lacks, sent and added to the brief once; owner-check then reads no gap", async () => {
  const deps = await ledgerDeps({ backend: "aoe" });
  const ledger = loadLedger(deps.config);
  const blocks = { "eight-steps": await eightSteps(), "ui-steps": await uiSteps() };
  // a brief as launch wrote it before the ledger: the lead's text, then what launch appended
  const old = `${fields}\n## Past signals (written by dori launch)\n- none\n\n## Lane footer (written by dori launch)\n- Key: old.\n`;
  const lane = await laneOf(deps, "old", await write("old.md", old));
  const before = briefGaps(lane, old, ledger, "hr35-isaac", blocks).map((g) => g.id);
  expect(before).toEqual(expect.arrayContaining(["eight-steps", "docs-same-pr", "options-ledger"]));
  const r = await applyDirectives(deps, lane);
  expect(r.ok).toBe(true);
  expect(r.added).toEqual(before);
  // one [LEAD] message with every text, as launch writes them (typed in SEND_CHUNK_BYTES pieces, so read as one text)
  const typed = sent(world).join("");
  expect(typed.split("[LEAD] 지침 보충")).toHaveLength(2);
  const options = ledger.entries.find((e) => e.id === "options-ledger")!;
  expect(typed).toContain(directiveText(options));
  expect(typed).toContain(blocks["eight-steps"]);
  const text = await Bun.file(lane.brief).text();
  // the lead's text above is untouched; the section sits before what launch appended
  expect(text.startsWith(fields.replace(/\s*$/, ""))).toBe(true);
  expect(text.indexOf(APPLIED_HEADING)).toBeGreaterThan(text.indexOf("[넘으면 안 되는 선]"));
  expect(text.indexOf(APPLIED_HEADING)).toBeLessThan(text.indexOf("## Past signals"));
  expect(text.endsWith("## Lane footer (written by dori launch)\n- Key: old.\n")).toBe(true);
  expect(count(text, directiveText(options))).toBe(1);
  // owner-check's gap check reads the section as part of the brief; the scope did not change with the added words
  expect(briefGaps(lane, text, ledger, "hr35-isaac", blocks)).toEqual([]);
  expect(scopeContext(text, ledger, { repo: "hr35-isaac" }).kinds).toEqual(scopeContext(old, ledger, { repo: "hr35-isaac" }).kinds);
  // words of a directive added there are not the lane's work: a section full of UI words does not make it UI work
  expect(scopeContext(withApplied(old, ["대시보드 화면 프론트엔드 디자인 UI"]), ledger, { repo: "x" }).ui).toBe(false);
  expect(await Bun.file(deps.config.watchLog).text()).toMatch(/^\S+ directives DIRECTIVES_APPLIED old: eight-steps, /m);
  expect((await deps.registry.read("old"))?.directives?.applied).toEqual(expect.arrayContaining(before));
  // again: nothing to send, nothing written
  const again = await applyDirectives(deps, (await deps.registry.read("old"))!);
  expect(again.lines.at(-1)).toStartWith("DIRECTIVES_APPLY_NONE old");
  expect(sent(world).filter((t) => t.startsWith("[LEAD] 지침 보충"))).toHaveLength(1);
  expect(await Bun.file(lane.brief).text()).toBe(text);
});

test("a brief that quotes a section heading inside a field keeps that field: only a heading on a line of its own starts the section", async () => {
  const deps = await ledgerDeps({ backend: "aoe" });
  const ledger = loadLedger(deps.config);
  const blocks = { "eight-steps": await eightSteps(), "ui-steps": await uiSteps() };
  // this lane's own brief: its [끝난 상태] names the section by its heading, and two fields follow it
  const quoting = fields.replace("[끝난 상태] x", `[끝난 상태] 같은 블록을 브리프 파일의 "${APPLIED_HEADING}" 절로 기록, "${"## 형 지침 (지침 장부에서 dori launch가 넣음)"}"도 그대로`);
  const four = ledger.entries.find((e) => e.id === "four-fields")!;
  expect(requireMissing(quoting, four)).toEqual([]);
  const old = `${quoting}\n## Lane footer (written by dori launch)\n- Key: q.\n`;
  const lane = await laneOf(deps, "q", await write("q.md", old));
  await applyDirectives(deps, lane);
  const text = await Bun.file(lane.brief).text();
  // apply starts its own section (the quoted heading is not one), and the gap check then finds nothing missing
  expect(text).toContain(`\n${APPLIED_HEADING}\n`);
  expect(briefGaps(lane, text, ledger, "hr35-isaac", blocks).map((g) => g.id)).toEqual([]);
});

test("directives apply: a message the lane did not take leaves the brief as it was; a missing four fields is listed, not sent", async () => {
  const deps = await ledgerDeps({ backend: "aoe" });
  world.stuckReads = 99;
  const old = "ulw\n\nfix the login loop\n";
  const lane = await laneOf(deps, "bare", await write("bare-old.md", old));
  const r = await applyDirectives(deps, lane);
  expect(r.ok).toBe(false);
  expect(r.lines).toContain("DIRECTIVES_APPLY_REQUIRE bare four-fields: 네 칸 is a brief requirement, not a text to send; the lead writes it into the lane's brief");
  expect(r.lines.at(-1)).toStartWith("DIRECTIVES_APPLY_NOT_SENT bare aoe_bare_0a1b2c3d");
  expect(await Bun.file(lane.brief).text()).toBe(old);
});

test("directives check: a reviewer of another family reads each new prompt against his words; CHANGED fails, SAME is not asked again", async () => {
  let reply = "VERDICT: SAME";
  const asked: string[] = [];
  const base = await ledgerDeps();
  const run: Runner = async (argv, opts) => {
    if (argv[0] !== "omo") return fakeRunner(world)(argv, opts);
    asked.push(argv.at(-1) ?? "");
    return { code: 0, out: reply, err: "" };
  };
  const deps = { ...base, run, config: { ...base.config, defaultModel: "anthropic/claude-opus-5-5", reviewers: { ...base.config.reviewers, models: ["anthropic/claude-x", "openai/gpt-6"] }, explore: { ...base.config.explore, modelsCommand: [] }, autoSignals: { ...base.config.autoSignals, ownerCheck: { ...base.config.autoSignals.ownerCheck, first: "" } } } };
  const ledger = loadLedger(deps.config);
  const owner = ledger.entries.filter((e) => e.by === "owner" && e.words && e.prompt);
  const ok = await checkMeaning(deps, ledger);
  expect(ok.ok).toBe(true);
  expect(asked).toHaveLength(owner.length);
  // the reviewer is of another family than the lead's model, and reads his words and the prompt
  expect(asked[0]).toContain("PROMPT:");
  expect(ok.lines.every((l) => l.startsWith("DIRECTIVES_MEANING_OK") && l.includes("openai/gpt-6"))).toBe(true);
  expect(await Bun.file(meaningCachePath(deps.config.stateDir)).exists()).toBe(true);
  // a prompt that changes his meaning: CHANGED with what it lost fails the check; the others are not asked again
  reply = "VERDICT: CHANGED\n- STRENGTH: 반드시 꼭 vs 가능하면";
  const skill = ledger.entries.find((e) => e.id === "skill-check")!;
  const changed = { ...ledger, entries: ledger.entries.map((e) => (e.id === "skill-check" ? { ...skill, prompt: "가능하면 스킬을 불렀는지 확인한다." } : e)) };
  const bad = await checkMeaning(deps, changed);
  expect(bad.ok).toBe(false);
  expect(asked).toHaveLength(owner.length + 1);
  expect(bad.lines).toContain("DIRECTIVES_BAD directive skill-check: prompt does not mean what his words mean: STRENGTH: 반드시 꼭 vs 가능하면 [openai/gpt-6]");
  // no reviewer answers: not checked, and the check fails
  reply = "I think it is fine";
  const none = await checkMeaning(deps, { ...ledger, entries: [{ ...skill, prompt: "다음부터는 스킬을 반드시 확인한다." }] });
  expect(none.ok).toBe(false);
  expect(none.lines[0]).toStartWith("DIRECTIVES_MEANING_FAILED skill-check");
});

test("the blocks the ledger names are the ones launch inserts", async () => {
  const deps = await ledgerDeps();
  const r = await renderBrief(deps, input(await write("ui.md", fields), { ui: true }));
  expect(r.text).toContain(await uiSteps());
  expect(r.text).toContain(await eightSteps());
  expect((await deps.registry.list()).length).toBe(0);
});

test("directive-audit: a bad local line is left out with DIRECTIVES_LOCAL_SKIP and the rest is audited; the lead gets it in the inbox and pane; launch still refuses it", async () => {
  // a source-only line for an id the fork does not have (Yoodori 2026-10-20), a fork override that breaks a field, and no entry at all
  const broken = { ...local, entries: [...local.entries, { id: "not-in-fork", source: "https://discord.com/channels/1/2/6" }, { id: "docs-same-pr", mode: "nope" }, "x"] };
  const deps = await ledgerDeps({ directives: { common: COMMON_LEDGER, local: await write("broken.json", JSON.stringify(broken)) } });
  expect(ledgerProblems(loadLedger(deps.config)).length).toBeGreaterThan(0);
  const inbox = await write("inbox.jsonl", "");
  const dry = await runDirectiveAudit(deps, { since: "2026-10-15T06:00:00.000Z", inbox, owner: "7", dryRun: true });
  const skips = dry.lines.filter((l) => l.startsWith("DIRECTIVES_LOCAL_SKIP "));
  expect(skips).toHaveLength(3);
  expect(skips[0]).toContain("entry 7: not an entry with an id");
  expect(skips.find((l) => l.startsWith("DIRECTIVES_LOCAL_SKIP not-in-fork:"))).toContain("no name");
  expect(skips.find((l) => l.startsWith("DIRECTIVES_LOCAL_SKIP docs-same-pr:"))).toContain("the fork entry stands");
  // the rest of the ledger is still read: the other local entries stand, the fork entry is back as the fork has it
  const ledger = loadLedger(deps.config, { tolerant: true });
  expect(ledger.entries.find((e) => e.id === "docs-same-pr")?.mode).toBe(loadLedger({ directives: { common: COMMON_LEDGER, local: "" } }).entries.find((e) => e.id === "docs-same-pr")?.mode);
  expect(ledger.entries.some((e) => e.id === "options-ledger")).toBe(true);
  expect(ledger.entries.some((e) => e.id === "not-in-fork")).toBe(false);
  const r = await runDirectiveAudit(deps, { since: "2026-10-15T06:00:00.000Z", inbox, owner: "7" });
  const rows = (await Bun.file(inbox).text()).trim().split("\n").map((l) => JSON.parse(l) as { kind: string; content: string });
  expect(rows.map((x) => x.kind)).toEqual(["directive-audit"]);
  expect(rows[0]?.content).toStartWith("[DIRECTIVE_AUDIT] 3 local ledger lines left out");
  expect(sent(world).filter((x) => x.startsWith("[DIRECTIVE_AUDIT] 3 local ledger lines left out"))).toHaveLength(1);
  expect(r.lines.at(-1)).toBe("DIRECTIVE_AUDIT_SENT lead:p1");
  expect(await Bun.file(deps.config.watchLog).text()).toMatch(/directive-audit DIRECTIVES_LOCAL_SKIP not-in-fork:/);
});

test("directive-audit: an audit that cannot run says DIRECTIVE_AUDIT_FAILED to the lead (inbox, pane, watch log) and runs again only a day later from freshness", async () => {
  const clock = fakeClock(T0);
  const deps = { ...(await ledgerDeps({ directives: { common: await write("bad-common.json", "{ not json"), local: "" } })), clock };
  const inbox = await write("inbox.jsonl", "");
  const r = await auditOrReport(deps, { since: "2026-10-15T06:00:00.000Z", inbox, owner: "7" });
  expect(r.failed).toBe(true);
  expect(r.lines[0]).toStartWith("DIRECTIVE_AUDIT_FAILED since 2026-10-15T06:00:00.000Z: directive ledger");
  expect(JSON.parse((await Bun.file(inbox).text()).trim()).kind).toBe("directive-audit");
  expect(sent(world).filter((x) => x.startsWith("[DIRECTIVE_AUDIT] 지침 감사가 돌지 못함"))).toHaveLength(1);
  expect(await Bun.file(deps.config.watchLog).text()).toContain("directive-audit DIRECTIVE_AUDIT_FAILED");
  expect(JSON.parse(await Bun.file(auditStampPath(deps.config.stateDir)).text()).ok).toBe(false);
  // freshness: the daily run is due a day after the last one, from that run on; not before
  const ran: string[] = [];
  const hooks = { signals: async () => ({}), directiveAudit: async (since: string) => (ran.push(since), [`ran ${since}`]) };
  expect((await freshnessTick(deps, "/home/test", hooks)).filter((a) => a.kind === "directive_audit")).toEqual([]);
  clock.at = T0 + 25 * 3_600_000;
  expect((await freshnessTick(deps, "/home/test", hooks)).filter((a) => a.kind === "directive_audit")).toEqual([{ kind: "directive_audit", lane: "lead", detail: `ran ${new Date(T0).toISOString()}` }]);
  expect(dailyAuditSince(join(state.dir, "fresh"), T0)).toBe(new Date(T0 - 86_400_000).toISOString());
});

test("directive links live in one place: the local ledger's links of fork ids are pushed to each peer, which reads them as sources only", async () => {
  const deps = await ledgerDeps();
  expect(linkRows(deps.config)).toEqual([{ id: "docs-same-pr", source: "https://discord.com/channels/1/2/5" }]);
  const peerFile = join(state.dir, "peer", "links.json");
  await Bun.write(join(state.dir, "peer", ".keep"), "");
  const calls: string[][] = [];
  // the peer account's sudo: the rest of the command runs as it would for that user
  const run = async (argv: readonly string[]) => (calls.push([...argv]), argv[0] === "sudo" ? realRun(argv.slice(4)) : { code: 1, out: "", err: "unexpected" });
  const pushDeps = { ...deps, run, config: { ...deps.config, directives: { ...deps.config.directives, linkPeers: [`okdori:${peerFile}`, "no-path"] } } };
  const first = await pushLinks(pushDeps);
  expect(first.ok).toBe(false);
  expect(first.lines).toEqual([`DIRECTIVE_LINKS_PUSHED okdori ${peerFile}: 1 links`, "DIRECTIVE_LINKS_PUSH_FAIL no-path: give <user>:<absolute path>"]);
  expect(calls.every((c) => c.slice(0, 4).join(" ") === "sudo -n -u okdori")).toBe(true);
  const again = await pushLinks({ ...pushDeps, config: { ...pushDeps.config, directives: { ...pushDeps.config.directives, linkPeers: [`okdori:${peerFile}`] } } });
  expect(again).toEqual({ lines: [`DIRECTIVE_LINKS_SAME okdori ${peerFile}: 1 links`], ok: true });
  // the peer: no local line for it, the pushed source only; a row for an id it does not have and other fields are left alone
  const pushed = JSON.parse(await Bun.file(peerFile).text());
  await Bun.write(peerFile, JSON.stringify({ entries: [...pushed.entries, { id: "docs-same-pr", source: "https://discord.com/channels/1/2/5", mode: "nope" }, { id: "not-merged-here", source: "https://discord.com/channels/1/2/8" }] }));
  const peer = loadLedger({ directives: { common: COMMON_LEDGER, local: "", links: peerFile } });
  expect(ledgerProblems(peer)).toEqual([]);
  expect(peer.entries.find((e) => e.id === "docs-same-pr")?.source).toBe("https://discord.com/channels/1/2/5");
  expect(peer.entries.some((e) => e.id === "not-merged-here")).toBe(false);
  // the fork ledger itself still holds no link
  expect(await Bun.file(COMMON_LEDGER).text()).not.toMatch(/discord(?:app)?\.com/);
});

test("a lane's brief is stored as an absolute path, and one stored relative (older lanes) is read from the lane's cwd, not from wherever the audit runs", async () => {
  const deps = await ledgerDeps();
  const full = (await renderBrief(deps, input(await write("full.md", fields)))).text;
  await write("lanes/rel.brief.md", full);
  await deps.registry.write({ key: "rel", title: "r", thread: "discord:42", brief: "lanes/rel.brief.md", done: "x", cwd: state.dir, openedAt: "2026-10-16T05:00:00.000Z" });
  const r = await runDirectiveAudit(deps, { since: "2026-10-15T06:00:00.000Z", inbox: await write("inbox.jsonl", ""), owner: "7", dryRun: true });
  expect(r.lines.filter((l) => l.includes("is not there"))).toEqual([]);
  const here = process.cwd();
  process.chdir(state.dir);
  try {
    await write("rel-launch.md", fields);
    const l = await launchLane({ ...deps, config: { ...deps.config, backend: "aoe", leadPane: "aoe_Dori_0a1b2c3d" } }, input("rel-launch.md", { key: "rel-launch" }), () => {});
    expect(l.lane.brief).toBe(join(state.dir, "rel-launch.md"));
  } finally {
    process.chdir(here);
  }
});

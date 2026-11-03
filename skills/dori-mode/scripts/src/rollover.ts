// Rollover = moving a lane to a new session (dori handover --lane). This module decides when to propose one, logs every
// proposal and rollover to <stateDir>/rollover-log.jsonl, and summarizes the log (dori rollover-stats) so the owner can
// set the automation parameters from what happened. A proposal never switches anything: the lead decides (--approved-by
// lead:<reason and signal>) and the owner is told afterwards; handover.autoRollover (off by default) is the only path that
// runs one without a person's decision.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Question } from "./messenger/discord-cards.ts";
import type { FixAttempt, Lane } from "./registry.ts";
import type { DoriConfig } from "./config.ts";
import { flat } from "./restatement.ts";
import { parseWatchLine } from "./watch-log.ts";

// stuck: the highest rung of the stuck ladder the lane reached in its current session (rung 4 makes a rollover due);
// repeats: written by older versions (the most attempts of one same fix), still shown by rollover-stats
// compactionStuck: how often the engine's "compaction did not complete" error stands on the session's screen, set only
// when that error is the last thing above its input box (lane-handover.ts compactionStuckOn): it can take no turn at all.
export type Signals = { readonly contextPct?: number; readonly compactions?: number; readonly afterCompactK?: number; readonly ageH?: number; readonly stuck?: { readonly metric: string; readonly n: number; readonly rung: number }; readonly repeats?: number; readonly compactionStuck?: number };

export type Step = { readonly step: string; readonly ms: number; readonly ok: boolean };
// one round of filling in what the new session's restatement left out: the items, how many old-log lines were quoted, the file
export type Supplement = { readonly round: number; readonly items: readonly { readonly kind: string; readonly text: string }[]; readonly evidence: number; readonly file: string };

export type Who = "lead" | "lane";

// work: a local chain or a background eval cell would die; busy: a turn ran or a question stayed open; training: the
// owner's rule keeps automatic starts away from a lane with a training or eval chain
export type Blocked = "work" | "busy" | "training";

// who decided a rollover: the lead (lead:<reason>), the owner (an answered card or their message), or the automation key
export type DecidedBy = "lead" | "owner" | "auto";

// the one-line message to the owner after a rollover the lead decided: its message id, or why it could not be sent
export type OwnerReport = { readonly message?: string; readonly error?: string };

// What a lane rollover bought, in thousands of context tokens (input + cache read + cache write of a model call): the old
// session's last call, the new one's first (its floor: system prompt, tools and the cwd's AGENTS.md, before it read anything)
// and its last once checked; newLog is the new session's log, where rollover-stats reads the context an hour later.
export type Sizes = { readonly oldK?: number; readonly firstK?: number; readonly checkedK?: number; readonly newLog?: string };

export type RolloverRequest = { readonly note?: string; readonly model?: string; readonly thinking?: string; readonly keepOld?: boolean; readonly verifyMin?: number };

export type RolloverEntry =
  | { readonly kind: "proposal"; readonly who: Who; readonly at: string; readonly key: string; readonly card?: string; readonly pane: string; readonly signals: Signals; readonly crossed: readonly string[]; readonly note?: string; readonly blockers: string }
  | {
      readonly kind: "rollover";
      readonly who: Who;
      readonly at: string;
      readonly key: string;
      readonly from: string;
      readonly to?: string;
      readonly approvedBy?: string;
      readonly decidedBy?: DecidedBy;
      readonly reason?: string;
      readonly ownerReport?: OwnerReport;
      readonly proposedAt?: string;
      readonly approvalMin?: number;
      readonly signals: Signals;
      readonly steps: readonly Step[];
      readonly result: string;
      readonly reasons: readonly string[];
      // a refusal: what held it (work that would die, a lane that stayed busy, a training chain) and the chain pids, so an
      // automatic start knows when to try again
      readonly blocked?: Blocked;
      readonly pids?: readonly number[];
      // the old session's background tasks that still ran (st_...), so an automatic start knows when they ended
      readonly tasks?: readonly string[];
      // a lane run refused while the lane was busy: the options it was given, so the start again after the lane's ready mark
      // (freshness readyResume) moves it the way it was asked
      readonly request?: RolloverRequest;
      // the subscription accounts of the old and new session ("" when the status line did not show one)
      readonly accounts?: { readonly from: string; readonly to: string };
      readonly supplementRounds?: number;
      readonly supplements?: readonly Supplement[];
      // the old lead frozen at the commit: how many processes, and when freshness closes it (null: by hand)
      readonly frozen?: { readonly pids: number; readonly closeAt: string | null };
      readonly sizes?: Sizes;
    };

// afterCompactK: thousands of tokens the session still held right after its last compaction (0 or absent is off)
export type Limits = { readonly contextPct: number; readonly compactions: number; readonly ageH: number; readonly afterCompactK?: number };

// Which thresholds the measured signals cross (a threshold of 0 is off). A session whose compaction did not complete is
// due whatever the thresholds say: it answers every message with that error and never reaches the turn after a compaction
// that afterCompactK measures (OkDori's lead, 262K/200K for hours on 2026-10-20, owner 16:13 KST "옥도리다 대답이 없어").
export const crossed = (s: Signals, h: Limits): string[] => [
  ...(s.compactionStuck ? [`${COMPACTION_STUCK} (the engine's "compaction did not complete" error ${s.compactionStuck}x on its screen${s.contextPct !== undefined ? `, context ${s.contextPct}%` : ""})`] : []),
  ...(h.contextPct > 0 && s.contextPct !== undefined && s.contextPct >= h.contextPct ? [`context ${s.contextPct}% >= ${h.contextPct}%`] : []),
  ...(h.compactions > 0 && s.compactions !== undefined && s.compactions >= h.compactions ? [`compactions ${s.compactions} >= ${h.compactions}`] : []),
  ...((h.afterCompactK ?? 0) > 0 && s.afterCompactK !== undefined && s.afterCompactK >= (h.afterCompactK ?? 0) ? [`context after compaction ${s.afterCompactK}k >= ${h.afterCompactK}k`] : []),
  ...(h.ageH > 0 && s.ageH !== undefined && s.ageH >= h.ageH ? [`age ${s.ageH.toFixed(1)} h >= ${h.ageH} h`] : []),
];

// The reasons a rollover is due: the measured thresholds crossed, and rung 4 of the stuck ladder.
export const dueReasons = (s: Signals, h: Limits): string[] => [...crossed(s, h), ...(s.stuck && s.stuck.rung >= 4 ? [`stuck rung 4 on ${JSON.stringify(s.stuck.metric)} (${s.stuck.n} attempts)`] : [])];

// The lane's current session began when it moved to its pane (a handover) or, before any move, when it opened.
export const sessionStart = (lane: Lane): string => lane.history?.findLast((h) => h.note.startsWith("pane moved") && h.note.includes(`-> ${lane.pane} `))?.at ?? lane.openedAt ?? "";

export const sessionFixes = (lane: Lane): FixAttempt[] => {
  const since = sessionStart(lane);
  return (lane.fixes ?? []).filter((f) => f.at >= since);
};

// Why a session moved, as the owner reads it: one cause, from the lead's approval (its words and the signal it names) or,
// for an automatic move or an approval that names none, the measured signals over their thresholds. The raw reason, the
// panes and the thaw command stay in the rollover log and the watch log, which the lead reads (owner 2026-10-20 "이건 왜
// 아직 기계적 구문 생성이 남아있어?" about "I moved lane ... (aoe_... -> aoe_...). Why: ...").
export type Cause =
  | { readonly kind: "owner" | "full" | "compactionStuck" | "drift" | "stuck" | "lead" | "threshold" }
  | { readonly kind: "afterCompact" | "context" | "compactions" | "age"; readonly n: number };

const numberIn = (re: RegExp, text: string): number | undefined => {
  const g = re.exec(text)?.slice(1).find((v) => v !== undefined);
  return g === undefined ? undefined : Number(g);
};

export const rolloverCause = (ref: string, signals: Signals, limits: Limits): Cause => {
  const words = ref.startsWith(AUTO_PREFIX) ? "" : ref.startsWith(LEAD_PREFIX) ? ref.slice(LEAD_PREFIX.length) : ref;
  const over = (limit: number | undefined, value: number | undefined): number | undefined => ((limit ?? 0) > 0 && value !== undefined && value >= (limit ?? 0) ? value : undefined);
  const pct = numberIn(/(?<![\w])context (\d+) ?%/i, words) ?? over(limits.contextPct, signals.contextPct);
  const afterK = numberIn(/context after compaction (\d+) ?k/i, words) ?? over(limits.afterCompactK, signals.afterCompactK);
  const compactions = numberIn(/compactions? (\d+)|(\d+) compactions?|압축 (\d+)/i, words) ?? over(limits.compactions, signals.compactions);
  const age = numberIn(/(?<![\w])age (\d+(?:\.\d+)?) ?h/i, words) ?? over(limits.ageH, signals.ageH);
  if (words && OWNER_REF.test(words)) return { kind: "owner" };
  if (/COMPACTION_STUCK|compaction did not complete|압축 ?실패/i.test(words) || (!words && (signals.compactionStuck ?? 0) > 0)) return { kind: "compactionStuck" };
  if (/문맥 ?(?:초과|가득|꽉)|context (?:overflow|full|limit)/i.test(words) || (pct ?? 0) >= 100) return { kind: "full" };
  if (/INTENT_CHECK|intent[- ]check|VIOLATION|CONTRADICTION|GOAL_LOSS|맥락 (?:이상|단)/i.test(words)) return { kind: "drift" };
  if (/STUCK|rung ?4|SAME_FIX_3|fixated|막힘 ?4 ?단/i.test(words) || (!words && (signals.stuck?.rung ?? 0) >= 4)) return { kind: "stuck" };
  if (afterK !== undefined) return { kind: "afterCompact", n: afterK };
  if (pct !== undefined) return { kind: "context", n: pct };
  if (compactions !== undefined) return { kind: "compactions", n: compactions };
  if (age !== undefined) return { kind: "age", n: age };
  return { kind: ref.startsWith(AUTO_PREFIX) ? "threshold" : "lead" };
};

// What the owner's message says besides the cause: which work moved (a lane's title; the lead is the Dori itself), what
// the move bought in context (a lane), and how long the frozen old lead is kept (null: until closed by hand).
export type OwnerNotice = { readonly who: Who; readonly title?: string; readonly cause: Cause; readonly sizes?: Sizes; readonly frozenH?: number | null };

const KO_WHY = (c: Cause): string => {
  switch (c.kind) {
    case "owner": return "형이 말한 대로";
    case "full": return "문맥이 꽉 차서";
    case "compactionStuck": return "압축이 끝나지 못해 아무 말에도 대답할 수 없게 돼서";
    case "drift": return "형이 말한 방향에서 벗어나기 시작해서";
    case "stuck": return "같은 문제에서 계속 막혀서 새 눈으로 보려고";
    case "afterCompact": return `압축해도 문맥이 ${c.n}k나 남아서`;
    case "context": return `문맥이 ${c.n}%까지 차서`;
    case "compactions": return `대화를 ${c.n}번이나 압축해서`;
    case "age": return `${Math.round(c.n)}시간 넘게 한 세션으로 일해서`;
    case "lead": return "지금이 갈아탈 때라서";
    case "threshold": return "정해 둔 기준을 넘어서";
  }
};

const EN_WHY = (c: Cause): string => {
  switch (c.kind) {
    case "owner": return "as you asked";
    case "full": return "because its context was full";
    case "compactionStuck": return "because its compaction did not finish and it could no longer answer anything";
    case "drift": return "because it had started to drift from what you asked";
    case "stuck": return "because it kept getting stuck on the same problem, to look at it fresh";
    case "afterCompact": return `because it still held ${c.n}k of context after compacting`;
    case "context": return `because its context reached ${c.n}%`;
    case "compactions": return `because it had compacted its conversation ${c.n} times`;
    case "age": return `because it had run for over ${Math.round(c.n)} hours`;
    case "lead": return "because it was a good point to switch";
    case "threshold": return "because it crossed a limit you set";
  }
};

// The owner's message after a rollover: one or two plain sentences in his language (discord.locale ko: Korean, else
// English) on what moved, why, and that he has nothing to do. No pane, arrow, config key, link or message id.
export const ownerRolloverText = (n: OwnerNotice, locale: string): string => {
  const pct = n.sizes ? sizePct(n.sizes) : undefined;
  const title = n.title?.trim();
  if (locale.toLowerCase().startsWith("ko")) {
    const first = `${n.who === "lead" ? "내 리드 세션을" : `‘${title}’ 세션을`} ${KO_WHY(n.cause)} 새 세션으로 옮겼어.`;
    const before = [
      ...(pct !== undefined ? [`문맥은 ${n.sizes?.oldK}k에서 ${n.sizes?.checkedK}k로 줄었고`] : []),
      ...(n.frozenH === undefined ? [] : n.frozenH ? [`옛 세션은 ${n.frozenH}시간 얼려 뒀다가 닫을 거고`] : ["옛 세션은 얼려 두기만 했고"]),
    ];
    return `${first} ${[...before, `하던 일은 ${before.length ? "" : "새 세션이 "}그대로 이어 가니까 형이 할 일은 없어.`].join(", ")}`;
  }
  const first = `I moved ${n.who === "lead" ? "myself (the lead)" : `the "${title}" work`} to a new session ${EN_WHY(n.cause)}.`;
  const extra = [
    ...(pct !== undefined ? [`its context went from ${n.sizes?.oldK}k to ${n.sizes?.checkedK}k`] : []),
    ...(n.frozenH === undefined ? [] : n.frozenH ? [`the old session is frozen and closes in ${n.frozenH} hours`] : ["the old session is frozen until it is closed by hand"]),
  ];
  return `${first} It carries on where it left off${extra.length ? `; ${extra.join(", ")}` : ""}, and there is nothing for you to do.`;
};

// After a rollover the lead decided (lead:<reason>) or an automatic one: the owner's message (ownerRolloverText), and its
// message id (or why it failed) for the log. A failure is ROLLOVER_OWNER_REPORT_MISSING in the watch log, so the lead
// tells the owner by hand.
export const reportToOwner = async (deps: { readonly reportOwner?: (thread: string | null, text: string) => Promise<string> }, key: string, thread: string | null, text: string, emit: (line: string) => void): Promise<OwnerReport> => {
  try {
    if (!deps.reportOwner) throw new Error("no messenger to reach the owner");
    const message = await deps.reportOwner(thread, text);
    emit(`ROLLOVER_OWNER_REPORTED ${key} message ${message}`);
    return { message };
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    emit(`ROLLOVER_OWNER_REPORT_MISSING ${key}: ${error}; tell the owner yourself: ${text}`);
    return { error };
  }
};

export const COMPACTION_STUCK = "COMPACTION_STUCK";
export const AUTO_PREFIX = "auto:";
export const LEAD_PREFIX = "lead:";

// a lead's approval names the signal it acts on (a STUCK rung, an intent-check finding, a measured threshold)
// whole tokens only: "age" in "message" or 단 in 단계 is no signal (challenge, grok-4.7)
const SIGNAL_WORD = /(?<![\w])(?:COMPACTION_STUCK|compaction did not complete|STUCK|rung ?4|INTENT_CHECK|VIOLATION|CONTRADICTION|GOAL_LOSS|ROLLOVER_DUE|SAME_FIX_3|fixated|context \d+ ?%|context after compaction \d+ ?k|compactions? \d+|\d+ compactions?|age \d+(?:\.\d+)? ?h)(?![\w])|막힘 ?4 ?단|맥락 (?:이상|단)|압축 \d+/i;

// the thresholds of one side, from handover.lane* or handover.lead*
export const limitsFor = (who: Who, h: DoriConfig["handover"]): Limits =>
  who === "lane" ? { contextPct: h.laneContextPct, compactions: h.laneCompactions, ageH: h.laneAgeH, afterCompactK: h.laneAfterCompactK } : { contextPct: h.leadContextPct, compactions: h.leadCompactions, ageH: h.leadAgeH, afterCompactK: h.leadAfterCompactK };

// the reason the owner reads after an automatic rollover: what the session crossed when it moved
export const autoReason = (who: Who, signals: Signals, h: DoriConfig["handover"]): string => `automatic (handover.autoRollover${who === "lane" ? "Lanes" : "Lead"}): ${dueReasons(signals, limitsFor(who, h)).join(", ") || "a threshold was crossed"}`;

export const decidedBy = (ref: string): DecidedBy => (ref.startsWith(LEAD_PREFIX) ? "lead" : ref.startsWith(AUTO_PREFIX) ? "auto" : "owner");

// A new session (lane or lead) does nothing but re-arm monitors and ack the probe until it gets this line: before it the
// handover may still roll back, and work done by a session that is then closed would be lost or done twice.
export const COMMITTED = "HANDOVER_COMMITTED";

const DISCORD_LINK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/\d+\/\d+\/\d+$/;

// the owner's message a lead's approval cites instead of a signal: "owner <message id>" or "owner <its Discord link>", and
// for the owner's card answer "owner Qn <id or link>" (형 works for owner); groups: 1 the card, 2 the link's channel, 3 the
// link's message, 4 a bare message id
const OWNER_REF = /(?<![\w])(?:owner|형)\s*[:#]?\s*(?:(Q\d+)\s*[:#]?\s*)?(?:https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d+)\/(\d+)|(\d{15,22}))(?![\w])/i;

// The author of an inbox card answer row (kind "answer"): the listener writes one only for a tap or a typed answer by
// DORI_DISCORD_OWNER (discord-cards.ts handle answers anyone else with ownerOnly and records nothing; a shadow listener
// checks the same), so the row is the owner's though it has no author_id.
const CARD_ANSWER = "owner card answer";

// The owner's ids (DORI_DISCORD_OWNER, DORI_KAKAO_OWNER_ID) and the inbox rows by message id: who wrote it, where, and for
// a card answer the card (its channel is the card's thread, "" for a card in DORI_DISCORD_CHANNEL itself).
type InboxRow = { readonly author: string; readonly channel: string; readonly card?: string };
export type OwnerMessages = { readonly ids: readonly string[]; readonly find: (id: string) => InboxRow | undefined };
export const NO_OWNER_MESSAGES: OwnerMessages = { ids: [], find: () => undefined };

// reads the inbox once, on the first lookup
export const inboxMessages = (inbox: string, ids: readonly string[]): OwnerMessages => {
  let rows: Map<string, InboxRow> | undefined;
  const load = () => {
    const out = new Map<string, InboxRow>();
    if (!existsSync(inbox)) return out;
    for (const line of readFileSync(inbox, "utf8").split("\n")) {
      let row: { id?: unknown; author_id?: unknown; channel_id?: unknown; kind?: unknown; qid?: unknown; thread?: unknown };
      try {
        row = JSON.parse(line) as typeof row;
      } catch {
        continue;
      }
      if (typeof row?.id !== "string" || out.has(row.id)) continue;
      if (typeof row.author_id === "string") out.set(row.id, { author: row.author_id, channel: String(row.channel_id ?? "") });
      else if (row.kind === "answer" && typeof row.qid === "string") out.set(row.id, { author: CARD_ANSWER, channel: typeof row.thread === "string" ? row.thread : "", card: row.qid });
    }
    return out;
  };
  return { ids, find: (id) => (rows ??= load()).get(id) };
};

// why a cited owner's message does not hold: not set up, not in the inbox (a made-up id), someone else's, another channel
const ownerRefProblem = (m: RegExpExecArray, owner: OwnerMessages): string | undefined => {
  const id = m[3] ?? m[4] ?? "";
  if (!owner.ids.length) return `the owner's message ${id} cannot be checked: DORI_DISCORD_OWNER is not set`;
  const row = owner.find(id);
  if (!row) return `message ${id} is not in the inbox, so it is not known as the owner's; cite the id or link of a message the owner wrote or of his card answer`;
  if (row.author !== CARD_ANSWER && !owner.ids.includes(row.author)) return `message ${id} in the inbox was written by ${row.author}, not by the owner`;
  const card = m[1]?.toUpperCase();
  if (card && row.card !== card) return `message ${id} in the inbox is ${row.card ? `the owner's answer to card ${row.card}` : "not a card answer"}, not to ${card}`;
  // a card in DORI_DISCORD_CHANNEL itself has no thread in its answer row: its link's channel is not known to differ
  if (m[2] && m[2] !== row.channel && !(row.card && !row.channel)) return `message ${id} is in channel ${row.channel} in the inbox, not in ${m[2]} as the link says`;
  return undefined;
};

// What makes a rollover approved: the lead's decision "lead:<reason and the signal behind it>" or "lead:<reason>, owner
// <the id or link of the owner's message that asked for it>" (the message must be the owner's in the inbox; the owner decided the lead
// rolls over and is told afterwards: canReport says the handover can post that message), a question card (Qn) the owner
// answered with its first option, a link to the owner's Discord message, or "auto:..." when the automation key for that
// side is on. A card counts only when it was posted as a rollover proposal for this key and for the session it runs in now
// (the rollover log says so), so a yes on another lane's card, on any other question, or on a card about an earlier session
// moves nothing. Undefined when the reference holds.
export const approvalProblem = (ref: string | undefined, card: (id: string) => Question | undefined, auto: { readonly on: boolean; readonly key: string }, key: string, pane: string, proposals: readonly RolloverEntry[], canReport = false, owner: OwnerMessages = NO_OWNER_MESSAGES): string | undefined => {
  const r = ref?.trim() ?? "";
  if (!r) return `no approval: pass --approved-by "${LEAD_PREFIX}<your reason and the signal behind it>" or "${LEAD_PREFIX}<your reason>, owner <id or link of the owner's message that asked for it>" (or the owner's answered rollover card Qn, or the link to their Discord message)`;
  if (r.startsWith(LEAD_PREFIX)) {
    const why = r.slice(LEAD_PREFIX.length).trim();
    const cited = OWNER_REF.exec(why);
    if (cited) {
      const problem = ownerRefProblem(cited, owner);
      if (problem) return `${JSON.stringify(r)} cites the owner, but ${problem}`;
      if (why.replace(cited[0], "").replace(/[\s,;:.()-]+/g, " ").trim().length < 8) return `${JSON.stringify(r)} does not say the reason: --approved-by "${LEAD_PREFIX}<reason>, owner <message id>"`;
    } else if (why.length < 8 || !SIGNAL_WORD.test(why)) return `${JSON.stringify(r)} does not say the reason and the signal behind it: --approved-by "${LEAD_PREFIX}<reason>, <signal: STUCK rung 4 on X, INTENT_CHECK GOAL_LOSS twice, context 85%>" or "${LEAD_PREFIX}<reason>, owner <id or link of the owner's message that asked for it>"`;
    return canReport ? undefined : "a lead's rollover needs a way to tell the owner afterwards: set DORI_DISCORD_TOKEN and DORI_DISCORD_CHANNEL (or give the lane a discord:<id> thread)";
  }
  if (r.startsWith(AUTO_PREFIX)) {
    if (r !== `${AUTO_PREFIX}${auto.key}`) return `${r} is not the automatic approval of this side; only ${AUTO_PREFIX}${auto.key} is`;
    if (!auto.on) return `${r} is an automatic approval, but the automation key is off (the owner turns it on)`;
    // an automatic rollover tells the owner afterwards too
    return canReport ? undefined : "an automatic rollover needs a way to tell the owner afterwards: set DORI_DISCORD_TOKEN and DORI_DISCORD_CHANNEL (or give the lane a discord:<id> thread)";
  }
  if (/^Q\d+$/i.test(r)) {
    const q = card(r.toUpperCase());
    if (!q) return `card ${r} not found`;
    const p = proposals.findLast((e): e is Extract<RolloverEntry, { kind: "proposal" }> => e.kind === "proposal" && e.card === q.id);
    if (!p || p.key !== key) return `card ${q.id} is not a rollover proposal for ${key}; post one with dori rollover-propose ${key}`;
    if (p.pane !== pane) return `card ${q.id} was about ${p.pane}, not the session ${key} runs in now (${pane}); post a new one with dori rollover-propose ${key}`;
    if (q.status !== "answered") return `card ${q.id} is not answered yet`;
    if (q.answer !== q.options[0]) return `card ${q.id} was answered ${JSON.stringify(q.answer ?? "")}, not ${JSON.stringify(q.options[0] ?? "")}`;
    return undefined;
  }
  if (!DISCORD_LINK.test(r)) return `approval reference ${JSON.stringify(r)} is neither an answered rollover card Qn nor a link to the owner's Discord message`;
  // a bare link holds like "owner <link>" in a lead's approval: the inbox has it from the owner (his message or card answer)
  const linked = OWNER_REF.exec(`owner ${r}`);
  const problem = linked ? ownerRefProblem(linked, owner) : `${r} is not a Discord message link`;
  return problem ? `${JSON.stringify(r)} is a link, but ${problem}` : undefined;
};

// While a session is being replaced it must not talk to the owner: the new one may already answer. dori send, ask and
// thread refuse from a pane with a live quiet mark; the mark expires on its own, so a crashed handover cannot gag a pane.
export const quietFile = (stateDir: string, pane: string): string => join(stateDir, "handover", "quiet", `${pane.replace(/[^\w.-]/g, "_")}.json`);

export const setQuiet = (stateDir: string, pane: string, until: number, why: string): void => {
  mkdirSync(join(stateDir, "handover", "quiet"), { recursive: true });
  writeFileSync(quietFile(stateDir, pane), JSON.stringify({ pane, until: new Date(until).toISOString(), why }));
};

// What dori type typed into a pane while its quiet mark was live: a lane's old session frozen by its handover reads none of
// it until it is thawed to be closed, so the lead's instruction typed there (GongDori's e7-leap card Q39 line, 2026-10-24
// 04:03:28Z) reached only the old session; the lane handover hands these lines to the new session when it commits.
export const heldFile = (stateDir: string, pane: string): string => join(stateDir, "handover", "quiet", `${pane.replace(/[^\w.-]/g, "_")}.typed.jsonl`);
export const holdTyped = (stateDir: string, pane: string, now: number, text: string): boolean => {
  if (!quietReason(stateDir, pane, now)) return false;
  appendFileSync(heldFile(stateDir, pane), `${JSON.stringify({ at: new Date(now).toISOString(), text })}\n`);
  return true;
};
export const heldTyped = (stateDir: string, pane: string): { readonly at: string; readonly text: string }[] => {
  let raw = "";
  try {
    raw = readFileSync(heldFile(stateDir, pane), "utf8");
  } catch {
    return [];
  }
  return raw.split("\n").flatMap((line) => {
    try {
      const o = JSON.parse(line) as { at?: unknown; text?: unknown };
      return typeof o.at === "string" && typeof o.text === "string" ? [{ at: o.at, text: o.text }] : [];
    } catch {
      return [];
    }
  });
};

export const clearQuiet = (stateDir: string, pane: string): void => {
  rmSync(quietFile(stateDir, pane), { force: true });
  rmSync(heldFile(stateDir, pane), { force: true });
};

export const quietReason = (stateDir: string, pane: string, now: number): string | undefined => {
  if (!pane) return undefined;
  try {
    const q = JSON.parse(readFileSync(quietFile(stateDir, pane), "utf8")) as { until?: string; why?: string };
    return q.until && Date.parse(q.until) > now ? `HANDOVER_QUIET ${pane}: ${q.why ?? "a handover is moving this session"} (until ${q.until}); the new session talks to the owner now` : undefined;
  } catch {
    return undefined;
  }
};

const COMPACTION = '"type":"compaction"';
// Session logs grow to tens of MB; a long-running sweep keeps where it stopped per file and reads only what was added.
// afterK: the context of the first assistant turn after the last compaction (input + cache read + cache write, in thousands),
// what the session really carries on; the compaction line's own tokenEstimate runs about three times higher (2026-10-16).
type Scan = { offset: number; count: number; afterK?: number; waiting: boolean };
const scanned = new Map<string, Scan>();

const turnContextK = (line: string): number | undefined => {
  try {
    const m = (JSON.parse(line) as { message?: { role?: string; usage?: { input?: number; cacheRead?: number; cacheWrite?: number } } }).message;
    if (m?.role !== "assistant" || !m.usage) return undefined;
    return Math.round(((m.usage.input ?? 0) + (m.usage.cacheRead ?? 0) + (m.usage.cacheWrite ?? 0)) / 1000);
  } catch {
    return undefined;
  }
};

// The context of a session log's first model call and of its last one at or before until (an ISO time), in thousands.
export const contextK = (file: string, until?: string): { readonly first?: number; readonly last?: number } => {
  let first: number | undefined;
  let last: number | undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"')) continue;
    const k = turnContextK(line);
    if (k === undefined) continue;
    if (until && ((JSON.parse(line) as { timestamp?: string }).timestamp ?? "") > until) break;
    first ??= k;
    last = k;
  }
  return { ...(first !== undefined ? { first } : {}), ...(last !== undefined ? { last } : {}) };
};

export const sizePct = (s: Sizes): number | undefined => (s.oldK && s.checkedK !== undefined ? Math.round((s.checkedK / s.oldK) * 100) : undefined);

export const compactionsIn = (file: string): number => compactionScan(file).count;

export const compactionScan = (file: string): { readonly count: number; readonly afterK?: number } => {
  const size = statSync(file).size;
  let { offset, count, afterK, waiting } = scanned.get(file) ?? { offset: 0, count: 0, waiting: false };
  if (size < offset) ({ offset, count, afterK, waiting } = { offset: 0, count: 0, afterK: undefined, waiting: false });
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(4 << 20);
    let rest = "";
    for (let read = 0; offset + read < size; ) {
      const n = readSync(fd, buf, 0, buf.length, offset + read);
      if (n <= 0) break;
      read += n;
      const text = rest + buf.toString("utf8", 0, n);
      const cut = text.lastIndexOf("\n");
      const whole = cut >= 0 ? text.slice(0, cut + 1) : "";
      rest = cut >= 0 ? text.slice(cut + 1) : text;
      for (const line of whole.split("\n")) {
        if (line.startsWith('{"type":"compaction"') || (line.includes(COMPACTION) && line.indexOf(COMPACTION) < 12)) {
          count++;
          afterK = undefined;
          waiting = true;
        } else if (waiting && line.includes('"usage"')) {
          const k = turnContextK(line);
          if (k !== undefined) [afterK, waiting] = [k, false];
        }
      }
    }
    offset = size - Buffer.byteLength(rest);
  } finally {
    closeSync(fd);
  }
  scanned.set(file, { offset, count, ...(afterK !== undefined ? { afterK } : {}), waiting });
  return { count, ...(afterK !== undefined ? { afterK } : {}) };
};

const SESSION_FILE = /^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z_([0-9a-f-]{36})\.jsonl$/;

// Compactions so far and hours since the session's log began, for the omo session id in a session directory.
export const sessionSignals = (sessionDir: string, session: string, now: number): Pick<Signals, "compactions" | "afterCompactK" | "ageH"> => {
  if (!session) return {};
  let name: string | undefined;
  try {
    name = readdirSync(sessionDir).find((n) => n.endsWith(`_${session}.jsonl`));
  } catch {
    return {};
  }
  const m = name ? SESSION_FILE.exec(name) : null;
  if (!name || !m) return {};
  const started = Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`);
  const scan = compactionScan(join(sessionDir, name));
  return { compactions: scan.count, ...(scan.afterK !== undefined ? { afterCompactK: scan.afterK } : {}), ageH: Math.round(((now - started) / 3_600_000) * 10) / 10 };
};

export const rolloverLog = (stateDir: string): string => join(stateDir, "rollover-log.jsonl");

export const appendRollover = (stateDir: string, entry: RolloverEntry): void => {
  const file = rolloverLog(stateDir);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
};

export const readRollovers = (stateDir: string): RolloverEntry[] => {
  const file = rolloverLog(stateDir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l) as RolloverEntry] : [];
    } catch {
      return [];
    }
  });
};

export const lastProposal = (entries: readonly RolloverEntry[], key: string): Extract<RolloverEntry, { kind: "proposal" }> | undefined =>
  entries.findLast((e): e is Extract<RolloverEntry, { kind: "proposal" }> => e.kind === "proposal" && e.key === key);

// Watch-log kinds that show a lane going wrong: silence (NUDGED, NO-REPORT), a stuck rung, an intent-check finding, lost
// input, a blocked pane. SAME_FIX_3, REPEAT_SUSPECT, INTENT_DRIFT and OWNER_CHECK (the periodic check removed 2026-11-02)
// are the names older versions wrote; they still count in old logs.
export const QUALITY_KINDS = ["NUDGED", "NO-REPORT", "STUCK", "INTENT_CHECK", "NOT_SUBMITTED", "LANE_BLOCKED", "SAME_FIX_3", "REPEAT_SUSPECT", "INTENT_DRIFT", "OWNER_CHECK"] as const;

type Counts = Record<string, number>;

const countsIn = (lines: readonly string[], key: string, from: number, to: number): Counts => {
  const out: Counts = {};
  for (const line of lines) {
    const w = parseWatchLine(line);
    if (!w || w.key !== key) continue;
    const at = Date.parse(w.at);
    const kind = QUALITY_KINDS.find((k) => k === w.kind);
    // a check that found nothing is not a quality signal
    if ((kind === "INTENT_CHECK" || kind === "OWNER_CHECK") && w.detail.startsWith("OK")) continue;
    if (kind && at >= from && at < to) out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
};

const fmtCounts = (c: Counts): string => Object.entries(c).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
const median = (xs: readonly number[]): number | undefined => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
};
const fmtSignals = (s: Signals): string => [s.compactionStuck ? `${COMPACTION_STUCK} ${s.compactionStuck}x` : "", s.contextPct !== undefined ? `context ${s.contextPct}%` : "", s.compactions !== undefined ? `compactions ${s.compactions}` : "", s.ageH !== undefined ? `age ${s.ageH} h` : "", s.stuck ? `stuck rung ${s.stuck.rung} on ${JSON.stringify(s.stuck.metric)} (${s.stuck.n}x)` : "", s.repeats !== undefined ? `same fix ${s.repeats}x` : ""].filter(Boolean).join(", ") || "no signals";
const HOUR_MS = 3_600_000;
const fmtSizes = (r: Extract<RolloverEntry, { kind: "rollover" }>, now: number, readK: typeof contextK): string => {
  const s = r.sizes;
  if (!s) return "";
  const hourAt = Date.parse(r.at) + HOUR_MS;
  const hour = s.newLog && now >= hourAt ? readK(s.newLog, new Date(hourAt).toISOString()).last : undefined;
  return `; context ${s.oldK ?? "?"}k -> new session first ${s.firstK ?? "?"}k, checked ${s.checkedK ?? "?"}k (${sizePct(s) ?? "?"}% of the old)${hour !== undefined ? `, 1 h later ${hour}k` : ""}`;
};
const fmtDecision = (r: Extract<RolloverEntry, { kind: "rollover" }>): string =>
  r.decidedBy === "lead" ? `; decided by the lead${r.reason ? ` (${r.reason})` : ""}, owner told: ${r.ownerReport?.message ?? `MISSING (${r.ownerReport?.error ?? "no report"})`}` : "";

// The summary the owner sets automation parameters from: how often a proposal came and at which signal values, how long
// approval took, how each rollover went step by step, and the lane's quality signals in windowH hours before and after.
export const rolloverStats = (entries: readonly RolloverEntry[], watchLines: readonly string[], now: number, windowH = 24, readK: typeof contextK = contextK): string[] => {
  const proposals = entries.filter((e) => e.kind === "proposal");
  const rolls = entries.filter((e): e is Extract<RolloverEntry, { kind: "rollover" }> => e.kind === "rollover");
  const byResult: Counts = {};
  for (const r of rolls) byResult[r.result] = (byResult[r.result] ?? 0) + 1;
  const approval = median(rolls.flatMap((r) => (r.approvalMin !== undefined ? [r.approvalMin] : [])));
  const out = [`ROLLOVER_STATS proposals=${proposals.length} rollovers=${rolls.length} (${fmtCounts(byResult)}) approval_median_min=${approval ?? "-"} window=${windowH}h`];
  const stepNames = [...new Set(rolls.flatMap((r) => r.steps.map((s) => s.step)))];
  if (stepNames.length) out.push(`ROLLOVER_STEPS ${stepNames.map((n) => `${n} median ${Math.round((median(rolls.flatMap((r) => r.steps.filter((s) => s.step === n).map((s) => s.ms))) ?? 0) / 1000)}s fail ${rolls.filter((r) => r.steps.some((s) => s.step === n && !s.ok)).length}`).join("; ")}`);
  for (const p of proposals) out.push(`PROPOSAL ${p.who} ${p.key}${p.card ? ` card ${p.card}` : ""} ${p.at} ${fmtSignals(p.signals)} crossed: ${p.crossed.join(", ") || "-"}${p.blockers ? `; blockers: ${p.blockers}` : ""}`);
  for (const r of rolls) {
    const at = Date.parse(r.at);
    const span = windowH * 3_600_000;
    const afterH = Math.round((Math.min(now, at + span) - at) / 360_000) / 10;
    out.push(`ROLLOVER ${r.who} ${r.key} ${r.at} ${r.result} ${r.from} -> ${r.to ?? "-"} ${fmtSignals(r.signals)}; approval ${r.approvalMin ?? "-"} min (by ${r.approvedBy ?? "-"})${fmtDecision(r)}; steps ${r.steps.map((s) => `${s.step} ${Math.round(s.ms / 1000)}s${s.ok ? "" : " FAIL"}`).join(", ") || "-"}${r.reasons.length ? `; reasons: ${r.reasons.join("; ")}` : ""}${r.accounts && r.accounts.from !== r.accounts.to ? `; account ${r.accounts.from || "?"} -> ${r.accounts.to || "?"}` : ""}${r.supplementRounds ? `; supplements ${r.supplementRounds} (${(r.supplements ?? []).map((s) => s.items.length).join("+")} items)` : ""}${fmtSizes(r, now, readK)}`);
    out.push(`QUALITY ${r.key} ${r.at} before ${windowH}h: ${fmtCounts(countsIn(watchLines, r.key, at - span, at))} | after ${afterH}h: ${fmtCounts(countsIn(watchLines, r.key, at, at + span))}`);
  }
  return out;
};

// The owner's own messages a lane handover note carries, since the lane's last handover: those in the lane's thread and
// those the lead relayed into the old conversation by message id or link. Only rows the inbox holds as written by him count,
// so what the lead or a bot wrote never passes for his words. Newest max kept, oldest first.
export type OwnerMessage = { readonly at: string; readonly id: string; readonly channel: string; readonly text: string; readonly link?: string };
export const ownerMessagesFor = (o: { readonly inbox: string; readonly ownerIds: readonly string[]; readonly oldLog?: string; readonly thread?: string; readonly since: string; readonly guild?: string; readonly max?: number }): OwnerMessage[] => {
  if (!o.ownerIds.length || !o.inbox || !existsSync(o.inbox)) return [];
  const cited = new Set<string>();
  if (o.oldLog && existsSync(o.oldLog)) {
    for (const line of readFileSync(o.oldLog, "utf8").split("\n")) {
      if (!line.includes('"user"')) continue;
      let row: { timestamp?: string; message?: { role?: string; content?: unknown } };
      try {
        row = JSON.parse(line) as typeof row;
      } catch {
        continue;
      }
      if (row.message?.role !== "user" || (row.timestamp ?? "") < o.since) continue;
      for (const m of JSON.stringify(row.message.content ?? "").matchAll(/(?<![\w])(\d{17,22})(?![\w])/g)) if (m[1]) cited.add(m[1]);
    }
  }
  const out = new Map<string, OwnerMessage>();
  for (const line of readFileSync(o.inbox, "utf8").split("\n")) {
    let r: { id?: unknown; author_id?: unknown; channel_id?: unknown; ts?: unknown; content?: unknown; transcript?: unknown };
    try {
      r = JSON.parse(line) as typeof r;
    } catch {
      continue;
    }
    if (typeof r?.id !== "string" || !o.ownerIds.includes(String(r.author_id ?? "")) || out.has(r.id)) continue;
    const at = String(r.ts ?? "");
    const channel = String(r.channel_id ?? "");
    if (at < o.since || !(cited.has(r.id) || (!!o.thread && channel === o.thread))) continue;
    const text = String((typeof r.content === "string" && r.content.trim()) || (typeof r.transcript === "string" ? r.transcript : "")).replace(/\s+/g, " ").trim();
    if (text) out.set(r.id, { at, id: r.id, channel, text, ...(o.guild && channel ? { link: `https://discord.com/channels/${o.guild}/${channel}/${r.id}` } : {}) });
  }
  return [...out.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-(o.max ?? 40));
};

// A user message of a session log: its line number in the log, its time and its text (the lead's and the owner's lines).
export type Said = { readonly line: number; readonly at: string; readonly text: string };

// The lead's and the owner's lines in a session log: the text of its user messages, with their time.
export const userLines = (log: string | undefined): Said[] => {
  let raw = "";
  try {
    raw = log ? readFileSync(log, "utf8") : "";
  } catch {
    return [];
  }
  const out: Said[] = [];
  raw.split("\n").forEach((line, i) => {
    if (!line.includes('"user"')) return;
    let o: { message?: { role?: string; content?: unknown }; timestamp?: string };
    try {
      o = JSON.parse(line) as typeof o;
    } catch {
      return;
    }
    if (o.message?.role !== "user") return;
    const c = o.message.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.flatMap((x: { type?: string; text?: string }) => (x?.type === "text" && typeof x.text === "string" ? [x.text] : [])).join(" ") : "";
    if (text.trim()) out.push({ line: i + 1, at: o.timestamp ?? "", text });
  });
  return out;
};

// [LEAD] lines that run the machinery (nudges, handover and rollover steps, checks, the directive top-up that the brief
// also gets) are not instructions the conversation alone holds
const MACHINE = /^\[LEAD\]\s*(your work thread has had no update|Handover of|An automatic rollover|지침 보충|The handover of)|HANDOVER_|dori handover (ready|ack)|INTENT_CHECK|DIRECTIVE_AUDIT|\bSTUCK\b/;

// The lead's own instructions among a log's user lines (the [LEAD] lines that are not machinery), from since (ms) on.
export const leadLines = (said: readonly Said[], since: number): Said[] => said.filter((s) => s.text.startsWith("[LEAD]") && !MACHINE.test(s.text) && (Date.parse(s.at) || 0) >= since);

// --- quotes in a conversation: the owner's (proved by his message id or an answered card) or the lead's ---

export const QUOTE = /"((?:[^"\\\n]|\\.){6,})"|“([^”\n]{6,})”|「([^」\n]{6,})」/g;
// the quote is the owner's when the words just before it name him: 형(17:43 KST, <id>): "...", owner 10-18 "...", 형 Q281: "..."
const OWNER_BEFORE = /(형|owner|오너)[^"“「\n]{0,60}$/i;
const HANGUL = /\p{Script=Hangul}/u;
// a command, a path or a config line is no instruction in words; a single token is one when it is a name the owner chose on
// a card (Q257 "zzangdori-ops"), not a short word
const words = (q: string): boolean => (HANGUL.test(q) ? /\s/.test(q.trim()) || q.length >= 6 : !/[=<>{}$`]|\/\w+\//.test(q.trim()) && q.trim().length >= 6);

export type Candidate = { readonly kind: "owner's words" | "lead's words" | "lead instruction"; readonly text: string; readonly at: string; readonly line: number; readonly context: string };

// What proves a quote is the owner's own: a message id or link next to it that the inbox holds as his, or the question card
// it answers (Q257 "zzangdori-ops"), answered. A quote the lead wrote to him ("형에게 ...라고 했어") or one without proof is
// the lead's words.
export type OwnerProof = { readonly message: (id: string) => boolean; readonly card: (id: string) => boolean };
const MESSAGE_ID = /discord(?:app)?\.com\/channels\/[\d@me]+\/\d+\/(\d{15,22})|(?<![\w])(\d{17,22})(?![\w])/;
const CARD_ID = /(?<![\w])(Q\d{1,5})(?![\w])/;
const TO_OWNER = /(형|owner|오너)\s*(에게|한테|께|to)\b|(형|오너)(에게|한테|께)/i;

export const ownerQuotes = (said: readonly Said[], proof: OwnerProof): Candidate[] => {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const s of said) {
    let end = 0;
    for (const m of s.text.matchAll(QUOTE)) {
      const q = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\"/g, '"').trim();
      const at = m.index ?? 0;
      const before = s.text.slice(Math.max(end, at - 80), at);
      end = at + m[0].length;
      if (!q || !words(q) || !OWNER_BEFORE.test(before) || seen.has(flat(q))) continue;
      seen.add(flat(q));
      const near = `${before} ${s.text.slice(end, end + 40).split(/["“「]/)[0] ?? ""}`;
      const id = MESSAGE_ID.exec(near);
      const card = CARD_ID.exec(before)?.[1];
      const owner = !TO_OWNER.test(before) && ((!!id && proof.message(id[1] ?? id[2] ?? "")) || (!!card && proof.card(card)));
      out.push({ kind: owner ? "owner's words" : "lead's words", text: q, at: s.at, line: s.line, context: s.text.slice(Math.max(0, at - 200), at + q.length + 300).replace(/\s+/g, " ") });
    }
  }
  return out;
};

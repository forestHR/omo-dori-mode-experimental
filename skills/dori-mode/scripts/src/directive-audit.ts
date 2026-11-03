import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import { laneSessionFiles, readLeadRelays, type ReportLine } from "./auto-signals.ts";
import { checkReviewers, ChallengeError, reviewers } from "./challenge.ts";
import { fill } from "./config.ts";
import { APPLIED_HEADING, appliesWhy, briefGaps, checkedLedger, coveredBy, type Directive, type DirectiveBlock, DirectiveError, directiveText, duplicated, type Gap, headingAt, type Ledger, leadGaps, LINK_SOURCE, loadLedger, scopeContext, unledgered } from "./directives.ts";
import type { DoriConfig } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { eightSteps, laneRepo, launchLedger, uiSteps } from "./launch.ts";
import { leadSessionFiles } from "./lead-sessions.ts";
import { sendVerified } from "./panes.ts";
import type { ThreadMap } from "./messenger/thread-map.ts";
import type { Lane } from "./registry.ts";
import { iso, type Runner } from "./run.ts";
import { watchLog } from "./watch-log.ts";

// dori directive-audit and intent-check: a launched lane's brief and the lead's actions against the directive ledger.

export const blockTexts = async (): Promise<Record<DirectiveBlock, string>> => ({ "eight-steps": await eightSteps(), "ui-steps": await uiSteps() });

// A lane launched before briefs were stored absolute keeps the path the lead typed, relative to the lane's cwd.
const briefOf = (lane: Pick<Lane, "brief" | "cwd">, defaultCwd: string): string => (isAbsolute(lane.brief) ? lane.brief : join(lane.cwd ?? defaultCwd, lane.brief));

const readBrief = async (path: string): Promise<string> => {
  const f = Bun.file(path);
  return (await f.exists()) ? await f.text() : "";
};

// The lead's [LEAD] lines typed into the lane since it opened, read as intent-check reads them: from the lane's own session
// files (those that carry its reports; the lead's sessions, which get every lane's reports, are not its own).
const laneRelays = async (deps: Pick<FlowDeps, "config">, lane: Lane, files?: readonly string[]): Promise<ReportLine[]> => {
  const lead = new Set(leadSessionFiles(deps.config.scorecard.leadSessions, deps.config.stateDir));
  const own: string[] = [];
  for (const f of files ?? laneSessionFiles(deps.config, lane)) {
    if (lead.has(f)) continue;
    if ((await Bun.file(f).text()).includes(`[REPORT] ${lane.key} |`)) own.push(f);
  }
  return readLeadRelays(own, Date.parse(lane.openedAt) || 0);
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

// A relay supplies a directive when it names its id or carries its text (what shows it in a brief: tag, words or rule, or
// the prompt a brief gets for his words; a built-in block as its whole text).
const supplies = (text: string, id: string, e: Directive | undefined, ledger: Ledger, blocks: Readonly<Record<DirectiveBlock, string>>): boolean => {
  if (new RegExp(`(?<![\\w-])${escapeRe(id)}(?![\\w-])`).test(text)) return true;
  if (!e) return false;
  if (e.block) return squash(text).includes(squash(blocks[e.block]));
  return e.mode === "inject" && (coveredBy(text, e, ledger) || (Boolean(e.prompt) && squash(text).includes(squash(e.prompt ?? ""))));
};

// The freshness loop's daily audit, unless directives.dailyAudit is false (another Dori audits this one); dori
// directive-audit by hand does not read it.
export const dailyAuditHook = <T>(cfg: Pick<DoriConfig, "directives">, hook: T): T | undefined => (cfg.directives.dailyAudit === false ? undefined : hook);

export type Excused = { readonly gap: Gap; readonly line: string };

// A lane's gaps, and the ones that are not its gaps: a directive that entered the ledger after the lane opened (entered:
// id -> ms, dori directive-audit; DIRECTIVE_LATE) and one the lead typed into the lane in a [LEAD] line after it opened
// (DIRECTIVE_RELAYED). files: the session files to look for the lane's own among (default: laneSessionFiles).
export const laneGapSplit = async (deps: Pick<FlowDeps, "run" | "config">, lane: Lane, ledger: Ledger, blocks: Readonly<Record<DirectiveBlock, string>>, opts: { readonly entered?: ReadonlyMap<string, number>; readonly files?: readonly string[] } = {}): Promise<{ readonly gaps: Gap[]; readonly excused: Excused[] }> => {
  if (!ledger.entries.length) return { gaps: [], excused: [] };
  const brief = await readBrief(briefOf(lane, deps.config.defaultCwd));
  if (!brief) return { gaps: [{ lane: lane.key, id: "-", line: `DIRECTIVE_GAP ${lane.key} -: its brief ${lane.brief} is not there to check` }], excused: [] };
  const repo = await laneRepo(deps, lane.cwd ?? deps.config.defaultCwd);
  const all = [...briefGaps(lane, brief, ledger, repo, blocks), ...leadGaps(lane, ledger)];
  const opened = Date.parse(lane.openedAt);
  const byId = new Map(ledger.entries.map((e) => [e.id, e] as const));
  const gaps: Gap[] = [];
  const excused: Excused[] = [];
  let relays: ReportLine[] | undefined;
  for (const g of all) {
    const at = opts.entered?.get(g.id);
    if (at !== undefined && !Number.isNaN(opened) && at > opened) {
      excused.push({ gap: g, line: `DIRECTIVE_LATE ${lane.key} ${g.id}: entered the ledger ${new Date(at).toISOString()}, after the lane opened ${lane.openedAt}; not counted` });
      continue;
    }
    relays ??= await laneRelays(deps, lane, opts.files);
    const r = relays.find((x) => supplies(x.text, g.id, byId.get(g.id), ledger, blocks));
    if (r) excused.push({ gap: g, line: `DIRECTIVE_RELAYED ${lane.key} ${g.id}: the lead's [LEAD] line of ${r.at} in the lane carries it ("${squash(r.text).slice(0, 100)}"); not counted` });
    else gaps.push(g);
  }
  return { gaps, excused };
};

export const laneDirectiveGaps = async (deps: Pick<FlowDeps, "run" | "config">, lane: Lane, ledger: Ledger, blocks: Readonly<Record<DirectiveBlock, string>>, files?: readonly string[]): Promise<Gap[]> => (await laneGapSplit(deps, lane, ledger, blocks, { files })).gaps;

// The first commit that added each id (an `"id": "<id>"` line) to a ledger file in its git repo, in ms. A file outside git,
// or an id only in uncommitted changes, gives nothing.
export const firstCommitted = async (run: Runner, file: string): Promise<Map<string, number>> => {
  const out = new Map<string, number>();
  if (!file || !existsSync(file)) return out;
  const r = await run(["git", "-C", dirname(file), "log", "--reverse", "--no-color", "--no-ext-diff", "--unified=0", "--format=COMMIT_AT %cI", "-p", "--", basename(file)], { timeoutMs: 60_000 });
  if (r.code !== 0) return out;
  let at = Number.NaN;
  for (const line of r.out.split("\n")) {
    if (line.startsWith("COMMIT_AT ")) at = Date.parse(line.slice(10));
    else {
      const id = /^\+.*"id"\s*:\s*"([^"]+)"/.exec(line)?.[1];
      if (id && !Number.isNaN(at) && !out.has(id)) out.set(id, at);
    }
  }
  return out;
};

// When each directive entered the ledger: for a fork entry its first commit into either ledger file (the earlier of the
// two; a Dori reads the fork ledger only as committed), never before the start of its date (a bare YYYY-MM-DD is read as
// the start of that day in KST, the earliest reading). A local entry has its date only: the local ledger is read live and
// committed later, often in batches (2026-10-24 436e08d committed what was added 10-21..24). The earliest evidence wins,
// so an entry is never later than the ledger shows it.
export const enteredAt = async (deps: Pick<FlowDeps, "run" | "config">, ledger: Ledger): Promise<Map<string, number>> => {
  const seen = await Promise.all([deps.config.directives.common, deps.config.directives.local].map((f) => firstCommitted(deps.run, f)));
  const out = new Map<string, number>();
  for (const e of ledger.entries) {
    const day = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(e.date) ? `${e.date}T00:00:00+09:00` : e.date);
    const commits = e.layer === "common" ? seen.flatMap((m) => (m.has(e.id) ? [m.get(e.id) as number] : [])) : [];
    const at = commits.length ? Math.max(day, Math.min(...commits)) : day;
    if (!Number.isNaN(at)) out.set(e.id, at);
  }
  return out;
};

// The directives in scope for a lane, as the owner's words: intent-check reads them next to the brief.
export const laneDirectiveWords = async (deps: Pick<FlowDeps, "run" | "config">, lane: Lane, ledger: Ledger): Promise<string[]> => {
  const brief = await readBrief(briefOf(lane, deps.config.defaultCwd));
  const ctx = scopeContext(brief, ledger, { ui: lane.ui, repo: await laneRepo(deps, lane.cwd ?? deps.config.defaultCwd) });
  const waived = new Set((lane.directives?.waived ?? []).map((w) => w.id));
  return ledger.entries.filter((e) => e.words && !waived.has(e.id) && appliesWhy(e, ctx)).map((e) => `[${e.id}, ${e.date}] "${e.words}"`);
};

// --- dori directives apply: a lane launched before a directive was in the ledger gets it now ---

const FOOTER = /\n## (?:Past signals|Hypothesis tree|Lane footer) \(written by dori launch\)/;

// The brief with the texts at the end of the lead's part, under APPLIED_HEADING (added to the heading already there),
// before what dori launch appended (past signals, tree, footer). Nothing above is changed.
export const withApplied = (brief: string, texts: readonly string[]): string => {
  const m = FOOTER.exec(brief);
  const head = (m ? brief.slice(0, m.index) : brief).replace(/\s*$/, "");
  const tail = m ? brief.slice(m.index) : "\n";
  const body = texts.join("\n\n");
  return `${headingAt(head, APPLIED_HEADING) >= 0 ? `${head}\n\n${body}` : `${head}\n\n${APPLIED_HEADING}\n\n${body}`}\n${tail}`;
};

export const applyMessage = (brief: string, texts: readonly string[]): string =>
  `[LEAD] 지침 보충: 이 lane을 열 때 브리프에 없던 형 지침·리드 규칙이다. 하던 일은 그대로 이어가고, 지금부터 아래 지침도 따른다. 브리프 ${brief}의 "${APPLIED_HEADING.slice(3)}" 절에도 적었다.\n\n${texts.join("\n\n")}`;

export type ApplyResult = { readonly lines: readonly string[]; readonly added: readonly string[]; readonly ok: boolean; readonly message?: string };

// The directives in scope the lane's brief lacks now (scope judged again from its brief, cwd repo and --ui, as intent-check
// does), in launch's format: an owner directive as [형 지침 id, date] and its prompt, a lead rule as [리드 규칙 id] and its
// rule, a built-in block as its text. They are typed into the lane as one [LEAD] message; once it is SUBMITTED the same
// texts go into the brief under APPLIED_HEADING and DIRECTIVES_APPLIED into the watch log. A require directive (the four
// fields) is not something to send: it is listed for the lead. Nothing missing: DIRECTIVES_APPLY_NONE and no change.
export const applyDirectives = async (deps: FlowDeps, lane: Lane, opts: { readonly dryRun?: boolean } = {}): Promise<ApplyResult> => {
  const ledger = launchLedger(deps);
  const brief = await readBrief(briefOf(lane, deps.config.defaultCwd));
  if (!brief) throw new DirectiveError(`lane ${lane.key}: its brief ${lane.brief} is not there`);
  const blocks = await blockTexts();
  const gaps = briefGaps(lane, brief, ledger, await laneRepo(deps, lane.cwd ?? deps.config.defaultCwd), blocks);
  const byId = new Map(ledger.entries.map((e) => [e.id, e] as const));
  const send: Directive[] = [];
  const lines: string[] = [];
  for (const g of gaps) {
    const e = byId.get(g.id);
    if (!e) continue;
    if (e.block || e.mode === "inject") send.push(e);
    else lines.push(`DIRECTIVES_APPLY_REQUIRE ${lane.key} ${e.id}: ${e.name} is a brief requirement, not a text to send; the lead writes it into the lane's brief`);
  }
  if (!send.length) return { ok: true, added: [], lines: [...lines, `DIRECTIVES_APPLY_NONE ${lane.key}: the brief has every directive in scope it can be sent`] };
  const texts = send.map((e) => (e.block ? blocks[e.block] : directiveText(e)));
  const ids = send.map((e) => e.id);
  const message = applyMessage(lane.brief, texts);
  if (opts.dryRun) return { ok: true, added: ids, message, lines: [...lines, `DIRECTIVES_APPLY_DRY ${lane.key}: would send ${ids.join(", ")} to ${lane.pane ?? "(no pane)"} and add them to ${lane.brief}`] };
  if (!lane.pane) throw new DirectiveError(`lane ${lane.key} has no pane to send the directives to`);
  if (!(await sendVerified(deps.run, deps.clock, deps.config, lane.pane, message))) {
    const line = `DIRECTIVES_APPLY_NOT_SENT ${lane.key} ${lane.pane}: the [LEAD] message was not submitted; the brief is unchanged (run it again)`;
    watchLog(deps.config.watchLog, deps.clock, { source: "directives", line });
    return { ok: false, added: [], message, lines: [...lines, line] };
  }
  await Bun.write(briefOf(lane, deps.config.defaultCwd), withApplied(brief, texts));
  await deps.registry.patch(lane.key, { directives: { applied: [...new Set([...(lane.directives?.applied ?? []), ...ids])], waived: lane.directives?.waived ?? [] } });
  const line = `DIRECTIVES_APPLIED ${lane.key}: ${ids.join(", ")} sent to ${lane.pane} (SUBMITTED) and added to ${lane.brief} under "${APPLIED_HEADING.slice(3)}"`;
  watchLog(deps.config.watchLog, deps.clock, { source: "directives", line });
  return { ok: true, added: ids, message, lines: [...lines, line] };
};

// --- dori directives check: a reviewer of another family compares each prompt with his message ---

export const MEANING_SYSTEM = "You compare an owner's message with a directive a lead rewrote from it. You answer only in the requested format. You never ask questions and never translate quotes.";

export const meaningPrompt = (e: Pick<Directive, "id" | "name" | "basis" | "rule" | "words" | "original" | "prompt">): string => [
  "An owner gave a standing directive in Korean. WORDS is the directive as he said it: his message with only fillers and whole unrelated sentences left out. ORIGINAL is his whole message, for context. PROMPT is the lead's rewrite of WORDS as a standing rule for coding agents: what a lane does from now on, in general terms, imperative or declarative, no question, no spoken filler.",
  `CONTEXT (the lead's notes, not his words): the directive is called "${e.name}"; ${e.basis ?? ""}${e.rule ? ` The lead applies it as: ${e.rule}` : ""}`,
  "WORDS can hold a task he asked to be done once in that message, a description of that situation or an aside; those are not the standing directive, and PROMPT leaving them out is not MISSING. A remark about a past case (\"처음부터 있었어야 할 것 같아\") may become the rule it implies. The rewrite may change the form (question to order, spoken to written, \"해 줘\" to \"한다\"), say who \"나\" and \"너\" are (형 = the owner, 리드 = the agent he spoke to) and name what a bare reference (\"이런 스레드\") points at when CONTEXT says it, and nothing else: it takes no requirement from the lead's notes that WORDS does not state. Check that PROMPT keeps every condition, target, scope, exception, step and the strength of WORDS (반드시 / 항상 / 절대 / 모두 / 가끔 stay as strong or as weak), and adds no requirement, target or method he did not state.",
  `ORIGINAL:\n<<<\n${e.original ?? e.words}\n>>>`,
  `WORDS:\n<<<\n${e.words}\n>>>`,
  `PROMPT:\n<<<\n${e.prompt ?? ""}\n>>>`,
  "Answer with the first line exactly \"VERDICT: SAME\" when PROMPT means what WORDS means, or \"VERDICT: CHANGED\" followed by one line per problem:",
  "- MISSING: <what of WORDS is not in PROMPT>",
  "- ADDED: <what PROMPT asks that WORDS does not>",
  "- STRENGTH: <a word whose strength changed, WORDS vs PROMPT>",
  "- QUESTION: <a part of PROMPT that is still a question>",
  "Nothing else.",
].join("\n");

export type MeaningVerdict = { readonly same: boolean; readonly problems: readonly string[] };

export const parseMeaning = (reply: string): MeaningVerdict | undefined => {
  const m = /^\s*\**VERDICT:\**\s*(SAME|CHANGED)\b/im.exec(reply);
  if (!m) return undefined;
  const problems = reply.split("\n").map((l) => l.trim().replace(/^[-*]\s*/, "")).filter((l) => /^(?:MISSING|ADDED|STRENGTH|QUESTION):/.test(l));
  return { same: m[1] === "SAME" && !problems.length, problems };
};

const meaningKey = (e: Directive): string => createHash("sha256").update(JSON.stringify([e.id, e.original ?? "", e.words, e.prompt ?? ""])).digest("hex").slice(0, 32);
type MeaningCache = Record<string, { readonly id: string; readonly model: string; readonly at: string }>;
export const meaningCachePath = (stateDir: string): string => join(stateDir, "directives", "meaning.json");

// Every owner entry with a prompt, against his words, by a reviewer of another family than the lead's model (reviewers.models,
// reviewers.first first, the reviewers command). A SAME verdict is kept per (id, original, words, prompt) in the state
// directory, so only a new or changed prompt is read again. Lines: DIRECTIVES_MEANING_OK, DIRECTIVES_BAD (meaning changed),
// DIRECTIVES_MEANING_FAILED (no reviewer answered: not checked, and the check fails).
export const checkMeaning = async (deps: Pick<FlowDeps, "run" | "config" | "clock">, ledger: Ledger): Promise<{ readonly lines: readonly string[]; readonly ok: boolean }> => {
  const path = meaningCachePath(deps.config.stateDir);
  const file = Bun.file(path);
  const cache: MeaningCache = (await file.exists()) ? (JSON.parse(await file.text()) as MeaningCache) : {};
  const todo = ledger.entries.filter((e) => e.by === "owner" && e.words && e.prompt);
  const fresh = todo.filter((e) => !cache[meaningKey(e)]);
  const lines: string[] = todo.filter((e) => cache[meaningKey(e)]).map((e) => `DIRECTIVES_MEANING_OK ${e.id} (read before by ${cache[meaningKey(e)]?.model})`);
  if (!fresh.length) return { lines, ok: true };
  const oc = deps.config.reviewers;
  const listed = reviewers(deps.config.defaultModel, oc.first ? [oc.first, ...deps.config.reviewers.models.filter((m) => m !== oc.first)] : deps.config.reviewers.models);
  let calls: string[] = [];
  try {
    calls = (await checkReviewers(deps as FlowDeps, listed)).flatMap((c) => (c.call ? [c.call] : []));
  } catch (e) {
    if (!(e instanceof ChallengeError)) throw e;
  }
  if (!calls.length) return { ok: false, lines: [...lines, ...fresh.map((e) => `DIRECTIVES_MEANING_FAILED ${e.id}: no callable reviewer of another family than ${deps.config.defaultModel} in reviewers.models`)] };
  let ok = true;
  // four at a time: a reviewer call takes minutes, and thirty at once trips provider rate limits
  const results: string[] = new Array(fresh.length);
  let next = 0;
  const one = async (e: Directive): Promise<string> => {
    const tried: string[] = [];
    for (const model of calls) {
      const r = await deps.run(fill(oc.command, { model, prompt: meaningPrompt(e), system: MEANING_SYSTEM }), { timeoutMs: oc.minutes * 60_000 });
      const v = r.code === 0 ? parseMeaning(r.out) : undefined;
      if (!v) {
        tried.push(`${model}: ${r.code !== 0 ? `exit ${r.code}` : `no VERDICT line in "${r.out.trim().slice(0, 80)}"`}`);
        continue;
      }
      if (v.same) {
        cache[meaningKey(e)] = { id: e.id, model, at: iso(deps.clock) };
        return `DIRECTIVES_MEANING_OK ${e.id} [${model}]`;
      }
      ok = false;
      return `DIRECTIVES_BAD directive ${e.id}: prompt does not mean what his words mean: ${v.problems.join("; ") || "CHANGED"} [${model}]`;
    }
    ok = false;
    return `DIRECTIVES_MEANING_FAILED ${e.id}: no reviewer answered (${tried.join(" | ")})`;
  };
  await Promise.all(
    Array.from({ length: Math.min(4, fresh.length) }, async () => {
      while (next < fresh.length) {
        const i = next++;
        results[i] = await one(fresh[i]!);
      }
    }),
  );
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(cache, null, 2)}\n`);
  return { lines: [...lines, ...results], ok };
};

// "Nh", "Nd" or an ISO time, back from now
export const sinceIso = (spec: string, now: number): string => {
  const m = /^(\d+)([hd])$/.exec(spec.trim());
  if (m) return new Date(now - Number(m[1]) * (m[2] === "h" ? 3_600_000 : 86_400_000)).toISOString();
  const t = Date.parse(spec);
  if (Number.isNaN(t)) throw new Error(`--since ${spec}: give Nh, Nd or an ISO time`);
  return new Date(t).toISOString();
};

export type AuditResult = { readonly gaps: readonly Gap[]; readonly lines: readonly string[]; readonly lanes: number; readonly failed?: boolean };

// The ledger the audit reads: tolerant, so one bad local line is a DIRECTIVES_LOCAL_SKIP line, not an audit that stops.
const auditLedger = (deps: Pick<FlowDeps, "config">): Ledger => (deps.config.directives.common || deps.config.directives.local ? checkedLedger(deps.config, { tolerant: true }) : launchLedger(deps));

// A row in the lead's inbox (never the owner's channel), like the weekly rollover audit's.
const toInbox = (inbox: string, deps: Pick<FlowDeps, "clock">, content: string): void => {
  if (!inbox) return;
  const ts = iso(deps.clock);
  mkdirSync(dirname(inbox), { recursive: true });
  appendFileSync(inbox, `${JSON.stringify({ ts, id: `directive-audit-${ts}`, kind: "directive-audit", content })}\n`);
};

// Each line in the watch log, the summary in the lead's inbox and typed to the lead; the last line says whether it got there.
const tellLead = async (deps: FlowDeps, inbox: string, lines: readonly string[], summary: string): Promise<string> => {
  for (const line of lines) watchLog(deps.config.watchLog, deps.clock, { source: "directive-audit", line });
  toInbox(inbox, deps, summary);
  const pane = deps.config.leadPane;
  const sent = pane ? await sendVerified(deps.run, deps.clock, deps.config, pane, summary) : false;
  const tail = sent ? `DIRECTIVE_AUDIT_SENT ${pane}` : `DIRECTIVE_AUDIT_NOT_SENT ${pane || "(no leadPane)"}: the summary did not reach the lead's pane; it is in the inbox and the watch log`;
  watchLog(deps.config.watchLog, deps.clock, { source: "directive-audit", line: tail });
  return tail;
};

export const auditStampPath = (stateDir: string): string => join(stateDir, "directives", "audit.json");
type AuditStamp = { readonly at: string; readonly since: string; readonly ok: boolean };
const readStamp = (stateDir: string): AuditStamp | undefined => {
  try {
    return JSON.parse(readFileSync(auditStampPath(stateDir), "utf8")) as AuditStamp;
  } catch {
    return undefined;
  }
};
const writeStamp = (deps: Pick<FlowDeps, "config" | "clock">, since: string, ok: boolean): void => {
  mkdirSync(dirname(auditStampPath(deps.config.stateDir)), { recursive: true });
  writeFileSync(auditStampPath(deps.config.stateDir), `${JSON.stringify({ at: iso(deps.clock), since, ok })}\n`);
};

// The lanes opened since `since` and the owner's messages since then against the ledger. No gap: one DIRECTIVE_AUDIT_OK
// line on stdout and nothing else (quiet). Gaps or local lines left out: each line in the watch log and one
// [DIRECTIVE_AUDIT] summary in the lead's inbox and typed to the lead. dryRun: the lines only. A run that is not a dry run
// leaves its time in the state dir (auditStampPath), so the daily run in freshness knows it was done.
// When a Discord id was made, from the snowflake (a thread opened from a message has that message's id).
const snowflakeMs = (id: string): number => (/^\d{15,}$/.test(id) ? Number((BigInt(id) >> 22n) + 1420070400000n) : Number.NaN);

// The threads the lead opened since `since` with no directives read: a thread in the map that no lane in the registry
// works in (dori launch --thread new maps its thread with no session, so a lane is told by the registry) and that dori
// thread open did not mark with the directives it printed (opened before that check, or mapped by hand). Its work had
// no lane brief and no directives.
export const leadThreadGaps = (map: ThreadMap, lanes: readonly Pick<Lane, "thread">[], since: string): Gap[] => {
  const laneThreads = new Set(lanes.map((l) => l.thread ?? ""));
  const out: Gap[] = [];
  for (const [id, t] of Object.entries(map)) {
    if (t.directives || laneThreads.has(`discord:${id}`)) continue;
    const at = t.openedAt ? Date.parse(t.openedAt) : snowflakeMs(id);
    if (Number.isNaN(at) || new Date(at).toISOString() < since) continue;
    out.push({ lane: `thread:${id}`, id: "-", line: `DIRECTIVE_LEAD thread:${id} -: the lead's thread "${t.title}" (${new Date(at).toISOString()}) was opened without reading the directive ledger and no lane works in it; dori thread open reads it now, or open such work as a lane` });
  }
  return out;
};

// The omo memory repo of a session in cwd, under that account's home: <cwd name>-<sha256(cwd) 8>/repo (dori directive-audit
// reads the lead's for DIRECTIVE_DUPLICATE when directives.memory is not set).
export const memoryRepoFor = (cwd: string, home: string): string => {
  const slug = basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "cwd";
  return join(home, ".omo", "memory", "agents", `${slug}-${createHash("sha256").update(cwd).digest("hex").slice(0, 8)}`, "repo");
};

// The lead memory files where his standing directives were kept before the ledger: system/*.md and reference/*.md, not
// the lead's journal about itself (reference/self/, and system/self-aware.md, which reflection writes from it: his words
// there are what he said about the lead's behaviour, quoted as evidence), and not system/boundaries.md, which keeps what he
// told the lead not to do in his own words by design (a pointer there would be a rewording). A repo that is not there
// leaves the check out, with a line.
const MEMORY_LEFT_OUT = ["system/self-aware.md", "system/boundaries.md"];
export const memoryFiles = (repo: string, skipped: string[]): { readonly path: string; readonly text: string }[] => {
  if (!existsSync(repo)) {
    skipped.push(`DIRECTIVES_MEMORY_SKIP ${repo}: the lead's memory repo is not there; no check for directives kept twice`);
    return [];
  }
  return ["system", "reference"].flatMap((dir) => {
    const d = join(repo, dir);
    if (!existsSync(d)) return [];
    return readdirSync(d).filter((n) => n.endsWith(".md") && !MEMORY_LEFT_OUT.includes(`${dir}/${n}`)).sort().map((n) => ({ path: `${dir}/${n}`, text: readFileSync(join(d, n), "utf8") }));
  });
};

// memory: the lead's omo memory repo (dori directive-audit passes it; "off" or absent: no check for directives kept twice)
export const runDirectiveAudit = async (deps: FlowDeps, opts: { readonly since: string; readonly inbox: string; readonly owner: string; readonly dryRun?: boolean; readonly threads?: ThreadMap; readonly memory?: string }): Promise<AuditResult> => {
  const ledger = auditLedger(deps);
  const skipped = ledger.skipped ?? [];
  const memoryNotes: string[] = [];
  const lanes = (await deps.registry.list()).filter((l) => l.openedAt >= opts.since).sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  const blocks = await blockTexts();
  const entered = await enteredAt(deps, ledger);
  const gaps: Gap[] = [];
  const excused: Excused[] = [];
  for (const l of lanes) {
    const s = await laneGapSplit(deps, l, ledger, blocks, { entered });
    gaps.push(...s.gaps);
    excused.push(...s.excused);
  }
  const notCounted = excused.length ? ` (${excused.length} not counted: entered the ledger after the lane opened, or the lead relayed it in a [LEAD] line; listed with --dry-run)` : "";
  const excusedLines = opts.dryRun ? excused.map((x) => x.line) : [];
  gaps.push(...unledgered(await readBrief(opts.inbox), ledger, opts.owner, opts.since, process.env.DORI_DISCORD_GUILD?.trim() ?? ""));
  if (opts.threads) gaps.push(...leadThreadGaps(opts.threads, await deps.registry.list(), opts.since));
  if (opts.memory && opts.memory !== "off") gaps.push(...duplicated(memoryFiles(opts.memory, memoryNotes), ledger));
  if (!opts.dryRun) writeStamp(deps, opts.since, true);
  if (!gaps.length && !skipped.length) return { gaps, lanes: lanes.length, lines: [...excusedLines, ...memoryNotes, `DIRECTIVE_AUDIT_OK since ${opts.since}: ${lanes.length} lanes and the owner's messages read against ${ledger.entries.length} directives, no gap${notCounted}`] };
  const lines = [...skipped, ...memoryNotes, ...gaps.map((g) => g.line), `DIRECTIVE_AUDIT_DONE since ${opts.since}: ${lanes.length} lanes and the owner's messages read against ${ledger.entries.length} directives, ${gaps.length} gaps${notCounted}, ${skipped.length} local ledger lines left out`];
  if (opts.dryRun) return { gaps, lanes: lanes.length, lines: [...excusedLines, ...lines] };
  const short = gaps.slice(0, 4).map((g) => (g.lane === "-" ? `unledgered ${g.id}` : `${g.lane} ${g.id}`)).join(", ");
  const left = skipped.length ? `${skipped.length} local ledger lines left out (DIRECTIVES_LOCAL_SKIP; fix them in ${deps.config.directives.local || "directives.local"}), ` : "";
  const summary = `[DIRECTIVE_AUDIT] ${left}${gaps.length} directive gaps since ${opts.since}${short ? `: ${short}${gaps.length > 4 ? ", ..." : ""}` : ""}. Full list: dori directive-audit --since ${opts.since} --dry-run`;
  return { gaps, lanes: lanes.length, lines: [...lines, await tellLead(deps, opts.inbox, lines, summary)] };
};

// runDirectiveAudit, and an audit that cannot run (a fork ledger with problems, a file it cannot read) is not a silent
// exit: DIRECTIVE_AUDIT_FAILED in the watch log, the lead's inbox and pane, and failed set (the CLI exits 1).
export const auditOrReport = async (deps: FlowDeps, opts: Parameters<typeof runDirectiveAudit>[1]): Promise<AuditResult> => {
  try {
    return await runDirectiveAudit(deps, opts);
  } catch (e) {
    const line = `DIRECTIVE_AUDIT_FAILED since ${opts.since}: ${e instanceof Error ? e.message : String(e)}`;
    if (opts.dryRun) return { gaps: [], lanes: 0, lines: [line], failed: true };
    writeStamp(deps, opts.since, false);
    const summary = `[DIRECTIVE_AUDIT] 지침 감사가 돌지 못함: ${line.slice(0, 600)}. 고친 뒤 dori directive-audit --since ${opts.since} --dry-run 로 확인`;
    return { gaps: [], lanes: 0, lines: [line, await tellLead(deps, opts.inbox, [line], summary)], failed: true };
  }
};

const DAY_MS = 86_400_000;
// The daily audit on every Dori, from the freshness loop: due when no audit ran in the last 24 h (the 08:30 timer's run
// counts), from the last run on (at most 7 days back, 24 h on the first run). undefined: not due.
export const dailyAuditSince = (stateDir: string, now: number): string | undefined => {
  const last = readStamp(stateDir);
  const at = last ? Date.parse(last.at) : Number.NaN;
  if (!Number.isNaN(at) && now - at < DAY_MS) return undefined;
  return new Date(Number.isNaN(at) ? now - DAY_MS : Math.max(at, now - 7 * DAY_MS)).toISOString();
};

// --- links in one place: one Dori's local ledger holds the owner's message links of fork entries; it pushes them to the
// other Dori (directives.linkPeers), which read them as their links layer (directives.links). The fork holds no links. ---

// The { id, source } rows of the local ledger's lines for fork ids whose source carries a message link or id.
export const linkRows = (cfg: Pick<DoriConfig, "directives">): { readonly id: string; readonly source: string }[] => {
  if (!cfg.directives.local || !existsSync(cfg.directives.local)) return [];
  const common = new Set(loadLedger({ directives: { common: cfg.directives.common, local: "" } }).entries.map((e) => e.id));
  const raw = JSON.parse(readFileSync(cfg.directives.local, "utf8")) as { entries?: { id?: unknown; source?: unknown }[] };
  return (raw.entries ?? []).flatMap((e) => (typeof e?.id === "string" && common.has(e.id) && typeof e.source === "string" && LINK_SOURCE.test(e.source) ? [{ id: e.id, source: e.source }] : []));
};

export const linksStampPath = (stateDir: string): string => join(stateDir, "directives", "links-push.json");

// Writes the rows to every peer as that account (sudo -n -u <user>), only where the file differs; one line per peer.
export const pushLinks = async (deps: Pick<FlowDeps, "run" | "config" | "clock">): Promise<{ readonly lines: readonly string[]; readonly ok: boolean }> => {
  const peers = deps.config.directives.linkPeers ?? [];
  if (!peers.length) return { lines: ["DIRECTIVE_LINKS_NO_PEERS: directives.linkPeers is empty"], ok: true };
  const rows = linkRows(deps.config);
  const text = `${JSON.stringify({ about: "The owner's message links of fork directives, pushed by dori directives links --push from one Dori's local ledger. Only the source of an entry the fork ledger has is read from here; edit the links there, not here.", entries: rows }, null, 2)}\n`;
  const lines: string[] = [];
  let ok = true;
  for (const peer of peers) {
    const m = /^([a-z_][a-z0-9_-]*):(\/\S+)$/.exec(peer);
    if (!m) {
      ok = false;
      lines.push(`DIRECTIVE_LINKS_PUSH_FAIL ${peer}: give <user>:<absolute path>`);
      continue;
    }
    const [, user, path] = m as unknown as [string, string, string];
    const now = await deps.run(["sudo", "-n", "-u", user, "cat", path], { timeoutMs: 15_000 });
    if (now.code === 0 && now.out === text.trim()) {
      lines.push(`DIRECTIVE_LINKS_SAME ${user} ${path}: ${rows.length} links`);
      continue;
    }
    const r = await deps.run(["sudo", "-n", "-u", user, "sh", "-c", 'printf "%s" "$1" > "$2.tmp" && mv -f "$2.tmp" "$2"', "sh", text, path], { timeoutMs: 15_000 });
    if (r.code === 0) lines.push(`DIRECTIVE_LINKS_PUSHED ${user} ${path}: ${rows.length} links`);
    else {
      ok = false;
      lines.push(`DIRECTIVE_LINKS_PUSH_FAIL ${user} ${path}: ${(r.err || r.out || `exit ${r.code}`).slice(0, 200)}`);
    }
  }
  for (const line of lines) watchLog(deps.config.watchLog, deps.clock, { source: "directive-links", line });
  if (ok && existsSync(deps.config.directives.local)) {
    mkdirSync(dirname(linksStampPath(deps.config.stateDir)), { recursive: true });
    writeFileSync(linksStampPath(deps.config.stateDir), `${JSON.stringify({ at: iso(deps.clock), mtime: statSync(deps.config.directives.local).mtimeMs })}\n`);
  }
  return { lines, ok };
};

// The push is due when there are peers and the local ledger changed since the last good push, or that push is a day old
// (a peer's file put back by hand is written again).
export const linksDue = (cfg: Pick<DoriConfig, "directives" | "stateDir">, now: number): boolean => {
  if (!cfg.directives.linkPeers?.length || !cfg.directives.local || !existsSync(cfg.directives.local)) return false;
  try {
    const last = JSON.parse(readFileSync(linksStampPath(cfg.stateDir), "utf8")) as { at: string; mtime: number };
    return statSync(cfg.directives.local).mtimeMs !== last.mtime || now - Date.parse(last.at) >= DAY_MS;
  } catch {
    return true;
  }
};

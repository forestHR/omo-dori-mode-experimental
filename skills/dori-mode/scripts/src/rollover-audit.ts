// The audit after a committed handover (lane or lead): what the new session never got from the old one, written to a ledger
// one line per gap, filled in at once, and summed up for the lead each week so the handover itself can be fixed where it
// loses most. The checks before the commit (restatement, supplement rounds, rollback) are not touched: this runs after them.
//
// What it compares, auditAfterMin minutes after HANDOVER_COMMITTED (freshness starts it once per handover):
// - the old conversation (its log stays on disk; the old lead is only frozen): the owner's words the lead quoted in it (his
//   only with proof: his message id in the inbox, or the card he answered; other quotes are the lead's words), and
//   the lead's own instructions of its last auditLeadH hours. Those that reach the new session nowhere (its brief, the
//   handover note, its restatement, the files they name, the cwd's AGENTS.md, the directive ledger) are sorted by a reviewer
//   model: STANDING (still holds, with a risk), CARRIED (holds, but the new session has it in other words: its restatement,
//   brief or the ledger's rules), DONE (carried out or replaced) or CHATTER (a question, status talk, not an instruction).
//   Only STANDING items are gaps.
// - the old session's open todos, goal and monitors against the new session's own (its todo list, goal, monitor manifest),
//   and, for a lane, the summary's decisions and the tried fixes against the restatement as it is now.
// Each gap is a row in <stateDir>/handover/audit.jsonl (stage "audit"); what the supplement rounds before the commit filled
// in is recorded too (stage "supplement"), and so is what a session later reports it did not know (dori handover gap,
// stage "reported"). No gap: no row. The gaps of risk HIGH or MEDIUM (and every todo, goal and monitor) go to the new session
// once through the same supplement path the handover uses, asking it to write what only the conversation held into the
// cwd's AGENTS.md or its memory; the check after its ack decides "fixed". Rows hold a short summary, never a secret value.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { closeFrozen, readFrozen } from "./frozen.ts";
import { basename, dirname, join } from "node:path";

import { ChallengeError, checkReviewers, reviewerOrder, reviewers } from "./challenge.ts";
import { fill } from "./config.ts";
import { laneDirectiveWords } from "./directive-audit.ts";
import { ackFile, launchOf, LEAD_UNDERSTOOD_HEADINGS, manifestPath, type MonitorSpec, openGoal, readManifest, sameCommand } from "./handover.ts";
import { type LaneFacts, type LaneHandoverDeps, missingFrom, UNDERSTOOD_HEADINGS } from "./lane-handover.ts";
import { launchLedger } from "./launch.ts";
import { beforeGenerated } from "./directives.ts";
import { sendVerified } from "./panes.ts";
import { covered, fillGaps, flat, type Missing, quoted, section, words as wordsIn } from "./restatement.ts";
import { type Candidate, inboxMessages, leadLines, type OwnerProof, ownerQuotes, QUOTE, readRollovers, type Said, userLines } from "./rollover.ts";
import { QuestionStore } from "./messenger/discord-cards.ts";
import { iso } from "./run.ts";
import { sessionDirFor } from "./session-id.ts";
import { watchLog } from "./watch-log.ts";

export type Who = "lane" | "lead";
export type Stage = "supplement" | "audit" | "reported";
export type Risk = "HIGH" | "MEDIUM" | "LOW";

// One line of the ledger: lane key (or "lead"), when, the handover it belongs to (its stamp), what kind of thing was left
// out, a short summary of it, where it came from and whether it was filled in.
export type AuditRow = {
  readonly at: string;
  readonly lane: string;
  readonly who: Who;
  readonly handover: string;
  readonly stage: Stage;
  readonly kind: string;
  readonly text: string;
  readonly source: string;
  readonly fixed: boolean;
  readonly risk?: Risk;
  readonly note?: string;
};

export const auditLog = (stateDir: string): string => join(stateDir, "handover", "audit.jsonl");

// Token-shaped strings and key=value secrets are masked, and the text is cut: the ledger is a summary, not a copy.
const SECRET = [
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{12,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{12,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(password|passwd|passphrase|secret|token|api[_-]?key|client[_-]?secret|authorization)(\s*[:=]\s*|\s+)("[^"]*"|'[^']*'|\S+)/gi,
  /[A-Za-z0-9+/_-]{40,}={0,2}/g,
];
export const scrubSecrets = (text: string): string =>
  SECRET.reduce((s, re) => s.replace(re, (m, k?: string, sep?: string) => (typeof k === "string" && typeof sep === "string" && /[a-z]/i.test(k) && m.startsWith(k) ? `${k}${sep}[masked]` : "[masked]")), text);
export const summary = (text: string, max = 160): string => {
  const s = scrubSecrets(text).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

export const appendAudit = (stateDir: string, rows: readonly AuditRow[]): void => {
  if (!rows.length) return;
  const file = auditLog(stateDir);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, rows.map((r) => `${JSON.stringify({ ...r, text: summary(r.text) })}\n`).join(""));
};

export const readAudit = (stateDir: string): AuditRow[] => {
  const file = auditLog(stateDir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l) as AuditRow] : [];
    } catch {
      return [];
    }
  });
};

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};
const readText = (file: string | undefined): string => {
  try {
    return file && existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
};

// --- the committed handovers ---

// a handover that reached HANDOVER_COMMITTED (the new session is the lane or the lead now)
const COMMITTED_RESULTS = new Set(["done", "done-kept-old", "done-frozen", "kept-new-old-gone"]);

type LaneResult = { readonly at: string; readonly key: string; readonly to: string; readonly note: string; readonly result: string };
type LeadResult = { readonly at: string; readonly to: { readonly pane: string; readonly session?: string }; readonly note: string; readonly result: string };
type LeadFactsFile = { readonly cwd?: string; readonly monitors?: MonitorSpec[]; readonly todos?: string[]; readonly goal?: string; readonly leadNote?: string; readonly oldLog?: string };

export type Committed = {
  readonly who: Who;
  readonly key: string;
  // <key>-<YYYYMMDD-HHMMSS> for a lane, <YYYYMMDD-HHMMSS> for the lead: the note's name without .md
  readonly stamp: string;
  readonly note: string;
  readonly at: string;
  readonly result: string;
  readonly to: string;
  readonly session?: string;
};

export const markerFile = (note: string): string => note.replace(/\.md$/, ".audit.json");
// ms, calls, tokensEst: what a finished audit cost (its time, its model calls, their tokens estimated from the text size)
export type Marker = { readonly at: string; readonly status: "queued" | "started" | "done"; readonly pid?: number; readonly rows?: number; readonly line?: string; readonly ms?: number; readonly calls?: number; readonly tokensEst?: number };

export const committedHandovers = (stateDir: string): Committed[] => {
  const out: Committed[] = [];
  const lanes = join(stateDir, "handover", "lanes");
  const files = (dir: string): string[] => {
    try {
      return readdirSync(dir).filter((n) => n.endsWith(".result.json"));
    } catch {
      return [];
    }
  };
  for (const n of files(lanes)) {
    const r = readJson<LaneResult>(join(lanes, n));
    if (r?.note && r.key && COMMITTED_RESULTS.has(r.result)) out.push({ who: "lane", key: r.key, stamp: basename(r.note, ".md"), note: r.note, at: r.at, result: r.result, to: r.to });
  }
  const top = join(stateDir, "handover");
  for (const n of files(top)) {
    const r = readJson<LeadResult>(join(top, n));
    if (r?.note && r.to?.pane && COMMITTED_RESULTS.has(r.result)) out.push({ who: "lead", key: "lead", stamp: basename(r.note, ".md"), note: r.note, at: r.at, result: r.result, to: r.to.pane, ...(r.to.session ? { session: r.to.session } : {}) });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
};

// The handovers freshness should audit now: committed at least afterMin and at most windowH ago, not audited or queued yet.
export const auditDue = (stateDir: string, now: number, cfg: { readonly auditAfterMin: number; readonly auditWindowH: number }): Committed[] => {
  if (cfg.auditAfterMin < 0 || cfg.auditWindowH <= 0) return [];
  return committedHandovers(stateDir).filter((c) => {
    const age = now - Date.parse(c.at);
    return age >= cfg.auditAfterMin * 60_000 && age <= cfg.auditWindowH * 3_600_000 && !existsSync(markerFile(c.note));
  });
};

export const writeMarker = (note: string, m: Marker): void => writeFileSync(markerFile(note), JSON.stringify(m, null, 1));

// --- the old conversation ---

export { type Candidate, type OwnerProof, ownerQuotes, userLines };


// The [REPORT] lines the old session sent (typed through dori type, so they sit in its tool calls), oldest first, once each.
const OPAQUE = /signature|encrypted/i;
const stringsOf = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (!OPAQUE.test(k)) stringsOf(x, out);
  return out;
};
export const reportsIn = (log: string | undefined, key: string): { readonly at: string; readonly text: string }[] => {
  const mark = `[REPORT] ${key} |`;
  const seen = new Set<string>();
  const out: { at: string; text: string }[] = [];
  for (const line of readText(log).split("\n")) {
    if (!line.includes(mark)) continue;
    let o: { timestamp?: string };
    try {
      o = JSON.parse(line) as typeof o;
    } catch {
      continue;
    }
    for (const s of stringsOf(o)) {
      const at = s.indexOf(mark);
      if (at < 0) continue;
      const text = s.slice(at).split(/["\n]/)[0]?.trim() ?? "";
      if (text.length > mark.length + 8 && !seen.has(text)) {
        seen.add(text);
        out.push({ at: o.timestamp ?? "", text });
      }
    }
  }
  return out;
};

export const leadInstructions = (said: readonly Said[], since: number): Candidate[] =>
  leadLines(said, since).map((s) => ({ kind: "lead instruction", text: s.text.replace(/\s+/g, " ").trim(), at: s.at, line: s.line, context: "" }));

// --- what reached the new session ---

const MD_PATH = /(?:~|\/(?:home|Users|root|tmp|srv|opt)\/)[\w.@/+-]*?\.md\b/g;
const MAX_FILE = 512 * 1024;
// the text the new session has (or is pointed to) besides its conversation: the files named, the cwd's AGENTS.md and CLAUDE.md
export const carriedFiles = (texts: readonly string[], home: string, cwd: string): string[] => {
  const paths = new Set<string>([join(cwd, "AGENTS.md"), join(cwd, "CLAUDE.md")]);
  for (const t of texts) for (const m of t.matchAll(MD_PATH)) paths.add(m[0].startsWith("~") ? join(home, m[0].slice(1)) : m[0]);
  return [...paths].slice(0, 40).filter((p) => {
    try {
      return existsSync(p) && statSync(p).isFile() && statSync(p).size <= MAX_FILE;
    } catch {
      return false;
    }
  });
};

const sessionFile = (dir: string, session: string): string | undefined => {
  try {
    const name = readdirSync(dir).find((n) => n.endsWith(`_${session}.jsonl`));
    return name ? join(dir, name) : undefined;
  } catch {
    return undefined;
  }
};

// every todo of a session (done ones too: a todo the new session finished was carried)
export const allTodos = (sessionDir: string, session: string): string[] => {
  const file = sessionFile(sessionDir, session);
  if (!file) return [];
  const last = readText(file).split("\n").findLast((l) => l.includes('"senpi.todo-state"'));
  try {
    const data = last ? (JSON.parse(last) as { data?: { phases?: { name?: string; tasks?: { content?: string }[] }[] } }).data : undefined;
    return (data?.phases ?? []).flatMap((p) => (p.tasks ?? []).map((t) => t.content ?? ""));
  } catch {
    return [];
  }
};

const anyGoal = (sessionDir: string, session: string): string | undefined =>
  openGoal(sessionDir, session) ?? readJson<{ goal?: { objective?: string } }>(join(sessionDir, "extensions", "goal", `${session}.json`))?.goal?.objective;

const norm = (text: string, home: string): string => text.replace(/(^|[\s=:'"])~\//g, `$1${home}/`).replace(/\s+/g, " ").trim();
// a monitor counts as carried when the new session armed the same watch at any time (an ended one-shot watch included).
// One that starts work (LAUNCHES_WORK) is carried by the watch-only one the note asks for in its place (a path watch or a
// command that starts nothing, with its description or filter, or its script's watch-only form): counting only its own
// command sent e7-leap's correct watch-only re-arm back as "never armed" with the launching tool.monitor call as evidence
// (audit 2026-10-24 04:15Z), the step that relaunches a finished chain.
const armed = (m: MonitorSpec, entries: ReturnType<typeof readManifest>, home: string): boolean => {
  const launch = m.launch ?? (m.command ? launchOf(m.command, home) : undefined);
  if (m.command && launch) {
    return entries.some((e) => (e.path || (!!e.command && !launchOf(e.command, home)))
      && ((!!m.description && e.description === m.description) || (!!m.filter && e.filter === m.filter) || (!!launch.rearm && !!e.command && sameCommand(launch.rearm, e.command, home))));
  }
  return entries.some((e) => (m.command ? !!e.command && norm(m.command, home) === norm(e.command, home) : m.path ? !!e.path && norm(m.path, home) === norm(e.path, home) : !!m.description && e.description === m.description));
};
const launchNote = (m: MonitorSpec, home: string): string => (m.command && (m.launch ?? launchOf(m.command, home)) ? "; it starts work (LAUNCHES_WORK): arm the watch-only monitor its line in the note describes, never this command, which would start the work again" : "");

// --- sorting what only the conversation held ---

export type Verdict = { readonly verdict: "STANDING" | "CARRIED" | "DONE" | "CHATTER"; readonly risk?: Risk; readonly why: string };
// has: what the new session holds in words of its own (its restatement, the brief, the directive ledger's rules): an item
// it holds in other words is CARRIED, not a gap
// cost: the model calls made and the text they carried (prompt, system and reply), for the audit's cost line
export type Classify = (items: readonly Candidate[], ctx: { readonly who: Who; readonly key: string; readonly title: string; readonly goal: string; readonly state: string; readonly model: string; readonly has: string; readonly reports: string }) => Promise<{ readonly verdicts?: readonly Verdict[]; readonly model?: string; readonly error?: string; readonly cost?: { readonly calls: number; readonly chars: number } }>;

export const CLASSIFY_SYSTEM = "You sort what an agent session's conversation held when its work moved to a new session. You answer only in the requested line format. You never ask questions and never translate quotes.";

export const classifyPrompt = (items: readonly Candidate[], ctx: Parameters<Classify>[1]): string => [
  `The ${ctx.who === "lead" ? "lead session" : `worker lane ${ctx.key} (${ctx.title})`} moved to a new agent session. The items below come from the old session's conversation: the owner's words the lead quoted (checked against his messages), quotes that are the lead's own words, and the lead's instructions. The new session never got them: they are not in its brief, its handover note, its restatement, the files those name, its AGENTS.md or the directive ledger.`,
  `Goal: ${ctx.goal || "(none recorded)"}`,
  `Where the work stands now: ${ctx.state || "(unknown)"}`,
  "",
  "The old session's own reports, oldest first (a later report that says an item was carried out makes it DONE):",
  ctx.reports || "(none)",
  "",
  "What the new session has (its restatement, its brief and the standing rules of the directive ledger), in its own words:",
  ctx.has.slice(0, 16_000) || "(nothing)",
  "",
  "Sort each item:",
  "- STANDING: it still holds for the work now: a rule or constraint, a decision, or a request for work that is not finished. Add HIGH when the new session would likely act wrongly, redo work or ask the owner again without it; MEDIUM when it matters for upcoming work; LOW when it barely matters.",
  "- CARRIED: it still holds, but the new session already has it in other words in the text above (same rule, decision or open work).",
  "- DONE: a request that was carried out or answered, or that a later item replaced.",
  "- CHATTER: a question, status talk, an acknowledgement, or text that is not an instruction (a log line, a command, the lead's own message to the owner).",
  "An item marked owner's words is the owner's own message (checked by its id or card); lead's words are the lead's (a rule it set, or what it told the owner), never call them the owner's.",
  "A later item replaces an earlier one on the same matter: the owner first chose one name or option and later another ('yoodori-ops' at 23:43, then 'zzangdori-ops' at 23:49) -> the earlier is DONE (replaced) and only the latest is STANDING. Answer one line per item and nothing else: `<number> STANDING HIGH|MEDIUM|LOW <reason, under 15 words>`, `<number> CARRIED <where>`, `<number> DONE <reason>` or `<number> CHATTER <reason>`.",
  "",
  "Items (oldest first):",
  ...items.map((it, i) => `${i + 1}. [${it.kind}, ${it.at.slice(0, 16) || "?"}] "${it.text.slice(0, 600)}"${it.context ? `\n   context: ${it.context.slice(0, 500)}` : ""}`),
].join("\n");

const VERDICT = /^\s*(\d+)[.)]?\s+\**(STANDING|CARRIED|DONE|CHATTER)\**(?:\s+\**(HIGH|MEDIUM|LOW)\**)?\s*[-:–—]?\s*(.*)$/gim;
export const parseVerdicts = (reply: string, n: number): (Verdict | undefined)[] => {
  const out: (Verdict | undefined)[] = Array.from({ length: n }, () => undefined);
  for (const m of reply.matchAll(VERDICT)) {
    const i = Number(m[1]) - 1;
    if (i < 0 || i >= n || out[i]) continue;
    const verdict = m[2]?.toUpperCase() as Verdict["verdict"];
    out[i] = { verdict, ...(verdict === "STANDING" ? { risk: ((m[3]?.toUpperCase() as Risk | undefined) ?? "MEDIUM") } : {}), why: (m[4] ?? "").trim().slice(0, 160) };
  }
  return out;
};

// The reviewer models (reviewers.first first, another family than the session's), in order, until one answers for at least
// half of the items; an item it skipped counts as STANDING MEDIUM.
export const reviewerClassify = (deps: LaneHandoverDeps): Classify => async (items, ctx) => {
  const cfg = deps.config.reviewers;
  const failures: string[] = [];
  let checks: Awaited<ReturnType<typeof checkReviewers>> = [];
  try {
    checks = await checkReviewers(deps, reviewers(ctx.model, reviewerOrder(cfg.models, cfg.first)));
  } catch (e) {
    if (!(e instanceof ChallengeError)) throw e;
    failures.push(e.message);
  }
  const prompt = classifyPrompt(items, ctx);
  const cost = { calls: 0, chars: 0 };
  for (const c of checks) {
    if (!c.call) {
      failures.push(`${c.listed}: ${c.note}`);
      continue;
    }
    const r = await deps.run(fill(cfg.command, { model: c.call, prompt, system: CLASSIFY_SYSTEM }), { timeoutMs: cfg.minutes * 60_000 });
    cost.calls++;
    cost.chars += prompt.length + CLASSIFY_SYSTEM.length + r.out.length;
    const got = r.code === 0 ? parseVerdicts(r.out, items.length) : [];
    if (got.filter(Boolean).length * 2 >= items.length && got.some(Boolean)) return { verdicts: got.map((v) => v ?? { verdict: "STANDING", risk: "MEDIUM", why: "not sorted by the reviewer" }), model: c.call, cost };
    failures.push(`${c.call}: ${r.code !== 0 ? `exit ${r.code} ${r.err.split("\n").find((l) => l.trim())?.slice(0, 120) ?? ""}` : `${got.filter(Boolean).length}/${items.length} items sorted`}`);
  }
  return { error: failures.join(" | ") || "no reviewer of another family in reviewers.models", cost };
};

// --- one handover's audit ---

type Gap = Missing & { readonly risk?: Risk; readonly conversation?: boolean };

export type AuditOptions = { readonly dryRun?: boolean; readonly noSend?: boolean; readonly force?: boolean; readonly classify?: Classify };
export type AuditResult = { readonly code: number; readonly rows: readonly AuditRow[]; readonly line: string };

const UNDER: Record<string, string> = { "owner's words": "Owner's words", "lead's words": "Decisions", "lead instruction": "Decisions", todo: "Next step", goal: "Goal", monitor: "Next step" };

// the new session keeps working while the audit runs, so it gets longer than a handover round to answer (10 min)
const AUDIT_TRIES = 120;

export const RECORD_TEXT = "Some of these lived only in the old conversation: write each one that still holds into the AGENTS.md of your working directory (or your Dori's AGENTS.md for a rule about Dori itself) or into your memory, so the next session gets it from a file; say which in your next report.";

export const auditHandover = async (deps: LaneHandoverDeps, c: Committed, opts: AuditOptions = {}): Promise<AuditResult> => {
  const { config } = deps;
  const at = iso(deps.clock);
  const started = deps.clock.now();
  let cost: { readonly calls: number; readonly chars: number } = { calls: 0, chars: 0 };
  let unsorted = false;
  const emit = (line: string): void => {
    deps.print(line);
    if (!opts.dryRun) watchLog(config.watchLog, deps.clock, { source: "handover", line });
  };
  const marker = readJson<Marker>(markerFile(c.note));
  const skip = (code: number, line: string): AuditResult => {
    deps.print(line);
    return { code, rows: [], line };
  };
  if (!opts.force && marker?.status === "done") return skip(0, `HANDOVER_AUDIT_DONE ${c.key} ${c.stamp}: audited at ${marker.at} (${marker.rows ?? 0} rows); --force audits again`);
  if (!opts.force && marker?.status === "started" && marker.pid && marker.pid !== process.pid && deps.alive(marker.pid)) return skip(2, `HANDOVER_AUDIT_RUNNING ${c.key} ${c.stamp}: pid ${marker.pid} audits it now`);
  if (!opts.dryRun) writeMarker(c.note, { at, status: "started", pid: process.pid });
  const stem = c.note.replace(/\.md$/, "");
  const understood = `${stem}.understood.md`;
  const factsFile = `${stem}.json`;
  const lane = c.who === "lane" ? await deps.registry.read(c.key) : undefined;
  const laneFacts = c.who === "lane" ? readJson<LaneFacts>(factsFile) : undefined;
  const leadFacts = c.who === "lead" ? readJson<LeadFactsFile>(factsFile) : undefined;
  const cwd = laneFacts?.cwd ?? leadFacts?.cwd ?? config.defaultCwd;
  const oldLog = laneFacts?.oldLog ?? leadFacts?.oldLog;
  const brief = laneFacts?.lane.brief ?? lane?.brief;
  const summaryText = laneFacts?.laneNote ?? leadFacts?.leadNote ?? "";
  const noteText = readText(c.note);
  // the new session: its pane is still the lane's (or the lead's), and its omo session id
  const live = c.who === "lane" ? lane?.pane === c.to : config.leadPane === c.to;
  const session = c.session ?? (c.who === "lane" && live && lane?.session ? lane.session : live ? await deps.sessionOf(c.to, cwd).catch(() => "") : "");
  const sessionDir = sessionDirFor(config.sessionsDir, cwd);
  const restated = (): string => readText(understood);
  const ledger = await (async (): Promise<string[]> => {
    try {
      const l = launchLedger(deps);
      return c.who === "lane" && lane ? await laneDirectiveWords(deps, lane, l) : l.entries.map((e) => e.words).filter(Boolean);
    } catch (e) {
      emit(`HANDOVER_AUDIT_WARN ${c.key} ${c.stamp}: the directive ledger could not be read (${String(e).slice(0, 160)}); its words do not count as carried`);
      return [];
    }
  })();
  const fixed = [readText(brief), noteText, ...ledger];
  const files = carriedFiles([...fixed, restated()], deps.home, cwd);
  const carried = (): string => flat([...fixed, restated(), ...files.map((f) => readText(f))].join("\n"));
  const all0 = carried();

  // what only the conversation held
  const said = userLines(oldLog);
  const inbox = inboxMessages(deps.inbox ?? "", deps.ownerIds ?? []);
  const cards = new QuestionStore(deps.cardDir);
  const proof: OwnerProof = { message: (id) => inbox.ids.includes(inbox.find(id)?.author ?? "-"), card: (id) => cards.get(id)?.status === "answered" };
  const quotes = ownerQuotes(said, proof).filter((q) => !quoted(all0, q.text));
  const leadSince = Date.parse(c.at) - config.handover.auditLeadH * 3_600_000;
  // an instruction is judged on its own words: the quotes in it are items of their own, and a bare relay of one is no instruction
  const own = (t: string): string => t.replace(QUOTE, " ").replace(/\d{6,}/g, " ");
  const instructions = c.who === "lane" ? leadInstructions(said, leadSince).filter((s) => wordsIn(own(s.text)).length >= 3 && !covered(all0, own(s.text))) : [];
  const candidates = [...quotes, ...instructions].sort((a, b) => a.at.localeCompare(b.at));
  const counts = { candidates: candidates.length, standing: 0, carried: 0, done: 0, chatter: 0 };
  const gaps: Gap[] = [];
  let sortedBy = "";
  if (candidates.length) {
    const classify = opts.classify ?? reviewerClassify(deps);
    const state = [lane?.lastReport ?? "", section(summaryText, "In progress"), section(summaryText, "Next step"), section(restated(), "Next step")].filter(Boolean).join(" | ").replace(/\s+/g, " ").slice(0, 1500);
    const r = await classify(candidates, { who: c.who, key: c.key, title: lane?.title ?? laneFacts?.lane.title ?? "", goal: lane?.goal ?? laneFacts?.lane.goal ?? "", state, model: lane?.model ?? config.defaultModel, reports: reportsIn(oldLog, c.key).slice(-60).map((x) => `- ${x.at.slice(0, 16)} ${x.text.slice(0, 350)}`).join("\n"), has: [restated(), beforeGenerated(readText(brief)), ...ledger].join("\n").replace(/\n{3,}/g, "\n\n") });
    cost = r.cost ?? cost;
    unsorted = !r.verdicts;
    if (!r.verdicts) emit(`HANDOVER_AUDIT_UNSORTED ${c.key} ${c.stamp}: ${candidates.length} items only the old conversation held were not sorted (${r.error ?? "no answer"}); none is recorded`);
    sortedBy = r.model ?? "";
    (r.verdicts ?? []).forEach((v, i) => {
      const it = candidates[i];
      if (!it) return;
      if (v.verdict === "STANDING") {
        counts.standing++;
        gaps.push({ kind: it.kind, text: it.text, under: UNDER[it.kind] ?? "", source: `the old conversation, line ${it.line}${it.at ? ` (${it.at.slice(0, 16)}Z)` : ""}; ${v.why}`, byWords: it.kind === "lead instruction", risk: v.risk ?? "MEDIUM", conversation: true });
      } else if (v.verdict === "CARRIED") counts.carried++;
      else if (v.verdict === "DONE") counts.done++;
      else counts.chatter++;
    });
  }
  // what the records hold: todos, goal, monitors (and, for a lane, the summary's decisions and the tried fixes)
  const newTodos = session ? allTodos(sessionDir, session) : [];
  const todoText = (): string => flat([...(session ? allTodos(sessionDir, session) : []), restated()].join("\n"));
  const oldTodos = (laneFacts?.todos ?? leadFacts?.todos ?? []).map((t) => t.replace(/ \((in_progress|pending|blocked)\)$/, "").replace(/^[^:]{1,60}: /, ""));
  // without the new session's own log (it was replaced by a later handover, or cannot be found) its todos, goal and
  // monitors are not known: nothing is said about them rather than every old todo counted as lost
  if (session) for (const t of oldTodos) if (!covered(todoText(), t)) gaps.push({ kind: "todo", text: t, under: "Next step", source: `the old session's open todo; the new session has ${newTodos.length} todos`, byWords: true });
  const oldGoal = laneFacts?.goal ?? leadFacts?.goal;
  if (oldGoal && session && !anyGoal(sessionDir, session) && !quoted(flat(restated()), oldGoal.replace(/ \((active|paused|blocked)\)$/, ""))) gaps.push({ kind: "goal", text: oldGoal, under: "Goal", source: "the old session's goal; the new session registered none" });
  const monitors = laneFacts?.monitors ?? leadFacts?.monitors ?? [];
  const manifest = (): ReturnType<typeof readManifest> => (session ? readManifest(manifestPath(config.sessionsDir, cwd, session)) : []);
  if (session) for (const m of monitors) if (!armed(m, manifest(), deps.home)) gaps.push({ kind: "monitor", text: m.description || m.command || m.path || "?", under: "Next step", source: `the old session's monitor${m.command ? ` (${m.command.slice(0, 120)})` : ""}; never armed in the new session${launchNote(m, deps.home)}` });
  // only a restatement written before the commit (handovers before owner Q476) is measured against the note
  if (laneFacts && existsSync(understood)) for (const m of missingFrom(restated(), laneFacts)) if (m.kind !== "owner goal" && !gaps.some((g) => flat(g.text) === flat(m.text))) gaps.push({ ...m, conversation: m.kind === "decision" || m.kind === "owner's words" });

  // what the supplement rounds before the commit filled in
  const rows: AuditRow[] = [];
  const base = { at, lane: c.key, who: c.who, handover: c.stamp };
  const entry = readRollovers(config.stateDir).findLast((e) => e.kind === "rollover" && (e.supplements ?? []).some((s) => s.file.startsWith(stem)));
  const before = new Map<string, { kind: string; text: string; round: number }>();
  if (entry?.kind === "rollover") for (const s of entry.supplements ?? []) for (const it of s.items) if (!before.has(`${it.kind}\n${flat(it.text)}`)) before.set(`${it.kind}\n${flat(it.text)}`, { ...it, round: s.round });
  for (const it of before.values()) rows.push({ ...base, stage: "supplement", kind: it.kind, text: it.text, source: `the supplement round ${it.round} before the commit`, fixed: true });

  // the gaps go to the new session once, through the handover's supplement path
  const send = gaps.filter((g) => g.risk !== "LOW");
  let still: Gap[] = gaps;
  let sent = "";
  const check = (): Gap[] => {
    const text = carried();
    const todos = todoText();
    const entries = manifest();
    return send.filter((g) =>
      g.kind === "owner's words" || g.kind === "lead's words" ? !quoted(text, g.text)
        : g.kind === "lead instruction" || g.kind === "decision" ? !covered(text, g.text)
        : g.kind === "todo" ? !covered(todos, g.text)
        : g.kind === "goal" ? !(session && anyGoal(sessionDir, session)) && !quoted(flat(restated()), g.text)
        : g.kind === "monitor" ? !monitors.some((m) => (m.description || m.command || m.path) === g.text && armed(m, entries, deps.home))
        : g.kind === "tried fix" ? !flat(section(restated(), "Ruled out")).includes(flat(g.text))
        : !covered(text, g.text));
  };
  if (send.length && !opts.dryRun && !opts.noSend && live) {
    const ackedBy = (id: string): string | undefined => readJson<{ pane?: string }>(ackFile(config.stateDir, id))?.pane ?? (existsSync(ackFile(config.stateDir, id)) ? "" : undefined);
    const conversation = send.some((g) => g.conversation);
    const r = await fillGaps(
      { clock: deps.clock, stateDir: config.stateDir, nonce: deps.nonce, tell: (to, line) => sendVerified(deps.run, deps.clock, config, to, line).catch(() => false), ackedBy },
      { who: c.key, pane: c.to, understood, headings: c.who === "lane" ? UNDERSTOOD_HEADINGS : LEAD_UNDERSTOOD_HEADINGS, rounds: 1, oldLog, check: () => check(), emit: (l) => emit(l.replace(/^HANDOVER_/, "HANDOVER_AUDIT_")), label: "audit-supplement", tries: AUDIT_TRIES, extra: `This comes from the audit after the handover: the work goes on meanwhile.${conversation ? ` ${RECORD_TEXT}` : ""}` },
    );
    sent = r.supplements[0]?.file ?? "";
    const left = new Set(check());
    still = gaps.filter((g) => g.risk === "LOW" || left.has(g));
    if (r.reasons.length && !r.supplements.length) emit(`HANDOVER_AUDIT_NOT_SENT ${c.key} ${c.stamp}: ${r.reasons.join("; ")}`);
  }
  for (const g of gaps) {
    const ok = !still.includes(g);
    const note = g.risk === "LOW" ? "low risk: recorded, not sent" : !live ? "the new session is no longer the lane's; not sent" : opts.noSend ? "not sent (--no-send)" : sent ? (ok ? `filled in after ${basename(sent)}` : `still missing after ${basename(sent)}`) : "not sent";
    rows.push({ ...base, stage: "audit", kind: g.kind, text: g.text, source: g.source, fixed: ok, ...(g.risk ? { risk: g.risk } : {}), note });
  }
  const kinds = [...new Map(rows.map((r) => [r.kind, rows.filter((x) => x.kind === r.kind).length])).entries()].map(([k, n]) => `${k} ${n}`).join(", ");
  const sortedLine = counts.candidates ? `; conversation-only items ${counts.candidates}: standing ${counts.standing}, carried ${counts.carried}, done ${counts.done}, chatter ${counts.chatter}${sortedBy ? ` [${sortedBy}]` : ""}` : "";
  const line = rows.length
    ? `HANDOVER_AUDIT ${c.key} ${c.stamp}: ${rows.length} left out (${kinds}); fixed ${rows.filter((r) => r.fixed).length}, sent ${sent ? basename(sent) : "none"}${sortedLine}`
    : `HANDOVER_AUDIT_OK ${c.key} ${c.stamp}: nothing left out${sortedLine}`;
  if (opts.dryRun) {
    for (const r of rows) deps.print(`AUDIT_ROW ${JSON.stringify({ ...r, text: summary(r.text) })}`);
    deps.print(line);
    return { code: 0, rows, line };
  }
  appendAudit(config.stateDir, rows);
  // what the audit cost (owner Q476): its time, and the model's tokens estimated from the text it read and wrote (4
  // characters a token; the reviewer command reports no usage)
  const ms = deps.clock.now() - started;
  const tokensEst = Math.ceil(cost.chars / 4);
  writeMarker(c.note, { at: iso(deps.clock), status: "done", rows: rows.length, line, ms, calls: cost.calls, tokensEst });
  emit(line);
  emit(`HANDOVER_AUDIT_COST ${c.key} ${c.stamp}: ${Math.round(ms / 1000)} s, ${cost.calls} model call(s), ~${tokensEst} tokens (estimated from the text size)`);
  // the old lead stays frozen only until its audit passed (owner Q476: 17 freezes, no thaw in three weeks): it is closed
  // now; an audit that left something out, or could not sort, keeps it frozen until handover.frozenCloseH
  if (c.who === "lead") {
    const rec = readFrozen(config.stateDir).find((f) => f.to === c.to);
    const passed = !unsorted && rows.every((r) => r.fixed);
    if (rec && !rec.keepFor?.length) emit(passed ? `${await closeFrozen(deps, config.stateDir, rec)} (the audit after the handover passed)` : `HANDOVER_OLD_KEPT_FROZEN ${rec.pane}: the audit ${unsorted ? "could not sort what the old conversation held" : `left ${rows.filter((r) => !r.fixed).length} item(s) not filled in`}; it stays frozen until ${rec.closeAt ?? "it is closed by hand"} (dori handover thaw ${rec.pane} resumes it)`);
  }
  return { code: 0, rows, line };
};

// dori handover audit <note|key|lead>: the note itself, or the latest committed handover of that lane (or of the lead)
export const findCommitted = (stateDir: string, ref: string): Committed | undefined => {
  const all = committedHandovers(stateDir);
  return ref.endsWith(".md") ? all.find((c) => c.note === ref || c.stamp === basename(ref, ".md")) : all.findLast((c) => c.key === ref);
};

// --- what a session reports it did not know ---

export const reportGap = (deps: { readonly config: LaneHandoverDeps["config"]; readonly clock: LaneHandoverDeps["clock"] }, key: string, kind: string, text: string, by: Who, fixed = false): { readonly row: AuditRow; readonly line: string } => {
  const last = committedHandovers(deps.config.stateDir).findLast((c) => c.key === key);
  const row: AuditRow = { at: iso(deps.clock), lane: key, who: key === "lead" ? "lead" : "lane", handover: last?.stamp ?? "", stage: "reported", kind, text, source: `reported by the ${by} (dori handover gap)`, fixed };
  appendAudit(deps.config.stateDir, [row]);
  const line = `HANDOVER_GAP ${key} ${kind}: ${summary(text, 200)} (by the ${by}${last ? `, after the handover ${last.stamp}` : ", no handover on record"})`;
  watchLog(deps.config.watchLog, deps.clock, { source: "handover", line });
  return { row, line };
};

// --- the weekly summary for the lead ---

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const localParts = (t: number, timeZone: string): { readonly date: string; readonly day: number; readonly minutes: number } => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, day: DAYS.indexOf(p.weekday ?? ""), minutes: Number(p.hour) * 60 + Number(p.minute) };
};

// The local date of the latest "Mon 08:30" (handover.auditSummaryAt) in timeZone at or before t: the week a summary belongs to.
export const summaryWeek = (t: number, timeZone: string, spec: string): string | undefined => {
  const m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(\d{1,2}):(\d{2})$/.exec(spec.trim());
  if (!m) return undefined;
  const want = DAYS.indexOf(m[1] ?? "");
  const at = Number(m[2]) * 60 + Number(m[3]);
  const now = localParts(t, timeZone);
  let back = (now.day - want + 7) % 7;
  if (back === 0 && now.minutes < at) back = 7;
  const d = new Date(`${now.date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
};

const weeklyFile = (stateDir: string): string => join(stateDir, "handover", "audit-weekly.json");

// the week whose summary is due (not sent yet), or nothing
export const weeklyDue = (stateDir: string, now: number, timeZone: string, spec: string): string | undefined => {
  if (!spec.trim()) return undefined;
  const week = summaryWeek(now, timeZone || "UTC", spec);
  return week && readJson<{ week?: string }>(weeklyFile(stateDir))?.week !== week ? week : undefined;
};

export const auditSummary = (stateDir: string, now: number, days = 7): string => {
  const since = new Date(now - days * 86_400_000).toISOString();
  const moved = committedHandovers(stateDir).filter((c) => c.at >= since);
  const rows = readAudit(stateDir).filter((r) => r.at >= since);
  const by = (pick: (r: AuditRow) => boolean): number => rows.filter(pick).length;
  const kinds = [...rows.reduce((m, r) => m.set(r.kind, (m.get(r.kind) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  const lanes = [...rows.reduce((m, r) => m.set(r.lane, (m.get(r.lane) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const head = `[ROLLOVER_AUDIT] 지난 ${days}일 교대 ${moved.length}번(점검 ${moved.filter((c) => readJson<Marker>(markerFile(c.note))?.status === "done").length}), 빠진 것 ${rows.length}건(교대 전 보충 ${by((r) => r.stage === "supplement")} · 교대 뒤 점검 ${by((r) => r.stage === "audit")} · 신고 ${by((r) => r.stage === "reported")}; 고침 ${by((r) => r.fixed)}, 못 고침 ${by((r) => !r.fixed)})`;
  if (!rows.length) return `${head}. 교대 기능 고칠 거리 없음.`;
  return `${head}. 많이 빠진 종류: ${kinds.slice(0, 3).map(([k, n]) => `${k} ${n}`).join(", ")}; lane: ${lanes.map(([k, n]) => `${k} ${n}`).join(", ")}. 교대 기능 고칠 거리로: 위 종류가 노트·요약에 실리게. 줄별 내용: ${auditLog(stateDir)}`;
};

// One row in the lead's inbox (never the owner's channel), once per week.
export const sendAuditSummary = (deps: { readonly config: LaneHandoverDeps["config"]; readonly clock: LaneHandoverDeps["clock"] }, inbox: string, week: string): string => {
  const now = deps.clock.now();
  const content = auditSummary(deps.config.stateDir, now);
  mkdirSync(dirname(inbox), { recursive: true });
  appendFileSync(inbox, `${JSON.stringify({ ts: new Date(now).toISOString(), id: `rollover-audit-${week}`, kind: "rollover-audit", content })}\n`);
  mkdirSync(join(deps.config.stateDir, "handover"), { recursive: true });
  writeFileSync(weeklyFile(deps.config.stateDir), JSON.stringify({ week, at: new Date(now).toISOString(), inbox }));
  const line = `ROLLOVER_AUDIT_WEEKLY ${week} -> ${inbox}: ${content}`;
  watchLog(deps.config.watchLog, deps.clock, { source: "handover", line });
  return line;
};


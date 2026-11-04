import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { DoriConfig } from "./config.ts";
import type { Lane } from "./registry.ts";

// The directive ledger: the owner's standing directives in machine-readable form, in two layers. The fork's
// references/directives.json holds the directives every Dori shares (no links, names or paths); a host's local file
// (config directives.local) holds the ones for that host and its repos, with links to the owner's messages. A local
// entry with the id of a fork entry overrides its fields (a link as source, a retirement). dori launch reads both:
// an inject directive in scope that the brief lacks goes in as written in the ledger (LAUNCH_DIRECTIVE_ADDED); a require
// directive the brief does not meet stops the launch (LAUNCH_DIRECTIVE_MISSING) unless the lead waives it with a reason;
// a lead directive is checked against what the lead did (dori directive-audit).

export const DIRECTIVE_MODES = ["inject", "require", "lead"] as const;
export type DirectiveMode = (typeof DIRECTIVE_MODES)[number];
// built-in blocks dori launch already places itself (the brief template's eight steps, the UI steps)
export const DIRECTIVE_BLOCKS = ["eight-steps", "ui-steps"] as const;
export type DirectiveBlock = (typeof DIRECTIVE_BLOCKS)[number];
// what a lead directive checks: the lane opened with a work thread; the owner's standing directives of the window are in the
// ledger; none: on record for the lead and intent-check, with no machine check
export const LEAD_CHECKS = ["thread", "ledger", "none"] as const;
export type LeadCheck = (typeof LEAD_CHECKS)[number];

export type DirectiveScope = {
  readonly all?: boolean;
  readonly ui?: boolean;
  readonly kinds?: readonly string[];
  readonly repos?: readonly string[];
  readonly keywords?: readonly string[];
  // narrowed for lane briefs only: the lead's surfaces stay as for an every-lane entry (no owner row, every thread it opens)
  readonly briefOnly?: boolean;
};

export type Directive = {
  readonly id: string;
  // what the lead and the owner call it ("UI 7단계"); a mention of it in a brief is not a sign of that kind of work
  readonly name: string;
  // owner: the owner stated the directive himself and words is that sentence (typos corrected only), or the directive is a
  // block of his words (eight-steps, ui-steps); lead: a rule the lead set, words stays empty and trigger holds what the owner
  // said that led to it
  readonly by: "owner" | "lead";
  readonly words: string;
  // his whole message(s) as he sent them, on record (several joined with " / "); words is this with only fillers (the
  // ledger's fillers) and whole sentences deleted, nothing reworded, reordered or added (trimProblem checks it)
  readonly original?: string;
  // typos and speech-to-text errors in original, corrected before that check: [as received, corrected]
  readonly fixes?: readonly (readonly [string, string])[];
  // what goes into a brief for an owner entry with words: the lead's rewrite of his words as a directive (imperative or
  // declarative, no question, no spoken filler), with every condition, target and strength of his words and nothing added.
  // words and original stay on record; dori directives check has a reviewer of another family compare prompt with original
  readonly prompt?: string;
  readonly trigger?: string;
  // why the entry is owner or lead: the context of his message, one line
  readonly basis?: string;
  // how the directive reads as a rule, when the owner's words alone do not say it
  readonly rule?: string;
  readonly date: string;
  readonly source: string;
  readonly scope: DirectiveScope;
  readonly mode: DirectiveMode;
  readonly block?: DirectiveBlock;
  // require: regexes (multiline) the brief must all match
  readonly require?: readonly string[];
  readonly check?: LeadCheck;
  // an inject entry that stays on record and in scope, but goes into a brief as the pointer entry with this id (one text
  // that names where the rule is written, e.g. a repo's AGENTS.md); the pointer in a brief counts as this entry
  readonly via?: string;
  readonly layer: "common" | "local";
};

export type Ledger = {
  readonly entries: readonly Directive[];
  // kind name -> regex (case-insensitive); a brief is that kind of work at minHits hits or more
  readonly kinds: Readonly<Record<string, string>>;
  readonly minHits: number;
  // words that name a scope ("노드·GPU"), not work of that kind: left out like directive names
  readonly labels: readonly string[];
  // a regex for an owner message that sets a standing directive (dori directive-audit)
  readonly standing: string;
  // owner message ids the lead read and judged not a standing directive
  readonly reviewed: readonly string[];
  // words and phrases with no directive in them ("알겠어", "아 그리고", his name for the Dori): words may drop them from original
  readonly fillers: readonly string[];
  readonly files: readonly string[];
  // a tolerant load (dori directive-audit): the local lines left out and why, one DIRECTIVES_LOCAL_SKIP line each
  readonly skipped?: readonly string[];
};

export class DirectiveError extends Error {}

export const COMMON_LEDGER = join(import.meta.dir, "../../references/directives.json");
export const DIRECTIVES_HEADING = "## 형 지침 (지침 장부에서 dori launch가 넣음)";
// the section dori directives apply adds to a launched lane's brief, before the parts dori launch appended
export const APPLIED_HEADING = "## 추가 지침(리드, launch 뒤)";

// A prompt that still asks: a question mark, or a sentence ending in a Korean question ending (않아, 할까, 하니, 하나요...).
const QUESTION = /\?|(?:않아|않나|않니|까|니|냐|나요|가요|죠|는가|을래|ㄹ래|할래)\s*(?:[.!]|$|\n)/m;
export const promptQuestion = (prompt: string): string | undefined => QUESTION.exec(prompt)?.[0].trim();

type RawLedger = { entries?: unknown[]; kinds?: Record<string, string>; minHits?: number; labels?: string[]; standing?: string; reviewed?: string[]; fillers?: string[] };

const readLedger = (path: string): RawLedger => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RawLedger;
  } catch (e) {
    throw new DirectiveError(`directive ledger ${path} is not readable JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
};

// A message link or id in a source: what dori directive-audit looks for (unledgered).
export const LINK_SOURCE = /discord(?:app)?\.com\/channels\/|\d{15,}/;

// The links layer (config directives.links): rows { id, source } another Dori pushed (dori directives links --push). It
// only sets the source of an entry the fork ledger already has; any other field, or an id this checkout does not have
// yet (the fork entry is not merged here), is left alone. It never stops a load: a file that is not there or not JSON is
// a skipped line.
const applyLinks = (path: string, byId: Map<string, Directive>, skipped: string[]): void => {
  if (!existsSync(path)) {
    skipped.push(`DIRECTIVES_LOCAL_SKIP ${path}: the links file (config directives.links) is not there; sources stay as the other layers give them`);
    return;
  }
  let raw: RawLedger;
  try {
    raw = readLedger(path);
  } catch (e) {
    skipped.push(`DIRECTIVES_LOCAL_SKIP ${path}: ${(e as Error).message}`);
    return;
  }
  for (const row of raw.entries ?? []) {
    const { id, source } = (row ?? {}) as { id?: unknown; source?: unknown };
    const prior = typeof id === "string" ? byId.get(id) : undefined;
    if (prior && prior.layer === "common" && typeof source === "string" && source.trim()) byId.set(prior.id, { ...prior, source });
  }
};

export const retiredError = (path: string, id: unknown): string =>
  `directive ledger ${path}: retired entry ${typeof id === "string" && id ? id : "(no id)"}; a directive the owner dropped is deleted, not kept: delete the entry and move its message ids to the source of the entry that replaced it, or to reviewed with a note`;

// One ledger from the layers: the fork's (common), the pushed links (links: sources only), the host's (local). A local
// entry with a common id overrides that entry's fields; others are added. tolerant (dori directive-audit): a local line
// that would break the ledger (a source-only line for an id the fork does not have, a field that fails the checks, a
// line that is no entry) is left out with a DIRECTIVES_LOCAL_SKIP line in skipped, the fork entry it overrode stands,
// and the rest is read; strict (launch, directives check) keeps every line, so ledgerProblems names it.
export const loadLedger = (cfg: Pick<DoriConfig, "directives">, opts: { readonly tolerant?: boolean } = {}): Ledger => {
  const files: string[] = [];
  const skipped: string[] = [];
  const byId = new Map<string, Directive>();
  // the ids the local layer touched, with the entry before it did (undefined: the local layer added it)
  const touched = new Map<string, Directive | undefined>();
  let kinds: Record<string, string> = {};
  let standing = "";
  let minHits = 3;
  const labels: string[] = [];
  const reviewed: string[] = [];
  const fillers: string[] = [];
  for (const [layer, path] of [["common", cfg.directives.common], ["links", cfg.directives.links ?? ""], ["local", cfg.directives.local]] as const) {
    if (!path) continue;
    if (layer === "links") {
      applyLinks(path, byId, skipped);
      files.push(path);
      continue;
    }
    if (!existsSync(path)) throw new DirectiveError(`directive ledger ${path} (config directives.${layer}) does not exist`);
    let raw: RawLedger;
    try {
      raw = readLedger(path);
    } catch (e) {
      if (layer !== "local" || !opts.tolerant) throw e;
      skipped.push(`DIRECTIVES_LOCAL_SKIP ${path}: ${(e as Error).message}; the whole local layer is left out`);
      continue;
    }
    files.push(path);
    kinds = { ...kinds, ...raw.kinds };
    standing = raw.standing || standing;
    minHits = raw.minHits ?? minHits;
    labels.push(...(raw.labels ?? []));
    reviewed.push(...(raw.reviewed ?? []));
    fillers.push(...(raw.fillers ?? []));
    for (const [n, e] of (raw.entries ?? []).entries()) {
      // a directive the owner dropped is deleted, never kept marked retired: every read (launch, hint, audit, table,
      // prompts, check) stops on such an entry, tolerant or not, so it can neither apply again nor half-apply
      if (e && typeof e === "object" && "retired" in e) throw new DirectiveError(retiredError(path, (e as { id?: unknown }).id));
      if (opts.tolerant && layer === "local" && (!e || typeof e !== "object" || typeof (e as { id?: unknown }).id !== "string")) {
        skipped.push(`DIRECTIVES_LOCAL_SKIP ${path} entry ${n + 1}: not an entry with an id; left out`);
        continue;
      }
      const entry = e as Partial<Directive>;
      const prior = entry.id ? byId.get(entry.id) : undefined;
      if (layer === "local" && !touched.has(entry.id ?? "")) touched.set(entry.id ?? "", prior);
      byId.set(entry.id ?? "", { ...(prior ?? {}), ...entry, layer: prior ? prior.layer : layer } as Directive);
    }
  }
  if (opts.tolerant) {
    const problems = ledgerProblems({ entries: [...byId.values()], kinds, minHits, labels, standing, reviewed, fillers, files });
    for (const [id, prior] of touched) {
      const own = problems.filter((p) => p.startsWith(`directive ${id || "(no id)"}: `)).map((p) => p.slice(`directive ${id || "(no id)"}: `.length));
      if (!own.length) continue;
      if (prior) byId.set(id, prior);
      else byId.delete(id);
      const what = prior ? "its local line is left out and the fork entry stands" : "not in the fork ledger and not a whole entry; left out";
      skipped.push(`DIRECTIVES_LOCAL_SKIP ${id || "(no id)"}: ${what} (${own.join("; ")})`);
    }
  }
  return { entries: [...byId.values()], kinds, minHits, labels, standing, reviewed, fillers, files, ...(opts.tolerant ? { skipped } : {}) };
};

// --- words against original: deletion only ---

type Tok = { readonly t: string; readonly nl: boolean };
const ELLIPSIS = /(…+\.*|\.{3,})/;
const isEllipsis = (t: string) => /^(?:…+\.*|\.{3,})$/.test(t);
// words split at whitespace; an ellipsis is a token of its own ("그대로다…..모든"); nl: a line break came before it
const tokens = (s: string): Tok[] => {
  const out: Tok[] = [];
  let nl = false;
  for (const part of s.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) {
      nl ||= part.includes("\n");
      continue;
    }
    for (const p of part.split(ELLIPSIS)) {
      if (!p) continue;
      out.push({ t: p, nl });
      nl = false;
    }
  }
  return out;
};
const bare = (t: string) => t.replace(/[,.!?~]+$/, "");
// where a sentence or clause ends: . ! ? , an ellipsis, the " / " between his messages
const endsPart = (t: string) => /[.!?,]["'”’)]*$/.test(t) || isEllipsis(t) || t === "/";

// Why words is not original with only fillers and whole sentences deleted, or undefined when it is. A deleted run of words
// is either fillers only (and ellipses) or whole sentences/clauses: it starts and ends at . ! ? , an ellipsis, a line break,
// a " / " between messages or the ends of the message. Every word kept is his word as he wrote it, in his order.
export const trimProblem = (original: string, words: string, fillers: readonly string[], fixes: readonly (readonly [string, string])[] = []): string | undefined => {
  let text = original;
  for (const [from, to] of fixes) {
    if (!from || !text.includes(from)) return `fix "${from}" is not in original`;
    text = text.split(from).join(to);
  }
  const o = tokens(text);
  const w = tokens(words);
  const phrases = fillers.map((f) => tokens(f).map((x) => bare(x.t))).filter((p) => p.length);
  const n = o.length;
  const startsAt = (i: number) => i === 0 || endsPart(o[i - 1]!.t) || o[i]!.nl || o[i]!.t === "/";
  const endsAt = (k: number) => k === n || endsPart(o[k - 1]!.t) || o[k]!.nl || o[k]!.t === "/" || isEllipsis(o[k]!.t);
  // del[i]: the ends k of a deletable run o[i..k)
  const del: number[][] = [];
  for (let i = 0; i < n; i++) {
    const ends = new Set<number>();
    const seen = new Set<number>([i]);
    const todo = [i];
    while (todo.length) {
      const at = todo.pop()!;
      const next: number[] = [];
      if (at < n && isEllipsis(o[at]!.t)) next.push(at + 1);
      for (const p of phrases) if (p.every((x, d) => at + d < n && bare(o[at + d]!.t) === x)) next.push(at + p.length);
      for (const k of next) {
        ends.add(k);
        if (seen.has(k)) continue;
        seen.add(k);
        todo.push(k);
      }
    }
    if (startsAt(i)) for (let k = i + 1; k <= n; k++) if (endsAt(k)) ends.add(k);
    del.push([...ends]);
  }
  const reach = Array.from({ length: n + 1 }, () => new Array<boolean>(w.length + 1).fill(false));
  reach[0]![0] = true;
  let far = 0;
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= w.length; j++) {
      if (!reach[i]![j]) continue;
      far = Math.max(far, j);
      if (i < n && j < w.length && o[i]!.t === w[j]!.t) reach[i + 1]![j + 1] = true;
      for (const k of del[i] ?? []) reach[k]![j] = true;
    }
  if (reach[n]![w.length]) return undefined;
  return far < w.length
    ? `words is not his original with words deleted: "${w[far]!.t}" (word ${far + 1}) is not there in that order, or what is left out before it is not a filler or a whole sentence`
    : "words is not his original with words deleted: what is left out at the end is not a filler or a whole sentence";
};

const compiles = (re: string): boolean => {
  try {
    new RegExp(re, "m");
    return true;
  } catch {
    return false;
  }
};

// Everything that would make the ledger mean something else than it says: checked at every launch and by dori directives check.
export const ledgerProblems = (ledger: Ledger): string[] => {
  const out: string[] = [];
  const kinds = new Set(Object.keys(ledger.kinds));
  for (const [k, re] of Object.entries(ledger.kinds)) if (!compiles(re)) out.push(`kind ${k}: pattern does not compile`);
  if (ledger.standing && !compiles(ledger.standing)) out.push("standing: pattern does not compile");
  for (const e of ledger.entries) {
    const at = `directive ${e.id || "(no id)"}`;
    if (!e.id || !/^[a-z0-9][a-z0-9-]*$/.test(e.id)) out.push(`${at}: id must be lowercase words with -`);
    if (!e.name) out.push(`${at}: no name`);
    if (e.by !== "owner" && e.by !== "lead") out.push(`${at}: by must be owner or lead`);
    // the owner's words go into briefs as they are: a sentence cut short (… or ...) is a summary of them
    if (/…|\.\.\./.test(e.words ?? "")) out.push(`${at}: words cut with an ellipsis; put the whole sentences of his message, or none (by owner, no words: a decision on record)`);
    if (e.by === "lead" && (e.words || e.original)) out.push(`${at}: a lead rule has no owner words (put what he said in trigger)`);
    if (e.by === "owner" && e.original !== undefined) {
      if (!e.words) out.push(`${at}: original without words (put his words, trimmed of fillers only)`);
      else {
        const p = trimProblem(e.original, e.words, ledger.fillers, e.fixes);
        if (p) out.push(`${at}: ${p}`);
      }
    }
    // what goes into a brief for his words is the lead's directive-style rewrite, never his spoken words or a question
    if (e.by === "owner" && e.words && !e.prompt?.trim()) out.push(`${at}: owner words without prompt (write his words as a directive: every condition, target and strength kept, no question, nothing added)`);
    if (e.prompt && e.by !== "owner") out.push(`${at}: prompt is for an owner entry with words (a lead rule goes in as its rule)`);
    const asks = e.prompt ? promptQuestion(e.prompt) : undefined;
    if (asks) out.push(`${at}: prompt is a question ("${asks}"); write it as a directive`);
    if (e.by === "lead" && !e.rule) out.push(`${at}: a lead rule needs its rule`);
    if (!e.basis) out.push(`${at}: no basis (why it is the owner's directive or the lead's rule)`);
    if (!/^\d{4}-\d{2}-\d{2}/.test(e.date ?? "")) out.push(`${at}: date must start YYYY-MM-DD`);
    if (!e.source) out.push(`${at}: no source`);
    if (!DIRECTIVE_MODES.includes(e.mode)) out.push(`${at}: mode must be ${DIRECTIVE_MODES.join("|")}`);
    if (!e.scope || typeof e.scope !== "object") out.push(`${at}: no scope`);
    for (const k of e.scope?.kinds ?? []) if (!kinds.has(k)) out.push(`${at}: unknown kind ${k}`);
    for (const re of e.scope?.keywords ?? []) if (!compiles(re)) out.push(`${at}: keyword ${re} does not compile`);
    if (e.mode === "inject" && !e.block && !e.words && !e.rule) out.push(`${at}: an inject directive needs words, a rule or a block`);
    if (e.block && !DIRECTIVE_BLOCKS.includes(e.block)) out.push(`${at}: block must be ${DIRECTIVE_BLOCKS.join("|")}`);
    if (e.mode === "require" && !e.require?.length) out.push(`${at}: a require directive needs require patterns`);
    for (const re of e.require ?? []) if (!compiles(re)) out.push(`${at}: require ${re} does not compile`);
    if (e.mode === "lead" && !LEAD_CHECKS.includes(e.check as LeadCheck)) out.push(`${at}: a lead directive needs check ${LEAD_CHECKS.join("|")}`);
    if (e.via !== undefined) {
      const p = ledger.entries.find((x) => x.id === e.via);
      if (e.mode !== "inject" || e.block) out.push(`${at}: via is for an inject directive with its own text`);
      if (!p || p.id === e.id || p.mode !== "inject" || p.block || p.via) out.push(`${at}: via ${e.via} must name another inject entry with its own text and no via`);
    }
  }
  return out;
};

export const checkedLedger = (cfg: Pick<DoriConfig, "directives">, opts: { readonly tolerant?: boolean } = {}): Ledger => {
  const ledger = loadLedger(cfg, opts);
  const problems = ledgerProblems(ledger);
  if (problems.length) throw new DirectiveError(`directive ledger has problems: ${problems.join("; ")}`);
  return ledger;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Where a heading stands as a line of its own (a brief that quotes the heading inside a field does not start that section).
export const headingAt = (text: string, heading: string): number => {
  const m = new RegExp(`(?:^|\\n)${escapeRe(heading)}[ \\t]*(?=\\n|$)`).exec(text);
  return m ? m.index + (m[0].startsWith("\n") ? 1 : 0) : -1;
};

// The sections dori launch writes after the lead's text (the repo's lessons, past signals, the tree, the footer): none of it
// is the owner's or the lead's words, and a brief launched again gets them fresh, not a second copy of the old ones.
export const GENERATED_SECTION = /\n## (?:Lessons for this repo|Past signals|Hypothesis tree|Lane footer) \(written by dori launch\)/;
export const beforeGenerated = (brief: string): string => brief.split(GENERATED_SECTION)[0] ?? brief;

// The lead's text of a brief: what dori launch appended (lessons, past signals, tree, footer) and the ledger block it put in are cut.
export const leadText = (brief: string): string => {
  let own = beforeGenerated(brief);
  for (const heading of [DIRECTIVES_HEADING, APPLIED_HEADING]) {
    const at = headingAt(own, heading);
    if (at < 0) continue;
    const rest = own.slice(at + heading.length);
    const next = rest.search(/\n## /);
    own = own.slice(0, at) + (next < 0 ? "" : rest.slice(next));
  }
  return own;
};

// The text that says what kind of work a brief is: the lead's text without quoted words (the owner's or anyone's) and
// without the names of directives. A brief about a directive ("UI 7단계", "이 PC 학습 금지") is not that kind of work.
export const scopeText = (brief: string, ledger: Pick<Ledger, "entries"> & Partial<Pick<Ledger, "labels">>): string => {
  let text = leadText(brief);
  // names first: a name may hold quote marks (승인 표 "코드에 있음" 열)
  const names = [...ledger.entries.map((e) => e.name), ...(ledger.labels ?? [])].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const name of names) text = text.replace(new RegExp(escapeRe(name), "gi"), " ");
  return text.replace(/"[^"\n]*"|“[^”]*”|‘[^’]*’|「[^」]*」|`[^`\n]*`/g, " ");
};

// Words that mark UI work. 화면 alone is not enough (a terminal screen, the template's "실제 화면·호출·출력"), and a word
// inside a hyphenated name (a lane key such as cytoplasm-pm-dashboard) does not count.
const UI_WORD = /(?<![\w-])(?:UI|UX|dashboard|front-?end|web ?page)(?![\w-])|대시보드|프론트엔드|디자인|웹 ?페이지|화면(?!·호출)/gi;

// UI work: two UI words, one of them not 화면
export const uiHits = (text: string): string[] => {
  const hits = [...text.matchAll(UI_WORD)].map((m) => m[0]);
  return hits.length < 2 || hits.every((h) => h === "화면") ? [] : hits;
};

export type ScopeContext = {
  readonly ui: boolean;
  // ui came from the brief's words, not from --ui
  readonly uiFromText: readonly string[];
  readonly kinds: Readonly<Record<string, readonly string[]>>;
  readonly repo: string;
  readonly text: string;
};

// The repo a lane works in: the name of its origin remote, else the directory's name.
export const repoName = (remote: string, cwd: string): string => basename(remote.trim().replace(/\.git$/, "")) || basename(cwd);

export const scopeContext = (brief: string, ledger: Ledger, opts: { readonly ui?: boolean; readonly repo: string }): ScopeContext => {
  const text = scopeText(brief, ledger);
  const kinds: Record<string, string[]> = {};
  for (const [k, re] of Object.entries(ledger.kinds)) {
    const hits = [...text.matchAll(new RegExp(re, "gi"))].map((m) => m[0]);
    if (hits.length >= ledger.minHits) kinds[k] = hits;
  }
  const fromText = opts.ui ? [] : uiHits(text);
  return { ui: Boolean(opts.ui) || fromText.length > 0, uiFromText: fromText, kinds, repo: opts.repo, text };
};

// Why a directive is in scope, or undefined when it is not.
export const appliesWhy = (e: Directive, ctx: ScopeContext): string | undefined => {
  const s = e.scope;
  if (s.all) return "all lanes";
  if (s.ui && ctx.ui) return ctx.uiFromText.length ? `UI work (${[...new Set(ctx.uiFromText)].slice(0, 3).join(", ")})` : "--ui";
  for (const k of s.kinds ?? []) if (ctx.kinds[k]) return `${k} work (${[...new Set(ctx.kinds[k])].slice(0, 3).join(", ")})`;
  if (s.repos?.includes(ctx.repo)) return `repo ${ctx.repo}`;
  for (const re of s.keywords ?? []) {
    const m = new RegExp(re, "i").exec(ctx.text);
    if (m) return `keyword ${m[0]}`;
  }
  return undefined;
};

// --- the small model that reads a brief at launch (owner Q482): every-lane entries, blocks and require entries stay fixed ---

export type DirectivePick = { readonly model: string; readonly picked: readonly { readonly id: string; readonly why: string }[]; readonly runs?: { readonly asked: number; readonly answered: number }; readonly evaluated?: readonly string[] };

// The model chooses differently between runs (agreement 0.51), so launch asks it this many times at once and takes all it named.
export const PICK_RUNS = 3;
export const mergePicks = (lists: readonly DirectivePick["picked"][]): DirectivePick["picked"] => {
  const out = new Map<string, DirectivePick["picked"][number]>();
  for (const list of lists) for (const p of list) if (!out.has(p.id)) out.set(p.id, p);
  return [...out.values()];
};

// A repo's own entries come by the repo, not by the model: on a replay of 20 briefs models left them out most (fork-is-source).
const repoEntry = (e: Directive, ctx: Pick<ScopeContext, "repo">): boolean => Boolean(e.scope.repos?.includes(ctx.repo));
export const pickCandidates = (ledger: Pick<Ledger, "entries">, ctx: Pick<ScopeContext, "repo">): Directive[] =>
  ledger.entries.filter((e) => e.mode === "inject" && !e.block && !e.scope.all && !repoEntry(e, ctx));

export const PICK_SYSTEM = "레인 브리프를 읽고 소유자의 상시 지침 중 이 일에 걸리는 것을 고른다. 걸릴 수 있으면 넣는다: 빠지는 쪽이 더 나쁘다. JSON만 답한다.";
export const pickPrompt = (brief: string, candidates: readonly Directive[]): string => {
  const list = candidates.map((e) => `- ${e.id}: ${e.by === "owner" && e.words ? (e.prompt ?? e.words) : (e.rule ?? "")}`).join("\n");
  // ulw in a prompt makes omo answer with its mode banner instead of the JSON
  const text = leadText(brief).replace(/\bulw[- ]?(?:plan|loop|explore)?\b/g, "집중");
  return `[지침 목록]\n${list}\n\n[브리프]\n${text}\n\n형식: {"picked":[{"id":"...","why":"한 줄"}]}`;
};

// The ids the reply names among the candidates; undefined when it is not that JSON or names none (the scope rules decide then).
export const parsePick = (reply: string, candidates: readonly Directive[]): DirectivePick["picked"] | undefined => {
  const at = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (at < 0 || end < at) return undefined;
  let picked: unknown;
  try {
    picked = (JSON.parse(reply.slice(at, end + 1)) as { picked?: unknown }).picked;
  } catch {
    return undefined;
  }
  if (!Array.isArray(picked)) return undefined;
  const ids = new Set(candidates.map((e) => e.id));
  const out = (picked as { id?: unknown; why?: unknown }[]).flatMap((x) => (typeof x?.id === "string" && ids.has(x.id) ? [{ id: x.id, why: typeof x.why === "string" ? x.why : "" }] : []));
  return out.length ? out : undefined;
};

// Why an entry is in a lane's brief when the model chose for it: what stays fixed by its rule, the repo's own, or the pick.
export const appliesUnder = (e: Directive, ctx: ScopeContext, pick?: DirectivePick): string | undefined => {
  if (!pick || e.mode !== "inject" || e.block || e.scope.all) return appliesWhy(e, ctx);
  if (repoEntry(e, ctx)) return `repo ${ctx.repo}`;
  // an entry the model never saw (it entered the ledger later) is not one it left out: its scope rule decides
  if (pick.evaluated && !pick.evaluated.includes(e.id)) return appliesWhy(e, ctx);
  const p = pick.picked.find((x) => x.id === e.id);
  return p ? `model ${pick.model}: ${p.why}` : undefined;
};

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

// The text dori launch puts in for an inject directive, and what shows it is already in a brief.
// The owner's directive goes in as his words only, byte for byte, under a one-line tag: no summary, no rule, no context. A
// lead rule goes in as the lead's rule only. An owner decision on record without his sentence says so in its tag. The
// trigger and the basis stay in the ledger and its table.
export const directiveTag = (e: Directive): string =>
  e.by === "lead" ? `[리드 규칙 ${e.id}]` : e.words ? `[형 지침 ${e.id}, ${e.date}]` : `[형 결정 ${e.id}, ${e.date}, 원문 없음: 리드 기록]`;
export const directiveText = (e: Directive): string => `${directiveTag(e)}\n${e.by === "owner" && e.words ? (e.prompt ?? e.words) : (e.rule ?? "")}`;
export const hasDirective = (brief: string, e: Directive): boolean => {
  const b = squash(brief);
  const own = e.by === "owner" && e.words ? e.words : (e.rule ?? "");
  // [지침 <id>]: the tag of briefs launched before #72
  return b.includes(squash(directiveTag(e))) || b.includes(`[지침 ${e.id}]`) || (Boolean(own) && b.includes(squash(own)));
};
// The pointer that goes into a brief for an entry with via (undefined when it has none).
export const pointerOf = (e: Directive, ledger: Pick<Ledger, "entries">): Directive | undefined => {
  if (!e.via) return undefined;
  const p = ledger.entries.find((x) => x.id === e.via);
  return p;
};
// In the brief as its own text, or through its pointer; a pointer is also in a brief that already has every entry
// naming it as their own texts (a lane launched before the pointer), so it is not sent on top of them.
export const coveredBy = (brief: string, e: Directive, ledger: Pick<Ledger, "entries">): boolean => {
  const p = pointerOf(e, ledger);
  if (hasDirective(brief, e) || (p !== undefined && hasDirective(brief, p))) return true;
  const named = ledger.entries.filter((x) => x.via === e.id);
  return named.length > 0 && named.every((x) => hasDirective(brief, x));
};
export const requireMissing = (brief: string, e: Directive): string[] => (e.require ?? []).filter((re) => !new RegExp(re, "m").test(leadText(brief)));

// --- the owner's message and a thread the lead opens: the work the lead does without a lane brief ---

// How many directives an owner message carries in the inbox row (dori inbound discord): the lead reads them in every
// monitor event, so only the ones his message is about, never more than this.
export const HINT_LIMIT = 5;

// The directives a text (an owner message, a thread's title and first message) is about, as a brief of that text would
// get them, except that one hit of a kind's words counts (a message is short; a brief needs minHits). all: the entries for
// every lane too (a thread the lead opens gets what a lane's brief gets); without it only those its words call: a keyword,
// a kind of work, UI work. Lead rules count (the lead is the one reading them); a require entry or a built-in block is a
// brief's, not a text to read. An entry with a pointer comes as its pointer, once. Order: the entries the text calls before
// the every-lane ones; within each, the host's own entries first, then a keyword before a kind (the narrower match), then
// the ledger's order.
export const textDirectives = (text: string, ledger: Ledger, opts: { readonly all?: boolean } = {}): { readonly e: Directive; readonly why: string }[] => {
  const ctx = scopeContext(text, { ...ledger, minHits: 1 }, { repo: "" });
  const out: { e: Directive; why: string; rank: number }[] = [];
  for (const [i, e] of ledger.entries.entries()) {
    if (e.mode === "require" || e.block || ((e.scope.all || e.scope.briefOnly) && !opts.all)) continue;
    const why = e.scope.briefOnly ? "all lanes" : appliesWhy(e, ctx);
    if (!why) continue;
    const shown = e.mode === "inject" ? (pointerOf(e, ledger) ?? e) : e;
    if (out.some((x) => x.e.id === shown.id)) continue;
    // what the text calls before what every lane gets, however long the host's every-lane list is
    const rank = (why === "all lanes" ? 8 : 0) + (shown.layer === "local" ? 0 : 4) + (why.startsWith("keyword ") ? 0 : 1);
    out.push({ e: shown, why: shown === e ? why : `${why}, for ${e.id}`, rank: rank * 10_000 + i });
  }
  return out.sort((a, b) => a.rank - b.rank).map(({ e, why }) => ({ e, why }));
};

// What an owner message's inbox row carries (dori inbound discord): the lines of the directives it calls, at most
// HINT_LIMIT, and when the tolerant load left local lines out (or the whole local layer), one last line saying so, so the
// lead knows the host's own directives may be missing (dori thread open refuses on it instead).
export const messageLines = (text: string, ledger: Ledger): string[] => {
  const lines = textDirectives(text, ledger).slice(0, HINT_LIMIT).map(({ e }) => directiveLine(e));
  const skipped = ledger.skipped ?? [];
  return skipped.length ? [...lines, `[장부 경고] 이 도리 로컬 장부에서 ${skipped.length}줄을 못 읽어 뺐다: ${skipped[0]?.slice(0, 200)}. dori directives check로 고친다.`] : lines;
};

// One line per directive: its tag and the text a brief gets (his prompt, or the lead's rule), on one line.
export const directiveLine = (e: Directive): string => squashLine(directiveText(e));
const squashLine = (s: string): string => s.replace(/\s+/g, " ").trim();

export type Waiver = { readonly id: string; readonly reason: string; readonly at: string };

export type DirectivePlan = {
  // inject directives to add as text (the built-in blocks are placed by launch itself)
  readonly add: readonly { readonly e: Directive; readonly why: string }[];
  // built-in blocks in scope (eight-steps always, ui-steps for UI work)
  readonly blocks: readonly DirectiveBlock[];
  readonly missing: readonly { readonly e: Directive; readonly patterns: readonly string[]; readonly why: string }[];
  readonly waived: readonly { readonly e: Directive; readonly reason: string }[];
  readonly applied: readonly string[];
};

// What the ledger asks of this brief: inject directives in scope it lacks, require directives it does not meet; waived ids
// are left out (a waiver of an id not in the ledger is refused: a typo would let a directive through).
export const planDirectives = (brief: string, ledger: Ledger, ctx: ScopeContext, waive: Readonly<Record<string, string>> = {}, pick?: DirectivePick): DirectivePlan => {
  const ids = new Set(ledger.entries.map((e) => e.id));
  const unknown = Object.keys(waive).filter((id) => !ids.has(id));
  if (unknown.length) throw new DirectiveError(`--waive ${unknown.join(", ")}: no such directive in the ledger (dori directives lists them)`);
  const add: { e: Directive; why: string }[] = [];
  const blocks: DirectiveBlock[] = [];
  const missing: { e: Directive; patterns: string[]; why: string }[] = [];
  const waived: { e: Directive; reason: string }[] = [];
  const applied: string[] = [];
  for (const e of ledger.entries) {
    if (e.mode === "lead") continue;
    const why = appliesUnder(e, ctx, pick);
    if (!why) continue;
    const reason = waive[e.id];
    if (reason !== undefined) {
      waived.push({ e, reason });
      continue;
    }
    applied.push(e.id);
    // an entry with a pointer goes in as the pointer, once for all entries that name it
    const shown = e.mode === "inject" && !e.block ? (pointerOf(e, ledger) ?? e) : e;
    if (e.mode === "inject" && e.block) blocks.push(e.block);
    else if (e.mode === "inject" && !coveredBy(brief, e, ledger) && !add.some((a) => a.e.id === shown.id)) add.push({ e: shown, why: shown === e ? why : `${why}, for ${e.id}` });
    else if (e.mode === "require") {
      const patterns = requireMissing(brief, e);
      if (patterns.length) missing.push({ e, patterns, why });
    }
  }
  return { add, blocks, missing, waived, applied };
};

// The lead's text with the added directives at its end, under one heading (added to the heading already there on a relaunch).
export const withDirectives = (lead: string, add: DirectivePlan["add"]): string => {
  if (!add.length) return lead;
  const body = add.map(({ e }) => directiveText(e)).join("\n\n");
  return headingAt(lead, DIRECTIVES_HEADING) >= 0 ? `${lead}\n\n${body}` : `${lead}\n\n${DIRECTIVES_HEADING}\n\n${body}`;
};

export const addedLine = (key: string, plan: DirectivePlan): string | undefined =>
  plan.add.length ? `LAUNCH_DIRECTIVE_ADDED ${key}: ${plan.add.map(({ e, why }) => `${e.id} (${why})`).join(", ")} from the directive ledger, as written there` : undefined;
export const missingLines = (key: string, plan: DirectivePlan): string[] =>
  plan.missing.map(({ e, patterns, why }) => `LAUNCH_DIRECTIVE_MISSING ${key} ${e.id}: ${e.name} applies (${why}) and the brief does not have it (${patterns.map((p) => `/${p}/`).join(", ")}); write it in, or launch with --waive ${e.id} "<reason>"`);
export const waivedLines = (key: string, plan: DirectivePlan): string[] => plan.waived.map(({ e, reason }) => `LAUNCH_DIRECTIVE_WAIVED ${key} ${e.id}: ${e.name} left out on the lead's word: ${reason}`);

// --- after the launch: intent-check and the daily audit ---

export type Gap = { readonly lane: string; readonly id: string; readonly line: string };

// A launched lane's brief against the ledger now: inject directives in scope it lacks, require directives it fails,
// minus the waivers on record. The built-in blocks count when their first line is in the brief.
export const briefGaps = (lane: Pick<Lane, "key" | "directives" | "ui">, brief: string, ledger: Ledger, repo: string, blockLines: Readonly<Record<DirectiveBlock, string>>): Gap[] => {
  const ctx = scopeContext(brief, ledger, { ui: lane.ui, repo });
  const waived = new Set((lane.directives?.waived ?? []).map((w) => w.id));
  const out: Gap[] = [];
  for (const e of ledger.entries) {
    if (e.mode === "lead" || waived.has(e.id)) continue;
    const why = appliesUnder(e, ctx, lane.directives?.pick);
    if (!why) continue;
    const lacks = e.block ? !squash(brief).includes(squash(blockLines[e.block])) : e.mode === "inject" ? !coveredBy(brief, e, ledger) : requireMissing(brief, e).length > 0;
    // an entry with a pointer is a gap of its pointer: that is the text to send
    const shown = e.mode === "inject" && !e.block ? (pointerOf(e, ledger) ?? e) : e;
    if (lacks && !out.some((g) => g.id === shown.id)) out.push({ lane: lane.key, id: shown.id, line: `DIRECTIVE_GAP ${lane.key} ${shown.id}: ${shown.name} applies (${shown === e ? why : `${why}, for ${e.id}`}) and is not in the brief` });
  }
  return out;
};

export const leadGaps = (lane: Pick<Lane, "key" | "thread" | "directives" | "noThread">, ledger: Ledger): Gap[] => {
  const waived = new Set((lane.directives?.waived ?? []).map((w) => w.id));
  return ledger.entries
    .filter((e) => e.mode === "lead" && !waived.has(e.id) && e.check === "thread" && (!lane.thread || lane.thread === "none") && !lane.noThread)
    .map((e) => ({ lane: lane.key, id: e.id, line: `DIRECTIVE_LEAD ${lane.key} ${e.id}: ${e.name}: the lane was launched without a work thread (--thread)` }));
};

type InboxRow = { ts?: string; id?: string; kind?: string; channel_id?: string; guild_id?: string; author_id?: string; content?: string; transcript?: string | null };

// The owner's messages of the window that read like a standing directive and that no ledger entry cites as its source
// (by message id) and the lead has not marked reviewed.
export const unledgered = (inbox: string, ledger: Ledger, owner: string, since: string, guild = ""): Gap[] => {
  if (!ledger.standing || !owner || !ledger.entries.some((e) => e.mode === "lead" && e.check === "ledger")) return [];
  const standing = new RegExp(ledger.standing, "i");
  const cited = ledger.entries.map((e) => e.source).join("\n");
  const out: Gap[] = [];
  for (const line of inbox.split("\n")) {
    if (!line.trim()) continue;
    let e: InboxRow;
    try {
      e = JSON.parse(line) as InboxRow;
    } catch {
      continue;
    }
    const ms = Date.parse((e.ts ?? "").replace(/(\.\d{3})\d+/, "$1"));
    if (e.kind || e.author_id !== owner || !e.id || Number.isNaN(ms) || new Date(ms).toISOString() < since) continue;
    const text = (e.transcript || e.content || "").trim();
    if (!standing.test(text) || cited.includes(e.id) || ledger.reviewed.includes(e.id)) continue;
    const g = e.guild_id || guild;
    const ref = g && e.channel_id ? `https://discord.com/channels/${g}/${e.channel_id}/${e.id}` : `${e.channel_id ?? "?"}/${e.id}`;
    out.push({ lane: "-", id: e.id, line: `DIRECTIVE_UNLEDGERED ${ref} "${text.replace(/\s+/g, " ").slice(0, 160)}": reads like a standing directive and no ledger entry cites it; add it to the ledger (owner's words, link) or list its id under reviewed` });
  }
  return out;
};

// The owner's standing directive in two places: a line of the lead's memory (system/ and reference/, where his directives
// were kept before the ledger) that holds an owner message a ledger entry cites. The ledger is the one place for them, so
// such a line is only a pointer: it names the entry ("장부:<id>") and does not quote his words again.
export const POINTER = "장부:";
export const duplicated = (files: readonly { readonly path: string; readonly text: string }[], ledger: Ledger): Gap[] => {
  // the message ids a source cites; the guild and channel ids of its links are not messages (a line naming a channel is
  // not his directive)
  const places = new Set([...ledger.entries.map((e) => e.source).join("\n").matchAll(/channels\/(\d{15,})\/(\d{15,})\//g)].flatMap((m) => [m[1], m[2]]));
  const byMessage = new Map<string, Directive[]>();
  for (const e of ledger.entries) {
    for (const id of new Set(e.source.match(/\d{15,}/g) ?? [])) if (!places.has(id)) byMessage.set(id, [...(byMessage.get(id) ?? []), e]);
  }
  const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
  const quotes = (line: string, e: Directive): boolean => {
    // a host line read tolerantly can come without words
    const w = squash(e.words ?? "");
    return w.length >= 10 && squash(line).includes(w.slice(0, 30));
  };
  const out: Gap[] = [];
  for (const f of files) {
    f.text.split("\n").forEach((line, i) => {
      const entries = [...new Set((line.match(/\d{15,}/g) ?? []).flatMap((id) => byMessage.get(id) ?? []))];
      if (!entries.length) return;
      const named = entries.filter((e) => line.includes(`${POINTER}${e.id}`));
      const bad = named.length ? named.filter((e) => quotes(line, e)) : entries;
      for (const e of bad) {
        const why = named.length ? `points at ${POINTER}${e.id} and still quotes his words` : `holds his message that ledger entry ${e.id} cites`;
        out.push({ lane: "-", id: e.id, line: `DIRECTIVE_DUPLICATE ${f.path}:${i + 1} ${e.id}: the memory line ${why}; the ledger is the one place for it: make the line a pointer "${POINTER}${e.id}" without his words` });
      }
    });
  }
  return out;
};

// His words next to the prompt a brief gets for them, one row per owner entry with words: for the owner to read.
export const promptTable = (ledger: Ledger): string => {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
  return [
    "| id | 형 원문 | 지침문 |",
    "|---|---|---|",
    ...ledger.entries.filter((e) => e.by === "owner" && e.words).map((e) => `| ${e.id} | ${cell(e.words)} | ${cell(e.prompt ?? "(없음)")} |`),
  ].join("\n");
};

// The ledger as one table for the owner.
export const ledgerTable = (ledger: Ledger): string => {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
  const scope = (s: DirectiveScope) => [s.all ? "모든 lane" : "", s.ui ? "UI" : "", ...(s.kinds ?? []), ...(s.repos ?? []).map((r) => `저장소 ${r}`), ...(s.keywords ?? []).map((k) => `낱말 /${k}/`), s.briefOnly ? "브리프만(리드 쪽은 모든 lane처럼)" : ""].filter(Boolean).join(", ");
  const how = (e: Directive) => (e.mode === "inject" ? (e.block ? `주입(${e.block})` : e.via ? `주입(포인터 ${e.via}로)` : "주입") : e.mode === "require" ? "브리프 확인(없으면 멈춤)" : e.check === "none" ? "리드 행동(기계 확인 없음, intent-check가 읽음)" : `리드 행동 확인(${e.check})`);
  const words = (e: Directive) => (e.words ? `"${e.words}"` : e.block ? `(블록 원문: ${e.block === "eight-steps" ? "references/sessions.md 1. 조사 … 8. 보고" : "references/ui-work.md [UI 지침] 1)…7)"})` : e.by === "lead" ? "-" : "(원문 없음)");
  return [
    "| id | 이름 | 누가 | 판단 근거 | 형 원문(지침 문장) | 지침문(브리프에 들어감) | 계기가 된 형 말 | 규칙 | 날짜 | 출처 | 적용 범위 | 강제 방식 | 층 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...ledger.entries.map((e) => `| ${e.id} | ${cell(e.name)} | ${e.by === "lead" ? "리드 규칙" : "형 지침"} | ${cell(e.basis ?? "")} | ${cell(words(e))} | ${cell(e.prompt ?? "")} | ${cell(e.trigger ? `"${e.trigger}"` : "")} | ${cell(e.rule ?? "")} | ${e.date} | ${cell(e.source)} | ${cell(scope(e.scope))} | ${how(e)} | ${e.layer === "common" ? "포크" : "로컬"} |`),
  ].join("\n");
};

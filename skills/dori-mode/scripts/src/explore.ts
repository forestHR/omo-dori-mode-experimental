import { mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { canonical, mentions } from "./auto-signals.ts";
import { type DoriConfig, type Explore, expandHome, fill, type Stuck } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { tagsOf } from "./lane-signals.ts";
import { sendVerified } from "./panes.ts";
import { type FixAttempt, type Lane, statusOf, type StuckMark } from "./registry.ts";
import { sessionStart } from "./rollover.ts";
import { iso } from "./run.ts";
import { fixCount, normFix } from "./same-fix.ts";
import { sessionDirFor } from "./session-id.ts";
import { watchLog } from "./watch-log.ts";

// The hypothesis tree: what one area of work (a repo, or a topic tag) tried, which hypotheses are open, which a test
// falsified or supported, which directions nobody tried yet, and which external searches are due. One JSON file per area
// under <stateDir>/trees, fed by dori fix-attempt and dori fork-explore, edited with dori tree, and attached in compact
// form to every brief dori launch writes for that area.

export type NodeKind = "hypothesis" | "direction" | "tried" | "finding" | "research";
export type NodeStatus = "open" | "falsified" | "supported" | "closed";
export type TreeNode = {
  readonly id: string;
  readonly kind: NodeKind;
  readonly status: NodeStatus;
  readonly text: string;
  readonly test?: string;
  readonly result?: string;
  readonly metric?: string;
  readonly lane?: string;
  readonly at: string;
  readonly updatedAt: string;
  readonly source: string;
};
export type Tree = { readonly area: string; readonly nodes: readonly TreeNode[] };
export type TreeArea = { readonly cwd?: string; readonly tag?: string };

export const NODE_KINDS: readonly NodeKind[] = ["hypothesis", "direction", "tried", "finding", "research"];
const PREFIX: Record<NodeKind, string> = { hypothesis: "H", direction: "D", tried: "T", finding: "F", research: "R" };

export class TreeError extends Error {}

export const areaName = (a: TreeArea): string => (a.cwd ? `cwd ${a.cwd}` : `tag ${a.tag ?? "?"}`);

// A lane's tree is its repo's when it works outside the default cwd, else its first tag's (the key's first word).
export const laneArea = (lane: Pick<Lane, "key" | "tags" | "cwd">, config: Pick<DoriConfig, "defaultCwd">): TreeArea => {
  const cwd = lane.cwd ? resolve(expandHome(lane.cwd)) : "";
  return cwd && cwd !== resolve(config.defaultCwd) ? { cwd } : { tag: tagsOf(lane)[0] ?? lane.key };
};

export const treeFile = (stateDir: string, a: TreeArea): string =>
  join(stateDir, "trees", a.cwd ? `cwd${resolve(a.cwd).replace(/[^A-Za-z0-9._]+/g, "-")}.json` : `tag-${(a.tag ?? "").replace(/[^A-Za-z0-9._-]+/g, "-")}.json`);

export const loadTree = async (stateDir: string, a: TreeArea): Promise<Tree> => {
  const f = Bun.file(treeFile(stateDir, a));
  return (await f.exists()) ? ((await f.json()) as Tree) : { area: areaName(a), nodes: [] };
};

// temp file + rename, like the registry, so a reader never sees half a tree
export const saveTree = async (stateDir: string, a: TreeArea, tree: Tree): Promise<void> => {
  const path = treeFile(stateDir, a);
  mkdirSync(join(stateDir, "trees"), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await Bun.write(tmp, JSON.stringify(tree, null, 1));
  renameSync(tmp, path);
};

export type NodeInput = { readonly kind: NodeKind; readonly text: string; readonly test?: string; readonly metric?: string; readonly lane?: string; readonly source: string; readonly status?: NodeStatus; readonly result?: string };

// Adds a node, or returns the same node when one of that kind already says the same thing (a test it lacked is filled in).
export const addNode = (tree: Tree, input: NodeInput, at: string): { readonly tree: Tree; readonly node: TreeNode; readonly added: boolean } => {
  const text = input.text.replace(/\s+/g, " ").trim();
  if (!text) throw new TreeError("a tree entry needs text");
  const same = input.kind !== "tried" ? tree.nodes.find((n) => n.kind === input.kind && normFix(n.text) === normFix(text)) : undefined;
  if (same) {
    const node: TreeNode = { ...same, ...(input.test && !same.test ? { test: input.test } : {}), ...(input.metric && !same.metric ? { metric: input.metric } : {}), updatedAt: at };
    return { tree: { ...tree, nodes: tree.nodes.map((n) => (n.id === same.id ? node : n)) }, node, added: false };
  }
  const n = tree.nodes.filter((x) => x.kind === input.kind).length + 1;
  const node: TreeNode = {
    id: `${PREFIX[input.kind]}${n}`,
    kind: input.kind,
    status: input.status ?? "open",
    text,
    ...(input.test ? { test: input.test.trim() } : {}),
    ...(input.result ? { result: input.result.trim() } : {}),
    ...(input.metric ? { metric: input.metric } : {}),
    ...(input.lane ? { lane: input.lane } : {}),
    at,
    updatedAt: at,
    source: input.source,
  };
  return { tree: { ...tree, nodes: [...tree.nodes, node] }, node, added: true };
};

export const setStatus = (tree: Tree, id: string, status: NodeStatus, result: string | undefined, at: string): { readonly tree: Tree; readonly node: TreeNode } => {
  const found = tree.nodes.find((n) => n.id.toLowerCase() === id.toLowerCase());
  if (!found) throw new TreeError(`no entry ${id} in the tree of ${tree.area}`);
  const node: TreeNode = { ...found, status, ...(result?.trim() ? { result: result.trim() } : {}), updatedAt: at };
  return { tree: { ...tree, nodes: tree.nodes.map((n) => (n.id === found.id ? node : n)) }, node };
};

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const describe = (n: TreeNode, width: number): string =>
  `${n.id} ${clip(n.text, width)}${n.test ? ` (test: ${clip(n.test, width)})` : ""}${n.result ? ` -> ${clip(n.result, width)}` : ""}${n.metric ? ` [${clip(n.metric, 40)}]` : ""}${n.lane ? ` {${n.lane}}` : ""}`;

const groups = (tree: Tree): [string, TreeNode[]][] => {
  const of = (kind: NodeKind, status?: NodeStatus) => tree.nodes.filter((n) => n.kind === kind && (status === undefined || n.status === status));
  return [
    ["Open hypotheses", of("hypothesis", "open")],
    ["Supported", of("hypothesis", "supported")],
    ["Falsified (do not retry)", of("hypothesis", "falsified")],
    ["Untried directions", of("direction", "open")],
    ["Research due", of("research", "open")],
    ["Findings", of("finding").filter((n) => n.status !== "closed")],
    ["Tried (newest first)", of("tried").slice().reverse()],
  ];
};

// dori tree: every entry, grouped, with closed ones listed last.
export const formatTree = (tree: Tree): string => {
  if (!tree.nodes.length) return `TREE ${tree.area}: empty. Add an entry with dori tree add --kind hypothesis --text "..." --test "...".`;
  const out = [`TREE ${tree.area}: ${tree.nodes.length} entries`];
  for (const [label, nodes] of groups(tree)) if (nodes.length) out.push(`${label}:`, ...nodes.map((n) => `  ${describe(n, 160)}`));
  const closed = tree.nodes.filter((n) => n.status === "closed" && n.kind !== "finding");
  if (closed.length) out.push("Closed:", ...closed.map((n) => `  ${describe(n, 160)}`));
  return out.join("\n");
};

// The compact form for a new brief: a few lines per group.
export const treeSection = (trees: readonly Tree[], limit: number, hint: string): string | undefined => {
  const shown = trees.filter((t) => t.nodes.some((n) => n.status !== "closed"));
  if (!shown.length) return undefined;
  const lines = [
    "",
    "## Hypothesis tree (written by dori launch)",
    `What this area already knows. Do not retry a falsified hypothesis; test an open one with its cheap experiment before patching; when stuck, add competing hypotheses before the next fix. ${hint} shows the whole tree; dori tree add|falsify|support|close edits it.`,
  ];
  for (const t of shown) {
    lines.push(`- ${t.area}:`);
    for (const [label, nodes] of groups(t)) {
      if (!nodes.length) continue;
      lines.push(`  - ${label}: ${nodes.slice(0, limit).map((n) => describe(n, 110)).join("; ")}${nodes.length > limit ? `; +${nodes.length - limit} more` : ""}`);
    }
  }
  return lines.join("\n");
};

export const updateTree = async (stateDir: string, a: TreeArea, change: (t: Tree) => Tree): Promise<Tree> => {
  const next = change(await loadTree(stateDir, a));
  await saveTree(stateDir, a, next);
  return next;
};

// ---- the stuck ladder: one count per metric, one rung, one STUCK line ----

// Failed attempts on one metric, whatever the hypothesis, since the last attempt marked improved. A fix the lead asked for and
// the lane then reported is one attempt, as in fixCount.
export const metricAttempts = (fixes: readonly FixAttempt[], metric: string): number => attemptTimes(fixes, metric).length;

// When each of those attempts was made (the lead's ask for one it asked and the lane reported), oldest first.
export const attemptTimes = (fixes: readonly FixAttempt[], metric: string): string[] => {
  let times: string[] = [];
  let askedByLead = false;
  for (const f of fixes) {
    if (f.metric !== metric) continue;
    if (f.improved) {
      times = [f.at];
      askedByLead = f.via === "lead";
    } else if (f.via === "report" && askedByLead) askedByLead = false;
    else {
      times.push(f.at);
      askedByLead = f.via === "lead";
    }
  }
  return times;
};

export type GateInput = { readonly hypotheses: readonly string[]; readonly tests: readonly string[]; readonly override?: string };
export type Gate = { readonly verdict: "ok" | "branch" | "override" | "required"; readonly attempt: number; readonly problem?: string };

// Rung 2 as dori fix-attempt enforces it: from stuck.hypothesesAt failed attempts on one metric (the tagged count with this
// attempt, or the inferred count, whichever is larger) a fix needs minHypotheses competing hypotheses, each with a cheap
// discriminating test, or an explicit override with a reason.
export const gateFix = (lane: Lane, next: FixAttempt, input: GateInput, config: Pick<DoriConfig, "explore" | "stuck" | "autoSignals">): Gate => {
  // the stuck ladder's own count with this attempt added (aliases, session, last PASS, --improved), so gate and ladder agree
  const attempt = next.improved ? 1 : stuckView({ ...lane, fixes: [...(lane.fixes ?? []), next] }, next.metric, config).n;
  const cfg = { ...config.explore, ...config.stuck };
  if (attempt < cfg.hypothesesAt) return { verdict: "ok", attempt };
  const hyps = input.hypotheses.map((h) => h.trim()).filter(Boolean);
  const tests = input.tests.map((t) => t.trim()).filter(Boolean);
  const distinct = new Set(hyps.map(normFix)).size;
  const problems = [
    ...(distinct < cfg.minHypotheses ? [`${distinct} competing hypothes${distinct === 1 ? "is" : "es"} given, at least ${cfg.minHypotheses} needed (--hypotheses, once per hypothesis)`] : []),
    ...(tests.length !== hyps.length ? [`${tests.length} --test for ${hyps.length} --hypotheses: give one cheap discriminating experiment per hypothesis, in the same order`] : []),
  ];
  if (!problems.length) return { verdict: "branch", attempt };
  if (input.override?.trim()) return { verdict: "override", attempt, problem: problems.join("; ") };
  return { verdict: "required", attempt, problem: problems.join("; ") };
};

export const requiredMessage = (key: string, metric: string, g: Gate, cfg: Pick<Explore, "minHypotheses">): string =>
  `HYPOTHESES_REQUIRED ${key} attempt ${g.attempt} on "${metric}" with no improvement: ${g.problem}. Stop patching and branch: dori fix-attempt ${key} --metric "${metric}" --hypothesis "<the one you try now>" ${Array.from({ length: cfg.minHypotheses }, (_, i) => `--hypotheses "<H${i + 1}>" --test "<cheap test for H${i + 1}>"`).join(" ")}. A fix that moved the metric: add --improved. To go on without branching: --no-hypotheses "<reason>" (logged).`;

// An accepted branch: every hypothesis and its test go into the tree as open hypotheses, and the lead's log gets one line.
export const recordBranch = async (deps: FlowDeps, lane: Lane, metric: string, input: GateInput, g: Gate): Promise<string> => {
  const at = iso(deps.clock);
  const area = laneArea(lane, deps.config);
  let ids: string[] = [];
  await updateTree(deps.config.stateDir, area, (t) => {
    let tree = t;
    ids = input.hypotheses.map((h, i) => {
      const r = addNode(tree, { kind: "hypothesis", text: h, test: input.tests[i], metric, lane: lane.key, source: `fix-attempt ${g.attempt}` }, at);
      tree = r.tree;
      return r.node.id;
    });
    return tree;
  });
  const line = `STUCK_BRANCH ${lane.key} attempt ${g.attempt} on "${metric}": ${input.hypotheses.map((h, i) => `${ids[i]} ${clip(h, 60)} (test: ${clip(input.tests[i] ?? "", 60)})`).join(" | ")}; tree ${areaName(area)}`;
  watchLog(deps.config.watchLog, deps.clock, { source: "fix-attempt", line });
  return line;
};

export const recordOverride = (deps: FlowDeps, key: string, metric: string, g: Gate, reason: string): string => {
  const line = `HYPOTHESES_OVERRIDE ${key} attempt ${g.attempt} on "${metric}" without competing hypotheses (${g.problem}): ${reason}`;
  watchLog(deps.config.watchLog, deps.clock, { source: "fix-attempt", line });
  return line;
};

export const recordRefusal = (deps: FlowDeps, message: string): void => watchLog(deps.config.watchLog, deps.clock, { source: "fix-attempt", line: message });

// One metric's stuck count: tagged failed attempts (fix tags and dori fix-attempt, in the lane's current session, since the
// last --improved and since the last PASS the reports showed) and the inferred cycles (untagged reports, commits, tree;
// auto-signals), counted under one name (autoSignals.aliases). fixated: one hypothesis tried fixatedAfter times.
// sameFix: one hypothesis tried fixatedAfter times; fixated: that, after the lane branched (two or more hypotheses tried)
// taggedAt: when each tagged attempt was made
export type StuckView = { readonly metric: string; readonly tagged: number; readonly inferred: number; readonly n: number; readonly hypotheses: number; readonly sameFix: boolean; readonly fixated: boolean; readonly taggedAt: readonly string[] };

export const stuckView = (lane: Lane, metric: string, config: Pick<DoriConfig, "stuck" | "autoSignals">): StuckView => {
  const aliases = config.autoSignals.aliases;
  const key = canonical(metric, aliases);
  const passed = lane.inferred?.passedAt?.[key] ?? "";
  const since = sessionStart(lane);
  const fixes = (lane.fixes ?? []).filter((f) => f.at >= since && f.at > passed && canonical(f.metric, aliases) === key).map((f) => ({ ...f, metric: key }));
  const restart = fixes.findLastIndex((f) => f.improved);
  const current = restart >= 0 ? fixes.slice(restart) : fixes;
  const hyps = [...new Set(current.map((f) => f.hypothesis))];
  const taggedAt = attemptTimes(fixes, key);
  const tagged = taggedAt.length;
  // an --improved attempt also starts the inferred half again: only cycles counted after it (baseline) are stuck ones
  const inferred = Math.max(0, (lane.inferred?.counts[key] ?? 0) - (lane.inferred?.baseline?.[key] ?? 0));
  const sameFix = hyps.some((h) => fixCount(current, key, h) >= config.stuck.fixatedAfter);
  return { metric: key, tagged, inferred, n: Math.max(tagged, inferred), hypotheses: hyps.length, sameFix, fixated: sameFix && hyps.length >= 2, taggedAt };
};

// Rung 3 already done: the ulw research and the dori challenge a lane ran on one symptom after `after` (the repeat that made
// rung 3 due), whoever asked for them. Research: a read of the ulw-research SKILL.md in the lane's session log, or a research
// session folder <cwd>/.omo/ulw-research/<YYYYMMDD-HHMMSS> (the skill names it by local time) started after it. Challenge:
// a dori challenge on record after it on the symptom: the first whose plan names the metric or one of its aliases, or, when a
// research folder's brief.md names it, the first at or after that folder. at: when both were done (the later of the two).
export type ResearchDone = { readonly at: string; readonly research: string; readonly challenge: string };

const RESEARCH_DIR = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)$/;
const textOf = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return ""; // a plan or brief that is gone names nothing
  }
};
const namesIn = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return []; // no research folder, no session folder
  }
};

// the first real read of the ulw-research SKILL.md (skillRead) at or after `since` in a session folder
const firstSkillRead = (dir: string, since: number): { readonly at: number; readonly file: string } | undefined => {
  let first: { at: number; file: string } | undefined;
  for (const n of namesIn(dir).filter((x) => x.endsWith(".jsonl"))) {
    const file = join(dir, n);
    if ((statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0) < since) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes(RESEARCH_SKILL)) continue;
      let e: LogEntry;
      try {
        e = JSON.parse(line) as LogEntry;
      } catch {
        continue; // the last line while omo is still writing it
      }
      const at = Date.parse(e.timestamp ?? "");
      if (!(at >= since) || (first && at >= first.at) || e.message?.role !== "assistant") continue;
      if (blocks(e.message.content).some((b) => b.type === "toolCall" && skillRead(b.name, b.arguments))) first = { at, file: n };
    }
  }
  return first;
};

export const researchDone = (config: Pick<DoriConfig, "sessionsDir" | "defaultCwd" | "autoSignals">, lane: Lane, metric: string, after: string): ResearchDone | undefined => {
  const since = Date.parse(after);
  if (!Number.isFinite(since)) return undefined;
  const cwd = expandHome(lane.cwd ?? config.defaultCwd);
  const root = join(cwd, ".omo", "ulw-research");
  const folders = namesIn(root).flatMap((n) => {
    const m = RESEARCH_DIR.exec(n)?.slice(1).map(Number);
    const at = m ? new Date(m[0] ?? 0, (m[1] ?? 1) - 1, m[2], m[3], m[4], m[5]).getTime() : Number.NaN;
    return at >= since ? [{ at, name: n }] : [];
  });
  const read = firstSkillRead(sessionDirFor(config.sessionsDir, cwd), since);
  const challenges = (lane.challenges ?? []).filter((c) => Date.parse(c.at) >= since).sort((a, b) => a.at.localeCompare(b.at));
  const researchAt = Math.min(read?.at ?? Number.POSITIVE_INFINITY, ...folders.map((f) => f.at));
  if (!Number.isFinite(researchAt)) return undefined;
  const named = (text: string): boolean => mentions(text, metric, config.autoSignals.aliases);
  const onSymptom = folders.filter((f) => named(textOf(join(root, f.name, "brief.md")))).sort((a, b) => a.at - b.at)[0];
  // an earlier challenge of another plan is not this symptom's: its time would credit attempts made before the real one
  const challenge = challenges.find((c) => named(textOf(c.plan))) ?? (onSymptom ? challenges.find((c) => Date.parse(c.at) >= onSymptom.at) : undefined);
  if (!challenge) return undefined;
  const folder = folders.sort((a, b) => a.at - b.at)[0];
  const research = read && read.at <= (folder?.at ?? Number.POSITIVE_INFINITY) ? `ulw research (${RESEARCH_SKILL} read ${new Date(read.at).toISOString()}, ${read.file})` : `ulw research (${join(root, folder?.name ?? "")})`;
  return { at: new Date(Math.max(researchAt, Date.parse(challenge.at))).toISOString(), research, challenge: `dori challenge (${challenge.model} ${challenge.at}, plan ${challenge.plan})` };
};

// The rung a count reaches: 4 when one hypothesis is fixated or an attempt failed after rung 3, 3 from researchAt, 2 from
// hypothesesAt, 1 for any failed attempt. prev is the rung this metric already reached in this session.
export const rungOf = (v: StuckView, prev: number, cfg: Stuck): number =>
  v.fixated || (v.n > cfg.researchAt && prev >= 3) ? 4 : v.n >= cfg.researchAt ? 3 : v.n >= cfg.hypothesesAt ? 2 : v.n >= 1 ? 1 : 0;

export const CONTEXT = "@context";

// the rungs of the lane's current session (a handover starts a new one)
const rungsNow = (lane: Lane): Record<string, StuckMark> => Object.fromEntries(Object.entries(lane.stuck ?? {}).filter(([, m]) => m.pane === lane.pane));

// The highest rung the lane reached in its current session, for the rollover log and dori rollover-propose.
export const stuckTop = (lane: Lane): { readonly metric: string; readonly n: number; readonly rung: number } | undefined =>
  Object.entries(rungsNow(lane)).map(([metric, m]) => ({ metric, n: m.n, rung: m.rung })).sort((x, y) => y.rung - x.rung || y.n - x.n)[0];

const counts = (v: StuckView): string => `tagged ${v.tagged}, inferred ${v.inferred}, hypotheses ${v.hypotheses}${v.fixated ? ", fixated" : ""}${v.inferred > v.tagged ? ", inferred only" : ""}`;

// the signal names this one line replaces, kept at its end for one release so old monitors and stats still match
// (a scan that jumps over a rung, the first untagged scan of a long loop, carries the skipped rungs' names too)
const oldNames = (rung: number, prev: number, v: StuckView, cfg: Stuck): string[] => [
  ...(rung >= 2 && prev < 2 ? ["HYPOTHESES_REQUIRED"] : []),
  ...(rung >= 3 && prev < 3 ? ["RESEARCH_DUE"] : []),
  ...(rung === 4 ? ["ROLLOVER_DUE"] : []),
  ...(v.sameFix ? ["SAME_FIX_3"] : []),
  ...(v.inferred >= cfg.researchAt ? ["REPEAT_SUSPECT"] : []),
];

export const stuckLine = (key: string, metric: string, rung: number | "context", detail: string, action: string, names: readonly string[]): string =>
  `STUCK ${key} ${JSON.stringify(metric)} rung ${rung} (${detail}) -> ${action}${names.length ? ` [${names.join(" ")}]` : ""}`;

const rolloverAction = (key: string, why: string): string =>
  `${why}: the cheap rungs are spent, so a new session may help; decide it (dori rollover-propose ${key} shows the note; dori handover --lane ${key} --approved-by "lead:<your reason and this signal>"; the owner is told afterwards), or re-instruct the lane`;

// After a tagged attempt or a grown inferred count: the metric's rung now. A rung above the one this metric reached in this
// session gives one STUCK line (rung 2 and up); rung 3 also types the ulw research text into the lane (research and a
// challenge of the next plan, in this session: no rollover at this rung), unless the lane is paused or already ran both on
// this symptom after the repeat that made rung 3 due (researchDone): then rung 3 is done and the ladder waits for the next
// attempt, and a repeat after that research and challenge is rung 4. A count that went down (PASS, --improved) only lowers
// the mark. Returns the lines written to the watch log.
export const stuckStep = async (deps: FlowDeps, key: string, metric: string): Promise<string[]> => {
  const lane = await deps.registry.read(key);
  if (!lane) return [];
  const cfg = deps.config.stuck;
  const v = stuckView(lane, metric, deps.config);
  const marks = lane.stuck ?? {};
  const prev = marks[v.metric]?.pane === lane.pane ? (marks[v.metric]?.rung ?? 0) : 0;
  let rung = rungOf(v, prev, cfg);
  // the times of the attempts the count stands on (the larger half), so research done after the third is seen
  const times = v.inferred > v.tagged ? (lane.inferred?.cycles?.[v.metric] ?? []).slice(-v.inferred) : v.taggedAt;
  const third = times[cfg.researchAt - 1];
  const done = rung === 3 && prev < 3 && third ? researchDone(deps.config, lane, v.metric, third) : undefined;
  const failedAfter = done ? times.filter((t) => Date.parse(t) > Date.parse(done.at)).length : 0;
  if (failedAfter) rung = 4;
  if (rung === prev && marks[v.metric]?.n === v.n) return [];
  await deps.registry.patch(key, { stuck: { ...marks, [v.metric]: { rung, n: v.n, at: iso(deps.clock), ...(lane.pane ? { pane: lane.pane } : {}) } } });
  if (rung <= prev || rung < 2) return [];
  let action: string;
  if (rung === 2) action = `branch before the next patch: ${deps.config.explore.minHypotheses} competing hypotheses, each with a cheap discriminating test (dori fix-attempt ${key} --metric "${v.metric}" --hypotheses ... --test ..., or dori tree add --lane ${key})`;
  else if (rung === 3 && done) action = `already done after attempt ${cfg.researchAt}: ${done.research} and ${done.challenge}; nothing sent, wait for the next attempt's result (one more failed attempt is rung 4)`;
  else if (rung === 3) {
    action = "ulw research on the exact symptom and a dori challenge of the next plan, in this session, before the next patch (no rollover at this rung)";
    const area = laneArea(lane, deps.config);
    const tree = await updateTree(deps.config.stateDir, area, (t) => addNode(t, { kind: "research", text: `external search on the symptom "${v.metric}" (stuck rung 3, ${v.n} failed attempts, lane ${key})`, metric: v.metric, lane: key, source: "stuck rung 3" }, iso(deps.clock)).tree);
    if (deps.config.explore.sendResearchToLane && lane.pane && statusOf(lane) === "paused") action += `; the lane is paused, so nothing was typed (after dori resume: dori research-hint ${key} --send)`;
    else if (deps.config.explore.sendResearchToLane && lane.pane) {
      const delivered = await sendResearch(deps, lane, tree, v.n, v.metric);
      action += delivered ? "; ulw research sent to the lane" : `; the research text did not reach pane ${lane.pane}`;
    }
  } else action = rolloverAction(key, v.fixated ? `hypothesis tried ${cfg.fixatedAfter}+ times on "${v.metric}"` : done ? `${failedAfter} failed attempt${failedAfter === 1 ? "" : "s"} after the ${done.research} and ${done.challenge} the lane already ran` : `attempt ${v.n} failed after rung 3`);
  // research already done is RESEARCH_DONE, never RESEARCH_DUE (a monitor on that name would ask for it again)
  const names = oldNames(rung, prev, v, cfg).map((n) => (done && n === "RESEARCH_DUE" ? "RESEARCH_DONE" : n));
  const line = stuckLine(key, v.metric, rung, `${counts(v)}${rung > prev + 1 && prev > 0 ? `, from rung ${prev}` : rung > 2 && prev === 0 ? ", first count" : ""}`, action, names);
  watchLog(deps.config.watchLog, deps.clock, { source: "stuck", line });
  return [line];
};

// After an intent check: a finding (VIOLATION, CONTRADICTION, GOAL_LOSS) is the context rung, a re-read of the brief and the
// owner's words that the lead confirms first (dori intent-check <key> --reread); the same in the next check is rung 4. A
// clean check ends it. A finding on the report the last one rested on (report) is not counted again. Returns the watch-log lines.
export const stuckContext = async (deps: FlowDeps, key: string, findings: readonly { readonly kind: string; readonly owner: string; readonly report: string; readonly why: string; readonly verified: boolean }[], model: string, report?: string): Promise<string[]> => {
  const lane = await deps.registry.read(key);
  if (!lane) return [];
  const marks = { ...(lane.stuck ?? {}) };
  const prev = marks[CONTEXT]?.pane === lane.pane ? marks[CONTEXT] : undefined;
  if (!findings.length) {
    if (marks[CONTEXT]) {
      delete marks[CONTEXT];
      await deps.registry.patch(key, { stuck: marks });
    }
    return [];
  }
  // the report under the last finding did not change: not a new finding (seen live: an older report flagged again)
  if (prev && report && prev.report === report) return [];
  // rung 4 only when the lead confirmed a re-read after the first finding and the lane is still off the owner's words
  // ... and the finding rests on a report (or a stated direction) from after that re-read
  const evidenceAt = report?.replace(/^direction@/, "");
  const reread = lane.intentCheck?.rereadAt && prev ? lane.intentCheck.rereadAt >= prev.at && (!evidenceAt || evidenceAt > lane.intentCheck.rereadAt) : false;
  const rung = prev ? (reread ? 4 : prev.rung) : 1;
  const n = (prev?.n ?? 0) + 1;
  await deps.registry.patch(key, { stuck: { ...marks, [CONTEXT]: { rung, n, at: iso(deps.clock), ...(lane.pane ? { pane: lane.pane } : {}), ...(report ? { report } : {}) } } });
  if (prev && (prev.rung === 4 || rung !== 4)) return [];
  const f = findings[0];
  const detail = `${findings.map((x) => x.kind).join(", ")}: owner "${clip(f?.owner ?? "", 160)}" vs report "${clip(f?.report ?? "", 160)}": ${clip(f?.why ?? "", 160)}${f?.verified ? "" : " (unverified quote)"}; reviewer ${model}`;
  const action = rung === 4
    ? rolloverAction(key, `the intent check found the lane off the owner's words again (${n} checks in a row)`)
    : `confirm the finding, then dori intent-check ${key} --reread sends the lane its brief and the owner's words to re-read; the same finding in the next check is rung 4`;
  const line = stuckLine(key, CONTEXT, rung === 4 ? 4 : "context", detail, action, [...findings.map((x) => `INTENT_CHECK_${x.kind}`), ...(rung === 4 ? ["ROLLOVER_DUE"] : [])]);
  watchLog(deps.config.watchLog, deps.clock, { source: "stuck", line });
  return [line];
};

// ---- after every recorded fix: tree feed, then the ladder ----

export const afterFix = async (deps: FlowDeps, lane: Lane, fixes: readonly FixAttempt[], attempt: FixAttempt): Promise<string[]> => {
  const n = metricAttempts(fixes, attempt.metric);
  await updateTree(deps.config.stateDir, laneArea(lane, deps.config), (t) => addNode(t, { kind: "tried", text: attempt.hypothesis, metric: attempt.metric, lane: lane.key, source: `${attempt.via} attempt ${n}` }, attempt.at).tree);
  return stuckStep(deps, lane.key, attempt.metric);
};

// ---- dori research-hint ----

const STOP = new Set(["the", "a", "an", "of", "to", "and", "or", "in", "on", "for", "with", "is", "are", "not", "no", "from", "at", "by", "after", "before", "too", "fix", "lane"]);
const words = (s: string, n: number): string => s.toLowerCase().replace(/[^\p{L}\p{N}._ -]+/gu, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)).slice(0, n).join(" ");

// What the lane's records say about its stuck symptom: the failing metric, the hypotheses tried, falsified and open.
export const researchFacts = (lane: Lane, tree: Tree) => {
  const fixes = lane.fixes ?? [];
  const metric = fixes.at(-1)?.metric ?? tree.nodes.findLast((n) => n.metric)?.metric ?? "";
  const tried = [...new Set(fixes.filter((f) => f.metric === metric).map((f) => f.hypothesis))];
  const hyps = (status: NodeStatus) => tree.nodes.filter((n) => n.kind === "hypothesis" && n.status === status && (!metric || n.metric === metric));
  const domain = words(`${lane.title} ${lane.cwd ? basename(lane.cwd) : ""}`, 6);
  const symptom = words(metric, 8) || words(lane.lastReport ?? lane.title, 8);
  return { fixes, metric, tried, falsified: hyps("falsified"), open: hyps("open"), domain, symptom };
};

const lastReportText = (lane: Lane): string => (lane.lastReport ?? "").replace(/^\[REPORT\][^|]*\|[^|]*\|\s*/, "");

// A search plan built from the lane's records only: the failing metric, the hypotheses tried and falsified, the domain.
export const researchHint = (lane: Lane, tree: Tree): string[] => {
  const f = researchFacts(lane, tree);
  const { fixes, metric, tried, domain, symptom } = f;
  const falsified = f.falsified.map((n) => n.text);
  const open = f.open.map((n) => n.text);
  const top = open[0] ?? tried.at(-1) ?? "";
  const queries = [
    `"${symptom}" ${domain} (papers: arxiv, Semantic Scholar, Google Scholar)`,
    ...(top ? [`"${symptom}" ${words(top, 6)} (GitHub issues and discussions: site:github.com)`] : []),
    `${domain} ${symptom} "known issue" OR "failure mode" OR "collapse" (forums, blog post-mortems)`,
    ...(falsified.length ? [`${symptom} -"${words(falsified[0] ?? "", 4)}" other causes (what else explains it, now that this is ruled out)`] : []),
    `repositories solving ${domain} with ${symptom}: how their setup differs from ours`,
  ];
  return [
    `RESEARCH_HINT ${lane.key} on "${metric || "(no metric on record)"}": ${fixes.filter((f) => f.metric === metric).length} attempts, ${tried.length} hypotheses tried, ${falsified.length} falsified, ${open.length} open`,
    `Symptom: ${symptom || "(unknown)"}${lane.lastReport ? `; last report: ${clip(lastReportText(lane), 160)}` : ""}`,
    ...(tried.length ? [`Already tried: ${tried.map((t) => clip(t, 80)).join("; ")}`] : []),
    "Search (10-15 minutes, stop at the first source that names this exact symptom):",
    ...queries.map((q, i) => `  ${i + 1}. ${q}`),
    `Record each useful finding: dori tree add --lane ${lane.key} --kind finding --text "<source url>: <what it says, and which hypothesis it supports or rules out>"`,
    "Then turn the best finding into a hypothesis with a cheap test (dori tree add --kind hypothesis --test ...) and report what it changes about the next step.",
  ];
};

// ---- the external-search step, run through omo's ulw research ----

// Text typed into a pane stays one line, and sendVerified refuses backticks and $(.
const typeable = (s: string): string => s.replace(/\s+/g, " ").replace(/`/g, "'").replaceAll("$(", "$ (").trim();

// The research question for ulw research, from the lane's records: the exact symptom, what was tried, what a test ruled
// out (and how), what is still open, and what sources to look for.
export const researchQuestion = (lane: Lane, tree: Tree): string => {
  const f = researchFacts(lane, tree);
  const report = lastReportText(lane);
  const symptom = f.metric ? `"${f.metric}" does not improve` : `${clip(report || lane.title, 160)}`;
  const parts = [
    `Lane ${lane.key} (${clip(lane.title, 80)}${lane.cwd ? `, repo ${basename(lane.cwd)}` : ""}) is stuck. Exact symptom: ${symptom}${f.fixes.length ? ` after ${f.fixes.filter((x) => x.metric === f.metric).length} fix attempts` : ""}${report && f.metric ? `; last report: ${clip(report, 160)}` : ""}.`,
    ...(f.tried.length ? [`Tried: ${f.tried.map((t) => clip(t, 80)).join("; ")}.`] : []),
    ...(f.falsified.length ? [`Ruled out by a test: ${f.falsified.map((n) => `${clip(n.text, 80)}${n.result ? ` (${clip(n.result, 80)})` : ""}`).join("; ")}.`] : []),
    ...(f.open.length ? [`Still open: ${f.open.map((n) => clip(n.text, 80)).join("; ")}.`] : []),
    `Look for papers (arxiv, Semantic Scholar), GitHub issues and discussions, and repos that hit this exact symptom${f.domain ? ` in ${f.domain}` : ""}: what caused it there, what fixed it, and causes other than the ones ruled out.`,
  ];
  return typeable(parts.join(" "));
};

// explore.researchText with the question filled in; it starts with "ulw research " (loadConfig refuses a template that does not)
export const researchMessage = (cfg: Pick<Explore, "researchText">, lane: Lane, tree: Tree, signal: number, metric: string): string =>
  typeable(fill([cfg.researchText], { question: researchQuestion(lane, tree), n: String(signal), metric, key: lane.key })[0] ?? cfg.researchText);

// Types the ulw research text into the lane and records when, so researchCheck can find it in the lane's session log.
export const sendResearch = async (deps: FlowDeps, lane: Lane, tree: Tree, signal: number, metric: string): Promise<boolean> => {
  if (!lane.pane) return false;
  const text = researchMessage(deps.config.explore, lane, tree, signal, metric);
  const sentAt = deps.clock.now();
  const delivered = await sendVerified(deps.run, deps.clock, deps.config, lane.pane, text);
  if (delivered) await deps.registry.patch(lane.key, { research: { at: new Date(sentAt).toISOString(), sentAt, probe: text.slice(0, 80), metric, signal } });
  return delivered;
};

// Markers of a started ulw research in an omo session log (jsonl), counted from `since` (ms) on:
// - seen: a user message whose text starts with the probe (the start of the text dori typed)
// - pointer: a {"type":"custom_message","customType":"omo-ulw-research:skill-pointer"} entry, or the pointer block
//   <omo-ulw-research-pointer> inside that user message (omo appends it there when the agent was busy)
// - read: an assistant tool call that really reads ulw-research/SKILL.md (skillRead), not one that only mentions it,
//   after the typed message reached the session
// - readEarlier: the same read before that (before `since`, or while the lane was still busy with an earlier send): a lane that already holds the skill may not read it again, and then
//   tends to answer without the skill's protocol (seen live on a second send in one session)
export const RESEARCH_POINTER = "omo-ulw-research:skill-pointer";
export const RESEARCH_SKILL = "ulw-research/SKILL.md";
export type ResearchStart = { readonly seen: boolean; readonly pointer: boolean; readonly read: boolean; readonly readEarlier: boolean };

// A read of the skill file, not a mention of it (a lane that records a finding quoting the path did not read it):
// - the read tool with that path, or
// - an eval/bash call whose code holds the file's path (/..., ~/..., ./..., ${dir}/...) as a whole string literal and
//   reads a file (Bun.file, readFile, ... or a shell cat, sed, head, ...), or runs such a shell command on the path.
// A bare "ulw-research/SKILL.md" in a string, or the path inside a sentence, is a mention.
const SKILL_PATH = /ulw-research\/SKILL\.md(?![\w.-])/;
const SKILL_LITERAL = /(["'`])(?:\/|~|\.|\$\{)[^"'`\s]*ulw-research\/SKILL\.md\1/;
const READ_API = /\b(?:Bun\.file|readFileSync|readFile|createReadStream|openSync|tool\.read)\s*\(/;
// a shell read command on an interpolated path (cat ${skill}); a bare `| tail -1` reads a pipe, not a file
const SHELL_VAR = /(?:^|[\n;&|(`"']|\$\()\s*(?:cat|sed|head|tail|less|more|bat|nl|awk)\b[^\n;&|`]*?\s["']?\$\{/;
const SHELL_READ = /(?:^|[\n;&|(`"']|\$\()\s*(?:cat|sed|head|tail|less|more|bat|nl|awk)\b[^\n;&|`]*?[\s"'][^\s"';&|`]*ulw-research\/SKILL\.md(?![\w.-])/;
export const skillRead = (name: string | undefined, args: unknown): boolean => {
  const a = (args ?? {}) as Record<string, unknown>;
  if (name?.toLowerCase() === "read") return [a.path, a.file_path, a.filePath].some((p) => typeof p === "string" && SKILL_PATH.test(p));
  const code = [a.code, a.command, a.cmd].find((c): c is string => typeof c === "string");
  if (!code) return false;
  return (SKILL_LITERAL.test(code) && (READ_API.test(code) || SHELL_VAR.test(code))) || SHELL_READ.test(code);
};

type LogEntry = { type?: string; customType?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
const blocks = (content: unknown): { type?: string; text?: string; name?: string; arguments?: unknown }[] => (Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : []);

export const parseResearchStart = (jsonl: string, probe: string, since: number): ResearchStart => {
  let seen = false;
  let pointer = false;
  let read = false;
  let readEarlier = false;
  for (const line of jsonl.split("\n")) {
    let e: LogEntry;
    try {
      e = JSON.parse(line) as LogEntry;
    } catch {
      continue; // a blank line, or the last line while omo is still writing it
    }
    const after = Date.parse(e.timestamp ?? "") >= since;
    if (after && e.type === "custom_message" && e.customType === RESEARCH_POINTER) pointer = true;
    if (e.type !== "message") continue;
    for (const b of blocks(e.message?.content)) {
      const readsSkill = e.message?.role === "assistant" && b.type === "toolCall" && skillRead(b.name, b.arguments);
      if (!after) {
        readEarlier ||= readsSkill;
        continue;
      }
      if (e.message?.role === "user" && b.type === "text" && b.text?.startsWith(probe)) {
        seen = true;
        if (b.text.includes("<omo-ulw-research-pointer>")) pointer = true;
      }
      // a read before the typed text reached the session (the lane still busy with an earlier send) is not this send's
      if (readsSkill && seen) read = true;
      else if (readsSkill) readEarlier = true;
    }
  }
  return { seen, pointer, read, readEarlier };
};

// The lane's session log is the one in its cwd's session directory, written since the send, that holds the typed text.
export const findResearchStart = (sessionsDir: string, cwd: string, probe: string, since: number): ResearchStart & { readonly file?: string } => {
  const dir = sessionDirFor(sessionsDir, cwd);
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return { seen: false, pointer: false, read: false, readEarlier: false };
  }
  // a file omo removed since the listing has no stat and is skipped
  const recent = names.map((n) => ({ file: join(dir, n), at: statSync(join(dir, n), { throwIfNoEntry: false })?.mtimeMs ?? 0 })).filter((f) => f.at >= since).sort((a, b) => b.at - a.at);
  for (const { file } of recent) {
    const r = parseResearchStart(readFileSync(file, "utf8"), probe, since);
    if (r.seen) return { ...r, file };
  }
  return { seen: false, pointer: false, read: false, readEarlier: false };
};

export type ResearchCheck = { readonly verdict: "started" | "not-started" | "pending" | "none"; readonly line: string };

// RESEARCH_STARTED once the lane's session log shows the skill pointer and a read of its SKILL.md; RESEARCH_NOT_STARTED
// when explore.researchVerifyMin passed without both. Either goes to the watch log once and is kept on the lane.
export const researchCheck = async (deps: FlowDeps, lane: Lane): Promise<ResearchCheck> => {
  const r = lane.research;
  if (!r) return { verdict: "none", line: `RESEARCH_NONE ${lane.key}: no ulw research text was sent to this lane (dori research-hint ${lane.key} --send)` };
  if (r.result) return { verdict: r.result, line: `RESEARCH_${r.result === "started" ? "STARTED" : "NOT_STARTED"} ${lane.key}: already decided for the text sent ${r.at}` };
  const cwd = expandHome(lane.cwd ?? deps.config.defaultCwd);
  const found = findResearchStart(deps.config.sessionsDir, cwd, r.probe, r.sentAt);
  const min = Math.round((deps.clock.now() - r.sentAt) / 60_000);
  const where = found.file ? ` (${basename(found.file)})` : ` (no session log in ${sessionDirFor(deps.config.sessionsDir, cwd)} holds it)`;
  let verdict: ResearchCheck["verdict"] = "pending";
  let line = `RESEARCH_PENDING ${lane.key} ${min} min after the ulw research text: seen=${found.seen} pointer=${found.pointer} skill-read=${found.read}${where}`;
  if (found.pointer && found.read) {
    verdict = "started";
    line = `RESEARCH_STARTED ${lane.key} failed attempt ${r.signal} on "${r.metric}": the session log shows the ${RESEARCH_POINTER} and a read of ${RESEARCH_SKILL}${where}`;
  } else if (deps.clock.now() - r.sentAt >= deps.config.explore.researchVerifyMin * 60_000) {
    verdict = "not-started";
    const missing = !found.seen
      ? "the typed text never reached the lane's session log"
      : !found.pointer
        ? `omo attached no ${RESEARCH_POINTER} (check the omo version and that the text starts with "ulw research ")`
        : found.readEarlier
          ? `the pointer came, but the lane did not read ${RESEARCH_SKILL} again (it read it earlier in this session) and may be answering without the skill's protocol; tell it to follow the ulw-research SKILL.md for this question`
          : `the pointer came but the lane did not read ${RESEARCH_SKILL}`;
    line = `RESEARCH_NOT_STARTED ${lane.key} ${min} min after the ulw research text: ${missing}${where}. Re-send with dori research-hint ${lane.key} --send, or tell the lane to read the ulw-research SKILL.md`;
  }
  if (verdict !== "pending") {
    watchLog(deps.config.watchLog, deps.clock, { source: "research", line });
    await deps.registry.patch(lane.key, { research: { ...r, result: verdict } });
  }
  return { verdict, line };
};

// ---- dori intent-check ----

const NEXT = /(?:next(?: step)?|다음(?: 단계)?)\s*[:：=-]\s*([^|;\n]+)/i;

// What dori intent-check shows next to its reviewer's verdict: the owner's goal, the lane's direction and next step.
export type IntentView = { readonly goal?: string; readonly direction: string; readonly next: string };

export const intentView = (lane: Lane, tree: Tree): IntentView => {
  const report = (lane.lastReport ?? "").replace(/^\[REPORT\][^|]*\|[^|]*\|\s*/, "");
  const direction = lane.direction?.text ?? (report || lane.title);
  const openTest = tree.nodes.find((n) => n.kind === "hypothesis" && n.status === "open" && n.lane === lane.key && n.test);
  const next = lane.direction?.next ?? NEXT.exec(report)?.[1]?.trim() ?? (openTest ? `test ${openTest.id}: ${openTest.test}` : "(not stated; pass --next)");
  return { ...(lane.goal ? { goal: lane.goal } : {}), direction, next };
};

export const formatIntent = (lane: Lane, v: IntentView): string[] => [
  `INTENT ${lane.key} (${lane.title})`,
  `Goal (owner words): ${v.goal ?? "(none recorded; the brief's owner words are read; set one with dori intent-check <key> --goal \"<the owner's words>\")"}`,
  `Direction now:      ${clip(v.direction, 300)}`,
  `Next step:          ${clip(v.next, 300)}`,
];

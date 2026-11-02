import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { type Explore, fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { formatTree, laneArea, loadTree } from "./explore.ts";
import type { ChallengeRecord, Lane } from "./registry.ts";
import { iso, type Ran } from "./run.ts";
import { hostModels, ModelCheckError, type ReviewerCheck, resolveReviewer } from "./reviewer-models.ts";
import { watchLog } from "./watch-log.ts";

// dori challenge: before a big step, a model of another family than the lane's own reads the plan in a fresh context
// (no session, no skills, no lane history) and argues against it. The review is saved under <stateDir>/challenges/<key>/
// and recorded on the lane.
// The reviewer is an agent run (omo -p) with read-only tools (read, grep, find, ls) in the plan's repository. A plan cites
// files and results, and an agent model answers that with "I'll read those first"; with no tools that announcement was
// its whole, final reply (the run ends at the first reply without a tool call), so reviews came back empty. Reviewer ids
// are checked against the host's models and logged-in providers before any call. A reply without the three headings
// still gets one stricter retry, as a safety net.

export class ChallengeError extends Error {}

const FAMILIES: readonly [RegExp, string][] = [
  [/claude|opus|sonnet|haiku|fable/, "anthropic"],
  [/gpt|^o\d|codex|davinci/, "openai"],
  [/grok/, "xai"],
  [/gemini|gemma/, "google"],
  [/qwen/, "qwen"],
  [/kimi|moonshot/, "moonshot"],
  [/glm|zhipu/, "zhipu"],
  [/deepseek/, "deepseek"],
  [/minimax/, "minimax"],
  [/mistral|pixtral|codestral/, "mistral"],
  [/nova/, "amazon"],
  [/llama/, "meta"],
];

// The model's family from its id, whatever provider serves it (github-copilot/gpt-6.1-sol is openai).
export const familyOf = (model: string): string => {
  const id = (model.split("/").pop() ?? model).toLowerCase();
  return FAMILIES.find(([re]) => re.test(id))?.[1] ?? (model.includes("/") ? (model.split("/")[0] ?? id) : id);
};

// the model without its provider and thinking suffix (anthropic-subscription/claude-opus-5-5:medium is claude-opus-5-5)
const bareModel = (model: string): string => (model.split("/").pop() ?? model).replace(/:[^:]*$/, "").toLowerCase();

// Reviewers of another family than the lane's model, in list order. With sameFamily (reviewers.allowSameFamily, for dori
// challenge only) a model of the lane's family stays too; only the lane's own model is still skipped.
export const reviewers = (laneModel: string, candidates: readonly string[], sameFamily = false): string[] =>
  candidates.filter((m) => (sameFamily ? bareModel(m) !== bareModel(laneModel) : familyOf(m) !== familyOf(laneModel)));

// reviewers.models with reviewers.first in front (intent-check, the directives check, the close summary, the rollover audit)
export const reviewerOrder = (models: readonly string[], first: string): string[] => (first ? [first, ...models.filter((m) => m !== first)] : [...models]);

export const SECTIONS = ["Reasons this will fail", "Missing alternatives", "Cheapest falsifying test"] as const;

const MAX_PLAN = 60_000;

export const challengePrompt = (lane: Lane, plan: string, tree: string, root: string): string => [
  "You are an adversarial reviewer with no stake in this plan. You did not write it and you will not carry it out. Your job is to find why it will fail before anyone spends time on it.",
  `The plan is in this message. You can read files under ${root} (the plan's repository) with the read, grep, find and ls tools to check what the plan cites or claims; you cannot change files, run code, or ask questions. Read only what the review needs. Your final reply is the review, under the three headings given after the plan.`,
  `Project: ${lane.title} (lane ${lane.key}).`,
  ...(lane.goal ? [`The owner's goal, in their words: "${lane.goal}"`] : []),
  "What the project already tried and learned (hypothesis tree):",
  tree,
  "The plan under review:",
  "<<<PLAN",
  plan.length > MAX_PLAN ? `${plan.slice(0, MAX_PLAN)}\n[plan cut at ${MAX_PLAN} characters]` : plan,
  "PLAN>>>",
  "Answer in plain markdown with exactly these three headings, in this order:",
  `## ${SECTIONS[0]}`,
  "Concrete, specific failure modes, most likely first. Name the assumption each one breaks. No generic risks.",
  `## ${SECTIONS[1]}`,
  "Competing explanations or approaches the plan ignores, including ones the tree has not ruled out.",
  `## ${SECTIONS[2]}`,
  "The single cheapest experiment (minutes, not hours) whose result would show the plan is wrong, with the number or observation that would decide it.",
  "Be blunt and short. Do not praise the plan.",
  `Your final reply starts with the line "## ${SECTIONS[0]}".`,
].join("\n");

// The retry after a final reply without the headings: the same prompt, what went wrong, and an order to write the review.
export const strictPrompt = (prompt: string, previous: string, missing: readonly string[]): string => [
  prompt,
  "",
  `A previous run of this review ended with a reply that was not the review: it lacked ${missing.map((s) => `"## ${s}"`).join(", ")} and began: "${previous.trim().replace(/\s+/g, " ").slice(0, 200)}".`,
  "Read a file only if the review cannot be written without it. Then write all three sections as your final reply, with nothing before the first heading:",
  ...SECTIONS.map((s) => `## ${s}`),
].join("\n");

// replaces the agent's own system prompt, which would make the reviewer plan work instead of writing the review
export const REVIEWER_SYSTEM = "You are an adversarial plan reviewer. You may read files with the read, grep, find and ls tools to check the plan's claims; you cannot change anything. Your final message is the review the user asks for, under the requested headings. You never ask questions.";

export const missingSections = (text: string): string[] => SECTIONS.filter((s) => !text.toLowerCase().includes(s.toLowerCase()));

// the line of the reviewer's stderr that says why it failed (omo ends a login error with links to its docs)
const why = (r: Ran): string => {
  const lines = r.err.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /error|api key|log ?in|authenticat|ambiguous|not found|unknown|timeout/i.test(l)) ?? lines.at(-1) ?? "";
  return `exit ${r.code}${line ? ` ${line.slice(0, 200)}` : ""}`;
};

const stampOf = (at: string): string => at.replace(/[:.]/g, "-");
const slug = (model: string): string => model.replace(/[^A-Za-z0-9._-]+/g, "-");

// The reviewers to call on this host, in order: each listed id resolved by reviewer-models (skipped when the host cannot
// call it). An empty modelsCommand turns the check off and every id is called as listed.
export const checkReviewers = async (deps: FlowDeps, listed: readonly string[]): Promise<ReviewerCheck[]> => {
  const cfg: Explore = deps.config.explore;
  if (!cfg.modelsCommand.length) return listed.map((m) => ({ listed: m, call: m, note: "not checked (explore.modelsCommand is empty)" }));
  try {
    const host = await hostModels(deps.run, cfg, listed);
    return listed.map((m) => resolveReviewer(m, host));
  } catch (e) {
    if (e instanceof ModelCheckError) throw new ChallengeError(e.message);
    throw e;
  }
};

// the plan's repository (git top level of its directory), else its directory: where the reviewer may read
const planRoot = async (deps: FlowDeps, planFile: string): Promise<string> => (await deps.run(["git", "-C", dirname(planFile), "rev-parse", "--show-toplevel"])).out.trim() || dirname(planFile);

export type Review = { readonly record: ChallengeRecord; readonly text: string };
export type ChallengeResult = { readonly reviews: readonly Review[]; readonly failures: readonly string[] };

// Tries each callable reviewer of another family in order (reviewers.models, or the one --model) until one writes
// all three sections; with all, goes on until each family in the list has written one. One that answers without the
// sections gets one stricter retry; if that still lacks them both replies are saved as <time>-<model>-raw.md and the
// next reviewer is asked.
export const runChallenge = async (deps: FlowDeps, lane: Lane, planFile: string, opts: { readonly model?: string; readonly all?: boolean } = {}): Promise<ChallengeResult> => {
  const file = Bun.file(planFile);
  if (!(await file.exists())) throw new ChallengeError(`plan not found: ${planFile}`);
  const plan = (await file.text()).trim();
  if (!plan) throw new ChallengeError(`plan ${planFile} is empty`);
  const cfg = deps.config.explore;
  const own = lane.model ?? deps.config.defaultModel;
  const sameFamily = deps.config.reviewers.allowSameFamily === true;
  if (opts.model && !reviewers(own, [opts.model], sameFamily).length) throw new ChallengeError(sameFamily ? `--model ${opts.model} is the lane's own model (${own}); pick another model` : `--model ${opts.model} is the lane's own family (${familyOf(own)}); pick another family, or set reviewers.allowSameFamily`);
  const candidates = opts.model ? [opts.model] : reviewers(own, deps.config.reviewers.models, sameFamily);
  if (!candidates.length) throw new ChallengeError(sameFamily ? `no reviewer in reviewers.models other than the lane's own model ${own}` : `no reviewer in reviewers.models is of another family than the lane's model ${own} (${familyOf(own)})`);
  const failures: string[] = [];
  const skip = (line: string): void => {
    failures.push(line);
    watchLog(deps.config.watchLog, deps.clock, { source: "challenge", line: `CHALLENGE_SKIP ${lane.key} ${line}` });
  };
  const checks = await checkReviewers(deps, candidates);
  for (const c of checks) if (!c.call) skip(`${c.listed}: not callable on this host: ${c.note}`);
  const callable = [...new Set(checks.flatMap((c) => (c.call ? [c.call] : [])))];
  const families = [...new Set(callable.map(familyOf))];
  const calls = opts.all ? families.flatMap((f) => callable.filter((m) => familyOf(m) === f)) : callable;
  const root = await planRoot(deps, planFile);
  const tree = formatTree(await loadTree(deps.config.stateDir, laneArea(lane, deps.config)));
  const prompt = challengePrompt(lane, plan, tree, root);
  const dir = join(deps.config.stateDir, "challenges", lane.key);
  mkdirSync(dir, { recursive: true });
  const ask = (m: string, text: string): Promise<Ran> => deps.run(fill(cfg.challengeCommand, { model: m, prompt: text, system: REVIEWER_SYSTEM }), { cwd: root, timeoutMs: cfg.challengeMinutes * 60_000 });
  const reviews: Review[] = [];
  const reviewed = new Set<string>();
  for (const m of calls) {
    if (reviewed.has(familyOf(m))) continue;
    const first = await ask(m, prompt);
    if (first.code !== 0) {
      skip(`${m}: ${why(first)}`);
      continue;
    }
    let answer = first.out.trim();
    const missing = missingSections(answer);
    let attempts = 1;
    if (missing.length) {
      const second = await ask(m, strictPrompt(prompt, answer, missing));
      attempts = 2;
      const retried = second.out.trim();
      if (second.code !== 0 || missingSections(retried).length) {
        const raw = join(dir, `${stampOf(iso(deps.clock))}-${slug(m)}-raw.md`);
        await Bun.write(raw, [`# Incomplete challenge replies of ${m} for ${lane.key}`, "", `- Plan: ${planFile}`, "", "## First reply", "", answer || "(empty)", "", `## Stricter retry (exit ${second.code})`, "", retried || "(empty)", ...(second.err.trim() ? ["", "stderr:", second.err.trim()] : []), ""].join("\n"));
        skip(`${m}: no complete review after a stricter retry (first reply lacked ${missing.join(", ")}: "${answer.split("\n")[0]?.slice(0, 100) ?? ""}"; retry ${second.code !== 0 ? why(second) : `lacked ${missingSections(retried).join(", ")}`}); raw replies: ${raw}`);
        continue;
      }
      answer = retried;
    }
    const at = iso(deps.clock);
    const path = join(dir, `${stampOf(at)}-${slug(m)}.md`);
    await Bun.write(path, [`# Challenge of ${lane.key}`, "", `- At: ${at}`, `- Reviewer: ${m} (${familyOf(m)}); lane model ${own} (${familyOf(own)})`, `- Plan: ${planFile}`, `- Read access: ${root}`, ...(attempts > 1 ? ["- Attempts: 2 (the first reply had no complete review; a stricter retry wrote it)"] : []), "", answer, ""].join("\n"));
    const record: ChallengeRecord = { at, model: m, plan: planFile, file: path };
    const fresh = await deps.registry.read(lane.key);
    await deps.registry.patch(lane.key, { challenges: [...(fresh?.challenges ?? []), record] });
    watchLog(deps.config.watchLog, deps.clock, { source: "challenge", line: `CHALLENGE ${lane.key} reviewer=${m} plan=${planFile} file=${path}${attempts > 1 ? " after a stricter retry" : ""}` });
    reviews.push({ record, text: answer });
    reviewed.add(familyOf(m));
    if (!opts.all) break;
  }
  if (opts.all) for (const f of new Set(candidates.map(familyOf))) if (!reviewed.has(f)) failures.push(`family ${f}: no review (every ${f} reviewer was skipped or failed)`);
  if (reviews.length) return { reviews, failures };
  const line = `no reviewer wrote a complete review: ${failures.join(" | ")}`;
  watchLog(deps.config.watchLog, deps.clock, { source: "challenge", line: `CHALLENGE_FAILED ${lane.key} ${line}` });
  throw new ChallengeError(line);
};

// A lane launched with --challenge-before cannot claim done before one challenge is on record.
export const challengeMissing = (lane: Lane): string | undefined =>
  lane.challengeBefore?.length && !lane.challenges?.length
    ? `CHALLENGE_MISSING ${lane.key}: launched with --challenge-before ${lane.challengeBefore.map((s) => `"${s}"`).join(", ")} and no challenge on record; run dori challenge ${lane.key} --plan <file> first`
    : undefined;

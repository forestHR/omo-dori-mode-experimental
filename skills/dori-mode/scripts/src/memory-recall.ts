import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

// Recalling the lead's own memory for an owner message (dori inbound discord): the notes of this Dori's omo memory repo
// that the message's words point at, so a lead that does the work itself sees what it already learned about that work
// (2026-11-02: MooDori answered the owner's "그리고 카드처리해 서류 준비하고 있어" wrong while reference/kimm-card-ai-billing.md
// held his 10-19 instruction; the memory advisor did not surface it that turn).

// How many notes an owner message carries in its inbox row.
export const RECALL_LIMIT = 3;

// The omo memory repo of a session started in cwd: ~/.omo/memory/agents/<basename slug>-<sha256(cwd) first 8>/repo.
export const memoryRepoFor = (cwd: string, home: string): string => {
  const slug = basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "cwd";
  return join(home, ".omo", "memory", "agents", `${slug}-${createHash("sha256").update(cwd).digest("hex").slice(0, 8)}`, "repo");
};

export class MemoryRecallError extends Error {}

type Note = { readonly path: string; readonly description: string; readonly body: string; readonly mtime: number };

// The notes recall reads: notes/ and reference/ (every .md), and people/<name>/card.md. system/ is in every prompt already.
const notesOf = (repo: string): Note[] => {
  if (!existsSync(repo)) throw new MemoryRecallError(`memory repo ${repo} does not exist`);
  const out: Note[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".md")) {
        const rel = relative(repo, p);
        // a person's observations and the lead's journal about its own behaviour are not knowledge about the work
        if ((rel.startsWith("people/") && name !== "card.md") || rel.startsWith("reference/self/")) continue;
        const text = readFileSync(p, "utf8");
        const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
        const desc = fm ? (/^description:\s*(.*)$/m.exec(fm[1] ?? "")?.[1] ?? "").trim().replace(/^["']|["']$/g, "") : "";
        out.push({ path: rel, description: desc, body: fm ? text.slice(fm[0].length) : text, mtime: st.mtimeMs });
      }
    }
  };
  for (const top of ["notes", "reference", "people"]) walk(join(repo, top));
  return out;
};

// The words of a message, each with the stems a Korean word ending may hide ("카드처리해" -> 카드처리, 카드처, 카드): every
// prefix of two characters or more, longest first. Words of one character are left out.
const stemsOf = (text: string): string[][] =>
  [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []))].map((w) => Array.from({ length: w.length - 1 }, (_, i) => w.slice(0, w.length - i)));

// What a note may show in the row: its path and description, never a secret. A long token-like run and a value after a
// password or token name are blanked.
export const safeLine = (s: string): string =>
  s
    .replace(/(password|passwd|pw|token|secret|비밀번호|비번|토큰|비밀값)(\s*[:=]\s*)\S+/gi, "$1$2[가림]")
    .replace(/[A-Za-z0-9_\-.+/=]{32,}/g, "[가림]")
    .replace(/\s+/g, " ")
    .trim();

// The notes a message points at, best first, at most limit: a word scores by how rare its matching stem is among the
// notes (a stem in most notes says nothing), three times in a note's description, once in its body; a note needs a
// description hit or two words. Ties go to the newer note.
export const recallNotes = (text: string, repo: string, limit = RECALL_LIMIT): { readonly path: string; readonly line: string; readonly score: number }[] => {
  const notes = notesOf(repo);
  if (!notes.length) return [];
  const hay = notes.map((n) => ({ desc: n.description.toLowerCase(), body: n.body.toLowerCase() }));
  const scored = notes.map(() => ({ score: 0, descHits: 0, words: 0, stems: [] as string[] }));
  for (const stems of stemsOf(text)) {
    // the longest stem that is in any note, and how many notes have it
    for (const stem of stems) {
      const df = hay.filter((h) => h.desc.includes(stem) || h.body.includes(stem)).length;
      if (!df) continue;
      if (df / notes.length > 0.5) break;
      const idf = Math.log(notes.length / df);
      hay.forEach((h, i) => {
        const s = scored[i]!;
        if (h.desc.includes(stem)) {
          s.score += 3 * idf;
          s.descHits += 1;
          s.words += 1;
        } else if (h.body.includes(stem)) {
          s.score += idf;
          s.words += 1;
          s.stems.push(stem);
        }
      });
      break;
    }
  }
  return notes
    .map((n, i) => ({ n, s: scored[i]! }))
    .filter(({ s }) => s.score > 0 && (s.descHits > 0 || s.words >= 2))
    .sort((a, b) => b.s.score - a.s.score || b.n.mtime - a.n.mtime)
    .slice(0, limit)
    // the path is a file name the lead chose; only the text after it can hold a secret (a long path is no token)
    .map(({ n, s }) => ({ path: n.path, score: s.score, line: `${n.path}: ${safeLine(gist(n, s).slice(0, 200))}` }));
};

// What a note says about the message: its description when that is what matched, else the body line with the most of the
// matched words (a dated facts file's description, "Explicit facts for 2026-10", says nothing about the work).
const gist = (n: Note, s: { readonly descHits: number; readonly stems: readonly string[] }): string => {
  if (s.descHits > 0 && n.description) return n.description;
  const lines = n.body.split("\n").filter((l) => l.trim());
  const hits = (l: string) => s.stems.filter((st) => l.toLowerCase().includes(st)).length;
  return lines.reduce((best, l) => (hits(l) > hits(best) ? l : best), lines[0] ?? n.description).trim();
};

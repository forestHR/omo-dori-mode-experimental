import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scrubSecrets } from "./rollover-audit.ts";

// dori-superagent #71 (https://github.com/sisyphuslabs/dori-superagent/issues/71): a reviewer that ends without a verdict
// (exit 0 with no VERDICT line, or a nonzero exit) used to leave nothing to read but its first words or stderr. Its stdout
// tail goes to a private file under the state directory instead (0600, in a 0700 folder, known secret patterns masked:
// that lowers the risk, it does not prove every secret or personal detail is gone), and the failure line names it.
export const KEPT_LINES = 200;
export const KEPT_CHARS = 16_000;

export const reviewerOutputDir = (stateDir: string): string => join(stateDir, "reviewer-output");

// a reviewer's nonzero exit in a line: its code and the end of its stderr, masked; never its stdout, which only the file holds
export const exitNote = (r: { readonly code: number; readonly err: string }): string => {
  const err = scrubSecrets(r.err).trim().split("\n").slice(-3).join(" ").slice(0, 300);
  return err ? `exit ${r.code} ${err}` : `exit ${r.code}`;
};

export const keepReviewerOutput = (stateDir: string, label: string, out: string): string => {
  if (!out.trim()) return "reviewer stdout was empty";
  // masked before it is cut, so a cut never leaves a secret too short for its pattern
  const tail = scrubSecrets(out).split(/\r?\n/).slice(-KEPT_LINES).join("\n").slice(-KEPT_CHARS);
  const dir = reviewerOutputDir(stateDir);
  const file = join(dir, `${label.replace(/[^A-Za-z0-9._@-]/g, "_")}-${randomUUID()}.txt`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, tail, { flag: "wx", mode: 0o600 });
  } catch (e) {
    return `reviewer stdout not kept (${e instanceof Error ? e.message : String(e)})`;
  }
  return `reviewer stdout kept in ${file}`;
};

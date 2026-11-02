import type { DoriConfig } from "./config.ts";
import type { Clock } from "./run.ts";
import { watchLog } from "./watch-log.ts";

export type AnnounceDeps = {
  readonly config: DoriConfig;
  readonly clock: Clock;
  readonly send: (pane: string, text: string) => Promise<boolean>;
  readonly print: (line: string) => void;
};
export type ChangeNotice = {
  readonly summary: string;
  readonly files: readonly string[];
  readonly keys?: readonly string[];
  readonly restarts?: readonly string[];
  // an update every Dori applies (dori update), not one Dori's own guidance (notify-change): the maintenance Dori gets
  // update.maintainerAnnounce for it, every other Dori update.announce
  readonly shared?: boolean;
};

export const announceChange = async (deps: AnnounceDeps, notice: ChangeNotice): Promise<boolean> => {
  const pane = deps.config.leadPane;
  const text = [
    `[UPDATE] ${notice.summary}`,
    ...(notice.files.length ? [`Changed guidance:\n${notice.files.join("\n")}`] : []),
    ...(notice.keys?.length ? [`CONFIG_NEW_KEY: ${notice.keys.join(", ")}`] : []),
    ...(notice.restarts?.length ? [`Restarts:\n${notice.restarts.join("\n")}`] : []),
    notice.shared && deps.config.update.maintainer ? deps.config.update.maintainerAnnounce : deps.config.update.announce,
  ].join("\n\n")
    // a commit or PR title with a backtick or $( would make the pane send refuse the whole notice (ANNOUNCE_FAIL, 2026-10-22 #170)
    .replace(/`/g, "'").replaceAll("$(", "$ (");
  let reason = "";
  try {
    if (!pane) reason = "leadPane is not configured";
    else if (!(await deps.send(pane, text))) reason = "message was not submitted (NOT_SUBMITTED in the watch log)";
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    reason = error.message;
  }
  const line = reason ? `ANNOUNCE_FAIL ${pane || "-"} ${reason}` : `ANNOUNCED ${pane}`;
  watchLog(deps.config.watchLog, deps.clock, { source: "update", line });
  deps.print(line);
  return !reason;
};

export const guidanceFiles = (files: readonly string[]): string[] => files.filter((path) =>
  path.startsWith("skills/dori-mode/references/") || path === "skills/dori-mode/SKILL.md" ||
  /^skills\/dori-mode\/setups\/.*\/README\.md$/.test(path));

export const mergeTitles = (log: string): string[] => log.split("\0").filter((entry) => entry.trim()).map((entry) => {
  const [subject = "", ...body] = entry.trim().split("\n");
  return /^Merge pull request #\d+ from /.test(subject) ? body.find((line) => line.trim())?.trim() || subject : subject;
});

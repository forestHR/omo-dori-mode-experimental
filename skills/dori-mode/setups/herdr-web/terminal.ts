import { loadConfig } from "../../scripts/src/config.ts";
import { herdrResult } from "../../scripts/src/herdr.ts";
import { run, type Runner } from "../../scripts/src/run.ts";

export async function focusLead(runner: Runner, leadPane: string): Promise<void> {
  if (!leadPane) return;
  const pane = (await herdrResult(runner, ["pane", "get", leadPane]))?.pane;
  if (typeof pane !== "object" || pane === null || !("tab_id" in pane) || typeof pane.tab_id !== "string") {
    throw new TypeError(`Lead pane ${leadPane} has no herdr tab`);
  }
  const focused = await runner(["herdr", "tab", "focus", pane.tab_id]);
  if (focused.code !== 0) throw new TypeError(`Cannot focus lead tab: ${focused.err || focused.out}`);
}

if (import.meta.main) await focusLead(run, (await loadConfig()).leadPane);

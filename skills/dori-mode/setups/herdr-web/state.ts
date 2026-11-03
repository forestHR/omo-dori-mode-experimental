import { paneActivity, type Activity } from "../../scripts/src/aoe.ts";
import { herdrResult, herdrSessions } from "../../scripts/src/herdr.ts";
import type { Runner } from "../../scripts/src/run.ts";

type State = "working" | "waiting" | "idle" | "none";
export type PaneState = {
  readonly pane: string;
  readonly label: string;
  readonly state: State;
  readonly focused: boolean;
};

const states = {
  busy: "working", running: "working", waiting: "waiting",
  question: "waiting", error: "waiting", idle: "idle",
} as const satisfies Record<Activity, State>;

export function cachedState(run: Runner, now: () => number = Date.now) {
  // Share the in-flight read as well as its result across all browser clients.
  let cached: Promise<readonly PaneState[]> | undefined;
  let until = 0;
  return () => {
    if (!cached || now() >= until) {
      until = Infinity;
      cached = (async () => {
        const sessions = await herdrSessions(run);
        const [activity, result] = await Promise.all([
          paneActivity(run, sessions.map((s) => s.pane)),
          herdrResult(run, ["tab", "list"]),
        ]);
        const tabs = Array.isArray(result?.tabs) ? result.tabs : [];
        return sessions.map((s): PaneState => {
          const state = activity.get(s.pane);
          return {
            pane: s.pane, label: s.title, state: state ? states[state] : "none",
            focused: tabs.some((t: unknown) => typeof t === "object" && t !== null &&
              "tab_id" in t && t.tab_id === s.tab && "focused" in t && t.focused === true),
          };
        });
      })().finally(() => { until = now() + 2000; });
    }
    return cached;
  };
}

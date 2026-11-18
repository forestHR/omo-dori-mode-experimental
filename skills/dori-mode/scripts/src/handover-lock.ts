import { readFileSync, rmSync, writeFileSync } from "node:fs";

// One handover at a time per state dir: two would each open a session and repoint the lead to their own.
export const takeLock = (file: string, alive: (pid: number) => boolean, at: string, what = "handover"): string | undefined => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, at }), { flag: "wx" });
      return undefined;
    } catch (e) {
      if (!(e instanceof Error) || !("code" in e) || e.code !== "EEXIST") throw e;
    }
    const held = (() => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (typeof parsed !== "object" || parsed === null) return {};
        const pid = "pid" in parsed ? parsed.pid : undefined;
        const startedAt = "at" in parsed ? parsed.at : undefined;
        return {
          ...(typeof pid === "number" ? { pid } : {}),
          ...(typeof startedAt === "string" ? { at: startedAt } : {}),
        };
      } catch (error) {
        if (error instanceof SyntaxError || (error instanceof Error && "code" in error && error.code === "ENOENT")) return {};
        throw error;
      }
    })();
    if (held.pid && alive(held.pid)) return `another ${what} is running (pid ${held.pid}, started ${held.at ?? "?"}); ${file}`;
    rmSync(file, { force: true });
  }
  return `could not take the ${what} lock ${file}`;
};

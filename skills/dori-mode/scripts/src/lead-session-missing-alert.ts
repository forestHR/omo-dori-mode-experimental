import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FlowDeps } from "./done-flow.ts";
import type { RolloverEntry } from "./rollover.ts";

export const shouldResumeMissingLeadHandover = (stateDir: string, now: number, last: RolloverEntry): boolean => {
  if (last.kind !== "rollover" || last.who !== "lead" || last.key !== "lead" || last.result !== "refused" || !last.approvedBy?.startsWith("auto:")) return false;
  const reason = last.reasons.find((entry) => entry.startsWith("HANDOVER_MISSING "));
  if (!reason) return false;
  const note = join(stateDir, "handover", `${new Date(now).toISOString().slice(0, 10)}.md`);
  if (!reason.startsWith(`HANDOVER_MISSING ${note}`)) return true;
  try {
    return readFileSync(note, "utf8").trim().length > 0;
  } catch {
    // leadSessionHandover records an unreadable note as HANDOVER_MISSING too.
    return false;
  }
};

export const alertMissingLeadSessionNote = async (deps: FlowDeps, date: string): Promise<void> => {
  if (!deps.postLeadAlert) return;
  const handoverDir = join(deps.config.stateDir, "handover");
  mkdirSync(handoverDir, { recursive: true });
  const note = join(handoverDir, `${date}.md`);
  const notified = join(handoverDir, `${date}.missing-alert.json`);
  if (existsSync(notified)) return;
  const text = `HANDOVER_MISSING ${note}: 노트가 없거나 비어 있어 자동 교대가 거절됐습니다. 새 노트를 작성하면 다음 freshness 차례에 자동 교대가 시작됩니다. 지난 노트를 그대로 복사하지 말고 오늘 바뀐 진행 중인 일, 혜린의 제약, 다음 할 일을 반영해 새로 작성하세요.`;
  const posted = await deps.postLeadAlert(text).catch((error: unknown) => [`LEAD_ALERT_WARN ${String(error).slice(0, 160)}`]);
  if (posted.some((line) => line.startsWith("LEAD_ALERT_POSTED "))) {
    writeFileSync(notified, `${JSON.stringify({ note, at: new Date(deps.clock.now()).toISOString() })}\n`);
  }
};

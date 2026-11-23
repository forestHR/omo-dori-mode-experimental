import { COMMITTED } from "./rollover.ts";
import type { AuditRow } from "./rollover-audit.ts";
import type { RolloverEntry } from "./rollover.ts";

type AutomaticRollover = Extract<RolloverEntry, { kind: "rollover" }>;

type WeeklyAuditSnapshot = {
  readonly days: number;
  readonly since: string;
  readonly moved: number;
  readonly audited: number;
  readonly rows: readonly AuditRow[];
  readonly rollovers: readonly RolloverEntry[];
  readonly committedResults: ReadonlySet<string>;
  readonly auditLog: string;
};

const reasonCounts = (attempts: readonly AutomaticRollover[]): string => {
  const counts = new Map<string, number>();
  for (const attempt of attempts) {
    const detail = attempt.reasons[0] ?? "";
    const reason = attempt.blocked
      ?? (/^HANDOVER_MISSING\b/.test(detail) ? "HANDOVER_MISSING" : /active turn|busy/i.test(detail) ? "busy" : /^[A-Z][A-Z0-9_]*/.exec(detail)?.[0] ?? "unknown");
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([reason, count]) => `${reason} ${count}`).join(", ") || "없음";
};

export const buildWeeklyAuditSummary = (snapshot: WeeklyAuditSnapshot): string => {
  const rows = snapshot.rows;
  const by = (pick: (row: AuditRow) => boolean): number => rows.filter(pick).length;
  const kinds = [...rows.reduce((counts, row) => counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  const lanes = [...rows.reduce((counts, row) => counts.set(row.lane, (counts.get(row.lane) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const unique = new Map<string, AutomaticRollover>();
  for (const entry of snapshot.rollovers) {
    if (entry.kind !== "rollover" || !entry.approvedBy?.startsWith("auto:") || entry.at < snapshot.since) continue;
    const id = JSON.stringify([entry.who, entry.key, entry.approvedBy, entry.at]);
    if (!unique.has(id)) unique.set(id, entry);
  }
  const attempts = [...unique.values()];
  const refused = attempts.filter((entry) => entry.result === "refused");
  const failed = attempts.filter((entry) => entry.result !== "refused" && entry.result !== COMMITTED && !snapshot.committedResults.has(entry.result));
  const automatic = `자동 교대 거절 ${refused.length}번 (${reasonCounts(refused)}); 자동 교대 실패 ${failed.length}번 (${reasonCounts(failed)})`;
  const head = `[ROLLOVER_AUDIT] 지난 ${snapshot.days}일 교대 ${snapshot.moved}번(점검 ${snapshot.audited}), 빠진 것 ${rows.length}건(교대 전 보충 ${by((row) => row.stage === "supplement")} · 교대 뒤 점검 ${by((row) => row.stage === "audit")} · 신고 ${by((row) => row.stage === "reported")}; 고침 ${by((row) => row.fixed)}, 못 고침 ${by((row) => !row.fixed)}; ${automatic})`;
  if (!rows.length) {
    return refused.length || failed.length
      ? `${head}. 자동 교대 거절·실패를 확인하세요.`
      : `${head}. 교대 기능 고칠 거리 없음.`;
  }
  return `${head}. 많이 빠진 종류: ${kinds.slice(0, 3).map(([kind, count]) => `${kind} ${count}`).join(", ")}; lane: ${lanes.map(([lane, count]) => `${lane} ${count}`).join(", ")}. 교대 기능 고칠 거리로: 위 종류가 노트·요약에 실리게. 줄별 내용: ${snapshot.auditLog}`;
};

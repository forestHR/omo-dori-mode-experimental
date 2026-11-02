// Report shape (owner Q302, 2026-10-20): the first line is "[REPORT] <who> | <status> | <one plain line>", the evidence
// sits on the lines below. The readers must keep reading it: the footer's own placeholder is never a report, and a
// report with evidence lines still yields its first line.
import { expect, test } from "bun:test";
import { lastReportLine } from "../src/freshness.ts";
import { footer } from "../src/launch.ts";
import type { Lane } from "../src/registry.ts";

const lane = { key: "msg-ux", thread: "discord:1", done: "check" } as unknown as Lane;

test("the footer's plain-line placeholder, echoed with a real status, is not read as the lane's report", () => {
  const placeholder = footer(lane, "aoe_lead_1", "aoe").split("\n").find((l) => l.includes("[REPORT] msg-ux |")) ?? "";
  expect(placeholder).toContain("[REPORT] msg-ux | <milestone|blocker|question|done> | <");
  const template = placeholder.slice(placeholder.indexOf("| <milestone|blocker|question|done> | ") + 38).split(";")[0];
  const echoed = `[REPORT] msg-ux | milestone | ${template}`;
  const screen = `[REPORT] msg-ux | milestone | 회의록 글을 사람 말로 고침, 형 할 일 없음\n\n${echoed}\n❯ `;

  expect(lastReportLine(screen, "msg-ux")).toBe("[REPORT] msg-ux | milestone | 회의록 글을 사람 말로 고침, 형 할 일 없음");
});

test("a report with its evidence on the lines below still starts with the plain first line", () => {
  const screen = [
    "[REPORT] msg-ux | done | 회의록 글이 사람 말 한 줄로 나와, 형 할 일 없음 (fix: owner-post / capture child stdout)",
    "PR #141 merge 1a2b3c4, QA ~/.dori/qa/yoodori-message-ux/REPORT.md",
    "",
    "❯ ",
  ].join("\n");

  const report = lastReportLine(screen, "msg-ux") ?? "";

  expect(report.startsWith("[REPORT] msg-ux | done | 회의록 글이 사람 말 한 줄로 나와, 형 할 일 없음 (fix: owner-post")).toBe(true);
});

// dori-superagent issue #22: a lane's code that prints a report template shows it on screen before it is filled in
test("a template line with ${...} or {name} in place of the plain line is not read as the lane's report", () => {
  const real = "[REPORT] demo-lane | milestone | checks passed";
  const shell = 'echo "[REPORT] demo-lane | milestone | ${message}"';
  const python = 'print(f"[REPORT] demo-lane | milestone | {message}")';
  expect(lastReportLine([real, python, shell].join("\n"), "demo-lane")).toBe(real);
  expect(lastReportLine(shell, "demo-lane")).toBeNull();
  expect(lastReportLine(python, "demo-lane")).toBeNull();
});

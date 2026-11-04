import { expect, test } from "bun:test";

import { defaultConfig } from "../src/config.ts";
import { alertReasons, guardTick, sampleHost } from "../src/host-guard.ts";
import { canLaunch } from "../src/routing.ts";
import type { Runner } from "../src/run.ts";

// https://github.com/sisyphuslabs/dori-superagent/issues/90: on Linux memory_pressure is missing, and memory read as 100% free
const t = defaultConfig("/home/test").guard;
const meminfo = "MemTotal:       1000000 kB\nMemFree:          20000 kB\nMemAvailable:     150000 kB\n";
const fake = (answers: Record<string, { code: number; out: string }>): Runner => async (argv) => {
  const a = answers[argv.join(" ")] ?? { code: 127, out: "" };
  return { ...a, err: "" };
};

test("on Linux memory is MemAvailable over MemTotal from /proc/meminfo, and low memory holds a launch", async () => {
  const s = await sampleHost(fake({ "cat /proc/meminfo": { code: 0, out: meminfo } }), "herdr");
  expect(s.memFreePct).toBe(15);
  expect(canLaunch(s, t).reasons).toContain("memory free 15% < 20%");
  expect(alertReasons(s, t)).toContain("memory free 15% < 20%");
});

test("memory just under the floor holds a launch though it would round up to the floor; at and over the floor it does not", async () => {
  const at = async (availKb: number) =>
    sampleHost(fake({ "cat /proc/meminfo": { code: 0, out: `MemTotal:       1000000 kB\nMemAvailable:     ${availKb} kB\n` } }), "herdr");
  const under = await at(199000);
  expect(canLaunch(under, t).reasons).toContain("memory free 19% < 20%");
  expect(alertReasons(under, t)).toContain("memory free 19% < 20%");
  for (const kb of [200000, 201000]) {
    const s = await at(kb);
    expect(canLaunch(s, t).reasons.some((r) => r.startsWith("memory"))).toBe(false);
    expect(alertReasons(s, t).some((r) => r.startsWith("memory"))).toBe(false);
  }
});

test("on macOS memory_pressure still gives the free percentage", async () => {
  const s = await sampleHost(fake({ "memory_pressure -Q": { code: 0, out: "System-wide memory free percentage: 42%" } }), "herdr");
  expect(s.memFreePct).toBe(42);
});

test("memory nobody can read is unknown: no memory reason, and the guard says unknown instead of a number", async () => {
  const s = await sampleHost(fake({ "cat /proc/meminfo": { code: 1, out: "" } }), "herdr");
  expect(s.memFreePct).toBeNull();
  expect(canLaunch(s, t).reasons.some((r) => r.startsWith("memory"))).toBe(false);
  expect(alertReasons(s, t).some((r) => r.startsWith("memory"))).toBe(false);
  const st = { alerting: true };
  expect(guardTick({ ...s, diskFreeGb: 200 }, t, st)[0]).toContain("memory free unknown");
});

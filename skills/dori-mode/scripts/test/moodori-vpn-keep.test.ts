import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credsFrom, inWindow, keepConfig, keepRun, keepTick, loginFlow, realDeps, totp, typeInto, vpnState, type Cdp, type KeepDeps, type KeepOptions, type Tunnel, type TunnelProc, type VpnState } from "../../setups/moodori-vpn-keep/keep.ts";

const KEEP = join(import.meta.dir, "../../setups/moodori-vpn-keep/keep.ts");

const BASE = { enabled: true, pcSsh: "user@pc.example", vpnUrl: "https://vpn.example.com/", credsCommand: ["printf", "id\\npw\\n"], motpFile: "~/motp.json" };
const options = (over: Record<string, unknown> = {}): KeepOptions => {
  const c = keepConfig({ ...BASE, ...over }, "/home/x");
  if (!c.on) throw new Error("expected on");
  return c.options;
};

test("vpn keep is off without a config file or without enabled: true, and an enabled config fills MooDori's defaults", () => {
  expect(keepConfig(undefined)).toEqual({ on: false, reason: "no config file" });
  expect(keepConfig({ ...BASE, enabled: "yes" })).toEqual({ on: false, reason: "enabled is not true" });
  expect(() => keepConfig({ enabled: true, vpnUrl: "https://vpn.example.com/" })).toThrow("credsCommand must be a non-empty argv array");
  expect(options()).toEqual({
    pcSsh: "user@pc.example", vpnUrl: "https://vpn.example.com/", credsCommand: ["printf", "id\\npw\\n"], motpFile: "/home/x/motp.json",
    secuwayTask: "moodori-secuway", edgeTask: "moodori-edge", edgePort: 9222, cdpPort: 9224,
    days: [1, 2, 3, 4, 5], hours: [8, 20], timeZone: "Asia/Seoul", intervalMs: 60000, maxFails: 3, restMs: 900000, pauseFile: "/tmp/moodori-vpn-keep.pause",
  });
});

test("the VPN is up only when sslvpn.log's last start/stop line is a completed start and a SecuwaySSL process runs", () => {
  expect(vpnState("L|Thu Nov 05 08:01:02 2026 Initialization Sequence Completed\r\n1")).toBe("UP");
  expect(vpnState("L|Thu Nov 05 12:15:00 2026 SIGTERM[soft,exit-with-notification] received, process exiting\r\n1")).toBe("DOWN");
  expect(vpnState("L|Thu Nov 05 08:01:02 2026 Initialization Sequence Completed\r\n0")).toBe("DOWN");
  expect(vpnState("L|\r\n0")).toBe("DOWN");
  expect(vpnState("NOLOG\r\n0")).toBe("NOLOG");
  expect(vpnState("")).toBe("DOWN");
});

test("the window is weekdays 08:00-19:59 in Seoul time, whatever the host's zone", () => {
  const o = options();
  const at = (iso: string) => inWindow(new Date(iso), o);
  expect(at("2026-11-01T22:59:00Z")).toBe(false); // Mon 07:59 KST
  expect(at("2026-11-01T23:00:00Z")).toBe(true); // Mon 08:00 KST (still Sunday in UTC)
  expect(at("2026-11-05T10:59:00Z")).toBe(true); // Thu 19:59 KST
  expect(at("2026-11-05T11:00:00Z")).toBe(false); // Thu 20:00 KST
  expect(at("2026-11-06T23:30:00Z")).toBe(false); // Sat 08:30 KST
  expect(at("2026-11-07T23:30:00Z")).toBe(false); // Sun 08:30 KST
});

test("the account lines keep every byte but the line ends: a password may start or end in a space", () => {
  expect(credsFrom("id\n pw with spaces \n")).toEqual(["id", " pw with spaces "]);
  expect(credsFrom("id\r\npw \r\n")).toEqual(["id", "pw "]);
  expect(credsFrom("id\n")).toBeNull();
  expect(credsFrom("")).toBeNull();
});

test("a running keep reads its config before every check and exits 0 once enabled is no longer true", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vpn-keep-"));
  const path = join(dir, "vpn-keep.json");
  writeFileSync(path, JSON.stringify({ ...BASE, days: [0, 1, 2, 3, 4, 5, 6], hours: [0, 24] }));
  const printed: string[] = [];
  let checks = 0;
  let sleeps = 0;
  let killed = 0;
  const code = await keepRun(path, {
    once: false,
    makeDeps: (_o, tunnel) => {
      tunnel.proc ??= { kill: () => { killed++; }, exited: Promise.resolve(0) };
      return deps("UP", [], { state: async () => { checks++; return "UP"; } }).d;
    },
    sleep: async () => {
      if (++sleeps > 1) throw new Error(`still checking after enabled: false (${checks} checks)`);
      writeFileSync(path, JSON.stringify({ ...BASE, enabled: false }));
    },
    now: () => MON_10_KST,
    print: (line) => printed.push(line),
  });
  expect({ code, checks, killed, printed }).toEqual({ code: 0, checks: 1, killed: 1, printed: [`VPN_KEEP_OFF ${path} (enabled is not true)`] });
});

test("the tunnel keeps its PC: a config naming another PC or port stops the old tunnel even while it answers", async () => {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("{}") });
  const port = probe.port;
  probe.stop(true);
  const spawned: string[] = [];
  let kills = 0;
  const spawn = (argv: readonly string[]): TunnelProc => { spawned.push(argv.slice(-2).join(" ")); return { kill: () => { kills++; }, exited: Promise.resolve(0) }; };
  const tunnel: Tunnel = {};
  const clock = { now: () => Date.now(), sleep: async () => {} };
  const quiet = async () => ({ code: 0, out: "", err: "" });
  const ensure = (over: Record<string, unknown>) => realDeps(options({ cdpPort: port, ...over }), quiet, clock, tunnel, spawn).ensureAgents();
  await ensure({ pcSsh: "a@pc-one" }); // nothing answers: start the tunnel
  const old = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("{}") }); // the started tunnel answers
  try {
    await ensure({ pcSsh: "a@pc-one" });
    const before = { spawned: [...spawned], kills };
    await ensure({ pcSsh: "b@pc-two" });
    expect({ before, after: { spawned, kills, key: tunnel.key } }).toEqual({
      before: { spawned: [`${port}:127.0.0.1:9222 a@pc-one`], kills: 0 },
      after: { spawned: [`${port}:127.0.0.1:9222 a@pc-one`], kills: 1, key: undefined },
    });
  } finally {
    old.stop(true);
  }
});

test("keep.ts takes DORI_VPN_KEEP_CONFIG from dori.env (DORI_ENV_FILE) like the other setups", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vpn-keep-env-"));
  writeFileSync(join(dir, "dori.env"), `DORI_VPN_KEEP_CONFIG=${join(dir, "from-env-file.json")}\n`);
  const env: Record<string, string | undefined> = { ...process.env, DORI_ENV_FILE: join(dir, "dori.env") };
  delete env.DORI_VPN_KEEP_CONFIG;
  const p = Bun.spawn([process.execPath, KEEP, "--once"], { env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  expect({ code, off: out.includes(`VPN_KEEP_OFF ${join(dir, "from-env-file.json")} (no config file)`) }).toEqual({ code: 0, off: true });
});

test("MOTP is RFC 6238 TOTP-SHA256 with 6 digits", () => {
  const secret = Buffer.from("12345678901234567890123456789012").toString("hex");
  expect(totp(secret, 59_000)).toBe("119246");
  expect(totp(secret, 1111111109_000)).toBe("084774");
});

const MON_10_KST = new Date("2026-11-02T01:00:00Z");
// state: one answer for every check, or answers in turn (the last one repeats)
const deps = (state: VpnState | VpnState[], logins: string[], over: Partial<KeepDeps> = {}) => {
  const calls: string[] = [];
  const states = Array.isArray(state) ? [...state] : [state];
  const d: KeepDeps = {
    paused: async () => false,
    state: async () => { calls.push("state"); return (states.length > 1 ? states.shift() : states[0]) ?? "DOWN"; },
    wait: async () => { calls.push("wait"); },
    ensureAgents: async () => { calls.push("agents"); },
    login: async () => { const r = logins.shift() ?? "FAIL"; calls.push(`login:${r}`); if (r.startsWith("throw")) throw new Error(r); return r; },
    restartAgent: async () => { calls.push("restart"); },
    log: (line) => calls.push(`log:${line}`),
    ...over,
  };
  return { d, calls };
};

test("an up VPN, a pause file or the time outside the window does nothing but wait the interval", async () => {
  const o = options();
  const up = deps("UP", []);
  expect(await keepTick(o, { fails: 0 }, up.d, MON_10_KST)).toBe(60000);
  expect(up.calls).toEqual(["state"]);
  const paused = deps("DOWN", ["OK"], { paused: async () => true });
  expect(await keepTick(o, { fails: 0 }, paused.d, MON_10_KST)).toBe(60000);
  expect(paused.calls).toEqual([]);
  const evening = deps("DOWN", ["OK"]);
  expect(await keepTick(o, { fails: 0 }, evening.d, new Date("2026-11-02T11:00:00Z"))).toBe(60000);
  expect(evening.calls).toEqual([]);
});

test("a down VPN starts the agents and logs in; a login page that never comes restarts the agent once", async () => {
  const o = options();
  const ok = deps(["DOWN", "DOWN", "UP"], ["OK"]);
  const s = { fails: 2 };
  expect(await keepTick(o, s, ok.d, MON_10_KST)).toBe(60000);
  expect(ok.calls).toEqual(["state", "log:DOWN", "agents", "login:OK", "wait", "state", "wait", "state", "log:RELOGIN OK"]);
  expect(s.fails).toBe(0);
  const stuck = deps(["NOLOG", "UP"], ["no login page", "OK"]);
  await keepTick(o, { fails: 0 }, stuck.d, MON_10_KST);
  expect(stuck.calls).toEqual(["state", "log:NOLOG", "agents", "login:no login page", "log:AGENT_RESTART", "restart", "login:OK", "wait", "state", "log:RELOGIN OK"]);
});

test("three failed rounds in a row rest 15 minutes and start counting again; a login that throws is a failed round; an up VPN ends the run", async () => {
  const o = options();
  const s = { fails: 0 };
  const waits: number[] = [];
  const logs: string[] = [];
  for (const pair of [["FAIL x", "FAIL y"], ["throw tunnel", "FAIL z"], ["no cert", "FAIL w"], ["FAIL v", "FAIL u"]]) {
    const r = deps("DOWN", pair);
    waits.push(await keepTick(o, s, r.d, MON_10_KST));
    logs.push(...r.calls.filter((c) => c.startsWith("log:RELOGIN") || c.startsWith("log:GIVEUP")));
  }
  expect(waits).toEqual([60000, 60000, 900000, 60000]);
  await keepTick(o, s, deps("UP", []).d, MON_10_KST);
  expect(s.fails).toBe(0); // an up VPN in between: the next failure is the first of a new run
  s.fails = 2;
  await keepTick(o, s, deps("UP", []).d, MON_10_KST);
  expect(await keepTick(o, s, deps("DOWN", ["FAIL a", "FAIL b"]).d, MON_10_KST)).toBe(60000);
  expect(logs).toEqual(["log:RELOGIN FAIL y", "log:RELOGIN FAIL z", "log:RELOGIN FAIL w", "log:GIVEUP after 3 fails, resting 15 min", "log:RELOGIN FAIL u"]);
  expect(s.fails).toBe(1);
});

test("a portal login whose tunnel never comes up within 30 s is a failed round, so three of them still rest", async () => {
  const o = options();
  const s = { fails: 0 };
  const waits: number[] = [];
  let r = deps("DOWN", []);
  for (let i = 0; i < 3; i++) {
    r = deps("DOWN", ["OK"]);
    waits.push(await keepTick(o, s, r.d, MON_10_KST));
  }
  expect(waits).toEqual([60000, 60000, 900000]);
  expect(r.calls.filter((c) => c === "wait").length).toBe(6);
  expect(r.calls.filter((c) => c.startsWith("log:RELOGIN") || c.startsWith("log:GIVEUP"))).toEqual(["log:RELOGIN OK portal, VPN still down after 30 s", "log:GIVEUP after 3 fails, resting 15 min"]);
});

// A scripted Secuway portal behind a fake CDP: frames move on after the login and the OTP send buttons are clicked.
type Page = { otpChoice?: boolean; focus?: Record<string, boolean>; throwOn?: string; holds?: Record<string, number>; noOtpField?: boolean; navError?: string; protocolError?: string };
const fakePortal = (page: Page = {}) => {
  const typed: string[] = [];
  const clicked: string[] = [];
  let stage: "login" | "cert" | "done" = "login";
  let focused = "";
  const value: Record<string, number> = {};
  const frame = (url: string) => ({ frame: { id: "top", url: "https://vpn.example.com/" }, childFrames: [{ frame: { id: "f", url } }] });
  const send = async (method: string, params: Record<string, any> = {}): Promise<any> => {
    if (page.protocolError === method) throw new Error(`${method}: protocol error`);
    if (method === "Page.navigate") return { result: page.navError ? { errorText: page.navError } : { frameId: "top" } };
    if (method === "Page.getFrameTree") return { result: { frameTree: frame(stage === "login" ? "https://vpn.example.com/login.jsp" : stage === "cert" ? "https://vpn.example.com/flag3_cert.jsp" : "https://vpn.example.com/bookmark.jsp") } };
    if (method === "Page.createIsolatedWorld") return { result: { executionContextId: 7 } };
    if (method === "Input.insertText") { typed.push(`${focused}=${params.text}`); value[focused] = page.holds?.[focused] ?? String(params.text).length; return { result: {} }; }
    if (method !== "Runtime.evaluate") return { result: {} };
    const x = String(params.expression);
    const name = /\[name=(\w+)\]/.exec(x)?.[1] ?? "";
    if (page.throwOn && x.includes(`[name=${page.throwOn}]`)) return { result: { result: { type: "object" }, exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: e is null" } } } };
    const val = (v: unknown) => ({ result: { result: { type: typeof v, value: v } } });
    if (x.includes("vxs")) return val(page.otpChoice ?? true);
    if (x.startsWith("!!")) return val(!page.noOtpField);
    if (x.includes("e.focus()")) { const ok = page.focus?.[name] ?? true; if (ok) focused = name; return val(ok); }
    if (x.includes("e.value.length")) return val(focused === name ? value[name] ?? 0 : -1);
    if (x.includes("go(")) { clicked.push("login"); stage = "cert"; return val(true); }
    if (x.includes("전송")) { clicked.push("otp"); stage = "done"; return val(true); }
    return val(undefined);
  };
  const V: Cdp = { send, dialogs: [], close: () => {} };
  return { V, typed, clicked };
};
const instant = { now: () => 15_000, sleep: async () => {} };
const flow = (page: Page) => {
  const p = fakePortal(page);
  const run = loginFlow(p.V, "https://vpn.example.com/", async () => ["the-id", "the-pw"], () => "123456", instant).catch((e: Error) => `THROW ${e.message}`);
  return run.then((r) => ({ r, typed: p.typed, clicked: p.clicked }));
};

test("the login flow types the account and the MOTP code each into its own focused field and ends OK at the bookmark page", async () => {
  expect(await flow({})).toEqual({ r: "OK", typed: ["userid=the-id", "userpw=the-pw", "usersms=123456"], clicked: ["login", "otp"] });
});

test("a field that is missing, not focused, throws in the page or does not hold the text gets no secret and stops the login", async () => {
  expect(await flow({ otpChoice: false })).toEqual({ r: "THROW OTP login choice not found or not chosen", typed: [], clicked: [] });
  expect(await flow({ focus: { userpw: false } })).toEqual({ r: "THROW userpw field not found or not focused", typed: ["userid=the-id"], clicked: [] });
  expect(await flow({ throwOn: "userid" })).toEqual({ r: "THROW page script failed: TypeError: e is null", typed: [], clicked: [] });
  expect(await flow({ holds: { userpw: 3 } })).toEqual({ r: "THROW userpw field holds 3 characters, not 6", typed: ["userid=the-id", "userpw=the-pw"], clicked: [] });
  expect(await flow({ focus: { usersms: false } })).toEqual({ r: "THROW usersms field not found or not focused", typed: ["userid=the-id", "userpw=the-pw"], clicked: ["login"] });
  expect(await flow({ noOtpField: true })).toEqual({ r: "no otp field", typed: ["userid=the-id", "userpw=the-pw"], clicked: ["login"] });
});

test("a navigation error or a CDP protocol error fails the login before anything is typed", async () => {
  expect(await flow({ navError: "net::ERR_NAME_NOT_RESOLVED" })).toEqual({ r: "THROW navigate: net::ERR_NAME_NOT_RESOLVED", typed: [], clicked: [] });
  expect(await flow({ protocolError: "Page.createIsolatedWorld" })).toEqual({ r: "THROW Page.createIsolatedWorld: protocol error", typed: [], clicked: [] });
});

test("typeInto sends no text when the page script throws", async () => {
  const sent: string[] = [];
  const send = async (method: string) => { sent.push(method); return { result: { result: { type: "object" }, exceptionDetails: { text: "Uncaught" } } }; };
  await expect(typeInto(send, 1, "userpw", "x")).rejects.toThrow("page script failed: Uncaught");
  expect(sent).toEqual(["Runtime.evaluate"]);
});

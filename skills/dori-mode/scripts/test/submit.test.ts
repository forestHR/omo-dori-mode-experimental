import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { writeFrozen } from "../src/frozen.ts";
import { SEND_CHUNK_BYTES, sendVerified, submitToPane, transcriptHas } from "../src/panes.ts";
import { editorText, type PaneKeys, SUBMIT_TIMING, submitText } from "../src/submit.ts";
import { announceChange } from "../src/update-announce.ts";
import { fakeClock, fakeRunner, newWorld, withState } from "./fakes.ts";

const BORDER = "────────────────────────────────────────";
const box = (...lines: string[]): string => ["transcript", BORDER, ...lines, BORDER, " ~/repo • main • 12K/1M"].join("\n");
const busyBox = (...lines: string[]): string => ["transcript", `── • Working (2s • esc to interrupt) ${BORDER}`, ...lines, BORDER, " ~/repo • main"].join("\n");
const PASTED = box("❯ [paste #1 +13 lines]");
const EMPTY = box("❯ ");
const RUNNING = busyBox("❯ ");

// screens are read in order, the last one repeats
const keysFor = (screens: readonly string[]) => {
  const log = { enters: 0, typed: [] as string[], reads: 0 };
  const keys: PaneKeys = {
    type: async (text) => { log.typed.push(text); return undefined; },
    enter: async () => { log.enters++; },
    read: async () => screens[Math.min(log.reads++, screens.length - 1)] ?? "",
    runsOmoCommands: true,
  };
  return { keys, log };
};

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

test("a paste-collapsed text left in the input box gets exactly one more Enter and is NOT_SUBMITTED", async () => {
  const { keys, log } = keysFor([PASTED]);
  const r = await submitText(keys, fakeClock(0), "line 1\nline 2");
  expect(r.status).toBe("NOT_SUBMITTED");
  expect(r.reason).toContain("[paste #1 +13 lines]");
  expect(log.enters).toBe(2);
});

test("a box that clears after the second Enter, with the turn running, is SUBMITTED", async () => {
  const { keys, log } = keysFor([...Array<string>(SUBMIT_TIMING.clearPolls).fill(PASTED), RUNNING]);
  expect(await submitText(keys, fakeClock(0), "line 1\nline 2")).toEqual({ status: "SUBMITTED", reason: "input box empty and the turn runs" });
  expect(log.enters).toBe(2);
});

test("an empty box without a running turn is NOT_SUBMITTED, even when the transcript quotes the busy mark", async () => {
  const quoted = ["omo prints esc to interrupt while it works", ...Array<string>(10).fill("transcript"), BORDER, "❯ ", BORDER].join("\n");
  const { keys, log } = keysFor([EMPTY, quoted]);
  const r = await submitText(keys, fakeClock(0), "hello");
  expect(r.status).toBe("NOT_SUBMITTED");
  expect(r.reason).toStartWith("input box empty but no running turn");
  expect(log.enters).toBe(1);
});

// omo empties the box with no running turn on screen two ways: a short turn that ends between screen reads (delivered), and
// a text typed while the main turn waits on its children, which omo queues undelivered (pingpong-analytics, 2026-10-31)
test("an empty box with no running turn on screen is SUBMITTED once the session's transcript has the text", async () => {
  const { keys } = keysFor([EMPTY]);
  let checks = 0;
  const r = await submitText({ ...keys, delivered: async () => ++checks >= 3 }, fakeClock(0), "[LEAD] hello");
  expect(r).toEqual({ status: "SUBMITTED", reason: "input box empty and the session's transcript has the text" });
});

test("a text omo took from the box but never put in the transcript stays NOT_SUBMITTED, and the reason says so", async () => {
  const { keys } = keysFor([EMPTY]);
  const r = await submitText({ ...keys, delivered: async () => false }, fakeClock(0), "[LEAD] hello");
  expect(r.status).toBe("NOT_SUBMITTED");
  expect(r.reason).toStartWith("input box empty but no running turn");
  expect(r.reason).toContain("the text is not in the session's transcript");
});

// A slash command runs in omo itself: no user message in the transcript (/goal pause writes nothing there at all), and omo
// rewrites its last status line in place, so a repeated /thinking low changes nothing on screen. Shaped after test pane w1:p17
// on 2026-11-03, where /thinking low applied but read NOT_SUBMITTED.
const slashTyped = (above: readonly string[], text: string) => [...above, BORDER, `❯ ${text}`, BORDER, " ~/qa • effort low"].join("\n");
const slashDone = (above: readonly string[]) => [...above, BORDER, "❯ ", BORDER, " ~/qa • effort low"].join("\n");

test("a command omo runs itself, typed into a box seen empty, is SUBMITTED once the box is empty again, with nothing else to show", async () => {
  const above = [" Update Available", " Thinking level: low"];
  for (const text of ["/thinking low", "/goal pause"]) {
    const { keys, log } = keysFor([slashDone(above), slashDone(above)]);
    const r = await submitText({ ...keys, delivered: async () => false }, fakeClock(0), text);
    expect(r).toEqual({ status: "SUBMITTED", reason: "input box empty: omo took the command from it to run it" });
    expect(log.enters).toBe(1);
  }
});

test("a command left in the box (startup still running) is NOT_SUBMITTED after 2 Enters", async () => {
  const { keys, log } = keysFor([slashDone([]), slashTyped([" Startup is still in progress"], "/thinking low")]);
  const r = await submitText(keys, fakeClock(0), "/thinking low");
  expect(r.status).toBe("NOT_SUBMITTED");
  expect(r.reason).toStartWith("text still in the input box after 2 Enters: /thinking low");
  expect(log.enters).toBe(2);
});

// review of #313: omo treats a skill, a prompt template and a command it does not know as ordinary input, which it can hold
test("a skill, a template or an unknown /text is no command omo runs: an emptied box alone is NOT_SUBMITTED", async () => {
  for (const text of ["/skill:review the diff", "/nosuchcmd qa", "/thinkingx low", "/settings now"]) {
    const { keys } = keysFor([slashDone([])]);
    const r = await submitText({ ...keys, delivered: async () => false }, fakeClock(0), text);
    expect(r.status).toBe("NOT_SUBMITTED");
    expect(r.reason).toContain("the text is not in the session's transcript");
  }
});

test("a screen that shows no input box (the pane went away, a read failed) does not count as an emptied box for a command", async () => {
  for (const screens of [[""], [slashDone([]), ""]]) {
    const { keys } = keysFor(screens);
    expect((await submitText({ ...keys, delivered: async () => false }, fakeClock(0), "/thinking low")).status).toBe("NOT_SUBMITTED");
  }
});

test("a pane that runs another agent gets no omo command shortcut: its emptied box alone is NOT_SUBMITTED", async () => {
  const { keys } = keysFor([slashDone([])]);
  const r = await submitText({ ...keys, runsOmoCommands: false }, fakeClock(0), "/goal pause");
  expect(r).toEqual({ status: "NOT_SUBMITTED", reason: `input box empty but no running turn ("esc to interrupt") within 15s` });
});

test("a command typed after a draft in the box is one ordinary message, so an emptied box alone is NOT_SUBMITTED", async () => {
  const { keys } = keysFor([slashTyped([], "owner draft"), slashDone([])]);
  expect((await submitText({ ...keys, delivered: async () => false }, fakeClock(0), "/thinking low")).status).toBe("NOT_SUBMITTED");
});

test("a text of more than one line that starts with a slash still needs a turn, the Steering queue or the transcript", async () => {
  const { keys } = keysFor([slashDone([])]);
  const r = await submitText({ ...keys, delivered: async () => false }, fakeClock(0), "/goal pause\nthen report");
  expect(r.status).toBe("NOT_SUBMITTED");
  expect(r.reason).toContain("the text is not in the session's transcript");
});

test("the transcript counts a user message with the text's first line from the send on, not an older one or the agent quoting it", () => {
  const line = (role: string, at: string, text: string) => JSON.stringify({ type: "message", timestamp: at, message: { role, content: [{ type: "text", text }] } });
  const text = "[LEAD] The lead moved to tmux session aoe_new\nsecond line";
  const since = Date.parse("2026-10-31T07:01:30Z");
  expect(transcriptHas(line("user", "2026-10-31T07:01:33Z", "[LEAD] The lead moved to tmux session aoe_new\nsecond line"), text, since)).toBe(true);
  expect(transcriptHas(line("user", "2026-10-31T06:59:00Z", "[LEAD] The lead moved to tmux session aoe_new"), text, since)).toBe(false);
  expect(transcriptHas(line("assistant", "2026-10-31T07:01:40Z", "[LEAD] The lead moved to tmux session aoe_new"), text, since)).toBe(false);
});

test("a text typed into a pane a handover froze goes to the session that replaced it, never into the frozen pane", async () => {
  // Given: the old lead was frozen and replaced, as on 2026-10-31 when a lane sent two reports into the frozen one
  const world = newWorld();
  world.screen = EMPTY;
  const config = { ...defaultConfig("/home/test"), backend: "aoe" as const, stateDir: state.dir, watchLog: join(state.dir, "lanes.log") };
  writeFrozen(state.dir, { pane: "aoe_lead_old", aoeId: "a", at: "2026-10-31T07:03:09Z", agentPid: 11, pids: [11], to: "aoe_lead_new" });
  // When
  const r = await submitToPane(fakeRunner(world), fakeClock(0), config, "aoe_lead_old", "[REPORT] demo | milestone | done");
  // Then
  expect(r).toMatchObject({ status: "SUBMITTED", pane: "aoe_lead_new" });
  const typedInto = world.calls.filter((c) => c[0] === "tmux" && c[1] === "send-keys").map((c) => c[c.indexOf("-t") + 1]);
  expect(typedInto.length).toBeGreaterThan(0);
  expect(typedInto.every((t) => t === "=aoe_lead_new:")).toBe(true);
  expect(await Bun.file(config.watchLog).text()).toContain("submit FORWARDED aoe_lead_old -> aoe_lead_new");
});

test("a pane whose agent is stopped (frozen mid-turn, its screen still showing the running turn) is NOT_SUBMITTED and nothing is typed", async () => {
  // Given: the frozen screen still shows esc to interrupt, as QA saw on a lead frozen during a turn
  const world = newWorld();
  world.screen = RUNNING;
  const base = fakeRunner(world);
  const run: typeof base = async (argv, opts) => (argv[0] === "ps" && argv[1] === "-A" ? { code: 0, out: "   11    10 Tl+  /home/u/.bun/bin/bun /x/senpi/dist/bundle/cli.js\n", err: "" } : base(argv, opts));
  const config = { ...defaultConfig("/home/test"), backend: "aoe" as const, stateDir: state.dir, watchLog: join(state.dir, "lanes.log") };
  // When
  const r = await submitToPane(run, fakeClock(0), config, "aoe_lead_old", "[REPORT] demo | milestone | done");
  // Then
  expect(r.status).toBe("NOT_SUBMITTED");
  expect(r.reason).toStartWith("the agent in the pane is stopped (pid 11, frozen)");
  expect(world.calls.some((c) => c[0] === "tmux" && c[1] === "send-keys")).toBe(false);
});

test("a pane whose agent runs as a background job of its shell (its stale ❯ prompt still showing) is NOT_SUBMITTED and nothing is typed", async () => {
  // Given: omo was left a background job (no + in its ps state) while its screen still shows an empty prompt
  const world = newWorld();
  world.screen = "❯ ";
  const base = fakeRunner(world);
  const run: typeof base = async (argv, opts) => (argv[0] === "ps" && argv[1] === "-A" ? { code: 0, out: "   11    10 Sl   /home/u/.bun/bin/bun /x/senpi/dist/bundle/cli.js\n", err: "" } : base(argv, opts));
  const config = { ...defaultConfig("/home/test"), backend: "aoe" as const, stateDir: state.dir, watchLog: join(state.dir, "lanes.log") };
  // When
  const r = await submitToPane(run, fakeClock(0), config, "aoe_lead_old", "[REPORT] demo | milestone | done");
  // Then: refused before typing (a later tick may send it again), and no key went to the shell
  expect(r.status).toBe("NOT_SUBMITTED");
  expect(r.reason).toBe("the agent in the pane is a background job of its shell (pid 11): its shell, not omo, would read the text, so it was not typed");
  expect(world.calls.some((c) => c[0] === "tmux" && c[1] === "send-keys")).toBe(false);
});

test("the text echoed in the transcript above the box is not unsent text", async () => {
  const echoed = ["❯ [paste #1 +13 lines]", busyBox("❯ ")].join("\n");
  const { keys, log } = keysFor([echoed]);
  expect((await submitText(keys, fakeClock(0), "line 1\nline 2")).status).toBe("SUBMITTED");
  expect(log.enters).toBe(1);
});

test("a tall box whose ❯ line scrolled out of view still counts as unsent text", () => {
  expect(editorText(box("line 12 of the announcement", "line 13 of the announcement"))).toBe("line 12 of the announcement line 13 of the announcement");
  expect(editorText(PASTED)).toBe("[paste #1 +13 lines]");
  expect(editorText(EMPTY)).toBe("");
});

// a 200-column senpi pane with its side panel from column 148, shaped after aoe_e7-beyond-eth_c16ae828 on 2026-10-15
const PANEL_AT = 148;
const row = (left: string, panel: string): string => left + " ".repeat(PANEL_AT - Bun.stringWidth(left)) + panel;
const paneled = (inBox: string, queued?: string): string => [
  row(" TPS 4657.5 tok/s. Cache hit 99.3%, 0.1s", "eval"),
  ...(queued ? [row("", "?? dig_smoke3_300.log"), row(` Steering: ${queued}`, "?? dig_smoke_300.log")] : []),
  `${"─".repeat(PANEL_AT)}eval`,
  row(inBox, "?? fp_clay_101.log"),
  `${"─".repeat(PANEL_AT)}FILES  143 changed · +135 more`,
  row(" Claude·cbaekdong ▕█████░░░░░░░░░▏ 35% 7d · resets 10/17 16:00", "?? .omo/"),
].join("\n");
const LEAD = "[LEAD] e7 stage A: pour more unless curled, then report the motion-bonus split";

test("side-panel text on the input box rows is not unsent text, and a Steering queue line of the sent text is SUBMITTED", async () => {
  expect(editorText(paneled("❯"))).toBe("");
  const { keys, log } = keysFor([paneled("❯", LEAD)]);
  expect(await submitText(keys, fakeClock(0), LEAD)).toEqual({ status: "SUBMITTED", reason: "input box empty and the text waits in the Steering queue" });
  expect(log.enters).toBe(1);
});

test("text left in the input box next to the side panel is still NOT_SUBMITTED, with only the box's text in the reason", async () => {
  const { keys, log } = keysFor([paneled("❯ [LEAD] half-typed report")]);
  const r = await submitText(keys, fakeClock(0), LEAD);
  expect(r).toEqual({ status: "NOT_SUBMITTED", reason: "text still in the input box after 2 Enters: [LEAD] half-typed report; left in the box" });
  expect(log.enters).toBe(2);
});

// dori-superagent issue #13: a prompt left in the box after its Enters failed sat there, and the next text was typed after it
const strandingPane = (before: string) => {
  const log = { clears: 0, enters: 0 };
  let inBox = before;
  const keys: PaneKeys = {
    type: async (text) => { inBox += text.split("\n").join(" "); return undefined; },
    enter: async () => { log.enters++; },
    read: async () => box(`❯ ${inBox}`),
    clear: async () => { log.clears++; inBox = ""; },
  };
  return { keys, log, inBox: () => inBox };
};

test("a text the Enters did not submit is cleared from a box that was empty before it, and is still NOT_SUBMITTED", async () => {
  const pane = strandingPane("");
  const r = await submitText(pane.keys, fakeClock(0), "[REPORT] demo | milestone | done");
  expect(r).toEqual({ status: "NOT_SUBMITTED", reason: "text still in the input box after 2 Enters: [REPORT] demo | milestone | done; cleared from the box" });
  expect(pane.log.clears).toBe(1);
  expect(pane.inBox()).toBe("");
});

test("a four-line text is cleared the way omo's ctrl+u works: one press empties a line, the next joins the line above", async () => {
  const lines: string[] = [""];
  let clears = 0;
  const keys: PaneKeys = {
    type: async (text) => { const [first = "", ...rest] = text.split("\n"); lines[lines.length - 1] += first; lines.push(...rest); return undefined; },
    enter: async () => {},
    read: async () => box(...lines.map((l, i) => (i === 0 ? `❯ ${l}` : `  ${l}`))),
    clear: async () => { clears++; if (lines.at(-1)) lines[lines.length - 1] = ""; else if (lines.length > 1) lines.pop(); },
  };
  const r = await submitText(keys, fakeClock(0), "[REPORT] demo | milestone | one\ntwo\nthree\nfour");
  expect(r.reason).toEndWith("; cleared from the box");
  expect(lines).toEqual([""]);
  expect(clears).toBe(7);
});

test("a box that already held other text is not cleared, so text that is not ours stays", async () => {
  const pane = strandingPane("owner draft ");
  const r = await submitText(pane.keys, fakeClock(0), "[REPORT] demo | milestone | done");
  expect(r.reason).toEndWith("; left in the box: it held other text before this one");
  expect(pane.log.clears).toBe(0);
  expect(pane.inBox()).toBe("owner draft [REPORT] demo | milestone | done");
});

test("a Steering line of another text does not count as the sent text", async () => {
  const { keys } = keysFor([paneled("❯", "[LEAD] an earlier message about something else")]);
  expect((await submitText(keys, fakeClock(0), LEAD)).reason).toStartWith("input box empty but no running turn");
});

test("NOT_SUBMITTED goes to the watch log with the pane and the reason", async () => {
  const world = newWorld();
  world.screen = PASTED;
  const config = { ...defaultConfig("/home/test"), backend: "aoe" as const, watchLog: join(state.dir, "lanes.log") };
  const r = await submitToPane(fakeRunner(world), fakeClock(0), config, "aoe_lead_0a1b2c3d", "[UPDATE] a\n\nb");
  expect(r.status).toBe("NOT_SUBMITTED");
  expect(await Bun.file(config.watchLog).text()).toContain("submit NOT_SUBMITTED aoe_lead_0a1b2c3d text still in the input box after 2 Enters: [paste #1 +13 lines]");
});

test("a text longer than tmux takes in one send-keys is typed in pieces, whole characters only, then submitted with one Enter", async () => {
  // Given: tmux refuses one send-keys argument over 16 KB, and a 28 KB Korean directive block like the one dori directives apply sent on 2026-10-19
  const world = newWorld();
  world.screen = EMPTY;
  const base = fakeRunner(world);
  const pieces: string[] = [];
  const run: typeof base = async (argv, opts) => {
    if (argv[0] === "tmux" && argv[1] === "send-keys" && argv.includes("-l")) {
      const text = argv.at(-1) ?? "";
      if (Buffer.byteLength(text) > 16_000) return { code: 1, out: "", err: "command too long" };
      pieces.push(text);
    }
    return base(argv, opts);
  };
  const config = { ...defaultConfig("/home/test"), backend: "aoe" as const, watchLog: join(state.dir, "lanes.log") };
  const text = `[LEAD] ${"가나다 라마바 사아자\n".repeat(1100)}끝`;
  // When
  const r = await submitToPane(run, fakeClock(0), config, "aoe_lane_0a1b2c3d", text);
  // Then
  expect(Buffer.byteLength(text)).toBeGreaterThan(28_000);
  expect(r.status).toBe("SUBMITTED");
  expect(pieces.join("")).toBe(text);
  expect(pieces.length).toBeGreaterThan(1);
  expect(pieces.every((p) => Buffer.byteLength(p) <= SEND_CHUNK_BYTES)).toBe(true);
  expect(world.calls.filter((c) => c[0] === "tmux" && c[1] === "send-keys" && c.at(-1) === "Enter").length).toBe(1);
});

test("an update announcement that stays in the lead's input box logs ANNOUNCE_FAIL, never ANNOUNCED", async () => {
  const world = newWorld();
  world.screen = PASTED;
  const config = { ...defaultConfig("/home/test"), backend: "aoe" as const, leadPane: "aoe_lead_0a1b2c3d", watchLog: join(state.dir, "lanes.log") };
  const run = fakeRunner(world);
  const clock = fakeClock(0);
  expect(await announceChange({ config, clock, print: () => {}, send: (pane, text) => sendVerified(run, clock, config, pane, text) }, { summary: "Guidance updated", files: ["skills/dori-mode/references/sessions.md"] })).toBe(false);
  const log = await Bun.file(config.watchLog).text();
  expect(log).toContain("update ANNOUNCE_FAIL aoe_lead_0a1b2c3d");
  expect(log).not.toContain("ANNOUNCED");
});

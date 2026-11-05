import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../setups/discord-aoe/dori-file-relay");
let root = "";
let homes = "";

// Three fake Dori accounts as folders; helpers run as the test user without sudo (DORI_FILE_RELAY_TEST_HOMES).
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dori-file-relay-"));
  homes = join(root, "homes");
  for (const a of ["za", "yo", "mo"]) mkdirSync(join(homes, a, `.${a}`), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "tmp"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const env = (extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  TMPDIR: join(root, "tmp"),
  DORI_FILE_RELAY_TEST_HOMES: homes,
  DORI_FILE_RELAY_STATE: join(root, "state"),
  DORI_FILE_RELAY_DORIS: "zzangdori=za:~/.za/inbox.jsonl yoodori=yo:~/.yo/inbox.jsonl moodori=mo:~/.mo/inbox.jsonl",
  DORI_FILE_RELAY_SETTLE_SEC: "0",
  DORI_FILE_RELAY_INTERVAL: "0",
  ...extra,
});

const run = async (args: string[], extra: Record<string, string> = {}) => {
  const p = Bun.spawn(["/usr/bin/python3", "-I", SCRIPT, ...args], { env: env(extra), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};
const serve = (cycles: number, extra: Record<string, string> = {}) => run(["--serve", "--cycles", String(cycles)], extra);

const home = (a: string, ...p: string[]) => join(homes, a, ...p);
const put = (path: string, body: string | Buffer) => {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { mode: 0o600 });
};
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const mode = (p: string) => statSync(p).mode & 0o777;
const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const lines = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const inbox = (a: string) => lines(home(a, `.${a}`, "inbox.jsonl"));
const relayLog = () => lines(join(root, "state", "relay.log"));

test("a file in to-<dori> reaches the other's inbox/from-<me>, wakes its lead once and moves to sent", async () => {
  expect((await serve(1)).code).toBe(0);
  expect(mode(home("mo", "outbox", "to-yoodori"))).toBe(0o700);
  expect(existsSync(home("mo", "outbox", "to-moodori"))).toBe(false);
  const body = `SECRET-MARKER-7731 ${"x".repeat(5000)}`;
  put(home("mo", "outbox", "to-yoodori", "deck", "a b.pdf"), body);

  expect((await serve(1)).code).toBe(0); // seen once: not yet steady
  expect(existsSync(home("yo", "inbox", "from-moodori"))).toBe(false);

  expect((await serve(2)).code).toBe(0);
  const got = home("yo", "inbox", "from-moodori", "deck", "a b.pdf");
  expect(sha(readFileSync(got))).toBe(sha(body));
  expect(mode(got)).toBe(0o600);
  expect(mode(home("yo", "inbox", "from-moodori"))).toBe(0o700);
  expect(mode(home("yo", "inbox", "from-moodori", "deck"))).toBe(0o700);
  expect(readdirSync(home("mo", "outbox", "to-yoodori", "deck"))).toEqual([]);
  expect(readFileSync(home("mo", "outbox", "sent", kst(), "to-yoodori", "deck", "a b.pdf"), "utf8")).toBe(body);

  const rows = inbox("yo");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "file-delivered", from: "moodori", to: "yoodori", path: "from-moodori/deck/a b.pdf", bytes: body.length, sha256: sha(body), replaced: false });
  const ok = relayLog().filter((r) => r.result === "ok");
  expect(ok).toHaveLength(1);
  expect(ok[0]).toMatchObject({ mode: "auto", from: "mo", to: "yo", sha256: sha(body), woke: true, sent_as: `sent/${kst()}/to-yoodori/deck/a b.pdf` });
  for (const f of [home("yo", ".yo", "inbox.jsonl"), join(root, "state", "relay.log")]) expect(readFileSync(f, "utf8")).not.toContain("SECRET-MARKER");

  expect((await serve(2)).code).toBe(0); // nothing is sent twice
  expect(inbox("yo")).toHaveLength(1);
  expect(inbox("za")).toHaveLength(0);
});

test("the subfolder a sent or set-aside file came from stays, so the next file can be copied into it", async () => {
  await serve(1);
  const dir = home("mo", "outbox", "to-yoodori", "nst", "case6");
  put(join(dir, "6.pdf"), "six");
  await serve(2);
  expect(readFileSync(home("yo", "inbox", "from-moodori", "nst", "case6", "6.pdf"), "utf8")).toBe("six");
  expect(readdirSync(dir)).toEqual([]);

  writeFileSync(join(dir, "7.pdf"), "seven", { mode: 0o600 }); // no mkdir: the folder the owner's Dori used before is still there
  symlinkSync("/etc/passwd", join(dir, "7-link"));
  await serve(2);
  expect(readFileSync(home("yo", "inbox", "from-moodori", "nst", "case6", "7.pdf"), "utf8")).toBe("seven");
  expect(readdirSync(dir)).toEqual([]);
  expect(existsSync(home("mo", "outbox", "to-yoodori", ".failed", "nst", "case6", "7-link.why"))).toBe(true);
});

test("a symlink, a hard link, a fifo and a file over the cap are set aside in .failed with the reason, never delivered", async () => {
  await serve(1);
  const to = home("mo", "outbox", "to-zzangdori");
  symlinkSync("/etc/passwd", join(to, "link"));
  put(join(to, "h1"), "hard");
  linkSync(join(to, "h1"), home("mo", "outbox", "h2"));
  expect((await Bun.spawn(["mkfifo", join(to, "pipe")]).exited)).toBe(0);
  put(join(to, "big.bin"), "y".repeat(64));

  expect((await serve(2, { DORI_FILE_RELAY_MAX_BYTES: "32" })).code).toBe(0);
  expect(existsSync(home("za", "inbox"))).toBe(false);
  expect(inbox("za")).toHaveLength(0);
  const why = (n: string) => JSON.parse(readFileSync(join(to, ".failed", `${n}.why`), "utf8")).reason;
  expect(why("link")).toBe("symlink");
  expect(why("h1")).toBe("hard-link");
  expect(why("pipe")).toBe("not-a-regular-file");
  expect(why("big.bin")).toBe("too-large");
  expect(readdirSync(to)).toEqual([".failed"]);
  expect(relayLog().filter((r) => r.result === "failed").map((r) => r.failed_as).sort()).toEqual([".failed/big.bin", ".failed/h1", ".failed/link", ".failed/pipe"]);
  mkdirSync(join(to, "sub", "deep"), { recursive: true });
  symlinkSync("/etc/passwd", join(to, "sub", "deep", "link2"));
  await serve(1);
  expect(relayLog().at(-1)).toMatchObject({ result: "failed", reason: "symlink", failed_as: ".failed/sub/deep/link2" });
  expect(existsSync(join(to, ".failed", "sub", "deep", "link2.why"))).toBe(true);
});

test("a file still open for writing, and a .part name, wait until the writer is done", async () => {
  await serve(1);
  const path = home("mo", "outbox", "to-yoodori", "rec.wav");
  put(home("mo", "outbox", "to-yoodori", "half.pdf.part"), "partial");
  const w = Bun.spawn(["/usr/bin/python3", "-c", "import sys; f = open(sys.argv[1], 'a'); f.write('one'); f.flush(); print('READY', flush=True); sys.stdin.read(); f.write('two'); f.close()", path], { stdin: "pipe", stdout: "pipe" });
  const reader = w.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("READY");

  await serve(3);
  expect(existsSync(home("yo", "inbox", "from-moodori", "rec.wav"))).toBe(false);

  w.stdin.end();
  expect(await w.exited).toBe(0);
  await serve(2);
  expect(readFileSync(home("yo", "inbox", "from-moodori", "rec.wav"), "utf8")).toBe("onetwo");
  expect(existsSync(home("yo", "inbox", "from-moodori", "half.pdf.part"))).toBe(false);
  expect(existsSync(home("mo", "outbox", "to-yoodori", "half.pdf.part"))).toBe(true);
});

test("the same name sent again replaces the receiver's copy and says so", async () => {
  await serve(1);
  const path = home("za", "outbox", "to-moodori", "brief.md");
  put(path, "v1");
  await serve(2);
  put(path, "v2 longer");
  await serve(2);
  expect(readFileSync(home("mo", "inbox", "from-zzangdori", "brief.md"), "utf8")).toBe("v2 longer");
  expect(inbox("mo").map((r) => [r.sha256, r.replaced])).toEqual([[sha("v1"), false], [sha("v2 longer"), true]]);
  const sent = readdirSync(home("za", "outbox", "sent", kst(), "to-moodori"));
  expect(sent).toHaveLength(2);
  expect(sent).toContain("brief.md");
});

test("by hand, one file still goes outbox to inbox and an existing dest still needs --replace", async () => {
  put(home("mo", "outbox", "deck.pdf"), "deck");
  const a = await run(["mo", "deck.pdf", "yo", "axmvp/"]);
  expect(a.code).toBe(0);
  expect(a.out).toBe(`RELAYED yo:${home("yo", "inbox", "axmvp", "deck.pdf")} bytes=4 sha256=${sha("deck")}\n`);
  expect(await run(["mo", "deck.pdf", "yo", "axmvp/"])).toMatchObject({ code: 3, out: "RELAY_REFUSED dest-exists\n" });
  expect((await run(["--replace", "mo", "deck.pdf", "yo", "axmvp/"])).code).toBe(0);
  expect(await run(["mo", "../yo/inbox/axmvp/deck.pdf", "za"])).toMatchObject({ code: 3, out: "RELAY_REFUSED path-escape\n" });
  expect(relayLog().map((r) => r.result)).toEqual(["ok", "refused", "ok", "refused"]);
});

test("a 3D package 12 folders deep is delivered; the 13th folder is set aside with the limit in its .why", async () => {
  await serve(1);
  const to = home("mo", "outbox", "to-yoodori");
  const urdf = ["excavator-video", "01_3d_assets", "hr35_e7_model", "third_party", "hr35_description", "meshes", "collision"];
  put(join(to, ...urdf, "boom.stl"), "boom");
  const twelve = ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10", "d11", "d12"];
  put(join(to, ...twelve, "deep.txt"), "deep");
  put(join(to, ...twelve, "d13", "too.txt"), "too");
  expect((await serve(2)).code).toBe(0);
  expect(readFileSync(home("yo", "inbox", "from-moodori", ...urdf, "boom.stl"), "utf8")).toBe("boom");
  expect(readFileSync(home("yo", "inbox", "from-moodori", ...twelve, "deep.txt"), "utf8")).toBe("deep");
  expect(existsSync(home("yo", "inbox", "from-moodori", ...twelve, "d13"))).toBe(false);
  const why = JSON.parse(readFileSync(join(to, ".failed", ...twelve, "d13.why"), "utf8"));
  expect(why).toMatchObject({ reason: "path-too-deep", max_depth: 12, path: [...twelve, "d13"].join("/") });
  expect(readFileSync(join(to, ".failed", ...twelve, "d13", "too.txt"), "utf8")).toBe("too");
  expect(relayLog().filter((r) => r.result === "failed")).toHaveLength(1);
});

test("DORI_FILE_RELAY_MAX_DEPTH sets the limit", async () => {
  await serve(1);
  const to = home("mo", "outbox", "to-yoodori");
  put(join(to, "a", "b", "ok.txt"), "ok");
  put(join(to, "a", "b", "c", "no.txt"), "no");
  expect((await serve(2, { DORI_FILE_RELAY_MAX_DEPTH: "2" })).code).toBe(0);
  expect(readFileSync(home("yo", "inbox", "from-moodori", "a", "b", "ok.txt"), "utf8")).toBe("ok");
  expect(JSON.parse(readFileSync(join(to, ".failed", "a", "b", "c.why"), "utf8"))).toMatchObject({ reason: "path-too-deep", max_depth: 2 });
});

test("a refusal that cannot be set aside is logged once, not on every scan, and set aside once it can be", async () => {
  await serve(1);
  const to = home("mo", "outbox", "to-yoodori");
  writeFileSync(join(to, ".failed"), "in the way", { mode: 0o600 });
  symlinkSync("/etc/passwd", join(to, "link"));
  expect((await serve(3)).code).toBe(0);
  const rows = relayLog().filter((r) => r.src === "mo:outbox/to-yoodori/link");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ result: "failed", reason: "symlink" });
  expect(rows[0].failed_move).toBeTruthy();
  rmSync(join(to, ".failed"));
  await serve(1);
  expect(JSON.parse(readFileSync(join(to, ".failed", "link.why"), "utf8")).reason).toBe("symlink");
});

test("a file that keeps failing to deliver, with .failed in the way, is logged as failed once and set aside once it can be", async () => {
  await serve(1);
  const to = home("mo", "outbox", "to-yoodori");
  writeFileSync(join(to, ".failed"), "in the way", { mode: 0o600 });
  put(join(to, "locked.pdf"), "locked");
  chmodSync(join(to, "locked.pdf"), 0o000); // the reader cannot open it: an error, not a refusal
  expect((await serve(7)).code).toBe(0);
  const rows = relayLog().filter((r) => r.src === "mo:outbox/to-yoodori/locked.pdf");
  expect(rows.map((r) => r.result)).toEqual(["error", "error", "failed"]);
  expect(rows[2].failed_move).toBeTruthy();
  rmSync(join(to, ".failed"));
  await serve(4);
  expect(JSON.parse(readFileSync(join(to, ".failed", "locked.pdf.why"), "utf8")).reason).toStartWith("error x3");
});

test("a refusal whose .failed move error names a fresh destination each scan is still logged once", async () => {
  await serve(1);
  const to = home("mo", "outbox", "to-yoodori");
  mkdirSync(join(to, ".failed"), { mode: 0o700 });
  writeFileSync(join(to, ".failed", "link"), "earlier", { mode: 0o600 });
  chmodSync(join(to, ".failed"), 0o500); // the move picks link-<time>-<random> and is denied
  symlinkSync("/etc/passwd", join(to, "link"));
  expect((await serve(3)).code).toBe(0);
  expect(relayLog().filter((r) => r.src === "mo:outbox/to-yoodori/link")).toHaveLength(1);
  chmodSync(join(to, ".failed"), 0o700);
  await serve(1);
  expect(readdirSync(join(to, ".failed")).filter((n) => n.startsWith("link-") && n.endsWith(".why"))).toHaveLength(1);
});

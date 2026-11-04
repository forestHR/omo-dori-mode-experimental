import { expect, test } from "bun:test";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";
import { DISCORD_FORM_SLACK, DISCORD_MESSAGE_MAX, type DiscordFile, discordMessageProblem } from "../src/messenger/upload-files.ts";

test("Discord CLI enables typing by default, skips it on request, and leaves edits alone", async () => {
  const state = withState();
  try {
    const results = [];
    for (const [i, extra] of [[], ["--no-typing"], ["--edit", "fake-message"]].entries()) {
      // a state dir per run: the same text twice in one would be a repeat (send-dedupe), not a second post
      results.push(await run(["env", `DORI_CONFIG=${join(state.dir, "missing.json")}`, `DORI_STATE_DIR=${join(state.dir, String(i))}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`, "DORI_DISCORD_TOKEN=fake",
        "bun", "--preload", join(import.meta.dir, "fixtures/discord-send-preload.ts"), join(import.meta.dir, "../src/cli.ts"), "send", "discord", "--to", "channel", "--thread", "thread", "--text", "hello", ...extra]));
    }
    expect(results.map((r) => ({ code: r.code, out: r.out }))).toEqual([
      { code: 0, out: `REQUEST typing\nREQUEST messages\n${receipt("SENT", "fake-message", "hello")}` },
      { code: 0, out: `REQUEST messages\n${receipt("SENT", "fake-message", "hello")}` },
      { code: 0, out: "REQUEST fake-message" },
    ]);
  } finally {
    state.done();
  }
});

for (const [text, ping, content] of [
  ["hello @everyone <@456>", "123", "<@123> hello @everyone <@456>"],
  ["hello <@123>", "123", "hello <@123>"],
  ["hello <@123>", undefined, "hello <@123>"],
] as const) {
  test(`Discord CLI request body with ping ${ping} and text ${text}`, async () => {
    const state = withState();
    try {
      const file = join(state.dir, "http.json");
      const result = await run(["env", `DORI_CONFIG=${join(state.dir, "missing.json")}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`, "DORI_DISCORD_TOKEN=fake", `DORI_TEST_HTTP=${file}`,
        "bun", "--preload", join(import.meta.dir, "discord-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"), "send", "discord", "--to", "channel", "--thread", "thread", "--text", text, "--no-typing", ...(ping === undefined ? [] : ["--ping", ping])]);
      expect({ code: result.code, out: result.out, calls: JSON.parse(readFileSync(file, "utf8")).calls }).toEqual({
        code: 0, out: receipt("SENT", "900", content), calls: [{ method: "POST", path: "/channels/thread/messages", body: { content, allowed_mentions: { parse: [], ...(ping === undefined ? {} : { users: [ping] }) } } }],
      });
    } finally {
      state.done();
    }
  });
}

test("Discord CLI sends to DORI_DISCORD_API when it is set (a Dori behind an egress gate), and to Discord when it is not", async () => {
  const seen: string[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => { seen.push(`${req.method} ${new URL(req.url).pathname} ${req.headers.get("authorization")}`); return Response.json({ id: "901" }); } });
  const state = withState();
  try {
    const base = ["env", `DORI_CONFIG=${join(state.dir, "missing.json")}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`, "DORI_DISCORD_TOKEN=fake"];
    const gated = await run([...base, `DORI_DISCORD_API=http://127.0.0.1:${server.port}/api/v10`, "bun", join(import.meta.dir, "../src/cli.ts"), "send", "discord", "--to", "channel", "--text", "hello", "--no-typing"]);
    const file = join(state.dir, "http.json");
    const direct = await run([...base, `DORI_STATE_DIR=${join(state.dir, "direct")}`, `DORI_TEST_HTTP=${file}`, "bun", "--preload", join(import.meta.dir, "discord-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"), "send", "discord", "--to", "channel", "--text", "hello", "--no-typing"]);
    expect({ gated: gated.out, seen, direct: direct.out, calls: JSON.parse(readFileSync(file, "utf8")).calls.map((c: { path: string }) => c.path) }).toEqual({
      // this fake answers no content: the line says so instead of guessing
      gated: "SENT 901 content=not-returned", seen: ["POST /api/v10/channels/channel/messages Bot fake"], direct: receipt("SENT", "900", "hello"), calls: ["/channels/channel/messages"],
    });
  } finally {
    server.stop(true);
    state.done();
  }
});

for (const ping of ["abc", "123x", "", " 123", "123\n"]) {
  test(`Discord CLI refuses invalid ping ${JSON.stringify(ping)} before HTTP`, async () => {
    const state = withState();
    try {
      const file = join(state.dir, "http.json");
      const result = await run(["env", `DORI_CONFIG=${join(state.dir, "missing.json")}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`, "DORI_DISCORD_TOKEN=fake", `DORI_TEST_HTTP=${file}`,
        "bun", "--preload", join(import.meta.dir, "discord-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"), "send", "discord", "--to", "channel", "--text", "hello", "--ping", ping]);
      expect({ code: result.code, sent: existsSync(file) }).toEqual({ code: 1, sent: false });
    } finally {
      state.done();
    }
  });
}

// 2026-10-19: "line one\nline two" in shell double quotes reached Discord as a backslash and an n (E7 thread 1561758859717115997)
const sendCli = async (dir: string, args: readonly string[]) => {
  const file = join(dir, "http.json");
  const r = await run(["env", `DORI_CONFIG=${join(dir, "missing.json")}`, `DORI_STATE_DIR=${dir}`, `DORI_ENV_FILE=${join(dir, "missing.env")}`, "DORI_DISCORD_TOKEN=fake", `DORI_TEST_HTTP=${file}`,
    "bun", "--preload", join(import.meta.dir, "discord-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"), ...args]);
  const calls = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).calls as { path: string; body?: { content?: string } }[]) : [];
  return { code: r.code, out: r.out, err: r.err, posted: calls.filter((c) => c.path.endsWith("/messages")).map((c) => c.body?.content) };
};

for (const args of [
  ["send", "discord", "--to", "channel", "--no-typing", "--text", "E7 끝났어\\n남은 건 없어"],
  ["thread", "reply", "discord:300000000000000003", "E7 끝났어\\n남은 건 없어"],
  ["thread", "done", "discord:300000000000000003", "E7 끝났어\\n남은 건 없어"],
]) {
  test(`${args.slice(0, 2).join(" ")} refuses a literal \\n with no real line break before anything is sent (SEND_LITERAL_NEWLINE)`, async () => {
    const state = withState();
    try {
      const r = await sendCli(state.dir, args);
      expect({ code: r.code, refused: r.err.includes("SEND_LITERAL_NEWLINE") && r.err.includes("--text-file FILE"), posted: r.posted }).toEqual({ code: 2, refused: true, posted: [] });
    } finally {
      state.done();
    }
  });
}

test("a literal \\n inside code, or beside real line breaks, is sent as written", async () => {
  const state = withState();
  try {
    const texts = ["split it with `printf 'a\\nb'`", "```\nprintf 'a\\nb'\n```", "first line\nthen a \\n in the second"];
    const out = [];
    for (const text of texts) out.push(await sendCli(state.dir, ["send", "discord", "--to", "channel", "--no-typing", "--text", text]));
    expect(out.map((r) => r.code)).toEqual([0, 0, 0]);
    expect(out.at(-1)?.posted).toEqual(texts);
  } finally {
    state.done();
  }
});

test("send --text-file posts the file's text with its real line breaks, like --text; both at once are refused", async () => {
  const state = withState();
  try {
    const file = join(state.dir, "post.txt");
    await Bun.write(file, "E7 끝났어\n남은 건 없어\n");
    const sent = await sendCli(state.dir, ["send", "discord", "--to", "channel", "--no-typing", "--text-file", file]);
    expect({ code: sent.code, out: sent.out, posted: sent.posted }).toEqual({ code: 0, out: receipt("SENT", "900", "E7 끝났어\n남은 건 없어"), posted: ["E7 끝났어\n남은 건 없어"] });
    const both = await sendCli(state.dir, ["send", "discord", "--to", "channel", "--no-typing", "--text-file", file, "--text", "x"]);
    expect(both.code).toBe(1);
  } finally {
    state.done();
  }
});

// 2026-10-20 "왜 두번씩 말해!": one reply of the lead carried two identical `dori send` calls that ran at once, and the
// owner's thread got the message twice (1561976241102397613, 1561976244944248883). The server counts real POSTs.
const discordServer = (status = 200) => {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (!path.endsWith("/messages")) return Response.json({});
    posts.push({ path, body: await req.json() as Record<string, unknown> });
    // a slow Discord keeps two senders started together inside one another's send
    await Bun.sleep(300);
    // as Discord does: the created message comes back with the content it holds
    return status === 200 ? Response.json({ id: String(posts.length), content: posts.at(-1)?.body.content }) : new Response("{}", { status });
  } });
  return { posts, server, stop: () => server.stop(true) };
};
const sendTo = (dir: string, port: number | undefined, args: readonly string[]) =>
  run(["env", `DORI_CONFIG=${join(dir, "missing.json")}`, `DORI_STATE_DIR=${dir}`, `DORI_ENV_FILE=${join(dir, "missing.env")}`, "DORI_DISCORD_TOKEN=fake",
    `DORI_DISCORD_API=http://127.0.0.1:${port}/api/v10`, "bun", join(import.meta.dir, "../src/cli.ts"), "send", "discord", "--no-typing", ...args]);
const SAME = ["--to", "1561963113488842792", "--reply", "1561976021270396959", "--text", "시험 레인 열게"];

// the receipt a post prints: the content the API answered, not the text the caller meant
const receipt = (verb: string, id: string, content: string) =>
  `${verb} ${id} len=${[...content].length} sha=${createHash("sha256").update(content).digest("hex").slice(0, 8)} first=${JSON.stringify([...content].slice(0, 40).join(""))}`;
const word2 = (out: string) => out.split(" ").slice(0, 2).join(" ");
const PLACE = "discord:1561963113488842792";

test("the same send twice posts once; the second names the place and the first message's id and exits 3", async () => {
  const state = withState();
  const d = discordServer();
  try {
    const first = await sendTo(state.dir, d.server.port, SAME);
    const second = await sendTo(state.dir, d.server.port, SAME);
    expect({ first: first.out, code: second.code, second: second.out.split(": ")[0], posts: d.posts.length }).toEqual({ first: receipt("SENT", "1", "시험 레인 열게"), code: 3, second: `SEND_DUPLICATE ${PLACE} 1`, posts: 1 });
  } finally {
    d.stop();
    state.done();
  }
});

test("two identical sends started together post once and both name that one message", async () => {
  const state = withState();
  const d = discordServer();
  try {
    const both = await Promise.all([sendTo(state.dir, d.server.port, SAME), sendTo(state.dir, d.server.port, SAME)]);
    expect({ codes: both.map((r) => r.code).sort(), outs: both.map((r) => word2(r.out.split(": ")[0] ?? "")).sort(), posts: d.posts.length }).toEqual({ codes: [0, 3], outs: ["SEND_DUPLICATE discord:1561963113488842792", "SENT 1"], posts: 1 });
  } finally {
    d.stop();
    state.done();
  }
});

test("another text, place or reply target, and --again, each post", async () => {
  const state = withState();
  const d = discordServer();
  try {
    const outs = [];
    for (const args of [SAME, [...SAME.slice(0, 5), "다른 글"], ["--to", "1561963113488842790", ...SAME.slice(2)], [...SAME.slice(0, 2), "--reply", "1561976021270396950", ...SAME.slice(4)], [...SAME, "--again"]]) outs.push(word2((await sendTo(state.dir, d.server.port, args)).out));
    expect({ outs, posts: d.posts.length }).toEqual({ outs: ["SENT 1", "SENT 2", "SENT 3", "SENT 4", "SENT 5"], posts: 5 });
  } finally {
    d.stop();
    state.done();
  }
});

// https://github.com/sisyphuslabs/dori-superagent/issues/88: a call refused by a hook left the earlier text in a kernel
// variable, a later call sent that variable 7 and 15 minutes after the first post, and the new id was taken as proof the
// new text went out. The repeat window was 10 minutes, so both re-posts went through.
const ageMarks = (dir: string, minutes: number) => {
  for (const name of readdirSync(join(dir, "sent")).filter((n) => n.endsWith(".json"))) {
    const path = join(dir, "sent", name);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), at: Date.now() - minutes * 60_000 }));
  }
};

test("the text of the place's last post is a repeat at any age (SEND_DUPLICATE, exit 3); --again posts it", async () => {
  const state = withState();
  const d = discordServer();
  try {
    await sendTo(state.dir, d.server.port, SAME);
    ageMarks(state.dir, 7 * 24 * 60);
    const later = await sendTo(state.dir, d.server.port, SAME);
    const again = await sendTo(state.dir, d.server.port, [...SAME, "--again"]);
    expect({ code: later.code, out: later.out.split(": ")[0], again: [again.code, word2(again.out)], posts: d.posts.length }).toEqual({ code: 3, out: `SEND_DUPLICATE ${PLACE} 1`, again: [0, "SENT 2"], posts: 2 });
  } finally {
    d.stop();
    state.done();
  }
});

// review 8 of #338: "hello" with --ping and "<@ID> hello" with the same --ping go out as one message, so the second is
// the repeat
test("the same outgoing message from equivalent inputs (a --ping already in the text) is the repeat", async () => {
  const state = withState();
  const d = discordServer();
  const to = ["--to", "1561963113488842792", "--ping", "1561000000000000001"];
  try {
    await sendTo(state.dir, d.server.port, [...to, "--text", "hello"]);
    ageMarks(state.dir, 11);
    const same = await sendTo(state.dir, d.server.port, [...to, "--text", "<@1561000000000000001> hello"]);
    expect({ code: same.code, out: same.out.split(": ")[0], posts: d.posts.length }).toEqual({ code: 3, out: `SEND_DUPLICATE ${PLACE} 1`, posts: 1 });
  } finally {
    d.stop();
    state.done();
  }
});

// review 10 of #338: thread reply posts its text without emoji, so its repeat check keys that text: "Finished 🎉" in a
// thread and then "Finished" to the same thread is one message, within the 10 minutes and after them
test("a thread reply with emoji and the same text without them, sent to that thread, is the repeat at any age", async () => {
  const state = withState();
  try {
    const ref = "discord:300000000000000003";
    const reply = await sendCli(state.dir, ["thread", "reply", ref, "Finished \u{1F389}"]);
    const soon = await sendCli(state.dir, ["send", "discord", "--to", "300000000000000003", "--no-typing", "--text", "Finished"]);
    ageMarks(state.dir, 11);
    const later = await sendCli(state.dir, ["thread", "reply", ref, "Finished"]);
    expect({ codes: [reply.code, soon.code, later.code], soon: soon.out.split(": ")[0], later: later.out.split(": ")[0], posted: later.posted }).toEqual({
      codes: [0, 3, 3], soon: "SEND_DUPLICATE discord:300000000000000003 900", later: "SEND_DUPLICATE discord:300000000000000003 900", posted: ["Finished"],
    });
  } finally {
    state.done();
  }
});

// review 10 of #338: thread reply sets the thread's status after its post; a status step held past the claim's minute
// must not let the same reply post again, so the post is recorded before the status step starts
test("a thread reply whose status step is held still counts as posted: the same reply meanwhile is the repeat", async () => {
  const state = withState();
  const posts: string[] = [];
  let inStatus: () => void = () => {};
  const statusHeld = new Promise<void>((r) => (inStatus = r));
  let release: () => void = () => {};
  const released = new Promise<void>((r) => (release = r));
  let heldOne = false;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (req.method === "POST" && path.endsWith("/messages")) {
      const body = (await req.json()) as { content: string };
      posts.push(body.content);
      return Response.json({ id: String(posts.length), content: body.content });
    }
    // the first command's status step reads the thread first: that one read is held until the test lets it go, and the
    // test goes on only once the first command is inside it (its post answered, its status step started)
    if (req.method === "GET" && posts.length && !heldOne) {
      heldOne = true;
      inStatus();
      await released;
    }
    return Response.json({});
  } });
  const reply = () => run(["env", `DORI_CONFIG=${join(state.dir, "missing.json")}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`, "DORI_DISCORD_TOKEN=fake",
    `DORI_DISCORD_API=http://127.0.0.1:${server.port}/api/v10`, "bun", join(import.meta.dir, "../src/cli.ts"), "thread", "reply", "discord:300000000000000004", "same words"]);
  try {
    const first = reply();
    await statusHeld;
    // the first command is past its post and inside its status step; its claim is now older than the takeover minute
    ageMarks(state.dir, 2);
    const second = await reply();
    release();
    await first;
    expect({ code: second.code, out: second.out.split(": ")[0], posts }).toEqual({ code: 3, out: "SEND_DUPLICATE discord:300000000000000004 1", posts: ["same words"] });
  } finally {
    release();
    server.stop(true);
    state.done();
  }
});

test("an older text after the 10 minutes is no repeat once another post came after it; within them it still is", async () => {
  const state = withState();
  const d = discordServer();
  const other = [...SAME.slice(0, 5), "다른 글"];
  try {
    const outs = [];
    for (const args of [SAME, other]) outs.push(word2((await sendTo(state.dir, d.server.port, args)).out));
    const soon = await sendTo(state.dir, d.server.port, SAME);
    ageMarks(state.dir, 11);
    outs.push(word2((await sendTo(state.dir, d.server.port, SAME)).out));
    expect({ outs, soon: [soon.code, soon.out.split(": ")[0]], posts: d.posts.length }).toEqual({ outs: ["SENT 1", "SENT 2", "SENT 3"], soon: [3, `SEND_DUPLICATE ${PLACE} 1`], posts: 3 });
  } finally {
    d.stop();
    state.done();
  }
});

test("SENT prints the length, sha and start of the content the API answered, not of the text asked for", async () => {
  const state = withState();
  const long = `${"가".repeat(45)} "q"\nline`;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ id: "1566900000000000007", content: long }) });
  try {
    const r = await sendTo(state.dir, server.port, ["--to", "1", "--text", "what the caller meant"]);
    expect({ code: r.code, out: r.out }).toEqual({ code: 0, out: `SENT 1566900000000000007 len=54 sha=${createHash("sha256").update(long).digest("hex").slice(0, 8)} first="${"가".repeat(40)}"` });
  } finally {
    server.stop(true);
    state.done();
  }
});

test("--reply makes the post a reply to that message, without pinging its author; a non-digit id is refused before HTTP", async () => {
  const state = withState();
  const d = discordServer();
  try {
    await sendTo(state.dir, d.server.port, SAME);
    const bad = await sendTo(state.dir, d.server.port, ["--to", "1", "--reply", "abc", "--text", "x"]);
    expect({ body: d.posts[0]?.body, bad: bad.code, posts: d.posts.length }).toEqual({
      body: { content: "시험 레인 열게", allowed_mentions: { parse: [] }, message_reference: { message_id: "1561976021270396959", fail_if_not_exists: false } }, bad: 1, posts: 1,
    });
  } finally {
    d.stop();
    state.done();
  }
});

test("a send that failed leaves no mark, so sending it again goes out", async () => {
  const state = withState();
  const down = discordServer(403);
  const up = discordServer();
  try {
    const failed = await sendTo(state.dir, down.server.port, SAME);
    const retry = await sendTo(state.dir, up.server.port, SAME);
    expect({ failed: failed.code, retry: retry.out, posts: up.posts.length }).toEqual({ failed: 1, retry: receipt("SENT", "1", "시험 레인 열게"), posts: 1 });
  } finally {
    down.stop();
    up.stop();
    state.done();
  }
});

for (const [why, args] of [["an unknown option", ["--rply", "1561976021270396959"]], ["a stray word", ["extra"]]] as const) {
  test(`send refuses ${why} instead of dropping it, and sends nothing (UNKNOWN_OPTION)`, async () => {
    const state = withState();
    const d = discordServer();
    try {
      const r = await sendTo(state.dir, d.server.port, [...SAME, ...args]);
      expect({ code: r.code, refused: r.err.includes("UNKNOWN_OPTION send"), posts: d.posts.length }).toEqual({ code: 2, refused: true, posts: 0 });
    } finally {
      d.stop();
      state.done();
    }
  });
}

test("thread reply twice posts once, a done with the same words is not posted again but still closes, and send to that thread is the same message", async () => {
  const state = withState();
  try {
    const ref = "discord:300000000000000003";
    const reply = await sendCli(state.dir, ["thread", "reply", ref, "끝났어"]);
    const again = await sendCli(state.dir, ["thread", "reply", ref, "끝났어"]);
    const done = await sendCli(state.dir, ["thread", "done", ref, "끝났어"]);
    const send = await sendCli(state.dir, ["send", "discord", "--to", "300000000000000003", "--no-typing", "--text", "끝났어"]);
    expect({ outs: [reply.out, again.out.split(": ")[0], done.out.split(": ")[0], done.out.endsWith(" THREAD_DONE"), send.out.split(": ")[0]], codes: [reply.code, again.code, done.code, send.code], posted: send.posted }).toEqual({
      outs: [receipt("POSTED", "900", "끝났어"), "SEND_DUPLICATE discord:300000000000000003 900", "SEND_DUPLICATE discord:300000000000000003 900", true, "SEND_DUPLICATE discord:300000000000000003 900"],
      // a done with the words of the last reply still closes the thread, so it exits 0; reply and send post nothing and say so
      codes: [0, 3, 0, 3], posted: ["끝났어"],
    });
  } finally {
    state.done();
  }
});

// 2026-10-20 a lane's progress post "…결과 카드를 여기 올릴게요." went to the owner's thread from a Dori that talks to him in 반말
// (owner "얘는 왜 말투 안 바꼈냐?"): send, thread and ask refuse 존댓말 for the owner's channel, its threads and the DM
const speechCli = async (dir: string, args: readonly string[], parent = "500") => {
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ discord: { locale: "ko-KR" } }));
  const file = join(dir, "http.json");
  const r = await run(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${dir}`, `DORI_ENV_FILE=${join(dir, "missing.env")}`, "DORI_DISCORD_TOKEN=fake", `DORI_TEST_HTTP=${file}`,
    "DORI_DISCORD_CHANNEL=500", "DORI_DISCORD_PAIR_CHANNEL=600", `DORI_TEST_THREAD_PARENT=${parent}`,
    "bun", "--preload", join(import.meta.dir, "discord-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"), ...args]);
  const calls = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).calls as { method: string; path: string; body?: { content?: string } }[]) : [];
  return { code: r.code, out: r.out, refused: r.err.includes("SPEECH_REFUSED") && r.err.includes("반말") && r.err.includes("nothing was sent"), posted: calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages")).map((c) => c.body?.content) };
};

const POLITE = "E7 평가 끝나면 결과 카드를 여기 올릴게요.";
for (const [name, args, parent] of [
  ["thread reply in a thread of the owner's channel", ["thread", "reply", "discord:300000000000000003", POLITE], "500"],
  ["thread wait in a thread of the owner's channel", ["thread", "wait", "discord:300000000000000003", POLITE], "500"],
  ["thread done in a thread of the owner's channel", ["thread", "done", "discord:300000000000000003", POLITE], "500"],
  ["send to a thread of the owner's channel", ["send", "discord", "--to", "300000000000000003", "--no-typing", "--text", POLITE], "500"],
  ["send --status working to the owner's channel", ["send", "discord", "--to", "500", "--status", "working", "--no-typing", "--text", POLITE], "500"],
  ["ask", ["ask", "--text", "E7 세션을 새로 켜도 될까요?", "--option", "켜", "--option", "그대로 둬"], "500"],
  ["a ~습니까 question", ["thread", "reply", "discord:300000000000000003", "E7 결과 카드 확인하셨습니까?"], "500"],
  ["a ~ㅂ니까 question", ["thread", "reply", "discord:300000000000000003", "그 문서는 누가 정리합니까?"], "500"],
] as const) {
  test(`${name}: 존댓말 for a 반말 owner is refused before anything is sent (SPEECH_REFUSED)`, async () => {
    const state = withState();
    try {
      expect(await speechCli(state.dir, args, parent)).toMatchObject({ code: 2, refused: true, posted: [] });
    } finally {
      state.done();
    }
  });
}

for (const [name, args, parent, out] of [
  ["반말 in the owner's thread", ["thread", "reply", "discord:300000000000000003", "E7 평가 끝나면 결과 카드 여기 올릴게."], "500", "POSTED 900"],
  // 2026-10-20 17:25Z the lead's 반말 answer "…그건 유돌 몫이니까." was refused as 존댓말: ~니까 after a syllable without ㅂ is 반말
  ["반말 ending in ~니까, ~거든, ~잖아 and ~네", ["thread", "reply", "discord:300000000000000003", "맞아, 문서는 대부분 메일 첨부나 드라이브로 오고 그건 유돌 몫이니까.\n어제 이미 보냈거든.\n그건 형도 알잖아.\n벌써 끝났네."], "500", "POSTED 900"],
  ["존댓말 in the pair channel", ["send", "discord", "--to", "600", "--no-typing", "--text", POLITE], "500", "SENT 900"],
  ["존댓말 in a thread of another channel", ["thread", "reply", "discord:300000000000000003", POLITE], "777", "POSTED 900"],
  ["a quoted 존댓말 line and code under the Dori's own 반말", ["thread", "reply", "discord:300000000000000003", "공돌 말 그대로 옮길게\n> 결과 카드를 여기 올릴게요.\n`올릴게요.`"], "500", "POSTED 900"],
] as const) {
  test(`${name} is sent`, async () => {
    const state = withState();
    try {
      const r = await speechCli(state.dir, args, parent);
      expect({ ...r, out: word2(r.out) }).toMatchObject({ code: 0, out, refused: false, posted: [args.at(-1)] });
    } finally {
      state.done();
    }
  });
}

// 2026-11-03: the owner wants OkDori to put the AX-MVP deck (pptx, PDF) and demo video into Slack itself; send had no
// --file, so Slack.upload had no caller and the Dori could only post a Drive link
const fakeSlack = (complete = 200, during: { upload?: () => void } = {}) => {
  const calls: { path: string; body: unknown }[] = [];
  let slots = 0;
  let port = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/up/")) {
        const bytes = new Uint8Array(await req.arrayBuffer());
        calls.push({ path, body: new TextDecoder().decode(bytes) });
        return new Response("OK");
      }
      // as Slack does: files.getUploadURLExternal reads form fields only and answers a JSON body invalid_arguments
      const form = (req.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded");
      const body = (form ? Object.fromEntries(new URLSearchParams(await req.text())) : await req.json().catch(() => ({}))) as Record<string, unknown>;
      calls.push({ path, body });
      if (path === "/api/files.getUploadURLExternal" && !form) return Response.json({ ok: false, error: "invalid_arguments" });
      if (path === "/api/files.getUploadURLExternal") return Response.json({ ok: true, upload_url: `http://127.0.0.1:${port}/up/${++slots}`, file_id: `F${slots}` });
      if (path === "/api/files.completeUploadExternal") during.upload?.();
      if (path === "/api/files.completeUploadExternal") return complete === 200 ? Response.json({ ok: true, files: body.files }) : new Response("unavailable", { status: complete });
      if (path === "/api/chat.postMessage") return Response.json({ ok: true, channel: body.channel, ts: "1700000100.000100", message: { text: body.text } });
      if (path === "/api/reactions.remove") return Response.json({ ok: true });
      return Response.json({ ok: false, error: "unknown_method" });
    },
  });
  port = server.port ?? 0;
  return { calls, server };
};
const slackCli = (dir: string, port: number | undefined, args: readonly string[]) =>
  run(["env", `DORI_CONFIG=${join(dir, "missing.json")}`, `DORI_STATE_DIR=${dir}`, `DORI_ENV_FILE=${join(dir, "missing.env")}`, "DORI_SLACK_TOKEN=xoxb-fake", "DORI_DISCORD_TOKEN=fake", `DORI_SLACK_API=http://127.0.0.1:${port}/api`,
    "bun", join(import.meta.dir, "../src/cli.ts"), "send", ...args]);

test("slack: SENT prints the text Slack answered; the channel's last text again is a repeat at any age, another thread is another place", async () => {
  const state = withState();
  const { calls, server } = fakeSlack();
  try {
    const post = ["slack", "--to", "C1", "--text", "배포 끝났어"];
    const first = await slackCli(state.dir, server.port, post);
    ageMarks(state.dir, 60);
    const later = await slackCli(state.dir, server.port, post);
    const thread = await slackCli(state.dir, server.port, [...post, "--thread", "1700000000.000001"]);
    expect({ outs: [first.out, later.out.split(": ")[0], word2(thread.out)], codes: [first.code, later.code, thread.code], posts: calls.filter((c) => c.path === "/api/chat.postMessage").length }).toEqual({
      outs: [receipt("SENT", "1700000100.000100", "배포 끝났어"), "SEND_DUPLICATE slack:C1 1700000100.000100", "SENT 1700000100.000100"], codes: [0, 3, 0], posts: 2,
    });
  } finally {
    server.stop(true);
    state.done();
  }
});

test("send slack --file uploads every file to its own URL, then shares them as one message with the text in the thread", async () => {
  const during: { upload?: () => void } = {};
  const { calls, server } = fakeSlack(200, during);
  const state = withState();
  try {
    writeFileSync(join(state.dir, "deck.pdf"), "pdf bytes");
    writeFileSync(join(state.dir, "demo.mp4"), "video");
    // the owner's message the watcher put eyes on: a share answers it like a text answer (OkDori answered the owner with
    // a file share and the eyes stayed, 2026-11-03)
    mkdirSync(join(state.dir, "discord"));
    writeFileSync(join(state.dir, "discord", "inbox.jsonl"), `${JSON.stringify({ scope: "slack", id: "1700000000.000001", channel_id: "C1", reply_thread: "1700000000.000001", addressed: "mention" })}\n`);
    const r = await slackCli(state.dir, server.port, ["slack", "--to", "C1", "--file", join(state.dir, "deck.pdf"), "--file", join(state.dir, "demo.mp4"), "--text", "AX-MVP 발표자료", "--thread", "1700000000.000001"]);
    expect({ code: r.code, out: r.out, calls }).toEqual({
      code: 0, out: "SENT F1,F2", calls: [
        { path: "/api/files.getUploadURLExternal", body: { filename: "deck.pdf", length: "9" } },
        { path: "/up/1", body: "pdf bytes" },
        { path: "/api/files.getUploadURLExternal", body: { filename: "demo.mp4", length: "5" } },
        { path: "/up/2", body: "video" },
        { path: "/api/files.completeUploadExternal", body: { files: [{ id: "F1", title: "deck.pdf" }, { id: "F2", title: "demo.mp4" }], channel_id: "C1", thread_ts: "1700000000.000001", initial_comment: "AX-MVP 발표자료" } },
        { path: "/api/reactions.remove", body: { channel: "C1", timestamp: "1700000000.000001", name: "eyes" } },
      ],
    });
    // a file alone needs no text; the message answered once is not asked about again by a later share or text answer
    const bare = await slackCli(state.dir, server.port, ["slack", "--to", "C1", "--file", join(state.dir, "demo.mp4")]);
    const text = await slackCli(state.dir, server.port, ["slack", "--to", "C1", "--thread", "1700000000.000001", "--text", "자료 올렸어"]);
    expect({ bare: bare.out, share: calls[8]?.body, text: text.out, after: calls.slice(9) }).toEqual({
      bare: "SENT F3", share: { files: [{ id: "F3", title: "demo.mp4" }], channel_id: "C1" }, text: receipt("SENT", "1700000100.000100", "자료 올렸어"), after: [
        { path: "/api/chat.postMessage", body: { channel: "C1", text: "자료 올렸어", thread_ts: "1700000000.000001" } },
      ],
    });
    // a share in the channel itself answers the channel message before it; one that arrives during the upload is not,
    // even with a ts older than the host clock (a host clock ahead of Slack's, review of #285)
    const row = (id: string) => JSON.stringify({ scope: "slack", id, channel_id: "C1", thread_ts: null, reply_thread: id, addressed: "name" });
    writeFileSync(join(state.dir, "discord", "inbox.jsonl"), `${row("1700000000.000050")}\n`, { flag: "a" });
    during.upload = () => writeFileSync(join(state.dir, "discord", "inbox.jsonl"), `${row("1700000000.000060")}\n`, { flag: "a" });
    await slackCli(state.dir, server.port, ["slack", "--to", "C1", "--file", join(state.dir, "demo.mp4")]);
    expect(calls.filter((c) => c.path === "/api/reactions.remove").map((c) => (c.body as { timestamp: string }).timestamp)).toEqual(["1700000000.000001", "1700000000.000050"]);
  } finally {
    server.stop(true);
    state.done();
  }
});

test("a share Slack answers 5xx is not retried: the send fails and nothing is shared a second time", async () => {
  const { calls, server } = fakeSlack(503);
  const state = withState();
  try {
    writeFileSync(join(state.dir, "deck.pdf"), "pdf bytes");
    const r = await slackCli(state.dir, server.port, ["slack", "--to", "C1", "--file", join(state.dir, "deck.pdf"), "--text", "발표자료"]);
    expect({ failed: r.code !== 0 && !r.out.includes("SENT"), shares: calls.filter((c) => c.path === "/api/files.completeUploadExternal").length }).toEqual({ failed: true, shares: 1 });
  } finally {
    server.stop(true);
    state.done();
  }
});

test("send --file refuses a missing, empty, too big or non-regular file, more than 10 files, --again, other platforms and --edit before any request", async () => {
  const { calls, server } = fakeSlack();
  const state = withState();
  try {
    const ok = join(state.dir, "ok.txt");
    writeFileSync(ok, "x");
    writeFileSync(join(state.dir, "empty.txt"), "");
    mkdirSync(join(state.dir, "folder"));
    writeFileSync(join(state.dir, "big.bin"), "");
    truncateSync(join(state.dir, "big.bin"), 1024 ** 3 + 1); // sparse: over Slack's 1 GB without the disk space
    const cases: [string, string[]][] = [
      ["SEND_FILE_MISSING", ["slack", "--to", "C1", "--file", ok, "--file", join(state.dir, "nope.pptx")]],
      ["SEND_FILE_REFUSED", ["slack", "--to", "C1", "--file", join(state.dir, "empty.txt")]],
      ["SEND_FILE_REFUSED", ["slack", "--to", "C1", "--file", join(state.dir, "folder")]],
      ["SEND_FILE_TOO_BIG", ["slack", "--to", "C1", "--file", join(state.dir, "big.bin")]],
      ["SEND_FILE_REFUSED", ["slack", "--to", "C1", ...Array.from({ length: 11 }, () => ["--file", ok]).flat()]],
      ["SEND_FILE_REFUSED", ["slack", "--to", "C1", "--file", ""]],
      ["SEND_FILE_REFUSED", ["slack", "--to", "C1", "--file", ok, "--again"]],
      ["SEND_FILE_REFUSED", ["telegram", "--to", "1", "--file", ok, "--text", "x"]],
      ["SEND_FILE_REFUSED", ["slack", "--to", "C1", "--edit", "1.2", "--file", ok, "--text", "x"]],
    ];
    const got = [];
    for (const [, args] of cases) {
      const r = await slackCli(state.dir, server.port, args);
      got.push({ code: r.code, line: r.err.split(" ")[0] });
    }
    // text with a $( is refused before any file goes out, as for a text post
    const unsafe = await slackCli(state.dir, server.port, ["slack", "--to", "C1", "--file", ok, "--text", "deck $(whoami)"]);
    expect({ got, unsafe: unsafe.code !== 0 && !unsafe.out.includes("SENT"), calls }).toEqual({ got: cases.map(([line]) => ({ code: 2, line })), unsafe: true, calls: [] });
  } finally {
    server.stop(true);
    state.done();
  }
});

// 2026-11-03: GongDori could not put a drawing into the owner's thread (send --file was Slack only) and called the Discord
// API with the bot token by hand (#dori-pair 1567110863117226090). Discord takes the text and up to 10 files as one
// multipart message: payload_json plus files[n], each named in payload_json's attachments.
const fileCli = async (dir: string, args: readonly string[]) => {
  const file = join(dir, "http.json");
  const r = await run(["env", `DORI_CONFIG=${join(dir, "missing.json")}`, `DORI_STATE_DIR=${dir}`, `DORI_ENV_FILE=${join(dir, "missing.env")}`, "DORI_DISCORD_TOKEN=fake", `DORI_TEST_HTTP=${file}`,
    "bun", "--preload", join(import.meta.dir, "discord-cli-fake.ts"), join(import.meta.dir, "../src/cli.ts"), ...args]);
  const calls = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).calls as { method: string; path: string; body: Record<string, unknown>; files?: unknown[] }[]) : [];
  return { code: r.code, out: r.out, err: r.err, posts: calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages")) };
};

test("send discord --file posts the text and every file as one multipart message, with --reply; a file alone needs no text", async () => {
  const state = withState();
  try {
    const png = join(state.dir, "drawing.png");
    const pdf = join(state.dir, "plan.pdf");
    writeFileSync(png, "png bytes");
    writeFileSync(pdf, "pdf bytes");
    const r = await fileCli(state.dir, ["send", "discord", "--to", "channel", "--thread", "thread", "--no-typing", "--text", "도면이야", "--reply", "1561976021270396959", "--file", png, "--file", pdf]);
    const bare = await fileCli(state.dir, ["send", "discord", "--to", "channel", "--no-typing", "--file", png]);
    expect({ code: r.code, out: r.out, bare: bare.out, posts: r.posts.concat(bare.posts.slice(1)) }).toEqual({
      code: 0, out: receipt("SENT", "900", "도면이야"), bare: receipt("SENT", "900", ""), posts: [
        {
          method: "POST", path: "/channels/thread/messages",
          body: { content: "도면이야", allowed_mentions: { parse: [] }, message_reference: { message_id: "1561976021270396959", fail_if_not_exists: false }, attachments: [{ id: 0, filename: "drawing.png" }, { id: 1, filename: "plan.pdf" }] },
          files: [{ field: "files[0]", name: "drawing.png", type: "image/png", text: "png bytes" }, { field: "files[1]", name: "plan.pdf", type: "application/pdf", text: "pdf bytes" }],
        },
        { method: "POST", path: "/channels/channel/messages", body: { allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: "drawing.png" }] }, files: [{ field: "files[0]", name: "drawing.png", type: "image/png", text: "png bytes" }] },
      ],
    });
  } finally {
    state.done();
  }
});

test("thread reply --file posts the files in the thread with the text, or alone", async () => {
  const state = withState();
  try {
    const png = join(state.dir, "drawing.png");
    writeFileSync(png, "png bytes");
    const r = await fileCli(state.dir, ["thread", "reply", "discord:300000000000000003", "그림 올렸어", "--file", png]);
    const bare = await fileCli(state.dir, ["thread", "reply", "discord:300000000000000003", "--file", png]);
    const shape = (p: { path: string; body: Record<string, unknown>; files?: unknown[] } | undefined) => ({ path: p?.path, content: p?.body.content, attachments: p?.body.attachments, files: p?.files?.length });
    expect({ outs: [r.code, r.out, bare.code, bare.out], posts: bare.posts.map(shape) }).toEqual({
      outs: [0, receipt("POSTED", "900", "그림 올렸어"), 0, receipt("POSTED", "900", "")], posts: [
        { path: "/channels/300000000000000003/messages", content: "그림 올렸어", attachments: [{ id: 0, filename: "drawing.png" }], files: 1 },
        { path: "/channels/300000000000000003/messages", content: undefined, attachments: [{ id: 0, filename: "drawing.png" }], files: 1 },
      ],
    });
  } finally {
    state.done();
  }
});

test("the same text and files again is a repeat (SEND_DUPLICATE); other bytes under the same name, or no file, post", async () => {
  const state = withState();
  try {
    const png = join(state.dir, "drawing.png");
    writeFileSync(png, "png bytes");
    const args = ["send", "discord", "--to", "channel", "--no-typing", "--text", "도면이야", "--file", png];
    const outs = [(await fileCli(state.dir, args)).out, (await fileCli(state.dir, args)).out.split(": ")[0]];
    outs.push((await fileCli(state.dir, ["thread", "reply", "discord:300000000000000003", "도면이야", "--file", png])).out);
    outs.push((await fileCli(state.dir, ["thread", "reply", "discord:300000000000000003", "도면이야", "--file", png])).out.split(": ")[0]);
    writeFileSync(png, "new png bytes");
    outs.push((await fileCli(state.dir, args)).out);
    const last = await fileCli(state.dir, args.slice(0, -2));
    expect({ outs: [...outs, last.out], posts: last.posts.length }).toEqual({ outs: [receipt("SENT", "900", "도면이야"), "SEND_DUPLICATE discord:channel 900", receipt("POSTED", "900", "도면이야"), "SEND_DUPLICATE discord:300000000000000003 900", receipt("SENT", "900", "도면이야"), receipt("SENT", "900", "도면이야")], posts: 4 });
  } finally {
    state.done();
  }
});

test("discord --file refuses a missing, empty, non-regular or too big file, more than 10 files and --edit before any request", async () => {
  const state = withState();
  try {
    const ok = join(state.dir, "ok.png");
    writeFileSync(ok, "x");
    writeFileSync(join(state.dir, "empty.png"), "");
    mkdirSync(join(state.dir, "folder"));
    writeFileSync(join(state.dir, "big.mp4"), "");
    truncateSync(join(state.dir, "big.mp4"), 20 * 1024 ** 2 + 1); // sparse: one byte over Discord's 20 MiB a file
    // each under 20 MiB, together over the 25 MiB a message request may be (review of #308)
    for (const half of ["half1.mp4", "half2.mp4"]) {
      writeFileSync(join(state.dir, half), "");
      truncateSync(join(state.dir, half), 13 * 1024 ** 2);
    }
    const send = ["send", "discord", "--to", "channel", "--no-typing", "--text", "x"];
    const cases: [string, string[]][] = [
      ["SEND_FILE_MISSING", [...send, "--file", ok, "--file", join(state.dir, "nope.png")]],
      ["SEND_FILE_REFUSED", [...send, "--file", join(state.dir, "empty.png")]],
      ["SEND_FILE_REFUSED", [...send, "--file", join(state.dir, "folder")]],
      ["SEND_FILE_TOO_BIG", [...send, "--file", join(state.dir, "big.mp4")]],
      ["SEND_FILE_REFUSED", [...send, ...Array.from({ length: 11 }, () => ["--file", ok]).flat()]],
      ["SEND_FILE_REFUSED", [...send, "--edit", "1", "--file", ok]],
      ["SEND_FILE_MISSING", ["thread", "reply", "discord:300000000000000003", "x", "--file", join(state.dir, "nope.png")]],
      ["SEND_FILE_TOO_BIG", ["thread", "done", "discord:300000000000000003", "x", "--file", join(state.dir, "big.mp4")]],
      ["SEND_FILE_TOO_BIG", [...send, "--file", join(state.dir, "half1.mp4"), "--file", join(state.dir, "half2.mp4")]],
      ["SEND_FILE_TOO_BIG", ["thread", "reply", "discord:300000000000000003", "x", "--file", join(state.dir, "half1.mp4"), "--file", join(state.dir, "half2.mp4")]],
    ];
    const got = [];
    for (const [, args] of cases) {
      const r = await fileCli(state.dir, args);
      got.push({ code: r.code, line: r.err.split(" ")[0], posts: r.posts.length });
    }
    expect({ got, requests: existsSync(join(state.dir, "http.json")) }).toEqual({ got: cases.map(([line]) => ({ code: 2, line, posts: 0 })), requests: false });
  } finally {
    state.done();
  }
});

test("a Discord message with files may be 25 MiB with its text and form slack, and not one byte more", () => {
  const file = (n: number): DiscordFile => ({ filename: "a.bin", type: "application/octet-stream", bytes: new Uint8Array(n), sha256: "" });
  const room = DISCORD_MESSAGE_MAX - DISCORD_FORM_SLACK - Buffer.byteLength("그림");
  expect({
    fits: discordMessageProblem([file(room - 10), file(10)], "그림"),
    over: discordMessageProblem([file(room - 10), file(11)], "그림")?.split(" ")[0],
    textOnly: discordMessageProblem([], "x".repeat(DISCORD_MESSAGE_MAX)),
  }).toEqual({ fits: undefined, over: "SEND_FILE_TOO_BIG", textOnly: undefined });
});

test("존댓말 with a file for a 반말 owner is refused before anything is sent (SPEECH_REFUSED), in send and thread reply", async () => {
  const state = withState();
  try {
    const png = join(state.dir, "drawing.png");
    writeFileSync(png, "png bytes");
    const send = await speechCli(state.dir, ["send", "discord", "--to", "300000000000000003", "--no-typing", "--text", POLITE, "--file", png]);
    const reply = await speechCli(state.dir, ["thread", "reply", "discord:300000000000000003", POLITE, "--file", png]);
    expect([send, reply]).toMatchObject([{ code: 2, refused: true, posted: [] }, { code: 2, refused: true, posted: [] }]);
  } finally {
    state.done();
  }
});

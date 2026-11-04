import { expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

test("Slack hook references land in the intended thread and deduplicate against explicit channel arguments", async () => {
  const state = withState();
  const messages: unknown[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
    messages.push(await req.json());
    return Response.json({ ok: true, channel: "C123", ts: "200.1" });
  } });
  try {
    const command = ["env", `DORI_CONFIG=${join(state.dir, "missing.json")}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`, "DORI_SLACK_TOKEN=fake",
      `DORI_SLACK_API=http://127.0.0.1:${server.port}/api`, "bun", join(import.meta.dir, "../src/cli.ts"), "send", "slack", "--text", "progress"];
    const posted = await run([...command, "--to", "slack:C123:100.1"]);
    const repeated = await run([...command, "--to", "C123", "--thread", "100.1"]);
    expect({ code: posted.code, messages }).toEqual({ code: 0, messages: [{ channel: "C123", text: "progress", thread_ts: "100.1" }] });
    expect(repeated.code).toBe(0);
    expect(repeated.out).toContain("SEND_DUPLICATE 200.1");
  } finally {
    server.stop(true);
    state.done();
  }
});

for (const args of [
  ["--to", "slack:C123"],
  ["--to", "slack:C123:not-a-timestamp"],
  ["--to", "slack:C123:100.1", "--thread", "999.1"],
]) {
  test(`Slack refuses ambiguous hook destination ${args.join(" ")} before posting`, async () => {
    const state = withState();
    let posted = false;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => {
      posted = true;
      return Response.json({ ok: true, channel: "C123", ts: "200.1" });
    } });
    try {
      const result = await run(["env", `DORI_CONFIG=${join(state.dir, "missing.json")}`, `DORI_STATE_DIR=${state.dir}`, `DORI_ENV_FILE=${join(state.dir, "missing.env")}`, "DORI_SLACK_TOKEN=fake",
        `DORI_SLACK_API=http://127.0.0.1:${server.port}/api`, "bun", join(import.meta.dir, "../src/cli.ts"), "send", "slack", "--text", "progress", ...args]);
      expect({ code: result.code, posted }).toEqual({ code: 2, posted: false });
    } finally {
      server.stop(true);
      state.done();
    }
  });
}

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
      { code: 0, out: "REQUEST typing\nREQUEST messages\nSENT fake-message" },
      { code: 0, out: "REQUEST messages\nSENT fake-message" },
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
        code: 0, out: "SENT 900", calls: [{ method: "POST", path: "/channels/thread/messages", body: { content, allowed_mentions: { parse: [], ...(ping === undefined ? {} : { users: [ping] }) } } }],
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
      gated: "SENT 901", seen: ["POST /api/v10/channels/channel/messages Bot fake"], direct: "SENT 900", calls: ["/channels/channel/messages"],
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
    expect({ code: sent.code, out: sent.out, posted: sent.posted }).toEqual({ code: 0, out: "SENT 900", posted: ["E7 끝났어\n남은 건 없어"] });
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
    return status === 200 ? Response.json({ id: String(posts.length) }) : new Response("{}", { status });
  } });
  return { posts, server, stop: () => server.stop(true) };
};
const sendTo = (dir: string, port: number | undefined, args: readonly string[]) =>
  run(["env", `DORI_CONFIG=${join(dir, "missing.json")}`, `DORI_STATE_DIR=${dir}`, `DORI_ENV_FILE=${join(dir, "missing.env")}`, "DORI_DISCORD_TOKEN=fake",
    `DORI_DISCORD_API=http://127.0.0.1:${port}/api/v10`, "bun", join(import.meta.dir, "../src/cli.ts"), "send", "discord", "--no-typing", ...args]);
const SAME = ["--to", "1561963113488842792", "--reply", "1561976021270396959", "--text", "시험 레인 열게"];

test("the same send twice posts once; the second prints the first message's id and exits 0", async () => {
  const state = withState();
  const d = discordServer();
  try {
    const first = await sendTo(state.dir, d.server.port, SAME);
    const second = await sendTo(state.dir, d.server.port, SAME);
    expect({ first: first.out, code: second.code, second: second.out.split(":")[0], posts: d.posts.length }).toEqual({ first: "SENT 1", code: 0, second: "SEND_DUPLICATE 1", posts: 1 });
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
    expect({ codes: both.map((r) => r.code), outs: both.map((r) => r.out.split(":")[0]).sort(), posts: d.posts.length }).toEqual({ codes: [0, 0], outs: ["SEND_DUPLICATE 1", "SENT 1"], posts: 1 });
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
    for (const args of [SAME, [...SAME.slice(0, 5), "다른 글"], ["--to", "1561963113488842790", ...SAME.slice(2)], [...SAME.slice(0, 2), "--reply", "1561976021270396950", ...SAME.slice(4)], [...SAME, "--again"]]) outs.push((await sendTo(state.dir, d.server.port, args)).out);
    expect({ outs, posts: d.posts.length }).toEqual({ outs: ["SENT 1", "SENT 2", "SENT 3", "SENT 4", "SENT 5"], posts: 5 });
  } finally {
    d.stop();
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
    expect({ failed: failed.code, retry: retry.out, posts: up.posts.length }).toEqual({ failed: 1, retry: "SENT 1", posts: 1 });
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
    expect({ outs: [reply.out, again.out.split(":")[0], done.out.split(":")[0], done.out.endsWith(" THREAD_DONE"), send.out.split(":")[0]], posted: send.posted }).toEqual({
      outs: ["POSTED 900", "SEND_DUPLICATE 900", "SEND_DUPLICATE 900", true, "SEND_DUPLICATE 900"], posted: ["끝났어"],
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
      expect(await speechCli(state.dir, args, parent)).toMatchObject({ code: 0, out, refused: false, posted: [args.at(-1)] });
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
      if (path === "/api/chat.postMessage") return Response.json({ ok: true, channel: body.channel, ts: "1700000100.000100" });
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
      bare: "SENT F3", share: { files: [{ id: "F3", title: "demo.mp4" }], channel_id: "C1" }, text: "SENT 1700000100.000100", after: [
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
      ["SEND_FILE_REFUSED", ["discord", "--to", "channel", "--file", ok, "--text", "x"]],
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

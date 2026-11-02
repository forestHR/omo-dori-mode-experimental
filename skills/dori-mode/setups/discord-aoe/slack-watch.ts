#!/usr/bin/env bun
// Slack watcher for a Dori with its own Slack app (a bot, never a member's account). Off unless DORI_SLACK_APP_TOKEN is
// set. Socket Mode: no public port, one outgoing WebSocket. Each human message the bot can see becomes one inbox row
// (scope "slack"); a DM, a mention of the bot or a reply in a thread the Dori posted in also prints one SLACK_MSG line for
// the lead's monitor. Replies go out with dori send slack --to <channel> [--thread <ts>] under the bot's name.
// --wait waits for the tokens instead of exiting; --set-tokens asks for them on the terminal and writes them to dori.env.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configPath, envFilePath, loadConfig, loadEnvFile, resolveInstance } from "../../scripts/src/config.ts";
import type { LedgerThread } from "../../scripts/src/messenger/thread-ledger.ts";

export type SlackWatchOptions = {
  readonly appToken: string;
  readonly botToken: string;
  readonly owner: readonly string[];
  readonly api: string;
  readonly inbox: string;
  readonly threads: string;
};

export const slackWatchOptions = (env: Record<string, string | undefined>, stateDir: string): SlackWatchOptions => ({
  appToken: env.DORI_SLACK_APP_TOKEN?.trim() ?? "",
  botToken: env.DORI_SLACK_TOKEN?.trim() ?? "",
  owner: (env.DORI_SLACK_OWNER_ID ?? "").split(",").map((x) => x.trim()).filter(Boolean),
  api: env.DORI_SLACK_API?.trim() || "https://slack.com/api",
  inbox: env.DORI_DISCORD_INBOX?.trim() || join(stateDir, "discord", "inbox.jsonl"),
  threads: join(stateDir, "slack-threads.json"),
});

// Why the watcher cannot run yet, or "" when both tokens are there. Only the prefix is checked, never printed whole.
export const missingTokens = (o: Pick<SlackWatchOptions, "appToken" | "botToken">): string =>
  !o.appToken
    ? "DORI_SLACK_APP_TOKEN is not set"
    : !o.appToken.startsWith("xapp-")
      ? "DORI_SLACK_APP_TOKEN is not an app-level token (xapp-)"
      : !o.botToken
        ? "DORI_SLACK_TOKEN is not set"
        : !o.botToken.startsWith("xoxb-")
          ? "DORI_SLACK_TOKEN is not a bot token (xoxb-): this watcher never uses a member's token"
          : "";

export type SlackEvent = {
  readonly type?: string;
  readonly subtype?: string;
  readonly channel?: string;
  readonly channel_type?: string;
  readonly user?: string;
  readonly bot_id?: string;
  readonly text?: string;
  readonly ts?: string;
  readonly thread_ts?: string;
  readonly files?: readonly { readonly name?: string }[];
};
export type Self = { readonly userId: string; readonly botId: string };
export type Addressed = "dm" | "mention" | "own-thread" | null;

// Subtypes that are a person writing. Edits, deletes, joins and bot posts are not taken in.
const HUMAN_SUBTYPES: ReadonlySet<string | undefined> = new Set([undefined, "thread_broadcast", "file_share"]);
const SEEN_MAX = 2000;

export type WatchDeps = {
  readonly call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly threads: () => Promise<readonly LedgerThread[]>;
  readonly append: (row: Record<string, unknown>) => void;
  readonly log: (line: string) => void;
  readonly now: () => number;
};

// One event in, at most one inbox row out. The same message reaches the app twice when it mentions the bot in a channel
// (app_mention and message.channels) and again when Slack retries an envelope; it is taken in once.
export class SlackWatch {
  private readonly seen = new Set<string>();
  private readonly names = new Map<string, string | null>();
  constructor(
    private readonly o: SlackWatchOptions,
    private readonly self: Self,
    private readonly deps: WatchDeps,
  ) {}

  private async name(user: string): Promise<string | null> {
    if (this.names.has(user)) return this.names.get(user) ?? null;
    let name: string | null = null;
    try {
      const u = (await this.deps.call("users.info", { user })).user as { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } | undefined;
      name = u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name || null;
    } catch {
      // users:read not granted or the user is gone: the row keeps the id, and the lookup is not repeated
    }
    this.names.set(user, name);
    return name;
  }

  async addressed(ev: SlackEvent): Promise<Addressed> {
    if (ev.channel_type === "im" || ev.channel?.startsWith("D")) return "dm";
    if (ev.type === "app_mention" || (ev.text ?? "").includes(`<@${this.self.userId}>`)) return "mention";
    if (ev.thread_ts && (await this.deps.threads()).some((t) => t.channel === ev.channel && t.rootTs === ev.thread_ts)) return "own-thread";
    return null;
  }

  async handle(ev: SlackEvent): Promise<Record<string, unknown> | null> {
    if (ev.type !== "message" && ev.type !== "app_mention") return null;
    if (!ev.channel || !ev.ts || !ev.user || ev.bot_id || !HUMAN_SUBTYPES.has(ev.subtype) || ev.user === this.self.userId) return null;
    const key = `${ev.channel}:${ev.ts}`;
    if (this.seen.has(key)) return null;
    this.seen.add(key);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value ?? "");
    const addressed = await this.addressed(ev);
    const files = (ev.files ?? []).map((f) => f.name ?? "file");
    const content = [ev.text ?? "", ...files.map((f) => `[file: ${f}]`)].filter(Boolean).join("\n");
    const author = await this.name(ev.user);
    // where a reply goes: the thread the message is in; a channel message starts a thread under itself; a plain DM is
    // answered in the DM itself
    const replyThread = ev.thread_ts ?? (addressed === "dm" ? null : ev.ts);
    const row = {
      ts: new Date(this.deps.now()).toISOString(),
      id: ev.ts,
      channel_id: ev.channel,
      thread_ts: ev.thread_ts ?? null,
      reply_thread: replyThread,
      scope: "slack",
      author_id: ev.user,
      author_name: author,
      author_kind: this.o.owner.includes(ev.user) ? "owner" : "member",
      addressed,
      mentions_self: addressed === "mention",
      content,
    };
    this.deps.append(row);
    if (addressed) this.deps.log(`SLACK_MSG ${ev.channel} ${replyThread ?? "-"} ${addressed} ${author ?? ev.user}${row.author_kind === "owner" ? " (owner)" : ""}: ${content.slice(0, 160).replace(/\n/g, " ")}`);
    return row;
  }
}

export type Sock = { send: (data: string) => void; close: () => void; ping: () => void };
export type SocketDeps = {
  readonly open: (url: string, on: { message: (data: string) => void; close: () => void; pong: () => void }) => Sock;
  readonly connect: () => Promise<string>;
  readonly handle: (ev: SlackEvent) => Promise<unknown>;
  readonly log: (line: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pingMs: number;
};

// Socket Mode until stopped: open a connection URL, ack every envelope at once, hand events_api payloads on, and on a
// disconnect message or a closed socket open a fresh URL (Slack refreshes connections every few hours). A connection
// that dies without a close (sleep, a dropped route) is found by a ping every pingMs: no frame and no pong since the
// last one closes it and opens a fresh URL. Failures to connect back off from 1 s to 60 s. Resolves only when
// stop.stopped is set (tests).
export const runSocket = async (deps: SocketDeps, stop: { stopped: boolean } = { stopped: false }): Promise<void> => {
  let ready = false;
  let wait = 1000;
  // one event at a time, in the order Slack sent them, so the inbox keeps that order
  let queue: Promise<unknown> = Promise.resolve();
  while (!stop.stopped) {
    let url: string;
    try {
      url = await deps.connect();
    } catch (e) {
      deps.log(`SLACK_CONNECT_FAIL ${e instanceof Error ? e.message : String(e)}, retry in ${wait / 1000}s`);
      await deps.sleep(wait);
      wait = Math.min(wait * 2, 60_000);
      continue;
    }
    await new Promise<void>((done) => {
      let finished = false;
      let heard = true;
      let health: ReturnType<typeof setInterval> | undefined;
      const end = () => {
        if (finished) return;
        finished = true;
        clearInterval(health);
        done();
      };
      const sock = deps.open(url, {
        close: end,
        pong: () => {
          heard = true;
        },
        message: (data) => {
          heard = true;
          let env: { envelope_id?: string; type?: string; reason?: string; payload?: { event?: SlackEvent } };
          try {
            env = JSON.parse(data);
          } catch {
            deps.log("SLACK_PARSE_FAIL a frame that is not JSON");
            return;
          }
          if (env.envelope_id) sock.send(JSON.stringify({ envelope_id: env.envelope_id }));
          if (env.type === "hello") {
            wait = 1000;
            deps.log(ready ? "SLACK_WATCH_RECONNECTED" : "SLACK_WATCH_READY");
            ready = true;
          } else if (env.type === "disconnect") {
            deps.log(`SLACK_WATCH_REFRESH ${env.reason ?? "disconnect"}`);
            sock.close();
            end();
          } else if (env.type === "events_api" && env.payload?.event) {
            const ev = env.payload.event;
            queue = queue.then(() => deps.handle(ev)).catch((e: unknown) => deps.log(`SLACK_EVENT_FAIL ${e instanceof Error ? e.message : String(e)}`));
          }
        },
      });
      health = setInterval(() => {
        if (stop.stopped || !heard) {
          if (!stop.stopped) deps.log(`SLACK_WATCH_STALE no frame or pong for ${deps.pingMs / 1000}s, opening a new connection`);
          sock.close();
          end();
          return;
        }
        heard = false;
        try {
          sock.ping();
        } catch {
          // a socket that cannot even send a ping is dead: the next tick finds it silent and replaces it
        }
      }, deps.pingMs);
    });
    if (!stop.stopped) await deps.sleep(1000);
  }
};

const slackCall = (api: string, token: string) => async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const res = await fetch(`${api}/${method}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(params) });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.ok !== true) throw new Error(`slack ${method}: ${String(body.error ?? res.status)}`);
  return body;
};

const readThreads = (file: string) => async (): Promise<readonly LedgerThread[]> => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as LedgerThread[]) : []);

export const startWatch = async (o: SlackWatchOptions, log: (line: string) => void, stop: { stopped: boolean } = { stopped: false }, pingMs = 30_000): Promise<void> => {
  const bot = slackCall(o.api, o.botToken);
  // a network error or a Slack outage at start is waited out like a failed connect, never an exit the monitor misses
  let me: Record<string, unknown> | undefined;
  for (let wait = 1000; !me; wait = Math.min(wait * 2, 60_000)) {
    try {
      me = await bot("auth.test", {});
    } catch (e) {
      log(`SLACK_AUTH_FAIL ${e instanceof Error ? e.message : String(e)}, retry in ${wait / 1000}s`);
      if (stop.stopped) return;
      await Bun.sleep(wait);
    }
  }
  const self = { userId: String(me.user_id ?? ""), botId: String(me.bot_id ?? "") };
  mkdirSync(dirname(o.inbox), { recursive: true, mode: 0o700 });
  const watch = new SlackWatch(o, self, { call: bot, threads: readThreads(o.threads), append: (row) => appendFileSync(o.inbox, `${JSON.stringify(row)}\n`), log, now: Date.now });
  log(`SLACK_WATCH_START team ${String(me.team ?? "?")} bot ${String(me.user ?? self.userId)}`);
  await runSocket(
    {
      connect: async () => String((await slackCall(o.api, o.appToken)("apps.connections.open", {})).url),
      open: (url, on) => {
        const ws = new WebSocket(url);
        ws.addEventListener("message", (e) => on.message(String(e.data)));
        ws.addEventListener("close", () => on.close());
        ws.addEventListener("error", () => on.close());
        ws.addEventListener("pong", () => on.pong());
        return { send: (d) => ws.send(d), close: () => ws.close(), ping: () => ws.ping() };
      },
      handle: (ev) => watch.handle(ev),
      log,
      sleep: (ms) => Bun.sleep(ms),
      pingMs,
    },
    stop,
  );
};

// Replaces (or adds) the given KEY=VALUE lines in an env file and leaves it mode 0600; other lines stay as they were.
export const writeEnvValues = (path: string, values: Record<string, string>): void => {
  const lines = existsSync(path) ? readFileSync(path, "utf8").replace(/\n$/, "").split("\n") : [];
  const kept = lines.filter((l) => !Object.keys(values).some((k) => new RegExp(`^\\s*${k}=`).test(l)));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${[...kept, ...Object.entries(values).map(([k, v]) => `${k}=${v}`)].join("\n")}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
};

const ask = async (prompt: string, hidden: boolean): Promise<string> => {
  process.stdout.write(prompt);
  const tty = hidden && process.stdin.isTTY;
  if (tty) Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
  try {
    for await (const line of console) return line.trim();
    return "";
  } finally {
    if (tty) {
      Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
      process.stdout.write("\n");
    }
  }
};

// --set-tokens: the owner pastes the two tokens (hidden) and, optionally, his member id. Both tokens are checked against
// Slack before anything is written; nothing but the team and bot names is printed.
const setTokens = async (api: string): Promise<number> => {
  const botToken = await ask("Bot User OAuth Token (xoxb-...): ", true);
  const appToken = await ask("App-Level Token (xapp-...): ", true);
  const owner = await ask("Your Slack member ID (U..., Enter to skip): ", false);
  const why = missingTokens({ appToken, botToken });
  if (why) {
    console.log(`SLACK_TOKENS_REFUSED ${why}; nothing was written`);
    return 2;
  }
  if (owner && !/^[UW][A-Z0-9]+$/.test(owner)) {
    console.log("SLACK_TOKENS_REFUSED the member ID looks like U0123ABCD; nothing was written");
    return 2;
  }
  try {
    const me = await slackCall(api, botToken)("auth.test", {});
    await slackCall(api, appToken)("apps.connections.open", {});
    writeEnvValues(envFilePath(), { DORI_SLACK_TOKEN: botToken, DORI_SLACK_APP_TOKEN: appToken, ...(owner ? { DORI_SLACK_OWNER_ID: owner } : {}) });
    console.log(`SLACK_TOKENS_SET team ${String(me.team ?? "?")} bot ${String(me.user ?? "?")}${owner ? " owner set" : ""} -> ${envFilePath()} (0600)`);
    return 0;
  } catch (e) {
    console.log(`SLACK_TOKENS_REFUSED ${e instanceof Error ? e.message : String(e)}; nothing was written`);
    return 1;
  }
};

if (import.meta.main) {
  await resolveInstance(process.cwd());
  await loadEnvFile(envFilePath());
  const config = await loadConfig(configPath());
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
  if (process.argv.includes("--set-tokens")) process.exit(await setTokens(slackWatchOptions(process.env, config.stateDir).api));
  let options = slackWatchOptions(process.env, config.stateDir);
  let why = missingTokens(options);
  if (why && !process.argv.includes("--wait")) {
    console.log(`SLACK_WATCH_OFF ${why}`);
    process.exit(0);
  }
  if (why) {
    const every = Number(process.env.DORI_SLACK_WAIT_MS) > 0 ? Number(process.env.DORI_SLACK_WAIT_MS) : 30_000;
    log(`SLACK_WATCH_WAIT ${why}; reading ${envFilePath()} every ${every / 1000}s`);
    while (why) {
      await Bun.sleep(every);
      const env = { ...process.env };
      await loadEnvFile(envFilePath(), env);
      options = slackWatchOptions(env, config.stateDir);
      why = missingTokens(options);
    }
  }
  await startWatch(options, log);
}

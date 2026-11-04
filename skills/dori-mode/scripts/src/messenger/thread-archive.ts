import type { DiscordWords } from "../config.ts";
import type { Discord } from "./discord.ts";
import { isDoneName } from "./discord-thread.ts";

type ActiveThread = {
  readonly id: string;
  readonly parent_id?: string;
  readonly name?: string;
  readonly last_message_id?: string | null;
  readonly thread_metadata?: { readonly archived?: boolean; readonly archive_timestamp?: string; readonly create_timestamp?: string };
};

export type ArchiveDeps = {
  readonly dc: Discord;
  readonly guild: string;
  // the owner's channel (DORI_DISCORD_CHANNEL): only its threads are looked at
  readonly channel: string;
  readonly words: DiscordWords;
  // discord.autoArchiveMin: quiet minutes after the last message (the ✅ rename is one) before a done thread is archived
  readonly afterMin: number;
  readonly now: () => number;
  // thread ids an open lane (any status but closed: working, paused, claimed, not-done) still has as its work thread
  readonly laneThreads: () => Promise<ReadonlySet<string>>;
  // ids of the question cards still open in a thread
  readonly openCards: (thread: string) => readonly string[];
  // a status rename still waiting in the thread status queue (thread-status.json)
  readonly pendingStatus: (thread: string) => boolean;
};

const DISCORD_EPOCH = 1_420_070_400_000n;
const snowflakeMs = (id: string): number => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);

// the last thing that happened in the thread: its newest message (a rename posts one too), else when it was opened or
// last archived or unarchived
const lastActivity = (t: ActiveThread): number =>
  Math.max(
    t.last_message_id && /^\d+$/.test(t.last_message_id) ? snowflakeMs(t.last_message_id) : 0,
    Date.parse(t.thread_metadata?.archive_timestamp ?? "") || 0,
    Date.parse(t.thread_metadata?.create_timestamp ?? "") || 0,
  );

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);

// A done (✅) thread that is still open in the owner's channel: dori close archives the thread, but anything posted in it
// afterwards (the lead's summary a second later, a reply) unarchives it again and the ✅ name stays. Each freshness tick
// archives such a thread once it has been quiet for afterMin minutes and nothing still holds it: an open lane, an open
// question card, a pending status rename. A working or waiting (🔄 / 🔔) thread is never touched, nor is any channel
// (only threads come back from threads/active), and nothing is renamed. The owner writing in it later reopens it as
// before (the listener marks it working).
export const archiveDoneThreads = async (d: ArchiveDeps): Promise<string[]> => {
  if (!(d.afterMin > 0) || !d.channel || !d.guild) return [];
  const active = await d.dc.call<{ threads?: ActiveThread[] }>("GET", `/guilds/${d.guild}/threads/active`);
  const done = (active.threads ?? []).filter((t) => t.parent_id === d.channel && t.thread_metadata?.archived !== true && isDoneName(t.name ?? "", d.words));
  if (!done.length) return [];
  const lanes = await d.laneThreads();
  const lines: string[] = [];
  for (const t of done) {
    const quietMin = Math.floor((d.now() - lastActivity(t)) / 60_000);
    if (quietMin < d.afterMin || lanes.has(t.id) || d.openCards(t.id).length || d.pendingStatus(t.id)) continue;
    try {
      await d.dc.setThread(t.id, { archived: true });
      lines.push(`THREAD_AUTO_ARCHIVED ${t.id} quiet=${quietMin}m ${JSON.stringify(t.name ?? "")}`);
    } catch (e) {
      lines.push(`THREAD_AUTO_ARCHIVE_WARN ${t.id} ${errText(e)}`);
    }
  }
  return lines;
};

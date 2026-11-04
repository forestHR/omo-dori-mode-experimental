// Discord draws a bare channel, thread or message URL, and a <#id> mention, as a pill named from the viewer's own client cache.
// A thread that client has not loaded (archived, which a ✅ thread is a moment after its rename, and one the owner never
// joined) is not in that cache, so the pill reads "unknown" (알 수 없음). A masked link [text](<url>) shows its own text
// and still opens the thread, so each such link in a post becomes one, named from the API when it is sent. The name goes
// without its status mark (and a status word after it, "✅ 완료 · x"): the mark changes after the post, the name does not.

const HOST = String.raw`https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(?:\d{5,25}|@me)\/(\d{5,25})(?:\/\d{5,25})?`;
// a channel, thread or message URL, bare or in <...>; not one already inside a masked link "](".
const LINK = new RegExp(String.raw`(?<![(<\w/])(?:<${HOST}>|${HOST})(?![\w/>])|<#(\d{5,25})>`, "g");
// code spans and blocks stay as written
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;

const STATUS = /^(?:\[[^\]]{1,20}\]|(?:🔄|🔔|⏸|✅|⏳|⛔|💤|❗|⌛)\uFE0F?)\s*/u;
const STATUS_WORD = /^[^\s·]{1,8}(?: [^\s·]{1,8})?\s*·\s*/u;

// "✅ 완료 · 🏷️ 릴리스 v2.6.18" -> "릴리스 v2.6.18"; a name with no status mark keeps everything but its emoji.
export const linkLabel = (name: string): string => {
  let rest = name.trim();
  let marked = false;
  for (let next = rest.replace(STATUS, ""); next !== rest; next = rest.replace(STATUS, "")) [rest, marked] = [next, true];
  if (marked) rest = rest.replace(STATUS_WORD, "");
  const label = rest
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "")
    .replace(/[[\]]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return label.slice(0, 90);
};

const THREAD_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);

type Channel = { readonly name?: string; readonly type?: number; readonly guild_id?: string };
export type ChannelLookup = (id: string) => Promise<Channel>;

// The post's text with each link to a thread (or to a message in one) written as [name](<url>). A link whose channel cannot be read, or is not a
// thread (a text channel is always in the client's cache), stays as it was; a failed read is logged, never thrown.
export const nameThreadLinks = async (text: string, lookup: ChannelLookup): Promise<string> => {
  const ids = new Set<string>();
  const outside = text.split(CODE);
  for (const part of outside) for (const m of part.matchAll(LINK)) ids.add((m[1] ?? m[2] ?? m[3]) as string);
  if (!ids.size) return text;
  const names = new Map<string, Channel>();
  await Promise.all([...ids].map(async (id) => {
    try {
      names.set(id, await lookup(id));
    } catch (e) {
      console.error(`DISCORD_LINK_NAME_SKIP ${id} ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    }
  }));
  const rewrite = (part: string): string =>
    part.replace(LINK, (all, angled?: string, bare?: string, mention?: string) => {
      const id = (angled ?? bare ?? mention) as string;
      const c = names.get(id);
      const label = c?.name ? linkLabel(c.name) : "";
      if (!c || !label || !THREAD_TYPES.has(c.type ?? -1)) return all;
      const url = mention ? (c.guild_id ? `https://discord.com/channels/${c.guild_id}/${id}` : "") : all.replace(/^<|>$/g, "");
      return url ? `[${label}](<${url}>)` : all;
    });
  const codes = text.match(CODE) ?? [];
  return outside.map((part, i) => rewrite(part) + (codes[i] ?? "")).join("");
};

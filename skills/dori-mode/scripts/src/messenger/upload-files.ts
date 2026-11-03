import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename } from "node:path";

import type { UploadFile } from "./slack.ts";

// dori send slack --file: Slack takes up to 1 GB a file and refuses an empty one; one send shares at most 10
export const SLACK_FILE_MAX = 1024 ** 3;
export const SLACK_FILES_MAX = 10;
// dori send discord / thread reply --file: Discord takes 20 MiB a file by default (more only on a boosted server) and at
// most 10 attachments a message (docs.discord.com/developers/reference#uploading-files)
export const DISCORD_FILE_MAX = 20 * 1024 ** 2;
export const DISCORD_FILES_MAX = 10;
// one message's whole request is at most 25 MiB (docs.discord.com/developers/resources/message; the egress gate's
// BODY_CAP is the same); the slack covers payload_json, the multipart headers and boundaries, a ping and named links
export const DISCORD_MESSAGE_MAX = 25 * 1024 ** 2;
export const DISCORD_FORM_SLACK = 16 * 1024;

export type UploadLimits = { readonly platform: string; readonly fileMax: number; readonly fileMaxText: string; readonly filesMax: number };
const SLACK: UploadLimits = { platform: "Slack", fileMax: SLACK_FILE_MAX, fileMaxText: "1 GB", filesMax: SLACK_FILES_MAX };
export const DISCORD: UploadLimits = { platform: "Discord", fileMax: DISCORD_FILE_MAX, fileMaxText: "20 MiB", filesMax: DISCORD_FILES_MAX };

export class UploadRefused extends Error {}

// Every path is checked before any request. The bytes are read only when that file's upload starts (one file in memory
// at a time) and must still have the size the upload URL was asked for.
export const readUploads = (paths: readonly string[], limits: UploadLimits = SLACK): UploadFile[] => {
  if (paths.length > limits.filesMax) throw new UploadRefused(`SEND_FILE_REFUSED ${paths.length} files: one ${limits.platform} send takes at most ${limits.filesMax}; nothing was sent`);
  return paths.map((p) => {
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) throw new UploadRefused(`SEND_FILE_MISSING ${p}: no such file; nothing was sent`);
    if (!st.isFile()) throw new UploadRefused(`SEND_FILE_REFUSED ${p}: not a regular file; nothing was sent`);
    if (st.size === 0) throw new UploadRefused(`SEND_FILE_REFUSED ${p}: the file is empty (no 0-byte upload is sent); nothing was sent`);
    if (st.size > limits.fileMax) throw new UploadRefused(`SEND_FILE_TOO_BIG ${p}: ${st.size} bytes, over ${limits.platform}'s ${limits.fileMax} bytes (${limits.fileMaxText}) a file; nothing was sent`);
    const length = st.size;
    return {
      filename: basename(p),
      length,
      read: async () => {
        const bytes = new Uint8Array(await Bun.file(p).arrayBuffer());
        if (bytes.byteLength !== length) throw new Error(`SEND_FILE_CHANGED ${p}: ${length} bytes when checked, ${bytes.byteLength} now; nothing was shared`);
        return bytes;
      },
    };
  });
};

// A Discord message carries its files in the one request, so they are all read before it; the sha256 of each goes into
// the repeat check's key (the same text with other bytes is a new message)
export type DiscordFile = { readonly filename: string; readonly type: string; readonly bytes: Uint8Array<ArrayBuffer>; readonly sha256: string };
export const readDiscordFiles = async (paths: readonly string[]): Promise<DiscordFile[]> => {
  const checked = readUploads(paths, DISCORD);
  const out: DiscordFile[] = [];
  for (const [i, f] of checked.entries()) {
    const bytes = await f.read();
    out.push({ filename: f.filename, type: Bun.file(paths[i] ?? "").type, bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return out;
};

export const discordMessageProblem = (files: readonly DiscordFile[], text: string): string | undefined => {
  if (!files.length) return undefined;
  const total = files.reduce((n, f) => n + f.bytes.byteLength, Buffer.byteLength(text)) + DISCORD_FORM_SLACK;
  return total > DISCORD_MESSAGE_MAX ? `SEND_FILE_TOO_BIG ${files.length} files: ${total} bytes with the text and form, over Discord's ${DISCORD_MESSAGE_MAX} bytes (25 MiB) a message; send them in more than one message; nothing was sent` : undefined;
};

// the attachments' part of a repeat-check key: empty without files, so a text post keeps its key
export const filesKey = (files: readonly DiscordFile[]): string[] => files.map((f) => `${f.filename}:${f.sha256}`);

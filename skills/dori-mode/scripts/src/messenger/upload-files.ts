import { statSync } from "node:fs";
import { basename } from "node:path";

import type { UploadFile } from "./slack.ts";

// dori send slack --file: Slack takes up to 1 GB a file and refuses an empty one; one send shares at most 10
export const SLACK_FILE_MAX = 1024 ** 3;
export const SLACK_FILES_MAX = 10;

export class UploadRefused extends Error {}

const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

// Every path is checked before any request, then hashed by streaming (one file in memory at a time). The bytes are read
// again only when that file's upload starts, and they must be the ones hashed: the hash is the repeat key, so a file
// changed in between (even to the same size) stops the send before anything is shared.
export const readUploads = async (paths: readonly string[]): Promise<(UploadFile & { sha: string })[]> => {
  if (paths.length > SLACK_FILES_MAX) throw new UploadRefused(`SEND_FILE_REFUSED ${paths.length} files: one send shares at most ${SLACK_FILES_MAX}; nothing was sent`);
  for (const p of paths) {
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) throw new UploadRefused(`SEND_FILE_MISSING ${p}: no such file; nothing was sent`);
    if (!st.isFile()) throw new UploadRefused(`SEND_FILE_REFUSED ${p}: not a regular file; nothing was sent`);
    if (st.size === 0) throw new UploadRefused(`SEND_FILE_REFUSED ${p}: the file is empty (Slack takes no 0-byte upload); nothing was sent`);
    if (st.size > SLACK_FILE_MAX) throw new UploadRefused(`SEND_FILE_TOO_BIG ${p}: ${st.size} bytes, over Slack's ${SLACK_FILE_MAX} bytes (1 GB) a file; nothing was sent`);
  }
  const out: (UploadFile & { sha: string })[] = [];
  for (const p of paths) {
    const hash = new Bun.CryptoHasher("sha256");
    let length = 0;
    for await (const chunk of Bun.file(p).stream()) {
      hash.update(chunk);
      length += chunk.byteLength;
    }
    const sha = hash.digest("hex");
    out.push({
      filename: basename(p),
      length,
      sha,
      read: async () => {
        const bytes = new Uint8Array(await Bun.file(p).arrayBuffer());
        if (bytes.byteLength !== length || sha256(bytes) !== sha) throw new Error(`SEND_FILE_CHANGED ${p}: the file changed after it was checked; nothing was shared`);
        return bytes;
      },
    });
  }
  return out;
};

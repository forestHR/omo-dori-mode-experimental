import { statSync } from "node:fs";
import { basename } from "node:path";

import type { UploadFile } from "./slack.ts";

// dori send slack --file: Slack takes up to 1 GB a file and refuses an empty one; one send shares at most 10
export const SLACK_FILE_MAX = 1024 ** 3;
export const SLACK_FILES_MAX = 10;

export class UploadRefused extends Error {}

// Every path is checked before any request. The bytes are read only when that file's upload starts (one file in memory
// at a time) and must still have the size the upload URL was asked for.
export const readUploads = (paths: readonly string[]): UploadFile[] => {
  if (paths.length > SLACK_FILES_MAX) throw new UploadRefused(`SEND_FILE_REFUSED ${paths.length} files: one send shares at most ${SLACK_FILES_MAX}; nothing was sent`);
  return paths.map((p) => {
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) throw new UploadRefused(`SEND_FILE_MISSING ${p}: no such file; nothing was sent`);
    if (!st.isFile()) throw new UploadRefused(`SEND_FILE_REFUSED ${p}: not a regular file; nothing was sent`);
    if (st.size === 0) throw new UploadRefused(`SEND_FILE_REFUSED ${p}: the file is empty (Slack takes no 0-byte upload); nothing was sent`);
    if (st.size > SLACK_FILE_MAX) throw new UploadRefused(`SEND_FILE_TOO_BIG ${p}: ${st.size} bytes, over Slack's ${SLACK_FILE_MAX} bytes (1 GB) a file; nothing was sent`);
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

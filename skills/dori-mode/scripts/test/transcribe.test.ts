import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../setups/discord-aoe/transcribe.sh");
let asr = "";

const exe = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};

// ffmpeg writes FAKE_SECS seconds of 16 kHz mono silence; whisper-cli prints plain text without -oj, and with -oj
// writes <input>.json for every -f: with FAKE_PIECE one line naming the piece and its length, else a first pass that loops
// on one line five times (FAKE_ZERO: all at one instant); the retry pass (-tp) hears two different lines, or fails with
// FAKE_RETRY_FAIL. The diarizer answers FAKE_TURNS.
beforeEach(() => {
  asr = mkdtempSync(join(tmpdir(), "dori-asr-"));
  exe(join(asr, "bin/ffmpeg"), `#!/usr/bin/env python3
import os, sys, wave
w = wave.open(sys.argv[-1], "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
w.writeframes(b"\\0\\0" * 16000 * int(os.environ["FAKE_SECS"])); w.close()
`);
  exe(join(asr, "whisper.cpp/build/bin/whisper-cli"), `#!/usr/bin/env python3
import json, os, sys
a = sys.argv
calls = os.path.join(os.environ["DORI_ASR_DIR"], "calls")
n = len(open(calls).read()) if os.path.exists(calls) else 0
open(calls, "a").write("x")
if n < int(os.environ.get("FAKE_CUDA_FAIL", "0")):
    print("ggml_cuda_init: found 1 CUDA devices:", file=sys.stderr)
    print("/src/whisper.cpp/ggml/src/ggml-cuda/ggml-cuda.cu:108: CUDA error", file=sys.stderr, flush=True)
    os.abort()
if os.environ.get("FAKE_PLAIN_FAIL"):
    print("error: failed to open the model", file=sys.stderr); sys.exit(2)
if "-oj" not in a:
    print(" hello there"); sys.exit(0)
import os, wave
seg = lambda f, t, x: {"offsets": {"from": f, "to": t}, "text": x}
for wav in [a[i + 1] for i, x in enumerate(a) if x == "-f"]:
    if os.environ.get("FAKE_PIECE"):
        rows = [seg(0, 1000, f" {os.path.basename(wav)} of {wave.open(wav).getnframes() // 16000} seconds")]
    elif "-tp" in a:
        if os.environ.get("FAKE_RETRY_FAIL"):
            sys.exit(3)
        rows = [seg(0, 4000, " fixed one"), seg(4000, 9000, " fixed two")]
    else:
        step = 0 if os.environ.get("FAKE_ZERO") else 2000
        rows = [seg(0, 5000, " opening words"), seg(5000, 10000, " reply words")]
        rows += [seg(10000 + i * step, 10000 + i * step + (step or 0), " stuck line") for i in range(5)]
    json.dump({"transcription": rows}, open(wav + ".json", "w"))
`);
});
afterEach(() => rmSync(asr, { recursive: true, force: true }));

// dori on PATH: gpu-room says what it did and leaves its arguments in <asr>/dori.log
const fakeDori = (): Record<string, string> => {
  exe(join(asr, "fakebin/dori"), `#!/bin/sh\necho "$*" >> "${asr}/dori.log"\necho "HEAVY_GPU_ROOM $2: pushed 20480M of cache out" >&2\n`);
  return { PATH: `${join(asr, "fakebin")}:${process.env.PATH}` };
};
const readOr = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");

const diarizer = () =>
  exe(join(asr, "diar/venv/bin/python"), `#!/usr/bin/env python3
import json, os, sys
# pyannote reads database.yml from the working directory, so a caller's unreadable one breaks it
assert os.getcwd() == os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(sys.argv[0])))), os.getcwd()
turns = os.environ.get("FAKE_TURNS") or '[[0, 5, "SPEAKER_07"], [5, 10, "SPEAKER_02"], [10, 30, "SPEAKER_07"]]'
open(sys.argv[-1], "w").write(turns)
`);

const run = async (secs: number, env: Record<string, string> = { DORI_ASR_CHUNK_SEC: "1000" }) => {
  const audio = join(asr, "in.ogg");
  writeFileSync(audio, "x");
  const p = Bun.spawn(["bash", SCRIPT, audio], {
    env: { ...process.env, DORI_ASR_DIR: asr, DORI_ASR_LANG: "ko", FAKE_SECS: String(secs), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out.trim(), err };
};

test("a short voice note stays one plain line, with no speaker labels", async () => {
  diarizer();
  expect(await run(20)).toMatchObject({ code: 0, out: "hello there" });
});

test("a long recording gets one line per speaker turn and a looping span transcribed again", async () => {
  diarizer();
  const r = await run(400);
  expect({ code: r.code, lines: r.out.split("\n") }).toEqual({
    code: 0,
    lines: ["[00:00:00] 화자1: opening words", "[00:00:05] 화자2: reply words", "[00:00:10] 화자1: fixed one fixed two"],
  });
  expect(r.err).toContain("REPEAT_FIXED 10.0-20.0s 5 lines -> 2 lines, 0 loop(s) left");
});

test("a long recording without the diarization install keeps its text, unlabeled", async () => {
  const r = await run(400);
  expect({ code: r.code, lines: r.out.split("\n") }).toEqual({
    code: 0,
    lines: ["[00:00:00] opening words reply words fixed one fixed two"],
  });
  expect(r.err).toContain("run setup-diarize.sh");
});

test("a long recording is transcribed in pieces of about DORI_ASR_CHUNK_SEC, each placed at its own time", async () => {
  diarizer();
  const turns = [[0, 95, "A"], [95, 190, "B"], [190, 285, "A"], [285, 400, "B"]];
  const r = await run(400, { DORI_ASR_CHUNK_SEC: "100", FAKE_PIECE: "1", FAKE_TURNS: JSON.stringify(turns) });
  expect({ code: r.code, lines: r.out.split("\n") }).toEqual({
    code: 0,
    lines: [
      "[00:00:00] 화자1: 0000.wav of 95 seconds",
      "[00:01:35] 화자2: 0001.wav of 95 seconds",
      "[00:03:10] 화자1: 0002.wav of 95 seconds",
      "[00:04:45] 화자2: 0003.wav of 115 seconds",
    ],
  });
});

test("a loop squeezed into one instant is kept once without a retry, and a failed retry keeps the lines it could not fix", async () => {
  const zero = await run(400, { DORI_ASR_CHUNK_SEC: "1000", FAKE_ZERO: "1" });
  expect({ code: zero.code, out: zero.out }).toEqual({ code: 0, out: "[00:00:00] opening words reply words stuck line" });
  expect(zero.err).toContain("REPEAT_COLLAPSED 10.0-10.0s 5 lines in under a second -> 1 line");
  const failed = await run(400, { DORI_ASR_CHUNK_SEC: "1000", FAKE_RETRY_FAIL: "1" });
  expect({ code: failed.code, out: failed.out }).toEqual({
    code: 0,
    out: "[00:00:00] opening words reply words stuck line stuck line stuck line stuck line stuck line",
  });
  expect(failed.err).toContain("REPEAT_LEFT 10.0-20.0s 5 lines kept: whisper-cli exit 3");
});

// 2026-11-02 20:33 KST: the owner's voice note failed in ggml_cuda_init (exit 134) while page cache filled the GB10's memory
test("a whisper-cli that dies in a CUDA error gets one more try after dori gpu-room, and the voice note is heard", async () => {
  const r = await run(20, { ...fakeDori(), FAKE_CUDA_FAIL: "1" });
  expect({ code: r.code, out: r.out, calls: readOr(join(asr, "calls")), room: readOr(join(asr, "dori.log")) }).toEqual({ code: 0, out: "hello there", calls: "xx", room: "gpu-room transcribe\n" });
  expect(r.err).toContain("TRANSCRIBE_CUDA_RETRY whisper-cli exit 134: /src/whisper.cpp/ggml/src/ggml-cuda/ggml-cuda.cu:108: CUDA error");
  expect(r.err).toContain("HEAVY_GPU_ROOM transcribe: pushed");
});

test("a second CUDA error fails with whisper-cli's code and its error, with no third try", async () => {
  const r = await run(20, { ...fakeDori(), FAKE_CUDA_FAIL: "9" });
  expect({ code: r.code, out: r.out, calls: readOr(join(asr, "calls")), room: readOr(join(asr, "dori.log")) }).toEqual({ code: 134, out: "", calls: "xx", room: "gpu-room transcribe\n" });
  expect(r.err).toContain("ggml-cuda.cu:108: CUDA error");
});

test("a failure that is not a CUDA error is not tried again and keeps its code", async () => {
  const r = await run(20, { ...fakeDori(), FAKE_PLAIN_FAIL: "1" });
  expect({ code: r.code, calls: readOr(join(asr, "calls")), room: readOr(join(asr, "dori.log")) }).toEqual({ code: 2, calls: "x", room: "" });
  expect(r.err).toContain("error: failed to open the model");
});

test("a long recording whose whisper-cli dies in a CUDA error is tried once more after dori gpu-room", async () => {
  diarizer();
  const r = await run(400, { ...fakeDori(), DORI_ASR_CHUNK_SEC: "1000", FAKE_CUDA_FAIL: "1" });
  expect({ code: r.code, lines: r.out.split("\n"), room: readOr(join(asr, "dori.log")) }).toEqual({
    code: 0,
    lines: ["[00:00:00] 화자1: opening words", "[00:00:05] 화자2: reply words", "[00:00:10] 화자1: fixed one fixed two"],
    room: "gpu-room transcribe\n",
  });
  expect(r.err).toContain("TRANSCRIBE_CUDA_RETRY whisper-cli exit -6: /src/whisper.cpp/ggml/src/ggml-cuda/ggml-cuda.cu:108: CUDA error");
});

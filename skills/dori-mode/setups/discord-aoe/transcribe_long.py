"""Long recordings (meetings) for transcribe.sh: whisper.cpp text, repeat-loop repair, speaker labels.

The audio is cut at its quietest moment near every DORI_ASR_CHUNK_SEC (60) seconds and all pieces go through one
whisper-cli call, so whisper.cpp's carried-over text never outlives a piece: a line it starts repeating stops at the
next cut instead of running to the end of the recording.

usage: python3 -I transcribe_long.py <whisper-cli> <ggml model> <16 kHz mono wav>   (env from transcribe.sh:
DORI_ASR_LANG, DORI_ASR_DIR, optional DORI_DIAR_DIR and the DORI_ASR_* options in the README). Prints one "[hh:mm:ss] <label>N: text" line per speaker turn; without the
diarization install (setup-diarize.sh) it prints the time-stamped text with no speaker and says why on stderr.
"""
import array
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import wave

CLI, MODEL = sys.argv[1], sys.argv[2]
LANG = os.environ.get("DORI_ASR_LANG", "auto")
ASR_DIR = os.environ["DORI_ASR_DIR"]
DIAR_DIR = os.environ.get("DORI_DIAR_DIR") or os.path.join(ASR_DIR, "diar")
HERE = os.path.dirname(os.path.abspath(__file__))
MAIN_OPTS = os.environ.get("DORI_ASR_LONG_OPTS", "").split()
CHUNK = float(os.environ.get("DORI_ASR_CHUNK_SEC", "60"))
RETRY_OPTS = os.environ.get("DORI_ASR_RETRY_OPTS", "-mc 0 -tp 0.4").split()
REPEAT_RUN = 3
LABEL = os.environ.get("DORI_ASR_SPEAKER_LABEL") or ("화자" if LANG == "ko" else "Speaker ")


def log(msg: str) -> None:
    print(f"transcribe_long: {msg}", file=sys.stderr)


CUDA_FAILED = re.compile(r"CUDA error|ggml_cuda_init: failed")


def whisper(parts: list[tuple[str, float]], opts: list[str]) -> list[list]:
    inputs = [a for wav, _ in parts for a in ("-f", wav)]
    argv = [CLI, "-m", MODEL, "-l", LANG, "-np", "-oj", *inputs, *opts]
    r = subprocess.run(argv, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace")
    hit = next((line for line in r.stderr.splitlines() if CUDA_FAILED.search(line)), None) if r.returncode else None
    if hit:
        # transcribe.sh: a CUDA start that failed while page cache filled a unified-memory GPU's memory gets one more
        # try after dori gpu-room pushed cache out; a second failure raises as before
        log(f"TRANSCRIBE_CUDA_RETRY whisper-cli exit {r.returncode}: {hit}")
        dori = shutil.which("dori") or os.path.expanduser("~/.bun/bin/dori")
        try:
            subprocess.run([dori, "gpu-room", "transcribe"], stdout=sys.stderr, check=True)
        except (OSError, subprocess.CalledProcessError) as e:
            log(f"TRANSCRIBE_GPU_ROOM_FAILED {dori}: {e}")
        r = subprocess.run(argv, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace")
    if r.returncode:
        sys.stderr.write("".join(r.stderr.splitlines(True)[-5:]))
        raise subprocess.CalledProcessError(r.returncode, argv)
    segs = []
    for wav, shift in parts:
        with open(wav + ".json", encoding="utf-8", errors="replace") as f:
            rows = json.load(f)["transcription"]
        segs += [[r["offsets"]["from"] / 1000 + shift, r["offsets"]["to"] / 1000 + shift, r["text"].strip()]
                 for r in rows if r["text"].strip()]
    return segs


def pieces(wav: str) -> list[tuple[float, float]]:
    with wave.open(wav) as w:
        rate = w.getframerate()
        pcm = array.array("h", w.readframes(w.getnframes()))
    total, frame = len(pcm) / rate, rate // 50
    cuts, t = [0.0], CHUNK
    while t < total - CHUNK / 4:
        lo, hi = int((t - 5) * rate), int(min(t + 5, total) * rate) - frame
        quiet = min(range(lo, hi, frame), key=lambda i: sum(map(abs, pcm[i:i + frame])))
        cuts.append(quiet / rate)
        t = quiet / rate + CHUNK
    return list(zip(cuts, cuts[1:] + [total]))


def norm(text: str) -> str:
    return re.sub(r"[\W_]+", "", text.lower())


def looping(text: str) -> bool:
    return re.search(r"(.{4,}?)\1{3,}", norm(text)) is not None


def loops(segs: list[list]) -> list[tuple[int, int]]:
    """Index ranges [i, j) of runs of REPEAT_RUN or more equal lines, and of single lines that repeat inside."""
    spans, i = [], 0
    while i < len(segs):
        j = i + 1
        while j < len(segs) and norm(segs[j][2]) and norm(segs[j][2]) == norm(segs[i][2]):
            j += 1
        if j - i >= REPEAT_RUN or looping(segs[i][2]):
            spans.append((i, j))
        i = j
    return spans


def cut(src: str, dst: str, start: float, end: float) -> None:
    with wave.open(src) as w:
        rate = w.getframerate()
        w.setpos(int(start * rate))
        frames = w.readframes(int((end - start) * rate))
        params = w.getparams()
    with wave.open(dst, "wb") as o:
        o.setparams(params)
        o.writeframes(frames)


def collapse(segs: list[list]) -> list[list]:
    out: list[list] = []
    for s in segs:
        if out and norm(s[2]) and norm(s[2]) == norm(out[-1][2]):
            out[-1][1] = s[1]
        else:
            out.append(s)
    return out


def repair(wav: str, segs: list[list]) -> list[list]:
    spans = loops(segs)
    if not spans:
        return segs
    out, last = [], 0
    for i, j in spans:
        out += segs[last:i]
        start, end = segs[i][0], segs[j - 1][1]
        last = j
        if end - start < 1:
            log(f"REPEAT_COLLAPSED {start:.1f}-{end:.1f}s {j - i} lines in under a second -> 1 line")
            out += collapse(segs[i:j])
            continue
        with tempfile.TemporaryDirectory() as tmp:
            part = os.path.join(tmp, "part.wav")
            cut(wav, part, start, end)
            try:
                again = whisper([(part, start)], RETRY_OPTS)
            except subprocess.CalledProcessError as e:
                log(f"REPEAT_LEFT {start:.1f}-{end:.1f}s {j - i} lines kept: whisper-cli exit {e.returncode}")
                out += segs[i:j]
                continue
        left = len(loops(again))
        log(f"REPEAT_FIXED {start:.1f}-{end:.1f}s {j - i} lines -> {len(again)} lines, {left} loop(s) left")
        out += collapse(again) if left else again
    return out + segs[last:]


def speakers(wav: str) -> list[list] | None:
    py = os.path.join(DIAR_DIR, "venv", "bin", "python")
    if not os.access(py, os.X_OK):
        log(f"no speaker labels: {py} missing (run setup-diarize.sh)")
        return None
    env = dict(os.environ, HF_HOME=os.path.join(DIAR_DIR, "hf"), HF_HUB_OFFLINE="1")
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "turns.json")
        r = subprocess.run([py, "-I", os.path.join(HERE, "diarize.py"), wav, out], env=env, cwd=DIAR_DIR,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        if r.returncode != 0:
            log(f"no speaker labels: diarize.py exit {r.returncode}: {r.stderr.strip()[-300:]}")
            return None
        with open(out) as f:
            return json.load(f)


def who(seg: list, turns: list[list]) -> str | None:
    best, best_overlap = None, 0.0
    for start, end, spk in turns:
        overlap = min(seg[1], end) - max(seg[0], start)
        if overlap > best_overlap:
            best, best_overlap = spk, overlap
    if best is None and turns:
        mid = (seg[0] + seg[1]) / 2
        best = min(turns, key=lambda t: min(abs(mid - t[0]), abs(mid - t[1])))[2]
    return best


def stamp(sec: float) -> str:
    s = int(sec)
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def main() -> int:
    wav = sys.argv[3]
    with tempfile.TemporaryDirectory() as tmp:
        parts = []
        for k, (start, end) in enumerate(pieces(wav)):
            parts.append((os.path.join(tmp, f"{k:04d}.wav"), start))
            cut(wav, parts[-1][0], start, end)
        segs = repair(wav, whisper(parts, MAIN_OPTS))
    turns = speakers(wav)
    names: dict[str, str] = {}
    lines: list[list] = []
    for seg in segs:
        spk = who(seg, turns) if turns else None
        name = names.setdefault(spk, f"{LABEL}{len(names) + 1}") if spk else ""
        if lines and lines[-1][1] == name:
            lines[-1][2].append(seg[2])
        else:
            lines.append([seg[0], name, [seg[2]]])
    for start, name, texts in lines:
        print(f"[{stamp(start)}] {name + ': ' if name else ''}{' '.join(texts)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

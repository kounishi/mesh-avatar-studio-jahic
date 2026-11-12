# /// script
# requires-python = ">=3.10"
# dependencies = ["faster-whisper>=1.1", "av>=11,<15", "truststore>=0.9"]
# ///
"""Find when each scenario line is spoken in a dialogue recording.

The scenario is a text file with one line per utterance: ``speaker,text``.
The audio is transcribed locally with Whisper (the model is downloaded once;
the audio never leaves this machine), the transcript is aligned to the
scenario text, and a timing table is written as CSV:

    line,speaker,start,end,text

Check the table and correct any times by hand, then pass it to
``npm run render-lipsync -- <project> <audio> --timeline <csv> --speaker <name>``.
"""

import argparse
import csv
import difflib
import re
import sys
import unicodedata
from pathlib import Path

import os

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

try:  # use the OS certificate store (corporate TLS proxies) for the model download
    import truststore

    truststore.inject_into_ssl()
except Exception:
    pass

SKIP = re.compile(r"[\s\W_]", re.UNICODE)


def norm(text):
    text = unicodedata.normalize("NFKC", text)
    return SKIP.sub("", text).lower()


def read_scenario(path):
    lines = []
    for n, raw in enumerate(Path(path).read_text(encoding="utf-8-sig").splitlines(), 1):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        if "," not in raw:
            sys.exit(f"{path}:{n}: expected 'speaker,text'")
        speaker, text = raw.split(",", 1)
        lines.append((speaker.strip(), text.strip()))
    if not lines:
        sys.exit(f"{path}: no lines")
    return lines


def transcribe(audio, model_name, device, language):
    from faster_whisper import WhisperModel

    model = WhisperModel(model_name, device=device, compute_type="int8" if device == "cpu" else "default")
    segments, info = model.transcribe(
        str(audio), language=language, word_timestamps=True, vad_filter=False,
        condition_on_previous_text=False,
    )
    chars, times = [], []
    duration = info.duration
    for seg in segments:
        print(f"\r  transcribed {seg.end:6.1f} / {duration:.1f} s", end="", file=sys.stderr)
        for w in seg.words or []:
            t = norm(w.word)
            if not t:
                continue
            step = (w.end - w.start) / len(t)
            for i, c in enumerate(t):
                chars.append(c)
                times.append((w.start + i * step, w.start + (i + 1) * step))
    print(file=sys.stderr)
    return "".join(chars), times, duration


def align(lines, heard, times, duration):
    script, owner = [], []
    for k, (_, text) in enumerate(lines):
        t = norm(text)
        script.append(t)
        owner += [k] * len(t)
    script = "".join(script)
    matcher = difflib.SequenceMatcher(None, script, heard, autojunk=False)
    spans = [[None, None, 0] for _ in lines]  # start, end, matched chars
    for a, b, size in matcher.get_matching_blocks():
        for i in range(size):
            k = owner[a + i]
            s, e = times[b + i]
            span = spans[k]
            span[0] = s if span[0] is None else min(span[0], s)
            span[1] = e if span[1] is None else max(span[1], e)
            span[2] += 1
    # Lines with too few matches get times between their neighbours.
    for k, (_, text) in enumerate(lines):
        if spans[k][2] < max(2, len(norm(text)) // 5):
            spans[k][0] = spans[k][1] = None
    known = [k for k in range(len(lines)) if spans[k][0] is not None]
    if not known:
        sys.exit("the transcript does not match the scenario; check the files")
    for k in range(len(lines)):
        if spans[k][0] is None:
            prev = max((j for j in known if j < k), default=None)
            nxt = min((j for j in known if j > k), default=None)
            spans[k][0] = spans[prev][1] if prev is not None else 0.0
            spans[k][1] = spans[nxt][0] if nxt is not None else duration
            spans[k][2] = -1
    # Keep lines in order and non-overlapping.
    for k in range(1, len(lines)):
        if spans[k][0] < spans[k - 1][1]:
            mid = (spans[k][0] + spans[k - 1][1]) / 2
            spans[k - 1][1] = spans[k][0] = mid
    return spans


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("audio")
    ap.add_argument("scenario", help="text file, one 'speaker,text' line per utterance")
    ap.add_argument("--out", help="CSV to write (default: <audio name>.timeline.csv next to the audio)")
    ap.add_argument("--model", default="large-v3-turbo", help="Whisper model (default large-v3-turbo; 'small' is faster but less exact)")
    ap.add_argument("--device", default="cpu", help="cpu (default) or cuda")
    ap.add_argument("--language", default="ja")
    args = ap.parse_args()

    audio = Path(args.audio).resolve()
    if not audio.is_file():
        sys.exit(f"not a file: {args.audio}")
    lines = read_scenario(args.scenario)
    out = Path(args.out) if args.out else audio.with_suffix(".timeline.csv")
    print(f"Transcribing {audio.name} with Whisper {args.model} (first run downloads the model)...", file=sys.stderr)
    heard, times, duration = transcribe(audio, args.model, args.device, args.language)
    spans = align(lines, heard, times, duration)

    with open(out, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["line", "speaker", "start", "end", "text"])
        for k, ((speaker, text), (s, e, _)) in enumerate(zip(lines, spans), 1):
            w.writerow([k, speaker, f"{s:.2f}", f"{e:.2f}", text])
    for k, ((speaker, text), (s, e, m)) in enumerate(zip(lines, spans), 1):
        flag = "  <- not heard; times guessed, please check" if m < 0 else ""
        print(f"{k:3d} {speaker:16s} {s:7.2f} - {e:7.2f}  {text[:24]}{flag}")
    speakers = sorted({s for s, _ in lines})
    print(f"Wrote {out}  (speakers: {', '.join(speakers)})")


if __name__ == "__main__":
    main()

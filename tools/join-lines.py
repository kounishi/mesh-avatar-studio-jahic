# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Join per-line voice files into one recording and write its timing table.

Input: a folder of WAV/MP3/... files, one per spoken line, named so that they sort in
order and carry the voice name, e.g. ``001_<voice>_<text>.wav`` (VOICEVOX style).
Output: one WAV with a short pause between lines, and a CSV timing table

    line,speaker,start,end,text

for ``npm run render-lipsync -- <project> <joined.wav> --timeline <csv> --speaker <name>``.

Map voice names to avatar project names with ``--map "<voice>=<project>"`` (repeatable).
Requires ffmpeg on PATH.
"""

import argparse
import csv
import re
import shutil
import subprocess
import sys
import wave
from pathlib import Path

RATE = 48000
AUDIO = {".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aac"}
NAME = re.compile(r"^(\d+)[_\- ]+([^_]+)(?:_(.*))?$")
TOGETHER = re.compile(r"\s*[&＆+＋]\s*")


def decode(ffmpeg, path):
    return subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(path),
         "-f", "s16le", "-ac", "1", "-ar", str(RATE), "-"],
        check=True, capture_output=True,
    ).stdout


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", help="folder with one audio file per line")
    ap.add_argument("--map", action="append", default=[], metavar="VOICE=PROJECT",
                    help="speaker name to use for a voice name in the file names (repeatable)")
    ap.add_argument("--gap", type=float, default=0.4, help="pause between lines, seconds (default 0.4)")
    ap.add_argument("--lead", type=float, default=0.5, help="silence before the first line (default 0.5)")
    ap.add_argument("--tail", type=float, default=1.0, help="silence after the last line (default 1.0)")
    ap.add_argument("--out", help="output WAV (default: <folder>/joined.wav); the CSV goes next to it")
    args = ap.parse_args()

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        sys.exit("ffmpeg not found; install it and add it to PATH")
    folder = Path(args.folder).resolve()
    out = Path(args.out).resolve() if args.out else folder / "joined.wav"
    table = out.with_suffix(".timeline.csv")
    mapping = {}
    for item in args.map:
        if "=" not in item:
            sys.exit(f"--map expects VOICE=PROJECT, got {item!r}")
        voice, project = item.split("=", 1)
        mapping[voice.strip()] = project.strip()

    files = sorted(p for p in folder.iterdir()
                   if p.suffix.lower() in AUDIO and p.resolve() != out and NAME.match(p.stem))
    if not files:
        sys.exit(f"no audio files named like 001_<voice>_<text>.wav in {folder}")

    pcm, rows, t = bytearray(), [], args.lead
    pcm += bytes(int(args.lead * RATE) * 2)
    for k, path in enumerate(files, 1):
        _, voice, text = NAME.match(path.stem).groups()
        data = decode(ffmpeg, path)
        length = len(data) / 2 / RATE
        # "a&b" in the file name: both speakers say the line together.
        speaker = "&".join(mapping.get(v, v) for v in TOGETHER.split(voice) if v)
        rows.append([k, speaker, f"{t:.3f}", f"{t + length:.3f}", text or ""])
        pcm += data
        t += length
        gap = args.gap if k < len(files) else args.tail
        pcm += bytes(int(gap * RATE) * 2)
        t = len(pcm) / 2 / RATE

    with wave.open(str(out), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(bytes(pcm))
    with open(table, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["line", "speaker", "start", "end", "text"])
        writer.writerows(rows)

    for row in rows:
        print(f"{row[0]:3d} {row[1]:16s} {float(row[2]):7.2f} - {float(row[3]):7.2f}  {row[4][:24]}")
    speakers = sorted({s for r in rows for s in r[1].split("&")})
    unmapped = [s for s in speakers if s not in mapping.values()]
    print(f"Wrote {out} ({t:.1f} s) and {table}")
    print(f"Speakers: {', '.join(speakers)}")
    if mapping and unmapped:
        print(f"Not mapped to a project: {', '.join(unmapped)}")


if __name__ == "__main__":
    main()

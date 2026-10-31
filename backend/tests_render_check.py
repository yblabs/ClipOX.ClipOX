"""Scratch validation for engine.render — builds a synthetic project and exports it.

Not part of the app; run it manually:

    cd backend && .venv/bin/python /tmp/test_render.py
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.config import FFMPEG_BIN
from app.engine import render as R
import subprocess

SRC = Path("/tmp/wv_src.mp4")
MUSIC = Path("/tmp/wv_music.wav")

if not SRC.is_file():
    subprocess.run([FFMPEG_BIN, "-y", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=20",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=20",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(SRC)], check=True)
if not MUSIC.is_file():
    subprocess.run([FFMPEG_BIN, "-y", "-loglevel", "error",
                    "-f", "lavfi", "-i", "sine=frequency=220:duration=8",
                    "-c:a", "pcm_s16le", str(MUSIC)], check=True)

project = {
    "id": "test",
    "aspect": "9:16",
    "layout": "fit",
    "source": {"path": str(SRC), "duration": 20},
    "clips": [
        {"id": "c1", "start": 0.0, "end": 5.0, "layout": "fit", "speed": 1, "volume": 1,
         "transition": {"type": "fade", "duration": 0.4},
         "effects": [{"type": "zoom_in", "intensity": 0.5, "start": 1.0, "end": 3.0}]},
        {"id": "c2", "start": 5.0, "end": 9.0, "layout": "split", "speed": 1.25, "volume": 0.8,
         "transition": {"type": "glitch", "duration": 0.3},
         "effects": [{"type": "vhs", "intensity": 0.6, "start": 5.0, "end": 9.0}]},
        {"id": "c3", "start": 9.0, "end": 13.0, "layout": "pip", "speed": 1, "volume": 1,
         "transition": {"type": "wipe", "duration": 0.5}, "effects": []},
    ],
    "subtitles": {"enabled": True, "preset": "word_highlight", "emojis": True,
                  "style": {"size": "medium", "position": "bottom"},
                  "lines": [{"start": 0.5, "end": 2.0, "text": "first clip money",
                             "words": [{"w": "first", "s": 0.5, "e": 1.0},
                                       {"w": "clip", "s": 1.0, "e": 1.4},
                                       {"w": "money", "s": 1.4, "e": 2.0}]},
                            {"start": 5.2, "end": 7.0, "text": "second clip part",
                             "words": [{"w": "second", "s": 5.2, "e": 5.8},
                                       {"w": "clip", "s": 5.8, "e": 6.3},
                                       {"w": "part", "s": 6.3, "e": 7.0}]}]},
    "texts": [{"id": "t1", "text": "TOP TEXT", "start": 0.2, "end": 2.5,
               "preset": "yellow_block", "style": {"y": 0.14}}],
    "hooks": [{"id": "h1", "text": "You need to see this", "start": 0.0, "end": 3.0,
               "preset": "boxed_white", "style": {"y": 0.08}}],
    "broll": [],
    "audio": {"enhance": False, "items": [
        {"media": str(MUSIC), "start": 0.5, "end": 8.0, "volume": 0.25,
         "fade_in": 0.5, "fade_out": 0.8, "duck": True},
    ]},
    "brand": {"logo": {"enabled": False}},
}

out = Path("/tmp/wv_out.mp4")
if out.exists():
    out.unlink()

t0 = time.time()
report = R.render_project(project, out, R.RenderOptions(resolution="720p", fps=30, quality="balanced",
                                                       burn_subtitles=True, watermark=True),
                          progress=lambda p, s: print(f"  {p:5.1f}% {s}", end="\r"))
print()
print("report:", report)
print("elapsed", round(time.time() - t0, 1))
print("probe:", R.probe(out))

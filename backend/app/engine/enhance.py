"""Sound tools: filler words, silences, Enhance Speech and speaker labels.

All three "Sound Good" actions in the AI Tools panel work the same way: they
analyse the transcript/audio, return something the user can inspect, and hand
back the cut spans or filter chain the renderer then applies.
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..config import FFMPEG_BIN, FFPROBE_BIN, SILENCE_DB, SILENCE_MIN_SEC

# ---------------------------------------------------------------------------
# Filler words (English + Hindi/Hinglish, which is what the studio sees most)
# ---------------------------------------------------------------------------
FILLERS: List[str] = [
    "um", "uh", "umm", "uhh", "erm", "err", "hmm", "mmm", "ah", "ahh", "eh",
    "like", "you know", "i mean", "sort of", "kind of", "basically", "literally",
    "actually", "honestly", "right", "okay so", "so yeah", "anyway",
    "matlab", "yaani", "yani", "wo", "wala", "arre", "arey", "haina", "na",
    "toh", "to", "bas", "kya", "ji", "haan", "acha", "accha",
]
_FILLER_SET = {f.lower() for f in FILLERS}
_MULTI = sorted([f for f in FILLERS if " " in f], key=len, reverse=True)


def _norm(word: str) -> str:
    return re.sub(r"[^\w']", "", str(word or "").lower())


def detect_fillers(segments: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Find filler words with their exact timestamps (word-level when present)."""
    found: Dict[str, Dict[str, Any]] = {}
    total = 0
    for seg in segments or []:
        words = [w for w in (seg.get("words") or []) if w.get("w")]
        if words:
            for word in words:
                token = _norm(word.get("w"))
                if token in _FILLER_SET:
                    entry = found.setdefault(token, {"word": token, "count": 0, "ranges": []})
                    entry["count"] += 1
                    entry["ranges"].append({"start": round(float(word.get("s", 0)), 3),
                                            "end": round(float(word.get("e", 0)), 3)})
                    total += 1
            continue
        # fall back to segment text when the model gave no word timings
        text = " ".join(_norm(t) for t in str(seg.get("text", "")).split())
        for filler in _MULTI + list(_FILLER_SET):
            if filler and re.search(rf"\b{re.escape(filler)}\b", text):
                entry = found.setdefault(filler, {"word": filler, "count": 0, "ranges": []})
                entry["count"] += 1
                entry["ranges"].append({"start": round(float(seg.get("start", 0)), 3),
                                        "end": round(float(seg.get("end", 0)), 3)})
                total += 1
    items = sorted(found.values(), key=lambda x: -x["count"])
    return {"words": items, "total": total,
            "dictionary": FILLERS,
            "removed_seconds": round(sum(r["end"] - r["start"]
                                         for item in items for r in item["ranges"]), 2)}


def spans_after_cuts(duration: float, cuts: List[Tuple[float, float]],
                     *, pad: float = 0.05, min_span: float = 0.12) -> List[Tuple[float, float]]:
    """Complement of *cuts* over ``[0, duration]`` — the kept spans.

    ``pad`` shrinks every cut slightly so a crossfade has room and speech is not
    clipped at the edges of a removed word.
    """
    cleaned: List[Tuple[float, float]] = []
    for start, end in sorted(cuts):
        a = max(0.0, float(start) + pad)
        b = min(float(duration), float(end) - pad)
        if b - a <= 0.01:
            a, b = max(0.0, float(start)), min(float(duration), float(end))
        if b > a:
            cleaned.append((a, b))
    spans: List[Tuple[float, float]] = []
    cursor = 0.0
    for a, b in cleaned:
        if a - cursor >= min_span:
            spans.append((cursor, a))
        cursor = max(cursor, b)
    if duration - cursor >= min_span:
        spans.append((cursor, duration))
    return spans or [(0.0, duration)]


def merge_ranges(ranges: List[Dict[str, Any]], *, gap: float = 0.06) -> List[Tuple[float, float]]:
    """Merge overlapping/nearby cut ranges (adjacent fillers, silence joins)."""
    merged: List[List[float]] = []
    for item in sorted(ranges, key=lambda r: float(r.get("start", 0))):
        start, end = float(item.get("start", 0)), float(item.get("end", 0))
        if end <= start:
            continue
        if merged and start - merged[-1][1] <= gap:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [(a, b) for a, b in merged]


# ---------------------------------------------------------------------------
# Silences (delegates to the shared detector so both features agree)
# ---------------------------------------------------------------------------
def detect_silences(src: Path | str, *, threshold_db: float = SILENCE_DB,
                    min_duration: float = SILENCE_MIN_SEC) -> Dict[str, Any]:
    from .edit import detect_silence

    report = detect_silence(str(src), threshold_db=threshold_db, min_duration=min_duration)
    return {
        "threshold_db": report.threshold_db,
        "min_duration": report.min_duration,
        "duration": round(report.duration, 3),
        "silences": [{"start": round(s.start, 3), "end": round(s.end, 3),
                      "duration": round(s.duration, 3)} for s in report.silenced],
        "removed_seconds": round(report.saved, 3),
    }


# ---------------------------------------------------------------------------
# Enhance Speech
# ---------------------------------------------------------------------------
def enhance_filters(strength: float = 1.0) -> str:
    """Denoise + voice clarity + EBU R128 loudness normalisation."""
    strength = max(0.2, min(1.5, float(strength or 1.0)))
    return (
        f"highpass=f=70,lowpass=f=11000,"
        f"afftdn=nr={int(6 + 10 * strength)}:nf=-25,"
        f"speechnorm=e={4 + 3 * strength:.2f}:r=0.0001,"
        f"equalizer=f=250:t=q:w=1.2:g=-2,"
        f"equalizer=f=3000:t=q:w=1.4:g={1.5 + strength:.1f},"
        f"loudnorm=I=-16:TP=-1.5:LRA=11"
    )


def preview_pair(src: Path | str, out_dir: Path | str, *, start: float = 0.0,
                 duration: float = 8.0) -> Dict[str, str]:
    """Render the same slice with and without enhancement for the A/B player."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    before = out_dir / "speech_before.mp3"
    after = out_dir / "speech_after.mp3"
    base = [FFMPEG_BIN, "-y", "-hide_banner", "-loglevel", "error",
            "-ss", f"{max(0.0, start):.3f}", "-t", f"{max(0.5, duration):.3f}", "-i", str(src)]
    subprocess.run(base + ["-vn", "-ac", "2", "-ar", "48000", "-b:a", "160k", str(before)],
                   capture_output=True, text=True, timeout=180)
    subprocess.run(base + ["-vn", "-af", enhance_filters(), "-ac", "2", "-ar", "48000",
                           "-b:a", "160k", str(after)],
                   capture_output=True, text=True, timeout=600)
    return {"before": str(before), "after": str(after)}


# ---------------------------------------------------------------------------
# Speaker labels
# ---------------------------------------------------------------------------
SPEAKER_COLORS = ["#2BF5A0", "#38BDF8", "#FFE14D", "#FF8A3D", "#FF5DA2", "#B18CFF"]


def assign_speakers(segments: List[Dict[str, Any]], *, gap: float = 1.05,
                    max_speakers: int = 4) -> Dict[str, Any]:
    """Label lines with a speaker id.

    Without a diarisation model this uses turn-taking: a pause longer than
    ``gap`` seconds is treated as a speaker change, and consecutive short lines
    stay with the current speaker. Good enough for captions, and the labels are
    editable in the Subtitles panel.
    """
    speakers: List[Dict[str, Any]] = []
    current = 0
    previous_end: Optional[float] = None
    out: List[Dict[str, Any]] = []
    for index, seg in enumerate(segments or []):
        start = float(seg.get("start", 0))
        if previous_end is not None and index > 0 and start - previous_end > gap:
            current = (current + 1) % max_speakers
        previous_end = float(seg.get("end", start))
        item = dict(seg)
        item["speaker"] = current
        out.append(item)
        if not any(s["id"] == current for s in speakers):
            speakers.append({"id": current, "label": f"Speaker {current + 1}",
                             "color": SPEAKER_COLORS[current % len(SPEAKER_COLORS)],
                             "lines": 0})
        for speaker in speakers:
            if speaker["id"] == current:
                speaker["lines"] += 1
    return {"segments": out, "speakers": speakers,
            "note": "turn-taking heuristic (pause based), editable in Subtitles → Edit"}


# ---------------------------------------------------------------------------
# Audio mix helpers used by the AI Music / SFX panels
# ---------------------------------------------------------------------------
def local_music(mood: str, duration: float, out_path: Path | str) -> str:
    """Offline fallback bed: a layered chord pad built with FFmpeg oscillators.

    Used when no music-generation key is configured so "AI Music" still produces
    real, usable audio instead of failing.
    """
    mood = (mood or "calm").lower()
    roots = {
        "calm": [220.0, 277.2, 329.6], "chill": [196.0, 246.9, 293.7],
        "happy": [261.6, 329.6, 392.0], "epic": [130.8, 196.0, 261.6],
        "dark": [110.0, 138.6, 164.8], "upbeat": [293.7, 370.0, 440.0],
        "lofi": [174.6, 220.0, 261.6], "sad": [146.8, 174.6, 220.0],
    }.get(mood, [220.0, 277.2, 329.6])

    duration = max(2.0, min(600.0, float(duration or 20)))
    inputs: List[str] = []
    filters: List[str] = []
    for i, freq in enumerate(roots):
        inputs += ["-f", "lavfi", "-i", f"sine=frequency={freq}:duration={duration:.2f}"]
        filters.append(f"[{i}:a]volume={0.18 / (i * 0.35 + 1):.3f},"
                       f"tremolo=f={0.4 + i * 0.2:.2f}:d=0.35[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(len(roots)))
    filters.append(f"{mix}amix=inputs={len(roots)}:normalize=0,"
                   f"aecho=0.7:0.6:60|120:0.25|0.15,"
                   f"afade=t=in:st=0:d=1.2,afade=t=out:st={max(0.0, duration - 1.5):.2f}:d=1.5,"
                   f"lowpass=f=6000,volume=0.9[out]")
    cmd = ([FFMPEG_BIN, "-y", "-hide_banner", "-loglevel", "error"] + inputs +
           ["-filter_complex", ";".join(filters), "-map", "[out]",
            "-c:a", "libmp3lame", "-b:a", "192k", str(out_path)])
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if proc.returncode != 0 or not os.path.isfile(out_path):
        raise RuntimeError(f"local music synthesis failed: {proc.stderr[-300:]}")
    return str(out_path)


def local_sfx(prompt: str, out_path: Path | str, *, duration: float = 1.2) -> str:
    """Offline fallback sound effect: shaped noise/sine by keyword."""
    text = (prompt or "").lower()
    duration = max(0.15, min(8.0, float(duration or 1.2)))
    if any(k in text for k in ("whoosh", "swoosh", "sweep", "transition", "slide")):
        # NOTE: the lavfi graph is passed as one argv entry (no shell), so
        # quoting an expression here would reach ffmpeg as literal quotes.
        # lowpass takes a fixed frequency here: its option is not an expression
        # in this build, and the fades already give the sweep its shape.
        filt = (f"anoisesrc=d={duration:.2f}:c=pink:a=0.6,highpass=f=200,"
                f"lowpass=f=8000,afade=t=in:st=0:d=0.05,"
                f"afade=t=out:st={duration * 0.7:.2f}:d={duration * 0.3:.2f},volume=0.9")
    elif any(k in text for k in ("pop", "click", "notification", "ding")):
        filt = (f"sine=frequency=880:duration={duration:.2f},"
                f"afade=t=out:st=0.02:d={max(0.05, duration - 0.02):.2f},volume=0.7")
    elif any(k in text for k in ("boom", "hit", "impact", "thud", "bass")):
        filt = (f"sine=frequency=70:duration={duration:.2f},volume=1.2,"
                f"afade=t=out:st=0:d={duration:.2f},lowpass=f=220")
    elif any(k in text for k in ("riser", "tension", "rise", "build")):
        # a swept tone needs an expression source; ``sine`` only takes a
        # constant frequency.
        filt = (f"aevalsrc=0.35*sin(2*PI*t*(150+60*t)):s=48000:d={duration:.2f},"
                f"afade=t=in:st=0:d={duration * 0.85:.2f},volume=0.55")
    else:
        filt = (f"anoisesrc=d={duration:.2f}:c=white:a=0.4,"
                f"afade=t=out:st=0:d={duration:.2f},volume=0.5")
    cmd = [FFMPEG_BIN, "-y", "-hide_banner", "-loglevel", "error",
           "-f", "lavfi", "-i", filt, "-c:a", "libmp3lame", "-b:a", "192k", str(out_path)]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if proc.returncode != 0 or not os.path.isfile(out_path):
        raise RuntimeError(f"local sound-effect synthesis failed: {proc.stderr[-300:]}")
    return str(out_path)

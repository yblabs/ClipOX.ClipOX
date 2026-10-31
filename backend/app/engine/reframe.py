"""Auto Reframe: aspect ratio conversion with subject tracking.

Real analysis, no API needed:

1. sample the source every ``sample_step`` seconds with OpenCV,
2. run a face detector on each sample (Haar cascade that ships with OpenCV),
3. group the samples into scenes (transcript segments when available, otherwise
   even windows, refined by cuts from :mod:`scenes`),
4. pick a layout per scene — one speaker keeps a tracked crop, two get a split
   screen, three get a trio, nothing detectable keeps the whole frame blurred —
   and smooth the crop centre so the movement does not jitter.

The planner returns *clips*: the timeline is rebuilt so each scene carries its
own layout and crop, which is exactly what the timeline UI renders and what
:mod:`render` compiles.
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import effects as fx
from .scenes import detect_scenes

CASCADE = "haarcascade_frontalface_default.xml"


class ReframeError(RuntimeError):
    pass


def _cascade():
    try:
        import cv2  # type: ignore
    except ImportError as exc:  # pragma: no cover - env dependent
        raise ReframeError("OpenCV is not installed (pip install opencv-python-headless)") from exc
    path = Path(cv2.data.haarcascades) / CASCADE
    cascade = cv2.CascadeClassifier(str(path))
    if cascade.empty():
        raise ReframeError(f"face cascade unavailable at {path}")
    return cv2, cascade


def sample_faces(src: Path | str, *, step: float = 0.5, max_samples: int = 400,
                 duration: Optional[float] = None) -> List[Dict[str, Any]]:
    """Face boxes on a time grid. Returns ``[{t, faces:[{x,y,w,h}], width, height}]``."""
    cv2, cascade = _cascade()
    capture = cv2.VideoCapture(str(src))
    if not capture.isOpened():
        raise ReframeError(f"cannot read video: {src}")
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    frames = capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    total = duration or (frames / fps if fps else 0.0)

    samples: List[Dict[str, Any]] = []
    t = 0.0
    work_w = 480
    scale = (work_w / width) if width else 1.0
    while t < max(1.0, total) and len(samples) < max_samples:
        capture.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
        ok, frame = capture.read()
        if not ok:
            break
        small = cv2.resize(frame, (work_w, max(2, int(height * scale)))) if scale != 1 else frame
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        faces = cascade.detectMultiScale(gray, scaleFactor=1.12, minNeighbors=5,
                                         minSize=(int(work_w * 0.05), int(work_w * 0.05)))
        boxes = []
        for (x, y, w, h) in (faces if len(faces) else []):
            boxes.append({"x": float(x) / work_w, "y": float(y) / small.shape[0],
                          "w": float(w) / work_w, "h": float(h) / small.shape[0]})
        samples.append({"t": round(t, 3), "faces": boxes, "width": width, "height": height})
        t += max(0.15, step)
    capture.release()
    return samples


def _smooth(values: Sequence[float], window: int = 5) -> List[float]:
    if not values:
        return []
    out: List[float] = []
    half = max(1, window // 2)
    for i in range(len(values)):
        lo, hi = max(0, i - half), min(len(values), i + half + 1)
        chunk = values[lo:hi]
        out.append(sum(chunk) / len(chunk))
    return out


def _scene_windows(total: float, segments: Optional[List[Dict[str, Any]]],
                   cuts: Optional[List[float]]) -> List[Tuple[float, float]]:
    """Scene boundaries: transcript segments, else cuts, else 4 s windows."""
    bounds: List[float] = []
    if segments:
        bounds = [float(s.get("start", 0)) for s in segments if float(s.get("end", 0)) > 0]
    elif cuts:
        bounds = list(cuts)
    if not bounds:
        bounds = [i * 4.0 for i in range(1, int(total // 4.0) + 1)]
    edges = sorted({0.0, *[b for b in bounds if 0 < b < total], round(total, 3)})
    windows = [(edges[i], edges[i + 1]) for i in range(len(edges) - 1)
               if edges[i + 1] - edges[i] > 0.35]
    # merge very short windows into the previous one
    merged: List[List[float]] = []
    for a, b in windows:
        if merged and b - a < 1.2:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    return [(a, b) for a, b in merged] or [(0.0, total)]


def plan(
    src: Path | str,
    *,
    ratio: str = "9:16",
    layout_pref: str = "auto",
    duration: float = 0.0,
    segments: Optional[List[Dict[str, Any]]] = None,
    use_scene_detect: bool = False,
) -> Dict[str, Any]:
    """Analyse *src* and return per-scene layouts + tracked crops."""
    samples = sample_faces(src, duration=duration or None)
    if not samples:
        raise ReframeError("no frames could be sampled from the source")

    sw = samples[0]["width"] or 1920
    sh = samples[0]["height"] or 1080
    target = fx.ASPECTS.get(ratio, fx.ASPECTS["9:16"])
    target_ratio = target["w"] / target["h"]
    source_ratio = sw / sh if sh else 1.777

    cuts = None
    if use_scene_detect:
        try:
            cuts = detect_scenes(src)
        except Exception:
            cuts = None

    total = float(duration or 0.0)
    if not total:
        try:
            from .render import probe
            total = float(probe(src).get("duration") or 0.0)
        except Exception:
            total = samples[-1]["t"] + 1.0

    windows = _scene_windows(total, segments, cuts)

    # per-sample horizontal face centre (0..1 of the source width)
    centres: List[float] = []
    for sample in samples:
        boxes = sample["faces"]
        if boxes:
            # weight the largest face most (that is the speaker)
            boxes = sorted(boxes, key=lambda b: -(b["w"] * b["h"]))
            centres.append(boxes[0]["x"] + boxes[0]["w"] / 2)
        else:
            centres.append(float("nan"))
    last_known = 0.5
    for i, value in enumerate(centres):
        if math.isnan(value):
            centres[i] = last_known
        else:
            last_known = value
    smooth = _smooth(centres, 7)

    scenes: List[Dict[str, Any]] = []
    for start, end in windows:
        inside = [i for i, s in enumerate(samples) if start <= s["t"] <= end]
        if not inside:
            inside = [min(range(len(samples)), key=lambda i: abs(samples[i]["t"] - start))]
        boxes: List[Dict[str, float]] = []
        for i in inside:
            boxes.extend(samples[i]["faces"])
        face_count = max((len(samples[i]["faces"]) for i in inside), default=0)
        biggest = max(boxes, key=lambda b: b["w"] * b["h"], default=None)
        centre = sum(smooth[i] for i in inside) / len(inside) if inside else 0.5
        spread = 0.0
        if boxes:
            xs = [b["x"] + b["w"] / 2 for b in boxes]
            spread = max(xs) - min(xs)

        if layout_pref and layout_pref != "auto":
            chosen = layout_pref
            reason = "you picked it in Global Layout"
        elif face_count >= 3:
            chosen, reason = "trio", f"{face_count} people on screen – stacked trio"
        elif face_count == 2:
            chosen, reason = "split", "two speakers – split screen keeps both in frame"
        elif face_count == 1:
            if abs(source_ratio - target_ratio) < 0.05 or source_ratio < target_ratio:
                chosen, reason = "full", "source already matches the target ratio"
            else:
                chosen, reason = "full", "one speaker – tracked crop keeps them centred"
        else:
            if abs(source_ratio - target_ratio) < 0.05:
                chosen, reason = "full", "source already matches the target ratio"
            else:
                chosen, reason = "blur", "no face detected – blurred fit keeps everything visible"

        crop = {"x": round(centre, 4), "y": 0.5, "w": 1.0, "h": 1.0}
        if chosen in ("full", "fit") and abs(source_ratio - target_ratio) > 0.01:
            if source_ratio > target_ratio:      # source wider → crop the sides
                keep = target_ratio / source_ratio
                crop = {"x": round(min(1.0, max(0.0, centre)), 4), "y": 0.5, "w": round(keep, 4), "h": 1.0}
                span = 1.0 - keep
                crop["x"] = round(min(1.0, max(0.0, (centre - keep / 2) / span)), 4) if span > 1e-4 else 0.5
            else:                                # source taller → crop the top/bottom
                keep = source_ratio / target_ratio
                crop = {"x": 0.5, "y": 0.35, "w": 1.0, "h": round(keep, 4)}
        scenes.append({
            "start": round(start, 3), "end": round(end, 3),
            "layout": chosen, "crop": crop,
            "faces": face_count, "spread": round(spread, 3),
            "track": [round(smooth[i], 3) for i in inside],
            "reason": reason,
            "source_ratio": round(source_ratio, 3),
        })

    return {
        "scenes": scenes,
        "ratio": ratio,
        "source": {"width": sw, "height": sh},
        "samples": len(samples),
        "duration": round(total, 3),
        "engine": "opencv-haar + pause-aware scene windows",
    }


def apply_to_clips(clips: List[Dict[str, Any]], scenes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Rebuild the clip list so every scene carries its own layout + crop.

    Overlaps are kept: each scene only inherits the parts of a clip it covers,
    and clip-level settings (speed, volume, effects, transitions) are preserved
    for the piece starting at the same place.
    """
    out: List[Dict[str, Any]] = []
    for index, scene in enumerate(scenes):
        start, end = float(scene["start"]), float(scene["end"])
        for clip in clips:
            c_start, c_end = float(clip.get("start", 0)), float(clip.get("end", 0))
            a, b = max(start, c_start), min(end, c_end)
            if b - a <= 0.08:
                continue
            piece = dict(clip)
            piece["id"] = f"{clip.get('id', 'c')}_s{index}"
            piece["start"], piece["end"] = round(a, 3), round(b, 3)
            piece["layout"] = scene["layout"]
            crop = dict(scene.get("crop") or {})
            if scene["track"]:
                # keep the first tracked centre so the crop starts where the speaker is
                crop["x"] = scene["track"][0]
            piece["crop"] = crop
            piece["reframe"] = {"reason": scene.get("reason", ""), "faces": scene.get("faces", 0)}
            out.append(piece)
    out.sort(key=lambda c: float(c["start"]))
    if out:
        out[0]["transition"] = {"type": "none", "duration": 0.3}
    return out

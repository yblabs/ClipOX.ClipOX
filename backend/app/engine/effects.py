"""Layouts, transitions and visual effects → FFmpeg filter fragments.

Three registries the editor, the preview and the renderer all read from, so the
timeline UI and the exported file agree on what "Trio" or "VHS" means:

``LAYOUTS``      how a source frame is fitted onto the output canvas
``TRANSITIONS``  clip-to-clip transitions (FFmpeg ``xfade`` keywords)
``EFFECTS``      stackable looks, each with an intensity in 0..1

``video_layout`` returns a filter chain that consumes exactly one video label
and produces one at canvas size; ``effect_chain`` does the same for a look.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

# ---------------------------------------------------------------------------
# Canvas geometry
# ---------------------------------------------------------------------------
ASPECTS: Dict[str, Dict[str, Any]] = {
    "9:16": {"label": "9:16 Vertical", "w": 9, "h": 16},
    "1:1":  {"label": "1:1 Square",    "w": 1, "h": 1},
    "4:5":  {"label": "4:5 Portrait",  "w": 4, "h": 5},
    "16:9": {"label": "16:9 Landscape", "w": 16, "h": 9},
}

RESOLUTIONS: Dict[str, Dict[str, Any]] = {
    "720p":  {"label": "720p",  "short": 720,  "crf": 23},
    "1080p": {"label": "1080p", "short": 1080, "crf": 21},
    "4k":    {"label": "4K",    "short": 2160, "crf": 19},
}


def canvas_size(aspect: str = "9:16", resolution: str = "1080p") -> Tuple[int, int]:
    """Even ``(width, height)`` for an aspect + resolution pair."""
    spec = ASPECTS.get(aspect, ASPECTS["9:16"])
    short = RESOLUTIONS.get(resolution, RESOLUTIONS["1080p"])["short"]
    ratio = spec["w"] / spec["h"]
    if ratio <= 1:                      # vertical or square: short side = width
        w, h = short, short / ratio
    else:                               # landscape: short side = height
        w, h = short * ratio, short
    w, h = int(round(w)), int(round(h))
    return w + (w % 2), h + (h % 2)


FIT = "force_original_aspect_ratio"


LAYOUTS: Dict[str, Dict[str, Any]] = {
    "full":  {"label": "Full Screen", "blurb": "Fill the frame, crop the edges."},
    "fit":   {"label": "Fit", "blurb": "Whole frame visible, letterboxed."},
    "blur":  {"label": "Blurred", "blurb": "Video fit over a blurred background."},
    "split": {"label": "Split Screen", "blurb": "Two speakers stacked."},
    "trio":  {"label": "Three Speakers", "blurb": "Three stacked bands."},
    "grid":  {"label": "Grid", "blurb": "2×2 grid of the same source."},
    "pip":   {"label": "PiP", "blurb": "Full-bleed video with a picture-in-picture."},
}


def video_layout(layout: str, w: int, h: int) -> List[str]:
    """Filter chain (list of fragments) rendering *layout* on a *w*×*h* canvas.

    The chain expects a single input label and emits a single output label, so
    callers write ``[in]{';'.join(video_layout(...))}[out]``.
    """
    W, H, layout = w, h, (layout or "fit")
    W2, H2 = W // 2, H // 2
    W3, H3 = W // 3, H // 3

    if layout == "full":
        return [f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1"]
    if layout == "fit":
        return [f"scale={W}:{H}:force_original_aspect_ratio=decrease,"
                f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=0x04070A,setsar=1"]
    if layout == "blur":
        return [
            "split=2[lb][lf]",
            f"[lb]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
            "boxblur=luma_radius=40:luma_power=2,eq=brightness=-0.06[lbg]",
            f"[lf]scale={W}:{H}:force_original_aspect_ratio=decrease[lfx]",
            "[lbg][lfx]overlay=(W-w)/2:(H-h)/2,setsar=1",
        ]
    if layout == "split":
        # left half of the source on top, right half below (two speakers)
        return [
            "split=2[s1][s2]",
            f"[s1]crop=iw/2:ih:0:0,scale={W}:{H2}:force_original_aspect_ratio=increase,crop={W}:{H2}[t]",
            f"[s2]crop=iw/2:ih:iw/2:0,scale={W}:{H2}:force_original_aspect_ratio=increase,crop={W}:{H2}[b]",
            "[t][b]vstack=inputs=2,setsar=1",
        ]
    if layout == "trio":
        return [
            "split=3[s1][s2][s3]",
            f"[s1]crop=iw/3:ih:0:0,scale={W}:{H3}:force_original_aspect_ratio=increase,crop={W}:{H3}[t1]",
            f"[s2]crop=iw/3:ih:iw/3:0,scale={W}:{H3}:force_original_aspect_ratio=increase,crop={W}:{H3}[t2]",
            f"[s3]crop=iw/3:ih:2*iw/3:0,scale={W}:{H3}:force_original_aspect_ratio=increase,crop={W}:{H3}[t3]",
            "[t1][t2][t3]vstack=inputs=3,setsar=1",
        ]
    if layout == "grid":
        return [
            "split=4[g1][g2][g3][g4]",
            f"[g1]crop=iw/2:ih/2:0:0,scale={W2}:{H2}:{FIT}=increase,crop={W2}:{H2}[q1]",
            f"[g2]crop=iw/2:ih/2:iw/2:0,scale={W2}:{H2}:{FIT}=increase,crop={W2}:{H2}[q2]",
            f"[g3]crop=iw/2:ih/2:0:ih/2,scale={W2}:{H2}:{FIT}=increase,crop={W2}:{H2}[q3]",
            f"[g4]crop=iw/2:ih/2:iw/2:ih/2,scale={W2}:{H2}:{FIT}=increase,crop={W2}:{H2}[q4]",
            "[q1][q2]hstack=inputs=2[r1]", "[q3][q4]hstack=inputs=2[r2]",
            "[r1][r2]vstack=inputs=2,setsar=1",
        ]
    if layout == "pip":
        pw, ph = int(W * 0.32) // 2 * 2, int(H * 0.22) // 2 * 2
        return [
            "split=2[pm][pi]",
            f"[pm]scale={W}:{H}:{FIT}=increase,crop={W}:{H}[pmx]",
            f"[pi]scale={pw}:{ph}:{FIT}=increase,crop={pw}:{ph},"
            "pad=iw+8:ih+8:4:4:color=0x2BF5A0[pix]",
            f"[pmx][pix]overlay=W-w-32:H-h-32,setsar=1",
        ]
    return video_layout("fit", w, h)


# ---------------------------------------------------------------------------
# Transitions (clip → clip)
# ---------------------------------------------------------------------------
TRANSITIONS: Dict[str, Dict[str, Any]] = {
    "none":      {"label": "None", "xfade": "", "blurb": "Hard cut."},
    "fade":      {"label": "Fade", "xfade": "fade", "blurb": "Classic dip to black."},
    "cross_zoom": {"label": "Cross Zoom", "xfade": "zoomin", "blurb": "Zoom into the next clip."},
    "dreamy":    {"label": "Dreamy", "xfade": "dissolve", "blurb": "Soft cross dissolve."},
    "slide":     {"label": "Slide", "xfade": "slideleft", "blurb": "Next clip slides in."},
    "wipe":      {"label": "Wipe", "xfade": "wipeleft", "blurb": "Directional wipe."},
    "glitch":    {"label": "Glitch", "xfade": "pixelize", "blurb": "Pixelated cut."},
    "circle":    {"label": "Circle", "xfade": "circleopen", "blurb": "Circular reveal."},
    "spin":      {"label": "Spin", "xfade": "radial", "blurb": "Radial spin."},
    "squeeze":   {"label": "Squeeze", "xfade": "squeezeh", "blurb": "Horizontal squeeze."},
    "blur":      {"label": "Blur", "xfade": "fadeblack", "blurb": "Through black."},
}


def transition_key(name: str) -> str:
    return (TRANSITIONS.get(name or "none", TRANSITIONS["none"]) or {}).get("xfade", "")


# ---------------------------------------------------------------------------
# Effects
# ---------------------------------------------------------------------------
def _amp(intensity: float) -> float:
    return max(0.0, min(1.0, float(intensity if intensity is not None else 0.5)))


EFFECTS: Dict[str, Dict[str, Any]] = {
    "zoom_in":      {"label": "Zoom in", "default": 0.5},
    "zoom_out":     {"label": "Zoom out", "default": 0.5},
    "handheld":     {"label": "Handheld Shake", "default": 0.5},
    "camera_shock": {"label": "Camera Shock", "default": 0.5},
    "focus_pull":   {"label": "Focus Pull In", "default": 0.5},
    "shake":        {"label": "Shake", "default": 0.7},
    "glitch":       {"label": "Glitch", "default": 0.6},
    "vhs":          {"label": "VHS Effect", "default": 0.6},
    "aged_film":    {"label": "Aged Film", "default": 0.6},
}


def effect_chain(kind: str, intensity: float, w: int, h: int, fps: int = 30) -> List[str]:
    """FFmpeg fragments realising *kind* at *intensity* on a *w*×*h* canvas."""
    k = _amp(intensity)
    if kind in ("zoom_in", "zoom_out"):
        speed = 0.0012 * (0.4 + k)
        if kind == "zoom_in":
            z = f"min(max(pzoom,1.0)+{speed:.5f},1.5)"
        else:
            z = f"max(1.0,if(lte(pzoom,1.0),1.5,pzoom-{speed:.5f}))"
        return [
            f"zoompan=z='{z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
            f"d=1:s={w}x{h}:fps={fps}"
        ]
    if kind == "handheld":
        a = 6.0 * k + 2
        return [
            f"crop=w={w}*0.96:h={h}*0.96:"
            f"x='(iw-ow)/2+sin(t*7.3)*{a:.2f}':y='(ih-oh)/2+cos(t*5.9)*{a * 0.75:.2f}',"
            f"scale={w}:{h}"
        ]
    if kind == "camera_shock":
        a = 16.0 * k + 2
        return [
            f"crop=w={w}*0.93:h={h}*0.93:"
            f"x='(iw-ow)/2+sin(t*23)*{a:.2f}':y='(ih-oh)/2+cos(t*19)*{a * 0.6:.2f}',"
            f"scale={w}:{h}"
        ]
    if kind == "shake":
        a = 22.0 * k + 3
        return [
            f"crop=w={w}*0.9:h={h}*0.9:"
            f"x='(iw-ow)/2+sin(t*31)*{a:.2f}':y='(ih-oh)/2+cos(t*27)*{a * 0.7:.2f}',"
            f"scale={w}:{h}"
        ]
    if kind == "focus_pull":
        return [
            f"zoompan=z='min(max(pzoom,1.0)+{0.0009 * (0.5 + k):.5f},1.18)':"
            f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={w}x{h}:fps={fps}",
            f"unsharp=5:5:{0.6 + k:.2f}:5:5:0.0",
        ]
    if kind == "glitch":
        return [
            f"rgbashift=rh={int(6 * k) + 2}:bh=-{int(4 * k) + 1}:gh={int(2 * k)}",
            f"noise=alls={int(10 * k) + 2}:allf=t",
        ]
    if kind == "vhs":
        return [
            f"chromashift=cbh={int(8 * k) + 2}:crh=-{int(6 * k) + 1}",
            f"eq=saturation={1 + 0.35 * k:.2f}:contrast=1.05:brightness=0.01",
            f"noise=alls={int(9 * k) + 2}:allf=t",
            "curves=preset=vintage",
        ]
    if kind == "aged_film":
        return [
            "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131",
            f"eq=contrast=1.05:saturation={max(0.2, 0.8 - 0.4 * k):.2f}",
            f"noise=alls={int(13 * k) + 3}:allf=t",
        ]
    return []


def effect_label(kind: str) -> str:
    return (EFFECTS.get(kind) or {}).get("label", kind)


def catalog() -> Dict[str, Any]:
    """Everything the frontend needs to draw the template/transition/effect panels."""
    return {
        "layouts": [{"key": k, **v} for k, v in LAYOUTS.items()],
        "transitions": [{"key": k, **v} for k, v in TRANSITIONS.items()],
        "effects": [{"key": k, **v} for k, v in EFFECTS.items()],
        "aspects": [{"key": k, **v} for k, v in ASPECTS.items()],
        "resolutions": [{"key": k, **v} for k, v in RESOLUTIONS.items()],
    }

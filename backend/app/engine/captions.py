"""Captions, text overlays, hooks and the watermark → one burnable ``.ass`` file.

The renderer burns exactly one ASS track, so every on-screen text element in a
project (subtitle lines, text items, the AI hook, the watermark) is compiled
here. Sharing one file is what keeps the preview and the export identical: the
frontend draws the same items with the same colours, sizes and animations.

Timings arrive in two flavours and both are handled:

* subtitle lines are recorded against the **source** time of the transcript and
  are pushed through ``to_out()`` (the source→output mapper built from the
  timeline), so trimming words or clips moves the captions with the video;
* text/hook items are authored on the **output** timeline already and used as-is.
"""
from __future__ import annotations

import struct
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .ass import hex_to_ass, ass_time

# ---------------------------------------------------------------------------
# Presets
# ---------------------------------------------------------------------------
SUBTITLE_PRESETS: List[Dict[str, Any]] = [
    # Basic
    {"key": "white", "group": "basic", "label": "Plain white",
     "style": {"color": "#FFFFFF", "background": "none", "stroke": 3, "shadow": 1, "animation": "static", "highlight": "#FFFFFF"}},
    {"key": "bold", "group": "basic", "label": "Bold",
     "style": {"color": "#FFFFFF", "background": "none", "stroke": 6, "shadow": 2, "bold": True, "animation": "static", "highlight": "#FFFFFF", "size": "large"}},
    {"key": "outlined", "group": "basic", "label": "Outlined",
     "style": {"color": "#FFFFFF", "background": "none", "stroke": 8, "shadow": 0, "animation": "static", "highlight": "#FFFFFF", "outline_color": "#2BF5A0"}},
    {"key": "green", "group": "basic", "label": "Green",
     "style": {"color": "#2BF5A0", "background": "none", "stroke": 4, "shadow": 1, "animation": "static", "highlight": "#FFFFFF"}},
    {"key": "italic_yellow", "group": "basic", "label": "Italic yellow",
     "style": {"color": "#FFE14D", "background": "none", "stroke": 3, "shadow": 1, "italic": True, "animation": "static", "highlight": "#FFFFFF"}},
    {"key": "orange_block", "group": "basic", "label": "Orange block",
     "style": {"color": "#111111", "background": "#FF8A3D", "stroke": 0, "shadow": 0, "animation": "static", "highlight": "#111111"}},
    # Dynamic
    {"key": "word_highlight", "group": "dynamic", "label": "Word by word",
     "style": {"color": "#FFFFFF", "background": "none", "stroke": 4, "shadow": 1, "animation": "word", "highlight": "#2BF5A0"}},
    {"key": "pop_in", "group": "dynamic", "label": "Pop in",
     "style": {"color": "#FFFFFF", "background": "none", "stroke": 5, "shadow": 1, "animation": "pop", "highlight": "#2BF5A0"}},
    {"key": "colored_keyword", "group": "dynamic", "label": "Colored keyword",
     "style": {"color": "#FFFFFF", "background": "none", "stroke": 4, "shadow": 1, "animation": "keyword", "highlight": "#FF5DA2"}},
    {"key": "box_highlight", "group": "dynamic", "label": "Background box",
     "style": {"color": "#FFFFFF", "background": "#0B1F17", "stroke": 0, "shadow": 0, "animation": "box", "highlight": "#2BF5A0"}},
    {"key": "karaoke", "group": "dynamic", "label": "Karaoke fill",
     "style": {"color": "#8FA3AE", "background": "none", "stroke": 4, "shadow": 1, "animation": "karaoke", "highlight": "#FFE14D"}},
    {"key": "typewriter", "group": "dynamic", "label": "Typewriter",
     "style": {"color": "#EAF6FF", "background": "none", "stroke": 3, "shadow": 1, "animation": "typewriter", "highlight": "#38BDF8"}},
]

TEXT_PRESETS: List[Dict[str, Any]] = [
    {"key": "boxed_white", "label": "Boxed white", "style": {"color": "#FFFFFF", "background": "#000000", "stroke": 0, "shadow": 0}},
    {"key": "black_box", "label": "Black box", "style": {"color": "#FFFFFF", "background": "#000000", "stroke": 0, "shadow": 0, "size": "large"}},
    {"key": "green_on_black", "label": "Green on black", "style": {"color": "#2BF5A0", "background": "#04070A", "stroke": 0, "shadow": 0}},
    {"key": "yellow", "label": "Yellow", "style": {"color": "#FFE14D", "background": "none", "stroke": 4, "shadow": 2}},
    {"key": "outlined", "label": "Outlined", "style": {"color": "#FFFFFF", "background": "none", "stroke": 8, "shadow": 0}},
    {"key": "yellow_block", "label": "Yellow block", "style": {"color": "#111111", "background": "#FFE14D", "stroke": 0, "shadow": 0}},
    {"key": "blue_outlined", "label": "Blue outlined", "style": {"color": "#EAF6FF", "background": "none", "stroke": 6, "shadow": 2, "outline_color": "#38BDF8"}},
    {"key": "serif_green", "label": "Serif green box", "style": {"color": "#0B1F17", "background": "#2BF5A0", "stroke": 0, "shadow": 0, "font": "Georgia"}},
    {"key": "serif_brown", "label": "Serif brown box", "style": {"color": "#FFF6E5", "background": "#5A3A22", "stroke": 0, "shadow": 0, "font": "Georgia"}},
]

FONTS = [
    "Montserrat", "Impact", "Anton", "Poppins", "Inter", "Sora",
    "Georgia", "Times New Roman", "Arial Black", "Courier New",
]

PLACEMENT_Y = {"top": 0.14, "center": 0.5, "bottom": 0.82}
ANIMATIONS_IN = ["none", "fade", "pop", "slide_up", "slide_down", "typewriter"]
ANIMATIONS_OUT = ["none", "fade", "pop", "slide_down"]

# Monochrome pictographs only. The bundled libass build cannot rasterise
# colour-emoji fonts (verified: 💰/🔥 come out as tofu even with fontsdir), so the
# map uses glyphs that every text font carries – which also keeps the burned
# export identical to the canvas preview. Point WV_FFMPEG at an emoji-capable
# build and these still render, just as text symbols.
EMOJI_MAP: Dict[str, str] = {
    "money": "$", "dollar": "$", "rich": "$", "gold": "★", "win": "★",
    "love": "♥", "heart": "♥", "like": "♥", "happy": "☺", "laugh": "☺", "funny": "☺",
    "sad": "☹", "cry": "☹", "angry": "☹", "scared": "!", "shock": "!",
    "idea": "✦", "think": "?", "brain": "✦", "smart": "✦", "learn": "✎",
    "fire": "▲", "hot": "▲", "fast": "≫", "speed": "≫", "energy": "▲",
    "music": "♪", "song": "♪", "sing": "♫", "dance": "♫",
    "video": "▶", "movie": "▶", "camera": "✎", "photo": "✎",
    "phone": "☎", "computer": "⌘", "code": "⌘", "ai": "✦", "robot": "✦",
    "rocket": "↑", "start": "↑", "grow": "↑", "data": "■", "chart": "■",
    "warning": "!", "stop": "✋", "check": "✓", "yes": "✓", "no": "✗",
    "time": "∞", "clock": "∞", "work": "⚑", "job": "⚑", "food": "☕",
    "coffee": "☕", "run": "↑", "gym": "■", "strong": "■", "sleep": "☁",
    "travel": "✈", "world": "●", "home": "■", "family": "♥", "friend": "♥",
    "perfect": "✦", "magic": "✦", "crazy": "!", "secret": "✦", "best": "★",
    "weather": "☂", "sun": "☀", "cloud": "☁", "star": "★", "link": "→",
    "growth": "↑", "cut": "✂", "edit": "✂", "mail": "✉", "settings": "⚙",
}

SPEAKER_COLORS = ["#2BF5A0", "#38BDF8", "#FFE14D", "#FF8A3D", "#FF5DA2", "#B18CFF"]


# ---------------------------------------------------------------------------
# Style helpers
# ---------------------------------------------------------------------------
@lru_cache(maxsize=1)
def font_scales() -> Dict[str, float]:
    """Per-family px scale applied by libass, keyed by font family.

    libass does not render ``Fontsize`` at the font's nominal em: it lays the
    face out with ``usWinAscent + usWinDescent`` as the line box and scales the
    glyphs into it, i.e. ``scale = unitsPerEm / (usWinAscent + usWinDescent)``.
    Verified against this build's libass with Montserrat (0.640), Arial (0.895)
    and Impact (0.820) – each matches the formula to 0.001.

    The browser preview applies the same factor so preview and export wrap
    identically. Families we cannot locate on this host keep 1.0.
    """
    scales: Dict[str, float] = {}
    for family in FONTS:
        path = _find_font_file(family)
        if path is None:
            continue
        try:
            scales[family] = round(_px_scale(path), 3)
        except Exception:                       # unreadable / unexpected font
            continue
    return scales


def _font_dirs() -> List[Path]:
    vendored = Path(__file__).resolve().parents[2] / "assets" / "fonts"
    dirs = [vendored, Path.home() / "Library" / "Fonts", Path("/Library/Fonts"),
            Path("/System/Library/Fonts"), Path("/System/Library/Fonts/Supplemental"),
            Path("/usr/share/fonts"), Path("/usr/local/share/fonts")]
    return [d for d in dirs if d.is_dir()]


def _slug(name: str) -> str:
    return "".join(ch for ch in str(name).lower() if ch.isalnum())


def _find_font_file(family: str) -> Optional[Path]:
    """Best-effort lookup of a font file for *family* on this host."""
    want = _slug(family)
    best: Optional[Path] = None
    for directory in _font_dirs():
        for path in sorted(directory.rglob("*.tt[fc]")) + sorted(directory.rglob("*.otf")):
            stem = _slug(path.stem)
            if not stem.startswith(want):
                continue
            # prefer a bold face: captions are bold in the default presets
            if "bold" in path.stem.lower():
                return path
            best = best or path
    return best


def _px_scale(path: Path) -> float:
    """``unitsPerEm / (usWinAscent + usWinDescent)`` straight from the font."""
    data = Path(path).read_bytes()
    num_tables = struct.unpack(">H", data[4:6])[0]
    tables: Dict[str, int] = {}
    for i in range(num_tables):
        off = 12 + i * 16
        tag = data[off:off + 4].decode("latin-1")
        offset = struct.unpack(">I", data[off + 8:off + 12])[0]
        tables[tag] = offset
    head, os2 = tables.get("head"), tables.get("OS/2")
    if head is None or os2 is None:
        return 1.0
    upem = struct.unpack(">H", data[head + 18:head + 20])[0] or 1000
    win_asc, win_desc = struct.unpack(">HH", data[os2 + 74:os2 + 78])
    total = win_asc + win_desc
    return (upem / total) if total else 1.0


def preset_catalog() -> Dict[str, Any]:
    return {
        "subtitle_presets": SUBTITLE_PRESETS,
        "text_presets": TEXT_PRESETS,
        "fonts": FONTS,
        "animations_in": ANIMATIONS_IN,
        "animations_out": ANIMATIONS_OUT,
        "speaker_colors": SPEAKER_COLORS,
        "font_scales": font_scales(),
    }


def resolve_subtitle_style(project: Dict[str, Any]) -> Dict[str, Any]:
    subs = project.get("subtitles") or {}
    style: Dict[str, Any] = {"size": "medium", "font": "Montserrat", "position": "bottom",
                             "align": "center", "max_words": 4, "stroke": 4,
                             "color": "#FFFFFF", "highlight": "#2BF5A0", "background": "none",
                             "shadow": 1, "animation": "word", "motion": "moving"}
    preset = subs.get("preset") or "word_highlight"
    for item in SUBTITLE_PRESETS:
        if item["key"] == preset:
            style.update(item["style"])
            break
    style.update(subs.get("style") or {})
    return style


def text_style(item: Dict[str, Any]) -> Dict[str, Any]:
    style: Dict[str, Any] = {"size": "medium", "font": "Montserrat", "color": "#FFFFFF",
                             "background": "none", "stroke": 0, "shadow": 0,
                             "align": "center", "x": 0.5, "y": 0.5,
                             "animation_in": "fade", "animation_out": "fade"}
    preset = item.get("preset")
    for p in TEXT_PRESETS:
        if p["key"] == preset:
            style.update(p["style"])
            break
    style.update(item.get("style") or {})
    return style


def px_size(size: Any, canvas_h: int) -> int:
    """Preset word or explicit pixel size → font px on a *canvas_h* tall canvas."""
    if isinstance(size, (int, float)):
        return max(12, int(size))
    frac = {"small": 0.042, "medium": 0.058, "large": 0.078, "xlarge": 0.1}.get(str(size), 0.058)
    return max(14, int(canvas_h * frac))


def _dim(color: str) -> str:
    return hex_to_ass(color, alpha=0x50)


def emoji_for(text: str) -> str:
    """First keyword hit in *text* → emoji (deterministic, offline friendly)."""
    words = [w.strip(".,!?:;\"'()[]").lower() for w in str(text).split()]
    for w in words:
        if w in EMOJI_MAP:
            return EMOJI_MAP[w]
    return ""


def speaker_of(line: Dict[str, Any], index: int, prev_gap: float) -> int:
    """Speaker id for a line: stored label if present, else alternate on long pauses."""
    if line.get("speaker") is not None:
        try:
            return int(line["speaker"])
        except (TypeError, ValueError):
            return 0
    if index == 0:
        return 0
    return (index if prev_gap > 0.7 else max(0, index - 1)) % 6


# ---------------------------------------------------------------------------
# Document assembly
# ---------------------------------------------------------------------------
def _header(w: int, h: int, styles: List[str], font: str = "Montserrat") -> str:
    return (
        "[Script Info]\n"
        "; Generated by WayinVideo AI Video Editor\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {w}\n"
        f"PlayResY: {h}\n"
        # 0 = smart word wrapping inside the style margins (matches the browser preview)
        "WrapStyle: 0\n"
        "ScaledBorderAndShadow: yes\n"
        "YCbCr Matrix: TV.709\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        + "\n".join(styles) + "\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )


def _style_line(name: str, *, font: str, px: int, color: str, highlight: str = "#FFFFFF",
                outline_color: str = "#000000", background: str = "none", stroke: int = 0,
                shadow: int = 0, bold: bool = False, italic: bool = False,
                align: int = 5, margin_v: int = 40, margin_h: int = 60) -> str:
    """One ``Style:`` row. ``align`` uses the ASS numpad convention.

    With ``BorderStyle 3`` libass fills the box with the *outline* colour (the
    back colour becomes the shadow), so a filled box swaps them around.
    """
    boxed = bool(background and background != "none")
    outline = background if boxed else outline_color
    back = hex_to_ass("#000000", alpha=0 if not boxed else 0x80)
    return (
        f"Style: {name},{font},{px},{hex_to_ass(color)},{hex_to_ass(highlight)},"
        f"{hex_to_ass(outline)},{back},{1 if bold else 0},{1 if italic else 0},0,0,"
        f"100,100,0,0,{3 if boxed else 1},{max(0, stroke) if not boxed else 6},"
        f"{max(0, shadow)},{align},{margin_h},{margin_h},{margin_v},1"
    )


def _align_of(value: str) -> int:
    return {"left": 4, "center": 5, "right": 6}.get(str(value), 5)


def _anim_tags(kind: str, x: int, y: int) -> str:
    """Inline ASS overrides realising an in/out animation at ``(x, y)``."""
    if kind == "pop":
        return "\\fscx60\\fscy60\\t(0,140,\\fscx100\\fscy100)"
    if kind == "slide_up":
        return f"\\move({x},{y + 70},{x},{y},0,240)"
    if kind == "slide_down":
        return f"\\move({x},{y - 70},{x},{y},0,240)"
    if kind == "typewriter":
        return "\\fad(120,120)"
    if kind == "fade":
        return "\\fad(220,220)"
    return ""


def build_ass(
    project: Dict[str, Any],
    out_path: Path | str,
    *,
    w: int,
    h: int,
    to_out: Optional[Callable[[float], Optional[float]]] = None,
    watermark: bool = False,
    subtitle_lines: Optional[List[Dict[str, Any]]] = None,
) -> Path:
    """Compile the project's text elements into an ASS file.

    ``to_out`` maps a source timestamp onto the output timeline; lines that fall
    inside a trimmed-away region are dropped (mapper returns ``None``).
    """
    def map_in(t: float) -> Optional[float]:
        return to_out(t) if to_out else float(t)

    subs = project.get("subtitles") or {}
    style = resolve_subtitle_style(project)
    px = px_size(style.get("size"), h)
    align = _align_of(style.get("align"))
    anchor_y = int(h * PLACEMENT_Y.get(str(style.get("position", "bottom")), 0.82))
    margin_v = max(20, h - anchor_y) if str(style.get("position")) == "bottom" else (
        max(20, anchor_y) if str(style.get("position")) == "top" else 40)

    # Horizontal text margins are proportional to the canvas so the browser
    # preview can wrap captions at exactly the same width on every aspect ratio.
    margin_h = max(24, int(round(w * 0.055)))

    def _s(name: str, **kw) -> str:
        kw.setdefault("margin_h", margin_h)
        return _style_line(name, **kw)

    font = style.get("font", "Montserrat")
    base_stroke = int(style.get("stroke", 4))
    base_shadow = int(style.get("shadow", 1))
    base_bg = style.get("background", "none")

    styles: List[str] = [
        _s("Main", font=font, px=px, color=style.get("color", "#FFFFFF"),
                    highlight=style.get("highlight", "#2BF5A0"),
                    outline_color=style.get("outline_color", "#000000"), background=base_bg,
                    stroke=base_stroke, shadow=base_shadow, bold=bool(style.get("bold")),
                    italic=bool(style.get("italic")), align=align, margin_v=margin_v),
        _s("Active", font=font, px=px, color=style.get("highlight", "#2BF5A0"),
                    highlight=style.get("highlight", "#2BF5A0"),
                    outline_color=style.get("outline_color", "#000000"), background=base_bg,
                    stroke=base_stroke, shadow=base_shadow, bold=True,
                    align=align, margin_v=margin_v),
        # karaoke fill: words start dim (secondary) and light up bright (primary)
        _s("Kara", font=font, px=px, color=style.get("highlight", "#2BF5A0"),
                    highlight=style.get("color", "#FFFFFF"),
                    outline_color=style.get("outline_color", "#000000"), background=base_bg,
                    stroke=base_stroke, shadow=base_shadow, bold=True,
                    align=align, margin_v=margin_v),
        _s("Overlay", font="Montserrat", px=px_size("large", h), color="#FFFFFF",
                    outline_color="#000000", background="#000000", align=5, margin_v=40),
        _s("Watermark", font="Inter", px=max(16, int(h * 0.018)), color="#FFFFFF",
                    outline_color="#000000", background="#000000", align=3, margin_v=24),
    ]
    for i, color in enumerate(SPEAKER_COLORS):
        styles.append(_s(f"Spk{i}", font=font, px=px, color=color, highlight=color,
                                  background="#04070A", stroke=0, shadow=0, bold=True,
                                  align=align, margin_v=margin_v))
        styles.append(_s(f"Spk{i}K", font=font, px=px, color=color,
                                  highlight=style.get("color", "#FFFFFF"),
                                  outline_color=style.get("outline_color", "#000000"),
                                  background=base_bg, stroke=base_stroke, shadow=base_shadow,
                                  bold=True, align=align, margin_v=margin_v))

    events: List[str] = []
    lines = subtitle_lines if subtitle_lines is not None else (subs.get("lines") or [])
    use_emojis = bool(subs.get("emojis"))
    use_speakers = bool(subs.get("speaker_labels"))
    animation = str(style.get("animation", "word"))
    max_words = int(style.get("max_words", 4) or 0)
    prev_end = 0.0

    for idx, line in enumerate(lines):
        text = (line.get("text") or "").strip()
        if not text:
            continue
        src_start = float(line.get("start", 0))
        src_end = float(line.get("end", src_start + 1))
        start = map_in(src_start)
        if start is None:
            continue
        end = map_in(src_end)
        end = max(start + 0.25, end if end is not None else start + 1.2)

        speaker = speaker_of(line, idx, max(0.0, src_start - prev_end))
        prev_end = max(prev_end, src_end)
        prefix = ""
        if use_speakers:
            prefix = f"{'Speaker ' + str(speaker + 1)}: "
        emoji = f" {emoji_for(text)}" if use_emojis and emoji_for(text) else ""
        words = [w for w in (line.get("words") or []) if w.get("w")]
        style_name = f"Spk{speaker}" if use_speakers else "Main"

        karaoke_style = f"Spk{speaker}K" if use_speakers else "Kara"
        spaced = []
        for word in words:
            ws = map_in(float(word.get("s", src_start)))
            we = map_in(float(word.get("e", src_end)))
            if ws is None:
                continue
            spaced.append((word["w"], ws, we if we is not None else ws + 0.3))

        if spaced and animation in ("word", "karaoke", "keyword"):
            # one event per line, karaoke tags per word: \k is in centiseconds
            line_start = spaced[0][1]
            karaoke = ""
            cursor = line_start
            for index, (word_text, ws, we) in enumerate(spaced):
                lead = max(0.0, ws - cursor)
                if lead > 0.01:
                    karaoke += f"{{\\k{int(round(lead * 100))}}}"
                hold = max(0.1, (we if index == len(spaced) - 1 else max(we, ws + 0.12)) - ws)
                clean = word_text.replace("{", "(").replace("}", ")")
                karaoke += f"{{\\k{max(2, int(round(hold * 100)))}}}{clean} "
                cursor = ws + hold
            events.append(
                f"Dialogue: 0,{ass_time(line_start)},{ass_time(max(end, cursor) + 0.3)},{karaoke_style},,"
                f"0,0,0,,{{\\an5\\pos({w // 2},{anchor_y})}}{prefix}{karaoke}{emoji}")
        elif animation == "box":
            events.append(
                f"Dialogue: 0,{ass_time(start)},{ass_time(end)},{style_name},,0,0,0,,"
                f"{{\\an5\\pos({w // 2},{anchor_y})\\fad(180,180)}}{prefix}{text}{emoji}")
        elif animation == "typewriter":
            events.append(
                f"Dialogue: 0,{ass_time(start)},{ass_time(end)},{style_name},,0,0,0,,"
                f"{{\\an5\\pos({w // 2},{anchor_y})\\fad(120,120)}}{prefix}{text}{emoji}")
        else:
            anim = "\\fad(200,200)" if animation in ("static", "pop") else "\\fad(160,160)"
            extra = "\\fscx70\\fscy70\\t(0,150,\\fscx100\\fscy100)" if animation == "pop" else ""
            events.append(
                f"Dialogue: 0,{ass_time(start)},{ass_time(end)},{style_name},,0,0,0,,"
                f"{{\\an5\\pos({w // 2},{anchor_y}){anim}{extra}}}{prefix}{text}{emoji}")

    # ---- text overlays + hooks (authored on the output timeline) ----
    for item in list(project.get("texts") or []) + list(project.get("hooks") or []):
        content = str(item.get("text") or "").strip()
        if not content:
            continue
        st = text_style(item)
        size_px = px_size(st.get("size"), h)
        name = ("T" + str(item.get("id", "x")))[-31:]
        styles.append(_s(
            name, font=st.get("font", "Montserrat"), px=size_px,
            color=st.get("color", "#FFFFFF"), highlight=st.get("color", "#FFFFFF"),
            outline_color=st.get("outline_color", "#000000"), background=st.get("background", "none"),
            stroke=int(st.get("stroke", 0)), shadow=int(st.get("shadow", 0)),
            bold=item.get("kind") == "heading", align=_align_of(st.get("align")), margin_v=40))
        x = int(float(st.get("x", 0.5)) * w)
        y = int(float(st.get("y", 0.5)) * h)
        anim_in = _anim_tags(str(st.get("animation_in", "fade")), x, y)
        anim_out = "\\fad(0,200)" if st.get("animation_out", "fade") != "none" else ""
        text_escaped = content.replace(chr(10), "\\N")
        events.append(
            f"Dialogue: 3,{ass_time(float(item.get('start', 0)))},"
            f"{ass_time(max(float(item.get('start', 0)) + 0.3, float(item.get('end', 3))))},"
            f"{name},,0,0,0,,{{\\an5\\pos({x},{y}){anim_in}{anim_out}}}"
            f"{text_escaped}")

    if watermark:
        events.append(
            f"Dialogue: 4,0:00:00.00,9:59:59.00,Watermark,,0,0,0,,"
            f"{{\\an3\\pos({w - 28},{h - 28})\\fad(300,300)}}Framewright")   # brand matches the site

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(_header(w, h, styles) + "\n".join(events) + "\n", encoding="utf-8")
    return out_path

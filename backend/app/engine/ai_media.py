"""Publish-side and generate-media AI: hooks, titles, description, translation,
B-roll planning, thumbnails, AI video / music / sound effects.

Everything here degrades honestly:

* LLM features (hooks, titles, description, translation, B-roll plan) use the
  configured provider and fall back to deterministic local writers that only use
  words from the transcript, so the buttons always produce something real;
* AI Video needs a video-generation provider – without a key the endpoint raises
  :class:`ProviderNotConfigured` and the UI shows exactly which variable to set;
* AI Music and AI Sound Effect fall back to local FFmpeg synthesis, which is
  real audio (a chord bed and keyword-shaped hits) rather than a fake success.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from ..config import FFMPEG_BIN, MEDIA_DIR
from . import enhance
from .llm import configured as llm_configured, extract_json, llm_json, llm_text

# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------
VIDEO_URL = os.getenv("WV_AI_VIDEO_URL", "")
VIDEO_KEY = os.getenv("WV_AI_VIDEO_KEY", "")
MUSIC_URL = os.getenv("WV_AI_MUSIC_URL", "")
MUSIC_KEY = os.getenv("WV_AI_MUSIC_KEY", "")
SFX_URL = os.getenv("WV_AI_SFX_URL", "")
SFX_KEY = os.getenv("WV_AI_SFX_KEY", "")


class ProviderNotConfigured(RuntimeError):
    def __init__(self, what: str, variables: str):
        super().__init__(f"{what} needs a provider. Set {variables} in the backend environment.")


HOOK_PATTERNS: List[Dict[str, str]] = [
    {"key": "curiosity_gap", "label": "Curiosity gap",
     "why": "Opens a question the viewer cannot answer without watching."},
    {"key": "bold_claim", "label": "Bold claim",
     "why": "A specific, checkable promise earns the first two seconds."},
    {"key": "pattern_interrupt", "label": "Pattern interrupt",
     "why": "Breaks the scroll rhythm so the eye stops on the frame."},
    {"key": "open_loop", "label": "Open loop",
     "why": "Sets up a payoff the brain insists on closing."},
    {"key": "contrarian", "label": "Contrarian take",
     "why": "Disagreement invites comments, which the algorithms reward."},
    {"key": "stop_scrolling", "label": "Stop-scrolling callout",
     "why": "Direct address filters for the exact viewer you want."},
    {"key": "story_midres", "label": "Story in medias res",
     "why": "Starting mid-action removes the warm-up nobody watches."},
]

HOOK_SYSTEM = """You are an expert short-form video strategist for TikTok, Instagram Reels and YouTube Shorts.
You write hooks grounded in the clip's transcript, never clickbait the clip cannot pay off.
Rules: under 12 words, no filler ("In this video..."), must create a question or tension
resolvable only by watching, must land in the first 1-2 seconds.

Return strict JSON:
{"hooks":[{"text":"on-screen text","spoken":"spoken version","pattern":"pattern label","why":"one line"}],
 "best":{"pick":1,"reason":"two sentences on retention"},
 "ab_test":"one A/B variant of the best hook"}
Give exactly 7 hooks, each using a different pattern."""

TITLE_SYSTEM = """You write high-CTR titles for short-form video.
Return strict JSON {"titles":[{"text":"...","why":"one line"}]} with 6 titles under 60 characters,
each true to the transcript, no clickbait the video cannot deliver."""

DESC_SYSTEM = """You write social descriptions for short-form video.
Return strict JSON {"description":"2-3 short paragraphs","hashtags":["#tag"],"chapters":[{"time":"0:00","label":"..."}]}
with 8-15 relevant hashtags (mix of broad and niche)."""

BRoll_SYSTEM = """You plan B-roll for a talking-head video.
Return strict JSON {"moments":[{"start":seconds,"end":seconds,"query":"2-5 word stock search","kind":"stock"}]}
with 3-10 moments where a visual would strengthen the narration. Use seconds from the provided segments."""


def provider_status() -> Dict[str, Any]:
    return {
        "llm": llm_configured(),
        "ai_video": bool(VIDEO_URL and VIDEO_KEY),
        "ai_music": bool(MUSIC_URL and MUSIC_KEY),
        "ai_sfx": bool(SFX_URL and SFX_KEY),
        "env": {"ai_video": "WV_AI_VIDEO_URL + WV_AI_VIDEO_KEY",
                "ai_music": "WV_AI_MUSIC_URL + WV_AI_MUSIC_KEY",
                "ai_sfx": "WV_AI_SFX_URL + WV_AI_SFX_KEY"},
    }


# ---------------------------------------------------------------------------
# Transcript helpers
# ---------------------------------------------------------------------------
def transcript_text(project: Dict[str, Any], limit: int = 6000) -> str:
    segments = ((project.get("transcript") or {}).get("segments")) or []
    parts: List[str] = []
    for seg in segments:
        text = str(seg.get("text", "")).strip()
        if text:
            parts.append(f"[{float(seg.get('start', 0)):.1f}-{float(seg.get('end', 0)):.1f}] {text}")
        if sum(len(p) for p in parts) > limit:
            break
    if not parts:
        parts = [str((project.get("transcript") or {}).get("text", ""))[:limit]]
    return "\n".join(parts)


def _words(project: Dict[str, Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for seg in ((project.get("transcript") or {}).get("segments")) or []:
        for word in seg.get("words") or []:
            if word.get("w"):
                out.append(word)
    return out


# ---------------------------------------------------------------------------
# Hooks
# ---------------------------------------------------------------------------
def write_hooks(project: Dict[str, Any], *, platform: str = "youtube",
                title: str = "", niche: str = "", count: int = 7) -> Dict[str, Any]:
    segments = ((project.get("transcript") or {}).get("segments")) or []
    duration = float((project.get("source") or {}).get("duration") or 0)
    data = llm_json(HOOK_SYSTEM, (
        f"Platform: {platform}\nNiche: {niche or 'general'}\nTitle: {title or 'untitled'}\n"
        f"Clip length: {duration:.1f}s\nTranscript:\n{transcript_text(project)}"))

    hooks: List[Dict[str, Any]] = []
    for item in (data.get("hooks") or [])[:count]:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text", "")).strip()
        if not text:
            continue
        hooks.append({"text": text[:120], "spoken": str(item.get("spoken", "") or text)[:200],
                      "pattern": str(item.get("pattern", "curiosity gap")),
                      "why": str(item.get("why", "") or "creates a question worth staying for")})
    source = "llm"
    if len(hooks) < count:
        local = local_hooks(project, count=count, niche=niche)
        if not hooks:
            hooks, source = local["hooks"], local["source"]
        else:
            hooks.extend(local["hooks"][: count - len(hooks)])
            source = "llm+local"

    best = data.get("best") if isinstance(data.get("best"), dict) else None
    if not best or not isinstance(best.get("pick"), (int, float)):
        best = {"pick": 1, "reason": "It states the clip's payoff first, so the viewer knows what "
                                     "they get and stays for it; it also survives being read in one breath."}
    pick = int(max(1, min(len(hooks) or 1, int(best.get("pick", 1)))))
    return {
        "hooks": hooks,
        "count": len(hooks),
        "best": {"pick": pick, "reason": str(best.get("reason", ""))[:400],
                 "hook": hooks[pick - 1]["text"] if hooks else ""},
        "ab_test": str(data.get("ab_test") or "").strip() or (
            hooks[pick - 1]["text"].replace("You", "I") if hooks else ""),
        "patterns": HOOK_PATTERNS,
        "platform": platform,
        "source": source,
        "research_note": ("Patterns come from the curated short-form strategy baseline; with an LLM key "
                          "the model may add patterns it knows to be current. The backend has no web "
                          "search tool, so STEP 1 runs off this list."),
    }


def local_hooks(project: Dict[str, Any], *, count: int = 7, niche: str = "") -> Dict[str, Any]:
    segments = ((project.get("transcript") or {}).get("segments")) or []
    words = _words(project)
    lines = [str(s.get("text", "")).strip() for s in segments if str(s.get("text", "")).strip()]
    topic = " ".join(lines[0].split()[:6]) if lines else (niche or "this")
    topic = topic.rstrip(".,!?") or "this"
    punch = ""
    if words:
        best = max(words, key=lambda w: len(str(w.get("w", ""))))
        punch = str(best.get("w", "")).strip(".,!?")
    hottest = ""
    for line in lines:
        if any(ch.isdigit() for ch in line) or "?" in line:
            hottest = line
            break
    hottest = hottest or (lines[min(2, len(lines) - 1)] if lines else "")
    templates = [
        ("You will not believe how {t} ends", "curiosity gap"),
        ("{t} — and it changes everything", "bold claim"),
        ("Stop scrolling if you {t}", "stop-scrolling callout"),
        ("Everyone gets {t} wrong", "contrarian take"),
        ("Wait for what happens after {t}", "open loop"),
        ("This started as {t}", "story in medias res"),
        ("The part nobody talks about: {t}", "pattern interrupt"),
    ]
    hooks: List[Dict[str, Any]] = []
    for template, pattern in templates[:count]:
        text = template.format(t=topic)
        hooks.append({
            "text": text[:100],
            "spoken": text[:200],
            "pattern": pattern,
            "why": next((p["why"] for p in HOOK_PATTERNS if p["label"].lower() == pattern), "stops the scroll"),
        })
    return {"hooks": hooks, "source": "local writer (no LLM key)"}


# ---------------------------------------------------------------------------
# Titles / description / translation
# ---------------------------------------------------------------------------
def write_titles(project: Dict[str, Any], *, count: int = 6) -> Dict[str, Any]:
    data = llm_json(TITLE_SYSTEM, f"Transcript:\n{transcript_text(project, 4000)}")
    titles = []
    for item in (data.get("titles") or [])[:count]:
        if isinstance(item, dict) and item.get("text"):
            titles.append({"text": str(item["text"])[:90], "why": str(item.get("why", ""))[:160]})
        elif isinstance(item, str) and item.strip():
            titles.append({"text": item.strip()[:90], "why": ""})
    source = "llm"
    if not titles:
        segments = ((project.get("transcript") or {}).get("segments")) or []
        lines = [str(s.get("text", "")).strip() for s in segments if str(s.get("text", "")).strip()]
        base = (lines[0].split(".")[0] if lines else (project.get("name") or "My video"))[:60].strip()
        titles = [{"text": f"{base} #{i + 1}", "why": "built from the opening line"} for i in range(min(count, 3))]
        source = "local fallback"
    return {"titles": titles, "source": source}


def write_description(project: Dict[str, Any], *, platform: str = "youtube") -> Dict[str, Any]:
    data = llm_json(DESC_SYSTEM, f"Platform: {platform}\nTranscript:\n{transcript_text(project, 4000)}")
    if data.get("description"):
        hashtags = [str(h).strip() for h in (data.get("hashtags") or []) if str(h).strip()]
        hashtags = [h if h.startswith("#") else f"#{h.lstrip('#')}" for h in hashtags]
        return {"description": str(data["description"]), "hashtags": hashtags[:15],
                "chapters": data.get("chapters") or [], "source": "llm"}

    segments = ((project.get("transcript") or {}).get("segments")) or []
    lines = [str(s.get("text", "")).strip() for s in segments if str(s.get("text", "")).strip()]
    body = " ".join(lines[:6])[:700] or "A short video."
    words: Dict[str, int] = {}
    for line in lines[:40]:
        for token in line.lower().split():
            token = "".join(ch for ch in token if ch.isalnum())
            if len(token) > 4:
                words[token] = words.get(token, 0) + 1
    tags = [w for w, _ in sorted(words.items(), key=lambda kv: -kv[1])[:8]]
    chapters = [{"time": _stamp(float(s.get("start", 0))), "label": str(s.get("text", ""))[:60]}
                for s in segments[:5]]
    return {
        "description": body,
        "hashtags": [f"#{t}" for t in tags] + ["#shorts", "#viral", "#fyp", f"#{platform}"],
        "chapters": chapters,
        "source": "local fallback (no LLM key)",
    }


def _stamp(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    return f"{int(seconds // 60)}:{int(seconds % 60):02d}"


LANGUAGES = [
    {"code": "en", "label": "English"}, {"code": "hi", "label": "Hindi"},
    {"code": "es", "label": "Spanish"}, {"code": "fr", "label": "French"},
    {"code": "de", "label": "German"}, {"code": "pt", "label": "Portuguese"},
    {"code": "ar", "label": "Arabic"}, {"code": "ja", "label": "Japanese"},
    {"code": "ko", "label": "Korean"}, {"code": "zh", "label": "Chinese"},
    {"code": "ru", "label": "Russian"}, {"code": "id", "label": "Indonesian"},
    {"code": "bn", "label": "Bengali"}, {"code": "ta", "label": "Tamil"},
    {"code": "ur", "label": "Urdu"}, {"code": "tr", "label": "Turkish"},
]


def translate_lines(lines: List[Dict[str, Any]], target: str, *, source_lang: str = "") -> Dict[str, Any]:
    if not lines:
        return {"lines": [], "target": target, "source": "nothing to translate"}
    if not llm_configured():
        raise ProviderNotConfigured("Translation", "WV_LLM_API_KEY (any OpenAI-compatible endpoint)")
    label = next((l["label"] for l in LANGUAGES if l["code"] == target), target)
    system = ("You translate subtitles. Keep each line short and natural for on-screen captions. "
              'Return strict JSON {"lines":[{"id":1,"text":"..."}]} with the same ids.')
    payload = {"target_language": label,
               "lines": [{"id": i, "text": str(l.get("text", ""))} for i, l in enumerate(lines)]}
    data = llm_json(system, json.dumps(payload, ensure_ascii=False), max_tokens=4000)
    mapping = {int(item.get("id", -1)): str(item.get("text", ""))
               for item in (data.get("lines") or []) if isinstance(item, dict)}
    out = []
    for i, line in enumerate(lines):
        item = dict(line)
        item["text"] = mapping.get(i, item.get("text", ""))
        item["translated"] = target
        out.append(item)
    return {"lines": out, "target": target, "language": label, "source": "llm"}


# ---------------------------------------------------------------------------
# B-roll planning
# ---------------------------------------------------------------------------
def plan_broll(project: Dict[str, Any], *, mode: str = "stock", moments: int = 6) -> Dict[str, Any]:
    data = llm_json(BRoll_SYSTEM, f"Transcript with timings:\n{transcript_text(project, 5000)}")
    planned: List[Dict[str, Any]] = []
    for item in (data.get("moments") or [])[:moments]:
        if not isinstance(item, dict):
            continue
        start = float(item.get("start", 0) or 0)
        end = max(start + 1.0, float(item.get("end", start + 4) or start + 4))
        query = str(item.get("query", "")).strip()
        if not query:
            continue
        planned.append({"start": round(start, 2), "end": round(end, 2), "query": query,
                        "kind": "ai" if mode == "ai" else "stock"})
    source = "llm"
    if not planned:
        planned = _heuristic_broll(project, moments=moments)
        source = "transcript heuristic"
    return {"moments": planned, "mode": mode, "source": source}


_TOPIC_QUERIES = [
    ("money", "money finance"), ("business", "business office"), ("city", "city skyline"),
    ("travel", "travel landscape"), ("food", "food cooking"), ("music", "music concert"),
    ("code", "programming code"), ("health", "healthy lifestyle"), ("study", "books study"),
    ("time", "clock timelapse"), ("people", "people crowd"), ("nature", "nature forest"),
]


def _heuristic_broll(project: Dict[str, Any], *, moments: int = 6) -> List[Dict[str, Any]]:
    segments = ((project.get("transcript") or {}).get("segments")) or []
    out: List[Dict[str, Any]] = []
    for seg in segments:
        text = str(seg.get("text", "")).lower()
        for keyword, query in _TOPIC_QUERIES:
            if keyword in text:
                out.append({"start": round(float(seg.get("start", 0)), 2),
                            "end": round(float(seg.get("end", 0)), 2) or 4.0,
                            "query": query, "kind": "stock"})
                break
        if len(out) >= moments:
            break
    if not out and segments:
        for i in range(min(moments, len(segments))):
            seg = segments[i * max(1, len(segments) // max(1, moments))]
            out.append({"start": float(seg.get("start", 0)), "end": float(seg.get("end", 0)) or 4.0,
                        "query": "abstract background", "kind": "stock"})
    return out


# ---------------------------------------------------------------------------
# Generate media
# ---------------------------------------------------------------------------
def _media_out(prefix: str, suffix: str) -> Path:
    out_dir = Path(MEDIA_DIR) / "generated"
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir / f"{prefix}_{int(time.time() * 1000)}{suffix}"


def generate_music(prompt: str, *, duration: float = 20.0, mood: str = "") -> Dict[str, Any]:
    if MUSIC_URL and MUSIC_KEY:
        out = _media_out("music", ".mp3")
        with httpx.Client(timeout=300.0) as client:
            resp = client.post(MUSIC_URL, headers={"Authorization": f"Bearer {MUSIC_KEY}"},
                               json={"prompt": prompt, "duration": duration, "mood": mood})
            if resp.status_code >= 400:
                raise RuntimeError(f"music provider {resp.status_code}: {resp.text[:200]}")
            out.write_bytes(resp.content)
        return {"path": str(out), "provider": "configured", "duration": duration}

    out = _media_out("music", ".mp3")
    enhance.local_music(mood or prompt or "calm", duration, out)
    return {"path": str(out), "provider": "local synth (no music key)",
            "duration": duration,
            "note": "Set WV_AI_MUSIC_URL + WV_AI_MUSIC_KEY for provider-generated music."}


def generate_sfx(prompt: str, *, duration: float = 1.2) -> Dict[str, Any]:
    if SFX_URL and SFX_KEY:
        out = _media_out("sfx", ".mp3")
        with httpx.Client(timeout=180.0) as client:
            resp = client.post(SFX_URL, headers={"Authorization": f"Bearer {SFX_KEY}"},
                               json={"prompt": prompt, "duration": duration})
            if resp.status_code >= 400:
                raise RuntimeError(f"sfx provider {resp.status_code}: {resp.text[:200]}")
            out.write_bytes(resp.content)
        return {"path": str(out), "provider": "configured", "duration": duration}

    out = _media_out("sfx", ".mp3")
    enhance.local_sfx(prompt, out, duration=duration)
    return {"path": str(out), "provider": "local synth (no sfx key)", "duration": duration,
            "note": "Set WV_AI_SFX_URL + WV_AI_SFX_KEY for provider-generated effects."}


def generate_video(prompt: str, *, duration: float = 5.0, ratio: str = "9:16",
                   image: Optional[str] = None) -> Dict[str, Any]:
    if not (VIDEO_URL and VIDEO_KEY):
        raise ProviderNotConfigured("AI Video generation", "WV_AI_VIDEO_URL + WV_AI_VIDEO_KEY")
    out = _media_out("aivideo", ".mp4")
    with httpx.Client(timeout=900.0) as client:
        resp = client.post(VIDEO_URL, headers={"Authorization": f"Bearer {VIDEO_KEY}"},
                           json={"prompt": prompt, "duration": duration, "aspect_ratio": ratio,
                                 "image": image})
        if resp.status_code >= 400:
            raise RuntimeError(f"video provider {resp.status_code}: {resp.text[:200]}")
        content_type = resp.headers.get("content-type", "")
        if "video" in content_type:
            out.write_bytes(resp.content)
            return {"path": str(out), "provider": "configured", "duration": duration}
        # async providers: poll a job url until it returns a video url
        payload = extract_json(resp.text) or {}
        job = payload.get("id") or payload.get("job_id") or payload.get("request_id")
        poll = payload.get("poll_url") or (f"{VIDEO_URL.rstrip('/')}/{job}" if job else "")
        if not poll:
            raise RuntimeError("video provider returned no video and no job id to poll")
        deadline = time.time() + 600
        while time.time() < deadline:
            time.sleep(6)
            status = client.get(poll, headers={"Authorization": f"Bearer {VIDEO_KEY}"})
            body = extract_json(status.text) or {}
            url = body.get("url") or body.get("output") or body.get("video_url")
            if isinstance(url, list):
                url = url[0] if url else ""
            if url:
                data = client.get(str(url))
                out.write_bytes(data.content)
                return {"path": str(out), "provider": "configured", "duration": duration}
            if str(body.get("status", "")).lower() in ("failed", "error"):
                raise RuntimeError(f"video provider failed: {body}")
        raise RuntimeError("video provider timed out after 10 minutes")


# ---------------------------------------------------------------------------
# Thumbnails
# ---------------------------------------------------------------------------
THUMB_STYLES = [
    {"key": "clean", "label": "Clean", "filters": "eq=contrast=1.06:saturation=1.05"},
    {"key": "punch", "label": "Punch", "filters": "eq=contrast=1.18:saturation=1.35,unsharp=5:5:0.8"},
    {"key": "warm", "label": "Warm", "filters": "colorbalance=rm=0.08:gm=0.02:bm=-0.08,eq=saturation=1.1"},
    {"key": "cool", "label": "Cool", "filters": "colorbalance=rm=-0.06:bm=0.1,eq=saturation=1.05"},
    {"key": "vignette", "label": "Vignette", "filters": "vignette=PI/5,eq=contrast=1.1"},
]


def build_thumbnails(src: str, out_dir: Path | str, *, title: str = "", aspect: str = "16:9",
                     count: int = 3) -> List[Dict[str, Any]]:
    """Frame grabs + styled versions with the title burned on (all real renders)."""
    import subprocess

    from .captions import build_ass
    from .effects import canvas_size
    from .render import extract_frames, probe

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    info = probe(src)
    duration = float(info.get("duration") or 0)
    timestamps = [duration * f for f in (0.15, 0.35, 0.55, 0.75)] if duration > 0 else [0.0]
    frames = extract_frames(src, out_dir / "frames", timestamps=timestamps[:max(1, count)], width=1280)

    w, h = canvas_size(aspect, "1080p")
    made: List[Dict[str, Any]] = []
    for index, frame in enumerate(frames):
        for style in THUMB_STYLES[:2 if index else 3]:
            target = out_dir / f"thumb_{index}_{style['key']}.jpg"
            filters = (f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},"
                       f"{style['filters']}")
            proc = subprocess.run(
                [FFMPEG_BIN, "-y", "-hide_banner", "-loglevel", "error", "-i", frame,
                 "-vf", filters, "-frames:v", "1", str(target)],
                capture_output=True, text=True, timeout=180)
            if proc.returncode != 0:
                continue
            if title:
                ass = out_dir / f"title_{index}_{style['key']}.ass"
                build_ass({
                    "subtitles": {"enabled": False},
                    "texts": [{"id": "thumb", "kind": "heading", "text": title[:80],
                               "start": 0, "end": 99, "preset": "yellow_block",
                               "style": {"y": 0.82, "size": "large", "x": 0.5}}],
                }, ass, w=w, h=h, watermark=False)
                burned = out_dir / f"thumb_{index}_{style['key']}_titled.jpg"
                proc = subprocess.run(
                    [FFMPEG_BIN, "-y", "-hide_banner", "-loglevel", "error", "-i", str(target),
                     "-vf", f"subtitles=filename='{str(ass).replace(chr(92), '/').replace(':', chr(92) + ':')}'",
                     "-frames:v", "1", str(burned)],
                    capture_output=True, text=True, timeout=180)
                if proc.returncode == 0 and burned.is_file():
                    target = burned
            made.append({"style": style["key"], "label": style["label"], "path": str(target),
                         "width": w, "height": h, "from": round(timestamps[index], 2)
                         if index < len(timestamps) else 0})
    return made

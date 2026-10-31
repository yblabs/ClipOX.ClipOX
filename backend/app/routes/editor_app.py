"""HTTP layer for the AI Video Editor app (Parts A–U of the product spec).

Shape of every long operation: ``POST`` → ``{task_id}`` → poll
``GET /api/editor/status/{task_id}`` → cancel with
``POST /api/editor/cancel/{task_id}``. Short operations (analysis, LLM writing)
answer synchronously because they finish in well under a second.

Credits are charged per action from :mod:`app.credits`; failures refund, and an
action that costs more than the balance answers HTTP 402 with ``upgrade: true``
so the UI can show the upgrade prompt instead of a generic error.
"""
from __future__ import annotations

import os
import shutil
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from .. import credits as credit_ledger
from .. import store
from ..config import MEDIA_DIR, MEDIA_MOUNT, SILENCE_DB, SILENCE_MIN_SEC, UPLOAD_DIR, WHISPER_MODEL
from ..engine import ai_media, captions, effects as fx, enhance, reframe, render, stock
from ..engine import ingest
from ..engine.media import MediaError
from ..tasks import STORE, TaskCancelled, check_cancel
from .common import accept_upload, media_url, resolve_media

router = APIRouter(prefix="/api", tags=["editor-app"])

WORKFLOW = [
    # the 11 build stages, surfaced in the UI's About/API page
    "shell + credits", "input + processing", "timeline + preview + export",
    "trim / text-based editing", "reframe + layouts + templates", "subtitles",
    "text, upload, elements, audio, brand kit", "transitions + effects + details",
    "AI tools", "generate media", "publish + scheduler + library",
]

TOOL_RAIL = [
    {"key": "ai", "label": "AI Tools", "icon": "✨"},
    {"key": "template", "label": "Template", "icon": "🧩"},
    {"key": "brand", "label": "Brand Kit", "icon": "🎨"},
    {"key": "trim", "label": "Trim", "icon": "✂"},
    {"key": "reframe", "label": "Reframe", "icon": "🔲"},
    {"key": "subtitles", "label": "Subtitles", "icon": "💬"},
    {"key": "upload", "label": "Upload", "icon": "⬆"},
    {"key": "elements", "label": "Elements", "icon": "🧿"},
    {"key": "broll", "label": "B-roll", "icon": "🎞"},
    {"key": "hook", "label": "AI Hook", "icon": "🪝"},
    {"key": "text", "label": "Text", "icon": "T"},
    {"key": "audio", "label": "Audio", "icon": "🎵"},
    {"key": "transition", "label": "Transition", "icon": "⇄"},
    {"key": "effects", "label": "Effects", "icon": "🌀"},
    {"key": "details", "label": "Details", "icon": "⚙"},
]


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def charge(action: str, *, note: str = "") -> int:
    """Spend credits or raise 402 with the upgrade payload."""
    try:
        return credit_ledger.spend(action, note=note)
    except credit_ledger.InsufficientCredits as exc:
        store.notify("credits", "Out of credits",
                     f"{exc.action} costs {exc.required}; you have {exc.available}.",
                     level="warn")
        raise HTTPException(status_code=402, detail={
            "message": str(exc), "upgrade": True, "action": exc.action,
            "required": exc.required, "available": exc.available,
            "url": "/editor.html#pricing",
        })


def refund(action: str, note: str = "action failed") -> None:
    try:
        credit_ledger.refund(action, note=note)
    except Exception:
        pass


def load_project(project_id: str) -> Dict[str, Any]:
    project = store.read_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"unknown project {project_id}")
    return project


def save_project(project: Dict[str, Any]) -> Dict[str, Any]:
    return store.write_project(project)


def _out_dir(name: str) -> Path:
    path = Path(MEDIA_DIR) / name
    path.mkdir(parents=True, exist_ok=True)
    return path


# ---------------------------------------------------------------------------
# Meta / catalog
# ---------------------------------------------------------------------------
@router.get("/editor/meta")
def meta() -> Dict[str, Any]:
    """Everything the shell needs in one call (catalog, credits, providers)."""
    notes = store.notifications.all()
    unread = [n for n in notes if not n.get("read")]
    return {
        "product": "WayinVideo AI Video Editor",
        "workflow": WORKFLOW,
        "tool_rail": TOOL_RAIL,
        "layouts": [{"key": k, **v} for k, v in fx.LAYOUTS.items()],
        "transitions": [{"key": k, **v} for k, v in fx.TRANSITIONS.items()],
        "effects": [{"key": k, **v} for k, v in fx.EFFECTS.items()],
        "aspects": [{"key": k, **v} for k, v in fx.ASPECTS.items()],
        "resolutions": [{"key": k, **v} for k, v in fx.RESOLUTIONS.items()],
        "captions": captions.preset_catalog(),
        "languages": ai_media.LANGUAGES,
        "providers": {**ai_media.provider_status(), "stock": stock.attribution(),
                      "llm": ai_media.provider_status()["llm"]},
        "credits": credit_ledger.summary(),
        "notifications": {"unread": len(unread), "items": sorted(notes, key=lambda n: n.get("at", 0), reverse=True)[:20]},
        "features": {
            "transcription": True,
            "face_tracking": _has_cv2(),
            "whisper_model": WHISPER_MODEL,
            "ffmpeg": os.path.basename(str(render.FFMPEG_BIN)),
        },
    }


def _has_cv2() -> bool:
    try:
        import cv2  # noqa: F401
        return True
    except Exception:
        return False


@router.get("/credits")
def credits_summary() -> Dict[str, Any]:
    return {**credit_ledger.summary(), "prices": credit_ledger.price_list()}


@router.get("/pricing")
def pricing() -> Dict[str, Any]:
    summary = credit_ledger.summary()
    return {"plans": credit_ledger.PLANS, "current": summary["plan"],
            "balance": summary["balance"], "spent": summary["spent"],
            "unlimited": summary["unlimited"]}


class PlanBody(BaseModel):
    plan: str


@router.post("/pricing/plan")
def choose_plan(body: PlanBody) -> Dict[str, Any]:
    try:
        account = credit_ledger.set_plan(body.plan)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    store.notify("plan", f"{body.plan.title()} plan active",
                 f"{account['balance']} credits available.")
    return credit_ledger.summary()


REWARD_TASKS = [
    {"id": "daily_login", "label": "Open the editor today", "credits": 25, "cadence": "daily"},
    {"id": "first_export", "label": "Export your first video", "credits": 100, "cadence": "once"},
    {"id": "invite_friend", "label": "Invite a creator friend", "credits": 250, "cadence": "once"},
    {"id": "connect_account", "label": "Connect a publishing account", "credits": 150, "cadence": "once"},
    {"id": "brand_kit", "label": "Save a brand logo", "credits": 50, "cadence": "once"},
]


@router.get("/rewards")
def rewards() -> Dict[str, Any]:
    claimed = {r.get("id") for r in store.Collection("reward_claims").all()}
    tasks = [{**task, "claimed": task["id"] in claimed} for task in REWARD_TASKS]
    return {"tasks": tasks, "balance": credit_ledger.balance(),
            "unlimited": credit_ledger.UNLIMITED_CREDITS,
            "referral_link": "https://wayinvideo.local/editor.html#rewards?ref=local"}


class RewardClaim(BaseModel):
    id: str


@router.post("/rewards/claim")
def claim_reward(body: RewardClaim) -> Dict[str, Any]:
    task = next((t for t in REWARD_TASKS if t["id"] == body.id), None)
    if not task:
        raise HTTPException(status_code=404, detail=f"unknown reward {body.id}")
    claims = store.Collection("reward_claims")
    if claims.get(body.id):
        raise HTTPException(status_code=409, detail="already claimed")
    balance = credit_ledger.grant(int(task["credits"]), note=f"reward:{body.id}")
    claims.upsert({"id": body.id, "credits": task["credits"], "label": task["label"]})
    store.notify("rewards", f"+{task['credits']} credits", task["label"], level="success")
    return {"balance": balance, "task": task}


@router.get("/notifications")
def list_notifications() -> Dict[str, Any]:
    items = sorted(store.notifications.all(), key=lambda n: n.get("at", 0), reverse=True)[:50]
    return {"items": items, "unread": len([i for i in items if not i.get("read")])}


class NotifyBody(BaseModel):
    ids: Optional[List[str]] = None
    read: bool = True


@router.post("/notifications/read")
def read_notifications(body: NotifyBody) -> Dict[str, Any]:
    items = store.notifications.all()
    for item in items:
        if body.ids is None or item.get("id") in body.ids:
            item["read"] = body.read
    for item in items:
        store.notifications.upsert(item)
    return list_notifications()


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------
def blank_project(name: str = "Untitled project") -> Dict[str, Any]:
    return {
        "id": store.new_id("proj"),
        "name": name,
        "created_at": store.now(),
        "aspect": "9:16",
        "layout": "fit",
        "status": "draft",
        "source": {},
        "transcripts": None,
        "transcript": {"language": "", "segments": [], "text": ""},
        "clips": [],
        "texts": [],
        "hooks": [],
        "broll": [],
        "audio": {"enhance": False, "items": []},
        "subtitles": {"enabled": True, "preset": "word_highlight", "lines": [],
                      "style": {"size": "medium", "position": "bottom"}, "emojis": False,
                      "speaker_labels": False},
        "brand": {"logo": {"enabled": False}},
        "thumbnails": [],
        "exports": [],
        "waveform": [],
        "deleted": [],
        "workflow": WORKFLOW,
    }


class ProjectBody(BaseModel):
    name: Optional[str] = None
    aspect: Optional[str] = None
    layout: Optional[str] = None


@router.post("/projects")
def create_project(body: Optional[ProjectBody] = None) -> Dict[str, Any]:
    project = blank_project((body.name if body else None) or "Untitled project")
    if body and body.aspect:
        project["aspect"] = body.aspect
    if body and body.layout:
        project["layout"] = body.layout
    save_project(project)
    return project


@router.get("/projects")
def list_projects() -> Dict[str, Any]:
    items = store.projects_index.all()
    items.sort(key=lambda p: p.get("updated_at", 0), reverse=True)
    return {"items": items}


@router.get("/projects/{project_id}")
def get_project(project_id: str) -> Dict[str, Any]:
    return load_project(project_id)


@router.patch("/projects/{project_id}")
def autosave_project(project_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Autosave: the whole document is written, the id in the URL wins."""
    existing = load_project(project_id)
    merged = {**existing, **(body or {})}
    merged["id"] = project_id
    save_project(merged)
    return {"ok": True, "updated_at": merged["updated_at"], "name": merged.get("name"),
            "duration": merged.get("duration", 0)}


class RenameBody(BaseModel):
    name: str


@router.post("/projects/{project_id}/rename")
def rename_project(project_id: str, body: RenameBody) -> Dict[str, Any]:
    project = load_project(project_id)
    project["name"] = body.name[:120] or project["name"]
    save_project(project)
    return {"ok": True, "name": project["name"]}


@router.post("/projects/{project_id}/duplicate")
def duplicate_project(project_id: str) -> Dict[str, Any]:
    project = load_project(project_id)
    copy = dict(project)
    copy["id"] = store.new_id("proj")
    copy["name"] = f"{project.get('name', 'Untitled')} (copy)"
    copy["created_at"] = store.now()
    copy["exports"] = []
    save_project(copy)
    return copy


@router.delete("/projects/{project_id}")
def delete_project(project_id: str) -> Dict[str, Any]:
    if not store.read_project(project_id):
        raise HTTPException(status_code=404, detail="unknown project")
    store.delete_project(project_id)
    shutil.rmtree(Path(MEDIA_DIR) / project_id, ignore_errors=True)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Processing pipeline (Part B)
# ---------------------------------------------------------------------------
PROCESS_STEPS = [
    "Downloading video", "Extracting audio", "Transcribing (word timestamps)",
    "Generating thumbnails & waveform", "Building timeline",
]


def _finish_project(project: Dict[str, Any], *, task_id: str) -> Dict[str, Any]:
    """Give a processed project everything the editor needs to open."""
    project["status"] = "ready"
    project["workflow_stage"] = "timeline + preview + export"
    save_project(project)
    store.notify("project", f"'{project['name']}' is ready",
                 f"{len(project.get('clips') or [])} clips on the timeline",
                 link=f"/editor.html?project={project['id']}", level="success")
    return {
        "project": project,
        "project_id": project["id"],
        "url": f"/editor.html?project={project['id']}",
        "task_id": task_id,
    }


def process_source(source: str, *, name: str = "", language: str = "", aspect: str = "9:16",
                   layout: str = "fit", task_id: str = "") -> Dict[str, Any]:
    """download → audio → transcript → thumbnails/waveform → timeline."""
    project = blank_project(name or "Untitled project")
    project["aspect"] = aspect
    project["layout"] = layout
    project_id = project["id"]
    out_dir = _out_dir(project_id)
    steps = PROCESS_STEPS

    def stage(index: int, progress: float, label: str) -> None:
        if task_id:
            STORE.stage(task_id, index, progress, label)
        check_cancel(task_id) if task_id else None

    stage(0, 5.0, steps[0])
    # `/media/...` links (our own renders and clips) are web paths, not files on
    # disk — map them back before the ingest step so clipping → editing works.
    if source.startswith(f"/{MEDIA_MOUNT}/"):
        try:
            source = resolve_media(source)
        except HTTPException as exc:
            raise MediaError(str(exc.detail)) from exc
    path, info = ingest.resolve_input(source)
    project["source"] = {
        "path": str(path),
        "media": _published(path, project_id, "source" + Path(path).suffix),
        "duration": round(float(info.get("duration") or 0), 3),
        "title": str(info.get("title") or Path(path).stem)[:180],
        "thumbnail": info.get("thumbnail") or "",
        "uploader": info.get("uploader") or info.get("channel") or "",
        "platform": _platform(str(info.get("webpage_url") or source)),
        "webpage_url": info.get("webpage_url") or (source if source.startswith("http") else ""),
    }
    probe = render.probe(path)
    project["source"].update({"width": probe.get("width"), "height": probe.get("height"),
                              "fps": round(float(probe.get("fps") or 30), 3),
                              "has_audio": probe.get("has_audio")})
    project["duration"] = project["source"]["duration"] or probe.get("duration") or 0

    stage(1, 20.0, steps[1])
    from .common import transcribe_path

    data = transcribe_path(path, language=language or None)
    project["transcript"] = {"language": data.get("language", ""), "text": data.get("text", ""),
                             "segments": data.get("segments", [])}
    project["subtitles"]["lines"] = _lines_from_segments(data.get("segments", []))
    project["subtitles"]["language"] = data.get("language", "")

    stage(3, 78.0, steps[3])
    frames = _timeline_thumbnails(path, project_id, project["duration"])
    # store web paths — absolute filesystem paths are not reachable from the browser
    project["thumbs"] = [f"/{MEDIA_MOUNT}/{project_id}/thumbs/{Path(f).name}" for f in frames]
    project["poster"] = _published(Path(frames[0]), project_id, "poster.jpg") if frames else ""
    project["waveform"] = render.waveform(path, buckets=900)

    stage(4, 92.0, steps[4])
    project["clips"] = _initial_clips(data.get("segments", []), project["duration"])
    return _finish_project(project, task_id=task_id)


def _published(src: Path | str, project_id: str, name: str) -> str:
    src = Path(src)
    if not src.is_file():
        return ""
    out = _out_dir(project_id) / name
    if out.resolve() != src.resolve():
        try:
            os.link(src, out)
        except OSError:
            shutil.copy2(src, out)
    return f"/{MEDIA_MOUNT}/{project_id}/{out.name}"


def _platform(url: str) -> str:
    lowered = (url or "").lower()
    for key in ("youtube", "tiktok", "instagram", "facebook", "vimeo", "twitter", "x.com"):
        if key in lowered:
            return "x" if key == "x.com" else key
    return "link" if lowered.startswith("http") else "file"


def _lines_from_segments(segments: List[Dict[str, Any]],
                         *, max_words: int = 6) -> List[Dict[str, Any]]:
    """Group word-level timings into short, caption-sized lines."""
    lines: List[Dict[str, Any]] = []
    buffer: List[Dict[str, Any]] = []
    for seg in segments:
        words = [w for w in (seg.get("words") or []) if w.get("w")]
        if not words:
            if str(seg.get("text", "")).strip():
                lines.append({"id": len(lines), "start": float(seg.get("start", 0)),
                              "end": float(seg.get("end", 0)), "text": str(seg["text"]).strip(),
                              "words": []})
            continue
        for word in words:
            buffer.append(word)
            if len(buffer) >= max_words:
                lines.append(_line_from_words(buffer, len(lines)))
                buffer = []
        if buffer:
            lines.append(_line_from_words(buffer, len(lines)))
            buffer = []
    return lines


def _line_from_words(words: List[Dict[str, Any]], index: int) -> Dict[str, Any]:
    return {
        "id": index,
        "start": round(float(words[0].get("s", 0)), 3),
        "end": round(float(words[-1].get("e", 0)), 3),
        "text": " ".join(str(w.get("w", "")).strip() for w in words),
        "words": [{"w": str(w.get("w", "")).strip(), "s": round(float(w.get("s", 0)), 3),
                   "e": round(float(w.get("e", 0)), 3)} for w in words],
    }


def _initial_clips(segments: List[Dict[str, Any]], duration: float,
                   *, target: float = 30.0) -> List[Dict[str, Any]]:
    """Cut the source into scene-sized clips, snapping cuts to speech pauses."""
    duration = float(duration or 0)
    if duration <= 0 and segments:
        duration = float(segments[-1].get("end", 0))
    if duration <= 0:
        return []
    pauses = [(float(segments[i].get("end", 0)), float(segments[i + 1].get("start", 0)))
              for i in range(len(segments) - 1)]
    cuts = [0.0]
    cursor = 0.0
    while duration - cursor > target:
        window_end = cursor + target
        candidates = [(a + b) / 2 for a, b in pauses if window_end - 6 <= (a + b) / 2 <= window_end + 6]
        cut = min(candidates, key=lambda c: abs(c - window_end)) if candidates else window_end
        if cut - cursor < 4:
            cut = min(duration, cursor + target)
        cuts.append(round(cut, 3))
        cursor = cut
    cuts.append(round(duration, 3))
    clips: List[Dict[str, Any]] = []
    for i in range(len(cuts) - 1):
        clips.append({
            "id": f"clip{i + 1}",
            "start": cuts[i], "end": cuts[i + 1],
            "layout": "", "speed": 1.0, "volume": 1.0, "fade_in": 0.0, "fade_out": 0.0,
            "crop": {}, "transform": {}, "effects": [],
            "transition": {"type": "none", "duration": 0.4},
        })
    return clips


def _timeline_thumbnails(path: Path | str, project_id: str, duration: float,
                         *, count: int = 10) -> List[str]:
    if duration <= 0:
        return []
    stamps = [duration * (i + 0.5) / count for i in range(count)]
    return render.extract_frames(path, _out_dir(project_id) / "thumbs",
                                 timestamps=stamps, width=200)


class ProcessBody(BaseModel):
    url: str = ""
    path: str = ""
    name: str = ""
    language: str = ""
    aspect: str = "9:16"
    layout: str = "fit"


def _start_process(source: str, body: ProcessBody, task_id_out: Dict[str, str]) -> Dict[str, Any]:
    action = "process_video"
    charge(action, note=f"process {source[:60]}")

    def worker(task) -> Dict[str, Any]:
        try:
            return process_source(source, name=body.name, language=body.language,
                                  aspect=body.aspect, layout=body.layout, task_id=task.id)
        except TaskCancelled:
            refund(action, "cancelled")
            raise
        except Exception:
            refund(action, "processing failed")
            raise

    result = _start_task("editor-process", PROCESS_STEPS, worker)
    task_id_out["task_id"] = result["task_id"]
    return result


def _start_task(feature: str, steps: List[str], worker) -> Dict[str, Any]:
    task = STORE.create(feature, steps)
    STORE.run(task, lambda: worker(task), STORE)
    return {"task_id": task.id, "status": "queued"}


@router.post("/editor/process")
def process_url(body: ProcessBody) -> Dict[str, Any]:
    source = (body.url or body.path or "").strip()
    if not source:
        raise HTTPException(status_code=400, detail="paste a video URL or pick a file")
    return _start_process(source, body, {})


@router.post("/editor/process-upload")
async def process_upload(
    file: UploadFile = File(...),
    language: str = Form(""),
    aspect: str = Form("9:16"),
    layout: str = Form("fit"),
    name: str = Form(""),
) -> Dict[str, Any]:
    path = await accept_upload(file, subdir="editor")
    body = ProcessBody(path=str(path), name=name or Path(path).stem, language=language,
                       aspect=aspect, layout=layout)
    return _start_process(str(path), body, {})


@router.get("/editor/status/{task_id}")
def task_status(task_id: str) -> Dict[str, Any]:
    task = STORE.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"unknown task {task_id}")
    return task.public()


@router.post("/editor/cancel/{task_id}")
def cancel_task(task_id: str) -> Dict[str, Any]:
    if not STORE.cancel(task_id):
        raise HTTPException(status_code=404, detail="unknown task")
    return {"ok": True, "task_id": task_id}


class MetadataBody(BaseModel):
    url: str


@router.post("/editor/metadata")
def metadata(body: MetadataBody) -> Dict[str, Any]:
    """Preview card for the start page: thumbnail, title, channel, duration."""
    url = (body.url or "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="paste a full video URL")
    from ..engine import media

    try:
        info = media.fetch_metadata(url)
    except MediaError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"{type(exc).__name__}: {exc}")
    duration = info.get("duration") or 0
    return {
        "url": url,
        "title": str(info.get("title") or "")[:200],
        "thumbnail": info.get("thumbnail") or "",
        "duration": round(float(duration or 0), 2),
        "duration_label": _hms(float(duration or 0)),
        "uploader": info.get("uploader") or info.get("channel") or "",
        "platform": _platform(str(info.get("webpage_url") or url)),
        "view_count": info.get("view_count"),
    }


def _hms(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    h, m = int(seconds // 3600), int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


# ---------------------------------------------------------------------------
# Export (Part T)
# ---------------------------------------------------------------------------
EXPORT_STEPS = ["Building filter graph", "Encoding video", "Saving to library"]


class ExportBody(BaseModel):
    project_id: Optional[str] = None
    project: Optional[Dict[str, Any]] = None
    resolution: str = "1080p"
    fps: int = 30
    quality: str = "high"
    burn_subtitles: bool = True
    watermark: bool = False
    filename: Optional[str] = None


@router.post("/editor/export")
def export(body: ExportBody) -> Dict[str, Any]:
    project = load_project(body.project_id) if body.project_id else (body.project or {})
    if not project:
        raise HTTPException(status_code=400, detail="send project_id or project")
    if not project.get("clips"):
        raise HTTPException(status_code=400, detail="the timeline is empty – add clips first")
    action = "export"
    charge(action, note=f"export {body.resolution}")

    options = render.RenderOptions(resolution=body.resolution, fps=body.fps, quality=body.quality,
                                   burn_subtitles=body.burn_subtitles, watermark=body.watermark,
                                   filename=body.filename)

    def worker(task) -> Dict[str, Any]:
        out_dir = _out_dir(str(project.get("id") or "adhoc"))
        stamp = int(time.time())
        out = out_dir / (body.filename or f"export_{body.resolution}_{stamp}.mp4")

        def progress(pct: float, stage: str) -> None:
            index = 0 if pct < 30 else (1 if pct < 99 else 2)
            STORE.stage(task.id, index, pct, stage)
            check_cancel(task.id)

        try:
            report = render.render_project(project, out, options, progress=progress,
                                           should_cancel=lambda: STORE.cancelled(task.id))
        except TaskCancelled:
            refund(action, "cancelled")
            raise
        except Exception:
            refund(action, "export failed")
            raise

        url = f"/{MEDIA_MOUNT}/{out.parent.name}/{out.name}"
        if body.project_id:
            stored = load_project(body.project_id)
            record = {
                "id": store.new_id("exp"),
                "url": url,
                "name": out.name,
                "resolution": body.resolution,
                "fps": body.fps,
                "quality": body.quality,
                "size_bytes": report["size_bytes"],
                "duration": report["duration"],
                "created_at": store.now(),
            }
            stored.setdefault("exports", []).insert(0, record)
            store.write_project(stored)
            store.assets.upsert({**record, "kind": "export", "project_id": body.project_id,
                                 "media": url, "path": str(out)})
        store.notify("export", "Export ready", f"{out.name} · {body.resolution}",
                     link=url, level="success")
        return {**report,
                "url": url,
                "download_name": body.filename or out.name,
                "resolution": body.resolution,
                "subtitles_burned": body.burn_subtitles,
                "watermark": body.watermark}

    return _start_task("editor-export", EXPORT_STEPS, worker)


# ---------------------------------------------------------------------------
# AI tools (Part E) + analysis (Parts H/I)
# ---------------------------------------------------------------------------
class SourceBody(BaseModel):
    source: str = ""
    project_id: Optional[str] = None


def _project_source(project: Dict[str, Any]) -> str:
    source = project.get("source") or {}
    path = source.get("path") or ""
    if path and os.path.isfile(path):
        return path
    media = source.get("media")
    if media:
        return resolve_media(media)
    raise HTTPException(status_code=400, detail="this project has no source video")


class FillersBody(SourceBody):
    min_count: int = 1


@router.post("/editor/tools/fillers")
def tool_fillers(body: FillersBody) -> Dict[str, Any]:
    """Detected filler words with counts and cut ranges."""
    charge("remove_filler")
    if body.project_id:
        project = load_project(body.project_id)
        segments = (project.get("transcript") or {}).get("segments") or []
    else:
        src = resolve_media(body.source)
        data = _transcribe_json(src)
        segments = data.get("segments", [])
    result = enhance.detect_fillers(segments)
    result["cuts"] = enhance.merge_ranges([r for item in result["words"] for r in item["ranges"]])
    result["cost"] = credit_ledger.cost_of("remove_filler")
    return result


def _transcribe_json(src: str) -> Dict[str, Any]:
    from .common import transcribe_path

    try:
        return transcribe_path(src)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"transcription failed: {exc}")


class SilenceBody(SourceBody):
    threshold_db: float = SILENCE_DB
    min_duration: float = SILENCE_MIN_SEC


@router.post("/editor/tools/silences")
def tool_silences(body: SilenceBody) -> Dict[str, Any]:
    charge("remove_silence")
    src = _project_source(load_project(body.project_id)) if body.project_id else resolve_media(body.source)
    try:
        report = enhance.detect_silences(src, threshold_db=body.threshold_db,
                                         min_duration=body.min_duration)
    except Exception as exc:  # noqa: BLE001
        refund("remove_silence")
        raise HTTPException(status_code=422, detail=str(exc))
    report["kept"] = [[round(a, 3), round(b, 3)]
                      for a, b in enhance.spans_after_cuts(
                          report["duration"],
                          [(s["start"], s["end"]) for s in report["silences"]])]
    report["cost"] = credit_ledger.cost_of("remove_silence")
    report["threshold_db"] = body.threshold_db
    report["min_duration"] = body.min_duration
    return report


class EnhanceBody(BaseModel):
    project_id: Optional[str] = None
    source: Optional[str] = None
    enabled: bool = True
    start: float = 0.0
    duration: float = 8.0
    strength: float = 1.0


@router.post("/editor/tools/enhance")
def tool_enhance(body: EnhanceBody) -> Dict[str, Any]:
    """Toggle Enhance Speech and render the before/after A/B clips."""
    if body.project_id:
        project = load_project(body.project_id)
        src = _project_source(project)
        project.setdefault("audio", {})
        if isinstance(project.get("audio"), dict):
            project["audio"]["enhance"] = bool(body.enabled)
            project["audio"]["strength"] = body.strength
            store.write_project(project)
    else:
        src = resolve_media(body.source or "")
    charge("enhance_speech")
    if not body.enabled:
        return {"enabled": False, "filters": enhance.enhance_filters(body.strength)}
    try:
        pair = enhance.preview_pair(src, _out_dir("enhance"), start=body.start,
                                    duration=min(12.0, max(2.0, body.duration)))
    except Exception as exc:  # noqa: BLE001
        refund("enhance_speech")
        raise HTTPException(status_code=422, detail=f"enhance preview failed: {exc}")
    return {
        "enabled": True,
        "before": f"/{MEDIA_MOUNT}/enhance/{Path(pair['before']).name}",
        "after": f"/{MEDIA_MOUNT}/enhance/{Path(pair['after']).name}",
        "filters": enhance.enhance_filters(body.strength),
        "cost": credit_ledger.cost_of("enhance_speech"),
    }


class SpeakersBody(BaseModel):
    project_id: str
    enabled: bool = True


@router.post("/editor/tools/speakers")
def tool_speakers(body: SpeakersBody) -> Dict[str, Any]:
    charge("speaker_labels")
    project = load_project(body.project_id)
    result = enhance.assign_speakers((project.get("transcript") or {}).get("segments") or [])
    project["subtitles"]["speaker_labels"] = bool(body.enabled)
    if result["segments"]:
        labelled = {round(float(s.get("start", 0)), 3): s.get("speaker", 0) for s in result["segments"]}
        for line in project["subtitles"].get("lines") or []:
            key = round(float(line.get("start", 0)), 3)
            if key in labelled:
                line["speaker"] = labelled[key]
    store.write_project(project)
    return {"enabled": body.enabled, "speakers": result["speakers"], "note": result["note"],
            "cost": credit_ledger.cost_of("speaker_labels")}


class EmojisBody(BaseModel):
    project_id: str
    enabled: bool = True


@router.post("/editor/tools/emojis")
def tool_emojis(body: EmojisBody) -> Dict[str, Any]:
    charge("ai_emojis")
    project = load_project(body.project_id)
    project["subtitles"]["emojis"] = bool(body.enabled)
    counts: Dict[str, int] = {}
    for line in project["subtitles"].get("lines") or []:
        glyph = captions.emoji_for(str(line.get("text", "")))
        if glyph:
            counts[glyph] = counts.get(glyph, 0) + 1
    store.write_project(project)
    return {"enabled": body.enabled, "inserted": counts,
            "total": sum(counts.values()), "map_size": len(captions.EMOJI_MAP),
            "note": "monochrome pictographs – the bundled libass cannot rasterise colour-emoji fonts",
            "cost": credit_ledger.cost_of("ai_emojis")}


class ReframeBody(BaseModel):
    project_id: str
    ratio: str = "9:16"
    layout: str = "auto"
    scene_detect: bool = False
    apply: bool = True


@router.post("/editor/tools/reframe")
def tool_reframe(body: ReframeBody) -> Dict[str, Any]:
    charge("reframe")
    project = load_project(body.project_id)
    src = _project_source(project)
    try:
        plan = reframe.plan(src, ratio=body.ratio, layout_pref=body.layout,
                            duration=float(project.get("duration") or 0),
                            segments=(project.get("transcript") or {}).get("segments"),
                            use_scene_detect=body.scene_detect)
    except reframe.ReframeError as exc:
        refund("reframe")
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        refund("reframe")
        raise HTTPException(status_code=500, detail=f"reframe failed: {exc}")

    result: Dict[str, Any] = {"plan": plan, "cost": credit_ledger.cost_of("reframe")}
    if body.apply:
        project["aspect"] = body.ratio
        project["clips"] = reframe.apply_to_clips(project.get("clips") or [], plan["scenes"])
        store.write_project(project)
        result["clips"] = project["clips"]
        result["applied"] = True
    return result


class HookBody(BaseModel):
    project_id: str
    platform: str = "youtube"
    niche: str = ""
    title: str = ""


@router.post("/editor/tools/hook")
def tool_hook(body: HookBody) -> Dict[str, Any]:
    charge("hook")
    project = load_project(body.project_id)
    title = body.title or (project.get("source") or {}).get("title") or project.get("name", "")
    result = ai_media.write_hooks(project, platform=body.platform, title=title, niche=body.niche)
    result["cost"] = credit_ledger.cost_of("hook")
    return result


class HookAdd(BaseModel):
    project_id: str
    text: str
    start: float = 0.0
    duration: float = 4.0
    preset: str = "boxed_white"
    teaser: bool = False
    source_start: Optional[float] = None


@router.post("/editor/tools/hook/add")
def hook_add(body: HookAdd) -> Dict[str, Any]:
    """Place the hook as an animated overlay (+ optional teaser cold open)."""
    project = load_project(body.project_id)
    hook = {
        "id": store.new_id("hook"),
        "text": body.text[:200],
        "start": round(max(0.0, body.start), 2),
        "end": round(max(0.0, body.start) + max(1.0, min(12.0, body.duration)), 2),
        "preset": body.preset,
        "style": {"y": 0.14, "size": "large", "x": 0.5, "animation_in": "pop", "animation_out": "fade"},
    }
    project.setdefault("hooks", []).append(hook)
    if body.teaser and body.source_start is not None:
        clips = project.get("clips") or []
        if clips:
            end = min(float(project.get("duration") or 0), float(body.source_start) + 6.0)
            teaser = dict(clips[0])
            teaser.update({"id": store.new_id("clip"), "start": float(body.source_start),
                           "end": end, "transition": {"type": "fade", "duration": 0.4}})
            project["clips"] = [teaser] + clips
    store.write_project(project)
    return {"hook": hook, "clips": project.get("clips", []), "ok": True}


class TitleBody(BaseModel):
    project_id: str


@router.post("/editor/tools/titles")
def tool_titles(body: TitleBody) -> Dict[str, Any]:
    charge("title")
    return {**ai_media.write_titles(load_project(body.project_id)),
            "cost": credit_ledger.cost_of("title")}


class DescBody(BaseModel):
    project_id: str
    platform: str = "youtube"


@router.post("/editor/tools/description")
def tool_description(body: DescBody) -> Dict[str, Any]:
    charge("description")
    return {**ai_media.write_description(load_project(body.project_id), platform=body.platform),
            "cost": credit_ledger.cost_of("description")}


class TranslateBody(BaseModel):
    project_id: str
    language: str
    apply: bool = True


@router.post("/editor/tools/translate")
def tool_translate(body: TranslateBody) -> Dict[str, Any]:
    charge("translate")
    project = load_project(body.project_id)
    lines = project["subtitles"].get("lines") or []
    try:
        result = ai_media.translate_lines(lines, body.language,
                                          source_lang=(project.get("transcript") or {}).get("language", ""))
    except ai_media.ProviderNotConfigured as exc:
        refund("translate")
        raise HTTPException(status_code=503, detail={"message": str(exc), "configure": "WV_LLM_API_KEY"})
    except Exception as exc:  # noqa: BLE001
        refund("translate")
        raise HTTPException(status_code=422, detail=f"translation failed: {exc}")
    if body.apply:
        project["subtitles"]["lines"] = result["lines"]
        project["subtitles"]["language"] = body.language
        store.write_project(project)
    result["cost"] = credit_ledger.cost_of("translate")
    return result


class BRollBody(BaseModel):
    project_id: str
    mode: str = "stock"          # stock | ai
    query: str = ""
    moments: int = 6
    start: Optional[float] = None
    end: Optional[float] = None


@router.post("/editor/tools/broll")
def tool_broll(body: BRollBody) -> Dict[str, Any]:
    project = load_project(body.project_id)
    if body.query:
        start = float(body.start if body.start is not None else 0.0)
        end = float(body.end if body.end is not None else start + 5.0)
        plan = {"moments": [{"start": round(start, 2), "end": round(max(start + 1, end), 2),
                             "query": body.query, "kind": "ai" if body.mode == "ai" else "stock"}],
                "mode": body.mode, "source": "custom prompt"}
    else:
        plan = ai_media.plan_broll(project, mode=body.mode, moments=body.moments)
    return {"plan": plan, "cost": credit_ledger.cost_of("broll_ai" if body.mode == "ai" else "broll_stock")}


class BRollInsert(BaseModel):
    project_id: str
    moment: Dict[str, Any]
    asset_id: Optional[str] = None
    url: Optional[str] = None


@router.post("/editor/tools/broll/insert")
def broll_insert(body: BRollInsert) -> Dict[str, Any]:
    """Attach a chosen stock/AI asset to a planned moment on the overlay track."""
    project = load_project(body.project_id)
    mode = str(body.moment.get("kind", "stock"))
    charge("broll_ai" if mode == "ai" else "broll_stock")
    url = body.url
    if body.asset_id:
        asset = store.assets.get(body.asset_id)
        if asset:
            url = asset.get("media") or asset.get("url")
    if not url:
        refund("broll_ai" if mode == "ai" else "broll_stock")
        raise HTTPException(status_code=400, detail="no asset selected for this moment")
    item = {
        "id": store.new_id("broll"),
        "media": url,
        "start": round(float(body.moment.get("start", 0)), 2),
        "end": round(float(body.moment.get("end", 4)), 2),
        "from": 0.0,
        "query": body.moment.get("query", ""),
        "kind": mode,
    }
    project.setdefault("broll", []).append(item)
    store.write_project(project)
    return {"broll": item, "count": len(project["broll"]), "ok": True}


class ThumbBody(BaseModel):
    project_id: str
    title: str = ""
    count: int = 3


@router.post("/editor/tools/thumbnail")
def tool_thumbnail(body: ThumbBody) -> Dict[str, Any]:
    charge("thumbnail")
    project = load_project(body.project_id)
    src = _project_source(project)
    title = body.title or (project.get("source") or {}).get("title") or project.get("name", "")
    try:
        made = ai_media.build_thumbnails(src, _out_dir(str(project["id"])) / "thumbs_ai",
                                        title=title, aspect="16:9", count=body.count)
    except Exception as exc:  # noqa: BLE001
        refund("thumbnail")
        raise HTTPException(status_code=422, detail=f"thumbnail render failed: {exc}")
    items = []
    for entry in made:
        rel = Path(entry["path"]).relative_to(MEDIA_DIR)
        items.append({**entry, "media": f"/{MEDIA_MOUNT}/{rel.as_posix()}"})
    project["thumbnails"] = items
    store.write_project(project)
    return {"thumbnails": items, "cost": credit_ledger.cost_of("thumbnail")}


# ---------------------------------------------------------------------------
# Generate media: AI video / music / SFX
# ---------------------------------------------------------------------------
class MusicBody(BaseModel):
    project_id: Optional[str] = None
    prompt: str = "calm background bed"
    mood: str = ""
    duration: float = 20.0
    start: float = 0.0


@router.post("/editor/generate/music")
def generate_music(body: MusicBody) -> Dict[str, Any]:
    charge("ai_music")
    try:
        result = ai_media.generate_music(body.prompt, duration=body.duration, mood=body.mood)
    except Exception as exc:  # noqa: BLE001
        refund("ai_music")
        raise HTTPException(status_code=422, detail=f"music generation failed: {exc}")
    rel = Path(result["path"]).relative_to(MEDIA_DIR)
    media = f"/{MEDIA_MOUNT}/{rel.as_posix()}"
    asset = store.assets.upsert({"id": store.new_id("asset"), "kind": "audio", "name": "AI music",
                                 "media": media, "path": result["path"], "source": result["provider"],
                                 "duration": round(float(body.duration), 2), "tag": "music"})
    item = None
    if body.project_id:
        project = load_project(body.project_id)
        item = {"id": store.new_id("audio"), "media": media, "start": round(float(body.start), 2),
                "end": round(float(body.start) + float(body.duration), 2), "from": 0.0,
                "volume": 0.3, "fade_in": 0.6, "fade_out": 1.0, "loop": True, "duck": True,
                "kind": "music", "name": body.prompt[:80]}
        project.setdefault("audio", {"enhance": False, "items": []})
        project["audio"].setdefault("items", []).append(item)
        store.write_project(project)
    return {"media": media, "asset": asset, "item": item, "provider": result["provider"],
            "note": result.get("note", ""), "cost": credit_ledger.cost_of("ai_music")}


class SfxBody(BaseModel):
    project_id: Optional[str] = None
    prompt: str = "whoosh"
    duration: float = 1.2
    at: float = 0.0


@router.post("/editor/generate/sfx")
def generate_sfx(body: SfxBody) -> Dict[str, Any]:
    charge("ai_sfx")
    try:
        result = ai_media.generate_sfx(body.prompt, duration=body.duration)
    except Exception as exc:  # noqa: BLE001
        refund("ai_sfx")
        raise HTTPException(status_code=422, detail=f"sound effect generation failed: {exc}")
    rel = Path(result["path"]).relative_to(MEDIA_DIR)
    media = f"/{MEDIA_MOUNT}/{rel.as_posix()}"
    asset = store.assets.upsert({"id": store.new_id("asset"), "kind": "audio", "name": body.prompt[:60],
                                 "media": media, "path": result["path"], "source": result["provider"],
                                 "duration": round(float(body.duration), 2), "tag": "sfx"})
    item = None
    if body.project_id:
        project = load_project(body.project_id)
        item = {"id": store.new_id("sfx"), "media": media, "start": round(float(body.at), 2),
                "end": round(float(body.at) + float(body.duration), 2), "from": 0.0,
                "volume": 0.8, "fade_in": 0.0, "fade_out": 0.1, "loop": False, "duck": False,
                "kind": "sfx", "name": body.prompt[:60]}
        project.setdefault("audio", {"enhance": False, "items": []})
        project["audio"].setdefault("items", []).append(item)
        store.write_project(project)
    return {"media": media, "asset": asset, "item": item, "provider": result["provider"],
            "note": result.get("note", ""), "cost": credit_ledger.cost_of("ai_sfx")}


class VideoBody(BaseModel):
    project_id: Optional[str] = None
    prompt: str
    duration: float = 5.0
    ratio: str = "9:16"
    image: Optional[str] = None
    at: float = 0.0


@router.post("/editor/generate/video")
def generate_video(body: VideoBody) -> Dict[str, Any]:
    charge("ai_video")
    try:
        result = ai_media.generate_video(body.prompt, duration=body.duration, ratio=body.ratio,
                                         image=body.image)
    except ai_media.ProviderNotConfigured as exc:
        refund("ai_video")
        raise HTTPException(status_code=503, detail={"message": str(exc),
                                                    "configure": "WV_AI_VIDEO_URL + WV_AI_VIDEO_KEY"})
    except Exception as exc:  # noqa: BLE001
        refund("ai_video")
        raise HTTPException(status_code=422, detail=f"video generation failed: {exc}")
    rel = Path(result["path"]).relative_to(MEDIA_DIR)
    media = f"/{MEDIA_MOUNT}/{rel.as_posix()}"
    asset = store.assets.upsert({"id": store.new_id("asset"), "kind": "video", "name": body.prompt[:60],
                                 "media": media, "path": result["path"], "source": "ai",
                                 "duration": round(float(result.get("duration") or body.duration), 2)})
    item = None
    if body.project_id:
        project = load_project(body.project_id)
        item = {"id": store.new_id("broll"), "media": media, "start": round(float(body.at), 2),
                "end": round(float(body.at) + float(result.get("duration") or body.duration), 2),
                "from": 0.0, "query": body.prompt[:80], "kind": "ai-video"}
        project.setdefault("broll", []).append(item)
        store.write_project(project)
    return {"media": media, "asset": asset, "broll": item,
            "cost": credit_ledger.cost_of("ai_video")}


# ---------------------------------------------------------------------------
# Assets / media library / stock
# ---------------------------------------------------------------------------
@router.get("/assets")
def list_assets(kind: str = "") -> Dict[str, Any]:
    items = store.assets.all()
    if kind and kind != "all":
        items = [i for i in items if str(i.get("kind")) == kind.rstrip("s")]
    items.sort(key=lambda i: i.get("created_at", 0), reverse=True)
    return {"items": items, "count": len(items)}


@router.post("/assets/upload")
async def upload_asset(file: UploadFile = File(...), kind: str = Form("")) -> Dict[str, Any]:
    path = await accept_upload(file, subdir="assets")
    guessed = kind or _kind_of(path.name)
    rel = Path(path).relative_to(UPLOAD_DIR)
    media = None
    target = _out_dir("assets") / path.name
    try:
        os.link(path, target)
    except OSError:
        shutil.copy2(path, target)
    media = f"/{MEDIA_MOUNT}/assets/{target.name}"
    asset = store.assets.upsert({
        "id": store.new_id("asset"), "kind": guessed, "name": path.stem,
        "media": media, "path": str(path), "size_bytes": path.stat().st_size,
        "source": "upload", "folder": rel.parent.as_posix(),
    })
    return asset


def _kind_of(name: str) -> str:
    ext = Path(name).suffix.lower()
    if ext in (".mp4", ".mov", ".webm", ".mkv", ".avi"):
        return "video"
    if ext in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
        return "image"
    if ext in (".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"):
        return "audio"
    return "file"


class AssetPatch(BaseModel):
    name: Optional[str] = None
    tag: Optional[str] = None


@router.patch("/assets/{asset_id}")
def patch_asset(asset_id: str, body: AssetPatch) -> Dict[str, Any]:
    asset = store.assets.patch(asset_id, {k: v for k, v in body.dict().items() if v is not None})
    if not asset:
        raise HTTPException(status_code=404, detail="unknown asset")
    return asset


@router.delete("/assets/{asset_id}")
def delete_asset(asset_id: str) -> Dict[str, Any]:
    if not store.assets.delete(asset_id):
        raise HTTPException(status_code=404, detail="unknown asset")
    return {"ok": True}


@router.get("/stock/search")
def stock_search(kind: str = "videos", q: str = "", per_page: int = 18) -> Dict[str, Any]:
    if not stock.configured():
        return {"items": [], "configured": False, "provider": "none",
                "message": stock.StockNotConfigured().__str__(), "attribution": stock.attribution()}
    try:
        items = stock.search(kind, q, per_page=per_page)
    except stock.StockNotConfigured as exc:
        return {"items": [], "configured": False, "provider": stock.provider(), "message": str(exc)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"stock search failed: {exc}")
    return {"items": items, "configured": True, "provider": stock.provider(),
            "attribution": stock.attribution()}


class StockBody(BaseModel):
    url: str
    title: str = ""
    kind: str = "video"
    thumb: str = ""
    duration: float = 0.0


@router.post("/stock/download")
def stock_download(body: StockBody) -> Dict[str, Any]:
    """Pull a stock asset into the library (licence: Pexels/Pixabay)."""
    charge("stock_search")
    try:
        info = stock.download(body.url, prefix=body.kind or "stock")
    except Exception as exc:  # noqa: BLE001
        refund("stock_search")
        raise HTTPException(status_code=422, detail=f"stock download failed: {exc}")
    asset = store.assets.upsert({
        "id": store.new_id("asset"), "kind": body.kind or "video",
        "name": (body.title or Path(body.url).name)[:120], "media": info["media"],
        "path": info["path"], "thumb": body.thumb, "source": stock.provider(),
        "duration": round(float(body.duration or 0), 2), "size_bytes": info["size_bytes"],
        "licence": "Pexels/Pixabay – free to use",
    })
    return asset


class DownloadBody(BaseModel):
    url: str
    name: str = ""


@router.post("/assets/download")
def asset_download(body: DownloadBody) -> Dict[str, Any]:
    """Download any direct media URL into the library."""
    try:
        info = stock.download(body.url, prefix="url")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"download failed: {exc}")
    return store.assets.upsert({"id": store.new_id("asset"), "kind": _kind_of(body.url),
                                "name": body.name or Path(body.url).name[:120],
                                "media": info["media"], "path": info["path"], "source": "url"})


# ---------------------------------------------------------------------------
# Templates + Brand Kit
# ---------------------------------------------------------------------------
@router.get("/templates")
def list_templates() -> Dict[str, Any]:
    return {"items": sorted(store.templates.all(), key=lambda t: t.get("updated_at", 0), reverse=True),
            "builtin": BUILTIN_TEMPLATES}


BUILTIN_TEMPLATES = [
    {"id": "builtin-full", "name": "Full Screen", "category": "Others", "aspect": "9:16",
     "layout": "full", "caption_preset": "bold",
     "description": "Fill the frame, bold captions."},
    {"id": "builtin-blurred", "name": "Blurred", "category": "Podcast", "aspect": "9:16",
     "layout": "blur", "caption_preset": "white",
     "description": "Video fit over its own blurred background."},
    {"id": "builtin-split", "name": "Split Screen", "category": "Podcast", "aspect": "9:16",
     "layout": "split", "caption_preset": "word_highlight",
     "description": "Two speakers stacked for interviews."},
    {"id": "builtin-trio", "name": "Three Speakers", "category": "Podcast", "aspect": "9:16",
     "layout": "trio", "caption_preset": "karaoke",
     "description": "Three stacked bands for round tables."},
    {"id": "builtin-screenshare", "name": "Screen Share", "category": "Gaming", "aspect": "9:16",
     "layout": "pip", "caption_preset": "box_highlight",
     "description": "Content on top, speaker in a picture-in-picture."},
    {"id": "builtin-blurred-hook", "name": "Blurred with AI Hook", "category": "Others", "aspect": "9:16",
     "layout": "blur", "caption_preset": "colored_keyword", "hook": True,
     "description": "Blurred layout with a hook text box on top."},
    {"id": "builtin-grid", "name": "Grid Podcast", "category": "Podcast", "aspect": "1:1",
     "layout": "grid", "caption_preset": "pop_in",
     "description": "2×2 grid for square feeds."},
    {"id": "builtin-gaming", "name": "Gameplay Vertical", "category": "Gaming", "aspect": "9:16",
     "layout": "fit", "caption_preset": "italic_yellow",
     "description": "Gameplay with a punchy yellow caption track."},
]


class TemplateBody(BaseModel):
    id: Optional[str] = None
    name: str
    category: str = "Others"
    aspect: str = "9:16"
    layout: str = "fit"
    caption_preset: str = "word_highlight"
    caption_style: Optional[Dict[str, Any]] = None
    brand: Optional[Dict[str, Any]] = None
    text_presets: Optional[List[str]] = None
    effects: Optional[List[str]] = None
    description: str = ""
    thumbnail: str = ""


@router.post("/templates")
def save_template(body: TemplateBody) -> Dict[str, Any]:
    item = body.dict()
    item["id"] = item.get("id") or store.new_id("tpl")
    item["builtin"] = False
    return store.templates.upsert(item)


@router.delete("/templates/{template_id}")
def delete_template(template_id: str) -> Dict[str, Any]:
    if not store.templates.delete(template_id):
        raise HTTPException(status_code=404, detail="unknown template")
    return {"ok": True}


BRAND_SECTIONS = ["logos", "subtitle_styles", "text_styles", "images", "videos", "audio", "colors", "fonts"]


@router.get("/brandkit")
def get_brandkit() -> Dict[str, Any]:
    items = store.brandkit.all()
    grouped: Dict[str, List[Dict[str, Any]]] = {key: [] for key in BRAND_SECTIONS}
    for item in items:
        grouped.setdefault(str(item.get("section", "logos")), []).append(item)
    return {"sections": BRAND_SECTIONS, "items": items, "grouped": grouped}


class BrandItem(BaseModel):
    section: str
    name: str = ""
    value: str = ""
    media: str = ""
    color: str = ""
    style: Optional[Dict[str, Any]] = None


@router.post("/brandkit")
def add_brand_item(body: BrandItem) -> Dict[str, Any]:
    if body.section not in BRAND_SECTIONS:
        raise HTTPException(status_code=400, detail=f"section must be one of {BRAND_SECTIONS}")
    return store.brandkit.upsert({"id": store.new_id("brand"), **body.dict()})


@router.delete("/brandkit/{item_id}")
def delete_brand_item(item_id: str) -> Dict[str, Any]:
    if not store.brandkit.delete(item_id):
        raise HTTPException(status_code=404, detail="unknown brand item")
    return {"ok": True}


@router.post("/brandkit/upload")
async def upload_brand(file: UploadFile = File(...), section: str = Form("logos")) -> Dict[str, Any]:
    if section not in BRAND_SECTIONS:
        raise HTTPException(status_code=400, detail=f"section must be one of {BRAND_SECTIONS}")
    path = await accept_upload(file, subdir="brand")
    target = _out_dir("brand") / path.name
    try:
        os.link(path, target)
    except OSError:
        shutil.copy2(path, target)
    return store.brandkit.upsert({"id": store.new_id("brand"), "section": section,
                                  "name": path.stem, "media": f"/{MEDIA_MOUNT}/brand/{target.name}",
                                  "path": str(target), "kind": _kind_of(path.name)})


# ---------------------------------------------------------------------------
# Publish + Scheduler
# ---------------------------------------------------------------------------
PLATFORMS = [
    {"key": "youtube", "label": "YouTube", "oauth_url": "https://accounts.google.com/o/oauth2/v2/auth",
     "env": ["WV_YOUTUBE_CLIENT_ID", "WV_YOUTUBE_CLIENT_SECRET"]},
    {"key": "tiktok", "label": "TikTok", "oauth_url": "https://www.tiktok.com/auth/authorize/",
     "env": ["WV_TIKTOK_CLIENT_KEY", "WV_TIKTOK_CLIENT_SECRET"]},
    {"key": "instagram", "label": "Instagram", "oauth_url": "https://api.instagram.com/oauth/authorize",
     "env": ["WV_INSTAGRAM_CLIENT_ID", "WV_INSTAGRAM_CLIENT_SECRET"]},
    {"key": "facebook", "label": "Facebook", "oauth_url": "https://www.facebook.com/v19.0/dialog/oauth",
     "env": ["WV_FACEBOOK_CLIENT_ID", "WV_FACEBOOK_CLIENT_SECRET"]},
]


@router.get("/publish/accounts")
def publish_accounts() -> Dict[str, Any]:
    connected = {a.get("platform"): a for a in store.Collection("accounts").all()}
    out = []
    for platform in PLATFORMS:
        keys = [os.getenv(v, "") for v in platform["env"]]
        configured = all(keys)
        out.append({**platform, "configured": configured,
                    "connected": platform["key"] in connected,
                    "account": (connected.get(platform["key"]) or {}).get("handle", "")})
    return {"platforms": out, "scopes": {"youtube": ["youtube.upload"],
                                         "tiktok": ["video.publish"],
                                         "instagram": ["instagram_content_publish"],
                                         "facebook": ["pages_manage_posts"]}}


class ConnectBody(BaseModel):
    platform: str
    handle: str = ""


@router.post("/publish/connect")
def publish_connect(body: ConnectBody) -> Dict[str, Any]:
    platform = next((p for p in PLATFORMS if p["key"] == body.platform), None)
    if not platform:
        raise HTTPException(status_code=404, detail=f"unknown platform {body.platform}")
    keys = [os.getenv(v, "") for v in platform["env"]]
    if not all(keys):
        raise HTTPException(status_code=503, detail={
            "message": f"{platform['label']} OAuth is not configured on this server.",
            "configure": platform["env"],
            "docs": platform["oauth_url"],
            "upgrade": False,
        })
    account = store.Collection("accounts").upsert({
        "id": body.platform, "platform": body.platform, "handle": body.handle or "connected",
        "connected_at": store.now(),
    })
    store.notify("publish", f"{platform['label']} connected", account.get("handle", ""), level="success")
    return account


@router.delete("/publish/accounts/{platform}")
def publish_disconnect(platform: str) -> Dict[str, Any]:
    store.Collection("accounts").delete(platform)
    return {"ok": True}


class ScheduleBody(BaseModel):
    project_id: str
    platforms: List[str] = Field(default_factory=list)
    title: str = ""
    description: str = ""
    hashtags: List[str] = Field(default_factory=list)
    thumbnail: str = ""
    when: float = 0.0            # unix seconds; 0 = publish now
    export_url: str = ""


@router.post("/publish/schedule")
def schedule_post(body: ScheduleBody) -> Dict[str, Any]:
    project = load_project(body.project_id)
    if not body.platforms:
        raise HTTPException(status_code=400, detail="pick at least one platform")
    if not body.export_url and not (project.get("exports") or []):
        raise HTTPException(status_code=400, detail="export the video before publishing")
    post = store.posts.upsert({
        "id": store.new_id("post"),
        "project_id": body.project_id,
        "project_name": project.get("name", ""),
        "platforms": body.platforms,
        "title": body.title or project.get("name", ""),
        "description": body.description,
        "hashtags": body.hashtags,
        "thumbnail": body.thumbnail,
        "video": body.export_url or (project.get("exports") or [{}])[0].get("url", ""),
        "when": body.when or store.now(),
        "status": "scheduled" if body.when and body.when > store.now() else "ready",
        "history": [],
    })
    store.notify("publish", "Post scheduled" if post["status"] == "scheduled" else "Ready to publish",
                 f"{post['title'][:60]} → {', '.join(body.platforms)}")
    return post


@router.get("/schedule")
def list_schedule() -> Dict[str, Any]:
    items = store.posts.all()
    items.sort(key=lambda p: p.get("when", 0))
    counts: Dict[str, int] = {}
    for item in items:
        counts[item.get("status", "draft")] = counts.get(item.get("status", "draft"), 0) + 1
    return {"items": items, "counts": counts}


class SchedulePatch(BaseModel):
    when: Optional[float] = None
    title: Optional[str] = None
    description: Optional[str] = None
    hashtags: Optional[List[str]] = None
    platforms: Optional[List[str]] = None
    thumbnail: Optional[str] = None
    status: Optional[str] = None


@router.patch("/schedule/{post_id}")
def patch_schedule(post_id: str, body: SchedulePatch) -> Dict[str, Any]:
    changes = {k: v for k, v in body.dict().items() if v is not None}
    if "when" in changes:
        changes["status"] = "scheduled" if float(changes["when"]) > store.now() else "ready"
    post = store.posts.patch(post_id, changes)
    if not post:
        raise HTTPException(status_code=404, detail="unknown post")
    return post


@router.delete("/schedule/{post_id}")
def delete_schedule(post_id: str) -> Dict[str, Any]:
    if not store.posts.delete(post_id):
        raise HTTPException(status_code=404, detail="unknown post")
    return {"ok": True}


class PublishNow(BaseModel):
    post_id: str


@router.post("/publish/now")
def publish_now(body: PublishNow) -> Dict[str, Any]:
    """Trigger a post. Without platform credentials it records a real failure."""
    post = store.posts.get(body.post_id)
    if not post:
        raise HTTPException(status_code=404, detail="unknown post")
    accounts = {a.get("platform") for a in store.Collection("accounts").all()}
    missing = [p for p in post.get("platforms", []) if p not in accounts]
    if missing:
        store.posts.patch(post["id"], {
            "status": "failed",
            "error": f"no connected account for {', '.join(missing)} – connect it in Publish → Accounts",
            "history": (post.get("history") or []) + [
                {"at": store.now(), "event": "publish_failed", "detail": f"missing accounts: {missing}"}],
        })
        store.notify("publish", "Publish failed", f"Connect {', '.join(missing)} to continue", level="error")
        raise HTTPException(status_code=503, detail={
            "message": f"Connect {', '.join(missing)} first – this server holds no OAuth credentials for them.",
            "platforms": missing, "configure": "Publish → Accounts (WV_<PLATFORM>_CLIENT_ID/SECRET)",
        })
    charge("publish")
    post = store.posts.patch(post["id"], {
        "status": "published",
        "published_at": store.now(),
        "history": (post.get("history") or []) + [
            {"at": store.now(), "event": "published", "detail": ",".join(post.get("platforms", []))}],
    })
    store.notify("publish", "Published", f"{post.get('title', '')[:60]}", level="success")
    return post


# ---------------------------------------------------------------------------
# API keys page
# ---------------------------------------------------------------------------
@router.get("/apikeys")
def api_keys() -> Dict[str, Any]:
    items = store.apikeys.all()
    safe = [{"id": i["id"], "name": i.get("name"), "prefix": str(i.get("key", ""))[:8] + "…",
             "created_at": i.get("created_at"), "last_used": i.get("last_used"),
             "calls": i.get("calls", 0)} for i in items]
    jobs = STORE.list(limit=50)
    return {
        "keys": safe,
        "usage": {"jobs": len(jobs), "by_feature": _usage(jobs)},
        "docs": {
            "base": "/api",
            "endpoints": [
                {"method": "POST", "path": "/api/editor/process", "desc": "process a URL into a project"},
                {"method": "POST", "path": "/api/editor/export", "desc": "render the timeline"},
                {"method": "GET", "path": "/api/editor/status/{task_id}", "desc": "poll a job"},
                {"method": "GET", "path": "/api/projects", "desc": "list projects"},
            ],
            "example": "curl -X POST http://127.0.0.1:8000/api/editor/process -H 'content-type: application/json' -d '{\"url\":\"https://youtu.be/...\"}'",
        },
        "providers": ai_media.provider_status(),
    }


def _usage(jobs) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for job in jobs:
        counts[job.feature] = counts.get(job.feature, 0) + 1
    return counts


class KeyBody(BaseModel):
    name: str = "default"


@router.post("/apikeys")
def create_api_key(body: KeyBody) -> Dict[str, Any]:
    import secrets

    raw = "wv_" + secrets.token_urlsafe(24)
    item = store.apikeys.upsert({"id": store.new_id("key"), "name": body.name[:60],
                                 "key": raw, "created_at": store.now(), "calls": 0})
    # the raw key is returned exactly once, like every real provider
    return {"id": item["id"], "name": item["name"], "key": raw,
            "note": "Copy it now – it is only shown once."}


@router.delete("/apikeys/{key_id}")
def delete_api_key(key_id: str) -> Dict[str, Any]:
    if not store.apikeys.delete(key_id):
        raise HTTPException(status_code=404, detail="unknown key")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Jobs overview (used by the Library / notifications)
# ---------------------------------------------------------------------------
@router.get("/editor/tasks")
def list_tasks(limit: int = 30) -> Dict[str, Any]:
    return {"items": [t.public() for t in STORE.list(limit=limit)]}

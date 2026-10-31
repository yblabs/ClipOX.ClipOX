"""Small JSON-backed collections for the AI Video Editor app.

Everything the app has to remember between requests lives in one JSON file per
collection under ``work/data/``:

    projects.json      project index (the heavy project documents are one file
                       each under ``work/projects/<id>.json``)
    assets.json        uploads / generated media library
    templates.json     "My Template" entries
    brandkit.json      logos, colours, fonts, styles, media
    posts.json         publish + schedule records
    notifications.json activity feed
    apikeys.json       API keys (hashed) + usage counters
    credits.json       credit balance + ledger per account

Windows/macOS single-user scope: a process-wide lock around read/modify/write is
enough. Swapping this for Postgres later only means re-implementing ``Collection``.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .config import WORK_DIR

DATA_DIR = Path(os.getenv("WV_DATA_DIR", str(WORK_DIR / "data")))
PROJECT_DIR = DATA_DIR / "projects"
CLIP_DIR = DATA_DIR / "clipvideos"

for _p in (DATA_DIR, PROJECT_DIR, CLIP_DIR):
    _p.mkdir(parents=True, exist_ok=True)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def now() -> float:
    return time.time()


class _Locks:
    """One lock per collection file (creating them is not thread safe either)."""

    _guard = threading.Lock()
    _locks: Dict[str, threading.RLock] = {}

    @classmethod
    def get(cls, name: str) -> threading.RLock:
        with cls._guard:
            if name not in cls._locks:
                cls._locks[name] = threading.RLock()
            return cls._locks[name]


class Collection:
    """A list of dicts persisted as ``{"items": [...]}``."""

    def __init__(self, name: str):
        self.name = name
        self.path = DATA_DIR / f"{name}.json"
        self.lock = _Locks.get(name)

    # -- raw io ----------------------------------------------------------
    def _load(self) -> List[Dict[str, Any]]:
        if not self.path.is_file():
            return []
        try:
            data = json.loads(self.path.read_text("utf-8"))
        except Exception:
            return []
        if isinstance(data, dict):
            return list(data.get("items") or [])
        return list(data or [])

    def _save(self, items: List[Dict[str, Any]]) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"items": items}, ensure_ascii=False, indent=2), "utf-8")
        tmp.replace(self.path)

    # -- api -------------------------------------------------------------
    def all(self) -> List[Dict[str, Any]]:
        with self.lock:
            return self._load()

    def get(self, item_id: str) -> Optional[Dict[str, Any]]:
        for item in self.all():
            if str(item.get("id")) == str(item_id):
                return item
        return None

    def upsert(self, item: Dict[str, Any]) -> Dict[str, Any]:
        """Insert or replace by ``id`` (a new id is minted when missing)."""
        with self.lock:
            items = self._load()
            if not item.get("id"):
                item["id"] = new_id(self.name.rstrip("s") or "item")
            item.setdefault("created_at", now())
            item["updated_at"] = now()
            for i, existing in enumerate(items):
                if str(existing.get("id")) == str(item["id"]):
                    items[i] = item
                    break
            else:
                items.append(item)
            self._save(items)
            return item

    def patch(self, item_id: str, changes: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        with self.lock:
            items = self._load()
            for item in items:
                if str(item.get("id")) == str(item_id):
                    item.update(changes)
                    item["updated_at"] = now()
                    self._save(items)
                    return item
            return None

    def delete(self, item_id: str) -> bool:
        with self.lock:
            items = self._load()
            keep = [i for i in items if str(i.get("id")) != str(item_id)]
            if len(keep) == len(items):
                return False
            self._save(keep)
            return True

    def mutate(self, fn: Callable[[List[Dict[str, Any]]], Any]) -> Any:
        """Read-modify-write under the collection lock (for counters)."""
        with self.lock:
            items = self._load()
            result = fn(items)
            self._save(items)
            return result


# ---------------------------------------------------------------------------
# Collections used across the app
# ---------------------------------------------------------------------------
projects_index = Collection("projects")
assets = Collection("assets")
templates = Collection("templates")
brandkit = Collection("brandkit")
posts = Collection("posts")
notifications = Collection("notifications")
apikeys = Collection("apikeys")
clipvideos = Collection("clipvideos")      # AI clipping: one row per source video
accounts = Collection("accounts")          # connected publish accounts


# ---------------------------------------------------------------------------
# Project documents (one file each – a timeline can be large)
# ---------------------------------------------------------------------------
def project_path(project_id: str) -> Path:
    return PROJECT_DIR / f"{project_id}.json"


def read_project(project_id: str) -> Optional[Dict[str, Any]]:
    path = project_path(project_id)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text("utf-8"))
    except Exception:
        return None


def write_project(project: Dict[str, Any]) -> Dict[str, Any]:
    project_id = str(project["id"])
    project["updated_at"] = now()
    path = project_path(project_id)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(project, ensure_ascii=False), "utf-8")
    tmp.replace(path)
    # keep a light index for the Library page
    light = {
        "id": project_id,
        "name": project.get("name", "Untitled"),
        "aspect": project.get("aspect", "9:16"),
        "duration": project.get("duration", 0),
        "thumb": (project.get("source") or {}).get("media", ""),
        "poster": project.get("poster", ""),
        "updated_at": project["updated_at"],
        "created_at": project.get("created_at"),
        "exports": len(project.get("exports") or []),
        "status": project.get("status", "in_progress"),
    }
    projects_index.upsert(light)
    return project


def delete_project(project_id: str) -> bool:
    project_path(project_id).unlink(missing_ok=True)
    return projects_index.delete(project_id)


# ---------------------------------------------------------------------------
# AI clipping documents (video + moments + transcript side files)
# ---------------------------------------------------------------------------
def clip_path(video_id: str) -> Path:
    return CLIP_DIR / f"{video_id}.json"


def clip_transcript_path(video_id: str) -> Path:
    return CLIP_DIR / f"{video_id}.transcript.json"


def read_clip(video_id: str) -> Optional[Dict[str, Any]]:
    path = clip_path(video_id)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text("utf-8"))
    except Exception:
        return None


def write_clip(doc: Dict[str, Any]) -> Dict[str, Any]:
    video_id = str(doc["id"])
    doc["updated_at"] = now()
    path = clip_path(video_id)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False), "utf-8")
    tmp.replace(path)
    light = {
        "id": video_id,
        "title": doc.get("title", "Untitled video"),
        "thumb": doc.get("thumbnail") or doc.get("poster") or "",
        "duration": doc.get("duration", 0),
        "platform": doc.get("platform", ""),
        "source_type": doc.get("source_type", "url"),
        "moment_count": len(doc.get("moments") or []),
        "language": doc.get("language", ""),
        "created_at": doc.get("created_at"),
        "updated_at": doc["updated_at"],
    }
    clipvideos.upsert(light)
    return doc


def read_clip_transcript(video_id: str) -> Optional[Dict[str, Any]]:
    path = clip_transcript_path(video_id)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text("utf-8"))
    except Exception:
        return None


def write_clip_transcript(video_id: str, transcript: Dict[str, Any]) -> None:
    path = clip_transcript_path(video_id)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(transcript, ensure_ascii=False), "utf-8")
    tmp.replace(path)


def delete_clip(video_id: str) -> bool:
    clip_path(video_id).unlink(missing_ok=True)
    clip_transcript_path(video_id).unlink(missing_ok=True)
    return clipvideos.delete(video_id)


def notify(kind: str, title: str, body: str = "", *, link: str = "", level: str = "info") -> Dict[str, Any]:
    """Push an entry onto the notification bell feed."""
    return notifications.upsert({
        "id": new_id("note"),
        "kind": kind,
        "title": title,
        "body": body,
        "link": link,
        "level": level,
        "read": False,
        "at": now(),
    })

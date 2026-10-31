"""Stock media search + download (Elements panel, stock B-roll, audio search).

Two providers, chosen by whichever key is configured:

* ``Pexels``  – videos and photos, ``WV_PEXELS_KEY``
* ``Pixabay`` – videos, photos and music, ``WV_PIXABAY_KEY``

Both are called server-side so the key never reaches the browser. When neither
key is set the endpoints raise :class:`StockNotConfigured`, which the UI turns
into a "add a key in API settings" card instead of a dead button.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from ..config import MEDIA_DIR

PEXELS_KEY = os.getenv("WV_PEXELS_KEY", "")
PIXABAY_KEY = os.getenv("WV_PIXABAY_KEY", "")


class StockNotConfigured(RuntimeError):
    """No stock provider key is present."""

    def __init__(self) -> None:
        super().__init__(
            "No stock library configured. Set WV_PEXELS_KEY (pexels.com/api) or "
            "WV_PIXABAY_KEY (pixabay.com/api/docs) in the backend environment."
        )


def configured() -> bool:
    return bool(PEXELS_KEY or PIXABAY_KEY)


def provider() -> str:
    if PEXELS_KEY:
        return "pexels"
    if PIXABAY_KEY:
        return "pixabay"
    return "none"


def _client() -> httpx.Client:
    return httpx.Client(timeout=40.0, follow_redirects=True)


def search(kind: str, query: str, *, per_page: int = 18) -> List[Dict[str, Any]]:
    """``kind`` is ``videos`` | ``photos`` | ``audio``."""
    if not configured():
        raise StockNotConfigured()
    kind = {"video": "videos", "image": "photos", "music": "audio"}.get(kind, kind)
    if provider() == "pexels":
        return _pexels(kind, query, per_page)
    return _pixabay(kind, query, per_page)


def _pexels(kind: str, query: str, per_page: int) -> List[Dict[str, Any]]:
    if kind == "audio":
        raise StockNotConfigured  # Pexels has no audio library
    url = f"https://api.pexels.com/v1/{'videos/search' if kind == 'videos' else 'search'}"
    with _client() as client:
        resp = client.get(url, params={"query": query or "abstract", "per_page": per_page},
                          headers={"Authorization": PEXELS_KEY})
    if resp.status_code >= 400:
        raise RuntimeError(f"Pexels {resp.status_code}: {resp.text[:200]}")
    data = resp.json()
    out: List[Dict[str, Any]] = []
    for item in data.get("videos", []) if kind == "videos" else data.get("photos", []):
        if kind == "videos":
            files = sorted(item.get("video_files") or [], key=lambda f: (f.get("height") or 0))
            best = next((f for f in files if (f.get("height") or 0) >= 720), files[-1] if files else None)
            if not best:
                continue
            out.append({
                "id": f"pexels-{item.get('id')}", "kind": "video", "provider": "pexels",
                "title": (item.get("user", {}) or {}).get("name", "Pexels video"),
                "thumb": item.get("image", ""), "url": best.get("link"),
                "duration": round(float(item.get("duration") or 0), 2),
                "width": best.get("width"), "height": best.get("height"),
                "author": (item.get("user", {}) or {}).get("name", ""),
                "source_url": item.get("url", ""),
            })
        else:
            src = (item.get("src") or {})
            out.append({
                "id": f"pexels-{item.get('id')}", "kind": "photo", "provider": "pexels",
                "title": item.get("alt") or "Pexels photo",
                "thumb": src.get("medium", ""), "url": src.get("large2x") or src.get("original"),
                "duration": 0, "width": item.get("width"), "height": item.get("height"),
                "author": item.get("photographer", ""), "source_url": item.get("url", ""),
            })
    return out


def _pixabay(kind: str, query: str, per_page: int) -> List[Dict[str, Any]]:
    endpoint = {"videos": "videos", "photos": "images", "audio": "music"}.get(kind, "videos")
    if endpoint == "music":
        # Pixabay has no public music search API – photos/videos only.
        raise StockNotConfigured()
    params = {"key": PIXABAY_KEY, "q": query or "abstract", "per_page": min(50, per_page), "safesearch": "true"}
    with _client() as client:
        resp = client.get(f"https://pixabay.com/api/{endpoint}/", params=params)
    if resp.status_code >= 400:
        raise RuntimeError(f"Pixabay {resp.status_code}: {resp.text[:200]}")
    hits = (resp.json() or {}).get("hits", [])
    out: List[Dict[str, Any]] = []
    for item in hits:
        if endpoint == "videos":
            variants = item.get("videos") or {}
            best = variants.get("medium") or variants.get("small") or variants.get("large")
            if not best:
                continue
            out.append({
                "id": f"pixabay-{item.get('id')}", "kind": "video", "provider": "pixabay",
                "title": item.get("tags", "Pixabay video"),
                "thumb": (item.get("videos", {}).get("tiny", {}) or {}).get("thumbnail") or item.get("previewURL", ""),
                "url": best.get("url"), "duration": int(item.get("duration") or 0),
                "width": best.get("width"), "height": best.get("height"),
                "author": item.get("user", ""), "source_url": item.get("pageURL", ""),
            })
        else:
            out.append({
                "id": f"pixabay-{item.get('id')}", "kind": "photo", "provider": "pixabay",
                "title": item.get("tags", "Pixabay photo"), "thumb": item.get("previewURL", ""),
                "url": item.get("largeImageURL") or item.get("webformatURL"),
                "duration": 0, "width": item.get("imageWidth"), "height": item.get("imageHeight"),
                "author": item.get("user", ""), "source_url": item.get("pageURL", ""),
            })
    return out


def download(url: str, *, prefix: str = "stock") -> Dict[str, Any]:
    """Fetch a stock file into the media library and return library metadata."""
    if not url:
        raise RuntimeError("no url supplied")
    suffix = Path(url.split("?")[0]).suffix or ".mp4"
    out_dir = Path(MEDIA_DIR) / "stock"
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"{prefix}_{int(time.time() * 1000)}{suffix}"
    with _client() as client:
        with client.stream("GET", url) as resp:
            if resp.status_code >= 400:
                raise RuntimeError(f"download failed ({resp.status_code}) for {url[:120]}")
            with open(target, "wb") as fh:
                for chunk in resp.iter_bytes(1024 * 256):
                    fh.write(chunk)
    if target.stat().st_size == 0:
        target.unlink(missing_ok=True)
        raise RuntimeError("downloaded file is empty")
    from ..config import MEDIA_MOUNT

    return {
        "path": str(target),
        "media": f"/{MEDIA_MOUNT}/stock/{target.name}",
        "size_bytes": target.stat().st_size,
    }


def attribution() -> Dict[str, Any]:
    return {
        "provider": provider(),
        "configured": configured(),
        "keys": {"WV_PEXELS_KEY": bool(PEXELS_KEY), "WV_PIXABAY_KEY": bool(PIXABAY_KEY)},
        "licence": "Pexels / Pixabay licence – free to use, attribution appreciated.",
    }

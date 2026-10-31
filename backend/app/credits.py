"""Credits: the ledger every AI action spends from.

The UI always asks for the balance before it runs something and shows the price
(``GET /api/credits`` returns both), spends after success, and blocks with an
upgrade prompt when the balance is too low (HTTP 402 + ``upgrade: true``).

Free actions cost 0 and are listed anyway so the diamond icon in the UI is
driven by the same table the server charges from.

UNLIMITED_CREDITS (config.py, ``UNLIMITED_CREDITS`` env var) is the one switch
for the whole product: while it is on, :func:`spend` and :func:`refund` return
without touching the ledger, no balance check can fail, and every API payload
carries ``"unlimited": true`` so the UI can show the ∞ badge. Set the variable
to ``false`` to turn billing back on — the ledger, costs and 402 path are all
untouched underneath.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from .config import UNLIMITED_CREDITS, WORK_DIR

DATA_FILE = Path(WORK_DIR) / "data" / "credits.json"
DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
_LOCK = threading.RLock()

# ---------------------------------------------------------------------------
# Price list — one entry per action the product exposes.
# ---------------------------------------------------------------------------
COSTS: Dict[str, Dict[str, Any]] = {
    # --- processing (Part B) ---
    "process_video":      {"label": "Process video (download + transcribe)", "cost": 5, "free": False},
    "transcribe":         {"label": "Transcribe", "cost": 3, "free": False},
    # --- sound (Part E) ---
    "enhance_speech":     {"label": "Enhance Speech", "cost": 2, "free": True},
    "remove_filler":      {"label": "Remove Filler Words", "cost": 1, "free": True},
    "remove_silence":     {"label": "Remove Silences", "cost": 1, "free": True},
    # --- look (Part E) ---
    "reframe":            {"label": "One Click Reframe", "cost": 4, "free": False},
    "auto_transitions":   {"label": "Auto Transitions", "cost": 2, "free": True},
    "ai_emojis":          {"label": "AI Emojis", "cost": 1, "free": True},
    "speaker_labels":     {"label": "Speaker Labels", "cost": 2, "free": False},
    # --- generate media ---
    "ai_video":           {"label": "AI Video", "cost": 40, "free": False},
    "ai_music":           {"label": "AI Music", "cost": 20, "free": False},
    "ai_sfx":             {"label": "AI Sound Effect", "cost": 10, "free": False},
    # --- publish ---
    "thumbnail":          {"label": "Generate Thumbnail", "cost": 3, "free": True},
    "title":              {"label": "Generate Title", "cost": 1, "free": True},
    "description":        {"label": "Generate Description", "cost": 2, "free": True},
    "translate":          {"label": "Translate", "cost": 6, "free": False},
    "hook":               {"label": "Generate Hook", "cost": 3, "free": False},
    "broll_ai":           {"label": "AI B-roll", "cost": 25, "free": False},
    "broll_stock":        {"label": "Stock B-roll", "cost": 2, "free": True},
    "stock_search":       {"label": "Stock search", "cost": 0, "free": True},
    "export":             {"label": "Export", "cost": 1, "free": True},
    "publish":            {"label": "Publish", "cost": 0, "free": True},
    # --- AI clipping (clip-maker page) ---
    "ai_clipping":        {"label": "AI Clipping (per video minute)", "cost": 1, "free": False},
    "clip_regenerate":    {"label": "Regenerate one moment", "cost": 2, "free": False},
    "montage":            {"label": "Create montage", "cost": 4, "free": False},
}

STARTER_CREDITS = 600          # a fresh install can run a few full jobs
PLANS: List[Dict[str, Any]] = [
    {"id": "free", "name": "Free", "price": 0, "credits": 600, "period": "month",
     "features": ["600 credits / month", "1080p export", "Watermark on export"], "current": True},
    {"id": "creator", "name": "Creator", "price": 19, "credits": 3000, "period": "month",
     "features": ["3,000 credits / month", "4K export", "No watermark", "Brand Kit", "Scheduler"]},
    {"id": "pro", "name": "Pro", "price": 49, "credits": 12000, "period": "month",
     "features": ["12,000 credits / month", "AI Video generation", "Team brand kits", "Priority queue"]},
]


def _load() -> Dict[str, Any]:
    if not DATA_FILE.is_file():
        return {}
    try:
        return json.loads(DATA_FILE.read_text("utf-8"))
    except Exception:
        return {}


def _save(data: Dict[str, Any]) -> None:
    tmp = DATA_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), "utf-8")
    tmp.replace(DATA_FILE)


def _account(data: Dict[str, Any], user: str = "local") -> Dict[str, Any]:
    acct = data.get(user)
    if not acct:
        acct = {"balance": STARTER_CREDITS, "plan": "free", "spent": 0, "ledger": []}
        data[user] = acct
    acct.setdefault("ledger", [])
    return acct


def account(user: str = "local") -> Dict[str, Any]:
    with _LOCK:
        data = _load()
        acct = _account(data, user)
        _save(data)
        return dict(acct)


def balance(user: str = "local") -> int:
    return int(account(user).get("balance", 0))


def cost_of(action: str) -> int:
    return int(COSTS.get(action, {}).get("cost", 0))


def price_list() -> Dict[str, Any]:
    return {
        "costs": {k: v for k, v in COSTS.items()},
        "plans": PLANS,
        "upgrade_url": "/editor.html#pricing",
        "unlimited": UNLIMITED_CREDITS,
    }


class InsufficientCredits(RuntimeError):
    """Raised when an action costs more than the account can pay."""

    def __init__(self, action: str, required: int, available: int):
        self.action = action
        self.required = required
        self.available = available
        super().__init__(
            f"Not enough credits: '{action}' costs {required}, you have {available}. "
            "Upgrade your plan to continue."
        )


def spend(action: str, *, user: str = "local", units: int = 1, note: str = "") -> int:
    """Charge *action* and return the new balance. Raises if too expensive.

    With ``UNLIMITED_CREDITS`` on this returns the current balance immediately:
    nothing is deducted and :class:`InsufficientCredits` can never be raised, so
    no route can answer 402.
    """
    amount = cost_of(action) * max(1, units)
    with _LOCK:
        data = _load()
        acct = _account(data, user)
        if UNLIMITED_CREDITS:
            return int(acct.get("balance", 0))     # bypass: never charge, never raise
        if amount > int(acct.get("balance", 0)):
            raise InsufficientCredits(action, amount, int(acct.get("balance", 0)))
        acct["balance"] = int(acct["balance"]) - amount
        acct["spent"] = int(acct.get("spent", 0)) + amount
        acct["ledger"].insert(0, {"action": action, "amount": amount, "at": __import__("time").time(),
                                  "note": note, "balance": acct["balance"]})
        del acct["ledger"][200:]
        _save(data)
        return int(acct["balance"])


def refund(action: str, *, user: str = "local", units: int = 1, note: str = "failed") -> int:
    amount = cost_of(action) * max(1, units)
    with _LOCK:
        data = _load()
        acct = _account(data, user)
        if UNLIMITED_CREDITS:
            return int(acct.get("balance", 0))     # nothing was charged, so nothing to restore
        acct["balance"] = int(acct["balance"]) + amount
        acct["spent"] = max(0, int(acct.get("spent", 0)) - amount)
        acct["ledger"].insert(0, {"action": f"refund:{action}", "amount": -amount,
                                  "at": __import__("time").time(), "note": note,
                                  "balance": acct["balance"]})
        del acct["ledger"][200:]
        _save(data)
        return int(acct["balance"])


def grant(amount: int, *, user: str = "local", note: str = "reward") -> int:
    with _LOCK:
        data = _load()
        acct = _account(data, user)
        acct["balance"] = int(acct["balance"]) + int(amount)
        acct["ledger"].insert(0, {"action": "grant", "amount": int(amount),
                                  "at": __import__("time").time(), "note": note,
                                  "balance": acct["balance"]})
        del acct["ledger"][200:]
        _save(data)
        return int(acct["balance"])


def set_plan(plan_id: str, *, user: str = "local") -> Dict[str, Any]:
    plan = next((p for p in PLANS if p["id"] == plan_id), None)
    if plan is None:
        raise ValueError(f"unknown plan {plan_id}")
    with _LOCK:
        data = _load()
        acct = _account(data, user)
        acct["plan"] = plan_id
        acct["balance"] = int(acct["balance"]) + int(plan["credits"])
        acct["ledger"].insert(0, {"action": f"plan:{plan_id}", "amount": int(plan["credits"]),
                                  "at": __import__("time").time(), "note": "plan activated",
                                  "balance": acct["balance"]})
        _save(data)
        return dict(acct)


def summary(user: str = "local") -> Dict[str, Any]:
    acct = account(user)
    plan = next((p for p in PLANS if p["id"] == acct.get("plan")), PLANS[0])
    used = int(acct.get("spent", 0))
    return {
        "balance": acct.get("balance", 0),
        "plan": plan["id"],
        "plan_name": plan["name"],
        "plan_credits": plan["credits"],
        "spent": used,
        "used_percent": round(min(100.0, used / max(1, plan["credits"]) * 100), 1),
        "ledger": (acct.get("ledger") or [])[:40],
        "costs": COSTS,
        "upgrade_url": "/editor.html#pricing",
        "unlimited": UNLIMITED_CREDITS,
    }

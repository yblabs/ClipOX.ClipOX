"""End-to-end API smoke test for the AI Video Editor app (scratch, delete later)."""
import json
import time

import httpx

B = "http://127.0.0.1:8000"
c = httpx.Client(timeout=600.0)


def jp(path, body=None):
    r = c.post(B + path, json=body or {})
    if r.status_code >= 400:
        print("FAIL", path, r.status_code, r.text[:400])
        raise SystemExit(1)
    return r.json()


def wait(task_id, label="task"):
    while True:
        st = c.get(f"{B}/api/editor/status/{task_id}").json()
        if st["status"] in ("done", "error", "cancelled"):
            print(f"[{label}] {st['status']} {st['progress']}% {st['stage']}")
            if st["status"] == "error":
                print("   error:", st["error"])
                raise SystemExit(1)
            return st
        time.sleep(2)


print("== meta ==")
meta = c.get(f"{B}/api/editor/meta").json()
print("tool rail:", len(meta["tool_rail"]), "layouts:", len(meta["layouts"]),
      "effects:", len(meta["effects"]), "credits:", meta["credits"]["balance"],
      "face tracking:", meta["features"]["face_tracking"])

print("== process local file ==")
started = jp("/api/editor/process", {"path": "/tmp/wv_talk.mp4", "name": "Smoke test",
                                     "aspect": "9:16", "layout": "fit"})
st = wait(started["task_id"], "process")
project = st["result"]["project"]
pid = project["id"]
print("project", pid, "| clips:", len(project["clips"]),
      "| lines:", len(project["subtitles"]["lines"]),
      "| thumbs:", len(project.get("thumbs") or []),
      "| waveform:", len(project.get("waveform") or []),
      "| lang:", project["transcript"]["language"])
print("first line:", project["subtitles"]["lines"][0]["text"] if project["subtitles"]["lines"] else "-")

print("== autosave (rename + caption preset) ==")
project["name"] = "Smoke test renamed"
project["subtitles"]["preset"] = "karaoke"
r = c.patch(f"{B}/api/projects/{pid}", json=project)
print("autosave ->", r.json())

print("== tools: fillers ==")
fill = jp("/api/editor/tools/fillers", {"project_id": pid})
print("fillers:", [(w["word"], w["count"]) for w in fill["words"]][:6], "total", fill["total"])

print("== tools: silences ==")
sil = jp("/api/editor/tools/silences", {"project_id": pid, "threshold_db": -35, "min_duration": 0.35})
print("silences:", len(sil["silences"]), "removed", sil["removed_seconds"], "s")

print("== tools: enhance (A/B) ==")
enh = jp("/api/editor/tools/enhance", {"project_id": pid, "enabled": True, "start": 2, "duration": 4})
print("before/after:", enh["before"], enh["after"])

print("== tools: emojis + speakers ==")
print(jp("/api/editor/tools/emojis", {"project_id": pid, "enabled": True}))
print(jp("/api/editor/tools/speakers", {"project_id": pid, "enabled": True})["speakers"])

print("== tools: reframe 9:16 ==")
ref = jp("/api/editor/tools/reframe", {"project_id": pid, "ratio": "9:16", "layout": "auto"})
print("scenes:", [(s["layout"], s["reason"][:40]) for s in ref["plan"]["scenes"]][:4])
print("clips now:", len(ref["clips"]))

print("== tools: hook / titles / description ==")
hook = jp("/api/editor/tools/hook", {"project_id": pid, "platform": "tiktok"})
print("hooks:", hook["count"], "best:", hook["best"]["hook"], "| source:", hook["source"])
added = jp("/api/editor/tools/hook/add", {"project_id": pid, "text": hook["best"]["hook"],
                                          "duration": 3.5, "teaser": False})
print("hook placed at", added["hook"]["start"], "-", added["hook"]["end"])
print("titles:", [t["text"][:40] for t in jp("/api/editor/tools/titles", {"project_id": pid})["titles"]][:3])
print("desc tags:", jp("/api/editor/tools/description", {"project_id": pid})["hashtags"][:6])

print("== generate media (local fallbacks) ==")
music = jp("/api/editor/generate/music", {"project_id": pid, "prompt": "lofi bed", "mood": "lofi",
                                          "duration": 8, "start": 1})
print("music:", music["provider"], music["media"])
sfx = jp("/api/editor/generate/sfx", {"project_id": pid, "prompt": "whoosh", "at": 5})
print("sfx:", sfx["provider"], sfx["media"])
vid = c.post(f"{B}/api/editor/generate/video", json={"prompt": "a drone shot", "duration": 4})
print("ai video ->", vid.status_code, json.dumps(vid.json())[:180])

print("== stock ==")
stk = c.get(f"{B}/api/stock/search", params={"kind": "videos", "q": "city"}).json()
print("stock configured:", stk["configured"], "|", (stk.get("message") or "")[:80])

print("== thumbnail ==")
th = jp("/api/editor/tools/thumbnail", {"project_id": pid, "title": "Edit video like text", "count": 2})
print("thumbs:", [(t["style"], t["media"]) for t in th["thumbnails"]][:3])

print("== transition + effect on the timeline ==")
proj = c.get(f"{B}/api/projects/{pid}").json()
for i, clip in enumerate(proj["clips"][:3]):
    clip["transition"] = {"type": ["fade", "glitch", "wipe"][i % 3], "duration": 0.4}
    if i == 0:
        clip["effects"] = [{"id": "e1", "type": "zoom_in", "intensity": 0.5,
                            "start": clip["start"], "end": clip["end"]}]
    if i == 1:
        clip["effects"] = [{"id": "e2", "type": "vhs", "intensity": 0.6,
                            "start": clip["start"], "end": clip["end"]}]
proj["aspect"] = "9:16"
c.patch(f"{B}/api/projects/{pid}", json=proj)

print("== export 720p ==")
exp = jp("/api/editor/export", {"project_id": pid, "resolution": "720p", "fps": 30,
                                "quality": "balanced", "burn_subtitles": True, "watermark": True})
st = wait(exp["task_id"], "export")
print("export:", {k: st["result"][k] for k in ("url", "duration", "width", "height", "size_bytes",
                                               "elapsed_sec", "clips")})

print("== publish + schedule ==")
accts = c.get(f"{B}/api/publish/accounts").json()
print("platforms configured:", [(p["key"], p["configured"]) for p in accts["platforms"]])
sched = jp("/api/publish/schedule", {"project_id": pid, "platforms": ["youtube"],
                                     "title": "Smoke", "description": "d",
                                     "hashtags": ["#shorts"], "when": time.time() + 7200,
                                     "export_url": st["result"]["url"]})
print("scheduled:", sched["id"], sched["status"])
now = c.post(f"{B}/api/publish/now", json={"post_id": sched["id"]})
print("publish now ->", now.status_code, json.dumps(now.json())[:160])
resched = c.patch(f"{B}/api/schedule/{sched['id']}", json={"when": time.time() + 300})
print("reschedule ->", resched.json()["status"])

print("== credits / rewards / library ==")
print("credits:", c.get(f"{B}/api/credits").json()["balance"])
print("rewards:", [t["id"] for t in c.get(f"{B}/api/rewards").json()["tasks"]])
print("claim:", jp("/api/rewards/claim", {"id": "first_export"})["balance"])
print("projects:", [(p["name"], p["exports"]) for p in c.get(f"{B}/api/projects").json()["items"]])
print("assets:", c.get(f"{B}/api/assets").json()["count"])
print("templates:", len(c.get(f"{B}/api/templates").json()["builtin"]))
print("apikey:", jp("/api/apikeys", {"name": "smoke"})["key"][:12] + "…")
print("notifications:", [n["title"] for n in c.get(f"{B}/api/notifications").json()["items"]][:4])
print("\nPROJECT_ID", pid)

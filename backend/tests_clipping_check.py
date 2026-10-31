"""End-to-end check of the AI clipping API (Part 1-7 of the spec)."""
import json
import os
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8000"
PASS, FAIL = [], []


def call(method, path, body=None, raw=None):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if raw is not None:
        data = raw
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            payload = r.read()
            try:
                return r.status, json.loads(payload)
            except Exception:
                return r.status, payload
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return e.code, json.loads(payload)
        except Exception:
            return e.code, payload.decode("utf-8", "replace")[:300]


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(("PASS " if ok else "FAIL ") + name + ((" — " + str(detail)[:220]) if detail else ""), flush=True)


def wait(task_id, timeout=600):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        _, d = call("GET", f"/api/ai-clipping/jobs/{task_id}")
        line = (d.get("status"), d.get("progress"), d.get("stage"))
        if line != last:
            print("   ", line, flush=True)
            last = line
        if d.get("status") in ("done", "error", "cancelled"):
            return d
        time.sleep(2)
    raise TimeoutError(task_id)


# ---------------------------------------------------------------- options
st, opt = call("GET", "/api/ai-clipping/options")
check("options endpoint", st == 200 and opt.get("clip_lengths") and opt.get("languages"),
      f"{len(opt.get('languages', []))} languages, {len(opt.get('layouts', []))} layouts")
print("   chunk size", opt["upload"]["chunk_size"], "max MB", opt["upload"]["max_mb"])

# ------------------------------------------------- link validation errors
st, d = call("POST", "/api/ai-clipping/inspect", {"url": "not-a-link"})
check("inspect rejects junk", st == 400, d.get("detail") if isinstance(d, dict) else d)
st, d = call("POST", "/api/ai-clipping/inspect", {"url": "https://example.com/some/page"})
check("inspect rejects unsupported host", st == 400, d.get("detail") if isinstance(d, dict) else d)

# ---------------------------------------------- chunked resumable upload
src = os.environ.get("WV_CLIP_TEST_VIDEO", "/tmp/clip_test.mp4")
blob = open(src, "rb").read()
CHUNK = 4 * 1024 * 1024
st, init = call("POST", "/api/ai-clipping/upload/init",
                {"filename": "podcast episode.mp4", "size": len(blob)})
up = init["upload_id"]
check("upload init", st == 200 and init["chunk_size"] == CHUNK, init)

first = blob[:CHUNK]
st, d = call("PUT", f"/api/ai-clipping/upload/{up}/chunk?offset=0", raw=first)
check("upload chunk 1", st == 200 and d["received"] == len(first), d)

st, d = call("POST", f"/api/ai-clipping/upload/{up}/complete")
check("upload resume guard (incomplete)", st == 409, d)

st, d = call("GET", f"/api/ai-clipping/upload/{up}")
check("upload state returns resume offset", st == 200 and d["received"] == len(first), d)

# re-sending an already written chunk must rewind, not duplicate
st, d = call("PUT", f"/api/ai-clipping/upload/{up}/chunk?offset=0", raw=first)
check("replayed chunk rewinds", st == 200 and d["received"] == len(first), d)

rest = blob[CHUNK:]
st, d = call("PUT", f"/api/ai-clipping/upload/{up}/chunk?offset={len(first)}", raw=rest)
check("upload chunk 2", st == 200 and d["received"] == len(blob), d)

st, done = call("POST", f"/api/ai-clipping/upload/{up}/complete")
check("upload complete", st == 200 and done.get("source_type") == "upload",
      f"{done.get('duration')}s {done.get('width')}x{done.get('height')} thumb={bool(done.get('thumbnail'))}")
uploaded_path = done.get("source")

# ------------------------------------------------------------- estimation
st, est = call("POST", "/api/ai-clipping/estimate", {"duration": 600})
check("credit estimate", st == 200 and est["credits"] == 10, est)

# ----------------------------------------------------------------- job
st, job = call("POST", "/api/ai-clipping/jobs", {
    "source": src, "source_type": "upload",
    "meta": {"title": "Business myths podcast", "duration": 85.9},
    "settings": {"language": "en", "clip_length": "under30", "count": 3, "platform": "tiktok",
                 "instruction": "find the most surprising money lessons", "clip_kind": "hook",
                 "layout": "Fit",
                 "style": {"motion": "moving", "palette": "brand", "font": "Montserrat",
                           "size": "medium", "placement": "center"}},
})
check("job created (credits charged)", st == 200 and job["credits_charged"] == 5, job)
vid = job["video_id"]
final = wait(job["task_id"])
check("job completed", final["status"] == "done", final.get("error"))
result = final.get("result") or {}
check("job result", result.get("moments", 0) >= 1, result)

# -------------------------------------------------------------- results
st, doc = call("GET", f"/api/ai-clipping/videos/{vid}")
moments = doc["moments"]
check("video document", st == 200 and moments, f"{len(moments)} moments, selector={doc['selector']}")
scored = all(m["score"] > 0 and m["score_breakdown"] for m in moments)
check("every moment carries score + breakdown", scored)
no_overlap = all(
    min(a["end"], b["end"]) - max(a["start"], b["start"]) <= 2
    for i, a in enumerate(moments) for b in moments[i + 1:]
)
check("no overlapping clips", no_overlap)
ranked = [m["score"] for m in moments] == sorted([m["score"] for m in moments], reverse=True)
check("ranked by score", ranked, [m["score"] for m in moments])
lengths = [round(m["duration"], 1) for m in moments]
check("respects <30s clip length", all(m["duration"] <= 31 for m in moments), lengths)
hook_ok = all(m.get("hook_text") and m.get("why_it_works") for m in moments)
check("hooks + why-it-works written", hook_ok, [(m["hook_text"][:40], m["why_it_works"][:40]) for m in moments])
style_ok = all(m["hook_type"] for m in moments)
check("hook types assigned", style_ok, [m["hook_type"] for m in moments])
hook7 = all((m.get("hooks") or {}).get("hooks") and len(m["hooks"]["hooks"]) == 7 for m in moments)
check("hook mode writes 7 hooks per clip", hook7)
check("preview files rendered", all(m.get("preview_url") for m in moments),
      [m.get("preview_url") for m in moments][:1])

# preview must be playable over HTTP
if moments[0].get("preview_url"):
    st, _ = call("GET", moments[0]["preview_url"])
    check("preview downloads over HTTP", st == 200, moments[0]["preview_url"])

# --------------------------------------------------- moment actions
mid = moments[0]["id"]
st, d = call("PATCH", f"/api/ai-clipping/moments/{mid}?video_id={vid}",
             {"title": "Renamed by test", "layout": "Split"})
check("rename + change layout", st == 200 and d["moment"]["title"] == "Renamed by test",
      d["moment"].get("layout"))
st, d = call("PATCH", f"/api/ai-clipping/moments/{mid}?video_id={vid}",
             {"start": moments[0]["start"] + 1.0, "end": moments[0]["end"] + 2.0})
check("adjust start/end", st == 200 and d["moment"]["duration"] > 0, d["moment"]["duration"])
st, d = call("POST", f"/api/ai-clipping/moments/{mid}/hooks?video_id={vid}")
check("5 alternative hooks", st == 200 and len(d.get("hooks", [])) == 5,
      [h["pattern"] for h in d.get("hooks", [])])
st, d = call("POST", f"/api/ai-clipping/moments/{mid}/platform?video_id={vid}")
check("platform copy", st == 200 and d.get("titles"), list((d.get("titles") or {}).keys()))
st, d = call("POST", f"/api/ai-clipping/moments/{mid}/duplicate?video_id={vid}")
dup_id = d["moment"]["id"]
check("duplicate", st == 200 and dup_id != mid, dup_id)
st, d = call("POST", f"/api/ai-clipping/moments/{mid}/regenerate?video_id={vid}")
check("regenerate (or refund when weaker)",
      (st == 200 and d["moment"]["score"] > 0) or (st == 409 and "refunded" in str(d)),
      d.get("detail") if isinstance(d, dict) else d)
st, d = call("DELETE", f"/api/ai-clipping/moments/{dup_id}?video_id={vid}")
check("delete moment", st == 200, d)

# ------------------------------------------------------------ find moments
st, d = call("POST", "/api/ai-clipping/find", {"video_id": vid, "query": "selling templates for twelve dollars"})
check("find moments", st == 200 and d.get("added", 0) >= 1, f"added={d.get('added')} src={d.get('source')}")
st, d = call("POST", "/api/ai-clipping/find", {"video_id": vid, "query": ""})
check("find moments requires a query", st == 400, d if isinstance(d, str) else d.get("detail"))

# --------------------------------------------------------------- share
st, doc = call("GET", f"/api/ai-clipping/videos/{vid}")
st, d = call("POST", "/api/ai-clipping/share", {"video_id": vid, "moment_id": doc["moments"][0]["id"]})
check("share link", st == 200 and d.get("url"), d.get("url"))
if d.get("url"):
    st, _ = call("GET", d["url"])
    check("share link downloads", st == 200)

# --------------------------------------------------------------- export
st, exp = call("POST", "/api/ai-clipping/export", {
    "video_id": vid, "resolution": "720p",
    "moment_ids": [m["id"] for m in doc["moments"][:3]],
    "options": {"captions": True, "hook": True, "watermark": True},
    "zip": True,
})
check("export started", st == 200 and exp.get("task_id"), exp)
out = wait(exp["task_id"])
check("export finished", out["status"] == "done", out.get("error"))
record = out.get("result") or {}
check("export produced files", len(record.get("files", [])) >= 2, [f["file"] for f in record.get("files", [])])
check("export zip", bool(record.get("zip_url")), record.get("zip_url"))
if record.get("files"):
    st, _ = call("GET", record["files"][0]["url"])
    check("exported mp4 downloads", st == 200, record["files"][0]["url"])
if record.get("zip_url"):
    st, blob2 = call("GET", record["zip_url"])
    check("zip downloads", st == 200 and blob2[:2] == b"PK", record["zip_url"])

# -------------------------------------------------------------- montage
st, mon = call("POST", "/api/ai-clipping/montage", {
    "video_id": vid, "moment_ids": [m["id"] for m in doc["moments"][:2]],
    "resolution": "720p", "transition": "fade", "captions": True})
check("montage started", st == 200 and mon.get("task_id"), mon)
mout = wait(mon["task_id"])
check("montage finished", mout["status"] == "done", mout.get("error"))
mont = mout.get("result") or {}
check("montage url", bool(mont.get("url")), mont.get("url"))
if mont.get("url"):
    st, _ = call("GET", mont["url"])
    check("montage downloads", st == 200)

# ------------------------------------------------- schedule + publish
st, sched = call("POST", "/api/ai-clipping/schedule", {
    "video_id": vid, "moment_ids": [m["id"] for m in doc["moments"][:2]],
    "platforms": ["tiktok"], "start_at": time.time() + 3600, "spacing_minutes": 30})
check("schedule clips", st == 200 and sched.get("count") == 2, sched.get("count"))
post_id = (sched.get("items") or [{}])[0].get("id")
st, listing = call("GET", "/api/ai-clipping/schedule")
check("schedule listing", st == 200 and listing.get("count", 0) >= 2, listing.get("counts"))
st, d = call("PATCH", f"/api/ai-clipping/schedule/{post_id}", {"when": time.time() - 60})
check("reschedule (drag on calendar)", st == 200 and d.get("status") == "ready", d.get("status"))
st, d = call("POST", "/api/ai-clipping/publish", {"post_id": post_id})
check("publish without OAuth fails clearly", st == 503 and "Connect" in str(d.get("detail")), d.get("detail"))
st, d = call("DELETE", f"/api/ai-clipping/schedule/{post_id}")
check("delete scheduled post", st == 200, d)

# -------------------------------------------------------------- library
st, lib = call("GET", "/api/ai-clipping/videos")
check("library lists projects", st == 200 and any(v["id"] == vid for v in lib["items"]),
      [v["title"] for v in lib["items"]])
st, ex = call("GET", "/api/ai-clipping/exports")
check("exports library", st == 200 and ex["items"], len(ex["items"]))

# ------------------------------------------------ API keys + webhooks
st, hook = call("POST", "/api/ai-clipping/webhooks", {"url": "http://127.0.0.1:9/unreachable"})
check("webhook registration", st == 200 and hook.get("id"), hook.get("url"))
st, _ = call("POST", "/api/ai-clipping/webhooks", {"url": "ftp://bad"})
check("webhook URL validated", st == 400)
if isinstance(hook, dict) and hook.get("id"):
    st, _ = call("DELETE", f"/api/ai-clipping/webhooks/{hook['id']}")
    check("webhook deleted", st == 200)


st, key = call("POST", "/api/apikeys", {"name": "clipping-check"})


def call_key(path, value):
    req = urllib.request.Request(BASE + path, headers={"X-API-Key": value}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status
    except urllib.error.HTTPError as exc:
        return exc.code


check("API key rejected when invalid", call_key("/api/ai-clipping/videos", "nope") == 401)
check("API key accepted", call_key("/api/ai-clipping/videos", key["key"]) == 200)
st, _ = call("DELETE", f"/api/apikeys/{key['id']}")
check("API key removed", st == 200)

print("\n" + "=" * 60)
print(f"{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    print("FAILED:", FAIL)
print("video_id:", vid, "| uploaded path:", uploaded_path)

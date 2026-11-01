/* ==========================================================================
   WayinVideo AI Video Editor — app core
   Vanilla JS, no build step: state + undo/redo + autosave, the canvas preview
   compositor, the timeline, the shell/pages and the export/publish dialogs.
   Panel internals live in editor-panels.js and register through WVE.panel().
   ========================================================================== */
window.WVE = (function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;

  const fmt = {
    clock(sec) {
      sec = Math.max(0, Number(sec) || 0);
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
      return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s).padStart(2, '0');
    },
    clockMs(sec) {
      sec = Math.max(0, Number(sec) || 0);
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
      const ms = Math.floor((sec - Math.floor(sec)) * 100);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
    },
    bytes(n) {
      n = Number(n) || 0;
      const units = ['B', 'KB', 'MB', 'GB'];
      let i = 0;
      while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
      return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
    },
    when(ts) {
      if (!ts) return '';
      const d = new Date(ts * 1000);
      return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    },
  };

  /* ------------------------------------------------------------------ api */
  const API_CANDIDATES = ['', 'http://127.0.0.1:8000'];
  let API = '';

  async function raw(path, opts = {}) {
    const res = await fetch(API + path, opts);
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) {
      const detail = (data && data.detail) || {};
      const err = new Error(typeof detail === 'string' ? detail
        : (detail.message || `HTTP ${res.status}`));
      err.status = res.status;
      err.detail = detail;
      err.upgrade = res.status === 402 || !!detail.upgrade;
      err.configure = detail.configure;
      throw err;
    }
    return data;
  }
  const api = {
    get: (p) => raw(p),
    post(p, body) {
      if (body instanceof FormData) return raw(p, { method: 'POST', body });
      return raw(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    },
    patch: (p, body) => raw(p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }),
    del: (p) => raw(p, { method: 'DELETE' }),
  };

  async function detectApi() {
    for (const candidate of API_CANDIDATES) {
      try {
        const res = await fetch(candidate + '/api/health', { method: 'GET' });
        if (res.ok) { API = candidate; return true; }
      } catch (e) { /* try the next candidate */ }
    }
    return false;
  }

  /* ---------------------------------------------------------------- state */
  const S = {
    meta: null,
    project: null,
    page: 'start',
    tool: 'ai',
    selection: { clip: null, track: '', item: null },
    playhead: 0,
    playing: false,
    zoom: 1,
    pxPerSec: 60,
    snap: true,
    showSubs: true,
    quality: 'preview',
    history: [],
    future: [],
    dirty: false,
    saving: false,
    tasks: {},
    locks: {},
    hidden: {},
    muted: {},
    dirtySince: 0,
  };

  /* -------------------------------------------------------------- timeline */
  function clipSegments(project) {
    const clips = (project && project.clips) || [];
    const segs = [];
    let cursor = 0;
    clips.forEach((clip, index) => {
      const start = Number(clip.start) || 0;
      const end = Number(clip.end) || 0;
      if (end - start <= 0.05) return;
      const speed = clamp(Number(clip.speed) || 1, 0.25, 4);
      const dur = (end - start) / speed;
      let outStart = cursor;
      const key = ((clip.transition || {}).type || 'none');
      if (index > 0 && key && key !== 'none') {
        const overlap = clamp(Number((clip.transition || {}).duration) || 0.4, 0, Math.min(dur / 2, 2));
        outStart = cursor - overlap;
      }
      segs.push({ clipId: clip.id, clip, index, srcStart: start, srcEnd: end, speed,
                  outStart, outEnd: outStart + dur, duration: dur });
      cursor = outStart + dur;
    });
    return segs;
  }

  function timeline() {
    const segs = clipSegments(S.project);
    const duration = segs.length ? Math.max(...segs.map((s) => s.outEnd)) : 0;
    return {
      segs, duration,
      at(t) { return segs.find((s) => t >= s.outStart - 1e-4 && t <= s.outEnd + 1e-4) || null; },
      toSource(t) {
        const seg = segs.find((s) => t >= s.outStart - 1e-4 && t <= s.outEnd + 1e-4);
        if (!seg) return null;
        return seg.srcStart + (t - seg.outStart) * seg.speed;
      },
      toOutput(src) {
        for (const seg of segs) {
          if (src >= seg.srcStart - 1e-4 && src <= seg.srcEnd + 1e-4) {
            return seg.outStart + (src - seg.srcStart) / seg.speed;
          }
        }
        return null;
      },
    };
  }

  function mediaUrl(ref) {
    if (!ref) return '';
    const s = String(ref).replace(/\\/g, '/');
    if (s.startsWith('http')) return s;
    // Older saves and native file pickers can hand us absolute filesystem paths;
    // the server only exposes the media root, so re-root them at /media/.
    const at = s.indexOf('/media/');
    if (at >= 0) return s.slice(at);
    return API + s;
  }

  /* ------------------------------------------------------------ undo/redo */
  function snapshot() {
    return JSON.stringify({ project: S.project, selection: S.selection });
  }

  function mutate(label, fn) {
    if (!S.project) return;
    const before = snapshot();
    const result = fn(S.project);
    S.history.push(before);
    if (S.history.length > 80) S.history.shift();
    S.future.length = 0;
    markDirty(label);
    rerender();
    return result;
  }

  function markDirty(label) {
    S.dirty = true;
    S.dirtySince = Date.now();
    setSaveState(label || 'Unsaved changes');
    scheduleSave();
  }

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 1600);
  }

  async function saveNow(force) {
    if (!S.project || (!S.dirty && !force)) return;
    S.saving = true;
    setSaveState('Saving…');
    try {
      await api.patch(`/api/projects/${S.project.id}`, S.project);
      S.dirty = false;
      setSaveState('Saved');
    } catch (err) {
      setSaveState('Save failed');
      toast('Could not save', err.message, 'err');
    } finally {
      S.saving = false;
    }
  }

  function undo() {
    if (!S.history.length) return;
    const current = snapshot();
    const prev = JSON.parse(S.history.pop());
    S.future.push(current);
    S.project = prev.project;
    S.selection = prev.selection;
    markDirty('Undo');
    rerender();
  }

  function redo() {
    if (!S.future.length) return;
    const current = snapshot();
    const next = JSON.parse(S.future.pop());
    S.history.push(current);
    S.project = next.project;
    S.selection = next.selection;
    markDirty('Redo');
    rerender();
  }

  /* -------------------------------------------------------------- preview */
  const player = {
    video: null,
    broll: {},
    audio: {},
    ready: false,
  };

  function ensurePlayer() {
    if (player.video) return player.video;
    const video = document.createElement('video');
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    video.muted = false;
    video.addEventListener('ended', () => { if (S.playing) pause(); });
    player.video = video;
    return video;
  }

  function loadSource() {
    const src = mediaUrl(((S.project || {}).source || {}).media || '');
    const video = ensurePlayer();
    if (!src) return null;
    if (video.dataset.src !== src) {
      video.src = src;
      video.dataset.src = src;
      video.load();
    }
    return video;
  }

  function pxPerSec() {
    const base = 46;
    return clamp(base * S.zoom, 6, 420);
  }

  function previewSize() {
    const p = S.project || {};
    const a = (S.meta || {}).aspects || [];
    const spec = a.find((x) => x.key === (p.aspect || '9:16')) || { w: 9, h: 16 };
    const ratio = spec.w / spec.h;
    return ratio <= 1 ? { w: 420, h: Math.round(420 / ratio) } : { w: Math.round(420 * ratio), h: 420 };
  }

  function drawFrame(t) {
    const canvas = $('#preview');
    if (!canvas || !S.project) return;
    const { w: W, h: H } = previewSize();
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    const tl = timeline();
    const seg = tl.at(t);
    const video = loadSource();
    let sourceTime = 0;

    if (seg && video && video.readyState >= 2) {
      sourceTime = tl.toSource(t);
      drawClipFrame(ctx, seg, sourceTime, W, H);
    } else if (!seg) {
      ctx.fillStyle = '#8fa3ae';
      ctx.font = '13px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(S.project.clips && S.project.clips.length ? 'Playhead is outside the timeline' : 'No clips yet', W / 2, H / 2);
    }
    drawBroll(ctx, t, W, H);
    drawOverlays(ctx, t, W, H);
    drawWatermark(ctx, W, H);
    syncWaveCursor();
    return sourceTime;
  }

  function layoutRect(mode, sw, sh, W, H) {
    // destination rectangle for the (cropped) source inside the canvas
    switch (mode) {
      case 'fit': case 'blur': {
        const s = Math.min(W / sw, H / sh);
        return { x: (W - sw * s) / 2, y: (H - sh * s) / 2, w: sw * s, h: sh * s };
      }
      case 'pip': {
        const s = Math.min(W / sw, H / sh);
        return { x: (W - sw * s) / 2, y: (H - sh * s) / 2, w: sw * s, h: sh * s };
      }
      default: {
        const s = Math.max(W / sw, H / sh);
        return { x: (W - sw * s) / 2, y: (H - sh * s) / 2, w: sw * s, h: sh * s };
      }
    }
  }

  function sourceRect(clip, vw, vh) {
    const crop = clip.crop || {};
    const cw = clamp(Number(crop.w) || 1, 0.08, 1);
    const ch = clamp(Number(crop.h) || 1, 0.08, 1);
    const cx = clamp(crop.x == null ? 0.5 : Number(crop.x), 0, 1);
    const cy = clamp(crop.y == null ? 0.5 : Number(crop.y), 0, 1);
    const w = vw * cw, h = vh * ch;
    const maxX = vw - w, maxY = vh - h;
    const t = clip.transform || {};
    const px = clamp(Number(t.x) || 0, -0.45, 0.45), py = clamp(Number(t.y) || 0, -0.45, 0.45);
    return { x: clamp(maxX * cx + vw * px, 0, Math.max(0, maxX)),
             y: clamp(maxY * cy + vh * py, 0, Math.max(0, maxY)), w, h };
  }

  function activeEffects(clip, sourceTime) {
    return (clip.effects || []).filter((e) => {
      const s = e.start == null ? clip.start : Number(e.start);
      const en = e.end == null ? clip.end : Number(e.end);
      return sourceTime >= s - 1e-4 && sourceTime <= en + 1e-4;
    });
  }

  function drawClipFrame(ctx, seg, sourceTime, W, H) {
    const clip = seg.clip;
    const video = player.video;
    const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
    const layout = clip.layout || S.project.layout || 'fit';
    const sr = sourceRect(clip, vw, vh);
    const effs = activeEffects(clip, sourceTime);
    const has = (k) => effs.some((e) => e.type === k);
    const intensity = (k) => {
      const e = effs.find((x) => x.type === k);
      return e ? clamp(Number(e.intensity) || 0.5, 0, 1) : 0;
    };

    // visual filters the canvas can approximate (Canvas2D filter support)
    let filter = '';
    if (has('vhs')) filter += `saturate(${1 + 0.5 * intensity('vhs')}) contrast(1.05) `;
    if (has('aged_film')) filter += `sepia(${0.5 * intensity('aged_film')}) contrast(1.05) `;
    if (has('glitch')) filter += `hue-rotate(${6 * intensity('glitch')}deg) `;
    if (has('focus_pull')) filter += `blur(${Math.max(0, 2.6 * (1 - 0.7 * intensity('focus_pull')))}px) `;
    ctx.save();
    if (filter) ctx.filter = filter.trim();

    // shake / camera shock offsets
    let dx = 0, dy = 0;
    if (has('shake')) { const a = 8 * intensity('shake'); dx += Math.sin(sourceTime * 31) * a; dy += Math.cos(sourceTime * 27) * a * 0.7; }
    if (has('handheld')) { const a = 3 + 4 * intensity('handheld'); dx += Math.sin(sourceTime * 7.3) * a; dy += Math.cos(sourceTime * 5.9) * a * 0.75; }
    if (has('camera_shock')) { const a = 3 + 9 * intensity('camera_shock'); dx += Math.sin(sourceTime * 23) * a; dy += Math.cos(sourceTime * 19) * a * 0.6; }

    // zoom in/out via a scaling of the destination rect
    let zoom = 1;
    if (has('zoom_in') || has('zoom_out') || has('focus_pull')) {
      const clipLen = Math.max(0.1, seg.srcEnd - seg.srcStart);
      const p = clamp((sourceTime - seg.srcStart) / clipLen, 0, 1);
      const amt = 0.35 * Math.max(intensity('zoom_in'), intensity('zoom_out'), intensity('focus_pull') * 0.6);
      zoom = has('zoom_out') ? 1 + amt * (1 - p) : 1 + amt * p;
    }

    const drawOver = (mode, sx, sy, sw, sh, dx0, dy0, dw, dh) => {
      const r = layoutRect(mode, sw, sh, dw, dh);
      const cx = dx0 + r.x + r.w / 2, cy = dy0 + r.y + r.h / 2;
      const zw = r.w * zoom, zh = r.h * zoom;
      ctx.drawImage(video, sx, sy, sw, sh, cx - zw / 2 + dx, cy - zh / 2 + dy, zw, zh);
    };

    if (layout === 'blur') {
      // blurred cover background (drawn from an offscreen copy), then the fitted frame
      const off = document.createElement('canvas');
      off.width = 64; off.height = 36;
      const octx = off.getContext('2d');
      octx.drawImage(video, sr.x, sr.y, sr.w, sr.h, 0, 0, 64, 36);
      ctx.save();
      ctx.filter = `blur(14px) brightness(${filter ? 0.85 : 0.8})`;
      ctx.drawImage(off, 0, 0, W, H);
      ctx.restore();
      if (filter) ctx.filter = filter.trim();
      drawOver('fit', sr.x, sr.y, sr.w, sr.h, 0, 0, W, H);
    } else if (layout === 'split' || layout === 'trio') {
      const n = layout === 'split' ? 2 : 3;
      const bandH = Math.round(H / n);
      for (let i = 0; i < n; i++) {
        const sw = vw / n, sx = i * sw;
        const r = layoutRect('full', sw, vh, W, bandH);
        ctx.drawImage(video, sx, 0, sw, vh, r.x, i * bandH + r.y, r.w, r.h);
      }
    } else if (layout === 'grid') {
      const hw = W / 2, hh = H / 2;
      const sw = vw / 2, sh = vh / 2;
      const cells = [[0, 0], [1, 0], [0, 1], [1, 1]];
      cells.forEach(([cx, cy], i) => {
        const r = layoutRect('full', sw, sh, hw, hh);
        ctx.drawImage(video, cx * sw, cy * sh, sw, sh, (i % 2) * hw + r.x, Math.floor(i / 2) * hh + r.y, r.w, r.h);
      });
    } else if (layout === 'pip') {
      drawOver('full', sr.x, sr.y, sr.w, sr.h, 0, 0, W, H);
      const pw = W * 0.32, ph = H * 0.22;
      const r = layoutRect('full', sr.w, sr.h, pw, ph);
      ctx.save();
      ctx.strokeStyle = '#00ff9c';
      ctx.lineWidth = 2;
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.fillRect(W - pw - 12, H - ph - 12, pw, ph);
      ctx.drawImage(video, sr.x, sr.y, sr.w, sr.h, W - pw - 12 + r.x, H - ph - 12 + r.y, r.w, r.h);
      ctx.strokeRect(W - pw - 12, H - ph - 12, pw, ph);
      ctx.restore();
    } else {
      drawOver(layout === 'full' ? 'full' : 'fit', sr.x, sr.y, sr.w, sr.h, 0, 0, W, H);
    }

    ctx.restore();

    // opacity, flip and rotation at the clip level
    const t = clip.transform || {};
    if (Number(t.opacity) != null && Number(t.opacity) < 0.999) {
      ctx.save();
      ctx.globalAlpha = clamp(Number(t.opacity), 0.05, 1);
      ctx.fillStyle = 'rgba(0,0,0,0)';
      ctx.restore();
    }
  }

  function drawBroll(ctx, t, W, H) {
    const items = S.project.broll || [];
    const active = items.filter((b) => t >= Number(b.start) - 1e-3 && t <= Number(b.end) + 1e-3);
    Object.keys(player.broll).forEach((id) => {
      if (!active.some((a) => a.id === id)) {
        const el = player.broll[id];
        if (el) { el.pause(); delete player.broll[id]; }
      }
    });
    active.forEach((b) => {
      let el = player.broll[b.id];
      const src = mediaUrl(b.media);
      if (!el) {
        el = document.createElement('video');
        el.muted = true; el.playsInline = true; el.src = src; el.loop = true;
        player.broll[b.id] = el;
        el.play().catch(() => {});
      }
      if (el.readyState >= 2) {
        const local = (t - Number(b.start)) + (Number(b.from) || 0);
        if (Math.abs(el.currentTime - local) > 0.35) el.currentTime = local;
        const r = layoutRect('full', el.videoWidth || 16, el.videoHeight || 9, W, H);
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.drawImage(el, r.x, r.y, r.w, r.h);
        ctx.restore();
      }
    });
  }

  function styleFor(item) {
    const base = { color: '#ffffff', background: 'none', font: 'Montserrat', size: 'medium',
                   stroke: 0, shadow: 0, align: 'center', x: 0.5, y: 0.5,
                   animation_in: 'fade', animation_out: 'fade' };
    const presets = ((S.meta || {}).captions || {}).text_presets || [];
    const p = presets.find((x) => x.key === item.preset);
    return Object.assign(base, (p && p.style) || {}, item.style || {});
  }

  /* Same fractions the exporter uses (captions.py px_size), so text wraps and
     sits at identical positions in the preview and in the exported video. */
  function sizePx(size, H) {
    if (typeof size === 'number') return size;
    const frac = { small: 0.042, medium: 0.058, large: 0.078, xlarge: 0.1 }[size] || 0.058;
    return Math.max(10, Math.round(H * frac));
  }

  /* libass lays a face out with usWinAscent+usWinDescent as the line box, so a
     font renders smaller than its nominal px. The backend publishes that factor
     per family (captions.font_scales) — apply it here or the preview wraps
     earlier than the export. */
  function libassScale(font) {
    const scales = ((S.meta || {}).captions || {}).font_scales || {};
    const v = scales[font || 'Montserrat'];
    return typeof v === 'number' && v > 0 ? v : 1;
  }

  function drawTextItem(ctx, item, t, W, H) {
    const st = styleFor(item);
    const start = Number(item.start) || 0;
    const end = Number(item.end) || start + 3;
    if (t < start - 1e-3 || t > end + 1e-3) return;
    const px = sizePx(st.size, H) * libassScale(st.font);
    // the exporter bolds headings only (captions.py text_style / build_ass)
    const weight = item.kind === 'heading' ? 700 : 400;
    const font = `${weight} ${Math.max(10, Math.round(px))}px "${st.font || 'Montserrat'}", Inter, sans-serif`;
    ctx.save();
    ctx.font = font;
    ctx.textAlign = st.align === 'left' ? 'left' : (st.align === 'right' ? 'right' : 'center');
    ctx.textBaseline = 'middle';
    const age = t - start;
    let alpha = 1, scale = 1;
    if (st.animation_in === 'fade' && age < 0.35) alpha = clamp(age / 0.35, 0, 1);
    if (st.animation_in === 'pop' && age < 0.35) { scale = 0.7 + 0.3 * clamp(age / 0.35, 0, 1); alpha = clamp(age / 0.2, 0, 1); }
    if (st.animation_out === 'fade' && end - t < 0.3) alpha = clamp((end - t) / 0.3, 0, 1);
    ctx.globalAlpha = alpha;
    const x = W * clamp(Number(st.x) || 0.5, 0, 1);
    const y = H * clamp(Number(st.y) || 0.5, 0, 1);
    // wrap like the exporter: explicit newlines first, then word wrap at the
    // same 5.5%-per-side margins the ASS styles use
    const maxTextW = W * 0.89;
    const rows = [];
    String(item.text || '').split('\n').forEach((raw) => {
      let cur = '';
      raw.split(/\s+/).filter(Boolean).forEach((word) => {
        const next = cur ? cur + ' ' + word : word;
        if (cur && ctx.measureText(next).width > maxTextW) { rows.push(cur); cur = word; }
        else cur = next;
      });
      rows.push(cur);
    });
    const lines = rows.length ? rows : [''];
    const metrics = lines.map((line) => ctx.measureText(line).width);
    const boxW = Math.max(...metrics, 10) + 24;
    const boxH = lines.length * (px * 1.25) + 14;
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    if (st.background && st.background !== 'none') {
      ctx.fillStyle = st.background;
      ctx.fillRect(-boxW / 2, -boxH / 2, boxW, boxH);
    }
    if (Number(st.shadow)) {
      ctx.shadowColor = 'rgba(0,0,0,.6)';
      ctx.shadowBlur = 6 * Number(st.shadow);
    }
    lines.forEach((line, i) => {
      const ly = -boxH / 2 + 7 + px * 1.25 * (i + 0.5);
      if (Number(st.stroke)) {
        ctx.lineWidth = Math.max(1, Number(st.stroke) * 0.6);
        ctx.strokeStyle = st.outline_color || '#000';
        ctx.strokeText(line, 0, ly);
      }
      ctx.fillStyle = st.color || '#fff';
      ctx.fillText(line, 0, ly);
    });
    ctx.restore();
  }

  function subtitleLines() {
    const subs = (S.project || {}).subtitles || {};
    if (!subs.enabled || !S.showSubs) return [];
    const tl = timeline();
    const out = [];
    (subs.lines || []).forEach((line) => {
      const start = tl.toOutput(Number(line.start));
      const end = tl.toOutput(Number(line.end));
      if (start == null) return;
      out.push(Object.assign({}, line, { outStart: start, outEnd: end == null ? start + 0.4 : Math.max(start + 0.3, end) }));
    });
    return out;
  }

  function subtitleStyle() {
    const subs = (S.project || {}).subtitles || {};
    const presets = ((S.meta || {}).captions || {}).subtitle_presets || [];
    const p = presets.find((x) => x.key === (subs.preset || 'word_highlight'));
    return Object.assign({ color: '#fff', highlight: '#00ff9c', background: 'none', stroke: 4,
                           shadow: 1, size: 'medium', position: 'bottom', align: 'center',
                           max_words: 4, animation: 'word', font: 'Montserrat' },
                         (p && p.style) || {}, subs.style || {});
  }

  function drawOverlays(ctx, t, W, H) {
    // text items + hooks (output timeline)
    (S.project.texts || []).forEach((item) => drawTextItem(ctx, item, t, W, H));
    (S.project.hooks || []).forEach((item) => drawTextItem(ctx, item, t, W, H));

    // subtitles
    const st = subtitleStyle();
    const active = subtitleLines().filter((l) => t >= l.outStart - 1e-3 && t <= l.outEnd + 1e-3);
    if (!active.length) return;
    const line = active[0];
    const px = sizePx(st.size, H) * libassScale(st.font);
    const yFrac = { top: 0.14, center: 0.5, bottom: 0.82 }[st.position || 'bottom'] || 0.82;
    const y = H * yFrac;
    const x = W * 0.5;
    const emoji = ((S.project.subtitles || {}).emojis) ? emojiFor(line.text) : '';
    const speakers = !!(S.project.subtitles || {}).speaker_labels;
    const prefix = speakers && line.speaker != null ? `Speaker ${Number(line.speaker) + 1}: ` : '';
    // karaoke styles are bold in the export, plain styles only if st.bold is set
    const captionWeight = (st.bold || ['word', 'karaoke', 'keyword'].includes(st.animation)) ? 700 : 400;
    ctx.save();
    ctx.font = `${captionWeight} ${Math.max(9, Math.round(px))}px "${st.font || 'Montserrat'}", Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const words = (line.words || []).filter((w) => w.w);
    const tl = timeline();
    const spaceW = ctx.measureText(' ').width;

    /* Wrapping mirrors the exporter: libass wraps inside MarginL/MarginR, which
       the backend sets to 5.5% of the canvas width on each side. */
    const wrapTokens = (tokens, maxW) => {
      const lines = [];
      let cur = [];
      let curW = 0;
      tokens.forEach((tk, i) => {
        const need = tk.w + (cur.length ? spaceW : 0);
        if (cur.length && curW + need > maxW) { lines.push(cur); cur = []; curW = 0; }
        curW += tk.w + (cur.length ? spaceW : 0);
        cur.push({ label: tk.label, w: tk.w, i });
      });
      if (cur.length) lines.push(cur);
      return lines;
    };

    const drawLines = (tokens, hlIndex) => {
      if (!tokens.length) return;
      const maxW = W * 0.89;
      const rows = wrapTokens(tokens, maxW);
      const lineH = px * 1.18;
      rows.forEach((row, li) => {
        const lineW = row.reduce((a, tk) => a + tk.w, 0) + spaceW * Math.max(0, row.length - 1);
        let cx = x - lineW / 2;
        const ly = y + (li - (rows.length - 1) / 2) * lineH;
        row.forEach((tk) => {
          const hl = hlIndex >= 0 && tk.i <= hlIndex;
          if (st.background && st.background !== 'none') {
            ctx.fillStyle = hl ? st.highlight : st.background;
            ctx.fillRect(cx - 4, ly - px * 0.75, tk.w + 8, px * 1.5);
          }
          if (Number(st.stroke)) {
            ctx.lineWidth = Math.max(1, Number(st.stroke) * 0.55);
            ctx.strokeStyle = st.outline_color || '#000';
            ctx.strokeText(tk.label, cx + tk.w / 2, ly);
          }
          ctx.fillStyle = hl ? st.highlight : st.color;
          ctx.fillText(tk.label, cx + tk.w / 2, ly);
          cx += tk.w + spaceW;
        });
      });
    };

    const decorated = (words.length ? words.map((w) => w.w) : String(line.text || '').split(/\s+/)).filter(Boolean);
    const extra = emoji ? ` ${emoji}` : '';
    const tokens = decorated.map((word, i) => ({
      label: (i === 0 ? prefix : '') + word + (i === decorated.length - 1 ? extra : ''),
      w: ctx.measureText((i === 0 ? prefix : '') + word + (i === decorated.length - 1 ? extra : '')).width,
    }));

    if (words.length && ['word', 'karaoke', 'keyword'].includes(st.animation)) {
      const srcTime = tl.toSource(t);
      let idx = -1;
      words.forEach((w, i) => { if (srcTime != null && srcTime >= Number(w.s)) idx = i; });
      drawLines(tokens, idx);
    } else {
      drawLines(tokens, -1);
    }
    ctx.restore();
  }

  function drawWatermark(ctx, W, H) {
    if (!(S.project.brand || {}).watermark) return;
    ctx.save();
    ctx.font = `${Math.max(8, Math.round(H * 0.02))}px Inter, sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.fillText('ClipOX', W - 10, H - 10);   /* CHANGED: brand matches index.html */
    ctx.restore();
  }

  const EMOJI_MAP = { money: '$', love: '♥', happy: '☺', idea: '✦', music: '♪', video: '▶',
                      camera: '✎', rocket: '↑', check: '✓', star: '★', fire: '▲', time: '∞',
                      travel: '✈', coffee: '☕', best: '★', perfect: '✦', fast: '≫' };
  function emojiFor(text) {
    const words = String(text || '').toLowerCase().split(/[^a-z]+/);
    for (const w of words) if (EMOJI_MAP[w]) return EMOJI_MAP[w];
    return '';
  }

  /* --------------------------------------------------------------- audio */
  function syncAudio(playing) {
    const items = (((S.project || {}).audio || {}).items) || [];
    items.forEach((item) => {
      const src = mediaUrl(item.media);
      if (!src) return;
      let el = player.audio[item.id];
      if (!el) {
        el = document.createElement('audio');
        el.src = src;
        el.loop = !!item.loop;
        el.preload = 'auto';
        player.audio[item.id] = el;
      }
      const start = Number(item.start) || 0;
      const end = Number(item.end) || start + 5;
      const inside = S.playhead >= start && S.playhead <= end;
      el.volume = clamp(Number(item.volume == null ? 0.3 : item.volume), 0, 1);
      el.loop = !!item.loop;
      if (playing && inside && !S.muted.audio) {
        const local = (S.playhead - start) + (Number(item.from) || 0);
        if (Math.abs(el.currentTime - local) > 0.4) el.currentTime = Math.max(0, local);
        if (el.paused) el.play().catch(() => {});
      } else if (!el.paused) {
        el.pause();
      }
    });
  }

  function syncWaveCursor() {
    const el = $('#waveCursor');
    if (!el) return;
    const tl = timeline();
    const pct = tl.duration ? clamp(S.playhead / tl.duration, 0, 1) * 100 : 0;
    el.style.left = `${pct}%`;
  }

  /* ------------------------------------------------------------- playback */
  let rafId = null;
  function play() {
    if (!S.project || !(S.project.clips || []).length) return;
    const tl = timeline();
    if (S.playhead >= tl.duration - 0.02) S.playhead = 0;
    S.playing = true;
    updateTransport();
    syncAudio(true);
    seekToPlayhead(true);
    const loop = () => {
      if (!S.playing) return;
      const video = player.video;
      const segs = timeline().segs;
      let seg = null;
      for (let i = 0; i < segs.length; i++) {
        if (S.playhead >= segs[i].outStart - 1e-3 && S.playhead <= segs[i].outEnd + 1e-3) { seg = segs[i]; break; }
      }
      if (!seg) {
        for (let i = 0; i < segs.length; i++) {
          if (S.playhead < segs[i].outStart) { seg = segs[i]; if (i > 0) { S.playhead = seg.outStart; seekToPlayhead(true); } break; }
        }
      }
      if (!seg) { pause(); return; }
      if (video && !video.paused) {
        const out = seg.outStart + (video.currentTime - seg.srcStart) / seg.speed;
        if (out > seg.outEnd + 0.02) {
          const next = segs.find((s) => s.outStart > seg.outEnd - 1e-3);
          if (next) { S.playhead = next.outStart; seekToPlayhead(true); }
          else { pause(); S.playhead = timeline().duration; }
        } else {
          S.playhead = Math.max(0, out);
        }
      } else {
        S.playhead += 1 / 30;
      }
      drawFrame(S.playhead);
      renderTimelineCursor();
      updateTransport();
      syncAudio(true);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }

  function pause() {
    S.playing = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (player.video) player.video.pause();
    Object.values(player.broll).forEach((el) => el.pause());
    syncAudio(false);
    updateTransport();
  }

  function seekToPlayhead(andPlay) {
    const tl = timeline();
    const src = tl.toSource(S.playhead);
    const video = loadSource();
    if (!video || src == null) return;
    video.playbackRate = 1;
    try { video.currentTime = Math.max(0, src); } catch (e) { /* not seekable yet */ }
    if (andPlay) video.play().catch(() => {});
    else video.pause();
  }

  function seek(t) {
    const tl = timeline();
    S.playhead = clamp(t, 0, Math.max(0, tl.duration));
    if (S.playing) seekToPlayhead(true);
    else {
      seekToPlayhead(false);
      drawFrame(S.playhead);
      renderTimelineCursor();
      updateTransport();
    }
  }

  function updateTransport() {
    const tl = timeline();
    const time = $('#tlTime');
    if (time) time.textContent = `${fmt.clockMs(S.playhead)} / ${fmt.clockMs(tl.duration)}`;
    const btn = $('#playBtn');
    if (btn) btn.textContent = S.playing ? '❚❚' : '▶';
  }

  /* ---------------------------------------------------------------- shell */
  function toast(title, body, kind) {
    const host = $('#toasts');
    if (!host) return;
    const el = document.createElement('div');
    el.className = `toast ${kind || ''}`;
    el.innerHTML = `<strong>${esc(title)}</strong>${body ? esc(body) : ''}`;
    host.appendChild(el);
    setTimeout(() => el.remove(), kind === 'err' ? 9000 : 5200);
  }

  function setSaveState(text) {
    const el = $('#saveState');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('dirty', /Unsaved|Saving|failed/i.test(text));
  }

  /** UNLIMITED_CREDITS (backend config) — one switch, read from /api/credits. */
  function unlimitedCredits() {
    return !!((S.meta || {}).credits || {}).unlimited;
  }

  function fail(err, hadBox) {
    const message = err && err.message ? err.message : String(err);
    if (err && err.upgrade && !unlimitedCredits()) {
      openModal(`upgrade`);
      toast('Not enough credits', message, 'warn');
      return;
    }
    if (err && err.configure) {
      toast('Needs a key', `${message} → set ${Array.isArray(err.configure) ? err.configure.join(', ') : err.configure}`, 'warn');
      return;
    }
    if (hadBox && hadBox.el) {
      hadBox.el.hidden = false;
      hadBox.el.textContent = message;
      hadBox.el.className = 'err';
    }
    toast('Something went wrong', message, 'err');
  }

  /* ------------------------------------------------------------- routing */
  function views() { return window.WVE_VIEWS || {}; }

  function showPage(page) {
    S.page = page;
    $$('.side-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
    const main = $('#main');
    if (!main) return;
    const render = views()['render_' + page];
    if (render) { render(main, state); return; }
    main.innerHTML = `<div class="page"><h1>${esc(page)}</h1><p class="lead">This page is not available.</p></div>`;
  }

  function renderTimeline() { if (views().renderTimeline) views().renderTimeline(state); }
  function renderTimelineCursor() { if (views().renderTimelineCursor) views().renderTimelineCursor(state); }

  /** Deep link from Clip Maker: /editor.html?src=<clip url> loads that clip. */
  function sourceFromQuery() {
    const src = new URLSearchParams(location.search).get('src');
    if (!src) return false;
    showPage('start');
    setTimeout(() => {
      const input = $('#startUrl');
      if (!input) return;
      input.value = src;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('paste', { bubbles: true }));
      const btn = $('#startBtn');
      if (btn) setTimeout(() => { if (!btn.disabled && input.value === src) btn.click(); }, 900);
    }, 420);
    return true;
  }

  function route() {
    const hash = location.hash.replace(/^#/, '') || '';
    const [page, query] = hash.split('?');
    const params = new URLSearchParams(query || '');
    const projectId = params.get('project') || new URLSearchParams(location.search).get('project');
    if (projectId) { openProject(projectId); return; }
    if (!page && sourceFromQuery()) return;
    /* Unknown or stale hash (e.g. a page that has since been removed, like
       #api): fall back to the default view instead of "not available". */
    const known = page === 'start' || !!views()['render_' + page];
    if (!page || !known) {
      showPage(S.project && S.project.clips && S.project.clips.length ? 'editor' : 'start');
      return;
    }
    showPage(page);
  }

  async function refreshCredits() {
    try {
      const data = await api.get('/api/credits');
      S.meta.credits = data;
      S.meta.plans = (data.prices || {}).plans || S.meta.plans || [];
      const unlimited = !!data.unlimited;
      const el = $('#creditCount');
      if (el) el.textContent = unlimited ? '∞' : data.balance;
      const pill = $('#creditsPill');
      if (pill) pill.classList.toggle('low', !unlimited && data.balance < 50);
      const up = $('#upgradeBtn');
      if (up) { up.hidden = unlimited; up.style.display = unlimited ? 'none' : ''; }
    } catch (e) { /* offline is handled by the shell banner */ }
  }

  async function refreshNotifications() {
    try {
      const data = await api.get('/api/notifications');
      S.notifications = data;
      const dot = $('#bellDot');
      if (dot) dot.classList.toggle('badge-dot', data.unread > 0);
      const list = $('#notifList');
      if (list) {
        list.innerHTML = data.items.length ? data.items.map((n) => `
          <div class="drop-item"><span>${n.level === 'error' ? '⛔' : n.level === 'warn' ? '⚠️' : '✅'}</span>
          <span><strong>${esc(n.title)}</strong><small>${esc(n.body || '')} · ${fmt.when(n.at)}</small></span></div>`).join('')
          : '<div class="drop-item"><span>🔔</span><span><strong>No notifications yet</strong><small>Job and export updates appear here.</small></span></div>';
      }
    } catch (e) { /* ignore */ }
  }

  async function openProject(projectId) {
    try {
      const project = await api.get(`/api/projects/${projectId}`);
      S.project = project;
      S.history = []; S.future = [];
      S.playhead = 0;
      S.page = 'editor';
      showPage('editor');
      history.replaceState(null, '', `#editor?project=${projectId}`);
    } catch (err) {
      fail(err);
      showPage('start');
    }
  }

  function rerender() {
    if (S.page === 'editor' && views().renderEditorShell) views().renderEditorShell(state);
    if (S.page === 'editor') {
      renderTimeline();
      renderPanel();
      const title = $('#projectTitle');
      if (title && document.activeElement !== title) title.value = S.project.name || 'Untitled';
      requestAnimationFrame(() => drawFrame(S.playhead));
    }
  }

  /* --------------------------------------------------------------- modal */
  function openModal(kind, data) {
    // Billing off: the "Not enough credits" modal is never reachable.
    if (kind === 'upgrade' && unlimitedCredits()) return;
    const host = $('#modalHost');
    if (!host) return;
    host.innerHTML = MODALS[kind] ? MODALS[kind](data || {}) : '';
    host.classList.add('open');
    host.dataset.kind = kind;
    if (MODAL_WIRE[kind]) MODAL_WIRE[kind](data || {});
  }

  function closeModal() {
    const host = $('#modalHost');
    if (host) { host.classList.remove('open'); host.innerHTML = ''; delete host.dataset.kind; }
  }

  const MODALS = {};
  const MODAL_WIRE = {};
  function modal(kind, html, wire) { MODALS[kind] = html; MODAL_WIRE[kind] = wire; }

  /* --------------------------------------------------------------- panels */
  const PANELS = {};
  function panel(key, def) { PANELS[key] = def; }

  function renderPanel() {
    const def = PANELS[S.tool];
    const head = $('#panelHead');
    const body = $('#panelBody');
    if (!body) return;
    if (!def) { body.innerHTML = '<div class="empty">Panel coming up…</div>'; return; }
    if (head) head.innerHTML = `<h3>${esc(def.title)}</h3><p>${esc(def.blurb || '')}</p>`;
    body.innerHTML = '';
    def.render(body, { rerender, mutate, seek, api, toast, fail, openModal, closeModal, state: S, timeline });
  }

  /* ------------------------------------------------------------ ui pages */
  const state = { S, player, api, toast, fail, mutate, seek, timeline, drawFrame, renderPanel,
                  openModal, closeModal, modal, panel, rerender, refreshCredits, refreshNotifications,
                  fmt, esc, clamp, mediaUrl, showPage, openProject, saveNow, modalOpen: openModal,
                  snapshot, undo, redo, markDirty, seekToPlayhead, syncAudio, pxPerSec, previewSize,
                  subtitleLines, subtitleStyle, styleFor, sizePx, emojiFor, clipSegments,
                  loadSource, ensurePlayer, play, pause, updateTransport, ensureViews: null };
  window.WVE_STATE = state;

  /* ------------------------------------------------------------------ boot */
  async function boot() {
    const ok = await detectApi();
    if (!ok) {
      const banner = $('#shellBanner');
      if (banner) {
        banner.hidden = false;
        banner.className = 'err';
        banner.textContent = 'Backend not reachable. Start it with: cd backend && .venv/bin/uvicorn app.main:app --port 8000';
      }
      return;
    }
    try {
      S.meta = await api.get('/api/editor/meta');
    } catch (err) {
      fail(err);
      return;
    }
    refreshCredits();
    refreshNotifications();
    renderShellStatic();
    route();
    window.addEventListener('hashchange', route);
    setInterval(() => { if (S.dirty) saveNow(); }, 12000);
  }

  function renderShellStatic() {
    const c = (S.meta || {}).credits;
    const unlimited = !!(c && c.unlimited);
    const el = $('#creditCount');
    if (el && c) el.textContent = unlimited ? '∞' : c.balance;
    const up = $('#upgradeBtn');
    if (up) { up.hidden = unlimited; up.style.display = unlimited ? 'none' : ''; }
    const pill = $('#creditsPill');
    if (pill) pill.classList.toggle('low', !unlimited && c && c.balance < 50);
    const sup = $('#sidebarFoot');
    if (sup && c) {
      sup.innerHTML = unlimited
        ? `<div class="spread"><span>Plan <b>${esc(c.plan_name)}</b></span>
             <span class="cost">∞ credits</span></div>
           <div class="tiny" style="margin-top:6px">Unlimited — billing is off (UNLIMITED_CREDITS)</div>`
        : `<div class="spread"><span>Plan <b>${esc(c.plan_name)}</b></span>
             <span class="cost">${c.balance} credits</span></div>
           <div class="bar" style="margin-top:6px"><i style="width:${c.used_percent}%"></i></div>
           <div class="tiny" style="margin-top:6px">${c.spent} spent this period</div>`;
    }
  }

  document.addEventListener('DOMContentLoaded', boot);

  return state;
})();

/* ==========================================================================
   WayinVideo AI Video Editor — views
   Registers every screen into WVE_VIEWS: start page + processing, the editor
   shell (rail / panel host / preview / timeline), the other pages and the
   modals. editor.js owns state, the compositor and the transport.
   ========================================================================== */
(function () {
  'use strict';
  const V = {};

  const WV = () => window.WVE_STATE;

  const TRACKS = [
    { key: 'videos', label: 'Video', type: 'clip', tall: true },
    { key: 'subtitles', label: 'Subtitles', type: 'subs' },
    { key: 'text', label: 'Text', type: 'text' },
    { key: 'hook', label: 'Hook', type: 'hook' },
    { key: 'broll', label: 'B-roll', type: 'broll' },
    { key: 'audio', label: 'Audio', type: 'audio' },
    { key: 'sfx', label: 'Sound FX', type: 'audio' },
    { key: 'effects', label: 'Effects', type: 'effect' },
  ];

  const h = (strings) => strings.join('');
  const pct = (v) => `${Math.max(0, Math.min(100, Number(v) || 0))}%`;

  /* ============================================================ start page */
  V.render_start = function (main, W) {
    const S = W.S;
    const langs = (S.meta && S.meta.languages) || [{ code: 'en', label: 'English' }];
    const aspects = (S.meta && S.meta.aspects) || [];
    main.innerHTML = `
      <div class="start-wrap"><div class="start-card">
        <h1>Video Editor</h1>
        <p class="sub">Start editing everything in one place with powerful tools.</p>
        <div id="startErr" class="err" hidden></div>
        <label class="lbl">Paste a video link</label>
        <div class="url-row">
          <input class="input" id="startUrl" placeholder="https://www.youtube.com/watch?v=…" spellcheck="false">
          <button class="btn btn-sm" id="fetchBtn">Fetch info</button>
        </div>
        <div id="metaCard"></div>
        <div class="dropzone" id="dropzone">
          <div><div style="font-size:22px">⬆</div>
          <strong>Drop an MP4, MOV or WEBM here</strong>
          <div class="muted small">or click to choose a file — also supports MP3/WAV audio</div></div>
          <input type="file" id="fileInput" accept="video/*,audio/*" hidden>
        </div>
        <div class="split-2" style="margin-top:14px">
          <div>
            <label class="lbl">Language (transcription / translation)</label>
            <select class="input" id="startLang">
              <option value="">Auto / No translation</option>
              ${langs.map((l) => `<option value="${l.code}">${W.esc(l.label)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="lbl">Output layout</label>
            <select class="input" id="startAspect">
              ${aspects.map((a) => `<option value="${a.key}" ${a.key === '9:16' ? 'selected' : ''}>${W.esc(a.label)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div style="margin-top:18px">
          <button class="btn btn-green btn-block" id="startBtn" style="height:46px">Start Editing Your Video</button>
          <div class="legal"><span>©</span><span>By continuing, you confirm the video is your own. Using others' content may violate copyright laws.</span></div>
        </div>
        <div id="procHost"></div>
      </div></div>`;
    main.classList.remove('editing');

    const err = main.querySelector('#startErr');
    const metaBox = main.querySelector('#metaCard');
    let meta = null;
    let file = null;
    let taskId = null;

    const showErr = (msg) => { err.hidden = !msg; err.textContent = msg || ''; };

    async function fetchMeta() {
      const url = main.querySelector('#startUrl').value.trim();
      if (!url) return;
      showErr('');
      metaBox.innerHTML = '<div class="card small muted" style="margin-top:14px">Reading video info…</div>';
      try {
        meta = await W.api.post('/api/editor/metadata', { url });
        metaBox.innerHTML = `
          <div class="meta-card">
            <div class="thumb" style="background-image:url('${meta.thumbnail}')">
              <div class="play">▶</div><span class="dur">${W.esc(meta.duration_label)}</span>
            </div>
            <div style="min-width:0">
              <strong style="display:block;font-size:15px">${W.esc(meta.title || 'Untitled')}</strong>
              <div class="muted small" style="margin-top:4px">${W.esc(meta.uploader || 'unknown channel')} · ${W.esc(meta.platform)}</div>
              <div class="row" style="margin-top:8px">
                <span class="tag">${W.esc(meta.duration_label)}</span>
                <span class="tag">${W.esc(meta.platform)}</span>
                ${meta.view_count ? `<span class="tag">${Number(meta.view_count).toLocaleString()} views</span>` : ''}
              </div>
            </div>
          </div>`;
      } catch (e) {
        metaBox.innerHTML = '';
        showErr(e.message);
      }
    }

    main.querySelector('#fetchBtn').onclick = fetchMeta;
    main.querySelector('#startUrl').addEventListener('paste', () => setTimeout(fetchMeta, 220));
    main.querySelector('#startUrl').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') fetchMeta(); });

    const dz = main.querySelector('#dropzone');
    const input = main.querySelector('#fileInput');
    dz.onclick = () => input.click();
    input.onchange = () => { if (input.files[0]) { file = input.files[0]; paintFile(); } };
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', (e) => {
      const dropped = e.dataTransfer.files && e.dataTransfer.files[0];
      if (dropped) { file = dropped; paintFile(); }
    });
    function paintFile() {
      if (!file) return;
      dz.querySelector('strong').textContent = file.name;
      dz.querySelector('.muted').textContent = `${W.fmt.bytes(file.size)} · ready to process`;
      main.querySelector('#startUrl').value = '';
      meta = null;
      metaBox.innerHTML = '';
    }

    main.querySelector('#startBtn').onclick = async () => {
      const btn = main.querySelector('#startBtn');
      const lang = main.querySelector('#startLang').value;
      const aspect = main.querySelector('#startAspect').value;
      showErr('');
      btn.disabled = true;
      try {
        let res;
        if (file) {
          const fd = new FormData();
          fd.append('file', file);
          fd.append('language', lang);
          fd.append('aspect', aspect);
          fd.append('layout', 'fit');
          fd.append('name', file.name.replace(/\.[^.]+$/, ''));
          res = await W.api.post('/api/editor/process-upload', fd);
        } else {
          const url = main.querySelector('#startUrl').value.trim();
          if (!url) { throw new Error('Paste a video URL or choose a file first.'); }
          res = await W.api.post('/api/editor/process', { url, language: lang, aspect, layout: 'fit' });
        }
        taskId = res.task_id;
        poll(taskId);
      } catch (e) {
        btn.disabled = false;
        if (e.upgrade) { W.openModal('upgrade'); }
        showErr(e.message);
      }
    };

    function poll(id) {
      const host = main.querySelector('#procHost');
      host.innerHTML = `
        <div class="proc">
          <div class="spread"><strong>We're processing your video. This won't take long…</strong>
            <span class="mono" id="procPct">0%</span></div>
          <div class="bar" style="margin-top:10px"><i id="procBar" style="width:0%"></i></div>
          <ol id="procSteps"></ol>
          <div class="row" style="margin-top:12px">
            <button class="btn btn-sm btn-ghost" id="procCancel">Cancel</button>
            <span class="muted tiny" id="procStage"></span>
          </div>
        </div>`;
      host.querySelector('#procCancel').onclick = async () => {
        try { await W.api.post(`/api/editor/cancel/${id}`); } catch (e) { /* already gone */ }
        W.toast('Cancelling', 'the job stops at the next stage');
      };
      const timer = setInterval(async () => {
        let st;
        try { st = await W.api.get(`/api/editor/status/${id}`); }
        catch (e) { clearInterval(timer); showErr(e.message); return; }
        host.querySelector('#procPct').textContent = `${Math.round(st.progress)}%`;
        host.querySelector('#procBar').style.width = pct(st.progress);
        host.querySelector('#procStage').textContent = st.stage || '';
        host.querySelector('#procSteps').innerHTML = (st.steps || []).map((s) =>
          `<li class="${s.state}"><span class="dot"></span>${W.esc(s.label)}</li>`).join('');
        if (st.status === 'done') {
          clearInterval(timer);
          W.refreshCredits(); W.refreshNotifications();
          const project = st.result.project;
          W.S.project = project;
          W.S.history = []; W.S.future = []; W.S.playhead = 0;
          W.toast('Ready', `${(project.clips || []).length} clips on the timeline`);
          history.replaceState(null, '', `#editor?project=${project.id}`);
          W.showPage('editor');
        } else if (st.status === 'error') {
          clearInterval(timer);
          showErr(st.error || 'processing failed');
          main.querySelector('#startBtn').disabled = false;
        } else if (st.status === 'cancelled') {
          clearInterval(timer);
          showErr('cancelled');
          main.querySelector('#startBtn').disabled = false;
        }
      }, 1200);
    }
  };

  /* ======================================================== editor shell */
  function railButtons(S) {
    const rail = (S.meta && S.meta.tool_rail) || [];
    return rail.map((t) => `<button class="rail-btn ${S.tool === t.key ? 'active' : ''}" data-tool="${t.key}">
      <span class="ico">${t.icon}</span><span>${WV().esc(t.label)}</span></button>`).join('');
  }

  function editorMarkup(S) {
    const W = WV();
    const p = S.project || {};
    const projectName = p.name || 'Untitled project';
    return h([
      `<div class="editor">`,
      `<div class="ed-head">`,
      `<button class="tb-btn" id="menuBtn" title="Menu">☰</button>`,
      `<button class="tb-btn" id="backBtn" title="Back to library">←</button>`,
      `<input class="ed-title" id="projectTitle" value="${W.esc(projectName)}" spellcheck="false">`,
      `<span class="save-state" id="saveState">Saved</span>`,
      `<div class="tb-spacer"></div>`,
      `<button class="tb-btn" id="undoBtn" title="Undo (Ctrl+Z)">↶</button>`,
      `<button class="tb-btn" id="redoBtn" title="Redo (Ctrl+Shift+Z)">↷</button>`,
      `<button class="tb-btn" id="shortcutsBtn" title="Keyboard shortcuts">⌨</button>`,
      `<button class="btn btn-sm" id="publishBtn">Publish</button>`,
      `<button class="btn btn-sm btn-green" id="exportBtn">Export</button>`,
      `</div>`,
      `<div class="ed-body">`,
      `<div class="rail"><div class="rail-scroll" id="railScroll">${railButtons(S)}</div>`,
      `<div class="rail-more"><button class="mini" id="railUp" title="Scroll tools up">▲</button>` +
      `<button class="mini" id="railDown" title="Scroll tools down">▼</button></div></div>`,
      `<aside class="panel"><div class="panel-head" id="panelHead"></div><div class="panel-body" id="panelBody"></div></aside>`,
      `<div class="center">`,
      `<div class="preview-wrap">`,
      `<div class="preview-box" id="previewBox" style="aspect-ratio:${aspectAr(S)};height:min(62vh,660px)"><canvas id="preview" class="preview"></canvas>`,
      `<span class="preview-badge" id="qualityBadge">Low-res Preview</span></div>`,
      `<div class="preview-tools">`,
      `<button class="btn btn-sm btn-ghost" id="origBtn">Original</button>`,
      `<button class="btn btn-sm btn-ghost" id="layoutBtn">Current Layout: ${W.esc(layoutLabel(S, p.layout || 'fit'))}</button>`,
      `</div>`,
      `<canvas id="wavecanvas" height="34" style="width:100%;max-width:560px"></canvas>`,
      `<div style="width:100%;max-width:560px;position:relative;height:6px;background:#141b23;border-radius:999px">`,
      `<div id="waveCursor" style="position:absolute;top:0;bottom:0;width:2px;background:var(--green);left:0"></div></div>`,
      `</div>`,
      `<div class="tl">`,
      `<div class="tl-bar">`,
      `<button class="btn btn-sm" id="splitBtn" title="Split at playhead (S)">✂ Split</button>`,
      `<button class="btn btn-sm" id="dupBtn" title="Duplicate (Ctrl+D)">⧉ Duplicate</button>`,
      `<button class="btn btn-sm btn-danger" id="delBtn" title="Delete (Del)">🗑 Delete</button>`,
      `<div class="tl-transport"><button class="mini" id="playBtn">▶</button>`,
      `<span class="tl-time" id="tlTime">00:00:00.00 / 00:00:00.00</span></div>`,
      `<div class="row">`,
      `<button class="mini on" id="snapBtn" title="Snap / ripple">🔗</button>`,
      `<button class="mini on" id="ccBtn" title="Subtitle track">CC</button>`,
      `<button class="mini" id="zoomOut" title="Zoom out">−</button>`,
      `<input type="range" id="zoomRange" min="0.3" max="8" step="0.1" value="${S.zoom}">`,
      `<button class="mini" id="zoomIn" title="Zoom in">+</button>`,
      `<button class="mini" id="fitBtn" title="Fit to screen">⤢</button>`,
      `<button class="mini" id="fullBtn" title="Fullscreen preview">⛶</button>`,
      `</div></div>`,
      `<div class="tl-body">`,
      `<div class="tl-controls" id="tlControls"></div>`,
      `<div class="tl-scroll" id="tlScroll"><div class="tl-inner" id="tlInner"></div></div>`,
      `</div></div></div></div></div>`,
    ]);
  }

  function aspectAr(S) {
    const key = (S.project || {}).aspect || '9:16';
    const spec = ((S.meta || {}).aspects || []).find((a) => a.key === key) || { w: 9, h: 16 };
    return `${spec.w}/${spec.h}`;
  }

  function layoutLabel(S, key) {
    const item = ((S.meta && S.meta.layouts) || []).find((l) => l.key === key);
    return item ? item.label : key;
  }

  V.render_editor = function (main, W) {
    const S = W.S;
    if (!S.project) {
      main.innerHTML = `<div class="page"><h1>No project open</h1>
        <p class="lead">Start in the Video Editor or open a project from the Library.</p>
        <div class="row"><button class="btn btn-green" id="goStart">Video Editor</button>
        <button class="btn" id="goLib">Open Library</button></div></div>`;
      main.querySelector('#goStart').onclick = () => W.showPage('start');
      main.querySelector('#goLib').onclick = () => W.showPage('library');
      return;
    }
    main.classList.add('editing');
    main.innerHTML = editorMarkup(S);
    wireEditor(main, W);
    V.renderTimeline(W);
    W.renderPanel();
    drawWaveform(W);
    requestAnimationFrame(() => W.drawFrame(S.playhead));
  };

  V.renderEditorShell = function (W) {
    const main = document.querySelector('#main');
    if (main && W.S.page === 'editor') V.render_editor(main, W);
  };

  function wireEditor(main, W) {
    const S = W.S;
    main.querySelector('#railScroll').innerHTML = railButtons(S);
    main.querySelectorAll('[data-tool]').forEach((btn) => {
      btn.onclick = () => { S.tool = btn.dataset.tool; V.render_editor(host(), W); };
    });
    const host = () => document.querySelector('#main');
    main.querySelector('#railDown').onclick = () => { const r = main.querySelector('#railScroll'); r.scrollTop += 140; };
    main.querySelector('#railUp').onclick = () => { const r = main.querySelector('#railScroll'); r.scrollTop -= 140; };

    const title = main.querySelector('#projectTitle');
    title.onchange = () => {
      W.mutate('Rename project', (p) => { p.name = title.value; });
    };
    title.onkeydown = (e) => { if (e.key === 'Enter') title.blur(); };
    main.querySelector('#backBtn').onclick = () => W.showPage('library');
    main.querySelector('#menuBtn').onclick = () => W.showPage('home');
    main.querySelector('#undoBtn').onclick = W.undo;
    main.querySelector('#redoBtn').onclick = W.redo;
    main.querySelector('#shortcutsBtn').onclick = () => W.openModal('shortcuts');
    main.querySelector('#publishBtn').onclick = () => W.openModal('publish');
    main.querySelector('#exportBtn').onclick = () => W.openModal('export');
    main.querySelector('#layoutBtn').onclick = () => W.openModal('layout');

    const orig = main.querySelector('#origBtn');
    let showingOriginal = false;
    orig.onclick = () => {
      showingOriginal = !showingOriginal;
      orig.classList.toggle('on', showingOriginal);
      const video = W.loadSource();
      if (showingOriginal && video) {
        W.pause();
        orig.textContent = 'Showing original';
        const box = main.querySelector('#previewBox');
        const overlay = document.createElement('video');
        overlay.src = W.mediaUrl((S.project.source || {}).media || '');
        overlay.controls = true;
        overlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;background:#000;z-index:5';
        overlay.id = 'origOverlay';
        box.appendChild(overlay);
      } else {
        orig.textContent = 'Original';
        const overlay = main.querySelector('#origOverlay');
        if (overlay) overlay.remove();
      }
    };

    main.querySelector('#qualityBadge').onclick = () => {
      S.quality = S.quality === 'preview' ? 'full' : 'preview';
      main.querySelector('#qualityBadge').textContent = S.quality === 'preview' ? 'Low-res Preview' : 'Full Preview';
      W.toast('Preview quality', S.quality === 'preview' ? 'Low-res proxy for smooth scrubbing' : 'Full resolution preview');
    };

    // ---- transport
    main.querySelector('#playBtn').onclick = () => (S.playing ? W.pause() : W.play());
    main.querySelector('#zoomIn').onclick = () => { S.zoom = W.clamp(S.zoom * 1.4, 0.3, 8); syncZoom(main); };
    main.querySelector('#zoomOut').onclick = () => { S.zoom = W.clamp(S.zoom / 1.4, 0.3, 8); syncZoom(main); };
    main.querySelector('#zoomRange').oninput = (e) => { S.zoom = Number(e.target.value); V.renderTimeline(W); };
    main.querySelector('#fitBtn').onclick = () => {
      const tl = W.timeline();
      const width = main.querySelector('#tlScroll').clientWidth - 30;
      S.zoom = W.clamp(width / Math.max(1, tl.duration) / 46, 0.3, 8);
      syncZoom(main);
    };
    main.querySelector('#fullBtn').onclick = () => {
      const box = main.querySelector('#previewBox');
      if (!document.fullscreenElement) box.requestFullscreen && box.requestFullscreen();
      else document.exitFullscreen();
    };
    main.querySelector('#snapBtn').onclick = (e) => { S.snap = !S.snap; e.currentTarget.classList.toggle('on', S.snap); };
    main.querySelector('#ccBtn').onclick = (e) => { S.showSubs = !S.showSubs; e.currentTarget.classList.toggle('on', S.showSubs); V.renderTimeline(W); };

    // ---- edit actions
    main.querySelector('#splitBtn').onclick = () => splitAtPlayhead(W);
    main.querySelector('#dupBtn').onclick = () => duplicateSelection(W);
    main.querySelector('#delBtn').onclick = () => deleteSelection(W);
    W.updateTransport();
  }

  function syncZoom(main) {
    const W = WV();
    const range = main.querySelector('#zoomRange');
    if (range) range.value = String(W.S.zoom);
    V.renderTimeline(W);
  }

  function hostW() { return window.WVE_STATE; }

  function splitAtPlayhead(W) {
    const S = W.S;
    const tl = W.timeline();
    const seg = tl.at(S.playhead);
    if (!seg) { W.toast('Nothing to split', 'move the playhead over a clip', 'warn'); return; }
    const src = tl.toSource(S.playhead);
    if (src == null || src - seg.srcStart < 0.15 || seg.srcEnd - src < 0.15) {
      W.toast('Too short to split', 'need at least 0.15s on both sides', 'warn');
      return;
    }
    W.mutate('Split clip', (p) => {
      const index = p.clips.findIndex((c) => c.id === seg.clipId);
      if (index < 0) return;
      const clip = p.clips[index];
      const right = JSON.parse(JSON.stringify(clip));
      right.id = `${clip.id}_b`;
      right.start = src;
      right.effects = (clip.effects || []).filter((e) => Number(e.end) > src);
      clip.end = src;
      clip.effects = (clip.effects || []).filter((e) => Number(e.start) < src);
      p.clips.splice(index + 1, 0, right);
    });
    W.toast('Split', 'the clip is now two items');
  }

  function duplicateSelection(W) {
    const S = W.S;
    if (S.selection.track === 'videos' && S.selection.clip) {
      W.mutate('Duplicate clip', (p) => {
        const index = p.clips.findIndex((c) => c.id === S.selection.clip);
        if (index < 0) return;
        const copy = JSON.parse(JSON.stringify(p.clips[index]));
        copy.id = `${copy.id}_copy`;
        p.clips.splice(index + 1, 0, copy);
      });
      return;
    }
    const map = { text: 'texts', hook: 'hooks', broll: 'broll', audio: 'audio_items' };
    const key = map[S.selection.track];
    if (key && S.selection.item) {
      W.mutate('Duplicate item', (p) => {
        const list = S.selection.track === 'audio'
          ? (((p.audio || {}).items) || [])
          : (p[key] || []);
        const item = list.find((i) => i.id === S.selection.item);
        if (!item) return;
        const copy = JSON.parse(JSON.stringify(item));
        copy.id = `${copy.id}_copy`;
        list.push(copy);
      });
      return;
    }
    W.toast('Nothing selected', 'select a clip or an item first', 'warn');
  }

  function deleteSelection(W) {
    const S = W.S;
    if (S.selection.track === 'videos' && S.selection.clip) {
      W.mutate('Delete clip', (p) => {
        p.clips = p.clips.filter((c) => c.id !== S.selection.clip);
      });
      S.selection.clip = null;
      return;
    }
    const map = { text: 'texts', hook: 'hooks', broll: 'broll' };
    const key = map[S.selection.track];
    if (key && S.selection.item) {
      W.mutate('Delete item', (p) => { p[key] = (p[key] || []).filter((i) => i.id !== S.selection.item); });
      S.selection.item = null;
      return;
    }
    if (S.selection.track === 'audio' && S.selection.item) {
      W.mutate('Delete audio', (p) => {
        if (p.audio && p.audio.items) p.audio.items = p.audio.items.filter((i) => i.id !== S.selection.item);
      });
      S.selection.item = null;
      return;
    }
    W.toast('Nothing selected', 'select a clip or an item first', 'warn');
  }

  /* ============================================================== timeline */
  function itemsFor(S, track) {
    const W = WV();
    const p = S.project || {};
    switch (track) {
      case 'videos': return W.clipSegments(p).map((s) => ({ id: s.clipId, start: s.outStart, end: s.outEnd,
        label: layoutLabel(S, s.clip.layout || p.layout || 'fit'), clip: s.clip }));
      case 'subtitles': return W.subtitleLines().map((l) => ({ id: `sub_${l.id}`, start: l.outStart,
        end: l.outEnd, label: l.text, item: l }));
      case 'text': return (p.texts || []).map((t) => ({ id: t.id, start: t.start, end: t.end, label: t.text, item: t }));
      case 'hook': return (p.hooks || []).map((t) => ({ id: t.id, start: t.start, end: t.end, label: t.text, item: t }));
      case 'broll': return (p.broll || []).map((t) => ({ id: t.id, start: t.start, end: t.end, label: t.query || 'B-roll', item: t }));
      case 'audio': return ((((p.audio || {}).items) || []).filter((i) => i.kind !== 'sfx'))
        .map((t) => ({ id: t.id, start: t.start, end: t.end, label: t.name || 'Music', item: t }));
      case 'sfx': return ((((p.audio || {}).items) || []).filter((i) => i.kind === 'sfx'))
        .map((t) => ({ id: t.id, start: t.start, end: t.end, label: t.name || 'SFX', item: t }));
      case 'effects': {
        const out = [];
        W.clipSegments(p).forEach((s) => (s.clip.effects || []).forEach((e) => out.push({
          id: `${s.clipId}_${e.id || e.type}`, start: Number(e.start || s.srcStart), end: Number(e.end || s.srcEnd),
          label: effectLabel(S, e.type), clipId: s.clipId, item: e, effect: true,
        })));
        return out;
      }
      default: return [];
    }
  }

  function effectLabel(S, key) {
    const item = ((S.meta && S.meta.effects) || []).find((e) => e.key === key);
    return item ? item.label : key;
  }

  V.renderTimeline = function (W) {
    const S = W.S;
    const inner = document.querySelector('#tlInner');
    const controls = document.querySelector('#tlControls');
    if (!inner || !S.project) return;
    const tl = W.timeline();
    const px = W.pxPerSec();
    const width = Math.max(600, tl.duration * px + 120);
    inner.style.width = `${width}px`;

    // ruler
    let stepChoice = 1;
    [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].some((candidate) => {
      stepChoice = candidate;
      return candidate * px > 62;
    });
    const ticks = [];
    for (let t = 0; t <= tl.duration + stepChoice; t += stepChoice) {
      ticks.push(`<div class="tick" style="left:${t * px}px">${W.fmt.clockMs(t).slice(3, 8)}</div>`);
    }

    const rows = TRACKS.filter((track) => track.key !== 'subtitles' || S.showSubs).map((track) => {
      const list = itemsFor(S, track.key);
      const height = track.tall ? 48 : 34;
      const items = list.map((item) => {
        const left = item.start * px;
        const w = Math.max(14, (item.end - item.start) * px);
        const selected = (track.key === 'videos' && S.selection.clip === item.id)
          || (S.selection.track === track.key && S.selection.item === item.id);
        const thumbs = track.key === 'videos' ? thumbnailStrip(W, S, item, w) : '';
        return `<div class="item ${track.type} ${selected ? 'selected' : ''}"
            data-track="${track.key}" data-id="${W.esc(item.id)}" data-start="${item.start}" data-end="${item.end}"
            style="left:${left}px;width:${w}px" title="${W.esc(item.label || '')}">
            ${thumbs}<div class="cap">${W.esc(String(item.label || '').slice(0, 60))}</div>
            <div class="handle l" data-handle="l"></div><div class="handle r" data-handle="r"></div>
          </div>`;
      }).join('');
      const transitions = track.key === 'videos'
        ? W.clipSegments(S.project).map((seg, i) => {
            const clip = (S.project.clips || [])[i] || {};
            const t = clip.transition || { type: 'none' };
            if (!t.type || t.type === 'none') return '';
            return `<div class="trans" data-trans="${i}" style="left:${seg.outStart * px}px" title="${W.esc(t.type)} ${t.duration || 0.4}s">⇄</div>`;
          }).join('')
        : '';
      const adders = track.key === 'videos'
        ? `<button class="add-item" data-add="start" style="left:2px" title="Add media at the start">+</button>
           <button class="add-item" data-add="end" style="left:${Math.max(40, tl.duration * px + 8)}px" title="Add media at the end">+</button>`
        : '';
      return `<div class="trk ${track.tall ? 'tall' : ''}" data-track="${track.key}" style="height:${height}px">
          <span class="trk-label">${track.label}</span>${items}${transitions}${adders}</div>`;
    }).join('');

    inner.innerHTML = `<div class="ruler" id="ruler">${ticks}</div><div class="tracks">${rows}</div>
      <div class="playhead" id="playhead" style="left:${S.playhead * px}px"></div>`;

    // track control column
    controls.innerHTML = TRACKS.map((track) => {
      const height = track.tall ? 48 : 34;
      const count = itemsFor(S, track.key).length;
      return `<div class="tl-ctl" style="height:${height + 0}px">
        <span class="nm" title="${track.label} (${count})">${track.label}${count ? ` · ${count}` : ''}</span>
        <button class="mini ${S.locks[track.key] ? 'on' : ''}" data-lock="${track.key}" title="Lock">🔒</button>
        <button class="mini ${S.hidden[track.key] ? '' : 'on'}" data-eye="${track.key}" title="Show/Hide">👁</button>
        <button class="mini ${S.muted[track.key] ? '' : 'on'}" data-mute="${track.key}" title="Mute">🔊</button>
      </div>`;
    }).join('');

    wireTimeline(W, px);
    drawWaveform(W);
  };

  function thumbnailStrip(W, S, item, width) {
    const thumbs = (S.project.thumbs || []).slice(0, 8).map((t) => W.mediaUrl(t));
    if (!thumbs.length) return '';
    const count = Math.max(1, Math.min(8, Math.round(width / 70)));
    return `<div class="strip">${Array.from({ length: count }, (_, i) =>
      `<img src="${thumbs[i % thumbs.length]}" alt="">`).join('')}</div>`;
  }

  function wireTimeline(W, px) {
    const S = W.S;
    const inner = document.querySelector('#tlInner');
    const scroll = document.querySelector('#tlScroll');

    inner.querySelector('#ruler').onclick = (e) => {
      const rect = inner.getBoundingClientRect();
      W.seek((e.clientX - rect.left) / px);
    };
    inner.querySelector('#ruler').onpointerdown = (e) => {
      const ruler = inner.querySelector('#ruler');
      const move = (ev) => {
        const rect = inner.getBoundingClientRect();
        W.seek((ev.clientX - rect.left) / px);
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      move(e);
    };

    inner.querySelector('#playhead').onpointerdown = (e) => {
      e.stopPropagation();
      const move = (ev) => {
        const rect = inner.getBoundingClientRect();
        W.seek((ev.clientX - rect.left) / px);
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };

    inner.querySelectorAll('.item').forEach((el) => {
      const track = el.dataset.track;
      const id = el.dataset.id;
      el.onclick = () => {
        if (track === 'videos') S.selection = { clip: id, track: 'videos', item: null };
        else S.selection = { clip: null, track, item: id };
        V.renderTimeline(W);
        W.renderPanel();
      };
      el.onpointerdown = (e) => {
        if (e.target.dataset.handle || S.locks[track]) return;
        e.preventDefault();
        const startX = e.clientX;
        const start = Number(el.dataset.start), end = Number(el.dataset.end);
        const originIndex = track === 'videos' ? (S.project.clips || []).findIndex((c) => c.id === id) : -1;
        const move = (ev) => {
          const delta = (ev.clientX - startX) / px;
          if (Math.abs(delta) < 0.02) return;
          el.style.transform = `translateX(${delta * px}px)`;
          el.dataset.delta = String(delta);
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          const delta = Number(el.dataset.delta || 0);
          el.style.transform = '';
          if (Math.abs(delta) < 0.03) return;
          if (track === 'videos') {
            // dragging a clip reorders it (the timeline is sequential)
            const clips = S.project.clips || [];
            const targetSpan = clips.map((c) => (Number(c.end) - Number(c.start)));
            let index = originIndex;
            let acc = 0;
            const dropAt = (S.project.clips || []).reduce((sum, c) => sum + (Number(c.end) - Number(c.start)), 0);
            void dropAt;
            const pos = Number(el.dataset.start) + delta;
            acc = 0;
            for (let i = 0; i < clips.length; i++) {
              acc += targetSpan[i];
              if (pos < acc - targetSpan[i] / 2 && i !== index) { index = i; break; }
              if (i === clips.length - 1) index = clips.length - 1;
            }
            if (index !== originIndex && index >= 0) {
              W.mutate('Reorder clips', (p) => {
                const [moved] = p.clips.splice(originIndex, 1);
                p.clips.splice(index, 0, moved);
              });
            }
          } else {
            applyShift(W, track, id, delta);
          }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      };
      el.querySelectorAll('.handle').forEach((handle) => {
        handle.onpointerdown = (e) => {
          e.stopPropagation();
          e.preventDefault();
          const side = handle.dataset.handle;
          const startX = e.clientX;
          const start = Number(el.dataset.start), end = Number(el.dataset.end);
          const move = (ev) => {
            const delta = (ev.clientX - startX) / px;
            if (side === 'l') {
              const ns = W.clamp(start + delta, 0, end - 0.15);
              el.style.left = `${ns * px}px`;
              el.style.width = `${Math.max(14, (end - ns) * px)}px`;
              el.dataset.ns = String(ns);
            } else {
              const ne = Math.max(start + 0.15, end + delta);
              el.style.width = `${Math.max(14, (ne - start) * px)}px`;
              el.dataset.ne = String(ne);
            }
          };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            const ns = el.dataset.ns ? Number(el.dataset.ns) : null;
            const ne = el.dataset.ne ? Number(el.dataset.ne) : null;
            if (ns == null && ne == null) return;
            if (track === 'videos') {
              W.mutate('Trim clip', (p) => {
                const clip = (p.clips || []).find((c) => c.id === id);
                if (!clip) return;
                if (ns != null) {
                  const tl = W.timeline();
                  const src = tl.toSource(ns);
                  if (src != null) clip.start = Math.max(0, Math.min(src, Number(clip.end) - 0.15));
                }
                if (ne != null) {
                  const tl = W.timeline();
                  const src = tl.toSource(ne);
                  if (src != null) clip.end = Math.max(Number(clip.start) + 0.15, src);
                }
              });
            } else {
              W.mutate('Resize item', (p) => {
                const list = trackList(p, track);
                const item = list.find((i) => i.id === id);
                if (!item) return;
                if (ns != null) item.start = Math.max(0, ns);
                if (ne != null) item.end = Math.max((item.start || 0) + 0.1, ne);
              });
            }
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        };
      });
    });

    inner.querySelectorAll('.trans').forEach((el) => {
      el.onclick = (e) => {
        e.stopPropagation();
        const index = Number(el.dataset.trans);
        const clip = (S.project.clips || [])[index];
        if (!clip) return;
        W.openModal('transitionPicker', { index, clipId: clip.id });
      };
    });

    inner.querySelectorAll('[data-add]').forEach((el) => {
      el.onclick = (e) => {
        e.stopPropagation();
        S.tool = el.dataset.add === 'start' ? 'upload' : 'elements';
        V.render_editor(document.querySelector('#main'), W);
      };
    });

    document.querySelectorAll('[data-lock]').forEach((el) => {
      el.onclick = () => { S.locks[el.dataset.lock] = !S.locks[el.dataset.lock]; V.renderTimeline(W); };
    });
    document.querySelectorAll('[data-eye]').forEach((el) => {
      el.onclick = () => { S.hidden[el.dataset.eye] = !S.hidden[el.dataset.eye]; V.renderTimeline(W); };
    });
    document.querySelectorAll('[data-mute]').forEach((el) => {
      el.onclick = () => { S.muted[el.dataset.mute] = !S.muted[el.dataset.mute]; V.renderTimeline(W); };
    });
  }

  function trackList(project, track) {
    if (track === 'text') return project.texts || (project.texts = []);
    if (track === 'hook') return project.hooks || (project.hooks = []);
    if (track === 'broll') return project.broll || (project.broll = []);
    if (track === 'audio' || track === 'sfx') {
      project.audio = project.audio || { items: [] };
      return project.audio.items || (project.audio.items = []);
    }
    return [];
  }

  function applyShift(W, track, id, delta) {
    W.mutate('Move item', (p) => {
      const list = trackList(p, track);
      const item = list.find((i) => i.id === id);
      if (!item) return;
      const span = (Number(item.end) || 0) - (Number(item.start) || 0);
      item.start = Math.max(0, (Number(item.start) || 0) + delta);
      item.end = item.start + span;
    });
  }

  V.renderTimelineCursor = function (W) {
    const el = document.querySelector('#playhead');
    if (el) el.style.left = `${W.S.playhead * W.pxPerSec()}px`;
    const scroll = document.querySelector('#tlScroll');
    if (scroll) {
      const x = W.S.playhead * W.pxPerSec();
      if (x < scroll.scrollLeft + 40) scroll.scrollLeft = Math.max(0, x - 80);
      else if (x > scroll.scrollLeft + scroll.clientWidth - 60) scroll.scrollLeft = x - scroll.clientWidth + 120;
    }
    const time = document.querySelector('#tlTime');
    if (time) {
      const tl = W.timeline();
      time.textContent = `${W.fmt.clockMs(W.S.playhead)} / ${W.fmt.clockMs(tl.duration)}`;
    }
    syncWave(W);
  };

  function syncWave(W) {
    const el = document.querySelector('#waveCursor');
    const tl = W.timeline();
    if (el) el.style.left = `${tl.duration ? (W.S.playhead / tl.duration) * 100 : 0}%`;
  }

  function drawWaveform(W) {
    const canvas = document.querySelector('#wavecanvas');
    if (!canvas || !W.S.project) return;
    const peaks = W.S.project.waveform || [];
    const width = canvas.clientWidth || 520;
    canvas.width = width;
    canvas.height = 34;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(0,255,156,.35)';
    if (!peaks.length) {
      ctx.fillStyle = '#2a3541';
      ctx.font = '11px Inter';
      ctx.fillText('waveform unavailable', 8, 21);
      return;
    }
    const step = canvas.width / peaks.length;
    peaks.forEach((peak, i) => {
      const hh = Math.max(1, peak * canvas.height * 0.9);
      ctx.fillRect(i * step, (canvas.height - hh) / 2, Math.max(1, step * 0.7), hh);
    });
  }

  /* ================================================================ pages */
  V.render_home = function (main, W) {
    main.classList.remove('editing');
    main.innerHTML = `
      <div class="page">
        <h1>Home</h1>
        <p class="lead">Recent projects and quick starts. Everything runs on this machine – Whisper, FFmpeg and OpenCV included.</p>
        <div class="grid g4" id="quick"></div>
        <h2>Recent projects</h2>
        <div class="grid g3" id="recent"><div class="muted small">Loading…</div></div>
        <h2>Recent AI Video Clipping</h2>
        <div class="grid g3" id="recentClips"><div class="muted small">Loading…</div></div>
        <h2>Notifications</h2>
        <div class="card" id="notes"><div class="muted small">Loading…</div></div>
      </div>`;
    const quick = [
      { icon: '🎬', title: 'AI Video Editor', body: 'Edit by transcript, reframe, export', href: '#start' },
      { icon: '✂️', title: 'Clip Maker', body: 'Long video → vertical shorts', href: 'clip-maker.html' },
      { icon: '📝', title: 'Summarizer', body: 'Chapters and key points', href: 'studio.html#summarizer' },
      { icon: '💬', title: 'Video to Text', body: 'Transcript + visual breakdown', href: 'studio.html#v2t' },
    ];
    main.querySelector('#quick').innerHTML = quick.map((q) => `
      <a class="card" href="${q.href}"><h3>${q.icon} ${q.title}</h3><div class="muted small">${q.body}</div></a>`).join('');

    (async () => {
      try {
        const { items } = await W.api.get('/api/projects');
        main.querySelector('#recent').innerHTML = items.length ? items.slice(0, 9).map((p) => `
          <div class="card" style="cursor:pointer" data-open="${p.id}">
            <div class="media-thumb" style="background-image:url('${W.mediaUrl(p.poster || p.thumb || '')}')"></div>
            <h3 style="margin-top:10px">${W.esc(p.name)}</h3>
            <div class="muted small">${p.aspect} · ${items.length ? '' : ''}${W.fmt.clock(p.duration || 0)} · updated ${W.fmt.when(p.updated_at)}</div>
            <div class="row" style="margin-top:8px"><span class="tag">${p.exports || 0} exports</span><span class="tag">${W.esc(p.status || 'draft')}</span></div>
          </div>`).join('') : '<div class="empty">No projects yet — paste a link on the start page.</div>';
        main.querySelectorAll('[data-open]').forEach((el) => {
          el.onclick = () => W.openProject(el.dataset.open);
        });
        const notes = await W.api.get('/api/notifications');
        main.querySelector('#notes').innerHTML = notes.items.length
          ? notes.items.slice(0, 6).map((n) => `<div class="spread" style="padding:6px 0;border-bottom:1px dashed rgba(255,255,255,.07)">
              <span>${W.esc(n.title)}<div class="muted tiny">${W.esc(n.body || '')}</div></span>
              <span class="tiny muted">${W.fmt.when(n.at)}</span></div>`).join('')
          : '<div class="muted small">Nothing yet.</div>';
      } catch (e) { W.fail(e); }

      /* history from AI Video Clipping lives on its own endpoint */
      try {
        const clips = await W.api.get('/api/ai-clipping/videos');
        const list = (clips.items || []).slice(0, 6);
        main.querySelector('#recentClips').innerHTML = list.length ? list.map((v) => `
          <a class="card" href="clip-maker.html#results/${encodeURIComponent(v.id)}">
            <div class="media-thumb" style="background-image:url('${W.esc(v.thumb || '')}')"></div>
            <h3 style="margin-top:10px">${W.esc(v.title)}</h3>
            <div class="muted small">${v.moment_count || 0} clips · ${W.fmt.clock(v.duration || 0)} · ${W.esc(v.source_type || v.platform || 'upload')}</div>
          </a>`).join('')
          : '<div class="muted small">No AI clips yet — open <a href="clip-maker.html" style="color:var(--green)">AI Video Clipping</a> to create your first batch.</div>';
      } catch (e) {
        main.querySelector('#recentClips').innerHTML = '<div class="muted small">Clipping history is unavailable right now.</div>';
      }
    })();
  };

  V.render_library = function (main, W) {
    main.classList.remove('editing');
    main.innerHTML = `
      <div class="page">
        <h1>Library</h1>
        <p class="lead">Projects, exports and uploads. Rename, duplicate, delete or reopen anything.</p>
        <div class="row" style="margin-bottom:14px">
          <input class="input" id="libSearch" placeholder="Search projects…" style="max-width:280px">
          <div class="chip-row" id="libTabs">
            <button class="chip active" data-tab="projects">Projects</button>
            <button class="chip" data-tab="exports">Exports</button>
            <button class="chip" data-tab="uploads">Uploads</button>
          </div>
          <button class="btn btn-sm btn-green" id="newProject">+ Video Editor</button>
        </div>
        <div id="libBody"><div class="muted small">Loading…</div></div>
      </div>`;
    let tab = 'projects';
    let query = '';
    const body = main.querySelector('#libBody');

    main.querySelector('#newProject').onclick = () => W.showPage('start');
    main.querySelector('#libSearch').oninput = (e) => { query = e.target.value.toLowerCase(); paint(); };
    main.querySelectorAll('[data-tab]').forEach((el) => {
      el.onclick = () => {
        tab = el.dataset.tab;
        main.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === el));
        paint();
      };
    });

    async function paint() {
      body.innerHTML = '<div class="muted small">Loading…</div>';
      try {
        if (tab === 'projects') {
          const { items } = await W.api.get('/api/projects');
          const list = items.filter((p) => !query || (p.name || '').toLowerCase().includes(query));
          body.innerHTML = list.length ? list.map((p) => `
            <div class="list-item" data-id="${p.id}" style="margin-bottom:10px">
              <div class="th" style="background-image:url('${W.mediaUrl(p.poster || p.thumb || '')}')"></div>
              <div style="flex:1;min-width:0">
                <strong>${W.esc(p.name)}</strong>
                <div class="muted tiny">${p.aspect} · ${W.fmt.clock(p.duration || 0)} · ${p.exports || 0} exports · updated ${W.fmt.when(p.updated_at)}</div>
              </div>
              <div class="row">
                <button class="btn btn-sm" data-open="${p.id}">Open</button>
                <button class="btn btn-sm btn-ghost" data-rename="${p.id}" data-name="${W.esc(p.name)}">Rename</button>
                <button class="btn btn-sm btn-ghost" data-dup="${p.id}">Duplicate</button>
                <button class="btn btn-sm btn-danger" data-del="${p.id}">Delete</button>
              </div>
            </div>`).join('') : '<div class="empty">No projects match.</div>';
        } else {
          const kind = tab === 'exports' ? 'export' : 'file';
          const { items } = await W.api.get(`/api/assets${tab === 'exports' ? '?kind=export' : ''}`);
          const list = items.filter((a) => (tab === 'exports' ? a.kind === 'export' : a.kind !== 'export'))
            .filter((a) => !query || (a.name || '').toLowerCase().includes(query));
          body.innerHTML = list.length ? list.map((a) => `
            <div class="list-item" style="margin-bottom:10px">
              <div class="th" style="background-image:url('${W.mediaUrl(a.thumb || a.media || '')}')"></div>
              <div style="flex:1;min-width:0">
                <strong>${W.esc(a.name || kind)}</strong>
                <div class="muted tiny">${W.esc(a.kind || kind)} · ${W.fmt.bytes(a.size_bytes || 0)} · ${W.fmt.when(a.created_at)}</div>
              </div>
              <div class="row">
                ${a.media ? `<a class="btn btn-sm" href="${W.mediaUrl(a.media)}" target="_blank">Open</a>` : ''}
                <button class="btn btn-sm btn-danger" data-delasset="${a.id}">Delete</button>
              </div>
            </div>`).join('') : `<div class="empty">No ${tab} yet.</div>`;
        }
        body.querySelectorAll('[data-open]').forEach((el) => { el.onclick = () => W.openProject(el.dataset.open); });
        body.querySelectorAll('[data-rename]').forEach((el) => {
          el.onclick = async () => {
            const name = prompt('New name', el.dataset.name);
            if (!name) return;
            await W.api.post(`/api/projects/${el.dataset.rename}/rename`, { name });
            paint();
          };
        });
        body.querySelectorAll('[data-dup]').forEach((el) => {
          el.onclick = async () => { await W.api.post(`/api/projects/${el.dataset.dup}/duplicate`); paint(); };
        });
        body.querySelectorAll('[data-del]').forEach((el) => {
          el.onclick = async () => {
            if (!confirm('Delete this project and its renders?')) return;
            await W.api.del(`/api/projects/${el.dataset.del}`);
            W.toast('Deleted', 'project removed from the library');
            paint();
          };
        });
        body.querySelectorAll('[data-delasset]').forEach((el) => {
          el.onclick = async () => { await W.api.del(`/api/assets/${el.dataset.delasset}`); paint(); };
        });
      } catch (e) { W.fail(e); }
    }
    paint();
  };

  V.render_scheduler = function (main, W) {
    main.classList.remove('editing');
    main.innerHTML = `
      <div class="page">
        <h1>Scheduler</h1>
        <p class="lead">Every publish and scheduled post. Drag a post to another day to reschedule it.</p>
        <div class="row" style="margin-bottom:12px">
          <div class="chip-row" id="viewTabs">
            <button class="chip active" data-view="month">Month</button>
            <button class="chip" data-view="week">Week</button>
          </div>
          <button class="btn btn-sm" id="prevRange">‹</button>
          <strong id="rangeLabel"></strong>
          <button class="btn btn-sm" id="nextRange">›</button>
          <div class="spacer" style="flex:1"></div>
          <span class="chip" id="counts"></span>
        </div>
        <div class="card"><div class="cal" id="cal"></div></div>
      </div>`;
    let view = 'month';
    let offset = 0;
    const cal = main.querySelector('#cal');

    main.querySelectorAll('[data-view]').forEach((el) => {
      el.onclick = () => {
        view = el.dataset.view;
        main.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('active', x === el));
        paint();
      };
    });
    main.querySelector('#prevRange').onclick = () => { offset -= 1; paint(); };
    main.querySelector('#nextRange').onclick = () => { offset += 1; paint(); };

    async function paint() {
      const { items, counts } = await W.api.get('/api/schedule');
      main.querySelector('#counts').textContent = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'no posts';
      const now = new Date();
      const anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (view === 'week') anchor.setDate(anchor.getDate() - anchor.getDay() + offset * 7);
      else anchor.setMonth(anchor.getMonth() + offset, 1);
      const start = new Date(anchor);
      if (view === 'week') start.setDate(anchor.getDate() - anchor.getDay());
      const days = view === 'week' ? 7 : new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
      main.querySelector('#rangeLabel').textContent = view === 'week'
        ? `week of ${start.toLocaleDateString()}`
        : anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

      const cells = [];
      if (view === 'month') {
        const firstDow = new Date(anchor.getFullYear(), anchor.getMonth(), 1).getDay();
        for (let i = 0; i < firstDow; i++) cells.push('<div class="d" style="opacity:.35"></div>');
        for (let d = 1; d <= days; d++) cells.push(dayCell(new Date(anchor.getFullYear(), anchor.getMonth(), d), items));
      } else {
        for (let i = 0; i < 7; i++) {
          const day = new Date(start);
          day.setDate(start.getDate() + i);
          cells.push(dayCell(day, items));
        }
      }
      cal.innerHTML = cells.join('');
      cal.querySelectorAll('.post').forEach((el) => {
        el.draggable = true;
        el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', el.dataset.id); });
        el.onclick = () => editPost(el.dataset.id, items);
      });
      cal.querySelectorAll('.d').forEach((cell) => {
        cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('drag'); });
        cell.addEventListener('dragleave', () => cell.classList.remove('drag'));
        cell.addEventListener('drop', async (e) => {
          e.preventDefault();
          cell.classList.remove('drag');
          const id = e.dataTransfer.getData('text/plain');
          const day = Number(cell.dataset.day);
          if (!id || !day) return;
          const post = items.find((p) => p.id === id);
          const at = new Date(Number(day) * 1000);
          const previous = post ? new Date(post.when * 1000) : new Date();
          at.setHours(previous.getHours(), previous.getMinutes(), 0, 0);
          await W.api.patch(`/api/schedule/${id}`, { when: at.getTime() / 1000 });
          W.toast('Rescheduled', `moved to ${at.toLocaleString()}`);
          paint();
        });
      });
    }

    function dayCell(day, items) {
      const startOfDay = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime() / 1000;
      const endOfDay = startOfDay + 86400;
      const posts = items.filter((p) => p.when >= startOfDay && p.when < endOfDay);
      const isToday = new Date().toDateString() === day.toDateString();
      return `<div class="d ${isToday ? 'today' : ''}" data-day="${startOfDay}">
        <div class="spread"><span>${day.getDate()}</span><span class="tiny">${posts.length || ''}</span></div>
        ${posts.map((p) => `<div class="post" data-id="${p.id}" title="${W.esc(p.title)} · ${p.status}">${p.status === 'published' ? '✅' : p.status === 'failed' ? '⛔' : '🗓'} ${W.esc(p.title).slice(0, 22)}</div>`).join('')}
      </div>`;
    }

    function editPost(id, items) {
      const post = items.find((p) => p.id === id);
      W.openModal('post', { post });
    }

    main.__paint = paint;
    paint();
  };

  V.render_brandkit = function (main, W) {
    main.classList.remove('editing');
    main.innerHTML = `
      <div class="page">
        <h1>Brand Kit</h1>
        <p class="lead">Saved per account and reusable across projects: logos, subtitle and text styles, media, colours and fonts.</p>
        <div id="bkBody"><div class="muted small">Loading…</div></div>
      </div>`;
    const body = main.querySelector('#bkBody');
    const SECTIONS = ['logos', 'subtitle_styles', 'text_styles', 'images', 'videos', 'audio', 'colors', 'fonts'];
    async function paint() {
      const data = await W.api.get('/api/brandkit');
      body.innerHTML = `<div class="grid g3">${SECTIONS.map((section) => `
        <div class="card">
          <div class="spread"><h3>${section.replace(/_/g, ' ')}</h3>
            <div class="row">
              ${['logos', 'images', 'videos', 'audio', 'fonts'].includes(section)
                ? `<label class="btn btn-sm btn-ghost">+ Upload<input type="file" hidden data-upload="${section}"></label>` : ''}
              ${section === 'colors'
                ? `<label class="row small">+ <input type="color" value="#00ff9c" data-color></label>` : ''}
              ${['subtitle_styles', 'text_styles'].includes(section)
                ? `<button class="btn btn-sm btn-ghost" data-savestyle="${section}">+ Save current</button>` : ''}
            </div>
          </div>
          <div style="margin-top:10px" class="grid" id="bk-${section}">
            ${(data.grouped[section] || []).map((item) => `
              <div class="row" style="justify-content:space-between">
                <span class="row">${item.media ? `<img src="${W.mediaUrl(item.media)}" style="width:36px;height:24px;object-fit:cover;border-radius:5px">` : item.color ? `<span style="width:22px;height:22px;border-radius:6px;background:${item.color};display:inline-block"></span>` : '✦'}
                <span class="small">${W.esc(item.name || item.value || section)}</span></span>
                <button class="btn btn-sm btn-ghost" data-del="${item.id}">✕</button>
              </div>`).join('') || '<span class="muted tiny">Nothing saved yet.</span>'}
          </div>
        </div>`).join('')}</div>`;

      body.querySelectorAll('[data-upload]').forEach((input) => {
        input.onchange = async () => {
          const section = input.dataset.upload;
          const fd = new FormData();
          fd.append('file', input.files[0]);
          fd.append('section', section);
          await W.api.post('/api/brandkit/upload', fd);
          paint();
        };
      });
      body.querySelectorAll('[data-color]').forEach((input) => {
        input.onchange = async () => {
          await W.api.post('/api/brandkit', { section: 'colors', name: input.value, color: input.value, value: input.value });
          paint();
        };
      });
      body.querySelectorAll('[data-savestyle]').forEach((btn) => {
        btn.onclick = async () => {
          const section = btn.dataset.savestyle;
          const style = section === 'subtitle_styles'
            ? { preset: (W.S.project || {}).subtitles ? W.S.project.subtitles.preset : '', style: W.subtitleStyle() }
            : { preset: 'custom', style: { font: 'Montserrat' } };
          await W.api.post('/api/brandkit', { section, name: `${section === 'subtitle_styles' ? 'Subtitle' : 'Text'} style`, style });
          paint();
        };
      });
      body.querySelectorAll('[data-del]').forEach((btn) => {
        btn.onclick = async () => { await W.api.del(`/api/brandkit/${btn.dataset.del}`); paint(); };
      });
    }
    paint().catch((e) => W.fail(e));
  };

  V.render_pricing = function (main, W) {
    main.classList.remove('editing');
    main.innerHTML = `<div class="page"><h1>Pricing</h1>
      <p class="lead">Credits are spent per action: the price is shown before it runs and deducted after it succeeds.</p>
      <div id="plans" class="grid g3"></div>
      <h2>Credit ledger</h2>
      <div class="card" id="ledger"></div></div>`;
    (async () => {
      const data = await W.api.get('/api/pricing');
      const credits = await W.api.get('/api/credits');
      main.querySelector('#plans').innerHTML = data.plans.map((plan) => `
        <div class="card">
          <div class="spread"><h3>${W.esc(plan.name)}</h3>${plan.id === data.current ? '<span class="chip active">Current</span>' : ''}</div>
          <div style="font-size:26px;font-family:var(--display);margin:8px 0">$${plan.price}<span class="muted small">/mo</span></div>
          <div class="muted small">${plan.credits.toLocaleString()} credits per month</div>
          <ul class="muted small" style="margin:12px 0 0 16px;padding:0">${plan.features.map((f) => `<li>${W.esc(f)}</li>`).join('')}</ul>
          <button class="btn ${plan.id === data.current ? '' : 'btn-green'} btn-block" style="margin-top:14px" data-plan="${plan.id}">
            ${plan.id === data.current ? 'Current plan' : `Switch to ${W.esc(plan.name)}`}</button>
        </div>`).join('');
      main.querySelectorAll('[data-plan]').forEach((btn) => {
        btn.onclick = async () => {
          await W.api.post('/api/pricing/plan', { plan: btn.dataset.plan });
          W.refreshCredits();
          W.toast('Plan updated', 'credits added to the balance');
          V.render_pricing(main, W);
        };
      });
      const unlim = !!credits.unlimited;
      main.querySelector('#ledger').innerHTML = `
        <div class="spread"><span>Balance <b>${unlim ? '∞' : credits.balance}</b></span><span class="muted small">${unlim ? 'Unlimited · ' : ''}${credits.plan_name} · ${unlim ? 'billing off' : credits.spent + ' spent'}</span></div>
        ${unlim ? '' : `<div class="bar" style="margin:10px 0"><i style="width:${credits.used_percent}%"></i></div>`}
        <div style="margin-top:10px">${(credits.ledger || []).slice(0, 12).map((l) => `
          <div class="spread tiny" style="padding:4px 0;border-bottom:1px dashed rgba(255,255,255,.06)">
            <span>${W.esc(l.action)}</span><span class="cost">${l.amount > 0 ? '-' : '+'}${Math.abs(l.amount)}</span></div>`).join('') || '<span class="muted small">No activity yet.</span>'}</div>
        <h2 style="font-size:15px;margin-top:18px">Action prices</h2>
        <div class="grid g4 tiny">${Object.entries(credits.costs || credits.prices ? (credits.prices ? {} : {}) : {}).map(() => '').join('')}</div>`;
      const costHost = main.querySelector('#ledger');
      const costs = (credits.costs || (credits.prices || {}).costs || {});
      costHost.insertAdjacentHTML('beforeend', `<div class="grid g4" style="margin-top:10px">${Object.entries(costs).map(([k, v]) => `
        <div class="spread"><span class="small">${W.esc(v.label || k)}</span><span class="cost">${v.cost}${v.free ? ' · free' : ' ◆'}</span></div>`).join('')}</div>`);
    })().catch((e) => W.fail(e));
  };

  V.render_rewards = function (main, W) {
    main.classList.remove('editing');
    main.innerHTML = `<div class="page"><h1>Rewards</h1>
      <p class="lead">Earn credits for referrals and for finishing tasks. Claims are one-off and recorded on the server.</p>
      <div class="card spread"><span>Balance <b id="rwBalance">…</b></span><span class="small muted" id="rwRef"></span></div>
      <div class="grid g3" style="margin-top:16px" id="rwTasks"></div></div>`;
    (async () => {
      const data = await W.api.get('/api/rewards');
      main.querySelector('#rwBalance').textContent = data.unlimited ? '∞' : data.balance;
      main.querySelector('#rwRef').textContent = data.referral_link;
      main.querySelector('#rwTasks').innerHTML = data.tasks.map((t) => `
        <div class="card">
          <h3>${W.esc(t.label)}</h3>
          <div class="muted small">${t.cadence} · +${t.credits} credits</div>
          <button class="btn btn-sm ${t.claimed ? '' : 'btn-green'} btn-block" style="margin-top:12px" data-claim="${t.id}" ${t.claimed ? 'disabled' : ''}>
            ${t.claimed ? 'Claimed' : 'Claim'}</button>
        </div>`).join('');
      main.querySelectorAll('[data-claim]').forEach((btn) => {
        btn.onclick = async () => {
          try {
            const res = await W.api.post('/api/rewards/claim', { id: btn.dataset.claim });
            W.toast('Claimed', `balance is now ${res.balance}`);
            W.refreshCredits();
            V.render_rewards(main, W);
          } catch (e) { W.fail(e); }
        };
      });
    })().catch((e) => W.fail(e));
  };

  /* =============================================================== modals */
  W_modal('shortcuts', () => `
    <button class="modal-x" data-close>✕</button>
    <h3>Keyboard shortcuts</h3>
    <p class="m-sub">These work anywhere in the editor.</p>
    <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
      ${[['Space', 'Play / pause'], ['← / →', 'Step 1 second'], ['Shift + ← / →', 'Step 5 seconds'],
         ['S', 'Split at playhead'], ['Delete', 'Delete selection'], ['Ctrl/Cmd + D', 'Duplicate'],
         ['Ctrl/Cmd + Z', 'Undo'], ['Ctrl/Cmd + Shift + Z', 'Redo'], ['Ctrl/Cmd + S', 'Save now'],
         ['+ / -', 'Zoom timeline'], ['F', 'Fit timeline'], ['Esc', 'Close dialog']]
        .map(([k, v]) => `<div class="spread small"><span>${v}</span><span class="kbd">${k}</span></div>`).join('')}
    </div>`);

  W_modal('layout', (data) => {
    const S = hostW().S;
    const aspects = (S.meta && S.meta.aspects) || [];
    const layouts = (S.meta && S.meta.layouts) || [];
    return `
    <button class="modal-x" data-close>✕</button>
    <h3>Layout & aspect</h3>
    <p class="m-sub">Applies to the ${data.clipId ? 'selected clip' : 'whole project'}.</p>
    <label class="lbl">Aspect ratio</label>
    <div class="chip-row" data-aspects>
      ${aspects.map((a) => `<button class="chip ${(S.project.aspect === a.key) ? 'active' : ''}" data-aspect="${a.key}">${W.esc(a.label)}</button>`).join('')}
    </div>
    <label class="lbl">Layout</label>
    <div class="grid g4" data-layouts>
      ${layouts.map((l) => `
        <div class="card" style="cursor:pointer" data-layout="${l.key}">
          <div class="preview" style="aspect-ratio:9/16;background:#05080b;border-radius:8px;position:relative;height:120px">
            ${layoutPreview(l.key)}
          </div>
          <strong class="small" style="display:block;margin-top:8px">${W.esc(l.label)}</strong>
          <span class="tiny muted">${W.esc(l.blurb || '')}</span>
        </div>`).join('')}
    </div>`;
  }, (data) => {
    const W = hostW();
    const main = document.querySelector('#main');
    const host = document.querySelector('#modalHost');
    host.querySelectorAll('[data-aspect]').forEach((btn) => {
      btn.onclick = () => {
        W.mutate('Set aspect', (p) => { p.aspect = btn.dataset.aspect; });
        W.closeModal();
        V.render_editor(main, W);
      };
    });
    host.querySelectorAll('[data-layout]').forEach((btn) => {
      btn.onclick = () => {
        const key = btn.dataset.layout;
        if (data && data.clipId) {
          W.mutate('Set clip layout', (p) => {
            const clip = (p.clips || []).find((c) => c.id === data.clipId);
            if (clip) clip.layout = key;
          });
        } else {
          W.mutate('Set layout', (p) => {
            p.layout = key;
            (p.clips || []).forEach((c) => { if (!c.layout) c.layout = key; });
          });
        }
        W.closeModal();
        V.render_editor(main, W);
      };
    });
  });

  function layoutPreview(key) {
    const box = 'position:absolute;background:#1f2c38;border:1px solid #31424f;border-radius:2px';
    if (key === 'split') return `<div style="${box};left:8%;right:8%;top:8%;height:38%"></div><div style="${box};left:8%;right:8%;top:50%;height:38%"></div>`;
    if (key === 'trio') return [8, 40, 72].map((t) => `<div style="${box};left:8%;right:8%;top:${t}%;height:20%"></div>`).join('');
    if (key === 'grid') return [[8, 8], [52, 8], [8, 52], [52, 52]].map(([l, t]) => `<div style="${box};left:${l}%;top:${t}%;width:40%;height:40%"></div>`).join('');
    if (key === 'pip') return `<div style="${box};inset:8%"></div><div style="${box};right:12%;bottom:12%;width:34%;height:24%"></div>`;
    if (key === 'blur') return `<div style="${box};inset:0;background:#243240"></div><div style="position:absolute;left:12%;right:12%;top:26%;bottom:26%;background:#0d141b;border:1px solid #31424f"></div>`;
    if (key === 'full') return `<div style="${box};inset:0"></div>`;
    return `<div style="position:absolute;inset:0;background:#121a22"></div><div style="position:absolute;left:10%;right:10%;top:28%;bottom:28%;background:#1f2c38;border:1px solid #31424f"></div>`;
  }

  W_modal('transitionPicker', (data) => {
    const S = hostW().S;
    const transitions = (S.meta && S.meta.transitions) || [];
    const clip = (S.project.clips || [])[data.index] || {};
    const current = (clip.transition || {}).type || 'none';
    return `
    <button class="modal-x" data-close>✕</button>
    <h3>Transition into clip ${data.index + 1}</h3>
    <p class="m-sub">Dropped on the junction between the previous clip and this one.</p>
    <div class="grid g4">
      ${transitions.map((t) => `
        <div class="card" style="cursor:pointer;${t.key === current ? 'border-color:rgba(0,255,156,.5)' : ''}" data-transition="${t.key}">
          <strong class="small">${W.esc(t.label)}</strong><div class="tiny muted">${W.esc(t.blurb || '')}</div>
        </div>`).join('')}
    </div>
    <label class="lbl">Duration (seconds)</label>
    <input class="input" type="number" min="0.1" max="2" step="0.1" id="transDur" value="${(clip.transition || {}).duration || 0.4}">
    <div class="row" style="margin-top:14px"><button class="btn btn-green" id="transApply">Apply</button>
      <button class="btn btn-ghost" id="transRemove">Remove transition</button></div>`;
  }, (data) => {
    const W = hostW();
    const host = document.querySelector('#modalHost');
    const main = document.querySelector('#main');
    host.querySelectorAll('[data-transition]').forEach((el) => {
      el.onclick = () => { host.dataset.pick = el.dataset.transition; host.querySelectorAll('[data-transition]').forEach((x) => x.style.borderColor = x === el ? 'rgba(0,255,156,.5)' : ''); };
    });
    host.querySelector('#transApply').onclick = () => {
      const type = host.dataset.pick || ((W.S.project.clips || [])[data.index] || {}).transition?.type || 'fade';
      const duration = Number(host.querySelector('#transDur').value) || 0.4;
      W.mutate('Set transition', (p) => {
        const clip = (p.clips || [])[data.index];
        if (clip) clip.transition = { type, duration };
      });
      W.closeModal();
      V.render_editor(main, W);
    };
    host.querySelector('#transRemove').onclick = () => {
      W.mutate('Remove transition', (p) => {
        const clip = (p.clips || [])[data.index];
        if (clip) clip.transition = { type: 'none', duration: 0.4 };
      });
      W.closeModal();
      V.render_editor(main, W);
    };
  });

  W_modal('post', (data) => {
    const post = data.post || {};
    return `
    <button class="modal-x" data-close>✕</button>
    <h3>${W_esc(post.title || 'Post')}</h3>
    <p class="m-sub">${(post.platforms || []).join(', ')} · status ${W_esc(post.status || 'draft')}</p>
    <div class="err" hidden id="postErr"></div>
    <label class="lbl">Title</label><input class="input" id="postTitle" value="${W_esc(post.title || '')}">
    <label class="lbl">Description</label><textarea class="input" id="postDesc" rows="3">${W_esc(post.description || '')}</textarea>
    <label class="lbl">Hashtags</label><input class="input" id="postTags" value="${W_esc((post.hashtags || []).join(' '))}">
    <label class="lbl">When</label><input class="input" type="datetime-local" id="postWhen" value="${toLocalInput(post.when)}">
    <div class="row" style="margin-top:14px">
      <button class="btn btn-green" id="postSave">Save</button>
      <button class="btn" id="postNow">Publish now</button>
      <button class="btn btn-danger" id="postDelete">Delete</button>
    </div>`;
  }, (data) => {
    const W = hostW();
    const host = document.querySelector('#modalHost');
    const post = data.post || {};
    const err = host.querySelector('#postErr');
    host.querySelector('#postSave').onclick = async () => {
      try {
        await W.api.patch(`/api/schedule/${post.id}`, {
          title: host.querySelector('#postTitle').value,
          description: host.querySelector('#postDesc').value,
          hashtags: host.querySelector('#postTags').value.split(/\s+/).filter(Boolean),
          when: new Date(host.querySelector('#postWhen').value).getTime() / 1000,
        });
        W.closeModal();
        W.showPage('scheduler');
      } catch (e) { W.fail(e, { el: err }); }
    };
    host.querySelector('#postNow').onclick = async () => {
      try {
        await W.api.post('/api/publish/now', { post_id: post.id });
        W.toast('Published', 'the post was sent');
        W.closeModal();
        W.showPage('scheduler');
      } catch (e) {
        err.hidden = false;
        err.textContent = e.message;
        W.toast('Publish failed', e.message, 'err');
      }
    };
    host.querySelector('#postDelete').onclick = async () => {
      await W.api.del(`/api/schedule/${post.id}`);
      W.closeModal();
      W.showPage('scheduler');
    };
  });

  function toLocalInput(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /* ============================================================== exports */
  function registerModal(kind, html, wire) { hostW().modal(kind, html, wire); }
  function W_modal(kind, html, wire) {
    // modals are registered once the state object exists; queue until then
    const register = () => registerModal(kind, html, wire);
    if (window.WVE_STATE) register();
    else document.addEventListener('DOMContentLoaded', register, { once: true });
  }
  const W_esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  window.WVE_VIEWS = V;
})();

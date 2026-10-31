/* ==========================================================================
   WayinVideo AI Video Editor — tool panels + dialogs
   Every rail button has a panel here. Buttons call real endpoints; each one
   shows its credit cost before running and reports failures honestly (missing
   provider keys come back as "Needs a key", empty balance as the upgrade modal).
   ========================================================================== */
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {
    const W = window.WVE_STATE;
    if (!W) return;
    const S = W.S;
    const esc = W.esc;
    const clamp = W.clamp;
    const fmt = W.fmt;

    /* ---------------------------------------------------------- helpers */
    const cost = (action) => {
      const costs = ((S.meta || {}).credits || {}).costs || {};
      const item = costs[action];
      if (!item || !item.cost) return '';
      return `<span class="cost" title="${esc(item.label || action)}">${item.cost}${item.free ? ' · free' : ' ◆'}</span>`;
    };
    const diamond = (action) => {
      const item = ((S.meta || {}).credits || {}).costs || {};
      return item[action] && item[action].free ? '' : '<span class="diamond" title="Paid feature">◆</span>';
    };
    const panelHtml = (blocks) => blocks.filter(Boolean).join('');
    const sec = (title, inner, note) => `<div class="sec"><h4>${esc(title)}${note || ''}</h4>${inner}</div>`;
    const itemRow = (title, sub, control) => `<div class="item"><div class="txt"><strong>${title}</strong>
      ${sub ? `<small>${sub}</small>` : ''}</div><div class="row">${control || ''}</div></div>`;
    const sw = (key, on, attr) => `<label class="switch"><input type="checkbox" ${on ? 'checked' : ''} ${attr || ''}>
      <span class="track-sw"></span></label>`;

    async function run(btn, promise, ok) {
      const original = btn ? btn.innerHTML : '';
      if (btn) { btn.disabled = true; btn.innerHTML = 'Working…'; }
      try {
        const res = await promise;
        if (ok) ok(res);
        return res;
      } catch (err) {
        W.fail(err);
        return null;
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = original; }
      }
    }

    function selectedClip() {
      const id = S.selection.clip;
      if (!id) return null;
      return (S.project.clips || []).find((c) => c.id === id) || null;
    }
    function guardSelectClip(btn) {
      if (selectedClip()) return true;
      W.toast('Select a clip', 'click a clip on the video track first', 'warn');
      return false;
    }
    function selectedTextItem() {
      if (S.selection.track === 'text') return (S.project.texts || []).find((t) => t.id === S.selection.item) || null;
      if (S.selection.track === 'hook') return (S.project.hooks || []).find((t) => t.id === S.selection.item) || null;
      return null;
    }
    function audioItem() {
      const items = ((S.project.audio || {}).items) || [];
      return items.find((i) => i.id === S.selection.item) || null;
    }
    const srtTime = (t, comma) => {
      const ms = Math.floor((t - Math.floor(t)) * 1000);
      const s = Math.floor(t) % 60, m = Math.floor(t / 60) % 60, hh = Math.floor(t / 3600);
      const p = (n, len) => String(n).padStart(len || 2, '0');
      return `${p(hh)}:${p(m)}:${p(s)}${comma ? ',' : '.'}${p(ms, 3)}`;
    };
    function download(name, text, mime) {
      const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    }
    /** Mapped subtitle lines on the output timeline (what the export burns). */
    function outLines() {
      const tl = W.timeline();
      return (S.project.subtitles.lines || []).map((line) => {
        const start = tl.toOutput(Number(line.start));
        const end = tl.toOutput(Number(line.end));
        if (start == null) return null;
        return { ...line, outStart: start, outEnd: end == null ? start + 0.4 : end };
      }).filter(Boolean);
    }

    /** Cut a source-time range out of the timeline (splits overlapping clips). */
    function cutSourceRange(start, end, label) {
      W.mutate(label || 'Cut range', (p) => {
        const clips = p.clips || [];
        const out = [];
        clips.forEach((clip) => {
          const a = Number(clip.start), b = Number(clip.end);
          if (end <= a + 0.02 || start >= b - 0.02) { out.push(clip); return; }
          const head = { ...clip, id: `${clip.id}_h${Math.random().toString(36).slice(2, 6)}`, start: a, end: Math.max(a, start) };
          const tail = { ...clip, id: `${clip.id}_t${Math.random().toString(36).slice(2, 6)}`, start: Math.min(b, end), end: b };
          if (head.end - head.start > 0.12) out.push(head);
          if (tail.end - tail.start > 0.12) out.push({ ...tail, transition: { type: 'none', duration: 0.3 } });
        });
        p.clips = out;
        p.deleted = p.deleted || [];
        p.deleted.push({ start, end, label: label || 'cut' });
      });
    }

    /* ============================================================== AI TOOLS */
    W.panel('ai', {
      title: 'AI Tools',
      blurb: 'One-click actions. Each shows its credit cost before it runs.',
      render(el) {
        el.innerHTML = panelHtml([
          sec('Sound Good', [
            itemRow('Enhance Speech', 'Noise reduction, voice clarity, loudness normalisation',
              `${cost('enhance_speech')}${sw('enhance', !!((S.project.audio || {}).enhance), 'data-enhance')}`),
            `<div id="abPlayer"></div>`,
            itemRow('Remove Filler Words', 'Detects um / uh / like / matlab and cuts them',
              `${cost('remove_filler')}<button class="btn btn-sm" data-act="fillers">Detect</button>`),
            `<div id="fillerBox"></div>`,
            itemRow('Remove Silences', 'Dead air above the threshold',
              `${cost('remove_silence')}<button class="btn btn-sm" data-act="silences">Detect</button>`),
            `<div class="row small" style="margin-top:8px">
               <label>Threshold <input class="input" type="number" id="silDb" value="-30" style="width:80px"></label>
               <label>Min length <input class="input" type="number" id="silMin" value="1" step="0.1" style="width:80px"></label>
             </div>`,
            `<div id="silenceBox"></div>`,
          ].join('')),
          sec('Look Good', [
            itemRow('Reframe', 'Resize for any platform with tracking', `<button class="btn btn-sm" data-open-tool="reframe">Open</button>`),
            itemRow('Generate Hook', 'Attention-grabbing text hooks', `<button class="btn btn-sm" data-open-tool="hook">Open</button>`),
            itemRow('Add AI Emojis', 'Contextual pictographs in the captions',
              `${cost('ai_emojis')}${sw('emojis', !!(S.project.subtitles || {}).emojis, 'data-emojis')}`),
            itemRow('Speaker labels & colours', 'Name + colour per speaker',
              `${cost('speaker_labels')}${sw('speakers', !!(S.project.subtitles || {}).speaker_labels, 'data-speakers')}`),
            itemRow('Add B-roll', 'Auto-generate visuals for the narration', `<button class="btn btn-sm" data-open-tool="broll">Open</button>`),
            itemRow('Auto Transitions', 'Detects cuts and picks transitions',
              `${cost('auto_transitions')}<button class="btn btn-sm" data-act="autotrans">Apply</button>`),
          ].join('')),
          sec('Generate Media', [
            itemRow('AI Video', 'Text-to-video clip into the timeline', `${cost('ai_video')}◆<button class="btn btn-sm" data-open-tool="broll">Open</button>`),
            itemRow('AI Music', 'Prompt or mood → music bed', `${cost('ai_music')}<button class="btn btn-sm" data-open-tool="audio">Open</button>`),
            itemRow('AI Sound Effect', 'Prompt → effect at the playhead', `${cost('ai_sfx')}<button class="btn btn-sm" data-open-tool="audio">Open</button>`),
          ].join('')),
          sec('Publish', [
            itemRow('Generate Thumbnail', 'Best frames + titled AI-styled version', `${cost('thumbnail')}<button class="btn btn-sm" data-act="thumb">Generate</button>`),
            itemRow('Generate Title', 'AI titles', `${cost('title')}<button class="btn btn-sm" data-act="titles">Generate</button>`),
            itemRow('Generate Description', 'Description + hashtags', `${cost('description')}<button class="btn btn-sm" data-act="desc">Generate</button>`),
            itemRow('Translate', 'Subtitle translation', `${cost('translate')}<button class="btn btn-sm" data-open-tool="subtitles">Open</button>`),
          ].join('')),
          `<div id="aiOut"></div>`,
        ]);
        const out = el.querySelector('#aiOut');

        el.querySelector('[data-enhance]').onchange = async (e) => {
          const btn = e.target;
          await run(null, W.api.post('/api/editor/tools/enhance', {
            project_id: S.project.id, enabled: btn.checked, start: Math.max(0, S.playhead), duration: 8,
          }), (res) => {
            W.markDirty('Enhance Speech'); W.renderPanel();
            const host = el.querySelector('#abPlayer');
            if (res.before) {
              host.innerHTML = sec('Before / after', `
                <div class="stack">
                  <div><div class="tiny muted">Before</div><audio controls src="${W.mediaUrl(res.before)}" style="width:100%"></audio></div>
                  <div><div class="tiny muted">After</div><audio controls src="${W.mediaUrl(res.after)}" style="width:100%"></audio></div>
                </div>`);
            }
            W.toast('Enhance Speech', btn.checked ? 'on — exported audio uses the enhanced chain' : 'off');
          });
        };
        el.querySelector('[data-emojis]').onchange = (e) => run(e.target, W.api.post('/api/editor/tools/emojis', {
          project_id: S.project.id, enabled: e.target.checked,
        }), (res) => {
          out.innerHTML = sec('AI Emojis', `<div class="small muted">${res.total} pictographs placed${res.note ? ` · ${esc(res.note)}` : ''}</div>`);
          W.markDirty('AI Emojis');
        });
        el.querySelector('[data-speakers]').onchange = (e) => run(e.target, W.api.post('/api/editor/tools/speakers', {
          project_id: S.project.id, enabled: e.target.checked,
        }), (res) => {
          out.innerHTML = sec('Speakers', `<div class="small muted">${(res.speakers || []).map((s) => `${esc(s.label)} (${s.lines})`).join(' · ') || 'no lines'}</div>
            <div class="tiny muted" style="margin-top:6px">${esc(res.note || '')}</div>`);
          W.markDirty('Speaker labels');
        });
        el.querySelector('[data-act="fillers"]').onclick = (e) => run(e.target, W.api.post('/api/editor/tools/fillers', {
          project_id: S.project.id,
        }), (res) => {
          el.querySelector('#fillerBox').innerHTML = res.total ? `
            <div class="small muted">${res.total} fillers · ${res.removed_seconds}s removable</div>
            <div class="row" style="margin:6px 0;flex-wrap:wrap">
              ${res.words.map((w) => `<span class="tag">${esc(w.word)} × ${w.count}</span>`).join('')}
            </div>
            <button class="btn btn-sm btn-green" id="applyFillers">Cut all fillers</button>` : '<div class="small muted">No filler words found.</div>';
          const btn = el.querySelector('#applyFillers');
          if (btn) btn.onclick = () => {
            W.mutate('Remove filler words', (p) => {
              const cuts = res.cuts || [];
              cuts.forEach(([a, b]) => {
                const clips = p.clips || [];
                const out = [];
                clips.forEach((clip) => {
                  const ca = Number(clip.start), cb = Number(clip.end);
                  if (b <= ca + 0.02 || a >= cb - 0.02) { out.push(clip); return; }
                  const head = { ...clip, id: `${clip.id}_h${Math.random().toString(36).slice(2, 6)}`, end: Math.max(ca, a) };
                  const tail = { ...clip, id: `${clip.id}_t${Math.random().toString(36).slice(2, 6)}`, start: Math.min(cb, b) };
                  if (head.end - head.start > 0.1) out.push(head);
                  if (tail.end - tail.start > 0.1) out.push(tail);
                });
                p.clips = out;
              });
              const lines = (p.subtitles.lines || []);
              lines.forEach((line) => {
                if ((res.cuts || []).some(([a, b]) => line.start >= a - 0.01 && line.end <= b + 0.01)) line.cut = true;
              });
            });
            W.toast('Fillers cut', `${res.cuts.length} ranges removed — audio crossfades in the export`);
          };
        });
        el.querySelector('[data-act="silences"]').onclick = (e) => run(e.target, W.api.post('/api/editor/tools/silences', {
          project_id: S.project.id,
          threshold_db: Number(el.querySelector('#silDb').value) || -30,
          min_duration: Number(el.querySelector('#silMin').value) || 1,
        }), (res) => {
          el.querySelector('#silenceBox').innerHTML = `
            <div class="small muted">${res.silences.length} gaps · ${res.removed_seconds}s removable</div>
            <div class="row" style="margin:6px 0;flex-wrap:wrap">
              ${res.silences.map((s) => `<span class="silence" data-sil="${s.start},${s.end}" title="click to cut">${s.duration}s</span>`).join('') || '<span class="muted tiny">none</span>'}
            </div>
            <div class="row"><button class="btn btn-sm btn-green" id="applySilences">Cut all silences</button></div>`;
          el.querySelector('#silenceBox').querySelectorAll('[data-sil]').forEach((chip) => {
            chip.onclick = () => {
              const [a, b] = chip.dataset.sil.split(',').map(Number);
              cutSourceRange(a, b, 'Remove silence');
            };
          });
          const all = el.querySelector('#applySilences');
          if (all) all.onclick = () => {
            W.mutate('Remove silences', (p) => {
              (res.silences || []).forEach((s) => {
                if (s.duration < (Number(el.querySelector('#silMin').value) || 1)) return;
                const clips = p.clips || [];
                const out = [];
                clips.forEach((clip) => {
                  const ca = Number(clip.start), cb = Number(clip.end);
                  if (s.end <= ca + 0.02 || s.start >= cb - 0.02) { out.push(clip); return; }
                  const head = { ...clip, id: `${clip.id}_h${Math.random().toString(36).slice(2, 6)}`, end: Math.max(ca, s.start) };
                  const tail = { ...clip, id: `${clip.id}_t${Math.random().toString(36).slice(2, 6)}`, start: Math.min(cb, s.end) };
                  if (head.end - head.start > 0.1) out.push(head);
                  if (tail.end - tail.start > 0.1) out.push(tail);
                });
                p.clips = out;
              });
            });
            W.toast('Silences removed', `${res.silences.length} gaps trimmed`);
          };
        });
        el.querySelector('[data-act="autotrans"]').onclick = (e) => run(e.target, Promise.resolve(1), () => {
          const types = ((S.meta || {}).transitions || []).map((t) => t.key).filter((k) => k !== 'none');
          W.mutate('Auto transitions', (p) => {
            (p.clips || []).forEach((clip, i) => {
              if (i === 0) { clip.transition = { type: 'none', duration: 0.3 }; return; }
              clip.transition = { type: types[i % types.length] || 'fade', duration: 0.4 };
            });
          });
          W.toast('Auto transitions', 'suitable transitions added at every cut');
        });
        el.querySelector('[data-act="thumb"]').onclick = (e) => run(e.target, W.api.post('/api/editor/tools/thumbnail', {
          project_id: S.project.id, title: (S.project.source || {}).title || S.project.name, count: 3,
        }), (res) => {
          out.innerHTML = sec('Thumbnails', `<div class="grid g3">${(res.thumbnails || []).map((t) => `
            <div class="card"><div class="media-thumb" style="background-image:url('${W.mediaUrl(t.media)}')"></div>
            <div class="small">${esc(t.label)}</div>
            <div class="row" style="margin-top:6px"><a class="btn btn-sm" href="${W.mediaUrl(t.media)}" download>Download</a>
            <button class="btn btn-sm btn-ghost" data-setthumb="${W.mediaUrl(t.media)}">Use for publish</button></div></div>`).join('')}</div>`);
          out.querySelectorAll('[data-setthumb]').forEach((b) => {
            b.onclick = () => { S.project.thumbnail = b.dataset.setthumb; W.markDirty('Thumbnail'); W.toast('Thumbnail set', 'used in the publish dialog'); };
          });
        });
        el.querySelector('[data-act="titles"]').onclick = (e) => run(e.target, W.api.post('/api/editor/tools/titles', {
          project_id: S.project.id,
        }), (res) => {
          out.innerHTML = sec('Titles', res.titles.map((t) => `<div class="item"><div class="txt"><strong>${esc(t.text)}</strong>
            <small>${esc(t.why || '')}</small></div><button class="btn btn-sm" data-copy="${esc(t.text)}">Copy</button></div>`).join('')
            + `<div class="tiny muted">source: ${esc(res.source)}</div>`);
          wireCopy(out);
        });
        el.querySelector('[data-act="desc"]').onclick = (e) => run(e.target, W.api.post('/api/editor/tools/description', {
          project_id: S.project.id,
        }), (res) => {
          out.innerHTML = sec('Description', `<textarea class="input" rows="6" id="descOut">${esc(res.description + '\n\n' + (res.hashtags || []).join(' '))}</textarea>
            <div class="row" style="margin-top:8px"><button class="btn btn-sm" id="copyDesc">Copy</button>
            <span class="tiny muted">${esc(res.source)}</span></div>`);
          out.querySelector('#copyDesc').onclick = () => navigator.clipboard.writeText(out.querySelector('#descOut').value);
        });
        el.querySelectorAll('[data-open-tool]').forEach((b) => {
          b.onclick = () => { S.tool = b.dataset.openTool; W.showPage('editor'); W.showPage('editor'); document.querySelectorAll('[data-tool]').forEach((x) => x.classList.toggle('active', x.dataset.tool === S.tool)); W.renderPanel(); };
        });
      },
    });

    function wireCopy(root) {
      root.querySelectorAll('[data-copy]').forEach((b) => {
        b.onclick = () => { navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied ✓'; };
      });
    }

    /* ============================================================ TEMPLATE */
    W.panel('template', {
      title: 'Template',
      blurb: 'Aspect ratio, reusable templates and built-in layouts.',
      render(el) {
        const aspects = (S.meta && S.meta.aspects) || [];
        const builtin = { items: [], builtin: [] };
        el.innerHTML = panelHtml([
          sec('Aspect ratio', `<select class="input" id="tplAspect">
            ${aspects.map((a) => `<option value="${a.key}" ${S.project.aspect === a.key ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}
          </select>`),
          sec('My Template', `
            <button class="btn btn-sm btn-block btn-green" id="saveTpl">+ Add Template (current settings)</button>
            <div id="myTpl" class="stack" style="margin-top:10px"></div>`),
          sec('Gallery', `
            <div class="chip-row" id="tplChips">
              <button class="chip active" data-cat="all">All</button>
              <button class="chip" data-cat="podcast">Podcast</button>
              <button class="chip" data-cat="gaming">Gaming</button>
              <button class="chip" data-cat="others">Others</button>
            </div>
            <div class="grid g3" id="tplGrid" style="margin-top:10px"></div>
            <button class="btn btn-sm btn-ghost btn-block" id="tplAll" style="margin-top:8px">View all</button>`),
        ]);
        let category = 'all';
        let expanded = false;
        let mine = [];

        async function load() {
          const data = await W.api.get('/api/templates');
          mine = data.items || [];
          draw(data.builtin || []);
        }

        function draw(builtinList) {
          const grid = el.querySelector('#tplGrid');
          const mineTiles = mine.map((t) => ({
            id: t.id, name: t.name, category: t.category, layout: t.layout,
            caption_preset: t.caption_preset, aspect: t.aspect, description: t.description, mine: true,
          }));
          let list = mineTiles.concat(builtinList.map((b) => ({ ...b, builtin: true })));
          if (category !== 'all') list = list.filter((t) => (t.category || 'Others').toLowerCase() === category);
          if (!expanded) list = list.slice(0, 6);
          grid.innerHTML = list.map((t) => `
            <div class="tile" data-apply="${t.id}">
              <div class="preview">${layoutPreviewStatic(t.layout)}</div>
              <div class="meta"><strong>${esc(t.name)}</strong><small>${esc(t.description || t.caption_preset || '')}</small>
              ${t.mine ? `<button class="btn btn-sm btn-ghost" data-del="${t.id}" style="margin-top:6px">Delete</button>` : ''}</div>
            </div>`).join('') || '<div class="empty">No templates in this category.</div>';
          grid.querySelectorAll('[data-apply]').forEach((tile) => {
            tile.onclick = (ev) => {
              if (ev.target.dataset.del) return;
              const id = tile.dataset.apply;
              const t = mineTiles.concat(builtinList).find((x) => x.id === id);
              if (!t) return;
              W.mutate('Apply template', (p) => {
                p.aspect = t.aspect || '9:16';
                p.layout = t.layout || 'fit';
                (p.clips || []).forEach((c) => { c.layout = t.layout || 'fit'; });
                p.subtitles = p.subtitles || {};
                p.subtitles.preset = t.caption_preset || p.subtitles.preset;
                if (t.hook && !(p.hooks || []).length) {
                  p.hooks = [{ id: 'hook_tpl', text: (p.source || {}).title || 'Watch this', start: 0, end: 4,
                               preset: 'boxed_white', style: { y: 0.14, size: 'large', animation_in: 'pop' } }];
                }
              });
              W.toast('Template applied', esc(t.name));
            };
          });
          grid.querySelectorAll('[data-del]').forEach((b) => {
            b.onclick = async (ev) => { ev.stopPropagation(); await W.api.del(`/api/templates/${b.dataset.del}`); load(); };
          });
        }

        el.querySelector('#tplAspect').onchange = (e) => {
          W.mutate('Set aspect', (p) => { p.aspect = e.target.value; });
        };
        el.querySelector('#saveTpl').onclick = async (e) => {
          const res = await run(e.target, W.api.post('/api/templates', {
            name: prompt('Template name', S.project.name || 'My template') || 'My template',
            category: 'Others',
            aspect: S.project.aspect,
            layout: S.project.layout,
            caption_preset: (S.project.subtitles || {}).preset,
            caption_style: W.subtitleStyle(),
            brand: S.project.brand,
            effects: ((S.project.clips || [])[0] || {}).effects ? [((S.project.clips || [])[0].effects || [])[0] && ((S.project.clips || [])[0].effects || [])[0].type].filter(Boolean) : [],
            description: 'Saved from the current project',
          }), (t) => W.toast('Template saved', t.name));
          if (res) load();
        };
        el.querySelectorAll('[data-cat]').forEach((chip) => {
          chip.onclick = () => {
            category = chip.dataset.cat === 'all' ? 'all' : chip.dataset.cat;
            el.querySelectorAll('[data-cat]').forEach((c) => c.classList.toggle('active', c === chip));
            load();
          };
        });
        el.querySelector('#tplAll').onclick = (e) => { expanded = !expanded; e.target.textContent = expanded ? 'Show less' : 'View all'; load(); };
        load().catch((err) => W.fail(err));
      },
    });

    function layoutPreviewStatic(key) {
      const box = 'position:absolute;background:#1f2c38;border:1px solid #31424f;border-radius:2px';
      if (key === 'split') return `<div style="${box};left:8%;right:8%;top:8%;height:38%"></div><div style="${box};left:8%;right:8%;top:50%;height:38%"></div>`;
      if (key === 'trio') return [8, 40, 72].map((t) => `<div style="${box};left:8%;right:8%;top:${t}%;height:20%"></div>`).join('');
      if (key === 'grid') return [[8, 8], [52, 8], [8, 52], [52, 52]].map(([l, t]) => `<div style="${box};left:${l}%;top:${t}%;width:40%;height:40%"></div>`).join('');
      if (key === 'pip') return `<div style="${box};inset:8%"></div><div style="${box};right:12%;bottom:12%;width:34%;height:24%"></div>`;
      if (key === 'blur') return `<div style="${box};inset:0;background:#243240"></div><div style="position:absolute;left:12%;right:12%;top:26%;bottom:26%;background:#0d141b;border:1px solid #31424f"></div>`;
      if (key === 'full') return `<div style="${box};inset:0"></div>`;
      return `<div style="position:absolute;inset:0;background:#121a22"></div><div style="position:absolute;left:10%;right:10%;top:28%;bottom:28%;background:#1f2c38;border:1px solid #31424f"></div>`;
    }

    /* =========================================================== BRAND KIT */
    W.panel('brand', {
      title: 'Brand Kit',
      blurb: 'Logos, styles, colours and fonts, reusable across every project.',
      render(el) {
        const SECTIONS = ['logos', 'subtitle_styles', 'text_styles', 'images', 'videos', 'audio', 'colors', 'fonts'];
        const logo = (S.project.brand || {}).logo || {};
        el.innerHTML = panelHtml([
          sec('Logo watermark', `
            <div class="item"><div class="txt"><strong>Show logo</strong><small>Position and size as an overlay</small></div>
              ${sw('logo', !!logo.enabled, 'data-logo')}</div>
            <div class="stack" style="margin-top:8px">
              <label class="lbl">Size <input class="input" type="range" min="0.05" max="0.5" step="0.01" id="logoScale" value="${logo.scale || 0.16}"></label>
              <label class="lbl">Opacity <input class="input" type="range" min="0.1" max="1" step="0.05" id="logoOpacity" value="${logo.opacity || 0.9}"></label>
              <div class="split-2"><label class="lbl">X <input class="input" type="range" min="0" max="0.9" step="0.01" id="logoX" value="${logo.x || 0.08}"></label>
              <label class="lbl">Y <input class="input" type="range" min="0" max="0.9" step="0.01" id="logoY" value="${logo.y || 0.06}"></label></div>
            </div>`),
          sec('Library', `<div id="bkSections" class="stack"></div>
            <div class="row" style="margin-top:10px"><label class="btn btn-sm btn-ghost">⬆ Upload
              <input type="file" hidden id="bkFile"></label>
              <select class="input" id="bkSection" style="max-width:140px">${SECTIONS.map((s) => `<option>${s}</option>`).join('')}</select></div>`),
        ]);
        const brand = (k) => (S.project.brand = S.project.brand || (k ? { logo: {} } : {}));

        el.querySelector('[data-logo]').onchange = (e) => {
          const billingOff = !!((S.meta || {}).credits || {}).unlimited;
          if (e.target.checked && !billingOff && S.meta.credits.plan === 'free') {
            e.target.checked = false;
            W.openModal('upgrade');
            W.toast('Brand Kit is a paid feature', 'switch plan to use logo watermarks', 'warn');
            return;
          }
          W.mutate('Toggle logo', (p) => { brand().logo = { ...(p.brand.logo || {}), enabled: e.target.checked }; });
        };
        [['logoScale', 'scale'], ['logoOpacity', 'opacity'], ['logoX', 'x'], ['logoY', 'y']].forEach(([id, key]) => {
          el.querySelector(`#${id}`).oninput = (e) => {
            W.mutate('Logo position', (p) => {
              p.brand = p.brand || { logo: {} };
              p.brand.logo = { ...(p.brand.logo || {}), [key]: Number(e.target.value), enabled: true };
            });
          };
        });

        async function paintSections() {
          const data = await W.api.get('/api/brandkit');
          el.querySelector('#bkSections').innerHTML = SECTIONS.map((section) => `
            <div class="item"><div class="txt"><strong>${section.replace(/_/g, ' ')}</strong>
              <small>${(data.grouped[section] || []).length} item(s)</small></div>
              <div class="row">${(data.grouped[section] || []).slice(0, 4).map((i) => `
                <button class="chip" data-apply-brand="${i.id}" data-media="${W.mediaUrl(i.media || '')}">${esc(i.name || i.value || 'item')}</button>`).join('')}</div>
            </div>`).join('');
          el.querySelectorAll('[data-apply-brand]').forEach((b) => {
            b.onclick = () => {
              const media = b.dataset.media;
              W.mutate('Apply brand item', (p) => {
                p.brand = p.brand || { logo: {} };
                p.brand.logo = { ...(p.brand.logo || {}), asset: media, enabled: true };
              });
              W.toast('Brand item applied', 'logo updated');
            };
          });
        }
        el.querySelector('#bkFile').onchange = async (e) => {
          const fd = new FormData();
          fd.append('file', e.target.files[0]);
          fd.append('section', el.querySelector('#bkSection').value);
          await W.api.post('/api/brandkit/upload', fd);
          paintSections();
          W.toast('Uploaded', 'saved to the brand kit');
        };
        paintSections().catch((err) => W.fail(err));
      },
    });

    /* ================================================================ TRIM */
    W.panel('trim', {
      title: 'Trim',
      blurb: 'Edit the video like a text document: delete words to delete footage.',
      render(el) {
        const subs = S.project.subtitles || {};
        el.innerHTML = panelHtml([
          `<div class="chip-row" id="trimChips">
            <button class="chip ${(S.project.audio || {}).enhance ? 'active' : ''}" data-chip="enhance">Enhance Speech</button>
            <button class="chip" data-chip="silence">Remove silences</button>
            <button class="chip" data-chip="fillers">Remove filler words</button>
          </div>`,
          `<div class="row small">
            <input class="input" id="trimSearch" placeholder="Search in transcript" style="max-width:150px">
            <button class="btn btn-sm" id="trimDownload">Download</button>
            <button class="btn btn-sm btn-ghost" id="trimSettings">Settings</button>
          </div>`,
          `<div id="trimSettingsBox" hidden>${sec('Settings', `
            <label class="lbl">Show timestamps <input type="checkbox" id="setTimestamps" ${S.trimTimestamps !== false ? 'checked' : ''}></label>
            <label class="lbl">Silence threshold (dB) <input class="input" type="number" id="setSil" value="-30"></label>
            <label class="lbl">Min silence (s) <input class="input" type="number" id="setMin" value="1" step="0.1"></label>`)}</div>`,
          `<div class="row"><span class="tag" id="trimStats"></span></div>`,
          `<div class="words" id="wordBox"></div>`,
          `<div class="row" style="margin-top:8px">
            <button class="btn btn-sm btn-green" id="cutSel">Delete selected text</button>
            <button class="btn btn-sm btn-ghost" id="clearCuts">Restore</button>
          </div>`,
          `<div id="silenceList" class="stack"></div>`,
        ]);
        let selected = [];
        let silences = [];

        function paintWords() {
          const tl = W.timeline();
          const query = (el.querySelector('#trimSearch').value || '').toLowerCase();
          const showTs = el.querySelector('#setTimestamps') ? el.querySelector('#setTimestamps').checked : true;
          let removed = 0, total = 0;
          const html = (subs.lines || []).map((line) => {
            const cut = (S.project.deleted || []).some((d) => line.start >= d.start - 0.02 && line.end <= d.end + 0.02);
            if (cut) removed += (line.words || []).length || 1;
            const words = (line.words && line.words.length ? line.words : [{ w: line.text, s: line.start, e: line.end }]);
            total += words.length;
            const out = words.map((w, i) => {
              const id = `${line.id}_${i}`;
              if (query && !String(w.w).toLowerCase().includes(query)) return '';
              const cur = S.playhead >= (tl.toOutput(Number(w.s)) || -1) && S.playhead <= (tl.toOutput(Number(w.e)) || -1);
              return `<span class="w ${cut ? 'cut' : ''} ${cur ? 'cur' : ''}" data-w="${id}" data-s="${w.s}" data-e="${w.e}"
                title="${showTs ? `${fmt.clockMs(Number(w.s))} → ${fmt.clockMs(Number(w.e))}` : ''}">${esc(w.w)}</span>`;
            }).join(' ');
            return `${out}${cut ? ' <span class="tiny muted">[cut]</span>' : ''} <span class="tiny muted">·</span> `;
          }).join('');
          el.querySelector('#wordBox').innerHTML = html || '<span class="muted small">No transcript. Transcribe the video first.</span>';
          el.querySelector('#trimStats').textContent = `${total - removed} words kept · ${removed} removed · ${silences.length} silences found`;

          el.querySelectorAll('[data-w]').forEach((node) => {
            node.onclick = (ev) => {
              const id = node.dataset.w;
              if (ev.shiftKey && selected.length) {
                const all = Array.from(el.querySelectorAll('[data-w]')).map((n) => n.dataset.w);
                const a = all.indexOf(selected[selected.length - 1]);
                const b = all.indexOf(id);
                selected = all.slice(Math.min(a, b), Math.max(a, b) + 1);
              } else {
                selected = [id];
              }
              el.querySelectorAll('[data-w]').forEach((n) => n.style.outline = selected.includes(n.dataset.w) ? '1px solid #00ff9c' : '');
              W.seek(tl.toOutput(Number(node.dataset.s)) || 0);
            };
            node.ondblclick = () => {
              const next = prompt('Fix the word (captions only, video unchanged)', node.textContent);
              if (next == null) return;
              const [lineId, idx] = node.dataset.w.split('_');
              W.mutate('Edit caption text', (p) => {
                const line = (p.subtitles.lines || []).find((l) => String(l.id) === String(lineId));
                if (!line) return;
                if (line.words && line.words[Number(idx)]) line.words[Number(idx)].w = next;
                line.text = (line.words && line.words.length ? line.words.map((w) => w.w).join(' ') : line.text.replace(node.textContent, next));
              });
            };
          });
        }

        el.querySelector('#trimSearch').oninput = paintWords;
        el.querySelector('#trimChips').querySelectorAll('[data-chip]').forEach((chip) => {
          chip.onclick = () => {
            if (chip.dataset.chip === 'enhance') {
              const on = !(S.project.audio || {}).enhance;
              chip.classList.toggle('active', on);
              run(chip, W.api.post('/api/editor/tools/enhance', { project_id: S.project.id, enabled: on }), (res) => {
                W.markDirty('Enhance Speech');
                if (res.before) el.insertAdjacentHTML('beforeend', sec('Before / after', `
                  <audio controls src="${W.mediaUrl(res.before)}" style="width:100%;margin-bottom:6px"></audio>
                  <audio controls src="${W.mediaUrl(res.after)}" style="width:100%"></audio>`));
              });
            } else if (chip.dataset.chip === 'silence') {
              run(chip, W.api.post('/api/editor/tools/silences', { project_id: S.project.id,
                threshold_db: Number(el.querySelector('#setSil').value) || -30,
                min_duration: Number(el.querySelector('#setMin').value) || 1,
              }), (res) => {
                silences = res.silences || [];
                el.querySelector('#silenceList').innerHTML = sec('Silences', `
                  <div class="small muted">${silences.length} gaps · ${res.removed_seconds}s removable</div>
                  <div class="row" style="flex-wrap:wrap;margin-top:6px">${silences.map((s) => `
                    <span class="silence" data-sil="${s.start},${s.end}">${s.duration}s</span>`).join('')}</div>`);
                el.querySelectorAll('[data-sil]').forEach((n) => {
                  n.onclick = () => {
                    const [a, b] = n.dataset.sil.split(',').map(Number);
                    cutSourceRange(a, b, 'Remove silence');
                    paintWords();
                  };
                });
                paintWords();
              });
            } else {
              run(chip, W.api.post('/api/editor/tools/fillers', { project_id: S.project.id }), (res) => {
                el.querySelector('#silenceList').innerHTML = sec('Filler words', res.total ? `
                  <div class="row" style="flex-wrap:wrap">${res.words.map((w) => `<span class="tag">${esc(w.word)} × ${w.count}</span>`).join('')}</div>
                  <button class="btn btn-sm btn-green btn-block" id="fillCut" style="margin-top:8px">Cut ${res.cuts.length} ranges</button>`
                  : '<span class="small muted">No fillers found.</span>');
                const btn = el.querySelector('#fillCut');
                if (btn) btn.onclick = () => {
                  (res.cuts || []).forEach(([a, b]) => cutSourceRange(a, b, 'Remove filler'));
                  W.toast('Fillers cut', `${res.cuts.length} ranges removed`);
                  paintWords();
                };
              });
            }
          };
        });
        el.querySelector('#trimSettings').onclick = () => {
          const box = el.querySelector('#trimSettingsBox');
          box.hidden = !box.hidden;
        };
        el.querySelector('#setTimestamps').onchange = paintWords;
        el.querySelector('#cutSel').onclick = () => {
          if (!selected.length) { W.toast('Nothing selected', 'click words, then shift-click to extend', 'warn'); return; }
          const nodes = Array.from(el.querySelectorAll('[data-w]')).filter((n) => selected.includes(n.dataset.w));
          const start = Math.min(...nodes.map((n) => Number(n.dataset.s)));
          const end = Math.max(...nodes.map((n) => Number(n.dataset.e)));
          cutSourceRange(start, end, 'Delete selected text');
          selected = [];
          paintWords();
        };
        el.querySelector('#clearCuts').onclick = () => {
          W.mutate('Restore cuts', (p) => {
            const original = JSON.parse(S.__originalClips || 'null');
            if (original) p.clips = original;
            p.deleted = [];
          });
          paintWords();
        };
        el.querySelector('#trimDownload').onclick = () => {
          const lines = outLines();
          const srt = lines.map((l, i) => `${i + 1}\n${srtTime(l.outStart, true)} --> ${srtTime(l.outEnd, true)}\n${l.text}\n`).join('\n');
          const vtt = 'WEBVTT\n\n' + lines.map((l) => `${srtTime(l.outStart)} --> ${srtTime(l.outEnd)}\n${l.text}\n`).join('\n');
          const txt = lines.map((l) => `[${fmt.clockMs(l.outStart)}] ${l.text}`).join('\n');
          W.openModal('downloadTranscript', { srt, vtt, txt });
        };
        if (!S.__originalClips) S.__originalClips = JSON.stringify(S.project.clips || []);
        paintWords();
      },
    });

    W.modal('downloadTranscript', (data) => `
      <button class="modal-x" data-close>✕</button>
      <h3>Download transcript</h3>
      <p class="m-sub">SRT/VTT use the edited timeline, so they match the exported video.</p>
      <div class="row"><button class="btn btn-green" data-dl="srt">SRT</button>
      <button class="btn" data-dl="vtt">VTT</button>
      <button class="btn" data-dl="txt">TXT</button>
      <button class="btn" data-dl="docx">DOCX</button></div>`);

    document.addEventListener('click', (ev) => {
      const btn = ev.target.closest && ev.target.closest('[data-dl]');
      if (!btn) return;
      const host = document.getElementById('modalHost');
      const kind = btn.dataset.dl;
      const lines = outLines();
      const srt = lines.map((l, i) => `${i + 1}\n${srtTime(l.outStart, true)} --> ${srtTime(l.outEnd, true)}\n${l.text}\n`).join('\n');
      const vtt = 'WEBVTT\n\n' + lines.map((l) => `${srtTime(l.outStart)} --> ${srtTime(l.outEnd)}\n${l.text}\n`).join('\n');
      const txt = lines.map((l) => `[${fmt.clockMs(l.outStart)}] ${l.text}`).join('\n');
      if (kind === 'srt') download('transcript.srt', srt, 'application/x-subrip');
      if (kind === 'vtt') download('transcript.vtt', vtt, 'text/vtt');
      if (kind === 'txt') download('transcript.txt', txt);
      if (kind === 'docx') download('transcript.doc', `<html><body>${lines.map((l) => `<p><b>${fmt.clockMs(l.outStart)}</b> ${esc(l.text)}</p>`).join('')}</body></html>`, 'application/msword');
      if (host) W.closeModal();
    });

    /* ============================================================ REFRAME */
    W.panel('reframe', {
      title: 'Reframe',
      blurb: 'Resize for any platform — AI crops, tracks and suggests layouts.',
      render(el) {
        const aspects = (S.meta && S.meta.aspects) || [];
        const layouts = (S.meta && S.meta.layouts) || [];
        el.innerHTML = panelHtml([
          `<div class="card" id="reframeIntro">
            <div class="small">Instantly resize your video for any platform. AI automatically crops, reframes and suggests the best layouts for you.</div>
            <div class="row" style="margin-top:10px"><button class="btn btn-sm" id="reframeOk">OK</button></div>
          </div>`,
          sec('Setup', `
            <label class="lbl">Ratio</label>
            <select class="input" id="rfRatio">${aspects.map((a) => `<option value="${a.key}" ${S.project.aspect === a.key ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}</select>
            ${itemRow('Auto Reframe', 'Face / speaker tracking with smooth movement', sw('auto', true, 'data-auto'))}
            <label class="lbl">Global layout</label>
            <select class="input" id="rfLayout">
              <option value="auto">Auto (per scene)</option>
              ${layouts.map((l) => `<option value="${l.key}">${esc(l.label)}</option>`).join('')}
            </select>
            ${itemRow('Scene detect', 'Use PySceneDetect for the scene windows', sw('scenes', false, 'data-scenes'))}
            <button class="btn btn-green btn-block" id="rfRun" style="margin-top:10px">One Click to Reframe ${cost('reframe')}</button>`),
          `<div id="rfScenes"></div>`,
        ]);
        el.querySelector('#reframeOk').onclick = () => el.querySelector('#reframeIntro').remove();
        el.querySelector('#rfRun').onclick = (e) => run(e.target, W.api.post('/api/editor/tools/reframe', {
          project_id: S.project.id,
          ratio: el.querySelector('#rfRatio').value,
          layout: el.querySelector('#rfLayout').value,
          scene_detect: el.querySelector('[data-scenes]').checked,
          apply: true,
        }), (res) => {
          W.markDirty('Reframe');
          const plan = res.plan;
          el.querySelector('#rfScenes').innerHTML = sec(`Scenes (${plan.scenes.length})`, `
            <div class="tiny muted" style="margin-bottom:6px">${esc(plan.engine)}</div>
            <div class="stack">${plan.scenes.slice(0, 14).map((sc, i) => `
              <div class="item">
                <div class="txt"><strong>${fmt.clock(sc.start)} → ${fmt.clock(sc.end)}</strong>
                  <small>${esc(sc.reason)}</small></div>
                <div class="row">
                  <select class="input" data-scene="${i}" style="width:112px">
                    ${layouts.map((l) => `<option value="${l.key}" ${l.key === sc.layout ? 'selected' : ''}>${esc(l.label)}</option>`).join('')}
                  </select>
                </div>
              </div>
              <label class="lbl">Crop centre <input class="input" type="range" min="0" max="1" step="0.01" value="${sc.crop.x || 0.5}" data-crop="${i}"></label>`).join('')}</div>`);
          el.querySelectorAll('[data-scene]').forEach((sel) => {
            sel.onchange = () => {
              const index = Number(sel.dataset.scene);
              W.mutate('Per-scene layout', (p) => {
                const clip = (p.clips || [])[index];
                if (clip) clip.layout = sel.value;
              });
            };
          });
          el.querySelectorAll('[data-crop]').forEach((slider) => {
            slider.oninput = () => {
              const index = Number(slider.dataset.crop);
              W.mutate('Adjust crop', (p) => {
                const clip = (p.clips || [])[index];
                if (clip) clip.crop = { ...(clip.crop || {}), x: Number(slider.value) };
              });
            };
          });
          W.toast('Reframed', `${plan.scenes.length} scenes · ${plan.samples} frames analysed`);
        });
      },
    });

    /* ========================================================== SUBTITLES */
    W.panel('subtitles', {
      title: 'Subtitles',
      blurb: 'Style, edit, translate and burn captions into the export.',
      render(el) {
        const subs = S.project.subtitles || (S.project.subtitles = { lines: [] });
        const catalog = (S.meta.captions) || {};
        const presets = catalog.subtitle_presets || [];
        const basic = presets.filter((p) => p.group === 'basic');
        const dynamic = presets.filter((p) => p.group === 'dynamic');
        let tab = S.subTab || 'style';
        let showAllDynamic = false;

        el.innerHTML = panelHtml([
          `<div class="row spread">
            ${sw('master', subs.enabled !== false, 'data-master')}
            <button class="btn btn-sm" id="subEmoji" title="AI Emojis">😀 ${cost('ai_emojis')}</button>
            <button class="btn btn-sm" id="subTranslate" title="Translate">🌐</button>
            <button class="btn btn-sm" id="subDl" title="Download">⬇</button>
            <button class="btn btn-sm btn-ghost" id="subInfo" title="How captions work">i</button>
          </div>`,
          `<div class="chip-row">
            <button class="chip ${tab === 'style' ? 'active' : ''}" data-subtab="style">Style</button>
            <button class="chip ${tab === 'edit' ? 'active' : ''}" data-subtab="edit">Edit</button>
          </div>`,
          `<div id="subPane"></div>`,
        ]);

        function paint() {
          const pane = el.querySelector('#subPane');
          if (tab === 'style') {
            const style = W.subtitleStyle();
            pane.innerHTML = panelHtml([
              sec('Basic', `<div class="grid g3">${basic.map((p) => `
                <div class="tile ${subs.preset === p.key ? 'sel' : ''}" data-preset="${p.key}" style="${subs.preset === p.key ? 'border-color:rgba(0,255,156,.6)' : ''}">
                  <div class="preview" style="aspect-ratio:16/9;background:#101820"><span style="font-size:12px;color:${(p.style || {}).color || '#fff'};background:${(p.style || {}).background && (p.style || {}).background !== 'none' ? (p.style || {}).background : 'transparent'};padding:2px 6px;border-radius:4px">Aa Bb Cc</span></div>
                  <div class="meta"><strong>${esc(p.label)}</strong></div>
                </div>`).join('')}</div>`),
              sec('Dynamic', `<div class="grid g3">${(showAllDynamic ? dynamic : dynamic.slice(0, 4)).map((p) => `
                <div class="tile ${subs.preset === p.key ? 'sel' : ''}" data-preset="${p.key}" style="${subs.preset === p.key ? 'border-color:rgba(0,255,156,.6)' : ''}">
                  <div class="preview" style="aspect-ratio:16/9;background:#101820"><span style="font-size:12px;color:${(p.style || {}).highlight || '#00ff9c'}">Word</span></div>
                  <div class="meta"><strong>${esc(p.label)}</strong></div>
                </div>`).join('')}</div>
                <button class="btn btn-sm btn-ghost btn-block" id="morePresets">${showAllDynamic ? 'Show less' : 'View more'}</button>`),
              sec('Controls', `
                <label class="lbl">Font <select class="input" id="subFont">${(catalog.fonts || []).map((f) => `<option ${style.font === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label>
                <label class="lbl">Size <select class="input" id="subSize">
                  ${['small', 'medium', 'large', 'xlarge'].map((s) => `<option value="${s}" ${style.size === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
                <div class="split-2">
                  <label class="lbl">Text <input class="input" type="color" id="subColor" value="${style.color || '#ffffff'}"></label>
                  <label class="lbl">Highlight <input class="input" type="color" id="subHighlight" value="${style.highlight || '#00ff9c'}"></label>
                </div>
                <label class="lbl">Stroke <input class="input" type="range" min="0" max="10" step="1" id="subStroke" value="${style.stroke || 0}"></label>
                <label class="lbl">Shadow <input class="input" type="range" min="0" max="6" step="1" id="subShadow" value="${style.shadow || 0}"></label>
                <label class="lbl">Background <input class="input" type="text" id="subBg" value="${esc(style.background || 'none')}" placeholder="#000000 or none"></label>
                <div class="split-2">
                  <label class="lbl">Position <select class="input" id="subPos">
                    ${['top', 'center', 'bottom'].map((p) => `<option ${style.position === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
                  <label class="lbl">Align <select class="input" id="subAlign">
                    ${['left', 'center', 'right'].map((p) => `<option ${style.align === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
                </div>
                <div class="split-2">
                  <label class="lbl">Max words <input class="input" type="number" id="subWords" value="${style.max_words || 4}" min="1" max="12"></label>
                  <label class="lbl">Animation <select class="input" id="subAnim">
                    ${['word', 'karaoke', 'keyword', 'pop', 'box', 'typewriter', 'static'].map((p) => `<option ${style.animation === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
                </div>
                <div class="tiny muted" style="margin-top:8px">Drag on the preview to move the caption block vertically (position preset) — changes burn into the export.</div>`),
            ]);
            const bind = (id, key, cast, extra) => {
              const node = pane.querySelector(`#${id}`);
              if (!node) return;
              node.oninput = node.onchange = () => {
                W.mutate('Subtitle style', (p) => {
                  p.subtitles = p.subtitles || {};
                  p.subtitles.style = { ...(p.subtitles.style || {}), [key]: cast ? cast(node.value) : node.value };
                  if (extra) extra(p);
                });
              };
            };
            bind('subFont', 'font');
            bind('subSize', 'size');
            bind('subColor', 'color');
            bind('subHighlight', 'highlight');
            bind('subStroke', 'stroke', Number);
            bind('subShadow', 'shadow', Number);
            bind('subBg', 'background');
            bind('subPos', 'position');
            bind('subAlign', 'align');
            bind('subWords', 'max_words', Number);
            bind('subAnim', 'animation');
            pane.querySelectorAll('[data-preset]').forEach((tile) => {
              tile.onclick = () => {
                W.mutate('Subtitle preset', (p) => {
                  p.subtitles = p.subtitles || {};
                  p.subtitles.preset = tile.dataset.preset;
                  const found = presets.find((x) => x.key === tile.dataset.preset);
                  p.subtitles.style = { ...(p.subtitles.style || {}), ...((found && found.style) || {}) };
                });
                paint();
              };
            });
            const more = pane.querySelector('#morePresets');
            if (more) more.onclick = () => { showAllDynamic = !showAllDynamic; paint(); };
          } else {
            pane.innerHTML = panelHtml([
              sec('Lines', `<div class="tiny muted" style="margin-bottom:6px">${(subs.lines || []).length} lines · click text to edit, split/merge to re-time</div>
                <div id="subLines" style="max-height:340px;overflow:auto"></div>`),
            ]);
            pane.querySelector('#subLines').innerHTML = (subs.lines || []).map((line, i) => `
              <div class="line-row" data-line="${line.id}">
                <div class="t">${fmt.clockMs(line.start)}</div>
                <input class="txt" value="${esc(line.text)}" data-text="${line.id}">
                <div class="row">
                  <button class="mini" data-split="${i}" title="Split here">✂</button>
                  <button class="mini" data-merge="${i}" title="Merge with next">⇥</button>
                  <button class="mini" data-del="${i}" title="Delete line">✕</button>
                </div>
              </div>`).join('') || '<div class="empty">No caption lines yet.</div>';
            pane.querySelectorAll('[data-text]').forEach((input) => {
              input.onchange = () => {
                W.mutate('Edit caption', (p) => {
                  const line = (p.subtitles.lines || []).find((l) => String(l.id) === input.dataset.text);
                  if (line) line.text = input.value;
                });
              };
            });
            pane.querySelectorAll('[data-del]').forEach((b) => {
              b.onclick = () => W.mutate('Delete caption line', (p) => {
                p.subtitles.lines = (p.subtitles.lines || []).filter((_, i) => i !== Number(b.dataset.del));
              });
            });
            pane.querySelectorAll('[data-split]').forEach((b) => {
              b.onclick = () => {
                const i = Number(b.dataset.split);
                W.mutate('Split caption line', (p) => {
                  const line = (p.subtitles.lines || [])[i];
                  if (!line) return;
                  const mid = (Number(line.start) + Number(line.end)) / 2;
                  const words = line.words || [];
                  const half = Math.ceil(words.length / 2) || 1;
                  const left = { ...line, id: `${line.id}s`, end: mid, words: words.slice(0, half),
                                 text: words.length ? words.slice(0, half).map((w) => w.w).join(' ') : line.text.split(' ').slice(0, 3).join(' ') };
                  const right = { ...line, id: `${line.id}t`, start: mid, words: words.slice(half),
                                  text: words.length ? words.slice(half).map((w) => w.w).join(' ') : line.text.split(' ').slice(3).join(' ') };
                  p.subtitles.lines.splice(i, 1, left, right);
                });
              };
            });
            pane.querySelectorAll('[data-merge]').forEach((b) => {
              b.onclick = () => {
                const i = Number(b.dataset.merge);
                W.mutate('Merge caption lines', (p) => {
                  const lines = p.subtitles.lines || [];
                  if (!lines[i + 1]) return;
                  const merged = { ...lines[i], end: lines[i + 1].end,
                                   text: `${lines[i].text} ${lines[i + 1].text}`.trim(),
                                   words: [...(lines[i].words || []), ...(lines[i + 1].words || [])] };
                  lines.splice(i, 2, merged);
                });
              };
            });
          }
        }

        el.querySelectorAll('[data-subtab]').forEach((chip) => {
          chip.onclick = () => { tab = chip.dataset.subtab; S.subTab = tab;
            el.querySelectorAll('[data-subtab]').forEach((c) => c.classList.toggle('active', c === chip)); paint(); };
        });
        el.querySelector('[data-master]').onchange = (e) => {
          W.mutate('Toggle subtitles', (p) => { p.subtitles.enabled = e.target.checked; });
          W.toast('Subtitles', e.target.checked ? 'on' : 'off');
        };
        el.querySelector('#subEmoji').onclick = (e) => run(e.target, W.api.post('/api/editor/tools/emojis', {
          project_id: S.project.id, enabled: !(S.project.subtitles || {}).emojis,
        }), (res) => { W.markDirty('AI Emojis'); W.toast('AI Emojis', `${res.total} pictographs`); });
        el.querySelector('#subTranslate').onclick = () => W.openModal('translate');
        el.querySelector('#subDl').onclick = () => W.openModal('downloadTranscript', {});
        el.querySelector('#subInfo').onclick = () => W.toast('Captions',
          'The export burns exactly what the preview shows — same styles, emojis and speaker colours.');
        paint();
      },
    });

    W.modal('translate', () => `
      <button class="modal-x" data-close>✕</button>
      <h3>Translate subtitles</h3>
      <p class="m-sub">Needs a configured LLM (WV_LLM_API_KEY). The translated lines replace the caption track.</p>
      <select class="input" id="trLang">${((window.WVE_STATE.S.meta || {}).languages || []).map((l) => `<option value="${l.code}">${esc(l.label)}</option>`).join('')}</select>
      <div class="row" style="margin-top:14px"><button class="btn btn-green" id="trGo">Translate</button></div>
      <div class="err" hidden id="trErr"></div>`, () => {
      const W = window.WVE_STATE;
      const host = document.getElementById('modalHost');
      host.querySelector('#trGo').onclick = (e) => run(e.target, W.api.post('/api/editor/tools/translate', {
        project_id: W.S.project.id, language: host.querySelector('#trLang').value, apply: true,
      }), (res) => {
        W.markDirty('Translate');
        W.closeModal();
        W.toast('Translated', `${res.lines.length} lines → ${res.language || res.target}`);
      });
    });

    /* ============================================================== UPLOAD */
    W.panel('upload', {
      title: 'Upload',
      blurb: 'Drop images, video, GIFs or audio into the media library.',
      render(el) {
        el.innerHTML = panelHtml([
          `<div class="dropzone" id="upz"><div><div style="font-size:20px">⬆</div>
            <strong>Drag &amp; drop or choose files</strong>
            <div class="muted tiny">JPG, PNG, WEBP, GIF, MP4, MOV, WEBM, MP3, WAV</div></div>
            <input type="file" id="upFile" multiple hidden></div>`,
          `<div class="bar"><i id="upBar" style="width:0"></i></div>`,
          `<div class="chip-row" id="upTabs">
            <button class="chip active" data-tab="all">All</button>
            <button class="chip" data-tab="image">Images</button>
            <button class="chip" data-tab="video">Videos</button>
            <button class="chip" data-tab="gif">GIFs</button>
            <button class="chip" data-tab="audio">Audios</button>
          </div>`,
          `<div id="upGrid" class="grid g3"></div>`,
        ]);
        let tab = 'all';
        const zone = el.querySelector('#upz');
        const fileInput = el.querySelector('#upFile');
        zone.onclick = () => fileInput.click();
        ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drag'); }));
        ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('drag'); }));
        zone.addEventListener('drop', (e) => upload(Array.from(e.dataTransfer.files || [])));
        fileInput.onchange = () => upload(Array.from(fileInput.files || []));

        function upload(files) {
          files.forEach((file) => {
            const fd = new FormData();
            fd.append('file', file);
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/assets/upload');
            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) el.querySelector('#upBar').style.width = `${(e.loaded / e.total) * 100}%`;
            };
            xhr.onload = () => {
              el.querySelector('#upBar').style.width = '0%';
              if (xhr.status < 400) { paint(); W.toast('Uploaded', file.name); }
              else W.toast('Upload failed', file.name, 'err');
            };
            xhr.onerror = () => W.toast('Upload failed', file.name, 'err');
            xhr.send(fd);
          });
        }

        el.querySelectorAll('[data-tab]').forEach((chip) => {
          chip.onclick = () => { tab = chip.dataset.tab; el.querySelectorAll('[data-tab]').forEach((c) => c.classList.toggle('active', c === chip)); paint(); };
        });

        async function paint() {
          const { items } = await W.api.get('/api/assets');
          const list = items.filter((a) => {
            if (tab === 'all') return true;
            if (tab === 'gif') return (a.name || '').toLowerCase().endsWith('.gif');
            return a.kind === tab;
          });
          el.querySelector('#upGrid').innerHTML = list.length ? list.map((a) => `
            <div class="tile" data-asset="${a.id}">
              <div class="media-thumb" style="background-image:url('${W.mediaUrl(a.thumb || a.media || '')}')">
                ${a.duration ? `<span class="dur">${Math.round(a.duration)}s</span>` : ''}</div>
              <div class="meta"><strong>${esc(a.name || a.kind)}</strong>
                <small>${esc(a.kind)} · ${fmt.bytes(a.size_bytes || 0)}</small>
                <div class="row" style="margin-top:6px">
                  <button class="btn btn-sm" data-add="${a.id}">Add to timeline</button>
                  <button class="btn btn-sm btn-ghost" data-rm="${a.id}">✕</button></div></div>
            </div>`).join('') : '<div class="empty">No assets uploaded yet</div>';
          el.querySelectorAll('[data-asset]').forEach((tile) => {
            tile.onclick = (ev) => {
              const asset = list.find((a) => a.id === tile.dataset.asset);
              if (ev.target.dataset.rm) return;
              if (ev.target.dataset.add && asset) {
                W.mutate('Add media to timeline', (p) => {
                  if (asset.kind === 'audio') {
                    p.audio = p.audio || { items: [] };
                    p.audio.items.push({ id: `au_${Math.random().toString(36).slice(2, 8)}`, media: asset.media,
                      start: S.playhead, end: S.playhead + Math.max(3, asset.duration || 5), volume: 0.35,
                      fade_in: 0.4, fade_out: 0.6, loop: false, duck: true, kind: 'music', name: asset.name });
                  } else {
                    p.broll = p.broll || [];
                    p.broll.push({ id: `br_${Math.random().toString(36).slice(2, 8)}`, media: asset.media,
                      start: S.playhead, end: S.playhead + Math.max(2, asset.duration || 4), from: 0,
                      query: asset.name, kind: 'upload' });
                  }
                });
                W.toast('Added', `${asset.name} → ${asset.kind === 'audio' ? 'audio' : 'B-roll'} track`);
              }
            };
          });
          el.querySelectorAll('[data-rm]').forEach((b) => {
            b.onclick = async (ev) => { ev.stopPropagation(); await W.api.del(`/api/assets/${b.dataset.rm}`); paint(); };
          });
        }
        paint().catch((err) => W.fail(err));
      },
    });

    /* ============================================================ ELEMENTS */
    W.panel('elements', {
      title: 'Elements',
      blurb: 'Stock videos and photos from your licensed library.',
      render(el) {
        el.innerHTML = panelHtml([
          `<div class="row"><input class="input" id="elSearch" placeholder="Search elements (city, nature, money…)" style="flex:1">
            <button class="btn btn-sm" id="elGo">Search</button></div>`,
          `<div id="elStatus"></div>`,
          `<div id="elSections"></div>`,
        ].join(''));
        const status = el.querySelector('#elStatus');

        async function search(kind, query) {
          status.innerHTML = '<div class="small muted">Searching…</div>';
          try {
            const res = await W.api.get(`/api/stock/search?kind=${kind}&q=${encodeURIComponent(query)}&per_page=12`);
            if (!res.configured) {
              status.innerHTML = `<div class="warn small">${esc(res.message || 'No stock provider configured.')}
                <div class="tiny" style="margin-top:6px">Free keys: pexels.com/api or pixabay.com/api/docs → set WV_PEXELS_KEY / WV_PIXABAY_KEY on the backend.</div></div>`;
              return [];
            }
            status.innerHTML = `<div class="tiny muted">${res.provider} · ${esc(res.attribution.licence || '')}</div>`;
            return res.items;
          } catch (err) {
            status.innerHTML = `<div class="err small">${esc(err.message)}</div>`;
            return [];
          }
        }

        async function paint(query) {
          const videos = await search('videos', query || 'abstract');
          const photos = await search('photos', query || 'abstract');
          el.querySelector('#elSections').innerHTML = panelHtml([
            sec('Videos', `<div class="grid g3">${videos.slice(0, 9).map((v) => stockTile(v)).join('') || '<span class="muted tiny">nothing</span>'}</div>`),
            sec('Photos', `<div class="grid g3">${photos.slice(0, 9).map((v) => stockTile(v)).join('') || '<span class="muted tiny">nothing</span>'}</div>`),
          ]);
          el.querySelectorAll('[data-stock]').forEach((tile) => {
            tile.onclick = async (ev) => {
              const item = [...videos, ...photos].find((x) => x.id === tile.dataset.stock);
              if (!item) return;
              if (ev.target.dataset.preview) { W.openModal('stockPreview', { item }); return; }
              if (ev.target.dataset.add) {
                const asset = await run(ev.target, W.api.post('/api/stock/download', {
                  url: item.url, title: item.title, kind: item.kind, thumb: item.thumb, duration: item.duration,
                }), () => W.toast('Downloaded', item.title));
                if (!asset) return;
                W.mutate('Add element', (p) => {
                  p.broll = p.broll || [];
                  p.broll.push({ id: `br_${Math.random().toString(36).slice(2, 8)}`, media: asset.media,
                    start: S.playhead, end: S.playhead + Math.max(2, item.duration || 4), from: 0,
                    query: item.title, kind: 'stock' });
                });
                W.toast('Added to timeline', `${item.kind} at the playhead`);
              }
            };
          });
        }

        function stockTile(item) {
          return `<div class="tile" data-stock="${item.id}">
            <div class="media-thumb" style="background-image:url('${item.thumb}')" data-preview="1">
              ${item.duration ? `<span class="dur">${Math.round(item.duration)}s</span>` : ''}</div>
            <div class="meta"><strong>${esc((item.title || '').slice(0, 40))}</strong>
              <small>${esc(item.author || item.provider)}</small>
              <div class="row" style="margin-top:6px"><button class="btn btn-sm" data-add="1">Add at playhead</button></div></div>
          </div>`;
        }

        el.querySelector('#elGo').onclick = () => paint(el.querySelector('#elSearch').value);
        el.querySelector('#elSearch').onkeydown = (e) => { if (e.key === 'Enter') paint(e.target.value); };
        paint('');
      },
    });

    W.modal('stockPreview', (data) => {
      const item = data.item || {};
      return `<button class="modal-x" data-close>✕</button>
        <h3>${esc(item.title || 'Preview')}</h3>
        <p class="m-sub">${esc(item.author || '')} · ${esc(item.source_url || '')}</p>
        ${item.kind === 'video'
          ? `<video src="${item.url}" controls style="width:100%;border-radius:10px;background:#000"></video>`
          : `<img src="${item.url}" style="width:100%;border-radius:10px">`}
        <div class="small muted" style="margin-top:10px">${esc((data.licence) || 'Pexels/Pixabay licence – free to use.')}</div>`;
    });

    /* =============================================================== B-ROLL */
    W.panel('broll', {
      title: 'B-roll',
      blurb: 'Auto-generate stock or AI visuals timed to the narration.',
      render(el) {
        el.innerHTML = panelHtml([
          `<div class="row"><label class="btn btn-sm btn-ghost">⬆ Upload<input type="file" hidden id="brFile"></label>
            <span class="tiny muted">adds to the library</span></div>`,
          sec('Auto Generate', `
            ${itemRow('AI B-roll', 'LLM picks the moments, then a video model renders them', `${cost('broll_ai')}<button class="btn btn-sm" data-auto="ai">Generate</button>`)}
            ${itemRow('Stock B-roll', 'Same planning, matched from the stock library', `${cost('broll_stock')}<button class="btn btn-sm" data-auto="stock">Generate</button>`)}`),
          sec('Custom B-roll', `
            <input class="input" id="brQuery" placeholder="Search term or prompt (e.g. city timelapse)">
            <div class="split-2" style="margin-top:8px">
              <label class="lbl">From <input class="input" type="number" id="brStart" value="${Math.round(S.playhead)}"></label>
              <label class="lbl">To <input class="input" type="number" id="brEnd" value="${Math.round(S.playhead + 5)}"></label>
            </div>
            <div class="row" style="margin-top:8px">
              <button class="btn btn-sm" data-custom="stock">Find stock</button>
              <button class="btn btn-sm" data-custom="ai">Generate AI clip</button>
            </div>`),
          `<div id="brPlan"></div>`,
          sec('Visual Library', `<div class="row"><input class="input" id="brLib" placeholder="Search stock videos" style="flex:1">
            <button class="btn btn-sm" id="brLibGo">Search</button></div>
            <div id="brLibGrid" class="grid g3" style="margin-top:10px"></div>
            <button class="btn btn-sm btn-ghost btn-block" id="brLibAll">View all</button>`),
          `<div id="brList" class="stack"></div>`,
        ]);

        el.querySelector('#brFile').onchange = async (e) => {
          const fd = new FormData();
          fd.append('file', e.target.files[0]);
          await W.api.post('/api/assets/upload', fd);
          W.toast('Uploaded', 'pick it from Upload → Videos');
        };

        function momentRow(m, i) {
          return `<div class="item" data-moment="${i}">
            <div class="txt"><strong>${fmt.clock(m.start)} → ${fmt.clock(m.end)}</strong><small>${esc(m.query)}</small></div>
            <div class="row"><button class="btn btn-sm" data-find="${i}">Find clip</button></div>
          </div>`;
        }

        function showPlan(plan) {
          el.querySelector('#brPlan').innerHTML = sec(`Planned moments (${plan.moments.length})`, `
            <div class="tiny muted" style="margin-bottom:6px">source: ${esc(plan.source)}</div>
            ${plan.moments.map(momentRow).join('')}`);
          el.querySelectorAll('[data-find]').forEach((btn) => {
            btn.onclick = (ev) => {
              const moment = plan.moments[Number(btn.dataset.find)];
              if (plan.mode === 'ai') {
                run(ev.target, W.api.post('/api/editor/generate/video', {
                  project_id: S.project.id, prompt: moment.query, duration: Math.max(2, moment.end - moment.start),
                  ratio: S.project.aspect, at: moment.start,
                }), (res) => {
                  W.markDirty('AI video');
                  W.toast('AI clip added', `${moment.query} at ${fmt.clock(moment.start)}`);
                  void res;
                });
                return;
              }
              (async () => {
                const res = await W.api.get(`/api/stock/search?kind=videos&q=${encodeURIComponent(moment.query)}&per_page=6`);
                if (!res.configured) { W.toast('Stock not configured', res.message, 'warn'); return; }
                if (!res.items.length) { W.toast('No match', moment.query, 'warn'); return; }
                const best = res.items[0];
                const asset = await run(ev.target, W.api.post('/api/stock/download', {
                  url: best.url, title: best.title, kind: 'video', thumb: best.thumb, duration: best.duration,
                }), () => {});
                if (!asset) return;
                await W.api.post('/api/editor/tools/broll/insert', {
                  project_id: S.project.id,
                  moment: { ...moment, start: moment.start, end: moment.end, kind: 'stock' },
                  asset_id: asset.id,
                });
                W.markDirty('B-roll');
                W.toast('B-roll inserted', `${best.title.slice(0, 40)} at ${fmt.clock(moment.start)}`);
              })();
            };
          });
        }

        el.querySelectorAll('[data-auto]').forEach((btn) => {
          btn.onclick = (e) => run(e.target, W.api.post('/api/editor/tools/broll', {
            project_id: S.project.id, mode: btn.dataset.auto, moments: 5,
          }), (res) => showPlan(res.plan));
        });
        el.querySelectorAll('[data-custom]').forEach((btn) => {
          btn.onclick = (e) => {
            const query = el.querySelector('#brQuery').value.trim();
            if (!query) { W.toast('Type a prompt', 'describe the shot or search term', 'warn'); return; }
            run(e.target, W.api.post('/api/editor/tools/broll', {
              project_id: S.project.id, mode: btn.dataset.custom, query,
              start: Number(el.querySelector('#brStart').value), end: Number(el.querySelector('#brEnd').value),
            }), (res) => showPlan(res.plan));
          };
        });
        el.querySelector('#brLibGo').onclick = () => lib(el.querySelector('#brLib').value);
        el.querySelector('#brLibAll').onclick = () => lib(el.querySelector('#brLib').value, true);
        async function lib(query, all) {
          const grid = el.querySelector('#brLibGrid');
          grid.innerHTML = '<div class="tiny muted">Searching…</div>';
          const res = await W.api.get(`/api/stock/search?kind=videos&q=${encodeURIComponent(query || 'abstract')}&per_page=${all ? 24 : 6}`);
          if (!res.configured) { grid.innerHTML = `<div class="warn tiny">${esc(res.message)}</div>`; return; }
          grid.innerHTML = res.items.map((v) => `<div class="tile" data-lib="${v.id}">
            <div class="media-thumb" style="background-image:url('${v.thumb}')">${v.duration ? `<span class="dur">${Math.round(v.duration)}s</span>` : ''}</div>
            <div class="meta"><small>${esc((v.title || '').slice(0, 30))}</small></div></div>`).join('');
          grid.querySelectorAll('[data-lib]').forEach((tile) => {
            tile.onclick = async () => {
              const item = res.items.find((x) => x.id === tile.dataset.lib);
              const asset = await run(tile, W.api.post('/api/stock/download', {
                url: item.url, title: item.title, kind: 'video', thumb: item.thumb, duration: item.duration,
              }), () => {});
              if (!asset) return;
              W.mutate('Add B-roll', (p) => {
                p.broll = p.broll || [];
                p.broll.push({ id: `br_${Math.random().toString(36).slice(2, 8)}`, media: asset.media,
                  start: S.playhead, end: S.playhead + Math.max(2, item.duration || 4), from: 0,
                  query: item.title, kind: 'stock' });
              });
              W.toast('B-roll added', item.title.slice(0, 40));
            };
          });
        }
        lib('');

        function paintList() {
          const items = S.project.broll || [];
          el.querySelector('#brList').innerHTML = sec(`B-roll track (${items.length})`, items.length ? items.map((b) => `
            <div class="item"><div class="txt"><strong>${fmt.clock(b.start)} → ${fmt.clock(b.end)}</strong>
              <small>${esc(b.query || b.kind)}</small></div>
              <div class="row"><button class="mini" data-br-del="${b.id}">✕</button></div></div>`).join('')
            : '<span class="muted tiny">No B-roll yet.</span>');
          el.querySelectorAll('[data-br-del]').forEach((b) => {
            b.onclick = () => W.mutate('Delete B-roll', (p) => { p.broll = (p.broll || []).filter((x) => x.id !== b.dataset.brDel); });
          });
        }
        paintList();
      },
    });

    /* ============================================================= AI HOOK */
    W.panel('hook', {
      title: 'AI Hook',
      blurb: 'Generate attention-grabbing text hooks.',
      render(el) {
        const title = (S.project.source || {}).title || S.project.name || '';
        el.innerHTML = panelHtml([
          `<div class="small muted">Generate attention-grabbing text hooks.</div>`,
          `<textarea class="input" id="hookText" maxlength="500" rows="3" placeholder="What is the video about?">${esc(title)}</textarea>
           <div class="tiny muted" id="hookCount">${title.length}/500</div>`,
          `<div class="row">
            <select class="input" id="hookPlatform" style="max-width:130px">
              <option value="tiktok">TikTok</option><option value="reels">Instagram Reels</option>
              <option value="youtube">YouTube Shorts</option>
            </select>
            <input class="input" id="hookNiche" placeholder="niche (optional)" style="max-width:130px">
          </div>`,
          `<button class="btn btn-green btn-block" id="hookGo">Auto-Write ${cost('hook')}</button>`,
          `<div id="hookOptions"></div>`,
          sec('Add to timeline', `
            <label class="lbl">Duration on screen <input class="input" type="number" id="hookDur" value="4" step="0.5" min="1" max="12"></label>
            <label class="lbl">Preset <select class="input" id="hookPreset">
              ${((S.meta.captions || {}).text_presets || []).map((p) => `<option value="${p.key}">${esc(p.label)}</option>`).join('')}</select></label>
            ${itemRow('Teaser cold open', 'Pull the most intriguing later moment to the start', sw('teaser', false, 'data-teaser'))}
            <button class="btn btn-block" id="hookAdd" style="margin-top:10px">Add to timeline</button>`),
        ]);
        const text = el.querySelector('#hookText');
        text.oninput = () => { el.querySelector('#hookCount').textContent = `${text.value.length}/500`; };
        let best = '';
        el.querySelector('#hookGo').onclick = (e) => run(e.target, W.api.post('/api/editor/tools/hook', {
          project_id: S.project.id, platform: el.querySelector('#hookPlatform').value,
          niche: el.querySelector('#hookNiche').value, title: text.value,
        }), (res) => {
          best = res.best.hook || (res.hooks[0] || {}).text || '';
          el.querySelector('#hookOptions').innerHTML = sec(`${res.count} hooks · best pick`, `
            <div class="stack">${res.hooks.map((hk, i) => `
              <div class="preset ${res.best.pick === i + 1 ? 'active' : ''}" data-hook="${i}">
                <span><strong>${esc(hk.text)}</strong>
                  <div class="tiny muted">${esc(hk.pattern)} · ${esc(hk.why)}</div>
                  <div class="tiny muted">spoken: ${esc(hk.spoken)}</div></span>
                ${res.best.pick === i + 1 ? '<span class="chip active">★</span>' : ''}
              </div>`).join('')}</div>
            <div class="small" style="margin-top:10px"><b>Why this one:</b> ${esc(res.best.reason)}</div>
            <div class="small" style="margin-top:6px"><b>A/B variant:</b> ${esc(res.ab_test)}</div>
            <div class="tiny muted" style="margin-top:8px">${esc(res.research_note)}</div>
            <button class="btn btn-sm btn-ghost btn-block" id="hookAgain" style="margin-top:8px">Regenerate</button>`);
          el.querySelector('#hookOptions').querySelectorAll('[data-hook]').forEach((node) => {
            node.onclick = () => {
              text.value = res.hooks[Number(node.dataset.hook)].text;
              el.querySelector('#hookCount').textContent = `${text.value.length}/500`;
              best = text.value;
            };
          });
          const again = el.querySelector('#hookAgain');
          if (again) again.onclick = () => el.querySelector('#hookGo').click();
        });
        el.querySelector('#hookAdd').onclick = (e) => {
          const value = (text.value || best).trim();
          if (!value) { W.toast('Write a hook first', 'Auto-Write or type one', 'warn'); return; }
          const teaser = el.querySelector('[data-teaser]').checked;
          run(e.target, W.api.post('/api/editor/tools/hook/add', {
            project_id: S.project.id, text: value, start: 0,
            duration: Number(el.querySelector('#hookDur').value) || 4,
            preset: el.querySelector('#hookPreset').value, teaser,
            source_start: teaser ? Math.min((S.project.duration || 10) * 0.6, (S.project.duration || 10) - 6) : null,
          }), () => {
            W.markDirty('Add hook');
            W.toast(teaser ? 'Hook + teaser added' : 'Hook added', 'edit it any time in the Text tool');
          });
        };
      },
    });

    /* =============================================================== TEXT */
    W.panel('text', {
      title: 'Text',
      blurb: 'Headings, body text and preset styles.',
      render(el) {
        const presets = (S.meta.captions || {}).text_presets || [];
        const sel = selectedTextItem();
        el.innerHTML = panelHtml([
          `<div class="row"><button class="btn btn-sm btn-green" data-addtext="heading">+ Heading</button>
            <button class="btn btn-sm" data-addtext="body">+ Body text</button></div>`,
          sec('Preset styles', `<div class="grid g3">${presets.map((p) => `
            <div class="tile" data-textpreset="${p.key}" style="${sel && sel.preset === p.key ? 'border-color:rgba(0,255,156,.6)' : ''}">
              <div class="preview" style="aspect-ratio:16/9;background:#0f151c"><span style="font-size:11px;padding:3px 7px;border-radius:4px;color:${(p.style || {}).color || '#fff'};background:${(p.style || {}).background && (p.style || {}).background !== 'none' ? (p.style || {}).background : 'transparent'};border:1px solid rgba(255,255,255,.2)">Text</span></div>
              <div class="meta"><small>${esc(p.label)}</small></div></div>`).join('')}</div>`),
          sec('Selected text', sel ? `
            <label class="lbl">Content</label>
            <textarea class="input" id="txtContent" rows="2">${esc(sel.text)}</textarea>
            <div class="split-2" style="margin-top:8px">
              <label class="lbl">Start <input class="input" type="number" step="0.1" id="txtStart" value="${(sel.start || 0).toFixed(1)}"></label>
              <label class="lbl">End <input class="input" type="number" step="0.1" id="txtEnd" value="${(sel.end || 3).toFixed(1)}"></label>
            </div>
            <label class="lbl">Size <select class="input" id="txtSize">
              ${['small', 'medium', 'large', 'xlarge'].map((s) => `<option ${(sel.style || {}).size === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
            <label class="lbl">Y position <input class="input" type="range" min="0.05" max="0.95" step="0.01" id="txtY" value="${(sel.style || {}).y == null ? 0.5 : sel.style.y}"></label>
            <label class="lbl">Animation in <select class="input" id="txtAnim">
              ${(((S.meta.captions || {}).animations_in) || ['fade']).map((a) => `<option ${(sel.style || {}).animation_in === a ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
            <button class="btn btn-sm btn-danger btn-block" id="txtDel" style="margin-top:10px">Delete text</button>`
            : '<span class="muted small">Select a text or hook item on the timeline.</span>'),
          sec('All text', `<div class="stack" id="txtList"></div>`),
        ]);
        el.querySelectorAll('[data-addtext]').forEach((btn) => {
          btn.onclick = () => {
            const kind = btn.dataset.addtext;
            W.mutate('Add text', (p) => {
              p.texts = p.texts || [];
              p.texts.push({
                id: `tx_${Math.random().toString(36).slice(2, 8)}`,
                kind, text: kind === 'heading' ? 'Heading' : 'Body text',
                start: S.playhead, end: S.playhead + 3,
                preset: kind === 'heading' ? 'boxed_white' : 'outlined',
                style: { y: kind === 'heading' ? 0.2 : 0.75, size: kind === 'heading' ? 'large' : 'medium',
                         x: 0.5, animation_in: 'fade', animation_out: 'fade' },
              });
            });
            W.toast('Text added', 'double-click it on the preview… edit it here');
          };
        });
        el.querySelectorAll('[data-textpreset]').forEach((tile) => {
          tile.onclick = () => {
            if (!sel) { W.toast('Select a text item first', 'then apply a preset', 'warn'); return; }
            W.mutate('Text preset', (p) => {
              const item = [...(p.texts || []), ...(p.hooks || [])].find((t) => t.id === sel.id);
              if (item) item.preset = tile.dataset.textpreset;
            });
            W.renderPanel();
          };
        });
        if (sel) {
          const update = (patch) => W.mutate('Edit text', (p) => {
            const item = [...(p.texts || []), ...(p.hooks || [])].find((t) => t.id === sel.id);
            if (!item) return;
            if (patch.style) item.style = { ...(item.style || {}), ...patch.style };
            Object.entries(patch).forEach(([k, v]) => { if (k !== 'style') item[k] = v; });
          });
          el.querySelector('#txtContent').onchange = (e) => update({ text: e.target.value });
          el.querySelector('#txtStart').onchange = (e) => update({ start: Number(e.target.value) });
          el.querySelector('#txtEnd').onchange = (e) => update({ end: Number(e.target.value) });
          el.querySelector('#txtSize').onchange = (e) => update({ style: { size: e.target.value } });
          el.querySelector('#txtY').oninput = (e) => update({ style: { y: Number(e.target.value) } });
          el.querySelector('#txtAnim').onchange = (e) => update({ style: { animation_in: e.target.value } });
          el.querySelector('#txtDel').onclick = () => {
            W.mutate('Delete text', (p) => {
              p.texts = (p.texts || []).filter((t) => t.id !== sel.id);
              p.hooks = (p.hooks || []).filter((t) => t.id !== sel.id);
            });
            W.renderPanel();
          };
        }
        const all = [...(S.project.texts || []), ...(S.project.hooks || [])];
        el.querySelector('#txtList').innerHTML = all.length ? all.map((t) => `
          <div class="item" data-picktext="${t.id}">
            <div class="txt"><strong>${esc(t.text)}</strong><small>${fmt.clock(t.start)} → ${fmt.clock(t.end)} · ${esc(t.preset || '')}</small></div>
            <span class="tag">${t.kind || 'hook'}</span></div>`).join('') : '<span class="muted tiny">No text items.</span>';
        el.querySelectorAll('[data-picktext]').forEach((row) => {
          row.onclick = () => {
            const id = row.dataset.picktext;
            const inTexts = (S.project.texts || []).some((t) => t.id === id);
            S.selection = { clip: null, track: inTexts ? 'text' : 'hook', item: id };
            W.renderPanel();
          };
        });
      },
    });

    /* ============================================================== AUDIO */
    W.panel('audio', {
      title: 'Audio',
      blurb: 'Music, sound effects and audio uploads — all licensed or generated.',
      render(el) {
        let tab = 'all';
        const item = audioItem();
        el.innerHTML = panelHtml([
          `<div class="chip-row">
            <button class="chip ${tab === 'all' ? 'active' : ''}" data-atab="all">All</button>
            <button class="chip" data-atab="music">Music</button>
            <button class="chip" data-atab="sfx">Sound Effect</button>
          </div>`,
          `<div class="row"><label class="btn btn-sm btn-ghost">⬆ Upload<input type="file" hidden id="auFile" accept="audio/*"></label>
            <button class="btn btn-sm" id="auMusic">AI Music ${cost('ai_music')}</button>
            <button class="btn btn-sm" id="auSfx">AI Sound Effect ${cost('ai_sfx')}</button></div>`,
          `<div class="row"><input class="input" id="auSearch" placeholder="Search copyright free audio" style="flex:1">
            <button class="btn btn-sm" id="auSearchGo">Search</button></div>`,
          `<div id="auStatus"></div>`,
          sec('Library', `<div class="stack" id="auList"></div>`),
          item ? sec('Selected audio', `
            <label class="lbl">Volume <input class="input" type="range" min="0" max="1" step="0.05" id="auVol" value="${item.volume}"></label>
            <div class="split-2">
              <label class="lbl">Fade in <input class="input" type="number" step="0.1" id="auIn" value="${item.fade_in || 0}"></label>
              <label class="lbl">Fade out <input class="input" type="number" step="0.1" id="auOut" value="${item.fade_out || 0}"></label>
            </div>
            ${itemRow('Loop', 'Repeat until the item ends', sw('loop', !!item.loop, 'data-loop'))}
            ${itemRow('Auto-ducking', 'Lower the music under speech', sw('duck', item.duck !== false, 'data-duck'))}
            <div class="split-2" style="margin-top:8px">
              <label class="lbl">Start <input class="input" type="number" step="0.1" id="auStart" value="${item.start}"></label>
              <label class="lbl">End <input class="input" type="number" step="0.1" id="auEnd" value="${item.end}"></label>
            </div>`)
            : sec('Selected audio', '<span class="muted small">Select an audio item on the timeline.</span>'),
        ]);

        el.querySelectorAll('[data-atab]').forEach((chip) => {
          chip.onclick = () => { tab = chip.dataset.atab; el.querySelectorAll('[data-atab]').forEach((c) => c.classList.toggle('active', c === chip)); paint(); };
        });
        el.querySelector('#auFile').onchange = async (e) => {
          const fd = new FormData();
          fd.append('file', e.target.files[0]);
          await W.api.post('/api/assets/upload', fd);
          W.toast('Uploaded', 'choose it below to add to the timeline');
          paint();
        };
        el.querySelector('#auMusic').onclick = async (e) => {
          const prompt = window.prompt('Describe the music (or a mood: lofi, epic, calm…)', 'lofi study beat');
          if (!prompt) return;
          await run(e.target, W.api.post('/api/editor/generate/music', {
            project_id: S.project.id, prompt, mood: prompt.split(' ')[0],
            duration: Math.min(60, Math.max(8, Math.round(S.project.duration || 20))), start: 0,
          }), (res) => {
            W.markDirty('AI music');
            W.toast('Music added', res.provider + (res.note ? ` — ${res.note}` : ''));
            paint();
          });
        };
        el.querySelector('#auSfx').onclick = async (e) => {
          const prompt = window.prompt('Describe the sound effect', 'whoosh transition');
          if (!prompt) return;
          await run(e.target, W.api.post('/api/editor/generate/sfx', {
            project_id: S.project.id, prompt, at: S.playhead,
          }), (res) => {
            W.markDirty('AI sound effect');
            W.toast('Sound effect placed', res.provider);
            paint();
          });
        };
        el.querySelector('#auSearchGo').onclick = () => searchAudio(el.querySelector('#auSearch').value);
        async function searchAudio(query) {
          const status = el.querySelector('#auStatus');
          status.innerHTML = '<div class="tiny muted">Searching…</div>';
          const res = await W.api.get(`/api/stock/search?kind=audio&q=${encodeURIComponent(query || 'music')}&per_page=10`);
          if (!res.configured) {
            status.innerHTML = `<div class="warn small">${esc(res.message)}</div>
              <div class="tiny muted">Tip: upload your own licensed tracks, or use AI Music which generates a royalty-free bed locally.</div>`;
            return;
          }
          status.innerHTML = res.items.map((t) => `<div class="preset" data-audio="${t.id}">
            <span><strong>${esc(t.title)}</strong><div class="tiny muted">${esc(t.author)} · ${t.duration}s</div></span>
            <button class="btn btn-sm" data-addaudio="${t.id}">Add</button></div>`).join('');
          el.querySelectorAll('[data-addaudio]').forEach((b) => {
            b.onclick = async (ev) => {
              const track = res.items.find((x) => x.id === b.dataset.addaudio);
              ev.stopPropagation();
              const asset = await run(b, W.api.post('/api/stock/download', {
                url: track.url, title: track.title, kind: 'audio', duration: track.duration,
              }), () => W.toast('Downloaded', track.title));
              if (asset) addAudio(asset, track.duration);
            };
          });
        }

        function addAudio(asset, duration) {
          W.mutate('Add audio', (p) => {
            p.audio = p.audio || { items: [] };
            p.audio.items.push({ id: `au_${Math.random().toString(36).slice(2, 8)}`, media: asset.media,
              start: S.playhead, end: S.playhead + Math.max(3, duration || 10), from: 0,
              volume: 0.35, fade_in: 0.4, fade_out: 0.6, loop: true, duck: true, kind: 'music', name: asset.name });
          });
          W.toast('Added', `${asset.name} on the audio track`);
        }

        async function paint() {
          const { items } = await W.api.get('/api/assets?kind=audio');
          const list = items.filter((a) => (tab === 'sfx' ? (a.tag === 'sfx' || /sfx|whoosh|pop/i.test(a.name || ''))
            : tab === 'music' ? a.tag !== 'sfx' : true));
          el.querySelector('#auList').innerHTML = list.length ? list.map((a) => `
            <div class="item" data-audioasset="${a.id}">
              <div class="txt"><strong>${esc(a.name || 'audio')}</strong><small>${esc(a.source || 'upload')} · ${a.duration || 0}s</small></div>
              <div class="row">
                <button class="mini" data-previewaudio="${a.id}" title="Preview">▶</button>
                <button class="btn btn-sm" data-addtomix="${a.id}">Add</button>
              </div></div>`).join('') : '<span class="muted small">No audio yet — upload, or generate with AI Music.</span>';
          let current = null;
          el.querySelectorAll('[data-previewaudio]').forEach((b) => {
            b.onclick = (e) => {
              e.stopPropagation();
              const asset = list.find((a) => a.id === b.dataset.previewaudio);
              if (current) { current.pause(); current = null; }
              current = new Audio(W.mediaUrl(asset.media));
              current.play().catch(() => W.toast('Cannot preview', 'the file may be an unsupported codec', 'warn'));
            };
          });
          el.querySelectorAll('[data-addtomix]').forEach((b) => {
            b.onclick = (e) => {
              e.stopPropagation();
              const asset = list.find((a) => a.id === b.dataset.addtomix);
              addAudio(asset, asset.duration);
            };
          });
        }

        if (item) {
          const upd = (patch) => W.mutate('Audio settings', (p) => {
            const target = (((p.audio || {}).items) || []).find((i) => i.id === item.id);
            if (target) Object.assign(target, patch);
          });
          el.querySelector('#auVol').oninput = (e) => upd({ volume: Number(e.target.value) });
          el.querySelector('#auIn').onchange = (e) => upd({ fade_in: Number(e.target.value) });
          el.querySelector('#auOut').onchange = (e) => upd({ fade_out: Number(e.target.value) });
          el.querySelector('#auStart').onchange = (e) => upd({ start: Number(e.target.value) });
          el.querySelector('#auEnd').onchange = (e) => upd({ end: Number(e.target.value) });
          el.querySelector('[data-loop]').onchange = (e) => upd({ loop: e.target.checked });
          el.querySelector('[data-duck]').onchange = (e) => upd({ duck: e.target.checked });
        }
        paint().catch((err) => W.fail(err));
      },
    });

    /* ========================================================= TRANSITION */
    W.panel('transition', {
      title: 'Transition',
      blurb: 'Drag onto a junction, or click the junction on the timeline.',
      render(el) {
        const transitions = (S.meta.transitions || []);
        const clip = selectedClip() || (S.project.clips || [])[0];
        el.innerHTML = panelHtml([
          `<div class="card" id="trIntro"><div class="small">Add transitions by dragging and dropping them, or by clicking between two clips on the timeline.</div>
            <div class="row" style="margin-top:10px"><button class="btn btn-sm" id="trOk">OK</button></div></div>`,
          sec('Auto Transitions', `${itemRow('Apply all', 'Detects cuts and picks suitable transitions', `${cost('auto_transitions')}<button class="btn btn-sm" id="trAuto">Apply all</button>`)}`),
          sec('Transition Types', `<div class="grid g3">${transitions.map((t) => `
            <div class="tile" data-trans="${t.key}">
              <div class="preview" style="aspect-ratio:16/9;background:#0f151c;position:relative;overflow:hidden">
                <div style="position:absolute;inset:0;background:linear-gradient(90deg,#1f2c38 0 50%,#2f4250 50% 100%);animation:slide 1.6s infinite alternate"></div>
                <span class="tiny" style="position:absolute;bottom:4px;left:6px">${esc(t.label)}</span>
              </div>
              <div class="meta"><small>${esc(t.blurb || '')}</small></div></div>`).join('')}</div>
            <style>@keyframes slide{from{transform:translateX(-8%)}to{transform:translateX(8%)}}</style>`),
          sec('Duration', `<label class="lbl">Seconds <input class="input" type="number" id="trDur" step="0.1" min="0.1" max="2" value="${((clip || {}).transition || {}).duration || 0.4}"></label>
            <div class="row" style="margin-top:8px"><button class="btn btn-sm btn-danger" id="trRemove">Remove transition</button></div>`),
        ]);
        el.querySelector('#trIntro').querySelector('#trOk').onclick = () => el.querySelector('#trIntro').remove();
        el.querySelectorAll('[data-trans]').forEach((tile) => {
          tile.onclick = () => {
            if (!guardSelectClip(tile)) return;
            const key = tile.dataset.trans;
            W.mutate('Set transition', (p) => {
              const target = (p.clips || []).find((c) => c.id === S.selection.clip);
              if (target) target.transition = { type: key, duration: Number(el.querySelector('#trDur').value) || 0.4 };
            });
            W.toast('Transition set', key);
          };
        });
        el.querySelector('#trDur').onchange = (e) => {
          if (!selectedClip()) return;
          W.mutate('Transition duration', (p) => {
            const target = (p.clips || []).find((c) => c.id === S.selection.clip);
            if (target) target.transition = { ...(target.transition || { type: 'fade' }), duration: Number(e.target.value) };
          });
        };
        el.querySelector('#trRemove').onclick = () => {
          if (!guardSelectClip(el.querySelector('#trRemove'))) return;
          W.mutate('Remove transition', (p) => {
            const target = (p.clips || []).find((c) => c.id === S.selection.clip);
            if (target) target.transition = { type: 'none', duration: 0.4 };
          });
        };
        el.querySelector('#trAuto').onclick = (e) => run(e.target, Promise.resolve(1), () => {
          const types = transitions.map((t) => t.key).filter((k) => k !== 'none');
          W.mutate('Auto transitions', (p) => {
            (p.clips || []).forEach((c, i) => {
              c.transition = i === 0 ? { type: 'none', duration: 0.3 }
                : { type: types[i % types.length] || 'fade', duration: 0.4 };
            });
          });
          W.toast('Auto transitions', 'applied to every cut');
        });
      },
    });

    /* ============================================================= EFFECTS */
    W.panel('effects', {
      title: 'Effects',
      blurb: 'Stackable looks. They preview live and render in the export.',
      render(el) {
        const effects = (S.meta.effects || []);
        const clip = selectedClip();
        el.innerHTML = panelHtml([
          !clip ? '<div class="warn small">Select a clip on the video track to apply effects.</div>' : '',
          sec('Gallery', `<div class="grid g3">${effects.map((e) => `
            <div class="tile" data-effect="${e.key}">
              <div class="preview" style="aspect-ratio:16/9;background:#0f151c"><span class="tiny">${esc(e.label)}</span></div>
              <div class="meta"><button class="btn btn-sm btn-block" data-apply="${e.key}">Apply</button></div>
            </div>`).join('')}</div>`),
          clip ? sec('On this clip', `
            <label class="lbl">Intensity <input class="input" type="range" min="0.1" max="1" step="0.05" id="fxInt" value="0.5"></label>
            <div class="split-2">
              <label class="lbl">From <input class="input" type="number" step="0.1" id="fxStart" value="${Number(clip.start).toFixed(1)}"></label>
              <label class="lbl">To <input class="input" type="number" step="0.1" id="fxEnd" value="${Number(clip.end).toFixed(1)}"></label>
            </div>
            <div class="stack" style="margin-top:10px" id="fxList"></div>`) : '',
        ]);

        function paintList() {
          const target = selectedClip();
          const host = el.querySelector('#fxList');
          if (!target || !host) return;
          host.innerHTML = (target.effects || []).length ? target.effects.map((fx) => `
            <div class="item"><div class="txt"><strong>${esc(fx.type)}</strong>
              <small>${Number(fx.start).toFixed(1)}s → ${Number(fx.end).toFixed(1)}s · intensity ${fx.intensity}</small></div>
              <button class="mini" data-fxdel="${fx.id || fx.type}">✕</button></div>`).join('')
            : '<span class="muted tiny">No effects on this clip yet.</span>';
          host.querySelectorAll('[data-fxdel]').forEach((b) => {
            b.onclick = () => W.mutate('Remove effect', (p) => {
              const target = (p.clips || []).find((c) => c.id === S.selection.clip);
              if (target) target.effects = (target.effects || []).filter((fx) => (fx.id || fx.type) !== b.dataset.fxdel);
            });
          });
        }

        el.querySelectorAll('[data-apply]').forEach((btn) => {
          btn.onclick = (e) => {
            e.stopPropagation();
            if (!guardSelectClip(btn)) return;
            const start = Number(el.querySelector('#fxStart').value);
            const end = Number(el.querySelector('#fxEnd').value);
            const intensity = Number(el.querySelector('#fxInt').value);
            W.mutate('Apply effect', (p) => {
              const target = (p.clips || []).find((c) => c.id === S.selection.clip);
              if (!target) return;
              target.effects = target.effects || [];
              target.effects.push({ id: `fx_${Math.random().toString(36).slice(2, 7)}`, type: btn.dataset.apply,
                                    intensity, start, end });
            });
            paintList();
            W.toast('Effect added', btn.dataset.apply);
          };
        });
        paintList();
      },
    });

    /* ============================================================= DETAILS */
    W.panel('details', {
      title: 'Details',
      blurb: 'Properties of the selected clip or item.',
      render(el) {
        const clip = selectedClip();
        const text = selectedTextItem();
        const audio = audioItem();
        if (!clip && !text && !audio) {
          el.innerHTML = '<div class="empty">Select a clip, text or audio item on the timeline.</div>';
          return;
        }
        if (text) {
          el.innerHTML = sec('Text item', `
            <label class="lbl">Opacity <input class="input" type="range" min="0.1" max="1" step="0.05" id="dtOpacity" value="1"></label>
            <div class="split-2">
              <label class="lbl">Start <input class="input" type="number" step="0.1" id="dtStart" value="${text.start}"></label>
              <label class="lbl">Duration <input class="input" type="number" step="0.1" id="dtDur" value="${(text.end - text.start).toFixed(1)}"></label>
            </div>
            <label class="lbl">Rotation <input class="input" type="range" min="-180" max="180" step="1" id="dtRot" value="${(text.style || {}).rotation || 0}"></label>`);
          el.querySelector('#dtStart').onchange = (e) => W.mutate('Item start', (p) => {
            const item = [...(p.texts || []), ...(p.hooks || [])].find((t) => t.id === text.id);
            if (!item) return;
            const span = item.end - item.start;
            item.start = Number(e.target.value); item.end = item.start + span;
          });
          el.querySelector('#dtDur').onchange = (e) => W.mutate('Item duration', (p) => {
            const item = [...(p.texts || []), ...(p.hooks || [])].find((t) => t.id === text.id);
            if (item) item.end = item.start + Number(e.target.value);
          });
          el.querySelector('#dtRot').oninput = (e) => W.mutate('Item rotation', (p) => {
            const item = [...(p.texts || []), ...(p.hooks || [])].find((t) => t.id === text.id);
            if (item) item.style = { ...(item.style || {}), rotation: Number(e.target.value) };
          });
          return;
        }
        if (audio) {
          el.innerHTML = sec('Audio item', `
            <label class="lbl">Volume <input class="input" type="range" min="0" max="1" step="0.05" id="daVol" value="${audio.volume}"></label>
            <label class="lbl">Layer order <input class="input" type="number" id="daZ" value="1"></label>`);
          el.querySelector('#daVol').oninput = (e) => W.mutate('Volume', (p) => {
            const item = (((p.audio || {}).items) || []).find((i) => i.id === audio.id);
            if (item) item.volume = Number(e.target.value);
          });
          return;
        }
        const t = clip.transform || {};
        const crop = clip.crop || {};
        el.innerHTML = panelHtml([
          sec('Transform', `
            <div class="split-2">
              <label class="lbl">Position X <input class="input" type="range" min="-0.45" max="0.45" step="0.01" id="dpX" value="${t.x || 0}"></label>
              <label class="lbl">Position Y <input class="input" type="range" min="-0.45" max="0.45" step="0.01" id="dpY" value="${t.y || 0}"></label>
            </div>
            <label class="lbl">Scale <input class="input" type="range" min="0.5" max="2" step="0.01" id="dpScale" value="${t.scale || 1}"></label>
            <label class="lbl">Rotation <input class="input" type="range" min="-180" max="180" step="1" id="dpRot" value="${t.rotation || 0}"></label>
            <label class="lbl">Opacity <input class="input" type="range" min="0.05" max="1" step="0.05" id="dpOpacity" value="${t.opacity == null ? 1 : t.opacity}"></label>
            ${itemRow('Flip horizontal', '', sw('flip', !!t.flip_h, 'data-flip'))}`),
          sec('Crop', `
            <div class="split-2">
              <label class="lbl">Width <input class="input" type="range" min="0.2" max="1" step="0.01" id="dcW" value="${crop.w || 1}"></label>
              <label class="lbl">Height <input class="input" type="range" min="0.2" max="1" step="0.01" id="dcH" value="${crop.h || 1}"></label>
            </div>
            <div class="split-2">
              <label class="lbl">Centre X <input class="input" type="range" min="0" max="1" step="0.01" id="dcX" value="${crop.x == null ? 0.5 : crop.x}"></label>
              <label class="lbl">Centre Y <input class="input" type="range" min="0" max="1" step="0.01" id="dcY" value="${crop.y == null ? 0.5 : crop.y}"></label>
            </div>`),
          sec('Timing & audio', `
            <div class="split-2">
              <label class="lbl">Speed <input class="input" type="number" min="0.25" max="4" step="0.05" id="dpSpeed" value="${clip.speed || 1}"></label>
              <label class="lbl">Volume <input class="input" type="range" min="0" max="1" step="0.05" id="dpVol" value="${clip.volume == null ? 1 : clip.volume}"></label>
            </div>
            <div class="split-2">
              <label class="lbl">Fade in <input class="input" type="number" step="0.1" id="dpFadeIn" value="${clip.fade_in || 0}"></label>
              <label class="lbl">Fade out <input class="input" type="number" step="0.1" id="dpFadeOut" value="${clip.fade_out || 0}"></label>
            </div>
            <div class="split-2">
              <label class="lbl">Start <input class="input" type="number" step="0.1" id="dpStart" value="${clip.start}"></label>
              <label class="lbl">End <input class="input" type="number" step="0.1" id="dpEnd" value="${clip.end}"></label>
            </div>
            <label class="lbl">Layer order <input class="input" type="number" id="dpZ" value="${clip.z || 1}"></label>
            <label class="lbl">Blend mode <select class="input" id="dpBlend">
              ${['normal', 'screen', 'multiply', 'overlay', 'lighten'].map((b) => `<option ${clip.blend === b ? 'selected' : ''}>${b}</option>`).join('')}</select></label>`),
        ]);
        const upd = (path, value) => W.mutate('Clip properties', (p) => {
          const target = (p.clips || []).find((c) => c.id === clip.id);
          if (!target) return;
          if (path.startsWith('transform.')) {
            target.transform = { ...(target.transform || {}), [path.slice(10)]: value };
          } else if (path.startsWith('crop.')) {
            target.crop = { ...(target.crop || {}), [path.slice(5)]: value };
          } else {
            target[path] = value;
          }
        });
        const bind = (id, path, cast) => {
          const node = el.querySelector(`#${id}`);
          if (node) node.oninput = node.onchange = () => upd(path, cast ? cast(node.value) : node.value);
        };
        bind('dpX', 'transform.x', Number);
        bind('dpY', 'transform.y', Number);
        bind('dpScale', 'transform.scale', Number);
        bind('dpRot', 'transform.rotation', Number);
        bind('dpOpacity', 'transform.opacity', Number);
        bind('dcW', 'crop.w', Number);
        bind('dcH', 'crop.h', Number);
        bind('dcX', 'crop.x', Number);
        bind('dcY', 'crop.y', Number);
        bind('dpSpeed', 'speed', Number);
        bind('dpVol', 'volume', Number);
        bind('dpFadeIn', 'fade_in', Number);
        bind('dpFadeOut', 'fade_out', Number);
        bind('dpStart', 'start', Number);
        bind('dpEnd', 'end', Number);
        bind('dpZ', 'z', Number);
        bind('dpBlend', 'blend');
        el.querySelector('[data-flip]').onchange = (e) => upd('transform.flip_h', e.target.checked);
      },
    });

    /* ============================================================= MODALS */
    W.modal('export', () => {
      const S2 = window.WVE_STATE.S;
      const resolutions = (S2.meta.resolutions || []).map((r) => r.key);
      const free = S2.meta.credits.plan === 'free';
      return `
      <button class="modal-x" data-close>✕</button>
      <h3>Export</h3>
      <p class="m-sub">Server-side FFmpeg render. The preview matches the export: layouts, captions, effects, transitions and the audio mix.</p>
      <div class="split-2">
        <div><label class="lbl">Resolution</label>
          <select class="input" id="exRes">${resolutions.map((r) => `<option value="${r}" ${r === '1080p' ? 'selected' : ''}>${r === '4k' ? '4K ◆' : r}</option>`).join('')}</select></div>
        <div><label class="lbl">Format</label><select class="input" id="exFmt"><option value="mp4">MP4 (H.264 + AAC)</option></select></div>
      </div>
      <div class="split-2">
        <div><label class="lbl">Frame rate</label><select class="input" id="exFps">
          <option value="24">24</option><option value="30" selected>30</option><option value="60">60</option></select></div>
        <div><label class="lbl">Quality</label><select class="input" id="exQuality">
          <option value="high" selected>High</option><option value="balanced">Balanced</option><option value="small">Small file</option></select></div>
      </div>
      <div class="stack" style="margin-top:12px">
        <label class="switch"><input type="checkbox" id="exSubs" checked><span class="track-sw"></span>
          <span class="small">Burn in subtitles &amp; text</span></label>
        <label class="switch"><input type="checkbox" id="exWm" ${free ? 'checked disabled' : ''}><span class="track-sw"></span>
          <span class="small">Watermark ${free ? '(forced on the free plan ◆)' : ''}</span></label>
      </div>
      <div class="row" style="margin-top:16px"><button class="btn btn-green" id="exGo">Export ${cost('export')}</button>
        <span class="muted tiny" id="exHint"></span></div>
      <div id="exProgress" style="margin-top:14px"></div>`;
    }, () => {
      const W = window.WVE_STATE;
      const host = document.getElementById('modalHost');
      const progress = host.querySelector('#exProgress');
      host.querySelector('#exGo').onclick = async (e) => {
        const body = {
          project_id: W.S.project.id,
          resolution: host.querySelector('#exRes').value,
          fps: Number(host.querySelector('#exFps').value),
          quality: host.querySelector('#exQuality').value,
          burn_subtitles: host.querySelector('#exSubs').checked,
          watermark: host.querySelector('#exWm').checked,
        };
        const res = await run(e.target, W.api.post('/api/editor/export', body), null);
        if (!res) return;
        progress.innerHTML = `<div class="proc"><div class="spread"><strong id="exStage">Queued</strong><span class="mono" id="exPct">0%</span></div>
          <div class="bar" style="margin-top:8px"><i id="exBar" style="width:0"></i></div></div>`;
        const timer = setInterval(async () => {
          let st;
          try { st = await W.api.get(`/api/editor/status/${res.task_id}`); }
          catch (err) { clearInterval(timer); progress.innerHTML = `<div class="err">${esc(err.message)}</div>`; return; }
          progress.querySelector('#exStage').textContent = st.stage;
          progress.querySelector('#exPct').textContent = `${Math.round(st.progress)}%`;
          progress.querySelector('#exBar').style.width = `${st.progress}%`;
          if (st.status === 'done') {
            clearInterval(timer);
            const r = st.result;
            progress.innerHTML = `<div class="ok">Export ready · ${r.width}×${r.height} · ${fmt.bytes(r.size_bytes)} · ${r.duration}s</div>
              <video src="${W.mediaUrl(r.url)}" controls style="width:100%;margin-top:10px;border-radius:10px;background:#000"></video>
              <div class="row" style="margin-top:10px"><a class="btn btn-green" href="${W.mediaUrl(r.url)}" download="${r.download_name}">Download</a>
              <span class="muted tiny">Saved to the Library</span></div>`;
            W.refreshNotifications();
            W.openProject(W.S.project.id);
          } else if (st.status === 'error') {
            clearInterval(timer);
            progress.innerHTML = `<div class="err">${esc(st.error || 'export failed')}</div>`;
          }
        }, 900);
      };
    });

    W.modal('publish', () => `
      <button class="modal-x" data-close>✕</button>
      <h3>Publish</h3>
      <p class="m-sub">Connect an account, pick platforms, then publish now or schedule.</p>
      <div id="pubAccounts" class="stack"></div>
      <label class="lbl">Title</label><input class="input" id="pubTitle" value="${esc((window.WVE_STATE.S.project.source || {}).title || window.WVE_STATE.S.project.name || '')}">
      <button class="btn btn-sm btn-ghost" id="pubTitleAi" style="margin-top:6px">Generate titles ${cost('title')}</button>
      <label class="lbl">Description</label><textarea class="input" id="pubDesc" rows="3"></textarea>
      <button class="btn btn-sm btn-ghost" id="pubDescAi" style="margin-top:6px">Generate description ${cost('description')}</button>
      <label class="lbl">Hashtags</label><input class="input" id="pubTags" placeholder="#shorts #viral">
      <label class="lbl">Thumbnail</label>
      <div class="row" id="pubThumbs"></div>
      <label class="lbl">When</label>
      <div class="row"><input class="input" type="datetime-local" id="pubWhen" style="max-width:240px">
        <label class="switch"><input type="checkbox" id="pubNow" checked><span class="track-sw"></span><span class="small">Publish now</span></label></div>
      <div class="err" hidden id="pubErr"></div>
      <div class="row" style="margin-top:16px"><button class="btn btn-green" id="pubGo">Publish</button></div>`,
      async () => {
        const W = window.WVE_STATE;
        const S2 = W.S;
        const host = document.getElementById('modalHost');
        const err = host.querySelector('#pubErr');
        const data = await W.api.get('/api/publish/accounts');
        host.querySelector('#pubAccounts').innerHTML = data.platforms.map((p) => `
          <div class="item"><div class="txt"><strong>${esc(p.label)}</strong>
            <small>${p.connected ? `connected as ${esc(p.account || 'account')}` : (p.configured ? 'ready to connect' : 'server has no OAuth credentials')}</small></div>
            <div class="row">
              <label class="switch"><input type="checkbox" data-platform="${p.key}" ${p.connected ? 'checked' : ''}><span class="track-sw"></span></label>
              ${p.connected ? `<button class="btn btn-sm btn-ghost" data-disconnect="${p.key}">Disconnect</button>`
                : `<button class="btn btn-sm" data-connect="${p.key}">Connect</button>`}
            </div></div>`).join('');
        host.querySelectorAll('[data-connect]').forEach((b) => {
          b.onclick = async () => {
            try {
              await W.api.post('/api/publish/connect', { platform: b.dataset.connect, handle: 'creator' });
              W.closeModal(); W.openModal('publish');
            } catch (e) {
              err.hidden = false;
              err.textContent = e.message + (e.configure ? ` → ${Array.isArray(e.configure) ? e.configure.join(', ') : e.configure}` : '');
            }
          };
        });
        host.querySelectorAll('[data-disconnect]').forEach((b) => {
          b.onclick = async () => { await W.api.del(`/api/publish/accounts/${b.dataset.disconnect}`); W.closeModal(); W.openModal('publish'); };
        });
        const thumbs = S2.project.thumbnails || [];
        host.querySelector('#pubThumbs').innerHTML = thumbs.length ? thumbs.map((t) => `
          <div class="tile" data-pubthumb="${W.mediaUrl(t.media)}" style="width:120px">
            <div class="media-thumb" style="background-image:url('${W.mediaUrl(t.media)}')"></div>
            <div class="meta tiny">${esc(t.label)}</div></div>`).join('')
          : '<span class="muted tiny">Generate thumbnails in AI Tools → Publish first.</span>';
        host.querySelectorAll('[data-pubthumb]').forEach((t) => {
          t.onclick = () => { S2.project.thumbnail = t.dataset.pubthumb; W.markDirty('Thumbnail'); host.querySelectorAll('[data-pubthumb]').forEach((x) => x.style.borderColor = ''); t.style.borderColor = '#00ff9c'; };
        });
        host.querySelector('#pubTitleAi').onclick = async (e) => {
          const res = await run(e.target, W.api.post('/api/editor/tools/titles', { project_id: S2.project.id }), null);
          if (res) host.querySelector('#pubTitle').value = (res.titles[0] || {}).text || '';
        };
        host.querySelector('#pubDescAi').onclick = async (e) => {
          const res = await run(e.target, W.api.post('/api/editor/tools/description', { project_id: S2.project.id }), null);
          if (res) {
            host.querySelector('#pubDesc').value = res.description;
            host.querySelector('#pubTags').value = (res.hashtags || []).join(' ');
          }
        };
        host.querySelector('#pubNow').onchange = (e) => { host.querySelector('#pubWhen').disabled = e.target.checked; };
        host.querySelector('#pubWhen').disabled = true;
        host.querySelector('#pubGo').onclick = async (e) => {
          const platforms = Array.from(host.querySelectorAll('[data-platform]')).filter((c) => c.checked).map((c) => c.dataset.platform);
          const when = host.querySelector('#pubNow').checked ? 0
            : new Date(host.querySelector('#pubWhen').value).getTime() / 1000;
          try {
            const post = await W.api.post('/api/publish/schedule', {
              project_id: S2.project.id, platforms,
              title: host.querySelector('#pubTitle').value,
              description: host.querySelector('#pubDesc').value,
              hashtags: host.querySelector('#pubTags').value.split(/\s+/).filter(Boolean),
              thumbnail: S2.project.thumbnail || '',
              when,
            });
            if (!when) await W.api.post('/api/publish/now', { post_id: post.id });
            W.closeModal();
            W.toast(when ? 'Scheduled' : 'Published', when ? 'see the Scheduler' : 'sent to every connected platform');
            W.showPage('scheduler');
          } catch (e2) {
            err.hidden = false;
            err.textContent = e2.message;
            W.toast('Publish failed', e2.message, 'err');
          }
        };
      });

    W.modal('community', () => `
      <button class="modal-x" data-close>✕</button>
      <h3>Community</h3>
      <p class="m-sub">This install is a single-user build, so there is no shared workspace or chat invite configured.</p>
      <div class="stack">
        <a class="btn" href="studio.html">Open the Studio tools (Clip Maker, Summarizer, Video to Text, Notes)</a>
        <a class="btn" href="index.html#features">Product overview</a>
        <div class="small muted">Set WV_LLM_API_KEY, WV_PEXELS_KEY and the AI media URLs on the backend to light up the
          features that need external providers — GET /api/health reports every variable and whether it is set.</div>
      </div>`);

    W.modal('upgrade', () => {
      const plans = (window.WVE_STATE.meta.credits && window.WVE_STATE.meta.credits.plans) || [];
      return `
      <button class="modal-x" data-close>✕</button>
      <h3>Not enough credits</h3>
      <p class="m-sub">Every action shows its price before it runs. Pick a plan to keep going.</p>
      <div class="grid g3" id="upPlans">
        ${(((window.WVE_STATE.meta || {}).plans) || plans || []).map((p) => `
          <div class="card"><h3>${esc(p.name)}</h3>
            <div class="muted small">${p.credits.toLocaleString()} credits · $${p.price}</div>
            <button class="btn btn-sm btn-green btn-block" style="margin-top:10px" data-up="${p.id}">Choose</button></div>`).join('')}
      </div>`;
    }, () => {
      const W = window.WVE_STATE;
      const host = document.getElementById('modalHost');
      host.querySelectorAll('[data-up]').forEach((b) => {
        b.onclick = async () => {
          try {
            const res = await W.api.post('/api/pricing/plan', { plan: b.dataset.up });
            W.S.meta.credits = res;
            W.refreshCredits();
            W.closeModal();
            W.toast('Plan active', `${res.balance} credits available`);
          } catch (e) { W.fail(e); }
        };
      });
      if (!host.querySelector('[data-up]')) {
        host.querySelector('#upPlans').innerHTML = '<div class="muted small">Plans are unavailable — open the Pricing page.</div>';
      }
    });
  });
})();

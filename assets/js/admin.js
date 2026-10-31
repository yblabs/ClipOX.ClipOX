/* ==========================================================================
   admin.js — feedback moderation dashboard.

   Every piece of data on this page comes from the server behind the admin
   session cookie; opening admin.html directly (or with the file:// scheme)
   shows nothing, because every request 401s and the page redirects to
   admin-login.html.

   Rendering rule: user text is NEVER interpolated raw. It always goes
   through esc() before it touches innerHTML, or through textContent.
   ========================================================================== */
(function () {
  'use strict';

  /* SAME ORIGIN ONLY — the session is an httpOnly SameSite=Strict cookie and
     the server's CSRF guard rejects Sec-Fetch-Site: cross-site (browsers
     report a different PORT as cross-site), so the admin console only ever
     talks to the origin that served it. */
  var API = '';
  var ADMIN_ORIGIN = 'http://127.0.0.1:4000';
  function showMissingApi() {
    document.getElementById('adminBody').hidden = true;
    var panel = document.getElementById('apiMissing');
    var link = document.getElementById('apiLink');
    link.href = ADMIN_ORIGIN + location.pathname + location.search;
    panel.hidden = false;
    link.focus();
  }

  /* ------------------------------------------------------------- state -- */
  var state = {
    type: 'all', status: '', rating: '', from: '', to: '',
    q: '', sort: 'createdAt', dir: 'desc',
    page: 1, pageSize: 25, total: 0, pages: 1
  };
  var items = [];                 // rows on screen
  var selected = new Set();       // ids ticked in the checkbox column
  var stats = null;
  var loading = false;
  var searchTimer = null;

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  /* ---------------------------------------------------------- escaping -- */
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
           ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function starRow(n) {
    var out = '<span class="stars" aria-label="' + (n || 0) + ' out of 5 stars">';
    for (var i = 1; i <= 5; i++) out += '<i class="' + (i <= (n || 0) ? 'on' : '') + '">★</i>';
    return out + '</span>';
  }

  /* -------------------------------------------------------------- toasts */
  function toast(title, text, isErr) {
    var host = $('#toasts');
    var el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' err' : '');
    var b = document.createElement('b');
    b.textContent = title;
    el.appendChild(b);
    if (text) {
      var s = document.createElement('small');
      s.textContent = text;
      el.appendChild(s);
    }
    host.appendChild(el);
    setTimeout(function () { el.remove(); }, isErr ? 6000 : 3600);
  }

  /* ----------------------------------------------------------- api calls */
  async function api(method, path, body) {
    var opts = {
      method: method,
      /* 'include' carries the httpOnly session cookie even when the page is
         served from :8000 and the API runs on :4000 (both are this site) */
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    var res, data;
    try {
      res = await fetch(API + path, opts);
    } catch (e) {
      throw { status: 0, error: 'Cannot reach the admin server' };
    }
    try { data = await res.json(); } catch (e2) { data = {}; }

    if (res.status === 401) {
      /* session gone (or never existed) — server protects the data anyway */
      location.replace('admin-login.html');
      throw { status: 401, error: 'Not authenticated' };
    }
    /* no admin API behind this URL (static file served by something else) */
    if (res.status === 404 || res.status === 405) {
      throw { status: res.status, missing: true, error: 'No admin API on this address' };
    }
    if (!res.ok) throw { status: res.status, error: (data && data.error) || ('HTTP ' + res.status) };
    return data;
  }

  /* ================================================================ STATS */
  async function loadStats() {
    try {
      var d = await api('GET', '/api/admin/stats');
      stats = d.stats || {};
      renderStats();
      renderTabs();
    } catch (e) {
      if (e.status !== 401) toast('Stats unavailable', e.error, true);
    }
  }

  function renderStats() {
    var s = stats || {};
    $('#stats').setAttribute('aria-busy', 'false');
    $('#stats').innerHTML = [
      card(s.total || 0, 'Total feedback', (s.reviews || 0) + ' reviews · ' + (s.suggestions || 0) + ' suggestions'),
      card(s.avgRating == null ? '—' : s.avgRating, 'Average rating', s.avgRating == null ? 'No reviews yet' : 'out of 5'),
      card(s.pending || 0, 'Pending', (s.pending || 0) ? 'Waiting for a decision' : 'Queue is clear'),
      card(s.thisWeek || 0, 'New this week', 'Last 7 days')
    ].join('');

    function card(n, label, hint) {
      return '<div class="stat"><span class="n">' + esc(n) + '</span>' +
             '<span class="l">' + esc(label) + '</span>' +
             '<span class="hint">' + esc(hint) + '</span></div>';
    }
  }

  function renderTabs() {
    var s = stats || {};
    $('#cntAll').textContent = s.total == null ? '–' : s.total;
    $('#cntReview').textContent = s.reviews == null ? '–' : s.reviews;
    $('#cntSuggestion').textContent = s.suggestions == null ? '–' : s.suggestions;
  }

  /* ================================================================= LIST */
  function queryString(page) {
    var p = [];
    if (state.type !== 'all') p.push('type=' + encodeURIComponent(state.type));
    if (state.status) p.push('status=' + encodeURIComponent(state.status));
    if (state.rating) p.push('rating=' + encodeURIComponent(state.rating));
    if (state.q) p.push('q=' + encodeURIComponent(state.q));
    if (state.from) p.push('from=' + state.from);
    if (state.to) p.push('to=' + state.to);
    p.push('sort=' + state.sort);
    p.push('dir=' + state.dir);
    p.push('page=' + page);
    p.push('pageSize=' + state.pageSize);
    return '/api/admin/feedback?' + p.join('&');
  }

  function showSkeletons() {
    var html = '';
    for (var i = 0; i < 5; i++) {
      html += '<tr class="skel-row"><td colspan="8"><div class="skel" style="width:' +
              (96 - i * 7) + '%"></div></td></tr>';
    }
    $('#rows').innerHTML = html;
    $('#emptyState').hidden = true;
    $('#loadMoreWrap').hidden = true;
  }

  async function loadList(keepScroll) {
    if (loading) return;
    loading = true;
    if (!keepScroll) showSkeletons();
    try {
      var d = await api('GET', queryString(state.page));
      state.total = d.total || 0;
      state.pages = d.pages || 1;
      var list = d.items || [];
      if (state.page === 1) items = list;
      else items = items.concat(list);

      /* drop ids that vanished (deleted elsewhere) */
      Array.from(selected).forEach(function (id) {
        if (!items.some(function (r) { return r.id === id; })) selected.delete(id);
      });

      renderRows();
      updateBulk();
    } catch (e) {
      if (e.status !== 401) {
        $('#rows').innerHTML = '';
        toast('Could not load feedback', e.error, true);
      }
    } finally {
      loading = false;
    }
  }

  function renderRows() {
    var tbody = $('#rows');
    var empty = $('#emptyState');

    if (!items.length) {
      tbody.innerHTML = '';
      $('.table-scroll').hidden = true;
      empty.hidden = false;
      var filtered = state.type !== 'all' || state.status || state.rating ||
                     state.q || state.from || state.to;
      $('#emptyTitle').textContent = filtered ? 'No matches' : 'Nothing here yet';
      $('#emptyText').textContent = filtered
        ? 'No feedback matches the current filters. Try widening them.'
        : 'When visitors submit a review or suggestion it will show up on this page.';
      $('#clearFilters').hidden = !filtered;
      $('#loadMoreWrap').hidden = true;
      return;
    }

    $('.table-scroll').hidden = false;
    empty.hidden = true;

    tbody.innerHTML = items.map(function (r) {
      var isSel = selected.has(r.id);
      var canApprove = r.status !== 'approved';
      var label = r.type === 'review' ? 'Review' : 'Suggestion';
      var stars = r.rating ? starRow(r.rating) : '<span class="stars muted">—</span>';
      return '' +
        '<tr data-id="' + esc(r.id) + '"' + (isSel ? ' data-sel="1"' : '') + '>' +
          '<td class="c-sel"><input type="checkbox" class="row-check" aria-label="Select ' + esc(label) + ' from ' + esc(r.name) + '"' + (isSel ? ' checked' : '') + '></td>' +
          '<td class="c-date" data-label="Date">' + esc(fmtDate(r.createdAt)) + '</td>' +
          '<td class="c-type" data-label="Type"><span class="type-tag ' + esc(r.type) + '">' + esc(label) + '</span></td>' +
          '<td class="c-rate" data-label="Rating">' + stars + '</td>' +
          '<td class="c-from" data-label="From"><span class="who-cell"><b>' + esc(r.name || 'Anonymous') + '</b>' +
              '<small>' + esc(r.role || (r.type === 'review' ? 'Creator' : '—')) + '</small></span></td>' +
          '<td class="c-msg" data-label="Message"><span class="msg-preview">' + esc(r.message) + '</span></td>' +
          '<td class="c-status" data-label="Status"><span class="badge ' + esc(r.status) + '">' + esc(r.status) + '</span></td>' +
          '<td class="c-act" data-label="Actions"><div class="row-acts">' +
            '<button class="icon-btn" data-act="view" title="View full message" aria-label="View full message">👁</button>' +
            '<button class="icon-btn" data-act="edit" title="Edit" aria-label="Edit">✎</button>' +
            '<button class="icon-btn' + (canApprove ? '' : ' on') + '" data-act="toggle" title="' +
               (canApprove ? 'Approve (make public)' : 'Hide (remove from public)') + '" aria-label="' +
               (canApprove ? 'Approve' : 'Hide') + '">' + (canApprove ? '✓' : '◌') + '</button>' +
            '<button class="icon-btn danger" data-act="del" title="Delete" aria-label="Delete">🗑</button>' +
          '</div></td>' +
        '</tr>';
    }).join('');

    $('#loadMoreWrap').hidden = state.page >= state.pages;
    $('#loadMoreBtn').textContent = 'Load more (' + (state.total - items.length) + ' left)';
  }

  /* ============================================================= selection */
  function updateBulk() {
    var n = selected.size;
    $('#selCount').innerHTML = '<b>' + n + '</b> selected';
    $('#bulkApprove').disabled = !n;
    $('#bulkHide').disabled = !n;
    $('#bulkDelete').disabled = !n;
    var all = items.length > 0 && items.every(function (r) { return selected.has(r.id); });
    $('#selAll').checked = all;
    $('#selAll').indeterminate = !all && n > 0;
  }

  $('#selAll').addEventListener('change', function () {
    if (this.checked) items.forEach(function (r) { selected.add(r.id); });
    else selected.clear();
    renderRows();
    updateBulk();
  });

  $('#rows').addEventListener('change', function (e) {
    var cb = e.target.closest('.row-check');
    if (!cb) return;
    var id = cb.closest('tr').dataset.id;
    if (cb.checked) selected.add(id); else selected.delete(id);
    cb.closest('tr').dataset.sel = cb.checked ? '1' : '';
    updateBulk();
  });

  /* ============================================================ row clicks */
  $('#rows').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var id = btn.closest('tr').dataset.id;
    var rec = items.find(function (r) { return r.id === id; });
    if (!rec) return;

    if (btn.dataset.act === 'view') openView(rec);
    else if (btn.dataset.act === 'edit') openEdit(rec);
    else if (btn.dataset.act === 'toggle') toggleStatus(rec);
    else if (btn.dataset.act === 'del') askDelete(rec);
  });

  /* =============================================================== actions */
  async function toggleStatus(rec) {
    var next = rec.status === 'approved' ? 'hidden' : 'approved';
    try {
      await api('PUT', '/api/admin/feedback/' + encodeURIComponent(rec.id), { status: next });
      rec.status = next;
      renderRows();
      loadStats();
      toast(next === 'approved' ? 'Approved' : 'Hidden',
            next === 'approved' ? 'This review is now public in the carousel.'
                                : 'Removed from the public carousel.');
    } catch (e) {
      toast('Update failed', e.error, true);
    }
  }

  async function bulkAction(action, verb) {
    var ids = Array.from(selected);
    if (!ids.length) return;
    try {
      var d = await api('POST', '/api/admin/feedback/bulk', { ids: ids, action: action });
      selected.clear();
      toast(verb, d.changed + ' record' + (d.changed === 1 ? '' : 's') + ' updated.');
      await loadList(true);
      loadStats();
    } catch (e) {
      toast('Bulk ' + verb.toLowerCase() + ' failed', e.error, true);
    }
  }

  $('#bulkApprove').addEventListener('click', function () { bulkAction('approved', 'Approved'); });
  $('#bulkHide').addEventListener('click', function () { bulkAction('hidden', 'Hidden'); });
  $('#bulkDelete').addEventListener('click', function () {
    openConfirm('Delete ' + selected.size + ' items permanently?', 'This cannot be undone.', function () {
      bulkAction('deleted', 'Deleted');
    });
  });

  /* ================================================================ modals */
  var lastFocus = null;

  function openDialog(id) {
    lastFocus = document.activeElement;
    $('#backdrop').hidden = false;
    $('#backdrop').classList.add('open');
    var dlg = $('#' + id);
    dlg.hidden = false;
    dlg.classList.add('open');
    var first = dlg.querySelector('input,select,textarea,button:not(.d-close)');
    (first || dlg.querySelector('.d-close')).focus();
    document.addEventListener('keydown', dialogKeys, true);
  }

  function closeDialog() {
    $$('.dialog').forEach(function (d) { d.classList.remove('open'); d.hidden = true; });
    $('#backdrop').classList.remove('open');
    $('#backdrop').hidden = true;
    document.removeEventListener('keydown', dialogKeys, true);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function dialogKeys(e) {
    var dlg = document.querySelector('.dialog.open');
    if (!dlg) return;
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(); return; }
    if (e.key !== 'Tab') return;
    /* focus trap */
    var f = Array.prototype.filter.call(
      dlg.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])'),
      function (el) { return el.offsetParent !== null; }
    );
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  $('#backdrop').addEventListener('click', function (e) {
    if (e.target === $('#backdrop') || e.target.closest('[data-close]')) closeDialog();
  });

  /* ---- view ---- */
  var current = null;

  function openView(rec) {
    current = rec;
    var meta = [];
    meta.push('<span class="type-tag ' + esc(rec.type) + '">' + (rec.type === 'review' ? 'Review' : 'Suggestion') + '</span>');
    meta.push('<span class="badge ' + esc(rec.status) + '">' + esc(rec.status) + '</span>');
    if (rec.rating) meta.push(starRow(rec.rating));
    if (rec.category) meta.push('<span class="badge">' + esc(rec.category) + '</span>');
    meta.push('<span class="badge">' + esc(fmtDate(rec.createdAt)) + '</span>');
    $('#viewMeta').innerHTML = meta.join('');
    $('#viewTitle').textContent = (rec.name || 'Anonymous') + (rec.role ? ' · ' + rec.role : '');
    $('#viewBody').textContent = rec.message || '';
    openDialog('viewDlg');
  }

  $('#viewEdit').addEventListener('click', function () {
    if (!current) return;
    closeDialog();
    setTimeout(function () { openEdit(current); }, 60);
  });

  /* ---- edit ---- */
  function openEdit(rec) {
    current = rec;
    $('#eName').value = rec.name || '';
    $('#eRole').value = rec.role || '';
    $('#eRating').value = String(rec.rating || 5);
    $('#eStatus').value = rec.status || 'pending';
    $('#eMessage').value = rec.message || '';
    $('#eRatingWrap').hidden = rec.type !== 'review';
    openDialog('editDlg');
  }

  $('#editForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    if (!current) return;
    var btn = $('#editSave');
    btn.disabled = true;
    try {
      var payload = {
        name: $('#eName').value,
        role: $('#eRole').value,
        message: $('#eMessage').value,
        status: $('#eStatus').value
      };
      if (current.type === 'review') payload.rating = Number($('#eRating').value);
      var d = await api('PUT', '/api/admin/feedback/' + encodeURIComponent(current.id), payload);
      var i = items.findIndex(function (r) { return r.id === current.id; });
      if (i > -1) items[i] = d.feedback;
      renderRows();
      closeDialog();
      toast('Saved', 'Changes are live' + (d.feedback.status === 'approved' ? ' in the carousel.' : '.'));
      loadStats();
    } catch (err) {
      toast('Save failed', err.error, true);
    } finally {
      btn.disabled = false;
    }
  });

  /* ---- confirm ---- */
  var confirmCb = null;

  function openConfirm(title, text, cb) {
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    confirmCb = cb;
    openDialog('confirmDlg');
  }

  $('#confirmYes').addEventListener('click', function () {
    var cb = confirmCb;
    confirmCb = null;
    closeDialog();
    if (cb) cb();
  });

  function askDelete(rec) {
    openConfirm('Delete this feedback permanently?',
      'From ' + (rec.name || 'anonymous') + ': “' + String(rec.message || '').slice(0, 90) + '”',
      async function () {
        try {
          await api('DELETE', '/api/admin/feedback/' + encodeURIComponent(rec.id));
          selected.delete(rec.id);
          items = items.filter(function (r) { return r.id !== rec.id; });
          state.total = Math.max(0, state.total - 1);
          renderRows();
          updateBulk();
          loadStats();
          toast('Deleted', 'The record was removed.');
        } catch (e) {
          toast('Delete failed', e.error, true);
        }
      });
  }

  /* =============================================================== filters */
  function bindFilters() {
    $('#fStatus').addEventListener('change', function () { state.status = this.value; reload(); });
    $('#fRating').addEventListener('change', function () { state.rating = this.value; reload(); });
    $('#fFrom').addEventListener('change', function () { state.from = this.value; reload(); });
    $('#fTo').addEventListener('change', function () { state.to = this.value; reload(); });
    $('#fSort').addEventListener('change', function () {
      var v = this.value;
      state.sort = (v === 'rating_desc' || v === 'rating_asc') ? 'rating' : 'createdAt';
      state.dir = (v === 'rating_asc' || v === 'oldest') ? 'asc' : 'desc';
      reload();
    });
    $('#fSearch').addEventListener('input', function () {
      var v = this.value.trim();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { state.q = v; reload(); }, 320);
    });
    $('#clearFilters').addEventListener('click', function () {
      state.type = 'all'; state.status = ''; state.rating = '';
      state.from = state.to = state.q = '';
      $('#fStatus').value = ''; $('#fRating').value = '';
      $('#fFrom').value = ''; $('#fTo').value = ''; $('#fSearch').value = '';
      syncTabs();
      reload();
    });
  }

  function reload() {
    state.page = 1;
    items = [];
    selected.clear();
    updateBulk();
    loadList();
  }

  /* ---- tabs (with arrow-key support) ---- */
  function syncTabs() {
    $$('.tab').forEach(function (t) {
      t.setAttribute('aria-selected', String(t.dataset.tab === state.type));
    });
  }

  $$('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      state.type = t.dataset.tab;
      syncTabs();
      reload();
    });
    t.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      var tabs = $$('.tab');
      var i = tabs.indexOf(t);
      var next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      next.click();
    });
  });

  /* ================================================================== CSV */
  $('#csvBtn').addEventListener('click', async function () {
    var btn = this;
    btn.disabled = true;
    try {
      /* pull every page that matches the current filters (cap: 200/page) */
      var all = [], page = 1, pages = 1;
      do {
        var d = await api('GET', queryString(page));
        all = all.concat(d.items || []);
        pages = d.pages || 1;
        page++;
      } while (page <= pages && page <= 25);

      var cols = ['id', 'createdAt', 'type', 'rating', 'name', 'role', 'email', 'category', 'status', 'message'];
      var lines = [cols.join(',')];
      all.forEach(function (r) {
        lines.push(cols.map(function (c) {
          var v = r[c];
          if (c === 'createdAt') v = new Date(v).toISOString();
          if (v == null) v = '';
          return '"' + String(v).replace(/"/g, '""') + '"';
        }).join(','));
      });
      var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'feedback-' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast('CSV ready', all.length + ' row' + (all.length === 1 ? '' : 's') + ' exported.');
    } catch (e) {
      toast('Export failed', e.error, true);
    } finally {
      btn.disabled = false;
    }
  });

  /* ================================================================ misc */
  $('#refreshBtn').addEventListener('click', function () {
    loadStats();
    reload();
  });

  $('#loadMoreBtn').addEventListener('click', function () {
    state.page += 1;
    loadList(true);
  });

  $('#logoutBtn').addEventListener('click', async function () {
    try { await api('POST', '/api/admin/logout', {}); } catch (e) { /* cookie cleared either way */ }
    location.replace('admin-login.html');
  });

  /* ================================================================ boot */
  (async function boot() {
    try {
      await api('GET', '/api/admin/me');     // 401 → redirects away
    } catch (e) {
      if (e && e.missing) showMissingApi();
      return;
    }

    $('#whoName').textContent = 'admin';
    bindFilters();
    loadStats();
    loadList();
  })();
})();

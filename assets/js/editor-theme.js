/* ==========================================================================
   editor-theme.js — visual chrome for the editor workspace.

   ADD-ONLY: this file never changes, reads or re-implements editor logic.
   It injects three purely presentational pieces and wires them with
   delegated listeners, so removing the file removes only the visuals:

     1. the phone "Best on desktop" notice (top of the workspace)
     2. the site's shared footer at the end of the scrollable views
        (hidden while a project is open in the editor, which is a
        fixed-height workspace)
     3. the tablet tool-panel drawer: a toggle in the top bar, a
        click-away scrim, and auto-open when a rail tool is picked

   No existing id, class or handler is touched. Everything injected carries
   its own data-attribute hook instead of an id.
   ========================================================================== */
(function () {
  'use strict';

  var noteDismissed = false;
  var MOBILE = '(max-width:700px)';
  var TABLET = '(max-width:1080px)';

  /* ------------------------------------------------------------ markup -- */

  var NOTICE =
    '<div class="ed-note" role="status">' +
      '<b>Best on desktop</b>' +
      '<span>The timeline, tool panels and export controls are built for a wide screen — ' +
      'you can still preview, review and export from here.</span>' +
      '<button type="button" class="x" data-ed-note-x aria-label="Dismiss notice">&times;</button>' +
    '</div>';

  var PANEL_BTN =
    '<button type="button" class="tb-btn" data-ed-panel aria-expanded="false" aria-controls="main">' +
      'Panel <span aria-hidden="true">&#9638;</span>' +
    '</button>';

  /* The site footer — same markup and classes as index.html, so theme.css
     styles it identically. Links point at the real pages of this site. */
  function footerHTML() {
    var year = new Date().getFullYear();
    return (
      '<footer class="foot app-foot" data-app-foot>' +
        '<div class="foot-top">' +
          '<div class="foot-brand">' +
            '<a class="mark" href="index.html">' +
              '<img class="mark-glyph" src="assets/img/clipox-icon.png" alt="" width="26" height="26" loading="lazy" decoding="async">' +
              '<span class="mark-word">Clip<span class="mark-tint">OX</span></span>' +
            '</a>' +
            '<p>The workbench for people who&rsquo;d rather tell the story than babysit the timeline.</p>' +
            '<div class="socials">' +
              '<a href="#" aria-label="Community">&#9678;</a>' +
              '<a href="#" aria-label="Video channel">&#9655;</a>' +
              '<a href="#" aria-label="Developer updates">&lt;/&gt;</a>' +
            '</div>' +
          '</div>' +
          '<nav class="foot-col" aria-label="Product">' +
            '<h4>Bench</h4>' +
            '<a href="editor.html#start">The Editor</a>' +
            '<a href="clip-maker.html">Cut Room</a>' +
            '<a href="studio.html#summarizer">Chapter Break</a>' +
            '<a href="studio.html#v2t">Spoken Type</a>' +
            '<a href="studio.html#notes">Meeting Ledger</a>' +
          '</nav>' +
          '<nav class="foot-col" aria-label="Workspace">' +
            '<h4>Workspace</h4>' +
            '<a href="editor.html#home">Home</a>' +
            '<a href="editor.html#library">Library</a>' +
            '<a href="editor.html#scheduler">Scheduler</a>' +
            '<a href="editor.html#brandkit">Brand Kit</a>' +
          '</nav>' +
          '<nav class="foot-col" aria-label="Company">' +
            '<h4>Shop</h4>' +
            '<a href="pricing.html">Pricing</a>' +
            '<a href="index.html#faq">Q&amp;A</a>' +
            '<a href="#">Changelog</a>' +
            '<a href="#">Say hello</a>' +
          '</nav>' +
          '<nav class="foot-col" aria-label="Legal">' +
            '<h4>Small print</h4>' +
            '<a href="#">Terms</a>' +
            '<a href="#">Privacy</a>' +
            '<a href="#">Cookies</a>' +
            '<a href="#">Security</a>' +
          '</nav>' +
        '</div>' +
        '<div class="foot-base">' +
          '<p>&copy; <span data-app-year>' + year + '</span> ClipOX. Cut with care.</p>' +
          '<p class="foot-fine">Every graphic on this site is drawn in CSS and SVG — no photography, ' +
          'no stock, no third-party artwork.</p>' +
        '</div>' +
      '</footer>'
    );
  }

  /* ------------------------------------------------------------- state --- */

  function setDrawer(open) {
    document.body.classList.toggle('panel-open', !!open);
    var btn = document.querySelector('[data-ed-panel]');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function drawerOpen() {
    return document.body.classList.contains('panel-open');
  }

  /* One pass: inject whatever is missing. Every insert is guarded, so the
     observer that fires from these inserts settles immediately. */
  function sync() {
    var main = document.getElementById('main');
    if (!main) return;
    var editing = main.classList.contains('editing');

    /* 1. phone notice */
    if (!noteDismissed && !main.querySelector('.ed-note')) {
      main.insertAdjacentHTML('afterbegin', NOTICE);
    }

    /* 2. shared footer — scrollable views only */
    var foot = main.querySelector('[data-app-foot]');
    if (editing) {
      if (foot) foot.remove();
    } else {
      if (!foot) main.insertAdjacentHTML('beforeend', footerHTML());
      /* the drawer only belongs to the workspace: close it once, on the pass
         that leaves the editor (never on every pass, or it would snap shut) */
      if (drawerOpen()) setDrawer(false);
    }

    /* 3a. click-away scrim behind the tablet drawer */
    var body = main.querySelector('.ed-body');
    if (body && !body.querySelector('[data-ed-scrim]')) {
      body.insertAdjacentHTML('beforeend', '<div class="panel-scrim" data-ed-scrim></div>');
    }

    /* 3b. drawer toggle in the top bar */
    var bar = document.getElementById('topbar');
    if (bar && !bar.querySelector('[data-ed-panel]')) {
      var spacer = bar.querySelector('.tb-spacer');
      if (spacer) spacer.insertAdjacentHTML('beforebegin', PANEL_BTN);
      else bar.insertAdjacentHTML('beforeend', PANEL_BTN);
    }
  }

  /* Modal cards: the editor writes dialog content straight into #modalHost,
     so the glass card rule (.modal) never had an element to style. Wrapping
     the children after each render gives dialogs a panel without touching
     any modal definition — the nodes themselves are moved, so the handlers
     the editor attached before this runs keep working. */
  function wrapModal(host) {
    if (!host || !host.children.length) return;
    var first = host.children[0];
    if (first.classList && first.classList.contains('modal')) return;   /* already wrapped */
    var card = document.createElement('div');
    card.className = 'modal';
    while (host.firstChild) card.appendChild(host.firstChild);
    host.appendChild(card);
  }

  /* ------------------------------------------------------------ events --- */

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;

    if (t.closest('[data-ed-note-x]')) {
      noteDismissed = true;
      var n = document.querySelector('.ed-note');
      if (n) n.remove();
      return;
    }
    if (t.closest('[data-ed-panel]')) {
      setDrawer(!drawerOpen());
      return;
    }
    if (t.closest('[data-ed-scrim]')) {
      setDrawer(false);
      return;
    }
    /* picking a tool on a tablet should reveal its panel */
    if (t.closest('.rail-btn') && window.matchMedia(TABLET).matches) {
      setDrawer(true);
    }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape' || !drawerOpen()) return;
    /* never steal the key from an open dialog — that one closes itself */
    var host = document.getElementById('modalHost');
    if (host && host.classList.contains('open')) return;
    setDrawer(false);
  });

  /* ------------------------------------------------------------- start --- */

  function start() {
    sync();
    var main = document.getElementById('main');
    if (main && window.MutationObserver) {
      new MutationObserver(sync).observe(main, { childList: true });
    }
    var modalHost = document.getElementById('modalHost');
    if (modalHost && window.MutationObserver) {
      wrapModal(modalHost);
      new MutationObserver(function () { wrapModal(modalHost); }).observe(modalHost, { childList: true });
    }
    /* views are re-rendered from JS; a slow sweep catches anything the
       observer misses (and is a no-op when everything is present) */
    setInterval(sync, 900);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

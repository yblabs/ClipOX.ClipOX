/* ===========================================================================
   Shared application sidebar.

   The menu is defined ONCE, here. Every page with a left sidebar renders it:

     <aside class="sidebar">                        <!-- or .cm-side -->
       <div data-sidebar data-nav="spa"></div>      <!-- the menu is injected -->
       <div class="side-foot" id="sidebarFoot">…</div>
     </aside>
     <script src="assets/js/sidebar.js"></script>   <!-- after the mount point -->

   Attributes on the mount point
     data-nav="spa"       editor.html — items are in-page routes (#home, #library…)
     data-nav="page"      any other page — items are links to editor.html#…
     data-active="id"     highlight this item as the current page (page mode)
     data-overrides       JSON map of id -> href for pages that own those views
                          (clip-maker keeps its own Library / Scheduler views)

   It renders synchronously so scripts that bind [data-page] later in the
   document still find the items.
   =========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------- the menu (once) */
  var NAV = [
    { id: 'home',      label: 'Home',              icon: '\u{1F3E0}', href: 'editor.html#home',      spa: true },
    { id: 'library',   label: 'Library',           icon: '\u{1F4DA}', href: 'editor.html#library',   spa: true },
    { id: 'scheduler', label: 'Scheduler',         icon: '\u{1F5D3}', href: 'editor.html#scheduler', spa: true },
    { id: 'brandkit',  label: 'Brand Kit',         icon: '\u{1F3A8}', href: 'editor.html#brandkit',  spa: true },
    { id: 'pricing',   label: 'Pricing',           icon: '\u{1F4B3}', href: 'editor.html#pricing',   spa: true },
    { id: 'rewards',  label: 'Rewards',          icon: '\u{1F381}', href: 'editor.html#rewards',   spa: true },
    { id: 'start',     label: 'Video Editor',      icon: '✂️',        href: 'editor.html#start',     spa: true },
    { id: 'clipmaker', label: 'AI Video Clipping', icon: '\u{1F3AC}', href: 'clip-maker.html' }
  ];

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function render(mount) {
    var spa = mount.getAttribute('data-nav') === 'spa';
    var active = mount.getAttribute('data-active') || '';
    var overrides = {};
    try { overrides = JSON.parse(mount.getAttribute('data-overrides') || '{}'); }
    catch (err) { overrides = {}; }

    mount.innerHTML = NAV.map(function (item) {
      var inPage = spa && item.spa;
      var href = overrides[item.id] || (inPage ? '#' + item.id : item.href);
      var cls = 'side-item' + (!spa && item.id === active ? ' active' : '');
      var page = inPage ? ' data-page="' + item.id + '"' : '';
      var current = !spa && item.id === active ? ' aria-current="page"' : '';
      return '<a class="' + cls + '"' + page + current + ' href="' + esc(href) + '">' +
        '<span class="ico" aria-hidden="true">' + item.icon + '</span>' +
        '<span class="lbl">' + esc(item.label) + '</span></a>';
    }).join('');
  }

  function boot() {
    var mounts = document.querySelectorAll('[data-sidebar]');
    for (var i = 0; i < mounts.length; i++) render(mounts[i]);
  }

  if (document.querySelector('[data-sidebar]')) boot();
  else document.addEventListener('DOMContentLoaded', boot);

  window.WV_NAV = { items: NAV, render: boot };
})();

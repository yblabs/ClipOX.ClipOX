/* ==========================================================================
   FRAMECRAFT — landing page behaviour
   Written from scratch for the redesign. Handles:
     notice dismiss · sticky pill state · dropdowns · mobile sheet
     headline rotator · scroll reveals · count-up metrics · cursor glow
     audience switcher · quote carousel · sticky dock · back-to-top
   No dependencies; runs as a classic script at the end of <body>.
   ========================================================================== */
(function () {
  'use strict';

  var $  = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------ announcement strip -- */
  (function notice() {
    var bar = $('[data-notice]');
    var x = $('[data-notice-x]');
    if (!bar || !x) return;
    x.addEventListener('click', function () { bar.classList.add('gone'); });
  })();

  /* ---------------------------------------------- dropdowns (Products…) - */
  (function dropdowns() {
    var items = $$('[data-drop]');
    if (!items.length) return;

    var closeAll = function (except) {
      items.forEach(function (it) {
        if (it === except) return;
        it.classList.remove('open');
        var b = $('[data-drop-btn]', it);
        if (b) b.setAttribute('aria-expanded', 'false');
      });
    };

    items.forEach(function (item) {
      var btn = $('[data-drop-btn]', item);
      if (!btn) return;

      var hoverCapable = function () {
        return window.matchMedia('(hover:hover) and (min-width: 981px)').matches;
      };
      var pinned = false;   // explicit click keeps it up on hover desktops

      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (hoverCapable()) {
          // pointer desktops already open it on hover: first click pins,
          // second click closes; touch/keyboard devices just toggle.
          if (!item.classList.contains('open')) {
            closeAll(item);
            item.classList.add('open');
            pinned = true;
          } else if (pinned) {
            item.classList.remove('open');
            pinned = false;
          } else {
            pinned = true;
          }
        } else {
          var open = !item.classList.contains('open');
          closeAll(item);
          item.classList.toggle('open', open);
          pinned = open;
        }
        btn.setAttribute('aria-expanded', String(item.classList.contains('open')));
      });

      // pointer devices get the menu on hover, with a small close delay
      var timer = null;
      item.addEventListener('mouseenter', function () {
        if (!hoverCapable()) return;
        clearTimeout(timer);
        pinned = false;   // a hover-open is never a pinned state
        closeAll(item);
        item.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
      });
      item.addEventListener('mouseleave', function () {
        if (!hoverCapable()) return;
        clearTimeout(timer);
        timer = setTimeout(function () {
          item.classList.remove('open');
          pinned = false;
          btn.setAttribute('aria-expanded', 'false');
        }, 200);
      });
    });

    document.addEventListener('click', function (e) {
      if (!e.target.closest('[data-drop]')) closeAll(null);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAll(null);
    });
  })();

  /* ------------------------------------------------------- mobile sheet -- */
  (function mobileNav() {
    var burger = $('[data-burger]');
    var sheet = $('[data-sheet]');
    if (!burger || !sheet) return;

    var setState = function (open) {
      burger.classList.toggle('is-open', open);
      burger.setAttribute('aria-expanded', String(open));
      sheet.hidden = !open;
    };

    burger.addEventListener('click', function () {
      setState(sheet.hidden);
    });
    // any link inside the sheet closes it
    sheet.addEventListener('click', function (e) {
      if (e.target.closest('a')) setState(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !sheet.hidden) setState(false);
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth > 980 && !sheet.hidden) setState(false);
    });
  })();

  /* --------------------------------------------------- headline rotator -- */
  (function rotator() {
    var el = $('[data-rotator]');
    if (!el || reduced) return;           // respect reduced-motion: keep first line
    var lines = [
      'Find the moment that matters.',
      'Caption it before you blink.',
      'Ship it while the idea is warm.'
    ];
    var i = 0;
    setInterval(function () {
      el.classList.add('is-fading');
      setTimeout(function () {
        i = (i + 1) % lines.length;
        el.textContent = lines[i];
        el.classList.remove('is-fading');
      }, 350);
    }, 3400);
  })();

  /* ------------------------------------------------------ reveal on scroll */
  (function reveals() {
    var els = $$('.reveal');
    if (!els.length) return;
    if (!('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry, n) {
        if (!entry.isIntersecting) return;
        // stagger siblings that arrive in the same tick
        entry.target.style.transitionDelay = (Math.min(n, 5) * 70) + 'ms';
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      });
    }, { threshold: 0.18, rootMargin: '0px 0px -6% 0px' });
    els.forEach(function (el) { io.observe(el); });
  })();

  /* ------------------------------------------------------ count-up metrics */
  (function counters() {
    var nums = $$('[data-count]');
    if (!nums.length) return;

    var run = function (el) {
      var target = parseFloat(el.getAttribute('data-count')) || 0;
      var suffix = el.getAttribute('data-suffix') || '';
      var decimals = parseInt(el.getAttribute('data-decimals') || '0', 10);
      if (reduced) { el.textContent = target.toFixed(decimals) + suffix; return; }

      var dur = 1500;
      var t0 = performance.now();
      var step = function (now) {
        var p = Math.min((now - t0) / dur, 1);
        var eased = 1 - Math.pow(1 - p, 3);          // ease-out cubic
        el.textContent = (target * eased).toFixed(decimals) + suffix;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };

    if (!('IntersectionObserver' in window)) { nums.forEach(run); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        run(entry.target);
        io.unobserve(entry.target);
      });
    }, { threshold: 0.6 });
    nums.forEach(function (el) { io.observe(el); });
  })();

  /* --------------------------------------------- cursor glow on cards ----- */
  (function cardGlow() {
    $$('[data-glow]').forEach(function (card) {
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        card.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
        card.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%');
      });
    });
  })();

  /* ------------------------------------------------- audience switcher --- */
  (function audiences() {
    var root = $('[data-aud]');
    if (!root) return;
    var btns = $$('.seg-btn', root);
    var panels = $$('.aud-panel', root);

    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-seg');
        btns.forEach(function (b) {
          var on = b === btn;
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-selected', String(on));
        });
        panels.forEach(function (p) {
          p.classList.toggle('is-on', p.getAttribute('data-panel') === key);
        });
      });
    });
  })();

  /* ------------------------------------------------------ quote carousel -- */
  (function voices() {
    var track = $('[data-voices]');
    if (!track) return;
    var dotsWrap = $('[data-voices-dots]');   // pagination (index.html only)
    var GAP = 16;                            // matches the track's CSS gap

    function visibleCards() {
      // placeholder cards are display:none once real reviews exist — slide
      // maths must only count cards that are actually on screen
      return Array.prototype.slice.call(track.children).filter(function (el) {
        return el.offsetParent !== null;
      });
    }
    function step() {
      var first = visibleCards()[0];
      return first ? first.getBoundingClientRect().width + GAP : 356;
    }
    // how many FULL cards fit side-by-side (3 on desktop, 1 on phones).
    // +GAP because only the gaps BETWEEN cards count, not one after the last.
    function perView() { return Math.max(1, Math.floor((track.clientWidth + GAP) / step())); }
    function slideCount() { return Math.max(1, Math.ceil(visibleCards().length / perView())); }
    function activeSlide() {
      var s = Math.round(track.scrollLeft / (step() * perView()));
      return Math.min(slideCount() - 1, Math.max(0, s));
    }

    function markActive() {
      if (!dotsWrap) return;
      var a = activeSlide();
      Array.prototype.forEach.call(dotsWrap.children, function (dot, i) {
        dot.classList.toggle('is-on', i === a);
        dot.setAttribute('aria-current', i === a ? 'true' : 'false');
      });
    }

    /* (re)build one dot per slide — runs on load, on resize, and after the
       feedback widget appends new cards (slide count changes). */
    function rebuild() {
      if (!dotsWrap) return;
      while (dotsWrap.firstChild) dotsWrap.removeChild(dotsWrap.firstChild);
      var n = slideCount();
      for (var i = 0; i < n; i++) {
        (function (i) {
          var dot = document.createElement('button');
          dot.type = 'button';
          dot.setAttribute('aria-label', 'Go to slide ' + (i + 1));
          dot.addEventListener('click', function () { goTo(i); });
          dotsWrap.appendChild(dot);
        })(i);
      }
      markActive();
    }

    function goTo(slide) {
      track.scrollTo({ left: slide * perView() * step(), behavior: reduced ? 'auto' : 'smooth' });
      markActive();
    }

    /* prev / next arrows — unchanged behaviour (one card per press) */
    $$('[data-slide]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var dir = parseInt(btn.getAttribute('data-slide'), 10) || 1;
        track.scrollBy({ left: dir * step(), behavior: reduced ? 'auto' : 'smooth' });
      });
    });

    var rafId = 0;
    track.addEventListener('scroll', function () {
      if (rafId) return;
      rafId = requestAnimationFrame(function () { rafId = 0; markActive(); });
    }, { passive: true });
    window.addEventListener('resize', rebuild);

    rebuild();

    /* Public hook used by assets/js/feedback.js: rebuild the dots after new
       cards are appended, and jump to a card with a short glow highlight. */
    window.FWVoices = {
      rebuild: rebuild,
      append: function (el) { track.appendChild(el); rebuild(); return el; },
      goToCard: function (el) {
        var idx = visibleCards().indexOf(el);
        if (idx < 0) return;
        goTo(Math.floor(idx / perView()));
        el.classList.add('just-added');          // green glow, see framecraft.css
        setTimeout(function () { el.classList.remove('just-added'); }, 2600);
      },
      track: track
    };
  })();

  /* ------------------------------- sticky dock + back-to-top + pill state -- */
  (function chrome() {
    var masthead = $('[data-masthead]');
    var dock = $('[data-dock]');
    var dockX = $('[data-dock-x]');
    var top = $('[data-totop]');
    var dockDismissed = false;

    if (dockX && dock) {
      dockX.addEventListener('click', function () {
        dockDismissed = true;
        dock.classList.remove('show');
        dock.setAttribute('aria-hidden', 'true');
      });
    }
    if (top) {
      top.addEventListener('click', function () {
        window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
      });
    }

    var ticking = false;
    var sync = function () {
      var y = window.scrollY || document.documentElement.scrollTop;
      var hero = $('.hero');
      var heroBottom = hero ? hero.offsetHeight : 600;

      if (masthead) masthead.classList.toggle('is-stuck', y > 10);
      if (top) top.classList.toggle('show', y > 640);
      if (dock && !dockDismissed) {
        var show = y > heroBottom * 0.85;
        dock.classList.toggle('show', show);
        dock.setAttribute('aria-hidden', String(!show));
      }
      ticking = false;
    };

    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; requestAnimationFrame(sync); }
    }, { passive: true });
    sync();
  })();

  /* ------------------------------------------------------------- footer --- */
  (function year() {
    var el = $('[data-year]');
    if (el) el.textContent = String(new Date().getFullYear());
  })();
})();

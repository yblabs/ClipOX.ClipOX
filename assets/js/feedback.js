/* ==========================================================================
   FEEDBACK / REVIEW WIDGET  —  Framewright  (vanilla JS, no dependencies)
   ------------------------------------------------------------------------
   WHAT THIS DOES
     • Injects a floating "Feedback" pill (bottom-left) on every page.
     • Opens an accessible glass modal with two tabs:
         – Leave a Review  → becomes a public carousel card (see AUTO_APPROVE)
         – Suggest a Feature → stored privately, never rendered
     • Renders approved reviews into the existing testimonial carousel on
       index.html using the SAME card markup/classes (.quote .stars .who),
       then rebuilds the carousel's pagination dots via window.FWVoices.

   FILES ADDED ALONGSIDE THIS ONE
     assets/css/feedback.css   → styles for everything injected here
     reviews.json              → hand-editable list of APPROVED reviews

   CONFIG IS IN THE NEXT BLOCK — that is the only part you normally touch.
   ========================================================================== */
(function () {
  'use strict';

  /* ======================================================== CONFIG ====== */

  /* AUTO_APPROVE — false (DEFAULT, recommended): submitted reviews are saved
     with status "pending" and are NOT shown in the carousel until you set
     their approved/status field to "approved" (reviews.json or your backend).
     true: the review appears in the carousel immediately. NOTE: with no
     backend, "immediately" only means in the submitter's own browser
     (localStorage) — visitors cannot see each other's reviews. On a real
     server (API_ENDPOINT below) it would be visible to everyone. */
  var AUTO_APPROVE = false;

  /* API_ENDPOINT — the admin server's public feedback API.
     "" (empty) keeps this widget on the localStorage demo below — handy when
     the site is opened straight from disk (file://) or the Node server is
     not running. Set to null to disable the API entirely. */
  var API_ENDPOINT = 'api/feedback';

  /* Where to look for the API, in order. "" = same origin.
     • site served by the Node server (production, or the dev port) → same
       origin only — one request, no dead ends.
     • site served by the FastAPI dev server (a different local port) → ask
       the Node server first, so we never fire a request that can only 404. */
  var NODE_ORIGIN = 'http://127.0.0.1:4000';
  var IS_LOCAL = (location.hostname === '127.0.0.1' || location.hostname === 'localhost');
  var API_CANDIDATES = !IS_LOCAL ? ['']
    : (location.origin === NODE_ORIGIN ? [''] : [NODE_ORIGIN, '']);

  /* Approved-reviews feed for the public carousel. */
  var REVIEWS_ENDPOINT = 'api/reviews/approved';

  var RATE_LIMIT_MS = 60000;   // one submission per minute per browser
  var MAX_VISIBLE   = 12;      // cap of submitted reviews in the carousel
  var STORE_KEY     = 'fw_feedback_store_v1';  // all submissions (demo)
  var LAST_KEY      = 'fw_feedback_last_ts';   // rate-limit stamp

  /* Optional hand-edited fallback list — same shape as reviews.json.
     Used only if reviews.json cannot be fetched (e.g. opened via file://). */
  var HAND_REVIEWS = [
    // { rating: 5, name: "Your Name", role: "Channel or role",
    //   message: "Paste an approved review here.", timestamp: 0, status: "approved" }
  ];

  /* ======================================================== HELPERS ===== */
  var $  = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------ API base *
     Probed ONCE per page load: whichever base answers GET /api/reviews/
     approved with a real payload becomes the base this widget posts to.
     null = no server reachable → the localStorage demo store is used. */
  var apiProbe = null;
  function resolveApiBase() {
    if (!apiProbe) {
      apiProbe = API_CANDIDATES.reduce(function (chain, base) {
        return chain.then(function (found) {
          if (found !== null) return found;
          return fetch(base + '/' + REVIEWS_ENDPOINT, { cache: 'no-store',
                          headers: { 'X-Requested-With': 'XMLHttpRequest' } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) { return (d && Array.isArray(d.reviews)) ? base : null; })
            .catch(function () { return null; });        // offline / wrong origin
        });
      }, Promise.resolve(null));
    }
    return apiProbe;
  }

  /* Sanitiser for anything a human typed. We only ever insert results with
     textContent (never innerHTML), so this is belt-and-braces: it strips
     angle brackets, collapses whitespace and caps the length. */
  function clean(value, max) {
    var s = String(value == null ? '' : value);
    s = s.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
    return max ? s.slice(0, max) : s;
  }

  function read(key, fallback) {
    try { var v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  /* =============================================== DOM (injected) ======= */
  /* Static skeleton only — no user data goes through innerHTML. */

  var SVG_BUBBLE =
    '<svg class="fw-ico" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H12l-4.4 3.5a.6.6 0 0 1-1-.5V16A2.5 2.5 0 0 1 4 13.5z" ' +
    'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>' +
    '<path d="M17.6 2.4l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7z" fill="currentColor"/></svg>';

  var skeleton =
    '<button type="button" class="fw-trigger" data-fw-trigger aria-haspopup="dialog">' +
      SVG_BUBBLE + '<span class="fw-trigger-label">Feedback</span>' +
    '</button>' +
    '<div class="fw-overlay" data-fw-overlay hidden>' +
      '<div class="fw-modal" role="dialog" aria-modal="true" aria-labelledby="fwTitle" tabindex="-1">' +
        '<button type="button" class="fw-close" data-fw-close aria-label="Close feedback dialog">&times;</button>' +
        '<div class="fw-head">' +
          '<h2 id="fwTitle">Shape what we build next</h2>' +
          '<p>Rate the product or tell us what to add — either takes a minute.</p>' +
        '</div>' +

        '<div data-fw-forms>' +
          '<div class="fw-tabs" role="tablist" aria-label="Feedback type">' +
            '<button type="button" class="fw-tab" role="tab" id="fwTabReview" ' +
              'aria-selected="true" aria-controls="fwPanelReview">Leave a Review</button>' +
            '<button type="button" class="fw-tab" role="tab" id="fwTabSuggest" ' +
              'aria-selected="false" aria-controls="fwPanelSuggest" tabindex="-1">Suggest a Feature</button>' +
          '</div>' +

          /* ---------- REVIEW TAB ---------- */
          '<form class="fw-panel" id="fwPanelReview" role="tabpanel" ' +
                'aria-labelledby="fwTabReview" novalidate>' +
            '<div class="fw-form-err" data-fw-formerr role="alert"></div>' +

            '<div class="fw-field" role="radiogroup" aria-label="Star rating">' +
              '<span class="fw-label">Your rating <span class="fw-req">required</span></span>' +
              '<div class="fw-stars" data-fw-stars>' +
                '<label><input type="radio" name="fwRating" value="1"><span>&#9733;</span></label>' +
                '<label><input type="radio" name="fwRating" value="2"><span>&#9733;</span></label>' +
                '<label><input type="radio" name="fwRating" value="3"><span>&#9733;</span></label>' +
                '<label><input type="radio" name="fwRating" value="4"><span>&#9733;</span></label>' +
                '<label><input type="radio" name="fwRating" value="5"><span>&#9733;</span></label>' +
              '</div>' +
              '<p class="fw-err" data-err="rating">Pick how many stars you would give us.</p>' +
            '</div>' +

            '<div class="fw-row">' +
              '<div class="fw-field">' +
                '<label class="fw-label" for="fwName">Name <span class="fw-req">required</span></label>' +
                '<input class="fw-input" id="fwName" name="name" type="text" maxlength="60" ' +
                       'autocomplete="name" placeholder="How should we credit you?">' +
                '<p class="fw-err" data-err="name">Please add your name.</p>' +
              '</div>' +
              '<div class="fw-field">' +
                '<label class="fw-label" for="fwRole">Role / channel <span style="color:var(--fw-faint)">optional</span></label>' +
                '<input class="fw-input" id="fwRole" name="role" type="text" maxlength="60" ' +
                       'placeholder="YouTube educator, podcaster…">' +
              '</div>' +
            '</div>' +

            '<div class="fw-field">' +
              '<label class="fw-label" for="fwReview">Your review ' +
                '<span><span class="fw-req">required</span> ' +
                '<span class="fw-count" data-count-for="fwReview" aria-live="polite">0 / 300</span></span>' +
              '</label>' +
              '<textarea class="fw-area" id="fwReview" name="message" maxlength="300" ' +
                        'placeholder="What works for you? What should we build next?"></textarea>' +
              '<p class="fw-err" data-err="message">Write at least 20 characters so others can learn from it.</p>' +
            '</div>' +

            '<div class="fw-field">' +
              '<label class="fw-check-row">' +
                '<input type="checkbox" data-fw-consent>' +
                '<span>I agree to show my review publicly.</span>' +
              '</label>' +
              '<p class="fw-err" data-err="consent">Tick the box so we are allowed to publish it.</p>' +
            '</div>' +

            /* honeypot: humans never see or tab to this field */
            '<input class="fw-hp" type="text" name="fw_website" tabindex="-1" ' +
                   'autocomplete="off" aria-hidden="true" data-fw-hp>' +

            '<div class="fw-actions">' +
              '<button type="submit" class="fw-submit" data-fw-submit>Send review</button>' +
            '</div>' +
          '</form>' +

          /* ---------- SUGGESTION TAB ---------- */
          '<form class="fw-panel" id="fwPanelSuggest" role="tabpanel" ' +
                'aria-labelledby="fwTabSuggest" hidden novalidate>' +
            '<div class="fw-form-err" data-fw-formerr role="alert"></div>' +

            '<div class="fw-field">' +
              '<label class="fw-label" for="fwCategory">Category <span class="fw-req">required</span></label>' +
              '<select class="fw-select" id="fwCategory" name="category">' +
                '<option value="">Choose one…</option>' +
                '<option>New feature</option>' +
                '<option>Improvement</option>' +
                '<option>Bug report</option>' +
                '<option>Other</option>' +
              '</select>' +
              '<p class="fw-err" data-err="category">Pick the closest category.</p>' +
            '</div>' +

            '<div class="fw-field">' +
              '<label class="fw-label" for="fwSuggest">Your suggestion ' +
                '<span><span class="fw-req">required</span> ' +
                '<span class="fw-count" data-count-for="fwSuggest" aria-live="polite">0 / 600</span></span>' +
              '</label>' +
              '<textarea class="fw-area" id="fwSuggest" name="message" maxlength="600" ' +
                        'placeholder="Describe the feature or problem in a sentence or two."></textarea>' +
              '<p class="fw-err" data-err="smessage">A little more detail — 10 to 600 characters.</p>' +
            '</div>' +

            '<div class="fw-field">' +
              '<label class="fw-label" for="fwEmail">Email <span style="color:var(--fw-faint)">optional</span></label>' +
              '<input class="fw-input" id="fwEmail" name="email" type="email" maxlength="120" ' +
                     'autocomplete="email" placeholder="you@example.com (only if you want a reply)">' +
              '<p class="fw-err" data-err="email">That email does not look right.</p>' +
            '</div>' +

            '<input class="fw-hp" type="text" name="fw_website" tabindex="-1" ' +
                   'autocomplete="off" aria-hidden="true" data-fw-hp>' +

            '<div class="fw-actions">' +
              '<button type="submit" class="fw-submit" data-fw-submit>Send suggestion</button>' +
            '</div>' +
          '</form>' +

          '<p class="fw-privacy">We only use your feedback to improve the product.</p>' +
        '</div>' +

        /* ---------- SUCCESS ---------- */
        '<div class="fw-success" data-fw-success>' +
          '<svg class="fw-check" viewBox="0 0 52 52" aria-hidden="true">' +
            '<circle cx="26" cy="26" r="24"/><path d="M15 27.5 22.5 35 37.5 19"/></svg>' +
          '<h3>Thanks!</h3>' +
          '<p data-fw-success-text></p>' +
          '<button type="button" class="fw-submit" data-fw-done>Close</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  /* ===================================================== INJECTION ====== */
  if (!document.querySelector('[data-fw-overlay]')) {
    document.body.insertAdjacentHTML('beforeend', skeleton);
  }

  var overlay   = $('[data-fw-overlay]');
  var modal     = $('.fw-modal', overlay);
  var trigger   = $('[data-fw-trigger]');
  var formsWrap = $('[data-fw-forms]');
  var success   = $('[data-fw-success]');
  var successText = $('[data-fw-success-text]');
  var reviewForm = $('#fwPanelReview');
  var suggestForm = $('#fwPanelSuggest');
  var lastFocused = null;
  var jumpTarget = null;   // card element to scroll to after Close

  /* ================================================= MODAL OPEN/CLOSE === */
  function openModal(tab) {
    // element to give focus back to on close (the floating trigger by default,
    // or whichever [data-open-feedback] control opened the dialog)
    lastFocused = document.activeElement;
    if (!lastFocused || lastFocused === document.body) lastFocused = trigger || lastFocused;
    showTab(tab === 'suggest' ? 'suggest' : 'review');
    resetSuccess();
    overlay.hidden = false;
    /* force a style pass with the closed state, then add is-open so the
       transition runs — done synchronously (no rAF) so it also works when
       the browser throttles background tabs */
    void overlay.offsetWidth;
    overlay.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    // focus the first real control inside the dialog
    var first = $('.fw-tab[aria-selected="true"]', modal) || modal;
    first.focus();
  }

  function closeModal() {
    overlay.classList.remove('is-open');
    document.body.style.overflow = '';
    var delay = reduced ? 0 : 240;
    setTimeout(function () { overlay.hidden = true; }, delay);
    if (lastFocused && lastFocused.focus) lastFocused.focus();   // return focus
    if (jumpTarget) {
      var target = jumpTarget;
      jumpTarget = null;
      jumpToCard(target);
    }
  }

  function isOpen() { return overlay && !overlay.hidden; }

  /* close triggers: X button, Esc, click on the dimmed backdrop */
  $('[data-fw-close]').addEventListener('click', closeModal);
  overlay.addEventListener('mousedown', function (e) {
    if (e.target === overlay) closeModal();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen()) closeModal();
  });

  /* focus trap: Tab / Shift+Tab cycle inside the dialog */
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), ' +
                  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  overlay.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab' || !isOpen()) return;
    var items = $$(FOCUSABLE, modal).filter(function (el) {
      return el.offsetParent !== null || el === document.activeElement;
    });
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  /* every element carrying data-open-feedback opens the Review tab */
  $$('[data-open-feedback]').forEach(function (el) {
    el.addEventListener('click', function () { openModal('review'); });
    if (el.classList.contains('is-empty')) {
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModal('review'); }
      });
    }
  });
  if (trigger) trigger.addEventListener('click', function () { openModal('review'); });

  /* ============================================================ TABS ==== */
  var tabs = $$('.fw-tab', modal);
  function showTab(which) {
    tabs.forEach(function (t) {
      var on = t.id === (which === 'review' ? 'fwTabReview' : 'fwTabSuggest');
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
    reviewForm.hidden = which !== 'review';
    suggestForm.hidden = which !== 'suggestion';
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { showTab(t.id === 'fwTabReview' ? 'review' : 'suggestion'); });
    t.addEventListener('keydown', function (e) {          // arrow-key tab switching
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      var next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      showTab(next.id === 'fwTabReview' ? 'review' : 'suggestion');
    });
  });

  /* ==================================================== STAR RATING ===== */
  var starsWrap = $('[data-fw-stars]');
  var starLabels = $$('label', starsWrap);

  function paintStars(preview) {
    var checked = $('input:checked', starsWrap);
    var value = preview != null ? preview : (checked ? Number(checked.value) : 0);
    starLabels.forEach(function (label, i) {
      label.classList.toggle('on', i < value);           // i is 0-based, value is 1–5
    });
  }
  starLabels.forEach(function (label, i) {
    label.addEventListener('mouseenter', function () { paintStars(i + 1); });   // hover preview
    label.addEventListener('mouseleave', function () { paintStars(); });       // back to choice
  });
  starsWrap.addEventListener('change', function () { paintStars(); });
  paintStars();

  /* ==================================================== COUNTERS ======== */
  [['fwReview', 300], ['fwSuggest', 600]].forEach(function (pair) {
    var field = document.getElementById(pair[0]);
    var out = $('[data-count-for="' + pair[0] + '"]');
    if (!field || !out) return;
    var update = function () { out.textContent = field.value.length + ' / ' + pair[1]; };
    field.addEventListener('input', update);
    update();
  });

  /* ================================================== VALIDATION ======== */
  /* Show an inline error. If no custom message is passed, the element's
     default text in the HTML is used. (Hiding is done by clearErrors.) */
  function setError(key, form, message) {
    var box = $('[data-err="' + key + '"]', form);
    if (box) {
      if (message) box.textContent = message;          // friendly override
      box.classList.add('show');
    }
    var input = form.querySelector('[name="' + key + '"]') ||
                (key === 'message' || key === 'smessage' ? form.querySelector('textarea') : null);
    if (input && input.setAttribute) input.setAttribute('aria-invalid', 'true');
  }
  function clearErrors(form) {
    $$('.fw-err.show', form).forEach(function (e) { e.classList.remove('show'); });
    $$('[aria-invalid]', form).forEach(function (e) { e.setAttribute('aria-invalid', 'false'); });
    var fe = $('[data-fw-formerr]', form);
    fe.classList.remove('show');
    fe.textContent = '';
  }
  function formError(form, message) {
    var fe = $('[data-fw-formerr]', form);
    fe.textContent = message;
    fe.classList.toggle('show', !!message);
  }

  function validateReview() {
    var form = reviewForm;
    clearErrors(form);
    var ok = true;
    var rating = $('input[name="fwRating"]:checked', form);
    if (!rating) { setError('rating', form); ok = false; }

    var name = $('#fwName', form);
    if (!clean(name.value)) { setError('name', form); ok = false; }
    else name.setAttribute('aria-invalid', 'false');

    var msg = $('#fwReview', form);
    var len = msg.value.trim().length;
    if (len < 20 || len > 300) {
      setError('message', form,
        len === 0 ? 'Write at least 20 characters so others can learn from it.'
                  : len < 20 ? 'Almost there — ' + (20 - len) + ' more character' +
                               (20 - len === 1 ? '' : 's') + ' to go (' + len + '/300).'
                  : 'That is a little long — trim it to 300 characters (' + len + '/300).');
      ok = false;
    } else msg.setAttribute('aria-invalid', 'false');

    if (!$('[data-fw-consent]', form).checked) { setError('consent', form); ok = false; }

    if (!ok) {
      var firstErr = $('.fw-err.show', form);
      if (firstErr) {
        var field = firstErr.parentElement.querySelector('input, textarea, select');
        if (field) field.focus();
      }
    }
    return ok;
  }

  function validateSuggestion() {
    var form = suggestForm;
    clearErrors(form);
    var ok = true;

    var cat = $('#fwCategory', form);
    if (!cat.value) { setError('category', form); ok = false; }
    else cat.setAttribute('aria-invalid', 'false');

    var msg = $('#fwSuggest', form);
    var len = msg.value.trim().length;
    if (len < 10 || len > 600) {
      setError('smessage', form,
        len < 10 ? 'A little more detail — ' + (10 - len) + ' more character' +
                   (10 - len === 1 ? '' : 's') + ' to go.'
                 : 'Keep it under 600 characters (' + len + '/600).');
      ok = false;
    } else msg.setAttribute('aria-invalid', 'false');

    var email = $('#fwEmail', form);
    if (email.value.trim() && !EMAIL_RE.test(email.value.trim())) {
      setError('email', form); ok = false;
    } else email.setAttribute('aria-invalid', 'false');

    if (!ok) {
      var firstErr = $('.fw-err.show', form);
      if (firstErr) {
        var field = firstErr.parentElement.querySelector('input, textarea, select');
        if (field) field.focus();
      }
    }
    return ok;
  }

  /* ============================================ LOADING + SUCCESS ======= */
  function setLoading(form, busy) {
    var btn = $('[data-fw-submit]', form);
    btn.disabled = busy;
    btn.setAttribute('aria-busy', String(busy));
    if (busy) {
      btn.dataset.label = btn.textContent;
      btn.innerHTML = '<span class="fw-spin" aria-hidden="true"></span>Sending…';
    } else {
      btn.textContent = btn.dataset.label || 'Send';
    }
  }

  function showSuccess(payload) {
    formsWrap.hidden = true;
    successText.textContent =
      payload.type === 'suggestion'
        ? 'Got it — suggestions stay private and land straight on the roadmap list.'
        : (payload.status === 'approved'
            ? 'Your review is live in the carousel below.'
            : 'Your review is in the queue — it appears publicly once approved.');
    success.classList.add('show');
    $('[data-fw-done]', success).focus();
  }
  function resetSuccess() {
    success.classList.remove('show');
    formsWrap.hidden = false;
    jumpTarget = null;
  }
  $('[data-fw-done]').addEventListener('click', closeModal);

  /* =============================================== DATA: submit ========= */
  /* submitFeedback(payload) — THE single data path.
     payload: { type, rating, name, role, message, email, timestamp, status } */
  function submitFeedback(payload) {
    // suggestions are ALWAYS pending/private; only reviews follow AUTO_APPROVE
    payload.status = (payload.type === 'review' && AUTO_APPROVE) ? 'approved' : 'pending';
    payload.timestamp = payload.timestamp || Date.now();

    /* ---- REAL BACKEND ----------------------------------------------------
       POSTs to the admin server (POST /api/feedback), which validates,
       sanitises, rate-limits, checks the honeypot AGAIN server-side and
       stores the record with status "pending" — a client can never make its
       own review public. Approval happens in admin.html.
       Only a NETWORK failure falls back to the localStorage demo store; a
       real HTTP error (400 validation, 429 rate limit…) is surfaced to the
       user verbatim.
       -------------------------------------------------------------------- */
    return resolveApiBase().then(function (base) {
      if (base === null || API_ENDPOINT === null) return localStore(payload);

      var url = base ? base + '/' + API_ENDPOINT : API_ENDPOINT;
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json',
                   'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify(payload)
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (r.status === 404 && base === '') {
            /* this origin has no feedback API (e.g. the FastAPI dev server)
               → retry through the fallback base before giving up */
            return null;
          }
          if (!r.ok) {
            var e = new Error((data && data.error) || ('HTTP ' + r.status));
            e.userMessage = (data && data.error) || '';
            throw e;
          }
          /* the server stored it as pending: an admin approves it */
          var saved = Object.assign({}, payload, { status: 'pending', id: data.id });
          return saved;
        });
      }).then(function (res) {
        if (res !== null) return res;
        /* 404 on same origin → try the fallback base once */
        return fetch('http://127.0.0.1:4000/' + API_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json',
                     'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify(payload)
        }).then(function (r2) {
          if (!r2.ok) {
            return r2.json().catch(function () { return {}; }).then(function (d2) {
              var e2 = new Error((d2 && d2.error) || ('HTTP ' + r2.status));
              e2.userMessage = (d2 && d2.error) || '';
              throw e2;
            });
          }
          return Object.assign({}, payload, { status: 'pending' });
        });
      }).catch(function (err) {
        if (err && err.userMessage !== undefined) throw err;   // real HTTP error
        return localStore(payload);                            // unreachable → demo
      });
    });
  }

  /* DEMO PATH: everything stays in this browser's localStorage. */
  function localStore(payload) {
    return new Promise(function (resolve) {
      var all = read(STORE_KEY, []);
      if (!Array.isArray(all)) all = [];
      all.push(payload);
      write(STORE_KEY, all);
      setTimeout(function () { resolve(payload); }, 550);   // simulated latency
    });
  }

  /* ============================================ RENDER: carousel ======== */
  var track = $('[data-voices]');

  /* reviews.json (hand-edited) merged with locally stored, approved ones */
  var jsonReviews = [];
  /* approved reviews served by the admin backend (GET /api/reviews/approved) */
  var apiReviews = [];

  function normalise(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(function (r) {
      return r && !r._example && r.status !== 'pending' &&
             typeof r.name === 'string' && typeof r.message === 'string';
    }).map(function (r) {
      return {
        rating: Math.min(5, Math.max(1, Number(r.rating) || 5)),
        name: clean(r.name, 60) || 'Anonymous',
        role: clean(r.role, 60) || 'Creator',
        message: clean(r.message, 300),
        timestamp: Number(r.timestamp) || 0
      };
    });
  }

  function approvedReviews() {
    var local = read(STORE_KEY, []);
    if (!Array.isArray(local)) local = [];
    var mine = local.filter(function (r) {
      return r && r.type === 'review' && r.status === 'approved';
    });
    var all = normalise(HAND_REVIEWS)
                .concat(normalise(apiReviews), normalise(jsonReviews), normalise(mine));
    // newest first, keep only the newest MAX_VISIBLE, de-duplicate by time+name
    all.sort(function (a, b) { return a.timestamp - b.timestamp; });
    var seen = {};
    all = all.filter(function (r) {
      var k = r.timestamp + '|' + r.name + '|' + r.message.slice(0, 24);
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
    return all.slice(-MAX_VISIBLE);
  }

  /* Build ONE card using the carousel's EXISTING markup/classes:
     figure.quote > div.stars + blockquote + figcaption > span.who + strong/small */
  function buildCard(rev) {
    var fig = document.createElement('figure');
    fig.className = 'quote';
    fig.setAttribute('data-fw-review', '');
    fig.setAttribute('data-ts', String(rev.timestamp));

    var stars = document.createElement('div');
    stars.className = 'stars';
    var full = Math.round(rev.rating);
    stars.textContent = '★★★★★'.slice(0, full) + '☆☆☆☆☆'.slice(0, 5 - full);
    stars.setAttribute('aria-label', full + ' out of 5 stars');

    var quote = document.createElement('blockquote');
    quote.textContent = '“' + rev.message + '”';     // curly quotes, textContent only

    var cap = document.createElement('figcaption');
    var avatar = document.createElement('span');
    avatar.className = 'who';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = (rev.name.trim()[0] || '?').toUpperCase();
    var meta = document.createElement('div');
    var strong = document.createElement('strong');
    strong.textContent = rev.name;
    var small = document.createElement('small');
    small.textContent = rev.role || 'Creator';
    meta.appendChild(strong);
    meta.appendChild(small);
    cap.appendChild(avatar);
    cap.appendChild(meta);

    fig.appendChild(stars);
    fig.appendChild(quote);
    fig.appendChild(cap);
    return fig;
  }

  function renderReviews() {
    if (!track) return;
    var list = approvedReviews();

    // clear previous rendered cards (placeholder cards stay untouched)
    $$('[data-fw-review]', track).forEach(function (el) { el.remove(); });

    // appended at the END of the carousel, after the placeholder cards
    list.forEach(function (rev) { track.appendChild(buildCard(rev)); });

    // hide the "Your first review could be here" placeholders once real
    // reviews exist (they are the empty state)
    $$('.quote.is-empty', track).forEach(function (el) {
      el.hidden = list.length > 0;
    });

    // rebuild pagination dots / slide maths / arrows
    if (window.FWVoices && typeof window.FWVoices.rebuild === 'function') {
      window.FWVoices.rebuild();
    }
  }

  /* smooth page scroll to the carousel, then jump to the new card + glow */
  function jumpToCard(card) {
    if (!card) return;
    var section = document.getElementById('voices');
    if (section) {
      section.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
    }
    setTimeout(function () {
      if (window.FWVoices && typeof window.FWVoices.goToCard === 'function') {
        window.FWVoices.goToCard(card);
      }
    }, reduced ? 0 : 650);
  }

  /* ================================================== FORM SUBMISSIONS == */
  function honeypotTripped(form) {
    var hp = $('[data-fw-hp]', form);
    return hp && hp.value !== '';
  }
  function rateLimited() {
    var last = Number(read(LAST_KEY, 0)) || 0;
    return Date.now() - last < RATE_LIMIT_MS;
  }

  function handle(form, type, valid) {
    clearErrors(form);
    formError(form, '');

    // spam protection 1: hidden honeypot — silently drop, never store
    if (honeypotTripped(form)) {
      showSuccess({ type: type, status: 'discarded' });
      return;
    }
    // spam protection 2: one submission per minute per browser
    if (rateLimited()) {
      formError(form, 'Easy there — one message per minute. Try again in a moment.');
      return;
    }
    if (!valid()) return;

    var payload;
    if (type === 'review') {
      payload = {
        type: 'review',
        rating: Number($('input[name="fwRating"]:checked', form).value),
        name: clean($('#fwName', form).value, 60),
        role: clean($('#fwRole', form).value, 60) || 'Creator',
        message: clean($('#fwReview', form).value, 300),
        email: '',
        timestamp: Date.now(),
        status: AUTO_APPROVE ? 'approved' : 'pending'
      };
    } else {
      payload = {
        type: 'suggestion',
        rating: 0,
        name: '',
        role: '',
        category: clean($('#fwCategory', form).value, 40),
        message: clean($('#fwSuggest', form).value, 600),
        email: clean($('#fwEmail', form).value, 120),
        timestamp: Date.now(),
        status: 'pending'
      };
    }

    setLoading(form, true);
    submitFeedback(payload)
      .then(function (saved) {
        setLoading(form, false);
        write(LAST_KEY, Date.now());

        var card = null;
        if (saved.type === 'review' && saved.status === 'approved') {
          renderReviews();                       // append into the carousel
          card = $('[data-fw-review][data-ts="' + saved.timestamp + '"]', track);
        }
        showSuccess(saved);
        if (card) jumpTarget = card;             // used by Close → scroll+glow
        form.reset();
        paintStars();
        $$('.fw-count').forEach(function (c) {
          var f = document.getElementById(c.getAttribute('data-count-for'));
          if (f) c.textContent = '0 / ' + f.maxLength;
        });
        if (card && !reduced) {
          // do not make people click Close just to see their card appear
          setTimeout(function () { if (isOpen()) closeModal(); }, 2200);
        }
      })
      .catch(function (err) {
        setLoading(form, false);
        /* server-side validation messages ("Please add your name", 429…)
           reach the user verbatim; everything else gets a friendly line */
        formError(form, (err && err.userMessage) ||
          'That did not go through — please try again in a moment.');
        if (window.console) console.error('[feedback]', err);
      });
  }

  reviewForm.addEventListener('submit', function (e) {
    e.preventDefault();
    handle(reviewForm, 'review', validateReview);
  });
  suggestForm.addEventListener('submit', function (e) {
    e.preventDefault();
    handle(suggestForm, 'suggestion', validateSuggestion);
  });

  /* ==================================================== PAGE LOAD ======= */
  renderReviews();                       // HAND_REVIEWS / stored, right away

  /* 1. approved reviews from the admin backend (if it is running) */
  resolveApiBase().then(function (base) {
    if (base === null) return;
    return fetch(base + '/' + REVIEWS_ENDPOINT, {
      cache: 'no-store', headers: { 'X-Requested-With': 'XMLHttpRequest' }
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && Array.isArray(data.reviews) && data.reviews.length) {
          apiReviews = data.reviews;
          renderReviews();
        }
      })
      .catch(function () { /* server went away — local cards still render */ });
  });

  /* 2. hand-edited reviews.json */
  if (track) {
    fetch('reviews.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (data) { jsonReviews = data; renderReviews(); })
      .catch(function () { /* file:// or missing — HAND_REVIEWS still render */ });
  }
})();

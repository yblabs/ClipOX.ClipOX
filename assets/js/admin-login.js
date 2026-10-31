/* ==========================================================================
   admin-login.js — admin authentication page.

   SAME-ORIGIN ONLY, by design: the session is an httpOnly SameSite=Strict
   cookie, and the server's CSRF guard rejects any request whose
   Sec-Fetch-Site is "cross-site" — browsers report a *different port* as
   cross-site. So the admin console must be opened on the Node server's own
   origin; if it is not, we say exactly that instead of pretending the
   credentials were wrong.

   The password never appears here — it is compared server-side against the
   bcrypt hash built from .env when the server boots.
   ========================================================================== */
(function () {
  'use strict';

  var LOGIN_URL = '/api/admin/login';
  var VERIFY_URL = '/api/admin/me';
  /* Where the admin console actually lives (Node server). Used only for the
     "you are on the wrong origin" hint — never for credentials. */
  var ADMIN_ORIGIN = 'http://127.0.0.1:4000';

  var form    = document.getElementById('loginForm');
  var btn     = document.getElementById('loginBtn');
  var label   = btn.querySelector('.btn-label');
  var errEl   = document.getElementById('loginErr');
  var idInput = document.getElementById('adminId');
  var pwInput = document.getElementById('password');
  var toggle  = document.getElementById('togglePw');
  var missing = document.getElementById('apiMissing');
  var missingLink = document.getElementById('apiLink');

  var busy = false;
  var locked = false;   /* rate-limit lockout active */
  var done = false;     /* successful sign-in, redirecting */

  /* ------------------------------------------------------------ helpers -- */
  function showError(msg, lockedMsg) {
    errEl.textContent = msg;
    errEl.classList.toggle('locked', !!lockedMsg);
    errEl.hidden = false;
  }
  function hideError() { errEl.hidden = true; errEl.textContent = ''; }

  /* This origin serves the HTML but has no admin API (e.g. the FastAPI dev
     server on :8000). Show the way to the real console. */
  function showMissingApi() {
    if (missing.hidden === false) return;
    missingLink.href = ADMIN_ORIGIN + location.pathname + location.search;
    missing.hidden = false;
    form.hidden = true;
    document.querySelector('.fine').hidden = true;
    missingLink.focus();
  }

  function setLoading(on) {
    busy = on;
    /* a lockout or a completed sign-in keeps the button disabled */
    btn.disabled = on || locked || done;
    if (done) return;
    label.textContent = on ? 'Signing in…' : 'Sign in';
    if (on) {
      if (!btn.querySelector('.spin')) btn.insertBefore(spinner(), label);
    } else {
      var s = btn.querySelector('.spin');
      if (s) s.remove();
    }
  }
  function spinner() {
    var s = document.createElement('span');
    s.className = 'spin';
    s.setAttribute('aria-hidden', 'true');
    return s;
  }

  /* POST to this origin's admin API. Never falls back cross-origin: a Strict
     cookie and the CSRF guard make that impossible by design. */
  async function send() {
    var res = await fetch(LOGIN_URL, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      /* "adminId", NOT "login": the field may hold a non-email admin ID */
      body: JSON.stringify({ adminId: idInput.value, password: pwInput.value })
    });
    var data = {};
    try { data = await res.json(); } catch (e) { /* empty body */ }
    return { status: res.status, data: data };
  }

  /* ---------------------------------------------------- show / hide pw --- */
  toggle.addEventListener('click', function () {
    var show = pwInput.type === 'password';
    pwInput.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Hide' : 'Show';
    toggle.setAttribute('aria-pressed', String(show));
    pwInput.focus();
  });

  /* ------------------------------------------------------------ lockout -- */
  function lockFor(seconds) {
    var left = seconds;
    locked = true;
    idInput.disabled = pwInput.disabled = true;
    btn.disabled = true;
    tick();
    var t = setInterval(tick, 1000);
    function tick() {
      if (left <= 0) {
        clearInterval(t);
        locked = false;
        idInput.disabled = pwInput.disabled = false;
        setLoading(false);
        hideError();
        return;
      }
      var m = Math.floor(left / 60), s = left % 60;
      showError(
        'Too many failed attempts. Locked for ' +
        (m ? m + ' min ' : '') + s + 's.',
        true
      );
      left--;
    }
  }

  /* -------------------------------------------------------------- submit -- */
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (busy || done) return;
    hideError();

    var login = idInput.value.trim();
    var password = pwInput.value;
    if (!login || !password) {
      showError('Enter your admin ID and password.');
      (!login ? idInput : pwInput).focus();
      return;
    }

    setLoading(true);
    try {
      var r = await send();

      if (r.status === 200 && r.data.ok) {
        done = true;
        label.textContent = 'Welcome back';
        setTimeout(function () { location.href = 'admin.html'; }, 260);
        return;
      }

      if (r.status === 423) {
        lockFor(Number(r.data.retryAfter) || 900);
        return;
      }

      /* No admin API behind this URL (static file served by something else) */
      if (r.status === 404 || r.status === 405) { showMissingApi(); return; }

      /* 401 and anything else: one generic message, never says which
         field was wrong (no username enumeration). */
      showError((r.data && r.data.error) || 'Invalid credentials.');
      pwInput.select();
    } catch (err) {
      showError('Cannot reach the admin server. Start it (see the README) and try again.');
    } finally {
      setLoading(false);
    }
  });

  /* -------------------------------------------- already signed in? ------ */
  (async function () {
    try {
      var r = await fetch(VERIFY_URL, {
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
      });
      if (r.ok) { location.replace('admin.html'); return; }
      if (r.status === 404 || r.status === 405) showMissingApi();
    } catch (e) { /* no server at all — the form explains it on submit */ }
  })();
})();

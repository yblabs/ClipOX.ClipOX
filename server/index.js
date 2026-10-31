'use strict';
/* ==========================================================================
   Framewright — admin feedback server (Node + Express)

   What this process does, in order:
     1. loads server/.env (secrets live ONLY there)
     2. security headers, CORS limited to this site's origins, cookies
     3. PUBLIC routes   POST /api/feedback · GET /api/reviews/approved
     4. ADMIN routes    login · logout · me · list · edit · delete · bulk
        (every one of them verified server-side, 401 otherwise)
     5. serves the existing static site (index.html, admin.html, assets…)
     6. proxies /api, /media and /fonts to the existing FastAPI app, so the
        whole site runs on ONE origin and the session cookie just works.

   Run:   npm install && npm start        (see README.md)
   ========================================================================== */

const path = require('path');
const http = require('http');

/* dotenv must run before anything reads process.env */
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const auth = require('./lib/auth');
const store = require('./lib/store');
const { line, block, email, rating, type } = require('./lib/sanitize');

const SITE_DIR = path.resolve(__dirname, '..');           // wayin-site/
const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:8000';
const PORT = Number(process.env.PORT) || 4000;
const ORIGINS = String(process.env.SITE_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const app = express();
app.disable('x-powered-by');
/* Only trust a proxy when you have actually put one in front (set TRUST_PROXY=1) */
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

/* ------------------------------------------------------------- security -- */
app.use(helmet({
  /* The existing site uses inline <script>/<style>, so a strict CSP would
     break every page. Everything else helmet offers stays on. */
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,             // would block ytimg thumbnails
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' }
}));

/* CORS — only this site's own origins may talk to the API with credentials. */
app.use('/api', cors({
  origin(origin, cb) { cb(null, !origin || ORIGINS.includes(origin)); },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Requested-With']
}));

app.use(cookieParser());

/* =========================================================== PUBLIC API == */

/* Simple in-memory throttle: 10 submissions / 10 minutes per IP. */
const feedbackHits = new Map();
function feedbackLimiter(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const win = 10 * 60 * 1000;
  const rec = feedbackHits.get(ip);
  if (!rec || rec.reset < now) feedbackHits.set(ip, { count: 1, reset: now + win });
  else {
    rec.count += 1;
    if (rec.count > 10) return res.status(429).json({ error: 'Too many submissions, try again later' });
  }
  if (feedbackHits.size > 5000) {
    for (const [k, v] of feedbackHits) if (v.reset < now) feedbackHits.delete(k);
  }
  next();
}

/**
 * POST /api/feedback — the public widget's submitFeedback() target.
 * Validates, sanitises, checks the honeypot and ALWAYS stores status
 * "pending": nothing becomes public without an admin approving it.
 */
app.post('/api/feedback', express.json({ limit: '64kb' }), feedbackLimiter, (req, res) => {
  const b = req.body || {};

  /* Honeypot: bots fill every field they can find. Humans never see these,
     so we answer with a normal success and store nothing. */
  if (b.website || b.hp || b._gotcha || b['bot-field']) {
    return res.status(201).json({ ok: true });
  }

  const kind = type(b.type);
  if (!kind) return res.status(400).json({ error: 'Invalid feedback type' });

  const message = block(b.message, kind === 'review' ? 300 : 600);
  const minLen = kind === 'review' ? 20 : 10;
  if (message.length < minLen) {
    return res.status(400).json({ error: kind === 'review'
      ? 'Please write at least 20 characters' : 'Please write at least 10 characters' });
  }

  const name = line(b.name, 60);
  if (kind === 'review' && !name) return res.status(400).json({ error: 'Please add your name' });

  const stars = kind === 'review' ? rating(b.rating) : null;
  if (kind === 'review' && !stars) return res.status(400).json({ error: 'Please choose a rating' });

  const rec = store.insert({
    type: kind,
    rating: stars,
    name,
    role: line(b.role, 60),
    message,
    email: email(b.email),                       // optional, only checked if present
    category: line(b.category, 40),
    status: 'pending'                            // never taken from the client
  });

  return res.status(201).json({ ok: true, id: rec.id });
});

/** GET /api/reviews/approved — feeds the public testimonial carousel. */
app.get('/api/reviews/approved', (req, res) => {
  const reviews = store.approvedReviews(req.query.limit);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, reviews });
});

/* ============================================================ ADMIN API == */

/** Failed logins: 5 per 15 minutes, then a 15-minute lockout for that IP. */
async function login(req, res) {
  const lock = auth.lockedFor(req);
  if (lock > 0) {
    const mins = Math.ceil(lock / 60000);
    return res.status(423).json({
      error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
      retryAfter: Math.ceil(lock / 1000)
    });
  }

  const { adminId, password } = req.body || {};
  const ok = await auth.verifyCredentials(adminId, password);

  if (!ok) {
    const rec = auth.recordFailure(req);
    if (rec.lockedUntil) {
      const mins = Math.ceil((rec.lockedUntil - Date.now()) / 60000);
      return res.status(423).json({
        error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
        retryAfter: Math.ceil((rec.lockedUntil - Date.now()) / 1000)
      });
    }
    /* Deliberately generic: it never says WHICH field was wrong. */
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  auth.recordSuccess(req);
  auth.setSessionCookie(res);
  return res.json({ ok: true, user: { id: 'admin' } });
}

function logout(req, res) {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
}

/* Mounted BEFORE the auth gate below, but both still carry the CSRF guard. */
app.post('/api/admin/login', express.json({ limit: '16kb' }), auth.csrfGuard, wrap(login));
app.post('/api/admin/logout', auth.csrfGuard, logout);

/* Everything under /api/admin from here on requires a valid session cookie.
   State-changing verbs additionally pass the CSRF guard. */
app.use('/api/admin',
  express.json({ limit: '64kb' }),
  auth.requireAuth,
  /* GET/HEAD/OPTIONS are reads; every write must also pass the CSRF guard */
  (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    return auth.csrfGuard(req, res, next);
  }
);

/* GET /api/admin/me — the dashboard calls this on load to check the session. */
app.get('/api/admin/me', (req, res) => res.json({ ok: true, user: { id: 'admin' } }));

/** Dashboard counters. */
app.get('/api/admin/stats', (req, res) => res.json({ ok: true, stats: store.stats() }));

/**
 * GET /api/admin/feedback
 * Query: type, status, rating, q, from, to, page, pageSize, sort, dir
 */
app.get('/api/admin/feedback', (req, res) => {
  const q = req.query || {};
  const from = q.from ? Date.parse(q.from) : NaN;
  const to = q.to ? Date.parse(q.to) + 86399999 : NaN;   // inclusive end of day
  const result = store.list({
    type: q.type || '',
    status: q.status || '',
    rating: q.rating || '',
    q: String(q.q || '').slice(0, 120),
    from: Number.isFinite(from) ? from : 0,
    to: Number.isFinite(to) ? to : 0,
    page: q.page,
    pageSize: q.pageSize,
    sort: q.sort,
    dir: q.dir
  });
  res.json({ ok: true, ...result });
});

/** PUT /api/admin/feedback/:id — edit name, role, message, rating, status. */
app.put('/api/admin/feedback/:id', (req, res) => {
  const existing = store.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Feedback not found' });

  const b = req.body || {};
  const fields = {};

  if (b.name !== undefined) fields.name = line(b.name, 60);
  if (b.role !== undefined) fields.role = line(b.role, 60);
  if (b.message !== undefined) {
    const msg = block(b.message, existing.type === 'review' ? 300 : 600);
    if (!msg) return res.status(400).json({ error: 'Message cannot be empty' });
    fields.message = msg;
  }
  if (b.rating !== undefined) {
    if (existing.type === 'review') {
      const stars = rating(b.rating);
      if (!stars) return res.status(400).json({ error: 'Rating must be between 1 and 5' });
      fields.rating = stars;
    }
  }
  if (b.status !== undefined) {
    if (!['pending', 'approved', 'hidden'].includes(b.status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    fields.status = b.status;
  }

  const changed = store.update(existing.id, fields);
  if (!changed) return res.status(400).json({ error: 'Nothing to update' });
  return res.json({ ok: true, feedback: store.get(existing.id) });
});

/** DELETE /api/admin/feedback/:id */
app.delete('/api/admin/feedback/:id', (req, res) => {
  const changed = store.remove(req.params.id);
  if (!changed) return res.status(404).json({ error: 'Feedback not found' });
  return res.json({ ok: true });
});

/** POST /api/admin/feedback/bulk — { ids: [], action: 'approved'|'hidden'|'deleted' } */
app.post('/api/admin/feedback/bulk', (req, res) => {
  const { ids, action } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No items selected' });
  if (!['approved', 'hidden', 'deleted'].includes(action)) {
    return res.status(400).json({ error: 'Invalid bulk action' });
  }
  const changed = store.bulk(ids, action);
  return res.json({ ok: true, changed });
});

/* Real error answers instead of Express' HTML stack traces — see the
   handler at the very bottom of this file (it must be registered last). */

/* ===================================================== EXISTING SITE ===== */
/* Our own routes above are matched first, so anything still arriving under
   these prefixes belongs to the FastAPI app (the editor, clip maker, media). */
function proxy(req, res) {
  let target;
  try { target = new URL(UPSTREAM); } catch (_e) {
    return res.status(502).json({ error: 'Bad UPSTREAM url' });
  }
  const headers = Object.assign({}, req.headers, { host: target.host });
  delete headers['accept-encoding'];             // pipe the body through raw

  const up = http.request({
    hostname: target.hostname,
    port: target.port || 80,
    path: req.originalUrl,
    method: req.method,
    headers
  }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
  });

  up.on('error', () => {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Application server is not running', upstream: UPSTREAM });
    } else {
      res.end();
    }
  });
  req.pipe(up);
}

app.use('/api', proxy);
app.use(['/media', '/fonts'], proxy);

/* Static files: the whole existing site (index, pricing, editor, admin…). */
app.use(express.static(SITE_DIR, {
  index: 'index.html',
  extensions: ['html'],
  etag: true,
  lastModified: true,
  cacheControl: true,
  maxAge: 0                                   // always revalidate (no stale CSS)
}));

app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

/* Must be registered last: an error handler only catches errors raised by
   middleware registered before it. */
app.use((err, req, res, _next) => {
  console.error('[error]', err.message);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: 'Server error' });
});

/* ---------------------------------------------------------------- start -- */
(async function start() {
  try {
    await auth.init();                         // bcrypt hash lives in memory
    const server = http.createServer(app);
    server.listen(PORT, async () => {
      const addr = server.address();
      console.log('');
      console.log('  Framewright admin server');
      console.log('  ────────────────────────');
      console.log(`  Site      http://127.0.0.1:${addr.port}/index.html`);
      console.log(`  Admin     http://127.0.0.1:${addr.port}/admin-login.html`);
      console.log(`  API       http://127.0.0.1:${addr.port}/api/feedback`);
      console.log(`  Database  ${store.DB_FILE}`);
      console.log(`  Proxied   /api, /media, /fonts → ${UPSTREAM}`);
      console.log('  (start the existing app too: uvicorn app.main:app --port 8000)');
      console.log('');
    });
  } catch (err) {
    console.error('Failed to start:', err.message);
    process.exit(1);
  }
})();

/** Small helper so async handlers reject into the error middleware. */
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
}

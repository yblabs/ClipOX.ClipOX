'use strict';
/* ==========================================================================
   auth.js — admin credentials, sessions and CSRF.

   • The password is hashed with bcrypt ONCE at boot and kept in memory only.
     It is never written to the database, returned by an endpoint, or shipped
     to the browser.
   • Login compares in constant time: the Admin ID with crypto.timingSafeEqual
     (over SHA-256 digests so unequal lengths do not leak), the password with
     bcrypt.compare, which bcryptjs performs through its constant-time
     safeStringCompare. The bcrypt compare runs even when the ID is wrong, so
     a wrong username and a wrong password take the same time.
   • Sessions are HS256 JWTs in an httpOnly, SameSite=Strict cookie for 2h.
   ========================================================================== */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'fw_admin';
const ISSUER = 'framewright-admin';
const AUDIENCE = 'framewright-admin-ui';
const SESSION_MS = 2 * 60 * 60 * 1000;          // 2 hours

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;              // 15 minutes

let passwordHash = null;                         // bcrypt hash, memory only
const attempts = new Map();                      // ip -> { count, resetAt, lockedUntil }

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

/* ------------------------------------------------------------- boot ------ */

/** Hash the configured password. Called once, before the server listens. */
async function init() {
  const secret = env('ADMIN_PASSWORD');
  if (!secret) throw new Error('ADMIN_PASSWORD is missing from server/.env');
  passwordHash = await bcrypt.hash(secret, 10);
}

/* --------------------------------------------------------- comparisons --- */

/** Constant-time string compare (SHA-256 first so lengths never leak). */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * @returns {Promise<boolean>} true only when BOTH halves match.
 * NOTE: no email validation — the login field is an admin ID, which may be
 * something like "yblabs.clips".
 */
async function verifyCredentials(adminId, password) {
  const idOk = safeEqual(String(adminId || ''), env('ADMIN_LOGIN', ''));
  const pwOk = await bcrypt.compare(String(password || ''), passwordHash || '');
  return idOk && pwOk;
}

/* ------------------------------------------------------- login limiter --- */

function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

function pruneAttempts() {
  if (attempts.size < 1000) return;
  const now = Date.now();
  for (const [ip, rec] of attempts) {
    if (rec.lockedUntil < now && rec.resetAt < now) attempts.delete(ip);
  }
}

/** @returns {number} ms remaining of a lockout, or 0 when not locked. */
function lockedFor(req) {
  const ip = clientIp(req);
  const rec = attempts.get(ip);
  if (!rec) return 0;
  const now = Date.now();
  if (rec.lockedUntil && rec.lockedUntil > now) return rec.lockedUntil - now;
  if (rec.resetAt < now) attempts.delete(ip);   // window expired, start clean
  return 0;
}

/** Record a failed attempt; locks the IP after MAX_ATTEMPTS in the window. */
function recordFailure(req) {
  const ip = clientIp(req);
  const now = Date.now();
  pruneAttempts();
  let rec = attempts.get(ip);
  if (!rec || rec.resetAt < now) rec = { count: 0, resetAt: now + LOCKOUT_MS, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) rec.lockedUntil = now + LOCKOUT_MS;
  attempts.set(ip, rec);
  return rec;
}

function recordSuccess(req) {
  attempts.delete(clientIp(req));
}

/* --------------------------------------------------------------- JWT ----- */

function issueToken() {
  return jwt.sign({ sub: 'admin', role: 'admin' }, env('JWT_SECRET', ''), {
    algorithm: 'HS256',
    expiresIn: SESSION_MS / 1000,
    issuer: ISSUER,
    audience: AUDIENCE
  });
}

function verifyToken(token) {
  return jwt.verify(token, env('JWT_SECRET', ''), {
    algorithms: ['HS256'],
    issuer: ISSUER,
    audience: AUDIENCE
  });
}

function setSessionCookie(res) {
  res.cookie(COOKIE_NAME, issueToken(), {
    httpOnly: true,                              // JS can never read it
    sameSite: 'strict',                          // never sent on cross-site requests
    secure: env('COOKIE_SECURE', 'false') === 'true',
    path: '/',
    maxAge: SESSION_MS
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'strict',
    secure: env('COOKIE_SECURE', 'false') === 'true',
    path: '/'
  });
}

/* --------------------------------------------------------- middlewares --- */

function allowedOrigins() {
  return String(env('SITE_ORIGINS', '')).split(',').map((s) => s.trim()).filter(Boolean);
}

/** 401 unless a valid admin session cookie is present. */
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = verifyToken(token);
    if (payload.sub !== 'admin') throw new Error('bad subject');
    req.admin = payload;
    return next();
  } catch (_e) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Session expired, please sign in again' });
  }
}

/**
 * CSRF guard for state-changing requests. Three independent checks:
 *   1. a custom header — cross-origin pages cannot set it without a CORS
 *      preflight this server would refuse;
 *   2. the Origin header, when the browser sends one, must be our own site;
 *   3. Sec-Fetch-Site, when present, must not be "cross-site".
 * SameSite=Strict on the cookie already blocks the classic CSRF vector.
 */
function csrfGuard(req, res, next) {
  if (req.get('x-requested-with') !== 'XMLHttpRequest') {
    return res.status(403).json({ error: 'Missing CSRF header' });
  }
  const origin = req.get('origin');
  if (origin && !allowedOrigins().includes(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return res.status(403).json({ error: 'Cross-site request blocked' });
  }
  return next();
}

module.exports = {
  init,
  verifyCredentials,
  lockedFor,
  recordFailure,
  recordSuccess,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  csrfGuard,
  COOKIE_NAME
};

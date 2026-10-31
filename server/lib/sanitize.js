'use strict';
/* ==========================================================================
   sanitize.js — validation + cleaning for anything a human typed.
   The rules are deliberately strict: we store only plain, printable text and
   never HTML. Escaping happens on OUTPUT (the admin UI renders with
   textContent), this is defence in depth on the way IN.
   ========================================================================== */

/** Strip control characters (keep \n and \t), collapse runs of spaces. */
function stripControl(value) {
  return String(value == null ? '' : value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n');
}

/**
 * Single-line text: control-stripped, angle brackets removed, whitespace
 * collapsed, trimmed and capped. Safe to show anywhere.
 */
function line(value, max) {
  return stripControl(value).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Multi-line text (messages): keeps newlines, drops HTML, caps length. */
function block(value, max) {
  return stripControl(value).replace(/[<>]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

/** Optional email — only validated when a value is actually supplied. */
function email(value) {
  const v = line(value, 254);
  if (!v) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v : '';
}

/** Rating must be an integer 1..5; anything else becomes null. */
function rating(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r >= 1 && r <= 5 ? r : null;
}

/** Whitelists — never trust an enum sent by the client. */
const TYPES = ['review', 'suggestion'];
const STATUSES = ['pending', 'approved', 'hidden'];

function type(value) {
  return TYPES.includes(String(value)) ? String(value) : null;
}

function status(value) {
  return STATUSES.includes(String(value)) ? String(value) : null;
}

/** Escape LIKE wildcards so a search for "100%" cannot scan the whole table. */
function likeTerm(value) {
  return '%' + String(value).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

/** SQLite LIKE ... ESCAPE '\' needs the escape clause on every LIKE. */
const LIKE = " LIKE ? ESCAPE '\\'";

module.exports = { line, block, email, rating, type, status, likeTerm, LIKE, TYPES, STATUSES };

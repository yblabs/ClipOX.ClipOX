'use strict';
/* ==========================================================================
   store.js — SQLite data layer (Node's built-in `node:sqlite`, no native
   npm modules to compile).

   Every value is bound with a `?` placeholder — there is no string
   interpolation of user input anywhere in this file. The only dynamic SQL is
   the ORDER BY column, which is picked from a whitelist, and the SET list of
   an UPDATE, whose column names also come from a whitelist.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'feedback.db');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS feedback (
    id        TEXT PRIMARY KEY,
    type      TEXT NOT NULL CHECK (type IN ('review','suggestion')),
    rating    INTEGER,
    name      TEXT NOT NULL DEFAULT '',
    role      TEXT NOT NULL DEFAULT '',
    message   TEXT NOT NULL,
    email     TEXT NOT NULL DEFAULT '',
    category  TEXT NOT NULL DEFAULT '',
    status    TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','approved','hidden')),
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS ix_feedback_status  ON feedback (status);
  CREATE INDEX IF NOT EXISTS ix_feedback_created ON feedback (createdAt DESC);
  CREATE INDEX IF NOT EXISTS ix_feedback_type    ON feedback (type);
`);

/* ------------------------------------------------------------ column maps - */

/** Columns a client may ever write through an update. */
const UPDATABLE = {
  name: 'text',
  role: 'text',
  message: 'text',
  rating: 'int',
  status: 'status'
};

/** ORDER BY whitelist — the only place a column name becomes SQL. */
const SORTABLE = {
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  rating: 'rating',
  name: 'name',
  type: 'type',
  status: 'status'
};

const LIKE = " LIKE ? ESCAPE '\\'";

function likeTerm(v) {
  return '%' + String(v).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

function now() {
  return Date.now();
}

function id() {
  return 'fb_' + crypto.randomBytes(9).toString('hex');
}

/* --------------------------------------------------------------- writes --- */

/**
 * Insert one record. `row` is already sanitised by lib/sanitize.js.
 * @returns {object} the stored row
 */
function insert(row) {
  const ts = now();
  const rec = {
    id: id(),
    type: row.type,
    rating: row.rating == null ? null : row.rating,
    name: row.name || '',
    role: row.role || '',
    message: row.message,
    email: row.email || '',
    category: row.category || '',
    status: row.status || 'pending',
    createdAt: ts,
    updatedAt: ts
  };
  db.prepare(`
    INSERT INTO feedback (id, type, rating, name, role, message, email, category, status, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rec.id, rec.type, rec.rating, rec.name, rec.role,
    rec.message, rec.email, rec.category, rec.status,
    rec.createdAt, rec.updatedAt
  );
  return rec;
}

/** Update the editable fields of one row. @returns {number} rows changed */
function update(rowId, fields) {
  const sets = [];
  const values = [];

  for (const [key, raw] of Object.entries(fields)) {
    const kind = UPDATABLE[key];
    if (!kind) continue;                        // ignore anything not whitelisted
    if (raw === undefined) continue;
    sets.push(`"${key}" = ?`);
    values.push(kind === 'int' ? (raw == null ? null : Number(raw)) : String(raw));
  }
  if (!sets.length) return 0;

  sets.push('"updatedAt" = ?');
  values.push(now());
  values.push(rowId);

  return db.prepare(`UPDATE feedback SET ${sets.join(', ')} WHERE id = ?`).run(...values).changes;
}

/** Delete one row. @returns {number} rows changed */
function remove(rowId) {
  return db.prepare('DELETE FROM feedback WHERE id = ?').run(rowId).changes;
}

/**
 * Bulk action: 'approved' | 'hidden' | 'deleted'.
 * ids are bound as `IN (?,?,?)` — the placeholders are generated, the values
 * are still parameters.
 * @returns {number} rows affected
 */
function bulk(ids, action) {
  const list = (Array.isArray(ids) ? ids : []).filter((v) => typeof v === 'string' && v).slice(0, 500);
  if (!list.length) return 0;

  if (action === 'deleted') {
    const stmt = db.prepare(`DELETE FROM feedback WHERE id IN (${list.map(() => '?').join(',')})`);
    return stmt.run(...list).changes;
  }

  const next = action === 'approved' ? 'approved' : 'hidden';
  const stmt = db.prepare(
    `UPDATE feedback SET status = ?, updatedAt = ? WHERE id IN (${list.map(() => '?').join(',')})`
  );
  return stmt.run(next, now(), ...list).changes;
}

/* ---------------------------------------------------------------- reads --- */

function get(rowId) {
  return db.prepare('SELECT * FROM feedback WHERE id = ?').get(rowId) || null;
}

/**
 * Filtered, sorted, paginated list.
 * @param {object} q  { type, status, rating, q, from, to, page, pageSize, sort, dir }
 * @returns {{items: object[], total: number, page: number, pageSize: number, pages: number}}
 */
function list(q = {}) {
  const where = [];
  const params = [];

  if (q.type) { where.push('"type" = ?'); params.push(q.type); }
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  if (q.rating) { where.push('rating = ?'); params.push(Number(q.rating)); }

  if (q.q) {
    const term = likeTerm(q.q);
    where.push(
      `("name" ${LIKE} OR "role" ${LIKE} OR "message" ${LIKE} OR "email" ${LIKE} OR "category" ${LIKE})`
    );
    params.push(term, term, term, term, term);
  }

  if (q.from) { where.push('"createdAt" >= ?'); params.push(Number(q.from)); }
  if (q.to)   { where.push('"createdAt" <= ?'); params.push(Number(q.to)); }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM feedback ${clause}`).get(...params).n;

  const col = SORTABLE[q.sort] || 'createdAt';
  const dir = String(q.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 25));
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number(q.page) || 1));
  const offset = (page - 1) * pageSize;

  const items = db.prepare(
    `SELECT * FROM feedback ${clause} ORDER BY "${col}" ${dir}, id ASC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset);

  return { items, total, page, pageSize, pages };
}

/** Only approved reviews — the public carousel feed. */
function approvedReviews(limit = 50) {
  return db.prepare(`
    SELECT id, type, rating, name, role, message, category, status, createdAt AS timestamp
    FROM feedback
    WHERE type = 'review' AND status = 'approved'
    ORDER BY createdAt DESC
    LIMIT ?
  `).all(Math.min(200, Math.max(1, Number(limit) || 50)));
}

/** Dashboard counters. */
function stats() {
  const weekAgo = now() - 7 * 24 * 60 * 60 * 1000;
  const row = db.prepare(`
    SELECT
      COUNT(*)                                                      AS total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)           AS pending,
      SUM(CASE WHEN createdAt >= ? THEN 1 ELSE 0 END)               AS fresh,
      AVG(CASE WHEN type = 'review' AND rating IS NOT NULL
               THEN rating END)                                     AS avgRating,
      SUM(CASE WHEN type = 'review' THEN 1 ELSE 0 END)              AS reviews,
      SUM(CASE WHEN type = 'suggestion' THEN 1 ELSE 0 END)          AS suggestions
    FROM feedback
  `).get(weekAgo);

  return {
    total: row.total || 0,
    pending: row.pending || 0,
    thisWeek: row.fresh || 0,
    avgRating: row.avgRating == null ? null : Math.round(row.avgRating * 10) / 10,
    reviews: row.reviews || 0,
    suggestions: row.suggestions || 0
  };
}

module.exports = { insert, update, remove, bulk, get, list, approvedReviews, stats, DB_FILE };

// SQLite storage (node:sqlite, built into Node >= 22.13 / 24; still marked
// experimental upstream). Opening is idempotent: the base schema is created if
// missing and later columns are added by migrate(), so an old database file
// upgrades in place.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { maskPhone } from './phone-format.js';

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_sha256 TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY,
  started INTEGER NOT NULL,
  ended INTEGER NOT NULL,
  has_ai INTEGER NOT NULL,
  multiplier INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS results (
  game_id INTEGER NOT NULL REFERENCES games(id),
  seat INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id),
  cards_left INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  PRIMARY KEY (game_id, seat)
);
CREATE INDEX IF NOT EXISTS results_user ON results(user_id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  admin_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
-- A season is a date range (epoch ms, UTC). A finished game belongs to the
-- season whose range contains the moment it ended: starts <= ended < ends.
-- ends NULL means "until the admin sets one". Ranges never overlap.
CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  starts INTEGER NOT NULL,
  ends INTEGER,
  CHECK (ends IS NULL OR ends > starts)
);
-- One pending phone-verification code per user (hashed; short-lived).
CREATE TABLE IF NOT EXISTS phone_codes (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  salt TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
-- Every text we try to send (never its content or the number): drives the
-- per-user cooldown and daily cap, and gives an audit trail of volume.
CREATE TABLE IF NOT EXISTS sms_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ok INTEGER NOT NULL,
  sent INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sms_log_user ON sms_log(user_id, kind, sent);
-- The one live table (waiting, playing or just finished), so a game survives
-- a server restart. At most one row.
CREATE TABLE IF NOT EXISTS live_game (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  updated INTEGER NOT NULL
);
`;

function addColumn(db, table, column, ddl) {
  const have = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
  if (!have.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function migrate(db) {
  addColumn(db, 'users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'users', 'disabled', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'users', 'last_login', 'INTEGER');
  // Phone numbers (E.164). Required for every new account; NULL only for accounts
  // that predate the rule, which are asked for one before they can join a game.
  addColumn(db, 'users', 'phone', 'TEXT');
  addColumn(db, 'users', 'phone_verified', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'users', 'sms_enabled', 'INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'users', 'sms_blocked', 'INTEGER NOT NULL DEFAULT 0'); // the carrier says they opted out
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_phone ON users(phone) WHERE phone IS NOT NULL');
  // 'finished' games score; 'cancelled' ones (an admin ended them) never do.
  addColumn(db, 'games', 'status', "TEXT NOT NULL DEFAULT 'finished'");
  // Every database has a first season, so there is always something to rank.
  // Existing games all fall inside it (it starts at the earliest one).
  if (db.prepare('SELECT COUNT(*) AS n FROM seasons').get().n === 0) {
    const first = db.prepare('SELECT MIN(ended) AS m FROM games').get().m;
    db.prepare('INSERT INTO seasons (name, starts, ends) VALUES (?, ?, NULL)').run('Season 1', first ?? Date.now());
  }
}

export function openDb(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// ---- games and scores ----

// seats: [{ userId|null, cardsLeft, delta }] indexed by seat. One transaction,
// so a game is either fully recorded or not at all; deltas must sum to zero.
export function recordGame(db, { started, ended, hasAi, multiplier, seats }) {
  if (seats.reduce((a, s) => a + s.delta, 0) !== 0) throw new Error('Scores must sum to zero');
  db.exec('BEGIN IMMEDIATE');
  try {
    const g = db
      .prepare("INSERT INTO games (started, ended, has_ai, multiplier, status) VALUES (?, ?, ?, ?, 'finished')")
      .run(started, ended, hasAi ? 1 : 0, multiplier);
    const gameId = Number(g.lastInsertRowid);
    const ins = db.prepare('INSERT INTO results (game_id, seat, user_id, cards_left, delta) VALUES (?, ?, ?, ?, ?)');
    seats.forEach((s, seat) => ins.run(gameId, seat, s.userId, s.cardsLeft, s.delta));
    db.exec('COMMIT');
    return gameId;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// A game an admin ended: kept for the record, but with no results rows, so it
// can never reach a leaderboard.
export function recordCancelled(db, { started, ended, hasAi }) {
  const g = db
    .prepare("INSERT INTO games (started, ended, has_ai, multiplier, status) VALUES (?, ?, ?, 1, 'cancelled')")
    .run(started, ended, hasAi ? 1 : 0);
  return Number(g.lastInsertRowid);
}

export class SeasonError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const FAR_PAST = -9e15;
const FAR_FUTURE = 9e15;
const MIN_TIME = Date.UTC(2020, 0, 1);
const MAX_TIME = Date.UTC(2100, 0, 1);

const seasonRow = (r) => (r ? { id: r.id, name: r.name, starts: r.starts, ends: r.ends } : null);

// which: 'current' (the season containing `now`, or null in a gap), 'all'
// (every game, ever) or a season id.
export function resolveSeason(db, which = 'current', now = Date.now()) {
  if (which === 'all') return { id: null, name: 'All-time', starts: null, ends: null };
  if (which === 'current') {
    return seasonRow(
      db
        .prepare('SELECT * FROM seasons WHERE starts <= ? AND (ends IS NULL OR ? < ends) ORDER BY starts DESC LIMIT 1')
        .get(now, now),
    );
  }
  const row = db.prepare('SELECT * FROM seasons WHERE id = ?').get(Number(which));
  if (!row) throw new SeasonError(404, 'No such season.');
  return seasonRow(row);
}

// Cumulative standings. kind 'human': games with four human seats; 'ai': games
// with any computer seat. Cancelled games never count. Ranked by total points
// (the running total), or by points per game with sort 'perGame'; the other is
// always shown. `season` as in resolveSeason; no season means no rows.
export function leaderboard(db, kind, { season = 'current', sort = 'points', minGames = 1, now = Date.now() } = {}) {
  const s = resolveSeason(db, season, now);
  if (!s) return { season: null, rows: [] };
  const order =
    sort === 'perGame' ? 'perGame DESC, points DESC, games DESC, name' : 'points DESC, wins DESC, games ASC, name';
  const rows = db
    .prepare(
      `SELECT u.name AS name, COUNT(*) AS games, SUM(r.delta > 0) AS wins, SUM(r.delta) AS points,
              ROUND(1.0 * SUM(r.delta) / COUNT(*), 2) AS perGame,
              ROUND(100.0 * SUM(r.delta > 0) / COUNT(*), 1) AS winPct
       FROM results r JOIN games g ON g.id = r.game_id JOIN users u ON u.id = r.user_id
       WHERE g.has_ai = ? AND g.status = 'finished' AND g.ended >= ? AND g.ended < ?
       GROUP BY r.user_id HAVING COUNT(*) >= ?
       ORDER BY ${order} LIMIT 100`,
    )
    .all(kind === 'ai' ? 1 : 0, s.starts ?? FAR_PAST, s.ends ?? FAR_FUTURE, minGames);
  return { season: s, rows: rows.map((r) => ({ ...r })) };
}

// All seasons, newest first, with status, game count and champion (top total
// among the all-human games; null if nobody has played).
export function listSeasons(db, now = Date.now()) {
  const rows = db.prepare('SELECT * FROM seasons ORDER BY starts DESC').all();
  return rows.map((r) => {
    const s = seasonRow(r);
    const status = now < s.starts ? 'upcoming' : s.ends !== null && now >= s.ends ? 'past' : 'active';
    const games = db
      .prepare("SELECT COUNT(*) AS n FROM games WHERE status = 'finished' AND ended >= ? AND ended < ?")
      .get(s.starts, s.ends ?? FAR_FUTURE).n;
    const top = leaderboard(db, 'human', { season: s.id, now }).rows[0];
    return { ...s, status, games, champion: top ? top.name : null };
  });
}

function validateSeason(db, { name, starts, ends }, ignoreId = null) {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (clean.length < 1 || clean.length > 40) throw new SeasonError(400, 'Season name must be 1-40 characters.');
  const inRange = (t) => Number.isSafeInteger(t) && t >= MIN_TIME && t < MAX_TIME;
  if (!inRange(starts)) throw new SeasonError(400, 'The start time is not a valid date.');
  const end = ends === undefined || ends === null ? null : ends;
  if (end !== null && !inRange(end)) throw new SeasonError(400, 'The end time is not a valid date.');
  if (end !== null && end <= starts) throw new SeasonError(400, 'The season must end after it starts.');
  // Ranges are [starts, ends): touching end-to-start is fine, overlapping is not.
  const clash = db
    .prepare('SELECT name FROM seasons WHERE id IS NOT ? AND starts < ? AND ? < COALESCE(ends, ?)')
    .get(ignoreId, end ?? FAR_FUTURE, starts, FAR_FUTURE);
  if (clash) throw new SeasonError(409, `These dates overlap "${clash.name}".`);
  return { name: clean, starts, ends: end };
}

export function createSeason(db, input) {
  const v = validateSeason(db, input);
  const r = db.prepare('INSERT INTO seasons (name, starts, ends) VALUES (?, ?, ?)').run(v.name, v.starts, v.ends);
  return { id: Number(r.lastInsertRowid), ...v };
}

export function updateSeason(db, id, input) {
  if (!db.prepare('SELECT 1 FROM seasons WHERE id = ?').get(id)) throw new SeasonError(404, 'No such season.');
  const v = validateSeason(db, input, id);
  db.prepare('UPDATE seasons SET name = ?, starts = ?, ends = ? WHERE id = ?').run(v.name, v.starts, v.ends, id);
  return { id, ...v };
}

// Games are never touched: they simply stop belonging to any season.
export function deleteSeason(db, id) {
  const r = db.prepare('DELETE FROM seasons WHERE id = ?').run(id);
  if (!r.changes) throw new SeasonError(404, 'No such season.');
}

// ---- the live table ----

export function saveLive(db, obj, now = Date.now()) {
  db.prepare(
    `INSERT INTO live_game (id, data, updated) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated = excluded.updated`,
  ).run(JSON.stringify(obj), now);
}

export function loadLive(db) {
  const row = db.prepare('SELECT data FROM live_game WHERE id = 1').get();
  return row ? JSON.parse(row.data) : null;
}

export function clearLive(db) {
  db.prepare('DELETE FROM live_game WHERE id = 1').run();
}

// ---- admin ----

export function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

export function audit(db, adminId, action, target = null, detail = null, now = Date.now()) {
  db.prepare('INSERT INTO audit (ts, admin_id, action, target, detail) VALUES (?, ?, ?, ?, ?)').run(
    now,
    adminId,
    action,
    target,
    detail,
  );
}

export function recentAudit(db, limit = 50) {
  return db
    .prepare(
      `SELECT a.id, a.ts, u.name AS admin, a.action, a.target, a.detail
       FROM audit a LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.id DESC LIMIT ?`,
    )
    .all(limit)
    .map((r) => ({ ...r }));
}

// Phone numbers leave this function masked, never whole.
export function listUsers(db) {
  return db
    .prepare(
      `SELECT u.id, u.name, u.is_admin AS isAdmin, u.disabled, u.created, u.last_login AS lastLogin,
              u.phone AS phone, u.phone_verified AS phoneVerified, u.sms_enabled AS smsEnabled,
              COUNT(r.game_id) AS games
       FROM users u LEFT JOIN results r ON r.user_id = u.id
       GROUP BY u.id ORDER BY u.name COLLATE NOCASE`,
    )
    .all()
    .map(({ phone, ...r }) => ({
      ...r,
      isAdmin: !!r.isAdmin,
      disabled: !!r.disabled,
      phoneVerified: !!r.phoneVerified,
      smsEnabled: !!r.smsEnabled,
      phone: maskPhone(phone),
    }));
}

export function adminCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0').get().n;
}

export function stats(db) {
  const one = (sql) => db.prepare(sql).get().n;
  return {
    users: one('SELECT COUNT(*) AS n FROM users'),
    gamesFinished: one("SELECT COUNT(*) AS n FROM games WHERE status = 'finished'"),
    gamesCancelled: one("SELECT COUNT(*) AS n FROM games WHERE status = 'cancelled'"),
  };
}

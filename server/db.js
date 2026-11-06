// SQLite storage (node:sqlite, built into Node >= 22.13 / 24; still marked
// experimental upstream). Opening is idempotent: the base schema is created if
// missing and later columns are added by migrate(), so an old database file
// upgrades in place.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DECK_SIZE } from '../src/cards.js';

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
-- One row per device that has turned turn alerts on (a browser's push subscription). The endpoint is the
-- address of that device at its push service; p256dh and auth are the keys messages to it are encrypted with.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  label TEXT NOT NULL,
  created INTEGER NOT NULL,
  last_ok INTEGER
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id);
-- Every turn alert we try to send (never its content): says which turns have already been alerted,
-- so a restart cannot repeat one, and bounds how many one person can get in a day.
CREATE TABLE IF NOT EXISTS push_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ok INTEGER NOT NULL,
  sent INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_log_user ON push_log(user_id, sent);
-- A person's finished solo rounds against the computer, reported by their browser: only ever read back for that
-- person. client_id makes a retried report count once.
CREATE TABLE IF NOT EXISTS solo_games (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('easy', 'medium', 'hard')),
  players INTEGER NOT NULL CHECK (players IN (3, 4)),
  won INTEGER NOT NULL CHECK (won IN (0, 1)),
  delta INTEGER NOT NULL,
  ended INTEGER NOT NULL,
  UNIQUE (user_id, client_id)
);
-- What a finished game was dealt and how it was played, so it can be studied or replayed
-- later. One row per seat, and one per move (cards is a JSON array, NULL for a pass).
CREATE TABLE IF NOT EXISTS game_deals (
  game_id INTEGER NOT NULL REFERENCES games(id),
  seat INTEGER NOT NULL,
  hand TEXT NOT NULL,
  PRIMARY KEY (game_id, seat)
);
CREATE TABLE IF NOT EXISTS game_moves (
  game_id INTEGER NOT NULL REFERENCES games(id),
  ply INTEGER NOT NULL,
  seat INTEGER NOT NULL,
  cards TEXT,
  auto INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, ply)
);
-- What the deal model (docs/deal-model.md) says each seat's cards were worth, per game: a win chance and
-- expected points. "model" fingerprints the model file, so a refit recomputes instead of mixing versions.
CREATE TABLE IF NOT EXISTS game_expectation (
  game_id INTEGER NOT NULL REFERENCES games(id),
  seat INTEGER NOT NULL,
  model TEXT NOT NULL,
  win_p REAL NOT NULL,
  exp_points REAL NOT NULL,
  PRIMARY KEY (game_id, seat, model)
);
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

// Text messages are gone (turn alerts are push notifications now), so the phone numbers and everything
// that went with them are erased from a database that still has them. Safe to run every time.
function dropPhoneData(db) {
  db.exec('DROP INDEX IF EXISTS users_phone');
  for (const table of ['phone_codes', 'login_codes', 'sms_log']) db.exec(`DROP TABLE IF EXISTS ${table}`);
  const have = db
    .prepare('PRAGMA table_info(users)')
    .all()
    .map((c) => c.name);
  for (const column of ['phone', 'phone_verified', 'sms_enabled', 'sms_blocked']) {
    if (have.includes(column)) db.exec(`ALTER TABLE users DROP COLUMN ${column}`);
  }
}

function migrate(db) {
  addColumn(db, 'users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'users', 'disabled', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'users', 'last_login', 'INTEGER');
  // When a session began, so a renewed one can still be capped (0 = began before this column existed).
  addColumn(db, 'sessions', 'created', 'INTEGER NOT NULL DEFAULT 0');
  // 'finished' games score; 'cancelled' ones (an admin ended them) never do.
  addColumn(db, 'games', 'status', "TEXT NOT NULL DEFAULT 'finished'");
  // 3 or 4. NULL for games saved before this column existed (their results rows give the count).
  addColumn(db, 'games', 'players', 'INTEGER');
  dropPhoneData(db);
  // A new database starts with one season, so there is something to rank. Existing games all fall inside it
  // (it starts at the earliest one). That happens once: after that, having no season is a choice an admin can
  // make (no online game can start until they create one), so it must survive a restart.
  const hasSeasons = db.prepare('SELECT COUNT(*) AS n FROM seasons').get().n > 0;
  if (!hasSeasons && getSetting(db, 'seasons_seeded', '0') !== '1') {
    const first = db.prepare('SELECT MIN(ended) AS m FROM games').get().m;
    db.prepare('INSERT INTO seasons (name, starts, ends) VALUES (?, ?, NULL)').run('Season 1', first ?? Date.now());
  }
  setSetting(db, 'seasons_seeded', '1');
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

const isCardId = (c) => Number.isInteger(c) && c >= 0 && c < DECK_SIZE;
const MAX_MOVES = 5000;

// Returns why a game record cannot be saved, or null if it can: every card dealt exactly once,
// and every move by a real seat with real cards.
export function recordProblem(record, players) {
  const { deals, moves } = record || {};
  if (!Array.isArray(deals) || deals.length !== players) return 'one deal per seat is needed';
  const seen = new Set();
  for (const hand of deals) {
    if (!Array.isArray(hand) || !hand.every(isCardId)) return 'a deal holds something that is not a card';
    for (const c of hand) {
      if (seen.has(c)) return `card ${c} was dealt twice`;
      seen.add(c);
    }
  }
  if (seen.size !== DECK_SIZE) return `${seen.size} cards were dealt, not ${DECK_SIZE}`;
  if (!Array.isArray(moves) || moves.length > MAX_MOVES) return 'the move log is missing or too long';
  for (const m of moves) {
    const okSeat = m && Number.isInteger(m.seat) && m.seat >= 0 && m.seat < players;
    const okCards =
      m && (m.cards === null || (Array.isArray(m.cards) && m.cards.length > 0 && m.cards.every(isCardId)));
    if (!okSeat || !okCards) return 'the move log holds a bad move';
  }
  return null;
}

// seats: [{ userId|null, cardsLeft, delta }] indexed by seat. One transaction,
// so a game is either fully recorded or not at all; deltas must sum to zero.
// record (optional): { deals, moves } as made by initialDeals and moveLog, saved in the same
// transaction (see recordProblem; callers check it first so a bad record never costs a score).
export function recordGame(db, { started, ended, hasAi, multiplier, seats, record }) {
  if (seats.reduce((a, s) => a + s.delta, 0) !== 0) throw new Error('Scores must sum to zero');
  if (record) {
    const problem = recordProblem(record, seats.length);
    if (problem) throw new Error(`Bad game record: ${problem}`);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const g = db
      .prepare(
        "INSERT INTO games (started, ended, has_ai, multiplier, status, players) VALUES (?, ?, ?, ?, 'finished', ?)",
      )
      .run(started, ended, hasAi ? 1 : 0, multiplier, seats.length);
    const gameId = Number(g.lastInsertRowid);
    const ins = db.prepare('INSERT INTO results (game_id, seat, user_id, cards_left, delta) VALUES (?, ?, ?, ?, ?)');
    seats.forEach((s, seat) => ins.run(gameId, seat, s.userId, s.cardsLeft, s.delta));
    if (record) {
      const insDeal = db.prepare('INSERT INTO game_deals (game_id, seat, hand) VALUES (?, ?, ?)');
      record.deals.forEach((hand, seat) => insDeal.run(gameId, seat, JSON.stringify(hand)));
      const insMove = db.prepare('INSERT INTO game_moves (game_id, ply, seat, cards, auto) VALUES (?, ?, ?, ?, ?)');
      record.moves.forEach((m, ply) =>
        insMove.run(gameId, ply, m.seat, m.cards ? JSON.stringify(m.cards) : null, m.auto ? 1 : 0),
      );
    }
    db.exec('COMMIT');
    return gameId;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// A saved game's deal and moves, or null for a game with no record (saved before records existed,
// or whose record could not be saved).
export function loadGameRecord(db, gameId) {
  const game = db.prepare('SELECT players FROM games WHERE id = ?').get(gameId);
  const dealRows = db.prepare('SELECT hand FROM game_deals WHERE game_id = ? ORDER BY seat').all(gameId);
  if (!game || !dealRows.length) return null;
  const moves = db
    .prepare('SELECT seat, cards, auto FROM game_moves WHERE game_id = ? ORDER BY ply')
    .all(gameId)
    .map((m) => ({ seat: m.seat, cards: m.cards === null ? null : JSON.parse(m.cards), auto: m.auto === 1 }));
  return { players: game.players ?? dealRows.length, deals: dealRows.map((r) => JSON.parse(r.hand)), moves };
}

// A game an admin ended: kept for the record, but with no results rows, so it
// can never reach a leaderboard.
// A player left a game in progress. The game is void for everyone else (no result rows for them, so it counts for
// nobody), and the leaver gets the worst result a round can give, which does count for them. Status 'forfeit'.
export function recordForfeit(db, { userId, seat, players, started, ended, cardsLeft, delta }) {
  if (!(delta < 0)) throw new Error('A forfeit costs points');
  db.exec('BEGIN IMMEDIATE');
  try {
    const g = db
      .prepare(
        "INSERT INTO games (started, ended, has_ai, multiplier, status, players) VALUES (?, ?, 0, 1, 'forfeit', ?)",
      )
      .run(started, ended, players);
    const gameId = Number(g.lastInsertRowid);
    db.prepare('INSERT INTO results (game_id, seat, user_id, cards_left, delta) VALUES (?, ?, ?, ?, ?)').run(
      gameId,
      seat,
      userId,
      cardsLeft,
      delta,
    );
    db.exec('COMMIT');
    return gameId;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

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
       WHERE g.has_ai = ? AND g.status IN ('finished', 'forfeit') AND g.ended >= ? AND g.ended < ?
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
    .prepare('SELECT name, ends FROM seasons WHERE id IS NOT ? AND starts < ? AND ? < COALESCE(ends, ?)')
    .get(ignoreId, end ?? FAR_FUTURE, starts, FAR_FUTURE);
  if (clash) {
    throw new SeasonError(
      409,
      clash.ends === null
        ? `These dates overlap "${clash.name}", which has no end date. Press End now on it first.`
        : `These dates overlap "${clash.name}".`,
    );
  }
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

// Ends a running season now, so the next one can start (a game finishing after this counts in no season until
// there is another). A season that has not started has nothing to end (delete it), and one that is over is over.
export function endSeason(db, id, now = Date.now()) {
  const s = db.prepare('SELECT * FROM seasons WHERE id = ?').get(id);
  if (!s) throw new SeasonError(404, 'No such season.');
  if (now <= s.starts) throw new SeasonError(409, 'That season has not started yet: delete it instead.');
  if (s.ends !== null && s.ends <= now) throw new SeasonError(409, 'That season is already over.');
  db.prepare('UPDATE seasons SET ends = ? WHERE id = ?').run(now, id);
  return { ...seasonRow(s), ends: now };
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

// `devices` is how many devices the person has turn alerts on for.
export function listUsers(db) {
  return db
    .prepare(
      `SELECT u.id, u.name, u.is_admin AS isAdmin, u.disabled, u.created, u.last_login AS lastLogin,
              (SELECT COUNT(*) FROM push_subscriptions s WHERE s.user_id = u.id) AS devices,
              COUNT(r.game_id) AS games
       FROM users u LEFT JOIN results r ON r.user_id = u.id
       GROUP BY u.id ORDER BY u.name COLLATE NOCASE`,
    )
    .all()
    .map((r) => ({ ...r, isAdmin: !!r.isAdmin, disabled: !!r.disabled }));
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
    gamesForfeited: one("SELECT COUNT(*) AS n FROM games WHERE status = 'forfeit'"),
  };
}

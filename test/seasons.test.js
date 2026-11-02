import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  openDb,
  recordGame,
  recordCancelled,
  leaderboard,
  listSeasons,
  createSeason,
  updateSeason,
  deleteSeason,
  resolveSeason,
  recentAudit,
} from '../server/db.js';
import { createUser } from '../server/auth.js';
import { boot, makeUser } from './support.js';

const T0 = Date.UTC(2026, 0, 1);
const DAY = 86400000;
const PW = 'correct-horse-battery';

async function fresh(names) {
  const db = openDb(':memory:');
  const ids = {};
  for (const n of names) ids[n] = (await createUser(db, n, PW)).id;
  deleteSeason(db, 1); // drop the automatic "Season 1" so the test controls every range
  return { db, ids };
}

// One finished game: `gains` maps user name -> points (the rest are computer
// seats); the deltas are balanced to sum to zero.
function game(db, ids, ended, gains, { hasAi = true } = {}) {
  const seats = Object.entries(gains).map(([name, delta]) => ({ userId: ids[name], cardsLeft: 3, delta }));
  const sum = seats.reduce((a, s) => a + s.delta, 0);
  while (seats.length < 4) seats.push({ userId: null, cardsLeft: 5, delta: seats.length === 3 ? -sum : 0 });
  return recordGame(db, { started: ended - 1000, ended, hasAi, multiplier: 1, seats });
}

test('a fresh database has an open-ended Season 1 that is current', () => {
  const db = openDb(':memory:');
  const s = resolveSeason(db, 'current');
  assert.equal(s.name, 'Season 1');
  assert.equal(s.ends, null);
  assert.equal(listSeasons(db)[0].status, 'active');
  db.close();
});

test('a game belongs to the season containing the moment it ended: [starts, ends)', async () => {
  const { db, ids } = await fresh(['ann']);
  const a = createSeason(db, { name: 'A', starts: T0, ends: T0 + DAY });
  const b = createSeason(db, { name: 'B', starts: T0 + DAY, ends: T0 + 2 * DAY });
  game(db, ids, T0, { ann: 1 }); // first instant of A
  game(db, ids, T0 + DAY - 1, { ann: 2 }); // last instant of A
  game(db, ids, T0 + DAY, { ann: 4 }); // first instant of B
  game(db, ids, T0 + 2 * DAY - 1, { ann: 8 }); // last instant of B
  game(db, ids, T0 + 2 * DAY, { ann: 16 }); // after every season
  game(db, ids, T0 - 1, { ann: 32 }); // before every season
  const pts = (season) => leaderboard(db, 'ai', { season }).rows[0].points;
  assert.equal(pts(a.id), 3);
  assert.equal(pts(b.id), 12);
  // All-time counts everything, including games outside any season.
  assert.equal(pts('all'), 1 + 2 + 4 + 8 + 16 + 32);
  db.close();
});

test('all-time is the sum of the seasons plus the games between them', async () => {
  const { db, ids } = await fresh(['ann', 'bob']);
  const a = createSeason(db, { name: 'A', starts: T0, ends: T0 + DAY });
  const b = createSeason(db, { name: 'B', starts: T0 + 2 * DAY, ends: null }); // a gap before it
  game(db, ids, T0 + 10, { ann: 5, bob: -5 });
  game(db, ids, T0 + DAY + 10, { ann: 7, bob: -7 }); // in the gap
  game(db, ids, T0 + 2 * DAY + 10, { ann: -3, bob: 3 });
  const total = (season, who) => leaderboard(db, 'ai', { season }).rows.find((r) => r.name === who).points;
  assert.equal(total(a.id, 'ann') + total(b.id, 'ann') + 7, total('all', 'ann'));
  assert.equal(total('all', 'ann'), 9);
  assert.equal(total('all', 'bob'), -9);
  db.close();
});

test('cumulative standings: ranked by total points, with per-game and win rate beside them', async () => {
  const { db, ids } = await fresh(['ann', 'bob']);
  createSeason(db, { name: 'S', starts: T0, ends: null });
  for (let i = 0; i < 3; i++) game(db, ids, T0 + 100 + i, { ann: 10 }); // steady: 30 over 3 games
  game(db, ids, T0 + 200, { bob: 25, ann: -5 }); // one big win
  const byTotal = leaderboard(db, 'ai', { season: 'current', now: T0 + 1000 });
  assert.deepEqual(
    byTotal.rows.map((r) => r.name),
    ['ann', 'bob'],
  );
  const [ann, bob] = byTotal.rows;
  assert.deepEqual([ann.games, ann.wins, ann.points, ann.perGame, ann.winPct], [4, 3, 25, 6.25, 75]);
  assert.deepEqual([bob.games, bob.wins, bob.points, bob.perGame, bob.winPct], [1, 1, 25, 25, 100]);
  // Equal totals: more wins first... here ann has 25 over 4 games, bob 25 over 1. Wins decide.
  const byRate = leaderboard(db, 'ai', { season: 'current', sort: 'perGame', now: T0 + 1000 });
  assert.deepEqual(
    byRate.rows.map((r) => r.name),
    ['bob', 'ann'],
  );
  assert.equal(leaderboard(db, 'ai', { season: 'current', minGames: 2, now: T0 + 1000 }).rows.length, 1);
  db.close();
});

test('human-only and computer-player games are separate boards; cancelled games never count', async () => {
  const { db, ids } = await fresh(['ann', 'bob']);
  createSeason(db, { name: 'S', starts: T0, ends: null });
  game(db, ids, T0 + 5, { ann: 6, bob: -6 }, { hasAi: false });
  game(db, ids, T0 + 6, { ann: 9 }, { hasAi: true });
  recordCancelled(db, { started: T0 + 7, ended: T0 + 8, hasAi: false });
  const opt = { season: 'all' };
  assert.equal(leaderboard(db, 'human', opt).rows.find((r) => r.name === 'ann').points, 6);
  assert.equal(leaderboard(db, 'ai', opt).rows.find((r) => r.name === 'ann').points, 9);
  assert.equal(
    leaderboard(db, 'human', opt).rows.reduce((s, r) => s + r.games, 0),
    2,
  );
  assert.equal(listSeasons(db, T0 + 100)[0].games, 2, 'a cancelled game is not a season game');
  db.close();
});

test('season rules: overlap refused, touching and gaps allowed, bad input refused', async () => {
  const { db } = await fresh([]);
  const a = createSeason(db, { name: 'A', starts: T0, ends: T0 + DAY });
  assert.throws(() => createSeason(db, { name: 'X', starts: T0 + DAY / 2, ends: T0 + 2 * DAY }), /overlap "A"/);
  assert.throws(() => createSeason(db, { name: 'X', starts: T0 - DAY, ends: T0 + 1 }), /overlap "A"/);
  assert.throws(
    () => createSeason(db, { name: 'X', starts: T0 - DAY, ends: null }),
    /overlap "A"/,
    'open-ended covers A',
  );
  createSeason(db, { name: 'B', starts: T0 + DAY, ends: T0 + 2 * DAY }); // starts exactly when A ends
  createSeason(db, { name: 'D', starts: T0 + 5 * DAY, ends: null }); // a gap, then open-ended
  assert.throws(() => createSeason(db, { name: 'E', starts: T0 + 9 * DAY, ends: null }), /overlap "D"/);
  // Editing a season does not clash with itself, but with others.
  updateSeason(db, a.id, { name: 'A renamed', starts: T0, ends: T0 + DAY });
  assert.throws(() => updateSeason(db, a.id, { name: 'A', starts: T0, ends: T0 + DAY + 1 }), /overlap/);
  for (const bad of [
    { name: '', starts: T0, ends: null },
    { name: 'x'.repeat(41), starts: T0, ends: null },
    { name: 'ok', starts: 'soon', ends: null },
    { name: 'ok', starts: T0 + 10 * DAY, ends: T0 + 10 * DAY },
    { name: 'ok', starts: T0 + 10 * DAY, ends: T0 + 9 * DAY },
    { name: 'ok', starts: 5, ends: null },
    { name: 'ok', starts: T0 + 20 * DAY, ends: 1e20 },
  ]) {
    assert.throws(
      () => createSeason(db, bad),
      (e) => e.status === 400,
      JSON.stringify(bad),
    );
  }
  assert.throws(
    () => updateSeason(db, 999, { name: 'n', starts: T0, ends: null }),
    (e) => e.status === 404,
  );
  assert.throws(
    () => deleteSeason(db, 999),
    (e) => e.status === 404,
  );
  db.close();
});

test('editing or deleting a season only re-sorts games; nothing is lost', async () => {
  const { db, ids } = await fresh(['ann']);
  const a = createSeason(db, { name: 'A', starts: T0, ends: T0 + DAY });
  game(db, ids, T0 + DAY + 5, { ann: 10 }); // just after A: in no season
  assert.equal(leaderboard(db, 'ai', { season: a.id }).rows.length, 0);
  updateSeason(db, a.id, { name: 'A', starts: T0, ends: T0 + 2 * DAY }); // extend A over the game
  assert.equal(leaderboard(db, 'ai', { season: a.id }).rows[0].points, 10);
  deleteSeason(db, a.id);
  assert.equal(listSeasons(db).length, 0);
  assert.equal(leaderboard(db, 'ai', { season: 'all' }).rows[0].points, 10, 'the game is still there for all-time');
  db.close();
});

test('current season resolves by the clock, including gaps; list shows status and champion', async () => {
  const { db, ids } = await fresh(['ann', 'bob']);
  const a = createSeason(db, { name: 'A', starts: T0, ends: T0 + DAY });
  const b = createSeason(db, { name: 'B', starts: T0 + 3 * DAY, ends: T0 + 4 * DAY });
  game(db, ids, T0 + 10, { ann: 4, bob: -4 }, { hasAi: false });
  game(db, ids, T0 + 3 * DAY + 10, { bob: 9, ann: -9 }, { hasAi: false });
  assert.equal(resolveSeason(db, 'current', T0 + 10).name, 'A');
  assert.equal(resolveSeason(db, 'current', T0 + 2 * DAY), null, 'a gap has no current season');
  assert.deepEqual(leaderboard(db, 'human', { season: 'current', now: T0 + 2 * DAY }), { season: null, rows: [] });
  const now = T0 + 3 * DAY + 100;
  const list = listSeasons(db, now);
  assert.deepEqual(
    list.map((s) => [s.name, s.status, s.games, s.champion]),
    [
      ['B', 'active', 1, 'bob'],
      ['A', 'past', 1, 'ann'],
    ],
  );
  assert.equal(listSeasons(db, T0 - 5).find((s) => s.id === b.id).status, 'upcoming');
  assert.equal(a.id < b.id, true);
  assert.throws(
    () => resolveSeason(db, 999),
    (e) => e.status === 404,
  );
  db.close();
});

test('an old database gets Season 1 covering all its games', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'big2-seasons-'));
  const file = path.join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, pw_hash TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE sessions (token_sha256 TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE games (id INTEGER PRIMARY KEY, started INTEGER NOT NULL, ended INTEGER NOT NULL, has_ai INTEGER NOT NULL, multiplier INTEGER NOT NULL);
      CREATE TABLE results (game_id INTEGER NOT NULL, seat INTEGER NOT NULL, user_id INTEGER, cards_left INTEGER NOT NULL, delta INTEGER NOT NULL, PRIMARY KEY (game_id, seat));
      INSERT INTO users (name, pw_hash, created) VALUES ('veteran', 'x', 1);
      INSERT INTO games (started, ended, has_ai, multiplier) VALUES (${T0}, ${T0 + 500}, 1, 1), (${T0 + 900}, ${T0 + 1000}, 1, 1);
      INSERT INTO results VALUES (1, 0, 1, 0, 10), (1, 1, NULL, 5, -10), (2, 0, 1, 0, 4), (2, 1, NULL, 2, -4);
    `);
    old.close();
    const db = openDb(file);
    const seasons = listSeasons(db, T0 + 5000);
    assert.equal(seasons.length, 1);
    assert.equal(seasons[0].name, 'Season 1');
    assert.equal(seasons[0].starts, T0 + 500, 'starts at the earliest game');
    assert.equal(seasons[0].games, 2);
    assert.equal(leaderboard(db, 'ai', { season: 'current', now: T0 + 5000 }).rows[0].points, 14);
    openDb(file).close();
    assert.equal(listSeasons(db, T0 + 5000).length, 1, 'reopening does not add another');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('API: seasons and leaderboards are public; only admins change seasons; everything is validated and audited', async () => {
  const ctx = await boot();
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    const pleb = await makeUser(ctx, 'pleb');
    const anon = (await import('./support.js')).Client;
    const guest = new anon(ctx.base);
    const day = 86400000;
    const now = Date.now();

    const list = (await guest.req('GET', '/api/seasons')).json.seasons;
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'Season 1');
    assert.equal(list[0].status, 'active');
    assert.equal((await guest.req('GET', '/api/leaderboard?kind=human&season=current')).json.season.name, 'Season 1');

    // Season 1 is open-ended: give it an end, then add the next one after it.
    const s1 = list[0];
    const body = { name: 'Season 1', starts: s1.starts, ends: now + 7 * day };
    assert.equal((await pleb.req('POST', `/api/admin/seasons/${s1.id}`, body)).status, 403);
    assert.equal(
      (await pleb.req('POST', '/api/admin/seasons', { name: 'x', starts: now + 9 * day, ends: null })).status,
      403,
    );
    assert.equal((await pleb.req('POST', `/api/admin/seasons/${s1.id}/delete`, {})).status, 403);
    assert.equal((await guest.req('POST', '/api/admin/seasons', body)).status, 401);
    assert.equal((await admin.req('POST', `/api/admin/seasons/${s1.id}`, body)).status, 200);

    const next = { name: 'Spring', starts: now + 7 * day, ends: now + 30 * day };
    const made = await admin.req('POST', '/api/admin/seasons', next);
    assert.equal(made.status, 201);
    assert.equal((await admin.req('POST', '/api/admin/seasons', { ...next, name: 'Clash' })).status, 409);
    assert.equal((await admin.req('POST', '/api/admin/seasons', { name: '', starts: now, ends: null })).status, 400);
    assert.equal((await admin.req('POST', '/api/admin/seasons/9999', next)).status, 404);

    const after = (await guest.req('GET', '/api/seasons')).json.seasons;
    assert.deepEqual(
      after.map((s) => [s.name, s.status]),
      [
        ['Spring', 'upcoming'],
        ['Season 1', 'active'],
      ],
    );
    assert.equal(
      (await guest.req('GET', `/api/leaderboard?kind=ai&season=${made.json.season.id}`)).json.season.name,
      'Spring',
    );
    assert.equal((await guest.req('GET', '/api/leaderboard?kind=ai&season=all')).json.season.name, 'All-time');
    assert.equal((await guest.req('GET', '/api/leaderboard?kind=ai&season=bogus')).status, 400);
    assert.equal((await guest.req('GET', '/api/leaderboard?kind=ai&season=9999')).status, 404);
    assert.equal((await guest.req('GET', '/api/leaderboard?kind=ai&sort=perGame')).json.sort, 'perGame');

    assert.equal((await admin.req('POST', `/api/admin/seasons/${made.json.season.id}/delete`, {})).status, 200);
    assert.equal((await guest.req('GET', '/api/seasons')).json.seasons.length, 1);
    const actions = recentAudit(ctx.app.db).map((e) => e.action);
    for (const a of ['create_season', 'update_season', 'delete_season']) assert.ok(actions.includes(a), a);
    assert.match(recentAudit(ctx.app.db).find((e) => e.action === 'delete_season').detail, /to /);
    assert.deepEqual(ctx.logs, []);
  } finally {
    await ctx.app.close();
  }
});

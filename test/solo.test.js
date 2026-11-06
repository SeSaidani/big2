import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { recordSolo, soloStats, SoloError, MAX_DELTA } from '../server/solo.js';
import { scoreRound } from '../src/scoring.js';
import { newGame } from '../src/game.js';
import { FIVE, STRAIGHT_FLUSH } from '../src/hands.js';
import { mulberry32 } from '../src/cards.js';
import { Client, boot, makeUser } from './support.js';

async function dbWith(names) {
  const db = openDb(':memory:');
  const ids = {};
  for (const n of names) ids[n] = (await createUser(db, n, 'a-long-enough-password')).id;
  return { db, ids };
}
let n = 0;
const result = (level, players, delta) => ({
  clientId: `game-${++n}-${Math.random().toString(36).slice(2)}`,
  level,
  players,
  won: delta > 0,
  delta,
});

test('the table: every cell, each size, each level over both sizes, and the overall row', async () => {
  const { db, ids } = await dbWith(['ann']);
  const play = (level, players, delta) => recordSolo(db, ids.ann, result(level, players, delta));
  play('easy', 4, 30); // win
  play('easy', 4, -6); // loss
  play('easy', 4, 12); // win
  play('medium', 4, -40);
  play('hard', 4, 55);
  play('easy', 3, -9);
  play('easy', 3, 20);
  play('hard', 3, -16);
  const s = soloStats(db, ids.ann);
  assert.deepEqual(s.bySize[4].easy, { games: 3, wins: 2, points: 36 });
  assert.deepEqual(s.bySize[4].medium, { games: 1, wins: 0, points: -40 });
  assert.deepEqual(s.bySize[4].hard, { games: 1, wins: 1, points: 55 });
  assert.deepEqual(s.bySize[4].all, { games: 5, wins: 3, points: 51 }, 'the four-player subtotal');
  assert.deepEqual(s.bySize[3].easy, { games: 2, wins: 1, points: 11 });
  assert.deepEqual(s.bySize[3].medium, { games: 0, wins: 0, points: 0 }, 'no games is a row of zeros');
  assert.deepEqual(s.bySize[3].hard, { games: 1, wins: 0, points: -16 });
  assert.deepEqual(s.bySize[3].all, { games: 3, wins: 1, points: -5 }, 'the three-player subtotal');
  assert.deepEqual(s.byLevel.easy, { games: 5, wins: 3, points: 47 }, 'a level over both table sizes');
  assert.deepEqual(s.byLevel.medium, { games: 1, wins: 0, points: -40 });
  assert.deepEqual(s.byLevel.hard, { games: 2, wins: 1, points: 39 });
  assert.deepEqual(s.overall, { games: 8, wins: 4, points: 46 });
  // The subtotals and the overall row agree with each other, however the games fall.
  assert.equal(s.bySize[4].all.games + s.bySize[3].all.games, s.overall.games);
  assert.equal(s.byLevel.easy.points + s.byLevel.medium.points + s.byLevel.hard.points, s.overall.points);
  // Nobody with no games has anything.
  const { db: empty, ids: e } = await dbWith(['zed']);
  assert.deepEqual(soloStats(empty, e.zed).overall, { games: 0, wins: 0, points: 0 });
});

test('a retried report counts once; the same id from two people is two games', async () => {
  const { db, ids } = await dbWith(['ann', 'bea']);
  const r = result('medium', 4, 25);
  assert.equal(recordSolo(db, ids.ann, r), true);
  assert.equal(recordSolo(db, ids.ann, r), false, 'the retry is recognised');
  assert.equal(recordSolo(db, ids.ann, { ...r, delta: 99 }), false, 'and cannot rewrite the game');
  assert.equal(soloStats(db, ids.ann).overall.games, 1);
  assert.equal(soloStats(db, ids.ann).overall.points, 25);
  assert.equal(recordSolo(db, ids.bea, r), true, 'ids are per person');
  assert.equal(soloStats(db, ids.bea).overall.games, 1);
});

test('only results a round could produce are accepted', async () => {
  const { db, ids } = await dbWith(['ann']);
  const ok = result('easy', 4, 10);
  const bad = (change, why) =>
    assert.throws(
      () => recordSolo(db, ids.ann, { ...ok, clientId: `bad-${why}-id`, ...change }),
      (e) => e instanceof SoloError && e.status === 400,
      why,
    );
  bad({ clientId: 'short' }, 'id too short');
  bad({ clientId: 'has spaces in it' }, 'id with spaces');
  bad({ clientId: 5 }, 'id not text');
  bad({ level: 'impossible' }, 'unknown level');
  bad({ level: undefined }, 'no level');
  bad({ players: 5 }, 'five players');
  bad({ players: '4' }, 'players as text');
  bad({ won: 'yes' }, 'won as text');
  bad({ delta: 0 }, 'a round always moves points');
  bad({ delta: 1.5 }, 'fractions');
  bad({ delta: MAX_DELTA + 1 }, 'more than a round can move');
  bad({ delta: -(MAX_DELTA + 1), won: false }, 'more than a round can move, a loss');
  bad({ won: false }, 'a win that lost points: sign and result disagree');
  bad({ delta: -10 }, 'a loss that gained points');
  assert.throws(() => recordSolo(db, ids.ann, null), SoloError);
  assert.equal(soloStats(db, ids.ann).overall.games, 0, 'nothing bad was kept');
  assert.equal(recordSolo(db, ids.ann, { ...ok, delta: MAX_DELTA }), true, 'the largest possible win is fine');
});

test('the limit really is the most a round can move (checked against the scoring rules)', () => {
  // The biggest payment: a loser holding the most cards in a doubled round (a straight flush or five of a kind).
  let most = 0;
  for (const players of [3, 4]) {
    const game = newGame(mulberry32(1), null, players);
    const cards = players === 4 ? 13 : 20;
    const hands = game.hands.map((h, i) => (i === 0 ? [] : game.hands[i].concat(game.hands[0]).slice(0, cards)));
    const trick = { cls: { type: FIVE, cat: STRAIGHT_FLUSH } }; // a straight flush: the multiplier is 2
    const r = scoreRound({ winner: 0, hands, trick });
    assert.equal(r.multiplier, 2);
    most = Math.max(most, r.delta[0]);
  }
  assert.ok(most <= MAX_DELTA, `a round can move ${most}, the limit is ${MAX_DELTA}`);
  assert.ok(most >= MAX_DELTA - 10, 'and the limit is not wildly above it');
});

test("API: sign-in required; each person sees only their own table; admins see no one else's", async () => {
  const ctx = await boot();
  try {
    const anon = new Client(ctx.base);
    assert.equal((await anon.req('GET', '/api/solo/stats')).status, 401);
    assert.equal((await anon.req('POST', '/api/solo/result', result('easy', 4, 10))).status, 401);

    const ann = await makeUser(ctx, 'ann1');
    const bea = await makeUser(ctx, 'bea1');
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    assert.equal((await ann.req('GET', '/api/solo/stats')).json.overall.games, 0);
    const r1 = result('hard', 4, 48);
    const first = await ann.req('POST', '/api/solo/result', r1);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.deepEqual(first.json.bySize[4].hard, { games: 1, wins: 1, points: 48 }, 'the reply is the new table');
    assert.equal((await ann.req('POST', '/api/solo/result', r1)).json.overall.games, 1, 'a retry changes nothing');
    await ann.req('POST', '/api/solo/result', result('easy', 3, -12));

    assert.equal((await ann.req('GET', '/api/solo/stats')).json.overall.games, 2);
    assert.equal((await bea.req('GET', '/api/solo/stats')).json.overall.games, 0, "bea cannot see ann's games");
    assert.equal((await admin.req('GET', '/api/solo/stats')).json.overall.games, 0, "nor can an admin see ann's");
    // There is no way to ask for someone else's: the person is the signed-in session, whatever is sent.
    const sneaky = await bea.req('GET', `/api/solo/stats?user=${ann.user.id}&userId=${ann.user.id}`);
    assert.equal(sneaky.json.overall.games, 0);
    const forged = await bea.req('POST', '/api/solo/result', { ...result('easy', 4, 5), userId: ann.user.id });
    assert.equal(forged.status, 200);
    assert.equal((await ann.req('GET', '/api/solo/stats')).json.overall.games, 2, 'a forged userId is ignored');
    assert.equal((await bea.req('GET', '/api/solo/stats')).json.overall.games, 1);
    for (const [m, p] of [
      ['GET', '/api/admin/solo'],
      ['GET', `/api/admin/users/${ann.user.id}/solo`],
    ]) {
      assert.equal((await admin.req(m, p)).status, 404, `${p} does not exist`);
    }
    // Bad reports are refused with a message, and the leaderboards never include solo games.
    assert.equal((await ann.req('POST', '/api/solo/result', { ...result('easy', 4, 10), won: false })).status, 400);
    assert.deepEqual((await ann.req('GET', '/api/leaderboard')).json.rows, []);
    assert.equal(
      ctx.app.db.prepare('SELECT COUNT(*) AS n FROM games').get().n,
      0,
      'solo rounds are not games on the server',
    );
  } finally {
    await ctx.app.close();
  }
});

test('deleting an account takes its solo rounds with it', async () => {
  const { db, ids } = await dbWith(['ann']);
  recordSolo(db, ids.ann, result('easy', 4, 10));
  db.prepare('DELETE FROM users WHERE id = ?').run(ids.ann);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM solo_games').get().n, 0);
});

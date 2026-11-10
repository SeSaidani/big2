// Every game is dealt to a fresh random seating of the same people, so nobody always sits next to the same player. The
// shuffle is uniform, the seats do not move during a game or while its result is up, a restored table keeps its seating,
// the scores go to the people who earned them whatever seat they were in, and the cards dealt do not depend on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/cards.js';
import { shuffleSeats } from '../server/seating.js';
import { Table } from '../server/table.js';
import { plainName, seatNames } from '../src/online-view.js';
import { boot, seasonPlayers, until } from './support.js';

test('the shuffle gives back the same seats in some order, and leaves the original alone', () => {
  const seats = ['a', 'b', 'c', 'd'];
  const rng = mulberry32(1);
  for (let i = 0; i < 100; i++) {
    const out = shuffleSeats(seats, rng);
    assert.deepEqual([...out].sort(), seats);
  }
  assert.deepEqual(seats, ['a', 'b', 'c', 'd']);
  assert.deepEqual(shuffleSeats([], rng), []);
  assert.deepEqual(shuffleSeats(['only'], rng), ['only']);
});

test('the same random numbers give the same seating', () => {
  assert.deepEqual(shuffleSeats([1, 2, 3, 4], mulberry32(7)), shuffleSeats([1, 2, 3, 4], mulberry32(7)));
});

test('every one of the 24 orders of four people comes up about equally often', () => {
  const rng = mulberry32(12345);
  const counts = new Map();
  const N = 24000;
  for (let i = 0; i < N; i++) {
    const k = shuffleSeats([0, 1, 2, 3], rng).join('');
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  assert.equal(counts.size, 24, 'all 24 orders are reachable');
  // 1000 expected each, standard deviation about 31: these bounds are about 6 sigma either way
  for (const [order, n] of counts) assert.ok(n > 810 && n < 1190, `${order} came up ${n} times of ${N}`);
});

test('at a table of three there are six orders, all reachable', () => {
  const rng = mulberry32(5);
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(shuffleSeats([0, 1, 2], rng).join(''));
  assert.equal(seen.size, 6);
});

test('a name drops its "(offline)" mark for the log, and seat labels keep it', () => {
  assert.equal(plainName('joe (offline)'), 'joe');
  assert.equal(plainName('joe'), 'joe');
  const t = {
    you: 0,
    spectator: false,
    seats: [{ name: 'me' }, { name: 'joe', online: false }, { name: 'amy', online: true }, { name: 'bo' }],
  };
  assert.deepEqual(seatNames(t), ['You', 'joe (offline)', 'amy', 'bo']);
  assert.deepEqual(seatNames(t).map(plainName), ['You', 'joe', 'amy', 'bo']);
});

// ---- at the table ----

const names4 = ['pam', 'quin', 'ros', 'sam'];
const tableOf = (ctx) => ctx.app.lobby.table;
const order = (ctx) => tableOf(ctx).seats.map((s) => s.name);
const fast = { startDelayMs: 100, nextGameDelayMs: 400, clockMs: 20 };

// Rigs the game in progress so that seat 0 goes out with its last card and the other seats hold 2, 4 and 8 cards, then
// plays that card.
function finishWith(ctx) {
  const t = tableOf(ctx);
  const g = t.game;
  let next = 0;
  g.hands = [[50], ...[2, 4, 8].map((n) => Array.from({ length: n }, () => next++))];
  const inHands = new Set(g.hands.flat());
  g.played = Array.from({ length: 56 }, (_, c) => c).filter((c) => !inHands.has(c));
  Object.assign(g, { turn: 0, trick: null, first: false, leadPasses: 0, passed: g.hands.map(() => false) });
  t.move(t.seats[0].userId, [50]);
  assert.equal(t.status, 'done');
}

test('the seats change between games, never during one or while the result is up', async () => {
  const ctx = await boot({ ...fast, shuffleSeating: true, seatRng: mulberry32(3), rng: mulberry32(8) });
  try {
    await seasonPlayers(ctx, names4);
    await until(() => tableOf(ctx).status === 'playing', 3000, 'a game in progress');
    const orders = [order(ctx)];
    assert.deepEqual([...orders[0]].sort(), names4, 'the same four people');
    for (let game = 0; game < 4; game++) {
      const before = order(ctx);
      finishWith(ctx);
      assert.deepEqual(order(ctx), before, 'the seats do not move while the result is on screen');
      const startedAt = tableOf(ctx).startedAt;
      await until(
        () => tableOf(ctx).status === 'playing' && tableOf(ctx).startedAt !== startedAt,
        4000,
        'the next game',
      );
      assert.deepEqual([...order(ctx)].sort(), names4);
      orders.push(order(ctx));
    }
    assert.ok(new Set(orders.map((o) => o.join())).size > 1, `five games, but only one seating: ${orders[0]}`);
  } finally {
    await ctx.app.close();
  }
});

test('the points go to the people who earned them, in whatever seat they were dealt', async () => {
  const ctx = await boot({ ...fast, shuffleSeating: true, seatRng: mulberry32(11), rng: mulberry32(8) });
  try {
    await seasonPlayers(ctx, names4);
    await until(() => tableOf(ctx).status === 'playing', 3000, 'a game in progress');
    const t = tableOf(ctx);
    const seats = t.seats.map((s) => ({ id: s.userId, name: s.name }));
    finishWith(ctx);
    const rows = ctx.app.db.prepare('SELECT seat, user_id, delta FROM results ORDER BY seat').all();
    assert.equal(rows.length, 4);
    rows.forEach((r) => assert.equal(r.user_id, seats[r.seat].id, `seat ${r.seat} is paid to who sat there`));
    // seat 0 went out; the others held 2, 4 and 8 cards (the 8 at double rate): seat 0 collects 2 + 4 + 16
    assert.deepEqual(
      rows.map((r) => r.delta),
      [22, -2, -4, -16],
    );
    assert.equal(t.result.winner, 0);
  } finally {
    await ctx.app.close();
  }
});

test('a table restored after a restart keeps the seating its game started with', async () => {
  const ctx = await boot({ ...fast, shuffleSeating: true, seatRng: mulberry32(2), rng: mulberry32(8) });
  try {
    await seasonPlayers(ctx, names4);
    await until(() => tableOf(ctx).status === 'playing', 3000, 'a game in progress');
    const t = tableOf(ctx);
    const back = Table.restore(JSON.parse(JSON.stringify(t.serialize())), ctx.app.lobby.tableDeps);
    assert.deepEqual(
      back.seats.map((s) => s.name),
      order(ctx),
    );
    assert.deepEqual(back.game.hands, t.game.hands);
  } finally {
    await ctx.app.close();
  }
});

test('shuffling the seats does not change which cards are dealt', async () => {
  const hands = async (shuffleSeating) => {
    const ctx = await boot({ ...fast, shuffleSeating, seatRng: mulberry32(2), rng: mulberry32(8) });
    try {
      await seasonPlayers(ctx, names4);
      await until(() => tableOf(ctx).status === 'playing', 3000, 'a game in progress');
      return tableOf(ctx).game.hands;
    } finally {
      await ctx.app.close();
    }
  };
  assert.deepEqual(await hands(true), await hands(false));
});

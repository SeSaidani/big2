// Rotation: with more people in the season than seats, whoever scored lowest in a game (the loser who paid the most)
// goes out when the next one starts, to the back of the line, and the next in line takes the seat. Ties go to whoever
// has been seated longest. Leaving the results counts as the lowest score, so it is that game's one swap. With only
// four players nobody rotates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mulberry32 } from '../src/cards.js';
import { seasonMembers } from '../server/roster.js';
import { boot, seasonPlayers, until } from './support.js';

const fast = { startDelayMs: 100, nextGameDelayMs: 400, clockMs: 20 };
const tableOf = (ctx) => ctx.app.lobby.table;
const names4 = ['pam', 'quin', 'ros', 'sam'];
const seated = (ctx) => tableOf(ctx).seats.map((s) => s.name);
const line = (ctx) => seasonMembers(ctx.app.db, 1).map((m) => m.name);

// Rigs the game in progress so that seat 0 goes out with its last card and every other seat is left holding the
// given number of cards, then plays that card. Every card is still accounted for, so the game's own checks pass.
async function finishWith(ctx, people, leftOver) {
  await until(() => tableOf(ctx).status === 'playing', 3000, 'a game in progress');
  const t = tableOf(ctx);
  const g = t.game;
  const out = 50;
  let next = 0;
  g.hands = [[out]];
  for (const n of leftOver) {
    g.hands.push(Array.from({ length: n }, () => next++));
  }
  const inHands = new Set([out, ...g.hands.flat()]);
  g.played = Array.from({ length: 56 }, (_, c) => c).filter((c) => !inHands.has(c));
  Object.assign(g, { turn: 0, trick: null, first: false, leadPasses: 0, passed: g.hands.map(() => false) });
  t.move(people[0].user.id, [out]);
  assert.equal(t.status, 'done');
  return t.result;
}

test('five players: the lowest score of the game goes out when the next starts, the winner and the rest stay', async () => {
  const ctx = await boot({ ...fast, rng: mulberry32(3) });
  try {
    const people = await seasonPlayers(ctx, [...names4, 'tomx']);
    // pam wins; quin holds 2 cards (-2), ros 4 (-4), sam 8 cards at rate 2 (-16): sam scored lowest.
    const result = await finishWith(ctx, people, [2, 4, 8]);
    assert.deepEqual(result.delta, [22, -2, -4, -16]);
    assert.deepEqual(
      result.rotation,
      { out: 'sam', in: 'tomx', why: 'lowest' },
      'the result says who goes out and who comes in',
    );
    assert.deepEqual(seated(ctx), names4, 'the seats do not change while the result is on screen');
    await until(() => tableOf(ctx).status === 'playing', 4000, 'the next game');
    assert.deepEqual(seated(ctx), ['pam', 'quin', 'ros', 'tomx'], 'tomx has sam’s seat; everyone else stays put');
    assert.deepEqual(line(ctx), ['pam', 'quin', 'ros', 'tomx', 'sam'], 'sam is at the back of the line');
    assert.equal(tableOf(ctx).result, null);
  } finally {
    await ctx.app.close();
  }
});

test('with exactly four players nobody rotates, however badly they lose', async () => {
  const ctx = await boot({ ...fast, rng: mulberry32(3) });
  try {
    const people = await seasonPlayers(ctx, names4);
    const result = await finishWith(ctx, people, [2, 4, 8]);
    assert.equal(result.rotation, null);
    await until(() => tableOf(ctx).status === 'playing', 4000, 'the next game');
    assert.deepEqual(seated(ctx), names4);
    assert.deepEqual(line(ctx), names4);
  } finally {
    await ctx.app.close();
  }
});

test('a tie for lowest goes to whoever has been seated longest', async () => {
  for (const [earlier, later, goes] of [
    [1, 2, 'quin'],
    [2, 1, 'ros'],
  ]) {
    const ctx = await boot({ ...fast, rng: mulberry32(3) });
    try {
      const people = await seasonPlayers(ctx, [...names4, 'tomx']);
      await until(() => tableOf(ctx).status === 'playing', 3000, 'a game in progress');
      const t = tableOf(ctx);
      for (const i of [0, 3]) t.seats[i].since = 1000; // pam and sam sat down later than the other two
      t.seats[earlier].since = 100;
      t.seats[later].since = 500;
      // quin and ros both hold 4 cards (-4 each); sam holds 2 (-2).
      const result = await finishWith(ctx, people, [4, 4, 2]);
      assert.deepEqual(result.delta, [10, -4, -4, -2]);
      assert.equal(result.rotation.out, goes);
      await until(() => tableOf(ctx).status === 'playing', 4000, 'the next game');
      assert.ok(!seated(ctx).includes(goes));
      assert.ok(seated(ctx).includes('tomx'));
    } finally {
      await ctx.app.close();
    }
  }
});

test('a tie that seating time cannot break is settled at random, between the tied players only', async () => {
  const out = new Set();
  for (let seed = 1; seed <= 12; seed++) {
    const ctx = await boot({ ...fast, rng: mulberry32(seed) });
    try {
      const people = await seasonPlayers(ctx, [...names4, 'tomx']);
      await until(() => tableOf(ctx).status === 'playing', 3000, 'a game in progress');
      for (const s of tableOf(ctx).seats) s.since = 100;
      const result = await finishWith(ctx, people, [4, 4, 2]);
      assert.ok(['quin', 'ros'].includes(result.rotation.out), result.rotation.out);
      out.add(result.rotation.out);
    } finally {
      await ctx.app.close();
    }
  }
  assert.equal(out.size, 2, 'across seeds both tied players are sometimes the one to go');
});

test('leaving the results counts as the lowest score: it is the game’s one swap and the lowest scorer stays', async () => {
  const ctx = await boot({ ...fast, nextGameDelayMs: 900, rng: mulberry32(3) });
  try {
    const people = await seasonPlayers(ctx, [...names4, 'tomx']);
    const result = await finishWith(ctx, people, [2, 4, 8]); // sam scored lowest
    assert.equal(result.rotation.out, 'sam');
    assert.equal((await people[1].req('POST', '/api/game/leave')).status, 200); // quin leaves the results
    assert.deepEqual(tableOf(ctx).result.rotation, { out: 'quin', in: 'tomx', why: 'left' });
    await until(() => tableOf(ctx).status === 'playing', 4000, 'the next game');
    assert.deepEqual(seated(ctx), ['pam', 'tomx', 'ros', 'sam'], 'quin is out and sam, though lowest, stays');
    assert.deepEqual(line(ctx), ['pam', 'ros', 'sam', 'tomx', 'quin']);
  } finally {
    await ctx.app.close();
  }
});

test('rotation survives several games: the player who came in plays and can be rotated out in turn', async () => {
  const ctx = await boot({ ...fast, rng: mulberry32(3) });
  try {
    const people = await seasonPlayers(ctx, [...names4, 'tomx']);
    await finishWith(ctx, people, [2, 4, 8]); // sam out, tomx in
    await until(() => tableOf(ctx).status === 'playing', 4000, 'game two');
    // Now tomx (seat 3) is the lowest; the line is pam, quin, ros, tomx, sam so sam comes back in.
    const second = await finishWith(ctx, people, [2, 4, 8]);
    assert.deepEqual(second.rotation, { out: 'tomx', in: 'sam', why: 'lowest' });
    await until(() => tableOf(ctx).status === 'playing', 4000, 'game three');
    assert.deepEqual(seated(ctx), ['pam', 'quin', 'ros', 'sam']);
    assert.deepEqual(line(ctx), ['pam', 'quin', 'ros', 'sam', 'tomx']);
  } finally {
    await ctx.app.close();
  }
});

test('a restart between the result and the next game still rotates the right person out', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'big2-rotation-'));
  const dbFile = path.join(dir, 'x.db');
  let ctx = await boot({ ...fast, nextGameDelayMs: 1500, rng: mulberry32(3), dbFile });
  try {
    const people = await seasonPlayers(ctx, [...names4, 'tomx']);
    await finishWith(ctx, people, [2, 4, 8]); // sam scored lowest
    await ctx.app.close(); // a restart while the result is on screen
    ctx = await boot({ ...fast, nextGameDelayMs: 1500, rng: mulberry32(3), dbFile });
    assert.equal(tableOf(ctx).status, 'done', 'the finished game was restored');
    assert.deepEqual(tableOf(ctx).result.rotation, { out: 'sam', in: 'tomx', why: 'lowest' });
    assert.deepEqual(seated(ctx), names4);
    await until(() => tableOf(ctx).status === 'playing', 5000, 'the next game after the restart');
    assert.deepEqual(seated(ctx), ['pam', 'quin', 'ros', 'tomx']);
    assert.deepEqual(line(ctx), ['pam', 'quin', 'ros', 'tomx', 'sam']);
  } finally {
    await ctx.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

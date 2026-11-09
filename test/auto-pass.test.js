// A player who holds nothing that can beat the play on the table is passed automatically (after a short pause), as an
// ordinary pass that shows in the log. One who can beat it is left to decide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, cardId } from '../src/cards.js';
import { classify } from '../src/hands.js';
import { mustPass } from '../src/game.js';
import { loadGameEvents } from '../server/db.js';
import { boot, seasonPlayers, until, sleep } from './support.js';

// A game state at seat 0's turn, with the given hands and play on the table.
const state = (hands, trick, extra = {}) => ({
  hands,
  turn: 0,
  trick: trick ? { cards: trick, cls: classify(trick), by: 1 } : null,
  passed: hands.map(() => false),
  leadPasses: 0,
  first: false,
  winner: -1,
  played: [],
  history: [],
  ...extra,
});
const others = [new Array(5).fill(0), new Array(5).fill(0), new Array(5).fill(0)];
const c = (rank, suit) => cardId(rank, suit);
const pairOf3 = [c(0, 0), c(0, 1)];

test('mustPass: a hand with no pair cannot beat a pair', () => {
  const hand = [c(2, 0), c(4, 1), c(7, 2)];
  assert.equal(mustPass(state([hand, ...others], pairOf3)), true);
});

test('mustPass: a hand with a higher pair can, so it is left to decide', () => {
  const hand = [c(2, 0), c(4, 1), c(4, 2)];
  assert.equal(mustPass(state([hand, ...others], pairOf3)), false);
});

test('mustPass: not enough cards for a five-card hand', () => {
  const five = [0, 1, 2, 3, 4].map((r) => c(r, 0)); // a straight flush, 3 to 7
  assert.equal(classify(five).type, 'five');
  assert.equal(mustPass(state([[c(8, 0), c(9, 0), c(10, 0)], ...others], five)), true, 'three cards');
  assert.equal(mustPass(state([[c(8, 0), c(9, 0), c(10, 0), c(11, 0)], ...others], five)), true, 'four cards');
});

test('mustPass: a higher single beats a single, a lower one does not', () => {
  const trick = [c(5, 0)];
  assert.equal(mustPass(state([[c(9, 0), c(1, 0)], ...others], trick)), false);
  assert.equal(mustPass(state([[c(1, 0), c(2, 0)], ...others], trick)), true);
});

test('mustPass: with the next player down to one card, the highest single still counts as a play', () => {
  const trick = [c(3, 0)];
  const next = [[c(0, 0)], new Array(5).fill(0), new Array(5).fill(0)]; // seat 1 holds one card
  assert.equal(mustPass(state([[c(5, 0), c(9, 0)], ...next], trick)), false, 'the highest single beats it');
  assert.equal(mustPass(state([[c(1, 0), c(2, 0)], ...next], trick)), true, 'nothing beats it');
});

test('mustPass: never for a lead, the opening play or a finished game', () => {
  const weak = [c(1, 0), c(2, 0)];
  assert.equal(mustPass(state([weak, ...others], null)), false, 'the lead can always play');
  assert.equal(mustPass(state([weak, ...others], null, { first: true })), false, 'the opening play');
  assert.equal(mustPass(state([weak, ...others], pairOf3, { winner: 2 })), false, 'a finished game');
});

// ---- at the table ----

async function started() {
  const ctx = await boot({
    startDelayMs: 100,
    nextGameDelayMs: 600000,
    clockMs: 20,
    autoPassMs: 60,
    rng: mulberry32(5),
  });
  const people = await seasonPlayers(ctx, ['pam', 'quin', 'ros', 'sam']);
  await until(() => ctx.app.lobby.table?.status === 'playing', 3000, 'a game in progress');
  return { ctx, people };
}

// Seat 0 leads a pair of 5s. Seat 1 holds no pair, seat 2 holds a higher pair, seat 3 holds no pair.
function rig(t) {
  const g = t.game;
  g.hands = [
    [c(2, 0), c(2, 1), c(8, 0)],
    [c(0, 0), c(1, 1), c(3, 2)],
    [c(10, 0), c(10, 1), c(4, 0)],
    [c(6, 3), c(7, 2), c(9, 1)],
  ];
  const inHands = new Set(g.hands.flat());
  g.played = Array.from({ length: 56 }, (_, i) => i).filter((i) => !inHands.has(i));
  Object.assign(g, { turn: 0, trick: null, first: false, leadPasses: 0, history: [] });
  g.passed = g.hands.map(() => false);
}

test('at the table a person with nothing to beat the play is passed, and it is an ordinary pass in the log', async () => {
  const { ctx, people } = await started();
  try {
    const t = ctx.app.lobby.table;
    rig(t);
    const lead = people.find((p) => p.user.id === t.seats[0].userId);
    t.move(lead.user.id, [c(2, 0), c(2, 1)]);
    assert.equal(t.game.turn, 1, 'seat 2 could beat it, so the play did not close the trick');
    await until(() => t.game.history.length >= 2, 3000, 'the automatic pass');
    const [play, pass] = t.game.history;
    assert.deepEqual([play.p, pass.p], [0, 1]);
    assert.equal(pass.cards, null);
    assert.equal(pass.auto, undefined, 'recorded as an ordinary pass, not as a seat that could not beat the play');
    assert.ok(t.game.passed[1]);
    assert.equal(t.game.turn, 2, 'and the turn moved on to the person who can beat it');
    const diary = loadGameEvents(ctx.app.db, `${t.id}-${t.startedAt}`).filter((e) => e.kind === 'move');
    assert.equal(diary[1].data.why, 'nothing to beat it with', 'the diary says the table did it');
  } finally {
    await ctx.app.close();
  }
});

test('a person who can beat the play is left to decide, however long they take', async () => {
  const { ctx, people } = await started();
  try {
    const t = ctx.app.lobby.table;
    rig(t);
    const lead = people.find((p) => p.user.id === t.seats[0].userId);
    t.move(lead.user.id, [c(2, 0), c(2, 1)]);
    await until(() => t.game.turn === 2, 3000, 'the turn reaching the person who can beat it');
    await sleep(400); // many times the pause
    assert.equal(t.game.turn, 2);
    assert.equal(t.game.history.length, 2, 'nothing was done for them');
    assert.ok(!t.game.passed[2]);
  } finally {
    await ctx.app.close();
  }
});

test('passing by hand before the pause ends is fine and is not done twice', async () => {
  const { ctx, people } = await started();
  try {
    const t = ctx.app.lobby.table;
    rig(t);
    const lead = people.find((p) => p.user.id === t.seats[0].userId);
    t.move(lead.user.id, [c(2, 0), c(2, 1)]);
    const seat1 = people.find((p) => p.user.id === t.seats[1].userId);
    t.move(seat1.user.id, null);
    await sleep(300);
    assert.equal(t.game.history.length, 2, 'one pass for seat 1, not two');
    assert.equal(t.game.turn, 2);
  } finally {
    await ctx.app.close();
  }
});

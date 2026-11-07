// A real card always beats a joker standing for the same thing. A joker hand is
// ranked as the hand its jokers represent; against a real hand of that exact
// strength the real one wins, in every hand type (singles included: nothing
// beats the real 2♠, and a lone joker is a 2♠ that loses to it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, cardId, suitOf, FIRST_JOKER, DECK_SIZE } from '../src/cards.js';
import { classify, baseKey, beats, SINGLE } from '../src/hands.js';
import { newGame, legalMoves, validatePlay } from '../src/game.js';
import { greedyMove } from '../src/ai/greedy.js';
import { buildContext, strength } from '../src/ai/heuristic.js';

const TWO_SPADES = cardId(12, 3);
const TWO_HEARTS = cardId(12, 2);
const JOKER = FIRST_JOKER;

test('no single beats the real 2♠, and a lone joker does not', () => {
  const twoSpades = classify([TWO_SPADES]);
  for (let c = 0; c < TWO_SPADES; c++) assert.ok(!beats(classify([c]), twoSpades), `card ${c}`);
  for (let j = FIRST_JOKER; j < DECK_SIZE; j++) assert.ok(!beats(classify([j]), twoSpades), `joker ${j}`);
  assert.ok(beats(twoSpades, classify([JOKER])));
});

test('a lone joker still beats everything below the 2♠, and jokers tie', () => {
  const joker = classify([JOKER]);
  for (let c = 0; c < TWO_SPADES; c++) assert.ok(beats(joker, classify([c])), `card ${c}`);
  assert.ok(beats(joker, classify([TWO_HEARTS])));
  assert.ok(!beats(joker, classify([JOKER + 1])));
  assert.ok(!beats(classify([JOKER + 1]), joker));
});

// For every real hand R, put a joker (or several) in place of some of its cards.
// If the result is the same type and exactly as strong as R, R must win.
function checkRealWins(real, jokerCount, rng, stats) {
  const idx = [...real.keys()];
  for (let i = idx.length - 1; i > 0; i--) {
    const k = Math.floor(rng() * (i + 1));
    [idx[i], idx[k]] = [idx[k], idx[i]];
  }
  const swapped = new Set(idx.slice(0, jokerCount));
  let next = FIRST_JOKER;
  const withJokers = real.map((c, i) => (swapped.has(i) ? next++ : c));
  const r = classify(real);
  const j = classify(withJokers);
  if (!r || !j || r.type !== j.type || baseKey(r) !== baseKey(j)) return;
  // A pair is decided by its higher card, and there is only one real spade of each rank. If the joker hand still holds
  // the real spade, the real hand holds the very same card, so the two can never be on the table together.
  if (r.type === 'pair' && withJokers.some((c) => c < FIRST_JOKER && suitOf(c) === 3)) return;
  stats[r.type] = (stats[r.type] || 0) + 1;
  assert.ok(beats(r, j), `real ${real} should beat ${withJokers}`);
  assert.ok(!beats(j, r), `${withJokers} must not beat real ${real}`);
}

test('in every hand type a real hand beats the equal hand made with jokers', () => {
  const rng = mulberry32(2026);
  const stats = {};
  const draw = (n) => {
    const out = new Set();
    while (out.size < n) out.add(Math.floor(rng() * 52));
    return [...out];
  };
  for (let t = 0; t < 60000; t++) {
    const n = [1, 2, 3, 5][t % 4];
    const real = draw(n);
    if (!classify(real)) continue;
    checkRealWins(real, 1 + Math.floor(rng() * Math.min(n, 4)), rng, stats);
  }
  // The property must actually have been exercised for each type.
  for (const type of ['single', 'pair', 'triple', 'five']) {
    assert.ok((stats[type] || 0) > 20, `${type}: only ${stats[type] || 0} equal-strength cases`);
  }
});

test('the game never lets a joker be played onto the real 2♠', () => {
  const s = newGame(
    () => 0,
    [
      [0, 1],
      [2, JOKER],
      [3, 4],
      [5, 6],
    ],
  );
  s.first = false;
  s.turn = 1;
  s.trick = { cards: [TWO_SPADES], cls: classify([TWO_SPADES]), by: 0 };
  assert.match(validatePlay(s, [JOKER]), /does not beat/);
  assert.equal(legalMoves(s).length, 0);
  // But the joker does beat the 2♥.
  s.trick = { cards: [TWO_HEARTS], cls: classify([TWO_HEARTS]), by: 0 };
  assert.equal(validatePlay(s, [JOKER]), null);
});

test('last-card rule: the highest single is the real 2♠, ahead of any joker', () => {
  const s = newGame(() => 0, [[3, 9, TWO_SPADES, JOKER], [1], [14, 15], [16, 17]]);
  s.first = false;
  s.turn = 0;
  assert.equal(validatePlay(s, [TWO_SPADES]), null);
  assert.match(validatePlay(s, [JOKER]), /2♠/);
  assert.match(validatePlay(s, [9]), /2♠/);
});

test('greedy never plays a joker onto the real 2♠', () => {
  const state = {
    hands: [[JOKER], [5, 6], [7, 8], [9, 10]],
    turn: 0,
    trick: { cards: [TWO_SPADES], cls: classify([TWO_SPADES]), by: 1 },
    first: false,
  };
  for (let i = 0; i < 50; i++) assert.equal(greedyMove(state, mulberry32(i)), null);
});

test('the heuristic knows a joker single is beatable while the 2♠ is unseen', () => {
  const lone = classify([JOKER]);
  assert.equal(lone.type, SINGLE);
  const hand = [JOKER];
  const open = strength(lone, buildContext({ me: 0, hand, played: [], counts: [1, 14, 14, 14] }));
  assert.equal(open.ctl, false, 'the real 2♠ is still out there');
  const gone = strength(lone, buildContext({ me: 0, hand, played: [TWO_SPADES], counts: [1, 14, 14, 14] }));
  assert.equal(gone.ctl, true, 'with the 2♠ played, only tying jokers remain: nothing can beat it');
});

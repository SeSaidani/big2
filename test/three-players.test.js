import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRAIGHT_FLUSH, FIVE } from '../src/hands.js';
import { mulberry32, dealHands, THREE_OF_DIAMONDS, SPADE_TWO, DECK_SIZE } from '../src/cards.js';
import { newGame, applyMove, legalMoves, validatePlay, checkInvariants, observe, viewRules } from '../src/game.js';
import { rateFor, scoreRound } from '../src/scoring.js';
import { chooseMove } from '../src/ai/agents.js';

test('a table of three: 18 cards each, the two spares go to the 3♦ and 2♠ holders', () => {
  let both = 0;
  for (let seed = 1; seed <= 2000; seed++) {
    const hands = dealHands(mulberry32(seed), 3);
    assert.equal(hands.length, 3);
    const all = hands.flat();
    assert.equal(all.length, DECK_SIZE);
    assert.equal(new Set(all).size, DECK_SIZE);
    const i3 = hands.findIndex((h) => h.includes(THREE_OF_DIAMONDS));
    const i2 = hands.findIndex((h) => h.includes(SPADE_TWO));
    const sizes = hands.map((h) => h.length);
    if (i3 === i2) {
      both++;
      assert.equal(sizes[i3], 20);
      assert.equal(sizes.filter((n) => n === 18).length, 2);
    } else {
      assert.equal(sizes[i3], 19);
      assert.equal(sizes[i2], 19);
      assert.equal(sizes.filter((n) => n === 18).length, 1);
    }
    for (const h of hands) {
      assert.deepEqual(
        h,
        [...h].sort((a, b) => a - b),
      );
    }
  }
  // P(one player holds both) is about 1/3; it must actually happen.
  assert.ok(both > 400 && both < 900, `both-holder frequency ${both}/2000`);
});

test('four-player dealing is unchanged and other table sizes are refused', () => {
  const h = dealHands(mulberry32(3));
  assert.deepEqual(
    h.map((x) => x.length),
    [14, 14, 14, 14],
  );
  assert.deepEqual(dealHands(mulberry32(3), 4), h);
  for (const n of [0, 1, 2, 5]) assert.throws(() => dealHands(mulberry32(1), n), RangeError);
});

test('three-player rates change at the band edges', () => {
  const edges = [
    [1, 1],
    [9, 1],
    [10, 2],
    [13, 2],
    [14, 3],
    [17, 3],
    [18, 4],
    [20, 4],
  ];
  for (const [n, rate] of edges) assert.equal(rateFor(n, 3), rate, `${n} cards`);
  assert.throws(() => rateFor(21, 3), RangeError);
  assert.throws(() => rateFor(0, 3), RangeError);
  assert.throws(() => rateFor(5, 5), RangeError);
  // Four-player behaviour is unchanged.
  assert.equal(rateFor(7), 1);
  assert.equal(rateFor(8), 2);
  assert.throws(() => rateFor(15), RangeError);
});

test('scoreRound at a table of three is zero-sum and doubles for a bonus play', () => {
  const s = {
    winner: 1,
    hands: [new Array(10).fill(0), [], new Array(18).fill(0)],
    trick: null,
  };
  const r = scoreRound(s);
  assert.equal(r.delta.length, 3);
  assert.deepEqual(r.delta, [-20, 20 + 72, -72]);
  assert.equal(
    r.delta.reduce((a, b) => a + b, 0),
    0,
  );
  const bonus = scoreRound({ ...s, trick: { cls: { type: FIVE, cat: STRAIGHT_FLUSH } } });
  assert.deepEqual(bonus.delta, [-40, 40 + 144, -144]);
});

test('three players: the opening, lead passing and view rules use the real table size', () => {
  const s = newGame(mulberry32(5), null, 3);
  assert.equal(s.hands.length, 3);
  assert.deepEqual(s.passed, [false, false, false]);
  assert.ok(s.hands[s.turn].includes(THREE_OF_DIAMONDS));
  assert.match(validatePlay(s, null), /3♦/);
  assert.equal(viewRules(observe(s, s.turn)).canPass, false); // the opening cannot be passed
});

test('three players: random legal play always terminates, conserves the 56 cards and scores zero-sum', () => {
  for (let g = 0; g < 200; g++) {
    const rng = mulberry32(5000 + g);
    const s = newGame(rng, null, 3);
    let steps = 0;
    while (s.winner < 0) {
      const moves = legalMoves(s);
      if (s.trick !== null && (moves.length === 0 || rng() < 0.3)) applyMove(s, null);
      else {
        assert.ok(moves.length > 0, 'a leader always has a legal play');
        const m = moves[Math.floor(rng() * moves.length)];
        applyMove(s, m.cards, m.cls);
      }
      checkInvariants(s);
      assert.ok(++steps < 3000);
    }
    const r = scoreRound(s);
    assert.equal(
      r.delta.reduce((a, b) => a + b, 0),
      0,
    );
    assert.ok(r.delta[r.winner] > 0);
  }
});

test('the computer players finish games of three at every level that is cheap to test', () => {
  for (const level of ['easy', 'medium']) {
    for (let g = 0; g < 5; g++) {
      const s = newGame(mulberry32(77 + g), null, 3);
      let steps = 0;
      while (s.winner < 0) {
        const m = chooseMove(observe(s, s.turn), level);
        applyMove(s, m ? m.cards : null, m ? m.cls : null);
        checkInvariants(s);
        assert.ok(++steps < 3000, `${level} did not finish`);
      }
      assert.equal(s.hands[s.winner].length, 0);
    }
  }
});

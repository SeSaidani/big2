import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/cards.js';
import { classify } from '../src/hands.js';
import { newGame, applyMove, autoSkip, observe } from '../src/game.js';
import { chooseMove } from '../src/ai/agents.js';
import { rateFor, scoreRound, isBonusPlay, forfeitPenalty } from '../src/scoring.js';

const ids = (n) => Array.from({ length: n }, (_, i) => i);
const finished = (winner, lefts, play = [51]) => {
  const hands = lefts.map((n) => ids(n));
  hands[winner] = [];
  return { winner, hands, trick: { cards: play, cls: classify(play), by: winner } };
};

test('rate steps at 7/8, 10/11 and 13/14 cards', () => {
  const r = Array.from({ length: 14 }, (_, i) => rateFor(i + 1));
  assert.deepEqual(r, [1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4]);
});

test('rate rejects counts a loser cannot have', () => {
  for (const bad of [0, 15, -1, 2.5, NaN]) assert.throws(() => rateFor(bad), RangeError);
});

test('losers pay n·rate(n) and the winner collects it (zero-sum)', () => {
  // Seat 2 wins. Losers hold 3, 9 and 14 cards: 3·1 + 9·2 + 14·4 = 77.
  const r = scoreRound(finished(2, [3, 9, 0, 14]));
  assert.deepEqual(r.delta, [-3, -18, 77, -56]);
  assert.equal(
    r.delta.reduce((a, b) => a + b, 0),
    0,
  );
  assert.equal(r.multiplier, 1);
});

test('a straight flush or five of a kind going out doubles every payment', () => {
  const sf = [0 * 4 + 1, 1 * 4 + 1, 2 * 4 + 1, 3 * 4 + 1, 4 * 4 + 1]; // 3-7 of clubs
  assert.ok(isBonusPlay(classify(sf)));
  const r = scoreRound(finished(0, [0, 3, 9, 14], sf));
  assert.equal(r.multiplier, 2);
  assert.deepEqual(r.delta, [2 * (3 + 18 + 56), -6, -36, -112]);
  // A plain straight, a pair, or a single does not.
  assert.ok(!isBonusPlay(classify([0, 5, 8, 12, 16])));
  assert.ok(!isBonusPlay(classify([51])));
  assert.ok(!isBonusPlay(null));
});

test('scoring fails loudly on an unfinished round', () => {
  const s = newGame(mulberry32(1));
  assert.throws(() => scoreRound(s), /not finished/);
  const bad = finished(1, [3, 0, 3, 3]);
  bad.hands[1] = [5];
  assert.throws(() => scoreRound(bad), /still holds/);
});

test('real games always score zero-sum with the winner positive', () => {
  for (let g = 0; g < 30; g++) {
    const rng = mulberry32(8000 + g);
    const s = newGame(rng);
    while (s.winner < 0) {
      const m = chooseMove(observe(s, s.turn), 'easy', { rng });
      applyMove(s, m ? m.cards : null, m ? m.cls : null);
      if (m) autoSkip(s);
    }
    const r = scoreRound(s);
    assert.equal(
      r.delta.reduce((a, b) => a + b, 0),
      0,
    );
    assert.ok(r.delta[s.winner] > 0);
    r.delta.forEach((d, p) => p === s.winner || assert.ok(d < 0));
  }
});

test('walking out of a game costs the most a loser can pay in a round', () => {
  // 4 players: the most cards a loser holds is a whole hand of 14, at the top rate of 4.
  assert.equal(forfeitPenalty(4), 14 * rateFor(14, 4));
  assert.equal(forfeitPenalty(4), 56);
  // 3 players: a loser can hold 20 (18 and both spares).
  assert.equal(forfeitPenalty(3), 20 * rateFor(20, 3));
  assert.equal(forfeitPenalty(3), 80);
  // It is exactly what a loser who never played would pay, so it cannot be beaten by any real round.
  const nobodyPlayed = scoreRound(finished(0, [0, 14, 14, 14]));
  assert.equal(-nobodyPlayed.delta[1], forfeitPenalty(4));
  assert.throws(() => forfeitPenalty(5));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, THREE_OF_DIAMONDS } from '../src/cards.js';
import { newGame, applyMove, autoSkip, legalMoves, validatePlay, checkInvariants } from '../src/game.js';
import { classify } from '../src/hands.js';

test('3♦ holder leads and the opening must include it', () => {
  const s = newGame(mulberry32(1));
  assert.ok(s.hands[s.turn].includes(THREE_OF_DIAMONDS));
  assert.ok(s.hands.every((h) => h.length === 14));
  const other = s.hands[s.turn].find((c) => c !== THREE_OF_DIAMONDS);
  assert.match(validatePlay(s, [other]), /3♦/);
  assert.equal(validatePlay(s, [THREE_OF_DIAMONDS]), null);
  assert.match(validatePlay(s, []), /3♦/);
});

test('a pass lasts only for the go-round, and the trick resets when everyone else has passed in a row', () => {
  const hands = [
    [0, 10, 20, 30, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49],
    [1, 11, 21, 31, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13],
    [14, 15, 16, 17, 18, 19, 22, 23, 24, 25, 26, 27, 28, 29],
    [32, 33, 34, 35, 36, 37, 38, 39, 50, 51, 52, 53, 54, 55],
  ];
  const s = newGame(() => 0, hands);
  assert.equal(s.turn, 0);
  applyMove(s, [0]); // 3♦
  assert.equal(s.turn, 1);
  applyMove(s, null); // 1 passes
  applyMove(s, [14]); // 2 plays
  applyMove(s, null); // 3 passes
  assert.equal(s.turn, 0);
  applyMove(s, null); // 0 passes
  // 1 passed before 2's play, which gave everyone another turn: 1 is not locked out.
  assert.equal(s.turn, 1);
  assert.equal(validatePlay(s, [21]), null);
  applyMove(s, null); // 1 passes again
  // Everyone else has now passed in a row: player 2 leads a fresh trick.
  assert.equal(s.turn, 2);
  assert.equal(s.trick, null);
  assert.deepEqual(s.passed, [false, false, false, false]);
  // The new leader may pass the lead on.
  assert.equal(validatePlay(s, null), null);
});

// Seat 0 holds 3♦; everyone has plenty of cards unless a test trims them.
function fixedHands() {
  return [
    [0, 10, 20, 30, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49],
    [1, 11, 21, 31, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13],
    [14, 15, 16, 17, 18, 19, 22, 23, 24, 25, 26, 27, 28, 29],
    [32, 33, 34, 35, 36, 37, 38, 39, 50, 51, 52, 53, 54, 55],
  ];
}

test('the opening lead cannot be passed', () => {
  const s = newGame(() => 0, fixedHands());
  assert.match(validatePlay(s, null), /3♦/);
  assert.throws(() => applyMove(s, null));
});

test('the leader may pass the lead; if all four pass it, the original leader must play', () => {
  const s = newGame(() => 0, fixedHands());
  applyMove(s, [0]);
  applyMove(s, null);
  applyMove(s, null);
  applyMove(s, null);
  // Trick won by seat 0, who now leads and passes it on.
  assert.equal(s.turn, 0);
  assert.equal(s.trick, null);
  assert.equal(validatePlay(s, null), null);
  applyMove(s, null);
  assert.equal(s.turn, 1);
  assert.equal(s.trick, null);
  applyMove(s, null);
  applyMove(s, null);
  applyMove(s, null);
  assert.equal(s.turn, 0);
  assert.equal(s.leadPasses, 4);
  assert.match(validatePlay(s, null), /must play/);
  assert.throws(() => applyMove(s, null));
  // Once someone plays, the count resets and no one is locked out by having
  // passed the lead.
  applyMove(s, [10]);
  assert.equal(s.leadPasses, 0);
  assert.deepEqual(s.passed, [false, false, false, false]);
  assert.equal(s.turn, 1);
});

test('a lead pass mid-sequence: the next seat may play', () => {
  const s = newGame(() => 0, fixedHands());
  applyMove(s, [0]);
  applyMove(s, null);
  applyMove(s, null);
  applyMove(s, null);
  applyMove(s, null); // seat 0 passes the lead
  assert.equal(validatePlay(s, [1]), null);
  applyMove(s, [1]);
  assert.equal(s.trick.by, 1);
  assert.equal(s.turn, 2);
});

test('last-card rule: singles must be the highest when the next seat has one card', () => {
  const hands = fixedHands();
  hands[1] = [1]; // seat 1 (next after seat 0) has one card
  const s = newGame(() => 0, hands);
  s.first = false;
  s.turn = 0;
  // Seat 0's highest single is 2♣ (49). Leading anything lower is illegal.
  assert.match(validatePlay(s, [10]), /highest \(2♣\)/);
  assert.equal(validatePlay(s, [49]), null);
  // Pairs and other combinations are unaffected.
  assert.equal(validatePlay(s, [40, 41]), null);
  // Following a single: only the highest single, or pass.
  s.trick = { cards: [4], cls: classify([4]), by: 3 };
  assert.match(validatePlay(s, [10]), /highest/);
  assert.equal(validatePlay(s, [49]), null);
  assert.equal(validatePlay(s, null), null);
  const singles = legalMoves(s).filter((m) => m.cls.type === 'single');
  assert.deepEqual(
    singles.map((m) => m.cards),
    [[49]],
  );
  // If the highest single cannot beat the trick, no single is legal.
  s.trick = { cards: [52], cls: classify([52]), by: 3 };
  assert.equal(legalMoves(s).length, 0);
});

test('last-card rule treats any joker as the highest single', () => {
  const hands = fixedHands();
  hands[0] = [3, 9, 53, 55];
  hands[1] = [1];
  const s = newGame(() => 0, [hands[0].concat([0]), hands[1], hands[2], hands[3]]);
  s.first = false;
  assert.equal(validatePlay(s, [53]), null);
  assert.equal(validatePlay(s, [55]), null);
  assert.match(validatePlay(s, [9]), /a joker/);
});

test('the last-card rule only looks at the next seat', () => {
  const hands = fixedHands();
  hands[2] = [14]; // seat 2 has one card, but seat 1 is next after seat 0
  const s = newGame(() => 0, hands);
  s.first = false;
  assert.equal(validatePlay(s, [10]), null);
});

test('auto-skip: an unbeatable play goes straight back to its player', () => {
  const hands = fixedHands();
  const s = newGame(() => 0, hands);
  s.first = false;
  // Seat 0 plays 2♣ (49). Seat 3 holds 2♥, 2♠ and jokers, so it can beat it.
  applyMove(s, [49]);
  assert.deepEqual(autoSkip(s), []);
  assert.equal(s.turn, 1);
  assert.ok(s.trick);
  // Seat 3 plays a joker: nobody can beat a lone joker, so 1 and 2 (and 0)
  // are skipped and seat 3 leads again.
  applyMove(s, null); // seat 1
  applyMove(s, null); // seat 2
  applyMove(s, [52]); // seat 3
  // A pass lasts only for the go-round, so 1 and 2 are asked again, and none of the three can beat it.
  assert.deepEqual(autoSkip(s), [0, 1, 2]);
  assert.equal(s.turn, 3);
  assert.equal(s.trick, null);
  assert.deepEqual(s.passed, [false, false, false, false]);
  const autos = s.history.filter((e) => e.auto);
  assert.deepEqual(
    autos.map((e) => e.p),
    [0, 1, 2],
  );
});

test('auto-skip skips every remaining player when none can beat the play', () => {
  const hands = fixedHands();
  const s = newGame(() => 0, hands);
  s.first = false;
  s.turn = 3;
  applyMove(s, [55]); // lone joker from seat 3, nobody has passed
  assert.deepEqual(autoSkip(s), [0, 1, 2]);
  assert.equal(s.turn, 3);
  assert.equal(s.trick, null);
});

test('auto-skip with the last-card rule in force', () => {
  // Seat 2 has one card, so any single seat 1 plays must be its highest (2♦).
  // Against 8♠ that still beats, so nothing is skipped. (The rule can never
  // change whether a single can be beaten: if the highest can't, none can.)
  const s = newGame(() => 0, [[0, 23], [24, 48], [1], [4, 5]]);
  s.first = false;
  applyMove(s, [23]); // seat 0 plays 8♠
  assert.deepEqual(autoSkip(s), []);
  assert.equal(s.turn, 1);
  // Against 2♥ nobody can beat, so seats 1-3 are skipped.
  const t = newGame(() => 0, [[0, 50], [24, 48], [1], [4, 5]]);
  t.first = false;
  applyMove(t, [50]);
  assert.deepEqual(autoSkip(t), [1, 2, 3]);
  assert.equal(t.turn, 0);
});

test('auto-skip never fires on the winning play', () => {
  const s = newGame(() => 0, [[55], [0, 2], [3, 4], [5, 6]]);
  s.first = false;
  s.turn = 0;
  applyMove(s, [55]); // seat 0 goes out with a joker
  assert.equal(s.winner, 0);
  assert.deepEqual(autoSkip(s), []);
  assert.ok(s.trick);
});

test('auto-skip does nothing after a pass or with no trick', () => {
  const s = newGame(() => 0, fixedHands());
  assert.deepEqual(autoSkip(s), []); // no trick yet
  applyMove(s, [0]);
  applyMove(s, null); // seat 1 passes on 3♦
  const before = JSON.stringify(s.passed);
  assert.deepEqual(autoSkip(s), []); // seats 2 and 3 can beat 3♦
  assert.equal(JSON.stringify(s.passed), before);
});

test('random legal play always terminates with card conservation', () => {
  for (let g = 0; g < 200; g++) {
    const rng = mulberry32(1000 + g);
    const s = newGame(rng);
    let steps = 0;
    while (s.winner < 0) {
      const moves = legalMoves(s);
      const canPass = s.trick !== null;
      const r = rng();
      if (canPass && (moves.length === 0 || r < 0.3)) applyMove(s, null);
      else {
        assert.ok(moves.length > 0, 'a leader always has a legal play');
        const m = moves[Math.floor(rng() * moves.length)];
        assert.equal(validatePlay(s, m.cards), null);
        applyMove(s, m.cards, m.cls);
      }
      checkInvariants(s);
      assert.ok(++steps < 2000);
    }
    assert.equal(s.hands[s.winner].length, 0);
  }
});

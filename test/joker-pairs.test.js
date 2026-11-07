// Pairs are decided by their higher card. Two jokers are a pair of 2s with a joker as the 2♠ on top, so only a pair
// holding the real 2♠ beats them: the other two jokers, or a joker with a real 2♥, 2♦ or 2♣, tie with them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, cardId, cardName, FIRST_JOKER, DECK_SIZE } from '../src/cards.js';
import { classify, beats } from '../src/hands.js';
import { newGame, validatePlay, legalMoves } from '../src/game.js';
import { buildContext } from '../src/ai/heuristic.js';

const RANK_TWO = 12;
const [DIAMONDS, CLUBS, HEARTS, SPADES] = [0, 1, 2, 3];
const two = (suit) => cardId(RANK_TWO, suit);
const [J1, J2, J3, J4] = [FIRST_JOKER, FIRST_JOKER + 1, FIRST_JOKER + 2, FIRST_JOKER + 3];
const name = (cards) => cards.map((c) => (c >= FIRST_JOKER ? 'Joker' : cardName(c))).join(' + ');

test('what beats two jokers: only a pair holding the real 2♠', () => {
  const table = classify([J1, J2]);
  assert.equal(table.label, 'Pair of 2s');
  const cannot = [
    [J3, J4], // the other two jokers
    [two(HEARTS), J3], // a joker with the 2♥, 2♦ or 2♣: a joker is still on top
    [two(DIAMONDS), J3],
    [two(CLUBS), J3],
    [two(HEARTS), two(CLUBS)], // two real 2s, neither the spade
    [two(HEARTS), two(DIAMONDS)],
  ];
  for (const p of cannot) {
    assert.ok(!beats(classify(p), table), `${name(p)} must not beat two jokers`);
    assert.ok(!beats(table, classify(p)) || !p.some((c) => c >= FIRST_JOKER), `${name(p)}`);
  }
  const can = [
    [two(SPADES), two(HEARTS)],
    [two(SPADES), two(DIAMONDS)],
    [two(SPADES), two(CLUBS)],
    [two(SPADES), J3], // the real 2♠ with a joker
  ];
  for (const p of can) assert.ok(beats(classify(p), table), `${name(p)} must beat two jokers`);
  // And nothing beats the pair with the real 2♠: there is only one 2♠ to build a better one from.
  const best = classify([two(SPADES), two(HEARTS)]);
  for (const p of [...can, ...cannot, [J1, J2]]) assert.ok(!beats(classify(p), best), `${name(p)} vs the best pair`);
});

test('the same rule for every rank: a joker pair is decided by the joker standing for the spade', () => {
  for (let r = 0; r < 12; r++) {
    const spade = cardId(r, SPADES);
    const withJoker = (suit) => classify([cardId(r, suit), J1]);
    // A joker with any non-spade of that rank: the joker is the spade on top, so these all tie each other.
    for (const a of [DIAMONDS, CLUBS, HEARTS]) {
      for (const b of [DIAMONDS, CLUBS, HEARTS]) {
        assert.ok(!beats(withJoker(a), withJoker(b)), `rank ${r}: joker with suit ${a} vs ${b}`);
      }
    }
    // The real spade of that rank (with anything) beats a joker standing for it.
    assert.ok(beats(classify([spade, cardId(r, HEARTS)]), withJoker(DIAMONDS)));
    assert.ok(beats(classify([spade, J2]), withJoker(HEARTS)));
    // A real pair with no spade has a lower top card than a joker pair, whatever its lower card is.
    assert.ok(beats(withJoker(DIAMONDS), classify([cardId(r, HEARTS), cardId(r, CLUBS)])));
    // A higher rank always wins, joker or not.
    assert.ok(beats(classify([cardId(r + 1, DIAMONDS), cardId(r + 1, CLUBS)]), classify([spade, J1])));
  }
});

test('in the game: a joker with a real 2♥ cannot be played on a pair of jokers, the real 2♠ can', () => {
  const play = (hand) => {
    const s = newGame(() => 0, [[3, 4], hand, [5, 6], [7, 8]]);
    s.first = false;
    s.turn = 1;
    s.trick = { cards: [J1, J2], cls: classify([J1, J2]), by: 0 };
    return s;
  };
  const refused = play([two(HEARTS), J3, 9, 10]);
  assert.match(validatePlay(refused, [two(HEARTS), J3]), /does not beat/);
  assert.match(validatePlay(refused, [J3, J4].slice(0, 1).concat([two(HEARTS)])), /does not beat/);
  assert.equal(
    legalMoves(refused).filter((m) => m.cards.length === 2).length,
    0,
    'no pair in this hand can be played on two jokers',
  );
  const allowed = play([two(SPADES), two(DIAMONDS), J3, 10]);
  assert.equal(validatePlay(allowed, [two(SPADES), two(DIAMONDS)]), null);
  assert.equal(validatePlay(allowed, [two(SPADES), J3]), null);
  assert.match(validatePlay(allowed, [two(DIAMONDS), J3]), /does not beat/);
  // The other two jokers tie with the two on the table: not playable either.
  const jokers = play([J3, J4, 9, 10]);
  assert.match(validatePlay(jokers, [J3, J4]), /does not beat/);
});

// The computer players decide whether a pair is "unbeatable" from the strongest pair that could still be out there.
// That estimate must be exactly the best pair that can be made from the cards nobody has shown.
test("the heuristic's strongest unseen pair is exactly the best pair the unseen cards can make", () => {
  const rng = mulberry32(77);
  let compared = 0;
  for (let trial = 0; trial < 1500; trial++) {
    const order = Array.from({ length: DECK_SIZE }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const k = Math.floor(rng() * (i + 1));
      [order[i], order[k]] = [order[k], order[i]];
    }
    const hand = order.slice(0, 1 + Math.floor(rng() * 14));
    const played = order.slice(14, 14 + Math.floor(rng() * 28));
    const unseen = order.filter((c) => !hand.includes(c) && !played.includes(c));
    let best = -1;
    for (let a = 0; a < unseen.length; a++) {
      for (let b = a + 1; b < unseen.length; b++) {
        const cls = classify([unseen[a], unseen[b]]);
        if (cls && cls.key > best) best = cls.key;
      }
    }
    const ctx = buildContext({ me: 0, hand, played, counts: [hand.length, 14, 14, 14] });
    assert.equal(ctx.maxPair, best, `hand ${hand} played ${played}`);
    compared++;
  }
  assert.equal(compared, 1500);
});

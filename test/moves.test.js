import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dealHands, mulberry32 } from '../src/cards.js';
import { classify } from '../src/hands.js';
import { generatePlays, legalPlays, moveKey } from '../src/moves.js';

function bruteForce(hand) {
  const out = new Map();
  const n = hand.length;
  const pick = [];
  const rec = (start, size) => {
    if (pick.length === size) {
      const cls = classify(pick);
      if (cls) out.set(moveKey(pick), cls.key + ':' + cls.type);
      return;
    }
    for (let i = start; i < n; i++) {
      pick.push(hand[i]);
      rec(i + 1, size);
      pick.pop();
    }
  };
  for (const size of [1, 2, 3, 5]) rec(0, size);
  return out;
}

test('structured generation equals brute-force enumeration of all subsets', () => {
  const rng = mulberry32(99);
  for (let g = 0; g < 60; g++) {
    for (const hand of dealHands(rng)) {
      const want = bruteForce(hand);
      const got = new Map(generatePlays(hand).map((m) => [m.key, m.cls.key + ':' + m.cls.type]));
      assert.equal(got.size, want.size, `hand ${hand}`);
      for (const [k, v] of want) assert.equal(got.get(k), v, `missing ${k} in ${hand}`);
    }
  }
});

test('generation is complete on joker-heavy hands', () => {
  const hands = [
    [0, 1, 5, 9, 13, 17, 20, 30, 40, 52, 53, 54, 55],
    [3, 7, 11, 15, 19, 23, 27, 31, 35, 39, 52, 53, 54, 55],
    [0, 4, 8, 12, 16, 2, 6, 52, 53, 54],
  ];
  for (const hand of hands) {
    const want = bruteForce(hand);
    const got = new Set(generatePlays(hand).map((m) => m.key));
    assert.equal(got.size, want.size);
    for (const k of want.keys()) assert.ok(got.has(k), k);
  }
});

test('legal plays respect type, strength and the 3♦ rule', () => {
  const hand = [0, 1, 4, 8, 12, 16, 50, 52];
  const opening = legalPlays(hand, null, 0);
  assert.ok(opening.length > 0);
  assert.ok(opening.every((m) => m.cards.includes(0)));
  const toBeat = classify([49]); // 2♣
  const follow = legalPlays(hand, toBeat);
  assert.deepEqual(follow.map((m) => m.cards).sort(), [[50], [52]].sort());
});

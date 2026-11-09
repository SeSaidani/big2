// Rearranging your own hand (src/hand-order.js): whatever you do, you still hold exactly the cards you were dealt,
// once each; a card moves to where you put it and nothing else moves relative to the others.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/cards.js';
import { applyOrder, moveCard, slotAfter } from '../src/hand-order.js';

test('moveCard puts the card where asked and keeps the others in their order', () => {
  assert.deepEqual(moveCard([1, 2, 3, 4, 5], 4, 0), [4, 1, 2, 3, 5], 'to the front');
  assert.deepEqual(moveCard([1, 2, 3, 4, 5], 1, 4), [2, 3, 4, 5, 1], 'to the back');
  assert.deepEqual(moveCard([1, 2, 3, 4, 5], 2, 3), [1, 3, 4, 2, 5], 'into the middle');
  assert.deepEqual(moveCard([1, 2, 3], 2, 1), [1, 2, 3], 'dropped where it was: nothing changes');
});

test('a position outside the hand is the nearest end, and an unknown card changes nothing', () => {
  assert.deepEqual(moveCard([1, 2, 3], 3, -5), [3, 1, 2]);
  assert.deepEqual(moveCard([1, 2, 3], 1, 99), [2, 3, 1]);
  assert.deepEqual(moveCard([1, 2, 3], 9, 0), [1, 2, 3]);
});

test('moveCard returns a new list and leaves the one it was given alone', () => {
  const order = [1, 2, 3];
  const out = moveCard(order, 3, 0);
  assert.notEqual(out, order);
  assert.deepEqual(order, [1, 2, 3]);
});

test('applyOrder keeps your order for the cards still held and drops the ones played', () => {
  assert.deepEqual(applyOrder([5, 3, 9, 1], [1, 3, 5]), [5, 3, 1]);
});

test('applyOrder never hides a card: ones the order does not mention come after, and repeats are ignored', () => {
  assert.deepEqual(applyOrder([5, 3], [1, 3, 5, 7]), [5, 3, 1, 7]);
  assert.deepEqual(applyOrder([5, 5, 3], [3, 5]), [5, 3]);
  assert.deepEqual(applyOrder([], [4, 2]), [4, 2]);
});

test('random moves and plays always leave exactly the cards held, each once', () => {
  const rng = mulberry32(11);
  for (let trial = 0; trial < 200; trial++) {
    const hand = Array.from({ length: 14 }, (_, i) => i * 4); // includes jokers' ids at the top of the deck
    hand.push(54, 55);
    let order = [...hand];
    let held = [...hand];
    for (let step = 0; step < 30 && held.length; step++) {
      if (rng() < 0.3) {
        held = held.filter((c) => c !== held[Math.floor(rng() * held.length)]); // a card is played
      } else {
        order = moveCard(order, held[Math.floor(rng() * held.length)], Math.floor(rng() * 20) - 3);
      }
      const shown = applyOrder(order, held);
      assert.deepEqual(
        [...shown].sort((a, b) => a - b),
        [...held].sort((a, b) => a - b),
      );
    }
  }
});

test('slotAfter moves the card by whole slots with the finger, and stays inside the hand', () => {
  assert.equal(slotAfter(2, 0, 30, 5), 2, 'not moved: same slot');
  assert.equal(slotAfter(2, 14, 30, 5), 2, 'less than half a slot: same slot');
  assert.equal(slotAfter(2, 16, 30, 5), 3, 'past half a slot');
  assert.equal(slotAfter(2, -46, 30, 5), 0, 'left, by 1.5 slots, rounds away from the start');
  assert.equal(slotAfter(2, -500, 30, 5), 0, 'far off the left end');
  assert.equal(slotAfter(2, 9999, 30, 5), 4, 'far off the right end');
  assert.equal(slotAfter(0, 50, 30, 1), 0, 'one card has one slot');
  assert.equal(slotAfter(3, 50, 0, 5), 0, 'a row with no spacing has nowhere to go');
});

// Round scoring, in the Hong Kong style: every loser pays the winner according
// to the cards they still hold, at a rate that rises with the count.
//
//   cards left   rate per card   (so a loser with n cards pays n · rate(n))
//   1-7          1
//   8-10         2
//   11-13        3
//   14           4               (never played a card)
//
// If the winning play is a straight flush or five of a kind, every payment
// doubles. The result is zero-sum: delta[winner] = -sum of the other deltas.
//
// The standard HK scale assumes 13-card hands; these thresholds are an
// adaptation to 14 cards, kept in one table so they are easy to change.

import { NUM_PLAYERS, HAND_SIZE } from './cards.js';
import { FIVE, STRAIGHT_FLUSH } from './hands.js';

export const RATES = [
  { upTo: 7, rate: 1 },
  { upTo: 10, rate: 2 },
  { upTo: 13, rate: 3 },
  { upTo: HAND_SIZE, rate: 4 },
];

export function rateFor(cardsLeft) {
  if (!Number.isInteger(cardsLeft) || cardsLeft < 1 || cardsLeft > HAND_SIZE) {
    throw new RangeError(`A loser holds 1..${HAND_SIZE} cards, got ${cardsLeft}`);
  }
  return RATES.find((r) => cardsLeft <= r.upTo).rate;
}

export const isBonusPlay = (cls) => !!cls && cls.type === FIVE && cls.cat >= STRAIGHT_FLUSH;

// Score a finished round from the final game state (state.trick is the
// winning play, because auto-skip never fires on the last card).
export function scoreRound(state) {
  const w = state.winner;
  if (!(w >= 0 && w < NUM_PLAYERS)) throw new Error('Round is not finished');
  if (state.hands[w].length !== 0) throw new Error('Winner still holds cards');
  const multiplier = isBonusPlay(state.trick && state.trick.cls) ? 2 : 1;
  const delta = new Array(NUM_PLAYERS).fill(0);
  const payments = [];
  for (let p = 0; p < NUM_PLAYERS; p++) {
    if (p === w) continue;
    const n = state.hands[p].length;
    const pay = n * rateFor(n) * multiplier;
    delta[p] = -pay;
    delta[w] += pay;
    payments.push({ player: p, cardsLeft: n, rate: rateFor(n), multiplier, pay });
  }
  return { winner: w, multiplier, delta, payments };
}

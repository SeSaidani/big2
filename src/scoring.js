// Round scoring, in the Hong Kong style: every loser pays the winner according
// to the cards they still hold, at a rate that rises with the count.
//
//   cards left   rate per card   (so a loser with n cards pays n · rate(n))
//   1-7          1
//   8-10         2
//   11-13        3
//   14           4               (never played a card)
//
// At a table of three, hands are 18 cards (19 or 20 for whoever got the spare cards), so the same
// scale is stretched to 18 in proportion (7/14, 10/14, 13/14 of the hand become 9, 13, 17 of 18):
//
//   1-9 → 1,  10-13 → 2,  14-17 → 3,  18-20 → 4
//
// If the winning play is a straight flush or five of a kind, every payment
// doubles. The result is zero-sum: delta[winner] = -sum of the other deltas.
//
// The standard HK scale assumes 13-card hands; these thresholds are an
// adaptation to 14 cards, kept in one table so they are easy to change.

import { NUM_PLAYERS, HAND_SIZE, HAND_SIZE_3 } from './cards.js';
import { FIVE, STRAIGHT_FLUSH } from './hands.js';

// The most cards a loser can hold: a full hand, and at a table of three the 3♦ holder may also have both spares.
const MOST_CARDS = { 4: HAND_SIZE, 3: HAND_SIZE_3 + 2 };

export const RATES_BY_PLAYERS = {
  4: [
    { upTo: 7, rate: 1 },
    { upTo: 10, rate: 2 },
    { upTo: 13, rate: 3 },
    { upTo: HAND_SIZE, rate: 4 },
  ],
  3: [
    { upTo: 9, rate: 1 },
    { upTo: 13, rate: 2 },
    { upTo: 17, rate: 3 },
    { upTo: MOST_CARDS[3], rate: 4 },
  ],
};
export const RATES = RATES_BY_PLAYERS[4];

export function rateFor(cardsLeft, players = NUM_PLAYERS) {
  const table = RATES_BY_PLAYERS[players];
  if (!table) throw new RangeError(`A table seats 3 or 4 players, not ${players}`);
  if (!Number.isInteger(cardsLeft) || cardsLeft < 1 || cardsLeft > MOST_CARDS[players]) {
    throw new RangeError(`A loser holds 1..${MOST_CARDS[players]} cards, got ${cardsLeft}`);
  }
  return table.find((r) => cardsLeft <= r.upTo).rate;
}

export const isBonusPlay = (cls) => !!cls && cls.type === FIVE && cls.cat >= STRAIGHT_FLUSH;

// Score a finished round from the final game state (state.trick is the
// winning play, because auto-skip never fires on the last card).
export function scoreRound(state) {
  const w = state.winner;
  const players = state.hands.length;
  if (!(w >= 0 && w < players)) throw new Error('Round is not finished');
  if (state.hands[w].length !== 0) throw new Error('Winner still holds cards');
  const multiplier = isBonusPlay(state.trick && state.trick.cls) ? 2 : 1;
  const delta = new Array(players).fill(0);
  const payments = [];
  for (let p = 0; p < players; p++) {
    if (p === w) continue;
    const n = state.hands[p].length;
    const rate = rateFor(n, players);
    const pay = n * rate * multiplier;
    delta[p] = -pay;
    delta[w] += pay;
    payments.push({ player: p, cardsLeft: n, rate, multiplier, pay });
  }
  return { winner: w, multiplier, delta, payments };
}

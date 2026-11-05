// Pure helpers that turn the server's table view into what the browser UI
// already knows how to draw. No DOM, so these are unit-tested in Node.
//
// The server numbers seats 0..n-1 globally (n is 3 or 4); the UI always draws "you" at the
// bottom as seat 0. mirrorState() rotates everything so that the UI's own
// game.js helpers (validatePlay, turnRules, observe) behave exactly as they
// would for the server's seat, with placeholders (-1) for hidden cards.

import { classify } from './hands.js';

// n is the number of seats at the table.
export const rot = (seat, you, n) => (seat - you + n) % n; // server seat -> display seat
export const unrot = (d, you, n) => (d + you) % n; // display seat -> server seat

const rotTrick = (trick, you, n) => (trick ? { ...trick, by: rot(trick.by, you, n) } : null);

export function mirrorState(t) {
  const you = t.you;
  const v = t.game.view;
  const n = t.seats.length;
  const at = (d) => unrot(d, you, n);
  const seats = Array.from({ length: n }, (_, d) => d);
  return {
    hands: seats.map((d) => {
      if (t.hands) return t.hands[at(d)].slice(); // round over: everything is shown
      return d === 0 ? v.hand.slice() : new Array(v.counts[at(d)]).fill(-1);
    }),
    turn: rot(t.game.turn, you, n),
    trick: rotTrick(v.trick, you, n),
    passed: seats.map((d) => v.passed[at(d)]),
    leadPasses: v.leadPasses,
    first: v.first,
    winner: t.game.winner >= 0 ? rot(t.game.winner, you, n) : -1,
    played: v.played.slice(),
    history: v.history.map((h) => ({ ...h, p: rot(h.p, you, n), trick: rotTrick(h.trick, you, n) })),
  };
}

// What happened since `prevLen` history entries ago, in display seats:
// { p, cards, cls, auto, leadPass }. An auto entry is a seat that was skipped
// because it could not beat the play; a lead pass is a pass with no trick.
export function newEvents(prevLen, t) {
  const n = t.seats.length;
  return t.game.view.history.slice(prevLen).map((h) => ({
    p: rot(h.p, t.you, n),
    cards: h.cards,
    cls: h.cards ? classify(h.cards) : null,
    auto: !!h.auto,
    leadPass: !h.cards && !h.trick && !h.auto,
  }));
}

// Display names by display seat; a person with no open connection is marked.
export function seatNames(t) {
  const n = t.seats.length;
  return Array.from({ length: n }, (_, d) => {
    if (d === 0) return 'You';
    const s = t.seats[unrot(d, t.you, n)];
    return s.name + (s.online === false ? ' (offline)' : '');
  });
}

// Is the seat at display position d played by the computer?
export const isComputer = (t, d) => t.seats[unrot(d, t.you, t.seats.length)].kind === 'ai';

// Is it a person at display position d who is not connected right now?
export const isAway = (t, d) => t.seats[unrot(d, t.you, t.seats.length)].online === false;

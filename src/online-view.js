// Pure helpers that turn the server's table view into what the browser UI
// already knows how to draw. No DOM, so these are unit-tested in Node.
//
// The server numbers seats 0..3 globally; the UI always draws "you" at the
// bottom as seat 0. mirrorState() rotates everything so that the UI's own
// game.js helpers (validatePlay, turnRules, observe) behave exactly as they
// would for the server's seat, with placeholders (-1) for hidden cards.

import { classify } from './hands.js';

const N = 4;

export const rot = (seat, you) => (seat - you + N) % N; // server seat -> display seat
export const unrot = (d, you) => (d + you) % N; // display seat -> server seat

const rotTrick = (trick, you) => (trick ? { ...trick, by: rot(trick.by, you) } : null);

export function mirrorState(t) {
  const you = t.you;
  const v = t.game.view;
  const at = (d) => unrot(d, you);
  const seats = [0, 1, 2, 3];
  return {
    hands: seats.map((d) => {
      if (t.hands) return t.hands[at(d)].slice(); // round over: everything is shown
      return d === 0 ? v.hand.slice() : new Array(v.counts[at(d)]).fill(-1);
    }),
    turn: rot(t.game.turn, you),
    trick: rotTrick(v.trick, you),
    passed: seats.map((d) => v.passed[at(d)]),
    leadPasses: v.leadPasses,
    first: v.first,
    winner: t.game.winner >= 0 ? rot(t.game.winner, you) : -1,
    played: v.played.slice(),
    history: v.history.map((h) => ({ ...h, p: rot(h.p, you), trick: rotTrick(h.trick, you) })),
  };
}

// What happened since `prevLen` history entries ago, in display seats:
// { p, cards, cls, auto, leadPass }. An auto entry is a seat that was skipped
// because it could not beat the play; a lead pass is a pass with no trick.
export function newEvents(prevLen, t) {
  return t.game.view.history.slice(prevLen).map((h) => ({
    p: rot(h.p, t.you),
    cards: h.cards,
    cls: h.cards ? classify(h.cards) : null,
    auto: !!h.auto,
    leadPass: !h.cards && !h.trick && !h.auto,
  }));
}

// Display names by display seat; a person with no open connection is marked.
export function seatNames(t) {
  return [0, 1, 2, 3].map((d) => {
    if (d === 0) return 'You';
    const s = t.seats[unrot(d, t.you)];
    return s.name + (s.online === false ? ' (offline)' : '');
  });
}

// Is the seat at display position d played by the computer?
export const isComputer = (t, d) => t.seats[unrot(d, t.you)].kind === 'ai';

// Is it a person at display position d who is not connected right now?
export const isAway = (t, d) => t.seats[unrot(d, t.you)].online === false;

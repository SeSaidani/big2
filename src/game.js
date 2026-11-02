// Game state machine. Seats 0..3 play in increasing order (0 is the human).
//
// - A player who passes on someone else's play is locked out of the trick
//   until it resets; when play comes back round to the last player who
//   played, they lead a fresh trick.
// - The leader may pass the lead to the next seat. If all four seats pass
//   it in a row, it is back with the player who had it first, who must now
//   play. The opening play (with the 3♦) cannot be passed.
// - Last-card rule: if the next seat has one card left, any single the
//   player to move plays must be their highest single (jokers tie as top).
// - The round ends as soon as one player empties their hand.
//
// turnRules / viewRules are the single source of these constraints; the
// validator, move generation, UI and every AI read from them.

import { NUM_PLAYERS, THREE_OF_DIAMONDS, DECK_SIZE, dealHands, isJoker, FIRST_JOKER, cardName } from './cards.js';
import { classify, beats, SINGLE } from './hands.js';
import { legalPlays } from './moves.js';

export function newGame(rng = Math.random, hands = dealHands(rng)) {
  const holder = hands.findIndex((h) => h.includes(THREE_OF_DIAMONDS));
  return {
    hands: hands.map((h) => [...h]),
    turn: holder,
    trick: null, // { cards, cls, by }
    passed: [false, false, false, false],
    leadPasses: 0, // consecutive passes of the lead in the current hand-off
    first: true,
    winner: -1,
    played: [], // every card played so far, in order
    history: [], // { p, cards } (cards null for a pass) with the trick faced
  };
}

export function cloneState(s, withHistory = false) {
  return {
    hands: s.hands.map((h) => h.slice()),
    turn: s.turn,
    trick: s.trick,
    passed: s.passed.slice(),
    leadPasses: s.leadPasses,
    first: s.first,
    winner: s.winner,
    played: withHistory ? s.played.slice() : null,
    history: withHistory ? s.history.slice() : null,
  };
}

// Key of the highest single in a hand (52 for any joker).
export function topSingleKey(hand) {
  let k = -1;
  for (const c of hand) k = Math.max(k, isJoker(c) ? FIRST_JOKER : c);
  return k;
}

export function rulesFor(hand, nextCount, trick, first, leadPasses) {
  return {
    canPass: trick ? true : !first && leadPasses < NUM_PLAYERS,
    mustInclude: first ? THREE_OF_DIAMONDS : -1,
    singleKey: nextCount === 1 ? topSingleKey(hand) : -1,
  };
}

export function turnRules(s) {
  const p = s.turn;
  return rulesFor(s.hands[p], s.hands[(p + 1) % NUM_PLAYERS].length, s.trick, s.first, s.leadPasses);
}

export function viewRules(v) {
  return rulesFor(v.hand, v.counts[(v.me + 1) % NUM_PLAYERS], v.trick, v.first, v.leadPasses);
}

export function legalMoves(s) {
  const r = turnRules(s);
  return legalPlays(s.hands[s.turn], s.trick ? s.trick.cls : null, r.mustInclude, r.singleKey);
}

// Checks a proposed play by the player to move; returns an error string or null.
export function validatePlay(s, cards) {
  if (s.winner >= 0) return 'The round is over.';
  const hand = s.hands[s.turn];
  const rules = turnRules(s);
  if (!cards || cards.length === 0) {
    if (rules.canPass) return null;
    if (s.first) return 'The opening play must include the 3♦, so it cannot be passed.';
    return 'The lead has come all the way round, so you must play.';
  }
  if (new Set(cards).size !== cards.length || !cards.every((c) => hand.includes(c))) {
    return 'Those cards are not all in hand.';
  }
  const cls = classify(cards);
  if (!cls) return 'That is not a valid combination.';
  if (s.first && !cards.includes(THREE_OF_DIAMONDS)) {
    return 'The opening play must include the 3♦.';
  }
  if (s.trick) {
    if (cls.type !== s.trick.cls.type) {
      return `You must play a ${s.trick.cls.type === 'five' ? 'five-card hand' : s.trick.cls.type}.`;
    }
    if (!beats(cls, s.trick.cls)) return `That does not beat ${s.trick.cls.label}.`;
  }
  if (cls.type === SINGLE && rules.singleKey >= 0 && cls.key !== rules.singleKey) {
    const top = rules.singleKey === FIRST_JOKER ? 'a joker' : cardName(rules.singleKey);
    return `The next player has one card left, so a single must be your highest (${top}).`;
  }
  return null;
}

// Applies a play (array of card ids, optionally with a precomputed cls) or a
// pass (null / []). Mutates and returns the state. Untrusted callers should
// call validatePlay first; this throws on a pass that is not allowed or an
// unclassifiable play, but trusts callers on the finer rules.
export function applyMove(s, cards, cls = null) {
  const p = s.turn;
  if (s.history) s.history.push({ p, cards: cards && cards.length ? cards : null, trick: s.trick });
  if (!cards || cards.length === 0) {
    if (s.trick) {
      s.passed[p] = true;
      advance(s);
    } else {
      if (s.first || s.leadPasses >= NUM_PLAYERS) throw new Error('Cannot pass the lead here');
      s.leadPasses++;
      s.turn = (p + 1) % NUM_PLAYERS;
    }
    return s;
  }
  cls = cls || classify(cards);
  if (!cls) throw new Error('Invalid combination');
  const hand = s.hands[p];
  const next = hand.filter((c) => !cards.includes(c));
  if (next.length !== hand.length - cards.length) throw new Error('Cards not in hand');
  s.hands[p] = next;
  s.trick = { cards, cls, by: p };
  s.first = false;
  s.leadPasses = 0;
  if (s.played) s.played.push(...cards);
  if (next.length === 0) {
    s.winner = p;
    return s;
  }
  advance(s);
  return s;
}

// Auto-skip: if nobody still in the trick (not passed, not the player who
// made the current play) holds a legal play that beats it, under the full
// rules including the last-card rule, pass them all at once and give the
// lead straight back. Every skipped pass was forced, so outcomes are
// unchanged; history marks them `auto` because, unlike a normal pass, they
// reveal that the player could not beat the play. Returns the skipped seats.
// The UI and arena call this after each play; AI simulations do not need to
// (a player with no legal play passes anyway, so results are identical).
export function autoSkip(s) {
  if (s.winner >= 0 || !s.trick) return [];
  const by = s.trick.by;
  const pending = [];
  for (let d = 1; d < NUM_PLAYERS; d++) {
    const q = (by + d) % NUM_PLAYERS;
    if (!s.passed[q]) pending.push(q);
  }
  for (const q of pending) {
    const r = rulesFor(s.hands[q], s.hands[(q + 1) % NUM_PLAYERS].length, s.trick, false, 0);
    if (legalPlays(s.hands[q], s.trick.cls, -1, r.singleKey).length) return [];
  }
  for (const q of pending) {
    if (s.history) s.history.push({ p: q, cards: null, trick: s.trick, auto: true });
  }
  s.trick = null;
  s.passed = [false, false, false, false];
  s.turn = by;
  return pending;
}

function advance(s) {
  let q = s.turn;
  do {
    q = (q + 1) % NUM_PLAYERS;
  } while (s.passed[q] && q !== s.trick.by);
  if (q === s.trick.by) {
    s.trick = null;
    s.passed = [false, false, false, false];
  }
  s.turn = q;
}

// What player p is allowed to know.
export function observe(s, p) {
  return {
    me: p,
    hand: s.hands[p].slice(),
    counts: s.hands.map((h) => h.length),
    trick: s.trick,
    passed: s.passed.slice(),
    leadPasses: s.leadPasses,
    first: s.first,
    played: s.played.slice(),
    history: s.history.slice(),
  };
}

export function checkInvariants(s) {
  const all = [...s.hands.flat(), ...s.played];
  if (all.length !== DECK_SIZE || new Set(all).size !== DECK_SIZE) {
    throw new Error('Card conservation violated');
  }
}

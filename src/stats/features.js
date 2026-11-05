// What a dealt hand looks like, as numbers: the inputs of the deal model (see model.js and
// docs/deal-model.md). One function is used both to fit the model offline and to apply it live,
// so the two can never drift apart.
//
// The features describe a hand as dealt, before a card is played, plus one fact about the
// table: whether the hand holds the 3♦ and so must open. Nothing here looks at the other hands.

import { RANK_NAMES, THREE_OF_DIAMONDS, isJoker, rankOf } from '../cards.js';
import { newGame, observe } from '../game.js';
import { analyzeHand } from '../moves.js';
import { Planner, buildContext } from '../ai/heuristic.js';

const rankIndex = (name) => RANK_NAMES.indexOf(name);
const R_TWO = rankIndex('2');
const R_ACE = rankIndex('A');
const R_KING = rankIndex('K');
const R_EIGHT = rankIndex('8');

// Order matters: it is the order of the columns in every feature vector and saved model.
export const FEATURES = [
  'twos', // real 2s (the highest rank)
  'aces',
  'kings',
  'jokers', // wild
  'pairs', // ranks held at least twice (naturals only)
  'triples', // ranks held at least three times
  'lowCards', // naturals ranked 3 to 8, the cards that rarely win a trick
  'planCost', // the planner's weighted number of plays to go out (smaller is better): see ai/heuristic.js
  'holdsLead', // 1 if this hand has the 3♦ and must open
];

export const FEATURE_SETS = {
  // The simple baseline: three counts, no planner.
  counts: ['twos', 'aces', 'jokers'],
  full: FEATURES,
};

// Features of one hand. `planCost` needs the planner's view of the table, built from the deal alone.
export function handFeatures(hand, { planCost, holdsLead }) {
  const { byRank, jokers } = analyzeHand(hand);
  const f = {
    twos: byRank[R_TWO].length,
    aces: byRank[R_ACE].length,
    kings: byRank[R_KING].length,
    jokers: jokers.length,
    pairs: byRank.filter((cards) => cards.length >= 2).length,
    triples: byRank.filter((cards) => cards.length >= 3).length,
    lowCards: hand.filter((c) => !isJoker(c) && rankOf(c) <= R_EIGHT).length,
    planCost,
    holdsLead: holdsLead ? 1 : 0,
  };
  return FEATURES.map((name) => f[name]);
}

// One feature vector per seat for a whole deal (hands[seat] = card ids).
export function dealFeatures(hands) {
  const state = newGame(() => 0, hands);
  return hands.map((hand, seat) => {
    const planner = new Planner(hand, buildContext(observe(state, seat)));
    return handFeatures(hand, { planCost: planner.cost(hand), holdsLead: hand.includes(THREE_OF_DIAMONDS) });
  });
}

// The columns of `names` picked out of a full feature vector.
export const pick = (vector, names) => names.map((n) => vector[FEATURES.indexOf(n)]);

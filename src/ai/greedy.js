// Fast greedy policy, used for Monte Carlo rollouts and as the Easy agent.
// It avoids full move generation except for five-card follows: leads are
// built around the lowest card from rank/suit groups, and single/pair/triple
// follows are read straight off the rank groups.

import { isJoker, rankOf, suitOf, RANK_TWO, THREE_OF_DIAMONDS, FIRST_JOKER } from '../cards.js';
import { classify, WINDOWS, SINGLE, PAIR, TRIPLE } from '../hands.js';
import { generatePlays } from '../moves.js';

function groups(hand) {
  const byRank = Array.from({ length: 13 }, () => []);
  const bySuit = [[], [], [], []];
  const jokers = [];
  let rankMask = 0;
  for (const c of hand) {
    if (isJoker(c)) jokers.push(c);
    else {
      const r = rankOf(c);
      byRank[r].push(c);
      bySuit[suitOf(c)].push(c);
      rankMask |= 1 << r;
    }
  }
  return { byRank, bySuit, jokers, rankMask };
}

const play = (cards) => ({ cards, cls: classify(cards) });

function leadAround(anchor, g) {
  const r = rankOf(anchor);
  const same = g.byRank[r];
  if (same.length >= 2) {
    // Full house if we have the triple/pair partner without breaking much.
    if (same.length === 3) {
      for (let b = 0; b < 13; b++) {
        if (b !== r && g.byRank[b].length === 2) return play([...same, ...g.byRank[b]]);
      }
      return play(same.slice());
    }
    if (same.length === 2) {
      for (let b = 0; b < 13; b++) {
        if (b !== r && g.byRank[b].length === 3) return play([...same, ...g.byRank[b]]);
      }
      return play(same.slice());
    }
    return play(same.slice(0, 3)); // four of a rank: lead three, keep a kicker
  }
  // Natural straight through the anchor, using the lowest window available.
  for (const w of WINDOWS) {
    if (!(w.mask & (1 << r)) || (g.rankMask & w.mask) !== w.mask) continue;
    if (w.ranks.some((x) => x !== r && g.byRank[x].length >= 2)) continue; // avoid breaking pairs
    return play(w.ranks.map((x) => (x === r ? anchor : g.byRank[x][0])));
  }
  const suited = g.bySuit[suitOf(anchor)];
  if (suited.length >= 5) {
    const loose = suited.filter((c) => c !== anchor && g.byRank[rankOf(c)].length === 1);
    if (loose.length >= 4) return play([anchor, ...loose.slice(0, 4)]);
  }
  return play([anchor]);
}

// Lowest natural single above `key` that isn't part of a same-rank group,
// falling back to any natural, then (if allowed) a joker.
function followSingle(g, key, allowPremium) {
  let loose = -1;
  let any = -1;
  for (let r = 0; r < 13; r++) {
    if (r === RANK_TWO && !allowPremium) break;
    for (const c of g.byRank[r]) {
      if (c <= key) continue;
      if (any < 0) any = c;
      if (loose < 0 && g.byRank[r].length === 1) loose = c;
    }
    if (loose >= 0) break;
  }
  if (loose >= 0) return [loose];
  if (any >= 0) return [any];
  if (allowPremium && g.jokers.length && key < FIRST_JOKER) return [g.jokers[0]];
  return null;
}

function followSet(g, size, key, allowPremium) {
  for (let r = 0; r < 13; r++) {
    if (r === RANK_TWO && !allowPremium) break;
    const nats = g.byRank[r];
    if (nats.length >= size) {
      const cards = size === 2 ? [nats[0], nats[nats.length - 1]] : nats.slice(0, 3);
      const cls = classify(cards);
      if (cls.key > key) return { cards, cls };
    }
    const need = size - nats.length;
    if (allowPremium && nats.length && need > 0 && need <= g.jokers.length) {
      const cards = [...nats, ...g.jokers.slice(0, need)];
      const cls = classify(cards);
      if (cls.key > key) return { cards, cls };
    }
  }
  return null;
}

// state: { hands, turn, trick, first } (full or determinised). Returns a
// play { cards, cls } or null for pass.
export function greedyMove(state, rng = Math.random, eps = 0.05) {
  const p = state.turn;
  const hand = state.hands[p];
  const trick = state.trick;
  let minOpp = 99;
  for (let q = 0; q < 4; q++) if (q !== p) minOpp = Math.min(minOpp, state.hands[q].length);
  // Last-card rule: singles must be the highest when the next seat has one card.
  const forcedTop = state.hands[(p + 1) % 4].length === 1;
  const top = hand[hand.length - 1]; // hands are sorted, jokers last
  const topKey = isJoker(top) ? FIRST_JOKER : top;

  if (!trick) {
    if (hand.length <= 5 && hand.length !== 4) {
      const cls = classify(hand);
      if (cls && (!state.first || hand.includes(THREE_OF_DIAMONDS))) return { cards: hand.slice(), cls };
    }
    const g = groups(hand);
    const anchor = state.first ? THREE_OF_DIAMONDS : hand[0];
    if (isJoker(anchor)) return play(hand.slice(0, Math.min(hand.length, 2))); // jokers only
    const m = leadAround(anchor, g);
    // Leading a lone single into a one-card opponent: lead the highest.
    if ((minOpp === 1 || forcedTop) && m.cards.length === 1 && !state.first) return play([top]);
    return m;
  }

  const cls = trick.cls;
  const ownerLow = state.hands[trick.by].length <= 2;
  const allowPremium = ownerLow || minOpp <= 2 || hand.length <= 6 || rng() < 0.25;
  if (!ownerLow && rng() < eps) return null;
  const g = groups(hand);
  if (cls.type === SINGLE) {
    if (forcedTop) return topKey > cls.key ? play([top]) : null;
    const c = followSingle(g, cls.key, allowPremium);
    return c ? play(c) : null;
  }
  if (cls.type === PAIR || cls.type === TRIPLE) {
    return followSet(g, cls.type === PAIR ? 2 : 3, cls.key, allowPremium);
  }
  if (hand.length < 5) return null;
  let best = null;
  for (const m of generatePlays(hand, cls.type)) {
    if (m.cls.key <= cls.key) continue;
    if (!allowPremium && m.cards.some(isJoker)) continue;
    if (!best || m.cls.key < best.cls.key) best = m;
  }
  return best;
}

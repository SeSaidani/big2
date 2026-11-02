// Legal play generation. Plays are generated structurally per category
// (straight windows, flush suits, full-house rank pairs, ...) rather than by
// scanning all 5-subsets, and deduplicated on (natural cards, joker count):
// jokers are interchangeable, so which joker ids are used never matters.

import { isJoker, rankOf, suitOf } from './cards.js';
import { classify, SINGLE, PAIR, TRIPLE, FIVE, WINDOWS } from './hands.js';

export function analyzeHand(hand) {
  const byRank = Array.from({ length: 13 }, () => []);
  const bySuit = [[], [], [], []];
  const jokers = [];
  for (const c of hand) {
    if (isJoker(c)) {
      jokers.push(c);
    } else {
      byRank[rankOf(c)].push(c);
      bySuit[suitOf(c)].push(c);
    }
  }
  return { byRank, bySuit, jokers };
}

function subsets(arr, k, start = 0, prefix = [], out = []) {
  if (prefix.length === k) {
    out.push(prefix.slice());
    return out;
  }
  for (let i = start; i <= arr.length - (k - prefix.length); i++) {
    prefix.push(arr[i]);
    subsets(arr, k, i + 1, prefix, out);
    prefix.pop();
  }
  return out;
}

export function moveKey(cards) {
  let j = 0;
  const nat = [];
  for (const c of cards) {
    if (isJoker(c)) j++;
    else nat.push(c);
  }
  nat.sort((a, b) => a - b);
  return nat.join(',') + '|' + j;
}

class Collector {
  constructor(jokers) {
    this.jokers = jokers;
    this.seen = new Set();
    this.moves = [];
  }

  add(naturals, jokerCount) {
    const cards = naturals.concat(this.jokers.slice(0, jokerCount));
    const key = moveKey(cards);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const cls = classify(cards);
    if (cls) this.moves.push({ cards: cards.sort((a, b) => a - b), cls, key });
  }
}

function genSets(info, col, size) {
  // Singles, pairs and triples: same-rank naturals plus jokers.
  const J = info.jokers.length;
  for (let r = 0; r < 13; r++) {
    const nats = info.byRank[r];
    for (let k = Math.min(J, size - 1); k >= 0; k--) {
      if (nats.length < size - k) continue;
      for (const s of subsets(nats, size - k)) col.add(s, k);
    }
  }
  if (J >= size) col.add([], size);
}

function genStraights(info, col) {
  const J = info.jokers.length;
  for (const w of WINDOWS) {
    const pick = [];
    const rec = (i, used) => {
      if (i === 5) {
        if (pick.length) col.add(pick.slice(), used);
        return;
      }
      for (const c of info.byRank[w.ranks[i]]) {
        pick.push(c);
        rec(i + 1, used);
        pick.pop();
      }
      if (used < J) rec(i + 1, used + 1);
    };
    rec(0, 0);
  }
}

function genFlushes(info, col) {
  const J = Math.min(info.jokers.length, 4);
  for (const nats of info.bySuit) {
    for (let k = 0; k <= J; k++) {
      if (nats.length < 5 - k) continue;
      for (const s of subsets(nats, 5 - k)) col.add(s, k);
    }
  }
}

function genGroups(info, col) {
  // Full houses, four of a kind (+ kicker) and five of a kind.
  const J = info.jokers.length;
  const { byRank } = info;
  const naturals = byRank.flat();
  for (let a = 0; a < 13; a++) {
    const A = byRank[a];
    // Triple of `a` with ka jokers, pair from rank b (or two jokers).
    for (let ka = 0; ka <= Math.min(J, 3); ka++) {
      if (A.length < 3 - ka) continue;
      const triples = 3 - ka === 0 ? [[]] : subsets(A, 3 - ka);
      for (const t of triples) {
        if (ka === 3) {
          // Three jokers as the triple (rank-independent, so emit once).
          if (a !== 0) continue;
          for (let b = 0; b < 13; b++) {
            for (const p of subsets(byRank[b], 2)) col.add(p, 3);
            if (J >= 4) for (const c of byRank[b]) col.add([c], 4);
          }
          continue;
        }
        for (let b = 0; b < 13; b++) {
          if (b === a) continue;
          for (let kb = 0; kb <= Math.min(J - ka, 2); kb++) {
            if (byRank[b].length < 2 - kb) continue;
            if (kb === 2) {
              if (b === (a === 0 ? 1 : 0)) col.add(t, ka + 2); // once only
              continue;
            }
            for (const p of subsets(byRank[b], 2 - kb)) col.add(t.concat(p), ka + kb);
          }
        }
      }
    }
    // Four of a kind of `a` with a kicker.
    // (Four jokers plus a natural is five of a kind, generated below.)
    for (let ka = 0; ka <= Math.min(J, 3); ka++) {
      if (A.length < 4 - ka) continue;
      for (const q of subsets(A, 4 - ka)) {
        for (const c of naturals) if (rankOf(c) !== a) col.add(q.concat([c]), ka);
        if (ka < J && q.length) col.add(q, ka + 1);
      }
    }
    // Five of a kind: at most four naturals exist, so at least one joker.
    for (let ka = Math.max(1, 5 - A.length); ka <= J; ka++) {
      for (const s of subsets(A, 5 - ka)) col.add(s, ka);
    }
  }
}

// All plays of the given type (or every type when type is null).
export function generatePlays(hand, type = null) {
  const info = analyzeHand(hand);
  const col = new Collector(info.jokers);
  if (type === null || type === SINGLE) genSets(info, col, 1);
  if (type === null || type === PAIR) genSets(info, col, 2);
  if (type === null || type === TRIPLE) genSets(info, col, 3);
  if ((type === null || type === FIVE) && hand.length >= 5) {
    genStraights(info, col);
    genFlushes(info, col);
    genGroups(info, col);
  }
  return col.moves;
}

// Plays that are legal from this position: beating `toBeat` if there is a
// trick in progress, including 3♦ on the opening play of the round, and (if
// singleKey >= 0, the last-card rule) singles only of that key.
export function legalPlays(hand, toBeat, mustInclude = -1, singleKey = -1) {
  let plays = generatePlays(hand, toBeat ? toBeat.type : null);
  if (toBeat) plays = plays.filter((m) => m.cls.key > toBeat.key);
  if (mustInclude >= 0) plays = plays.filter((m) => m.cards.includes(mustInclude));
  if (singleKey >= 0) plays = plays.filter((m) => m.cls.type !== SINGLE || m.cls.key === singleKey);
  return plays;
}

export function canBeat(hand, toBeat) {
  return legalPlays(hand, toBeat).length > 0;
}

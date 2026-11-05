// Heuristic agent.
//
// 1. Card counting: everything not in my hand and not yet played is
//    "unseen". From it we bound the strongest single, pair and triple any
//    opponent could hold; a combo at or above that bound is a "control"
//    (nobody can beat it, so it wins the lead back).
// 2. Strength s ∈ [0, 1] per combo, and a cost w = 1 − 0.85·s. A control
//    costs 0.15 (it plays itself out), the weakest combo costs 1.
// 3. Decomposition: the partition of the hand into legal combos minimising
//    Σw, by exact DP over sub-hands. The lowest natural card left must
//    belong to some combo, so we only branch on combos anchored on it;
//    memoised on (natural-card bitmask, jokers left).
// 4. Lead/follow rules use the decomposition, danger from opponents' card
//    counts, and the change in plan cost a play would cause.

import {
  isJoker,
  rankOf,
  suitOf,
  cardId,
  FIRST_JOKER,
  DECK_SIZE,
  RANK_TWO,
  SPADES,
  THREE_OF_DIAMONDS,
} from '../cards.js';
import { classify, baseKey, singleKeyOf, TIE, SINGLE, PAIR, TRIPLE, FOUR_KIND } from '../hands.js';
import { generatePlays, legalPlays, moveKey } from '../moves.js';
import { viewRules, topSingleKey } from '../game.js';

const TWO_OF_SPADES = cardId(RANK_TWO, SPADES);

export function buildContext(view) {
  const known = new Uint8Array(DECK_SIZE);
  for (const c of view.hand) known[c] = 1;
  for (const c of view.played) known[c] = 1;
  const unseenByRank = Array.from({ length: 13 }, () => []);
  let uj = 0;
  const below = new Int32Array(FIRST_JOKER + 2); // below[b] = #unseen singles with base rank < b
  let total = 0;
  for (let c = 0; c < DECK_SIZE; c++) {
    if (known[c]) continue;
    total++;
    if (isJoker(c)) uj++;
    else unseenByRank[rankOf(c)].push(c);
  }
  for (let k = 1; k < below.length; k++) {
    const c = k - 1; // base ranks: naturals are their id, and a joker counts as a 2♠
    let add = 0;
    if (c < FIRST_JOKER) add = known[c] ? 0 : 1;
    if (c === TWO_OF_SPADES) add += uj;
    below[k] = below[k - 1] + add;
  }
  let maxSingle = uj > 0 ? singleKeyOf(FIRST_JOKER) : -1;
  // Strongest pair/triple keys opponents could hold, in classify()'s encoding
  // (base · TIE + natural-card count, so real cards win ties).
  let maxPair = uj >= 2 ? (RANK_TWO * 4 + 3) * TIE : -1;
  let maxTriple = uj >= 3 ? RANK_TWO * TIE : -1;
  for (let r = 0; r < 13; r++) {
    const u = unseenByRank[r];
    if (u.length) maxSingle = Math.max(maxSingle, singleKeyOf(u[u.length - 1]));
    if (u.length >= 2) maxPair = Math.max(maxPair, (r * 4 + suitOf(u[u.length - 1])) * TIE + 2);
    if (u.length >= 1 && uj >= 1) maxPair = Math.max(maxPair, (r * 4 + 3) * TIE + 1);
    if (u.length >= 1 && u.length + uj >= 3) maxTriple = Math.max(maxTriple, r * TIE + Math.min(u.length, 3));
  }
  const n = view.counts.length;
  const opps = Array.from({ length: n - 1 }, (_, i) => (view.me + 1 + i) % n);
  const oppCounts = opps.map((p) => view.counts[p]);
  return {
    total,
    below,
    uj,
    maxSingle,
    maxPair,
    maxTriple,
    opps,
    minOpp: Math.min(...oppCounts),
  };
}

const FIVE_BASE = [0, 0.15, 0.35, 0.55, 0.78, 0.92, 0.97];

export function strength(cls, ctx) {
  switch (cls.type) {
    case SINGLE: {
      if (cls.key >= ctx.maxSingle) return { s: 1, ctl: true };
      return { s: (0.9 * ctx.below[baseKey(cls)]) / Math.max(1, ctx.total), ctl: false };
    }
    case PAIR:
      if (cls.key >= ctx.maxPair) return { s: 1, ctl: true };
      return { s: (0.9 * baseKey(cls)) / 51, ctl: false };
    case TRIPLE:
      if (cls.key >= ctx.maxTriple) return { s: 1, ctl: true };
      return { s: (0.9 * baseKey(cls)) / 12, ctl: false };
    default: {
      const sub = baseKey(cls) % 2_000_000;
      let frac;
      if (cls.cat === 2) {
        frac = Math.floor(sub / (4 * 13 ** 4)) / 12;
      } // flush: top rank
      else if (cls.cat === 1 || cls.cat === 5) {
        frac = Math.floor(sub / 4) / 9;
      } // window
      else frac = sub / 12; // full house / four / five of a kind: rank
      const s = Math.min(1, FIVE_BASE[cls.cat] + 0.12 * frac);
      return { s, ctl: cls.cat >= FOUR_KIND && s >= 0.9 };
    }
  }
}

const lowBit = (x) => 31 - Math.clz32(x & -x);

export class Planner {
  constructor(hand, ctx) {
    this.ctx = ctx;
    this.byLow = new Map();
    this.jokerCost = [0, Infinity, Infinity, Infinity, Infinity];
    const jokerOnly = [];
    for (const m of generatePlays(hand)) {
      const { s, ctl } = strength(m.cls, ctx);
      const e = { ...m, s, ctl, w: 1 - 0.85 * s, lo: 0, hi: 0, j: 0, size: m.cards.length };
      let low = -1;
      for (const c of m.cards) {
        if (isJoker(c)) e.j++;
        else {
          if (c < 32) e.lo |= 1 << c;
          else e.hi |= 1 << (c - 32);
          if (low < 0 || c < low) low = c;
        }
      }
      e.lo >>>= 0;
      e.hi >>>= 0;
      if (low < 0) jokerOnly.push(e);
      else {
        if (!this.byLow.has(low)) this.byLow.set(low, []);
        this.byLow.get(low).push(e);
      }
    }
    // Best split of k leftover jokers into joker-only combos.
    this.jokerPick = [null, null, null, null, null];
    for (let k = 1; k <= 4; k++) {
      for (const e of jokerOnly) {
        if (e.j > k) continue;
        const c = e.w + this.jokerCost[k - e.j];
        if (c < this.jokerCost[k]) {
          this.jokerCost[k] = c;
          this.jokerPick[k] = e;
        }
      }
    }
    this.memo = [new Map(), new Map(), new Map(), new Map(), new Map()];
  }

  static encode(cards) {
    let lo = 0;
    let hi = 0;
    let j = 0;
    for (const c of cards) {
      if (isJoker(c)) j++;
      else if (c < 32) lo |= 1 << c;
      else hi |= 1 << (c - 32);
    }
    return { lo: lo >>> 0, hi: hi >>> 0, j };
  }

  solve(lo, hi, j) {
    if (lo === 0 && hi === 0) return { cost: this.jokerCost[j], pick: null };
    const key = hi * 4294967296 + lo;
    const m = this.memo[j];
    const hit = m.get(key);
    if (hit) return hit;
    const anchor = lo !== 0 ? lowBit(lo) : 32 + lowBit(hi);
    let best = { cost: Infinity, pick: null };
    const list = this.byLow.get(anchor);
    if (list) {
      for (const e of list) {
        if (e.j > j || (e.lo & ~lo) !== 0 || (e.hi & ~hi) !== 0) continue;
        const sub = this.solve((lo & ~e.lo) >>> 0, (hi & ~e.hi) >>> 0, j - e.j);
        const c = e.w + sub.cost;
        if (c < best.cost) best = { cost: c, pick: e };
      }
    }
    m.set(key, best);
    return best;
  }

  cost(cards) {
    const { lo, hi, j } = Planner.encode(cards);
    return this.solve(lo, hi, j).cost;
  }

  plan(cards) {
    let { lo, hi, j } = Planner.encode(cards);
    const combos = [];
    const cost = this.solve(lo, hi, j).cost;
    while (lo !== 0 || hi !== 0) {
      const e = this.solve(lo, hi, j).pick;
      combos.push(e);
      lo = (lo & ~e.lo) >>> 0;
      hi = (hi & ~e.hi) >>> 0;
      j -= e.j;
    }
    while (j > 0) {
      const e = this.jokerPick[j];
      combos.push(e);
      j -= e.j;
    }
    return { cost, combos };
  }
}

const minus = (hand, cards) => hand.filter((c) => !cards.includes(c));
const count = (cards, pred) => cards.reduce((n, c) => n + (pred(c) ? 1 : 0), 0);

function single(c) {
  return { cards: [c], cls: classify([c]), key: moveKey([c]) };
}

function highestSingle(hand) {
  const k = topSingleKey(hand);
  return single(hand.find((c) => singleKeyOf(c) === k));
}

// Lead options, best first; every entry is legal under `rules`.
function rankLeads(view, ctx, planner, rules) {
  const hand = view.hand;
  const { combos } = planner.plan(hand);
  if (view.first) {
    const open = combos.find((e) => e.cards.includes(THREE_OF_DIAMONDS));
    const others = legalPlays(hand, null, THREE_OF_DIAMONDS).filter((m) => m.key !== open.key);
    others.sort((a, b) => b.cards.length - a.cards.length || a.cls.key - b.cls.key);
    return [open, ...others];
  }
  const legal = (m) => m.cards.length !== 1 || rules.singleKey < 0 || m.cls.key === rules.singleKey;
  const danger1 = ctx.minOpp === 1;
  const danger2 = ctx.minOpp === 2;
  const scored = combos.map((e) => {
    let score = e.s - 0.06 * (e.size - 1);
    if (danger1 && e.size === 1 && !e.ctl) score += 2;
    if (danger2 && e.size === 2 && !e.ctl) score += 1;
    if (e.ctl) score += 0.5; // hold controls back while there is weak stuff to shed
    return { e, score };
  });
  scored.sort((a, b) => a.score - b.score);
  const out = [];
  const add = (m) => m && legal(m) && !out.some((x) => x.key === m.key) && out.push(m);
  if (combos.length === 1) add(combos[0]);
  // Run the table: cash controls (keeping the lead), then the last weak combo.
  const ctl = combos.filter((e) => e.ctl);
  if (combos.filter((e) => !e.ctl).length <= 1 && ctl.length) {
    add(ctl.reduce((a, b) => (b.size > a.size || (b.size === a.size && b.cls.key < a.cls.key) ? b : a)));
  }
  // A single led into a one-card opponent (or forced by the last-card rule)
  // should be the highest one we hold.
  if (scored.length && scored[0].e.size === 1 && (danger1 || rules.singleKey >= 0)) add(highestSingle(hand));
  for (const { e } of scored) add(e);
  if (!out.length) add(highestSingle(hand));
  return out;
}

// Follow options, best first, with null (pass) placed by value.
function rankFollows(view, ctx, planner, rules) {
  const hand = view.hand;
  const legal = legalPlays(hand, view.trick.cls, -1, rules.singleKey);
  const base = planner.cost(hand);
  const ownerCount = view.counts[view.trick.by];
  const urgent = ownerCount <= 2 || ctx.minOpp <= 1;
  const handFrac = hand.length / (view.counts.length === 3 ? 18 : 14); // a typical full hand
  const scored = [];
  for (const m of legal) {
    const rest = minus(hand, m.cards);
    if (rest.length === 0) {
      scored.push({ m, val: Infinity });
      continue;
    }
    const { ctl } = strength(m.cls, ctx);
    const gain = base - planner.cost(rest);
    const jk = count(m.cards, isJoker);
    const tw = count(m.cards, (c) => !isJoker(c) && rankOf(c) === RANK_TWO);
    const spend = urgent ? 0 : (0.3 * jk + 0.12 * tw) * handFrac;
    let val = gain - spend + (ctl ? 0.15 : 0);
    if (urgent && ctl) val += 1;
    // Taking control here and then running the rest of the hand wins.
    if (ctl) {
      const after = planner.plan(rest).combos;
      if (after.filter((e) => !e.ctl).length <= 1) val += 2;
    }
    scored.push({ m, val });
  }
  scored.sort((a, b) => b.val - a.val || a.m.cls.key - b.m.cls.key);
  const out = [];
  let passed = false;
  for (const { m, val } of scored) {
    if (!passed && !urgent && val < 0) {
      out.push(null);
      passed = true;
    }
    out.push(m);
  }
  if (!passed) out.push(null);
  return out;
}

// All candidate moves in the heuristic's preference order (null = pass).
export function heuristicRanking(view) {
  const ctx = buildContext(view);
  const planner = new Planner(view.hand, ctx);
  const rules = viewRules(view);
  if (!view.trick) return rankLeads(view, ctx, planner, rules);
  return rankFollows(view, ctx, planner, rules);
}

// Returns { cards, cls } to play, or null to pass.
export function heuristicMove(view) {
  return heuristicRanking(view)[0];
}

// The heuristic as a rollout policy on a full (determinised) state. Each
// player's Planner is built once per rollout from their hand at the start;
// its memo is keyed by sub-hand, so it stays valid as cards are played.
// Combo strengths use the card counting at rollout start (an approximation:
// controls can only get stronger as cards leave play). Only minOpp is
// refreshed per move.
export class HeuristicRollout {
  constructor(state) {
    const inHand = new Uint8Array(DECK_SIZE);
    for (const h of state.hands) for (const c of h) inHand[c] = 1;
    const played = [];
    for (let c = 0; c < DECK_SIZE; c++) if (!inHand[c]) played.push(c);
    const counts = state.hands.map((h) => h.length);
    this.ctx = [];
    this.planners = [];
    for (let p = 0; p < state.hands.length; p++) {
      const ctx = buildContext({ me: p, hand: state.hands[p], played, counts });
      this.ctx.push(ctx);
      this.planners.push(new Planner(state.hands[p], ctx));
    }
  }

  move(s) {
    const p = s.turn;
    const counts = s.hands.map((h) => h.length);
    const view = { me: p, hand: s.hands[p], counts, trick: s.trick, first: s.first, leadPasses: s.leadPasses };
    const base = this.ctx[p];
    const ctx = { ...base, minOpp: Math.min(...base.opps.map((q) => counts[q])) };
    const rules = viewRules(view);
    const ranked = s.trick
      ? rankFollows(view, ctx, this.planners[p], rules)
      : rankLeads(view, ctx, this.planners[p], rules);
    const m = ranked[0];
    if (!m || !m.cards.some(isJoker)) return m;
    // Planner combos carry the joker ids of the starting hand; jokers are
    // interchangeable, so swap in the ones this player still holds.
    const held = s.hands[p].filter(isJoker);
    let k = 0;
    return { ...m, cards: m.cards.map((c) => (isJoker(c) ? held[k++] : c)) };
  }
}

export { minus as removeCards };

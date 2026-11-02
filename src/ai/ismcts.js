// Single-observer Information Set MCTS (Cowling, Powley & Whitehouse 2012),
// used as a policy-improvement step on top of the heuristic.
//
// Each iteration draws a determinisation, a full deal consistent with what
// this player has seen (own hand, every card played, every opponent's card
// count), and descends one shared tree using only moves legal in that
// determinisation. Selection is UCB1 with availability counts:
//   argmax_a  W_a / N_a + c · sqrt( ln A_a / N_a )
// where A_a counts iterations in which `a` was available. Leaves are played
// out with the heuristic policy for every seat (HeuristicRollout); reward is
// 1 to the winner, 0 otherwise, and each node is scored from the viewpoint
// of the player who made its move.
//
// Measured (tools/arena.js, Hard vs 3× Medium, 200 duplicate deals each):
//   greedy rollouts, 1500 iters  27.0% ± 2.6   (4000 iters: 27.3% ± 2.8)
//   heuristic rollouts, 300 iters 33.4% ± 2.6; fresh deals 31.4% ± 2.6
//   heuristic rollouts, 600 iters 32.6% ± 2.5 (fresh deals)
// More greedy iterations did not help: the limit was rollout bias (greedy
// opponents are unlike real ones), not variance.
//
// Root: only the heuristic's top-K moves (plus pass where legal), so the
// budget is not spread over dozens of hopeless five-card leads.
// Decision gate: the heuristic's choice h is kept unless the most-visited
// move b beats it by Z standard errors:
//   q_b − q_h > Z · sqrt( q_b(1−q_b)/n_b + q_h(1−q_h)/n_h ).
// Rollout estimates are biased (greedy opponents), so search should overrule
// the heuristic only when the evidence is clear.
//
// Inference: a pass is evidence that the passer could not (or chose not to)
// beat the trick. Determinisations are importance-weighted by
// Π 0.45 over passes the sampled hand could have beaten, applied by
// rejection sampling. 0.45 not ~0 because strategic passes are common.

import { DECK_SIZE, shuffle } from '../cards.js';
import { applyMove, legalMoves, cloneState, viewRules } from '../game.js';
import { legalPlays, moveKey } from '../moves.js';
import { greedyMove } from './greedy.js';
import { heuristicRanking, HeuristicRollout } from './heuristic.js';

const PASS = { cards: null, cls: null, key: 'P' };
const PASS_LIKELIHOOD = 0.45;
// Near-zero rather than zero so the best-weight fallback still ranks samples
// when rejection sampling runs out of tries.
const AUTO_PASS_LIKELIHOOD = 0.01;

function passEvents(view) {
  const events = [];
  const h = view.history;
  for (let i = 0; i < h.length; i++) {
    const e = h[i];
    if (e.cards || e.p === view.me || !e.trick) continue;
    const later = [];
    for (let k = i + 1; k < h.length; k++) if (h[k].p === e.p && h[k].cards) later.push(...h[k].cards);
    // An automatic pass (autoSkip) proves the player could not beat the
    // trick; a voluntary one is only soft evidence.
    events.push({ p: e.p, cls: e.trick.cls, later, like: e.auto ? AUTO_PASS_LIKELIHOOD : PASS_LIKELIHOOD });
  }
  return events.slice(-16);
}

export function sampleDeterminizations(view, rng, count, tries = 12) {
  const known = new Uint8Array(DECK_SIZE);
  for (const c of view.hand) known[c] = 1;
  for (const c of view.played) known[c] = 1;
  const pool = [];
  for (let c = 0; c < DECK_SIZE; c++) if (!known[c]) pool.push(c);
  const opps = [1, 2, 3].map((d) => (view.me + d) % 4);
  const need = opps.reduce((n, p) => n + view.counts[p], 0);
  if (need !== pool.length) throw new Error(`Unseen ${pool.length} != opponent cards ${need}`);
  const events = passEvents(view);
  const out = [];
  for (let k = 0; k < count; k++) {
    let best = null;
    let bestW = -1;
    for (let t = 0; t < tries; t++) {
      shuffle(pool, rng);
      const hands = [];
      let at = 0;
      for (const p of opps) {
        hands[p] = pool.slice(at, at + view.counts[p]).sort((a, b) => a - b);
        at += view.counts[p];
      }
      let w = 1;
      for (const ev of events) {
        const handThen = ev.later.length ? hands[ev.p].concat(ev.later) : hands[ev.p];
        if (legalPlays(handThen, ev.cls).length) w *= ev.like;
      }
      if (w > bestW) {
        bestW = w;
        best = hands;
      }
      if (rng() < w) break;
    }
    best[view.me] = view.hand.slice();
    out.push({
      hands: best,
      turn: view.me,
      trick: view.trick,
      passed: view.passed.slice(),
      leadPasses: view.leadPasses,
      first: view.first,
      winner: -1,
      played: null,
      history: null,
    });
  }
  return out;
}

const withKey = (m) => (m.key ? m : { ...m, key: moveKey(m.cards) });

// Pruned move set for tree nodes: branching on every five-card lead would
// spread visits too thin to learn anything. (Passing the lead is not
// modelled inside the tree; it is rare and almost always bad.)
function treeCandidates(s, rng) {
  const legal = legalMoves(s);
  const out = new Map();
  const add = (m) => m && !out.has(m.key) && out.set(m.key, m);
  if (s.trick) {
    legal.sort((a, b) => a.cls.key - b.cls.key);
    legal.slice(0, 4).forEach(add);
    if (legal.length) add(legal[legal.length - 1]);
    out.set('P', PASS);
    return [...out.values()];
  }
  const byType = { single: [], pair: [], triple: [], five: [] };
  for (const m of legal) byType[m.cls.type].push(m);
  const keep = { single: 3, pair: 3, triple: 2, five: 4 };
  for (const t in byType) {
    const l = byType[t].sort((a, b) => a.cls.key - b.cls.key);
    l.slice(0, keep[t]).forEach(add);
  }
  if (byType.single.length) add(byType.single[byType.single.length - 1]);
  const g = greedyMove(s, rng, 0);
  if (g) add(withKey(g));
  return [...out.values()];
}

function rootCandidates(view, topK) {
  const ranking = heuristicRanking(view);
  const out = new Map();
  for (const m of ranking.slice(0, topK)) {
    const e = m ? withKey(m) : PASS;
    out.set(e.key, e);
  }
  if (viewRules(view).canPass) out.set('P', PASS);
  const h = ranking[0];
  return { moves: [...out.values()], heuristic: h ? withKey(h).key : 'P' };
}

class Node {
  constructor(parent, move, player) {
    this.parent = parent;
    this.move = move;
    this.player = player;
    this.children = new Map();
    this.n = 0;
    this.w = 0;
    this.avail = 1;
  }
}

const apply = (s, m) => applyMove(s, m.cards, m.cls);

export function ismctsMove(view, opts = {}) {
  const {
    iterations = 4000,
    timeMs = Infinity,
    rng = Math.random,
    c = 0.7,
    determinizations = 96,
    topK = 6,
    gateZ = 1.5,
    rollout = 'heuristic',
  } = opts;
  const { moves: rootMoves, heuristic } = rootCandidates(view, topK);
  if (rootMoves.length === 1) return rootMoves[0].cards ? rootMoves[0] : null;
  const dets = sampleDeterminizations(view, rng, determinizations);
  const root = new Node(null, null, -1);
  const start = Date.now();
  let it = 0;
  for (; it < iterations; it++) {
    if ((it & 15) === 0 && Date.now() - start > timeMs) break;
    const s = cloneState(dets[it % dets.length]);
    let node = root;
    while (s.winner < 0) {
      const moves = node === root ? rootMoves : treeCandidates(s, rng);
      const fresh = [];
      for (const m of moves) {
        const ch = node.children.get(m.key);
        if (ch) ch.avail++;
        else fresh.push(m);
      }
      if (fresh.length) {
        const m = fresh[Math.floor(rng() * fresh.length)];
        const child = new Node(node, m, s.turn);
        node.children.set(m.key, child);
        apply(s, m);
        node = child;
        break;
      }
      // Apply this determinisation's own move: a child is keyed by naturals
      // plus joker count, but the joker ids held can differ between deals.
      let best = null;
      let bestMove = null;
      let bestU = -Infinity;
      for (const m of moves) {
        const ch = node.children.get(m.key);
        const u = ch.w / ch.n + c * Math.sqrt(Math.log(ch.avail) / ch.n);
        if (u > bestU) {
          bestU = u;
          best = ch;
          bestMove = m;
        }
      }
      apply(s, bestMove);
      node = best;
    }
    let guard = 0;
    const policy = rollout === 'heuristic' && s.winner < 0 ? new HeuristicRollout(s) : null;
    while (s.winner < 0) {
      const m = policy ? policy.move(s) : greedyMove(s, rng);
      if (m) applyMove(s, m.cards, m.cls);
      else applyMove(s, null);
      if (++guard > 500) throw new Error('Rollout did not terminate');
    }
    for (let n = node; n; n = n.parent) {
      n.n++;
      if (n.player === s.winner) n.w++;
    }
  }
  let best = null;
  for (const ch of root.children.values()) if (!best || ch.n > best.n) best = ch;
  const h = root.children.get(heuristic);
  if (h && best !== h) {
    const qb = best.w / best.n;
    const qh = h.w / h.n;
    const se = Math.sqrt((qb * (1 - qb)) / best.n + (qh * (1 - qh)) / h.n) || 1;
    if (qb - qh < gateZ * se) best = h;
  }
  if (opts.onStats) {
    const stats = [...root.children.values()]
      .map((ch) => ({ key: ch.move.key, n: ch.n, q: ch.n ? ch.w / ch.n : 0 }))
      .sort((a, b) => b.n - a.n);
    opts.onStats({ iterations: it, stats, heuristic, chosen: best.move.key });
  }
  return best.move.cards ? best.move : null;
}

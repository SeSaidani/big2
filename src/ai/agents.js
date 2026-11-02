// One entry point for every AI level. Agents only ever receive a view
// (observe()), never the other players' hands.

import { greedyMove } from './greedy.js';
import { heuristicMove } from './heuristic.js';
import { ismctsMove } from './ismcts.js';
import { legalPlays } from '../moves.js';
import { viewRules } from '../game.js';

export const LEVELS = ['easy', 'medium', 'hard'];

function viewAsState(view) {
  const hands = view.counts.map((n, p) => (p === view.me ? view.hand : new Array(n).fill(-1)));
  return { hands, turn: view.me, trick: view.trick, first: view.first };
}

export function randomMove(view, rng = Math.random) {
  const r = viewRules(view);
  const legal = legalPlays(view.hand, view.trick ? view.trick.cls : null, r.mustInclude, r.singleKey);
  if (view.trick && (legal.length === 0 || rng() < 0.3)) return null;
  if (!view.trick && r.canPass && rng() < 0.15) return null; // passes the lead
  return legal[Math.floor(rng() * legal.length)];
}

// Returns { cards, cls } or null (pass).
export function chooseMove(view, level, opts = {}) {
  const rng = opts.rng || Math.random;
  switch (level) {
    case 'random':
      return randomMove(view, rng);
    case 'easy':
      return greedyMove(viewAsState(view), rng, 0.15);
    case 'medium':
      return heuristicMove(view);
    case 'hard':
      return ismctsMove(view, {
        rng,
        // 300 and 600 iterations are both validated against Medium (see
        // ismcts.js); the time limit protects slower machines.
        timeMs: opts.timeMs ?? 900,
        iterations: opts.iterations ?? 600,
        topK: opts.topK,
        gateZ: opts.gateZ,
        rollout: opts.rollout,
        onStats: opts.onStats,
      });
    default:
      throw new Error(`Unknown level ${level}`);
  }
}

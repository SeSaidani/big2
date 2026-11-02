// Headless tournament: agent A in one seat vs three copies of agent B.
//
// Duplicate format: every deal is replayed four times with A rotated through
// all seats, so luck of the cards cancels to first order. The four results
// of a deal are correlated, so the standard error is computed from per-deal
// means (cluster SE), not from the 4D individual games:
//   p̂ = mean_d x̄_d,   SE = sd(x̄_d) / sqrt(D),   95% CI ≈ p̂ ± 1.96·SE.
// Null hypothesis (A no better than B): p = 0.25.
//
// Deal d and its games are seeded from (seed, d) alone, so results do not
// depend on how deals are split across worker threads.
//
// Usage: node tools/arena.js --a hard --b medium --deals 100 --iters 1500 --workers 16
//        (extra agent options: --topK 6 --gateZ 1.5)

import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mulberry32, dealHands } from '../src/cards.js';
import { newGame, applyMove, autoSkip, observe, validatePlay, checkInvariants } from '../src/game.js';
import { chooseMove } from '../src/ai/agents.js';

function args() {
  const out = { a: 'medium', b: 'easy', deals: 100, iters: 1500, seed: 1, workers: 1 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  for (const k of ['deals', 'iters', 'seed', 'workers', 'topK', 'gateZ']) {
    if (out[k] !== undefined) out[k] = Number(out[k]);
  }
  out.workers = Math.max(1, Math.min(out.workers, os.availableParallelism(), out.deals));
  return out;
}

function playGame(hands, levels, rng, opts, timing) {
  const s = newGame(rng, hands);
  let steps = 0;
  while (s.winner < 0) {
    const level = levels[s.turn];
    const t0 = performance.now();
    const m = chooseMove(observe(s, s.turn), level, {
      rng,
      iterations: opts.iters,
      timeMs: Infinity,
      topK: opts.topK,
      gateZ: opts.gateZ,
      rollout: opts.rollout,
    });
    const dt = performance.now() - t0;
    (timing[level] ||= { ms: 0, n: 0 }).ms += dt;
    timing[level].n++;
    const cards = m ? m.cards : null;
    const err = validatePlay(s, cards);
    if (err) throw new Error(`${level} made an illegal move: ${err} (${cards})`);
    applyMove(s, cards, m ? m.cls : null);
    if (cards) autoSkip(s); // as in the browser game
    if (++steps > 1000) throw new Error('Game did not terminate');
  }
  checkInvariants(s);
  return s.winner;
}

function runDeals(opts, dealIdx, onDeal) {
  const timing = {};
  for (const d of dealIdx) {
    const hands = dealHands(mulberry32(opts.seed * 1000003 + d));
    let wins = 0;
    for (let seat = 0; seat < 4; seat++) {
      const levels = [opts.b, opts.b, opts.b, opts.b];
      levels[seat] = opts.a;
      const rng = mulberry32((opts.seed * 7919 + d) * 4 + seat);
      if (playGame(hands, levels, rng, opts, timing) === seat) wins++;
    }
    onDeal(d, wins / 4);
  }
  return timing;
}

function report(opts, perDeal, timing, t0) {
  const D = perDeal.length;
  const mean = perDeal.reduce((x, y) => x + y, 0) / D;
  const sd = Math.sqrt(perDeal.reduce((x, y) => x + (y - mean) ** 2, 0) / (D - 1));
  const se = sd / Math.sqrt(D);
  const z = (mean - 0.25) / se;
  console.log(`A=${opts.a} vs 3×B=${opts.b}  deals=${D} games=${4 * D}  iters=${opts.iters}`);
  console.log(
    `A win rate ${(100 * mean).toFixed(1)}% ± ${(196 * se).toFixed(1)} (95% CI), null 25%, z=${z.toFixed(2)}`,
  );
  for (const [k, v] of Object.entries(timing)) {
    console.log(`  ${k}: ${(v.ms / v.n).toFixed(2)} ms/move over ${v.n} moves`);
  }
  console.log(`  wall ${(Date.now() - t0) / 1000}s`);
}

if (isMainThread) {
  const opts = args();
  const t0 = Date.now();
  const perDeal = [];
  const timing = {};
  const merge = (t) => {
    for (const [k, v] of Object.entries(t)) {
      timing[k] ||= { ms: 0, n: 0 };
      timing[k].ms += v.ms;
      timing[k].n += v.n;
    }
  };
  const progress = () => {
    if (perDeal.length % 10 === 0) {
      const m = perDeal.reduce((x, y) => x + y, 0) / perDeal.length;
      process.stderr.write(`  ${perDeal.length}/${opts.deals} deals, A win rate so far ${(100 * m).toFixed(1)}%\n`);
    }
  };
  const all = Array.from({ length: opts.deals }, (_, d) => d);
  if (opts.workers === 1) {
    merge(
      runDeals(opts, all, (d, x) => {
        perDeal.push(x);
        progress();
      }),
    );
    report(opts, perDeal, timing, t0);
  } else {
    let done = 0;
    for (let w = 0; w < opts.workers; w++) {
      const mine = all.filter((d) => d % opts.workers === w);
      const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { opts, deals: mine } });
      worker.on('message', (msg) => {
        if (msg.type === 'deal') {
          perDeal.push(msg.x);
          progress();
        } else if (msg.type === 'done') {
          merge(msg.timing);
          if (++done === opts.workers) report(opts, perDeal, timing, t0);
        }
      });
      worker.on('error', (err) => {
        console.error(err);
        process.exit(1);
      });
    }
  }
} else {
  const { opts, deals } = workerData;
  const timing = runDeals(opts, deals, (d, x) => parentPort.postMessage({ type: 'deal', d, x }));
  parentPort.postMessage({ type: 'done', timing });
}

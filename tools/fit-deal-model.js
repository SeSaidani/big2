// Fits the deal model offline and writes it, with a report, into the repository.
//
//   node tools/fit-deal-model.js --players 4 --train 40000 --test 10000 --workers 8
//   node tools/fit-deal-model.js --players 3 --train 20000 --test 6000 --workers 8
//   (--save-data FILE keeps the simulated games; --load-data FILE refits from them; --out DIR for the JSON;
//    --report FILE writes this size's report section as markdown)
//
// The reference player. Every seat is played by the Medium AI, from random deals, to the end. The model
// therefore describes how Medium-style play fares from a dealt hand, not how any person plays.
//
// Honest validation. Games are seeded from their number alone. Models are fitted on games 1..train and
// scored on games 10,000,001.. (a disjoint range), so no game, and no deal, is in both sets.
//
// Simple first. Three models are compared on the held-out games by multiclass log-loss (nats per game):
//   uniform  P = 1/n                          (the baseline: no information)
//   counts   conditional logit on 2s, aces, jokers
//   full     conditional logit on every feature in features.js
// The richer model is shipped only if it beats the simple one by more than three paired standard errors
// and by at least 0.002 nats per game; otherwise the simple one is shipped. Both rules are written down
// here before any result is seen.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mulberry32, dealHands } from '../src/cards.js';
import { newGame, applyMove, autoSkip, observe } from '../src/game.js';
import { chooseMove } from '../src/ai/agents.js';
import { scoreRound } from '../src/scoring.js';
import { isMain } from '../server/main-module.js';
import { predictDeal } from '../src/stats/deal-model.js';
import { FEATURES, FEATURE_SETS, dealFeatures } from '../src/stats/features.js';
import {
  fitWinModel,
  winProbabilities,
  fitPointsModel,
  expectedPoints,
  perGameLogLoss,
  uniformProbs,
  meanAndSe,
  brier,
  calibration,
  pointsR2,
} from '../src/stats/model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_SEED_BASE = 10_000_000;
const LAMBDA = 1; // the ridge penalty on standardised weights; negligible next to tens of thousands of games
const MIN_GAIN = 0.002; // nats per game the richer model must add ...
const MIN_Z = 3; // ... and by how many paired standard errors

// ---- simulation ----

export function simulateGame(seed, players) {
  const hands = dealHands(mulberry32(seed), players);
  const x = dealFeatures(hands);
  const s = newGame(() => 0, hands);
  for (let steps = 0; s.winner < 0; steps++) {
    if (steps > 3000) throw new Error(`game ${seed} did not finish`);
    const m = chooseMove(observe(s, s.turn), 'medium');
    applyMove(s, m ? m.cards : null, m ? m.cls : null);
    if (m) autoSkip(s);
  }
  const r = scoreRound(s);
  return { x, winner: s.winner, delta: r.delta };
}

function simulateRange(seeds, players) {
  return seeds.map((seed) => simulateGame(seed, players));
}

async function simulate(seeds, players, workers) {
  if (workers <= 1) return simulateRange(seeds, players);
  const chunks = Array.from({ length: workers }, (_, w) => seeds.filter((_, i) => i % workers === w));
  const parts = await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise((resolve, reject) => {
          const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { seeds: chunk, players } });
          worker.once('message', resolve);
          worker.once('error', reject);
        }),
    ),
  );
  // Put the games back in seed order, so the result does not depend on the number of workers.
  const bySeed = new Map();
  parts.forEach((games, w) => games.forEach((g, i) => bySeed.set(chunks[w][i], g)));
  return seeds.map((s) => bySeed.get(s));
}

// ---- fitting and measuring ----

const project = (games, names) => {
  const idx = names.map((n) => FEATURES.indexOf(n));
  return games.map((g) => ({ ...g, x: g.x.map((v) => idx.map((i) => v[i])) }));
};

const f4 = (v) => v.toFixed(4);
const pm = (e) => `${f4(e.mean)} ± ${f4(1.96 * e.se)}`;

function analyse(players, train, test) {
  const n = players;
  const sets = {};
  for (const [name, names] of Object.entries(FEATURE_SETS)) {
    const model = fitWinModel(project(train, names), { lambda: LAMBDA });
    const testP = project(test, names);
    sets[name] = { names, model, testP, probsOf: (g) => winProbabilities(model, g.x) };
  }
  const loss = {
    uniform: perGameLogLoss(test, uniformProbs),
    counts: perGameLogLoss(sets.counts.testP, sets.counts.probsOf),
    full: perGameLogLoss(sets.full.testP, sets.full.probsOf),
  };
  const gain = (a, b) => meanAndSe(loss[a].map((v, i) => v - loss[b][i])); // positive: b is better
  const comparisons = {
    'counts vs uniform': gain('uniform', 'counts'),
    'full vs counts': gain('counts', 'full'),
    'full vs uniform': gain('uniform', 'full'),
  };
  const fullGain = comparisons['full vs counts'];
  const chosen = fullGain.mean >= MIN_GAIN && fullGain.mean / fullGain.se >= MIN_Z ? 'full' : 'counts';
  const win = sets[chosen];

  // Points: ridge on the chosen features, relative to the table.
  const pointsModel = fitPointsModel(project(train, win.names), win.model.scaler, { lambda: LAMBDA });
  const pointsOf = (g) => expectedPoints(pointsModel, win.model.scaler, g.x);
  const r2 = pointsR2(win.testP, pointsOf);

  // Does the seat that opens (holds the 3 of diamonds) win more than its share?
  const li = FEATURES.indexOf('holdsLead');
  const openerWins = test.filter((g) => g.x[g.winner][li] === 1).length;
  const opener = {
    rate: openerWins / test.length,
    se: Math.sqrt(((1 / n) * (1 - 1 / n)) / test.length),
    games: test.length,
  };

  const bins = calibration(win.testP, win.probsOf, 8);
  return {
    players,
    chosen,
    comparisons,
    loss: Object.fromEntries(Object.entries(loss).map(([k, v]) => [k, meanAndSe(v)])),
    brier: {
      uniform: brier(test, uniformProbs),
      chosen: brier(win.testP, win.probsOf),
    },
    r2,
    opener,
    bins,
    win,
    pointsModel,
    pointsRaw: {
      sdDelta: Math.sqrt(test.reduce((s, g) => s + g.delta.reduce((a, d) => a + d * d, 0), 0) / (test.length * n)),
    },
    trainGames: train.length,
    testGames: test.length,
  };
}

// ---- output ----

function modelJson(a) {
  const { win, pointsModel } = a;
  const se = win.model.covariance.map((row, k) => Math.sqrt(row[k]));
  const model = {
    players: a.players,
    reference: 'Medium AI at every seat, random deals',
    featureSet: a.chosen,
    features: win.names,
    scaler: win.model.scaler,
    win: { weights: win.model.weights, se, lambda: LAMBDA },
    points: { weights: pointsModel.weights, lambda: LAMBDA },
    fit: { trainGames: a.trainGames, testGames: a.testGames, testSeedBase: TEST_SEED_BASE },
    heldOut: {
      logLoss: { uniform: a.loss.uniform.mean, chosen: a.loss[a.chosen].mean },
      brier: { uniform: a.brier.uniform.mean, chosen: a.brier.chosen.mean },
      pointsR2: a.r2,
      openerWinRate: a.opener.rate,
    },
  };
  // A few fixed deals with the predictions this exact file gives them. A test recomputes them, so any
  // change to the features or to how a model is applied, without a refit, is caught exactly.
  model.reference = [1, 2, 3, 4, 5].map((seed) => ({
    seed,
    ...predictDeal(model, dealHands(mulberry32(seed), a.players)),
  }));
  return model;
}

function reportSection(a) {
  const n = a.players;
  const lines = [];
  lines.push(`## ${n} players`, '');
  lines.push(
    `Fitted on ${a.trainGames.toLocaleString('en-GB')} games and scored on ${a.testGames.toLocaleString('en-GB')} different ones.`,
    '',
    '### Who wins: held-out log-loss (nats per game; lower is better)',
    '',
    '| model | log-loss ± 95% | Brier ± 95% |',
    '| --- | --- | --- |',
    `| uniform (1/${n}) | ${pm(a.loss.uniform)} | ${pm(a.brier.uniform)} |`,
    `| counts (2s, aces, jokers) | ${pm(a.loss.counts)} | |`,
    `| full (${FEATURES.length} features) | ${pm(a.loss.full)} | ${a.chosen === 'full' ? pm(a.brier.chosen) : ''} |`,
    '',
    'Paired improvements (the same games scored by both models):',
    '',
    ...Object.entries(a.comparisons).map(
      ([k, e]) => `- ${k}: ${pm(e)} nats per game (${(e.mean / e.se).toFixed(1)} standard errors)`,
    ),
    '',
    `Rule fixed in advance: ship the full model only if it beats counts by at least ${MIN_GAIN} nats and ${MIN_Z} standard errors. **Shipped: ${a.chosen}.**`,
    '',
    '### Weights of the shipped model (per standard deviation of the feature; ± 1.96 standard errors)',
    '',
    '| feature | weight |',
    '| --- | --- |',
    ...a.win.names.map(
      (name, k) =>
        `| ${name} | ${f4(a.win.model.weights[k])} ± ${f4(1.96 * Math.sqrt(a.win.model.covariance[k][k]))} |`,
    ),
    '',
    '### Calibration of the shipped model on held-out games',
    '',
    'Seats sorted by predicted chance and cut into eight equal groups:',
    '',
    '| predicted | observed | ± 1.96 se | seats |',
    '| --- | --- | --- | --- |',
    ...a.bins.map((b) => `| ${f4(b.predicted)} | ${f4(b.observed)} | ${f4(1.96 * b.se)} | ${b.n} |`),
    '',
    '### The seat that opens (holds the 3 of diamonds)',
    '',
    `It won ${(100 * a.opener.rate).toFixed(1)}% of ${a.opener.games.toLocaleString('en-GB')} held-out games, against ${(100 / n).toFixed(1)}% if the seat did not matter (± ${(196 * a.opener.se).toFixed(1)} points, 95%).`,
    '',
    '### Points',
    '',
    `Expected points from the shipped features, relative to the table, explain R² = ${f4(a.r2)} of the variation in a seat's points on held-out games (the baseline of 0 for everyone scores R² = 0; the typical size of a seat's result is ${a.pointsRaw.sdDelta.toFixed(1)} points). The rest comes from the other hands and the course of play.`,
    '',
  );
  return lines.join('\n');
}

// ---- main ----

function args() {
  const out = {
    players: '4',
    train: 40000,
    test: 10000,
    workers: Math.max(1, os.availableParallelism() - 1),
    out: path.join(ROOT, 'src', 'stats'),
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    out[argv[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[i + 1];
  }
  for (const k of ['train', 'test', 'workers']) out[k] = Number(out[k]);
  return out;
}

async function main() {
  const a = args();
  const players = Number(a.players);
  if (![3, 4].includes(players)) throw new Error('--players must be 3 or 4');
  let train;
  let test;
  if (a.loadData) {
    ({ train, test } = JSON.parse(fs.readFileSync(a.loadData, 'utf8')));
    console.log(`Loaded ${train.length} training and ${test.length} test games from ${a.loadData}`);
  } else {
    const t0 = performance.now();
    train = await simulate(
      Array.from({ length: a.train }, (_, i) => i + 1),
      players,
      a.workers,
    );
    test = await simulate(
      Array.from({ length: a.test }, (_, i) => TEST_SEED_BASE + i + 1),
      players,
      a.workers,
    );
    console.log(
      `Simulated ${train.length + test.length} games in ${((performance.now() - t0) / 1000).toFixed(0)} s on ${a.workers} workers`,
    );
    if (a.saveData) fs.writeFileSync(a.saveData, JSON.stringify({ train, test }));
  }
  const result = analyse(players, train, test);
  fs.mkdirSync(a.out, { recursive: true });
  const file = path.join(a.out, `deal-model-${players}.json`);
  fs.writeFileSync(file, JSON.stringify(modelJson(result), null, 2) + '\n');
  console.log(`Wrote ${path.relative(ROOT, file)}`);
  if (a.report) {
    fs.writeFileSync(a.report, reportSection(result));
    console.log(`Wrote the report section to ${a.report}`);
  }
  console.log(reportSection(result));
}

if (isMainThread && isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (!isMainThread) {
  parentPort.postMessage(simulateRange(workerData.seeds, workerData.players));
}

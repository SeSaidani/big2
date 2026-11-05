import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mulberry32, dealHands } from '../src/cards.js';
import { FEATURE_SETS } from '../src/stats/features.js';
import { predictDeal } from '../src/stats/deal-model.js';
import { simulateGame } from '../tools/fit-deal-model.js';

// The saved models are data files fitted by tools/fit-deal-model.js. These tests keep them from going
// stale: if the features, their order, or the model code change without a refit, they fail.
const load = (players) =>
  JSON.parse(fs.readFileSync(new URL(`../src/stats/deal-model-${players}.json`, import.meta.url), 'utf8'));
const FRESH_SEED_BASE = 20_000_000; // outside both the training and the held-out seed ranges

for (const players of [3, 4]) {
  test(`the saved ${players}-player model is well formed and matches the feature code`, () => {
    const m = load(players);
    assert.equal(m.players, players);
    assert.deepEqual(m.features, FEATURE_SETS[m.featureSet], 'its columns are the ones features.js produces');
    const d = m.features.length;
    for (const v of [m.scaler.mean, m.scaler.sd, m.win.weights, m.win.se, m.points.weights]) {
      assert.equal(v.length, d);
      assert.ok(v.every(Number.isFinite));
    }
    assert.ok(m.scaler.sd.every((s) => s > 0));
    assert.ok(
      m.win.se.every((s) => s > 0 && s < 0.05),
      'weights are pinned down by the data',
    );
    assert.ok(m.fit.trainGames >= 20000 && m.fit.testGames >= 5000, 'fitted on a real sample');
    assert.ok(
      m.heldOut.logLoss.chosen < m.heldOut.logLoss.uniform - 0.1,
      'it beat the uniform guess on held-out games',
    );
    assert.ok(m.fit.testSeedBase >= 10_000_000);
  });

  test(`the saved ${players}-player model gives exactly the stored predictions for its reference deals`, () => {
    const m = load(players);
    assert.equal(m.reference.length, 5);
    for (const r of m.reference) {
      const p = predictDeal(m, dealHands(mulberry32(r.seed), players));
      p.winProbabilities.forEach((v, i) =>
        assert.ok(Math.abs(v - r.winProbabilities[i]) < 1e-9, `seed ${r.seed} seat ${i}`),
      );
      p.expectedPoints.forEach((v, i) =>
        assert.ok(Math.abs(v - r.expectedPoints[i]) < 1e-9, `seed ${r.seed} seat ${i}`),
      );
    }
  });

  test(`predictions for ${players} players add up: probabilities to 1, points to 0`, () => {
    const m = load(players);
    for (let seed = 1; seed <= 30; seed++) {
      const p = predictDeal(m, dealHands(mulberry32(seed), players));
      assert.equal(p.winProbabilities.length, players);
      assert.ok(Math.abs(p.winProbabilities.reduce((s, v) => s + v) - 1) < 1e-9);
      assert.ok(Math.abs(p.expectedPoints.reduce((s, v) => s + v)) < 1e-6);
      assert.ok(p.winProbabilities.every((v) => v > 0 && v < 1));
    }
    assert.throws(() => predictDeal(m, dealHands(mulberry32(1), players === 4 ? 3 : 4)), /not/);
  });

  test(`the saved ${players}-player model still predicts fresh games as well as it did on held-out ones`, () => {
    const m = load(players);
    const games = players === 4 ? 400 : 120;
    let loss = 0;
    for (let i = 1; i <= games; i++) {
      const seed = FRESH_SEED_BASE + i;
      const p = predictDeal(m, dealHands(mulberry32(seed), players)).winProbabilities;
      loss += -Math.log(p[simulateGame(seed, players).winner]) / games;
    }
    const uniform = Math.log(players);
    const minGain = players === 4 ? 0.15 : 0.1; // the held-out gain is 0.39 and 0.28; this is many standard errors below
    assert.ok(uniform - loss > minGain, `log-loss ${loss.toFixed(3)} against uniform ${uniform.toFixed(3)}`);
    assert.ok(
      Math.abs(loss - m.heldOut.logLoss.chosen) < (players === 4 ? 0.2 : 0.3),
      `${loss} vs ${m.heldOut.logLoss.chosen}`,
    );
  });
}

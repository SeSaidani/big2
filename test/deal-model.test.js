import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, dealHands, cardId, THREE_OF_DIAMONDS, FIRST_JOKER } from '../src/cards.js';
import { FEATURES, handFeatures, dealFeatures } from '../src/stats/features.js';
import {
  solveSpd,
  inverseSpd,
  softmax,
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

const RANK = { 3: 0, 4: 1, 5: 2, 6: 3, 7: 4, 8: 5, 9: 6, 10: 7, J: 8, Q: 9, K: 10, A: 11, 2: 12 };
const card = (rank, suit) => cardId(RANK[rank], suit);

// Seeded standard normal numbers.
function normals(seed) {
  const rng = mulberry32(seed);
  return () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}

// Synthetic tables where the true answer is known: seat scores are w . x and the winner is drawn from the softmax.
function syntheticGames(n, seats, trueW, seed) {
  const gauss = normals(seed);
  const rng = mulberry32(seed + 1);
  return Array.from({ length: n }, () => {
    const x = Array.from({ length: seats }, () => trueW.map(() => gauss()));
    const p = softmax(x.map((r) => r.reduce((s, v, k) => s + v * trueW[k], 0)));
    let u = rng();
    let winner = 0;
    while (winner < seats - 1 && u > p[winner]) u -= p[winner++];
    return { x, winner };
  });
}

test('the linear algebra solves and inverts, and refuses a matrix that is not positive definite', () => {
  const A = [
    [4, 1, 0],
    [1, 3, 1],
    [0, 1, 2],
  ];
  const x = solveSpd(A, [1, 2, 3]);
  const back = A.map((row) => row.reduce((s, v, k) => s + v * x[k], 0));
  back.forEach((v, i) => assert.ok(Math.abs(v - [1, 2, 3][i]) < 1e-12));
  const inv = inverseSpd(A);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const v = A[i].reduce((s, a, k) => s + a * inv[k][j], 0);
      assert.ok(Math.abs(v - (i === j ? 1 : 0)) < 1e-12);
    }
  }
  assert.throws(
    () =>
      solveSpd(
        [
          [1, 2],
          [2, 1],
        ],
        [1, 1],
      ),
    /positive definite/,
  );
});

test('softmax adds up to 1 and survives huge scores', () => {
  assert.ok(Math.abs(softmax([1, 2, 3, 4]).reduce((s, v) => s + v) - 1) < 1e-12);
  const big = softmax([1000, 1001, 999]);
  assert.ok(big.every(Number.isFinite) && Math.abs(big.reduce((s, v) => s + v) - 1) < 1e-12);
});

test('the win model recovers known weights, within its own error bars', () => {
  const trueW = [0.9, -0.6, 0];
  const games = syntheticGames(8000, 4, trueW, 11);
  const model = fitWinModel(games, { lambda: 0.01 });
  trueW.forEach((w, k) => {
    const se = Math.sqrt(model.covariance[k][k]);
    assert.ok(se > 0 && se < 0.05, `se ${se}`);
    assert.ok(Math.abs(model.weights[k] - w) < 4 * se, `weight ${k}: ${model.weights[k]} vs ${w} (se ${se})`);
  });
});

test('win probabilities add up to 1 per game, favour the better hand, and beat the uniform guess on new games', () => {
  const trueW = [0.9, -0.6];
  const model = fitWinModel(syntheticGames(6000, 4, trueW, 21), { lambda: 0.01 });
  const test = syntheticGames(6000, 4, trueW, 99); // a different seed: games the model has never seen
  const probsOf = (g) => winProbabilities(model, g.x);
  for (const g of test.slice(0, 50)) {
    const p = probsOf(g);
    assert.ok(Math.abs(p.reduce((s, v) => s + v) - 1) < 1e-12);
  }
  const strong = winProbabilities(model, [
    [2, -2],
    [0, 0],
    [0, 0],
    [0, 0],
  ]);
  assert.ok(strong[0] > 0.5 && strong[0] > strong[1]);

  const uniform = perGameLogLoss(test, uniformProbs);
  assert.ok(Math.abs(meanAndSe(uniform).mean - Math.log(4)) < 1e-12, 'the uniform guess scores ln 4');
  const fitted = perGameLogLoss(test, probsOf);
  const diff = meanAndSe(uniform.map((u, i) => u - fitted[i]));
  assert.ok(diff.mean > 4 * diff.se, `the model should clearly beat the uniform guess: ${diff.mean} +- ${diff.se}`);
  assert.ok(brier(test, probsOf).mean < brier(test, uniformProbs).mean);
});

test('the win model is calibrated on new games', () => {
  const trueW = [0.9, -0.6];
  const model = fitWinModel(syntheticGames(8000, 4, trueW, 31), { lambda: 0.01 });
  const test = syntheticGames(8000, 4, trueW, 77);
  const bins = calibration(test, (g) => winProbabilities(model, g.x), 6);
  assert.equal(bins.length, 6);
  for (const b of bins) {
    assert.ok(Math.abs(b.observed - b.predicted) < 4 * b.se + 0.01, `${b.predicted} vs ${b.observed} (se ${b.se})`);
  }
});

test('a feature that carries no information gets a weight near zero', () => {
  const games = syntheticGames(8000, 4, [0.8, 0], 41);
  const model = fitWinModel(games, { lambda: 0.01 });
  assert.ok(Math.abs(model.weights[1]) < 4 * Math.sqrt(model.covariance[1][1]));
});

test('expected points add up to zero for any table, and the points model finds a real effect', () => {
  const gauss = normals(5);
  const games = Array.from({ length: 4000 }, () => {
    const x = Array.from({ length: 4 }, () => [gauss(), gauss()]);
    const mean = [0, 1].map((k) => x.reduce((s, r) => s + r[k], 0) / 4);
    // Points depend on how strong a seat is against the table, plus noise; they sum to zero.
    const raw = x.map((r) => 10 * (r[0] - mean[0]) + gauss() * 8);
    const m = raw.reduce((s, v) => s + v, 0) / 4;
    return { x, winner: 0, delta: raw.map((v) => v - m) };
  });
  const own = { mean: [0, 0], sd: [1, 1] };
  const model = fitPointsModel(games, own, { lambda: 1 });
  assert.ok(model.weights[0] > 8 && model.weights[0] < 12, `weight ${model.weights[0]}`);
  assert.ok(Math.abs(model.weights[1]) < 1);
  for (const g of games.slice(0, 20)) {
    assert.ok(Math.abs(expectedPoints(model, own, g.x).reduce((s, v) => s + v, 0)) < 1e-9);
  }
  assert.ok(pointsR2(games, (g) => expectedPoints(model, own, g.x)) > 0.3);
});

test('hand features count what they say', () => {
  const hand = [
    card('2', 3),
    card('2', 2),
    card('A', 0),
    card('K', 1),
    card('K', 2),
    card('K', 3),
    card('9', 0),
    card('9', 1),
    card('3', 0),
    card('4', 1),
    card('8', 2),
    FIRST_JOKER,
    FIRST_JOKER + 1,
    card('Q', 0),
  ];
  const f = Object.fromEntries(
    FEATURES.map((name, i) => [name, handFeatures(hand, { planCost: 5.5, holdsLead: true })[i]]),
  );
  assert.deepEqual(f, {
    twos: 2,
    aces: 1,
    kings: 3,
    jokers: 2,
    pairs: 3, // 2s, Ks, 9s
    triples: 1, // Ks
    lowCards: 3, // 3, 4, 8
    planCost: 5.5,
    holdsLead: 1,
  });
  assert.equal(handFeatures(hand, { planCost: 1, holdsLead: false })[FEATURES.indexOf('holdsLead')], 0);
});

test('across a table the counts add up to the whole deck, and exactly one hand opens', () => {
  for (const players of [3, 4]) {
    for (let seed = 1; seed <= 20; seed++) {
      const hands = dealHands(mulberry32(seed), players);
      const vectors = dealFeatures(hands);
      assert.equal(vectors.length, players);
      const total = (name) => vectors.reduce((s, v) => s + v[FEATURES.indexOf(name)], 0);
      assert.equal(total('twos'), 4, 'four real 2s in the deck');
      assert.equal(total('aces'), 4);
      assert.equal(total('kings'), 4);
      assert.equal(total('jokers'), 4);
      assert.equal(total('holdsLead'), 1);
      assert.equal(vectors[hands.findIndex((h) => h.includes(THREE_OF_DIAMONDS))][FEATURES.indexOf('holdsLead')], 1);
      for (const v of vectors) assert.ok(v.every(Number.isFinite) && v[FEATURES.indexOf('planCost')] > 0);
    }
  }
});

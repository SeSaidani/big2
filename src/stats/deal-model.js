// Applies a saved deal model (src/stats/deal-model-3.json or -4.json, written by tools/fit-deal-model.js)
// to a deal: how likely each seat is to win from the hands dealt, and how many points each is worth.
// Both describe play like the reference player (Medium at every seat), not how any person plays.

import { dealFeatures, pick } from './features.js';
import { softmax, expectedPoints } from './model.js';

const dot = (a, b) => a.reduce((s, v, k) => s + v * b[k], 0);
const scaled = (scaler, vector) => vector.map((v, k) => (scaler.sd[k] > 0 ? (v - scaler.mean[k]) / scaler.sd[k] : 0));

// model: a parsed deal-model-N.json. hands[seat]: the card ids each seat was dealt.
// Returns { winProbabilities, expectedPoints }, one number per seat. Probabilities add up to 1 and
// expected points add up to 0.
export function predictDeal(model, hands) {
  if (hands.length !== model.players) {
    throw new Error(`This model is for ${model.players} players, not ${hands.length}`);
  }
  const x = dealFeatures(hands).map((v) => pick(v, model.features));
  return {
    winProbabilities: softmax(x.map((v) => dot(model.win.weights, scaled(model.scaler, v)))),
    expectedPoints: expectedPoints({ weights: model.points.weights }, model.scaler, x),
  };
}

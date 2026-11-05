// The statistics behind the deal model: who is likely to win from the hands dealt, and how many
// points a deal is worth. No dependencies; the problems are tiny (a handful of features).
//
// A game is { x, winner, delta }: x[seat] is the seat's feature vector, winner the seat that went
// out, delta[seat] the points each seat won or lost (they sum to zero).
//
// WHO WINS: a conditional logit (a softmax over the seats of one table). With standardised features z,
//   score_i = w . z_i,   P(seat i wins) = exp(score_i) / sum_j exp(score_j).
// A good hand is only good relative to the other hands at the table, and this form makes the
// probabilities of one game add to exactly 1, so expected wins can be summed over a player's games
// without bias. Fitted by Newton's method on the penalised log-likelihood
//   sum_g [ score_winner - log sum_j exp(score_j) ] - (lambda / 2) |w|^2,
// whose Hessian is minus the sum over games of the covariance of z under the softmax, minus
// lambda I. No intercept: a constant shift of every seat cancels in the softmax.
//
// POINTS: ridge regression of each seat's points on its features relative to the table's mean,
//   pred_i = b . (z_i - mean_j z_j).
// The relative features sum to zero over the seats, so the predictions do too, as real scores do.

const sum = (a) => a.reduce((s, v) => s + v, 0);

// ---- small linear algebra ----

// Solves A x = b for symmetric positive definite A (Cholesky). Throws if A is not.
export function solveSpd(A, b) {
  const n = b.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(s > 1e-12)) throw new Error('The matrix is not positive definite (a feature has no variation?)');
        L[i][i] = Math.sqrt(s);
      } else L[i][j] = s / L[j][j];
    }
  }
  const y = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

// The inverse of a symmetric positive definite matrix, column by column.
export function inverseSpd(A) {
  const n = A.length;
  const cols = Array.from({ length: n }, (_, j) =>
    solveSpd(
      A,
      Array.from({ length: n }, (_, i) => (i === j ? 1 : 0)),
    ),
  );
  return Array.from({ length: n }, (_, i) => cols.map((c) => c[i]));
}

// ---- standardisation ----

// Mean and standard deviation of every feature over all seats of all games.
export function fitScaler(games) {
  const rows = games.flatMap((g) => g.x);
  const d = rows[0].length;
  const mean = new Array(d).fill(0);
  for (const r of rows) r.forEach((v, k) => (mean[k] += v / rows.length));
  const sd = new Array(d).fill(0);
  for (const r of rows) r.forEach((v, k) => (sd[k] += (v - mean[k]) ** 2 / rows.length));
  return { mean, sd: sd.map((v) => Math.sqrt(v)) };
}

export function scale(scaler, vector) {
  return vector.map((v, k) => (scaler.sd[k] > 0 ? (v - scaler.mean[k]) / scaler.sd[k] : 0));
}

// ---- who wins: conditional logit ----

export function softmax(scores) {
  const m = Math.max(...scores);
  const e = scores.map((s) => Math.exp(s - m));
  const t = sum(e);
  return e.map((v) => v / t);
}

const dot = (a, b) => a.reduce((s, v, k) => s + v * b[k], 0);

// games: [{ x: [[...] per seat], winner }]. Returns { scaler, weights, covariance, iterations, logLik }.
// `weights` act on standardised features, so their size is comparable across features.
export function fitWinModel(games, { lambda = 1, maxIter = 60 } = {}) {
  const scaler = fitScaler(games);
  const Z = games.map((g) => g.x.map((v) => scale(scaler, v)));
  const d = Z[0][0].length;
  let w = new Array(d).fill(0);
  const objective = (wv) => {
    let ll = 0;
    Z.forEach((z, g) => {
      const s = z.map((r) => dot(wv, r));
      const m = Math.max(...s);
      ll += s[games[g].winner] - (m + Math.log(sum(s.map((v) => Math.exp(v - m)))));
    });
    return ll - (lambda / 2) * dot(wv, wv);
  };
  let current = objective(w);
  let hessian = null;
  let iterations = 0;
  for (; iterations < maxIter; iterations++) {
    const grad = new Array(d).fill(0);
    const H = Array.from({ length: d }, () => new Array(d).fill(0)); // minus the Hessian
    Z.forEach((z, g) => {
      const p = softmax(z.map((r) => dot(w, r)));
      const mean = new Array(d).fill(0);
      z.forEach((r, i) => r.forEach((v, k) => (mean[k] += p[i] * v)));
      z[games[g].winner].forEach((v, k) => (grad[k] += v - mean[k]));
      z.forEach((r, i) => {
        for (let a = 0; a < d; a++) for (let b = 0; b < d; b++) H[a][b] += p[i] * r[a] * r[b];
      });
      for (let a = 0; a < d; a++) for (let b = 0; b < d; b++) H[a][b] -= mean[a] * mean[b];
    });
    for (let k = 0; k < d; k++) {
      grad[k] -= lambda * w[k];
      H[k][k] += lambda;
    }
    hessian = H;
    const step = solveSpd(H, grad);
    let t = 1;
    let next = w.map((v, k) => v + t * step[k]);
    let value = objective(next);
    while (value < current - 1e-12 && t > 1e-6) {
      t /= 2; // the full step overshot: halve it until the objective improves
      next = w.map((v, k) => v + t * step[k]);
      value = objective(next);
    }
    const move = Math.sqrt(dot(step, step)) * t;
    w = next;
    current = value;
    if (move < 1e-9) {
      iterations++;
      break;
    }
  }
  return { scaler, weights: w, covariance: inverseSpd(hessian), iterations, logLik: current };
}

// P(each seat wins) for one deal, given the seats' raw feature vectors.
export function winProbabilities(model, x) {
  return softmax(x.map((v) => dot(model.weights, scale(model.scaler, v))));
}

// ---- points: ridge on features relative to the table ----

function relative(scaler, x) {
  const z = x.map((v) => scale(scaler, v));
  const mean = z[0].map((_, k) => sum(z.map((r) => r[k])) / z.length);
  return z.map((r) => r.map((v, k) => v - mean[k]));
}

export function fitPointsModel(games, scaler, { lambda = 1 } = {}) {
  const d = scaler.mean.length;
  const A = Array.from({ length: d }, (_, a) => Array.from({ length: d }, (_, b) => (a === b ? lambda : 0)));
  const rhs = new Array(d).fill(0);
  for (const g of games) {
    const r = relative(scaler, g.x);
    r.forEach((row, i) => {
      for (let a = 0; a < d; a++) {
        rhs[a] += row[a] * g.delta[i];
        for (let b = 0; b < d; b++) A[a][b] += row[a] * row[b];
      }
    });
  }
  return { weights: solveSpd(A, rhs) };
}

// Expected points of each seat of one deal; they sum to zero.
export function expectedPoints(model, scaler, x) {
  return relative(scaler, x).map((row) => dot(model.weights, row));
}

// ---- measuring a model on games it was not fitted on ----

// -log P(the actual winner), per game, for a function that gives each game's probabilities.
export function perGameLogLoss(games, probsOf) {
  return games.map((g) => -Math.log(Math.max(probsOf(g)[g.winner], 1e-12)));
}

export const uniformProbs = (g) => g.x.map(() => 1 / g.x.length);

// The mean of a list with its standard error.
export function meanAndSe(values) {
  const n = values.length;
  const mean = sum(values) / n;
  const variance = sum(values.map((v) => (v - mean) ** 2)) / (n - 1);
  return { mean, se: Math.sqrt(variance / n), n };
}

// Brier score of the win probabilities: the mean over games of sum_i (p_i - [i won])^2.
export function brier(games, probsOf) {
  return meanAndSe(
    games.map((g) => {
      const p = probsOf(g);
      return sum(p.map((v, i) => (v - (i === g.winner ? 1 : 0)) ** 2));
    }),
  );
}

// Predicted against observed win rate, pooling every seat, in bins holding equal numbers of seats.
export function calibration(games, probsOf, bins = 8) {
  const pairs = games.flatMap((g) => probsOf(g).map((p, i) => [p, i === g.winner ? 1 : 0]));
  pairs.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (let b = 0; b < bins; b++) {
    const part = pairs.slice(Math.floor((b * pairs.length) / bins), Math.floor(((b + 1) * pairs.length) / bins));
    const predicted = sum(part.map((p) => p[0])) / part.length;
    const observed = sum(part.map((p) => p[1])) / part.length;
    out.push({ n: part.length, predicted, observed, se: Math.sqrt((observed * (1 - observed)) / part.length) });
  }
  return out;
}

// R^2 of expected points against a prediction of 0 for everyone (the zero-sum baseline).
export function pointsR2(games, pointsOf) {
  let sse = 0;
  let sst = 0;
  for (const g of games) {
    const p = pointsOf(g);
    g.delta.forEach((y, i) => {
      sse += (y - p[i]) ** 2;
      sst += y ** 2;
    });
  }
  return 1 - sse / sst;
}

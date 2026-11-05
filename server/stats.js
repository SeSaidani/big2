// Luck and skill: how each player did against what their dealt hands were worth.
//
// For a finished game that was saved with its deal (see recordGame in db.js), the deal model (see
// docs/deal-model.md) gives every seat a chance of winning and an expected score. A player's results
// then split into two parts:
//
//   deal luck   = sum over their games of E[points | the hands dealt]     (what their cards were worth)
//   play        = sum over their games of (points won - E[points | deal]) (what they made of the cards)
//
// and their wins can be compared with the sum of their win chances. "Expected" means how Medium-style
// play fares from the same cards; it is not a measure of absolute skill.
//
// Errors. A player's win in each game is a Bernoulli trial with chance p, so the wins above expectation
// have standard error sqrt(sum p (1 - p)). The play total is a sum of n per-game residuals, so its
// standard error is sd(residual) * sqrt(n). Both are shown as 95% ranges (1.96 of them).
//
// The model's numbers are computed once per game and cached against a fingerprint of the model file,
// so refitting the model recomputes them and nothing is calculated on a page view.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { loadGameRecord, resolveSeason } from './db.js';
import { predictDeal } from '../src/stats/deal-model.js';

export const MIN_GAMES = 10; // below this the error bars are wider than any real effect
const FAR_PAST = -9e15;
const FAR_FUTURE = 9e15;
const BATCH = 200; // games priced per request at most, so a long backlog cannot stall the server

const loadModel = (players) => {
  const text = fs.readFileSync(new URL(`../src/stats/deal-model-${players}.json`, import.meta.url), 'utf8');
  return { model: JSON.parse(text), id: crypto.createHash('sha256').update(text).digest('hex').slice(0, 12) };
};
const MODELS = { 3: loadModel(3), 4: loadModel(4) };
export const modelIds = () => ({ 3: MODELS[3].id, 4: MODELS[4].id });

// Prices the finished games that have a saved deal but no numbers from the current model yet.
// Returns how many such games are still waiting afterwards.
export function ensureExpectations(db, { limit = BATCH, log = () => {} } = {}) {
  const todo = db.prepare(`
    SELECT g.id AS id, g.players AS players FROM games g
    WHERE g.status = 'finished' AND g.players = ?
      AND EXISTS (SELECT 1 FROM game_deals d WHERE d.game_id = g.id)
      AND NOT EXISTS (SELECT 1 FROM game_expectation e WHERE e.game_id = g.id AND e.model = ?)
    ORDER BY g.id LIMIT ?`);
  const insert = db.prepare(
    'INSERT OR REPLACE INTO game_expectation (game_id, seat, model, win_p, exp_points) VALUES (?, ?, ?, ?, ?)',
  );
  let left = limit;
  for (const players of [3, 4]) {
    const { model, id } = MODELS[players];
    for (const game of todo.all(players, id, left)) {
      try {
        const rec = loadGameRecord(db, game.id);
        const pred = predictDeal(model, rec.deals);
        db.exec('BEGIN IMMEDIATE');
        try {
          pred.winProbabilities.forEach((p, seat) => insert.run(game.id, seat, id, p, pred.expectedPoints[seat]));
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        left--;
      } catch (err) {
        log('Could not price game', game.id, err); // a bad record must not break the page for everyone
      }
    }
  }
  return pending(db);
}

function pending(db) {
  let n = 0;
  for (const players of [3, 4]) {
    n += db
      .prepare(
        `SELECT COUNT(*) AS n FROM games g
         WHERE g.status = 'finished' AND g.players = ?
           AND EXISTS (SELECT 1 FROM game_deals d WHERE d.game_id = g.id)
           AND NOT EXISTS (SELECT 1 FROM game_expectation e WHERE e.game_id = g.id AND e.model = ?)`,
      )
      .get(players, MODELS[players].id).n;
  }
  return n;
}

// kind: 'human' (games with only people) or 'ai' (games with computer players), as for the leaderboard.
export function luckAndSkill(db, kind, { season = 'current', now = Date.now(), minGames = MIN_GAMES, log } = {}) {
  const s = resolveSeason(db, season, now);
  if (!s) return { season: null, rows: [], minGames, pending: 0 };
  const stillPending = ensureExpectations(db, { log });
  const where = `g.has_ai = ? AND g.status = 'finished' AND g.ended >= ? AND g.ended < ?`;
  const args = [kind === 'ai' ? 1 : 0, s.starts ?? FAR_PAST, s.ends ?? FAR_FUTURE];

  const played = new Map(
    db
      .prepare(
        `SELECT r.user_id AS id, COUNT(*) AS n FROM results r JOIN games g ON g.id = r.game_id
         WHERE r.user_id IS NOT NULL AND ${where} GROUP BY r.user_id`,
      )
      .all(...args)
      .map((r) => [r.id, r.n]),
  );

  const perGame = db
    .prepare(
      `SELECT r.user_id AS id, u.name AS name, r.delta AS delta, e.win_p AS p, e.exp_points AS ep
       FROM results r
       JOIN games g ON g.id = r.game_id
       JOIN users u ON u.id = r.user_id
       JOIN game_expectation e ON e.game_id = r.game_id AND e.seat = r.seat
         AND e.model = CASE g.players WHEN 3 THEN ? WHEN 4 THEN ? END
       WHERE ${where}`,
    )
    .all(MODELS[3].id, MODELS[4].id, ...args);

  const byUser = new Map();
  for (const g of perGame) {
    if (!byUser.has(g.id)) byUser.set(g.id, { name: g.name, rows: [] });
    byUser.get(g.id).rows.push(g);
  }

  const rows = [...byUser.entries()].map(([id, { name, rows: games }]) => {
    const n = games.length;
    const wins = games.filter((g) => g.delta > 0).length;
    const expWins = games.reduce((t, g) => t + g.p, 0);
    const winsSe = Math.sqrt(games.reduce((t, g) => t + g.p * (1 - g.p), 0));
    const luck = games.reduce((t, g) => t + g.ep, 0);
    const resid = games.map((g) => g.delta - g.ep);
    const play = resid.reduce((t, v) => t + v, 0);
    const mean = play / n;
    const sd = n > 1 ? Math.sqrt(resid.reduce((t, v) => t + (v - mean) ** 2, 0) / (n - 1)) : null;
    return {
      name,
      games: n,
      played: played.get(id) ?? n,
      wins,
      expWins,
      winsAbove: wins - expWins,
      winsSe,
      points: games.reduce((t, g) => t + g.delta, 0),
      luck,
      play,
      playSe: sd === null ? null : sd * Math.sqrt(n),
      ready: n >= minGames,
    };
  });
  // Players with enough games first, best play first; the rest after, by games.
  rows.sort(
    (a, b) =>
      Number(b.ready) - Number(a.ready) ||
      (a.ready ? b.play - a.play : b.games - a.games) ||
      a.name.localeCompare(b.name),
  );
  return { season: s, rows, minGames, pending: stillPending };
}

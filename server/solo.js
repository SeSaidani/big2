// Solo games against the computer, as the person who played them sees them. The game itself runs in the
// browser, which reports each finished round here so the numbers follow the person from device to device.
// They are never on a leaderboard, and nothing here reads anyone else's rows: every query is for one user id,
// and that id always comes from the signed-in session.
//
// The browser is trusted only as far as this person's own table: a made-up result can only change what they
// themselves see, and each report is checked for being a possible result of a round.

import { LEVELS } from '../src/ai/agents.js';
import { PLAYER_COUNTS } from '../src/cards.js';

export class SoloError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// The most one round can move: a winner at a table of three can collect 2 x 20 cards x 4 x 2 (a doubled
// round); at four, 3 x 13 x 4 x 2. A loser pays at most one of those.
export const MAX_DELTA = 320;
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

// input: { clientId, level, players, won, delta } (delta: the person's points for the round, seat 0).
// Returns true if it was new, false if this clientId had already been recorded (a retry).
export function recordSolo(db, userId, input, now = Date.now()) {
  const { clientId, level, players, won, delta } = input || {};
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) throw new SoloError('A result needs an id.');
  if (!LEVELS.includes(level)) throw new SoloError('Unknown level.');
  if (!PLAYER_COUNTS.includes(players)) throw new SoloError('A solo game has 3 or 4 players.');
  if (typeof won !== 'boolean') throw new SoloError('won must be true or false.');
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_DELTA) {
    throw new SoloError('That is not a possible score for a round.');
  }
  // Going out always collects from every other player, and anyone else always pays: the sign says who won.
  if (won !== delta > 0) throw new SoloError('The score does not match the result.');
  const r = db
    .prepare(
      'INSERT OR IGNORE INTO solo_games (user_id, client_id, level, players, won, delta, ended) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(userId, clientId, level, players, won ? 1 : 0, delta, now);
  return r.changes > 0;
}

const zero = () => ({ games: 0, wins: 0, points: 0 });
const addTo = (a, b) => {
  a.games += b.games;
  a.wins += b.wins;
  a.points += b.points;
};

// One person's table: by number of players and level, each size's total, each level's total over both sizes, and
// the overall total. Every cell is { games, wins, points }.
export function soloStats(db, userId) {
  const rows = db
    .prepare(
      'SELECT level, players, COUNT(*) AS games, SUM(won) AS wins, SUM(delta) AS points FROM solo_games WHERE user_id = ? GROUP BY level, players',
    )
    .all(userId);
  const bySize = {};
  for (const n of PLAYER_COUNTS) {
    bySize[n] = { all: zero() };
    for (const l of LEVELS) bySize[n][l] = zero();
  }
  const byLevel = Object.fromEntries(LEVELS.map((l) => [l, zero()]));
  const overall = zero();
  for (const r of rows) {
    const cell = { games: r.games, wins: r.wins, points: r.points };
    addTo(bySize[r.players][r.level], cell);
    addTo(bySize[r.players].all, cell);
    addTo(byLevel[r.level], cell);
    addTo(overall, cell);
  }
  return { bySize, byLevel, overall };
}

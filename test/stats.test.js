import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mulberry32 } from '../src/cards.js';
import { newGame, applyMove, autoSkip, legalMoves, initialDeals, moveLog } from '../src/game.js';
import { scoreRound } from '../src/scoring.js';
import { predictDeal } from '../src/stats/deal-model.js';
import { openDb, recordGame, loadGameRecord } from '../server/db.js';
import { luckAndSkill, ensureExpectations, modelIds, MIN_GAMES } from '../server/stats.js';
import { boot, Client } from './support.js';

const MODEL = (players) =>
  JSON.parse(fs.readFileSync(new URL(`../src/stats/deal-model-${players}.json`, import.meta.url), 'utf8'));
const NOW = Date.now() + 100_000;

// A whole game played at random, the way the server plays it.
function playRandomGame(seed, players) {
  const rng = mulberry32(seed);
  const s = newGame(rng, null, players);
  while (s.winner < 0) {
    const moves = legalMoves(s);
    if (s.trick !== null && (moves.length === 0 || rng() < 0.3)) applyMove(s, null);
    else {
      const m = moves[Math.floor(rng() * moves.length)];
      applyMove(s, m.cards, m.cls);
      autoSkip(s);
    }
  }
  return s;
}

function setup(names = ['ann', 'bob', 'cat', 'dan']) {
  const db = openDb(':memory:');
  const ids = names.map((n) =>
    Number(db.prepare("INSERT INTO users (name, pw_hash, created) VALUES (?, 'x', 1)").run(n).lastInsertRowid),
  );
  let clock = Date.now() + 1000;
  // Saves a finished random game with seat i played by users[i] (null = a computer).
  const addGame = ({ seed, users, hasAi = false, record = true }) => {
    const s = playRandomGame(seed, users.length);
    const r = scoreRound(s);
    const rec = { deals: initialDeals(s), moves: moveLog(s) };
    const id = recordGame(db, {
      started: clock,
      ended: ++clock,
      hasAi,
      multiplier: r.multiplier,
      seats: users.map((u, i) => ({ userId: u, cardsLeft: s.hands[i].length, delta: r.delta[i] })),
      record: record ? rec : undefined,
    });
    return { id, s, r, rec };
  };
  return { db, ids, addGame };
}

const sum = (a) => a.reduce((t, v) => t + v, 0);

test("a player's luck and play are the sums over their games, checked against the model computed independently", () => {
  const { db, ids, addGame } = setup();
  const games = Array.from({ length: 12 }, (_, i) => addGame({ seed: 100 + i, users: ids }));
  const out = luckAndSkill(db, 'human', { now: NOW });
  assert.equal(out.rows.length, 4);
  assert.equal(out.pending, 0);

  const model = MODEL(4);
  const preds = games.map((g) => predictDeal(model, g.rec.deals));
  const ann = out.rows.find((r) => r.name === 'ann');
  assert.equal(ann.games, 12);
  assert.equal(ann.played, 12);
  assert.equal(ann.ready, true);
  assert.equal(ann.wins, games.filter((g) => g.s.winner === 0).length);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(ann.expWins, sum(preds.map((p) => p.winProbabilities[0])));
  near(ann.winsAbove, ann.wins - ann.expWins);
  near(ann.winsSe, Math.sqrt(sum(preds.map((p) => p.winProbabilities[0] * (1 - p.winProbabilities[0])))));
  near(ann.points, sum(games.map((g) => g.r.delta[0])));
  near(ann.luck, sum(preds.map((p) => p.expectedPoints[0])));
  near(ann.play, sum(games.map((g, i) => g.r.delta[0] - preds[i].expectedPoints[0])));
  near(ann.points, ann.luck + ann.play); // actual = luck + play
  assert.ok(ann.playSe > 0);

  // Across a table of four people: the win chances add to one game each, and luck and play add to zero.
  near(sum(out.rows.map((r) => r.expWins)), 12);
  near(sum(out.rows.map((r) => r.luck)), 0);
  near(sum(out.rows.map((r) => r.play)), 0);
  near(sum(out.rows.map((r) => r.wins)), 12);
  db.close();
});

test(`a player with fewer than ${MIN_GAMES} games is listed but not ready, after those who are`, () => {
  const { db, ids, addGame } = setup(['ann', 'bob', 'cat', 'dan', 'eve']);
  for (let i = 0; i < MIN_GAMES; i++) addGame({ seed: 200 + i, users: ids.slice(0, 4) });
  for (let i = 0; i < 3; i++) addGame({ seed: 300 + i, users: [ids[4], ids[1], ids[2], ids[3]] });
  const out = luckAndSkill(db, 'human', { now: NOW });
  const eve = out.rows.find((r) => r.name === 'eve');
  assert.equal(eve.games, 3);
  assert.equal(eve.ready, false);
  assert.equal(out.rows.at(-1).name, 'eve', 'not-ready players come last');
  assert.ok(out.rows.slice(0, 4).every((r) => r.ready));
  assert.equal(out.minGames, MIN_GAMES);
  db.close();
});

test('games saved without a deal count as played but not in the figures', () => {
  const { db, ids, addGame } = setup();
  for (let i = 0; i < 4; i++) addGame({ seed: 400 + i, users: ids });
  for (let i = 0; i < 2; i++) addGame({ seed: 500 + i, users: ids, record: false });
  const ann = luckAndSkill(db, 'human', { now: NOW }).rows.find((r) => r.name === 'ann');
  assert.equal(ann.games, 4);
  assert.equal(ann.played, 6);
  db.close();
});

test('the two boards stay apart, as on the leaderboard', () => {
  const { db, ids, addGame } = setup();
  addGame({ seed: 600, users: ids });
  addGame({ seed: 601, users: [ids[0], null, null, null], hasAi: true });
  assert.equal(luckAndSkill(db, 'human', { now: NOW }).rows.find((r) => r.name === 'ann').games, 1);
  const ai = luckAndSkill(db, 'ai', { now: NOW }).rows;
  assert.deepEqual(
    ai.map((r) => [r.name, r.games]),
    [['ann', 1]],
    'computer seats have no row, and the human game is not on this board',
  );
  db.close();
});

test('three- and four-player games pool correctly: each is priced by its own model', () => {
  const { db, ids, addGame } = setup();
  const g4 = addGame({ seed: 700, users: ids });
  const g3 = addGame({ seed: 701, users: ids.slice(0, 3) });
  const ann = luckAndSkill(db, 'human', { now: NOW }).rows.find((r) => r.name === 'ann');
  const p4 = predictDeal(MODEL(4), g4.rec.deals);
  const p3 = predictDeal(MODEL(3), g3.rec.deals);
  assert.ok(Math.abs(ann.expWins - (p4.winProbabilities[0] + p3.winProbabilities[0])) < 1e-9);
  assert.ok(Math.abs(ann.luck - (p4.expectedPoints[0] + p3.expectedPoints[0])) < 1e-9);
  db.close();
});

test('numbers are cached once per game and model, recomputed after a model change, and never mixed', () => {
  const { db, ids, addGame } = setup();
  const g = addGame({ seed: 800, users: ids });
  const rows = () => db.prepare('SELECT COUNT(*) AS n FROM game_expectation').get().n;
  const before = luckAndSkill(db, 'human', { now: NOW });
  assert.equal(rows(), 4);
  luckAndSkill(db, 'human', { now: NOW });
  assert.equal(rows(), 4, 'a second call prices nothing');

  // Pretend the model file changed: the old numbers are ignored and the game is priced again.
  db.prepare("UPDATE game_expectation SET model = 'an-older-model'").run();
  const after = luckAndSkill(db, 'human', { now: NOW });
  assert.equal(rows(), 8, 'old rows are kept but the current model priced the game afresh');
  assert.deepEqual(after.rows, before.rows, 'the same model gives the same figures');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM game_expectation WHERE model = ?').get(modelIds()[4]).n, 4);
  assert.ok(loadGameRecord(db, g.id));
  db.close();
});

test('one game with a damaged record is skipped and logged, and everyone else is still priced', () => {
  const { db, ids, addGame } = setup();
  const bad = addGame({ seed: 900, users: ids });
  for (let i = 0; i < 3; i++) addGame({ seed: 901 + i, users: ids });
  db.prepare('DELETE FROM game_deals WHERE game_id = ? AND seat = 3').run(bad.id);
  const logged = [];
  const out = luckAndSkill(db, 'human', { now: NOW, log: (...a) => logged.push(a) });
  assert.equal(out.rows.find((r) => r.name === 'ann').games, 3, 'the three good games count');
  assert.equal(logged.length, 1);
  assert.equal(logged[0][1], bad.id);
  assert.equal(out.pending, 1, 'the damaged game stays unpriced');
  db.close();
});

test('pricing is batched, and reports what is still waiting', () => {
  const { db, ids, addGame } = setup();
  for (let i = 0; i < 5; i++) addGame({ seed: 1000 + i, users: ids });
  assert.equal(ensureExpectations(db, { limit: 2 }), 3);
  assert.equal(ensureExpectations(db, { limit: 10 }), 0);
  db.close();
});

test('the stats API is exactly as public as the leaderboard, and checks its input', async () => {
  const ctx = await boot();
  try {
    const anon = new Client(ctx.base);
    const lb = await anon.req('GET', '/api/leaderboard?kind=human&season=current');
    const st = await anon.req('GET', '/api/stats?kind=human&season=current');
    assert.equal(st.status, lb.status);
    if (st.status === 200) {
      assert.deepEqual(st.json.rows, []);
      assert.equal(st.json.minGames, MIN_GAMES);
    }
    assert.equal(
      (await anon.req('GET', '/api/stats?kind=human&season=bogus')).status,
      st.status === 200 ? 400 : st.status,
    );
  } finally {
    await ctx.app.close();
  }
});

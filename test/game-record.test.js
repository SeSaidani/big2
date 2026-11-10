import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mulberry32 } from '../src/cards.js';
import {
  newGame,
  applyMove,
  autoSkip,
  legalMoves,
  initialDeals,
  moveLog,
  replayRecord,
  checkInvariants,
  RULES_VERSION,
} from '../src/game.js';
import { scoreRound } from '../src/scoring.js';
import { openDb, recordGame, recordCancelled, recordProblem, loadGameRecord } from '../server/db.js';

// Plays a whole game with random legal moves, the way the server does (a play, then autoSkip).
function playRandomGame(seed, players) {
  const rng = mulberry32(seed);
  const s = newGame(rng, null, players);
  const dealt = s.hands.map((h) => [...h].sort((a, b) => a - b));
  while (s.winner < 0) {
    const moves = legalMoves(s);
    if (s.trick !== null && (moves.length === 0 || rng() < 0.3)) applyMove(s, null);
    else {
      const m = moves[Math.floor(rng() * moves.length)];
      applyMove(s, m.cards, m.cls);
      autoSkip(s);
    }
    checkInvariants(s);
  }
  return { s, dealt };
}

const seatsOf = (s) => {
  const r = scoreRound(s);
  return s.hands.map((h, i) => ({ userId: null, cardsLeft: h.length, delta: r.delta[i] }));
};

test('the deal is rebuilt exactly and the saved moves replay to the same game, at 3 and 4 players', () => {
  for (const players of [3, 4]) {
    for (let g = 0; g < 60; g++) {
      const { s, dealt } = playRandomGame(7000 + g, players);
      const record = { deals: initialDeals(s), moves: moveLog(s) };
      assert.deepEqual(record.deals, dealt, `${players} players, game ${g}: the rebuilt deal`);
      assert.equal(recordProblem(record, players), null);
      const again = replayRecord(record);
      assert.equal(again.winner, s.winner);
      assert.deepEqual(again.hands, s.hands);
      assert.deepEqual(scoreRound(again), scoreRound(s));
      assert.deepEqual(moveLog(again), moveLog(s), 'the replay logs the same moves, automatic passes included');
    }
  }
});

test('a record is refused unless every card was dealt once and every move is real', () => {
  const { s } = playRandomGame(1, 4);
  const good = { deals: initialDeals(s), moves: moveLog(s) };
  assert.equal(recordProblem(good, 4), null);
  assert.match(recordProblem(good, 3), /one deal per seat/);
  assert.match(recordProblem({ ...good, deals: good.deals.slice(1) }, 4), /one deal per seat/);
  const dup = good.deals.map((h) => [...h]);
  dup[1][0] = dup[0][0];
  assert.match(recordProblem({ ...good, deals: dup }, 4), /dealt twice/);
  const short = good.deals.map((h) => [...h]);
  short[0].pop();
  assert.match(recordProblem({ ...good, deals: short }, 4), /55 cards/);
  const notCard = good.deals.map((h) => [...h]);
  notCard[2][0] = 99;
  assert.match(recordProblem({ ...good, deals: notCard }, 4), /not a card/);
  assert.match(recordProblem({ ...good, moves: [{ seat: 4, cards: null, auto: false }] }, 4), /bad move/);
  assert.match(recordProblem({ ...good, moves: [{ seat: 0, cards: [], auto: false }] }, 4), /bad move/);
  assert.match(recordProblem({ ...good, moves: [{ seat: 0, cards: [56], auto: false }] }, 4), /bad move/);
  assert.match(recordProblem({ ...good, moves: null }, 4), /move log/);
  assert.match(recordProblem(null, 4), /one deal per seat/);
});

test('replaying a doctored log fails loudly instead of inventing a game', () => {
  const { s } = playRandomGame(2, 4);
  const record = { deals: initialDeals(s), moves: moveLog(s) };
  const wrongSeat = record.moves.map((m) => ({ ...m }));
  const first = wrongSeat.findIndex((m) => !m.auto);
  wrongSeat[first].seat = (wrongSeat[first].seat + 1) % 4;
  assert.throws(() => replayRecord({ ...record, moves: wrongSeat }), /out of step/);
  const illegal = record.moves.map((m) => ({ ...m }));
  illegal[first].cards = [illegal[first].cards[0] === 0 ? 1 : 0]; // the opening must include the 3 of diamonds
  assert.throws(() => replayRecord({ ...record, moves: illegal }), /illegal move/);
});

test('a game is saved with its deal and moves in one transaction, and loads back the same', () => {
  const db = openDb(':memory:');
  for (const players of [3, 4]) {
    const { s } = playRandomGame(50 + players, players);
    const record = { deals: initialDeals(s), moves: moveLog(s) };
    const id = recordGame(db, { started: 1, ended: 2, hasAi: true, multiplier: 1, seats: seatsOf(s), record });
    assert.equal(db.prepare('SELECT players FROM games WHERE id = ?').get(id).players, players);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM results WHERE game_id = ?').get(id).n, players);
    assert.deepEqual(loadGameRecord(db, id), { players, rules: RULES_VERSION, ...record });
    assert.equal(replayRecord(loadGameRecord(db, id)).winner, s.winner);
  }
  db.close();
});

test('a bad record saves nothing, and a game without a record still scores', () => {
  const db = openDb(':memory:');
  const { s } = playRandomGame(3, 4);
  const record = { deals: initialDeals(s), moves: moveLog(s) };
  record.deals[0].pop();
  assert.throws(
    () => recordGame(db, { started: 1, ended: 2, hasAi: true, multiplier: 1, seats: seatsOf(s), record }),
    /Bad game record/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM games').get().n, 0, 'no half-saved game');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM results').get().n, 0);
  const id = recordGame(db, { started: 1, ended: 2, hasAi: true, multiplier: 1, seats: seatsOf(s) });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM results WHERE game_id = ?').get(id).n, 4);
  assert.equal(loadGameRecord(db, id), null);
  assert.equal(loadGameRecord(db, 999), null);
  db.close();
});

test('a cancelled game has no record', () => {
  const db = openDb(':memory:');
  const id = recordCancelled(db, { started: 1, ended: 2, hasAi: true });
  assert.equal(loadGameRecord(db, id), null);
  db.close();
});

test('an old database gains the record tables, keeps its games, and records new ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'big2-record-'));
  const file = path.join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, pw_hash TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE sessions (token_sha256 TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE games (id INTEGER PRIMARY KEY, started INTEGER NOT NULL, ended INTEGER NOT NULL, has_ai INTEGER NOT NULL, multiplier INTEGER NOT NULL);
      CREATE TABLE results (game_id INTEGER NOT NULL, seat INTEGER NOT NULL, user_id INTEGER, cards_left INTEGER NOT NULL, delta INTEGER NOT NULL, PRIMARY KEY (game_id, seat));
      INSERT INTO games (started, ended, has_ai, multiplier) VALUES (1, 2, 1, 1);
      INSERT INTO results VALUES (1, 0, NULL, 0, 10), (1, 1, NULL, 5, -10);
    `);
    old.close();
    const db = openDb(file);
    assert.equal(db.prepare('SELECT players FROM games WHERE id = 1').get().players, null, 'old games have no count');
    assert.equal(loadGameRecord(db, 1), null);
    const { s } = playRandomGame(4, 3);
    const id = recordGame(db, {
      started: 3,
      ended: 4,
      hasAi: false,
      multiplier: 1,
      seats: seatsOf(s),
      record: { deals: initialDeals(s), moves: moveLog(s) },
    });
    assert.equal(loadGameRecord(db, id).players, 3);
    db.close();
    const again = openDb(file); // reopening is harmless
    assert.equal(again.prepare('SELECT COUNT(*) AS n FROM games').get().n, 2);
    assert.equal(loadGameRecord(again, id).deals.length, 3);
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

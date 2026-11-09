// Recording every play: a finished solo game can carry its deal and every play, which the server plays again before it
// stores them; every record says which rules it was played under; and the export turns the records into one line per
// play (or per game) for study and training.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/cards.js';
import {
  newGame,
  applyMove,
  autoSkip,
  legalMoves,
  mustPass,
  initialDeals,
  moveLog,
  RULES_VERSION,
} from '../src/game.js';
import { classify } from '../src/hands.js';
import { scoreRound } from '../src/scoring.js';
import { openDb, recordGame } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { recordSolo, SoloError } from '../server/solo.js';
import { exportLines } from '../tools/export-plays.js';
import { boot, makeUser } from './support.js';

// A whole game of random legal play (seeded), as the browser would report it.
function simulate(players, seed) {
  const rng = mulberry32(seed);
  const g = newGame(rng, null, players);
  while (g.winner < 0) {
    const legal = legalMoves(g);
    const pass = g.trick && !g.first && (mustPass(g) || rng() < 0.3);
    const lead = !g.trick && !g.first && rng() < 0.05;
    const m = pass || lead || !legal.length ? null : legal[Math.floor(rng() * legal.length)];
    applyMove(g, m ? m.cards : null, m ? classify(m.cards) : null);
    if (m) autoSkip(g);
  }
  const delta = scoreRound(g).delta;
  const left = g.hands.map((h) => h.length);
  return { record: { deals: initialDeals(g), moves: moveLog(g) }, winner: g.winner, delta, players, left };
}
const copy = (x) => JSON.parse(JSON.stringify(x));
let n = 0;
const report = (game, extra = {}) => ({
  clientId: `rec-${++n}-${Math.random().toString(36).slice(2)}`,
  level: 'easy',
  players: game.players,
  won: game.winner === 0,
  delta: game.delta[0],
  record: copy(game.record),
  ...extra,
});
async function dbWith() {
  const db = openDb(':memory:');
  const user = await createUser(db, 'ann', 'a-long-enough-password');
  return { db, uid: user.id };
}
const count = (db) => db.prepare('SELECT COUNT(*) AS n FROM solo_games').get().n;
const refused = (fn, why) => assert.throws(fn, (e) => e instanceof SoloError && why.test(e.message), String(why));

test('a solo result carries its record, which is stored as sent with the rules version', async () => {
  const { db, uid } = await dbWith();
  const g = simulate(4, 11);
  assert.equal(recordSolo(db, uid, report(g)), true);
  const row = db.prepare('SELECT rules, record FROM solo_games').get();
  assert.equal(row.rules, RULES_VERSION);
  assert.deepEqual(JSON.parse(row.record), g.record);
});

test('a result with no record still counts, and has none stored', async () => {
  const { db, uid } = await dbWith();
  const g = simulate(3, 5);
  const { record, ...bare } = report(g);
  void record;
  assert.equal(recordSolo(db, uid, bare), true);
  assert.equal(db.prepare('SELECT record FROM solo_games').get().record, null);
});

test('a retry of the same result is counted once, and keeps the first record', async () => {
  const { db, uid } = await dbWith();
  const g = simulate(4, 21);
  const r = report(g);
  assert.equal(recordSolo(db, uid, r), true);
  assert.equal(recordSolo(db, uid, r), false);
  assert.equal(count(db), 1);
});

test('a record that is not a real game of this result is refused, and nothing is stored', async () => {
  const { db, uid } = await dbWith();
  const g = simulate(4, 31);

  refused(
    () => recordSolo(db, uid, report(g, { delta: g.winner === 0 ? g.delta[0] + 1 : g.delta[0] - 1 })),
    /match the result/,
  );

  const twice = report(g);
  twice.record.deals[0][0] = twice.record.deals[1][0];
  refused(() => recordSolo(db, uid, twice), /dealt twice|not valid/);

  const cut = report(g);
  cut.record.moves.pop();
  refused(() => recordSolo(db, uid, cut), /does not end|cannot be played|not valid/);

  const wrongSize = report(g, { players: 3 });
  refused(() => recordSolo(db, uid, wrongSize), /not valid/);

  const garbage = report(g, { record: { deals: 'x', moves: 7 } });
  refused(() => recordSolo(db, uid, garbage), /not valid/);

  // an illegal play: the first play of the game is made with different cards
  const illegal = report(g);
  const i = illegal.record.moves.findIndex((m) => m.cards && !m.auto);
  const held = illegal.record.deals[illegal.record.moves[i].seat];
  const other = held.find((c) => !illegal.record.moves[i].cards.includes(c));
  illegal.record.moves[i].cards = [other];
  refused(() => recordSolo(db, uid, illegal), /cannot be played|not valid|match/);

  assert.equal(count(db), 0, 'none of them was stored');
});

test('over HTTP a result with its whole game goes through, and a huge body is still refused', async () => {
  const ctx = await boot();
  try {
    const c = await makeUser(ctx, 'ann');
    let g = simulate(4, 41);
    for (let seed = 42; JSON.stringify(report(g)).length <= 4096 && seed < 300; seed++) g = simulate(4, seed);
    const body = report(g);
    assert.ok(JSON.stringify(body).length > 4096, 'bigger than the limit for any other request');
    const ok = await c.req('POST', '/api/solo/result', body);
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const huge = await c.req('POST', '/api/solo/result', { ...report(g), padding: 'x'.repeat(20_000) });
    assert.equal(huge.status, 413);
    assert.equal(ctx.app.db.prepare('SELECT COUNT(*) AS n FROM solo_games').get().n, 1);
  } finally {
    await ctx.app.close();
  }
});

// ---- the export ----

async function populated() {
  const { db, uid } = await dbWith();
  const solo = [simulate(4, 51), simulate(3, 52)];
  for (const g of solo) recordSolo(db, uid, report(g));
  const online = simulate(4, 53);
  recordGame(db, {
    started: 1,
    ended: 2,
    hasAi: false,
    multiplier: 1,
    seats: online.left.map((cardsLeft, seat) => ({ userId: uid, cardsLeft, delta: online.delta[seat] })),
    record: online.record,
  });
  return { db, uid, solo, online };
}

test('the export writes one line per play, with only what the player to move knew', async () => {
  const { db, solo, online } = await populated();
  const { lines, kept, skipped } = exportLines(db);
  assert.equal(kept, 3);
  assert.deepEqual(skipped, { rules: 0, replay: 0 });
  const humanMoves = (g) => g.record.moves.filter((m) => !m.auto).length;
  assert.equal(
    lines.length,
    [...solo, online].reduce((a, g) => a + humanMoves(g), 0),
    'a line for every play, none for automatic skips',
  );
  for (const l of lines) {
    assert.deepEqual(Object.keys(l.view).sort(), [
      'counts',
      'first',
      'hand',
      'leadPasses',
      'passed',
      'played',
      'trick',
    ]);
    if (l.move) {
      assert.ok(
        l.move.every((c) => l.view.hand.includes(c)),
        'the chosen cards were in the hand',
      );
    }
    if (l.forced) assert.ok(l.move === null && l.legal === 0, 'a forced pass had no legal play');
    assert.equal(typeof l.outcome, 'number');
    assert.equal(l.rules, RULES_VERSION);
  }
  const soloLines = lines.filter((l) => l.source === 'solo');
  assert.ok(
    soloLines.every((l) =>
      l.seat === 0 ? l.actor.kind === 'human' : l.actor.kind === 'ai' && l.actor.level === 'easy',
    ),
  );
});

test('the export of games keeps the deal, every move and what every seat scored', async () => {
  const { db, online } = await populated();
  const { lines } = exportLines(db, { games: true });
  assert.equal(lines.length, 3);
  const g = lines.find((l) => l.source === 'online');
  assert.deepEqual(g.deals, online.record.deals);
  assert.deepEqual(g.moves, online.record.moves);
  assert.equal(
    g.delta.reduce((a, b) => a + b, 0),
    0,
    'what the seats scored sums to nothing',
  );
});

test('games played under other rules are left out unless asked for, and what does not replay is never written', async () => {
  const { db, uid } = await populated();
  db.prepare('UPDATE solo_games SET rules = NULL WHERE id = 1').run();
  let out = exportLines(db);
  assert.equal(out.skipped.rules, 1);
  assert.equal(out.kept, 2);
  out = exportLines(db, { allRules: true });
  assert.equal(out.kept, 3);

  // a damaged record that got in some other way (it could not have through the server)
  const bad = copy(simulate(4, 61).record);
  bad.moves[0].cards = [bad.deals[bad.moves[0].seat].find((c) => !bad.moves[0].cards.includes(c))];
  db.prepare(
    "INSERT INTO solo_games (user_id, client_id, level, players, won, delta, ended, rules, record) VALUES (?, 'damaged-1', 'easy', 4, 0, -5, 1, ?, ?)",
  ).run(uid, RULES_VERSION, JSON.stringify(bad));
  out = exportLines(db);
  assert.equal(out.skipped.replay, 1);
  assert.equal(out.kept, 2);
  assert.ok(
    out.lines.every((l) => l.game !== 4 || l.source !== 'solo'),
    'the damaged game is not in the output',
  );
});

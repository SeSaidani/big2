// The game diary: every game is written down move by move as it is played (not when it ends), with who was
// connected, so a game that never finishes is still on record and a screen that did not match the game can be checked
// against what the server did. Only an admin can read it, because it holds hands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/cards.js';
import { legalMoves, turnRules, moveLog, initialDeals } from '../src/game.js';
import { openDb, addGameEvent, pruneGameEvents, listGameRounds, loadGameEvents, KEEP_ROUNDS } from '../server/db.js';
import { boot, seasonPlayers, until } from './support.js';

const config = { startDelayMs: 100, nextGameDelayMs: 600000, clockMs: 20 };
const names4 = ['pam', 'quin', 'ros', 'sam'];
const tableOf = (ctx) => ctx.app.lobby.table;
const rows = (ctx) => ctx.app.db.prepare('SELECT kind, round FROM game_events ORDER BY id').all();

// Plays `n` moves (or to the end if n is not given) as whoever's turn it is: the first legal play, else a pass.
function play(ctx, people, n = Infinity) {
  const t = tableOf(ctx);
  for (let i = 0; i < n && t.status === 'playing'; i++) {
    const g = t.game;
    const person = people.find((c) => c.user.id === t.seats[g.turn].userId);
    const legal = legalMoves(g);
    const cards = legal.length ? legal[0].cards : null;
    assert.ok(cards || turnRules(g).canPass, 'a move exists');
    t.move(person.user.id, cards);
  }
}

async function started(extra = {}) {
  const ctx = await boot({ ...config, rng: mulberry32(7), ...extra });
  const people = await seasonPlayers(ctx, names4);
  await until(() => tableOf(ctx).status === 'playing', 3000, 'a game in progress');
  return { ctx, people };
}

test('a finished game is in the diary exactly as the engine played it, and ends with its result', async () => {
  const { ctx, people } = await started();
  try {
    const t = tableOf(ctx);
    const dealt = t.game.hands.map((h) => [...h]);
    play(ctx, people);
    assert.equal(t.status, 'done');
    const [round] = listGameRounds(ctx.app.db);
    const events = loadGameEvents(ctx.app.db, round.round);
    assert.equal(events[0].kind, 'deal');
    assert.deepEqual(events[0].data.hands, dealt, 'the deal is written before a card is played');
    assert.deepEqual(initialDeals(t.game), dealt);
    const moves = events.filter((e) => e.kind === 'move');
    assert.deepEqual(
      moves.map((e) => ({ seat: e.seat, cards: e.cards, auto: e.auto })),
      moveLog(t.game),
      'every play, pass and automatic pass, in order, none missing',
    );
    assert.deepEqual(
      moves.map((e) => e.data.n),
      moves.map((_, i) => i),
      'numbered with no gaps',
    );
    const end = events[events.length - 1];
    assert.equal(end.kind, 'end');
    assert.equal(end.data.why, 'finished');
    assert.deepEqual(end.data.delta, t.result.delta);
    assert.ok(
      events.filter((e) => e.kind === 'move').every((e) => e.data.online.length === 4),
      'who was connected is written with each move',
    );
  } finally {
    await ctx.app.close();
  }
});

test('a game that never finishes is on record up to the last move made', async () => {
  const { ctx, people } = await started();
  try {
    play(ctx, people, 6);
    const t = tableOf(ctx);
    assert.equal(t.status, 'playing');
    const kinds = rows(ctx).map((r) => r.kind);
    assert.equal(kinds[0], 'deal');
    assert.equal(kinds.filter((k) => k === 'move').length, t.game.history.length);
    assert.ok(!kinds.includes('end'), 'no result yet');
    const last = loadGameEvents(ctx.app.db, rows(ctx)[0].round)
      .filter((e) => e.kind === 'move')
      .pop();
    assert.equal(last.data.turn, t.game.turn, 'the last move says whose turn it is');
    assert.deepEqual(
      last.data.counts,
      t.game.hands.map((h) => h.length),
    );
  } finally {
    await ctx.app.close();
  }
});

test('someone dropping off and coming back is written down, once for each change', async () => {
  const { ctx, people } = await started();
  try {
    const t = tableOf(ctx);
    const seat = t.seats.findIndex((s) => s.userId === people[1].user.id);
    people[1].ev.close();
    await until(
      () =>
        loadGameEvents(ctx.app.db, rows(ctx)[0].round).some((e) => e.kind === 'conn' && e.data.online[seat] === false),
      3000,
      'the disconnect in the diary',
    );
    const conn = loadGameEvents(ctx.app.db, rows(ctx)[0].round).filter((e) => e.kind === 'conn');
    assert.equal(conn.length, 1, 'one entry for one change');
  } finally {
    await ctx.app.close();
  }
});

test('a diary that cannot be written never stops a game', async () => {
  const { ctx, people } = await started();
  try {
    ctx.app.db.exec('DROP TABLE game_events');
    play(ctx, people);
    assert.equal(tableOf(ctx).status, 'done', 'the game finished and was scored');
    assert.equal(ctx.app.db.prepare('SELECT COUNT(*) AS n FROM games').get().n, 1);
  } finally {
    await ctx.app.close();
  }
});

test('only the most recent games are kept, and a game is listed newest first', () => {
  const db = openDb();
  for (let r = 0; r < KEEP_ROUNDS + 5; r++) {
    addGameEvent(db, { round: `t-${r}`, at: r, kind: 'deal', data: { r } });
    addGameEvent(db, { round: `t-${r}`, at: r + 1, kind: 'move', seat: 0, cards: [r], auto: false });
  }
  pruneGameEvents(db);
  const rounds = listGameRounds(db, 1000);
  assert.equal(rounds.length, KEEP_ROUNDS);
  assert.equal(rounds[0].round, `t-${KEEP_ROUNDS + 4}`);
  assert.equal(rounds[0].events, 2);
  assert.equal(loadGameEvents(db, 't-0').length, 0, 'the oldest games are gone');
  assert.deepEqual(
    loadGameEvents(db, 't-9').map((e) => e.kind),
    ['deal', 'move'],
  );
  assert.deepEqual(loadGameEvents(db, 't-9')[1].cards, [9]);
});

test('only an admin can read the diary, and an unknown game is not found', async () => {
  const { ctx, people } = await started();
  try {
    play(ctx, people, 3);
    assert.equal((await people[0].req('GET', '/api/admin/game-events')).status, 403, 'a player is refused');
    const list = await ctx.admin.req('GET', '/api/admin/game-events');
    assert.equal(list.status, 200);
    assert.equal(list.json.rounds.length, 1);
    const one = await ctx.admin.req(
      'GET',
      `/api/admin/game-events?round=${encodeURIComponent(list.json.rounds[0].round)}`,
    );
    assert.equal(one.status, 200);
    assert.equal(one.json.events[0].kind, 'deal');
    assert.equal((await people[0].req('GET', '/api/admin/game-events?round=x')).status, 403);
    assert.equal((await ctx.admin.req('GET', '/api/admin/game-events?round=nope')).status, 404);
  } finally {
    await ctx.app.close();
  }
});

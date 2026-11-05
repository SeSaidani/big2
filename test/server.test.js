import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseMove } from '../src/ai/agents.js';
import { mulberry32 } from '../src/cards.js';
import { loadLive, openDb, loadGameRecord, deleteSeason, createSeason } from '../server/db.js';
import { replayRecord } from '../src/game.js';
import {
  PASSWORD,
  boot,
  sleep,
  until,
  Client,
  makeUser,
  isTable,
  isDone,
  checkNoLeak,
  driveEasy,
  seatPlayers,
} from './support.js';

const tableOf = (ctx) => ctx.app.lobby.table;

// The newest finished game must have been saved with its deal and moves, and replay to the same win.
function assertRecordReplays(ctx, players, winner) {
  const id = ctx.app.db.prepare("SELECT id FROM games WHERE status = 'finished' ORDER BY id DESC LIMIT 1").get().id;
  const rec = loadGameRecord(ctx.app.db, id);
  assert.ok(rec, 'the game was saved with a record');
  assert.equal(rec.players, players);
  assert.equal(rec.deals.flat().length, 56);
  assert.ok(rec.moves.some((m) => m.cards) && rec.moves.length > players);
  assert.equal(replayRecord(rec).winner, winner);
}

test('accounts: registration is closed by default; opened by the admin it works', async () => {
  const ctx = await boot();
  try {
    const anon = new Client(ctx.base);
    assert.equal((await anon.req('GET', '/api/config')).json.registrationOpen, false);
    const closed = await anon.req('POST', '/api/register', { name: 'Alice', password: PASSWORD });
    assert.equal(closed.status, 403);

    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    assert.equal((await admin.req('POST', '/api/admin/settings', { registrationOpen: true })).status, 200);
    assert.equal((await anon.req('GET', '/api/config')).json.registrationOpen, true);

    const a = new Client(ctx.base);
    assert.equal((await a.req('POST', '/api/register', { name: 'Alice', password: PASSWORD })).status, 201);
    assert.equal((await a.req('GET', '/api/me')).json.user.name, 'Alice');
    assert.equal((await a.req('GET', '/api/me')).json.user.isAdmin, false);
    assert.equal(
      (
        await new Client(ctx.base).req('POST', '/api/register', {
          name: 'alice',
          password: PASSWORD,
        })
      ).status,
      409,
    );
    for (const bad of [
      { name: 'x', password: PASSWORD },
      { name: 'ok_name', password: 'short' },
      { name: 'bad name!', password: PASSWORD },
    ]) {
      assert.equal((await new Client(ctx.base).req('POST', '/api/register', bad)).status, 400);
    }
    // Self-registration never makes an admin, even if asked.
    const sneaky = new Client(ctx.base);
    await sneaky.req('POST', '/api/register', {
      name: 'sneaky',
      password: PASSWORD,
      isAdmin: true,
    });
    assert.equal((await sneaky.req('GET', '/api/me')).json.user.isAdmin, false);

    const b = new Client(ctx.base);
    assert.equal((await b.req('POST', '/api/login', { name: 'ALICE', password: 'wrong-password-123' })).status, 401);
    assert.equal((await b.req('POST', '/api/login', { name: 'nobody', password: PASSWORD })).status, 401);
    await b.login('ALICE');
    const cookie = b.cookie;
    await b.req('POST', '/api/logout', {});
    const stale = new Client(ctx.base);
    stale.cookie = cookie;
    assert.equal((await stale.req('GET', '/api/me')).status, 401);
    const row = ctx.app.db.prepare('SELECT pw_hash FROM users WHERE name = ?').get('Alice');
    assert.match(row.pw_hash, /^scrypt\$/);
    assert.ok(!row.pw_hash.includes(PASSWORD));
    assert.deepEqual(ctx.logs, []);
  } finally {
    await ctx.app.close();
  }
});

test('login attempts are rate limited', async () => {
  const ctx = await boot();
  try {
    await makeUser(ctx, 'Victim');
    const c = new Client(ctx.base);
    for (let i = 0; i < 10; i++) {
      assert.equal((await c.req('POST', '/api/login', { name: 'Victim', password: 'wrong-password-123' })).status, 401);
    }
    assert.equal((await c.req('POST', '/api/login', { name: 'Victim', password: PASSWORD })).status, 429);
  } finally {
    await ctx.app.close();
  }
});

test('hardening: auth required, body size, content type, origin, static whitelist', async () => {
  const { app, base } = await boot();
  try {
    const anon = new Client(base);
    for (const [m, p] of [
      ['GET', '/api/events'],
      ['GET', '/api/me'],
      ['POST', '/api/game'],
      ['GET', '/api/game'],
      ['POST', '/api/game/chat'],
    ]) {
      assert.equal((await anon.req(m, p, m === 'POST' ? {} : undefined)).status, 401, p);
    }
    for (const p of ['/api/admin/users', '/api/admin/overview', '/api/admin/audit']) {
      assert.equal((await anon.req('GET', p)).status, 401, p);
    }
    assert.equal((await anon.req('POST', '/api/login', { name: 'a', password: 'x'.repeat(5000) })).status, 413);
    const r = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x',
    });
    assert.equal(r.status, 415);
    assert.equal(
      (await anon.req('POST', '/api/login', { name: 'a', password: 'b' }, { origin: 'http://evil.example' })).status,
      403,
    );
    assert.equal((await anon.req('POST', '/api/login', { name: 'a', password: 'b' }, { origin: base })).status, 401);
    for (const p of ['/server/db.js', '/package.json', '/data/big2.db', '/test/server.test.js']) {
      assert.equal((await fetch(base + p)).status, 404, p);
    }
    // Signed in, the same traversal tricks under /src/ still find nothing.
    const member = await makeUser({ app, base }, 'walker');
    for (const p of ['/src/..%2fpackage.json', '/src/%2e%2e/package.json', '/src/../package.json']) {
      const r = await fetch(base + p, { headers: { cookie: member.cookie } });
      assert.equal(r.status, 404, p);
    }
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetch(base + '/src/game.js')).status, 401); // the game needs a sign-in (login-gate.test.js)
    const icon = await fetch(base + '/favicon.svg');
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get('content-type'), /svg/);
    // The installable-app files are public; look-alike names are not.
    assert.match((await fetch(base + '/manifest.webmanifest')).headers.get('content-type'), /manifest\+json/);
    for (const n of [180, 192, 512]) {
      const r = await fetch(`${base}/icon-${n}.png`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'image/png');
    }
    for (const p of ['/icon-999.png', '/icon-180.png/../package.json', '/README.md', '/manifest.json']) {
      assert.equal((await fetch(base + p)).status, 404, p);
    }
  } finally {
    await app.close();
  }
});

test('one account cannot hold unlimited event streams open', async () => {
  const ctx = await boot();
  const aborts = [];
  try {
    const user = await makeUser(ctx, 'streamer');
    const statuses = [];
    for (let i = 0; i < 10; i++) {
      const ac = new AbortController();
      aborts.push(ac);
      const r = await fetch(ctx.base + '/api/events', { headers: { cookie: user.cookie }, signal: ac.signal });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 200, 429, 429]);
    // Closing one frees a slot.
    aborts[0].abort();
    await until(() => ctx.app.hub.conns.get(user.user.id).size === 7, 3000, 'a stream to close');
    const ac = new AbortController();
    aborts.push(ac);
    assert.equal(
      (await fetch(ctx.base + '/api/events', { headers: { cookie: user.cookie }, signal: ac.signal })).status,
      200,
    );
  } finally {
    for (const ac of aborts) ac.abort();
    await ctx.app.close();
  }
});

test('only an admin creates a game, and only one game exists at a time', async () => {
  const ctx = await boot();
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    const pleb = await makeUser(ctx, 'pleb');
    assert.equal((await pleb.req('POST', '/api/game', { aiLevel: 'easy' })).status, 403);
    assert.equal((await admin.req('POST', '/api/game', { aiLevel: 'easy' })).status, 201);
    // A second game, from anyone, is refused while one exists.
    assert.equal((await admin.req('POST', '/api/game', { aiLevel: 'easy' })).status, 409);
    const other = await makeUser(ctx, 'otheradmin', { isAdmin: true });
    assert.equal((await other.req('POST', '/api/game', { aiLevel: 'easy' })).status, 409);
    // Everyone sees the single game's summary.
    const lobby = (await pleb.req('GET', '/api/game')).json;
    assert.equal(lobby.game.status, 'waiting');
    assert.deepEqual(lobby.game.players, ['boss']);
    assert.equal(lobby.table, null); // not seated yet
    assert.deepEqual(ctx.logs, []);
  } finally {
    await ctx.app.close();
  }
});

test('four humans play a full game: no view leaks a hand, result is zero-sum and saved', async () => {
  const ctx = await boot({ rng: mulberry32(7) });
  try {
    const clients = await seatPlayers(ctx, 'full');
    for (const c of clients) driveEasy(c, c.ev, () => tableOf(ctx).game);
    assert.equal((await clients[0].req('POST', '/api/game/start')).status, 200);
    const finals = await Promise.all(clients.map((c) => c.ev.waitFor(isDone, 30000)));
    for (const c of clients) assert.deepEqual(c.errors, []);

    const r = finals[0].data.result;
    assert.equal(
      r.delta.reduce((a, b) => a + b, 0),
      0,
    );
    assert.ok(r.delta[r.winner] > 0);
    assert.equal(r.hasAi, false);
    assert.equal(r.saved, true);
    for (const f of finals) assert.deepEqual(f.data.result, r);
    assert.equal(finals[0].data.hands[r.winner].length, 0);
    assertRecordReplays(ctx, 4, r.winner);

    assert.equal(ctx.app.db.prepare("SELECT COUNT(*) AS n FROM games WHERE status = 'finished'").get().n, 1);
    assert.equal(ctx.app.db.prepare('SELECT SUM(delta) AS s FROM results').get().s, 0);
    assert.equal((await clients[0].req('GET', '/api/leaderboard?kind=human')).json.rows.length, 4);
    // There is no computer board: asking for one gets the one board, and a game with computers never joins it.
    assert.equal((await clients[0].req('GET', '/api/leaderboard?kind=ai')).json.rows.length, 4);
    assert.deepEqual(ctx.logs, []);

    // A finished round does not block the next game: an admin simply creates one.
    assert.equal((await clients[0].req('POST', '/api/game', { aiLevel: 'easy' })).status, 201);
    assert.equal(tableOf(ctx).status, 'waiting');
  } finally {
    await ctx.app.close();
  }
});

test('three humans at a table of three play a full game: view and result have three seats', async () => {
  const ctx = await boot({ devTables: true, rng: mulberry32(11) });
  try {
    const clients = await seatPlayers(ctx, 'tri', 3, 'easy', 3);
    for (const c of clients) driveEasy(c, c.ev, () => tableOf(ctx).game);
    assert.equal((await clients[0].req('POST', '/api/game/start')).status, 200);
    const finals = await Promise.all(clients.map((c) => c.ev.waitFor(isDone, 30000)));
    for (const c of clients) assert.deepEqual(c.errors, []);

    const r = finals[0].data.result;
    assert.equal(r.delta.length, 3);
    assert.equal(finals[0].data.seats.length, 3);
    assert.equal(
      r.delta.reduce((a, b) => a + b, 0),
      0,
    );
    assert.ok(r.delta[r.winner] > 0);
    assert.equal(r.saved, true);
    assert.equal(finals[0].data.hands.length, 3);
    assert.equal(finals[0].data.hands[r.winner].length, 0);
    assertRecordReplays(ctx, 3, r.winner);
    assert.equal(ctx.app.db.prepare('SELECT COUNT(*) AS n FROM results').get().n, 3);
    assert.equal(ctx.app.db.prepare('SELECT SUM(delta) AS s FROM results').get().s, 0);
    assert.deepEqual(ctx.logs, []);
  } finally {
    await ctx.app.close();
  }
});

test('a game has 3 or 4 seats and nothing else', async () => {
  const ctx = await boot({ devTables: true, rng: mulberry32(12) });
  try {
    const admin = await makeUser(ctx, 'seatadmin', { isAdmin: true });
    assert.equal((await admin.req('POST', '/api/game', { aiLevel: 'nonsense' })).status, 400, 'an unknown AI level');
    for (const seats of [2, 5, 0, 'x']) {
      const r = await admin.req('POST', '/api/game', { aiLevel: 'easy', seats });
      assert.equal(r.status, 400, `seats=${seats}`);
    }
    assert.equal((await admin.req('POST', '/api/game', { aiLevel: 'easy', seats: 3 })).status, 201);
    assert.equal(tableOf(ctx).seats.length, 3);
  } finally {
    await ctx.app.close();
  }
});

test('a game with computer players is saved, but it is on no board and not in Luck & skill', async () => {
  const ctx = await boot({ devTables: true, rng: mulberry32(33) });
  try {
    const clients = await seatPlayers(ctx, 'cpu', 1);
    driveEasy(clients[0], clients[0].ev, () => tableOf(ctx).game);
    assert.equal((await clients[0].req('POST', '/api/game/start')).status, 200);
    const done = await clients[0].ev.waitFor(isDone, 30000);
    assert.deepEqual(clients[0].errors, []);
    assert.equal(done.data.result.hasAi, true);
    assert.equal(done.data.result.saved, true);
    assertRecordReplays(ctx, 4, done.data.result.winner); // it is still saved in full

    const db = ctx.app.db;
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM games WHERE status = 'finished' AND has_ai = 1").get().n, 1);
    const lb = await clients[0].req('GET', '/api/leaderboard?season=current');
    assert.deepEqual(lb.json.rows, []);
    const st = await clients[0].req('GET', '/api/stats?season=current');
    assert.deepEqual(st.json.rows, []);
    assert.equal(st.json.pending, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM game_expectation').get().n, 0, 'it was not priced');
  } finally {
    await ctx.app.close();
  }
});

test('a season game: four people, no computer players, started only when the table is full', async () => {
  const ctx = await boot({ rng: mulberry32(51) });
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    assert.equal((await admin.req('POST', '/api/game', { seats: 3 })).status, 400, 'a season game has 4 players');
    assert.equal(
      (await admin.req('POST', '/api/game', { aiLevel: 'hard' })).status,
      201,
      'the AI level is simply unused',
    );
    const table = tableOf(ctx);
    assert.equal(table.seats.length, 4);
    assert.equal(table.aiLevel, 'medium');

    // Alone, and then with two more, the host cannot start: every seat needs a person.
    let start = await admin.req('POST', '/api/game/start');
    assert.equal(start.status, 409);
    assert.match(start.json.error, /3 more players are needed/);
    for (const name of ['pat', 'quinn']) {
      assert.equal((await (await makeUser(ctx, name)).req('POST', '/api/game/join')).status, 200);
    }
    start = await admin.req('POST', '/api/game/start');
    assert.equal(start.status, 409);
    assert.match(start.json.error, /1 more player is needed/);
    assert.equal(table.status, 'waiting', 'nothing started');
    assert.equal(table.seats.filter((x) => x.kind === 'ai').length, 0, 'no computer seat was added');

    // The fourth person joins, and now it starts, with four people and no computer.
    assert.equal((await (await makeUser(ctx, 'rosa')).req('POST', '/api/game/join')).status, 200);
    assert.equal((await admin.req('POST', '/api/game/start')).status, 200);
    assert.equal(table.status, 'playing');
    assert.deepEqual(
      table.seats.map((x) => x.kind),
      ['human', 'human', 'human', 'human'],
    );
  } finally {
    await ctx.app.close();
  }
});

test('an online game can only be created while a season is running', async () => {
  const ctx = await boot();
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    deleteSeason(ctx.app.db, 1); // the automatic Season 1: now there is a gap with no season
    const refused = await admin.req('POST', '/api/game', { seats: 4 });
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /No season is running/);
    assert.equal(tableOf(ctx), null);
    createSeason(ctx.app.db, { name: 'Autumn', starts: Date.now() - 1000, ends: null });
    assert.equal((await admin.req('POST', '/api/game', { seats: 4 })).status, 201);
  } finally {
    await ctx.app.close();
  }
});

test('the server says whether the development table rules are on, and they are off by default', async () => {
  for (const [opts, expected] of [
    [{}, false],
    [{ devTables: true }, true],
  ]) {
    const ctx = await boot(opts);
    try {
      assert.equal((await new Client(ctx.base).req('GET', '/api/config')).json.devTables, expected);
    } finally {
      await ctx.app.close();
    }
  }
});

test('rejected moves change nothing; join rules; reconnect resumes the current view', async () => {
  const ctx = await boot({ rng: mulberry32(11) });
  try {
    const clients = await seatPlayers(ctx, 'rej');
    const table = tableOf(ctx);
    assert.equal((await clients[1].req('POST', '/api/game/start')).status, 403); // not the host
    const late = await makeUser(ctx, 'late');
    assert.equal((await late.req('POST', '/api/game/join')).status, 409); // full
    assert.equal((await clients[1].req('POST', '/api/game', { aiLevel: 'easy' })).status, 403);

    assert.equal((await clients[0].req('POST', '/api/game/start')).status, 200);
    assert.equal((await late.req('POST', '/api/game/join')).status, 409); // started
    const turn = table.game.turn;
    const mover = clients[turn];
    const other = clients[(turn + 1) % 4];
    const v0 = table.version;
    const snapshot = JSON.stringify(table.game);
    const attempts = [
      [other, { cards: [0] }, 409], // out of turn
      [mover, { cards: null }, 422], // the opening play cannot be passed
      [mover, { cards: [table.game.hands[(turn + 1) % 4][0]] }, 422], // a card someone else holds
      [mover, { cards: [table.game.hands[turn].find((c) => c !== 0)] }, 422], // must include 3♦
      [mover, { cards: [0, 0] }, 400],
      [mover, { cards: [99] }, 400],
      [mover, { cards: [] }, 400],
      [mover, { cards: 'x' }, 400],
      [mover, {}, 400],
    ];
    for (const [c, body, status] of attempts) {
      const r = await c.req('POST', '/api/game/move', body);
      assert.equal(r.status, status, JSON.stringify(body));
    }
    assert.equal(table.version, v0);
    assert.equal(JSON.stringify(table.game), snapshot);

    mover.ev.close();
    const again = mover.openEvents();
    const first = await again.waitFor(isTable);
    assert.equal(first.data.you, turn);
    checkNoLeak(first.data, table.game);

    assert.equal((await mover.req('POST', '/api/game/move', { cards: [0] })).status, 200);
    assert.ok(table.version > v0);
    assert.deepEqual(ctx.logs, []);
  } finally {
    await ctx.app.close();
  }
});

test('an away player holds the game: no timer, no auto-play', async () => {
  const ctx = await boot({ devTables: true, rng: mulberry32(5) });
  try {
    const admin = await makeUser(ctx, 'solo', { isAdmin: true });
    await admin.req('POST', '/api/game', { aiLevel: 'easy' });
    await admin.req('POST', '/api/game/start');
    const table = tableOf(ctx);
    // Bots play until it is the human's turn, then everything stops.
    await until(() => table.game.turn === 0, 5000, "the human's turn");
    const v = table.version;
    const snapshot = JSON.stringify(table.game);
    await sleep(400);
    assert.equal(table.version, v);
    assert.equal(JSON.stringify(table.game), snapshot);
    assert.equal(table.status, 'playing');
    // They come back and carry on.
    const view = (await admin.req('GET', '/api/game')).json.table;
    const mv = chooseMove(view.game.view, 'easy');
    assert.equal((await admin.req('POST', '/api/game/move', { cards: mv ? mv.cards : null })).status, 200);
    assert.deepEqual(ctx.logs, []);
  } finally {
    await ctx.app.close();
  }
});

test('leaving: waiting room frees the seat; a started game holds it', async () => {
  const ctx = await boot({ devTables: true, rng: mulberry32(3) });
  try {
    const clients = await seatPlayers(ctx, 'lv', 3);
    const table = tableOf(ctx);
    assert.equal(table.humans().length, 3);
    assert.equal((await clients[2].req('POST', '/api/game/leave')).status, 200);
    assert.equal(table.humans().length, 2);
    assert.equal((await clients[2].req('GET', '/api/game')).json.table, null);
    assert.equal((await clients[2].req('POST', '/api/game/join')).status, 200); // can come back

    await clients[0].req('POST', '/api/game/start');
    const r = await clients[2].req('POST', '/api/game/leave');
    assert.equal(r.status, 409);
    assert.match(r.json.error, /holds your seat/);
    assert.equal(table.seatOf(clients[2].user.id), 2);
    assert.equal(tableOf(ctx).status, 'playing');
    // Seated players still see their table after "leaving the page".
    assert.ok((await clients[2].req('GET', '/api/game')).json.table);
  } finally {
    await ctx.app.close();
  }
});

test('the whole table disappears when the last person leaves the waiting room', async () => {
  const ctx = await boot();
  try {
    const admin = await makeUser(ctx, 'solo', { isAdmin: true });
    await admin.req('POST', '/api/game', { aiLevel: 'easy' });
    assert.ok(tableOf(ctx));
    await admin.req('POST', '/api/game/leave');
    assert.equal(tableOf(ctx), null);
    assert.equal(loadLive(ctx.app.db), null);
  } finally {
    await ctx.app.close();
  }
});

test('an admin cancel ends a running game, unscored; only an admin can do it', async () => {
  const ctx = await boot({ rng: mulberry32(9) });
  try {
    const clients = await seatPlayers(ctx, 'cx');
    await clients[0].req('POST', '/api/game/start');
    const pleb = clients[1];
    for (const p of ['/api/admin/game/cancel']) assert.equal((await pleb.req('POST', p, {})).status, 403, p);
    // The host is an admin but a plain player cannot cancel; nor is there a player-side cancel route.
    assert.equal((await pleb.req('POST', '/api/game/cancel', {})).status, 404);
    assert.equal(tableOf(ctx).status, 'playing');

    // (Each client's stream already carries a null "table" from before it was seated.)
    const seen = pleb.ev.log.length;
    const gone = () => pleb.ev.log.slice(seen).some((m) => m.event === 'table' && m.data === null);
    assert.equal((await clients[0].req('POST', '/api/admin/game/cancel', {})).status, 200);
    await until(gone, 5000, 'the cancelled game to disappear for a seated player');
    assert.equal(tableOf(ctx), null);
    assert.equal(loadLive(ctx.app.db), null);
    // Recorded as cancelled, with no results, so it never reaches a leaderboard.
    const g = ctx.app.db.prepare('SELECT status FROM games').all();
    assert.deepEqual(
      g.map((x) => x.status),
      ['cancelled'],
    );
    assert.equal(ctx.app.db.prepare('SELECT COUNT(*) AS n FROM results').get().n, 0);
    assert.equal((await pleb.req('GET', '/api/leaderboard?kind=human')).json.rows.length, 0);
    // The slot is free again.
    assert.equal((await clients[0].req('POST', '/api/game', { aiLevel: 'easy' })).status, 201);
    // Cancelling a game that never started records nothing.
    await clients[0].req('POST', '/api/admin/game/cancel', {});
    assert.equal(ctx.app.db.prepare('SELECT COUNT(*) AS n FROM games').get().n, 1);
    assert.deepEqual(ctx.logs, []);
  } finally {
    await ctx.app.close();
  }
});

test('chat: needs two humans, is validated and rate limited, and history reaches reconnecting clients', async () => {
  const ctx = await boot({ rng: mulberry32(2) });
  try {
    const clients = await seatPlayers(ctx, 'ch', 1);
    const [a] = clients;
    // One human: no chat.
    assert.equal((await a.req('POST', '/api/game/chat', { text: 'hello?' })).status, 409);
    assert.equal((await a.req('GET', '/api/game')).json.table.chatEnabled, false);

    const b = await makeUser(ctx, 'ch2');
    b.ev = b.openEvents();
    await b.ev.waitFor((m) => m.event === 'lobby');
    await b.req('POST', '/api/game/join');
    assert.equal((await a.req('GET', '/api/game')).json.table.chatEnabled, true);

    const got = a.ev.waitFor((m) => m.event === 'chat' && m.data.text === 'hi there');
    const gotB = b.ev.waitFor((m) => m.event === 'chat' && m.data.text === 'hi there');
    assert.equal((await b.req('POST', '/api/game/chat', { text: '  hi there  ' })).status, 200);
    const msg = (await got).data;
    await gotB;
    assert.equal(msg.name, 'ch2');
    assert.equal(msg.id, 1);

    // Plain text only: markup and control characters stay inert text.
    assert.equal(
      (await a.req('POST', '/api/game/chat', { text: '<img src=x onerror=alert(1)>\u0000\u0007' })).status,
      200,
    );
    const stored = tableOf(ctx).chat.at(-1).text;
    assert.equal(stored, '<img src=x onerror=alert(1)>');
    for (const [body, status] of [
      [{ text: '' }, 400],
      [{ text: '   ' }, 400],
      [{ text: 'x'.repeat(301) }, 400],
      [{ text: 5 }, 400],
      [{}, 400],
    ]) {
      assert.equal((await a.req('POST', '/api/game/chat', body)).status, status, JSON.stringify(body));
    }
    const outsider = await makeUser(ctx, 'outsider');
    assert.equal((await outsider.req('POST', '/api/game/chat', { text: 'let me in' })).status, 403);

    // Rate limit: 5 per 10 seconds per user (two were used above by `a`... and 1 by b).
    let limited = 0;
    for (let i = 0; i < 8; i++) {
      const r = await b.req('POST', '/api/game/chat', { text: `spam ${i}` });
      if (r.status === 429) limited++;
    }
    assert.ok(limited >= 3, `expected rate limiting, got ${limited} rejections`);

    // A reconnecting client is sent the history.
    b.ev.close();
    const again = b.openEvents();
    const hist = await again.waitFor((m) => m.event === 'chathistory');
    assert.equal(hist.data[0].text, 'hi there');
    assert.ok(hist.data.length >= 2);
    assert.deepEqual(ctx.logs, []);
  } finally {
    await ctx.app.close();
  }
});

test('a running game survives a server restart and carries on to a scored finish', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'big2-persist-'));
  const dbFile = path.join(dir, 'test.db');
  let ctx = await boot({ devTables: true, dbFile, rng: mulberry32(21) });
  try {
    const admin = await makeUser(ctx, 'keeper', { isAdmin: true });
    await admin.req('POST', '/api/game', { aiLevel: 'easy' });
    await admin.req('POST', '/api/game/start');
    let table = tableOf(ctx);
    await until(() => table.game.turn === 0, 5000, "the human's turn");
    // Make one real move so the saved state is not the opening position.
    const first = (await admin.req('GET', '/api/game')).json.table;
    const mv = chooseMove(first.game.view, 'easy', { rng: mulberry32(1) });
    assert.equal((await admin.req('POST', '/api/game/move', { cards: mv ? mv.cards : null })).status, 200);
    if (table.game.turn !== 0) {
      await until(() => table.game.turn === 0 || table.status !== 'playing', 5000, 'human turn again');
    }
    assert.equal(table.status, 'playing');
    await sleep(50);
    const before = {
      game: JSON.stringify(table.game),
      version: table.version,
      id: table.id,
      chat: table.chat,
      turnSince: table.turnSince,
    };
    const cookie = admin.cookie;
    await ctx.app.close(); // a restart: the live game must NOT be cancelled or lost
    const peek = openDb(dbFile);
    assert.equal(loadLive(peek).id, before.id, 'the live game is still saved after shutdown');
    peek.close();

    ctx = await boot({ devTables: true, dbFile, rng: mulberry32(21) });
    table = ctx.app.lobby.table;
    assert.ok(table, 'the table was restored');
    assert.equal(table.id, before.id);
    assert.equal(table.status, 'playing');
    assert.equal(JSON.stringify(table.game), before.game);
    assert.ok(table.version > before.version);
    assert.ok(before.turnSince > 0);
    assert.equal(table.turnSince, before.turnSince, 'when the turn began is restored, not reset');
    assert.equal(
      ctx.app.db.prepare('SELECT COUNT(*) AS n FROM games').get().n,
      0,
      'no game was recorded by the restart',
    );

    // The same session cookie still works and shows the same hand.
    const back = new Client(ctx.base);
    back.cookie = cookie;
    const view = (await back.req('GET', '/api/game')).json.table;
    assert.equal(view.you, 0);
    assert.deepEqual(view.game.view.hand, table.game.hands[0]);
    back.user = { id: 1 };
    // Play it out: the restored bots resume and the game finishes, scored.
    back.ev = back.openEvents();
    driveEasy(back, back.ev, () => tableOf(ctx).game);
    const done = await back.ev.waitFor(isDone, 30000);
    assert.deepEqual(back.errors, []);
    assert.equal(done.data.result.saved, true);
    // The moves made before the restart survive in the saved game, so the record is whole.
    assertRecordReplays(ctx, 4, done.data.result.winner);
    assert.equal(ctx.app.db.prepare("SELECT COUNT(*) AS n FROM games WHERE status = 'finished'").get().n, 1);
  } finally {
    await ctx.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

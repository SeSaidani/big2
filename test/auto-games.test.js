// Production rules: while a season is running there is always a table; four people start a game by
// themselves, the next game follows the last with the same people, and ending the season stops it all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mulberry32 } from '../src/cards.js';
import { boot, makeUser, until, sleep, driveEasy, isTable, isDone } from './support.js';

const fast = { startDelayMs: 150, nextGameDelayMs: 300, clockMs: 20 };
const tableOf = (ctx) => ctx.app.lobby.table;
const count = (ctx, sql) => ctx.app.db.prepare(sql).get().n;

// People who sit down at the table, each with an open event stream.
async function sitDown(ctx, names) {
  const people = [];
  for (const n of names) people.push(await makeUser(ctx, n));
  for (const c of people) {
    c.ev = c.openEvents();
    await c.ev.waitFor((m) => m.event === 'lobby');
    assert.equal((await c.req('POST', '/api/game/join')).status, 200);
  }
  return people;
}

test('a running season always has a table; no season, no table; a season starting by its dates opens one', async () => {
  const ctx = await boot(fast);
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    const t = tableOf(ctx);
    assert.equal(t.status, 'waiting');
    assert.equal(t.seats.length, 4);
    assert.equal(t.humans().length, 0, 'nobody is seated at first');
    assert.equal(t.hostId, null, 'nobody hosts it');
    const lobby = (await admin.req('GET', '/api/admin/overview')).json.game;
    assert.deepEqual([lobby.status, lobby.humans, lobby.seats], ['waiting', 0, 4]);

    // Delete the only season: nothing is running, so the empty table closes.
    assert.equal((await admin.req('POST', '/api/admin/seasons/1/delete', {})).status, 200);
    assert.equal(tableOf(ctx), null);
    // A season that starts later opens it when its time comes (the clock notices), not before.
    const starts = Date.now() + 400;
    assert.equal((await admin.req('POST', '/api/admin/seasons', { name: 'Later', starts, ends: null })).status, 201);
    assert.equal(tableOf(ctx), null, 'not yet');
    await until(() => tableOf(ctx) !== null, 3000, 'the table opening when the season starts');
    assert.ok(Date.now() >= starts - 5);
    assert.equal(tableOf(ctx).status, 'waiting');
  } finally {
    await ctx.app.close();
  }
});

test('nobody creates or starts a game by hand; four people seated start one by themselves; fewer do not', async () => {
  const ctx = await boot({ ...fast, rng: mulberry32(5) });
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    assert.equal((await admin.req('POST', '/api/game', {})).status, 409, 'the admin does not create games');
    assert.equal((await admin.req('POST', '/api/game/start', {})).status, 409, 'and nobody starts them');
    const [a, b, c] = await sitDown(ctx, ['pam', 'quin', 'ros']);
    await sleep(400); // far longer than the countdown
    assert.equal(tableOf(ctx).status, 'waiting', 'three people are not enough');
    assert.equal(tableOf(ctx).view(a.user.id).next, null);

    const [d] = await sitDown(ctx, ['sam']);
    const view = tableOf(ctx).view(d.user.id);
    assert.equal(view.next.kind, 'start', 'the fourth seat starts a countdown');
    assert.ok(view.next.at > Date.now() - 50 && view.next.at <= Date.now() + fast.startDelayMs + 50);
    assert.equal(view.isHost, false);
    await until(() => tableOf(ctx).status === 'playing', 3000, 'the game starting by itself');
    assert.equal(tableOf(ctx).game.hands.length, 4);
    assert.deepEqual(
      tableOf(ctx).seats.map((s) => s.kind),
      ['human', 'human', 'human', 'human'],
      'four people and no computer players',
    );
    // Keep the clients referenced so their streams stay open for the whole test.
    assert.ok(a && b && c);
  } finally {
    await ctx.app.close();
  }
});

test('leaving during the countdown cancels it; the seat can be taken again and the countdown restarts', async () => {
  const ctx = await boot({ ...fast, startDelayMs: 400 });
  try {
    const [a, b, c, d] = await sitDown(ctx, ['pam', 'quin', 'ros', 'sam']);
    assert.equal(tableOf(ctx).view(a.user.id).next.kind, 'start');
    assert.equal((await d.req('POST', '/api/game/leave')).status, 200);
    assert.equal(tableOf(ctx).view(a.user.id).next, null, 'the countdown is off');
    await sleep(600);
    assert.equal(tableOf(ctx).status, 'waiting', 'it did not start with three');
    const [e] = await sitDown(ctx, ['tom']);
    assert.equal(tableOf(ctx).view(e.user.id).next.kind, 'start', 'a full table counts down again');
    await until(() => tableOf(ctx).status === 'playing', 3000, 'the game starting');
    assert.ok(b && c);
  } finally {
    await ctx.app.close();
  }
});

test('when a game ends the next one follows with the same people, and every game is scored', async () => {
  const ctx = await boot({ ...fast, rng: mulberry32(7) });
  try {
    const people = await sitDown(ctx, ['pam', 'quin', 'ros', 'sam']);
    for (const c of people) driveEasy(c, c.ev, () => tableOf(ctx).game);
    const first = await people[0].ev.waitFor(isDone, 20000);
    assert.equal(first.data.next.kind, 'next', 'the results show what comes next');
    assert.equal(count(ctx, "SELECT COUNT(*) AS n FROM games WHERE status = 'finished'"), 1);
    const tableId = tableOf(ctx).id;
    const seatsBefore = tableOf(ctx).seats.map((s) => s.userId);

    // After the results have been up for a while, the next game is dealt to the same four.
    const again = await people[0].ev.waitFor(
      (m) => isTable(m) && m.data.status === 'playing' && m.data.version > first.data.version,
      10000,
    );
    assert.equal(again.data.result, null);
    assert.equal(again.data.next, null);
    assert.equal(tableOf(ctx).id, tableId, 'the same table');
    assert.deepEqual(
      tableOf(ctx).seats.map((s) => s.userId),
      seatsBefore,
      'the same people in the same seats',
    );
    // ... and it is a real new deal that plays to a second scored result.
    await people[0].ev.waitFor((m) => isDone(m) && m.data.version > again.data.version, 20000);
    assert.equal(count(ctx, "SELECT COUNT(*) AS n FROM games WHERE status = 'finished'"), 2);
    assert.equal(count(ctx, 'SELECT COUNT(*) AS n FROM results'), 8);
    for (const c of people) assert.deepEqual(c.errors, []);
  } finally {
    await ctx.app.close();
  }
});

test('someone who leaves the results is replaced before the next game starts', async () => {
  const ctx = await boot({ ...fast, nextGameDelayMs: 600, rng: mulberry32(7) });
  try {
    const people = await sitDown(ctx, ['pam', 'quin', 'ros', 'sam']);
    await makeUser(ctx, 'tomx'); // a fifth account, so there is someone to take a seat over
    for (const c of people) driveEasy(c, c.ev, () => tableOf(ctx).game);
    await people[0].ev.waitFor(isDone, 20000);
    assert.equal((await people[3].req('POST', '/api/game/leave')).status, 200, 'leaving the results is allowed');
    assert.equal(count(ctx, "SELECT COUNT(*) AS n FROM games WHERE status = 'forfeit'"), 0, 'and costs nothing');
    await until(() => tableOf(ctx).status === 'waiting', 3000, 'waiting for a replacement');
    assert.equal(tableOf(ctx).humans().length, 3);
    const [tom] = await sitDown(ctx, ['tomy']);
    await until(() => tableOf(ctx).status === 'playing', 3000, 'the next game');
    assert.ok(tableOf(ctx).seats.some((s) => s.userId === tom.user.id));
    assert.ok(!tableOf(ctx).seats.some((s) => s.userId === people[3].user.id));
  } finally {
    await ctx.app.close();
  }
});

test('ending the season stops the game in progress (unscored) and closes the table', async () => {
  const ctx = await boot({ ...fast, rng: mulberry32(7) });
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    const people = await sitDown(ctx, ['pam', 'quin', 'ros', 'sam']);
    await until(() => tableOf(ctx).status === 'playing', 3000, 'a game in progress');
    const season = (await admin.req('GET', '/api/seasons')).json.seasons[0];
    const ended = await admin.req('POST', `/api/admin/seasons/${season.id}/end`, {});
    assert.equal(ended.status, 200, JSON.stringify(ended.json));
    assert.equal(tableOf(ctx), null, 'the table is gone and no new one opens');
    assert.equal(count(ctx, "SELECT COUNT(*) AS n FROM games WHERE status = 'cancelled'"), 1);
    assert.equal(count(ctx, "SELECT COUNT(*) AS n FROM games WHERE status = 'finished'"), 0, 'nothing was scored');
    assert.equal(count(ctx, 'SELECT COUNT(*) AS n FROM results'), 0);
    await people[0].ev.waitFor((m) => m.event === 'table' && m.data === null, 3000); // everybody is told
    const audit = (await admin.req('GET', '/api/admin/audit?limit=3')).json.entries[0];
    assert.equal(audit.action, 'end_season');
    assert.match(audit.detail, /stopped, not scored/);
    await sleep(100);
    assert.equal(tableOf(ctx), null);
    // A new season opens a table again.
    assert.equal(
      (await admin.req('POST', '/api/admin/seasons', { name: 'Next', starts: Date.now(), ends: null })).status,
      201,
    );
    assert.equal(tableOf(ctx).status, 'waiting');
    assert.equal(tableOf(ctx).humans().length, 0, 'with the seats empty');
  } finally {
    await ctx.app.close();
  }
});

test('a season ending by its dates lets the game in progress finish, and then there is no next one', async () => {
  const ctx = await boot({ ...fast, rng: mulberry32(7) });
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    const people = await sitDown(ctx, ['pam', 'quin', 'ros', 'sam']);
    await until(() => tableOf(ctx).status === 'playing', 3000, 'a game in progress');
    const season = (await admin.req('GET', '/api/seasons')).json.seasons[0];
    // The season's end date arrives while they are playing (the admin moves it to now, not "End now").
    const moved = await admin.req('POST', `/api/admin/seasons/${season.id}`, {
      name: season.name,
      starts: season.starts,
      ends: Date.now(),
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.json));
    assert.equal(tableOf(ctx).status, 'playing', 'the game is left alone');
    for (const c of people) driveEasy(c, c.ev, () => tableOf(ctx).game);
    tableOf(ctx).touch(); // a fresh view for the players' bots, which were attached after the deal
    await people[0].ev.waitFor(isDone, 20000);
    assert.equal(
      count(ctx, "SELECT COUNT(*) AS n FROM games WHERE status = 'finished'"),
      1,
      'it finished and was scored',
    );
    await until(() => tableOf(ctx) === null, 3000, 'the table closing after the results');
    await sleep(150);
    assert.equal(tableOf(ctx), null, 'no next game');
    assert.equal(count(ctx, "SELECT COUNT(*) AS n FROM games WHERE status = 'cancelled'"), 0);
  } finally {
    await ctx.app.close();
  }
});

test('a cancelled game leaves a fresh empty table; a restart in the countdown carries on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'big2-auto-'));
  const dbFile = path.join(dir, 'x.db');
  let ctx = await boot({ ...fast, startDelayMs: 700, dbFile });
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    await sitDown(ctx, ['pam', 'quin', 'ros', 'sam']);
    assert.equal(tableOf(ctx).status, 'waiting');
    await ctx.app.close(); // a restart during the countdown
    ctx = await boot({ ...fast, startDelayMs: 700, dbFile });
    assert.equal(tableOf(ctx).status, 'waiting', 'the table and its four seats were restored');
    assert.equal(tableOf(ctx).humans().length, 4);
    await until(() => tableOf(ctx).status === 'playing', 4000, 'the countdown carrying on after the restart');

    const before = tableOf(ctx).id;
    const boss = await makeUser(ctx, 'chief', { isAdmin: true });
    assert.equal((await boss.req('POST', '/api/admin/game/cancel', {})).status, 200);
    assert.notEqual(tableOf(ctx).id, before);
    assert.equal(tableOf(ctx).humans().length, 0, 'a fresh table with the seats empty');
    assert.equal(count(ctx, "SELECT COUNT(*) AS n FROM games WHERE status = 'cancelled'"), 1);
    assert.ok(admin);
  } finally {
    await ctx.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with only four accounts nobody can leave a seat in a game or on the results; the waiting room is free', async () => {
  const ctx = await boot({ ...fast, rng: mulberry32(7) });
  try {
    const people = await sitDown(ctx, ['pam', 'quin', 'ros', 'sam']);
    assert.equal(tableOf(ctx).view(people[0].user.id).leave, 'free', 'during the countdown nothing is promised yet');
    await until(() => tableOf(ctx).status === 'playing', 3000, 'a game in progress');
    assert.equal(tableOf(ctx).view(people[0].user.id).leave, null, 'once it starts, leaving is not on offer');
    const refused = await people[3].req('POST', '/api/game/leave');
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /only 4 players/);
    assert.equal(tableOf(ctx).seats.filter((s) => s.kind === 'human').length, 4, 'nobody left');
    for (const c of people) driveEasy(c, c.ev, () => tableOf(ctx).game);
    tableOf(ctx).touch();
    await people[0].ev.waitFor(isDone, 20000);
    assert.equal((await people[3].req('POST', '/api/game/leave')).status, 409, 'nor from the results');
    assert.equal(count(ctx, "SELECT COUNT(*) AS n FROM games WHERE status = 'forfeit'"), 0);
    // Before a game starts nothing is promised yet, so a seat can be given up and taken again.
    const solo = await boot({ ...fast, startDelayMs: 5000 });
    try {
      const [a] = await sitDown(solo, ['pam']);
      assert.equal(tableOf(solo).view(a.user.id).leave, 'free');
      assert.equal((await a.req('POST', '/api/game/leave')).status, 200);
      assert.equal(tableOf(solo).humans().length, 0);
    } finally {
      await solo.app.close();
    }
  } finally {
    await ctx.app.close();
  }
});

test('with more people than seats, leaving a game costs the most a round can, and the game is void for the others', async () => {
  const ctx = await boot({ ...fast, rng: mulberry32(7) });
  try {
    const people = await sitDown(ctx, ['pam', 'quin', 'ros', 'sam']);
    const spare = await makeUser(ctx, 'tomz'); // a fifth account: the seat can be filled, so it can be left
    await until(() => tableOf(ctx).status === 'playing', 3000, 'a game in progress');
    assert.equal(tableOf(ctx).view(people[3].user.id).leave, 'forfeit');
    const left = await people[3].req('POST', '/api/game/leave');
    assert.equal(left.status, 200, JSON.stringify(left.json));

    // The leaver: the worst round there is, and it counts for them (4 players: 14 cards x 4 = 56).
    const rows = ctx.app.db.prepare('SELECT game_id, user_id, delta FROM results').all();
    assert.equal(rows.length, 1, 'only the leaver has a result: the game counts for nobody else');
    assert.equal(rows[0].user_id, people[3].user.id);
    assert.equal(rows[0].delta, -56);
    assert.equal(count(ctx, "SELECT COUNT(*) AS n FROM games WHERE status = 'forfeit'"), 1);
    assert.equal(count(ctx, "SELECT COUNT(*) AS n FROM games WHERE status = 'finished'"), 0);
    const board = (await people[0].req('GET', '/api/leaderboard')).json.rows;
    assert.deepEqual(
      board.map((r) => [r.name, r.games, r.wins, r.points]),
      [['sam', 1, 0, -56]],
      'the leaderboard has the leaver, with the loss, and nobody else',
    );
    assert.equal((await people[3].req('GET', '/api/game')).json.table, null, 'the leaver is no longer seated');

    // The three who stayed: the table waits for a replacement, and says why.
    assert.equal(tableOf(ctx).status, 'waiting');
    assert.equal(tableOf(ctx).humans().length, 3);
    const stayed = tableOf(ctx).view(people[0].user.id);
    assert.match(stayed.notice, /sam left the game.*does not count for anyone else/);
    spare.ev = spare.openEvents();
    await spare.ev.waitFor((m) => m.event === 'lobby');
    assert.equal((await spare.req('POST', '/api/game/join')).status, 200);
    await until(() => tableOf(ctx).status === 'playing', 3000, 'a new game with the replacement');
    assert.equal(tableOf(ctx).view(people[0].user.id).notice, null, 'the notice goes when a game starts');
    assert.ok(tableOf(ctx).seats.some((s) => s.userId === spare.user.id));
    assert.equal(count(ctx, "SELECT COUNT(*) AS n FROM games WHERE status = 'finished'"), 0);
  } finally {
    await ctx.app.close();
  }
});

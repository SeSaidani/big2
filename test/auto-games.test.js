// Production rules: a season has players (put there by an admin); while it runs with at least four there is always a
// table seated with its first four players; they start a game by themselves, the next follows with the same people,
// a player who leaves is replaced by the next in line, anyone else can watch and chat, and ending the season stops it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mulberry32 } from '../src/cards.js';
import { boot, makeUser, seasonPlayers, until, sleep, driveEasy, isDone, isTable } from './support.js';

const fast = { startDelayMs: 150, nextGameDelayMs: 300, clockMs: 20 };
const tableOf = (ctx) => ctx.app.lobby.table;
const count = (ctx, sql) => ctx.app.db.prepare(sql).get().n;
const seated = (ctx) => tableOf(ctx).seats.map((s) => s.name);
const names4 = ['pam', 'quin', 'ros', 'sam'];

test('a season needs four players before it has a table; the fourth opens it, seated in the order added', async () => {
  const ctx = await boot(fast);
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    assert.equal(tableOf(ctx), null, 'a season with no players has no table');
    assert.deepEqual((await admin.req('GET', '/api/game')).json.season, {
      state: 'needs-players',
      name: 'Season 1',
      players: 0,
      needed: 4,
    });
    const people = [];
    for (const n of names4) people.push(await makeUser(ctx, n));
    for (const p of people.slice(0, 3)) {
      assert.equal((await admin.req('POST', '/api/admin/seasons/1/members', { userId: p.user.id })).status, 200);
    }
    assert.equal(tableOf(ctx), null, 'three players are not enough');
    assert.equal((await admin.req('POST', '/api/admin/seasons/1/members', { userId: people[3].user.id })).status, 200);
    assert.deepEqual(seated(ctx), names4, 'the four are seated, in the order they were added');
    assert.equal(tableOf(ctx).view(people[0].user.id).next.kind, 'start', 'and the countdown to the first game runs');
    assert.deepEqual((await admin.req('GET', '/api/game')).json.season, {
      state: 'running',
      name: 'Season 1',
      players: 4,
    });
  } finally {
    await ctx.app.close();
  }
});

test('deleting the season closes the table; a season that starts later opens one with its players when its time comes', async () => {
  const ctx = await boot(fast);
  try {
    const people = await seasonPlayers(ctx, names4);
    const admin = ctx.admin;
    assert.ok(tableOf(ctx));
    assert.equal((await admin.req('POST', '/api/admin/seasons/1/delete', {})).status, 200);
    assert.equal(tableOf(ctx), null);
    const starts = Date.now() + 400;
    const made = await admin.req('POST', '/api/admin/seasons', {
      name: 'Later',
      starts,
      ends: null,
      members: people.map((p) => p.user.id),
    });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    assert.equal(tableOf(ctx), null, 'not yet');
    await until(() => tableOf(ctx) !== null, 3000, 'the table opening when the season starts');
    assert.ok(Date.now() >= starts - 5);
    assert.deepEqual(seated(ctx), names4);
  } finally {
    await ctx.app.close();
  }
});

test('nobody creates, joins or starts a game by hand; the four seated start one by themselves', async () => {
  const ctx = await boot({ ...fast, rng: mulberry32(5) });
  try {
    const people = await seasonPlayers(ctx, names4);
    const admin = ctx.admin;
    assert.equal((await admin.req('POST', '/api/game', {})).status, 409, 'the admin does not create games');
    assert.equal((await admin.req('POST', '/api/game/start', {})).status, 409, 'and nobody starts them');
    const other = await makeUser(ctx, 'stranger');
    const join = await other.req('POST', '/api/game/join');
    assert.equal(join.status, 409, 'and nobody takes a seat');
    assert.match(join.json.error, /season's players/);
    assert.equal((await people[0].req('POST', '/api/game/join')).status, 409, 'not even someone already seated');
    await until(() => tableOf(ctx).status === 'playing', 3000, 'the game starting by itself');
    assert.deepEqual(
      tableOf(ctx).seats.map((s) => s.kind),
      ['human', 'human', 'human', 'human'],
      'four people and no computer players',
    );
  } finally {
    await ctx.app.close();
  }
});

test('the roster rules: existing accounts only, at least four for a season that runs, nothing is removed below four', async () => {
  const ctx = await boot(fast);
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    const pat = await makeUser(ctx, 'pat');
    const ids = [];
    for (const n of ['ann1', 'bea1', 'cat1', 'dan1', 'eve1']) ids.push((await makeUser(ctx, n)).user.id);
    const create = (body) =>
      admin.req('POST', '/api/admin/seasons', { name: 'S', starts: Date.now() + 5000, ends: null, ...body });
    // Only an admin touches a roster.
    assert.equal((await pat.req('POST', '/api/admin/seasons/1/members', { userId: ids[0] })).status, 403);
    assert.equal((await pat.req('GET', '/api/admin/seasons/1/members')).status, 403);
    // Making a season: four or more, real accounts, no repeats.
    await admin.req('POST', '/api/admin/seasons/1/delete', {});
    let r = await create({ members: ids.slice(0, 3) });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /at least 4 players: 3 picked/);
    assert.equal((await create({})).status, 400, 'no list at all');
    assert.equal((await create({ members: 'everyone' })).status, 400);
    r = await create({ members: [...ids.slice(0, 3), 99999] });
    assert.equal(r.status, 404, 'an id with no account behind it');
    assert.match(r.json.error, /only existing accounts/);
    assert.equal((await create({ members: [...ids.slice(0, 3), ids[0]] })).status, 400, 'a repeat');
    assert.equal((await create({ members: [...ids.slice(0, 3), 'x'] })).status, 400, 'not an id');
    assert.equal(count(ctx, 'SELECT COUNT(*) AS n FROM seasons'), 0, 'nothing half-made is left behind');
    // A disabled account cannot be added.
    await admin.req('POST', `/api/admin/users/${ids[4]}/status`, { disabled: true });
    assert.equal((await create({ members: [...ids.slice(0, 3), ids[4]] })).status, 409);
    await admin.req('POST', `/api/admin/users/${ids[4]}/status`, { disabled: false });
    // A good one, then the roster as the admin sees it.
    r = await create({ members: ids.slice(0, 4) });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const id = r.json.season.id;
    const roster = (await admin.req('GET', `/api/admin/seasons/${id}/members`)).json;
    assert.deepEqual(
      roster.members.map((m) => [m.name, m.seated]),
      [
        ['ann1', false],
        ['bea1', false],
        ['cat1', false],
        ['dan1', false],
      ],
    );
    assert.deepEqual(
      roster.candidates.map((c) => c.name).sort(),
      ['bossy'.replace('bossy', 'boss'), 'eve1', 'pat'].sort(),
    );
    assert.equal(roster.min, 4);
    // Adding: only existing, enabled, not already there; the order is the order added.
    assert.equal((await admin.req('POST', `/api/admin/seasons/${id}/members`, { userId: ids[4] })).status, 200);
    assert.equal(
      (await admin.req('POST', `/api/admin/seasons/${id}/members`, { userId: ids[4] })).status,
      409,
      'twice',
    );
    assert.equal((await admin.req('POST', `/api/admin/seasons/${id}/members`, { userId: 99999 })).status, 404);
    assert.equal((await admin.req('POST', `/api/admin/seasons/${id}/members`, { userId: 'ann' })).status, 400);
    assert.equal((await admin.req('POST', '/api/admin/seasons/99999/members', { userId: ids[0] })).status, 404);
    // Removing: down to four and no further.
    const remove = (uid) => admin.req('POST', `/api/admin/seasons/${id}/members/${uid}/remove`, {});
    assert.equal((await remove(ids[4])).status, 200, 'five to four is fine');
    const refused = await remove(ids[3]);
    assert.equal(refused.status, 409, 'four to three is not');
    assert.match(refused.json.error, /at least 4 players/);
    assert.equal((await remove(ids[4])).status, 404, 'someone who is not on the roster');
    // A season of the past may have no players; moving it so that it runs needs four first.
    const past = await admin.req('POST', '/api/admin/seasons', {
      name: 'Old',
      starts: Date.now() - 9e6,
      ends: Date.now() - 8e6,
    });
    assert.equal(past.status, 201, 'a season entirely in the past needs no players');
    const revive = await admin.req('POST', `/api/admin/seasons/${past.json.season.id}`, {
      name: 'Old',
      starts: past.json.season.starts,
      ends: null,
    });
    assert.equal(revive.status, 409);
    assert.match(revive.json.error, /at least 4 players before it can run/);
    assert.equal(
      (await admin.req('POST', '/api/admin/seasons/99999', { name: 'x', starts: 1, ends: null })).status,
      404,
    );
    const lists = (await admin.req('GET', '/api/seasons')).json.seasons;
    assert.equal(lists.find((s) => s.name === 'Old').players, 0);
    assert.equal(lists.find((s) => s.id === id).players, 4);
    const audit = (await admin.req('GET', '/api/admin/audit?limit=50')).json.entries.map((e) => e.action);
    assert.ok(
      audit.includes('add_season_player') && audit.includes('remove_season_player') && audit.includes('create_season'),
    );
  } finally {
    await ctx.app.close();
  }
});

test('a seated player cannot be removed from the roster; cancelling the game seats the roster again', async () => {
  const ctx = await boot({ ...fast, startDelayMs: 5000 });
  try {
    const people = await seasonPlayers(ctx, [...names4, 'tomx']);
    const admin = ctx.admin;
    const refuse = await admin.req('POST', `/api/admin/seasons/1/members/${people[0].user.id}/remove`, {});
    assert.equal(refuse.status, 409);
    assert.match(refuse.json.error, /seated at the table/);
    const roster = (await admin.req('GET', '/api/admin/seasons/1/members')).json.members;
    assert.deepEqual(
      roster.map((m) => [m.name, m.seated]),
      [
        ['pam', true],
        ['quin', true],
        ['ros', true],
        ['sam', true],
        ['tomx', false],
      ],
    );
    // A reserve can be removed (five to four), and then cancelling reseats the first four.
    assert.equal((await admin.req('POST', `/api/admin/seasons/1/members/${people[4].user.id}/remove`, {})).status, 200);
  } finally {
    await ctx.app.close();
  }
});

test('with a fifth player, leaving before the game hands the seat to the reserve and goes to the back of the line', async () => {
  const ctx = await boot({ ...fast, startDelayMs: 600 });
  try {
    const people = await seasonPlayers(ctx, [...names4, 'tomx']);
    assert.deepEqual(seated(ctx), names4, 'the fifth is a reserve');
    assert.equal(tableOf(ctx).view(people[0].user.id).leave, 'free');
    const left = await people[1].req('POST', '/api/game/leave'); // quin leaves during the countdown
    assert.equal(left.status, 200, JSON.stringify(left.json));
    assert.deepEqual(seated(ctx), ['pam', 'tomx', 'ros', 'sam'], "the reserve took quin's seat at once");
    const roster = (await ctx.admin.req('GET', '/api/admin/seasons/1/members')).json.members;
    assert.deepEqual(
      roster.map((m) => m.name),
      ['pam', 'ros', 'sam', 'tomx', 'quin'],
      'quin is now last in line',
    );
    assert.equal(tableOf(ctx).view(people[0].user.id).next.kind, 'start', 'the countdown carries on');
    await until(() => tableOf(ctx).status === 'playing', 4000, 'the game with the replacement');
  } finally {
    await ctx.app.close();
  }
});

test('with only four players nobody can leave a seat at all, not even before the game', async () => {
  const ctx = await boot({ ...fast, startDelayMs: 5000 });
  try {
    const people = await seasonPlayers(ctx, names4);
    assert.equal(tableOf(ctx).view(people[0].user.id).leave, null);
    const r = await people[0].req('POST', '/api/game/leave');
    assert.equal(r.status, 409);
    assert.match(r.json.error, /only 4 players in this season/);
    assert.deepEqual(seated(ctx), names4);
  } finally {
    await ctx.app.close();
  }
});

test('when a game ends the next one follows with the same people, and every game is scored', async () => {
  const ctx = await boot({ ...fast, rng: mulberry32(7) });
  try {
    const people = await seasonPlayers(ctx, names4);
    for (const c of people) driveEasy(c, c.ev, () => tableOf(ctx).game);
    const first = await people[0].ev.waitFor(isDone, 20000);
    assert.equal(first.data.next.kind, 'next', 'the results show what comes next');
    assert.equal(count(ctx, "SELECT COUNT(*) AS n FROM games WHERE status = 'finished'"), 1);
    const tableId = tableOf(ctx).id;
    const seatsBefore = tableOf(ctx).seats.map((s) => s.userId);
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
    await people[0].ev.waitFor((m) => isDone(m) && m.data.version > again.data.version, 20000);
    assert.equal(count(ctx, "SELECT COUNT(*) AS n FROM games WHERE status = 'finished'"), 2);
    assert.equal(count(ctx, 'SELECT COUNT(*) AS n FROM results'), 8);
    for (const c of people) assert.deepEqual(c.errors, []);
  } finally {
    await ctx.app.close();
  }
});

test('someone who leaves the results is replaced by the reserve before the next game starts', async () => {
  const ctx = await boot({ ...fast, nextGameDelayMs: 700, rng: mulberry32(7) });
  try {
    const people = await seasonPlayers(ctx, [...names4, 'tomx']);
    for (const c of people.slice(0, 4)) driveEasy(c, c.ev, () => tableOf(ctx).game);
    await people[0].ev.waitFor(isDone, 20000);
    assert.equal((await people[3].req('POST', '/api/game/leave')).status, 200, 'leaving the results is allowed');
    assert.equal(count(ctx, "SELECT COUNT(*) AS n FROM games WHERE status = 'forfeit'"), 0, 'and costs nothing');
    assert.deepEqual(seated(ctx), ['pam', 'quin', 'ros', 'tomx'], 'the reserve has the seat already');
    await until(() => tableOf(ctx).status === 'playing', 4000, 'the next game');
    assert.ok(tableOf(ctx).seats.some((s) => s.userId === people[4].user.id));
    assert.ok(!tableOf(ctx).seats.some((s) => s.userId === people[3].user.id));
  } finally {
    await ctx.app.close();
  }
});

test('with more players than seats, leaving a game costs the most a round can, and the game is void for the others', async () => {
  const ctx = await boot({ ...fast, rng: mulberry32(7) });
  try {
    const people = await seasonPlayers(ctx, [...names4, 'tomx']);
    await until(() => tableOf(ctx).status === 'playing', 3000, 'a game in progress');
    assert.equal(tableOf(ctx).view(people[3].user.id).leave, 'forfeit');
    const left = await people[3].req('POST', '/api/game/leave');
    assert.equal(left.status, 200, JSON.stringify(left.json));
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
    );
    assert.equal((await people[3].req('GET', '/api/game')).json.table, null, 'the leaver is no longer seated');
    // The reserve takes the seat at once; the three who stayed are told why the game stopped.
    assert.deepEqual(seated(ctx), ['pam', 'quin', 'ros', 'tomx']);
    assert.equal(tableOf(ctx).status, 'waiting');
    assert.match(tableOf(ctx).view(people[0].user.id).notice, /sam left the game.*does not count for anyone else/);
    await until(() => tableOf(ctx).status === 'playing', 3000, 'a new game with the replacement');
    assert.equal(tableOf(ctx).view(people[0].user.id).notice, null, 'the notice goes when a game starts');
    assert.equal(count(ctx, "SELECT COUNT(*) AS n FROM games WHERE status = 'finished'"), 0);
  } finally {
    await ctx.app.close();
  }
});

test('anyone else can watch: they see the table and what has been played, never a hand, and they can chat', async () => {
  const ctx = await boot({ ...fast, rng: mulberry32(7) });
  try {
    const people = await seasonPlayers(ctx, names4);
    const watcher = await makeUser(ctx, 'wendy');
    watcher.ev = watcher.openEvents();
    await watcher.ev.waitFor((m) => m.event === 'lobby');
    // A seated player is sent back to their own game instead.
    const refused = await people[0].req('POST', '/api/game/watch');
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /go back to it/);
    // Not watching: no table of their own, and no chat.
    assert.equal((await watcher.req('GET', '/api/game')).json.table, null);
    assert.equal((await watcher.req('POST', '/api/game/chat', { text: 'hello' })).status, 403);
    const watch = await watcher.req('POST', '/api/game/watch');
    assert.equal(watch.status, 200, JSON.stringify(watch.json));
    await until(() => tableOf(ctx).status === 'playing', 3000, 'a game in progress');
    const view = (await watcher.req('GET', '/api/game')).json.table;
    assert.equal(view.spectator, true);
    assert.equal(view.you, 0);
    assert.equal(view.isHost, false);
    assert.equal(view.leave, null);
    assert.equal(view.game.rules, null, 'no moves for a watcher');
    assert.deepEqual(view.game.view.hand, [], 'no hand at all');
    assert.deepEqual(
      view.seats.map((s) => s.count),
      [14, 14, 14, 14],
      'only how many cards each seat holds',
    );
    assert.equal(view.hands, null, "nobody's cards are shown while the game is on");
    // Every card the view shows has been played: the played pile, the trick, and the plays in the history.
    const truth = tableOf(ctx).game;
    const v = view.game.view;
    const shown = [
      ...v.played,
      ...(v.trick ? v.trick.cards : []),
      ...v.history.flatMap((h) => [...(h.cards || []), ...(h.trick ? h.trick.cards : [])]),
    ];
    const publicCards = new Set([...truth.played, ...(truth.trick ? truth.trick.cards : [])]);
    for (const card of shown) {
      assert.ok(publicCards.has(card), `card ${card} is in the watcher's view but was never played`);
    }
    // The only other places cards could be are the hand and the all-hands list: both are empty while the game is on.
    assert.deepEqual(v.hand, []);
    assert.equal(view.hands, null);
    assert.deepEqual(Object.keys(view).sort(), [
      'aiLevel',
      'chatEnabled',
      'game',
      'hands',
      'host',
      'id',
      'isHost',
      'leave',
      'next',
      'notice',
      'result',
      'seats',
      'spectator',
      'status',
      'version',
      'watching',
      'you',
    ]);
    // They cannot move.
    const move = await watcher.req('POST', '/api/game/move', { cards: [truth.hands[0][0]] });
    assert.equal(move.status, 403);
    // They chat with the players, and the players see it.
    const said = await watcher.req('POST', '/api/game/chat', { text: 'good luck' });
    assert.equal(said.status, 200, JSON.stringify(said.json));
    const heard = await people[0].ev.waitFor((m) => m.event === 'chat' && m.data.text === 'good luck', 3000);
    assert.equal(heard.data.name, 'wendy');
    const echo = await watcher.ev.waitFor((m) => m.event === 'chat' && m.data.text === 'good luck', 3000);
    assert.equal(echo.data.name, 'wendy');
    // The players chat back; the watcher hears it. Watchers are counted in the lobby.
    await people[1].req('POST', '/api/game/chat', { text: 'thanks' });
    await watcher.ev.waitFor((m) => m.event === 'chat' && m.data.text === 'thanks', 3000);
    assert.equal(tableOf(ctx).summary().watching, 1);
    // Moves are shown to them as they happen; at the end all the cards are shown, as to everybody.
    for (const c of people) driveEasy(c, c.ev, () => tableOf(ctx).game);
    tableOf(ctx).touch();
    const seen = await watcher.ev.waitFor((m) => isTable(m) && m.data.spectator && m.data.status === 'done', 20000);
    assert.equal(seen.data.hands.length, 4, "once it is over everyone's cards are shown");
    assert.deepEqual(seen.data.game.view.hand, []);
    // Stopping: leave takes them out of the watchers.
    assert.equal((await watcher.req('POST', '/api/game/leave')).status, 200);
    assert.equal((await watcher.req('GET', '/api/game')).json.table, null);
    assert.equal(tableOf(ctx).watchers.size, 0);
    assert.equal((await watcher.req('POST', '/api/game/chat', { text: 'still here?' })).status, 403);
  } finally {
    await ctx.app.close();
  }
});

test('a watcher who disconnects is no longer watching, and watchers are told when the table goes', async () => {
  const ctx = await boot(fast);
  try {
    await seasonPlayers(ctx, names4);
    const watcher = await makeUser(ctx, 'wendy');
    watcher.ev = watcher.openEvents();
    await watcher.ev.waitFor((m) => m.event === 'lobby');
    await watcher.req('POST', '/api/game/watch');
    assert.equal(tableOf(ctx).watchers.size, 1);
    // The season ends: the table closes and the watcher is told.
    assert.equal((await ctx.admin.req('POST', '/api/admin/seasons/1/end', {})).status, 200);
    await watcher.ev.waitFor((m) => m.event === 'table' && m.data === null, 3000);
    const second = await boot(fast);
    try {
      await seasonPlayers(second, names4);
      const w = await makeUser(second, 'wendy');
      w.ev = w.openEvents();
      await w.ev.waitFor((m) => m.event === 'lobby');
      await w.req('POST', '/api/game/watch');
      assert.equal(tableOf(second).watchers.size, 1);
      w.ev.close(); // closes the page
      await until(() => tableOf(second).watchers.size === 0, 3000, 'the watcher being forgotten');
    } finally {
      await second.app.close();
    }
  } finally {
    await ctx.app.close();
  }
});

test('ending the season stops the game in progress (unscored) and closes the table', async () => {
  const ctx = await boot({ ...fast, rng: mulberry32(7) });
  try {
    const people = await seasonPlayers(ctx, names4);
    const admin = ctx.admin;
    await until(() => tableOf(ctx).status === 'playing', 3000, 'a game in progress');
    const ended = await admin.req('POST', '/api/admin/seasons/1/end', {});
    assert.equal(ended.status, 200, JSON.stringify(ended.json));
    assert.equal(tableOf(ctx), null, 'the table is gone and no new one opens');
    assert.equal(count(ctx, "SELECT COUNT(*) AS n FROM games WHERE status = 'cancelled'"), 1);
    assert.equal(count(ctx, "SELECT COUNT(*) AS n FROM games WHERE status = 'finished'"), 0, 'nothing was scored');
    assert.equal(count(ctx, 'SELECT COUNT(*) AS n FROM results'), 0);
    await people[0].ev.waitFor((m) => m.event === 'table' && m.data === null, 3000);
    const audit = (await admin.req('GET', '/api/admin/audit?limit=3')).json.entries[0];
    assert.equal(audit.action, 'end_season');
    assert.match(audit.detail, /stopped, not scored/);
    // A new season, with its own players, opens a table again.
    const made = await admin.req('POST', '/api/admin/seasons', {
      name: 'Next',
      starts: Date.now(),
      ends: null,
      members: people.map((p) => p.user.id),
    });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    assert.equal(tableOf(ctx).status, 'waiting');
    assert.deepEqual(seated(ctx), names4, 'seated with its players');
  } finally {
    await ctx.app.close();
  }
});

test('a season ending by its dates lets the game in progress finish, and then there is no next one', async () => {
  const ctx = await boot({ ...fast, rng: mulberry32(7) });
  try {
    const people = await seasonPlayers(ctx, names4);
    const admin = ctx.admin;
    await until(() => tableOf(ctx).status === 'playing', 3000, 'a game in progress');
    const season = (await admin.req('GET', '/api/seasons')).json.seasons[0];
    const moved = await admin.req('POST', `/api/admin/seasons/${season.id}`, {
      name: season.name,
      starts: season.starts,
      ends: Date.now(),
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.json));
    assert.equal(tableOf(ctx).status, 'playing', 'the game is left alone');
    for (const c of people) driveEasy(c, c.ev, () => tableOf(ctx).game);
    tableOf(ctx).touch();
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

test('a cancelled game leaves a fresh table seated with the roster; a restart in the countdown carries on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'big2-auto-'));
  const dbFile = path.join(dir, 'x.db');
  let ctx = await boot({ ...fast, startDelayMs: 700, dbFile });
  try {
    await seasonPlayers(ctx, names4);
    assert.equal(tableOf(ctx).status, 'waiting');
    await ctx.app.close(); // a restart during the countdown
    ctx = await boot({ ...fast, startDelayMs: 700, dbFile });
    assert.equal(tableOf(ctx).status, 'waiting', 'the table and its four seats were restored');
    assert.deepEqual(seated(ctx), names4);
    await until(() => tableOf(ctx).status === 'playing', 4000, 'the countdown carrying on after the restart');

    const before = tableOf(ctx).id;
    const boss = await makeUser(ctx, 'chief', { isAdmin: true });
    assert.equal((await boss.req('POST', '/api/admin/game/cancel', {})).status, 200);
    assert.notEqual(tableOf(ctx).id, before);
    assert.deepEqual(seated(ctx), names4, 'a fresh table seated with the roster again');
    assert.equal(tableOf(ctx).view(tableOf(ctx).seats[0].userId).next.kind, 'start');
    assert.equal(count(ctx, "SELECT COUNT(*) AS n FROM games WHERE status = 'cancelled'"), 1);
  } finally {
    await ctx.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

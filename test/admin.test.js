import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, listUsers, recentAudit, stats } from '../server/db.js';
import { makeAdmin, resetPassword } from '../server/admin.js';
import { login } from '../server/auth.js';
import { PASSWORD, boot, Client, makeUser } from './support.js';

const NEW_PASSWORD = 'another-long-password';

test('every admin route refuses non-admins', async () => {
  const ctx = await boot();
  try {
    const pleb = await makeUser(ctx, 'pleb');
    const routes = [
      ['GET', '/api/admin/overview'],
      ['GET', '/api/admin/users'],
      ['POST', '/api/admin/users', { name: 'newbie', password: PASSWORD }],
      ['POST', '/api/admin/users/1/password', { password: NEW_PASSWORD }],
      ['POST', '/api/admin/users/1/status', { disabled: true }],
      ['POST', '/api/admin/users/1/role', { isAdmin: true }],
      ['POST', '/api/admin/game/cancel', {}],
      ['POST', '/api/admin/settings', { registrationOpen: true }],
      ['GET', '/api/admin/audit'],
    ];
    for (const [m, p, body] of routes) assert.equal((await pleb.req(m, p, body)).status, 403, `${m} ${p}`);
    // Nothing changed: still one user, registration still closed, no audit trail.
    assert.equal(listUsers(ctx.app.db).length, 1);
    assert.equal((await pleb.req('GET', '/api/config')).json.registrationOpen, false);
    assert.equal(recentAudit(ctx.app.db).length, 0);
    assert.deepEqual(ctx.logs, []);
  } finally {
    await ctx.app.close();
  }
});

test('admin creates users with temporary passwords; they can sign in and change them', async () => {
  const ctx = await boot();
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    for (const bad of [
      { name: 'x', password: PASSWORD },
      { name: 'okname', password: 'short' },
    ]) {
      assert.equal((await admin.req('POST', '/api/admin/users', bad)).status, 400);
    }
    const made = await admin.req('POST', '/api/admin/users', { name: 'newbie', password: PASSWORD });
    assert.equal(made.status, 201);
    assert.equal(made.json.user.isAdmin, false);
    assert.equal((await admin.req('POST', '/api/admin/users', { name: 'NEWBIE', password: PASSWORD })).status, 409);

    const list = (await admin.req('GET', '/api/admin/users')).json.users;
    assert.deepEqual(
      list.map((u) => u.name),
      ['boss', 'newbie'],
    );
    assert.equal(list[1].lastLogin, null);
    assert.ok(!JSON.stringify(list).includes('pw_hash'), 'password hashes never leave the server');

    const n = new Client(ctx.base);
    await n.login('newbie');
    assert.equal((await n.req('GET', '/api/me')).json.user.isAdmin, false);
    // Changing your own password: needs the current one; signs the old sessions out.
    const old = n.cookie;
    assert.equal((await n.req('POST', '/api/password', { current: 'not-it-at-all', next: NEW_PASSWORD })).status, 401);
    assert.equal((await n.req('POST', '/api/password', { current: PASSWORD, next: 'short' })).status, 400);
    assert.equal((await n.req('POST', '/api/password', { current: PASSWORD, next: NEW_PASSWORD })).status, 200);
    assert.equal((await n.req('GET', '/api/me')).status, 200); // the fresh session works
    const stale = new Client(ctx.base);
    stale.cookie = old;
    assert.equal((await stale.req('GET', '/api/me')).status, 401);
    const c = new Client(ctx.base);
    assert.equal((await c.req('POST', '/api/login', { name: 'newbie', password: PASSWORD })).status, 401);
    assert.equal((await c.req('POST', '/api/login', { name: 'newbie', password: NEW_PASSWORD })).status, 200);
    // Created users show up in the audit log under the admin's name.
    const log = recentAudit(ctx.app.db);
    assert.equal(log[0].action, 'create_user');
    assert.equal(log[0].admin, 'boss');
    assert.equal(log[0].target, 'newbie');
  } finally {
    await ctx.app.close();
  }
});

test('reset password signs the user out everywhere; disabling blocks login and revokes sessions', async () => {
  const ctx = await boot();
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    const user = await makeUser(ctx, 'target');
    const id = user.user.id;
    assert.equal((await admin.req('POST', `/api/admin/users/${id}/password`, { password: 'short' })).status, 400);
    assert.equal((await admin.req('POST', '/api/admin/users/9999/password', { password: NEW_PASSWORD })).status, 404);
    assert.equal((await admin.req('POST', `/api/admin/users/${id}/password`, { password: NEW_PASSWORD })).status, 200);
    assert.equal((await user.req('GET', '/api/me')).status, 401);
    assert.equal(
      (await new Client(ctx.base).req('POST', '/api/login', { name: 'target', password: PASSWORD })).status,
      401,
    );
    const again = new Client(ctx.base);
    await again.login('target', NEW_PASSWORD);

    assert.equal((await admin.req('POST', `/api/admin/users/${id}/status`, { disabled: 'yes' })).status, 400);
    assert.equal((await admin.req('POST', `/api/admin/users/${id}/status`, { disabled: true })).status, 200);
    assert.equal((await again.req('GET', '/api/me')).status, 401, 'existing sessions are revoked');
    const blocked = await new Client(ctx.base).req('POST', '/api/login', { name: 'target', password: NEW_PASSWORD });
    assert.equal(blocked.status, 403);
    // A wrong password still looks like any other wrong password.
    assert.equal(
      (await new Client(ctx.base).req('POST', '/api/login', { name: 'target', password: 'wrong-wrong-wrong' })).status,
      401,
    );
    assert.equal((await admin.req('POST', `/api/admin/users/${id}/status`, { disabled: false })).status, 200);
    await new Client(ctx.base).login('target', NEW_PASSWORD);

    const actions = recentAudit(ctx.app.db).map((e) => e.action);
    for (const a of ['reset_password', 'disable_user', 'enable_user']) assert.ok(actions.includes(a), a);
  } finally {
    await ctx.app.close();
  }
});

test('you cannot lock yourself out: no self-disable, and the last admin cannot be demoted or disabled', async () => {
  const ctx = await boot();
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    const me = admin.user.id;
    assert.equal((await admin.req('POST', `/api/admin/users/${me}/status`, { disabled: true })).status, 409);
    assert.equal((await admin.req('POST', `/api/admin/users/${me}/role`, { isAdmin: false })).status, 409);
    // A second admin makes demotion legitimate, and the roles really change.
    const second = await makeUser(ctx, 'second');
    assert.equal((await admin.req('POST', `/api/admin/users/${second.user.id}/role`, { isAdmin: true })).status, 200);
    assert.equal((await second.req('GET', '/api/me')).json.user.isAdmin, true);
    assert.equal((await second.req('GET', '/api/admin/overview')).status, 200);
    assert.equal((await admin.req('POST', `/api/admin/users/${me}/role`, { isAdmin: false })).status, 200);
    assert.equal((await admin.req('GET', '/api/admin/users')).status, 403, 'demoted: loses access immediately');
    // `second` is now the last admin.
    assert.equal((await second.req('POST', `/api/admin/users/${second.user.id}/role`, { isAdmin: false })).status, 409);
    assert.equal((await second.req('POST', `/api/admin/users/${me}/status`, { disabled: true })).status, 200);
    assert.deepEqual(ctx.logs, []);
  } finally {
    await ctx.app.close();
  }
});

test('overview, settings and audit endpoints', async () => {
  const ctx = await boot();
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    await makeUser(ctx, 'someone');
    let o = (await admin.req('GET', '/api/admin/overview')).json;
    assert.equal(o.stats.users, 2);
    assert.equal(o.registrationOpen, false);
    assert.equal(o.game, null);
    assert.equal((await admin.req('POST', '/api/admin/settings', { registrationOpen: 'yes' })).status, 400);
    await admin.req('POST', '/api/admin/settings', { registrationOpen: true });
    o = (await admin.req('GET', '/api/admin/overview')).json;
    assert.equal(o.registrationOpen, true);
    await admin.req('POST', '/api/game', { aiLevel: 'easy' });
    assert.equal((await admin.req('GET', '/api/admin/overview')).json.game.status, 'waiting');
    await admin.req('POST', '/api/admin/game/cancel', {});
    assert.equal((await admin.req('POST', '/api/admin/game/cancel', {})).status, 404);
    const entries = (await admin.req('GET', '/api/admin/audit?limit=5')).json.entries;
    assert.deepEqual(entries.map((e) => e.action).slice(0, 2), ['cancel_game', 'set_registration']);
    assert.ok(entries.length <= 5);
  } finally {
    await ctx.app.close();
  }
});

test('the command-line tool creates and promotes admins and resets passwords', async () => {
  const db = openDb(':memory:');
  const made = await makeAdmin(db, 'rootuser', PASSWORD);
  assert.equal(made.created, true);
  await login(db, 'rootuser', PASSWORD);
  assert.equal(listUsers(db)[0].isAdmin, true);
  // Promoting an existing, disabled user re-enables them and keeps their password.
  const { createUser } = await import('../server/auth.js');
  await createUser(db, 'plainuser', PASSWORD);
  db.prepare('UPDATE users SET disabled = 1 WHERE name = ?').run('plainuser');
  const promoted = await makeAdmin(db, 'plainuser', null);
  assert.equal(promoted.created, false);
  assert.equal((await login(db, 'plainuser', PASSWORD)).isAdmin, true);
  await resetPassword(db, 'plainuser', NEW_PASSWORD);
  await assert.rejects(login(db, 'plainuser', PASSWORD));
  await login(db, 'plainuser', NEW_PASSWORD);
  await assert.rejects(resetPassword(db, 'ghost', NEW_PASSWORD), /No such user/);
  await assert.rejects(resetPassword(db, 'plainuser', 'short'), /Password must be/);
  assert.ok(recentAudit(db).some((e) => e.action === 'cli_make_admin'));
  assert.equal(stats(db).users, 2);
  db.close();
});

test('an old database file upgrades in place without losing data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'big2-migrate-'));
  const file = path.join(dir, 'old.db');
  try {
    // The schema as it was before admin/cancel support existed.
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, pw_hash TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE sessions (token_sha256 TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE games (id INTEGER PRIMARY KEY, started INTEGER NOT NULL, ended INTEGER NOT NULL, has_ai INTEGER NOT NULL, multiplier INTEGER NOT NULL);
      CREATE TABLE results (game_id INTEGER NOT NULL, seat INTEGER NOT NULL, user_id INTEGER, cards_left INTEGER NOT NULL, delta INTEGER NOT NULL, PRIMARY KEY (game_id, seat));
      INSERT INTO users (name, pw_hash, created) VALUES ('veteran', 'x', 1);
      INSERT INTO games (started, ended, has_ai, multiplier) VALUES (1, 2, 0, 1);
      INSERT INTO results VALUES (1, 0, 1, 0, 10), (1, 1, NULL, 5, -10);
    `);
    old.close();
    const db = openDb(file);
    const u = listUsers(db)[0];
    assert.equal(u.name, 'veteran');
    assert.equal(u.isAdmin, false);
    assert.equal(u.disabled, false);
    assert.equal(u.games, 1);
    assert.equal(db.prepare('SELECT status FROM games').get().status, 'finished', 'old games count as finished');
    openDb(file).close(); // reopening a migrated file is a no-op
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

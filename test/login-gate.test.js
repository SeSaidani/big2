import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createUser, createSession, renewSession, getSession } from '../server/auth.js';
import { boot, makeUser, PASSWORD } from './support.js';

const DAY = 24 * 3600 * 1000;
const TTL = 30 * DAY;
const MAX = 180 * DAY;

const get = (base, path, cookie) => fetch(base + path, { headers: cookie ? { cookie } : {} });

test('before sign-in only the sign-in page is served, never the game', async () => {
  const { app, base } = await boot();
  try {
    for (const p of ['/', '/index.html']) {
      const r = await get(base, p);
      const html = await r.text();
      assert.equal(r.status, 200, p);
      assert.match(html, /<title>Big Two · Sign in<\/title>/, p);
      assert.ok(!html.includes('src/ui.js'), p);
      assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    }
    for (const p of ['/src/ui.js', '/src/game.js', '/src/ai/agents.js']) {
      assert.equal((await get(base, p)).status, 401, p);
    }
    // What the sign-in page itself needs stays public.
    for (const p of ['/signin.html', '/signin.js', '/styles.css', '/favicon.svg', '/manifest.webmanifest']) {
      assert.equal((await get(base, p)).status, 200, p);
    }
  } finally {
    await app.close();
  }
});

test('signed in, the game is served; after logging out it is not', async () => {
  const ctx = await boot();
  try {
    const c = await makeUser(ctx, 'dana');
    const page = await get(ctx.base, '/', c.cookie);
    assert.match(await page.text(), /src\/ui\.js/);
    assert.equal((await get(ctx.base, '/src/ui.js', c.cookie)).status, 200);
    assert.equal((await c.req('POST', '/api/logout', {})).status, 200);
    const stale = c.cookie;
    assert.ok(!(await (await get(ctx.base, '/', stale)).text()).includes('src/ui.js'));
    assert.equal((await get(ctx.base, '/src/ui.js', stale)).status, 401);
    // A disabled account loses the game at once, even with a live cookie.
    const e = await makeUser(ctx, 'eve');
    ctx.app.db.prepare("UPDATE users SET disabled = 1 WHERE name = 'eve'").run();
    assert.equal((await get(ctx.base, '/src/ui.js', e.cookie)).status, 401);
  } finally {
    await ctx.app.close();
  }
});

test('a session is renewed from its last use, and never beyond the absolute cap', async () => {
  const db = openDb();
  await createUser(db, 'dana', PASSWORD);
  const id = db.prepare("SELECT id FROM users WHERE name = 'dana'").get().id;
  const expiry = (t) => db.prepare('SELECT expires FROM sessions').get().expires - t;

  // Fresh: more than half the life left, so nothing is written.
  const t = 1_000_000_000_000;
  let token = createSession(db, id, TTL, t);
  assert.equal(renewSession(db, token, TTL, MAX, t + 10 * DAY), null);
  assert.equal(expiry(t), TTL);
  // Under half left: pushed out to a full TTL from now.
  assert.equal(renewSession(db, token, TTL, MAX, t + 20 * DAY), t + 50 * DAY);
  assert.deepEqual(getSession(db, token, t + 49 * DAY), { id, name: 'dana', isAdmin: false });
  // Used every 25 days or so it never lapses, but it stops at the cap: 180 days from sign-in.
  for (const d of [45, 70, 95, 120, 145]) renewSession(db, token, TTL, MAX, t + d * DAY);
  assert.equal(expiry(t), 175 * DAY);
  assert.equal(renewSession(db, token, TTL, MAX, t + 170 * DAY), t + 180 * DAY);
  assert.equal(renewSession(db, token, TTL, MAX, t + 179 * DAY), null); // nothing more to gain
  // Past the cap: expired for good, renewal does not resurrect it.
  assert.equal(getSession(db, token, t + 181 * DAY), null);
  assert.equal(renewSession(db, token, TTL, MAX, t + 181 * DAY), null);

  // A session from before the `created` column: its start is taken as expires - TTL.
  db.exec('DELETE FROM sessions');
  token = createSession(db, id, TTL, t);
  db.prepare('UPDATE sessions SET created = 0').run();
  assert.equal(renewSession(db, token, TTL, MAX, t + 20 * DAY), t + 50 * DAY);
  assert.equal(renewSession(db, 'x', TTL, MAX, t), null); // junk tokens are ignored
});

test('using the site renews a session over HTTP and sends the browser a fresh cookie', async () => {
  const ctx = await boot();
  try {
    const c = await makeUser(ctx, 'dana');
    const fresh = await c.req('GET', '/api/me');
    assert.equal(fresh.headers.get('set-cookie'), null); // plenty left: no write, no new cookie

    const age = () => ctx.app.db.prepare('SELECT expires FROM sessions').get().expires - Date.now();
    ctx.app.db.prepare('UPDATE sessions SET expires = ?').run(Date.now() + 10 * DAY);
    const renewed = await c.req('GET', '/api/me');
    const cookie = renewed.headers.get('set-cookie');
    assert.match(cookie, /^sid=[^;]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+/);
    assert.ok(Number(/Max-Age=(\d+)/.exec(cookie)[1]) > 29 * 86400);
    assert.ok(age() > 29 * DAY);

    // Opening the page counts as use too.
    ctx.app.db.prepare('UPDATE sessions SET expires = ?').run(Date.now() + 5 * DAY);
    const page = await get(ctx.base, '/', c.cookie);
    assert.match(page.headers.get('set-cookie'), /^sid=/);
    assert.ok(age() > 29 * DAY);
  } finally {
    await ctx.app.close();
  }
});

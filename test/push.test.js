import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import {
  addSubscription,
  listSubscriptions,
  publicDevices,
  removeSubscription,
  vapidKeys,
  countPush,
  logPush,
  lastPushAt,
  MAX_DEVICES,
  PushError,
} from '../server/push-store.js';
import { createPusher } from '../server/pusher.js';
import { chooseMove } from '../src/ai/agents.js';
import { mulberry32 } from '../src/cards.js';
import { Client, FakeDevice, boot, makeUser, until, sleep } from './support.js';

async function dbWithUser(name = 'ann') {
  const db = openDb(':memory:');
  const user = await createUser(db, name, 'a-long-enough-password');
  return { db, user };
}

test('the sender keys are made once and kept', async () => {
  const { db } = await dbWithUser();
  const a = vapidKeys(db);
  assert.equal(Buffer.from(a.publicKey, 'base64url').length, 65);
  assert.deepEqual(vapidKeys(db), a, 'the same keys every time: new ones would silence every device');
});

test('devices: added, listed without secrets, replaced rather than doubled, moved between people, removed', async () => {
  const { db, user } = await dbWithUser();
  const bob = await createUser(db, 'bob', 'a-long-enough-password');
  const d = new FakeDevice();
  addSubscription(db, user.id, d.subscription, { label: '  Android phone, Chrome\n' });
  assert.equal(listSubscriptions(db, user.id).length, 1);
  assert.equal(listSubscriptions(db, user.id)[0].label, 'Android phone, Chrome');
  const shown = publicDevices(db, user.id);
  assert.deepEqual(Object.keys(shown[0]).sort(), ['created', 'id', 'label', 'lastOk'], 'never the endpoint or keys');

  addSubscription(db, user.id, d.subscription, { label: 'Renamed' });
  assert.equal(listSubscriptions(db, user.id).length, 1, 'the same browser again is one device');
  assert.equal(listSubscriptions(db, user.id)[0].label, 'Renamed');

  addSubscription(db, bob.id, d.subscription); // someone else signs in on that phone
  assert.equal(listSubscriptions(db, user.id).length, 0);
  assert.equal(listSubscriptions(db, bob.id).length, 1);
  assert.equal(listSubscriptions(db, bob.id)[0].label, 'This device', 'a missing label gets a plain one');

  assert.equal(removeSubscription(db, user.id, d.endpoint), false, 'only the owner can remove it');
  assert.equal(removeSubscription(db, bob.id, d.endpoint), true);
  assert.equal(listSubscriptions(db, bob.id).length, 0);
});

test('devices: bad endpoints and keys are refused, and the number per person is limited', async () => {
  const { db, user } = await dbWithUser();
  const good = new FakeDevice().subscription;
  const refuse = (sub, status = 400) =>
    assert.throws(
      () => addSubscription(db, user.id, sub),
      (e) => e instanceof PushError && e.status === status,
      JSON.stringify(sub),
    );
  refuse(undefined);
  refuse({});
  refuse({ ...good, endpoint: 'https://169.254.169.254/latest/meta-data/' });
  refuse({ ...good, endpoint: 'http://fcm.googleapis.com/fcm/send/x' });
  refuse({ endpoint: good.endpoint, keys: { p256dh: 'AAAA', auth: good.keys.auth } });
  refuse({ endpoint: good.endpoint, keys: { p256dh: good.keys.p256dh, auth: 'AAAA' } });
  refuse({ endpoint: good.endpoint, keys: { p256dh: 5, auth: good.keys.auth } });
  assert.equal(listSubscriptions(db, user.id).length, 0);
  for (let i = 0; i < MAX_DEVICES; i++) addSubscription(db, user.id, new FakeDevice(i).subscription);
  refuse(new FakeDevice(99).subscription, 409);
  assert.equal(listSubscriptions(db, user.id).length, MAX_DEVICES);
});

test('the send log counts only alerts that reached a device', async () => {
  const { db, user } = await dbWithUser();
  logPush(db, user.id, false, 1000);
  assert.equal(lastPushAt(db, user.id), null);
  logPush(db, user.id, true, 2000);
  logPush(db, user.id, true, 3000);
  assert.equal(lastPushAt(db, user.id), 3000);
  assert.equal(countPush(db, user.id, 0), 2);
  assert.equal(countPush(db, user.id, 2500), 1);
});

test('the pusher: reaches every device, forgets dead ones, retries a busy push service once', async () => {
  const { db, user } = await dbWithUser();
  const [d1, d2, d3] = [new FakeDevice(1), new FakeDevice(2), new FakeDevice(3)];
  for (const d of [d1, d2, d3]) addSubscription(db, user.id, d.subscription);
  const seen = [];
  let busyOnce = true;
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    if (url === d2.endpoint) return new Response(null, { status: 410 }); // this phone was reset
    if (url === d3.endpoint && busyOnce) {
      busyOnce = false;
      return new Response(null, { status: 503 });
    }
    return new Response(null, { status: 201 });
  };
  const pusher = createPusher({ db, subject: 'https://big2.example.com', fetchImpl, retryDelayMs: 1 });
  const r = await pusher.sendToUser(user.id, { title: 'Big Two', body: "It's your turn." });
  assert.deepEqual(r, { devices: 3, delivered: 2, removed: 1 });
  assert.equal(seen.length, 4, 'three devices and one retry');
  const left = listSubscriptions(db, user.id).map((x) => x.endpoint);
  assert.deepEqual(left.sort(), [d1.endpoint, d3.endpoint].sort(), 'the dead device is gone');
  const sentToD1 = seen.find((x) => x.url === d1.endpoint);
  assert.deepEqual(JSON.parse(d1.read(sentToD1.init.body)), { title: 'Big Two', body: "It's your turn." });
  assert.notEqual(listSubscriptions(db, user.id)[0].lastOk, null, 'delivery is noted');

  // A person with no devices, and an outage, are both quiet.
  const ann = await createUser(db, 'zed', 'a-long-enough-password');
  assert.deepEqual(await pusher.sendToUser(ann.id, { title: 'x' }), { devices: 0, delivered: 0, removed: 0 });
  const down = createPusher({
    db,
    subject: 'https://big2.example.com',
    retryDelayMs: 1,
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  assert.deepEqual(await down.sendToUser(user.id, { title: 'x' }), { devices: 2, delivered: 0, removed: 0 });
  assert.equal(listSubscriptions(db, user.id).length, 2, 'an outage does not forget anyone');
});

test('opening an old database erases the phone numbers and everything that went with them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'big2-migrate-'));
  const file = path.join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, pw_hash TEXT NOT NULL,
        created INTEGER NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0,
        last_login INTEGER, phone TEXT, phone_verified INTEGER NOT NULL DEFAULT 0,
        sms_enabled INTEGER NOT NULL DEFAULT 1, sms_blocked INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX users_phone ON users(phone) WHERE phone IS NOT NULL;
      CREATE TABLE phone_codes (user_id INTEGER PRIMARY KEY, phone TEXT NOT NULL, salt TEXT, code_hash TEXT, expires INTEGER, attempts INTEGER);
      CREATE TABLE login_codes (user_id INTEGER PRIMARY KEY, salt TEXT, code_hash TEXT, expires INTEGER, attempts INTEGER);
      CREATE TABLE sms_log (id INTEGER PRIMARY KEY, user_id INTEGER, kind TEXT, ok INTEGER, sent INTEGER);
      CREATE INDEX sms_log_user ON sms_log(user_id, kind, sent);
      INSERT INTO users (id, name, pw_hash, created, phone, phone_verified) VALUES (1, 'stephen', 'hash-1', 5, '+447700900001', 1);
      INSERT INTO users (id, name, pw_hash, created, is_admin) VALUES (2, 'pat', 'hash-2', 6, 0);
      INSERT INTO phone_codes VALUES (1, '+447700900001', 's', 'h', 9, 0);
      INSERT INTO sms_log VALUES (1, 1, 'turn', 1, 7);
    `);
    old.close();

    const db = openDb(file);
    const cols = db
      .prepare('PRAGMA table_info(users)')
      .all()
      .map((c) => c.name);
    for (const gone of ['phone', 'phone_verified', 'sms_enabled', 'sms_blocked']) assert.ok(!cols.includes(gone), gone);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((t) => t.name);
    for (const gone of ['phone_codes', 'login_codes', 'sms_log']) assert.ok(!tables.includes(gone), gone);
    assert.ok(tables.includes('push_subscriptions') && tables.includes('push_log'));
    const users = db.prepare('SELECT id, name, pw_hash, created FROM users ORDER BY id').all();
    assert.deepEqual(
      users.map((u) => ({ ...u })),
      [
        { id: 1, name: 'stephen', pw_hash: 'hash-1', created: 5 },
        { id: 2, name: 'pat', pw_hash: 'hash-2', created: 6 },
      ],
      'accounts are untouched',
    );
    db.close();
    openDb(file).close(); // opening again changes nothing and does not fail
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A phone-shaped service for the API tests: records what the server POSTs and lets each device read it.
function fakePushService(devices) {
  const posts = [];
  const fetchImpl = async (url, init) => {
    const device = devices.find((d) => d.endpoint === url);
    posts.push({ url, device, init, text: device ? device.read(init.body) : null });
    return new Response(null, { status: device ? 201 : 410 });
  };
  return { posts, fetchImpl };
}

test('the push API: key, subscribe, list, test alert, unsubscribe; sign-in required; nothing secret leaves', async () => {
  const phone = new FakeDevice();
  const service = fakePushService([phone]);
  const ctx = await boot({ pushFetch: service.fetchImpl });
  try {
    const anon = await makeUser(ctx, 'someone');
    for (const [m, p] of [
      ['GET', '/api/push'],
      ['POST', '/api/push/subscribe'],
      ['POST', '/api/push/unsubscribe'],
      ['POST', '/api/push/test'],
    ]) {
      const r = await new Client(ctx.base).req(m, p, m === 'POST' ? {} : undefined);
      assert.equal(r.status, 401, `${m} ${p} needs a sign-in`);
    }
    const first = await anon.req('GET', '/api/push');
    assert.equal(first.status, 200);
    assert.equal(Buffer.from(first.json.publicKey, 'base64url').length, 65);
    assert.deepEqual(first.json.devices, []);
    assert.equal((await anon.req('POST', '/api/push/test', {})).status, 409, 'no device, nothing to test');

    assert.equal(
      (
        await anon.req('POST', '/api/push/subscribe', {
          subscription: { endpoint: 'https://evil.example/x', keys: phone.subscription.keys },
        })
      ).status,
      400,
      'an address that is not a push service is refused',
    );
    const sub = await anon.req('POST', '/api/push/subscribe', {
      subscription: phone.subscription,
      label: 'Android phone, Chrome',
    });
    assert.equal(sub.status, 200, JSON.stringify(sub.json));
    assert.equal(sub.json.devices.length, 1);
    assert.equal(sub.json.devices[0].label, 'Android phone, Chrome');
    assert.ok(!JSON.stringify(sub.json).includes(phone.endpoint), 'the address stays on the server');
    assert.ok(!JSON.stringify(sub.json).includes(phone.auth));
    assert.equal(
      (await anon.req('POST', '/api/push/subscribe', { subscription: phone.subscription })).json.devices.length,
      1,
    );

    const test = await anon.req('POST', '/api/push/test', {});
    assert.equal(test.status, 200);
    assert.equal(test.json.delivered, 1);
    assert.equal(service.posts.length, 1);
    const message = JSON.parse(service.posts[0].text);
    assert.equal(message.title, 'Big Two');
    assert.match(message.body, /Test alert/);
    assert.equal(service.posts[0].init.headers.Topic, 'test');

    for (let i = 0; i < 4; i++) assert.equal((await anon.req('POST', '/api/push/test', {})).status, 200);
    assert.equal((await anon.req('POST', '/api/push/test', {})).status, 429, 'test alerts are limited');

    const other = await makeUser(ctx, 'another');
    assert.equal(
      (await other.req('POST', '/api/push/unsubscribe', { endpoint: phone.endpoint })).json.devices.length,
      0,
    );
    assert.equal((await anon.req('GET', '/api/push')).json.devices.length, 1, 'nobody else can remove your device');
    const off = await anon.req('POST', '/api/push/unsubscribe', { endpoint: phone.endpoint });
    assert.equal(off.json.devices.length, 0);
    assert.equal(ctx.app.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 0);
  } finally {
    await ctx.app.close();
  }
});

test('the service worker is served, and the old phone and text routes are gone', async () => {
  const ctx = await boot();
  try {
    const sw = await fetch(`${ctx.base}/sw.js`);
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get('content-type'), /javascript/);
    assert.match(await sw.text(), /addEventListener\('push'/);
    const user = await makeUser(ctx, 'carol');
    for (const [m, p] of [
      ['POST', '/api/phone'],
      ['POST', '/api/phone/verify'],
      ['POST', '/api/sms'],
      ['POST', '/api/login/code'],
      ['POST', '/api/login/verify'],
    ]) {
      assert.equal((await user.req(m, p, {})).status, 404, `${p} is gone`);
    }
    const config = (await user.req('GET', '/api/config')).json;
    assert.deepEqual(Object.keys(config).sort(), ['devTables', 'registrationOpen']);
    const me = (await user.req('GET', '/api/me')).json.user;
    assert.deepEqual(Object.keys(me).sort(), ['id', 'isAdmin', 'name']);
  } finally {
    await ctx.app.close();
  }
});

test('in a real game: an alert when the turn has waited, a last one later, never a third, nothing about the cards', async () => {
  const phone = new FakeDevice();
  const service = fakePushService([phone]);
  const ctx = await boot({
    devTables: true,
    rng: mulberry32(5),
    pushFetch: service.fetchImpl,
    notify: { firstAfterMs: 30, secondAfterMs: 400 },
  });
  try {
    const away = await makeUser(ctx, 'away', { isAdmin: true });
    await away.req('POST', '/api/push/subscribe', { subscription: phone.subscription, label: 'Test phone' });
    await away.req('POST', '/api/game', { aiLevel: 'easy' });
    await away.req('POST', '/api/game/start');
    const table = ctx.app.lobby.table;
    await until(() => table.game.turn === 0, 5000, "the human's turn");
    await until(() => service.posts.length === 1, 3000, 'the first alert');
    assert.equal(JSON.parse(service.posts[0].text).body, "It's your turn.");
    await sleep(150); // not yet time for the second
    assert.equal(service.posts.length, 1);
    await until(() => service.posts.length === 2, 3000, 'the second alert');
    assert.equal(JSON.parse(service.posts[1].text).body, "It's still your turn.");
    await sleep(500); // still their turn, still away: two is the most
    assert.equal(service.posts.length, 2);
    for (const p of service.posts) {
      assert.deepEqual(Object.keys(JSON.parse(p.text)).sort(), ['body', 'tag', 'title', 'url']);
      assert.ok(!/\d[♦♣♥♠]|[♦♣♥♠]|\bjoker\b/i.test(p.text), 'no cards in an alert');
    }
    assert.equal(ctx.app.db.prepare('SELECT COUNT(*) AS n FROM push_log WHERE ok = 1').get().n, 2);
    assert.deepEqual(ctx.logs, []);
  } finally {
    await ctx.app.close();
  }
});

test('in a real game: someone who plays at once is not alerted for that turn', async () => {
  const phone = new FakeDevice();
  const service = fakePushService([phone]);
  const ctx = await boot({
    devTables: true,
    rng: mulberry32(5),
    pushFetch: service.fetchImpl,
    notify: { firstAfterMs: 60_000, secondAfterMs: 120_000 },
  });
  try {
    const me = await makeUser(ctx, 'quick', { isAdmin: true });
    await me.req('POST', '/api/push/subscribe', { subscription: phone.subscription });
    await me.req('POST', '/api/game', { aiLevel: 'easy' });
    await me.req('POST', '/api/game/start');
    const table = ctx.app.lobby.table;
    await until(() => table.game.turn === 0, 5000, "the human's turn");
    const mv = chooseMove((await me.req('GET', '/api/game')).json.table.game.view, 'easy', { rng: mulberry32(1) });
    assert.equal((await me.req('POST', '/api/game/move', { cards: mv ? mv.cards : null })).status, 200);
    await sleep(200);
    assert.equal(service.posts.length, 0, 'nothing is sent for a turn that was played at once');
  } finally {
    await ctx.app.close();
  }
});

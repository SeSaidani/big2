// Shared helpers for the server tests (not itself a test file).

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { createPool } from '../server/ai-pool.js';
import { createUser } from '../server/auth.js';
import { addSubscription } from '../server/push-store.js';
import { chooseMove } from '../src/ai/agents.js';
import { mulberry32 } from '../src/cards.js';

export const PASSWORD = 'correct-horse-battery';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function boot(opts = {}) {
  const logs = [];
  const app = createApp({
    pool: createPool({ inline: true }),
    aiDelayMs: 0,
    log: (...a) => logs.push(a),
    ...opts,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  return { app, logs, base: `http://127.0.0.1:${app.server.address().port}` };
}

export async function until(pred, ms = 10000, label = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
    this.errors = [];
  }

  async req(method, path, body, headers = {}) {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (this.cookie) h.cookie = this.cookie;
    const r = await fetch(this.base + path, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    let json = null;
    try {
      json = await r.json();
    } catch {
      /* not JSON */
    }
    return { status: r.status, json, headers: r.headers };
  }

  async login(name, password = PASSWORD) {
    const r = await this.req('POST', '/api/login', { name, password });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    this.user = r.json.user;
    return r;
  }

  openEvents() {
    const ac = new AbortController();
    const handlers = new Set();
    const log = [];
    (async () => {
      const res = await fetch(this.base + '/api/events', { headers: { cookie: this.cookie }, signal: ac.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block);
          const data = /^data: (.*)$/m.exec(block);
          if (!ev || !data) continue;
          const msg = { event: ev[1], data: JSON.parse(data[1]) };
          log.push(msg);
          for (const h of [...handlers]) h(msg);
        }
      }
    })().catch(() => {});
    return {
      log,
      close: () => ac.abort(),
      on: (h) => handlers.add(h),
      waitFor(pred, ms = 20000) {
        const hit = log.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('timed out waiting for an event')), ms);
          const h = (m) => {
            if (pred(m)) {
              clearTimeout(t);
              handlers.delete(h);
              resolve(m);
            }
          };
          handlers.add(h);
        });
      },
    };
  }
}

// A receiver, written from the other side of RFC 8291: what a phone does with a push body.
export function decryptPush(body, uaPrivate, uaPublic, auth) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  assert.equal(rs, 4096);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(uaPrivate, 'base64url'));
  const shared = ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(uaPublic, 'base64url'), asPublic]);
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const prk = hmac(Buffer.from(auth, 'base64url'), shared);
  const ikm = hmac(prk, Buffer.concat([info, Buffer.from([1])]));
  const prk2 = hmac(salt, ikm);
  const cek = hmac(prk2, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(
    0,
    16,
  );
  const nonce = hmac(prk2, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'the last record ends with 0x02');
  return plain.subarray(0, plain.length - 1);
}

// A phone that can be sent push messages: its subscription as a browser reports it, and a way to read
// what was sent to it.
export class FakeDevice {
  constructor(n = 0) {
    this.ecdh = crypto.createECDH('prime256v1');
    this.ecdh.generateKeys();
    this.p256dh = this.ecdh.getPublicKey().toString('base64url');
    this.auth = crypto.randomBytes(16).toString('base64url');
    this.endpoint = `https://fcm.googleapis.com/fcm/send/fake-${crypto.randomBytes(6).toString('hex')}-${n}`;
  }

  // The object a browser's pushManager.subscribe() gives (as JSON).
  get subscription() {
    return { endpoint: this.endpoint, keys: { p256dh: this.p256dh, auth: this.auth } };
  }

  // The text of a message that was POSTed to this device's endpoint.
  read(body) {
    return decryptPush(
      Buffer.from(body),
      this.ecdh.getPrivateKey().toString('base64url'),
      this.p256dh,
      this.auth,
    ).toString();
  }
}

// Gives the user a device straight in the database.
export function newDevice(db, userId, n = 0) {
  addSubscription(db, userId, new FakeDevice(n).subscription, { label: 'Test phone' });
}

// Creates the account directly in the database and signs in through the API.
export async function makeUser(ctx, name, { isAdmin = false } = {}) {
  await createUser(ctx.app.db, name, PASSWORD, { isAdmin });
  const c = new Client(ctx.base);
  await c.login(name);
  return c;
}

export const isTable = (m) => m.event === 'table' && m.data;
export const isDone = (m) => isTable(m) && m.data.status === 'done';

// Every table message must match this whitelisted shape and reveal no cards.
const TOP = [
  'id',
  'status',
  'host',
  'isHost',
  'aiLevel',
  'version',
  'you',
  'chatEnabled',
  'seats',
  'game',
  'result',
  'next',
  'leave',
  'notice',
  'hands',
].sort();
const SEAT = ['kind', 'name', 'level', 'count', 'online'].sort();
const GAME = ['view', 'turn', 'winner', 'rules'].sort();
const VIEW = ['me', 'hand', 'counts', 'trick', 'passed', 'leadPasses', 'first', 'played', 'history'].sort();
export function checkNoLeak(t, truth) {
  assert.deepEqual(Object.keys(t).sort(), TOP);
  t.seats.forEach((s) => assert.deepEqual(Object.keys(s).sort(), SEAT));
  if (t.status !== 'done') assert.equal(t.hands, null);
  if (!t.game) return;
  assert.deepEqual(Object.keys(t.game).sort(), GAME);
  const v = t.game.view;
  assert.deepEqual(Object.keys(v).sort(), VIEW);
  const pub = new Set([...truth.played, ...(truth.trick ? truth.trick.cards : [])]);
  const shown = [
    ...v.played,
    ...(v.trick ? v.trick.cards : []),
    ...v.history.flatMap((h) => [...(h.cards || []), ...(h.trick ? h.trick.cards : [])]),
  ];
  for (const c of shown) assert.ok(pub.has(c), `card ${c} shown before being played`);
  // My (possibly slightly stale) hand never overlaps anyone else's cards.
  truth.hands.forEach((h, q) => q === t.you || h.forEach((c) => assert.ok(!v.hand.includes(c))));
  assert.equal(v.me, t.you);
}

// A player that makes Easy-AI moves from nothing but its own view.
export function driveEasy(client, ev, truthOf) {
  let acted = -1;
  const rng = mulberry32(client.user.id);
  ev.on(async (m) => {
    if (!isTable(m)) return;
    try {
      const t = m.data;
      checkNoLeak(t, truthOf());
      // Act once per position in the game: a presence update re-sends the same
      // position under a new version number.
      const position = t.game ? t.game.view.history.length : -1;
      if (t.status !== 'playing' || t.game.turn !== t.you || position === acted) return;
      acted = position;
      const mv = chooseMove(t.game.view, 'easy', { rng });
      const r = await client.req('POST', '/api/game/move', { cards: mv ? mv.cards : null });
      if (r.status !== 200) client.errors.push(r);
    } catch (err) {
      client.errors.push(err);
    }
  });
}

// An admin creates the game and `n - 1` other people join it. Returns the
// clients in seat order (the admin first), each with an open event stream.
export async function seatPlayers(ctx, prefix, n = 4, aiLevel = 'easy', seats = 4) {
  const clients = [await makeUser(ctx, `${prefix}1`, { isAdmin: true })];
  for (let i = 2; i <= n; i++) clients.push(await makeUser(ctx, `${prefix}${i}`));
  for (const c of clients) {
    c.ev = c.openEvents();
    await c.ev.waitFor((m) => m.event === 'lobby');
  }
  const created = await clients[0].req('POST', '/api/game', { aiLevel, seats });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  for (const c of clients.slice(1)) assert.equal((await c.req('POST', '/api/game/join')).status, 200);
  return clients;
}

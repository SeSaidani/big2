import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  encryptPayload,
  generateVapidKeys,
  vapidAuthorization,
  isPushEndpoint,
  parseKeys,
  sendPush,
  MAX_PAYLOAD,
} from '../server/web-push.js';
import { decryptPush } from './support.js';

// RFC 8291 Appendix A, copied from the RFC (whitespace removed).
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_' +
    'yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('encryption reproduces the RFC 8291 Appendix A example byte for byte', () => {
  const body = encryptPayload({
    payload: Buffer.from(RFC.plaintext, 'base64url'),
    p256dh: RFC.uaPublic,
    auth: RFC.auth,
    ephemeral: { privateKey: RFC.asPrivate },
    salt: RFC.salt,
  });
  assert.equal(body.toString('base64url'), RFC.body);
  assert.equal(Buffer.from(RFC.plaintext, 'base64url').toString(), 'When I grow up, I want to be a watermelon');
});

test('a message encrypted for a device decrypts there, and only there', () => {
  const device = crypto.createECDH('prime256v1');
  device.generateKeys();
  const p256dh = device.getPublicKey().toString('base64url');
  const auth = crypto.randomBytes(16).toString('base64url');
  const message = JSON.stringify({ title: 'Big Two', body: "It's your turn." });
  const body = encryptPayload({ payload: message, p256dh, auth });
  assert.equal(decryptPush(body, device.getPrivateKey().toString('base64url'), p256dh, auth).toString(), message);
  // Fresh salt and key every time: the same message never encrypts the same way twice.
  assert.notDeepEqual(body, encryptPayload({ payload: message, p256dh, auth }));
  // Someone else's key, or the wrong auth secret, cannot read it.
  const other = crypto.createECDH('prime256v1');
  other.generateKeys();
  assert.throws(() =>
    decryptPush(body, other.getPrivateKey().toString('base64url'), other.getPublicKey().toString('base64url'), auth),
  );
  assert.throws(() =>
    decryptPush(
      body,
      device.getPrivateKey().toString('base64url'),
      p256dh,
      crypto.randomBytes(16).toString('base64url'),
    ),
  );
});

test('the size limit and bad keys are refused', () => {
  const device = crypto.createECDH('prime256v1');
  device.generateKeys();
  const p256dh = device.getPublicKey().toString('base64url');
  const auth = crypto.randomBytes(16).toString('base64url');
  assert.doesNotThrow(() => encryptPayload({ payload: Buffer.alloc(MAX_PAYLOAD), p256dh, auth }));
  assert.throws(() => encryptPayload({ payload: Buffer.alloc(MAX_PAYLOAD + 1), p256dh, auth }), RangeError);
  assert.equal(parseKeys('AAAA', auth), null, 'too short');
  assert.equal(parseKeys(p256dh, 'AAAA'), null, 'auth secret of the wrong size');
  const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');
  assert.equal(parseKeys(offCurve, auth), null, 'not a point on the curve');
  assert.throws(() => encryptPayload({ payload: 'x', p256dh: 'AAAA', auth }), TypeError);
});

test('the VAPID token is a valid ES256 JWT for the right audience, expiry and sender', async () => {
  const keys = generateVapidKeys();
  assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65);
  const now = Date.UTC(2026, 10, 5, 12, 0, 0);
  const header = vapidAuthorization({
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    keys,
    subject: 'https://big2.example.com',
    now,
  });
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  assert.ok(m, header);
  const [, h, c, s, k] = m;
  assert.equal(k, keys.publicKey);
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url')), {
    aud: 'https://fcm.googleapis.com',
    exp: now / 1000 + 12 * 3600,
    sub: 'https://big2.example.com',
  });
  // Verified by a different implementation (WebCrypto), from the public key alone.
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const publicKey = await crypto.subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'verify',
  ]);
  const signature = Buffer.from(s, 'base64url');
  assert.equal(signature.length, 64, 'raw r||s, not DER');
  assert.equal(
    await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, Buffer.from(`${h}.${c}`)),
    true,
  );
  // A different key does not verify it.
  const other = await crypto.subtle.importKey(
    'raw',
    Buffer.from(generateVapidKeys().publicKey, 'base64url'),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  assert.equal(
    await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, other, signature, Buffer.from(`${h}.${c}`)),
    false,
  );
});

test('only real push services are accepted as endpoints (the server calls them)', () => {
  const ok = [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QAbc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ];
  for (const u of ok) assert.equal(isPushEndpoint(u), true, u);
  const bad = [
    'http://fcm.googleapis.com/fcm/send/abc', // not https
    'https://169.254.169.254/latest/meta-data/', // the cloud metadata address
    'https://localhost/x',
    'https://fcm.googleapis.com.evil.example/x', // a lookalike
    'https://evil.example/fcm.googleapis.com',
    'https://user:pw@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'https://notify.windows.com.evil.example/x',
    'ftp://fcm.googleapis.com/x',
    'not a url',
    '',
    null,
    42,
    `https://fcm.googleapis.com/${'a'.repeat(1000)}`,
  ];
  for (const u of bad) assert.equal(isPushEndpoint(u), false, String(u));
  assert.equal(isPushEndpoint('https://push.test.example/x'), false);
  assert.equal(isPushEndpoint('https://push.test.example/x', { extraHosts: ['push.test.example'] }), true);
});

test('sending: what is posted, and how each answer is classified', async () => {
  const device = crypto.createECDH('prime256v1');
  device.generateKeys();
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    p256dh: device.getPublicKey().toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
  };
  const keys = generateVapidKeys();
  const seen = [];
  const reply = (status) => async (url, init) => {
    seen.push({ url, init });
    return new Response(null, { status });
  };
  const send = (fetchImpl) =>
    sendPush({ subscription, payload: 'hello', keys, subject: 'https://big2.example.com', fetchImpl });

  assert.deepEqual(await send(reply(201)), { ok: true, gone: false, retryable: false, status: 201 });
  const { url, init } = seen[0];
  assert.equal(url, subscription.endpoint);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(init.headers.TTL, '86400');
  assert.equal(init.headers.Urgency, 'high');
  assert.equal(init.headers.Topic, 'turn');
  assert.match(init.headers.Authorization, /^vapid t=.+, k=.+$/);
  assert.equal(
    decryptPush(
      Buffer.from(init.body),
      device.getPrivateKey().toString('base64url'),
      subscription.p256dh,
      subscription.auth,
    ).toString(),
    'hello',
  );

  assert.deepEqual(await send(reply(410)), { ok: false, gone: true, retryable: false, status: 410 });
  assert.deepEqual(await send(reply(404)), { ok: false, gone: true, retryable: false, status: 404 });
  assert.deepEqual(await send(reply(429)), { ok: false, gone: false, retryable: true, status: 429 });
  assert.deepEqual(await send(reply(503)), { ok: false, gone: false, retryable: true, status: 503 });
  assert.deepEqual(await send(reply(400)), { ok: false, gone: false, retryable: false, status: 400 });
  assert.deepEqual(
    await send(async () => {
      throw new Error('socket hang up');
    }),
    { ok: false, gone: false, retryable: true, status: 0 },
    'a network failure is retryable and never throws',
  );
  const broken = await sendPush({
    subscription: { ...subscription, p256dh: 'AAAA' },
    payload: 'x',
    keys,
    subject: 'https://big2.example.com',
    fetchImpl: reply(201),
  });
  assert.equal(broken.gone, true, 'keys that cannot work are dropped, nothing is sent');
  assert.equal(seen.length, 6, 'six answered requests; the network failure and the bad keys never recorded one');
});

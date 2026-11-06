// Web Push, written out with Node's own crypto so the server needs no library.
//
//   RFC 8291  message encryption (aes128gcm): the push service only ever sees ciphertext.
//   RFC 8292  VAPID: a signed token (ES256) that says which server is sending.
//   RFC 8030  the HTTP request itself: POST to the subscription's endpoint.
//
// Checked against the test vector in RFC 8291 Appendix A (test/web-push.test.js).

import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

const RECORD_SIZE = 4096;
export const MAX_PAYLOAD = RECORD_SIZE - 86 - 16 - 1; // header, GCM tag and the padding delimiter

// ---- the places a subscription may point at ----
// The server POSTs to whatever endpoint a browser hands it, so an arbitrary URL would let any signed-in
// user make the server call any address (SSRF). Only the real push services are accepted.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, // Chrome, Edge, Opera, Samsung Internet and every Android browser
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^web\.push\.apple\.com$/, // Safari and iPhone Home Screen apps
  /^[a-z0-9-]+\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/, // Edge on Windows
];

export function isPushEndpoint(value, { extraHosts = [] } = {}) {
  if (typeof value !== 'string' || value.length > 1000) return false;
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  return PUSH_HOSTS.some((re) => re.test(u.hostname)) || extraHosts.includes(u.hostname);
}

// A subscription's keys: p256dh is an uncompressed P-256 point (65 bytes), auth is 16 random bytes.
export function parseKeys(p256dh, auth) {
  const pub = unb64u(p256dh);
  const secret = unb64u(auth);
  if (pub.length !== 65 || pub[0] !== 4 || secret.length !== 16) return null;
  try {
    const probe = crypto.createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(pub); // throws unless it is a point on the curve
  } catch {
    return null;
  }
  return { pub, secret };
}

// ---- RFC 8291: encrypt one message for one subscription ----
// `ephemeral` ({ privateKey }) and `salt` are only given by the test that reproduces the RFC's example.
export function encryptPayload({ payload, p256dh, auth, ephemeral, salt }) {
  const plain = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  if (plain.length > MAX_PAYLOAD) throw new RangeError(`Push payload too large (${plain.length} bytes).`);
  const keys = parseKeys(p256dh, auth);
  if (!keys) throw new TypeError('Bad subscription keys.');

  const ecdh = crypto.createECDH('prime256v1');
  if (ephemeral) ecdh.setPrivateKey(unb64u(ephemeral.privateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(); // 65 bytes, uncompressed
  const shared = ecdh.computeSecret(keys.pub);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), keys.pub, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, keys.secret, keyInfo, 32));
  const theSalt = salt ? unb64u(salt) : crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, theSalt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, theSalt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // One record: the message, then 0x02 ("this is the last record"). No further padding.
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([plain, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(21);
  theSalt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed]);
}

// ---- RFC 8292: VAPID ----
export function generateVapidKeys() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const publicKey = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
  return { publicKey: b64u(publicKey), privateKey: jwk.d };
}

function vapidPrivateKeyObject({ publicKey, privateKey }) {
  const pub = unb64u(publicKey);
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
}

// The Authorization header for a push to `endpoint`. The token names the push service's origin,
// who is sending (a contact URL or mailto:) and when it stops being valid (at most 24 hours).
export function vapidAuthorization({ endpoint, keys, subject, now = Date.now(), lifetimeS = 12 * 3600 }) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(
    JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + lifetimeS, sub: subject }),
  );
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: vapidPrivateKeyObject(keys),
    dsaEncoding: 'ieee-p1363', // the raw r||s form JWT wants, not DER
  });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

// ---- RFC 8030: send ----
// Returns { ok, gone, retryable, status }. `gone` means the subscription is dead for good (404/410) and
// should be forgotten. Never throws for a network failure or a refusal: callers decide what to do.
export async function sendPush({
  subscription,
  payload,
  keys,
  subject,
  fetchImpl = fetch,
  ttlS = 24 * 3600,
  urgency = 'high',
  topic = 'turn',
  timeoutMs = 10_000,
  now = Date.now(),
}) {
  let body;
  try {
    body = encryptPayload({ payload, p256dh: subscription.p256dh, auth: subscription.auth });
  } catch {
    return { ok: false, gone: true, retryable: false, status: 0 }; // keys that cannot work are as good as gone
  }
  let res;
  try {
    res = await fetchImpl(subscription.endpoint, {
      method: 'POST',
      redirect: 'error', // a push service never redirects; following one could point us anywhere
      headers: {
        Authorization: vapidAuthorization({ endpoint: subscription.endpoint, keys, subject, now }),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttlS),
        Urgency: urgency,
        Topic: topic, // a newer message with the same topic replaces one still waiting
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, gone: false, retryable: true, status: 0 };
  }
  // Drain the (small) body so the connection is released.
  await res.arrayBuffer().catch(() => {});
  if (res.status >= 200 && res.status < 300) return { ok: true, gone: false, retryable: false, status: res.status };
  if (res.status === 404 || res.status === 410) return { ok: false, gone: true, retryable: false, status: res.status };
  const retryable = res.status === 429 || res.status >= 500;
  return { ok: false, gone: false, retryable, status: res.status };
}

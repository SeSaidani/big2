// Turn-alert devices in the database: who has alerts on, where, and what has been sent.
// A device is a browser's push subscription (see web-push.js). Nothing here is a phone number or an email.

import { getSetting, setSetting } from './db.js';
import { generateVapidKeys, isPushEndpoint, parseKeys } from './web-push.js';

export const MAX_DEVICES = 10;

export class PushError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// The keys that sign our messages. Made once, on first use, and kept: changing them would silence every
// device (subscriptions are tied to the key they were made with).
export function vapidKeys(db) {
  const publicKey = getSetting(db, 'vapid_public', '');
  const privateKey = getSetting(db, 'vapid_private', '');
  if (publicKey && privateKey) return { publicKey, privateKey };
  const fresh = generateVapidKeys();
  setSetting(db, 'vapid_public', fresh.publicKey);
  setSetting(db, 'vapid_private', fresh.privateKey);
  return fresh;
}

// A device's name as people see it ("Android phone, Chrome"): short, plain text, set by the browser.
const cleanLabel = (s) =>
  String(s ?? '')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 40) || 'This device';

// `sub` is what the browser gives: { endpoint, keys: { p256dh, auth } }. Subscribing again from the same
// browser updates its row (and moves it to whoever is signed in now); it never makes a second one.
export function addSubscription(db, userId, sub, { label, now = Date.now(), extraHosts = [] } = {}) {
  const endpoint = sub && sub.endpoint;
  const p256dh = sub && sub.keys && sub.keys.p256dh;
  const auth = sub && sub.keys && sub.keys.auth;
  if (!isPushEndpoint(endpoint, { extraHosts })) throw new PushError('That is not a push service address.');
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !parseKeys(p256dh, auth)) {
    throw new PushError('The device keys are not valid.');
  }
  const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
  if (existing) {
    db.prepare('UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ?, label = ? WHERE id = ?').run(
      userId,
      p256dh,
      auth,
      cleanLabel(label),
      existing.id,
    );
    return existing.id;
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId).n;
  if (count >= MAX_DEVICES) {
    throw new PushError(`You already have alerts on for ${MAX_DEVICES} devices. Turn one off first.`, 409);
  }
  const r = db
    .prepare(
      'INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, label, created) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(userId, endpoint, p256dh, auth, cleanLabel(label), now);
  return Number(r.lastInsertRowid);
}

export function listSubscriptions(db, userId) {
  return db
    .prepare(
      'SELECT id, endpoint, p256dh, auth, label, created, last_ok AS lastOk FROM push_subscriptions WHERE user_id = ? ORDER BY id',
    )
    .all(userId)
    .map((r) => ({ ...r }));
}

// What a person may see about their own devices: never the endpoint or the keys.
export const publicDevices = (db, userId) =>
  listSubscriptions(db, userId).map(({ id, label, created, lastOk }) => ({ id, label, created, lastOk }));

export function removeSubscription(db, userId, endpoint) {
  return (
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint).changes > 0
  );
}

export function removeSubscriptionById(db, id) {
  db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id);
}

export function markDelivered(db, id, now = Date.now()) {
  db.prepare('UPDATE push_subscriptions SET last_ok = ? WHERE id = ?').run(now, id);
}

// ---- the send log ----
export function logPush(db, userId, ok, now = Date.now()) {
  db.prepare('INSERT INTO push_log (user_id, ok, sent) VALUES (?, ?, ?)').run(userId, ok ? 1 : 0, now);
}

// Alerts that reached a device since `sinceMs`.
export function countPush(db, userId, sinceMs) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM push_log WHERE user_id = ? AND ok = 1 AND sent >= ?')
    .get(userId, sinceMs).n;
}

export function lastPushAt(db, userId) {
  const r = db.prepare('SELECT MAX(sent) AS t FROM push_log WHERE user_id = ? AND ok = 1').get(userId);
  return r && r.t !== null ? r.t : null;
}

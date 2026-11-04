// Phone numbers in the database: setting one, the 6-digit verification code
// (hashed, 10 minutes, 5 tries), who may be texted, and the send log.
// Whole numbers only ever come out of here for the notifier and the
// verification sender; everything shown to people goes through maskPhone.

import crypto from 'node:crypto';
import { PhoneError, maskPhone } from './phone-format.js';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

// `phone` must already be normalised (normalizePhone). Changing the number
// clears verification and any pending code, and lifts an opt-out block.
export function setUserPhone(db, userId, phone, { verified = false } = {}) {
  try {
    const r = db
      .prepare('UPDATE users SET phone = ?, phone_verified = ?, sms_blocked = 0 WHERE id = ?')
      .run(phone, verified ? 1 : 0, userId);
    if (!r.changes) throw new PhoneError('No such user.', 404);
  } catch (err) {
    if (/UNIQUE/i.test(String(err.message))) {
      throw new PhoneError('That number is already used by another account.', 409);
    }
    throw err;
  }
  db.prepare('DELETE FROM phone_codes WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM login_codes WHERE user_id = ?').run(userId); // a code texted to the old number is void
}

// What the user themselves may see about their phone, and what they still have to do.
export function accountPhone(db, userId, { verificationRequired }) {
  const r = db
    .prepare(
      'SELECT phone, phone_verified AS verified, sms_enabled AS enabled, sms_blocked AS blocked FROM users WHERE id = ?',
    )
    .get(userId);
  if (!r) return null;
  return {
    phone: maskPhone(r.phone),
    phoneVerified: !!r.verified,
    smsEnabled: !!r.enabled,
    smsBlocked: !!r.blocked,
    // true until a number is on file, and (when texting is on) until it is verified
    phoneRequired: !r.phone || (verificationRequired && !r.verified),
    needsCode: !!r.phone && verificationRequired && !r.verified,
  };
}

export function setSmsEnabled(db, userId, enabled) {
  db.prepare('UPDATE users SET sms_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, userId);
}

export function blockSms(db, userId) {
  db.prepare('UPDATE users SET sms_blocked = 1 WHERE id = ?').run(userId);
}

// The raw row, for the notifier and for sending a code. Never send it to a client.
export function textingRow(db, userId) {
  const r = db
    .prepare(
      'SELECT phone, phone_verified AS verified, sms_enabled AS enabled, sms_blocked AS blocked FROM users WHERE id = ?',
    )
    .get(userId);
  return r ? { phone: r.phone, verified: !!r.verified, enabled: !!r.enabled, blocked: !!r.blocked } : null;
}

// ---- verification codes ----

// Makes (and stores the hash of) a new code for the user's current number.
export function createCode(db, userId, now = Date.now()) {
  const row = db.prepare('SELECT phone FROM users WHERE id = ?').get(userId);
  if (!row || !row.phone) throw new PhoneError('Add a phone number first.');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const salt = crypto.randomBytes(8).toString('hex');
  db.prepare(
    `INSERT INTO phone_codes (user_id, phone, salt, code_hash, expires, attempts) VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT(user_id) DO UPDATE SET phone = excluded.phone, salt = excluded.salt,
       code_hash = excluded.code_hash, expires = excluded.expires, attempts = 0`,
  ).run(userId, row.phone, salt, sha(`${salt}:${code}`), now + CODE_TTL_MS);
  return { code, phone: row.phone };
}

export function dropCode(db, userId) {
  db.prepare('DELETE FROM phone_codes WHERE user_id = ?').run(userId);
}

// Throws PhoneError unless the code is right. Marks the number verified on success.
export function checkCode(db, userId, code, now = Date.now()) {
  const wrong = new PhoneError('That code is not right.', 400);
  const row = db.prepare('SELECT * FROM phone_codes WHERE user_id = ?').get(userId);
  if (!row) throw new PhoneError('Ask for a new code first.');
  const current = db.prepare('SELECT phone FROM users WHERE id = ?').get(userId);
  if (!current || current.phone !== row.phone) {
    dropCode(db, userId);
    throw new PhoneError('Your number changed. Ask for a new code.');
  }
  if (row.expires <= now) {
    dropCode(db, userId);
    throw new PhoneError('That code has expired. Ask for a new one.');
  }
  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    dropCode(db, userId);
    throw new PhoneError('Too many wrong tries. Ask for a new code.', 429);
  }
  db.prepare('UPDATE phone_codes SET attempts = attempts + 1 WHERE user_id = ?').run(userId);
  const given = Buffer.from(sha(`${row.salt}:${String(code ?? '').trim()}`));
  const want = Buffer.from(row.code_hash);
  if (!crypto.timingSafeEqual(given, want)) throw wrong;
  db.prepare('UPDATE users SET phone_verified = 1 WHERE id = ?').run(userId);
  dropCode(db, userId);
}

// ---- send log ----

export function logSms(db, userId, kind, ok, now = Date.now()) {
  db.prepare('INSERT INTO sms_log (user_id, kind, ok, sent) VALUES (?, ?, ?, ?)').run(userId, kind, ok ? 1 : 0, now);
}

export function lastSmsAt(db, userId, kind) {
  const r = db
    .prepare('SELECT MAX(sent) AS t FROM sms_log WHERE user_id = ? AND kind = ? AND ok = 1')
    .get(userId, kind);
  return r && r.t !== null ? r.t : null;
}

export function countSms(db, userId, kind, sinceMs) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM sms_log WHERE user_id = ? AND kind = ? AND ok = 1 AND sent >= ?')
    .get(userId, kind, sinceMs).n;
}

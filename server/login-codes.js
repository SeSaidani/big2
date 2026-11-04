// Sign-in by texted code. One pending 6-digit code per user: stored as
// SHA-256(salt:code), valid for 10 minutes, 5 tries, then gone; a new code
// replaces the old one and a correct one is used up. Sending and rate limits
// live in index.js; this is only the storage and the comparison.
//
// Guessing odds: 5 tries per code and 3 codes an hour per account is at most
// 15 guesses an hour against 10^6 codes: about 1.5e-5 per hour of sustained attack.

import crypto from 'node:crypto';
import { CODE_TTL_MS, MAX_CODE_ATTEMPTS } from './phones.js';

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const MAX_GIVEN = 20; // anything longer cannot be a code; bounds the work per request

export function createLoginCode(db, userId, now = Date.now()) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const salt = crypto.randomBytes(8).toString('hex');
  db.prepare(
    `INSERT INTO login_codes (user_id, salt, code_hash, expires, attempts) VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(user_id) DO UPDATE SET salt = excluded.salt, code_hash = excluded.code_hash,
       expires = excluded.expires, attempts = 0`,
  ).run(userId, salt, sha(`${salt}:${code}`), now + CODE_TTL_MS);
  return code;
}

export function dropLoginCode(db, userId) {
  db.prepare('DELETE FROM login_codes WHERE user_id = ?').run(userId);
}

// true only for the right, unexpired code with tries left; it is then used up.
// Every failure looks the same to the caller, which must not say which it was.
export function checkLoginCode(db, userId, given, now = Date.now()) {
  const row = db.prepare('SELECT * FROM login_codes WHERE user_id = ?').get(userId);
  if (!row) return false;
  if (row.expires <= now || row.attempts >= MAX_CODE_ATTEMPTS) {
    dropLoginCode(db, userId);
    return false;
  }
  db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE user_id = ?').run(userId);
  const text = typeof given === 'string' || typeof given === 'number' ? String(given).trim() : '';
  if (text.length > MAX_GIVEN) return false;
  const got = Buffer.from(sha(`${row.salt}:${text}`));
  if (!crypto.timingSafeEqual(got, Buffer.from(row.code_hash))) return false;
  dropLoginCode(db, userId);
  return true;
}

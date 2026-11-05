// Accounts: scrypt password hashes, random session tokens (only their SHA-256
// is stored), and a small sliding-window rate limiter.

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const NAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 200; // bounds the work an attacker can force per request

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    return `Password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters.`;
  }
  return null;
}

export function validateCredentials(name, password) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return 'Name must be 3-20 characters: letters, digits, _ or -.';
  }
  return validatePassword(password);
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, key] = parts;
  const want = Buffer.from(key, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), want.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(got, want);
}

// Unknown names still cost one scrypt, so response time doesn't reveal them.
let dummyHash;
async function burn(password) {
  dummyHash ||= await hashPassword('dummy-password');
  await verifyPassword(password, dummyHash);
}

export async function createUser(db, name, password, { isAdmin = false } = {}) {
  const err = validateCredentials(name, password);
  if (err) throw new AuthError(400, err);
  const hash = await hashPassword(password);
  try {
    const r = db
      .prepare('INSERT INTO users (name, pw_hash, created, is_admin) VALUES (?, ?, ?, ?)')
      .run(name, hash, Date.now(), isAdmin ? 1 : 0);
    return { id: Number(r.lastInsertRowid), name, isAdmin };
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) throw new AuthError(409, 'That name is taken.');
    throw e;
  }
}

export async function login(db, name, password) {
  const bad = new AuthError(401, 'Invalid name or password.');
  if (typeof name !== 'string' || typeof password !== 'string' || password.length > MAX_PASSWORD) throw bad;
  const row = db.prepare('SELECT id, name, pw_hash, is_admin, disabled FROM users WHERE name = ?').get(name);
  if (!row) {
    await burn(password);
    throw bad;
  }
  if (!(await verifyPassword(password, row.pw_hash))) throw bad;
  // Only someone who knows the password learns the account is disabled.
  if (row.disabled) throw new AuthError(403, 'This account has been disabled. Ask an admin.');
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), row.id);
  return { id: row.id, name: row.name, isAdmin: !!row.is_admin };
}

export async function setPassword(db, userId, password) {
  const err = validatePassword(password);
  if (err) throw new AuthError(400, err);
  const hash = await hashPassword(password);
  const r = db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(hash, userId);
  if (!r.changes) throw new AuthError(404, 'No such user.');
  deleteUserSessions(db, userId); // everyone signed in with the old password is signed out
}

export async function changeOwnPassword(db, userId, current, next) {
  const row = db.prepare('SELECT pw_hash FROM users WHERE id = ?').get(userId);
  if (typeof current !== 'string' || !row || !(await verifyPassword(current, row.pw_hash))) {
    throw new AuthError(401, 'Your current password is wrong.');
  }
  await setPassword(db, userId, next);
}

const sha = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function createSession(db, userId, ttlMs, now = Date.now()) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_sha256, user_id, expires, created) VALUES (?, ?, ?, ?)').run(
    sha(token),
    userId,
    now + ttlMs,
    now,
  );
  return token;
}

// A session lives ttlMs from its last use, never longer than maxMs from when it began. Renewing
// costs a write, so it happens only once less than half the lifetime is left. Returns the new
// expiry (ms), or null when the session was left as it is.
export function renewSession(db, token, ttlMs, maxMs, now = Date.now()) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const row = db.prepare('SELECT expires, created FROM sessions WHERE token_sha256 = ?').get(sha(token));
  if (!row || row.expires <= now || row.expires - now >= ttlMs / 2) return null;
  const began = row.created || row.expires - ttlMs; // sessions from before `created` existed
  const expires = Math.min(now + ttlMs, began + maxMs);
  if (expires <= row.expires) return null;
  db.prepare('UPDATE sessions SET expires = ? WHERE token_sha256 = ?').run(expires, sha(token));
  return expires;
}

export function getSession(db, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const row = db
    .prepare(
      `SELECT u.id AS id, u.name AS name, u.is_admin AS isAdmin, s.expires AS expires FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token_sha256 = ? AND u.disabled = 0`,
    )
    .get(sha(token));
  if (!row || row.expires <= now) return null;
  return { id: row.id, name: row.name, isAdmin: !!row.isAdmin };
}

export function deleteSession(db, token) {
  if (typeof token === 'string') db.prepare('DELETE FROM sessions WHERE token_sha256 = ?').run(sha(token));
}

export function deleteUserSessions(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function purgeSessions(db, now = Date.now()) {
  db.prepare('DELETE FROM sessions WHERE expires <= ?').run(now);
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Allows `max` events per `windowMs` per key. Caller decides what to count.
export class RateLimiter {
  constructor(max, windowMs, now = Date.now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  #prune(key) {
    const t = this.now() - this.windowMs;
    const list = (this.hits.get(key) || []).filter((x) => x > t);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  allowed(key) {
    return this.#prune(key).length < this.max;
  }

  record(key) {
    if (this.hits.size > 10000) this.hits.clear(); // bound memory under a flood of keys
    const list = this.#prune(key);
    list.push(this.now());
    this.hits.set(key, list);
  }
}

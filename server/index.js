// Online Big Two server: static files, accounts, the one table, chat, an admin
// API and a Server-Sent Events stream. No dependencies beyond Node itself.
//
//   node server/index.js
//   env: PORT=8765  HOST=127.0.0.1  DB_FILE=data/big2.db
//        AI_DELAY_MS=700 (pause before each computer move, so humans can follow)
//        TRUST_PROXY=1 (behind Caddy/nginx: take the client IP from X-Forwarded-For)
//        SECURE_COOKIES=1 (when served over HTTPS)
//   first admin: node server/admin.js make-admin <name>
//
// Binds to localhost by default; set HOST=0.0.0.0 to expose it on the LAN.
// Clients send moves with POST and receive state over GET /api/events; the
// server is authoritative and each client only ever receives its own view.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDb,
  leaderboard,
  getSetting,
  setSetting,
  audit,
  recentAudit,
  listUsers,
  adminCount,
  stats,
  listSeasons,
  createSeason,
  updateSeason,
  deleteSeason,
  endSeason,
} from './db.js';
import { luckAndSkill } from './stats.js';
import { recordSolo, soloStats } from './solo.js';
import * as auth from './auth.js';
import { Hub } from './hub.js';
import { Lobby } from './lobby.js';
import { createPool } from './ai-pool.js';
import { secureRng } from './table.js';
import {
  addSubscription,
  removeSubscription,
  removeAllSubscriptions,
  publicDevices,
  listSubscriptions,
} from './push-store.js';
import { createPusher } from './pusher.js';
import { TurnNotifier } from './notify.js';
import { isMain } from './main-module.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 4096;
const SESSION_MS = 30 * 24 * 3600 * 1000; // from the last use...
const SESSION_MAX_MS = 180 * 24 * 3600 * 1000; // ...but never beyond this from sign-in
const COOKIE = 'sid';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; " +
    "worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isHttpError = (e) => Number.isInteger(e && e.status);

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}

async function readJson(req) {
  if ((req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') {
    throw new HttpError(415, 'Send application/json.');
  }
  if (Number(req.headers['content-length']) > MAX_BODY) throw new HttpError(413, 'Request too large.');
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request too large.');
    chunks.push(c);
  }
  let v;
  try {
    v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Expected a JSON object.');
  return v;
}

// null = pass; otherwise 1-5 distinct integer card ids.
function parseCards(x) {
  if (x === null) return null;
  const ok =
    Array.isArray(x) &&
    x.length >= 1 &&
    x.length <= 5 &&
    x.every((c) => Number.isInteger(c) && c >= 0 && c < 56) &&
    new Set(x).size === x.length;
  if (!ok) throw new HttpError(400, 'cards must be null or 1-5 distinct card ids.');
  return x;
}

const seasonDetail = (s) =>
  `${new Date(s.starts).toISOString()} to ${s.ends === null ? 'open-ended' : new Date(s.ends).toISOString()}`;

const parseId = (s) => {
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, 'Bad id.');
  return n;
};

export function createApp(opts = {}) {
  const cfg = {
    aiDelayMs: opts.aiDelayMs ?? 700,
    // Off in production. Development and tests turn it on to get computer seats and 3-seat tables online.
    devTables: !!opts.devTables,
    rng: opts.rng ?? secureRng,
    now: opts.now ?? Date.now,
    startDelayMs: opts.startDelayMs ?? 10_000, // from the fourth person sitting down to the deal
    nextGameDelayMs: opts.nextGameDelayMs ?? 30_000, // how long the results stay up before the next game
    clockMs: opts.clockMs ?? 5000, // how often the table checks the seasons
    // A name for this copy of the site ("Staging"), shown on every page and in the app's name, so a test copy can
    // never be mistaken for the real one. Plain letters, digits, spaces and . _ - only.
    label: /^[A-Za-z0-9 ._-]{1,20}$/.test(opts.label ?? '') ? opts.label : '',
  };
  const ownsDb = !opts.db;
  const db = opts.db ?? openDb(opts.dbFile ?? ':memory:');
  const pool = opts.pool ?? createPool();
  const log = opts.log ?? ((...a) => console.error(...a));
  const hub = new Hub();
  const chatLimit = new auth.RateLimiter(5, 10 * 1000);
  // Turn alerts are push notifications to the devices people have turned them on for.
  const pusher =
    opts.pusher ??
    createPusher({
      db,
      subject: opts.publicUrl || 'https://big2.invalid',
      now: cfg.now,
      log,
      ...(opts.pushFetch ? { fetchImpl: opts.pushFetch } : {}),
    });
  const pushHosts = opts.pushHosts ?? []; // extra hosts a test's fake push service listens on
  const notifier = new TurnNotifier({ db, pusher, config: { ...opts.notify, now: cfg.now }, log });
  const pushTestLimit = new auth.RateLimiter(5, 3600 * 1000); // test alerts per person per hour
  const soloLimit = new auth.RateLimiter(300, 3600 * 1000); // solo results per person per hour
  const lobby = new Lobby({ db, pool, hub, cfg, log, chatLimit, notifier });
  hub.onPresence = (userId) => lobby.presence(userId); // the hub and the lobby need each other
  lobby.restore();
  lobby.startClock();
  const loginLimit = new auth.RateLimiter(10, 15 * 60 * 1000);
  const registerLimit = new auth.RateLimiter(10, 3600 * 1000);

  auth.purgeSessions(db);
  const purger = setInterval(() => auth.purgeSessions(db), 3600 * 1000);
  purger.unref();

  const registrationOpen = () => getSetting(db, 'registration_open', '0') === '1';

  const clientIp = (req) => {
    if (opts.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',');
      const last = xff[xff.length - 1].trim();
      if (last) return last;
    }
    return req.socket.remoteAddress || 'unknown';
  };

  const cookieFor = (token, maxAgeS) =>
    `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeS}${opts.secureCookies ? '; Secure' : ''}`;

  const sessionToken = (req) => auth.parseCookies(req.headers.cookie)[COOKIE];

  // Which response answers a request, so a renewed session can put its fresh cookie on it.
  const responses = new WeakMap();

  // Using the site keeps you signed in: a session with under half its life left is extended and
  // the browser gets a new cookie to match.
  function renewSession(req) {
    const token = sessionToken(req);
    const expires = auth.renewSession(db, token, SESSION_MS, SESSION_MAX_MS);
    const res = responses.get(req);
    if (expires && res && !res.headersSent) {
      res.setHeader('Set-Cookie', cookieFor(token, Math.floor((expires - Date.now()) / 1000)));
    }
  }

  const currentUser = (req) => {
    const user = auth.getSession(db, sessionToken(req));
    if (user) renewSession(req);
    return user;
  };

  const requireUser = (req) => {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'Please log in.');
    return user;
  };

  const requireAdmin = (req) => {
    const user = requireUser(req);
    if (!user.isAdmin) throw new HttpError(403, 'Admins only.');
    return user;
  };

  // SameSite=Strict already keeps cross-site requests from carrying the
  // cookie; this also rejects a browser request whose Origin is another host.
  const checkOrigin = (req) => {
    const origin = req.headers.origin;
    if (!origin) return;
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      throw new HttpError(403, 'Bad origin.');
    }
    if (host !== req.headers.host) throw new HttpError(403, 'Cross-origin request refused.');
  };

  const MAX_STREAMS_PER_USER = 8;
  const MAX_STREAMS_TOTAL = 500;

  function openStream(req, res, user) {
    // Each stream holds a socket and a buffer: bound them per user and overall.
    const mine = hub.conns.get(user.id);
    if (mine && mine.size >= MAX_STREAMS_PER_USER) {
      throw new HttpError(429, 'Too many open connections for this account.');
    }
    let total = 0;
    for (const set of hub.conns.values()) total += set.size;
    if (total >= MAX_STREAMS_TOTAL) throw new HttpError(503, 'The server is busy. Try again shortly.');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    hub.sendTo(res, 'lobby', lobby.summary());
    // Always say where this user stands (null = not seated), so a client that
    // reconnects after a restart or a cancelled game never keeps a stale table.
    const t = lobby.tableOf(user.id);
    hub.sendTo(res, 'table', t ? t.view(user.id) : null, t ? t.version : undefined);
    if (t) hub.sendTo(res, 'chathistory', t.chat);
    hub.add(user.id, res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      hub.remove(user.id, res);
    });
  }

  function startSession(res, user, status) {
    const token = auth.createSession(db, user.id, SESSION_MS);
    sendJson(res, status, { user }, { 'Set-Cookie': cookieFor(token, SESSION_MS / 1000) });
  }

  const gameReply = (res, user, status = 200) => {
    const t = lobby.tableOf(user.id);
    sendJson(res, status, { table: t ? t.view(user.id) : null, ...lobby.summary() }, {});
  };

  const getUserRow = (id) => {
    const row = db.prepare('SELECT id, name, is_admin AS isAdmin, disabled FROM users WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'No such user.');
    return { ...row, isAdmin: !!row.isAdmin, disabled: !!row.disabled };
  };

  // ---- admin ----
  async function adminApi(req, res, url) {
    const admin = requireAdmin(req);
    const p = url.pathname;
    const m = req.method;

    if (p === '/api/admin/overview' && m === 'GET') {
      return sendJson(res, 200, {
        stats: stats(db),
        registrationOpen: registrationOpen(),
        online: hub.conns.size,
        ...lobby.summary(),
      });
    }
    if (p === '/api/admin/users' && m === 'GET') return sendJson(res, 200, { users: listUsers(db) });
    if (p === '/api/admin/users' && m === 'POST') {
      const body = await readJson(req);
      const user = await auth.createUser(db, body.name, body.password, { isAdmin: body.isAdmin === true });
      audit(db, admin.id, 'create_user', user.name, user.isAdmin ? 'admin' : null);
      return sendJson(res, 201, { user });
    }
    const act = /^\/api\/admin\/users\/(\d+)\/(password|status|role)$/.exec(p);
    if (act && m === 'POST') {
      const target = getUserRow(parseId(act[1]));
      const body = await readJson(req);
      if (act[2] === 'password') {
        await auth.setPassword(db, target.id, body.password);
        hub.disconnect(target.id);
        audit(db, admin.id, 'reset_password', target.name);
      } else if (act[2] === 'status') {
        if (typeof body.disabled !== 'boolean') throw new HttpError(400, 'disabled must be true or false.');
        if (body.disabled && target.id === admin.id) throw new HttpError(409, 'You cannot disable yourself.');
        if (body.disabled && target.isAdmin && !target.disabled && adminCount(db) <= 1) {
          throw new HttpError(409, 'That is the last active admin.');
        }
        db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(body.disabled ? 1 : 0, target.id);
        if (body.disabled) {
          auth.deleteUserSessions(db, target.id);
          hub.disconnect(target.id);
        }
        audit(db, admin.id, body.disabled ? 'disable_user' : 'enable_user', target.name);
      } else {
        if (typeof body.isAdmin !== 'boolean') throw new HttpError(400, 'isAdmin must be true or false.');
        if (!body.isAdmin && target.isAdmin && !target.disabled && adminCount(db) <= 1) {
          throw new HttpError(409, 'That is the last active admin.');
        }
        db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(body.isAdmin ? 1 : 0, target.id);
        audit(db, admin.id, body.isAdmin ? 'make_admin' : 'remove_admin', target.name);
      }
      return sendJson(res, 200, { user: getUserRow(target.id) });
    }
    if (p === '/api/admin/game/cancel' && m === 'POST') {
      if (!lobby.table) throw new HttpError(404, 'There is no game to cancel.');
      const was = lobby.table.status;
      lobby.cancel();
      audit(db, admin.id, 'cancel_game', null, was === 'playing' ? 'in progress; not scored' : was);
      return sendJson(res, 200, lobby.summary());
    }
    if (p === '/api/admin/settings' && m === 'POST') {
      const body = await readJson(req);
      if (typeof body.registrationOpen !== 'boolean') {
        throw new HttpError(400, 'registrationOpen must be true or false.');
      }
      setSetting(db, 'registration_open', body.registrationOpen ? '1' : '0');
      audit(db, admin.id, 'set_registration', body.registrationOpen ? 'open' : 'closed');
      return sendJson(res, 200, { registrationOpen: registrationOpen() });
    }
    if (p === '/api/admin/seasons' && m === 'POST') {
      const body = await readJson(req);
      const season = createSeason(db, body);
      audit(db, admin.id, 'create_season', season.name, seasonDetail(season));
      lobby.reconcile(); // a season that is running now opens the table
      return sendJson(res, 201, { season });
    }
    const sea = /^\/api\/admin\/seasons\/(\d+)(\/delete|\/end)?$/.exec(p);
    if (sea && m === 'POST') {
      const id = parseId(sea[1]);
      if (sea[2] === '/end') {
        const season = endSeason(db, id, cfg.now());
        const was = lobby.stopForSeasonEnd();
        audit(
          db,
          admin.id,
          'end_season',
          season.name,
          seasonDetail(season) + (was === 'playing' ? '; the game in progress was stopped, not scored' : ''),
        );
        return sendJson(res, 200, { season });
      }
      if (sea[2]) {
        const before = listSeasons(db, cfg.now()).find((s) => s.id === id);
        deleteSeason(db, id);
        lobby.reconcile();
        audit(db, admin.id, 'delete_season', before ? before.name : String(id), before ? seasonDetail(before) : null);
        return sendJson(res, 200, { ok: true });
      }
      const body = await readJson(req);
      const season = updateSeason(db, id, body);
      audit(db, admin.id, 'update_season', season.name, seasonDetail(season));
      lobby.reconcile();
      return sendJson(res, 200, { season });
    }
    if (p === '/api/admin/audit' && m === 'GET') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      return sendJson(res, 200, { entries: recentAudit(db, limit) });
    }
    throw new HttpError(404, 'Not found.');
  }

  async function api(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    if (m === 'POST') checkOrigin(req);

    if (p === '/api/config' && m === 'GET') {
      return sendJson(res, 200, {
        registrationOpen: registrationOpen(),
        devTables: cfg.devTables,
        label: cfg.label,
      });
    }
    if (p === '/api/register' && m === 'POST') {
      if (!registrationOpen()) throw new HttpError(403, 'Registration is closed. Ask an admin for an account.');
      const ip = clientIp(req);
      if (!registerLimit.allowed(ip)) throw new HttpError(429, 'Too many sign-ups. Try again later.');
      registerLimit.record(ip);
      const body = await readJson(req);
      return startSession(res, await auth.createUser(db, body.name, body.password), 201);
    }
    if (p === '/api/login' && m === 'POST') {
      const body = await readJson(req);
      const keys = [`ip:${clientIp(req)}`, `name:${String(body.name).toLowerCase()}`];
      if (!keys.every((k) => loginLimit.allowed(k))) {
        throw new HttpError(429, 'Too many failed logins. Try again later.');
      }
      try {
        return startSession(res, await auth.login(db, body.name, body.password), 200);
      } catch (err) {
        if (err instanceof auth.AuthError && err.status === 401) keys.forEach((k) => loginLimit.record(k));
        throw err;
      }
    }
    if (p === '/api/logout' && m === 'POST') {
      auth.deleteSession(db, sessionToken(req));
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieFor('', 0) });
    }
    if (p === '/api/leaderboard' && m === 'GET') {
      // Only games with no computer players count. (A "kind" in the query is ignored: there is one board.)
      const kind = 'human';
      const season = url.searchParams.get('season') || 'current';
      if (!/^(current|all|\d+)$/.test(season)) throw new HttpError(400, 'season must be current, all or a season id.');
      const sort = url.searchParams.get('sort') === 'perGame' ? 'perGame' : 'points';
      return sendJson(res, 200, { kind, sort, ...leaderboard(db, kind, { season, sort, now: cfg.now() }) });
    }
    if (p === '/api/stats' && m === 'GET') {
      const season = url.searchParams.get('season') || 'current';
      if (!/^(current|all|\d+)$/.test(season)) throw new HttpError(400, 'season must be current, all or a season id.');
      return sendJson(res, 200, { kind: 'human', ...luckAndSkill(db, { season, now: cfg.now(), log }) });
    }
    if (p === '/api/seasons' && m === 'GET') return sendJson(res, 200, { seasons: listSeasons(db, cfg.now()) });
    if (p.startsWith('/api/admin/')) return adminApi(req, res, url);

    const user = requireUser(req);
    if (p === '/api/me' && m === 'GET') return sendJson(res, 200, { user });

    // ---- my solo games: only ever my own ----
    if (p === '/api/solo/result' && m === 'POST') {
      const key = `solo:${user.id}`;
      if (!soloLimit.allowed(key)) throw new HttpError(429, 'Too many results. Try again later.');
      soloLimit.record(key);
      const body = await readJson(req);
      recordSolo(db, user.id, body, cfg.now());
      return sendJson(res, 200, soloStats(db, user.id));
    }
    if (p === '/api/solo/stats' && m === 'GET') return sendJson(res, 200, soloStats(db, user.id));

    // ---- my devices and turn alerts ----
    if (p === '/api/push' && m === 'GET') {
      return sendJson(res, 200, { publicKey: pusher.publicKey, devices: publicDevices(db, user.id) });
    }
    if (p === '/api/push/subscribe' && m === 'POST') {
      const body = await readJson(req);
      addSubscription(db, user.id, body.subscription, { label: body.label, now: cfg.now(), extraHosts: pushHosts });
      return sendJson(res, 200, { devices: publicDevices(db, user.id) });
    }
    if (p === '/api/push/unsubscribe' && m === 'POST') {
      const body = await readJson(req);
      if (body.all === true) removeAllSubscriptions(db, user.id);
      else if (typeof body.endpoint === 'string') removeSubscription(db, user.id, body.endpoint);
      else throw new HttpError(400, 'Say which device to turn alerts off for.');
      return sendJson(res, 200, { devices: publicDevices(db, user.id) });
    }
    if (p === '/api/push/test' && m === 'POST') {
      if (!listSubscriptions(db, user.id).length) {
        throw new HttpError(409, 'Turn alerts are not switched on for any of your devices.');
      }
      const key = `pushtest:${user.id}`;
      if (!pushTestLimit.allowed(key)) throw new HttpError(429, 'Too many test alerts. Try again later.');
      pushTestLimit.record(key);
      const r = await pusher.sendToUser(
        user.id,
        { title: 'Big Two', body: 'Test alert: this device is set up for turn alerts.', url: '/', tag: 'test' },
        { topic: 'test' },
      );
      return sendJson(res, 200, { ...r, devices: publicDevices(db, user.id) });
    }
    if (p === '/api/password' && m === 'POST') {
      const body = await readJson(req);
      const key = `pw:${user.id}`;
      if (!loginLimit.allowed(key)) throw new HttpError(429, 'Too many attempts. Try again later.');
      try {
        await auth.changeOwnPassword(db, user.id, body.current, body.next);
      } catch (err) {
        if (err instanceof auth.AuthError && err.status === 401) loginLimit.record(key);
        throw err;
      }
      hub.disconnect(user.id);
      return startSession(res, user, 200); // every old session was revoked; this one is fresh
    }
    if (p === '/api/events' && m === 'GET') return openStream(req, res, user);
    if (p === '/api/game' && m === 'GET') return gameReply(res, user);
    if (p === '/api/game' && m === 'POST') {
      const body = await readJson(req);
      lobby.create(user, body.aiLevel, body.seats);
      return gameReply(res, user, 201);
    }
    const act = /^\/api\/game\/(join|leave|start|move|chat)$/.exec(p);
    if (act && m === 'POST') {
      const verb = act[1];
      if (verb === 'join') lobby.join(user);
      else if (verb === 'leave') lobby.leave(user);
      else if (verb === 'start') lobby.start(user);
      else if (verb === 'move') {
        const body = await readJson(req);
        if (!('cards' in body)) throw new HttpError(400, 'cards is required.');
        lobby.move(user, parseCards(body.cards));
      } else {
        const body = await readJson(req);
        lobby.say(user, body.text);
      }
      return gameReply(res, user);
    }
    throw new HttpError(404, 'Not found.');
  }

  // Only the client files are served; server/, test/, data/ and package.json never are. The game
  // itself (the page and its scripts) goes only to a signed-in user; everyone else gets the sign-in
  // page, which has just what it needs to sign in.
  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    const isGame = pathname === '/' || pathname === '/index.html' || pathname.startsWith('/src/');
    const signedIn = isGame && !!currentUser(req);
    if (isGame && !signedIn) {
      if (pathname.startsWith('/src/')) throw new HttpError(401, 'Please log in.');
      pathname = '/signin.html';
    }
    let rel = null;
    if (pathname === '/' || pathname === '/index.html') rel = 'index.html';
    else if (pathname === '/signin.html') rel = 'signin.html';
    else if (pathname === '/signin.js') rel = 'signin.js';
    else if (pathname === '/styles.css') rel = 'styles.css';
    else if (pathname === '/favicon.svg' || pathname === '/favicon.ico') rel = 'favicon.svg';
    else if (pathname === '/manifest.webmanifest') rel = 'manifest.webmanifest';
    else if (pathname === '/sw.js') rel = 'sw.js';
    else if (/^\/icon-(180|192|512)\.png$/.test(pathname)) rel = pathname.slice(1);
    else if (pathname === '/notify-icon.png') rel = 'notify-icon.png';
    else if (pathname === '/notify-badge.png') rel = 'notify-badge.png';
    else if (/^\/src\/[A-Za-z0-9_/-]+(\.[A-Za-z0-9_-]+)*\.js$/.test(pathname) && !pathname.includes('..')) {
      rel = pathname.slice(1);
    }
    const file = rel && path.resolve(ROOT, rel);
    if (!file || !file.startsWith(ROOT + path.sep)) throw new HttpError(404, 'Not found.');
    if (rel === 'manifest.webmanifest' && cfg.label) {
      // The installed icon carries the label too ("Big Two (Staging)"), so two copies on one phone are told apart.
      return fs.readFile(file, 'utf8', (err, text) => {
        if (err) return sendJson(res, 404, { error: 'Not found.' });
        const m = JSON.parse(text);
        m.name = `${m.name} (${cfg.label})`;
        m.short_name = `${m.short_name} (${cfg.label})`.slice(0, 30);
        const body = JSON.stringify(m);
        res.writeHead(200, { 'Content-Type': TYPES['.webmanifest'], 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : body);
      });
    }
    fs.readFile(file, (err, data) => {
      if (err) return sendJson(res, 404, { error: 'Not found.' });
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
    responses.set(req, res);
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else serveStatic(req, res, url.pathname);
    } catch (err) {
      if (res.headersSent) return res.destroy();
      if (isHttpError(err)) {
        const close = err.status === 413 ? { Connection: 'close' } : {};
        return sendJson(res, err.status, { error: err.message }, close);
      }
      log('Unhandled error', err);
      sendJson(res, 500, { error: 'Internal error.' });
    }
  });

  return {
    server,
    lobby,
    db,
    hub,
    // Stops timers and connections. The live game stays saved, so the next
    // start resumes it; it is NOT cancelled.
    async close() {
      clearInterval(purger);
      notifier.stop();
      lobby.shutdown();
      hub.closeAll();
      pool.close();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
      if (ownsDb) db.close();
    },
  };
}

if (isMain(import.meta.url)) {
  const env = process.env;
  const app = createApp({
    dbFile: env.DB_FILE || path.join(ROOT, 'data', 'big2.db'),
    aiDelayMs: env.AI_DELAY_MS ? Number(env.AI_DELAY_MS) : undefined,
    devTables: env.DEV_TABLES === '1',
    trustProxy: env.TRUST_PROXY === '1',
    secureCookies: env.SECURE_COOKIES === '1',
    publicUrl: env.PUBLIC_URL || '',
    label: env.SITE_LABEL || '',
    ...(env.TABLE_START_DELAY_MS ? { startDelayMs: Number(env.TABLE_START_DELAY_MS) } : {}),
    ...(env.TABLE_NEXT_GAME_DELAY_MS ? { nextGameDelayMs: Number(env.TABLE_NEXT_GAME_DELAY_MS) } : {}),
    notify: {
      ...(env.PUSH_FIRST_AFTER_MS ? { firstAfterMs: Number(env.PUSH_FIRST_AFTER_MS) } : {}),
      ...(env.PUSH_SECOND_AFTER_MS ? { secondAfterMs: Number(env.PUSH_SECOND_AFTER_MS) } : {}),
      ...(env.PUSH_MAX_PER_DAY ? { maxPerDay: Number(env.PUSH_MAX_PER_DAY) } : {}),
    },
  });
  console.log('Turn alerts: push notifications');
  if (!/^https:\/\//.test(env.PUBLIC_URL || '')) {
    console.warn(
      'WARNING: set PUBLIC_URL to the https address of this site; Apple and Google use it to identify the sender.',
    );
  }
  const port = Number(env.PORT || 8765);
  const host = env.HOST || '127.0.0.1';
  app.server.listen(port, host, () => console.log(`Big Two online at http://${host}:${port}`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close().then(() => process.exit(0)));
}

// A season game with the production rules (no development switch): created by an admin, four people, no
// computer players, started only when the table is full, and only while a season is running. The admin is in
// a real browser; the other three players join from the side over the API.
import { launch, newPage, sleep, outDir } from './lib.mjs';
import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';

const OUT = outDir(process.argv[2]);
const PORT = 8774;
const CDP = 9341;
const BASE = `http://127.0.0.1:${PORT}/`;
const PW = 'correct-horse-battery';

const env = await launch({ port: PORT, cdp: CDP, tmpPrefix: 'big2-e2e-sg-' }); // no DEV_TABLES

const results = [];
const check = (label, ok, extra = '') => {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) throw new Error('check failed: ' + label);
};

// A person who is not in a browser: signs in and joins over the API.
async function personJoins(name) {
  const login = await fetch(`${BASE}api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE.slice(0, -1) },
    body: JSON.stringify({ name, password: PW }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const join = await fetch(`${BASE}api/game/join`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: BASE.slice(0, -1) },
    body: '{}',
  });
  if (join.status !== 200) throw new Error(`${name} could not join: ${join.status}`);
}

let A;
async function main() {
  console.log('CLI:', env.makeAdmin('boss', PW).stdout.trim());
  const db = openDb(env.env.DB_FILE);
  for (const [i, name] of ['bob', 'cat', 'dan'].entries()) {
    await createUser(db, name, PW, { phone: `+447700900${700 + i}`, verified: true });
  }
  db.close();
  await env.state.start();
  A = await newPage(CDP, 'A', OUT);
  await A.goto(BASE);
  await A.signIn('boss', PW);

  check(
    'the Players and AI level choices are not offered',
    await A.ev(
      `[...document.querySelectorAll('.dev-only')].length === 2 && [...document.querySelectorAll('.dev-only')].every(e => e.hidden)`,
    ),
  );
  check('the create form says what a season game is', (await A.text('createRow')).includes('4 people'));

  await A.click('createBtn');
  await A.waitFor(`!document.getElementById('waitRoom').hidden`, 8000, 'waiting room');
  const info = await A.text('waitInfo');
  check(
    'the waiting room says it is a season game with no computer players',
    /season game/.test(info) && /no computer players/.test(info),
    info,
  );
  check(
    'the host cannot start with one person at the table',
    await A.ev(`document.getElementById('startBtn').disabled`),
  );
  check(
    'and is told how many more are needed',
    (await A.text('waitMsg')).includes('3 more players'),
    await A.text('waitMsg'),
  );
  const seats = await A.ev(`[...document.querySelectorAll('#waitSeats li')].map(l => l.textContent)`);
  check(
    'empty seats wait for a person; none says a computer will play',
    seats.filter((s) => s.includes('waiting for a player')).length === 3 && !seats.join(' ').includes('AI'),
    seats.join(' | '),
  );
  await A.shot('1-waiting-for-people');

  await personJoins('bob');
  await personJoins('cat');
  await A.waitFor(`document.getElementById('waitMsg').textContent.includes('1 more player ')`, 8000, 'one more needed');
  check(
    'with two more people it still waits for one',
    await A.ev(`document.getElementById('startBtn').disabled`),
    await A.text('waitMsg'),
  );

  await personJoins('dan');
  await A.waitFor(`!document.getElementById('startBtn').disabled`, 8000, 'Start enabled');
  check('with four people the host can start', true);
  await A.shot('2-full-table');
  await A.click('startBtn');
  await A.waitFor(
    `!document.getElementById('tableMain').hidden && document.querySelectorAll('#hand .card').length === 14`,
    10000,
    'the table',
  );
  const names = await A.ev(`[1, 2, 3].map(i => document.getElementById('seat-' + i).textContent)`);
  check(
    'the other three seats are the three people, not computers',
    ['bob', 'cat', 'dan'].every((n) => names.join(' ').includes(n)) && !/bot/i.test(names.join(' ')),
    names.join(' | '),
  );
  await A.shot('3-playing');

  // An admin ends it, and with no season running a new game cannot be created.
  await A.ev(
    `fetch('/api/admin/game/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(r => r.status)`,
  );
  await sleep(500);
  await A.ev(
    `fetch('/api/admin/seasons/1/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(r => r.status)`,
  );
  await A.goto(BASE);
  await A.waitFor(
    `!document.getElementById('lobbyHome').hidden && !document.getElementById('createRow').hidden`,
    10000,
    'lobby with the create row',
  );
  await A.click('createBtn');
  await A.waitFor(
    `document.getElementById('lobbyMsg').textContent.includes('No season is running')`,
    8000,
    'the no-season message',
  );
  check('with no season running a game cannot be created, and the admin is told why', true, await A.text('lobbyMsg'));
  await A.shot('4-no-season');
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  console.log('FAILED:', err.message);
  try {
    if (A) await A.shot('failure');
  } catch {
    /* ignore */
  }
}
if (A) console.log(`browser errors [${A.name}]:`, A.errors.length ? [...new Set(A.errors)] : 'none');
console.log(`${results.filter((r) => r.ok).length} checks passed${failed ? ', then FAILED' : ''}`);
await env.cleanup();
process.exit(failed ? 1 : 0);

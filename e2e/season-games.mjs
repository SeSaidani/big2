// A season game with the production rules (no development switch): there is always a table while a season is
// running, nobody creates or starts a game, four people seated start one by themselves, and ending the season
// closes the table. The admin is in a real browser; the other three players join from the side over the API.
import { launch, newPage, sleep, outDir } from './lib.mjs';
import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';

const OUT = outDir(process.argv[2]);
const PORT = 8774;
const CDP = 9341;
const BASE = `http://127.0.0.1:${PORT}/`;
const PW = 'correct-horse-battery';

// No DEV_TABLES. A few seconds of countdown so there is time to see it.
const env = await launch({
  port: PORT,
  cdp: CDP,
  tmpPrefix: 'big2-e2e-sg-',
  extraEnv: { TABLE_START_DELAY_MS: '4000', TABLE_NEXT_GAME_DELAY_MS: '4000' },
});

const results = [];
const check = (label, ok, extra = '') => {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) throw new Error('check failed: ' + label);
};

// A person who is not in a browser: signs in and takes a seat over the API.
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
const byId = (id) => `document.getElementById(${JSON.stringify(id)})`;
async function main() {
  console.log('CLI:', env.makeAdmin('boss', PW).stdout.trim());
  const db = openDb(env.env.DB_FILE);
  for (const name of ['bob', 'cat', 'dan']) await createUser(db, name, PW);
  db.close();
  await env.state.start();
  A = await newPage(CDP, 'A', OUT);
  await A.goto(BASE);
  await A.signIn('boss', PW);

  // ---- nobody creates a game ----
  check('there is no Create game button: the admin does not make games', await A.ev(`${byId('createRow')}.hidden`));
  const facts = await A.text('gameBox');
  check(
    'the lobby shows the table, waiting for players, with no host',
    facts.includes('Waiting for players') && facts.includes('0 of 4') && !facts.includes('Host'),
    facts.replace(/\s+/g, ' ').slice(0, 120),
  );
  check(
    'and a Take a seat button',
    await A.ev(`[...document.querySelectorAll('#gameBox button')].some((b) => b.textContent === 'Take a seat')`),
  );
  await A.shot('1-lobby-table');

  await A.clickButton('#gameBox', 'Take a seat');
  await A.waitFor(`!${byId('waitRoom')}.hidden`, 8000, 'waiting room');
  const info = (await A.text('waitInfo')).replace(/\s+/g, ' ');
  check(
    'the waiting room says the game starts by itself, with no computer players',
    /by itself/.test(info) && /no computer players/.test(info),
    info,
  );
  check('there is no Start button', await A.ev(`${byId('startBtn')}.hidden`));
  check('and it says how many more are needed', (await A.text('waitMsg')).includes('3 more players'));
  const seats = await A.ev(`[...document.querySelectorAll('#waitSeats li')].map(l => l.textContent)`);
  check(
    'empty seats wait for a person; none says a computer will play',
    seats.filter((s) => s.includes('waiting for a player')).length === 3 && !seats.join(' ').includes('AI'),
    seats.join(' | '),
  );
  await A.shot('2-waiting-for-people');

  await personJoins('bob');
  await personJoins('cat');
  await A.waitFor(`${byId('waitMsg')}.textContent.includes('1 more player')`, 8000, 'one more needed');
  check('with three people there is no countdown yet', (await A.text('waitCount')) === '');

  await personJoins('dan');
  await A.waitFor(`${byId('waitCount')}.textContent.includes('The game starts in')`, 8000, 'the countdown');
  check('the fourth person starts a countdown on screen', true, await A.text('waitCount'));
  await A.shot('3-countdown');

  // ---- and then it starts, without anyone pressing anything ----
  await A.waitFor(
    `!${byId('tableMain')}.hidden && document.querySelectorAll('#hand .card').length === 14`,
    15000,
    'the game starting by itself',
  );
  check('the game started by itself and the cards were dealt', true);
  const names = await A.ev(`[1, 2, 3].map(i => document.getElementById('seat-' + i).textContent)`);
  check(
    'the other three seats are the three people, not computers',
    ['bob', 'cat', 'dan'].every((n) => names.join(' ').includes(n)) && !/bot/i.test(names.join(' ')),
    names.join(' | '),
  );
  await A.shot('4-playing');

  // ---- the admin can look at the game as a player ----
  await A.click('who');
  check(
    'an admin sees the Admin button and a switch to the player view',
    (await A.ev(`!${byId('adminBtn')}.hidden && !${byId('viewBtn')}.hidden`)) &&
      (await A.text('viewBtn')) === 'Switch to player view',
  );
  await A.click('viewBtn');
  check(
    'in the player view the Admin button is gone, and the switch offers the way back',
    (await A.ev(`${byId('adminBtn')}.hidden`)) && (await A.text('viewBtn')) === 'Switch to admin view',
  );
  await A.click('who');
  await A.click('viewBtn');
  check('and switching back brings it back', await A.ev(`!${byId('adminBtn')}.hidden`));

  // ---- ending the season stops the game and closes the table ----
  await A.ev(
    `fetch('/api/seasons').then(r => r.json()).then(j => fetch('/api/admin/seasons/' + j.seasons[0].id + '/end', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).then(r => r.status)`,
  );
  await A.waitFor(
    `!${byId('lobbyHome')}.hidden && ${byId('gameBox')}.textContent.includes('No season is running')`,
    10000,
    'the lobby saying there is no season',
  );
  check('ending the season stops the game and the lobby says no season is running', true, await A.text('gameBox'));
  await A.click('who');
  await A.click('viewBtn');
  await A.waitFor(`${byId('gameBox')}.textContent.includes('There is no table right now')`, 5000, 'the player wording');
  check('in the player view it says so without pointing at Admin', true, await A.text('gameBox'));
  await A.shot('5-no-season');
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
await sleep(100);
await env.cleanup();
process.exit(failed ? 1 : 0);

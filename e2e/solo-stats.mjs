// My solo stats, end to end in a real browser: nothing about the record at the top of the game any more, a real solo
// game played to the end appears in the right rows, a result that could not be sent is sent next time, and another
// person signing in on the same browser sees none of it.
import { launch, newPage, sleep, outDir, STEP } from './lib.mjs';
import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';

const OUT = outDir(process.argv[2]);
const PORT = 8776;
const CDP = 9343;
const BASE = `http://127.0.0.1:${PORT}/`;
const PW = 'correct-horse-battery';

const env = await launch({ port: PORT, cdp: CDP, tmpPrefix: 'big2-e2e-solo-' });
const results = [];
const check = (label, ok, extra = '') => {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) throw new Error('check failed: ' + label);
};

let A;
const byId = (id) => `document.getElementById(${JSON.stringify(id)})`;
const openStats = async () => {
  await A.click('who');
  await A.click('soloStatsBtn');
  await A.waitFor(`${byId('soloStatsDlg')}.open && ${byId('soloStatsBody')}.children.length > 0`, 8000, 'stats dialog');
};
const closeStats = () => A.ev(`${byId('soloStatsDlg')}.close()`);
// The table as rows of text, e.g. ["4 players", "Easy|0|0|-|-|-", ...]
const tableRows = () =>
  A.ev(
    `[...document.querySelectorAll('#soloStatsBody tr')].map((r) => [...r.children].map((c) => c.textContent).join('|'))`,
  );
const rowStarting = async (label) => (await tableRows()).find((r) => r.startsWith(label + '|'));

async function main() {
  console.log('CLI:', env.makeAdmin('boss', PW).stdout.trim());
  const db = openDb(env.env.DB_FILE);
  await createUser(db, 'cat', PW);
  db.close();
  await env.state.start();
  A = await newPage(CDP, 'A', OUT);
  await A.goto(BASE);
  await A.signIn('boss', PW);
  await A.ev(`localStorage.setItem('big2.mode', 'solo')`);
  await A.goto(BASE);
  await A.waitFor(`${byId('soloChip')}.textContent.includes('players')`, 10000, 'solo table');

  // ---- nothing about the record at the top of the game ----
  check(
    'the "You\'ve won n of m" record is gone from the top of the game',
    await A.ev(`${byId('record')} === null && !document.querySelector('.topbar').textContent.includes("You've won")`),
  );

  // ---- an empty table ----
  await openStats();
  const empty = await tableRows();
  check(
    'the table has a four-player block, a three-player block, a by-level block and an overall row at the bottom',
    empty[0] === '4 players' &&
      empty.includes('3 players') &&
      empty.includes('By level, both table sizes together') &&
      empty[empty.length - 1].startsWith('Overall|'),
    empty.length + ' rows',
  );
  check(
    'each size has Easy, Medium, Hard and its own total',
    ['All 4-player games', 'All 3-player games'].every((l) => empty.some((r) => r.startsWith(l + '|'))) &&
      empty.filter((r) => r.startsWith('Easy|')).length === 3,
  );
  check(
    'with no games it says so, and the rows are empty',
    (await A.text('soloStatsEmpty')).includes('No solo games yet'),
  );
  await A.shot('1-empty');
  await closeStats();

  // ---- play a real solo game: 3 players, Easy ----
  await A.click('newBtn');
  await A.ev(`${byId('ngPlayers')}.value = '3'; ${byId('ngLevel')}.value = 'easy'`);
  await A.click('ngStart');
  await A.waitFor(
    `${byId('soloChip')}.textContent.includes('3 players') && ${byId('soloChip')}.textContent.includes('Easy')`,
    5000,
    'chip',
  );
  const t0 = Date.now();
  for (;;) {
    const what = await A.ev(STEP);
    if (what === 'over') break;
    if (Date.now() - t0 > 240000) throw new Error('the solo game did not finish in time');
    await sleep(what === 'wait' ? 250 : 120);
  }
  const title = await A.text('endTitle');
  const iWon = title.includes('You win');
  check('a real solo game ran to the end', true, title);
  await A.shot('2-win-screen');
  check(
    'the win screen does not carry My solo stats: they are in the account menu',
    await A.ev(`!document.getElementById('endStats')`),
  );
  await A.click('who');
  await A.click('soloStatsBtn');
  await A.waitFor(
    `${byId('soloStatsDlg')}.open && ${byId('soloStatsBody')}.textContent.includes('Overall')`,
    8000,
    'stats from the account menu',
  );

  // The round is in exactly the right rows.
  await A.waitFor(
    `document.querySelector('#soloStatsBody tr.total:last-child td:nth-child(2)').textContent === '1'`,
    8000,
    'the game in Overall',
  );
  const easy3 = (await tableRows()).filter((r) => r.startsWith('Easy|'))[1]; // the second Easy row is the three-player block
  const all3 = await rowStarting('All 3-player games');
  const overall = await rowStarting('Overall');
  const [, g, w, pct, pts] = overall.split('|');
  check('it counts as one game in Easy, three players', easy3.split('|')[1] === '1', easy3);
  check(
    'and in the three-player total and the overall row',
    all3.split('|')[1] === '1' && g === '1',
    `${all3}  ${overall}`,
  );
  check('the four-player block is untouched', (await rowStarting('All 4-player games')).split('|')[1] === '0');
  check(
    'the win or loss matches the win screen',
    w === (iWon ? '1' : '0') && pct === (iWon ? '100%' : '0%'),
    `${title}: ${overall}`,
  );
  check('and the points have the right sign', iWon ? pts.startsWith('+') : pts.startsWith('−'), pts);
  await A.shot('3-one-game');
  await closeStats();

  // ---- a result that could not be sent is sent next time ----
  const me = await A.ev(`fetch('/api/me').then((r) => r.json()).then((j) => j.user.id)`);
  await A.ev(
    `localStorage.setItem('big2.soloQueue.${me}', JSON.stringify([{ clientId: 'offline-game-0001', level: 'hard', players: 4, won: true, delta: 36 }, { clientId: 'offline-game-0002', level: 'hard', players: 4, won: false, delta: -9 }]))`,
  );
  await A.goto(BASE);
  await A.waitFor(`${byId('soloChip')}.textContent.includes('players')`, 10000, 'reload');
  await A.waitFor(`localStorage.getItem('big2.soloQueue.${me}') === '[]'`, 8000, 'the waiting results being sent');
  await openStats();
  const hard4 = (await tableRows()).filter((r) => r.startsWith('Hard|'))[0];
  check(
    'two results kept in the browser were sent when it next connected',
    hard4.startsWith('Hard|2|1|50%|+27'),
    hard4,
  );
  check('and the overall row is now three games', (await rowStarting('Overall')).split('|')[1] === '3');
  await closeStats();
  await A.ev(
    `localStorage.setItem('big2.soloQueue.${me}', JSON.stringify([{ clientId: 'offline-game-0001', level: 'hard', players: 4, won: true, delta: 36 }]))`,
  );
  await A.goto(BASE);
  await A.waitFor(`localStorage.getItem('big2.soloQueue.${me}') === '[]'`, 8000, 'the repeat being cleared');
  await openStats();
  check('sending a result again changes nothing', (await rowStarting('Overall')).split('|')[1] === '3');
  await closeStats();

  // ---- someone else on the same browser sees none of it ----
  await A.click('who');
  await A.click('logoutBtn');
  await A.signIn('cat', PW);
  await A.ev(`localStorage.setItem('big2.mode', 'solo')`);
  await A.goto(BASE);
  await A.waitFor(`${byId('soloChip')}.textContent.includes('players')`, 10000, 'cat in solo');
  await openStats();
  check(
    "another person's table starts empty: they cannot see boss's games",
    (await rowStarting('Overall')).split('|')[1] === '0',
  );
  await A.shot('4-someone-else');
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

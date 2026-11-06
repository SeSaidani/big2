// A table of three in a real browser: a solo game, then an online game with two computer seats.
import { launch, newPage, sleep, STEP, outDir } from './lib.mjs';

const OUT = outDir(process.argv[2]);
const PORT = 8770;
const CDP = 9337;
const BASE = `http://127.0.0.1:${PORT}/`;
const ADMIN_PW = 'admin-password-123';

const env = await launch({ port: PORT, cdp: CDP, tmpPrefix: 'big2-e2e3-', extraEnv: { DEV_TABLES: '1' } });
console.log('CLI:', env.makeAdmin('boss', ADMIN_PW).stdout.trim());

const results = [];
const check = (label, ok, extra = '') => {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) throw new Error('check failed: ' + label);
};

// Plays the lowest legal single (or passes) until the result panel shows.
async function playOut(page) {
  const t0 = Date.now();
  for (;;) {
    const r = await page.ev(STEP);
    if (r === 'over') return;
    if (r === 'stuck') throw new Error(`[${page.name}] stuck: ` + (await page.text('status')));
    if (Date.now() - t0 > 240000) throw new Error(`[${page.name}] round did not finish`);
    await sleep(70);
  }
}

const handSize = (p) => p.ev(`document.querySelectorAll('#hand .card').length`);

let A;
async function main() {
  await env.state.start();
  A = await newPage(CDP, 'A', OUT);
  await A.goto(BASE);
  await A.signIn('boss', ADMIN_PW);

  // --- solo, three players ---
  await A.waitFor(`!!document.getElementById('modeSolo')`, 8000, 'mode buttons');
  await A.click('modeSolo');
  check(
    'the header has no settings to change mid-game',
    (await A.ev(`document.querySelectorAll('.topbar select').length`)) === 0,
  );
  // The settings are chosen in the New game dialog.
  await A.click('newBtn');
  await A.waitFor(`document.getElementById('newGameDlg').open`, 4000, 'the New game dialog');
  await A.ev(`document.getElementById('ngPlayers').value = '3'; document.getElementById('ngLevel').value = 'easy'`);
  await A.click('ngStart');
  check(
    'the dialog closes and the chip shows the settings',
    (await A.text('soloChip')) === '3 players · Easy',
    await A.text('soloChip'),
  );
  await A.waitFor(`document.querySelectorAll('#hand .card').length >= 18`, 8000, 'a hand of 18 or more');
  const n = await handSize(A);
  check('a solo hand at a table of three has 18-20 cards', n >= 18 && n <= 20, `${n} cards`);
  check('the empty North seat is hidden', await A.ev(`document.getElementById('seat-2').hidden`));
  check(
    'the other two seats are shown',
    await A.ev(`!document.getElementById('seat-1').hidden && !document.getElementById('seat-3').hidden`),
  );
  // On a phone a hand of 18-20 cards must still sit inside the screen (the fan used to run off the edge).
  await A.phone(390, 844);
  await sleep(300);
  const box = await A.ev(
    `(() => { const r = [...document.getElementById('hand').children].map((c) => c.getBoundingClientRect()); return { left: Math.min(...r.map((x) => x.left)), right: Math.max(...r.map((x) => x.right)), vw: innerWidth }; })()`,
  );
  check('on a phone the whole hand is inside the screen', box.left >= 0 && box.right <= box.vw, JSON.stringify(box));
  await A.shot('1b-phone-three');
  await A.desktop();
  await sleep(300);
  // Once the opening play is made, starting another game warns, and cancelling changes nothing.
  for (let i = 0; i < 80 && !['play', 'pass'].includes(await A.ev(STEP)); i++) await sleep(100);
  const cardsBefore = await A.ev(`[...document.querySelectorAll('#hand .card')].map((c) => c.dataset.id).join()`);
  await A.click('newBtn');
  await A.waitFor(`document.getElementById('newGameDlg').open`, 4000, 'the New game dialog mid-game');
  check('mid-game the dialog warns it replaces the game', await A.visible('ngWarn'));
  await A.click('ngCancel');
  const cardsAfter = await A.ev(`[...document.querySelectorAll('#hand .card')].map((c) => c.dataset.id).join()`);
  check(
    'cancelling leaves the game as it was',
    !(await A.ev(`document.getElementById('newGameDlg').open`)) &&
      cardsAfter.length > 0 &&
      cardsAfter.split(',').every((id) => cardsBefore.split(',').includes(id)),
  );
  await A.shot('1-solo-three');
  await playOut(A);
  const soloRows = await A.ev(`document.querySelectorAll('#endHands .end-row').length`);
  check('the solo result lists the two losing hands', soloRows === 2, `${soloRows} rows`);
  await A.shot('2-solo-result');

  // --- online, three seats, two computer seats ---
  await A.click('modeOnline');
  await A.waitFor(`!document.getElementById('createRow').hidden`, 10000, 'create row');
  await A.ev(
    `document.getElementById('newSeats').value = '3'; document.getElementById('newLevel').value = 'easy'; document.getElementById('createBtn').click()`,
  );
  await A.waitFor(`!document.getElementById('waitRoom').hidden`, 8000, 'waiting room');
  const seatsListed = await A.ev(`document.querySelectorAll('#waitSeats li').length`);
  check('the waiting room lists three seats', seatsListed === 3, `${seatsListed} seats`);
  await A.click('startBtn');
  await A.waitFor(
    `!document.getElementById('tableMain').hidden && document.querySelectorAll('#hand .card').length >= 18`,
    10000,
    'at the online table',
  );
  const m = await handSize(A);
  check('an online hand at a table of three has 18-20 cards', m >= 18 && m <= 20, `${m} cards`);
  check('the online table hides the empty North seat', await A.ev(`document.getElementById('seat-2').hidden`));
  await A.shot('3-online-three');
  await playOut(A);
  await A.waitFor(`!document.getElementById('overlay').hidden`, 10000, 'result panel');
  const rows = await A.ev(
    `[...document.querySelectorAll('#endHands .end-row')].map(r => [r.querySelector('.who').textContent, Number(r.querySelector('.pts').textContent.replace('−','-'))])`,
  );
  check('the online result has three rows', rows.length === 3, JSON.stringify(rows));
  check('the points add up to zero', rows.reduce((s, r) => s + r[1], 0) === 0);
  await A.shot('4-online-result');
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
console.log(
  'server output:',
  env.state.out
    .replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n?/g, '')
    .replace(/\(Use `node[^\n]*\n?/g, '')
    .trim() || '(quiet)',
);
console.log(`${results.filter((r) => r.ok).length} checks passed${failed ? ', then FAILED' : ''}`);
await env.cleanup();
process.exit(failed ? 1 : 0);

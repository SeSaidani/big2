// A solo game survives going to the online screen and back, and a page reload: the same cards, the same log, the
// computer carries on, and a finished game still shows its result. A new game still deals new cards.
import { launch, newPage, sleep, outDir, STEP } from './lib.mjs';

const OUT = outDir(process.argv[2]);
const PORT = 8779;
const CDP = 9346;
const BASE = `http://127.0.0.1:${PORT}/`;
const PW = 'admin-password-123';

const env = await launch({ port: PORT, cdp: CDP, tmpPrefix: 'big2-e2e-ss-' });
const results = [];
const check = (label, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) throw new Error('check failed: ' + label);
};

let A;
const byId = (id) => `document.getElementById(${JSON.stringify(id)})`;
const handIds = () =>
  A.ev(`[...document.querySelectorAll('#hand .card')].map((c) => c.dataset.id).sort((a, b) => a - b).join(',')`);
const logLines = () => A.ev(`[...document.querySelectorAll('#log li')].map((l) => l.textContent).join(' / ')`);
const inSolo = `document.body.classList.contains('solo') && document.querySelectorAll('#hand .card').length > 0`;

// Online and back to Solo, the way a person does it with the two buttons at the top.
async function flick() {
  await A.click('modeOnline');
  await A.waitFor(`document.body.classList.contains('online') && !${byId('lobbyHome')}.hidden`, 8000, 'the lobby');
  await A.click('modeSolo');
  await A.waitFor(inSolo, 8000, 'the solo table again');
}

async function main() {
  console.log('CLI:', env.makeAdmin('boss', PW).stdout.trim());
  await env.state.start();
  A = await newPage(CDP, 'A', OUT);
  await A.goto(BASE);
  await A.signIn('boss', PW);
  await A.click('modeSolo');
  await A.waitFor(inSolo, 8000, 'a solo game');

  // ---- the same game after a trip to the online screen ----
  const hand1 = await handIds();
  const chip1 = await A.text('soloChip');
  const log1 = await logLines();
  await flick();
  check('the same cards come back after going online and returning', (await handIds()) === hand1, hand1);
  check('with the same settings and the same log', (await A.text('soloChip')) === chip1 && (await logLines()) === log1);

  // ---- ...and after some play, with the computer to move ----
  let played = 0;
  const t0 = Date.now();
  while (played < 2 && Date.now() - t0 < 60000) {
    const what = await A.ev(STEP);
    if (what === 'play' || what === 'pass') played++;
    await sleep(what === 'wait' ? 200 : 120);
  }
  check('made two moves in the game', played === 2);
  const hand2 = await handIds();
  const log2 = await logLines();
  await flick(); // straight away: the computer may be mid-move
  check(
    'after play, the hand and the log are as they were',
    (await handIds()) === hand2 && (await logLines()) === log2,
  );
  const lines = await A.ev(`document.querySelectorAll('#log li').length`);
  await A.waitFor(
    `${byId('hand')}.classList.contains('disabled') === false || document.querySelectorAll('#log li').length > ${lines}`,
    20000,
    'the game carrying on',
  );
  check('and the game carries on from there', true);

  // ---- a reload ----
  await sleep(1500);
  const hand3 = await handIds();
  const log3 = await logLines();
  await A.goto(BASE);
  await A.waitFor(inSolo, 15000, 'solo after a reload');
  check('a reload brings the same cards back', (await handIds()) === hand3, hand3);
  check(
    'and the same log (plus anything the computer played meanwhile)',
    (await logLines()).endsWith(log3) || (await logLines()) === log3,
  );

  // ---- New game still deals new cards ----
  await A.click('newBtn');
  await A.click('ngStart');
  await A.waitFor(`!${byId('newGameDlg')}.open`, 5000, 'the dialog closing');
  await sleep(500);
  check('New game deals a different hand', (await handIds()) !== hand3);
  await A.shot('1-new-game');

  // ---- a finished game still shows its result ----
  await A.click('newBtn');
  await A.ev(`${byId('ngPlayers')}.value = '3'; ${byId('ngLevel')}.value = 'easy'`);
  await A.click('ngStart');
  await A.waitFor(
    `${byId('soloChip')}.textContent.includes('3 players') && ${byId('soloChip')}.textContent.includes('Easy')`,
    5000,
    'chip',
  );
  const t1 = Date.now();
  for (;;) {
    const what = await A.ev(STEP);
    if (what === 'over') break;
    if (Date.now() - t1 > 240000) throw new Error('the solo game did not finish in time');
    await sleep(what === 'wait' ? 250 : 120);
  }
  const title = await A.text('endTitle');
  const rows = await A.ev(`document.querySelectorAll('#endHands .end-row').length`);
  await flick();
  check(
    'after the game ends, going online and back still shows the result',
    !(await A.ev(`${byId('overlay')}.hidden`)) && (await A.text('endTitle')) === title,
    title,
  );
  await A.click('endClose');
  await A.goto(BASE);
  await A.waitFor(
    `document.body.classList.contains('solo') && !${byId('tableMain')}.hidden`,
    15000,
    'solo after a reload',
  );
  check(
    'a reload with the result closed keeps it closed, on the same finished game',
    await A.ev(`${byId('overlay')}.hidden`),
  );
  check('and the result had the other players left holding cards', rows === 2, `${rows} rows`);
  await A.click('againBtn');
  await sleep(500);
  check(
    'Play again deals a new game and clears the result',
    await A.ev(`${byId('overlay')}.hidden && document.querySelectorAll('#hand .card').length > 0`),
  );
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
console.log(`${results.length} checks passed${failed ? ', then FAILED' : ''}`);
await sleep(100);
await env.cleanup();
process.exit(failed ? 1 : 0);

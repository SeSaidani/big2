// Seasons admin UI, cumulative totals over two real games, and a phone-sized touch session.
import { openDb, recordGame } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { launch, newPage, sleep, HELPERS, outDir } from './lib.mjs';

const OUT = outDir(process.argv[2]);
const PORT = 8768;
const CDP = 9335;
const BASE = `http://127.0.0.1:${PORT}/`;
const PW = 'admin-password-123';
const results = [];
const check = (label, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) throw new Error('check failed: ' + label);
};

const env = await launch({ port: PORT, cdp: CDP, tmpPrefix: 'big2-e2e3-', extraEnv: { DEV_TABLES: '1' } });
// Games are seeded before the server starts. Only games with no computer players count, so these are human
// games (boss wins 30, then loses 12: 18 in total), plus one game with computers that must not count (boss +50).
async function seedGames() {
  const db = openDb(env.env.DB_FILE);
  const boss = db.prepare("SELECT id FROM users WHERE name = 'boss'").get().id;
  const others = [];
  for (const name of ['bob', 'cat', 'dan']) {
    others.push((await createUser(db, name, PW)).id);
  }
  const t = Date.now() - 10 * 60 * 1000;
  db.prepare('UPDATE seasons SET starts = ?').run(t - 1000); // Season 1 began just now; the games are a little older
  const human = (k, deltas) =>
    recordGame(db, {
      started: t + k * 1000,
      ended: t + k * 1000 + 500,
      hasAi: false,
      multiplier: 1,
      seats: [boss, ...others].map((id, i) => ({ userId: id, cardsLeft: deltas[i] > 0 ? 0 : 5, delta: deltas[i] })),
    });
  human(1, [30, -10, -10, -10]);
  human(2, [-12, 4, 4, 4]);
  recordGame(db, {
    started: t + 3000,
    ended: t + 3500,
    hasAi: true,
    multiplier: 1,
    seats: [
      { userId: boss, cardsLeft: 0, delta: 50 },
      { userId: null, cardsLeft: 5, delta: -20 },
      { userId: null, cardsLeft: 5, delta: -20 },
      { userId: null, cardsLeft: 5, delta: -10 },
    ],
  });
  db.close();
}

let P;

async function main() {
  console.log('CLI:', env.makeAdmin('boss', PW).stdout.trim());
  await seedGames();
  await env.state.start();
  P = await newPage(CDP, 'P', OUT);
  await P.goto(BASE);
  await P.signIn('boss', PW);

  // ---------- seasons admin ----------
  await P.click('adminBtn');
  await P.waitFor(`document.querySelectorAll('#seasonsBody tr').length === 1`, 8000, 'one automatic season');
  check(
    'there is an automatic open-ended Season 1',
    (await P.ev(`document.querySelector('#seasonsBody tr').textContent`)).includes('Season 1') &&
      (await P.ev(`document.querySelector('#seasonsBody tr').textContent`)).includes('open-ended'),
  );

  const localIn = (ms) =>
    `(() => { const d = new Date(${ms}); const p = n => String(n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes()); })()`;
  const now = Date.now();
  const end1 = now + 3 * 3600e3;
  // Edit Season 1: give it an end three hours from now (its start is left exactly as stored).
  await P.clickButton('#seasonsBody', 'Edit');
  await P.ev(`document.getElementById('seasonEnd').value = ${localIn(end1)}`);
  await P.click('seasonSave');
  await P.waitFor(`document.getElementById('seasonMsg').textContent === 'Season updated.'`, 8000, 'season updated');
  // Season 2 starts exactly when Season 1 ends.
  await P.ev(
    `document.getElementById('seasonName').value='Season 2'; document.getElementById('seasonStart').value=${localIn(end1)}; document.getElementById('seasonEnd').value=${localIn(end1 + 30 * 86400e3)}; document.getElementById('seasonSave').click()`,
  );
  await P.waitFor(`document.getElementById('seasonMsg').textContent === 'Season created.'`, 8000, 'season created');
  // An overlapping season is refused, with the reason shown.
  await P.ev(
    `document.getElementById('seasonName').value='Clash'; document.getElementById('seasonStart').value=${localIn(now)}; document.getElementById('seasonEnd').value=''; document.getElementById('seasonSave').click()`,
  );
  await P.waitFor(`document.getElementById('seasonMsg').textContent.includes('overlap')`, 8000, 'overlap error');
  check('overlapping seasons are refused with a clear message', true, await P.text('seasonMsg'));
  const seasonRows = await P.ev(
    `[...document.querySelectorAll('#seasonsBody tr')].map(r => [...r.children].slice(0, 4).map(c => c.textContent).join(' | '))`,
  );
  check(
    'Season 1 now has an end and Season 2 follows it',
    seasonRows.length === 2 && !seasonRows.join(' ').includes('open-ended') && seasonRows[0].startsWith('Season 2'),
    seasonRows.join('  //  '),
  );
  await P.shot('1-seasons-admin');

  // ---------- cumulative totals over the seeded human games ----------
  await P.click('adminBtn'); // back to the lobby
  await P.waitFor(`!document.getElementById('lobbyHome').hidden`, 8000, 'lobby');
  check(
    'there is no computer-players board to pick',
    await P.ev(`!document.getElementById('lbAi') && !document.getElementById('lbHuman')`),
  );
  const g1 = 30;
  const g2 = -12;
  await P.waitFor(
    `document.querySelector('#lbBody td:nth-child(2)') && document.querySelector('#lbBody td:nth-child(2)').textContent === 'boss'`,
    8000,
    'leaderboard row',
  );
  const row = await P.ev(`[...document.querySelector('#lbBody tr').children].map(c => c.textContent)`);
  check(
    'the season board shows the running total across both human games, and not the game with computers (+50)',
    row[2] === '2' && Number(row[5]) === g1 + g2,
    JSON.stringify(row),
  );
  check(
    'win % and per-game are shown beside the total',
    row[4] === '50%' && Math.abs(Number(row[6]) - (g1 + g2) / 2) < 0.01,
    JSON.stringify(row),
  );

  await P.ev(
    `(() => { const s = document.getElementById('lbSeason'); s.value = 'all'; s.dispatchEvent(new Event('change')); })()`,
  );
  await P.waitFor(`document.getElementById('lbSeasonInfo').textContent.startsWith('All-time')`, 8000, 'all-time view');
  const allRow = await P.ev(`[...document.querySelector('#lbBody tr').children].map(c => c.textContent)`);
  check('All-time shows the same total', Number(allRow[5]) === g1 + g2 && allRow[2] === '2');
  const opts = await P.ev(`[...document.getElementById('lbSeason').options].map(o => o.textContent)`);
  check(
    'the season picker lists current, each season and all-time',
    opts.length === 4 && opts[0].startsWith('Current season (Season 1)') && opts[3] === 'All-time',
    opts.join(' | '),
  );
  // Season 2 has not started: nothing in it.
  await P.ev(
    `(() => { const s = document.getElementById('lbSeason'); s.value = [...s.options].find(o => o.textContent.startsWith('Season 2')).value; s.dispatchEvent(new Event('change')); })()`,
  );
  await P.waitFor(`document.getElementById('lbBody').textContent.includes('No games yet')`, 8000, 'empty season');
  check('a season with no games is empty', true, await P.text('lbSeasonInfo'));
  await P.click('lbSort');
  await P.waitFor(`document.getElementById('lbSort').textContent.includes('per game')`, 5000, 'sort toggled');
  check('the ranking can switch to points per game', true);
  await P.ev(
    `(() => { const s = document.getElementById('lbSeason'); s.value = 'current'; s.dispatchEvent(new Event('change')); })()`,
  );
  await P.shot('2-leaderboard-desktop');

  // ---------- phone: touch ----------
  await P.click('adminBtn');
  await P.click('adminBtn');
  await P.waitFor(`!document.getElementById('createRow').hidden`, 8000, 'create row');
  await P.phone(390, 844);
  await sleep(300);
  await P.shot('3-phone-lobby');
  // The round buttons stay round on a phone (the 44px touch height used to stretch them into ovals).
  const round = (id) =>
    P.ev(
      `(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; })()`,
    );
  const help = await round('helpBtn');
  check('on a phone the ? button is a circle, at least 44px', help.w === help.h && help.w >= 44, JSON.stringify(help));
  await P.click('helpBtn');
  await P.waitFor(`document.getElementById('helpDlg').open`, 3000, 'help dialog');
  const x = await round('helpX');
  check('and so is the × that closes a dialog', x.w === x.h && x.w >= 44, JSON.stringify(x));
  await P.ev(`document.getElementById('helpDlg').close()`);
  check('the top bar still fits the phone width', await P.ev(`document.documentElement.scrollWidth <= innerWidth + 1`));
  await P.ev(`document.getElementById('newLevel').value='easy'; document.getElementById('createBtn').click()`);
  await P.waitFor(`!document.getElementById('waitRoom').hidden`, 8000, 'waiting room (phone)');
  await P.click('startBtn');
  await P.waitFor(
    `!document.getElementById('tableMain').hidden && document.querySelectorAll('#hand .card').length === 14`,
    10000,
    'phone game',
  );
  await P.waitFor(`!document.getElementById('hand').classList.contains('disabled')`, 20000, 'my turn on the phone');
  await sleep(500);

  const geom = await P.ev(`(() => { ${HELPERS}
    const cards = [...$('hand').children];
    const rects = cards.map(c => c.getBoundingClientRect());
    const slices = cards.map((_, i) => slice(i));
    return {
      n: cards.length,
      slices: slices.map(s => s && Math.round(s.width)),
      minLeft: Math.min(...rects.map(r => r.left)), maxRight: Math.max(...rects.map(r => r.right)),
      vw: innerWidth, scrollW: document.documentElement.scrollWidth,
      vh: innerHeight, scrollH: document.documentElement.scrollHeight,
      tableBottom: $('tableMain').getBoundingClientRect().bottom, cardBottom: Math.max(...rects.map(r => r.bottom)),
    };
  })()`);
  console.log('phone hand geometry:', JSON.stringify(geom));
  check(
    'all 14 cards fit inside the phone screen',
    geom.n === 14 && geom.minLeft >= -1 && geom.maxRight <= geom.vw + 1,
    `left ${geom.minLeft.toFixed(0)}..right ${geom.maxRight.toFixed(0)} of ${geom.vw}`,
  );
  check(
    'on a tall phone the table fills the screen without scrolling',
    geom.tableBottom >= geom.vh - 24 && geom.scrollH <= geom.vh + 1,
    `table ends ${geom.tableBottom.toFixed(0)} of ${geom.vh}, page ${geom.scrollH}`,
  );
  check('no sideways scrolling on the phone', geom.scrollW <= geom.vw + 1, `${geom.scrollW} <= ${geom.vw}`);
  check(
    'every card has a tappable slice of at least 18px',
    geom.slices.every((w) => w !== null && w >= 18),
    geom.slices.join(','),
  );
  check(
    'the whole hand sits inside the table, nothing clipped at the bottom',
    geom.cardBottom <= geom.tableBottom,
    `cards reach ${geom.cardBottom.toFixed(0)}, table ends ${geom.tableBottom.toFixed(0)}`,
  );
  await P.shot('4-phone-table');

  const at = (i) => P.ev(`(() => { ${HELPERS} return slice(${i}); })()`);
  const selCount = () => P.ev(`document.querySelectorAll('#hand .card.selected').length`);
  const tops = () =>
    P.ev(`[...document.getElementById('hand').children].map(c => Math.round(c.getBoundingClientRect().top))`);

  // A real touch tap on the 4th card.
  const p3 = await at(3);
  await P.tap(p3.x, p3.y);
  check('tapping a card selects it', (await selCount()) === 1);
  const after = await tops();
  const lift = after[4] - after[3]; // neighbour is unselected; the selected card sits higher
  check('a selected card is lifted well clear of the others', lift >= 30, `${lift}px higher than its neighbour`);
  await P.shot('5-phone-selected');
  await P.tap(p3.x, (await at(3)).y);
  check('tapping again puts it back', (await selCount()) === 0);

  // A real touch swipe across cards 6..9 selects them all.
  const a = await at(6);
  const b = await at(9);
  await P.swipe(a.x, a.y, b.x, b.y);
  const picked = await P.ev(
    `[...document.getElementById('hand').children].map((c, i) => c.classList.contains('selected') ? i : -1).filter(i => i >= 0)`,
  );
  check(
    'swiping across cards selects each one',
    JSON.stringify(picked) === JSON.stringify([6, 7, 8, 9]),
    JSON.stringify(picked),
  );
  await P.shot('6-phone-swipe');
  // Swiping back over selected cards deselects them (the first card touched decides).
  const a2 = await at(9);
  const b2 = await at(7);
  await P.swipe(a2.x, a2.y, b2.x, b2.y);
  const left = await P.ev(
    `[...document.getElementById('hand').children].map((c, i) => c.classList.contains('selected') ? i : -1).filter(i => i >= 0)`,
  );
  check(
    'swiping over selected cards deselects them',
    JSON.stringify(left) === JSON.stringify([6]),
    JSON.stringify(left),
  );
  await P.ev(`document.getElementById('clearBtn').click()`);
  check('Clear empties the selection', (await selCount()) === 0);

  // A selected card is lifted but must not cover the cards beside it: you need to see what is next to it.
  await P.ev(`(() => { ${HELPERS} pick(6); })()`);
  const beside = await P.ev(
    `(() => { ${HELPERS} const l = slice(5); const r = slice(7); return [l && Math.round(l.width), r && Math.round(r.width)]; })()`,
  );
  check(
    'a selected card does not hide the cards beside it',
    beside.every((w) => w !== null && w >= 18),
    beside.join(','),
  );
  await P.ev(`document.getElementById('clearBtn').click()`);

  const coveredP = await P.ev(
    `[...document.querySelectorAll('.actions button')].filter(b => b.offsetParent).filter(b => { const r = b.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !(t && t.closest('button') === b); }).map(b => b.textContent)`,
  );
  check('on a portrait phone no action button is covered by the hand', coveredP.length === 0, coveredP.join(','));
  // Buttons are finger-sized.
  const btn = await P.ev(
    `[...document.querySelectorAll('.actions button')].filter(b => b.offsetParent).map(b => Math.round(b.getBoundingClientRect().height))`,
  );
  check(
    'action buttons are at least 44px tall',
    btn.every((h) => h >= 44),
    btn.join(','),
  );

  // The play log is a sheet over the table, opened on request (it used to sit under the hand).
  const logShown = () => P.ev(`getComputedStyle(document.querySelector('.log')).display !== 'none'`);
  check('on a phone the play log is off the table until asked for', !(await logShown()));
  await P.click('logBtn');
  check(
    'the Log button opens it as a full-screen sheet',
    (await logShown()) &&
      (await P.ev(
        `(() => { const r = document.querySelector('.log').getBoundingClientRect(); return r.width === innerWidth && r.height === innerHeight; })()`,
      )),
  );
  await P.click('logToggle');
  check('the × closes it', !(await logShown()));
  await P.click('logBtn');
  await P.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  check('Escape closes it too', !(await logShown()));

  // ---------- landscape phone ----------
  await P.phone(844, 390);
  await sleep(500);
  const land = await P.ev(
    `({ scrollW: document.documentElement.scrollWidth, vw: innerWidth, scrollH: document.documentElement.scrollHeight, vh: innerHeight, handVisible: document.querySelectorAll('#hand .card').length })`,
  );
  console.log('landscape:', JSON.stringify(land));
  check(
    'landscape has no sideways scrolling and shows the hand',
    land.scrollW <= land.vw + 1 && land.handVisible === 14,
  );
  check(
    'landscape fits the screen height without scrolling',
    land.scrollH <= land.vh + 2,
    `${land.scrollH} vs ${land.vh}`,
  );
  const covered = await P.ev(
    `[...document.querySelectorAll('.actions button')].filter(b => b.offsetParent).filter(b => { const r = b.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !(t && t.closest('button') === b); }).map(b => b.textContent)`,
  );
  check('in landscape no action button is covered by the hand', covered.length === 0, covered.join(','));
  await P.shot('7-phone-landscape');

  // ---------- back to portrait, and the admin screen on a phone ----------
  await P.phone(390, 844);
  await P.click('adminBtn');
  await sleep(500);
  const adm = await P.ev(`({ scrollW: document.documentElement.scrollWidth, vw: innerWidth })`);
  check(
    'the admin screen has no page-level sideways scrolling on a phone',
    adm.scrollW <= adm.vw + 1,
    JSON.stringify(adm),
  );
  await P.shot('8-phone-admin');
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  console.log('FAILED:', err.message);
  try {
    if (P) await P.shot('failure');
  } catch {
    /* ignore */
  }
}
if (P) console.log('browser errors:', P.errors.length ? [...new Set(P.errors)] : 'none');
console.log(
  'server output:',
  env.state.out
    .replace(/\(node:\d+\) ExperimentalWarning[^\n]*\n?/g, '')
    .replace(/\(Use `node[^\n]*\n?/g, '')
    .trim() || '(quiet)',
);
console.log(`${results.length} checks passed${failed ? ', then FAILED' : ''}`);
await env.cleanup();
process.exit(failed ? 1 : 0);

// The Luck & skill view with real figures: the database is seeded with played games (each saved with its
// deal and moves, as the server saves them) before the server starts, so there are enough games to show.
import { launch, newPage, sleep, outDir } from './lib.mjs';
import { openDb, recordGame } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { mulberry32 } from '../src/cards.js';
import { newGame, applyMove, autoSkip, legalMoves, initialDeals, moveLog } from '../src/game.js';
import { scoreRound } from '../src/scoring.js';

const OUT = outDir(process.argv[2]);
const PORT = 8773;
const CDP = 9340;
const BASE = `http://127.0.0.1:${PORT}/`;
const PW = 'correct-horse-battery';

const env = await launch({ port: PORT, cdp: CDP, tmpPrefix: 'big2-e2e-ls-' });

const results = [];
const check = (label, ok, extra = '') => {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) throw new Error('check failed: ' + label);
};

// A whole game at random, the way the server plays it.
function playRandomGame(seed, players) {
  const rng = mulberry32(seed);
  const s = newGame(rng, null, players);
  while (s.winner < 0) {
    const moves = legalMoves(s);
    if (s.trick !== null && (moves.length === 0 || rng() < 0.3)) applyMove(s, null);
    else {
      const m = moves[Math.floor(rng() * moves.length)];
      applyMove(s, m.cards, m.cls);
      autoSkip(s);
    }
  }
  return s;
}

async function seed() {
  const db = openDb(env.env.DB_FILE);
  const names = ['ann', 'bob', 'cat', 'dan', 'eve'];
  const ids = [];
  for (let i = 0; i < names.length; i++) {
    const u = await createUser(db, names[i], PW);
    ids.push(u.id);
  }
  let clock = Date.now() - 5 * 60 * 1000;
  // The first season began when the database was created just now; the games below are older than that.
  db.prepare('UPDATE seasons SET starts = ?').run(clock - 1000);
  const add = (seedNo, users, withRecord = true) => {
    const s = playRandomGame(seedNo, users.length);
    const r = scoreRound(s);
    recordGame(db, {
      started: clock,
      ended: ++clock,
      hasAi: false,
      multiplier: r.multiplier,
      seats: users.map((u, i) => ({ userId: u, cardsLeft: s.hands[i].length, delta: r.delta[i] })),
      record: withRecord ? { deals: initialDeals(s), moves: moveLog(s) } : undefined,
    });
  };
  for (let g = 0; g < 12; g++) add(9000 + g, ids.slice(0, 4)); // ann, bob, cat, dan: twelve games each
  for (let g = 0; g < 3; g++) add(9100 + g, [ids[4], ids[1], ids[2], ids[3]]); // eve: only three
  for (let g = 0; g < 2; g++) add(9200 + g, ids.slice(0, 4), false); // two more for ann etc. without a deal
  db.close();
}

let A;
async function main() {
  await seed();
  await env.state.start();
  A = await newPage(CDP, 'A', OUT);
  await A.goto(BASE);
  await A.signIn('ann', PW);

  await A.click('lbViewStats');
  await A.waitFor(`document.querySelectorAll('#lsBody tr').length >= 5`, 10000, 'the rows');
  const rows = await A.ev(
    `[...document.querySelectorAll('#lsBody tr')].map(r => [...r.children].map(c => c.textContent))`,
  );
  console.log(JSON.stringify(rows));

  const ready = rows.filter((r) => !r[6].startsWith('needs'));
  check('four players have figures and one is still short of games', ready.length === 4 && rows.length === 5);
  const eve = rows.find((r) => r[0] === 'eve');
  check(
    'the player with three games shows how many more are needed',
    eve && eve[1] === '3' && eve[6] === 'needs 7 more',
    JSON.stringify(eve),
  );
  check('and comes last', rows.at(-1)[0] === 'eve');

  const ann = rows.find((r) => r[0] === 'ann');
  check('games shows how many of the games had a saved deal', ann[1] === '12 of 14', ann[1]);
  const fmt = {
    expected: /^\d+\.\d$/,
    wins: /^[+−]\d+\.\d ± \d+\.\d$/,
    luck: /^[+−]\d+$/,
    play: /^[+−]\d+ ± \d+$/,
  };
  check(
    'every figure is formatted: expected wins, wins vs expected ± range, luck, play ± range',
    ready.every((r) => fmt.expected.test(r[3]) && fmt.wins.test(r[4]) && fmt.luck.test(r[5]) && fmt.play.test(r[6])),
    JSON.stringify(ready[0]),
  );
  const num = (s) => Number(s.split(' ')[0].replace('−', '-'));
  const plays = ready.map((r) => num(r[6]));
  check(
    'players are ordered by play, best first',
    plays.every((v, i) => i === 0 || plays[i - 1] >= v),
    plays.join(','),
  );
  // (Luck and play add to zero over a whole table, but eve's three games sit in the others' totals while she
  // is hidden below the minimum, so the four visible rows are not expected to cancel.)
  check(
    'wins vs expected is wins minus expected wins on every row',
    ready.every((r) => Math.abs(Number(r[2]) - Number(r[3]) - num(r[4])) <= 0.11),
    ready.map((r) => [r[2], r[3], r[4]].join('/')).join(' '),
  );
  await A.shot('1-luck-skill-desktop');

  // On a phone the wider table scrolls inside its card instead of pushing the page sideways.
  await A.phone(390, 844);
  await sleep(400);
  const geom = await A.ev(
    `({ page: document.documentElement.scrollWidth, vw: innerWidth, scroller: document.querySelector('.ls-scroll').scrollWidth > document.querySelector('.ls-scroll').clientWidth })`,
  );
  check('on a phone the page does not scroll sideways', geom.page <= geom.vw + 1, JSON.stringify(geom));
  check('and the table fits its card without scrolling', geom.scroller === false, JSON.stringify(geom));
  await A.shot('2-luck-skill-phone');
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

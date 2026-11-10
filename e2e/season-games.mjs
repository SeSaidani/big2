// A season game with the production rules (no development switch), through the real screens. An admin puts players
// on a season's roster; the first four are seated and start a game by themselves; anyone else can only watch (never
// seeing a hand) and chat; with a fifth player a seated person can leave at a cost and the reserve takes the seat;
// ending the season closes the table; and a new season is made by ticking at least four players.
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

let A;
let B;
const byId = (id) => `document.getElementById(${JSON.stringify(id)})`;

// The admin opens the Admin screen (or leaves it) from the account menu.
async function toggleAdmin(page) {
  await page.click('who');
  await page.click('adminBtn');
}

// In the Players dialog: pick a name from the "Add a player" list and press Add, then wait for it to be listed.
async function addPlayer(page, name, expectedRows) {
  await page.ev(
    `(() => { const s = ${byId('playersAdd')}; s.value = [...s.options].find((o) => o.textContent === ${JSON.stringify(name)}).value; ${byId('playersAddBtn')}.click(); })()`,
  );
  await page.waitFor(
    `document.querySelectorAll('#playersBody tr').length === ${expectedRows}`,
    8000,
    `${name} on the roster`,
  );
}

const playerRows = (page) =>
  page.ev(
    `[...document.querySelectorAll('#playersBody tr')].map((r) => [...r.children].slice(1, 3).map((c) => c.textContent).join(': '))`,
  );

async function main() {
  console.log('CLI:', env.makeAdmin('boss', PW).stdout.trim());
  const db = openDb(env.env.DB_FILE);
  for (const name of ['bob', 'cat', 'dan', 'eve', 'wendy']) await createUser(db, name, PW);
  db.close();
  await env.state.start();
  A = await newPage(CDP, 'A', OUT);
  await A.goto(BASE);
  await A.signIn('boss', PW);

  // ---- a season with no players has no table, and the admin is told what to do ----
  check('there is no Create game button: the admin does not make games', await A.ev(`${byId('createRow')}.hidden`));
  await A.waitFor(`${byId('gameBox')}.textContent.includes('players it needs')`, 8000, 'the season note');
  const none = (await A.text('gameBox')).replace(/\s+/g, ' ');
  check(
    'with no players the lobby says the season needs four, and where to add them',
    /Season 1 is running but has 0 of the 4 players it needs/.test(none) &&
      /Admin, then Seasons, then Players/.test(none),
    none,
  );
  await A.shot('1-no-players');

  // ---- the admin adds the roster: boss, bob, cat, dan sit down; eve is a reserve ----
  await toggleAdmin(A);
  await A.waitFor(
    `!${byId('admin')}.hidden && document.querySelectorAll('#seasonsBody tr').length === 1`,
    8000,
    'admin',
  );
  // ---- the Admin screen is tabbed: one section at a time, and it remembers where you were ----
  const tabsNow = () =>
    A.ev(
      `[...document.querySelectorAll('[role=tab]')].map((t) => t.textContent.trim() + ':' + t.getAttribute('aria-selected'))`,
    );
  const panelsNow = () =>
    A.ev(`[...document.querySelectorAll('[role=tabpanel]')].filter((p) => !p.hidden).map((p) => p.id)`);
  check(
    'Admin has four tabs and opens on Seasons while the season still needs players',
    (await tabsNow()).join(' ') === 'Overview:false Seasons:true Users:false Audit log:false' &&
      (await panelsNow()).join() === 'admin-seasons',
    (await tabsNow()).join(' '),
  );
  await A.click('tab-users');
  check(
    'the Users tab shows the user list and the new-user form, and nothing else',
    (await panelsNow()).join() === 'admin-users' &&
      (await A.ev(
        `!!document.querySelector('#admin-users #createUserBtn') && !!document.querySelector('#admin-users #usersBody tr')`,
      )),
  );
  await A.click('tab-audit');
  check('the Audit log tab shows only the log', (await panelsNow()).join() === 'admin-audit');
  await A.ev(
    `document.getElementById('tab-audit').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`,
  );
  check(
    'the right arrow moves along the tabs, wrapping round to Overview',
    (await panelsNow()).join() === 'admin-overview' &&
      (await A.ev(
        `document.activeElement.id === 'tab-overview' && document.getElementById('adminStats').textContent.includes('accounts')`,
      )),
  );
  await A.shot('1b-admin-overview-tab');
  await A.click('tab-seasons');

  const cols = await A.ev(`[...document.querySelectorAll('.lb.users th')].map((t) => t.textContent)`);
  check('the seasons table has a Players column', cols.includes('Players'));
  check(
    'Season 1 has no players yet',
    (await A.ev(`document.querySelector('#seasonsBody tr').children[4].textContent`)) === '0',
  );
  await A.clickButton('#seasonsBody', 'Players');
  await A.waitFor(`${byId('playersDlg')}.open`, 8000, 'the Players dialog');
  check('the Players dialog opens for the season', (await A.text('playersTitle')).startsWith('Season 1'));
  let n = 0;
  for (const name of ['boss', 'bob', 'cat']) await addPlayer(A, name, ++n);
  check(
    'three players are not enough: no table yet',
    (await playerRows(A)).every((r) => r.endsWith('Will sit down')),
  );
  await addPlayer(A, 'dan', 4);
  await A.waitFor(
    `[...document.querySelectorAll('#playersBody tr')].every((r) => r.children[2].textContent === 'Seated')`,
    8000,
    'the four are seated',
  );
  check('the fourth player seats the first four', true, (await playerRows(A)).join(' | '));
  const removeSeated = await A.ev(`[...document.querySelectorAll('#playersBody button')].every((b) => b.disabled)`);
  check('a seated player cannot be removed', removeSeated);
  await addPlayer(A, 'eve', 5);
  const rows = await playerRows(A);
  check('a fifth player is a reserve', rows[4] === 'eve: Reserve 1', rows.join(' | '));
  await A.shot('2-players-dialog');
  await A.click('playersClose');
  await A.waitFor(
    `document.querySelector('#seasonsBody tr').children[4].textContent === '5'`,
    8000,
    'the players count',
  );
  check('the seasons table now counts five players', true);

  // ---- back in the player view: the table, and the countdown to a game that starts by itself ----
  await toggleAdmin(A);
  await A.waitFor(
    `!${byId('waitRoom')}.hidden || !${byId('tableMain')}.hidden`,
    8000,
    'boss is seated, so the waiting room or the table shows',
  );
  await A.waitFor(
    `!${byId('tableMain')}.hidden && document.querySelectorAll('#hand .card').length === 14`,
    20000,
    'the game starting by itself',
  );
  check('the four seated people got a game without anyone pressing Start', true);

  // ---- getting back to the lobby from a game in progress: the seat is kept, and it says if it is your move ----
  check(
    'the table has a Lobby button in its corner (and the old Back to lobby is gone)',
    await A.ev(`getComputedStyle(${byId('lobbyBtn')}).display !== 'none' && !document.getElementById('leaveBtn')`),
  );
  const seatKept = () =>
    A.ev(`fetch('/api/game').then((r) => r.json()).then((j) => !!j.table && j.table.status === 'playing')`);
  const myMove = await A.ev(`fetch('/api/game').then((r) => r.json()).then((j) => j.table.game.turn === j.table.you)`);
  await A.click('lobbyBtn');
  await A.waitFor(`!${byId('lobbyHome')}.hidden && ${byId('tableMain')}.hidden`, 5000, 'the lobby');
  check(
    'the Lobby button goes to the lobby and offers to rejoin the game',
    (await A.text('gameBox')).includes('Rejoin your game'),
  );
  check(
    'it says it is your turn exactly when it is, in the lobby and as a dot on Online',
    (await A.ev(`!!document.querySelector('#gameBox .turn-note')`)) === myMove &&
      (await A.ev(`${byId('modeOnline')}.classList.contains('attention')`)) === myMove,
    `my move: ${myMove}`,
  );
  check('the seat is kept', await seatKept());
  await A.clickButton('#gameBox', 'Rejoin your game');
  await A.waitFor(`!${byId('tableMain')}.hidden`, 5000, 'back at the table');
  await A.click('modeOnline');
  await A.waitFor(`!${byId('lobbyHome')}.hidden && ${byId('tableMain')}.hidden`, 5000, 'the lobby from the table');
  check('the Online button also goes home from the table, and the seat is kept', await seatKept());
  await toggleAdmin(A);
  await A.waitFor(`!${byId('admin')}.hidden`, 5000, 'admin');
  await A.click('modeOnline');
  await A.waitFor(`${byId('admin')}.hidden && !${byId('lobbyHome')}.hidden`, 5000, 'the lobby from admin');
  check('and from the Admin screen', true);
  await A.clickButton('#gameBox', 'Rejoin your game');
  await A.waitFor(`!${byId('tableMain')}.hidden`, 5000, 'back at the table for the logo');
  await A.click('brandBtn');
  await A.waitFor(`!${byId('lobbyHome')}.hidden && ${byId('tableMain')}.hidden`, 5000, 'the lobby from the logo');
  check('the logo also goes to the lobby, and the seat is kept', await seatKept());
  await A.clickButton('#gameBox', 'Rejoin your game');
  await A.waitFor(`!${byId('tableMain')}.hidden`, 5000, 'back at the table again');
  const names = await A.ev(`[1, 2, 3].map((i) => document.getElementById('seat-' + i).textContent)`);
  check(
    'the other seats are the roster players, not computers',
    ['bob', 'cat', 'dan'].every((nm) => names.join(' ').includes(nm)) && !/bot/i.test(names.join(' ')),
    names.join(' | '),
  );
  await A.shot('3-playing');

  // ---- a person who is not seated can only watch: no seat, no cards, but chat ----
  B = await newPage(CDP, 'B', OUT);
  await B.goto(BASE);
  await B.signIn('wendy', PW);
  await B.waitFor(`${byId('gameBox')}.textContent.includes('Watch the game')`, 8000, 'the lobby offering to watch');
  const lobbyB = await B.text('gameBox');
  check(
    'someone not on the roster is told they can watch',
    /Watch the game/.test(lobbyB) && !/Take a seat/.test(lobbyB),
  );
  check(
    'and there is no seat to take',
    await B.ev(`![...document.querySelectorAll('#gameBox button')].some((b) => /seat|join/i.test(b.textContent))`),
  );
  await B.shot('4-lobby-watcher');
  await B.clickButton('#gameBox', 'Watch the game');
  await B.waitFor(`!${byId('tableMain')}.hidden`, 8000, 'the table, watched');
  check(
    'a watcher sees the table with the four players named',
    await B.ev(`['boss', 'bob', 'cat', 'dan'].every((nm) => document.body.textContent.includes(nm))`),
  );
  check('and is never shown a hand', (await B.ev(`document.querySelectorAll('#hand .card').length`)) === 0);
  check(
    'the bottom seat is a player with a card count, like the others',
    // whoever the shuffle put in the bottom seat (the seats are shuffled for every game)
    /^(boss|bob|cat|dan)( \(offline\))? has 14 cards$/.test(await B.text('selInfo')),
    await B.text('selInfo'),
  );
  check(
    'with no Play or Pass buttons, and nobody called You',
    (await B.ev(
      `['playBtn', 'passBtn'].every((id) => getComputedStyle(document.getElementById(id)).display === 'none')`,
    )) &&
      !(await B.ev(
        `document.getElementById('selInfo').textContent.includes('You') || [1, 2, 3].some((i) => document.getElementById('seat-' + i).textContent.includes('You'))`,
      )),
  );
  check('and there is a Stop watching button', await B.ev(`!${byId('watchStopBtn')}.hidden`));
  await B.shot('5-watching');
  await B.waitFor(`!${byId('chat')}.hidden`, 8000, 'chat on for a watcher');
  await B.ev(`${byId('chatInput')}.value = 'hello from the stands'; ${byId('chatSend')}.click()`);
  await A.waitFor(
    `${byId('chatMsgs')}.textContent.includes('hello from the stands')`,
    8000,
    'the message reaching the table',
  );
  check('a watcher can chat, and the players see it', true);
  await B.click('watchStopBtn');
  await B.waitFor(`!${byId('lobbyHome')}.hidden`, 8000, 'back in the lobby');
  check(
    'Stop watching goes back to the lobby, where they can watch again',
    (await B.text('gameBox')).includes('Watch the game'),
  );

  // ---- leaving a seat with a fifth player: the game is void, it costs the leaver the most, the reserve sits ----
  await A.waitFor(`!${byId('forfeitBtn')}.hidden`, 8000, 'Leave seat offered with five players');
  check('with a fifth player a Leave seat button appears', true);
  await A.click('forfeitBtn');
  const warn = await A.confirmPopup();
  check(
    'it asks in a popup and says what it costs',
    warn.includes('Leave the game?') && warn.includes('56 points'),
    warn,
  );
  await A.waitFor(
    `!${byId('lobbyHome')}.hidden && ${byId('gameBox')}.textContent.includes('Starting')`,
    10000,
    'the lobby after leaving',
  );
  const lobby = (await A.text('gameBox')).replace(/\s+/g, ' ');
  check(
    'leaving takes you to the lobby, and the reserve (eve) has taken the seat',
    ['eve', 'bob', 'cat', 'dan'].every((nm) => lobby.includes(nm)) &&
      !lobby.includes('boss') &&
      lobby.includes('4 of 4'),
    lobby.slice(0, 120),
  );
  const dbRead = openDb(env.env.DB_FILE);
  const forfeit = dbRead
    .prepare(
      'SELECT g.status, r.delta, u.name FROM games g JOIN results r ON r.game_id = g.id JOIN users u ON u.id = r.user_id',
    )
    .all();
  dbRead.close();
  check(
    'it was recorded as the worst round for the leaver only: -56, and nobody else has a result',
    forfeit.length === 1 && forfeit[0].status === 'forfeit' && forfeit[0].delta === -56 && forfeit[0].name === 'boss',
    JSON.stringify(forfeit.map((r) => ({ ...r }))),
  );
  check(
    'boss, no longer seated, is offered the watch button, not a seat',
    await A.ev(`[...document.querySelectorAll('#gameBox button')].some((b) => b.textContent === 'Watch the game')`),
  );
  await A.shot('6-after-leaving');

  // ---- ending the season (End now, twice to confirm) closes the table; the picker drops "Current season" ----
  await toggleAdmin(A);
  await A.waitFor(
    `!${byId('admin')}.hidden && document.querySelectorAll('#seasonsBody tr').length === 1`,
    8000,
    'admin',
  );
  await A.clickButton('#seasonsBody', 'End now');
  await A.confirmPopup();
  await A.waitFor(
    `document.querySelector('#seasonsBody tr').children[1].textContent === 'past'`,
    8000,
    'the season ended',
  );
  const picker = await A.ev(`[...document.querySelectorAll('#lbSeason option')].map((o) => o.textContent)`);
  check(
    'with no season running the leaderboard picker does not offer "Current season"',
    !picker.some((t) => /Current season/.test(t)) && picker.includes('All-time'),
    picker.join(' | '),
  );
  await toggleAdmin(A);
  await A.waitFor(
    `!${byId('lobbyHome')}.hidden && ${byId('gameBox')}.textContent.includes('No season is running')`,
    10000,
    'the lobby saying there is no season',
  );
  check('ending the season closes the table and the lobby says no season is running', true, await A.text('gameBox'));

  // ---- a new season: tick the players; fewer than four is refused ----
  await toggleAdmin(A);
  await A.waitFor(
    `!${byId('admin')}.hidden && document.querySelectorAll('#seasonPicks input').length >= 5`,
    8000,
    'the player tick-list',
  );
  await A.ev(`${byId('seasonName')}.value = 'Autumn'`);
  const tick = (name) =>
    A.ev(
      `[...document.querySelectorAll('#seasonPicks label')].find((l) => l.textContent.trim() === ${JSON.stringify(name)}).querySelector('input').click()`,
    );
  await tick('bob');
  await tick('cat');
  await A.click('seasonSave');
  await A.waitFor(`${byId('seasonMsg')}.textContent.includes('at least 4 players')`, 5000, 'the refusal');
  check('a new season with only two players ticked is refused', true, await A.text('seasonMsg'));
  await tick('dan');
  await tick('eve');
  await A.click('seasonSave');
  await A.waitFor(`${byId('seasonMsg')}.textContent === 'Season created.'`, 8000, 'the new season');
  check('with four ticked the season is created', true);
  const tableRow = await A.ev(
    `[...document.querySelectorAll('#seasonsBody tr')].map((r) => [r.children[0].textContent, r.children[1].textContent, r.children[4].textContent].join(': '))`,
  );
  check('and listed as running with four players', tableRow.includes('Autumn: active: 4'), tableRow.join(' | '));
  await A.shot('7-new-season');
  await toggleAdmin(A);
  await A.waitFor(`${byId('gameBox')}.textContent.includes('bob, cat, dan, eve')`, 8000, 'the new season table');
  check('and its table opens with the four ticked players, in the order ticked', true);

  // ---- the tab you left on is the one you come back to ----
  await A.click('tab-audit');
  await A.goto(BASE);
  await A.waitFor(
    `document.getElementById('who').textContent === 'boss' && !document.getElementById('lobbyHome').hidden`,
    10000,
    'the lobby after a reload',
  );
  await toggleAdmin(A);
  await A.waitFor(`!${byId('admin')}.hidden`, 8000, 'admin again');
  check(
    'after a reload Admin opens on the tab you left it on',
    (await panelsNow()).join() === 'admin-audit',
    (await tabsNow()).join(' '),
  );
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  console.log('FAILED:', err.message);
  for (const p of [A, B]) {
    try {
      if (p) await p.shot(`failure-${p.name}`);
    } catch {
      /* ignore */
    }
  }
}
for (const p of [A, B]) {
  if (p) console.log(`browser errors [${p.name}]:`, p.errors.length ? [...new Set(p.errors)] : 'none');
}
console.log(`${results.filter((r) => r.ok).length} checks passed${failed ? ', then FAILED' : ''}`);
await sleep(100);
await env.cleanup();
process.exit(failed ? 1 : 0);

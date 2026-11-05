import { launch, newPage, sleep, STEP, outDir } from './lib.mjs';

const OUT = outDir(process.argv[2]);
const PORT = 8767;
const CDP = 9334;
const BASE = `http://127.0.0.1:${PORT}/`;
const ADMIN_PW = 'admin-password-123';
const TEMP_PW = 'temporary-pass-1';
const NEW_PW = 'alice-new-password-9';

const env = await launch({ port: PORT, cdp: CDP, tmpPrefix: 'big2-e2e2-', extraEnv: { DEV_TABLES: '1' } });
console.log('CLI:', env.makeAdmin('boss', ADMIN_PW).stdout.trim());

let moves = 0;
async function drive(page, stop) {
  const t0 = Date.now();
  while (!stop.done) {
    const r = await page.ev(STEP);
    if (r === 'over') return;
    if (r === 'stuck') throw new Error(`[${page.name}] stuck: ` + (await page.text('status')));
    if (r === 'play' || r === 'pass') moves++;
    if (Date.now() - t0 > 240000) throw new Error(`[${page.name}] round did not finish`);
    await sleep(70);
  }
}

const results = [];
const check = (label, ok, extra = '') => {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) throw new Error('check failed: ' + label);
};

let A;
let B;
async function main() {
  await env.state.start();
  A = await newPage(CDP, 'A', OUT);
  B = await newPage(CDP, 'B', OUT);

  // --- admin signs in and creates a user in the UI ---
  await A.goto(BASE);
  await A.signIn('boss', ADMIN_PW);
  check('admin signs in and sees the Admin button', await A.visible('adminBtn'));
  check(
    'the account menu shows the name and starts closed',
    (await A.text('who')) === 'boss' && !(await A.ev(`document.getElementById('account').open`)),
  );
  await A.click('who');
  check(
    'the account menu opens with Admin, Phone, Password and Log out',
    await A.ev(
      `document.getElementById('account').open && ['adminBtn', 'phoneBtn', 'passwordBtn', 'logoutBtn'].every((id) => document.getElementById(id).closest('.menu') && !document.getElementById(id).hidden)`,
    ),
  );
  await A.ev(`document.body.click()`);
  check('a click elsewhere closes the account menu', !(await A.ev(`document.getElementById('account').open`)));
  await A.click('helpBtn');
  check(
    'the How to play dialog opens with the rules and the scoring table',
    await A.ev(
      `document.getElementById('helpDlg').open && document.getElementById('helpDlg').textContent.includes('Scoring') && document.querySelectorAll('#helpDlg .rates tbody tr').length === 4`,
    ),
  );
  check(
    'it opens at the top, not scrolled to the end',
    (await A.ev(`document.getElementById('helpDlg').scrollTop`)) === 0,
  );
  await A.click('helpClose');
  check('and closes again', !(await A.ev(`document.getElementById('helpDlg').open`)));
  await A.click('helpBtn');
  await A.click('helpX');
  check('the × in the corner also closes it', !(await A.ev(`document.getElementById('helpDlg').open`)));
  await A.click('adminBtn');
  await A.waitFor(
    `!document.getElementById('admin').hidden && document.getElementById('usersBody').children.length >= 1`,
    8000,
    'admin screen',
  );
  check('registration is closed by default', (await A.text('regState')).startsWith('Closed'));
  await A.ev(
    `document.getElementById('newUserName').value='alice'; document.getElementById('newUserPw').value=${JSON.stringify(TEMP_PW)}; document.getElementById('newUserPhone').value='+447700900002'; document.getElementById('createUserBtn').click()`,
  );
  await A.waitFor(
    `[...document.querySelectorAll('#usersBody tr')].some(r => r.children[0].textContent === 'alice')`,
    8000,
    'alice in the users table',
  );
  check('admin created a user from the UI', true, await A.text('createUserMsg'));
  await A.shot('1-admin');

  // --- the new user signs in with the temporary password, then changes it ---
  await B.goto(BASE);
  await B.signIn('alice', TEMP_PW);
  check('a non-admin has no Admin button', !(await B.visible('adminBtn')));
  check('a non-admin still has Log out in the menu', await B.visible('logoutBtn'));
  await B.click('passwordBtn');
  await B.ev(
    `document.getElementById('pwCurrent').value=${JSON.stringify(TEMP_PW)}; document.getElementById('pwNext').value=${JSON.stringify(NEW_PW)}; document.getElementById('pwOk').click()`,
  );
  await B.waitFor(`!document.getElementById('pwDlg').open`, 8000, 'password dialog closes');
  check('user changed their temporary password', (await B.ev(`fetch('/api/me').then(r => r.status)`)) === 200);

  // --- admin creates the one game; alice joins; chat ---
  await A.click('adminBtn'); // back to the lobby
  await A.waitFor(`!document.getElementById('createRow').hidden`, 8000, 'create row');
  await A.ev(`document.getElementById('newLevel').value='easy'; document.getElementById('createBtn').click()`);
  await A.waitFor(`!document.getElementById('waitRoom').hidden`, 8000, 'waiting room');
  await B.waitFor(
    `[...document.querySelectorAll('#gameBox button')].some(b => b.textContent === 'Join game')`,
    8000,
    'Join button for alice',
  );
  const card = await B.text('gameBox');
  check(
    'the lobby shows the current game and its settings',
    ['Host', 'boss', 'Waiting to start', '4 seats', 'Easy AI plays the 3 empty seats'].every((s) => card.includes(s)),
    card.replace(/\s+/g, ' ').slice(0, 120),
  );
  check(
    'a second game cannot be created while one is waiting',
    (await A.ev(
      `fetch('/api/game', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({aiLevel:'easy'})}).then(r => r.status)`,
    )) === 409,
  );
  await B.clickButton('#gameBox', 'Join game');
  await B.waitFor(`!document.getElementById('waitRoom').hidden`, 8000, 'alice in the waiting room');
  await A.waitFor(
    `!document.getElementById('chat').hidden && document.getElementById('waitSeats').textContent.includes('alice')`,
    8000,
    'chat appears for two humans',
  );
  await B.ev(
    `document.getElementById('chatInput').value='<b>hello</b> from alice'; document.getElementById('chatSend').click()`,
  );
  await A.waitFor(
    `document.getElementById('chatMsgs').textContent.includes('hello')`,
    8000,
    'chat message reaches the admin',
  );
  check(
    'chat shows markup as plain text',
    (await A.ev(`document.querySelectorAll('#chatMsgs li b').length`)) === 1 &&
      (await A.text('chatMsgs')).includes('<b>hello</b>'),
  );
  await A.shot('2-waiting-chat');

  // Chat on a phone: the side panel is a sheet there, so the waiting room has its own Chat button.
  await B.phone(390, 844);
  await sleep(300);
  check(
    'on a phone the waiting room offers a Chat button now that chat is on',
    await B.ev(
      `!document.getElementById('waitLogBtn').hidden && getComputedStyle(document.getElementById('waitLogBtn')).display !== 'none'`,
    ),
  );
  check(
    'and the chat itself is off the screen until it is opened',
    !(await B.ev(`document.body.classList.contains('log-open')`)),
  );
  await A.ev(
    `document.getElementById('chatInput').value = 'ping for the phone'; document.getElementById('chatSend').click()`,
  );
  await B.waitFor(
    `document.getElementById('waitLogBtn').classList.contains('unread')`,
    8000,
    'an unread mark on the Chat button',
  );
  check('a message from someone else marks the Chat button as unread', true);
  await B.click('waitLogBtn');
  check(
    'opening it shows the chat, including that message, and clears the mark',
    await B.ev(
      `document.body.classList.contains('log-open') && !document.getElementById('chat').hidden && document.getElementById('chatMsgs').textContent.includes('ping for the phone') && !document.getElementById('waitLogBtn').classList.contains('unread')`,
    ),
  );
  await B.click('logToggle');
  await B.desktop();
  await sleep(200);

  // --- play, with a lobby round-trip and a hard server restart in the middle ---
  await A.click('startBtn');
  await Promise.all(
    [A, B].map((p) =>
      p.waitFor(
        `!document.getElementById('tableMain').hidden && document.querySelectorAll('#hand .card').length === 14`,
        10000,
        'both at the table',
      ),
    ),
  );
  const stop = { done: false };
  const driving = Promise.all([drive(A, stop), drive(B, stop)]);
  const watch = async () => {
    while (moves < 8) await sleep(100);
    await B.click('leaveBtn');
    await B.waitFor(
      `!document.getElementById('lobby').hidden && [...document.querySelectorAll('#gameBox button')].some(b => b.textContent === 'Rejoin your game')`,
      8000,
      'Rejoin button after going back to the lobby',
    );
    check('going back to the lobby keeps the seat (Rejoin offered)', true);
    await B.clickButton('#gameBox', 'Rejoin your game');
    await B.waitFor(`!document.getElementById('tableMain').hidden`, 8000, 'back at the table');
    await A.shot('3-midgame');
    const before = moves;
    env.state.server.kill(); // abrupt: no clean shutdown
    await sleep(800);
    await env.state.start();
    check('server restarted mid-game', true, `at move ${before}`);
    await Promise.all(
      [A, B].map((p) =>
        p.waitFor(
          `!document.getElementById('tableMain').hidden && document.querySelectorAll('#hand .card').length > 0`,
          20000,
          'pages recover after the restart',
        ),
      ),
    );
    const t0 = moves;
    const tw = Date.now();
    while (moves < t0 + 4 && Date.now() - tw < 60000) await sleep(100);
    check('the game carried on after the restart', moves >= t0 + 4 || (await A.visible('overlay')));
  };
  await Promise.all([driving, watch()]);

  // --- result ---
  await Promise.all([A, B].map((p) => p.waitFor(`!document.getElementById('overlay').hidden`, 10000, 'result panel')));
  const rows = async (p) =>
    p.ev(
      `[...document.querySelectorAll('#endHands .end-row')].map(r => [r.querySelector('.who').textContent, Number(r.querySelector('.pts').textContent.replace('−','-'))])`,
    );
  const ra = await rows(A);
  const rb = await rows(B);
  console.log('A sees:', JSON.stringify(ra), ' B sees:', JSON.stringify(rb));
  check('the points add up to zero', ra.reduce((s, r) => s + r[1], 0) === 0 && rb.reduce((s, r) => s + r[1], 0) === 0);
  const ptsOf = (rowsOf, name) => rowsOf.find((r) => r[0] === name)[1];
  check(
    'both players see the same scores',
    ptsOf(ra, 'You') === ptsOf(rb, 'boss') && ptsOf(rb, 'You') === ptsOf(ra, 'alice'),
  );
  check('only the host gets "Play again"', (await A.visible('againBtn')) && !(await B.visible('againBtn')));
  await A.shot('4-result');

  // --- leaderboard: a game with computer players does not count ---
  await A.click('endLeave');
  await A.waitFor(`!document.getElementById('lobbyHome').hidden`, 8000, 'A back in the lobby');
  check(
    'there is no computer-players board to pick',
    await A.ev(`!document.getElementById('lbAi') && !document.getElementById('lbHuman')`),
  );
  await A.waitFor(`document.getElementById('lbBody').textContent.includes('No games yet')`, 8000, 'an empty board');
  check('the game with computer players is not on the leaderboard', true, await A.text('lbBody'));
  await A.shot('5-leaderboard');

  // Luck & skill leaves that game out too: it had computer players.
  await A.click('lbViewStats');
  await A.waitFor(
    `document.getElementById('lsBody').textContent.includes('No games with their deals saved yet')`,
    8000,
    'an empty Luck & skill view',
  );
  check(
    'Luck & skill is empty too, and the standings table is out of the way while it shows',
    await A.ev(`document.getElementById('lbStandings').hidden && !document.getElementById('lsBox').hidden`),
  );
  const priced = await A.ev(`fetch('/api/stats').then(r => r.json())`);
  check(
    'the server neither counted nor priced the game with computer players',
    priced.rows.length === 0 && priced.pending === 0,
    JSON.stringify(priced.rows),
  );
  await A.shot('5b-luck-skill');
  await A.click('lbViewStandings');
  check(
    'the toggle goes back to the standings',
    await A.ev(`!document.getElementById('lbStandings').hidden && document.getElementById('lsBox').hidden`),
  );

  // --- a second game: an admin can create one now, and only an admin can cancel ---
  await A.waitFor(`!document.getElementById('createRow').hidden`, 8000, 'create row after a finished game');
  await B.click('endLeave');
  await B.waitFor(`!document.getElementById('lobbyHome').hidden`, 8000, 'B back in the lobby');
  await A.ev(`document.getElementById('newLevel').value='easy'; document.getElementById('createBtn').click()`);
  await B.waitFor(
    `[...document.querySelectorAll('#gameBox button')].some(b => b.textContent === 'Join game')`,
    8000,
    'Join for the second game',
  );
  await B.clickButton('#gameBox', 'Join game');
  await A.waitFor(`document.getElementById('waitSeats').textContent.includes('alice')`, 8000, 'alice seated again');
  await A.click('startBtn');
  await Promise.all(
    [A, B].map((p) =>
      p.waitFor(
        `!document.getElementById('tableMain').hidden && document.querySelectorAll('#hand .card').length === 14`,
        10000,
        'second game started',
      ),
    ),
  );
  check(
    'a plain player cannot cancel (no such route)',
    (await B.ev(
      `fetch('/api/admin/game/cancel', {method:'POST', headers:{'content-type':'application/json'}, body:'{}'}).then(r => r.status)`,
    )) === 403,
  );
  await A.click('adminBtn');
  await A.waitFor(
    `!document.getElementById('admin').hidden && [...document.querySelectorAll('#adminGame button')].some(b => b.textContent === 'Cancel game')`,
    8000,
    'Cancel button',
  );
  await A.clickButton('#adminGame', 'Cancel game'); // arms
  await A.clickButton('#adminGame', 'Click again to confirm'); // confirms
  await Promise.all(
    [A, B].map((p) => p.waitFor(`document.getElementById('tableMain').hidden`, 10000, 'table gone after the cancel')),
  );
  await B.waitFor(
    `document.getElementById('gameBox').textContent.includes('No game is running')`,
    8000,
    'no game for alice',
  );
  await A.waitFor(
    `document.getElementById('adminStats').textContent.includes('1 cancelled')`,
    8000,
    'admin stats show the cancelled game',
  );
  check('an admin cancelled the game for everyone, and it is recorded as cancelled', true, await A.text('adminStats'));
  const lbAfter = await A.ev(`fetch('/api/leaderboard').then(r => r.json()).then(j => j.rows.length)`);
  check(
    'neither the finished game nor the cancelled one counted for anyone (both had computer players)',
    lbAfter === 0,
  );
  await A.shot('6-admin-after-cancel');

  // --- a third game on a phone-sized screen, to look at the layout ---
  await A.size(390, 844, true);
  await A.click('adminBtn');
  await A.waitFor(`!document.getElementById('createRow').hidden`, 8000, 'create row');
  await A.ev(`document.getElementById('newLevel').value='easy'; document.getElementById('createBtn').click()`);
  await A.waitFor(`!document.getElementById('waitRoom').hidden`, 8000, 'waiting room');
  await A.shot('7-mobile-waiting');
  await A.click('startBtn');
  await A.waitFor(
    `!document.getElementById('tableMain').hidden && document.querySelectorAll('#hand .card').length === 14`,
    10000,
    'mobile table',
  );
  await sleep(1500);
  await A.shot('8-mobile-table');
  await A.click('adminBtn');
  await A.waitFor(`!document.getElementById('admin').hidden`, 5000, 'admin on mobile');
  await A.shot('9-mobile-admin');
  await A.clickButton('#adminGame', 'Cancel game');
  await A.clickButton('#adminGame', 'Click again to confirm');
  await A.waitFor(`document.getElementById('adminStats').textContent.includes('2 cancelled')`, 8000, 'second cancel');
  await A.size(1400, 900, false);

  // --- disabling a user signs them out live ---
  await A.waitFor(
    `[...document.querySelectorAll('#usersBody tr')].some(r => r.children[0].textContent === 'alice')`,
    8000,
    'users table',
  );
  await A.ev(
    `(() => { const row = [...document.querySelectorAll('#usersBody tr')].find(r => r.children[0].textContent === 'alice'); const b = [...row.querySelectorAll('button')].find(x => x.textContent === 'Disable'); b.click(); })()`,
  );
  await A.ev(
    `(() => { const row = [...document.querySelectorAll('#usersBody tr')].find(r => r.children[0].textContent === 'alice'); const b = [...row.querySelectorAll('button')].find(x => x.textContent === 'Click again to confirm'); b.click(); })()`,
  );
  await B.waitFor(
    `!!document.getElementById('form') && !document.getElementById('hand')`,
    15000,
    'alice is signed out',
  );
  check('disabling a user sends their open page back to the sign-in page', true);
  const auditText = await A.ev(
    `(async () => { await new Promise(r => setTimeout(r, 600)); return document.getElementById('auditList').textContent; })()`,
  );
  check(
    'every admin action is in the audit log',
    ['create_user', 'cancel_game', 'disable_user'].every((a) => auditText.includes(a)),
  );
  await A.shot('10-audit');
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  console.log('FAILED:', err.message);
  for (const p of [A, B]) {
    try {
      if (p) await p.shot('failure');
    } catch {
      /* ignore */
    }
  }
}
for (const p of [A, B]) {
  if (p) console.log(`browser errors [${p.name}]:`, p.errors.length ? [...new Set(p.errors)] : 'none');
}
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

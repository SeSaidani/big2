// Turn alerts as people meet them (an Android phone, an iPhone in Safari, a computer), the buttons on the solo
// win screen, and ending and creating seasons from the Admin screen. Real Chrome, a real server.
//
// Not covered here, and it cannot be: a real push through Google's or Apple's servers to a real phone.
// Headless Chrome has no push service to subscribe to, so "Turn on alerts" is checked up to the browser's
// own answer, and the delivery path is covered by the server tests, which decrypt what the server sends.
import { launch, newPage, sleep, outDir } from './lib.mjs';
import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';

const OUT = outDir(process.argv[2]);
const PORT = 8775;
const CDP = 9342;
const BASE = `http://127.0.0.1:${PORT}/`;
const PW = 'admin-password-123';

const UA = {
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};

const env = await launch({ port: PORT, cdp: CDP, tmpPrefix: 'big2-e2e-al-' });
const results = [];
const check = (label, ok, extra = '') => {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) throw new Error('check failed: ' + label);
};

let A;
const byId = (id) => `document.getElementById(${JSON.stringify(id)})`;
const setUa = (ua) => A.conn.send('Network.setUserAgentOverride', { userAgent: ua });
const reloadGame = async () => {
  await A.goto(BASE);
  await A.waitFor(
    `${byId('who')}.textContent === 'boss' && !${byId('lobbyHome')}.hidden && document.body.dataset.online === 'ready'`,
    10000,
    'lobby',
  );
  await sleep(400); // startAlerts runs just after the lobby appears
};
const openAlerts = async () => {
  await A.click('who');
  await A.click('alertsBtn');
  await A.waitFor(`${byId('alertsDlg')}.open && ${byId('alertsStatus')}.textContent !== ''`, 5000, 'alerts dialog');
};
const closeAlerts = () => A.ev(`${byId('alertsDlg')}.close()`);

async function main() {
  console.log('CLI:', env.makeAdmin('boss', PW).stdout.trim());
  const db = openDb(env.env.DB_FILE);
  for (const name of ['bob', 'cat', 'dan']) await createUser(db, name, PW); // a new season needs four players to pick
  db.close();
  await env.state.start();
  A = await newPage(CDP, 'A', OUT);
  await A.conn.send('Network.enable');

  // ---------------- an Android phone ----------------
  await setUa(UA.android);
  await A.phone(390, 844);
  await A.goto(BASE);
  await A.signIn('boss', PW);
  await A.waitFor(`!${byId('alertsBanner')}.hidden`, 6000, 'the one-tap bar');
  check('Android: signing in offers alerts with a one-tap bar, and asks the browser nothing yet', true);
  check(
    'the bar says what it is for and has Turn on / Not now',
    (await A.text('alertsBanner')).includes('alert') &&
      (await A.ev(`!${byId('alertsBannerOn')}.hidden && !${byId('alertsBannerLater')}.hidden`)),
  );
  await A.shot('1-android-banner');
  await A.click('alertsBannerLater');
  check('"Not now" hides the bar', await A.ev(`${byId('alertsBanner')}.hidden`));
  await reloadGame();
  check('and it stays hidden on the next visit', await A.ev(`${byId('alertsBanner')}.hidden`));
  check('no iPhone steps are shown to an Android phone', await A.ev(`!${byId('iosDlg')}.open`));

  await openAlerts();
  check(
    'the Turn alerts dialog says alerts are off and offers to turn them on',
    (await A.text('alertsStatus')).includes('off'),
  );
  const parts = await A.ev(
    `(() => { const t = ${byId('alertsDlg')}.textContent.replace(/\\s+/g, ' '); return { on: !${byId('alertsOn')}.hidden, noTest: ${byId('alertsTest')}.hidden, noOff: ${byId('alertsOff')}.hidden, twenty: t.includes('20 minutes'), day: t.includes('24 hours') }; })()`,
  );
  check(
    'it offers Turn on only (no test, no turn-off yet) and explains what is sent',
    Object.values(parts).every(Boolean),
    JSON.stringify(parts),
  );
  check(
    'a "Not getting alerts?" help section covers blocked, silent and starting again',
    await A.ev(
      `(() => { const t = ${byId('alertsDlg')}.querySelector('.alerts-trouble:not(#alertsHow)').textContent; return ['Blocked', 'Silent', 'Start again', 'New phone'].every((w) => t.includes(w)); })()`,
    ),
  );
  await A.shot('2-android-dialog');

  // Blocked by the browser: the dialog says so and how to undo it.
  await A.ev(`Object.defineProperty(Notification, 'permission', { get: () => 'denied', configurable: true })`);
  await closeAlerts();
  await openAlerts();
  check(
    'if the browser has blocked alerts, the dialog says how to allow them again',
    (await A.text('alertsStatus')).includes('blocked') &&
      (await A.text('alertsHowSteps')).includes('Settings') &&
      (await A.ev(`${byId('alertsOn')}.hidden && ${byId('alertsHow')}.open`)),
  );
  await closeAlerts();

  // Turning on: the browser's own answer decides. Headless Chrome has no push service, so the answer is a
  // clean message rather than a crash; on a real phone this is where the permission question appears.
  await A.ev(`delete Notification.permission; Notification.requestPermission = async () => 'granted'`);
  await openAlerts();
  await A.click('alertsOn');
  await A.waitFor(`${byId('alertsMsg')}.textContent !== ''`, 15000, 'an answer to Turn on');
  const answer = await A.text('alertsMsg');
  check('Turn on gives an answer on screen instead of failing silently', answer.length > 0, answer.slice(0, 100));
  check(
    'a failed attempt opens the steps and records what the browser said',
    (await A.ev(`${byId('alertsHow')}.open`)) && (await A.text('alertsDiag')).includes('last problem'),
    await A.text('alertsDiag'),
  );
  await closeAlerts();

  // The steps are there for this phone and browser, a failed attempt opens them, and a details line says what the browser reports.
  await A.ev(`Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true })`);
  await openAlerts();
  const how = await A.ev(
    `({ shown: !${byId('alertsHow')}.hidden, title: ${byId('alertsHowTitle')}.textContent, steps: ${byId('alertsHowSteps')}.textContent, diag: ${byId('alertsDiag')}.textContent })`,
  );
  check(
    'the dialog has numbered steps for allowing alerts, named for this phone and browser',
    how.shown &&
      how.title === 'How to allow alerts in Chrome on Android' &&
      how.steps.includes('tap your name at the top right of the game, then Turn alerts') &&
      how.steps.includes('Delete & reset') &&
      how.steps.includes('All sites') &&
      how.steps.includes('All notifications') &&
      how.steps.includes('padlock'),
    how.title,
  );
  check(
    'and a details line to read out if it still does not work',
    how.diag.includes('Android phone, Chrome') &&
      how.diag.includes('permission: default') &&
      how.diag.includes('alerts supported: yes'),
    how.diag,
  );
  await A.shot('2b-android-steps');
  await closeAlerts();

  // Turning everything off: a pretend phone is registered, listed, and removed with one button.
  const status = await A.ev(
    `(async () => {
      const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
      const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
      const auth = crypto.getRandomValues(new Uint8Array(16));
      const r = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-pretend-phone', keys: { p256dh: b64u(raw), auth: b64u(auth) } }, label: 'Pretend phone' }),
      });
      return r.status;
    })()`,
  );
  check('a pretend phone was registered for the test', status === 200, String(status));
  await openAlerts();
  check(
    'the dialog lists it, with a button to turn alerts off on all my devices',
    (await A.ev(
      `!${byId('alertsDevices')}.hidden && ${byId('alertsDeviceList')}.textContent.includes('Pretend phone')`,
    )) && (await A.ev(`!${byId('alertsOffAll')}.hidden`)),
  );
  await A.click('alertsOffAll');
  await A.waitFor(`${byId('alertsDevices')}.hidden`, 6000, 'the list emptying');
  check(
    'turning off on all devices empties the list, and says so',
    (await A.text('alertsMsg')).includes('off on all your devices') &&
      (await A.ev(`fetch('/api/push').then((r) => r.json()).then((j) => j.devices.length === 0)`)),
  );
  await closeAlerts();

  // ---------------- an iPhone in Safari ----------------
  await A.ev(`localStorage.clear()`);
  await setUa(UA.iphone);
  await reloadGame();
  await A.waitFor(`${byId('iosDlg')}.open`, 6000, 'the iPhone steps');
  const steps = (await A.text('iosDlg')).replace(/\s+/g, ' ');
  check(
    'iPhone: the first sign-in shows how to add the game to the Home Screen',
    ['Share', 'Add to Home Screen', 'Sign in again', 'iOS 16.4'].every((w) => steps.includes(w)),
  );
  check('and no one-tap bar competes with it', await A.ev(`${byId('alertsBanner')}.hidden`));
  await A.shot('3-iphone-steps');
  await A.click('iosOk');
  check('"Got it" closes it', await A.ev(`!${byId('iosDlg')}.open`));
  await reloadGame();
  check('it is not shown again on this phone', await A.ev(`!${byId('iosDlg')}.open`));
  await openAlerts();
  check(
    'the Turn alerts dialog still explains the Home Screen step, with a button to see the steps again',
    (await A.text('alertsStatus')).includes('Home Screen') &&
      (await A.ev(
        `${byId('alertsOn')}.hidden && [...${byId('alertsHelp')}.querySelectorAll('button')].some((b) => b.textContent === 'Show me how')`,
      )),
  );
  await A.ev(
    `[...${byId('alertsHelp')}.querySelectorAll('button')].find((b) => b.textContent === 'Show me how').click()`,
  );
  check('"Show me how" opens the steps', await A.ev(`${byId('iosDlg')}.open`));
  await A.click('iosOk');
  await closeAlerts();

  // ---------------- a computer ----------------
  await setUa(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  );
  await A.ev(`localStorage.clear()`);
  await A.desktop();
  await reloadGame();
  check(
    'a computer is not nagged: no bar, no steps (alerts are in the account menu)',
    await A.ev(`${byId('alertsBanner')}.hidden && !${byId('iosDlg')}.open`),
  );

  // ---------------- the solo win screen ----------------
  await A.click('modeSolo');
  await A.waitFor(`document.body.classList.contains('solo') && !${byId('tableMain')}.hidden`, 8000, 'solo table');
  await A.ev(`${byId('overlay')}.hidden = false`); // as when a round has just ended
  const shown = (id) => A.ev(`getComputedStyle(${byId(id)}).display !== 'none'`);
  check(
    'solo win screen: Play again, Change level or players and Close are there; Leave table, My solo stats and Go online are not',
    (await shown('againBtn')) &&
      (await shown('againNewBtn')) &&
      (await shown('endClose')) &&
      !(await shown('endLeave')) &&
      (await A.ev(`!document.getElementById('endStats') && !document.getElementById('endOnline')`)),
  );
  await A.click('endClose');
  check('Close lets you look at the finished table', await A.ev(`${byId('overlay')}.hidden`));
  await A.ev(`${byId('overlay')}.hidden = false`);
  await A.click('againNewBtn');
  check(
    '"Change level or players" opens the new-game settings with the current choices',
    await A.ev(`${byId('newGameDlg')}.open && ${byId('ngLevel')}.value === 'medium'`),
  );
  await A.ev(`${byId('ngLevel')}.value = 'easy'`);
  await A.click('ngStart');
  check(
    'starting from there plays a new game at the chosen level',
    await A.ev(
      `${byId('overlay')}.hidden && ${byId('soloChip')}.textContent.includes('Easy') && !${byId('newGameDlg')}.open`,
    ),
    await A.text('soloChip'),
  );
  await A.ev(`${byId('overlay')}.hidden = false`);
  await A.click('modeOnline');
  await A.waitFor(`document.body.classList.contains('online') && ${byId('overlay')}.hidden`, 8000, 'online lobby');
  check('the Online switch leaves the solo game for the online lobby', true);
  check('online, none of the solo-only buttons show', !(await shown('againNewBtn')) && !(await shown('endClose')));

  // ---------------- ending and creating seasons ----------------
  await A.click('who');
  await A.click('adminBtn');
  await A.waitFor(`!${byId('admin')}.hidden && ${byId('seasonsBody')}.children.length >= 1`, 8000, 'admin screen');
  const rows = () =>
    A.ev(
      `[...document.querySelectorAll('#seasonsBody tr')].map((r) => [...r.children].slice(0, 4).map((c) => c.textContent).join('|'))`,
    );
  check(
    'a running season shows an End now button',
    await A.ev(`[...document.querySelectorAll('#seasonsBody button')].some((b) => b.textContent === 'End now')`),
  );
  // Before ending it, a new season clashes with it, and the message says what to do.
  await A.ev(
    `document.querySelectorAll('#seasonPicks input').forEach((i) => { if (!i.checked) i.click(); }); ${byId('seasonName')}.value = 'Autumn'; ${byId('seasonSave')}.click()`,
  );
  await A.waitFor(`${byId('seasonMsg')}.textContent.includes('End now')`, 6000, 'the clash message');
  check('creating a season while one is running explains why not, and what to press', true, await A.text('seasonMsg'));
  await A.clickButton('#seasonsBody', 'End now');
  const saysEnd = await A.confirmPopup();
  check(
    'End now asks in a popup that says what happens',
    /End Season 1 now\?/.test(saysEnd) && saysEnd.includes('not scored'),
    saysEnd,
  );
  await A.waitFor(`document.querySelector('#seasonsBody tr').children[1].textContent === 'past'`, 6000, 'season ended');
  check('End now (confirmed) ends the season at once', (await rows())[0].includes('past'), (await rows())[0]);
  check(
    'and its End now button is gone',
    await A.ev(`![...document.querySelectorAll('#seasonsBody button')].some((b) => b.textContent === 'End now')`),
  );
  // With the start left empty (meaning now), a new season can be made in one step.
  await A.ev(
    `${byId('seasonName')}.value = 'Autumn'; ${byId('seasonStart')}.value = ''; ${byId('seasonSave')}.click()`,
  );
  await A.waitFor(
    `[...document.querySelectorAll('#seasonsBody tr')].some((r) => r.children[0].textContent === 'Autumn' && r.children[1].textContent === 'active')`,
    6000,
    'Autumn running',
  );
  check('a new season with the start left empty begins now and is running', true, (await rows()).join('  //  '));
  await A.shot('4-seasons');
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

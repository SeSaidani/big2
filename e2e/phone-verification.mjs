// Phone numbers in a real browser: an admin creates a user with a number, the user is held at the
// gate until they confirm it with a texted code (the console provider "sends" it to the server's
// output, which this script reads), and only then can join a game. Also: a number is required.
import { launch, newPage, sleep, outDir } from './lib.mjs';

const OUT = outDir(process.argv[2]);
const PORT = 8769;
const CDP = 9336;
const BASE = `http://127.0.0.1:${PORT}/`;
const ADMIN_PW = 'admin-password-123';
const TEMP_PW = 'temporary-pass-1';
const DANA_PHONE = '+447700900123';

const results = [];
const check = (label, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) throw new Error('check failed: ' + label);
};

const env = await launch({ port: PORT, cdp: CDP, tmpPrefix: 'big2-e2e-phone-', extraEnv: { SMS_PROVIDER: 'console' } });
let A;
let D;

// The most recent "texted" code in the server's output.
const lastCode = () => {
  const all = [...env.state.out.matchAll(/Big Two code: (\d{6})/g)];
  return all.length ? all[all.length - 1][1] : null;
};

async function main() {
  console.log('CLI:', env.makeAdmin('boss', ADMIN_PW).stdout.trim());
  await env.state.start();
  A = await newPage(CDP, 'A', OUT);
  D = await newPage(CDP, 'D', OUT);

  // The admin (made at the command line: number set, counts as verified) signs in and creates a game.
  await A.goto(BASE);
  await A.waitFor(`document.querySelectorAll('#hand .card').length === 14`, 15000, 'page loads');
  await A.signIn('boss', ADMIN_PW);
  check('the command-line admin is not asked for a number', !(await A.ev(`document.getElementById('phoneDlg').open`)));
  await A.ev(`document.getElementById('newLevel').value='easy'; document.getElementById('createBtn').click()`);
  await A.waitFor(`!document.getElementById('waitRoom').hidden`, 8000, 'game created');

  // Creating a user needs a number: refused without one, with a clear message.
  await A.click('adminBtn');
  await A.waitFor(`!document.getElementById('admin').hidden`, 8000, 'admin screen');
  await A.ev(
    `document.getElementById('newUserName').value='dana'; document.getElementById('newUserPw').value=${JSON.stringify(TEMP_PW)}; document.getElementById('createUserBtn').click()`,
  );
  await A.waitFor(
    `document.getElementById('createUserMsg').textContent.includes('phone number is required')`,
    8000,
    'number required',
  );
  check('a user cannot be created without a phone number', true, await A.text('createUserMsg'));
  await A.ev(
    `document.getElementById('newUserPhone').value='07700 900123'; document.getElementById('createUserBtn').click()`,
  );
  await A.waitFor(
    `document.getElementById('createUserMsg').textContent.includes('country code')`,
    8000,
    'country code needed',
  );
  check('a number without a country code is refused', true, await A.text('createUserMsg'));
  await A.ev(
    `document.getElementById('newUserPhone').value=${JSON.stringify(DANA_PHONE.replace('+44', '+44 '))}; document.getElementById('createUserBtn').click()`,
  );
  await A.waitFor(
    `document.getElementById('createUserMsg').textContent.startsWith('Created dana')`,
    8000,
    'dana created',
  );
  const shown = await A.ev(
    `[...document.querySelectorAll('#usersBody tr')].find(r => r.children[0].textContent === 'dana').children[2].textContent`,
  );
  check('the admin sees the number masked and marked unverified', /^\+44•+123 \(not verified\)$/.test(shown), shown);
  await A.shot('1-admin-phone-column');

  // dana signs in: held at the gate, the phone dialog opens by itself.
  await D.goto(BASE);
  await D.waitFor(`document.querySelectorAll('#hand .card').length === 14`, 15000, 'D page loads');
  await D.signIn('dana', TEMP_PW);
  await D.waitFor(`document.getElementById('phoneDlg').open`, 8000, 'the phone dialog opens at sign-in');
  check('a user with an unverified number is taken to the phone dialog', true);
  check(
    'the dialog shows the masked number, never the whole one',
    (await D.text('phoneCurrent')).includes('•') && !(await D.text('phoneCurrent')).includes('7700'),
  );
  check('a code field is offered', await D.visible('phoneCodeField'));
  await D.shot('2-phone-dialog');
  await D.click('phoneClose');
  const gate = await D.text('gameBox');
  check(
    'the lobby will not let them join yet',
    gate.includes('Confirm your phone number') && !gate.includes('Join game'),
    gate.trim().slice(0, 60),
  );

  // Ask for a code, get it from the server's output, get it wrong, then right.
  await D.click('phoneBtn');
  await D.click('phoneResend');
  for (let i = 0; i < 50 && !lastCode(); i++) await sleep(100);
  const code = lastCode();
  check(
    'a code was texted (to the console provider)',
    !!code && /\[sms to \+44•+123\]/.test(env.state.out),
    `code ${code ? 'received' : 'missing'}`,
  );
  check(
    'the server output masks the number',
    !env.state.out.includes('7700900123') && !env.state.out.includes('7700 900123'),
  );
  await D.ev(
    `document.getElementById('phoneCode').value=${JSON.stringify(code === '000000' ? '111111' : '000000')}; document.getElementById('phoneVerify').click()`,
  );
  await D.waitFor(`document.getElementById('phoneMsg').textContent.includes('not right')`, 8000, 'wrong code message');
  check('a wrong code is refused', true, await D.text('phoneMsg'));
  await D.ev(
    `document.getElementById('phoneCode').value=${JSON.stringify(code)}; document.getElementById('phoneVerify').click()`,
  );
  await D.waitFor(`document.getElementById('phoneMsg').textContent.includes('Verified')`, 8000, 'verified');
  check(
    'the right code verifies the number',
    (await D.text('phoneState')).includes('verified') && !(await D.visible('phoneCodeField')),
  );
  await D.shot('3-verified');
  await D.click('phoneClose');
  await D.waitFor(
    `[...document.querySelectorAll('#gameBox button')].some(b => b.textContent === 'Join game')`,
    8000,
    'join offered',
  );
  check('once verified, they can join the game', true);

  // Texts can be switched off.
  await D.click('phoneBtn');
  await D.ev(`document.getElementById('smsToggle').click()`);
  await D.waitFor(`!document.getElementById('smsToggle').checked`, 5000, 'toggle off');
  const me = await D.ev(`fetch('/api/me').then(r => r.json())`);
  check('the "text me" switch is saved', me.user.smsEnabled === false);
  await D.click('phoneClose');

  // Self-registration needs a number too (the admin opens registration).
  await A.click('regBtn');
  await A.waitFor(`document.getElementById('regState').textContent.startsWith('Anyone')`, 8000, 'registration opened');
  await A.click('logoutBtn');
  await A.waitFor(`document.body.classList.contains('solo')`, 8000, 'log-out to finish');
  await A.click('modeOnline');
  await A.waitFor(`document.getElementById('loginDlg').open`, 8000, 'login dialog');
  check('the sign-in dialog asks for a number when sign-up is open', await A.visible('loginPhoneField'));
  await A.shot('4-register-with-phone');
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  console.log('FAILED:', err.message);
  for (const p of [A, D]) {
    try {
      if (p) await p.shot(`failure-${p.name}`);
    } catch {
      /* ignore */
    }
  }
}
for (const p of [A, D]) {
  if (p) console.log(`browser errors [${p.name}]:`, p.errors.length ? [...new Set(p.errors)] : 'none');
}
console.log(`${results.length} checks passed${failed ? ', then FAILED' : ''}`);
await env.cleanup();
process.exit(failed ? 1 : 0);

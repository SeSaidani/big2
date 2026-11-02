import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import {
  setUserPhone,
  accountPhone,
  createCode,
  checkCode,
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  logSms,
  lastSmsAt,
  countSms,
} from '../server/phones.js';
import { nextPhone } from './support.js';

const PW = 'a-long-enough-password';
const NOW = Date.UTC(2026, 5, 1);

async function twoUsers() {
  const db = openDb(':memory:');
  const a = await createUser(db, 'ann', PW, { phone: nextPhone() });
  const b = await createUser(db, 'bob', PW, { phone: nextPhone() });
  return { db, a, b };
}

test('an account cannot be created without a valid, unused phone number', async () => {
  const db = openDb(':memory:');
  const phone = nextPhone();
  for (const missing of [undefined, null, '']) {
    await assert.rejects(
      createUser(db, 'ann', PW, { phone: missing }),
      (e) => e.status === 400 && /required/.test(e.message),
    );
  }
  await assert.rejects(createUser(db, 'ann', PW), /required/);
  await assert.rejects(createUser(db, 'ann', PW, { phone: '07700 900123' }), /country code/);
  await assert.rejects(
    createUser(db, 'ann', PW, { phone: '+61 412 345 678', allowedPrefixes: ['+44'] }),
    /not supported/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0, 'nothing half-created');
  await createUser(db, 'ann', PW, { phone: phone.replace('+44', '+44 ') });
  await assert.rejects(createUser(db, 'bob', PW, { phone }), (e) => e.status === 409 && /already used/.test(e.message));
  await assert.rejects(
    createUser(db, 'ANN', PW, { phone: nextPhone() }),
    (e) => e.status === 409 && /name is taken/.test(e.message),
  );
  assert.equal(db.prepare('SELECT phone FROM users WHERE name = ?').get('ann').phone, phone, 'stored in E.164');
});

test('what a user sees of their own number: masked, with what is still to do', async () => {
  const { db, a } = await twoUsers();
  const withCodes = accountPhone(db, a.id, { verificationRequired: true });
  assert.match(withCodes.phone, /^\+44•+\d{3}$/);
  assert.deepEqual([withCodes.phoneVerified, withCodes.phoneRequired, withCodes.needsCode], [false, true, true]);
  const without = accountPhone(db, a.id, { verificationRequired: false });
  assert.deepEqual([without.phoneRequired, without.needsCode], [false, false], 'no provider, so nothing to verify');
  db.prepare('UPDATE users SET phone = NULL WHERE id = ?').run(a.id); // an account from before the rule
  const legacy = accountPhone(db, a.id, { verificationRequired: false });
  assert.deepEqual([legacy.phone, legacy.phoneRequired], [null, true]);
  assert.equal(accountPhone(db, 9999, { verificationRequired: true }), null);
});

test('a code verifies the number; it is single-use, hashed and six digits', async () => {
  const { db, a } = await twoUsers();
  const { code, phone } = createCode(db, a.id, NOW);
  assert.match(code, /^\d{6}$/);
  assert.equal(phone, db.prepare('SELECT phone FROM users WHERE id = ?').get(a.id).phone);
  const stored = db.prepare('SELECT * FROM phone_codes WHERE user_id = ?').get(a.id);
  assert.ok(!JSON.stringify(stored).includes(code), 'the code itself is never stored');
  assert.throws(
    () => checkCode(db, a.id, '000000', NOW + 1000),
    (e) => e.message === 'That code is not right.',
  );
  checkCode(db, a.id, ` ${code} `, NOW + 2000); // surrounding spaces are forgiven
  assert.equal(accountPhone(db, a.id, { verificationRequired: true }).phoneVerified, true);
  assert.throws(() => checkCode(db, a.id, code, NOW + 3000), /Ask for a new code/, 'a used code is gone');
});

test('codes expire, are limited to five tries, and die if the number changes', async () => {
  const { db, a, b } = await twoUsers();
  const first = createCode(db, a.id, NOW);
  assert.throws(() => checkCode(db, a.id, first.code, NOW + CODE_TTL_MS), /expired/);
  assert.throws(() => checkCode(db, a.id, first.code, NOW + 1), /Ask for a new code/, 'an expired code is dropped');

  const second = createCode(db, a.id, NOW);
  const wrong = second.code === '123456' ? '654321' : '123456';
  for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) assert.throws(() => checkCode(db, a.id, wrong, NOW + 10), /not right/);
  assert.throws(
    () => checkCode(db, a.id, second.code, NOW + 11),
    (e) => e.status === 429,
    'even the right code is refused now',
  );
  assert.throws(() => checkCode(db, a.id, second.code, NOW + 12), /Ask for a new code/);

  const third = createCode(db, a.id, NOW);
  setUserPhone(db, a.id, nextPhone());
  assert.throws(
    () => checkCode(db, a.id, third.code, NOW + 1),
    /Ask for a new code/,
    'changing the number clears the pending code',
  );
  const fourth = createCode(db, a.id, NOW);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM phone_codes').get().n, 1, 'one pending code per user');
  assert.notEqual(fourth.phone, third.phone);

  // One person's code does not verify another's number.
  const forB = createCode(db, b.id, NOW);
  assert.throws(() => checkCode(db, a.id, forB.code, NOW + 1), /not right/);
  assert.throws(() => createCode(db, 9999, NOW), /phone number first/);
});

test('changing the number resets verification; two accounts cannot share a number', async () => {
  const { db, a, b } = await twoUsers();
  const { code } = createCode(db, a.id, NOW);
  checkCode(db, a.id, code, NOW + 1);
  assert.equal(accountPhone(db, a.id, { verificationRequired: true }).phoneVerified, true);
  const bobsNumber = db.prepare('SELECT phone FROM users WHERE id = ?').get(b.id).phone;
  assert.throws(
    () => setUserPhone(db, a.id, bobsNumber),
    (e) => e.status === 409,
  );
  assert.equal(
    accountPhone(db, a.id, { verificationRequired: true }).phoneVerified,
    true,
    'a refused change changes nothing',
  );
  setUserPhone(db, a.id, nextPhone());
  assert.equal(accountPhone(db, a.id, { verificationRequired: true }).phoneVerified, false);
  assert.throws(
    () => setUserPhone(db, 9999, nextPhone()),
    (e) => e.status === 404,
  );
});

test('the send log drives cooldowns: only successful sends count', async () => {
  const { db, a } = await twoUsers();
  assert.equal(lastSmsAt(db, a.id, 'turn'), null);
  logSms(db, a.id, 'turn', false, NOW);
  assert.equal(lastSmsAt(db, a.id, 'turn'), null, 'a failed send is not a send');
  logSms(db, a.id, 'turn', true, NOW + 5);
  logSms(db, a.id, 'verify', true, NOW + 9);
  assert.equal(lastSmsAt(db, a.id, 'turn'), NOW + 5);
  assert.equal(countSms(db, a.id, 'turn', NOW), 1);
  assert.equal(countSms(db, a.id, 'turn', NOW + 6), 0);
  assert.equal(countSms(db, a.id, 'verify', 0), 1);
});

test('an old database gains the phone columns without losing users, who are then asked for a number', async () => {
  const db = openDb(':memory:');
  db.exec("INSERT INTO users (name, pw_hash, created) VALUES ('legacy', 'x', 1)");
  const row = db.prepare('SELECT phone, phone_verified, sms_enabled, sms_blocked FROM users').get();
  assert.deepEqual({ ...row }, { phone: null, phone_verified: 0, sms_enabled: 1, sms_blocked: 0 });
  const id = db.prepare('SELECT id FROM users').get().id;
  assert.equal(accountPhone(db, id, { verificationRequired: false }).phoneRequired, true);
  // The unique index only constrains real numbers: any number of legacy accounts may have none.
  db.exec("INSERT INTO users (name, pw_hash, created) VALUES ('legacy2', 'x', 1)");
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { setUserPhone, setSmsEnabled, textingRow, logSms, countSms } from '../server/phones.js';
import { TurnNotifier } from '../server/notify.js';
import { SmsError, createSmsProvider } from '../server/sms/index.js';
import { nextPhone, sleep } from './support.js';

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

async function setup({ online = false, config = {}, provider } = {}) {
  const db = openDb(':memory:');
  const phone = nextPhone();
  const user = await createUser(db, 'ann', 'a-long-enough-password', { phone, verified: true });
  const sms = provider ?? createSmsProvider({ provider: 'console', quiet: true });
  const clock = { t: NOW };
  const state = { online };
  const logs = [];
  const notifier = new TurnNotifier({
    db,
    provider: sms,
    isOnline: () => state.online,
    config: { delayMs: 15, retryDelayMs: 1, now: () => clock.t, ...config },
    log: (...a) => logs.push(a.join(' ')),
  });
  return { db, user, phone, sms, clock, state, logs, notifier };
}

test('a text goes to someone who is away, and says nothing about the cards', async () => {
  const { notifier, user, sms, phone } = await setup({ config: { baseUrl: 'https://big2.example.com' } });
  assert.equal(await notifier.consider(user.id), 'sent');
  assert.equal(sms.outbox.length, 1);
  assert.equal(sms.outbox[0].to, phone);
  assert.equal(sms.outbox[0].body, "Big Two: it's your turn. https://big2.example.com");
  assert.ok(sms.outbox[0].body.length <= 160, 'fits one text');
  const { notifier: bare, user: u2, sms: s2 } = await setup();
  await bare.consider(u2.id);
  assert.equal(s2.outbox[0].body, "Big Two: it's your turn.", 'no link when no public address is configured');
});

test('no text while they are on the page (unless texting is set to "always")', async () => {
  const away = await setup({ online: true });
  assert.equal(await away.notifier.consider(away.user.id), 'online');
  assert.equal(away.sms.outbox.length, 0);
  const always = await setup({ online: true, config: { when: 'always' } });
  assert.equal(await always.notifier.consider(always.user.id), 'sent');
});

test('who is never texted: no number, switched off, opted out, unverified, no provider', async () => {
  const s = await setup();
  setSmsEnabled(s.db, s.user.id, false);
  assert.equal(await s.notifier.consider(s.user.id), 'switched-off');
  setSmsEnabled(s.db, s.user.id, true);
  s.db.prepare('UPDATE users SET sms_blocked = 1 WHERE id = ?').run(s.user.id);
  assert.equal(await s.notifier.consider(s.user.id), 'blocked');
  setUserPhone(s.db, s.user.id, s.phone); // setting the number again lifts the block, and clears verification
  assert.equal(await s.notifier.consider(s.user.id), 'unverified');
  s.db.prepare('UPDATE users SET phone_verified = 1 WHERE id = ?').run(s.user.id);
  assert.equal(await s.notifier.consider(s.user.id), 'sent');
  s.db.prepare('UPDATE users SET phone = NULL WHERE id = ?').run(s.user.id);
  assert.equal(await s.notifier.consider(s.user.id), 'no-phone');
  assert.equal(await s.notifier.consider(99999), 'no-phone');

  const off = await setup({ provider: createSmsProvider({ provider: 'none' }) });
  assert.equal(await off.notifier.consider(off.user.id), 'no-provider');
  // If verification is not required (no provider to send codes), unverified numbers can still be texted.
  const lax = await setup({ config: { requireVerified: false } });
  lax.db.prepare('UPDATE users SET phone_verified = 0 WHERE id = ?').run(lax.user.id);
  assert.equal(await lax.notifier.consider(lax.user.id), 'sent');
});

test('cooldown and daily cap are enforced from the database, so a restart cannot cause a repeat', async () => {
  const s = await setup({ config: { cooldownMs: 10 * 60_000, maxPerDay: 3 } });
  assert.equal(await s.notifier.consider(s.user.id), 'sent');
  s.clock.t += 5 * 60_000;
  assert.equal(await s.notifier.consider(s.user.id), 'cooldown');
  // A brand-new notifier on the same database (a restart) still sees the first text.
  const restarted = new TurnNotifier({
    db: s.db,
    provider: s.sms,
    isOnline: () => false,
    config: { cooldownMs: 10 * 60_000, maxPerDay: 3, now: () => s.clock.t },
  });
  assert.equal(await restarted.consider(s.user.id), 'cooldown');
  s.clock.t += 6 * 60_000;
  assert.equal(await s.notifier.consider(s.user.id), 'sent');
  s.clock.t += 11 * 60_000;
  assert.equal(await s.notifier.consider(s.user.id), 'sent');
  s.clock.t += 11 * 60_000;
  assert.equal(await s.notifier.consider(s.user.id), 'daily-cap', 'a fourth text inside 24 hours');
  s.clock.t += 25 * 60 * 60_000;
  assert.equal(await s.notifier.consider(s.user.id), 'sent', 'the cap resets after a day');
  assert.equal(s.sms.outbox.length, 4);
});

test('the turn must still be theirs after the delay; a newer turn replaces the pending one', async () => {
  const s = await setup({ config: { delayMs: 20 } });
  let theirTurn = true;
  s.notifier.schedule(s.user.id, () => theirTurn);
  theirTurn = false; // they moved (or the game ended) inside the delay
  await sleep(60);
  assert.equal(s.sms.outbox.length, 0);

  s.notifier.schedule(s.user.id, () => true);
  s.notifier.schedule(s.user.id, () => true); // scheduling again replaces, never doubles
  await sleep(80);
  assert.equal(s.sms.outbox.length, 1);

  const stopped = await setup({ config: { delayMs: 20 } });
  stopped.notifier.schedule(stopped.user.id, () => true);
  stopped.notifier.stop();
  await sleep(50);
  assert.equal(stopped.sms.outbox.length, 0);
  // Without a provider nothing is even scheduled.
  const none = await setup({ provider: createSmsProvider({ provider: 'none' }), config: { delayMs: 5 } });
  none.notifier.schedule(none.user.id, () => true);
  assert.equal(none.notifier.timers.size, 0);
});

test('failures: a retryable error is tried once more; permanent ones are not; opted-out switches texting off', async () => {
  const flaky = (errors) => {
    let n = 0;
    const calls = [];
    return {
      name: 'flaky',
      canSend: true,
      calls,
      async send(msg) {
        calls.push(msg);
        const err = errors[n++];
        if (err) throw err;
        return { id: 'ok' };
      },
    };
  };
  const retry = await setup({ provider: flaky([new SmsError('busy', { retryable: true })]) });
  assert.equal(await retry.notifier.consider(retry.user.id), 'sent');
  assert.equal(retry.sms.calls.length, 2);

  const twice = await setup({
    provider: flaky([new SmsError('busy', { retryable: true }), new SmsError('still busy', { retryable: true })]),
  });
  assert.equal(await twice.notifier.consider(twice.user.id), 'failed');
  assert.equal(twice.sms.calls.length, 2, 'two attempts, no more');
  assert.equal(countSms(twice.db, twice.user.id, 'turn', 0), 0, 'a failed text does not use up the allowance');

  const permanent = await setup({ provider: flaky([new SmsError('bad number', { retryable: false })]) });
  assert.equal(await permanent.notifier.consider(permanent.user.id), 'failed');
  assert.equal(permanent.sms.calls.length, 1);
  assert.equal(textingRow(permanent.db, permanent.user.id).blocked, false);

  const stop = await setup({ provider: flaky([new SmsError('opted out', { optedOut: true })]) });
  assert.equal(await stop.notifier.consider(stop.user.id), 'failed');
  assert.equal(textingRow(stop.db, stop.user.id).blocked, true);
  assert.equal(await stop.notifier.consider(stop.user.id), 'blocked');

  // Logs name the number only in masked form.
  assert.ok(
    stop.logs.every((l) => !l.includes(stop.phone)),
    stop.logs.join('\n'),
  );
  assert.ok(stop.logs.some((l) => l.includes('+44')));
});

test('an unexpected provider crash never escapes into the game', async () => {
  const s = await setup({
    config: { delayMs: 5 },
    provider: {
      name: 'broken',
      canSend: true,
      async send() {
        throw new TypeError('provider bug');
      },
    },
  });
  s.notifier.schedule(s.user.id, () => true);
  await sleep(60);
  assert.equal(await s.notifier.consider(s.user.id), 'failed');
  logSms(s.db, s.user.id, 'turn', false); // (and failures are recorded)
});

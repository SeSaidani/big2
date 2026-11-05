import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { countPush, logPush } from '../server/push-store.js';
import { TurnNotifier } from '../server/notify.js';
import { sleep, newDevice } from './support.js';

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

// A pusher that records what it was asked to send. `delivered` is how many devices accept each message.
function fakePusher({ delivered = 1, canSend = true } = {}) {
  const calls = [];
  return {
    canSend,
    calls,
    delivered,
    async sendToUser(userId, message) {
      calls.push({ userId, message });
      if (this.delivered instanceof Error) throw this.delivered;
      return { devices: 1, delivered: this.delivered, removed: 0 };
    },
  };
}

// The turn began at NOW; the clock is moved forward to see what is sent when.
async function setup({ config = {}, pusher = fakePusher(), device = true } = {}) {
  const db = openDb(':memory:');
  const user = await createUser(db, 'ann', 'a-long-enough-password');
  if (device) newDevice(db, user.id);
  const clock = { t: NOW };
  const logs = [];
  const make = () =>
    new TurnNotifier({ db, pusher, config: { now: () => clock.t, ...config }, log: (...a) => logs.push(a.join(' ')) });
  const at = (ms) => {
    clock.t = NOW + ms;
  };
  return { db, user, pusher, clock, logs, notifier: make(), make, at };
}

test('the first alert goes after 20 minutes of not playing, and says nothing about the cards', async () => {
  const s = await setup();
  s.at(0);
  assert.equal(await s.notifier.consider(s.user.id, NOW), 'too-soon');
  s.at(20 * MIN - 1);
  assert.equal(await s.notifier.consider(s.user.id, NOW), 'too-soon', 'one millisecond early');
  s.at(20 * MIN);
  assert.equal(await s.notifier.consider(s.user.id, NOW), 'sent');
  assert.equal(s.pusher.calls.length, 1);
  assert.equal(s.pusher.calls[0].userId, s.user.id);
  assert.deepEqual(s.pusher.calls[0].message, { title: 'Big Two', body: "It's your turn.", url: '/', tag: 'turn' });
  assert.equal(countPush(s.db, s.user.id, 0), 1);
});

test('one more alert after 24 hours if it is still their turn, and never a third', async () => {
  const s = await setup();
  s.at(20 * MIN);
  assert.equal(await s.notifier.consider(s.user.id, NOW), 'sent');
  s.at(20 * MIN + 5);
  assert.equal(await s.notifier.consider(s.user.id, NOW), 'too-soon', 'the second waits for 24 hours');
  s.at(23 * HOUR);
  assert.equal(await s.notifier.consider(s.user.id, NOW), 'too-soon');
  s.at(24 * HOUR);
  assert.equal(await s.notifier.consider(s.user.id, NOW), 'sent');
  assert.equal(s.pusher.calls[1].message.body, "It's still your turn.");
  for (const hours of [25, 48, 200]) {
    s.at(hours * HOUR);
    assert.equal(await s.notifier.consider(s.user.id, NOW), 'enough', 'two is the most for one turn');
  }
  assert.equal(s.pusher.calls.length, 2);
  // The next turn starts afresh: its own two alerts.
  const next = NOW + 300 * HOUR;
  s.at(300 * HOUR + 20 * MIN);
  assert.equal(await s.notifier.consider(s.user.id, next), 'sent');
  assert.equal(s.pusher.calls[2].message.body, "It's your turn.");
});

test('a restart cannot repeat an alert: what was sent is read from the database', async () => {
  const s = await setup();
  s.at(20 * MIN);
  assert.equal(await s.notifier.consider(s.user.id, NOW), 'sent');
  const restarted = s.make(); // a brand-new notifier on the same database
  assert.equal(await restarted.consider(s.user.id, NOW), 'too-soon', 'the first is out; the second is for later');
  s.at(24 * HOUR);
  assert.equal(await restarted.consider(s.user.id, NOW), 'sent');
  assert.equal(await s.make().consider(s.user.id, NOW), 'enough');
  assert.equal(s.pusher.calls.length, 2);
});

test('after a long outage one alert catches up, not two in a row', async () => {
  const s = await setup();
  s.at(30 * HOUR); // the server was down from before 20 minutes until now
  assert.equal(await s.notifier.consider(s.user.id, NOW), 'sent');
  assert.equal(await s.notifier.consider(s.user.id, NOW), 'caught-up');
  assert.equal(s.pusher.calls.length, 1);
  s.at(31 * HOUR);
  assert.equal(await s.notifier.consider(s.user.id, NOW), 'caught-up');
});

test('nobody is alerted without a device, or when the pusher cannot send', async () => {
  const s = await setup({ device: false });
  s.at(20 * MIN);
  assert.equal(await s.notifier.consider(s.user.id, NOW), 'no-device');
  assert.equal(await s.notifier.consider(99999, NOW), 'no-device');
  const off = await setup({ pusher: fakePusher({ canSend: false }) });
  off.at(20 * MIN);
  assert.equal(await off.notifier.consider(off.user.id, NOW), 'no-pusher');
  assert.equal(s.pusher.calls.length + off.pusher.calls.length, 0);
});

test('a turn nobody received does not use up the allowance, and a crash never escapes', async () => {
  const s = await setup({ pusher: fakePusher({ delivered: 0 }) });
  s.at(20 * MIN);
  assert.equal(await s.notifier.consider(s.user.id, NOW), 'failed');
  assert.equal(countPush(s.db, s.user.id, 0), 0, 'a failed alert is not counted as sent');
  s.pusher.delivered = 1;
  assert.equal(await s.notifier.consider(s.user.id, NOW), 'sent', 'so it is tried again');

  const crash = await setup({ pusher: fakePusher({ delivered: new TypeError('push bug') }) });
  crash.at(20 * MIN);
  crash.notifier.schedule(crash.user.id, NOW, () => true); // due at once; the crash is caught and logged
  await sleep(60);
  assert.ok(
    crash.logs.some((l) => l.includes('turn alert failed unexpectedly')),
    crash.logs.join('\n'),
  );
  crash.notifier.stop();
});

test('the safety cap per person per 24 hours holds across turns', async () => {
  const s = await setup({ config: { maxPerDay: 3 } });
  const results = [];
  for (let k = 0; k < 4; k++) {
    const since = NOW + k * 30 * MIN; // four turns, each left for 20 minutes
    s.clock.t = since + 20 * MIN;
    results.push(await s.notifier.consider(s.user.id, since));
  }
  assert.deepEqual(results, ['sent', 'sent', 'sent', 'daily-cap']);
  const since = NOW + 25 * HOUR; // a day later the allowance has come back
  s.clock.t = since + 20 * MIN;
  assert.equal(await s.notifier.consider(s.user.id, since), 'sent');
});

test('timers: both alerts are timed from when the turn began, and only if it is still their turn', async () => {
  const pusher = fakePusher();
  const s = await setup({ pusher, config: { firstAfterMs: 20, secondAfterMs: 120, now: Date.now } });
  let theirTurn = true;
  s.notifier.schedule(s.user.id, Date.now(), () => theirTurn);
  await sleep(70);
  assert.equal(pusher.calls.length, 1, 'the first');
  theirTurn = false; // they moved before the second time
  await sleep(150);
  assert.equal(pusher.calls.length, 1, 'no second alert for a turn they played');

  // Scheduling again (a newer turn) replaces the pending timers, never doubles them; stop() clears them.
  const quiet = fakePusher();
  const u = new TurnNotifier({ db: s.db, pusher: quiet, config: { firstAfterMs: 30, secondAfterMs: 5000 } });
  u.schedule(s.user.id, Date.now() + 10_000, () => true);
  u.schedule(s.user.id, Date.now() + 10_000, () => true);
  assert.equal(u.timers.get(s.user.id).length, 2);
  u.stop();
  assert.equal(u.timers.size, 0);
  await sleep(60);
  assert.equal(quiet.calls.length, 0, 'stopped timers send nothing');

  // A turn that began long ago fires straight away (the restart case): one catch-up alert, not two.
  const db2 = openDb(':memory:');
  const bea = await createUser(db2, 'bea', 'a-long-enough-password');
  newDevice(db2, bea.id);
  const late = fakePusher();
  const lateNotifier = new TurnNotifier({ db: db2, pusher: late, config: {} });
  lateNotifier.schedule(bea.id, Date.now() - 25 * HOUR, () => true);
  await sleep(80);
  assert.equal(late.calls.length, 1);
  lateNotifier.stop();

  // Without a way to send nothing is even scheduled.
  const none = await setup({ pusher: fakePusher({ canSend: false }) });
  none.notifier.schedule(none.user.id, NOW, () => true);
  assert.equal(none.notifier.timers.size, 0);
  logPush(s.db, s.user.id, false); // (failures are recorded too)
});

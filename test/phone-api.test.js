import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/cards.js';
import { createSmsProvider } from '../server/sms/index.js';
import { recentAudit } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { PASSWORD, boot, sleep, until, Client, makeUser, nextPhone } from './support.js';

// A server with a recording (console) provider, so we can read the texts it "sends".
const withSms = (extra = {}) => {
  const smsProvider = createSmsProvider({ provider: 'console', quiet: true });
  return { smsProvider, ...extra };
};
const codeFrom = (provider) => /code: (\d{6})/.exec(provider.outbox.at(-1).body)[1];

// The admin creates a user (unverified), the user signs in.
async function newbie(ctx, admin, name, phone = nextPhone()) {
  const made = await admin.req('POST', '/api/admin/users', { name, password: PASSWORD, phone });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const c = new Client(ctx.base);
  await c.login(name);
  return { c, phone };
}

test('a new user must verify their number by a texted code before they can join a game', async () => {
  const smsProvider = createSmsProvider({ provider: 'console', quiet: true });
  const ctx = await boot({ smsProvider });
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    await admin.req('POST', '/api/game', { aiLevel: 'easy' });
    const { c, phone } = await newbie(ctx, admin, 'newbie');

    const me = (await c.req('GET', '/api/me')).json.user;
    assert.deepEqual([me.phoneRequired, me.needsCode, me.phoneVerified], [true, true, false]);
    assert.match(me.phone, /^\+44•+\d{3}$/);
    // Until verified, joining is refused, with the reason.
    const refused = await c.req('POST', '/api/game/join');
    assert.equal(refused.status, 403);
    assert.match(refused.json.error, /phone number/);

    // Ask for a code; it arrives as a text to the number on file (and only that).
    assert.equal((await c.req('POST', '/api/phone/resend')).status, 200);
    assert.equal(smsProvider.outbox.length, 1);
    assert.equal(smsProvider.outbox[0].to, phone);
    assert.match(smsProvider.outbox[0].body, /^Big Two code: \d{6}\. It expires in 10 minutes\./);
    const code = codeFrom(smsProvider);

    assert.equal(
      (await c.req('POST', '/api/phone/verify', { code: code === '000000' ? '111111' : '000000' })).status,
      400,
    );
    const ok = await c.req('POST', '/api/phone/verify', { code });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.user.phoneRequired, false);
    assert.equal((await c.req('POST', '/api/game/join')).status, 200, 'verified, so they can join');
    assert.equal((await c.req('POST', '/api/phone/resend')).status, 409, 'nothing left to verify');
    assert.deepEqual(ctx.logs, []);
  } finally {
    await ctx.app.close();
  }
});

test('the whole number never leaves the server: masked everywhere, absent from the audit log', async () => {
  const smsProvider = createSmsProvider({ provider: 'console', quiet: true });
  const ctx = await boot({ smsProvider });
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    const { c, phone } = await newbie(ctx, admin, 'newbie');
    const digits = phone.slice(1);
    const responses = [
      await c.req('GET', '/api/me'),
      await admin.req('GET', '/api/admin/users'),
      await admin.req('GET', '/api/admin/overview'),
      await admin.req('GET', '/api/admin/audit?limit=200'),
      await c.req('GET', '/api/leaderboard?kind=human'),
      await c.req('GET', '/api/game'),
      await c.req('POST', '/api/phone', { phone: nextPhone() }),
    ];
    for (const r of responses) {
      const text = JSON.stringify(r.json);
      assert.ok(
        !text.includes(digits) && !text.includes(phone),
        `a response contains the whole number: ${text.slice(0, 120)}`,
      );
    }
    const listed = (await admin.req('GET', '/api/admin/users')).json.users.find((u) => u.name === 'newbie');
    assert.match(listed.phone, /^\+44•+\d{3}$/);
    assert.equal(listed.phoneVerified, false);
    for (const e of recentAudit(ctx.app.db, 200)) assert.ok(!JSON.stringify(e).includes(digits));
    const text = JSON.stringify(ctx.logs);
    assert.ok(!text.includes(digits));
  } finally {
    await ctx.app.close();
  }
});

test('every way of making an account needs a number: admin, self-registration, and it is validated', async () => {
  const ctx = await boot(withSms());
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    const create = (body) => admin.req('POST', '/api/admin/users', { name: 'someone', password: PASSWORD, ...body });
    assert.equal((await create({})).status, 400);
    assert.equal((await create({ phone: '' })).status, 400);
    assert.equal((await create({ phone: '07700 900123' })).status, 400, 'no country code');
    assert.equal((await create({ phone: 'call me' })).status, 400);
    const good = nextPhone();
    assert.equal((await create({ phone: good })).status, 201);
    const dup = await admin.req('POST', '/api/admin/users', { name: 'other', password: PASSWORD, phone: good });
    assert.equal(dup.status, 409);
    assert.match(dup.json.error, /already used/);

    await admin.req('POST', '/api/admin/settings', { registrationOpen: true });
    const guest = new Client(ctx.base);
    assert.equal((await guest.req('POST', '/api/register', { name: 'selfie', password: PASSWORD })).status, 400);
    const registered = await guest.req('POST', '/api/register', {
      name: 'selfie',
      password: PASSWORD,
      phone: nextPhone(),
    });
    assert.equal(registered.status, 201);
    assert.equal(registered.json.user.needsCode, true);
  } finally {
    await ctx.app.close();
  }
});

test('countries can be restricted by prefix', async () => {
  const ctx = await boot(withSms({ phoneAllowedPrefixes: ['+44'] }));
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    const create = (phone) =>
      admin.req('POST', '/api/admin/users', { name: `u${phone.slice(-4)}`, password: PASSWORD, phone });
    assert.equal((await create('+61412345678')).status, 400);
    assert.equal((await create('+447700912345')).status, 201);
  } finally {
    await ctx.app.close();
  }
});

test('an existing account with no number is held at the gate until it adds one; admins can set one too', async () => {
  const smsProvider = createSmsProvider({ provider: 'console', quiet: true });
  const ctx = await boot({ smsProvider });
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    // An account from before the rule: made directly, then its number removed.
    await createUser(ctx.app.db, 'legacy', PASSWORD, { phone: nextPhone() });
    ctx.app.db.prepare('UPDATE users SET phone = NULL WHERE name = ?').run('legacy');
    const c = new Client(ctx.base);
    await c.login('legacy');
    const me = (await c.req('GET', '/api/me')).json.user;
    assert.deepEqual([me.phone, me.phoneRequired, me.needsCode], [null, true, false]);
    await admin.req('POST', '/api/game', { aiLevel: 'easy' });
    assert.equal((await c.req('POST', '/api/game/join')).status, 403);
    assert.equal((await c.req('POST', '/api/phone/resend')).status, 409, 'cannot be sent a code with no number');

    assert.equal((await c.req('POST', '/api/phone', { phone: 'nope' })).status, 400);
    const set = await c.req('POST', '/api/phone', { phone: nextPhone() });
    assert.equal(set.status, 200);
    assert.equal(set.json.codeSent, true);
    assert.equal((await c.req('POST', '/api/phone/verify', { code: codeFrom(smsProvider) })).status, 200);
    assert.equal((await c.req('POST', '/api/game/join')).status, 200);

    // An admin can set someone's number (e.g. a typo); they must re-verify it.
    const target = (await admin.req('GET', '/api/admin/users')).json.users.find((u) => u.name === 'legacy');
    assert.equal((await admin.req('POST', `/api/admin/users/${target.id}/phone`, { phone: 'bad' })).status, 400);
    assert.equal((await admin.req('POST', `/api/admin/users/${target.id}/phone`, { phone: nextPhone() })).status, 200);
    assert.equal((await c.req('GET', '/api/me')).json.user.needsCode, true);
    assert.equal(recentAudit(ctx.app.db)[0].action, 'set_phone');
    const pleb = await makeUser(ctx, 'pleb');
    assert.equal((await pleb.req('POST', `/api/admin/users/${target.id}/phone`, { phone: nextPhone() })).status, 403);
  } finally {
    await ctx.app.close();
  }
});

test('code requests are rate limited, and a failing provider says so without leaving a code behind', async () => {
  const smsProvider = createSmsProvider({ provider: 'console', quiet: true });
  const ctx = await boot({ smsProvider });
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    const { c } = await newbie(ctx, admin, 'newbie');
    for (let i = 0; i < 3; i++) assert.equal((await c.req('POST', '/api/phone/resend')).status, 200);
    const limited = await c.req('POST', '/api/phone/resend');
    assert.equal(limited.status, 429);
    assert.equal(smsProvider.outbox.length, 3, 'the fourth request sent nothing');

    // A provider that fails: a clear error, and no usable code remains.
    const down = createSmsProvider({ provider: 'console', quiet: true });
    down.send = async () => {
      throw new Error('carrier is down');
    };
    const ctx2 = await boot({ smsProvider: down });
    try {
      const admin2 = await makeUser(ctx2, 'boss', { isAdmin: true });
      const { c: c2 } = await newbie(ctx2, admin2, 'newbie');
      const r = await c2.req('POST', '/api/phone/resend');
      assert.equal(r.status, 502);
      assert.equal(ctx2.app.db.prepare('SELECT COUNT(*) AS n FROM phone_codes').get().n, 0);
      assert.ok(ctx2.logs.some((l) => String(l[0]).includes('verification text')));
    } finally {
      await ctx2.app.close();
    }
  } finally {
    await ctx.app.close();
  }
});

test('with no SMS provider there is nothing to verify: numbers are required but accepted, and nothing is sent', async () => {
  const ctx = await boot(); // default provider: none
  try {
    const admin = await makeUser(ctx, 'boss', { isAdmin: true });
    const { c } = await newbie(ctx, admin, 'newbie');
    const me = (await c.req('GET', '/api/me')).json.user;
    assert.deepEqual([me.phoneRequired, me.needsCode], [false, false]);
    await admin.req('POST', '/api/game', { aiLevel: 'easy' });
    assert.equal((await c.req('POST', '/api/game/join')).status, 200);
    assert.equal((await c.req('POST', '/api/phone/resend')).status, 409);
    const changed = await c.req('POST', '/api/phone', { phone: nextPhone() });
    assert.equal(changed.json.codeSent, false);
  } finally {
    await ctx.app.close();
  }
});

test('texts can be switched off, and the setting is validated', async () => {
  const ctx = await boot(withSms());
  try {
    const user = await makeUser(ctx, 'someone');
    assert.equal((await user.req('GET', '/api/me')).json.user.smsEnabled, true);
    assert.equal((await user.req('POST', '/api/sms', { enabled: false })).json.user.smsEnabled, false);
    assert.equal((await user.req('POST', '/api/sms', { enabled: 'no' })).status, 400);
    assert.equal((await new Client(ctx.base).req('POST', '/api/sms', { enabled: true })).status, 401);
  } finally {
    await ctx.app.close();
  }
});

test('in a real game: one text when the turn reaches an absent player, none to someone watching, never any cards', async () => {
  const smsProvider = createSmsProvider({ provider: 'console', quiet: true });
  const ctx = await boot({
    devTables: true,
    smsProvider,
    rng: mulberry32(5),
    notify: { delayMs: 30, cooldownMs: 60_000, baseUrl: 'https://big2.example.com' },
  });
  try {
    // Away: no page open. The bots play until it is their turn, then exactly one text.
    const away = await makeUser(ctx, 'away', { isAdmin: true });
    await away.req('POST', '/api/game', { aiLevel: 'easy' });
    await away.req('POST', '/api/game/start');
    const table = ctx.app.lobby.table;
    await until(() => table.game.turn === 0, 5000, "the human's turn");
    await until(() => smsProvider.outbox.length === 1, 3000, 'the turn text');
    await sleep(250); // still their turn, still away: no second text
    assert.equal(smsProvider.outbox.length, 1);
    const sms = smsProvider.outbox[0];
    assert.equal(sms.to, ctx.app.db.prepare('SELECT phone FROM users WHERE name = ?').get('away').phone);
    assert.equal(sms.body, "Big Two: it's your turn. https://big2.example.com");
    assert.ok(!/\d[♦♣♥♠]|[♦♣♥♠]|\bjoker\b/i.test(sms.body), 'no cards in a text');
    assert.equal(ctx.app.db.prepare("SELECT COUNT(*) AS n FROM sms_log WHERE kind = 'turn' AND ok = 1").get().n, 1);
    assert.deepEqual(ctx.logs, []);
  } finally {
    await ctx.app.close();
  }

  const watching = createSmsProvider({ provider: 'console', quiet: true });
  const ctx2 = await boot({
    devTables: true,
    smsProvider: watching,
    rng: mulberry32(5),
    notify: { delayMs: 30, cooldownMs: 0 },
  });
  const abort = new AbortController();
  try {
    const here = await makeUser(ctx2, 'here', { isAdmin: true });
    // An open event stream is what "on the page" means.
    fetch(`${ctx2.base}/api/events`, { headers: { cookie: here.cookie }, signal: abort.signal })
      .then((r) => r.body.getReader().read())
      .catch(() => {});
    await until(() => ctx2.app.hub.conns.has(here.user.id), 3000, 'the stream to open');
    await here.req('POST', '/api/game', { aiLevel: 'easy' });
    await here.req('POST', '/api/game/start');
    await until(() => ctx2.app.lobby.table.game.turn === 0, 5000, "the human's turn");
    await sleep(300);
    assert.equal(watching.outbox.length, 0, 'someone looking at the game is not texted');
  } finally {
    abort.abort();
    await ctx2.app.close();
  }
});

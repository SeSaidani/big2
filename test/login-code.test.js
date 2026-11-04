import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSmsProvider } from '../server/sms/index.js';
import { openDb, recentAudit } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { createLoginCode, checkLoginCode } from '../server/login-codes.js';
import { setUserPhone } from '../server/phones.js';
import { issueLoginCode } from '../server/admin.js';
import { boot, until, Client, makeUser, nextPhone } from './support.js';

const provider = () => createSmsProvider({ provider: 'console', quiet: true });
const lastCode = (p) => /code: (\d{6})/.exec(p.outbox.at(-1).body)[1];
const wrongOf = (code) => (code === '000000' ? '111111' : '000000');

// A server with texting on and one player who has never typed a password.
async function setup(extra = {}) {
  const smsProvider = provider();
  const ctx = await boot({ smsProvider, ...extra });
  const phone = nextPhone();
  await createUser(ctx.app.db, 'dana', 'unused-password-1', { phone });
  const userId = ctx.app.db.prepare("SELECT id FROM users WHERE name = 'dana'").get().id;
  return { ctx, smsProvider, phone, userId, anon: new Client(ctx.base) };
}

test('sign in by texted code: the text goes to the number on file, the code works once and proves the number', async () => {
  const { ctx, smsProvider, phone, anon } = await setup();
  try {
    assert.deepEqual((await anon.req('GET', '/api/config')).json.codeLogin, true);
    const asked = await anon.req('POST', '/api/login/code', { name: 'dana' });
    assert.deepEqual([asked.status, asked.json], [200, { ok: true }]);
    await until(() => smsProvider.outbox.length === 1, 2000, 'the text');
    assert.equal(smsProvider.outbox[0].to, phone);
    assert.match(smsProvider.outbox[0].body, /^Big Two sign-in code: \d{6}\. It expires in 10 minutes\./);
    const code = lastCode(smsProvider);

    const bad = await anon.req('POST', '/api/login/verify', { name: 'dana', code: wrongOf(code) });
    assert.equal(bad.status, 401);
    assert.equal(anon.cookie, '');

    const ok = await anon.req('POST', '/api/login/verify', { name: 'dana', code });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.user.name, 'dana');
    assert.equal(ok.json.user.phoneVerified, true); // a code that reached the number proves it
    assert.equal((await anon.req('GET', '/api/me')).status, 200);

    const again = await new Client(ctx.base).req('POST', '/api/login/verify', { name: 'dana', code });
    assert.equal(again.status, 401); // used up
  } finally {
    await ctx.app.close();
  }
});

test('asking for a code answers the same for any name, and texts nobody who does not exist or is disabled', async () => {
  const { ctx, smsProvider, userId, anon } = await setup();
  try {
    const known = await anon.req('POST', '/api/login/code', { name: 'dana' });
    const unknown = await anon.req('POST', '/api/login/code', { name: 'nobody' });
    assert.deepEqual([unknown.status, unknown.json], [known.status, known.json]);
    await until(() => smsProvider.outbox.length === 1, 2000, 'one text, for dana only');

    ctx.app.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(userId);
    const disabled = await new Client(ctx.base).req('POST', '/api/login/code', { name: 'dana' });
    assert.deepEqual([disabled.status, disabled.json], [200, { ok: true }]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(smsProvider.outbox.length, 1);
    // Even holding a valid code, a disabled account is refused (and only now is the reason given).
    const code = createLoginCode(ctx.app.db, userId);
    assert.equal((await anon.req('POST', '/api/login/verify', { name: 'dana', code })).status, 403);
  } finally {
    await ctx.app.close();
  }
});

test('five wrong guesses burn the code, even for the right one afterwards', async () => {
  const { ctx, userId, anon } = await setup();
  try {
    const code = createLoginCode(ctx.app.db, userId);
    for (let i = 0; i < 5; i++) {
      const r = await new Client(ctx.base).req('POST', '/api/login/verify', { name: 'dana', code: wrongOf(code) });
      assert.equal(r.status, i < 5 ? 401 : 429);
    }
    assert.equal((await anon.req('POST', '/api/login/verify', { name: 'dana', code })).status, 401);
  } finally {
    await ctx.app.close();
  }
});

test('codes expire after 10 minutes; a newer code replaces an older one', async () => {
  let clock = 1_000_000;
  const { ctx, smsProvider, userId, anon } = await setup({ now: () => clock });
  try {
    const first = createLoginCode(ctx.app.db, userId, clock);
    const second = createLoginCode(ctx.app.db, userId, clock);
    const wrongFirst = first === second ? wrongOf(second) : first; // 1 in a million: equal
    assert.equal((await anon.req('POST', '/api/login/verify', { name: 'dana', code: wrongFirst })).status, 401);

    clock += 10 * 60 * 1000;
    assert.equal((await anon.req('POST', '/api/login/verify', { name: 'dana', code: second })).status, 401);

    await anon.req('POST', '/api/login/code', { name: 'dana' });
    await until(() => smsProvider.outbox.length === 1, 2000, 'a fresh text');
    clock += 10 * 60 * 1000 - 1;
    assert.equal(
      (await anon.req('POST', '/api/login/verify', { name: 'dana', code: lastCode(smsProvider) })).status,
      200,
    );
  } finally {
    await ctx.app.close();
  }
});

test('three codes an hour per name, counted the same for names that do not exist', async () => {
  const { ctx, smsProvider } = await setup();
  try {
    for (const name of ['dana', 'ghost']) {
      const statuses = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await new Client(ctx.base).req('POST', '/api/login/code', { name })).status);
      }
      assert.deepEqual(statuses, [200, 200, 200, 429], name);
    }
    await until(() => smsProvider.outbox.length === 3, 2000, 'three texts for dana, none for ghost');
  } finally {
    await ctx.app.close();
  }
});

test('changing the number voids a code already texted to the old one', async () => {
  const { ctx, userId, anon } = await setup();
  try {
    const code = createLoginCode(ctx.app.db, userId);
    setUserPhone(ctx.app.db, userId, nextPhone());
    assert.equal((await anon.req('POST', '/api/login/verify', { name: 'dana', code })).status, 401);
  } finally {
    await ctx.app.close();
  }
});

test('failed sends: no code is left behind and the caller learns nothing', async () => {
  const smsProvider = { canSend: true, send: () => Promise.reject(new Error('carrier down')) };
  const ctx = await boot({ smsProvider });
  try {
    await createUser(ctx.app.db, 'dana', 'unused-password-1', { phone: nextPhone() });
    const r = await new Client(ctx.base).req('POST', '/api/login/code', { name: 'dana' });
    assert.deepEqual([r.status, r.json], [200, { ok: true }]);
    await until(() => ctx.logs.some((l) => /sign-in text .* failed/.test(l[0])), 2000, 'the failure log');
    assert.equal(ctx.app.db.prepare('SELECT COUNT(*) AS n FROM login_codes').get().n, 0);
    assert.doesNotMatch(ctx.logs.flat().join(' '), /\+4477009\d{5}/); // the number is masked in logs
  } finally {
    await ctx.app.close();
  }
});

test('without a text provider, code sign-in is off and says so; passwords still work', async () => {
  const ctx = await boot();
  try {
    const c = await makeUser(ctx, 'boss');
    assert.equal((await c.req('GET', '/api/config')).json.codeLogin, false);
    const r = await new Client(ctx.base).req('POST', '/api/login/code', { name: 'boss' });
    assert.equal(r.status, 409);
    assert.equal(
      (await new Client(ctx.base).req('POST', '/api/login/verify', { name: 'boss', code: '123456' })).status,
      401,
    );
  } finally {
    await ctx.app.close();
  }
});

test('the codes themselves: tries, expiry, single use, and junk input', () => {
  const db = openDb(':memory:');
  const id = Number(
    db.prepare("INSERT INTO users (name, pw_hash, created) VALUES ('a', 'x', 0)").run().lastInsertRowid,
  );
  assert.equal(checkLoginCode(db, id, '123456', 0), false); // none issued
  const code = createLoginCode(db, id, 0);
  assert.match(code, /^\d{6}$/);
  for (const junk of [undefined, null, {}, [], 123, 'x'.repeat(5000), ' ']) {
    assert.equal(checkLoginCode(db, id, junk, 1), false);
  }
  assert.equal(checkLoginCode(db, id, code, 1), false); // five junk tries used it up
  const fresh = createLoginCode(db, id, 0);
  assert.equal(checkLoginCode(db, id, ` ${fresh} `, 1), true); // whitespace is forgiven
  assert.equal(checkLoginCode(db, id, fresh, 2), false); // single use
  const old = createLoginCode(db, id, 0);
  assert.equal(checkLoginCode(db, id, old, 10 * 60 * 1000), false); // expired
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM login_codes').get().n, 0);
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM login_codes').all()), /\d{6}/);
});

test('the admin tool issues a code when texts do not arrive, and records that in the audit log', async () => {
  const smsProvider = provider();
  const ctx = await boot({ smsProvider });
  try {
    await createUser(ctx.app.db, 'dana', 'unused-password-1', { phone: nextPhone() });
    assert.throws(() => issueLoginCode(ctx.app.db, 'nobody'), /No such user/);
    const code = issueLoginCode(ctx.app.db, 'dana');
    assert.equal((await new Client(ctx.base).req('POST', '/api/login/verify', { name: 'dana', code })).status, 200);
    const entry = recentAudit(ctx.app.db, 10).find((a) => a.action === 'cli_login_code');
    assert.ok(entry && entry.target === 'dana');
    assert.ok(!JSON.stringify(entry).includes(code));
  } finally {
    await ctx.app.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSmsProvider, smsConfigFromEnv, SmsError } from '../server/sms/index.js';

const NUMBER = '+447700900123';
const CREDS = async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'tok' });

// A fake fetch that records requests and replies with whatever the test queues.
function fakeFetch(...replies) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url: String(url), options });
    const next = replies.length > 1 ? replies.shift() : replies[0];
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

const snsOk = (id = 'abc-123') =>
  new Response(`<PublishResponse><PublishResult><MessageId>${id}</MessageId></PublishResult></PublishResponse>`);
const snsError = (status, code, message) =>
  new Response(
    `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error></ErrorResponse>`,
    {
      status,
    },
  );

const sns = (fetch, extra = {}) =>
  createSmsProvider(
    { provider: 'aws-sns', region: 'eu-west-2', ...extra },
    { fetch, credentials: CREDS, now: () => new Date('2026-01-02T03:04:05Z') },
  );

test('aws-sns: sends a signed Publish with the right fields', async () => {
  const fetch = fakeFetch(snsOk('msg-1'));
  const provider = sns(fetch, { senderId: 'Big2' });
  assert.deepEqual(await provider.send({ to: NUMBER, body: "Big Two: it's your turn." }), { id: 'msg-1' });
  const { url, options } = fetch.calls[0];
  assert.equal(url, 'https://sns.eu-west-2.amazonaws.com/');
  assert.equal(options.method, 'POST');
  const form = new URLSearchParams(options.body);
  assert.equal(form.get('Action'), 'Publish');
  assert.equal(form.get('PhoneNumber'), NUMBER);
  assert.equal(form.get('Message'), "Big Two: it's your turn.");
  assert.equal(form.get('MessageAttributes.entry.1.Name'), 'AWS.SNS.SMS.SMSType');
  assert.equal(form.get('MessageAttributes.entry.1.Value.StringValue'), 'Transactional');
  assert.equal(form.get('MessageAttributes.entry.2.Name'), 'AWS.SNS.SMS.SenderID');
  assert.equal(form.get('MessageAttributes.entry.2.Value.StringValue'), 'Big2');
  const h = options.headers;
  assert.match(
    h.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260102\/eu-west-2\/sns\/aws4_request, SignedHeaders=.*host/,
  );
  assert.equal(h['x-amz-date'], '20260102T030405Z');
  assert.equal(h['x-amz-security-token'], 'tok');
  assert.match(h['content-type'], /application\/x-www-form-urlencoded/);
});

test('aws-sns: no sender id attribute unless configured; region is required', async () => {
  const fetch = fakeFetch(snsOk());
  await sns(fetch).send({ to: NUMBER, body: 'hi' });
  assert.equal(new URLSearchParams(fetch.calls[0].options.body).get('MessageAttributes.entry.2.Name'), null);
  assert.throws(() => createSmsProvider({ provider: 'aws-sns' }), /AWS_REGION/);
});

test('aws-sns: errors are classified (retryable, permanent, opted out)', async () => {
  const attempt = async (reply) => {
    try {
      await sns(fakeFetch(reply)).send({ to: NUMBER, body: 'hi' });
    } catch (err) {
      return err;
    }
    assert.fail('expected an error');
  };
  const throttled = await attempt(snsError(400, 'Throttling', 'Rate exceeded'));
  assert.ok(throttled instanceof SmsError);
  assert.equal(throttled.retryable, true);
  assert.equal(throttled.code, 'Throttling');

  const server = await attempt(snsError(503, 'ServiceUnavailable', 'try later'));
  assert.equal(server.retryable, true);

  const badNumber = await attempt(
    snsError(400, 'InvalidParameter', 'Invalid parameter: PhoneNumber Reason: not valid'),
  );
  assert.equal(badNumber.retryable, false);
  assert.equal(badNumber.optedOut, false);

  const sandbox = await attempt(snsError(400, 'InvalidParameter', 'Destination is not verified (sandbox)'));
  assert.equal(sandbox.retryable, false);

  const optedOut = await attempt(snsError(400, 'InvalidParameter', 'Phone number is opted out'));
  assert.equal(optedOut.optedOut, true);
  assert.equal(optedOut.retryable, false);

  const network = await attempt(new Error('ECONNRESET'));
  assert.equal(network.retryable, true);
  assert.equal(network.code, 'NETWORK');

  const noId = await attempt(new Response('<PublishResponse/>'));
  assert.equal(noId.code, 'BAD_RESPONSE');
});

test('aws-sns: missing credentials are a retryable failure, not a crash', async () => {
  const provider = createSmsProvider(
    { provider: 'aws-sns', region: 'eu-west-2' },
    {
      fetch: fakeFetch(snsOk()),
      credentials: async () => {
        throw new Error('no role');
      },
    },
  );
  await assert.rejects(provider.send({ to: NUMBER, body: 'x' }), (e) => e.code === 'CREDENTIALS' && e.retryable);
});

test('twilio: form-encoded POST with basic auth; classifies errors', async () => {
  const config = { provider: 'twilio', twilioAccountSid: 'ACxxx', twilioAuthToken: 'tkn', twilioFrom: '+15005550006' };
  const fetch = fakeFetch(Response.json({ sid: 'SM123' }, { status: 201 }));
  const provider = createSmsProvider(config, { fetch });
  assert.deepEqual(await provider.send({ to: NUMBER, body: 'hello' }), { id: 'SM123' });
  const { url, options } = fetch.calls[0];
  assert.equal(url, 'https://api.twilio.com/2010-04-01/Accounts/ACxxx/Messages.json');
  assert.equal(options.headers.Authorization, `Basic ${Buffer.from('ACxxx:tkn').toString('base64')}`);
  const form = new URLSearchParams(options.body);
  assert.deepEqual([form.get('To'), form.get('From'), form.get('Body')], [NUMBER, '+15005550006', 'hello']);

  const f2 = fakeFetch(Response.json({ sid: 'SM2' }));
  const viaService = createSmsProvider(
    { provider: 'twilio', twilioAccountSid: 'AC', twilioAuthToken: 't', twilioMessagingServiceSid: 'MG1' },
    { fetch: f2 },
  );
  await viaService.send({ to: NUMBER, body: 'x' });
  const f = new URLSearchParams(f2.calls[0].options.body);
  assert.equal(f.get('MessagingServiceSid'), 'MG1');
  assert.equal(f.get('From'), null);

  const stopped = createSmsProvider(config, {
    fetch: fakeFetch(Response.json({ code: 21610, message: 'blocked' }, { status: 400 })),
  });
  await assert.rejects(stopped.send({ to: NUMBER, body: 'x' }), (e) => e.optedOut && !e.retryable);
  const busy = createSmsProvider(config, { fetch: fakeFetch(Response.json({ message: 'busy' }, { status: 503 })) });
  await assert.rejects(busy.send({ to: NUMBER, body: 'x' }), (e) => e.retryable);
  assert.throws(
    () => createSmsProvider({ provider: 'twilio', twilioAccountSid: 'a', twilioAuthToken: 'b' }),
    /TWILIO_FROM/,
  );
  assert.throws(() => createSmsProvider({ provider: 'twilio' }), /TWILIO_ACCOUNT_SID/);
});

test('http: posts JSON, requires https, and sends the authorization header if set', async () => {
  const fetch = fakeFetch(Response.json({ id: 'w-1' }));
  const provider = createSmsProvider(
    { provider: 'http', httpUrl: 'https://sms.example.com/send', httpAuthorization: 'Bearer abc' },
    { fetch },
  );
  assert.deepEqual(await provider.send({ to: NUMBER, body: 'hi' }), { id: 'w-1' });
  const { options } = fetch.calls[0];
  assert.deepEqual(JSON.parse(options.body), { to: NUMBER, body: 'hi' });
  assert.equal(options.headers.Authorization, 'Bearer abc');

  assert.throws(() => createSmsProvider({ provider: 'http', httpUrl: 'http://sms.example.com/' }), /https/);
  assert.throws(() => createSmsProvider({ provider: 'http' }), /SMS_HTTP_URL/);
  createSmsProvider({ provider: 'http', httpUrl: 'http://localhost:9999/' }); // local testing is allowed

  const empty = createSmsProvider(
    { provider: 'http', httpUrl: 'https://x.example/' },
    { fetch: fakeFetch(new Response(null, { status: 204 })) },
  );
  assert.deepEqual(await empty.send({ to: NUMBER, body: 'x' }), { id: null });
  const down = createSmsProvider(
    { provider: 'http', httpUrl: 'https://x.example/' },
    { fetch: fakeFetch(new Response('', { status: 502 })) },
  );
  await assert.rejects(down.send({ to: NUMBER, body: 'x' }), (e) => e.retryable);
  const rejected = createSmsProvider(
    { provider: 'http', httpUrl: 'https://x.example/' },
    { fetch: fakeFetch(new Response('', { status: 400 })) },
  );
  await assert.rejects(rejected.send({ to: NUMBER, body: 'x' }), (e) => !e.retryable);
});

test('console: keeps an outbox, masks the number in its log; none refuses to send', async () => {
  const lines = [];
  const provider = createSmsProvider({ provider: 'console' }, { log: (l) => lines.push(l) });
  assert.equal(provider.canSend, true);
  await provider.send({ to: NUMBER, body: 'code 123456' });
  assert.deepEqual(
    provider.outbox.map((m) => [m.to, m.body]),
    [[NUMBER, 'code 123456']],
  );
  assert.ok(lines[0].includes('+44•••') && !lines[0].includes(NUMBER), lines[0]);
  const quiet = createSmsProvider({ provider: 'console', quiet: true }, {});
  await quiet.send({ to: NUMBER, body: 'x' });

  const none = createSmsProvider({ provider: 'none' });
  assert.equal(none.canSend, false);
  await assert.rejects(none.send({ to: NUMBER, body: 'x' }), SmsError);
  assert.equal(createSmsProvider({}).name, 'none', 'unconfigured means no texting');
  assert.throws(() => createSmsProvider({ provider: 'carrier-pigeon' }), /Unknown SMS_PROVIDER/);
});

test('configuration is read from the environment, defaulting to the harmless console provider', () => {
  assert.equal(smsConfigFromEnv({}).provider, 'console');
  const c = smsConfigFromEnv({
    SMS_PROVIDER: 'aws-sns',
    AWS_REGION: 'eu-west-2',
    SMS_SENDER_ID: 'Big2',
    TWILIO_ACCOUNT_SID: 'AC1',
    SMS_HTTP_URL: 'https://x.example/',
  });
  assert.deepEqual(
    [c.provider, c.region, c.senderId, c.twilioAccountSid, c.httpUrl],
    ['aws-sns', 'eu-west-2', 'Big2', 'AC1', 'https://x.example/'],
  );
});

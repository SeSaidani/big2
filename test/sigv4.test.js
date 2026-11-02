import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signRequest, createCredentialProvider } from '../server/aws-sigv4.js';

// AWS's published SigV4 test-suite case "get-vanilla". If this signature
// matches, the canonical request, string to sign and key derivation are right.
const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

test('matches the AWS published test vector (get-vanilla)', () => {
  const { signature, headers, canonicalRequest } = signRequest({
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    region: 'us-east-1',
    service: 'service',
    credentials: CREDENTIALS,
    now: new Date('2015-08-30T12:36:00Z'),
  });
  assert.equal(
    canonicalRequest,
    [
      'GET',
      '/',
      '',
      'host:example.amazonaws.com',
      'x-amz-date:20150830T123600Z',
      '',
      'host;x-amz-date',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    ].join('\n'),
  );
  assert.equal(signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  assert.equal(
    headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
      'SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  );
});

test('query parameters are sorted and encoded, and a session token is signed', () => {
  const { canonicalRequest, headers } = signRequest({
    method: 'GET',
    url: 'https://example.amazonaws.com/?b=2&a=1&a=0&c=x y!',
    region: 'us-east-1',
    service: 'service',
    credentials: { ...CREDENTIALS, sessionToken: 'TOKEN' },
    now: new Date('2015-08-30T12:36:00Z'),
  });
  assert.match(canonicalRequest, /\na=0&a=1&b=2&c=x%20y%21\n/);
  assert.equal(headers['x-amz-security-token'], 'TOKEN');
  assert.match(headers.authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token/);
});

test('the body is part of the signature', () => {
  const sign = (body) =>
    signRequest({
      method: 'POST',
      url: 'https://sns.eu-west-2.amazonaws.com/',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      region: 'eu-west-2',
      service: 'sns',
      credentials: CREDENTIALS,
      now: new Date('2026-01-02T03:04:05Z'),
    }).signature;
  assert.notEqual(sign('Action=Publish&Message=a'), sign('Action=Publish&Message=b'));
  assert.equal(sign('Action=Publish&Message=a'), sign('Action=Publish&Message=a'));
});

test('credentials: environment variables win; otherwise the EC2 role is fetched once and cached', async () => {
  const fromEnv = createCredentialProvider({
    env: { AWS_ACCESS_KEY_ID: 'AK', AWS_SECRET_ACCESS_KEY: 'SK', AWS_SESSION_TOKEN: 'ST' },
    fetchImpl: () => assert.fail('must not call the metadata service'),
  });
  assert.deepEqual(await fromEnv(), { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' });

  let t = Date.parse('2026-01-01T00:00:00Z');
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push(`${options.method || 'GET'} ${url.replace('http://169.254.169.254/latest', '')}`);
    if (url.endsWith('/api/token')) {
      assert.equal(options.headers['X-aws-ec2-metadata-token-ttl-seconds'], '21600'); // IMDSv2
      return new Response('SESSION');
    }
    assert.equal(options.headers['X-aws-ec2-metadata-token'], 'SESSION');
    if (url.endsWith('/security-credentials/')) return new Response('big2-role\n');
    return Response.json({
      AccessKeyId: 'RK',
      SecretAccessKey: 'RS',
      Token: 'RT',
      Expiration: '2026-01-01T06:00:00Z',
    });
  };
  const fromRole = createCredentialProvider({ env: {}, fetchImpl, now: () => t });
  assert.deepEqual(await fromRole(), { accessKeyId: 'RK', secretAccessKey: 'RS', sessionToken: 'RT' });
  await fromRole();
  assert.equal(calls.length, 3, 'second call is served from the cache');
  t = Date.parse('2026-01-01T05:56:00Z'); // within 5 minutes of expiry: refresh
  await fromRole();
  assert.equal(calls.length, 6);

  const noRole = createCredentialProvider({
    env: {},
    fetchImpl: async (url) => (url.endsWith('/api/token') ? new Response('T') : new Response('')),
  });
  await assert.rejects(noRole(), /No instance role/);
});

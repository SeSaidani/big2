// AWS Signature Version 4, written out by hand so the server needs no AWS SDK.
// Used by the SNS text-message provider. Checked against AWS's published test
// vector in test/sms.test.js.
//
// Credentials come from the environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY,
// optional AWS_SESSION_TOKEN) or, on EC2, from the instance role via IMDSv2.

import crypto from 'node:crypto';

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
// RFC 3986 encoding, as SigV4 requires (encodeURIComponent leaves !'()* alone).
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Returns the headers to send (including Authorization). `now` is a Date.
export function signRequest({ method, url, headers = {}, body = '', region, service, credentials, now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20150830T123600Z
  const dateStamp = amzDate.slice(0, 8);
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  h.host = u.host;
  h['x-amz-date'] = amzDate;
  if (credentials.sessionToken) h['x-amz-security-token'] = credentials.sessionToken;

  const names = Object.keys(h).sort();
  const canonicalHeaders = names.map((n) => `${n}:${h[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = [...u.searchParams.entries()]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  // Non-S3 services encode each path segment twice (the URL already encoded it once).
  const canonicalPath = (u.pathname || '/')
    .split('/')
    .map((s) => enc(s))
    .join('/');
  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    sha256hex(body),
  ].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const kSigning = hmac(hmac(hmac(kDate, region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  h.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: h, signature, canonicalRequest, stringToSign };
}

// Resolves credentials lazily and caches role credentials until shortly before they expire.
export function createCredentialProvider({ env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
  let cached = null;
  const IMDS = 'http://169.254.169.254/latest';
  const get = async (url, options = {}) => {
    const res = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`Instance metadata request failed (${res.status})`);
    return res;
  };
  return async () => {
    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
      return {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        sessionToken: env.AWS_SESSION_TOKEN || undefined,
      };
    }
    if (cached && cached.expires - 5 * 60 * 1000 > now()) return cached.credentials;
    // EC2 instance role, via IMDSv2 (a session token is required).
    const token = await (
      await get(`${IMDS}/api/token`, { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' } })
    ).text();
    const auth = { headers: { 'X-aws-ec2-metadata-token': token } };
    const roles = (await (await get(`${IMDS}/meta-data/iam/security-credentials/`, auth)).text()).trim();
    const role = roles.split('\n')[0];
    if (!role) throw new Error('No instance role is attached, and no AWS credentials are set.');
    const j = await (await get(`${IMDS}/meta-data/iam/security-credentials/${role}`, auth)).json();
    cached = {
      credentials: { accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, sessionToken: j.Token },
      expires: Date.parse(j.Expiration),
    };
    return cached.credentials;
  };
}

// Generic provider: POST {"to": "+44...", "body": "..."} as JSON to a URL you
// control or a service that accepts that shape (an API gateway in front of
// another vendor, a webhook, ...). Any 2xx counts as sent; if the reply is JSON
// with an "id" it is kept. SMS_HTTP_AUTHORIZATION, if set, is sent verbatim as
// the Authorization header.

import { SmsError, REQUEST_TIMEOUT_MS, isRetryableStatus } from './errors.js';

export function createHttpProvider(config = {}, deps = {}) {
  if (!config.httpUrl) throw new Error('The http provider needs SMS_HTTP_URL.');
  const url = new URL(config.httpUrl);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('SMS_HTTP_URL must use https (messages and codes would travel in clear text).');
  }
  const fetchImpl = deps.fetch ?? fetch;
  return {
    name: 'http',
    canSend: true,
    async send({ to, body }) {
      const headers = { 'Content-Type': 'application/json' };
      if (config.httpAuthorization) headers.Authorization = config.httpAuthorization;
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ to, body }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        throw new SmsError(`SMS webhook failed: ${err.message}`, { retryable: true, code: 'NETWORK' });
      }
      if (!res.ok) {
        throw new SmsError(`SMS webhook replied ${res.status}.`, {
          retryable: isRetryableStatus(res.status),
          code: `HTTP_${res.status}`,
        });
      }
      let id = null;
      try {
        id = (await res.json()).id ?? null;
      } catch {
        /* no body, or not JSON: fine */
      }
      return { id };
    },
  };
}

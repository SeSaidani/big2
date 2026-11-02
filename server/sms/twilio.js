// Twilio's REST API (https://www.twilio.com/docs/messaging/api/message-resource),
// called with fetch: no SDK. Send from a number (TWILIO_FROM) or a Messaging
// Service (TWILIO_MESSAGING_SERVICE_SID).

import { SmsError, REQUEST_TIMEOUT_MS, isRetryableStatus } from './errors.js';

// 21610: the recipient replied STOP to this sender.
const OPTED_OUT = '21610';

export function createTwilioProvider(config = {}, deps = {}) {
  const {
    twilioAccountSid: sid,
    twilioAuthToken: token,
    twilioFrom: from,
    twilioMessagingServiceSid: service,
  } = config;
  if (!sid || !token) throw new Error('The twilio provider needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.');
  if (!from && !service) throw new Error('The twilio provider needs TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID.');
  const fetchImpl = deps.fetch ?? fetch;
  const url = config.endpoint ?? `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const authorization = `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;

  return {
    name: 'twilio',
    canSend: true,
    async send({ to, body }) {
      const form = new URLSearchParams({ To: to, Body: body });
      if (service) form.set('MessagingServiceSid', service);
      else form.set('From', from);
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: authorization, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        throw new SmsError(`Twilio request failed: ${err.message}`, { retryable: true, code: 'NETWORK' });
      }
      let json = {};
      try {
        json = await res.json();
      } catch {
        /* not JSON */
      }
      if (res.ok && json.sid) return { id: json.sid };
      const code = String(json.code ?? `HTTP_${res.status}`);
      throw new SmsError(`Twilio ${code}: ${json.message ?? res.status}`, {
        retryable: isRetryableStatus(res.status) && code !== OPTED_OUT,
        optedOut: code === OPTED_OUT,
        code,
      });
    },
  };
}

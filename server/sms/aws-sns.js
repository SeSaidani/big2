// Amazon SNS direct-to-phone text messages (Publish with a PhoneNumber), signed
// with SigV4 by hand (see ../aws-sigv4.js). Credentials: AWS_* variables, or
// the instance role on EC2: give the role sns:Publish and nothing else.
//
// Things AWS controls that code cannot: new accounts start in the SMS sandbox
// (verified destination numbers only), the monthly spend limit starts low,
// and many countries need a registered sender ID or number. See the README.

import { signRequest, createCredentialProvider } from '../aws-sigv4.js';
import { SmsError, REQUEST_TIMEOUT_MS, isRetryableStatus } from './errors.js';

const tag = (xml, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1].trim() : null;
};

export function createAwsSnsProvider(config = {}, deps = {}) {
  const region = config.region;
  if (!region) throw new Error('The aws-sns provider needs AWS_REGION.');
  const fetchImpl = deps.fetch ?? fetch;
  const getCredentials = deps.credentials ?? createCredentialProvider({ fetchImpl });
  const now = deps.now ?? (() => new Date());
  const endpoint = config.endpoint ?? `https://sns.${region}.amazonaws.com/`;
  const smsType = config.smsType ?? 'Transactional';

  return {
    name: 'aws-sns',
    canSend: true,
    async send({ to, body }) {
      const params = new URLSearchParams({
        Action: 'Publish',
        Version: '2010-03-31',
        PhoneNumber: to,
        Message: body,
        'MessageAttributes.entry.1.Name': 'AWS.SNS.SMS.SMSType',
        'MessageAttributes.entry.1.Value.DataType': 'String',
        'MessageAttributes.entry.1.Value.StringValue': smsType,
      });
      if (config.senderId) {
        params.set('MessageAttributes.entry.2.Name', 'AWS.SNS.SMS.SenderID');
        params.set('MessageAttributes.entry.2.Value.DataType', 'String');
        params.set('MessageAttributes.entry.2.Value.StringValue', config.senderId);
      }
      const payload = params.toString();
      let credentials;
      try {
        credentials = await getCredentials();
      } catch (err) {
        throw new SmsError(`Could not get AWS credentials: ${err.message}`, { retryable: true, code: 'CREDENTIALS' });
      }
      const { headers } = signRequest({
        method: 'POST',
        url: endpoint,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: payload,
        region,
        service: 'sns',
        credentials,
        now: now(),
      });
      let res;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body: payload,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        throw new SmsError(`SNS request failed: ${err.message}`, { retryable: true, code: 'NETWORK' });
      }
      const xml = await res.text();
      if (res.ok) {
        const id = tag(xml, 'MessageId');
        if (!id) throw new SmsError('SNS replied without a MessageId.', { retryable: true, code: 'BAD_RESPONSE' });
        return { id };
      }
      const code = tag(xml, 'Code') || `HTTP_${res.status}`;
      const message = tag(xml, 'Message') || `SNS error ${res.status}`;
      const optedOut = /opted out/i.test(message);
      const throttled = /throttl/i.test(code);
      throw new SmsError(`SNS ${code}: ${message}`, {
        retryable: !optedOut && (throttled || isRetryableStatus(res.status)),
        optedOut,
        code,
      });
    },
  };
}

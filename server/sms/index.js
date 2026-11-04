// Text-message providers. One tiny interface, chosen by configuration:
//
//   provider.send({ to, body }) -> Promise<{ id }>      (throws SmsError)
//   provider.name, provider.canSend
//
//   SMS_PROVIDER=console    dev: prints the message, keeps an in-memory outbox
//   SMS_PROVIDER=none       no texting (verification is switched off with it)
//   SMS_PROVIDER=aws-sns    Amazon SNS (instance role or AWS_* credentials)
//   SMS_PROVIDER=twilio     Twilio's REST API
//   SMS_PROVIDER=http       any service that accepts a JSON POST
//
// Nothing here uses an SDK: providers call their service with fetch, so the
// project keeps zero runtime dependencies.

import { createConsoleProvider } from './console.js';
import { createAwsSnsProvider } from './aws-sns.js';
import { createTwilioProvider } from './twilio.js';
import { createHttpProvider } from './http.js';
import { SmsError } from './errors.js';

export { SmsError };

export const createNoneProvider = () => ({
  name: 'none',
  canSend: false,
  async send() {
    throw new SmsError('Text messaging is not configured.', { code: 'NOT_CONFIGURED' });
  },
});

export function createSmsProvider(config = {}, deps = {}) {
  switch (config.provider ?? 'none') {
    case 'none':
      return createNoneProvider();
    case 'console':
      return createConsoleProvider(config, deps);
    case 'aws-sns':
      return createAwsSnsProvider(config, deps);
    case 'twilio':
      return createTwilioProvider(config, deps);
    case 'http':
      return createHttpProvider(config, deps);
    default:
      throw new Error(`Unknown SMS_PROVIDER "${config.provider}" (use none, console, aws-sns, twilio or http).`);
  }
}

// Reads provider settings from environment variables. Secrets stay in the
// environment (or a secrets manager that fills it): never in the repository.
export function smsConfigFromEnv(env = process.env) {
  return {
    provider: env.SMS_PROVIDER || 'console',
    senderId: env.SMS_SENDER_ID || undefined,
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || undefined,
    twilioAccountSid: env.TWILIO_ACCOUNT_SID || undefined,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN || undefined,
    twilioFrom: env.TWILIO_FROM || undefined,
    twilioMessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID || undefined,
    httpUrl: env.SMS_HTTP_URL || undefined,
    httpAuthorization: env.SMS_HTTP_AUTHORIZATION || undefined,
  };
}

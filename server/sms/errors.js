// retryable: worth trying again (network, throttling, 5xx). optedOut: the
// recipient has opted out (STOP), so stop texting them.
export class SmsError extends Error {
  constructor(message, { retryable = false, optedOut = false, code = null } = {}) {
    super(message);
    this.name = 'SmsError';
    this.retryable = retryable;
    this.optedOut = optedOut;
    this.code = code;
  }
}

// Shared by the HTTP-based providers: a timeout for every request.
export const REQUEST_TIMEOUT_MS = 8000;

// 5xx and 429 are worth retrying; other 4xx (bad number, bad credentials) are not.
export const isRetryableStatus = (status) => status === 429 || status >= 500;

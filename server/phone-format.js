// Phone numbers: one canonical form (E.164, "+" then up to 15 digits, no
// spaces) and a masked form for anything a person other than the owner sees.
// This is deliberately shallow validation (shape and country prefix, no
// per-country length tables): a real check is the verification text.

export class PhoneError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const E164 = /^\+[1-9]\d{6,14}$/;

// allowedPrefixes: e.g. ['+44', '+1']; empty means every country is accepted.
export function normalizePhone(input, { allowedPrefixes = [] } = {}) {
  if (typeof input !== 'string') throw new PhoneError('Enter a phone number.');
  // "+44 (0) 7700 900123": the "(0)" trunk prefix is not part of the number.
  const cleaned = input
    .trim()
    .replace(/\(0\)/g, '')
    .replace(/[\s().-]/g, '');
  if (!cleaned.startsWith('+')) {
    throw new PhoneError('Start with the country code, for example +44 7700 900123.');
  }
  if (!E164.test(cleaned)) throw new PhoneError('That does not look like a valid international phone number.');
  if (allowedPrefixes.length && !allowedPrefixes.some((p) => cleaned.startsWith(p))) {
    throw new PhoneError('Numbers from that country are not supported.');
  }
  return cleaned;
}

// +447700900123 -> +44••••••123. Enough for the owner to recognise it, not enough to use it.
export function maskPhone(e164) {
  if (!e164) return null;
  const digits = e164.slice(1);
  return `+${digits.slice(0, 2)}${'•'.repeat(Math.max(2, digits.length - 5))}${digits.slice(-3)}`;
}

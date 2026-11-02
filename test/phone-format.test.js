import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, maskPhone, PhoneError } from '../server/phone-format.js';

test('numbers are normalised to E.164', () => {
  const ok = {
    '+447700900123': '+447700900123',
    '+44 7700 900123': '+447700900123',
    '+44 (0) 7700 900123': '+447700900123', // the trunk "0" is dropped
    '  +1 (415) 555-0132 ': '+14155550132',
    '+61.412.345.678': '+61412345678',
  };
  for (const [input, want] of Object.entries(ok)) assert.equal(normalizePhone(input), want, input);
});

test('numbers without a country code or with the wrong shape are refused', () => {
  for (const bad of [
    '07700 900123',
    '7700900123',
    '+0447700900123',
    '+44',
    '+44 77',
    '+44abc7700900123',
    '+1234567890123456',
    '',
    '   ',
  ]) {
    assert.throws(() => normalizePhone(bad), PhoneError, JSON.stringify(bad));
  }
  for (const notText of [null, undefined, 447700900123, {}, ['+447700900123']]) {
    assert.throws(() => normalizePhone(notText), PhoneError);
  }
  // Errors carry an HTTP status for the API layer.
  assert.throws(
    () => normalizePhone('nope'),
    (e) => e.status === 400,
  );
});

test('an allow-list of country prefixes can restrict where texts may go', () => {
  const allowedPrefixes = ['+44', '+1'];
  assert.equal(normalizePhone('+44 7700 900123', { allowedPrefixes }), '+447700900123');
  assert.equal(normalizePhone('+1 415 555 0132', { allowedPrefixes }), '+14155550132');
  assert.throws(() => normalizePhone('+61 412 345 678', { allowedPrefixes }), /not supported/);
  assert.equal(normalizePhone('+61 412 345 678', { allowedPrefixes: [] }), '+61412345678');
});

test('masking hides all but the country code and the last three digits', () => {
  assert.equal(maskPhone('+447700900123'), '+44•••••••123'); // 12 digits: 2 + 7 hidden + 3
  assert.equal(maskPhone('+14155550132'), '+14••••••132'); // 11 digits: 2 + 6 hidden + 3
  assert.equal(maskPhone(null), null);
  for (const n of ['+447700900123', '+14155550132', '+1234567', '+123456789012345']) {
    const masked = maskPhone(n);
    assert.equal(masked.length, n.length, n);
    // "+", two digits of country code, at least two hidden, then the last three.
    assert.match(masked, /^\+\d{2}•{2,}\d{3}$/, masked);
    assert.equal(masked.slice(-3), n.slice(-3));
  }
});

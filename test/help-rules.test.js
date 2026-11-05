import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RATES_BY_PLAYERS } from '../src/scoring.js';

// The How to play dialog prints the scoring table by hand. This keeps it honest: if the rates in
// scoring.js change, the page must change with them.
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const rates = html.slice(
  html.indexOf('<table class="rates">'),
  html.indexOf('</table>', html.indexOf('<table class="rates">')),
);
const rows = [...rates.matchAll(/<tr>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>\s*<\/tr>/g)].map(
  (m) => [m[1], m[2], m[3]],
);

const range = (table, i) => {
  const lo = i === 0 ? 1 : table[i - 1].upTo + 1;
  return lo === table[i].upTo ? `${lo}` : `${lo} to ${table[i].upTo}`;
};

test('the scoring table in the How to play dialog matches scoring.js', () => {
  assert.equal(rows.length, RATES_BY_PLAYERS[4].length);
  assert.equal(RATES_BY_PLAYERS[3].length, RATES_BY_PLAYERS[4].length);
  rows.forEach(([four, rate, three], i) => {
    assert.equal(four, range(RATES_BY_PLAYERS[4], i), `4 players, row ${i + 1}`);
    assert.equal(Number(rate), RATES_BY_PLAYERS[4][i].rate, `rate, row ${i + 1}`);
    assert.equal(Number(rate), RATES_BY_PLAYERS[3][i].rate, `3-player rate, row ${i + 1}`);
    assert.equal(three, range(RATES_BY_PLAYERS[3], i), `3 players, row ${i + 1}`);
  });
});

test('the dialog states the deal sizes the code uses', () => {
  assert.match(html, /everyone gets 14 cards/);
  assert.match(html, /everyone gets 18/);
});

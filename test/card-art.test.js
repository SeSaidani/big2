import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardSVG, pipLayout, isCourt, VIEW_W, VIEW_H } from '../src/card-art.js';
import { RANK_NAMES, DECK_SIZE } from '../src/cards.js';

test('a number card carries as many pips as its rank (ace 1, two 2)', () => {
  const expected = { A: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10 };
  RANK_NAMES.forEach((name, rank) => {
    if (isCourt(rank)) return assert.equal(pipLayout(rank).length, 0, `${name} is a court card`);
    assert.equal(pipLayout(rank).length, expected[name], name);
  });
});

test('pips sit inside the 3 x 7 grid and never overlap', () => {
  RANK_NAMES.forEach((_, rank) => {
    const pips = pipLayout(rank);
    for (const [col, row] of pips) {
      assert.ok(col >= 0 && col <= 2 && row >= 0 && row <= 6);
    }
    const keys = pips.map((p) => p.join(','));
    assert.equal(new Set(keys).size, keys.length, `rank ${rank} repeats a position`);
  });
});

test('exactly J, Q and K are court cards', () => {
  assert.deepEqual(
    RANK_NAMES.filter((_, r) => isCourt(r)),
    ['J', 'Q', 'K'],
  );
});

test('every card renders balanced SVG, full size and mini', () => {
  for (let c = 0; c < DECK_SIZE; c++) {
    for (const mini of [false, true]) {
      const svg = cardSVG(c, mini);
      assert.ok(svg.startsWith('<svg ') && svg.endsWith('</svg>'), `card ${c}`);
      assert.ok(svg.includes(`viewBox="0 0 ${VIEW_W} ${VIEW_H}"`));
      for (const tag of ['g', 'text']) {
        const open = (svg.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length;
        const close = (svg.match(new RegExp(`</${tag}>`, 'g')) || []).length;
        assert.equal(open, close, `card ${c} mini=${mini}: unbalanced <${tag}>`);
      }
    }
  }
});

test('the two suit colours are not baked in: faces use currentColor', () => {
  assert.ok(!/#c8242f|#1b1b1f/i.test(cardSVG(10)));
  assert.ok(cardSVG(10).includes('currentColor'));
});

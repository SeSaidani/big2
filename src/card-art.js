// Card faces as inline SVG, so a card looks the same on every OS (the suit glyphs are
// emoji on some phones) and scales cleanly to every card size. Pure string building, no DOM.
//
// Every face is drawn in a 70 x 98 box and stretched to the card. Colour comes from
// `currentColor`, which the stylesheet sets red or black per suit.

import { isJoker, rankOf, suitOf, RANK_NAMES } from './cards.js';

export const VIEW_W = 70;
export const VIEW_H = 98;

const GOLD = '#e0b43c';
const SKIN = '#f4dcb8';

// Suit shapes, each centred on the origin inside a 20 x 20 box (♦ ♣ ♥ ♠, as SUIT_NAMES).
const SUIT_SHAPES = [
  '<path d="M0-10 7 0 0 10-7 0Z"/>',
  '<circle cx="0" cy="-5" r="4.6"/><circle cx="-5.2" cy="2.4" r="4.6"/><circle cx="5.2" cy="2.4" r="4.6"/>' +
    '<path d="M-1.2 2-3.4 10h6.8L1.2 2Z"/>',
  '<path d="M0 9.5C-15 0-8.5-9.5 0-4 8.5-9.5 15 0 0 9.5Z"/>',
  '<path d="M0-10C-14 0-10.5 8.5-3 5.2-3.2 8.2-4.2 10-6.4 10h12.8C4.2 10 3.2 8.2 3 5.2 10.5 8.5 14 0 0-10Z"/>',
];

function suit(s, x, y, scale = 1, flip = false) {
  const rot = flip ? ' rotate(180)' : '';
  return `<g transform="translate(${x} ${y}) scale(${scale})${rot}">${SUIT_SHAPES[s]}</g>`;
}

// Pip positions as [column 0..2, row 0..6], rows running top to bottom. Indexed by rank
// (RANK_NAMES order: 3 .. K, A, 2). Pips below the middle row are drawn upside down, as on a
// printed card. Court cards (J Q K) have no pips.
const SIDES = [
  [0, 0],
  [2, 0],
  [0, 6],
  [2, 6],
];
const SIX = [...SIDES, [0, 3], [2, 3]];
const EIGHT_SIDES = [0, 2, 4, 6].flatMap((r) => [
  [0, r],
  [2, r],
]);
const PIPS_BY_NAME = {
  A: [[1, 3]],
  2: [
    [1, 0],
    [1, 6],
  ],
  3: [
    [1, 0],
    [1, 3],
    [1, 6],
  ],
  4: SIDES,
  5: [...SIDES, [1, 3]],
  6: SIX,
  7: [...SIX, [1, 1.5]],
  8: [...SIX, [1, 1.5], [1, 4.5]],
  9: [...EIGHT_SIDES, [1, 3]],
  10: [...EIGHT_SIDES, [1, 1], [1, 5]],
};

export const pipLayout = (rank) => PIPS_BY_NAME[RANK_NAMES[rank]] || [];
export const isCourt = (rank) => ['J', 'Q', 'K'].includes(RANK_NAMES[rank]);

const COL_X = [24.5, 35, 45.5];
const ROW_Y = (row) => 23 + row * 8.7;

// The index in the top-left and (upside down) bottom-right corner.
function index(label, s) {
  const size = label.length > 1 ? 12 : 15;
  const top =
    `<text x="10" y="17" text-anchor="middle" font-size="${size}" font-weight="700" ` +
    `font-family="Georgia, 'Times New Roman', serif">${label}</text>` +
    suit(s, 10, 25.5, 0.5);
  return `${top}<g transform="rotate(180 35 49)">${top}</g>`;
}

// One half of a court card (top half; the other is the same turned about the centre line).
function courtHalf(label, s) {
  const robe = `<path d="M17 49C17 40 25.5 36.5 35 36.5S53 40 53 49Z"/>`;
  const collar = `<path d="M27.5 39.5 35 46 42.5 39.5" fill="none" stroke="${GOLD}" stroke-width="1.6"/>`;
  const face = `<circle cx="35" cy="31" r="6.2" fill="${SKIN}" stroke="currentColor" stroke-width=".6"/>`;
  const eyes = '<circle cx="32.6" cy="30.6" r=".7" fill="#222"/><circle cx="37.4" cy="30.6" r=".7" fill="#222"/>';
  let headgear;
  if (label === 'K') {
    headgear =
      `<path d="M29 25.2 28 19.5l3.7 2.7L35 19l3.3 3.2L42 19.5l-1 5.7Z" fill="${GOLD}" stroke="currentColor" stroke-width=".6"/>` +
      '<path d="M29.4 32.5Q35 44 40.6 32.5 35 36.6 29.4 32.5Z"/>';
  } else if (label === 'Q') {
    headgear =
      `<path d="M29.4 25.4 29 21.4l3.4 2.4L35 20.6l2.6 3.2L41 21.4l-.4 4Z" fill="${GOLD}" stroke="currentColor" stroke-width=".6"/>` +
      '<path d="M28.9 28C25.6 33 26.6 38 29.4 40.4L29.6 31.6ZM41.1 28C44.4 33 43.4 38 40.6 40.4L40.4 31.6Z"/>';
  } else {
    headgear =
      '<path d="M28.6 29.2C28.6 22.6 41.4 22.6 41.4 29.2Z"/>' +
      `<path d="M39.6 25.4Q46.5 20.4 49 25.8 44.4 24.4 41 28Z" fill="${GOLD}"/>`;
  }
  return (
    `<g>${robe}${collar}${face}${eyes}${headgear}</g>` +
    suit(s, 20.5, 25.5, 0.45) +
    '<path d="M15 49H55" stroke="currentColor" stroke-width=".4"/>'
  );
}

function court(label, s) {
  const half = courtHalf(label, s);
  return (
    '<rect x="15" y="19" width="40" height="60" rx="2" fill="currentColor" fill-opacity=".06" ' +
    'stroke="currentColor" stroke-width=".8"/>' +
    half +
    `<g transform="rotate(180 35 49)">${half}</g>`
  );
}

function pips(rank, s) {
  const out = [];
  for (const [col, row] of pipLayout(rank)) {
    const ace = RANK_NAMES[rank] === 'A';
    out.push(suit(s, COL_X[col], ROW_Y(row), ace ? 2.2 : 0.68, row > 3));
  }
  return out.join('');
}

const jesterFace = () =>
  `<rect x="15" y="19" width="40" height="60" rx="2" fill="currentColor" fill-opacity=".06" stroke="currentColor" stroke-width=".8"/>` +
  '<path d="M28 46Q22 34 15.5 36.5 21 40 23.5 49Z"/><path d="M42 46Q48 34 54.5 36.5 49 40 46.5 49Z"/>' +
  '<path d="M31 44Q35 29 35 25 35 29 39 44Z"/>' +
  `<g fill="${GOLD}"><circle cx="15.5" cy="36.5" r="2.4"/><circle cx="54.5" cy="36.5" r="2.4"/>` +
  '<circle cx="35" cy="24.2" r="2.4"/><rect x="27" y="43" width="16" height="4.4" rx="1"/></g>' +
  `<circle cx="35" cy="54.5" r="8" fill="${SKIN}" stroke="currentColor" stroke-width=".6"/>` +
  '<circle cx="32" cy="52.4" r=".9" fill="#222"/><circle cx="38" cy="52.4" r=".9" fill="#222"/>' +
  '<path d="M31 57.4Q35 61.6 39 57.4" fill="none" stroke="#222" stroke-width=".9"/>' +
  '<path d="M20 79C20 71 26 66.5 35 66.5S50 71 50 79Z"/>' +
  `<path d="M24.5 69 28 74.5 31.5 68.6 35 74.5 38.5 68.6 42 74.5 45.5 69" fill="none" stroke="${GOLD}" stroke-width="1.4"/>`;

const STAR = '<path d="M0-6 1.8-1.9 6.2-1.7 2.8 1.1 3.9 5.4 0 3 -3.9 5.4-2.8 1.1-6.2-1.7-1.8-1.9Z"/>';

// The SVG for card `c`. `mini` is the small table-top card: just the rank over the suit,
// because the full face turns to mush at 20 to 40 px wide.
export function cardSVG(c, mini = false) {
  const head = `<svg class="face" viewBox="0 0 ${VIEW_W} ${VIEW_H}" preserveAspectRatio="none" aria-hidden="true" focusable="false" fill="currentColor">`;
  let body;
  if (isJoker(c)) {
    body = mini
      ? `<g transform="translate(35 49) scale(3.4)">${STAR}</g>`
      : `${jesterFace()}<g transform="translate(10 15) scale(.75)">${STAR}</g>` +
        `<g transform="rotate(180 35 49)"><g transform="translate(10 15) scale(.75)">${STAR}</g></g>`;
  } else {
    const rank = rankOf(c);
    const s = suitOf(c);
    const label = RANK_NAMES[rank];
    if (mini) {
      const size = label.length > 1 ? 30 : 38;
      body =
        `<text x="35" y="42" text-anchor="middle" font-size="${size}" font-weight="700" ` +
        `font-family="Georgia, 'Times New Roman', serif">${label}</text>` +
        suit(s, 35, 71, 1.7);
    } else {
      body = index(label, s) + (isCourt(rank) ? court(label, s) : pips(rank, s));
    }
  }
  return `${head}${body}</svg>`;
}

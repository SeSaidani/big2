// Hand classification with wild jokers.
//
// classify(cards) returns null for an illegal combination, otherwise
//   { type, cat, key, label, jokerAs }
// where `key` is a single integer that totally orders hands of the same type:
// a play beats another iff the types match and its key is strictly greater.
// Jokers always resolve to the strongest identity available, found
// analytically rather than by enumerating 52^j identities. A joker may copy a
// card held elsewhere or already played, but within one flush it never
// duplicates a card in the same hand (no "double-ace flush"). Five of a kind
// necessarily repeats a card; for pairs, triples, straights, full houses and
// four of a kind the rule makes no difference to the result.
// Ties between otherwise-equal plays go to the one with more real cards.

import {
  RANK_NAMES,
  SUIT_NAMES,
  RANK_TWO,
  SPADES,
  isJoker,
  cardId,
  rankOf,
  suitOf,
  cardName,
  rankPlural,
} from './cards.js';

export const SINGLE = 'single';
export const PAIR = 'pair';
export const TRIPLE = 'triple';
export const FIVE = 'five';

export const STRAIGHT = 1;
export const FLUSH = 2;
export const FULL_HOUSE = 3;
export const FOUR_KIND = 4;
export const STRAIGHT_FLUSH = 5;
export const FIVE_KIND = 6;
export const CAT_NAMES = ['', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush', 'Five of a kind'];

// Within-category keys are < 13^5 * 4 ≈ 1.49e6, so this base keeps categories
// strictly separated in one integer.
const CAT_BASE = 2_000_000;

// "The real card beats the joker", in every hand type: key = base · TIE +
// (number of natural cards). A joker hand is ranked as the hand its jokers
// represent, and between otherwise-equal plays the one with more real cards
// wins; equal joker counts still tie. A lone joker is a 2♠ with no real card,
// so nothing beats the real 2♠, the real 2♠ beats a joker, and a joker beats
// everything below the 2♠.
// The exception is a pair, which is decided by its higher card alone (as in
// ordinary Big Two): its tie value is 1 if that higher card is real and 0 if it
// is a joker, whatever the lower card is. So two jokers (a pair of 2s with a
// joker as the 2♠ on top) are beaten only by a pair holding the real 2♠, and a
// joker with a real 2♥, 2♦ or 2♣ ties with them.
export const TIE = 8;
export const baseKey = (cls) => Math.floor(cls.key / TIE);
const withTie = (base, cards, jokers) => base * TIE + (cards - jokers);

const TWO_OF_SPADES = cardId(RANK_TWO, SPADES);

// The key classify() gives a lone card, and its inverse for messages.
export const singleKeyOf = (c) => (isJoker(c) ? withTie(TWO_OF_SPADES, 1, 1) : withTie(c, 1, 0));
export const singleName = (key) => (key % TIE === 0 ? 'a joker' : cardName((key - 1) / TIE));

// Straight windows in ascending strength. Ranks are Big Two indices (3=0 ..
// 2=12). A straight is worth its highest card, and in a straight the ace and
// the 2 are low: A-2-3-4-5 is a 5-high straight and 2-3-4-5-6 a 6-high one, so
// they are the two weakest straights, then 3-4-5-6-7 up to 10-J-Q-K-A.
// `top` is the highest card, whose suit breaks ties between equal straights.
export const WINDOWS = [
  { ranks: [11, 12, 0, 1, 2], top: 2 }, // A-2-3-4-5, ranked by the 5
  { ranks: [12, 0, 1, 2, 3], top: 3 }, // 2-3-4-5-6, ranked by the 6
];
for (let i = 0; i < 8; i++) {
  WINDOWS.push({ ranks: [i, i + 1, i + 2, i + 3, i + 4], top: i + 4 });
}
for (const w of WINDOWS) w.mask = w.ranks.reduce((m, r) => m | (1 << r), 0);

function bestWindow(rankMask) {
  for (let w = WINDOWS.length - 1; w >= 0; w--) {
    if ((rankMask & ~WINDOWS[w].mask) === 0) return w;
  }
  return -1;
}

function windowLabel(w) {
  const r = WINDOWS[w].ranks;
  return `${RANK_NAMES[r[0]]}–${RANK_NAMES[r[4]]}`;
}

const asCard = (rank, suit) => RANK_NAMES[rank] + SUIT_NAMES[suit];

// jokerAs has one entry per joker, so its length is the joker count.
function five(cat, key, label, jokerAs) {
  return { type: FIVE, cat, key: withTie(cat * CAT_BASE + key, 5, jokerAs.length), label, jokerAs };
}

export function classify(cards) {
  const n = cards.length;
  if (n !== 1 && n !== 2 && n !== 3 && n !== 5) return null;
  const nat = [];
  let j = 0;
  for (const c of cards) {
    if (isJoker(c)) j++;
    else nat.push(c);
  }
  if (n === 5) return classifyFive(nat, j);

  if (n === 1) {
    const label = j ? 'Joker' : cardName(nat[0]);
    return { type: SINGLE, cat: 0, key: singleKeyOf(cards[0]), label, jokerAs: [] };
  }
  const r = nat.length ? rankOf(nat[0]) : RANK_TWO;
  for (const c of nat) if (rankOf(c) !== r) return null;
  if (n === 2) {
    // A joker in a pair becomes the spade of that rank; two jokers are 2s. The pair is ranked by its higher card: a
    // real card on top beats a joker standing for the same card, and otherwise the lower card makes no difference.
    let suit = SPADES;
    let topIsReal = 1;
    if (!j) suit = Math.max(suitOf(nat[0]), suitOf(nat[1]));
    else topIsReal = nat.some((c) => suitOf(c) === SPADES) ? 1 : 0;
    const jokerAs = Array(j).fill(asCard(r, SPADES));
    return {
      type: PAIR,
      cat: 0,
      key: (r * 4 + suit) * TIE + topIsReal,
      label: `Pair of ${rankPlural(r)}`,
      jokerAs,
    };
  }
  return {
    type: TRIPLE,
    cat: 0,
    key: withTie(r, 3, j),
    label: `Three ${rankPlural(r)}`,
    jokerAs: Array(j).fill(RANK_NAMES[r]),
  };
}

function classifyFive(nat, j) {
  // j <= 4, so there is always at least one natural card.
  const cnt = new Array(13).fill(0);
  let rankMask = 0;
  const suit0 = suitOf(nat[0]);
  let sameSuit = true;
  for (const c of nat) {
    const r = rankOf(c);
    cnt[r]++;
    rankMask |= 1 << r;
    if (suitOf(c) !== suit0) sameSuit = false;
  }
  const ranks = [];
  for (let r = 12; r >= 0; r--) if (cnt[r]) ranks.push(r);
  const allDistinct = ranks.length === nat.length;
  const w = allDistinct ? bestWindow(rankMask) : -1;

  if (ranks.length === 1) {
    const r = ranks[0];
    return five(FIVE_KIND, r, `Five ${rankPlural(r)}`, Array(j).fill(RANK_NAMES[r]));
  }

  if (sameSuit && w >= 0) {
    const missing = WINDOWS[w].ranks.filter((r) => !cnt[r]);
    return five(
      STRAIGHT_FLUSH,
      w * 4 + suit0,
      `Straight flush ${windowLabel(w)}${SUIT_NAMES[suit0]}`,
      missing.map((r) => asCard(r, suit0)),
    );
  }

  if (ranks.length === 2) {
    const [a, b] = ranks; // a > b
    // Four of a kind: the other rank must be exactly the single kicker.
    let q = -1;
    if (cnt[b] === 1) q = a;
    else if (cnt[a] === 1) q = b;
    if (q >= 0) {
      return five(FOUR_KIND, q, `Four ${rankPlural(q)}`, Array(4 - cnt[q]).fill(RANK_NAMES[q]));
    }
    // Full house: both counts are now >= 2, so the higher rank can always
    // take the triple unless the lower rank already holds three naturals.
    const t = cnt[a] <= 3 && cnt[b] <= 2 ? a : b;
    const p = t === a ? b : a;
    const jokerAs = [...Array(3 - cnt[t]).fill(RANK_NAMES[t]), ...Array(2 - cnt[p]).fill(RANK_NAMES[p])];
    return five(FULL_HOUSE, t, `Full house, ${rankPlural(t)} over ${rankPlural(p)}`, jokerAs);
  }

  if (sameSuit) {
    // Jokers take the highest ranks absent from the hand. They cannot have
    // formed a straight flush, otherwise that branch would have fired.
    const fill = [];
    for (let r = 12; r >= 0 && fill.length < j; r--) if (!cnt[r]) fill.push(r);
    const all = [...ranks, ...fill].sort((x, y) => y - x);
    let key = 0;
    for (const r of all) key = key * 13 + r;
    key = key * 4 + suit0;
    return five(
      FLUSH,
      key,
      `Flush ${SUIT_NAMES[suit0]}, ${RANK_NAMES[all[0]]} high`,
      fill.map((r) => asCard(r, suit0)),
    );
  }

  if (w >= 0) {
    const { top, ranks: wr } = WINDOWS[w];
    const topCard = nat.find((c) => rankOf(c) === top);
    const topSuit = topCard === undefined ? SPADES : suitOf(topCard);
    const missing = wr.filter((r) => !cnt[r]);
    return five(
      STRAIGHT,
      w * 4 + topSuit,
      `Straight ${windowLabel(w)}`,
      missing.map((r) => asCard(r, SPADES)),
    );
  }
  return null;
}

export function beats(a, b) {
  return a.type === b.type && a.key > b.key;
}

export function describe(cls) {
  if (!cls) return 'Not a valid hand';
  const jokers = cls.jokerAs.length ? ` (joker as ${cls.jokerAs.join(', ')})` : '';
  return cls.label + jokers;
}

// Card model. Natural cards are ids 0..51, rank-major: id = rank * 4 + suit,
// so numeric id order is exactly Big Two single-card order (3♦ lowest, 2♠
// highest). Jokers are ids 52..55 and are interchangeable in play.

export const RANK_NAMES = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
export const SUIT_NAMES = ['♦', '♣', '♥', '♠'];
export const NUM_RANKS = 13;
export const NUM_PLAYERS = 4;
export const FIRST_JOKER = 52;
export const DECK_SIZE = 56;
export const HAND_SIZE = 14;
export const THREE_OF_DIAMONDS = 0;
export const RANK_TWO = 12;
export const SPADES = 3;

export const isJoker = (c) => c >= FIRST_JOKER;
export const rankOf = (c) => c >> 2;
export const suitOf = (c) => c & 3;
export const cardId = (rank, suit) => rank * 4 + suit;
export const isRedSuit = (s) => s === 0 || s === 2;

export function cardName(c) {
  return isJoker(c) ? 'Joker' : RANK_NAMES[rankOf(c)] + SUIT_NAMES[suitOf(c)];
}

export function rankPlural(r) {
  return RANK_NAMES[r] + 's';
}

// Small, fast, seedable PRNG (mulberry32) so games and tests are reproducible.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const k = Math.floor(rng() * (i + 1));
    const t = arr[i];
    arr[i] = arr[k];
    arr[k] = t;
  }
  return arr;
}

export function dealHands(rng = Math.random) {
  const deck = shuffle(
    Array.from({ length: DECK_SIZE }, (_, i) => i),
    rng,
  );
  const hands = [];
  for (let p = 0; p < NUM_PLAYERS; p++) {
    hands.push(deck.slice(p * HAND_SIZE, (p + 1) * HAND_SIZE).sort((a, b) => a - b));
  }
  return hands;
}

export function sortByRank(cards) {
  return [...cards].sort((a, b) => a - b);
}

export function sortBySuit(cards) {
  const k = (c) => (isJoker(c) ? 1000 + c : suitOf(c) * 100 + rankOf(c));
  return [...cards].sort((a, b) => k(a) - k(b));
}

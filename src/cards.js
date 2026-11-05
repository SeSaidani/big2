// Card model. Natural cards are ids 0..51, rank-major: id = rank * 4 + suit,
// so numeric id order is exactly Big Two single-card order (3♦ lowest, 2♠
// highest). Jokers are ids 52..55 and are interchangeable in play.

export const RANK_NAMES = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
export const SUIT_NAMES = ['♦', '♣', '♥', '♠'];
export const NUM_RANKS = 13;
export const NUM_PLAYERS = 4; // the usual table; games can also seat 3 (see dealHands)
export const PLAYER_COUNTS = [3, 4];
export const FIRST_JOKER = 52;
export const DECK_SIZE = 56;
export const HAND_SIZE = 14; // each hand at a table of 4
export const HAND_SIZE_3 = 18; // each hand at a table of 3, before the two spare cards
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

export const SPADE_TWO = cardId(RANK_TWO, SPADES); // 51

// Deals a shuffled 56-card deck to 4 players (14 each) or 3 (18 each, plus the two spare cards).
//
// Three players: 3 x 18 = 54 leaves 2 spare cards. They go one each to the holder of the 3♦ (who must
// open, so the extra card is their price for it) and to the holder of the 2♠ (the highest card). If one
// player holds both, they get both. So the 3♦ holder has 19 cards (20 if they also hold the 2♠), and the
// 2♠ holder 19. To make "the holder" well defined, the spares are drawn from the 54 cards other than the
// 3♦ and 2♠, then the rest are dealt; the spares are therefore uniformly random among those.
export function dealHands(rng = Math.random, players = NUM_PLAYERS) {
  if (!PLAYER_COUNTS.includes(players)) throw new RangeError(`A table seats 3 or 4 players, not ${players}`);
  const deck = shuffle(
    Array.from({ length: DECK_SIZE }, (_, i) => i),
    rng,
  );
  const byId = (a, b) => a - b;
  if (players === NUM_PLAYERS) {
    return Array.from({ length: players }, (_, p) => deck.slice(p * HAND_SIZE, (p + 1) * HAND_SIZE).sort(byId));
  }
  const special = new Set([THREE_OF_DIAMONDS, SPADE_TWO]);
  const others = deck.filter((c) => !special.has(c));
  const spare = others.slice(0, DECK_SIZE - players * HAND_SIZE_3);
  const dealt = deck.filter((c) => !spare.includes(c));
  const hands = Array.from({ length: players }, (_, p) => dealt.slice(p * HAND_SIZE_3, (p + 1) * HAND_SIZE_3));
  hands[hands.findIndex((h) => h.includes(THREE_OF_DIAMONDS))].push(spare[0]);
  hands[hands.findIndex((h) => h.includes(SPADE_TWO))].push(spare[1]);
  return hands.map((h) => h.sort(byId));
}

export function sortByRank(cards) {
  return [...cards].sort((a, b) => a - b);
}

export function sortBySuit(cards) {
  const k = (c) => (isJoker(c) ? 1000 + c : suitOf(c) * 100 + rankOf(c));
  return [...cards].sort((a, b) => k(a) - k(b));
}

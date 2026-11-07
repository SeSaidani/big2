import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardId, FIRST_JOKER } from '../src/cards.js';
import {
  classify,
  baseKey,
  beats,
  SINGLE,
  PAIR,
  TRIPLE,
  FIVE,
  STRAIGHT,
  FLUSH,
  FULL_HOUSE,
  FOUR_KIND,
  STRAIGHT_FLUSH,
  FIVE_KIND,
} from '../src/hands.js';

// Parse "10♠ J♦ X" style strings; X is a joker.
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const SUITS = ['♦', '♣', '♥', '♠'];
function cards(str) {
  let joker = FIRST_JOKER;
  return str.split(/\s+/).map((t) => {
    if (t === 'X') return joker++;
    const s = SUITS.indexOf(t.slice(-1));
    const r = RANKS.indexOf(t.slice(0, -1));
    assert.ok(s >= 0 && r >= 0, `bad card ${t}`);
    return cardId(r, s);
  });
}
const C = (s) => classify(cards(s));

test('singles: rank then suit; a joker is a 2♠ that the real 2♠ beats, and jokers do not beat each other', () => {
  assert.ok(beats(C('3♠'), C('3♥')));
  assert.ok(beats(C('4♦'), C('3♠')));
  assert.ok(beats(C('2♦'), C('A♠')));
  assert.ok(beats(C('X'), C('2♥')));
  assert.ok(!beats(C('X'), C('2♠')));
  assert.ok(beats(C('2♠'), C('X')));
  assert.ok(!beats(C('X'), C('X')));
  assert.equal(C('X').type, SINGLE);
});

test('pairs and triples, with jokers', () => {
  assert.equal(C('5♦ 5♣').type, PAIR);
  assert.equal(C('5♦ 6♣'), null);
  assert.ok(beats(C('5♦ 5♠'), C('5♣ 5♥')));
  // A joker pairs as the spade: 5♦+X equals 5♣ 5♠ and so cannot beat it.
  assert.ok(!beats(C('5♦ X'), C('5♣ 5♠')));
  assert.ok(beats(C('5♦ X'), C('5♣ 5♥')));
  // Two jokers are a pair of 2s with the spade: unbeatable as a pair.
  assert.ok(beats(C('X X'), C('2♦ 2♥')));
  assert.ok(!beats(C('X X'), C('2♣ 2♠')));
  assert.equal(C('7♦ 7♣ X').type, TRIPLE);
  assert.equal(C('X X X').label, 'Three 2s');
  assert.ok(beats(C('8♦ X X'), C('7♦ 7♣ 7♠')));
  assert.equal(C('7♦ 8♣ X'), null);
});

test('five-card categories without jokers', () => {
  assert.equal(C('3♦ 4♣ 5♥ 6♠ 7♦').cat, STRAIGHT);
  assert.equal(C('3♦ 5♦ 9♦ J♦ K♦').cat, FLUSH);
  assert.equal(C('9♦ 9♣ 9♥ J♠ J♦').cat, FULL_HOUSE);
  assert.equal(C('9♦ 9♣ 9♥ 9♠ 3♦').cat, FOUR_KIND);
  assert.equal(C('5♥ 6♥ 7♥ 8♥ 9♥').cat, STRAIGHT_FLUSH);
  assert.equal(C('3♦ 4♣ 5♥ 6♠ 8♦'), null);
  assert.equal(C('9♦ 9♣ 9♥ J♠ Q♦'), null);
  // Category order beats rank within category.
  assert.ok(beats(C('3♦ 5♦ 9♦ J♦ K♦'), C('10♦ J♣ Q♥ K♠ A♦')));
  assert.ok(beats(C('3♦ 3♣ 3♥ 4♠ 4♦'), C('2♦ 5♦ 9♦ J♦ K♦')));
  assert.ok(beats(C('3♦ 3♣ 3♥ 3♠ 4♦'), C('2♦ 2♣ 2♥ A♠ A♦')));
  assert.ok(beats(C('3♦ 4♦ 5♦ 6♦ 7♦'), C('2♦ 2♣ 2♥ 2♠ A♦')));
});

test('straights are worth their highest card; ace and 2 are low in A-2-3-4-5 and 2-3-4-5-6', () => {
  const wheel = C('A♦ 2♣ 3♥ 4♠ 5♦'); // 5-high
  const six = C('2♦ 3♣ 4♥ 5♠ 6♦'); // 6-high
  const low = C('3♦ 4♣ 5♥ 6♠ 7♦'); // 7-high
  const eight = C('4♦ 5♣ 6♥ 7♠ 8♦');
  const broadway = C('10♦ J♣ Q♥ K♠ A♦'); // ace-high
  assert.ok(beats(six, wheel));
  assert.ok(beats(low, six), 'a 2 does not make 2-3-4-5-6 beat 3-4-5-6-7');
  assert.ok(beats(low, wheel));
  assert.ok(beats(eight, low));
  assert.ok(beats(broadway, eight));
  assert.ok(!beats(wheel, broadway) && !beats(six, broadway) && !beats(wheel, low));
  assert.equal(C('J♦ Q♣ K♥ A♠ 2♦'), null);
  assert.equal(C('Q♦ K♣ A♥ 2♠ 3♦'), null);
  assert.equal(C('K♦ A♣ 2♥ 3♠ 4♦'), null);
  // Equal straights: only the suit of the highest card decides (the 5 / the 6
  // in the two low straights, not the ace or the 2).
  assert.ok(beats(C('3♦ 4♦ 5♦ 6♦ 7♠'), C('3♠ 4♠ 5♠ 6♠ 7♥')));
  assert.ok(!beats(C('3♠ 4♠ 5♠ 6♠ 7♥'), C('3♦ 4♦ 5♦ 6♦ 7♠')));
  assert.ok(beats(C('A♦ 2♦ 3♦ 4♦ 5♠'), C('A♠ 2♠ 3♠ 4♠ 5♥')));
  assert.ok(!beats(C('A♠ 2♠ 3♠ 4♠ 5♥'), C('A♦ 2♦ 3♦ 4♦ 5♠')));
  assert.ok(beats(C('2♦ 3♦ 4♦ 5♦ 6♠'), C('2♠ 3♠ 4♠ 5♠ 6♥')));
  // Straight flushes follow the same order.
  assert.ok(beats(C('3♦ 4♦ 5♦ 6♦ 7♦'), C('2♠ 3♠ 4♠ 5♠ 6♠')));
  assert.ok(beats(C('2♦ 3♦ 4♦ 5♦ 6♦'), C('A♠ 2♠ 3♠ 4♠ 5♠')));
  // Jokers take the strongest window: 2-3-4-5 + joker is 2-3-4-5-6, not A-5.
  const j = C('2♦ 3♣ 4♥ 5♠ X');
  assert.ok(j.label.startsWith('Straight 2–6'), j.label);
  assert.deepEqual(j.jokerAs, ['6♠']);
  // 3-4-5-6 + joker is 3-7 (7-high), which beats 2-3-4-5-6.
  assert.ok(C('3♦ 4♣ 5♥ 6♠ X').label.startsWith('Straight 3–7'));
});

test('flush compares by highest card, then next, then suit', () => {
  assert.ok(beats(C('3♦ 5♦ 9♦ J♦ A♦'), C('3♠ 5♠ 9♠ J♠ K♠')));
  assert.ok(beats(C('4♦ 5♦ 9♦ J♦ A♦'), C('3♠ 5♠ 9♠ J♠ A♠')));
  assert.ok(beats(C('3♠ 5♠ 9♠ J♠ A♠'), C('3♦ 5♦ 9♦ J♦ A♦')));
});

test('jokers resolve to the strongest possible five-card hand', () => {
  // Four naturals of a rank plus a joker is five of a kind.
  assert.equal(C('9♦ 9♣ 9♥ 9♠ X').cat, FIVE_KIND);
  // Four jokers and anything is five of a kind.
  assert.equal(C('3♦ X X X X').cat, FIVE_KIND);
  // Same-suit run with a gap becomes a straight flush, not a flush.
  const sf = C('5♥ 6♥ 8♥ 9♥ X');
  assert.equal(sf.cat, STRAIGHT_FLUSH);
  assert.deepEqual(sf.jokerAs, ['7♥']);
  // The joker extends to the highest window it fits: 6-10 over 5-9.
  const ext = C('6♥ 7♥ 8♥ 9♥ X');
  assert.ok(ext.label.startsWith('Straight flush 6–10'), ext.label);
  assert.deepEqual(ext.jokerAs, ['10♥']);
  // Two pairs plus joker: full house on the higher rank.
  const fh = C('9♦ 9♣ J♥ J♠ X');
  assert.equal(fh.cat, FULL_HOUSE);
  assert.ok(fh.label.startsWith('Full house, Js over 9s'));
  // Trips plus kicker plus joker: four of a kind beats full house.
  assert.equal(C('9♦ 9♣ 9♥ J♠ X').cat, FOUR_KIND);
  // Two singles plus three jokers: four of the higher rank.
  assert.ok(C('4♦ J♠ X X X').label.startsWith('Four Js'));
  // Same-suit, no straight possible: flush with jokers as the top ranks.
  const fl = C('3♦ 7♦ J♦ X X');
  assert.equal(fl.cat, FLUSH);
  assert.deepEqual(fl.jokerAs, ['2♦', 'A♦']);
  // Straight with joker in the top slot takes the spade.
  assert.ok(beats(C('3♦ 4♣ 5♥ 6♠ X'), C('3♣ 4♣ 5♥ 6♠ 7♥')));
});

test('the real card beats the joker when plays are otherwise equal', () => {
  // Pairs are decided by their higher card: a joker pairs as the spade, and the real spade on top wins.
  assert.ok(beats(C('5♣ 5♠'), C('5♦ X')));
  assert.ok(!beats(C('5♦ X'), C('5♣ 5♠')));
  assert.ok(beats(C('2♣ 2♠'), C('X X')));
  assert.ok(beats(C('2♠ X'), C('X X')));
  // A joker with a real 2♦ has a joker on top, like two jokers: they tie, and neither can be played on the other.
  assert.ok(!beats(C('2♦ X'), C('X X')));
  assert.ok(!beats(C('X X'), C('2♦ X')));
  // The tie-break never overrides real strength.
  assert.ok(beats(C('5♦ X'), C('5♣ 5♥')));
  assert.ok(beats(C('X X'), C('2♦ 2♥')));
  // Triples.
  assert.ok(beats(C('7♦ 7♣ 7♠'), C('7♥ 7♠ X')));
  assert.ok(beats(C('7♥ 7♠ X'), C('7♦ X X')));
  // Five-card: same straight 4-8, joker as the top 8♠ vs the real 8♠.
  const jokerStraight = C('4♣ 5♣ 6♥ 7♠ X');
  assert.deepEqual(jokerStraight.jokerAs, ['8♠']);
  assert.ok(beats(C('4♦ 5♣ 6♥ 7♠ 8♠'), jokerStraight));
  assert.ok(!beats(jokerStraight, C('4♦ 5♣ 6♥ 7♠ 8♠')));
  // Same full house rank: fewer jokers wins.
  assert.ok(beats(C('9♦ 9♣ 9♥ 4♠ 4♦'), C('9♠ 9♣ X J♠ J♦')) === false); // 9s over Js vs 9s over 4s: equal rank
  assert.ok(beats(C('9♦ 9♣ 9♥ 4♠ 4♦'), C('9♠ 9♣ X 4♣ 4♥')));
  // Equal joker counts still tie: neither beats the other.
  assert.ok(!beats(C('5♦ X'), C('5♥ X')));
  assert.ok(!beats(C('5♥ X'), C('5♦ X')));
  // Singles: a lone joker is a 2♠, so the real 2♠ wins and nothing real above 2♥ loses to it.
  assert.ok(beats(C('2♠'), C('X')));
  assert.ok(!beats(C('X'), C('2♠')));
});

test('classification is invariant to card order and joker identity', () => {
  const a = classify([52, cardId(5, 1), cardId(5, 2), cardId(9, 0), 55]);
  const b = classify([cardId(9, 0), 53, cardId(5, 2), 54, cardId(5, 1)]);
  assert.deepEqual(a, b);
});

// Brute-force reference: try every concrete identity for each joker (with
// replacement, allowing copies) and classify the resulting natural-only hand
// with a standard poker-style evaluator written independently of hands.js.
function referenceBest(nat, j) {
  let best = -1;
  const ids = [...nat];
  const rec = (k) => {
    if (k === j) {
      const v = refFive(ids);
      if (v > best) best = v;
      return;
    }
    for (let id = 0; id < 52; id++) {
      ids.push(id);
      rec(k + 1);
      ids.pop();
    }
  };
  rec(0);
  return best;
}

// Weakest first: A-2-3-4-5 (5-high), 2-3-4-5-6 (6-high), then 3-7 .. 10-A.
const WIN = [
  [11, 12, 0, 1, 2],
  [12, 0, 1, 2, 3],
];
for (let i = 0; i < 8; i++) WIN.push([i, i + 1, i + 2, i + 3, i + 4]);
const WIN_TOP = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]; // rank of each window's highest card

function refFive(ids) {
  const r = ids.map((c) => c >> 2);
  const s = ids.map((c) => c & 3);
  const cnt = new Map();
  for (const x of r) cnt.set(x, (cnt.get(x) || 0) + 1);
  const counts = [...cnt.values()].sort((a, b) => b - a);
  const flush = s.every((x) => x === s[0]);
  const rs = new Set(r);
  let win = -1;
  if (rs.size === 5) {
    for (let w = WIN.length - 1; w >= 0; w--) {
      if (WIN[w].every((x) => rs.has(x))) {
        win = w;
        break;
      }
    }
  }
  const B = 2_000_000;
  const rankWith = (n) => [...cnt].filter(([, v]) => v === n).map(([k]) => k)[0];
  const topSuit = () => {
    const top = WIN_TOP[win];
    return Math.max(...ids.filter((c) => c >> 2 === top).map((c) => c & 3));
  };
  if (counts[0] === 5) return 6 * B + r[0];
  if (flush && win >= 0) return 5 * B + win * 4 + s[0];
  if (counts[0] === 4) return 4 * B + rankWith(4);
  if (counts[0] === 3 && counts[1] === 2) return 3 * B + rankWith(3);
  if (flush && new Set(ids).size === 5) {
    let key = 0;
    for (const x of [...r].sort((a, b) => b - a)) key = key * 13 + x;
    return 2 * B + key * 4 + s[0];
  }
  if (win >= 0) return B + win * 4 + topSuit(); // category 1 (straight)
  return -1;
}

test('analytic joker resolution matches brute force over joker identities', () => {
  let rng = 12345;
  const rand = (n) => {
    rng = (rng * 1103515245 + 12345) % 2147483648;
    return rng % n;
  };
  let checked = 0;
  for (let iter = 0; iter < 3000; iter++) {
    const j = iter < 1500 ? 1 : 2;
    const nat = new Set();
    while (nat.size < 5 - j) nat.add(rand(52));
    // Bias towards structured hands so every category gets exercised.
    if (iter % 3 === 0) {
      const base = [...nat][0];
      const arr = [...nat];
      arr[1] = (base & ~3) | ((base + 1) & 3);
      if (new Set(arr).size === arr.length) {
        nat.clear();
        arr.forEach((x) => nat.add(x));
      }
    }
    if (iter % 3 === 1) {
      const s = rand(4);
      const arr = [...nat].map((c) => (c & ~3) | s);
      if (new Set(arr).size === arr.length) {
        nat.clear();
        arr.forEach((x) => nat.add(x));
      }
    }
    const natArr = [...nat];
    const jokers = Array.from({ length: j }, (_, i) => FIRST_JOKER + i);
    const got = classify([...natArr, ...jokers]);
    const want = referenceBest(natArr, j);
    assert.equal(got ? baseKey(got) : -1, want, `nat=${natArr} j=${j}`);
    checked++;
  }
  assert.equal(checked, 3000);
});

test('natural five-card hands match the reference evaluator', () => {
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 48271) % 2147483647;
    return seed % n;
  };
  for (let iter = 0; iter < 20000; iter++) {
    const s = new Set();
    while (s.size < 5) s.add(rand(52));
    const arr = [...s];
    const got = classify(arr);
    assert.equal(got ? baseKey(got) : -1, refFive(arr), `hand=${arr}`);
    if (got) assert.equal(got.type, FIVE);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, cardId, FIRST_JOKER } from '../src/cards.js';
import { classify } from '../src/hands.js';
import { newGame, applyMove, autoSkip, observe, validatePlay, checkInvariants } from '../src/game.js';
import { chooseMove } from '../src/ai/agents.js';
import { greedyMove } from '../src/ai/greedy.js';
import { Planner, buildContext, HeuristicRollout } from '../src/ai/heuristic.js';
import { sampleDeterminizations } from '../src/ai/ismcts.js';

function playOut(levels, seed, opts = {}) {
  const rng = mulberry32(seed);
  const s = newGame(rng);
  while (s.winner < 0) {
    const m = chooseMove(observe(s, s.turn), levels[s.turn], { rng, ...opts });
    const cards = m ? m.cards : null;
    assert.equal(validatePlay(s, cards), null, `${levels[s.turn]} played ${cards}`);
    applyMove(s, cards, m ? m.cls : null);
    if (cards) autoSkip(s);
    checkInvariants(s);
  }
  return s.winner;
}

test('every AI level only makes legal moves (incl. lead passes and the last-card rule)', () => {
  for (let g = 0; g < 40; g++) playOut(['easy', 'medium', 'random', 'medium'], 500 + g);
  for (let g = 0; g < 40; g++) playOut(['random', 'easy', 'medium', 'random'], 700 + g);
  for (let g = 0; g < 6; g++) playOut(['hard', 'random', 'easy', 'medium'], 900 + g, { iterations: 60 });
});

test('agents obey the last-card rule when the next seat has one card', () => {
  const view = {
    me: 0,
    hand: [cardId(0, 1), cardId(4, 2), cardId(9, 0), cardId(11, 3)],
    counts: [4, 1, 5, 5],
    trick: null,
    passed: [false, false, false, false],
    leadPasses: 0,
    first: false,
    played: [],
    history: [],
  };
  // Pad `played` so card counting is consistent with the counts above.
  const inHands = 4 + 1 + 5 + 5;
  for (let c = 0; c < 56 && view.played.length < 56 - inHands; c++) if (!view.hand.includes(c)) view.played.push(c);
  for (const level of ['easy', 'medium', 'random']) {
    for (let i = 0; i < 20; i++) {
      const m = chooseMove(view, level, { rng: mulberry32(i) });
      if (m && m.cards.length === 1) assert.equal(m.cards[0], cardId(11, 3), level);
    }
  }
});

test('heuristic rollout policy plays only legal moves, remapping joker ids', () => {
  // Regression: the cached planner holds the starting hand's joker ids, so
  // after a joker is played a planned combo could name one no longer held.
  let jokerPlays = 0;
  for (let g = 0; g < 150; g++) {
    const s = newGame(mulberry32(3000 + g));
    const policy = new HeuristicRollout(s);
    while (s.winner < 0) {
      const m = policy.move(s);
      assert.equal(validatePlay(s, m ? m.cards : null), null);
      if (m && m.cards.some((c) => c >= FIRST_JOKER)) jokerPlays++;
      applyMove(s, m ? m.cards : null, m ? m.cls : null);
    }
  }
  assert.ok(jokerPlays > 50, 'test should exercise joker plays');
});

test('greedy never follows a joker single with a joker (jokers tie)', () => {
  const state = {
    hands: [
      [cardId(0, 1), FIRST_JOKER],
      [5, 6],
      [7, 8],
      [9, 10],
    ],
    turn: 0,
    trick: { cards: [FIRST_JOKER + 1], cls: classify([FIRST_JOKER + 1]), by: 1 },
    first: false,
  };
  for (let i = 0; i < 50; i++) assert.equal(greedyMove(state, mulberry32(i)), null);
});

test('decomposition finds the minimum-cost partition', () => {
  // 3♦ 4♣ 5♥ 6♠ 7♦ + 9♦ 9♣: best plan is a straight and a pair (2 combos).
  const hand = [cardId(0, 0), cardId(1, 1), cardId(2, 2), cardId(3, 3), cardId(4, 0), cardId(6, 0), cardId(6, 1)];
  const view = { me: 0, hand, played: [], counts: [7, 14, 14, 14] };
  const planner = new Planner(hand, buildContext(view));
  const { combos } = planner.plan(hand);
  assert.equal(combos.length, 2);
  assert.deepEqual(combos.map((e) => e.cards.length).sort(), [2, 5]);
  const used = combos.flatMap((e) => e.cards).sort((a, b) => a - b);
  assert.deepEqual(
    used,
    [...hand].sort((a, b) => a - b),
  );
});

test('determinisations respect card counts and never deal seen cards', () => {
  const rng = mulberry32(3);
  const s = newGame(rng);
  // Play a few greedy moves to create history.
  for (let k = 0; k < 12 && s.winner < 0; k++) {
    const m = greedyMove(s, rng);
    applyMove(s, m ? m.cards : null, m ? m.cls : null);
  }
  const view = observe(s, s.turn);
  const dets = sampleDeterminizations(view, rng, 30);
  const seen = new Set([...view.hand, ...view.played]);
  for (const d of dets) {
    assert.deepEqual(d.hands[view.me], view.hand);
    d.hands.forEach((h, p) => assert.equal(h.length, view.counts[p]));
    const all = d.hands.flat();
    assert.equal(new Set(all).size, all.length);
    for (let p = 0; p < 4; p++) if (p !== view.me) for (const c of d.hands[p]) assert.ok(!seen.has(c));
  }
});

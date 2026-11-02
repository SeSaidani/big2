import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/cards.js';
import { newGame, applyMove, autoSkip, observe, legalMoves, validatePlay, turnRules } from '../src/game.js';
import { mirrorState, newEvents, seatNames, isComputer, isAway, rot, unrot } from '../src/online-view.js';

// Seat 3 is a bot; seat 2 is a person with no open connection.
const seats = (names) =>
  names.map((n, i) => ({ kind: i === 3 ? 'ai' : 'human', name: n, online: i === 3 ? null : i !== 2 }));

// What the server would send to `you` for state s.
const tableFor = (s, you, hands = null) => ({
  you,
  seats: seats(['a', 'b', 'c', 'd']),
  hands,
  game: { view: observe(s, you), turn: s.turn, winner: s.winner, rules: null },
});

// A random legal game, recording the kind of each history entry as it happens.
function simulate(seed, onState) {
  const rng = mulberry32(seed);
  const s = newGame(rng);
  const kinds = [];
  onState(s);
  while (s.winner < 0) {
    const moves = legalMoves(s);
    const canPass = turnRules(s).canPass;
    const pass = canPass && (!moves.length || rng() < 0.3);
    if (pass) {
      kinds.push(s.trick ? 'pass' : 'leadpass');
      applyMove(s, null);
    } else {
      const m = moves[Math.floor(rng() * moves.length)];
      kinds.push('play');
      applyMove(s, m.cards, m.cls);
      for (const _ of autoSkip(s)) kinds.push('auto');
    }
    onState(s);
  }
  return { s, kinds };
}

test('rot and unrot are inverse for every viewer', () => {
  for (let you = 0; you < 4; you++) {
    assert.equal(rot(you, you), 0);
    for (let d = 0; d < 4; d++) assert.equal(rot(unrot(d, you), you), d);
  }
});

test('the mirror is a faithful, rotated copy: you at seat 0, hidden hands as placeholders', () => {
  simulate(1, (s) => {
    for (let you = 0; you < 4; you++) {
      const m = mirrorState(tableFor(s, you));
      assert.equal(m.turn, rot(s.turn, you));
      assert.deepEqual(m.hands[0], s.hands[you]);
      for (let d = 1; d < 4; d++) {
        const q = unrot(d, you);
        assert.equal(m.hands[d].length, s.hands[q].length);
        assert.ok(
          m.hands[d].every((c) => c === -1),
          'other hands must be placeholders',
        );
        assert.equal(m.passed[d], s.passed[q]);
      }
      assert.equal(m.trick ? m.trick.by : null, s.trick ? rot(s.trick.by, you) : null);
    }
  });
});

test('rules computed on the mirror equal the server rules for the player to move', () => {
  let checked = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const rng = mulberry32(seed * 77);
    simulate(seed, (s) => {
      if (s.winner >= 0) return;
      const you = s.turn;
      const m = mirrorState(tableFor(s, you));
      assert.equal(m.turn, 0);
      assert.deepEqual(turnRules(m), turnRules(s));
      // Every legal move is accepted; random subsets are judged identically.
      for (const mv of legalMoves(s)) assert.equal(validatePlay(m, mv.cards), null);
      assert.equal(validatePlay(m, null), validatePlay(s, null));
      const hand = s.hands[you];
      for (let k = 0; k < 12; k++) {
        const size = 1 + Math.floor(rng() * 5);
        const subset = [...hand].sort(() => rng() - 0.5).slice(0, size);
        assert.equal(validatePlay(m, subset), validatePlay(s, subset), JSON.stringify(subset));
        checked++;
      }
    });
  }
  assert.ok(checked > 500);
});

test('when the round is over the mirror shows every hand', () => {
  const { s } = simulate(3, () => {});
  const you = 2;
  const m = mirrorState(tableFor(s, you, s.hands));
  assert.equal(m.winner, rot(s.winner, you));
  for (let d = 0; d < 4; d++) assert.deepEqual(m.hands[d], s.hands[unrot(d, you)]);
  assert.equal(m.hands[rot(s.winner, you)].length, 0);
});

test('newEvents reports each history entry once, classified, in display seats', () => {
  for (const you of [0, 1, 3]) {
    // Feed the client a view after every move; it only keeps the length.
    let prev = 0;
    const got = [];
    const { kinds, s } = simulate(10 + you, (st) => {
      const t = tableFor(st, you);
      const ev = newEvents(prev, t);
      prev = t.game.view.history.length;
      for (const e of ev) got.push(e);
    });
    const kindOf = (e) => (e.cards ? 'play' : e.auto ? 'auto' : e.leadPass ? 'leadpass' : 'pass');
    assert.deepEqual(got.map(kindOf), kinds);
    assert.deepEqual(
      got.map((e) => e.p),
      s.history.map((h) => rot(h.p, you)),
    );
    assert.ok(got.filter((e) => e.cards).every((e) => e.cls && e.cls.type));
    // A late joiner who starts from zero sees the same list.
    assert.equal(newEvents(0, tableFor(s, you)).length, got.length);
  }
});

test('seat names are rotated; offline people are labelled; computers and absentees are identified', () => {
  const t = { you: 1, seats: seats(['a', 'b', 'c', 'd']) };
  assert.deepEqual(seatNames(t), ['You', 'c (offline)', 'd', 'a']);
  assert.equal(isComputer(t, 2), true); // 'd', a bot
  assert.equal(isComputer(t, 1), false); // 'c' is a person
  assert.equal(isAway(t, 1), true); // 'c' is offline
  assert.equal(isAway(t, 2), false); // bots are never "away"
  assert.equal(isAway(t, 3), false); // 'a' is online
});

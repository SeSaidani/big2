import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/cards.js';
import { classify } from '../src/hands.js';
import { newGame, applyMove, autoSkip, legalMoves, turnRules } from '../src/game.js';
import { serializeSolo, readSavedSolo } from '../src/solo-save.js';

const LEVELS = ['easy', 'medium', 'hard'];

// Plays a random legal game and calls back with the state after every move, as the page would have it.
function playRandom(players, seed, onState) {
  const rng = mulberry32(seed);
  const s = newGame(rng, null, players);
  onState(s, 0);
  let moves = 0;
  while (s.winner < 0 && moves < 600) {
    const legal = legalMoves(s);
    const pass = turnRules(s).canPass && (!legal.length || rng() < 0.3);
    const m = pass ? null : legal[Math.floor(rng() * legal.length)];
    applyMove(s, m ? m.cards : null, m ? classify(m.cards) : null);
    if (m) autoSkip(s);
    moves++;
    onState(s, moves);
  }
  return s;
}

const saved = (players, game, extra = {}) =>
  serializeSolo({
    id: 'g-test-1',
    level: 'medium',
    players,
    game,
    shownTrick: game.trick ? { cards: game.trick.cards, cls: game.trick.cls, by: game.trick.by } : null,
    seatActions: new Array(players).fill(null),
    log: [{ text: 'New round.', cls: 'sys', cards: null }],
    overlay: false,
    ...extra,
  });

test('a solo game comes back from storage exactly as it was, at any point of a game, at 3 and 4 players', () => {
  let checked = 0;
  for (const players of [3, 4]) {
    for (let seed = 1; seed <= 25; seed++) {
      playRandom(players, 100 + seed, (s, moves) => {
        if (moves % 3 !== 0 && s.winner < 0) return; // a sample of positions, and every finished game
        const back = readSavedSolo(saved(players, s), LEVELS);
        assert.ok(back, `seed ${seed}, move ${moves}`);
        assert.deepEqual(back.game, JSON.parse(JSON.stringify(s)), `seed ${seed}, move ${moves}`);
        assert.equal(back.players, players);
        assert.equal(back.id, 'g-test-1');
        checked++;
      });
    }
  }
  assert.ok(checked > 200, `only ${checked} positions checked`);
});

test('the hand classifications come back recomputed, not read from the text', () => {
  let withTrick = null;
  playRandom(4, 8, (st) => {
    if (!withTrick && st.trick) withTrick = JSON.parse(JSON.stringify(st));
  });
  assert.ok(withTrick, 'a position with a play on the table');
  const text = JSON.parse(saved(4, withTrick));
  text.game.trick.cls = { type: 'single', key: 999999, label: 'Tampered' };
  const back = readSavedSolo(JSON.stringify(text), LEVELS);
  assert.ok(back);
  assert.notEqual(back.game.trick.cls.label, 'Tampered');
  assert.deepEqual(back.game.trick.cls, classify(back.game.trick.cards));
});

test('the log, the overlay and the seat markers come back', () => {
  const s = playRandom(4, 11, () => {});
  const text = saved(4, s, {
    overlay: true,
    seatActions: [null, 'pass', { cards: [0], cls: classify([0]) }, 'cantbeat'],
    log: [
      { text: 'a', cls: '', cards: null },
      { text: 'b', cls: 'you', cards: [4, 5] },
    ],
  });
  const back = readSavedSolo(text, LEVELS);
  assert.equal(back.overlay, true);
  assert.deepEqual(
    back.seatActions.map((a) => (a && a.cards ? 'cards' : a)),
    [null, 'pass', 'cards', 'cantbeat'],
  );
  assert.deepEqual(back.log, [
    { text: 'a', cls: '', cards: null },
    { text: 'b', cls: 'you', cards: [4, 5] },
  ]);
});

// One thing wrong in an otherwise good save: every one of these must be refused.
test('a damaged, old, forged or oversized save is refused, whatever is wrong with it', () => {
  const base = JSON.parse(saved(4, newGame(mulberry32(3), null, 4)));
  const mutate = (fn) => {
    const copy = JSON.parse(JSON.stringify(base));
    fn(copy);
    return JSON.stringify(copy);
  };
  assert.ok(readSavedSolo(JSON.stringify(base), LEVELS), 'the unmodified save is accepted');
  const bad = {
    'not JSON': '{"v":1',
    null: 'null',
    'a number': '42',
    'an old version': mutate((s) => (s.v = 0)),
    'a future version': mutate((s) => (s.v = 2)),
    'no id': mutate((s) => delete s.id),
    'an empty id': mutate((s) => (s.id = '')),
    'a huge id': mutate((s) => (s.id = 'x'.repeat(200))),
    'a level that does not exist': mutate((s) => (s.level = 'impossible')),
    'two players': mutate((s) => (s.players = 2)),
    'five players': mutate((s) => (s.players = 5)),
    'players that do not match the hands': mutate((s) => (s.players = 3)),
    'a card dealt twice': mutate((s) => (s.game.hands[1][0] = s.game.hands[0][0])),
    'a card missing': mutate((s) => s.game.hands[2].pop()),
    'a card that is not in the deck': mutate((s) => (s.game.hands[0][0] = 99)),
    'a fractional card': mutate((s) => (s.game.hands[0][0] = 1.5)),
    'a hand that is not a list': mutate((s) => (s.game.hands[3] = 'cards')),
    'the played list missing': mutate((s) => delete s.game.played),
    'a turn out of range': mutate((s) => (s.game.turn = 4)),
    'a negative turn': mutate((s) => (s.game.turn = -1)),
    'a winner with cards left': mutate((s) => (s.game.winner = 0)),
    'an empty hand and no winner': mutate((s) => {
      s.game.played.push(...s.game.hands[1]);
      s.game.hands[1] = [];
    }),
    'passed flags of the wrong length': mutate((s) => s.game.passed.pop()),
    'passed flags that are not booleans': mutate((s) => (s.game.passed[0] = 1)),
    'first that is not a boolean': mutate((s) => (s.game.first = 'yes')),
    'a trick that is not a valid combination': mutate((s) => (s.game.trick = { cards: [0, 50], by: 1 })),
    'a trick by a seat that is not there': mutate((s) => (s.game.trick = { cards: [0], by: 7 })),
    'a trick of six cards': mutate((s) => (s.game.trick = { cards: [0, 1, 2, 3, 4, 5], by: 1 })),
    'a history that is not a list': mutate((s) => (s.game.history = {})),
    'a history entry from a seat that is not there': mutate((s) => (s.game.history = [{ p: 9, cards: null }])),
    'a history of a million entries': mutate((s) => (s.game.history = new Array(5000).fill({ p: 0, cards: null }))),
    'seat markers of the wrong length': mutate((s) => s.seatActions.pop()),
    'a seat marker that is a script': mutate((s) => (s.seatActions[1] = '<img src=x onerror=alert(1)>')),
    'a log that is not a list': mutate((s) => (s.log = 'text')),
    'a log line that is not text': mutate((s) => (s.log = [{ text: 5, cls: '', cards: null }])),
    'a log line that is far too long': mutate((s) => (s.log = [{ text: 'x'.repeat(1000), cls: '', cards: null }])),
    'a log line with cards that do not exist': mutate((s) => (s.log = [{ text: 'a', cls: '', cards: [77] }])),
  };
  for (const [what, text] of Object.entries(bad)) {
    assert.equal(readSavedSolo(text, LEVELS), null, `should be refused: ${what}`);
  }
  assert.equal(readSavedSolo('x'.repeat(500_000), LEVELS), null, 'an oversized value');
  assert.equal(readSavedSolo(undefined, LEVELS), null);
  assert.equal(readSavedSolo(null, LEVELS), null, 'nothing stored');
});

test('the level is checked against the levels the page offers', () => {
  const text = saved(4, newGame(mulberry32(5), null, 4), { level: 'hard' });
  assert.ok(readSavedSolo(text, LEVELS));
  assert.equal(readSavedSolo(text, ['easy', 'medium']), null);
});

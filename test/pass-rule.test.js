// A pass lasts only for the go-round. Whoever passes on a play may play later in the same trick, once another play
// has been made and the turn comes back to them; the trick ends when every other seat has passed in a row after the
// last play. (Before this, a pass locked you out of the rest of the trick.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/cards.js';
import { classify } from '../src/hands.js';
import {
  newGame,
  applyMove,
  autoSkip,
  legalMoves,
  turnRules,
  validatePlay,
  normalizePasses,
  checkInvariants,
} from '../src/game.js';

// Card ids are rank * 4 + suit (3♦ = 0). Small hands: enough to show the rule.
//   seat 0: 3♦ (0) and an 8 (20)     seat 1: a K (40) and a 3♣ (1)
//   seat 2: a 5♦ (8) and a 3♥ (2)    seat 3: a 10♠ (31) and a 4♦ (4)
const hands = () => [
  [0, 20],
  [40, 1],
  [8, 2],
  [31, 4],
];

test('someone who passed on a play can play later in the same trick', () => {
  const s = newGame(() => 0, hands());
  applyMove(s, [0]); // seat 0 opens with the 3♦
  applyMove(s, null); // seat 1 passes (it could have played its K)
  assert.deepEqual(s.passed, [false, true, false, false]);
  applyMove(s, [8]); // seat 2 plays: everybody gets another turn
  assert.deepEqual(s.passed, [false, false, false, false], 'a play clears the passes');
  applyMove(s, null); // seat 3 passes
  applyMove(s, null); // seat 0 passes
  assert.equal(s.turn, 1, 'seat 1 passed earlier in this trick but is asked again');
  assert.equal(validatePlay(s, [40]), null);
  assert.ok(legalMoves(s).some((m) => m.cards[0] === 40));
  applyMove(s, [40]); // and plays
  assert.equal(s.trick.by, 1);
  assert.equal(s.turn, 2);
});

test('within one go-round a pass is final: the passer is not asked again until another play', () => {
  const s = newGame(() => 0, hands());
  applyMove(s, [0]);
  applyMove(s, null); // 1 passes
  assert.equal(s.turn, 2);
  applyMove(s, null); // 2 passes
  applyMove(s, null); // 3 passes
  // Everyone else has passed in a row: the 3♦ stands and seat 0 leads again.
  assert.equal(s.trick, null);
  assert.equal(s.turn, 0);
  assert.deepEqual(s.passed, [false, false, false, false]);
});

test('the trick ends only when every other seat has passed in a row after the last play', () => {
  const s = newGame(() => 0, hands());
  applyMove(s, [0]);
  applyMove(s, null); // 1 passes
  applyMove(s, [8]); // 2 plays
  applyMove(s, null); // 3 passes
  applyMove(s, null); // 0 passes
  applyMove(s, [40]); // 1 plays its K (it had passed before 2's play)
  assert.ok(s.trick);
  applyMove(s, null); // 2
  applyMove(s, null); // 3
  assert.ok(s.trick, 'two of the three others have passed: the trick is still open');
  applyMove(s, null); // 0
  assert.equal(s.trick, null);
  assert.equal(s.turn, 1, 'seat 1 played last, so it leads');
});

test('auto-skip does not skip a player who passed earlier but can beat the new play', () => {
  // seat 0: 3♦ and a 5♣ (4)   seat 1: a K and a 3♣   seat 2: a 5♦ and a 3♥   seat 3: two low cards
  const s = newGame(
    () => 0,
    [
      [0, 4],
      [40, 1],
      [8, 2],
      [5, 6],
    ],
  );
  applyMove(s, [0]);
  applyMove(s, null); // seat 1 passes on the 3♦
  applyMove(s, [8]); // seat 2 plays the 5♦; seats 3 and 0 cannot beat it, seat 1 can (its K)
  assert.deepEqual(autoSkip(s), [], 'the K is still to be heard from: no automatic skip');
  assert.equal(s.turn, 3);
  assert.ok(s.trick);
  applyMove(s, null); // seat 3
  applyMove(s, null); // seat 0
  assert.equal(s.turn, 1);
  assert.equal(validatePlay(s, [40]), null);
});

test('the last-card rule is unchanged: a single must be your highest, and you may still pass', () => {
  // Seat 2 holds one card, so seat 1, who plays just before it, must play its highest single if it plays a single.
  const s = newGame(() => 0, [[0, 20], [40, 1], [8], [31, 4]]);
  applyMove(s, [0]); // seat 0 opens with the 3♦; it is seat 1's turn
  assert.ok(turnRules(s).singleKey >= 0, "seat 1's next seat has one card");
  assert.equal(validatePlay(s, null), null, 'it may still pass');
  assert.match(validatePlay(s, [1]), /highest/, 'a low single is refused');
  assert.equal(validatePlay(s, [40]), null, 'its highest single is allowed');
});

// ---- a game saved under the old rule ----

// Seat 3 has played, seat 0 has passed since. Under the old rule seat 1 (who passed on the 3♦ earlier) stayed locked
// out, so the turn had gone round to seat 2; under the current rule it is seat 1's turn.
function oldRuleState() {
  const s = newGame(
    () => 0,
    [
      [0, 20],
      [40, 1],
      [8, 2],
      [31, 4],
    ],
  );
  applyMove(s, [0]);
  applyMove(s, null); // 1 passes on the 3♦
  applyMove(s, [8]); // 2 plays
  applyMove(s, [31]); // 3 plays
  applyMove(s, null); // 0 passes
  assert.equal(s.turn, 1); // what the current engine does
  s.turn = 2; // what the old one did: seat 1 skipped
  s.passed = [true, true, false, false]; // the old one kept seat 1's earlier pass
  return s;
}

test('a game saved under the old rule is brought in line: the skipped player gets their turn back', () => {
  const s = oldRuleState();
  assert.equal(normalizePasses(s), true);
  assert.equal(s.turn, 1);
  assert.deepEqual(s.passed, [true, false, false, false], 'only the pass since the last play counts');
  assert.equal(validatePlay(s, [40]), null);
  assert.equal(normalizePasses(s), false, 'and doing it again changes nothing');
});

test('a game that follows the current rule is left exactly as it is', () => {
  const rng = mulberry32(21);
  for (let g = 0; g < 40; g++) {
    const s = newGame(rng, null, g % 2 ? 3 : 4);
    let guard = 0;
    while (s.winner < 0 && guard++ < 500) {
      const legal = legalMoves(s);
      const pass = turnRules(s).canPass && (!legal.length || rng() < 0.4);
      const m = pass ? null : legal[Math.floor(rng() * legal.length)];
      applyMove(s, m ? m.cards : null, m ? classify(m.cards) : null);
      if (m) autoSkip(s);
      checkInvariants(s);
      if (s.winner < 0) {
        const copy = JSON.stringify(s);
        assert.equal(normalizePasses(s), false, `game ${g}, move ${guard}`);
        assert.equal(JSON.stringify(s), copy);
      }
    }
    assert.ok(s.winner >= 0);
  }
});

test('normalizePasses leaves alone a game with nothing on the table, a finished one, and one with no history', () => {
  const fresh = newGame(() => 0, hands());
  assert.equal(normalizePasses(fresh), false); // the opening play has not been made
  const s = oldRuleState();
  const noHistory = { ...s, history: null };
  assert.equal(normalizePasses(noHistory), false);
  const done = { ...s, winner: 0 };
  assert.equal(normalizePasses(done), false);
  const led = newGame(() => 0, hands());
  applyMove(led, [0]);
  for (let i = 0; i < 3; i++) applyMove(led, null); // everyone passes: seat 0 leads a fresh trick
  assert.equal(led.trick, null);
  assert.equal(normalizePasses(led), false);
});

test('in play-through games a pass never costs a player their place for the rest of the trick', () => {
  // Property: whenever a play is made, the seats that passed earlier in the trick are asked again if they come next.
  const rng = mulberry32(5);
  let reentries = 0;
  for (let g = 0; g < 60; g++) {
    const s = newGame(rng, null, g % 3 === 0 ? 3 : 4);
    const passedInTrick = new Set();
    let guard = 0;
    while (s.winner < 0 && guard++ < 500) {
      const legal = legalMoves(s);
      const pass = s.trick && (!legal.length || rng() < 0.5);
      const trickBefore = s.trick;
      const seat = s.turn;
      if (pass) {
        applyMove(s, null);
        if (trickBefore) passedInTrick.add(seat);
      } else {
        if (passedInTrick.has(seat)) reentries++;
        const m = legal[Math.floor(rng() * legal.length)];
        applyMove(s, m.cards, classify(m.cards));
        autoSkip(s);
      }
      if (!s.trick) passedInTrick.clear();
    }
  }
  assert.ok(reentries > 20, `only ${reentries} re-entries happened in the sample`);
});

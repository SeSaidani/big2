// The page's short memory of what it was sent (src/trace.js): it keeps the latest entries in order, says when each
// happened, hands out copies, and never holds anyone's cards but what was played.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrace, describeView } from '../src/trace.js';

test('it keeps the latest entries, oldest dropped first, numbered in order', () => {
  let clock = 1000;
  const tr = createTrace(3, () => clock++);
  for (let i = 0; i < 5; i++) tr.add('view', { version: i });
  const d = tr.dump();
  assert.equal(tr.size, 3);
  assert.deepEqual(
    d.map((x) => x.version),
    [2, 3, 4],
  );
  assert.deepEqual(
    d.map((x) => x.n),
    [2, 3, 4],
    'the numbers show how many entries came before',
  );
  assert.deepEqual(
    d.map((x) => x.at),
    [1002, 1003, 1004],
  );
});

test('the dump is a copy: changing it does not change the trace', () => {
  const tr = createTrace();
  tr.add('open');
  tr.dump()[0].kind = 'changed';
  assert.equal(tr.dump()[0].kind, 'open');
});

test('a view is described without the player’s hand', () => {
  const t = {
    id: 'abc',
    version: 12,
    status: 'playing',
    you: 2,
    seats: [{ online: true }, { online: false }, { online: true }, { online: null }],
    game: {
      turn: 3,
      winner: -1,
      view: { hand: [1, 2, 3], counts: [5, 6, 7, 8], history: [{}, {}, {}] },
    },
  };
  const d = describeView(t, { fresh: true });
  assert.deepEqual(d, {
    table: 'abc',
    version: 12,
    status: 'playing',
    you: 2,
    turn: 3,
    winner: -1,
    history: 3,
    counts: [5, 6, 7, 8],
    online: [true, false, true, null],
    fresh: true,
  });
  assert.ok(!JSON.stringify(d).includes('"hand"'), 'no hand in it');
});

test('a view with no game yet (waiting for players) is described too', () => {
  const d = describeView({ id: 'w', version: 1, status: 'waiting', you: 0, seats: [{}], game: null });
  assert.equal(d.turn, null);
  assert.equal(d.history, null);
});

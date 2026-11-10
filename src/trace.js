// A short memory of what this browser was sent and what it showed, for working out why a screen did not match the
// game (compare it with the server's diary, GET /api/admin/game-events). Holds only what the page already knows: the
// cards played and the player's own hand are never put in it. Pure, so it is unit-tested in Node.

export const TRACE_MAX = 400;

export function createTrace(max = TRACE_MAX, now = Date.now) {
  const items = [];
  let n = 0;
  return {
    // kind: a short word ('view', 'stale', 'open', 'log'); data: plain JSON-able facts.
    add(kind, data = {}) {
      items.push({ n: n++, at: now(), kind, ...data });
      if (items.length > max) items.shift();
    },
    dump: () => items.map((i) => ({ ...i })),
    get size() {
      return items.length;
    },
  };
}

// One view from the server, as the trace remembers it. `shown` is the log lines this view added.
export function describeView(t, extra = {}) {
  const v = t.game ? t.game.view : null;
  return {
    table: t.id,
    version: t.version,
    status: t.status,
    you: t.you,
    turn: t.game ? t.game.turn : null,
    winner: t.game ? t.game.winner : null,
    history: v ? v.history.length : null,
    counts: v ? v.counts : null,
    online: t.seats.map((s) => s.online ?? null),
    ...extra,
  };
}

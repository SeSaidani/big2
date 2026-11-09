// A solo game kept in the browser, so it survives a trip to the online screen and a reload. This file only turns a
// game into text and, more importantly, checks what comes back out of storage before anything trusts it: storage
// can hold an old format, a half-written value or something edited by hand. A saved game that does not pass every
// check is simply not restored (a new game is dealt), and the game state that comes back is rebuilt from the plain
// values (the hand classifications are recomputed, never read from the text).

import { DECK_SIZE, NUM_PLAYERS } from './cards.js';
import { classify } from './hands.js';

export const SOLO_SAVE_VERSION = 1;
const MAX_LOG = 200;
const MAX_HISTORY = 2000;
const ACTIONS = ['pass', 'leadpass', 'cantbeat'];

export function serializeSolo({ id, level, players, game, shownTrick, seatActions, log, overlay }) {
  return JSON.stringify({
    v: SOLO_SAVE_VERSION,
    id,
    level,
    players,
    game,
    shownTrick,
    seatActions,
    log: log.slice(-MAX_LOG),
    overlay,
  });
}

const isInt = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
const isCards = (c) => Array.isArray(c) && c.length >= 1 && c.length <= 5 && c.every((x) => isInt(x, 0, DECK_SIZE - 1));

// A play on the table: the cards and who played them; the classification is worked out again here.
function readTrick(t, players) {
  if (t === null) return null;
  if (!t || typeof t !== 'object' || !isCards(t.cards) || !isInt(t.by, 0, players - 1)) throw new Error('bad trick');
  const cls = classify(t.cards);
  if (!cls) throw new Error('trick is not a valid combination');
  return { cards: t.cards.slice(), cls, by: t.by };
}

// Returns the saved game, rebuilt and checked, or null if there is none or any part of it is wrong.
export function readSavedSolo(text, levels) {
  try {
    if (typeof text !== 'string' || text.length > 400_000) return null;
    const s = JSON.parse(text);
    if (!s || typeof s !== 'object' || s.v !== SOLO_SAVE_VERSION) return null;
    if (typeof s.id !== 'string' || !s.id || s.id.length > 80) return null;
    if (!levels.includes(s.level) || ![3, NUM_PLAYERS].includes(s.players)) return null;
    const n = s.players;
    const g = s.game;
    if (!g || typeof g !== 'object') return null;

    // The cards: every card exactly once, in hands or already played.
    if (!Array.isArray(g.hands) || g.hands.length !== n) return null;
    for (const h of g.hands) if (!Array.isArray(h) || !h.every((x) => isInt(x, 0, DECK_SIZE - 1))) return null;
    if (!Array.isArray(g.played) || !g.played.every((x) => isInt(x, 0, DECK_SIZE - 1))) return null;
    const all = [...g.hands.flat(), ...g.played];
    if (all.length !== DECK_SIZE || new Set(all).size !== DECK_SIZE) return null;

    // The state of play.
    if (!isInt(g.turn, 0, n - 1) || !isInt(g.winner, -1, n - 1) || !isInt(g.leadPasses, 0, n)) return null;
    if (typeof g.first !== 'boolean') return null;
    const passedOk = Array.isArray(g.passed) && g.passed.length === n && g.passed.every((b) => typeof b === 'boolean');
    if (!passedOk) return null;
    if (g.winner >= 0 && g.hands[g.winner].length !== 0) return null; // a winner has no cards left
    if (g.winner < 0 && g.hands.some((h) => h.length === 0)) return null; // and an empty hand means a winner

    if (!Array.isArray(g.history) || g.history.length > MAX_HISTORY) return null;
    const history = g.history.map((e) => {
      if (!e || !isInt(e.p, 0, n - 1) || (e.cards !== null && !isCards(e.cards))) throw new Error('bad history');
      const entry = { p: e.p, cards: e.cards ? e.cards.slice() : null, trick: readTrick(e.trick ?? null, n) };
      if (e.auto) entry.auto = true;
      return entry;
    });

    const game = {
      hands: g.hands.map((h) => h.slice()),
      turn: g.turn,
      trick: readTrick(g.trick ?? null, n),
      passed: g.passed.slice(),
      leadPasses: g.leadPasses,
      first: g.first,
      winner: g.winner,
      played: g.played.slice(),
      history,
    };

    if (!Array.isArray(s.seatActions) || s.seatActions.length !== n) return null;
    const seatActions = s.seatActions.map((a) => {
      if (a === null || ACTIONS.includes(a)) return a;
      if (a && isCards(a.cards)) return { cards: a.cards.slice(), cls: classify(a.cards) };
      throw new Error('bad seat action');
    });

    if (!Array.isArray(s.log) || s.log.length > MAX_LOG) return null;
    const log = s.log.map((l) => {
      const ok = l && typeof l.text === 'string' && l.text.length <= 300 && typeof (l.cls ?? '') === 'string';
      if (!ok || (l.cards !== undefined && l.cards !== null && !isCards(l.cards))) throw new Error('bad log line');
      return { text: l.text, cls: l.cls ?? '', cards: l.cards ?? null };
    });

    return {
      id: s.id,
      level: s.level,
      players: n,
      game,
      shownTrick: readTrick(s.shownTrick ?? null, n),
      seatActions,
      log,
      overlay: s.overlay === true,
    };
  } catch {
    return null;
  }
}

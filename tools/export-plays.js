// Writes the recorded games as lines of JSON, for studying how games go and for training the computer players.
//
//   node tools/export-plays.js [--db FILE] [--out FILE] [--games] [--all-rules]
//
//   (default) one line per play: what the player to move knew (their hand, how many cards each seat holds, the play on
//             the table, who has passed, what has been played), how many plays were legal, whether the only move was to
//             pass, what they chose, who chose it (a person, or the computer at a level), and what that seat scored
//             in the end. Plays the engine made by itself (an automatic skip) are not plays and are not written.
//   --games   one line per game instead: the deal, every move, who sat where, and what every seat scored.
//   --all-rules  include games played under older rules (by default only the current RULES_VERSION: the others cannot
//             be played again under today's rules, and mixing rules would quietly mix two different games).
//
// Reads the online games (every finished game that has a record) and the solo games whose browser sent one. The
// database is opened read-only, so it is safe on a copy of the live one. Every game is played again from its deal, so
// anything that does not replay is skipped and counted, never written. Nothing here is committed: the output holds
// what people played.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  newGame,
  applyMove,
  autoSkip,
  observe,
  legalMoves,
  mustPass,
  validatePlay,
  RULES_VERSION,
} from '../src/game.js';
import { scoreRound } from '../src/scoring.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const hasColumn = (db, table, column) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);

// Every game with a record, as { source, id, rules, players, ended, seats, deals, moves } (rules null = before there
// was a version). seats: [{ kind: 'human' | 'ai', level }] by seat number.
export function* recordedGames(db) {
  const rulesOnline = hasColumn(db, 'games', 'rules') ? 'g.rules' : 'NULL';
  const online = db
    .prepare(
      `SELECT g.id, g.ended, g.players, ${rulesOnline} AS rules FROM games g
       WHERE g.status = 'finished' AND EXISTS (SELECT 1 FROM game_deals d WHERE d.game_id = g.id) ORDER BY g.id`,
    )
    .all();
  for (const g of online) {
    const deals = db
      .prepare('SELECT hand FROM game_deals WHERE game_id = ? ORDER BY seat')
      .all(g.id)
      .map((r) => JSON.parse(r.hand));
    const moves = db
      .prepare('SELECT seat, cards, auto FROM game_moves WHERE game_id = ? ORDER BY ply')
      .all(g.id)
      .map((m) => ({ seat: m.seat, cards: m.cards === null ? null : JSON.parse(m.cards), auto: m.auto === 1 }));
    const users = new Map(
      db
        .prepare('SELECT seat, user_id FROM results WHERE game_id = ?')
        .all(g.id)
        .map((r) => [r.seat, r.user_id]),
    );
    const seats = deals.map((_, seat) =>
      users.get(seat) === null || users.get(seat) === undefined
        ? { kind: 'ai', level: null }
        : { kind: 'human', level: null },
    );
    yield {
      source: 'online',
      id: g.id,
      rules: g.rules ?? null,
      players: deals.length,
      ended: g.ended,
      seats,
      deals,
      moves,
    };
  }
  if (!hasColumn(db, 'solo_games', 'record')) return;
  const rulesSolo = hasColumn(db, 'solo_games', 'rules') ? 'rules' : 'NULL';
  const solo = db
    .prepare(
      `SELECT id, level, players, ended, ${rulesSolo} AS rules, record FROM solo_games WHERE record IS NOT NULL ORDER BY id`,
    )
    .all();
  for (const g of solo) {
    const { deals, moves } = JSON.parse(g.record);
    const seats = deals.map((_, seat) =>
      seat === 0 ? { kind: 'human', level: null } : { kind: 'ai', level: g.level },
    );
    yield { source: 'solo', id: g.id, rules: g.rules ?? null, players: g.players, ended: g.ended, seats, deals, moves };
  }
}

// Plays the game again from its deal. Returns { delta, plays }, or throws if the record does not replay (a move out of
// turn or illegal, or a game that does not end).
export function replay(game) {
  const s = newGame(() => 0, game.deals);
  const plays = [];
  for (const [ply, m] of game.moves.entries()) {
    if (m.auto) continue; // the engine's own skip: it follows from the plays and is made again by autoSkip
    if (m.seat !== s.turn) throw new Error(`move ${ply}: seat ${m.seat} moved on seat ${s.turn}'s turn`);
    const err = validatePlay(s, m.cards);
    if (err) throw new Error(`move ${ply}: ${err}`);
    const v = observe(s, s.turn);
    plays.push({
      ply,
      seat: s.turn,
      view: {
        hand: v.hand,
        counts: v.counts,
        trick: v.trick,
        passed: v.passed,
        leadPasses: v.leadPasses,
        first: v.first,
        played: v.played,
      },
      legal: legalMoves(s).length,
      forced: mustPass(s),
      move: m.cards,
    });
    applyMove(s, m.cards);
    if (m.cards) autoSkip(s);
  }
  if (s.winner < 0) throw new Error('the game does not end');
  return { delta: scoreRound(s).delta, plays };
}

// Everything to write, as plain objects, and what was left out and why.
export function exportLines(db, { games = false, allRules = false } = {}) {
  const lines = [];
  const skipped = { rules: 0, replay: 0 };
  let kept = 0;
  for (const g of recordedGames(db)) {
    if (!allRules && g.rules !== RULES_VERSION) {
      skipped.rules++;
      continue;
    }
    let done;
    try {
      done = replay(g);
    } catch {
      skipped.replay++;
      continue;
    }
    kept++;
    const head = { source: g.source, game: g.id, rules: g.rules, players: g.players };
    if (games) {
      lines.push({ ...head, ended: g.ended, seats: g.seats, deals: g.deals, moves: g.moves, delta: done.delta });
    } else {
      for (const p of done.plays) {
        lines.push({ ...head, ...p, actor: g.seats[p.seat], outcome: done.delta[p.seat] });
      }
    }
  }
  return { lines, kept, skipped };
}

function main(argv) {
  const opt = {
    db: process.env.DB_FILE || path.join(ROOT, 'data', 'big2.db'),
    out: null,
    games: false,
    allRules: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') opt.db = argv[++i];
    else if (argv[i] === '--out') opt.out = argv[++i];
    else if (argv[i] === '--games') opt.games = true;
    else if (argv[i] === '--all-rules') opt.allRules = true;
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  if (!fs.existsSync(opt.db)) throw new Error(`No database at ${opt.db}`);
  const db = new DatabaseSync(opt.db, { readOnly: true });
  const { lines, kept, skipped } = exportLines(db, opt);
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '');
  if (opt.out) fs.writeFileSync(opt.out, text);
  else process.stdout.write(text);
  console.error(
    `${kept} games, ${lines.length} lines${opt.games ? ' (one per game)' : ' (one per play)'}; left out: ` +
      `${skipped.rules} played under other rules, ${skipped.replay} that did not replay.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

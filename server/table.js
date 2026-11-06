// The one table: three or four seats, the authoritative game state, AI seats, chat and
// scoring. Clients never see `game` itself, only view(userId), built from
// observe() (that seat's hand plus public information) and whitelisted field
// by field. Other hands are revealed only once the round is over.
//
// A started game belongs to its seated players until it finishes or an admin
// cancels it: leaving does not free a seat, there is no turn timer, and a
// human who is away simply holds the game up. Computer seats move on their
// own. After every change the whole table is saved (deps.persist), so it
// survives a restart; restore() + resume() pick it up again.

import crypto from 'node:crypto';
import {
  newGame,
  applyMove,
  autoSkip,
  observe,
  validatePlay,
  turnRules,
  legalMoves,
  checkInvariants,
  initialDeals,
  moveLog,
} from '../src/game.js';
import { classify } from '../src/hands.js';
import { NUM_PLAYERS } from '../src/cards.js';
import { scoreRound, forfeitPenalty } from '../src/scoring.js';
import { recordGame, recordCancelled, recordForfeit, recordProblem } from './db.js';

export class TableError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// A deal decides money-like scores, so use the OS CSPRNG rather than Math.random.
export const secureRng = () => crypto.randomBytes(4).readUInt32LE() / 2 ** 32;

const EMPTY = { kind: 'empty' };
export const MAX_CHAT = 300;
const KEEP_CHAT = 100;

export class Table {
  // deps: { db, pool, cfg: { aiDelayMs, rng, now }, isOnline(userId), chatLimit,
  //         persist(table), onView(table), onChat(table, msg), onList(), onClose(table), log(...) }
  constructor(id, host, aiLevel, deps, seatCount = NUM_PLAYERS) {
    this.id = id;
    this.aiLevel = aiLevel;
    this.deps = deps;
    this.seats = Array.from({ length: seatCount }, (_, i) => (host && i === 0 ? Table.human(host) : EMPTY));
    this.hostId = host ? host.id : null;
    this.status = 'waiting'; // waiting | playing | done | closed
    this.game = null;
    this.version = 0;
    this.token = 0; // bumped on every state change; stale AI replies check it
    this.timer = null;
    this.result = null;
    this.startedAt = 0;
    this.turnSince = 0; // when the turn passed to whoever holds it (saved, so alerts survive a restart)
    this.chat = [];
    // A production table runs itself (see #autoCheck): what it is counting down to, and when.
    this.autoTimer = null;
    this.autoKind = null; // 'start' (four seated) | 'next' (a game just ended)
    this.autoAt = null;
    this.notice = null; // why the table is waiting again after a game was stopped (shown to the people still seated)
  }

  static human(user) {
    return { kind: 'human', userId: user.id, name: user.name };
  }

  static restore(data, deps) {
    const t = new Table(data.id, null, data.aiLevel, deps);
    Object.assign(t, {
      hostId: data.hostId,
      status: data.status,
      seats: data.seats,
      game: data.game,
      result: data.result,
      startedAt: data.startedAt,
      turnSince: data.turnSince ?? deps.cfg.now(), // games saved before this was recorded
      autoKind: data.autoKind ?? null,
      autoAt: data.autoAt ?? null,
      notice: data.notice ?? null,
      chat: data.chat || [],
      version: data.version + 1, // clients reconnecting after a restart must not ignore the first view
    });
    return t;
  }

  serialize() {
    return {
      id: this.id,
      aiLevel: this.aiLevel,
      hostId: this.hostId,
      status: this.status,
      seats: this.seats,
      game: this.game,
      result: this.result,
      startedAt: this.startedAt,
      turnSince: this.turnSince,
      autoKind: this.autoKind,
      autoAt: this.autoAt,
      notice: this.notice,
      chat: this.chat,
      version: this.version,
    };
  }

  // After a restart: computer seats carry on, and a countdown that was running carries on from its saved moment.
  resume() {
    this.#schedule();
    this.#autoCheck();
  }

  seatOf(userId) {
    return this.seats.findIndex((s) => s.kind === 'human' && s.userId === userId);
  }

  humans() {
    return this.seats.filter((s) => s.kind === 'human');
  }

  get hostName() {
    const h = this.seats.find((s) => s.kind === 'human' && s.userId === this.hostId);
    return h ? h.name : '';
  }

  join(user) {
    if (this.status !== 'waiting') throw new TableError(409, 'That game has already started.');
    if (this.seatOf(user.id) >= 0) return;
    const i = this.seats.findIndex((s) => s.kind === 'empty');
    if (i < 0) throw new TableError(409, 'That table is full.');
    this.seats[i] = Table.human(user);
    this.#autoCheck();
    this.#changed(true);
  }

  // Only the waiting room (or a finished round) lets you give up your seat.
  leave(userId) {
    const i = this.seatOf(userId);
    if (i < 0) return;
    if (this.deps.auto && this.status !== 'waiting') {
      // A seat is a promise to the other three. With only as many accounts as seats there is nobody to take it
      // over, so it cannot be given up; with more, a seat can be left between games, or mid-game at a cost.
      const players = this.deps.activeUsers();
      if (players <= this.seats.length) {
        throw new TableError(
          409,
          `There are only ${players} players, so every seat stays filled: nobody can leave until there are more.`,
        );
      }
      if (this.status === 'playing') return this.#forfeit(i);
    } else if (this.status === 'playing') {
      throw new TableError(
        409,
        'The game is in progress and holds your seat until it finishes or an admin cancels it.',
      );
    }
    this.seats[i] = EMPTY;
    if (this.deps.auto) {
      // Nobody hosts a production table and an empty one just waits: leaving only frees the seat.
      this.#autoCheck();
      return this.#changed(true);
    }
    const remaining = this.humans();
    if (!remaining.length) return this.close();
    if (this.hostId === userId) this.hostId = remaining[0].userId;
    this.#changed(true);
  }

  start(userId) {
    if (userId !== this.hostId) throw new TableError(403, 'Only the host can start the game.');
    if (this.status === 'playing') throw new TableError(409, 'The game is already running.');
    if (this.status === 'closed') throw new TableError(409, 'That table is closed.');
    const empty = this.seats.filter((s) => s.kind === 'empty').length;
    if (empty > 0 && !this.deps.cfg.devTables) {
      throw new TableError(
        409,
        `Every seat needs a person: ${empty} more ${empty === 1 ? 'player is' : 'players are'} needed.`,
      );
    }
    this.#begin();
  }

  // Deals the game. Empty seats (only ever in development) are played by the computer.
  #begin() {
    this.notice = null;
    let bots = 0;
    this.seats = this.seats.map((s) => {
      if (s.kind !== 'empty') return s;
      bots++;
      const label = this.aiLevel[0].toUpperCase() + this.aiLevel.slice(1);
      return { kind: 'ai', level: this.aiLevel, name: `${label} bot ${bots}` };
    });
    this.game = newGame(this.deps.cfg.rng, null, this.seats.length);
    this.result = null;
    this.status = 'playing';
    this.startedAt = this.deps.cfg.now();
    this.#commit(true);
  }

  // cards: array of card ids, or null for a pass. Throws TableError.
  move(userId, cards) {
    if (this.status !== 'playing') throw new TableError(409, 'There is no game in progress.');
    const p = this.seatOf(userId);
    if (p < 0) throw new TableError(403, 'You are not seated at this table.');
    if (p !== this.game.turn) throw new TableError(409, 'It is not your turn.');
    const err = validatePlay(this.game, cards);
    if (err) throw new TableError(422, err);
    this.#play(cards);
  }

  // Chat is for people talking to each other, so it needs two or more humans.
  say(userId, text) {
    const i = this.seatOf(userId);
    if (i < 0) throw new TableError(403, 'You are not seated at this table.');
    if (this.humans().length < 2) {
      throw new TableError(409, 'Chat is available when two or more people are at the table.');
    }
    if (typeof text !== 'string') throw new TableError(400, 'Message must be text.');
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (!clean) throw new TableError(400, 'Message is empty.');
    if (clean.length > MAX_CHAT) throw new TableError(400, `Message is longer than ${MAX_CHAT} characters.`);
    const key = `chat:${userId}`;
    if (!this.deps.chatLimit.allowed(key)) throw new TableError(429, 'You are sending messages too quickly.');
    this.deps.chatLimit.record(key);
    const last = this.chat.length ? this.chat[this.chat.length - 1].id : 0;
    const msg = { id: last + 1, name: this.seats[i].name, text: clean, ts: this.deps.cfg.now() };
    this.chat.push(msg);
    if (this.chat.length > KEEP_CHAT) this.chat.shift();
    this.deps.persist(this);
    this.deps.onChat(this, msg);
  }

  // Admin only (checked by the caller). A game that had started is kept in
  // the record as cancelled, with no results, so it never counts for scoring.
  cancel() {
    if (this.status === 'closed') return;
    if (this.status === 'playing') {
      try {
        recordCancelled(this.deps.db, {
          started: this.startedAt,
          ended: this.deps.cfg.now(),
          hasAi: this.seats.some((s) => s.kind === 'ai'),
        });
      } catch (err) {
        this.deps.log('Could not record cancelled game', err);
      }
    }
    this.close();
  }

  close() {
    if (this.status === 'closed') return;
    clearTimeout(this.timer);
    clearTimeout(this.autoTimer);
    this.token++;
    this.status = 'closed';
    this.deps.onClose(this);
  }

  // Stop moving without ending the game (the process is shutting down).
  halt() {
    clearTimeout(this.timer);
    clearTimeout(this.autoTimer);
    this.token++;
  }

  // Someone connected or disconnected: views show who is online.
  touch() {
    this.#changed(false, false);
  }

  // ---- internals ----

  #play(cards) {
    const cls = cards && cards.length ? classify(cards) : null;
    applyMove(this.game, cards, cls);
    if (cls) autoSkip(this.game);
    checkInvariants(this.game);
    if (this.game.winner >= 0) return this.#finish();
    this.#commit(false);
  }

  #commit(structural) {
    this.turnSince = this.deps.cfg.now();
    this.#schedule();
    this.#changed(structural);
  }

  #changed(structural, persist = true) {
    this.version++;
    if (persist) this.deps.persist(this);
    this.deps.onView(this);
    if (structural) this.deps.onList();
  }

  // A production table runs itself: four people seated start a game after a short wait (startDelayMs), and a
  // finished game is followed, after the results have been on screen for a while (nextGameDelayMs), by the next
  // one with the same people, if a season is still running. Called whenever the seats or the status change.
  #autoCheck() {
    if (!this.deps.auto || this.status === 'closed') return;
    if (this.status === 'done' && !this.humans().length) return this.#toWaiting(); // everybody left the results
    const full = this.seats.every((s) => s.kind === 'human');
    const kind = this.status === 'waiting' && full ? 'start' : this.status === 'done' ? 'next' : null;
    if (!kind) {
      clearTimeout(this.autoTimer);
      this.autoTimer = null;
      this.autoKind = null;
      this.autoAt = null;
      return;
    }
    if (this.autoKind === kind && this.autoTimer) return; // already counting down
    const cfg = this.deps.cfg;
    // After a restart the saved moment still stands.
    const keep = this.autoKind === kind && this.autoAt;
    const at = keep ? this.autoAt : cfg.now() + (kind === 'start' ? cfg.startDelayMs : cfg.nextGameDelayMs);
    clearTimeout(this.autoTimer);
    this.autoKind = kind;
    this.autoAt = at;
    this.autoTimer = setTimeout(
      () => this.#guarded(Promise.resolve().then(() => this.#fire(kind))),
      Math.max(0, at - cfg.now()),
    );
    this.autoTimer.unref?.();
  }

  #fire(kind) {
    this.autoTimer = null;
    this.autoKind = null;
    this.autoAt = null;
    if (this.status === 'closed') return;
    const full = this.seats.every((s) => s.kind === 'human');
    if (kind === 'start') {
      if (this.status === 'waiting' && full) this.#begin();
      else this.#autoCheck();
      return;
    }
    if (this.status !== 'done') return;
    if (!this.deps.seasonRunning()) return this.close(); // the season is over: no next game
    if (full) return this.#newRound();
    this.#toWaiting(); // someone left the results: wait for a replacement
  }

  // The next game, with the same four people.
  #newRound() {
    this.notice = null;
    this.game = newGame(this.deps.cfg.rng, null, this.seats.length);
    this.result = null;
    this.status = 'playing';
    this.startedAt = this.deps.cfg.now();
    this.#commit(true);
  }

  // Someone left a game in progress (only possible when there are more people than seats, so the seat can be
  // filled). It costs them the most a round can cost; for the three who stay the game is void and counts for nobody.
  #forfeit(i) {
    const seat = this.seats[i];
    const players = this.seats.length;
    try {
      recordForfeit(this.deps.db, {
        userId: seat.userId,
        seat: i,
        players,
        started: this.startedAt,
        ended: this.deps.cfg.now(),
        cardsLeft: this.game.hands[i].length,
        delta: -forfeitPenalty(players),
      });
    } catch (err) {
      this.deps.log('Could not record a forfeit', err);
    }
    this.notice = `${seat.name} left the game, so it was stopped. It does not count for anyone else.`;
    this.seats[i] = EMPTY;
    this.#toWaiting();
  }

  #toWaiting() {
    this.game = null;
    this.result = null;
    this.status = 'waiting';
    this.token++;
    clearTimeout(this.timer);
    this.#autoCheck();
    this.#changed(true);
  }

  // Computer seats move after a short pause; a human seat just waits.
  #schedule() {
    clearTimeout(this.timer);
    this.token++;
    if (this.status !== 'playing') return;
    const seat = this.seats[this.game.turn];
    const tok = this.token;
    if (seat.kind === 'human') {
      // A person's turn: the notifier may text them if they have still not played after
      // 20 minutes, and again after 24 hours (timed from when the turn began).
      this.deps.notifier?.schedule(seat.userId, this.turnSince, () => tok === this.token && this.status === 'playing');
      return;
    }
    if (seat.kind !== 'ai') return;
    this.timer = setTimeout(() => this.#guarded(this.#aiMove(tok, seat.level)), this.deps.cfg.aiDelayMs);
    this.timer.unref?.();
  }

  // An unrecoverable error in a timer callback must not crash the server:
  // log it and close this table (its players see it disappear).
  #guarded(promise) {
    promise.catch((err) => {
      this.deps.log('Table failed, closing', this.id, err);
      this.close();
    });
  }

  async #aiMove(tok, level) {
    if (tok !== this.token) return;
    let cards;
    try {
      cards = await this.deps.pool.choose(observe(this.game, this.game.turn), level);
    } catch (err) {
      this.deps.log('AI failure', err);
      cards = undefined;
    }
    if (tok !== this.token || this.status !== 'playing') return;
    if (cards === undefined || validatePlay(this.game, cards)) {
      if (cards !== undefined) this.deps.log('AI proposed an illegal move', cards);
      const legal = legalMoves(this.game);
      cards = legal.length ? legal[0].cards : null;
      if (cards === null && validatePlay(this.game, null)) throw new Error('No legal move available');
    }
    this.#play(cards);
  }

  #finish() {
    clearTimeout(this.timer);
    this.token++;
    this.status = 'done';
    const r = scoreRound(this.game);
    const hasAi = this.seats.some((s) => s.kind === 'ai');
    let saved = true;
    // The deal and the moves are saved with the result. If they ever fail their own checks, the
    // result is still saved (a score must never be lost to a bad record) and the problem is logged.
    let record = { deals: initialDeals(this.game), moves: moveLog(this.game) };
    const problem = recordProblem(record, this.seats.length);
    if (problem) {
      this.deps.log('Game record not saved', this.id, problem);
      record = undefined;
    }
    try {
      recordGame(this.deps.db, {
        record,
        started: this.startedAt,
        ended: this.deps.cfg.now(),
        hasAi,
        multiplier: r.multiplier,
        seats: this.seats.map((s, i) => ({
          userId: s.kind === 'human' ? s.userId : null,
          cardsLeft: this.game.hands[i].length,
          delta: r.delta[i],
        })),
      });
    } catch (err) {
      saved = false;
      this.deps.log('Could not save game', err);
    }
    this.result = { winner: r.winner, multiplier: r.multiplier, delta: r.delta, payments: r.payments, hasAi, saved };
    this.#autoCheck();
    this.#changed(true);
  }

  // The only data a client ever receives about this table.
  view(userId) {
    const me = this.seatOf(userId);
    if (me < 0) return null;
    const live = this.game && (this.status === 'playing' || this.status === 'done');
    const g = this.game;
    return {
      id: this.id,
      status: this.status,
      host: this.hostName,
      isHost: userId === this.hostId,
      aiLevel: this.aiLevel,
      version: this.version,
      you: me,
      chatEnabled: this.humans().length >= 2,
      seats: this.seats.map((s, i) => ({
        kind: s.kind,
        name: s.name || null,
        level: s.level || null,
        count: live ? g.hands[i].length : null,
        online: s.kind === 'human' ? this.deps.isOnline(s.userId) : null,
      })),
      game: live
        ? {
            view: observe(g, me),
            turn: g.turn,
            winner: g.winner,
            rules: this.status === 'playing' && g.turn === me ? turnRules(g) : null,
          }
        : null,
      result: this.result,
      // ms is what is left on the server's clock: the browser counts down from when it receives this, so a
      // phone with the wrong time still shows the right number of seconds.
      // What the Leave button would do for this person right now: 'free' (just frees the seat), 'forfeit' (a game
      // in progress is stopped and they lose the most a round can cost) or null (not allowed).
      leave: this.#leaveRule(),
      notice: this.notice,
      next:
        this.autoKind && this.autoAt
          ? { kind: this.autoKind, at: this.autoAt, ms: Math.max(0, this.autoAt - this.deps.cfg.now()) }
          : null,
      hands: this.status === 'done' ? g.hands.map((h) => h.slice()) : null,
    };
  }

  #leaveRule() {
    if (this.status === 'waiting') return 'free';
    if (this.deps.auto) {
      if (this.deps.activeUsers() <= this.seats.length) return null;
      return this.status === 'playing' ? 'forfeit' : 'free';
    }
    return this.status === 'playing' ? null : 'free';
  }

  // Public summary for everyone, seated or not.
  summary() {
    return {
      status: this.status,
      host: this.hostName,
      aiLevel: this.aiLevel,
      seats: this.seats.length,
      players: this.humans().map((s) => s.name),
      humans: this.humans().length,
    };
  }
}

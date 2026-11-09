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
  mustPass,
  initialDeals,
  moveLog,
  normalizePasses,
} from '../src/game.js';
import { classify } from '../src/hands.js';
import { NUM_PLAYERS } from '../src/cards.js';
import { scoreRound, forfeitPenalty } from '../src/scoring.js';
import { recordGame, recordCancelled, recordForfeit, recordProblem, addGameEvent, pruneGameEvents } from './db.js';

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
    this.seats = Array.from({ length: seatCount }, (_, i) =>
      host && i === 0 ? Table.human(host, deps.cfg.now()) : EMPTY,
    );
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
    this.rotationOut = null; // who goes out when the next game starts (the lowest score of the game just played)
    this.notice = null; // why the table is waiting again after a game was stopped (shown to the people still seated)
    this.seasonId = null; // the season whose players sit here (production tables)
    this.watchers = new Map(); // people watching without a seat: userId -> name (not saved: they ask again)
    this.lastOnline = null; // who was connected at the last diary entry (not saved)
  }

  // `since` is when they sat down: it decides who has been seated longest.
  static human(user, since = 0) {
    return { kind: 'human', userId: user.id, name: user.name, since };
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
      rotationOut: data.rotationOut ?? null,
      notice: data.notice ?? null,
      seasonId: data.seasonId ?? null,
      chat: data.chat || [],
      version: data.version + 1, // clients reconnecting after a restart must not ignore the first view
    });
    // A game saved while a pass still locked you out of the trick: apply the current rule to where it stands.
    if (t.status === 'playing' && t.game) {
      const turnBefore = t.game.turn;
      if (normalizePasses(t.game)) {
        deps.log('A saved game was brought in line with the pass rule', t.id, 'turn', turnBefore, '->', t.game.turn);
      }
    }
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
      rotationOut: this.rotationOut,
      notice: this.notice,
      seasonId: this.seasonId,
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
    this.seats[i] = Table.human(user, this.deps.cfg.now());
    this.#autoCheck();
    this.#changed(true);
  }

  // Only the waiting room (or a finished round) lets you give up your seat.
  leave(userId) {
    const i = this.seatOf(userId);
    if (i < 0) return;
    if (this.deps.auto) {
      // A seat is a promise to the other three. With only as many players in the season as seats there is nobody
      // to take it over, so it cannot be given up; with more, a seat can be left before or between games, or
      // mid-game at a cost, and the next player in line takes it.
      const players = this.deps.seasonPlayers(this.seasonId);
      if (players <= this.seats.length) {
        throw new TableError(
          409,
          `There are only ${players} players in this season, so every seat stays filled: nobody can leave until there are more.`,
        );
      }
      if (this.status === 'playing') return this.#forfeit(i);
    } else if (this.status === 'playing') {
      throw new TableError(
        409,
        'The game is in progress and holds your seat until it finishes or an admin cancels it.',
      );
    }
    const leaverName = this.seats[i].name;
    this.seats[i] = EMPTY;
    if (this.deps.auto) {
      // Nobody hosts a production table: the next player in line takes the seat, and the leaver joins the back.
      this.#fillSeats(userId);
      if (this.status === 'done' && this.rotationOut !== null) {
        // Leaving the results counts as the lowest score, so it is this game's one swap: the lowest scorer stays.
        this.rotationOut = null;
        const taker = this.seats[i];
        this.result = {
          ...this.result,
          rotation: { out: leaverName, in: taker.kind === 'human' ? taker.name : null, why: 'left' },
        };
      }
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
    this.#logDeal();
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

  // Chat is for people talking to each other, so it needs two or more people at the table (watchers count).
  say(userId, text) {
    const i = this.seatOf(userId);
    const watching = i < 0 && this.watchers.has(userId);
    if (i < 0 && !watching) throw new TableError(403, 'You are not at this table: watch the game to join the chat.');
    if (this.humans().length + this.watchers.size < 2) {
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
    const name = i >= 0 ? this.seats[i].name : this.watchers.get(userId);
    const msg = { id: last + 1, name, text: clean, ts: this.deps.cfg.now() };
    this.chat.push(msg);
    if (this.chat.length > KEEP_CHAT) this.chat.shift();
    this.deps.persist(this);
    this.deps.onChat(this, msg);
  }

  // Watching: anyone signed in who has no seat here can look at the game (the cards played, never anyone's hand)
  // and chat. Watchers are only remembered while they are connected.
  watch(user) {
    if (this.status === 'closed') throw new TableError(409, 'That table is closed.');
    if (this.seatOf(user.id) >= 0) throw new TableError(409, 'You are in this game: go back to it.');
    this.watchers.set(user.id, user.name);
  }

  unwatch(userId) {
    this.watchers.delete(userId);
  }

  // Admin only (checked by the caller). A game that had started is kept in
  // the record as cancelled, with no results, so it never counts for scoring.
  cancel() {
    if (this.status === 'closed') return;
    if (this.status === 'playing') {
      this.#event('end', { data: { why: 'cancelled' } });
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
    if (this.status === 'playing') {
      const online = this.#online();
      if (JSON.stringify(online) !== this.lastOnline) this.#event('conn', { data: { online } });
    }
    this.#changed(false, false);
  }

  // ---- internals ----

  // The game diary (see game_events in db.js). It is only for finding out what went wrong, so a failure to write
  // to it is logged and never reaches the game.
  #round() {
    return `${this.id}-${this.startedAt}`;
  }

  #online() {
    return this.seats.map((s) => (s.kind === 'human' ? this.deps.isOnline(s.userId) : null));
  }

  #event(kind, { seat = null, cards = null, auto = false, data = null } = {}) {
    try {
      if (kind === 'conn' || kind === 'deal' || kind === 'move') this.lastOnline = JSON.stringify(this.#online());
      addGameEvent(this.deps.db, { round: this.#round(), at: this.deps.cfg.now(), kind, seat, cards, auto, data });
    } catch (err) {
      this.deps.log('Could not write the game diary', err);
    }
  }

  #logDeal() {
    this.#event('deal', {
      data: {
        seats: this.seats.map((s) => ({ kind: s.kind, name: s.name, userId: s.userId ?? null })),
        hands: this.game.hands.map((h) => [...h]),
        turn: this.game.turn,
        online: this.#online(),
      },
    });
    try {
      pruneGameEvents(this.deps.db);
    } catch (err) {
      this.deps.log('Could not tidy the game diary', err);
    }
  }

  // Every entry the engine added to its history since `before`, in order: a play, a pass, or an automatic pass. The
  // last one also says where the game stands, so a gap in what a player saw can be checked against it.
  #logMoves(before, why = null) {
    const added = this.game.history.slice(before);
    added.forEach((e, i) => {
      const last = i === added.length - 1;
      this.#event('move', {
        seat: e.p,
        cards: e.cards,
        auto: !!e.auto,
        data: {
          n: before + i,
          online: this.#online(),
          ...(why && i === 0 ? { why } : {}),
          ...(last
            ? { turn: this.game.turn, winner: this.game.winner, counts: this.game.hands.map((h) => h.length) }
            : {}),
        },
      });
    });
  }

  // `why` is only for the diary: a pass the table made for someone says so there.
  #play(cards, why = null) {
    const cls = cards && cards.length ? classify(cards) : null;
    const before = this.game.history.length;
    applyMove(this.game, cards, cls);
    if (cls) autoSkip(this.game);
    checkInvariants(this.game);
    this.#logMoves(before, why);
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
    if (!this.deps.seasonRunning(this.seasonId)) return this.close(); // the season is over: no next game
    this.#rotate();
    if (this.seats.every((s) => s.kind === 'human')) return this.#newRound();
    this.#toWaiting(); // someone left the results: wait for a replacement
  }

  // Rotation. With more people in the season than seats, whoever scored lowest in the game just played (the loser who
  // paid the most) goes out: to the back of the line, with the next person in line taking the seat. Ties go to whoever has
  // been seated longest, and if that ties too, one of them is picked at random. Leaving a game is scored as the
  // lowest possible, so it ends the same way (see #forfeit). With only as many players as seats nobody rotates.
  #pickLowest(delta) {
    if (!this.deps.auto || this.seasonId === null) return null;
    if (this.deps.seasonPlayers(this.seasonId) <= this.seats.length) return null;
    const people = this.seats.map((s, i) => ({ s, i })).filter(({ s }) => s.kind === 'human');
    if (!people.length) return null;
    const lowest = Math.min(...people.map(({ i }) => delta[i]));
    let tied = people.filter(({ i }) => delta[i] === lowest);
    const longest = Math.min(...tied.map(({ s }) => s.since ?? 0));
    tied = tied.filter(({ s }) => (s.since ?? 0) === longest);
    const pick = tied.length === 1 ? tied[0] : tied[Math.floor(this.deps.cfg.rng() * tied.length)];
    return pick.s.userId;
  }

  // The seat change itself, when the next game is about to start: the seat numbers stay as they were while
  // the result is on screen. Skipped if that person has already left, or if the season no longer has spare people.
  #rotate() {
    const outId = this.rotationOut;
    this.rotationOut = null;
    if (outId === null) return;
    const i = this.seatOf(outId);
    if (i < 0 || this.deps.seasonPlayers(this.seasonId) <= this.seats.length) return;
    this.seats[i] = EMPTY;
    this.#fillSeats(outId);
  }

  // The next game, with the same four people.
  #newRound() {
    this.notice = null;
    this.game = newGame(this.deps.cfg.rng, null, this.seats.length);
    this.result = null;
    this.status = 'playing';
    this.startedAt = this.deps.cfg.now();
    this.#logDeal();
    this.#commit(true);
  }

  // Someone left a game in progress (only possible when there are more people than seats, so the seat can be
  // filled). It costs them the most a round can cost; for the three who stay the game is void and counts for nobody.
  #forfeit(i) {
    const seat = this.seats[i];
    const players = this.seats.length;
    this.#event('end', { seat: i, data: { why: 'forfeit', name: seat.name } });
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
    this.#fillSeats(seat.userId);
    this.#toWaiting();
  }

  // Production tables: an empty seat goes to the next player in the season's line. The person who just gave up a
  // seat goes to the back of the line, and is never the one who takes it over.
  #fillSeats(leaverId) {
    if (!this.deps.auto || this.seasonId === null) return;
    if (leaverId) this.deps.sitOut(this.seasonId, leaverId);
    const taken = this.seats.filter((s) => s.kind === 'human').map((s) => s.userId);
    if (leaverId) taken.push(leaverId);
    this.seats = this.seats.map((s) => {
      if (s.kind !== 'empty') return s;
      const next = this.deps.nextReserve(this.seasonId, taken);
      if (!next) return s;
      taken.push(next.userId);
      return Table.human({ id: next.userId, name: next.name }, this.deps.cfg.now());
    });
  }

  #toWaiting() {
    this.rotationOut = null;
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
      // 20 minutes, and again after 24 hours (timed from when the turn began). It checks the turn is still waiting
      // when it fires, so it says nothing if the table has passed for them by then.
      this.deps.notifier?.schedule(seat.userId, this.turnSince, () => tok === this.token && this.status === 'playing');
      if (mustPass(this.game)) {
        // Nothing in this hand can beat the play: the pass is made for them, after a short pause so the table can
        // be followed.
        this.timer = setTimeout(() => this.#guarded(this.#autoPass(tok)), this.deps.cfg.autoPassMs ?? 1000);
        this.timer.unref?.();
      }
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

  async #autoPass(tok) {
    if (tok !== this.token || this.status !== 'playing' || !mustPass(this.game)) return;
    this.#play(null, 'nothing to beat it with');
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
    this.#event('end', { data: { why: 'finished', winner: r.winner, delta: r.delta } });
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
    this.rotationOut = this.#pickLowest(r.delta);
    const out = this.rotationOut === null ? null : this.seats[this.seatOf(this.rotationOut)].name;
    const taken = this.seats.filter((s) => s.kind === 'human').map((s) => s.userId);
    const incoming = out === null ? null : this.deps.nextReserve(this.seasonId, taken);
    this.result = {
      winner: r.winner,
      multiplier: r.multiplier,
      delta: r.delta,
      payments: r.payments,
      hasAi,
      saved,
      rotation: out === null ? null : { out, in: incoming ? incoming.name : null, why: 'lowest' },
    };
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
      spectator: false,
      chatEnabled: this.humans().length + this.watchers.size >= 2,
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

  // What someone watching sees: the table as seat 0 would, minus every hand (so nothing but what has been played), and
  // no way to move. `spectator` tells the screen to say whose seat is at the bottom instead of "You".
  watchView(userId) {
    const live = this.game && (this.status === 'playing' || this.status === 'done');
    const g = this.game;
    return {
      id: this.id,
      status: this.status,
      host: this.hostName,
      isHost: false,
      aiLevel: this.aiLevel,
      version: this.version,
      you: 0,
      spectator: true,
      chatEnabled: this.humans().length + this.watchers.size >= 2,
      seats: this.seats.map((s, i) => ({
        kind: s.kind,
        name: s.name || null,
        level: s.level || null,
        count: live ? g.hands[i].length : null,
        online: s.kind === 'human' ? this.deps.isOnline(s.userId) : null,
      })),
      game: live ? { view: { ...observe(g, 0), hand: [] }, turn: g.turn, winner: g.winner, rules: null } : null,
      result: this.result,
      leave: null,
      notice: this.notice,
      next:
        this.autoKind && this.autoAt
          ? { kind: this.autoKind, at: this.autoAt, ms: Math.max(0, this.autoAt - this.deps.cfg.now()) }
          : null,
      hands: this.status === 'done' ? g.hands.map((h) => h.slice()) : null,
      watching: this.watchers.has(userId),
    };
  }

  #leaveRule() {
    if (this.deps.auto) {
      if (this.deps.seasonPlayers(this.seasonId) <= this.seats.length) return null;
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
      watching: this.watchers.size,
    };
  }
}

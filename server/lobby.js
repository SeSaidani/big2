// The server holds at most one table. In production nobody creates it: while a season is running there is
// always a table, people sit down, four of them start a game, and when it ends the next one follows with the
// same people. Ending the season stops the game and closes the table. A started game belongs to its seated
// players until it finishes or an admin cancels it, and is saved after every change so it survives a restart.
// (With cfg.devTables an admin creates the table and starts the game by hand, with computer seats if wanted.)

import crypto from 'node:crypto';
import { LEVELS } from '../src/ai/agents.js';
import { PLAYER_COUNTS, NUM_PLAYERS } from '../src/cards.js';
import { Table, TableError } from './table.js';
import { saveLive, loadLive, clearLive, resolveSeason } from './db.js';

export class Lobby {
  // deps: { db, pool, hub, cfg, log, chatLimit }
  constructor(deps) {
    this.deps = deps;
    this.table = null;
    this.auto = !deps.cfg.devTables;
    this.clock = null;
    this.stopped = false;
    this.tableDeps = {
      ...deps,
      auto: this.auto,
      seasonRunning: () => !!resolveSeason(deps.db, 'current', deps.cfg.now()),
      isOnline: (userId) => deps.hub.conns.has(userId),
      persist: (t) => this.#persist(t),
      onView: (t) => this.#pushViews(t),
      onChat: (t, msg) => {
        for (const s of t.humans()) deps.hub.send(s.userId, 'chat', msg);
      },
      onList: () => deps.hub.broadcast('lobby', this.summary()),
      onClose: (t) => this.#drop(t),
    };
  }

  // Pick up a saved table after a restart.
  restore() {
    const data = loadLive(this.deps.db);
    if (data) {
      this.table = Table.restore(data, this.tableDeps);
      this.table.resume();
    }
    this.reconcile();
  }

  // Keeps the table in step with the seasons: a running season has a table, and with none running a table
  // nobody has started closes. (A game in progress is left to finish; the table closes when it is over.)
  reconcile() {
    if (!this.auto || this.stopped) return;
    const running = this.tableDeps.seasonRunning();
    if (running && !this.table) this.#openTable();
    else if (!running && this.table && this.table.status === 'waiting') this.table.close();
  }

  // The clock that notices a season starting or ending by its dates.
  startClock() {
    if (!this.auto || this.clock) return;
    this.clock = setInterval(() => this.reconcile(), this.deps.cfg.clockMs ?? 5000);
    this.clock.unref?.();
  }

  // An admin ended the season: the game stops now (it is recorded as cancelled and never scores) and the table
  // closes. Returns the status the table was in.
  stopForSeasonEnd() {
    const t = this.table;
    if (!t) return null;
    const was = t.status;
    if (was === 'playing') t.cancel();
    else t.close();
    return was;
  }

  // The table this user sits at, if any.
  tableOf(userId) {
    return this.table && this.table.seatOf(userId) >= 0 ? this.table : null;
  }

  summary() {
    return { game: this.table ? this.table.summary() : null };
  }

  // An online game is a season game: four people, no computer players, created by an admin while a season is
  // running. (cfg.devTables, off in production, lifts the table rules for development and tests: computer
  // seats at a chosen level, and 3-seat tables.)
  create(user, aiLevel = 'medium', seats = NUM_PLAYERS) {
    if (!user.isAdmin) throw new TableError(403, 'Only an admin can create a game.');
    if (this.auto) throw new TableError(409, 'Games start by themselves while a season is running.');
    if (this.deps.cfg.devTables) {
      if (!LEVELS.includes(aiLevel)) throw new TableError(400, 'Unknown AI level.');
      if (!PLAYER_COUNTS.includes(seats)) throw new TableError(400, 'A game has 3 or 4 players.');
    } else {
      if (seats !== NUM_PLAYERS) throw new TableError(400, `A season game has ${NUM_PLAYERS} players.`);
      aiLevel = 'medium'; // no computer players online: the level is unused, so a stray value is not kept
    }
    if (!resolveSeason(this.deps.db, 'current', this.deps.cfg.now())) {
      throw new TableError(
        409,
        'No season is running, so a game cannot be started. Create a season in the Admin area first.',
      );
    }
    if (this.table && this.table.status !== 'done') {
      throw new TableError(409, 'A game is already in progress. Only one game can run at a time.');
    }
    if (this.table) this.table.close(); // a finished round's results screen
    const t = new Table(crypto.randomBytes(4).toString('hex'), user, aiLevel, this.tableDeps, seats);
    this.table = t;
    this.#persist(t);
    this.deps.hub.broadcast('lobby', this.summary());
    this.#pushViews(t);
    return t;
  }

  join(user) {
    this.#require().join(user);
    return this.table;
  }

  leave(user) {
    this.#require().leave(user.id);
  }

  start(user) {
    if (this.auto) throw new TableError(409, 'Games start by themselves when four people are seated.');
    this.#require().start(user.id);
  }

  move(user, cards) {
    this.#require().move(user.id, cards);
  }

  say(user, text) {
    this.#require().say(user.id, text);
  }

  cancel() {
    this.#require().cancel();
  }

  // A user's first connection opened or last one closed.
  presence(userId) {
    const t = this.tableOf(userId);
    if (t) t.touch();
  }

  // Process is stopping: halt timers but keep the saved game for the next start.
  shutdown() {
    this.stopped = true;
    clearInterval(this.clock);
    if (this.table) this.table.halt();
  }

  #require() {
    if (!this.table) throw new TableError(404, 'There is no game.');
    return this.table;
  }

  #openTable() {
    const t = new Table(crypto.randomBytes(4).toString('hex'), null, 'medium', this.tableDeps, NUM_PLAYERS);
    this.table = t;
    this.#persist(t);
    this.deps.hub.broadcast('lobby', this.summary());
  }

  #persist(t) {
    try {
      saveLive(this.deps.db, t.serialize());
    } catch (err) {
      this.deps.log('Could not save the live game', err);
    }
  }

  #pushViews(t) {
    for (const s of t.humans()) this.deps.hub.send(s.userId, 'table', t.view(s.userId), t.version);
  }

  #drop(t) {
    if (this.table !== t) return;
    this.table = null;
    clearLive(this.deps.db);
    for (const s of t.humans()) this.deps.hub.send(s.userId, 'table', null);
    this.deps.hub.broadcast('lobby', this.summary());
    this.reconcile(); // a season still running means a fresh table, with the seats empty
  }
}

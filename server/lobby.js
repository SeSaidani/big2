// The server holds at most one table. In production nobody creates it and nobody takes a seat: while a season is
// running with at least four players there is always a table, the season's first four players are seated, four
// seated start a game, and when it ends the next one follows with the same people. A player who leaves is replaced
// by the next in line. Everyone else can watch (never anyone's hand) and chat. Ending the season stops the game and
// closes the table. A started game belongs to its seated players until it finishes or an admin cancels it, and is
// saved after every change so it survives a restart.
// (With cfg.devTables an admin creates the table and starts the game by hand, with computer seats if wanted.)

import crypto from 'node:crypto';
import { LEVELS } from '../src/ai/agents.js';
import { PLAYER_COUNTS, NUM_PLAYERS } from '../src/cards.js';
import { Table, TableError } from './table.js';
import { saveLive, loadLive, clearLive, resolveSeason } from './db.js';
import { MIN_PLAYERS, memberCount, firstPlayers, nextReserve, sitOut } from './roster.js';

export class Lobby {
  // deps: { db, pool, hub, cfg, log, chatLimit }
  constructor(deps) {
    this.deps = deps;
    this.table = null;
    this.auto = !deps.cfg.devTables;
    this.clock = null;
    this.stopped = false;
    const currentSeason = () => resolveSeason(deps.db, 'current', deps.cfg.now());
    this.currentSeason = currentSeason;
    this.tableDeps = {
      ...deps,
      auto: this.auto,
      // Is the season this table belongs to still the one running?
      seasonRunning: (seasonId) => {
        const s = currentSeason();
        return !!s && (seasonId === null || s.id === seasonId);
      },
      seasonPlayers: (seasonId) => (seasonId === null ? 0 : memberCount(deps.db, seasonId)),
      nextReserve: (seasonId, seatedIds) => nextReserve(deps.db, seasonId, seatedIds),
      sitOut: (seasonId, userId) => sitOut(deps.db, seasonId, userId),
      isOnline: (userId) => deps.hub.conns.has(userId),
      persist: (t) => this.#persist(t),
      onView: (t) => this.#pushViews(t),
      onChat: (t, msg) => {
        for (const s of t.humans()) deps.hub.send(s.userId, 'chat', msg);
        for (const id of t.watchers.keys()) deps.hub.send(id, 'chat', msg);
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

  // Keeps the table in step with the seasons: a running season with enough players has a table, seated with its
  // first four; with none running (or too few players) a table nobody has started closes. A game in progress is
  // left to finish, and the table closes when it is over.
  reconcile() {
    if (!this.auto || this.stopped) return;
    const season = this.currentSeason();
    const ready = !!season && memberCount(this.deps.db, season.id) >= MIN_PLAYERS;
    if (!ready) {
      if (this.table && this.table.status === 'waiting') this.table.close();
      return;
    }
    if (!this.table) this.#openTable(season);
    else if (this.table.seasonId !== season.id && this.table.status === 'waiting') this.table.close(); // reopens below
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

  // What this user is shown of the table: their own view if they sit at it, the watcher's view if they are watching.
  viewFor(user) {
    const t = this.tableOf(user.id);
    if (t) return t.view(user.id);
    if (this.table && this.table.watchers.has(user.id)) return this.table.watchView(user.id);
    return null;
  }

  summary() {
    return { game: this.table ? this.table.summary() : null, season: this.#seasonNote() };
  }

  // Why there is (or is not) a table, for the lobby to say: no season, or a season that needs more players.
  #seasonNote() {
    if (!this.auto) return null;
    const season = this.currentSeason();
    if (!season) return { state: 'none' };
    const players = memberCount(this.deps.db, season.id);
    return players >= MIN_PLAYERS
      ? { state: 'running', name: season.name, players }
      : { state: 'needs-players', name: season.name, players, needed: MIN_PLAYERS };
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
    if (this.auto) throw new TableError(409, "Seats go to the season's players: you cannot take one. You can watch.");
    this.#require().join(user);
    return this.table;
  }

  leave(user) {
    const t = this.#require();
    if (t.watchers.has(user.id)) return t.unwatch(user.id); // stopping watching
    t.leave(user.id);
  }

  // Look at the game without a seat. Seated players are sent back to their own view instead.
  watch(user) {
    this.#require().watch(user);
    this.deps.hub.broadcast('lobby', this.summary());
    return this.table;
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
    if (t) return t.touch();
    // Someone who was watching and has gone away is not watching any more.
    if (this.table && this.table.watchers.has(userId) && !this.deps.hub.conns.has(userId)) {
      this.table.unwatch(userId);
    }
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

  // A table for the season, with its first four players already in their seats.
  #openTable(season) {
    const t = new Table(crypto.randomBytes(4).toString('hex'), null, 'medium', this.tableDeps, NUM_PLAYERS);
    t.seasonId = season.id;
    firstPlayers(this.deps.db, season.id, NUM_PLAYERS).forEach((m, i) => {
      t.seats[i] = Table.human({ id: m.userId, name: m.name }, this.deps.cfg.now());
    });
    this.table = t;
    t.resume(); // all four are seated: the countdown to the first game starts
    this.#persist(t);
    this.deps.hub.broadcast('lobby', this.summary());
    this.#pushViews(t);
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
    for (const id of t.watchers.keys()) this.deps.hub.send(id, 'table', t.watchView(id), t.version);
  }

  #drop(t) {
    if (this.table !== t) return;
    this.table = null;
    clearLive(this.deps.db);
    for (const s of t.humans()) this.deps.hub.send(s.userId, 'table', null);
    for (const id of t.watchers.keys()) this.deps.hub.send(id, 'table', null);
    this.deps.hub.broadcast('lobby', this.summary());
    this.reconcile(); // a season still running means a fresh table, seated with its first four players
  }
}

// The server holds at most one table. Only an admin creates it; a started game
// belongs to its seated players until it finishes or an admin cancels it, and
// is saved after every change so it survives a restart.

import crypto from 'node:crypto';
import { LEVELS } from '../src/ai/agents.js';
import { Table, TableError } from './table.js';
import { saveLive, loadLive, clearLive } from './db.js';

export class Lobby {
  // deps: { db, pool, hub, cfg, log, chatLimit }
  constructor(deps) {
    this.deps = deps;
    this.table = null;
    this.tableDeps = {
      ...deps,
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
    if (!data) return;
    this.table = Table.restore(data, this.tableDeps);
    this.table.resume();
  }

  // The table this user sits at, if any.
  tableOf(userId) {
    return this.table && this.table.seatOf(userId) >= 0 ? this.table : null;
  }

  summary() {
    return { game: this.table ? this.table.summary() : null };
  }

  create(user, aiLevel = 'medium') {
    if (!user.isAdmin) throw new TableError(403, 'Only an admin can create a game.');
    if (!LEVELS.includes(aiLevel)) throw new TableError(400, 'Unknown AI level.');
    if (this.table && this.table.status !== 'done') {
      throw new TableError(409, 'A game is already in progress. Only one game can run at a time.');
    }
    if (this.table) this.table.close(); // a finished round's results screen
    const t = new Table(crypto.randomBytes(4).toString('hex'), user, aiLevel, this.tableDeps);
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
    if (this.table) this.table.halt();
  }

  #require() {
    if (!this.table) throw new TableError(404, 'There is no game.');
    return this.table;
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
  }
}

// "It is your turn" alerts, as push notifications to the person's devices. At most two per turn, and
// only if the person has not played:
//   1. firstAfterMs (default 20 minutes) after the turn passed to them, and
//   2. secondAfterMs (default 24 hours) after it passed, if it is still their turn.
// A person who moves in time costs nothing. Nothing depends on whether a page is open.
//
// The table tells us when a turn began (`since`, saved with the game, so it survives a restart:
// resume() schedules again from the saved time). Whether an alert has already gone out for this
// turn is read from the database (alerts logged since the turn began), so a restart or a
// repeated check can never send one twice. A safety cap per person per 24 hours remains.
// An alert says it is your turn and never shows any cards.
//
// A failing push service never touches the game: failures are logged and swallowed.

import { countPush, lastPushAt, logPush, listSubscriptions } from './push-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TURN_ALERTS = 2;

export class TurnNotifier {
  // pusher: { canSend, sendToUser(userId, message) -> { devices, delivered, removed } }
  constructor({ db, pusher, config = {}, log = () => {} }) {
    this.db = db;
    this.pusher = pusher;
    this.log = log;
    this.config = {
      firstAfterMs: 20 * 60_000,
      secondAfterMs: DAY_MS,
      maxPerDay: 6,
      now: Date.now,
      ...config,
    };
    this.timers = new Map(); // userId -> [timers] for the pending turn
    this.inflight = new Set();
  }

  // The turn passed to `userId` at time `since`. `stillTheirTurn()` is asked again when each
  // time is up: it must be false if anything has happened since.
  schedule(userId, since, stillTheirTurn) {
    if (!this.pusher.canSend) return;
    this.#clear(userId);
    const c = this.config;
    const timers = [c.firstAfterMs, c.secondAfterMs].map((after) => {
      const timer = setTimeout(
        () => {
          if (!stillTheirTurn()) return;
          this.consider(userId, since).catch((err) => this.log('turn alert failed unexpectedly', err));
        },
        Math.max(0, since + after - c.now()),
      );
      timer.unref?.();
      return timer;
    });
    this.timers.set(userId, timers);
  }

  stop() {
    for (const id of [...this.timers.keys()]) this.#clear(id);
  }

  #clear(userId) {
    for (const t of this.timers.get(userId) ?? []) clearTimeout(t);
    this.timers.delete(userId);
  }

  // Decides and (if allowed) sends. Returns why, so tests can assert on it.
  async consider(userId, since) {
    if (!this.pusher.canSend) return 'no-pusher';
    if (this.inflight.has(userId)) return 'busy';
    const c = this.config;
    if (!listSubscriptions(this.db, userId).length) return 'no-device';

    const now = c.now();
    const elapsed = now - since;
    const sent = countPush(this.db, userId, since); // alerts for this turn
    if (sent >= MAX_TURN_ALERTS) return 'enough';
    if (sent === 0) {
      if (elapsed < c.firstAfterMs) return 'too-soon';
    } else {
      if (elapsed < c.secondAfterMs) return 'too-soon';
      // After a long outage both times pass at once: one alert catches up, not two in a row.
      if (lastPushAt(this.db, userId) >= since + c.secondAfterMs) return 'caught-up';
    }
    if (countPush(this.db, userId, now - DAY_MS) >= c.maxPerDay) return 'daily-cap';

    this.inflight.add(userId);
    try {
      const body = sent === 0 ? "It's your turn." : "It's still your turn.";
      const r = await this.pusher.sendToUser(userId, { title: 'Big Two', body, url: '/', tag: 'turn' });
      const ok = r.delivered > 0;
      logPush(this.db, userId, ok, now);
      return ok ? 'sent' : 'failed';
    } finally {
      this.inflight.delete(userId);
    }
  }
}

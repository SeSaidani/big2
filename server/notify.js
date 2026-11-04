// "It is your turn" texts. The table tells us when the turn passes to a
// person; we wait a little (they may be about to move), re-check that it is
// still their turn and that they are not already looking at the game, then
// text them once, politely: a per-person cooldown and a daily cap, kept in the
// database so a restart cannot cause a second text. A text carries a link and
// never any cards.
//
// A failing provider never touches the game: errors are logged (with the
// number masked) and swallowed. "Opted out" from the carrier switches texting
// off for that person until they set their number again.

import { maskPhone } from './phone-format.js';
import { textingRow, blockSms, logSms, lastSmsAt, countSms } from './phones.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export class TurnNotifier {
  // config.when: 'offline' (only if they have no open page) or 'always'
  constructor({ db, provider, isOnline, config = {}, log = () => {} }) {
    this.db = db;
    this.provider = provider;
    this.isOnline = isOnline;
    this.log = log;
    this.config = {
      delayMs: 20_000,
      cooldownMs: 10 * 60_000,
      maxPerDay: 12,
      when: 'offline',
      baseUrl: '',
      requireVerified: true,
      retryDelayMs: 5000,
      now: Date.now,
      ...config,
    };
    this.timers = new Map(); // userId -> pending timer
    this.inflight = new Set();
  }

  // The turn has just passed to `userId`. `stillTheirTurn()` is asked again when
  // the delay is up: it must be false if anything has happened since.
  schedule(userId, stillTheirTurn) {
    if (!this.provider.canSend) return;
    clearTimeout(this.timers.get(userId));
    const timer = setTimeout(() => {
      this.timers.delete(userId);
      if (!stillTheirTurn()) return;
      this.consider(userId).catch((err) => this.log('turn text failed unexpectedly', err));
    }, this.config.delayMs);
    timer.unref?.();
    this.timers.set(userId, timer);
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // Decides and (if allowed) sends. Returns why, so tests can assert on it.
  async consider(userId) {
    if (!this.provider.canSend) return 'no-provider';
    if (this.inflight.has(userId)) return 'busy';
    const c = this.config;
    const u = textingRow(this.db, userId);
    if (!u || !u.phone) return 'no-phone';
    if (!u.enabled) return 'switched-off';
    if (u.blocked) return 'blocked';
    if (c.requireVerified && !u.verified) return 'unverified';
    if (c.when === 'offline' && this.isOnline(userId)) return 'online';
    const now = c.now();
    const last = lastSmsAt(this.db, userId, 'turn');
    if (last !== null && now - last < c.cooldownMs) return 'cooldown';
    if (countSms(this.db, userId, 'turn', now - DAY_MS) >= c.maxPerDay) return 'daily-cap';

    this.inflight.add(userId);
    try {
      const body = c.baseUrl ? `Big Two: it's your turn. ${c.baseUrl}` : "Big Two: it's your turn.";
      const ok = await this.#sendWithRetry(userId, u.phone, body);
      logSms(this.db, userId, 'turn', ok, c.now());
      return ok ? 'sent' : 'failed';
    } finally {
      this.inflight.delete(userId);
    }
  }

  async #sendWithRetry(userId, phone, body) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.provider.send({ to: phone, body });
        return true;
      } catch (err) {
        this.log(`turn text to ${maskPhone(phone)} failed (attempt ${attempt}): ${err.message}`);
        if (err.optedOut) {
          blockSms(this.db, userId);
          return false;
        }
        if (!err.retryable || attempt === 2) return false;
        await new Promise((r) => setTimeout(r, this.config.retryDelayMs));
      }
    }
    return false;
  }
}

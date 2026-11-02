// Server-sent-event connections, grouped by user. An account may have several
// open (several tabs); each receives every message. `onPresence(userId)` fires
// when a user's first connection opens or their last one closes.

const MAX_BUFFERED = 1 << 20;

export class Hub {
  constructor(onPresence = () => {}) {
    this.conns = new Map(); // userId -> Set<res>
    this.onPresence = onPresence;
  }

  add(userId, res) {
    const first = !this.conns.has(userId);
    if (first) this.conns.set(userId, new Set());
    this.conns.get(userId).add(res);
    if (first) this.onPresence(userId);
  }

  remove(userId, res) {
    const set = this.conns.get(userId);
    if (!set) return;
    set.delete(res);
    if (!set.size) {
      this.conns.delete(userId);
      this.onPresence(userId);
    }
  }

  #write(res, text) {
    if (res.writableLength > MAX_BUFFERED) {
      res.destroy();
    } // a stalled client must not hold memory
    else res.write(text);
  }

  static format(event, data, id) {
    return `${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  sendTo(res, event, data, id) {
    this.#write(res, Hub.format(event, data, id));
  }

  send(userId, event, data, id) {
    const set = this.conns.get(userId);
    if (!set) return;
    const text = Hub.format(event, data, id);
    for (const res of set) this.#write(res, text);
  }

  broadcast(event, data) {
    const text = Hub.format(event, data);
    for (const set of this.conns.values()) for (const res of set) this.#write(res, text);
  }

  // End every stream of one user (their sessions were revoked).
  disconnect(userId) {
    const set = this.conns.get(userId);
    if (set) for (const res of [...set]) res.end();
  }

  closeAll() {
    this.onPresence = () => {};
    for (const set of this.conns.values()) for (const res of set) res.end();
    this.conns.clear();
  }
}

// Runs AI decisions off the main thread so the page never freezes.
import { chooseMove } from './agents.js';

self.onmessage = (e) => {
  const { id, view, level } = e.data;
  try {
    const m = chooseMove(view, level);
    self.postMessage({ id, cards: m ? m.cards : null });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack ? err.stack : err) });
  }
};

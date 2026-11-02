// Worker thread: runs one AI decision at a time.

import { parentPort } from 'node:worker_threads';
import { chooseMove } from '../src/ai/agents.js';

parentPort.on('message', ({ id, view, level, opts }) => {
  try {
    const m = chooseMove(view, level, opts);
    parentPort.postMessage({ id, cards: m ? m.cards : null });
  } catch (err) {
    parentPort.postMessage({ id, error: String((err && err.stack) || err) });
  }
});

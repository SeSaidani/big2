// AI decisions off the main thread, so Hard's search (~900 ms) cannot stall
// other tables. choose(view, level) resolves to an array of card ids, or null
// for a pass. A job that exceeds `timeoutMs` kills its worker (replaced
// immediately) and falls back to the Easy policy so a table never hangs.
// `inline: true` runs on the calling thread (tests).

import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { chooseMove } from '../src/ai/agents.js';

const WORKER_FILE = fileURLToPath(new URL('./ai-worker.js', import.meta.url));

const easy = (view) => {
  const m = chooseMove(view, 'easy');
  return m ? m.cards : null;
};

export function createPool({
  size = Math.max(1, Math.min(4, os.availableParallelism() - 1)),
  inline = false,
  timeoutMs = 5000,
} = {}) {
  if (inline) {
    return {
      choose: async (view, level, opts) => {
        const m = chooseMove(view, level, opts);
        return m ? m.cards : null;
      },
      close() {},
    };
  }

  const slots = [];
  const queue = [];
  let nextId = 1;
  let closed = false;

  const spawn = () => {
    const slot = { worker: new Worker(WORKER_FILE), job: null, timer: null };
    slot.worker.on('message', (msg) => {
      const job = slot.job;
      if (!job || job.id !== msg.id) return;
      finish(slot);
      if (msg.error) job.resolve(easy(job.view));
      else job.resolve(msg.cards);
    });
    slot.worker.on('error', () => replace(slot));
    slot.worker.on('exit', () => {
      if (!closed && slots.includes(slot)) replace(slot);
    });
    return slot;
  };

  const finish = (slot) => {
    clearTimeout(slot.timer);
    slot.job = null;
    pump();
  };

  const replace = (slot) => {
    const i = slots.indexOf(slot);
    if (i < 0) return;
    clearTimeout(slot.timer);
    const job = slot.job;
    slot.job = null;
    slots[i] = closed ? slot : spawn();
    slot.worker.terminate();
    if (job) job.resolve(easy(job.view));
    pump();
  };

  const pump = () => {
    for (const slot of slots) {
      if (slot.job || !queue.length) continue;
      const job = queue.shift();
      slot.job = job;
      slot.timer = setTimeout(() => replace(slot), timeoutMs);
      slot.worker.postMessage({ id: job.id, view: job.view, level: job.level, opts: job.opts });
    }
  };

  for (let i = 0; i < size; i++) slots.push(spawn());
  for (const s of slots) s.worker.unref();

  return {
    choose(view, level, opts) {
      if (closed) return Promise.reject(new Error('AI pool is closed'));
      return new Promise((resolve) => {
        queue.push({ id: nextId++, view, level, opts, resolve });
        pump();
      });
    },
    close() {
      closed = true;
      for (const s of slots) {
        clearTimeout(s.timer);
        s.worker.terminate();
      }
    },
  };
}

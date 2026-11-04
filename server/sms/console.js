// Development provider: nothing leaves the machine. Messages are kept in
// `outbox` (tests read it) and printed unless `quiet`. It prints the whole
// message, verification codes included, so never use it in production.

import { maskPhone } from '../phone-format.js';

export function createConsoleProvider(config = {}, deps = {}) {
  const quiet = config.quiet ?? false;
  const log = deps.log ?? console.log;
  const outbox = [];
  let n = 0;
  return {
    name: 'console',
    canSend: true,
    outbox,
    async send({ to, body }) {
      const id = `console-${++n}`;
      outbox.push({ id, to, body });
      if (!quiet) log(`[sms to ${maskPhone(to)}] ${body}`);
      return { id };
    },
  };
}

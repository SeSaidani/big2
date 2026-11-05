// Sends one message to every device a person has turn alerts on for.
// A device that is gone for good (the push service says 404/410) is forgotten; a busy push service is
// tried once more. Nothing here ever throws into the game: the result says what happened.

import { sendPush } from './web-push.js';
import { listSubscriptions, removeSubscriptionById, markDelivered, vapidKeys } from './push-store.js';

export function createPusher({ db, subject, fetchImpl = fetch, now = Date.now, retryDelayMs = 2000, log = () => {} }) {
  const keys = vapidKeys(db);
  return {
    canSend: true,
    publicKey: keys.publicKey,
    // message: { title, body, url?, tag? } (plain text; it is encrypted for each device).
    // Returns { devices, delivered, removed }: how many devices there were, how many accepted it, how many
    // were dropped as dead.
    async sendToUser(userId, message, { topic } = {}) {
      const subs = listSubscriptions(db, userId);
      const payload = JSON.stringify(message);
      const results = await Promise.all(
        subs.map(async (sub) => {
          let r;
          for (let attempt = 1; attempt <= 2; attempt++) {
            r = await sendPush({ subscription: sub, payload, keys, subject, fetchImpl, now: now(), topic });
            if (!r.retryable) break;
            if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          }
          if (r.ok) markDelivered(db, sub.id, now());
          else if (r.gone) removeSubscriptionById(db, sub.id);
          else log(`push to device ${sub.id} failed (status ${r.status || 'no answer'})`);
          return r;
        }),
      );
      return {
        devices: subs.length,
        delivered: results.filter((r) => r.ok).length,
        removed: results.filter((r) => r.gone).length,
      };
    },
  };
}

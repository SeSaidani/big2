// Rearranging your own hand by hand: the order a player has made, kept apart from the sort. Pure, so it is
// unit-tested in Node. The order is only a list of card ids; the hand itself (what you hold) is never changed.

// The hand as the player has arranged it: the cards of `order` that are still held, in that order, then anything held
// that the order does not mention (in the order the hand gives it), so a stale or short order can never hide a card.
export function applyOrder(order, hand) {
  const held = new Set(hand);
  const placed = order.filter((c, i) => held.has(c) && order.indexOf(c) === i);
  const seen = new Set(placed);
  return [...placed, ...hand.filter((c) => !seen.has(c))];
}

// `order` with card `id` moved so that it sits at position `to` (0 = leftmost) in the result. A position outside the
// hand is the nearest end. An id that is not in the order leaves it as it was.
export function moveCard(order, id, to) {
  const from = order.indexOf(id);
  if (from < 0) return [...order];
  const rest = order.filter((c) => c !== id);
  const at = Math.max(0, Math.min(rest.length, Math.round(to)));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

// Where a carried card lands: it started in slot `from`, the cards sit `step` px apart, and the finger has moved `dx`
// px since it picked the card up, so the card follows the finger by whole slots. Always 0..count-1. Working from how
// far the finger has moved (not from where the row is on the page) means it does not depend on the layout.
export function slotAfter(from, dx, step, count) {
  if (!(count > 1) || !(step > 0)) return 0;
  return Math.max(0, Math.min(count - 1, from + Math.round(dx / step)));
}

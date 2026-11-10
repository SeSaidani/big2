// Who sits where. The order people sit in decides who they pass the turn to, and whose one card forces their highest
// single (the next seat's), so a table where the same four people always sit in the same order would give the same
// neighbours every game. Every game is therefore dealt to a fresh random order of the same people.

// A uniformly random order of `seats` (Fisher-Yates: every one of the n! orders is equally likely when `rng` is
// uniform in [0, 1)). A new array: the one given is not changed.
export function shuffleSeats(seats, rng) {
  const out = [...seats];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

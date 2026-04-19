// Toy safe-prime Schnorr group for fast tests:
// q is prime, p = 2q+1 is prime, and g is a generator of the order-q subgroup.
// Generated locally (see repo history).
export const GROUP = Object.freeze({
  q: 2305843009213697249n,
  p: 4611686018427394499n,
  g: 4n
});


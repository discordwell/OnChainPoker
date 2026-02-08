import type { WorldState } from "./types.js";

export function assertInvariants(world: WorldState): void {
  const { table } = world;

  let total = world.treasury;

  for (const v of world.validators.values()) {
    if (v.stake < 0) throw new Error(`invariant: negative validator stake for ${v.id}`);
    total += v.stake;
  }

  for (const p of table.players) {
    if (p.stack < 0) throw new Error(`invariant: negative player stack for ${p.id}`);
    if (p.committed < 0) throw new Error(`invariant: negative player committed for ${p.id}`);
    if (p.bond < 0) throw new Error(`invariant: negative player bond for ${p.id}`);
    total += p.stack + p.committed + p.bond;
  }

  // Store the invariant target on the world object to avoid plumbing it everywhere.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyWorld = world as any;
  if (anyWorld.__initialTotal === undefined) {
    anyWorld.__initialTotal = total;
  } else if (total !== anyWorld.__initialTotal) {
    throw new Error(`invariant: chip conservation violated: total=${total} initial=${anyWorld.__initialTotal}`);
  }

  const hand = table.hand;
  if (hand?.dealer.deckCursor !== undefined) {
    if (hand.dealer.deckCursor < 0 || hand.dealer.deckCursor > 52) {
      throw new Error(`invariant: deckCursor out of bounds: ${hand.dealer.deckCursor}`);
    }
  }
}


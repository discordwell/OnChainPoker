export enum HandCategory {
  HighCard = 0,
  OnePair = 1,
  TwoPair = 2,
  Trips = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  Quads = 7,
  StraightFlush = 8
}

export type HandRank = Readonly<{
  category: HandCategory;
  /**
   * Lexicographic tiebreakers, high-to-low.
   * Examples:
   * - Straight: [highCard] (wheel = 5)
   * - Quads: [quadRank, kicker]
   * - TwoPair: [highPair, lowPair, kicker]
   */
  tiebreakers: readonly number[];
}>;

export function compareHandRank(a: HandRank, b: HandRank): -1 | 0 | 1 {
  if (a.category !== b.category) {
    return a.category < b.category ? -1 : 1;
  }

  const len = Math.max(a.tiebreakers.length, b.tiebreakers.length);
  for (let i = 0; i < len; i += 1) {
    const av = a.tiebreakers[i] ?? 0;
    const bv = b.tiebreakers[i] ?? 0;
    if (av !== bv) {
      return av < bv ? -1 : 1;
    }
  }

  return 0;
}


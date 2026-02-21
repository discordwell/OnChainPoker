import { assertValidCardId, cardRank, cardSuit, type CardId, type Rank } from "./cards.js";
import { compareHandRank, type HandRank, HandCategory } from "./handRank.js";

function assertDistinct(cards: readonly CardId[], label: string): void {
  const seen = new Set<number>();
  for (const c of cards) {
    assertValidCardId(c);
    if (seen.has(c)) {
      throw new RangeError(`${label} contains duplicate card id ${c}.`);
    }
    seen.add(c);
  }
}

function straightHighFromRanksDesc(uniqueRanksDesc: readonly Rank[]): Rank | null {
  if (uniqueRanksDesc.length !== 5) return null;

  // Unique ranks descending. Detect wheel (A-5) specially.
  const hasAce = uniqueRanksDesc[0] === 14;
  const wheel = hasAce && uniqueRanksDesc[1] === 5 && uniqueRanksDesc[2] === 4 && uniqueRanksDesc[3] === 3 && uniqueRanksDesc[4] === 2;
  if (wheel) return 5;

  for (let i = 1; i < uniqueRanksDesc.length; i += 1) {
    if (uniqueRanksDesc[i - 1]! - 1 !== uniqueRanksDesc[i]!) return null;
  }
  return uniqueRanksDesc[0]!;
}

function ranksDesc(cards: readonly CardId[]): Rank[] {
  const ranks = cards.map(cardRank);
  ranks.sort((a, b) => b - a);
  return ranks;
}

export function evaluate5(cards5: readonly CardId[]): HandRank {
  if (cards5.length !== 5) {
    throw new RangeError(`evaluate5 expected 5 cards, got ${cards5.length}.`);
  }
  assertDistinct(cards5, "cards5");

  const suits = cards5.map(cardSuit);
  const isFlush = suits.every((s) => s === suits[0]);

  const ranks = ranksDesc(cards5);
  const counts = new Map<Rank, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);

  const uniqueRanksDesc = Array.from(counts.keys()).sort((a, b) => b - a) as Rank[];
  const isStraight = uniqueRanksDesc.length === 5 && straightHighFromRanksDesc(uniqueRanksDesc) !== null;
  const straightHigh = isStraight ? (straightHighFromRanksDesc(uniqueRanksDesc) as Rank) : null;

  const groups = Array.from(counts.entries())
    .map(([rank, count]) => ({ rank, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : b.rank - a.rank));

  if (isStraight && isFlush) {
    return { category: HandCategory.StraightFlush, tiebreakers: [straightHigh!] };
  }

  if (groups[0]!.count === 4) {
    const quadRank = groups[0]!.rank;
    const kicker = groups.find((g) => g.count === 1)!.rank;
    return { category: HandCategory.Quads, tiebreakers: [quadRank, kicker] };
  }

  if (groups[0]!.count === 3 && groups[1]!.count === 2) {
    return { category: HandCategory.FullHouse, tiebreakers: [groups[0]!.rank, groups[1]!.rank] };
  }

  if (isFlush) {
    return { category: HandCategory.Flush, tiebreakers: ranks };
  }

  if (isStraight) {
    return { category: HandCategory.Straight, tiebreakers: [straightHigh!] };
  }

  if (groups[0]!.count === 3) {
    const tripsRank = groups[0]!.rank;
    const kickers = groups
      .filter((g) => g.count === 1)
      .map((g) => g.rank)
      .sort((a, b) => b - a);
    return { category: HandCategory.Trips, tiebreakers: [tripsRank, ...kickers] };
  }

  if (groups[0]!.count === 2 && groups[1]!.count === 2) {
    const pairRanks = [groups[0]!.rank, groups[1]!.rank].sort((a, b) => b - a);
    const kicker = groups.find((g) => g.count === 1)!.rank;
    return { category: HandCategory.TwoPair, tiebreakers: [pairRanks[0]!, pairRanks[1]!, kicker] };
  }

  if (groups[0]!.count === 2) {
    const pairRank = groups[0]!.rank;
    const kickers = groups
      .filter((g) => g.count === 1)
      .map((g) => g.rank)
      .sort((a, b) => b - a);
    return { category: HandCategory.OnePair, tiebreakers: [pairRank, ...kickers] };
  }

  return { category: HandCategory.HighCard, tiebreakers: ranks };
}

const COMBOS_7_CHOOSE_5: readonly (readonly [number, number, number, number, number])[] = [
  [0, 1, 2, 3, 4],
  [0, 1, 2, 3, 5],
  [0, 1, 2, 3, 6],
  [0, 1, 2, 4, 5],
  [0, 1, 2, 4, 6],
  [0, 1, 2, 5, 6],
  [0, 1, 3, 4, 5],
  [0, 1, 3, 4, 6],
  [0, 1, 3, 5, 6],
  [0, 1, 4, 5, 6],
  [0, 2, 3, 4, 5],
  [0, 2, 3, 4, 6],
  [0, 2, 3, 5, 6],
  [0, 2, 4, 5, 6],
  [0, 3, 4, 5, 6],
  [1, 2, 3, 4, 5],
  [1, 2, 3, 4, 6],
  [1, 2, 3, 5, 6],
  [1, 2, 4, 5, 6],
  [1, 3, 4, 5, 6],
  [2, 3, 4, 5, 6]
] as const;

export function evaluate7(cards7: readonly CardId[]): HandRank {
  if (cards7.length !== 7) {
    throw new RangeError(`evaluate7 expected 7 cards, got ${cards7.length}.`);
  }
  assertDistinct(cards7, "cards7");

  let best: HandRank | null = null;
  for (const [a, b, c, d, e] of COMBOS_7_CHOOSE_5) {
    const rank = evaluate5([cards7[a], cards7[b], cards7[c], cards7[d], cards7[e]]);
    if (best === null || compareHandRank(rank, best) === 1) {
      best = rank;
    }
  }
  return best!;
}

export function winners(
  board5: readonly CardId[],
  holeCardsBySeat: Readonly<Record<number, readonly [CardId, CardId]>>
): number[] {
  if (board5.length !== 5) {
    throw new RangeError(`winners expected 5 board cards, got ${board5.length}.`);
  }
  assertDistinct(board5, "board5");

  const entries = Object.entries(holeCardsBySeat)
    .map(([seatStr, hole]) => ({ seat: Number(seatStr), hole }))
    .filter((e) => Number.isInteger(e.seat));

  let best: HandRank | null = null;
  let bestSeats: number[] = [];

  for (const { seat, hole } of entries) {
    if (!Array.isArray(hole) || hole.length !== 2) {
      throw new TypeError(`Invalid hole cards for seat ${seat}; expected [c1, c2].`);
    }
    assertDistinct([...board5, hole[0], hole[1]], `seat ${seat} cards`);
    const rank = evaluate7([...board5, hole[0], hole[1]]);
    if (best === null) {
      best = rank;
      bestSeats = [seat];
      continue;
    }
    const cmp = compareHandRank(rank, best);
    if (cmp === 1) {
      best = rank;
      bestSeats = [seat];
    } else if (cmp === 0) {
      bestSeats.push(seat);
    }
  }

  bestSeats.sort((a, b) => a - b);
  return bestSeats;
}


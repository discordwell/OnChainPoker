import type { CardId } from "@onchainpoker/holdem-eval";
import {
  cardRank,
  cardSuit,
  evaluate5,
  evaluate7,
  compareHandRank,
  HandCategory,
  type HandRank,
} from "@onchainpoker/holdem-eval";

// ---------------------------------------------------------------------------
// Hand evaluation helpers
// ---------------------------------------------------------------------------

/** Evaluate the best 5-card hand from 5, 6, or 7 cards. */
export function evaluateBest(cards: readonly CardId[]): HandRank {
  const n = cards.length;
  if (n === 7) return evaluate7(cards);
  if (n === 5) return evaluate5(cards);
  if (n === 6) {
    let best: HandRank | null = null;
    for (let skip = 0; skip < 6; skip++) {
      const five = [...cards.slice(0, skip), ...cards.slice(skip + 1)];
      const rank = evaluate5(five);
      if (best === null || compareHandRank(rank, best) === 1) best = rank;
    }
    return best!;
  }
  throw new RangeError(`evaluateBest: expected 5-7 cards, got ${n}`);
}

export function hasFlushDraw(hole: [CardId, CardId], board: CardId[]): boolean {
  const suits = [0, 0, 0, 0];
  for (const c of [...hole, ...board]) suits[cardSuit(c)]++;
  return suits.some((count) => count === 4);
}

export function hasStraightDraw(hole: [CardId, CardId], board: CardId[]): boolean {
  const ranks = new Set<number>([...hole, ...board].map((c) => cardRank(c)));
  if (ranks.has(14)) ranks.add(1); // ace-low
  for (let high = 5; high <= 14; high++) {
    let count = 0;
    for (let r = high - 4; r <= high; r++) {
      if (ranks.has(r)) count++;
    }
    if (count === 4) return true;
  }
  return false;
}

export type PostflopStrength = "monster" | "strong" | "medium" | "draw" | "weak";

export function categorizePostflop(
  hole: [CardId, CardId],
  board: CardId[]
): PostflopStrength {
  const all = [...hole, ...board];
  if (all.length < 5) return "weak";

  const handRank = evaluateBest(all);

  // Two pair or better → monster
  if (handRank.category >= HandCategory.TwoPair) return "monster";

  if (handRank.category === HandCategory.OnePair) {
    const pairRank = handRank.tiebreakers[0]!;
    const boardRanks = board.map((c) => cardRank(c)).sort((a, b) => b - a);
    const topBoardRank = boardRanks[0] ?? 0;

    if (pairRank > topBoardRank) {
      // Overpair
      return "strong";
    }
    if (pairRank === topBoardRank) {
      // Top pair — check kicker quality
      const kicker = handRank.tiebreakers[1] ?? 0;
      return kicker >= 12 ? "strong" : "medium"; // Q+ kicker
    }
    // Middle or bottom pair
    return "medium";
  }

  // High card — check draws
  if (hasFlushDraw(hole, board) || hasStraightDraw(hole, board)) {
    return "draw";
  }

  return "weak";
}

// ---------------------------------------------------------------------------
// Bet sizing helpers
// ---------------------------------------------------------------------------

/** Clamp a bet to at least minRaise and at most stack. */
export function clampBet(desired: bigint, minRaise: bigint, stack: bigint): bigint {
  if (desired > stack) return stack;
  if (desired < minRaise) return minRaise > stack ? stack : minRaise;
  return desired;
}

export function potFraction(pot: bigint, num: bigint, den: bigint): bigint {
  return (pot * num) / den;
}

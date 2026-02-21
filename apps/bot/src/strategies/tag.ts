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
import type { GameState, BotAction, Strategy } from "../strategy.js";
import { preflopTier } from "./preflopRanges.js";

// ---------------------------------------------------------------------------
// Hand evaluation helpers
// ---------------------------------------------------------------------------

/** Evaluate the best 5-card hand from 5, 6, or 7 cards. */
function evaluateBest(cards: readonly CardId[]): HandRank {
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

function hasFlushDraw(hole: [CardId, CardId], board: CardId[]): boolean {
  const suits = [0, 0, 0, 0];
  for (const c of [...hole, ...board]) suits[cardSuit(c)]++;
  return suits.some((count) => count === 4);
}

function hasStraightDraw(hole: [CardId, CardId], board: CardId[]): boolean {
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

type PostflopStrength = "monster" | "strong" | "medium" | "draw" | "weak";

function categorizePostflop(
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
function clampBet(desired: bigint, minRaise: bigint, stack: bigint): bigint {
  if (desired > stack) return stack;
  if (desired < minRaise) return minRaise > stack ? stack : minRaise;
  return desired;
}

function potFraction(pot: bigint, num: bigint, den: bigint): bigint {
  return (pot * num) / den;
}

// ---------------------------------------------------------------------------
// TAG strategy
// ---------------------------------------------------------------------------

export class TagStrategy implements Strategy {
  readonly name = "tag";

  decide(state: GameState): BotAction {
    if (state.street === "preflop") {
      return this.preflop(state);
    }
    return this.postflop(state);
  }

  // ---- Preflop ----

  private preflop(state: GameState): BotAction {
    // Without hole cards, fall back to calling station behavior
    if (!state.holeCards) {
      return state.toCall === 0n ? { action: "check" } : { action: "call" };
    }

    const tier = preflopTier(state.holeCards[0], state.holeCards[1]);
    const facingBet = state.toCall > 0n;

    switch (tier) {
      case "premium":
        if (facingBet) {
          // Re-raise 3x the current bet
          const raiseAmt = clampBet(state.betTo * 3n, state.minRaise, state.myStack + state.myStreetCommit);
          return { action: "raise", amount: raiseAmt };
        } else {
          // Open raise 3x BB
          const bb = state.bigBlind > 0n ? state.bigBlind : state.minRaise;
          const openAmt = clampBet(bb * 3n, state.minRaise, state.myStack + state.myStreetCommit);
          return { action: "raise", amount: openAmt };
        }

      case "strong":
        if (facingBet) {
          // Call a raise, re-raise a small bet
          if (state.toCall <= potFraction(state.pot, 1n, 3n)) {
            const raiseAmt = clampBet(state.betTo * 3n, state.minRaise, state.myStack + state.myStreetCommit);
            return { action: "raise", amount: raiseAmt };
          }
          return { action: "call" };
        } else {
          // Open raise 2.5x BB
          const bb = state.bigBlind > 0n ? state.bigBlind : state.minRaise;
          const openAmt = clampBet(bb * 5n / 2n, state.minRaise, state.myStack + state.myStreetCommit);
          return { action: "raise", amount: openAmt };
        }

      case "playable":
        if (facingBet) {
          // Call if in position, fold from early position facing a raise
          if (state.position === "early" && state.toCall > potFraction(state.pot, 1n, 4n)) {
            return { action: "fold" };
          }
          return { action: "call" };
        } else {
          // Open raise from middle/late, check from blinds
          if (state.position === "blinds") return { action: "check" };
          const bb = state.bigBlind > 0n ? state.bigBlind : state.minRaise;
          const openAmt = clampBet(bb * 5n / 2n, state.minRaise, state.myStack + state.myStreetCommit);
          return { action: "raise", amount: openAmt };
        }

      case "marginal":
        if (facingBet) {
          // Only call in late position with small bets
          if (state.position === "late" && state.toCall <= potFraction(state.pot, 1n, 5n)) {
            return { action: "call" };
          }
          return { action: "fold" };
        } else {
          return { action: "check" };
        }

      case "trash":
      default:
        if (facingBet) return { action: "fold" };
        return { action: "check" };
    }
  }

  // ---- Postflop ----

  private postflop(state: GameState): BotAction {
    if (!state.holeCards) {
      // Can't evaluate without hole cards — check/fold
      return state.toCall === 0n ? { action: "check" } : { action: "fold" };
    }

    const strength = categorizePostflop(state.holeCards, state.board);
    const facingBet = state.toCall > 0n;

    switch (strength) {
      case "monster": {
        if (facingBet) {
          // Raise 2.5x the current bet
          const raiseAmt = clampBet(
            state.betTo * 5n / 2n,
            state.minRaise,
            state.myStack + state.myStreetCommit
          );
          return { action: "raise", amount: raiseAmt };
        }
        // Bet 2/3 pot
        const betAmt = clampBet(
          potFraction(state.pot, 2n, 3n),
          state.minRaise,
          state.myStack + state.myStreetCommit
        );
        if (betAmt === 0n) return { action: "check" };
        return { action: "bet", amount: betAmt };
      }

      case "strong": {
        if (facingBet) {
          return { action: "call" };
        }
        // Bet 1/2 pot
        const betAmt = clampBet(
          potFraction(state.pot, 1n, 2n),
          state.minRaise,
          state.myStack + state.myStreetCommit
        );
        if (betAmt === 0n) return { action: "check" };
        return { action: "bet", amount: betAmt };
      }

      case "medium": {
        if (facingBet) {
          // Call small bets (≤ 1/3 pot), fold large ones
          if (state.toCall <= potFraction(state.pot, 1n, 3n)) {
            return { action: "call" };
          }
          return { action: "fold" };
        }
        return { action: "check" };
      }

      case "draw": {
        if (facingBet) {
          // Call if pot odds justify (need ~4:1 for gutshot, ~2:1 for OESD/flush)
          // Simplified: call bets up to 40% pot
          if (state.toCall <= potFraction(state.pot, 2n, 5n)) {
            return { action: "call" };
          }
          return { action: "fold" };
        }
        // Semi-bluff ~30% of the time (use a deterministic check based on pot size)
        if (state.pot % 3n === 0n) {
          const betAmt = clampBet(
            potFraction(state.pot, 1n, 2n),
            state.minRaise,
            state.myStack + state.myStreetCommit
          );
          if (betAmt > 0n) return { action: "bet", amount: betAmt };
        }
        return { action: "check" };
      }

      case "weak":
      default:
        if (facingBet) return { action: "fold" };
        return { action: "check" };
    }
  }
}

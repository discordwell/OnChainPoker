import type { GameState, BotAction, Strategy } from "../strategy.js";
import { preflopTier } from "./preflopRanges.js";
import { categorizePostflop, clampBet, potFraction } from "./shared.js";

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

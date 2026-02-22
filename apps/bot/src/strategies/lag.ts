import type { GameState, BotAction, Strategy } from "../strategy.js";
import { preflopTier, type PreflopTier } from "./preflopRanges.js";
import { categorizePostflop, clampBet, potFraction } from "./shared.js";

// ---------------------------------------------------------------------------
// LAG (Loose-Aggressive) strategy
//
// Opens wider (~35% of hands vs TAG's ~15%), raises more aggressively,
// bets draws harder, and bluffs with missed draws on the river.
// ---------------------------------------------------------------------------

/** LAG plays marginal hands as if they're playable. */
function lagPreflopTier(tier: PreflopTier): PreflopTier {
  if (tier === "marginal") return "playable";
  if (tier === "trash") return "marginal"; // upgrades some trash to marginal
  return tier;
}

export class LagStrategy implements Strategy {
  readonly name = "lag";

  decide(state: GameState): BotAction {
    if (state.street === "preflop") {
      return this.preflop(state);
    }
    return this.postflop(state);
  }

  // ---- Preflop ----

  private preflop(state: GameState): BotAction {
    if (!state.holeCards) {
      return state.toCall === 0n ? { action: "check" } : { action: "call" };
    }

    const rawTier = preflopTier(state.holeCards[0], state.holeCards[1]);
    const tier = lagPreflopTier(rawTier);
    const facingBet = state.toCall > 0n;
    const bb = state.bigBlind > 0n ? state.bigBlind : state.minRaise;

    switch (tier) {
      case "premium":
        if (facingBet) {
          // Re-raise 3.5x the current bet (bigger than TAG)
          const raiseAmt = clampBet(state.betTo * 7n / 2n, state.minRaise, state.myStack + state.myStreetCommit);
          return { action: "raise", amount: raiseAmt };
        } else {
          // Open raise 3.5x BB
          const openAmt = clampBet(bb * 7n / 2n, state.minRaise, state.myStack + state.myStreetCommit);
          return { action: "raise", amount: openAmt };
        }

      case "strong":
        if (facingBet) {
          // Always re-raise (LAG is aggressive)
          const raiseAmt = clampBet(state.betTo * 3n, state.minRaise, state.myStack + state.myStreetCommit);
          return { action: "raise", amount: raiseAmt };
        } else {
          // Open raise 3x BB
          const openAmt = clampBet(bb * 3n, state.minRaise, state.myStack + state.myStreetCommit);
          return { action: "raise", amount: openAmt };
        }

      case "playable":
        if (facingBet) {
          // Call raises, re-raise small bets aggressively
          if (state.toCall <= potFraction(state.pot, 1n, 4n)) {
            const raiseAmt = clampBet(state.betTo * 3n, state.minRaise, state.myStack + state.myStreetCommit);
            return { action: "raise", amount: raiseAmt };
          }
          return { action: "call" };
        } else {
          // Always open-raise (LAG doesn't limp)
          const openAmt = clampBet(bb * 5n / 2n, state.minRaise, state.myStack + state.myStreetCommit);
          return { action: "raise", amount: openAmt };
        }

      case "marginal":
        if (facingBet) {
          // Call in position, fold out of position to large bets
          if (state.position === "late" && state.toCall <= potFraction(state.pot, 1n, 3n)) {
            return { action: "call" };
          }
          if (state.position !== "early" && state.toCall <= potFraction(state.pot, 1n, 5n)) {
            return { action: "call" };
          }
          return { action: "fold" };
        } else {
          // Open-raise from middle/late position (wider than TAG)
          if (state.position === "early") return { action: "check" };
          const openAmt = clampBet(bb * 5n / 2n, state.minRaise, state.myStack + state.myStreetCommit);
          return { action: "raise", amount: openAmt };
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
      return state.toCall === 0n ? { action: "check" } : { action: "fold" };
    }

    const strength = categorizePostflop(state.holeCards, state.board);
    const facingBet = state.toCall > 0n;

    switch (strength) {
      case "monster": {
        if (facingBet) {
          // Raise 3x the current bet (bigger than TAG)
          const raiseAmt = clampBet(
            state.betTo * 3n,
            state.minRaise,
            state.myStack + state.myStreetCommit
          );
          return { action: "raise", amount: raiseAmt };
        }
        // Bet 75-80% pot
        const betAmt = clampBet(
          potFraction(state.pot, 4n, 5n),
          state.minRaise,
          state.myStack + state.myStreetCommit
        );
        if (betAmt === 0n) return { action: "check" };
        return { action: "bet", amount: betAmt };
      }

      case "strong": {
        if (facingBet) {
          // Raise (LAG doesn't just call with strong hands)
          const raiseAmt = clampBet(
            state.betTo * 5n / 2n,
            state.minRaise,
            state.myStack + state.myStreetCommit
          );
          return { action: "raise", amount: raiseAmt };
        }
        // Bet 70% pot
        const betAmt = clampBet(
          potFraction(state.pot, 7n, 10n),
          state.minRaise,
          state.myStack + state.myStreetCommit
        );
        if (betAmt === 0n) return { action: "check" };
        return { action: "bet", amount: betAmt };
      }

      case "medium": {
        if (facingBet) {
          // Call bets up to 50% pot (more willing to call than TAG)
          if (state.toCall <= potFraction(state.pot, 1n, 2n)) {
            return { action: "call" };
          }
          return { action: "fold" };
        }
        // Bet 50% pot as a probe bet
        const betAmt = clampBet(
          potFraction(state.pot, 1n, 2n),
          state.minRaise,
          state.myStack + state.myStreetCommit
        );
        if (betAmt === 0n) return { action: "check" };
        return { action: "bet", amount: betAmt };
      }

      case "draw": {
        // On the river, draws are dead — treat as a bluff candidate
        if (state.street === "river") {
          if (facingBet) return { action: "fold" };
          // Bluff ~30% of the time with missed draws
          if (state.pot % 10n < 3n) {
            const betAmt = clampBet(
              potFraction(state.pot, 3n, 4n),
              state.minRaise,
              state.myStack + state.myStreetCommit
            );
            if (betAmt > 0n) return { action: "bet", amount: betAmt };
          }
          return { action: "check" };
        }

        if (facingBet) {
          // Semi-bluff raise ~40% of the time, otherwise call
          if (state.pot % 5n < 2n) {
            const raiseAmt = clampBet(
              state.betTo * 5n / 2n,
              state.minRaise,
              state.myStack + state.myStreetCommit
            );
            return { action: "raise", amount: raiseAmt };
          }
          if (state.toCall <= potFraction(state.pot, 1n, 2n)) {
            return { action: "call" };
          }
          return { action: "fold" };
        }
        // Semi-bluff bet 70% pot
        const betAmt = clampBet(
          potFraction(state.pot, 7n, 10n),
          state.minRaise,
          state.myStack + state.myStreetCommit
        );
        if (betAmt > 0n) return { action: "bet", amount: betAmt };
        return { action: "check" };
      }

      case "weak":
      default:
        if (facingBet) return { action: "fold" };
        return { action: "check" };
    }
  }
}

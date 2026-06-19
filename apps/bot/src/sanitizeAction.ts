import type { BotAction } from "./strategy.js";

export interface SanitizeContext {
  /** Maximum street commitment the seat can reach: myStack + myStreetCommit. */
  allIn: bigint;
  /** Current street bet-to total the seat is facing. */
  betTo: bigint;
  /** Amount still owed to call: max(betTo - myStreetCommit, 0). */
  toCall: bigint;
  /** Smallest legal raise-to total: betTo + minRaiseSize. */
  minRaise: bigint;
}

/**
 * Coerce a strategy's intended action into one the chain will accept.
 *
 * The chain interprets a bet/raise `amount` as a raise-**to** total (the target
 * street commitment) and rejects any raise whose total does not strictly exceed
 * the current `betTo`. Two adjustments are needed before broadcasting:
 *
 *  1. Cap a bet/raise to the seat's all-in total (can't wager chips it lacks).
 *  2. If the seat is too short-stacked to clear `betTo` at all (its entire
 *     all-in total is <= betTo), it cannot legally raise — downgrade to a call
 *     (the chain caps the call to the remaining stack, putting the seat all-in
 *     for less) or a check when nothing is owed. Otherwise, an all-in below the
 *     minimum raise is permitted by the chain, so a short raise is floored to
 *     the all-in total rather than rejected.
 */
export function sanitizeAction(
  decision: BotAction,
  ctx: SanitizeContext
): { action: BotAction["action"]; amount: bigint } {
  let action = decision.action;
  let amount = decision.amount ?? 0n;
  const { allIn, betTo, toCall, minRaise } = ctx;

  if ((action === "bet" || action === "raise") && amount > allIn) {
    amount = allIn;
  }

  if ((action === "bet" || action === "raise") && allIn <= betTo) {
    action = toCall > 0n ? "call" : "check";
    amount = 0n;
  } else if (action === "raise" && amount < minRaise) {
    amount = allIn >= minRaise ? minRaise : allIn;
  }

  return { action, amount };
}

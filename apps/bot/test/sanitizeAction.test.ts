import { describe, it, expect } from "vitest";
import { sanitizeAction, type SanitizeContext } from "../src/sanitizeAction.js";
import type { BotAction } from "../src/strategy.js";

// Default context: deep-stacked, facing a 100 bet, min-raise to 200.
function ctx(overrides: Partial<SanitizeContext> = {}): SanitizeContext {
  return {
    allIn: 10000n,
    betTo: 100n,
    toCall: 100n,
    minRaise: 200n,
    ...overrides,
  };
}

describe("sanitizeAction", () => {
  it("passes through a legal full raise unchanged", () => {
    const out = sanitizeAction({ action: "raise", amount: 300n }, ctx());
    expect(out).toEqual({ action: "raise", amount: 300n });
  });

  it("caps a bet/raise to the all-in total", () => {
    const out = sanitizeAction({ action: "raise", amount: 99999n }, ctx({ allIn: 500n }));
    // 500 > betTo(100) so it stays a (full) raise, floored within reach.
    expect(out.action).toBe("raise");
    expect(out.amount).toBe(500n);
  });

  it("floors a short raise-to to all-in when below the min raise (legal all-in under-raise)", () => {
    // all-in 150 exceeds betTo 100 (a legal raise) but is below minRaise 200.
    const out = sanitizeAction({ action: "raise", amount: 150n }, ctx({ allIn: 150n }));
    expect(out).toEqual({ action: "raise", amount: 150n });
  });

  // --- The bug this fix addresses ---

  it("downgrades a raise to a call when the all-in total cannot clear betTo", () => {
    // Short stack: all-in total 10 <= betTo 50. A "raise" of 10 would be a
    // sub-betTo raise the chain rejects ("BetTo must exceed current betTo").
    const out = sanitizeAction({ action: "raise", amount: 10n }, ctx({ allIn: 10n, betTo: 50n, toCall: 50n, minRaise: 52n }));
    expect(out).toEqual({ action: "call", amount: 0n });
  });

  it("downgrades a raise to a call when all-in exactly equals betTo (not a strict increase)", () => {
    const out = sanitizeAction({ action: "raise", amount: 50n }, ctx({ allIn: 50n, betTo: 50n, toCall: 50n, minRaise: 52n }));
    expect(out).toEqual({ action: "call", amount: 0n });
  });

  it("downgrades an unaffordable bet to a check when nothing is owed", () => {
    // No live wager to clear (betTo 0 is degenerate but defensive): nothing owed.
    const out = sanitizeAction({ action: "bet", amount: 0n }, ctx({ allIn: 0n, betTo: 0n, toCall: 0n, minRaise: 0n }));
    expect(out).toEqual({ action: "check", amount: 0n });
  });

  it("reproduces the original AA-short-stack scenario as a legal call", () => {
    // Bot holds a premium hand, strategy returns raise(allIn=10) facing betTo=50.
    const decision: BotAction = { action: "raise", amount: 10n };
    const out = sanitizeAction(decision, { allIn: 10n, betTo: 50n, toCall: 50n, minRaise: 52n });
    expect(out.action).toBe("call");
    expect(out.amount).toBe(0n);
    // The resulting raise-to (0/call) never violates desiredCommit > betTo,
    // because a call is capped to remaining stack by the chain.
  });

  it("leaves call/check/fold actions untouched", () => {
    expect(sanitizeAction({ action: "call" }, ctx())).toEqual({ action: "call", amount: 0n });
    expect(sanitizeAction({ action: "check" }, ctx({ toCall: 0n }))).toEqual({ action: "check", amount: 0n });
    expect(sanitizeAction({ action: "fold" }, ctx())).toEqual({ action: "fold", amount: 0n });
  });
});

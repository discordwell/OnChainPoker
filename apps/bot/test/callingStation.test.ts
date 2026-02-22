import { describe, it, expect } from "vitest";
import { CallingStation } from "../src/strategies/callingStation.js";
import type { GameState } from "../src/strategy.js";

function baseState(overrides: Partial<GameState> = {}): GameState {
  return {
    street: "preflop",
    holeCards: null,
    board: [],
    myStack: 10000n,
    pot: 150n,
    betTo: 100n,
    myStreetCommit: 0n,
    toCall: 100n,
    minRaise: 200n,
    bigBlind: 100n,
    position: "late",
    playersInHand: 3,
    isLastToAct: false,
    ...overrides,
  };
}

describe("CallingStation", () => {
  const strategy = new CallingStation();

  it("has the correct name", () => {
    expect(strategy.name).toBe("calling-station");
  });

  it("checks when there is nothing to call", () => {
    const state = baseState({ toCall: 0n, betTo: 0n });
    const result = strategy.decide(state);
    expect(result.action).toBe("check");
  });

  it("calls when facing a bet", () => {
    const state = baseState({ toCall: 100n });
    const result = strategy.decide(state);
    expect(result.action).toBe("call");
  });

  it("calls regardless of bet size", () => {
    const state = baseState({ toCall: 5000n, betTo: 5000n });
    const result = strategy.decide(state);
    expect(result.action).toBe("call");
  });

  it("never folds", () => {
    // Test a variety of states — calling station should never fold
    const states = [
      baseState({ toCall: 1n }),
      baseState({ toCall: 10000n }),
      baseState({ street: "river", toCall: 500n }),
    ];
    for (const s of states) {
      expect(strategy.decide(s).action).not.toBe("fold");
    }
  });

  it("never bets or raises", () => {
    const states = [
      baseState({ toCall: 0n, betTo: 0n }),
      baseState({ toCall: 100n }),
    ];
    for (const s of states) {
      const result = strategy.decide(s);
      expect(result.action).not.toBe("bet");
      expect(result.action).not.toBe("raise");
    }
  });

  it("checks on every street when not facing a bet", () => {
    for (const street of ["preflop", "flop", "turn", "river"] as const) {
      const result = strategy.decide(baseState({ street, toCall: 0n, betTo: 0n }));
      expect(result.action).toBe("check");
    }
  });
});

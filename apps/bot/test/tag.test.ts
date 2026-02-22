import { describe, it, expect } from "vitest";
import { TagStrategy } from "../src/strategies/tag.js";
import { cardIdFromRankSuit } from "@onchainpoker/holdem-eval";
import type { GameState } from "../src/strategy.js";

// Suit constants: 0=clubs, 1=diamonds, 2=hearts, 3=spades
const Ac = cardIdFromRankSuit(14, 0); // Ace of clubs
const As = cardIdFromRankSuit(14, 3); // Ace of spades
const Kh = cardIdFromRankSuit(13, 2); // King of hearts
const Ks = cardIdFromRankSuit(13, 3); // King of spades
const Qh = cardIdFromRankSuit(12, 2);
const Jc = cardIdFromRankSuit(11, 0);
const Td = cardIdFromRankSuit(10, 1);
const _9h = cardIdFromRankSuit(9, 2);
const _7c = cardIdFromRankSuit(7, 0);
const _2c = cardIdFromRankSuit(2, 0);
const _2d = cardIdFromRankSuit(2, 1);
const _3c = cardIdFromRankSuit(3, 0);
const _4h = cardIdFromRankSuit(4, 2);
const _5s = cardIdFromRankSuit(5, 3);

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
    playersInHand: 4,
    isLastToAct: false,
    ...overrides,
  };
}

describe("TagStrategy", () => {
  const tag = new TagStrategy();

  it("has the correct name", () => {
    expect(tag.name).toBe("tag");
  });

  describe("preflop — premium hands", () => {
    it("raises with AA when no bet facing", () => {
      const state = baseState({ holeCards: [Ac, As], toCall: 0n, betTo: 0n });
      const result = tag.decide(state);
      expect(result.action).toBe("raise");
      expect(result.amount).toBeGreaterThan(0n);
    });

    it("re-raises with AA when facing a bet", () => {
      const state = baseState({ holeCards: [Ac, As], toCall: 100n, betTo: 100n });
      const result = tag.decide(state);
      expect(result.action).toBe("raise");
    });

    it("raises with KK", () => {
      const state = baseState({ holeCards: [Kh, Ks], toCall: 0n, betTo: 0n });
      const result = tag.decide(state);
      expect(result.action).toBe("raise");
    });
  });

  describe("preflop — strong hands", () => {
    it("raises with AKo when unopened", () => {
      const state = baseState({
        holeCards: [As, Kh],  // AKo — strong tier
        toCall: 0n,
        betTo: 0n,
      });
      const result = tag.decide(state);
      expect(result.action).toBe("raise");
    });

    it("calls a large raise with JJ", () => {
      const state = baseState({
        holeCards: [Jc, cardIdFromRankSuit(11, 3)], // JJ
        toCall: 500n,
        betTo: 500n,
        pot: 600n,
      });
      const result = tag.decide(state);
      expect(result.action).toBe("call");
    });
  });

  describe("preflop — trash hands", () => {
    it("folds trash when facing a bet", () => {
      const state = baseState({
        holeCards: [_2c, cardIdFromRankSuit(7, 1)], // 72o — different suits
        toCall: 100n,
      });
      const result = tag.decide(state);
      expect(result.action).toBe("fold");
    });

    it("checks trash when no bet facing", () => {
      const state = baseState({
        holeCards: [_2c, cardIdFromRankSuit(7, 1)], // 72o
        toCall: 0n,
        betTo: 0n,
      });
      const result = tag.decide(state);
      expect(result.action).toBe("check");
    });
  });

  describe("preflop — marginal hands", () => {
    it("folds marginal from early position facing a raise", () => {
      const state = baseState({
        holeCards: [cardIdFromRankSuit(5, 0), cardIdFromRankSuit(5, 2)], // 55
        toCall: 300n,
        betTo: 300n,
        pot: 450n,
        position: "early",
      });
      const result = tag.decide(state);
      expect(result.action).toBe("fold");
    });
  });

  describe("preflop — no hole cards fallback", () => {
    it("checks without hole cards when no bet facing", () => {
      const state = baseState({ holeCards: null, toCall: 0n, betTo: 0n });
      const result = tag.decide(state);
      expect(result.action).toBe("check");
    });

    it("calls without hole cards when facing a bet", () => {
      const state = baseState({ holeCards: null, toCall: 100n });
      const result = tag.decide(state);
      expect(result.action).toBe("call");
    });
  });

  describe("postflop — hand strength", () => {
    it("bets with monster (two pair or better)", () => {
      // Board: Ac Kh 7c, Hole: Ac Kh → two pair AA+KK
      const state = baseState({
        street: "flop",
        holeCards: [Ac, Kh],
        board: [cardIdFromRankSuit(14, 1), cardIdFromRankSuit(13, 0), _7c], // Ad Kc 7c
        toCall: 0n,
        betTo: 0n,
        pot: 300n,
      });
      const result = tag.decide(state);
      expect(result.action).toBe("bet");
      expect(result.amount).toBeGreaterThan(0n);
    });

    it("raises monster when facing a bet", () => {
      const state = baseState({
        street: "flop",
        holeCards: [Ac, Kh],
        board: [cardIdFromRankSuit(14, 1), cardIdFromRankSuit(13, 0), _7c],
        toCall: 100n,
        betTo: 100n,
        pot: 400n,
      });
      const result = tag.decide(state);
      expect(result.action).toBe("raise");
    });

    it("folds weak hand facing a bet postflop", () => {
      // Board: Kh Qh Jc, Hole: 2c 3c → no pair, no draw
      const state = baseState({
        street: "flop",
        holeCards: [_2c, _3c],
        board: [Kh, Qh, Jc],
        toCall: 200n,
        betTo: 200n,
        pot: 500n,
      });
      const result = tag.decide(state);
      expect(result.action).toBe("fold");
    });

    it("checks weak hand when not facing a bet", () => {
      const state = baseState({
        street: "flop",
        holeCards: [_2c, _3c],
        board: [Kh, Qh, Jc],
        toCall: 0n,
        betTo: 0n,
        pot: 300n,
      });
      const result = tag.decide(state);
      expect(result.action).toBe("check");
    });

    it("calls or bets with strong hand (top pair, good kicker)", () => {
      // Board: Ac 7c 3c, Hole: As Kh → top pair, K kicker
      const state = baseState({
        street: "flop",
        holeCards: [As, Kh],
        board: [Ac, _7c, _3c],
        toCall: 0n,
        betTo: 0n,
        pot: 300n,
      });
      const result = tag.decide(state);
      // Should bet with strong hand
      expect(["bet", "check"]).toContain(result.action);
      if (result.action === "bet") {
        expect(result.amount).toBeGreaterThan(0n);
      }
    });
  });

  describe("postflop — no hole cards", () => {
    it("checks without hole cards and no bet", () => {
      const state = baseState({
        street: "flop",
        holeCards: null,
        board: [Kh, Qh, Jc],
        toCall: 0n,
        betTo: 0n,
      });
      const result = tag.decide(state);
      expect(result.action).toBe("check");
    });

    it("folds without hole cards when facing a bet", () => {
      const state = baseState({
        street: "flop",
        holeCards: null,
        board: [Kh, Qh, Jc],
        toCall: 200n,
      });
      const result = tag.decide(state);
      expect(result.action).toBe("fold");
    });
  });
});

import { describe, it, expect } from "vitest";
import { LagStrategy } from "../src/strategies/lag.js";
import { cardIdFromRankSuit } from "@onchainpoker/holdem-eval";
import type { GameState } from "../src/strategy.js";

// Suit constants: 0=clubs, 1=diamonds, 2=hearts, 3=spades
const Ac = cardIdFromRankSuit(14, 0);
const As = cardIdFromRankSuit(14, 3);
const Kh = cardIdFromRankSuit(13, 2);
const Ks = cardIdFromRankSuit(13, 3);
const Qh = cardIdFromRankSuit(12, 2);
const Jc = cardIdFromRankSuit(11, 0);
const Js = cardIdFromRankSuit(11, 3);
const Td = cardIdFromRankSuit(10, 1);
const _9h = cardIdFromRankSuit(9, 2);
const _8c = cardIdFromRankSuit(8, 0);
const _7c = cardIdFromRankSuit(7, 0);
const _7d = cardIdFromRankSuit(7, 1);
const _6h = cardIdFromRankSuit(6, 2);
const _5s = cardIdFromRankSuit(5, 3);
const _5c = cardIdFromRankSuit(5, 0);
const _4h = cardIdFromRankSuit(4, 2);
const _3c = cardIdFromRankSuit(3, 0);
const _2c = cardIdFromRankSuit(2, 0);
const _2d = cardIdFromRankSuit(2, 1);

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

describe("LagStrategy", () => {
  const lag = new LagStrategy();

  it("has the correct name", () => {
    expect(lag.name).toBe("lag");
  });

  describe("preflop — wider range than TAG", () => {
    it("raises with premium hands (AA)", () => {
      const state = baseState({ holeCards: [Ac, As], toCall: 0n, betTo: 0n });
      const result = lag.decide(state);
      expect(result.action).toBe("raise");
      expect(result.amount).toBeGreaterThan(0n);
    });

    it("re-raises with premium hands facing a bet", () => {
      const state = baseState({ holeCards: [Ac, As], toCall: 100n, betTo: 100n });
      const result = lag.decide(state);
      expect(result.action).toBe("raise");
    });

    it("raises with strong hands (always re-raises, not just calls)", () => {
      const state = baseState({
        holeCards: [Jc, Js], // JJ — strong tier
        toCall: 100n,
        betTo: 100n,
        pot: 300n,
      });
      const result = lag.decide(state);
      // LAG always re-raises strong hands, unlike TAG which sometimes just calls
      expect(result.action).toBe("raise");
    });

    it("open-raises marginal hands from late position (wider range)", () => {
      // 55 is marginal in raw tiers but LAG upgrades it to playable
      const state = baseState({
        holeCards: [_5s, _5c], // 55 — marginal tier
        toCall: 0n,
        betTo: 0n,
        position: "late",
      });
      const result = lag.decide(state);
      // LAG plays marginal hands as playable → open-raises from late
      expect(result.action).toBe("raise");
    });

    it("open-raises marginal hands from middle position", () => {
      // K9s — marginal in standard, upgraded by LAG
      const state = baseState({
        holeCards: [cardIdFromRankSuit(13, 0), cardIdFromRankSuit(9, 0)], // K9s
        toCall: 0n,
        betTo: 0n,
        position: "middle",
      });
      const result = lag.decide(state);
      expect(result.action).toBe("raise");
    });

    it("folds true trash when facing a bet", () => {
      const state = baseState({
        holeCards: [_2c, _7d], // 72o — trash even for LAG
        toCall: 100n,
      });
      const result = lag.decide(state);
      expect(result.action).toBe("fold");
    });
  });

  describe("postflop — aggressive betting", () => {
    it("bets larger with monster (80% pot vs TAG's 66%)", () => {
      // Two pair on flop
      const state = baseState({
        street: "flop",
        holeCards: [Ac, Kh],
        board: [cardIdFromRankSuit(14, 1), cardIdFromRankSuit(13, 0), _7c],
        toCall: 0n,
        betTo: 0n,
        pot: 1000n,
      });
      const result = lag.decide(state);
      expect(result.action).toBe("bet");
      // LAG bets 80% pot = 800, TAG bets 66% = 660
      expect(result.amount!).toBeGreaterThanOrEqual(750n);
    });

    it("raises strong hands instead of just calling", () => {
      // Top pair good kicker facing a bet
      const state = baseState({
        street: "flop",
        holeCards: [As, Kh],
        board: [Ac, _7c, _3c],
        toCall: 200n,
        betTo: 200n,
        pot: 600n,
      });
      const result = lag.decide(state);
      // LAG raises strong hands, TAG just calls
      expect(result.action).toBe("raise");
    });

    it("semi-bluffs draws aggressively (bets when not facing action)", () => {
      // Flush draw on flop
      const state = baseState({
        street: "flop",
        holeCards: [cardIdFromRankSuit(14, 2), cardIdFromRankSuit(10, 2)], // AhTh
        board: [
          cardIdFromRankSuit(8, 2),  // 8h
          cardIdFromRankSuit(5, 2),  // 5h
          cardIdFromRankSuit(3, 0),  // 3c
        ],
        toCall: 0n,
        betTo: 0n,
        pot: 400n,
      });
      const result = lag.decide(state);
      // LAG always bets draws when not facing action
      expect(result.action).toBe("bet");
      expect(result.amount!).toBeGreaterThan(0n);
    });

    it("bets medium hands (probe bet) unlike TAG which checks", () => {
      // Middle pair, no draw
      const state = baseState({
        street: "flop",
        holeCards: [_7c, _8c],
        board: [cardIdFromRankSuit(13, 2), cardIdFromRankSuit(7, 1), _3c], // Kh 7d 3c
        toCall: 0n,
        betTo: 0n,
        pot: 300n,
      });
      const result = lag.decide(state);
      // LAG bets medium hands as probe, TAG checks
      expect(result.action).toBe("bet");
    });
  });

  describe("river bluffing — missed draws", () => {
    it("sometimes bluffs with missed flush draw on river", () => {
      // Had flush draw that missed
      // Board through turn: 8h 5h 3c Kd
      // River: 2c (no flush)
      // Hole: AhTh (missed flush draw)
      const turnBoard = [
        cardIdFromRankSuit(8, 2),   // 8h
        cardIdFromRankSuit(5, 2),   // 5h
        cardIdFromRankSuit(3, 0),   // 3c
        cardIdFromRankSuit(13, 1),  // Kd
      ];
      const riverBoard = [...turnBoard, cardIdFromRankSuit(2, 0)]; // 2c

      // Test multiple pot sizes to hit the ~30% bluff frequency
      // Bluff condition: pot % 10n < 3n → values ending in 0,1,2 bluff
      let bluffCount = 0;
      let checkCount = 0;
      for (let potVal = 100n; potVal <= 200n; potVal += 1n) {
        const state = baseState({
          street: "river",
          holeCards: [cardIdFromRankSuit(14, 2), cardIdFromRankSuit(10, 2)], // AhTh
          board: riverBoard,
          toCall: 0n,
          betTo: 0n,
          pot: potVal,
        });
        const result = lag.decide(state);
        if (result.action === "bet") bluffCount++;
        else checkCount++;
      }
      // Should bluff roughly 30% of the time
      expect(bluffCount).toBeGreaterThan(0);
      expect(checkCount).toBeGreaterThan(0);
      // Bluff ratio should be around 20-40%
      const ratio = bluffCount / (bluffCount + checkCount);
      expect(ratio).toBeGreaterThanOrEqual(0.2);
      expect(ratio).toBeLessThanOrEqual(0.4);
    });
  });

  describe("no hole cards fallback", () => {
    it("checks without hole cards when no bet facing", () => {
      const state = baseState({ holeCards: null, toCall: 0n, betTo: 0n });
      const result = lag.decide(state);
      expect(result.action).toBe("check");
    });

    it("calls without hole cards when facing a bet", () => {
      const state = baseState({ holeCards: null, toCall: 100n });
      const result = lag.decide(state);
      expect(result.action).toBe("call");
    });

    it("folds postflop without hole cards when facing a bet", () => {
      const state = baseState({
        street: "flop",
        holeCards: null,
        board: [Kh, Qh, Jc],
        toCall: 200n,
      });
      const result = lag.decide(state);
      expect(result.action).toBe("fold");
    });
  });
});

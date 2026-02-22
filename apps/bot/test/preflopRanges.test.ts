import { describe, it, expect } from "vitest";
import { preflopTier, type PreflopTier } from "../src/strategies/preflopRanges.js";
import { cardIdFromRankSuit, type Rank, type Suit } from "@onchainpoker/holdem-eval";

function card(rank: Rank, suit: Suit) {
  return cardIdFromRankSuit(rank, suit);
}

describe("preflopRanges", () => {
  describe("premium hands", () => {
    it("classifies AA as premium", () => {
      expect(preflopTier(card(14, 0), card(14, 3))).toBe("premium");
    });

    it("classifies KK as premium", () => {
      expect(preflopTier(card(13, 0), card(13, 2))).toBe("premium");
    });

    it("classifies QQ as premium", () => {
      expect(preflopTier(card(12, 1), card(12, 3))).toBe("premium");
    });

    it("classifies AKs as premium", () => {
      // Same suit → suited
      expect(preflopTier(card(14, 0), card(13, 0))).toBe("premium");
    });

    it("does NOT classify AKo as premium", () => {
      // Different suits → offsuit
      expect(preflopTier(card(14, 0), card(13, 2))).not.toBe("premium");
    });
  });

  describe("strong hands", () => {
    it("classifies JJ as strong", () => {
      expect(preflopTier(card(11, 0), card(11, 3))).toBe("strong");
    });

    it("classifies TT as strong", () => {
      expect(preflopTier(card(10, 1), card(10, 2))).toBe("strong");
    });

    it("classifies AKo as strong", () => {
      expect(preflopTier(card(14, 0), card(13, 2))).toBe("strong");
    });

    it("classifies AQs as strong", () => {
      expect(preflopTier(card(14, 1), card(12, 1))).toBe("strong");
    });

    it("classifies AJs as strong", () => {
      expect(preflopTier(card(14, 2), card(11, 2))).toBe("strong");
    });

    it("classifies KQs as strong", () => {
      expect(preflopTier(card(13, 3), card(12, 3))).toBe("strong");
    });
  });

  describe("playable hands", () => {
    it("classifies 99 as playable", () => {
      expect(preflopTier(card(9, 0), card(9, 1))).toBe("playable");
    });

    it("classifies 66 as playable", () => {
      expect(preflopTier(card(6, 2), card(6, 3))).toBe("playable");
    });

    it("classifies ATs as playable", () => {
      expect(preflopTier(card(14, 0), card(10, 0))).toBe("playable");
    });

    it("classifies JTs as playable", () => {
      expect(preflopTier(card(11, 2), card(10, 2))).toBe("playable");
    });

    it("classifies AQo as playable", () => {
      expect(preflopTier(card(14, 0), card(12, 2))).toBe("playable");
    });

    it("classifies 87s as playable", () => {
      expect(preflopTier(card(8, 1), card(7, 1))).toBe("playable");
    });
  });

  describe("marginal hands", () => {
    it("classifies 55 as marginal", () => {
      expect(preflopTier(card(5, 0), card(5, 3))).toBe("marginal");
    });

    it("classifies 22 as marginal", () => {
      expect(preflopTier(card(2, 0), card(2, 1))).toBe("marginal");
    });

    it("classifies A9s as marginal", () => {
      expect(preflopTier(card(14, 3), card(9, 3))).toBe("marginal");
    });

    it("classifies KQo as marginal", () => {
      expect(preflopTier(card(13, 0), card(12, 2))).toBe("marginal");
    });

    it("classifies 54s as marginal", () => {
      expect(preflopTier(card(5, 0), card(4, 0))).toBe("marginal");
    });
  });

  describe("trash hands", () => {
    it("classifies 72o as trash", () => {
      expect(preflopTier(card(7, 0), card(2, 1))).toBe("trash");
    });

    it("classifies 93o as trash", () => {
      expect(preflopTier(card(9, 0), card(3, 2))).toBe("trash");
    });

    it("classifies 84o as trash", () => {
      expect(preflopTier(card(8, 1), card(4, 3))).toBe("trash");
    });
  });

  describe("order independence", () => {
    it("returns the same tier regardless of card order", () => {
      const c1 = card(14, 0);
      const c2 = card(13, 0);
      expect(preflopTier(c1, c2)).toBe(preflopTier(c2, c1));
    });

    it("pocket pairs are order-independent", () => {
      const c1 = card(10, 0);
      const c2 = card(10, 3);
      expect(preflopTier(c1, c2)).toBe(preflopTier(c2, c1));
    });
  });

  describe("suited vs offsuit distinction", () => {
    it("AKs is premium but AKo is strong", () => {
      expect(preflopTier(card(14, 0), card(13, 0))).toBe("premium");
      expect(preflopTier(card(14, 0), card(13, 2))).toBe("strong");
    });

    it("KQs is strong but KQo is marginal", () => {
      expect(preflopTier(card(13, 0), card(12, 0))).toBe("strong");
      expect(preflopTier(card(13, 0), card(12, 2))).toBe("marginal");
    });
  });

  describe("169-combo coverage", () => {
    it("every possible hand gets a valid tier", () => {
      const validTiers: Set<string> = new Set(["premium", "strong", "playable", "marginal", "trash"]);
      for (let i = 0; i < 52; i++) {
        for (let j = i + 1; j < 52; j++) {
          const tier = preflopTier(i, j);
          expect(validTiers.has(tier)).toBe(true);
        }
      }
    });
  });
});

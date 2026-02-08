import { describe, expect, test } from "vitest";
import { Hand } from "pokersolver";

import { HandCategory, cardFromString, compareHandRank, evaluate7, winners } from "../src/index.js";

function cs(s: string): number[] {
  return s
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(cardFromString);
}

function prng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    // mulberry32
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rand: () => number): void {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}

describe("evaluate7 known-answer", () => {
  test("straight flush (broadway)", () => {
    const r = evaluate7(cs("As Ks Qs Js Ts 2d 3c"));
    expect(r.category).toBe(HandCategory.StraightFlush);
    expect(r.tiebreakers).toEqual([14]);
  });

  test("wheel straight", () => {
    const r = evaluate7(cs("As 2d 3c 4h 5s Kd Qh"));
    expect(r.category).toBe(HandCategory.Straight);
    expect(r.tiebreakers).toEqual([5]);
  });

  test("quads", () => {
    const r = evaluate7(cs("As Ad Ah Ac 2s 3d 4c"));
    expect(r.category).toBe(HandCategory.Quads);
    expect(r.tiebreakers).toEqual([14, 4]);
  });

  test("full house", () => {
    const r = evaluate7(cs("Ks Kd Kh 2c 2d 3h 4s"));
    expect(r.category).toBe(HandCategory.FullHouse);
    expect(r.tiebreakers).toEqual([13, 2]);
  });

  test("flush beats straight", () => {
    const flush = evaluate7(cs("As Qs 9s 4s 2s Kd 3c"));
    const straight = evaluate7(cs("As Kd Qh Js Tc 2d 3c"));
    expect(compareHandRank(flush, straight)).toBe(1);
  });

  test("two pair tiebreakers", () => {
    const a = evaluate7(cs("As Ad Ks Kd Qc 2d 3c")); // A,K,Q
    const b = evaluate7(cs("As Ad Ks Kd Jc 2d 3c")); // A,K,J
    expect(a.category).toBe(HandCategory.TwoPair);
    expect(b.category).toBe(HandCategory.TwoPair);
    expect(compareHandRank(a, b)).toBe(1);
  });
});

describe("winners()", () => {
  test("ties on board", () => {
    const board = cs("As Ks Qs Js Ts");
    const w = winners(board, {
      0: [cardFromString("2c"), cardFromString("3d")],
      5: [cardFromString("Ah"), cardFromString("Ad")]
    });
    expect(w).toEqual([0, 5]);
  });

  test("straight high wins", () => {
    const board = cs("2c 3d 4h 5s 9c");
    const w = winners(board, {
      0: [cardFromString("6d"), cardFromString("Kd")], // 6-high straight
      1: [cardFromString("Ad"), cardFromString("7d")] // 5-high straight
    });
    expect(w).toEqual([0]);
  });
});

describe("randomized cross-check vs pokersolver", () => {
  test("evaluate7 ordering matches reference (seeded)", () => {
    const rand = prng(0x51c0_ffee);
    const deck = Array.from({ length: 52 }, (_, i) => i);

    for (let iter = 0; iter < 250; iter += 1) {
      shuffle(deck, rand);
      const cards7a = deck.slice(0, 7);
      const cards7b = deck.slice(7, 14);

      const oursA = evaluate7(cards7a);
      const oursB = evaluate7(cards7b);
      const oursCmp = compareHandRank(oursA, oursB);

      const refA = Hand.solve(cards7a.map((c) => {
        // pokersolver expects uppercase rank, lowercase suit (e.g. "As")
        const rankIndex = c % 13;
        const suitIndex = Math.floor(c / 13);
        const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
        const suits = ["c", "d", "h", "s"];
        return `${ranks[rankIndex]}${suits[suitIndex]}`;
      }));
      const refB = Hand.solve(cards7b.map((c) => {
        const rankIndex = c % 13;
        const suitIndex = Math.floor(c / 13);
        const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
        const suits = ["c", "d", "h", "s"];
        return `${ranks[rankIndex]}${suits[suitIndex]}`;
      }));

      const winnersHands = Hand.winners([refA, refB]);
      const refCmp = winnersHands.length === 2 ? 0 : winnersHands[0] === refA ? 1 : -1;

      expect(oursCmp).toBe(refCmp);
    }
  });

  test("winners() matches reference (seeded)", () => {
    const rand = prng(0x0bad_f00d);
    const deck = Array.from({ length: 52 }, (_, i) => i);

    for (let iter = 0; iter < 200; iter += 1) {
      shuffle(deck, rand);

      const board = deck.slice(0, 5);
      const seats = [0, 1, 2, 3];
      const holeBySeat: Record<number, [number, number]> = {};
      for (let i = 0; i < seats.length; i += 1) {
        const h = deck.slice(5 + i * 2, 5 + i * 2 + 2) as [number, number];
        holeBySeat[seats[i]!] = h;
      }

      const oursW = winners(board, holeBySeat);

      const refHands = seats.map((seat) => {
        const hole = holeBySeat[seat]!;
        const seven = [...board, hole[0], hole[1]];
        const cards = seven.map((c) => {
          const rankIndex = c % 13;
          const suitIndex = Math.floor(c / 13);
          const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
          const suits = ["c", "d", "h", "s"];
          return `${ranks[rankIndex]}${suits[suitIndex]}`;
        });
        return { seat, hand: Hand.solve(cards) };
      });

      const winnersHands = Hand.winners(refHands.map((h) => h.hand));
      const refW = refHands
        .filter((h) => winnersHands.includes(h.hand))
        .map((h) => h.seat)
        .sort((a, b) => a - b);

      expect(oursW).toEqual(refW);
    }
  });
});

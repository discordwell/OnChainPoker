import { describe, it, expect } from "vitest";
import { cardIdFromLabel } from "./CardFace";

// Mirror the chain's cards.Card.String() to generate letter-format labels for
// every card id, so we can prove the round-trip id -> label -> id.
const RANK_CH = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUIT_CH = ["c", "d", "h", "s"];
function chainLabel(id: number): string {
  return RANK_CH[id % 13]! + SUIT_CH[Math.floor(id / 13)]!;
}

describe("cardIdFromLabel", () => {
  it("parses the chain's letter format for known cards", () => {
    expect(cardIdFromLabel("2c")).toBe(0);
    expect(cardIdFromLabel("As")).toBe(51);
    expect(cardIdFromLabel("Tc")).toBe(8);
    expect(cardIdFromLabel("Kh")).toBe(37);
  });

  it("round-trips every chain card label back to its id", () => {
    for (let id = 0; id < 52; id++) {
      expect(cardIdFromLabel(chainLabel(id))).toBe(id);
    }
  });

  it("still accepts the internal glyph format", () => {
    expect(cardIdFromLabel("A♠")).toBe(51); // ace of spades
    expect(cardIdFromLabel("10♥")).toBe(34); // ten of hearts
  });

  it("returns null for malformed labels", () => {
    expect(cardIdFromLabel("")).toBeNull();
    expect(cardIdFromLabel("X")).toBeNull();
    expect(cardIdFromLabel("Zx")).toBeNull();
    expect(cardIdFromLabel("1z")).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import {
  CURVE_ORDER,
  mulBase,
  mulPoint,
  pointAdd,
  groupElementFromBytes,
  groupElementToBytes,
  scalarToBytes,
} from "@onchainpoker/ocp-crypto";
import {
  modQ,
  invMod,
  lagrangeCoefficients,
  decodeShareBytes,
  lookupCardId,
  decryptEncShare,
  recoverCard,
  CARD_TABLE,
} from "../src/components/holeCardCrypto";

// ---------------------------------------------------------------------------
// modQ
// ---------------------------------------------------------------------------
describe("modQ", () => {
  it("returns 0 for 0", () => {
    expect(modQ(0n)).toBe(0n);
  });

  it("wraps at CURVE_ORDER", () => {
    expect(modQ(CURVE_ORDER)).toBe(0n);
    expect(modQ(CURVE_ORDER + 1n)).toBe(1n);
  });

  it("wraps negative values", () => {
    expect(modQ(-1n)).toBe(CURVE_ORDER - 1n);
    expect(modQ(-CURVE_ORDER)).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// invMod
// ---------------------------------------------------------------------------
describe("invMod", () => {
  it("inverts 1 to 1", () => {
    expect(invMod(1n, CURVE_ORDER)).toBe(1n);
  });

  it("produces a valid inverse", () => {
    const a = 42n;
    const inv = invMod(a, CURVE_ORDER);
    expect(modQ(a * inv)).toBe(1n);
  });

  it("throws for zero", () => {
    expect(() => invMod(0n, CURVE_ORDER)).toThrow("cannot invert zero");
  });
});

// ---------------------------------------------------------------------------
// lagrangeCoefficients
// ---------------------------------------------------------------------------
describe("lagrangeCoefficients", () => {
  it("reconstructs 2-of-3 Shamir secret", () => {
    // f(x) = secret + a1*x  (degree 1, threshold 2)
    const secret = 12345n;
    const a1 = 67890n;
    const f = (x: bigint) => modQ(secret + modQ(a1 * x));

    // Evaluate at x=1,2,3
    const y1 = f(1n);
    const y2 = f(2n);
    const y3 = f(3n);

    // Reconstruct from shares at x=1,3 (any 2 of 3)
    const coeffs = lagrangeCoefficients([1n, 3n]);
    const recovered = modQ(coeffs[0]! * y1 + coeffs[1]! * y3);
    expect(recovered).toBe(secret);

    // Also test with x=2,3
    const coeffs2 = lagrangeCoefficients([2n, 3n]);
    const recovered2 = modQ(coeffs2[0]! * y2 + coeffs2[1]! * y3);
    expect(recovered2).toBe(secret);
  });

  it("throws for zero index", () => {
    expect(() => lagrangeCoefficients([0n, 1n])).toThrow("must be >= 1");
  });
});

// ---------------------------------------------------------------------------
// decodeShareBytes
// ---------------------------------------------------------------------------
describe("decodeShareBytes", () => {
  it("decodes 64-char hex string (32 bytes)", () => {
    const hex = "ab".repeat(32); // 64 hex chars
    const result = decodeShareBytes(hex);
    expect(result.length).toBe(32);
    expect(result[0]).toBe(0xab);
  });

  it("decodes 128-char hex string (64 bytes)", () => {
    const hex = "cd".repeat(64); // 128 hex chars
    const result = decodeShareBytes(hex);
    expect(result.length).toBe(64);
    expect(result[0]).toBe(0xcd);
  });

  it("decodes 0x-prefixed hex", () => {
    const hex = "0x" + "ef".repeat(32);
    const result = decodeShareBytes(hex);
    expect(result.length).toBe(32);
    expect(result[0]).toBe(0xef);
  });

  it("falls back to base64 for non-hex-length strings", () => {
    // 63 hex chars is not a valid hex-only path, but let's use a proper base64 string
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const b64 = btoa(String.fromCharCode(...bytes));
    const result = decodeShareBytes(b64);
    expect(result.length).toBe(4);
    expect(result[0]).toBe(1);
    expect(result[3]).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// lookupCardId
// ---------------------------------------------------------------------------
describe("lookupCardId", () => {
  it("card 0 → mulBase(1n)", () => {
    const pt = mulBase(1n);
    expect(lookupCardId(pt)).toBe(0);
  });

  it("card 51 → mulBase(52n)", () => {
    const pt = mulBase(52n);
    expect(lookupCardId(pt)).toBe(51);
  });

  it("CARD_TABLE has exactly 52 entries", () => {
    expect(CARD_TABLE.size).toBe(52);
  });

  it("invalid point → null", () => {
    // mulBase(53n) is not in the table
    const pt = mulBase(53n);
    expect(lookupCardId(pt)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// decryptEncShare
// ---------------------------------------------------------------------------
describe("decryptEncShare", () => {
  it("correctly decrypts a 64-byte enc share", () => {
    // Create a known enc share: U = r*G, V = d + r*pk
    const sk = 42n;
    const pk = mulBase(sk);
    const r = 7n;
    const d = mulBase(100n); // some known group element

    const U = mulBase(r);
    const V = pointAdd(d, mulPoint(pk, r));

    const uBytes = groupElementToBytes(U);
    const vBytes = groupElementToBytes(V);
    const encShare = new Uint8Array(64);
    encShare.set(uBytes, 0);
    encShare.set(vBytes, 32);

    const result = decryptEncShare(encShare, sk);
    const resultBytes = groupElementToBytes(result);
    const expectedBytes = groupElementToBytes(d);
    expect(resultBytes).toEqual(expectedBytes);
  });

  it("throws for wrong length", () => {
    expect(() => decryptEncShare(new Uint8Array(32), 1n)).toThrow("must be 64 bytes");
    expect(() => decryptEncShare(new Uint8Array(65), 1n)).toThrow("must be 64 bytes");
  });
});

// ---------------------------------------------------------------------------
// recoverCard — end-to-end threshold recovery
// ---------------------------------------------------------------------------
describe("recoverCard", () => {
  it("recovers card ID from threshold shares", () => {
    const cardId = 7; // pick a known card

    // M = mulBase(cardId + 1) — the plaintext card point
    const M = mulBase(BigInt(cardId + 1));

    // ElGamal encrypt: pick random xHand, C1 = xHand * G, C2 = M + xHand * pk
    // For testing we don't need a real pk — we just need to simulate the
    // threshold decryption. The "decrypted share" from validator j is:
    //   d_j = xHand_j * C1
    // where xHand = Σ xHand_j (Shamir shares of xHand at x=0).

    // Shamir-split a secret xHand with threshold 2, 3 shares
    const xHand = 999n;
    const a1 = 12345n; // polynomial: f(x) = xHand + a1*x
    const f = (x: bigint) => modQ(xHand + modQ(a1 * x));

    const C1 = mulBase(1n); // simplified: C1 = G
    const D = mulPoint(C1, xHand); // D = xHand * C1
    const C2 = pointAdd(M, D); // C2 = M + D

    // Create threshold shares: d_j = f(j) * C1
    const shares = [1n, 2n, 3n].map((j) => ({
      validatorIndex: j,
      d: mulPoint(C1, f(j)),
    }));

    // Recover with 2 of 3 shares (threshold = 2)
    const result = recoverCard(C2, [shares[0]!, shares[2]!]);
    expect(result).toBe(cardId);
  });

  it("returns null for empty shares", () => {
    const C2 = mulBase(1n);
    expect(recoverCard(C2, [])).toBeNull();
  });
});

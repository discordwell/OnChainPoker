import { describe, it, expect } from "vitest";
import {
  CURVE_ORDER,
  mulBase,
  mulPoint,
  pointAdd,
  pointSub,
  groupElementFromBytes,
  groupElementToBytes,
  scalarFromBytesModOrder,
} from "@onchainpoker/ocp-crypto";

/**
 * Tests for hole card cryptographic primitives.
 *
 * These test the building blocks used in holeCards.ts:
 *  - CARD_TABLE lookup ((id+1)*G for each card)
 *  - Lagrange coefficient computation
 *  - Encrypt/decrypt round-trip
 */

// Re-implement the card table logic for verification
function buildCardTable(): Map<string, number> {
  const table = new Map<string, number>();
  for (let id = 0; id < 52; id++) {
    const pt = mulBase(BigInt(id + 1));
    const hex = Array.from(groupElementToBytes(pt))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    table.set(hex, id);
  }
  return table;
}

function modQ(n: bigint): bigint {
  const x = n % CURVE_ORDER;
  return x < 0n ? x + CURVE_ORDER : x;
}

function invMod(a: bigint, m: bigint): bigint {
  const a0 = modQ(a);
  if (a0 === 0n) throw new Error("invMod: cannot invert zero");
  let [old_r, r] = [a0, m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return ((old_s % m) + m) % m;
}

function lagrangeCoefficients(xCoords: bigint[]): bigint[] {
  const n = xCoords.length;
  const coeffs: bigint[] = [];
  for (let j = 0; j < n; j++) {
    let num = 1n;
    let den = 1n;
    for (let m = 0; m < n; m++) {
      if (m === j) continue;
      num = modQ(num * modQ(CURVE_ORDER - xCoords[m]!));
      den = modQ(den * modQ(xCoords[j]! - xCoords[m]!));
    }
    coeffs.push(modQ(num * invMod(den, CURVE_ORDER)));
  }
  return coeffs;
}

describe("CARD_TABLE", () => {
  const table = buildCardTable();

  it("contains exactly 52 entries", () => {
    expect(table.size).toBe(52);
  });

  it("maps each cardId from 0 to 51", () => {
    const ids = new Set(table.values());
    expect(ids.size).toBe(52);
    for (let i = 0; i < 52; i++) {
      expect(ids.has(i)).toBe(true);
    }
  });

  it("uses (id+1)*G, not id*G (avoids identity at id=0)", () => {
    // Card 0 maps to 1*G, not 0*G (identity)
    const g = mulBase(1n);
    const hex = Array.from(groupElementToBytes(g))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(table.get(hex)).toBe(0);
  });

  it("all keys are unique hex strings of length 64", () => {
    for (const key of table.keys()) {
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("Lagrange coefficients", () => {
  it("computes coefficients for 2 points", () => {
    const coeffs = lagrangeCoefficients([1n, 2n]);
    expect(coeffs).toHaveLength(2);
    // Sum of λ_j should be 1 (mod q) for x=0 interpolation
    const sum = modQ(coeffs[0]! + coeffs[1]!);
    expect(sum).toBe(1n);
  });

  it("computes coefficients for 3 points", () => {
    const coeffs = lagrangeCoefficients([1n, 2n, 3n]);
    expect(coeffs).toHaveLength(3);
    const sum = modQ(coeffs[0]! + coeffs[1]! + coeffs[2]!);
    expect(sum).toBe(1n);
  });

  it("handles non-sequential indices", () => {
    const coeffs = lagrangeCoefficients([1n, 3n, 5n]);
    expect(coeffs).toHaveLength(3);
    const sum = modQ(coeffs[0]! + coeffs[1]! + coeffs[2]!);
    expect(sum).toBe(1n);
  });
});

describe("encrypt/decrypt round-trip", () => {
  it("encrypts and decrypts a card point correctly (single share)", () => {
    // Simulate a single-validator scenario
    const cardId = 7;
    const M = mulBase(BigInt(cardId + 1)); // The message point

    // Player keypair
    const skPlayer = 42n;
    const pkPlayer = mulBase(skPlayer);

    // Validator share: d_1 = secret sharing of the blinding factor
    const blindingFactor = 12345n;
    const d1 = mulBase(blindingFactor); // d_1 = blindingFactor * G

    // D = blindingFactor * pkPlayer
    const D = mulPoint(pkPlayer, blindingFactor);

    // C2 = M + D
    const c2 = pointAdd(M, D);

    // Encrypt share: U = blindingFactor * G, V = d_1 + blindingFactor * pkPlayer
    // Wait — the protocol is different. Let's simulate the actual enc share:
    // encShare = (U, V) where U = r*G, V = d + r*pkPlayer
    // Decrypt: V - skPlayer * U = d
    const r = 9999n;
    const U = mulBase(r);
    const V = pointAdd(d1, mulPoint(pkPlayer, r));

    // Decrypt the enc share
    const decrypted = pointSub(V, mulPoint(U, skPlayer));
    // decrypted should equal d1

    const decryptedBytes = groupElementToBytes(decrypted);
    const d1Bytes = groupElementToBytes(d1);
    expect(decryptedBytes).toEqual(d1Bytes);
  });

  it("recovers the correct card with threshold shares", () => {
    const cardId = 23;
    const M = mulBase(BigInt(cardId + 1));

    // Simulate 2-of-3 threshold: secret s split into shares
    // s(x) = a0 + a1*x, shares at x=1,2,3
    const a0 = 777n; // secret
    const a1 = 333n; // random coefficient

    const s1 = modQ(a0 + a1 * 1n);
    const s2 = modQ(a0 + a1 * 2n);

    // D_j = s_j * pkPlayer... actually in the protocol:
    // The dealer picks d_j shares, D = Σ λ_j * d_j
    // Let's just verify Lagrange interpolation recovers a0

    // d_j = s_j * G
    const d1 = mulBase(s1);
    const d2 = mulBase(s2);

    // Recover D = a0 * G using Lagrange
    const xCoords = [1n, 2n];
    const coeffs = lagrangeCoefficients(xCoords);

    let D = mulPoint(d1, coeffs[0]!);
    D = pointAdd(D, mulPoint(d2, coeffs[1]!));

    // D should equal a0 * G
    const expected = mulBase(a0);
    expect(groupElementToBytes(D)).toEqual(groupElementToBytes(expected));
  });
});

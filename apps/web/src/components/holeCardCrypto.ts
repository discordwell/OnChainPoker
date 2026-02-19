import {
  CURVE_ORDER,
  groupElementFromBytes,
  hexToBytes,
  mulBase,
  mulPoint,
  pointAdd,
  pointSub,
} from "@onchainpoker/ocp-crypto";
import type { GroupElement } from "@onchainpoker/ocp-crypto";

// --- Lagrange interpolation helpers (scalar field arithmetic) ---

export function modQ(n: bigint): bigint {
  const x = n % CURVE_ORDER;
  return x < 0n ? x + CURVE_ORDER : x;
}

export function invMod(a: bigint, m: bigint): bigint {
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

/**
 * Compute Lagrange coefficients at x=0 for a set of x-coordinates.
 * Returns scalar coefficients λ_j such that:
 *   secret = Σ λ_j * y_j  (for scalar interpolation)
 *   point  = Σ λ_j * P_j  (for group element interpolation)
 */
export function lagrangeCoefficients(xCoords: bigint[]): bigint[] {
  const n = xCoords.length;
  for (const x of xCoords) {
    if (x === 0n) throw new Error("lagrangeCoefficients: validator index must be >= 1");
  }
  const coeffs: bigint[] = [];
  for (let j = 0; j < n; j++) {
    let num = 1n;
    let den = 1n;
    for (let m = 0; m < n; m++) {
      if (m === j) continue;
      num = modQ(num * modQ(CURVE_ORDER - xCoords[m]!)); // (0 - x_m) mod q
      den = modQ(den * modQ(xCoords[j]! - xCoords[m]!)); // (x_j - x_m) mod q
    }
    coeffs.push(modQ(num * invMod(den, CURVE_ORDER)));
  }
  return coeffs;
}

// --- Card decryption ---

/**
 * Lookup table: cardId → mulBase(BigInt(cardId + 1)) bytes as hex.
 * Encoding uses (id+1)*G (not id*G) to avoid the identity point at id=0,
 * matching the Go chain's cardPoint() encoding.
 */
export const CARD_TABLE: Map<string, number> = (() => {
  const table = new Map<string, number>();
  for (let id = 0; id < 52; id++) {
    const pt = mulBase(BigInt(id + 1));
    const hex = Array.from(pt.toBytes())
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    table.set(hex, id);
  }
  return table;
})();

export function lookupCardId(point: GroupElement): number | null {
  const hex = Array.from(point.toBytes())
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return CARD_TABLE.get(hex) ?? null;
}

/**
 * Decode a hex or base64 string to Uint8Array.
 */
export function decodeShareBytes(raw: string): Uint8Array {
  const s = raw.trim();
  // Try hex: strip optional 0x prefix, then require valid hex of known length
  // (32 bytes = 64 hex chars, or 64 bytes = 128 hex chars)
  const hexBody = s.startsWith("0x") ? s.slice(2) : s;
  if (/^[0-9a-fA-F]+$/.test(hexBody) && (hexBody.length === 64 || hexBody.length === 128)) {
    return hexToBytes(s);
  }
  // Try base64
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Decrypt a single enc share from a validator.
 * encShare format: U(32) || V(32) where U = r*G, V = d + r*pkPlayer
 * Decryption: V - skPlayer * U = d = xHand_j * C1
 */
export function decryptEncShare(encShareBytes: Uint8Array, skPlayer: bigint): GroupElement {
  if (encShareBytes.length !== 64) {
    throw new Error(`enc share must be 64 bytes, got ${encShareBytes.length}`);
  }
  const uBytes = encShareBytes.slice(0, 32);
  const vBytes = encShareBytes.slice(32, 64);
  const U = groupElementFromBytes(uBytes);
  const V = groupElementFromBytes(vBytes);
  return pointSub(V, mulPoint(U, skPlayer));
}

/**
 * Recover a card ID from threshold decrypted shares.
 * Each decrypted share d_j = xHand_j * C1 is a group element.
 * Lagrange interpolation on group elements yields D = xHand * C1.
 * Then M = C2 - D, and M encodes the card ID as mulBase(cardId + 1).
 */
export function recoverCard(
  c2: GroupElement,
  decryptedShares: Array<{ validatorIndex: bigint; d: GroupElement }>
): number | null {
  if (decryptedShares.length === 0) return null;

  const xCoords = decryptedShares.map((s) => s.validatorIndex);
  const coeffs = lagrangeCoefficients(xCoords);

  // D = Σ λ_j * d_j
  let D = mulPoint(decryptedShares[0]!.d, coeffs[0]!);
  for (let j = 1; j < decryptedShares.length; j++) {
    D = pointAdd(D, mulPoint(decryptedShares[j]!.d, coeffs[j]!));
  }

  // M = C2 - D
  const M = pointSub(c2, D);
  return lookupCardId(M);
}

/**
 * Hole card decryption — ported from apps/web/src/components/holeCardCrypto.ts.
 *
 * Decrypts a player's hole cards from on-chain encrypted shares using
 * the player's ristretto private key and Lagrange interpolation.
 */

import {
  CURVE_ORDER,
  groupElementFromBytes,
  mulBase,
  mulPoint,
  pointAdd,
  pointSub,
} from "@onchainpoker/ocp-crypto";
import type { GroupElement } from "@onchainpoker/ocp-crypto";
import type { CardId } from "@onchainpoker/holdem-eval";

// ---------------------------------------------------------------------------
// Lagrange interpolation (scalar field arithmetic)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Card lookup table: cardId → (cardId+1)*G
// ---------------------------------------------------------------------------

const CARD_TABLE: Map<string, number> = (() => {
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

function lookupCardId(point: GroupElement): number | null {
  const hex = Array.from(point.toBytes())
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return CARD_TABLE.get(hex) ?? null;
}

// ---------------------------------------------------------------------------
// Decryption primitives
// ---------------------------------------------------------------------------

function decodeBytes(raw: string): Uint8Array {
  const s = raw.trim();
  const hexBody = s.startsWith("0x") ? s.slice(2) : s;
  if (/^[0-9a-fA-F]+$/.test(hexBody) && (hexBody.length === 64 || hexBody.length === 128)) {
    const bytes = new Uint8Array(hexBody.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hexBody.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  // base64
  const bin = Buffer.from(s, "base64");
  return new Uint8Array(bin);
}

/**
 * Decrypt a single encrypted share from a validator.
 * encShare = U(32) || V(32) where U = r*G, V = d + r*pkPlayer
 * Decryption: V - skPlayer * U
 */
function decryptEncShare(encShareBytes: Uint8Array, skPlayer: bigint): GroupElement {
  if (encShareBytes.length !== 64) {
    throw new Error(`enc share must be 64 bytes, got ${encShareBytes.length}`);
  }
  const U = groupElementFromBytes(encShareBytes.slice(0, 32));
  const V = groupElementFromBytes(encShareBytes.slice(32, 64));
  return pointSub(V, mulPoint(U, skPlayer));
}

/**
 * Recover a card ID from threshold decrypted shares via Lagrange interpolation.
 * M = C2 - D where D = Σ λ_j * d_j, then lookup M in CARD_TABLE.
 */
function recoverCard(
  c2: GroupElement,
  decryptedShares: Array<{ validatorIndex: bigint; d: GroupElement }>
): number | null {
  if (decryptedShares.length === 0) return null;

  const xCoords = decryptedShares.map((s) => s.validatorIndex);
  const coeffs = lagrangeCoefficients(xCoords);

  let D = mulPoint(decryptedShares[0]!.d, coeffs[0]!);
  for (let j = 1; j < decryptedShares.length; j++) {
    D = pointAdd(D, mulPoint(decryptedShares[j]!.d, coeffs[j]!));
  }

  const M = pointSub(c2, D);
  return lookupCardId(M);
}

// ---------------------------------------------------------------------------
// High-level: decrypt hole cards from on-chain data
// ---------------------------------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function toBytes(raw: string | Uint8Array): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  return decodeBytes(raw);
}

/**
 * Attempt to decrypt two hole cards for a given seat from on-chain DealerHand state.
 *
 * @param dealerHand - raw DealerHand JSON from LCD (snake_case or camelCase)
 * @param holePositions - [pos0, pos1] deck positions for the seat's hole cards
 * @param pkPlayerBytes - bot's ristretto public key (32 bytes)
 * @param skPlayer - bot's ristretto private key scalar
 * @returns tuple of two card IDs, or null if shares aren't available yet
 */
export function decryptHoleCards(
  dealerHand: any,
  holePositions: [number, number],
  pkPlayerBytes: Uint8Array,
  skPlayer: bigint
): [CardId, CardId] | null {
  const deck: any[] = dealerHand?.deck ?? [];
  const encShares: any[] = dealerHand?.encShares ?? dealerHand?.enc_shares ?? [];

  const cards: (CardId | null)[] = [];

  for (const pos of holePositions) {
    if (pos === 255 || pos < 0) return null;

    const deckEntry = deck[pos];
    if (!deckEntry) return null;

    const c2Raw = deckEntry.c2;
    if (!c2Raw) return null;
    const c2Bytes = toBytes(c2Raw);
    const c2 = groupElementFromBytes(c2Bytes);

    // Collect enc shares for this position that match our pk
    const shares: Array<{ validatorIndex: bigint; d: GroupElement }> = [];
    for (const es of encShares) {
      const esPos = typeof es.pos === "string" ? parseInt(es.pos, 10) : es.pos;
      if (esPos !== pos) continue;

      const esPk = toBytes(es.pkPlayer ?? es.pk_player);
      if (!bytesEqual(esPk, pkPlayerBytes)) continue;

      const esBytes = toBytes(es.encShare ?? es.enc_share);
      const idx = typeof es.index === "string" ? parseInt(es.index, 10) : es.index;

      try {
        const d = decryptEncShare(esBytes, skPlayer);
        shares.push({ validatorIndex: BigInt(idx), d });
      } catch {
        // skip malformed share
      }
    }

    if (shares.length === 0) return null;

    const cardId = recoverCard(c2, shares);
    if (cardId === null) return null;
    cards.push(cardId);
  }

  if (cards.length !== 2 || cards[0] === null || cards[1] === null) return null;
  return [cards[0]!, cards[1]!] as [CardId, CardId];
}

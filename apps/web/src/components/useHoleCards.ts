import { useCallback, useEffect, useRef, useState } from "react";
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

type HoleCardsState = {
  cards: [number, number] | null;
  loading: boolean;
  error: string | null;
};

// --- Lagrange interpolation helpers (scalar field arithmetic) ---

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

/**
 * Compute Lagrange coefficients at x=0 for a set of x-coordinates.
 * Returns scalar coefficients λ_j such that:
 *   secret = Σ λ_j * y_j  (for scalar interpolation)
 *   point  = Σ λ_j * P_j  (for group element interpolation)
 */
function lagrangeCoefficients(xCoords: bigint[]): bigint[] {
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

/** Precompute lookup table: cardId → mulBase(BigInt(cardId)) bytes as hex */
const CARD_TABLE = new Map<string, number>();
function initCardTable() {
  if (CARD_TABLE.size > 0) return;
  for (let id = 0; id < 52; id++) {
    const pt = mulBase(BigInt(id));
    const hex = Array.from(pt.toBytes())
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    CARD_TABLE.set(hex, id);
  }
}

function lookupCardId(point: GroupElement): number | null {
  initCardTable();
  const hex = Array.from(point.toBytes())
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return CARD_TABLE.get(hex) ?? null;
}

/**
 * Decode a hex or base64 string to Uint8Array.
 */
function decodeShareBytes(raw: string): Uint8Array {
  const s = raw.trim();
  // Try hex first (64 chars = 32 bytes)
  if (/^(0x)?[0-9a-fA-F]+$/.test(s)) {
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
function decryptEncShare(encShareBytes: Uint8Array, skPlayer: bigint): GroupElement {
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
 * Then M = C2 - D, and M encodes the card ID as mulBase(cardId).
 */
function recoverCard(
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

// --- Main hook ---

/**
 * Hook that recovers hole cards for the local player using the coordinator's
 * dealer proxy routes and the player's secret key.
 *
 * Triggers when a hand is active, deck is finalized, and the player is seated.
 */
export function useHoleCards(args: {
  coordinatorBase: string;
  tableId: string | null;
  handId: string | null;
  seat: number | null;
  skPlayer: bigint | null;
  deckFinalized: boolean;
}): HoleCardsState {
  const { coordinatorBase, tableId, handId, seat, skPlayer, deckFinalized } = args;
  const [state, setState] = useState<HoleCardsState>({
    cards: null,
    loading: false,
    error: null,
  });

  // Track which hand we last fetched for to avoid re-fetching
  const lastFetchRef = useRef<string>("");
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchHoleCards = useCallback(async () => {
    if (!coordinatorBase || !tableId || !handId || seat == null || !skPlayer || !deckFinalized) {
      return;
    }

    const fetchKey = `${tableId}:${handId}:${seat}`;
    if (lastFetchRef.current === fetchKey) return;

    setState({ cards: null, loading: true, error: null });

    try {
      // 1. Get hole card positions
      const posRes = await fetch(
        `${coordinatorBase}/v1/dealer/hand/${tableId}/${handId}/hole-positions/${seat}`
      );
      if (!posRes.ok) throw new Error(`Failed to get hole positions: ${posRes.status}`);
      const { pos0, pos1 } = await posRes.json();

      // 2. Get ciphertexts for each position
      const [ct0Res, ct1Res] = await Promise.all([
        fetch(`${coordinatorBase}/v1/dealer/hand/${tableId}/${handId}/ciphertext/${pos0}`),
        fetch(`${coordinatorBase}/v1/dealer/hand/${tableId}/${handId}/ciphertext/${pos1}`),
      ]);

      if (!ct0Res.ok || !ct1Res.ok) throw new Error("Failed to get ciphertexts");
      const ct0Data = await ct0Res.json();
      const ct1Data = await ct1Res.json();

      // 3. Get enc shares for each position
      const [es0Res, es1Res] = await Promise.all([
        fetch(`${coordinatorBase}/v1/dealer/hand/${tableId}/${handId}/enc-shares/${pos0}`),
        fetch(`${coordinatorBase}/v1/dealer/hand/${tableId}/${handId}/enc-shares/${pos1}`),
      ]);

      if (!es0Res.ok || !es1Res.ok) throw new Error("Failed to get enc shares");
      const es0 = await es0Res.json();
      const es1 = await es1Res.json();

      if (!es0.shares?.length || !es1.shares?.length) {
        setState({ cards: null, loading: false, error: "Waiting for validator enc shares..." });
        // Retry after delay since shares may arrive later
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(() => void fetchHoleCards(), 3000);
        return;
      }

      // 4. Get dealer hand state to learn validator indices
      const dhRes = await fetch(
        `${coordinatorBase}/v1/dealer/hand/${tableId}/${handId}`
      );
      if (!dhRes.ok) throw new Error("Failed to get dealer hand state");
      const dhData = await dhRes.json();
      const epochMembers: Array<{ validator: string; index: number }> =
        dhData.hand?.members ?? dhData.hand?.epoch?.members ?? [];

      // Build validator → index map
      const validatorIndex = new Map<string, number>();
      for (const m of epochMembers) {
        validatorIndex.set(String(m.validator ?? "").toLowerCase(), m.index);
      }

      // 5. Decrypt each card
      const cards: [number, number] = [-1, -1];

      for (let cardIdx = 0; cardIdx < 2; cardIdx++) {
        const ctData = cardIdx === 0 ? ct0Data : ct1Data;
        const esData = cardIdx === 0 ? es0 : es1;

        // Parse ciphertext C2
        const c2Bytes = decodeShareBytes(String(ctData.c2));
        const c2 = groupElementFromBytes(c2Bytes);

        // Decrypt enc shares from each validator
        const decryptedShares: Array<{ validatorIndex: bigint; d: GroupElement }> = [];

        for (const share of esData.shares) {
          const valAddr = String(share.validator ?? "").toLowerCase();
          const idx = validatorIndex.get(valAddr);
          if (idx === undefined) continue;

          try {
            const encShareBytes = decodeShareBytes(String(share.encShare));
            const d = decryptEncShare(encShareBytes, skPlayer);
            decryptedShares.push({ validatorIndex: BigInt(idx), d });
          } catch {
            // Skip invalid shares
            continue;
          }
        }

        if (decryptedShares.length === 0) {
          throw new Error(`No valid enc shares for card ${cardIdx}`);
        }

        const cardId = recoverCard(c2, decryptedShares);
        if (cardId === null) {
          throw new Error(`Failed to decrypt card ${cardIdx} — no matching card ID`);
        }
        cards[cardIdx] = cardId;
      }

      lastFetchRef.current = fetchKey;
      setState({ cards, loading: false, error: null });
    } catch (err) {
      setState({
        cards: null,
        loading: false,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }, [coordinatorBase, tableId, handId, seat, skPlayer, deckFinalized]);

  useEffect(() => {
    void fetchHoleCards();
  }, [fetchHoleCards]);

  // Reset when hand changes
  useEffect(() => {
    const key = `${tableId}:${handId}:${seat}`;
    if (lastFetchRef.current && lastFetchRef.current !== key) {
      lastFetchRef.current = "";
      setState({ cards: null, loading: false, error: null });
    }
  }, [tableId, handId, seat]);

  // Cleanup retry timer
  useEffect(() => {
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  return state;
}

import { useCallback, useEffect, useRef, useState } from "react";
import { groupElementFromBytes } from "@onchainpoker/ocp-crypto";
import type { GroupElement } from "@onchainpoker/ocp-crypto";
import { decodeShareBytes, decryptEncShare, recoverCard } from "./holeCardCrypto";

type HoleCardsState = {
  cards: [number, number] | null;
  loading: boolean;
  error: string | null;
};

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

        // Threshold sanity check: need at least ceil(members/2) shares for
        // correct interpolation. With fewer, recoverCard returns null but the
        // error message would be misleading ("no matching card ID").
        const estimatedThreshold = Math.max(1, Math.ceil(epochMembers.length / 2));
        if (decryptedShares.length < estimatedThreshold) {
          throw new Error(
            `Insufficient shares for card ${cardIdx}: have ${decryptedShares.length}, ` +
            `need >= ${estimatedThreshold} (${epochMembers.length} members)`
          );
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

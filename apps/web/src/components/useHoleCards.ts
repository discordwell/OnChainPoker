import { useCallback, useEffect, useRef, useState } from "react";

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

      // 3. Get enc shares for each position
      const [es0Res, es1Res] = await Promise.all([
        fetch(`${coordinatorBase}/v1/dealer/hand/${tableId}/${handId}/enc-shares/${pos0}`),
        fetch(`${coordinatorBase}/v1/dealer/hand/${tableId}/${handId}/enc-shares/${pos1}`),
      ]);

      if (!es0Res.ok || !es1Res.ok) throw new Error("Failed to get enc shares");

      // For now, store the raw data — the actual decryption will be done
      // via HoleCardRecovery when the full crypto pipeline is wired in.
      // This placeholder reports that data is available.
      const es0 = await es0Res.json();
      const es1 = await es1Res.json();

      if (!es0.shares?.length || !es1.shares?.length) {
        setState({ cards: null, loading: false, error: "Waiting for validator enc shares..." });
        return;
      }

      // TODO: Wire in actual HoleCardRecovery.recoverHoleCards() here
      // For now, set loading complete with a placeholder indicating data is ready
      setState({ cards: null, loading: false, error: "Hole card decryption pending crypto wiring" });
      lastFetchRef.current = fetchKey;
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

  return state;
}

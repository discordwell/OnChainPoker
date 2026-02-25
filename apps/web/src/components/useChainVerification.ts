import { useCallback, useEffect, useRef, useState } from "react";
import { parsePlayerTable, type PlayerTableState } from "../lib/parsePlayerTable";

export type VerificationStatus = "idle" | "pending" | "verified" | "mismatch" | "error";

export type FieldMismatch = {
  path: string;
  coordinator: string;
  chain: string;
};

export type ChainVerificationResult = {
  status: VerificationStatus;
  mismatches: FieldMismatch[];
  lastVerifiedAt: number | null;
  verify: () => void;
};

function compareFields(
  coordParsed: PlayerTableState,
  chainTable: PlayerTableState
): FieldMismatch[] {
  const mismatches: FieldMismatch[] = [];

  // Compare seats
  const maxSeats = Math.max(coordParsed.seats.length, chainTable.seats.length);
  for (let i = 0; i < maxSeats; i++) {
    const cs = coordParsed.seats[i];
    const ps = chainTable.seats[i];
    if (!cs || !ps) continue;

    if (cs.player !== ps.player) {
      mismatches.push({
        path: `seats[${i}].player`,
        coordinator: cs.player || "(empty)",
        chain: ps.player || "(empty)",
      });
    }
    if (cs.stack !== ps.stack) {
      mismatches.push({
        path: `seats[${i}].stack`,
        coordinator: cs.stack,
        chain: ps.stack,
      });
    }
    if (cs.bond !== ps.bond) {
      mismatches.push({
        path: `seats[${i}].bond`,
        coordinator: cs.bond,
        chain: ps.bond,
      });
    }
  }

  // Compare hand state
  const ch = coordParsed.hand;
  const ph = chainTable.hand;

  if (ch && ph) {
    if (ch.handId !== ph.handId) {
      mismatches.push({ path: "hand.handId", coordinator: ch.handId, chain: ph.handId });
    }
    if (ch.phase !== ph.phase) {
      mismatches.push({ path: "hand.phase", coordinator: ch.phase, chain: ph.phase });
    }
    if (ch.actionOn !== ph.actionOn) {
      mismatches.push({ path: "hand.actionOn", coordinator: String(ch.actionOn), chain: String(ph.actionOn) });
    }
    if (ch.buttonSeat !== ph.buttonSeat) {
      mismatches.push({ path: "hand.buttonSeat", coordinator: String(ch.buttonSeat), chain: String(ph.buttonSeat) });
    }
    if (ch.pot !== ph.pot) {
      mismatches.push({ path: "hand.pot", coordinator: ch.pot, chain: ph.pot });
    }
    // Compare board arrays
    const coordBoard = ch.board.join(",");
    const chainBoard = ph.board.join(",");
    if (coordBoard !== chainBoard) {
      mismatches.push({ path: "hand.board", coordinator: `[${coordBoard}]`, chain: `[${chainBoard}]` });
    }
  } else if (ch && !ph) {
    mismatches.push({ path: "hand", coordinator: `handId=${ch.handId}`, chain: "(no hand)" });
  } else if (!ch && ph) {
    mismatches.push({ path: "hand", coordinator: "(no hand)", chain: `handId=${ph.handId}` });
  }

  return mismatches;
}

export function useChainVerification({
  coordinatorRawTable,
  playerTable,
  enabled,
}: {
  coordinatorRawTable: unknown;
  playerTable: PlayerTableState | null;
  enabled: boolean;
}): ChainVerificationResult {
  const [status, setStatus] = useState<VerificationStatus>("idle");
  const [mismatches, setMismatches] = useState<FieldMismatch[]>([]);
  const [lastVerifiedAt, setLastVerifiedAt] = useState<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const consecutiveFailures = useRef(0);

  const runComparison = useCallback(() => {
    if (!enabled || !coordinatorRawTable || !playerTable) {
      setStatus("idle");
      setMismatches([]);
      return;
    }

    setStatus("pending");

    let coordParsed: PlayerTableState | null;
    try {
      coordParsed = parsePlayerTable(coordinatorRawTable);
    } catch {
      setStatus("error");
      setMismatches([]);
      return;
    }

    if (!coordParsed) {
      setStatus("error");
      setMismatches([]);
      return;
    }

    const fieldMismatches = compareFields(coordParsed, playerTable);

    if (fieldMismatches.length === 0) {
      consecutiveFailures.current = 0;
      setStatus("verified");
      setMismatches([]);
      setLastVerifiedAt(Date.now());
    } else {
      consecutiveFailures.current += 1;

      if (consecutiveFailures.current >= 2) {
        // Confirmed mismatch after retry
        setStatus("mismatch");
        setMismatches(fieldMismatches);
        setLastVerifiedAt(Date.now());
      } else {
        // First failure — schedule a retry after 1.5s (coordinator may be a block ahead of LCD)
        setStatus("pending");
        if (retryTimerRef.current != null) {
          window.clearTimeout(retryTimerRef.current);
        }
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null;
          // Use ref to call the latest version of runComparison (avoids stale closure)
          runComparisonRef.current();
        }, 1500);
      }
    }
  }, [coordinatorRawTable, playerTable, enabled]);

  // Keep a ref to the latest runComparison so the retry timer always calls fresh state
  const runComparisonRef = useRef(runComparison);
  runComparisonRef.current = runComparison;

  useEffect(() => {
    consecutiveFailures.current = 0;
    runComparison();

    return () => {
      if (retryTimerRef.current != null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [runComparison]);

  const verify = useCallback(() => {
    consecutiveFailures.current = 0;
    runComparison();
  }, [runComparison]);

  return { status, mismatches, lastVerifiedAt, verify };
}

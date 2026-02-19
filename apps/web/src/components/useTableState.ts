import type { PokerTableProps } from "./PokerTable";

interface RawTableState {
  seats: Array<{
    seat: number;
    player: string;
    stack: string;
    bond: string;
    inHand: boolean;
    folded: boolean;
    allIn: boolean;
  }>;
  hand: {
    handId: string;
    phase: string;
    actionOn: number;
  } | null;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Derives PokerTable display state from raw chain table + dealer hand data.
 */
export function deriveTableProps(args: {
  raw: RawTableState | null;
  rawDealer: any | null;
  localAddress: string | null;
  localHoleCards: [number, number] | null;
  actionEnabled: boolean;
  onAction: (action: string, amount?: string) => void;
}): PokerTableProps | null {
  const { raw, rawDealer, localAddress, localHoleCards, actionEnabled, onAction } = args;
  if (!raw) return null;

  const seats = (raw.seats ?? []).map((s) => ({
    seat: s.seat,
    player: s.player,
    stack: s.stack,
    inHand: s.inHand,
    folded: s.folded,
    allIn: s.allIn,
  }));

  // Ensure 9 seats
  while (seats.length < 9) {
    seats.push({
      seat: seats.length,
      player: "",
      stack: "0",
      inHand: false,
      folded: false,
      allIn: false,
    });
  }

  // Determine local player seat
  const localPlayerSeat =
    localAddress
      ? seats.findIndex((s) => s.player.toLowerCase() === localAddress.toLowerCase())
      : -1;

  // Extract board cards from dealer hand data
  const board: (number | null)[] = [];
  if (rawDealer) {
    const reveals = Array.isArray(rawDealer.reveals) ? rawDealer.reveals : [];
    const cursor = asNumber(rawDealer.cursor) ?? 0;

    // Board positions are cursor..cursor+4 in the deck (first 5 after hole cards)
    // Revealed cards come from the reveals array
    for (const r of reveals) {
      const pos = asNumber(r?.pos);
      const cardId = asNumber(r?.cardId ?? r?.card_id);
      if (pos != null && cardId != null && cardId >= 0 && cardId <= 51) {
        board.push(cardId);
      }
    }
  }

  // Extract pot from raw hand data
  const rawHand = raw.hand as any;
  const pot = String(rawHand?.pot ?? rawHand?.pot_total ?? "0");

  const hand = raw.hand
    ? {
        handId: raw.hand.handId,
        phase: raw.hand.phase,
        actionOn: raw.hand.actionOn,
        pot,
        board,
      }
    : null;

  return {
    seats,
    hand,
    localPlayerSeat: localPlayerSeat >= 0 ? localPlayerSeat : null,
    localHoleCards,
    onAction,
    actionEnabled,
  };
}

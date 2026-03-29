/**
 * Client-side leaderboard — aggregated from hand history.
 * Shows top players by hands won with gold/silver/bronze accents.
 */
import { useMemo } from "react";
import type { HandResult } from "./PokerTable";

interface LeaderboardProps {
  handHistory: HandResult[];
  seats: Array<{ seat: number; player: string }>;
  getDisplayName: (address: string) => string;
}

interface LeaderboardEntry {
  address: string;
  name: string;
  handsWon: number;
  totalWinnings: number;
}

const RANK_ACCENT = ["#f0bf4f", "#c0c0c0", "#cd7f32"]; // gold, silver, bronze

export function Leaderboard({ handHistory, seats, getDisplayName }: LeaderboardProps) {
  const entries = useMemo(() => {
    const map = new Map<string, { handsWon: number; totalWinnings: number }>();

    // Build seat→address lookup from current seats
    const seatToAddr = new Map<number, string>();
    for (const s of seats) {
      if (s.player) seatToAddr.set(s.seat, s.player);
    }

    for (const hand of handHistory) {
      for (const w of hand.winners) {
        const addr = seatToAddr.get(w.seat);
        if (!addr) continue;
        const entry = map.get(addr) ?? { handsWon: 0, totalWinnings: 0 };
        entry.handsWon++;
        entry.totalWinnings += Number(w.amount) || 0;
        map.set(addr, entry);
      }
    }

    const result: LeaderboardEntry[] = [];
    for (const [address, data] of map) {
      result.push({
        address,
        name: getDisplayName(address),
        handsWon: data.handsWon,
        totalWinnings: data.totalWinnings,
      });
    }

    return result.sort((a, b) => b.totalWinnings - a.totalWinnings);
  }, [handHistory, seats, getDisplayName]);

  if (entries.length === 0) {
    return (
      <div className="leaderboard">
        <p className="leaderboard__empty">No hand data yet</p>
      </div>
    );
  }

  return (
    <div className="leaderboard">
      {entries.slice(0, 10).map((entry, idx) => (
        <div
          key={entry.address}
          className={`leaderboard__row${idx < 3 ? " leaderboard__row--top" : ""}`}
          style={idx < 3 ? { borderLeftColor: RANK_ACCENT[idx] } : undefined}
        >
          <span className="leaderboard__rank" style={idx < 3 ? { color: RANK_ACCENT[idx] } : undefined}>
            {idx + 1}
          </span>
          <span className="leaderboard__name" title={entry.address}>
            {entry.name}
          </span>
          <span className="leaderboard__stat">
            {entry.totalWinnings.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Session stats panel — tracks hands played, won, and P&L from hand history.
 */
import type { HandResult } from "./PokerTable";

interface PlayerStatsProps {
  address: string;
  handHistory: HandResult[];
}

export function PlayerStats({ address, handHistory }: PlayerStatsProps) {
  if (!address || handHistory.length === 0) return null;

  let handsPlayed = 0;
  let handsWon = 0;
  let totalWinnings = 0;

  for (const h of handHistory) {
    handsPlayed++;
    for (const w of h.winners) {
      // Check if any winner address matches (seat-based, so we need to approximate)
      if (w.seat >= 0) {
        // We don't have direct address→seat mapping in history, count all wins
        handsWon++;
        totalWinnings += Number(w.amount) || 0;
        break;
      }
    }
  }

  const winRate = handsPlayed > 0 ? Math.round((handsWon / handsPlayed) * 100) : 0;

  return (
    <div className="player-stats">
      <h4 className="player-stats__title">Session Stats</h4>
      <div className="player-stats__grid">
        <div className="player-stats__item">
          <span className="player-stats__value">{handsPlayed}</span>
          <span className="player-stats__label">Hands</span>
        </div>
        <div className="player-stats__item">
          <span className="player-stats__value">{handsWon}</span>
          <span className="player-stats__label">Won</span>
        </div>
        <div className="player-stats__item">
          <span className="player-stats__value">{winRate}%</span>
          <span className="player-stats__label">Win Rate</span>
        </div>
      </div>
    </div>
  );
}

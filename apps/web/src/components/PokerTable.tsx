import { useState } from "react";
import { CardFace } from "./CardFace";
import "./PokerTable.css";

export interface PokerTableProps {
  seats: Array<{
    seat: number;
    player: string;
    stack: string;
    inHand: boolean;
    folded: boolean;
    allIn: boolean;
  }>;
  hand: {
    handId: string;
    phase: string;
    actionOn: number;
    pot: string;
    board: (number | null)[];
  } | null;
  localPlayerSeat: number | null;
  localHoleCards: [number, number] | null;
  onAction: (action: string, amount?: string) => void;
  actionEnabled: boolean;
}

/**
 * Seat positions around an elliptical table (percentage-based).
 * Index = seat number, arranged clockwise from bottom-center.
 */
const SEAT_POSITIONS: Array<{ x: number; y: number }> = [
  { x: 50, y: 92 },  // 0 - bottom center
  { x: 18, y: 82 },  // 1 - bottom left
  { x: 4,  y: 52 },  // 2 - left
  { x: 12, y: 18 },  // 3 - top left
  { x: 35, y: 5 },   // 4 - top center-left
  { x: 65, y: 5 },   // 5 - top center-right
  { x: 88, y: 18 },  // 6 - top right
  { x: 96, y: 52 },  // 7 - right
  { x: 82, y: 82 },  // 8 - bottom right
];

function truncateAddress(addr: string): string {
  if (!addr || addr.length < 16) return addr || "";
  return `${addr.slice(0, 8)}...${addr.slice(-4)}`;
}

function phaseLabel(phase: string): string {
  if (!phase) return "";
  const map: Record<string, string> = {
    shuffle: "Shuffling",
    betting: "Betting",
    awaitFlop: "Dealing Flop",
    awaitTurn: "Dealing Turn",
    awaitRiver: "Dealing River",
    awaitShowdown: "Showdown",
    showdown: "Showdown",
  };
  return map[phase] ?? phase;
}

export function PokerTable({
  seats,
  hand,
  localPlayerSeat,
  localHoleCards,
  onAction,
  actionEnabled,
}: PokerTableProps) {
  const [betAmount, setBetAmount] = useState("");

  const phase = hand?.phase ?? "";
  const pot = hand?.pot ?? "0";
  const board = hand?.board ?? [];
  const actionOn = hand?.actionOn ?? -1;

  const handleAction = (action: string) => {
    if (action === "bet" || action === "raise") {
      onAction(action, betAmount || undefined);
    } else {
      onAction(action);
    }
  };

  return (
    <div className="poker-room">
      {/* Ambient glow */}
      <div className="poker-room__ambient" />

      {/* Phase indicator */}
      {hand && (
        <div className="poker-room__phase">
          <span className="poker-room__phase-dot" />
          Hand #{hand.handId} — {phaseLabel(phase)}
        </div>
      )}

      {/* The felt table */}
      <div className="felt">
        <div className="felt__surface">
          <div className="felt__inner-line" />

          {/* Board cards */}
          <div className="felt__board">
            {board.length > 0 ? (
              board.map((cardId, i) => (
                <div key={i} className="felt__board-card" style={{ animationDelay: `${i * 80}ms` }}>
                  <CardFace cardId={cardId} size="md" />
                </div>
              ))
            ) : hand ? (
              <span className="felt__waiting">Waiting for cards</span>
            ) : (
              <span className="felt__waiting">No active hand</span>
            )}
          </div>

          {/* Pot */}
          {hand && pot !== "0" && (
            <div className="felt__pot">
              <span className="felt__pot-chip" />
              {pot}
            </div>
          )}
        </div>

        {/* Seats */}
        {seats.map((seat) => {
          const pos = SEAT_POSITIONS[seat.seat];
          if (!pos) return null;
          const isLocal = seat.seat === localPlayerSeat;
          const isActive = seat.seat === actionOn;
          const isEmpty = !seat.player;
          const showHole = isLocal && localHoleCards != null;

          return (
            <div
              key={seat.seat}
              className={[
                "seat",
                isEmpty && "seat--empty",
                seat.folded && "seat--folded",
                seat.allIn && "seat--allin",
                isActive && "seat--active",
                isLocal && "seat--local",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{
                left: `${pos.x}%`,
                top: `${pos.y}%`,
              }}
            >
              {/* Active turn ring */}
              {isActive && <div className="seat__ring" />}

              <div className="seat__body">
                {/* Cards above seat */}
                <div className="seat__cards">
                  {!isEmpty && seat.inHand && !seat.folded && (
                    showHole ? (
                      <>
                        <CardFace cardId={localHoleCards![0]} size={isLocal ? "md" : "sm"} />
                        <CardFace cardId={localHoleCards![1]} size={isLocal ? "md" : "sm"} />
                      </>
                    ) : (
                      <>
                        <CardFace cardId={null} size="sm" />
                        <CardFace cardId={null} size="sm" />
                      </>
                    )
                  )}
                </div>

                {/* Player info */}
                <div className="seat__info">
                  {isEmpty ? (
                    <span className="seat__empty-label">Empty</span>
                  ) : (
                    <>
                      <span className="seat__name" title={seat.player}>
                        {truncateAddress(seat.player)}
                      </span>
                      <span className="seat__stack">{seat.stack}</span>
                      {seat.folded && <span className="seat__badge seat__badge--fold">Fold</span>}
                      {seat.allIn && <span className="seat__badge seat__badge--allin">All-In</span>}
                    </>
                  )}
                </div>
              </div>

              <span className="seat__number">{seat.seat}</span>
            </div>
          );
        })}
      </div>

      {/* Action panel */}
      {hand && localPlayerSeat != null && (
        <div className={`action-panel ${actionEnabled ? "action-panel--live" : ""}`}>
          <div className="action-panel__row">
            <button
              className="action-btn action-btn--fold"
              disabled={!actionEnabled}
              onClick={() => handleAction("fold")}
            >
              Fold
            </button>
            <button
              className="action-btn action-btn--check"
              disabled={!actionEnabled}
              onClick={() => handleAction("check")}
            >
              Check
            </button>
            <button
              className="action-btn action-btn--call"
              disabled={!actionEnabled}
              onClick={() => handleAction("call")}
            >
              Call
            </button>
            <div className="action-panel__bet-group">
              <input
                className="action-panel__bet-input"
                type="text"
                inputMode="numeric"
                placeholder="Amount"
                value={betAmount}
                onChange={(e) => setBetAmount(e.target.value)}
                disabled={!actionEnabled}
              />
              <button
                className="action-btn action-btn--raise"
                disabled={!actionEnabled}
                onClick={() => handleAction("raise")}
              >
                Raise
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

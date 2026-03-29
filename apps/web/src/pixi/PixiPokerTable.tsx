/**
 * React wrapper for the PixiJS poker table.
 * Mounts a canvas, creates a PixiJS Application, and syncs React props into the scene.
 *
 * The action panel and hand history remain as React/CSS components outside this canvas.
 */
import { useEffect, useRef, useState } from "react";
import { Application } from "pixi.js";
import { TableScene } from "./scenes/TableScene";
import { bindTweener, cancelAll } from "./animations/Tweener";
import { audioManager } from "../audio/AudioManager";
import type { PokerTableProps, HandResult } from "../components/PokerTable";
import { CardFace, cardIdFromLabel } from "../components/CardFace";
import "../components/PokerTable.css";

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
    HAND_PHASE_SHUFFLE: "Shuffling",
    HAND_PHASE_BETTING: "Betting",
    HAND_PHASE_AWAIT_FLOP: "Dealing Flop",
    HAND_PHASE_AWAIT_TURN: "Dealing Turn",
    HAND_PHASE_AWAIT_RIVER: "Dealing River",
    HAND_PHASE_AWAIT_SHOWDOWN: "Showdown",
    HAND_PHASE_SHOWDOWN: "Showdown",
  };
  return map[phase] ?? phase;
}

interface PixiPokerTableProps extends PokerTableProps {
  getDisplayName?: (address: string) => string;
}

export function PixiPokerTable({
  seats,
  hand,
  localPlayerSeat,
  localHoleCards,
  onAction,
  actionEnabled,
  handHistory,
  getDisplayName,
}: PixiPokerTableProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const sceneRef = useRef<TableScene | null>(null);
  const [betAmount, setBetAmount] = useState("");

  // Initialize PixiJS application
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let destroyed = false;
    const app = new Application();

    app.init({
      background: 0x000000,
      backgroundAlpha: 0,
      resizeTo: container,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    }).then(() => {
      if (destroyed) {
        app.destroy();
        return;
      }

      container.appendChild(app.canvas);
      bindTweener(app);

      const scene = new TableScene();
      app.stage.addChild(scene);
      scene.resize(app.screen.width, app.screen.height);

      appRef.current = app;
      sceneRef.current = scene;

      // Per-frame tick for continuous animations
      app.ticker.add(() => {
        sceneRef.current?.tick();
      });

      // Handle resize
      const resizeObserver = new ResizeObserver(() => {
        if (sceneRef.current && appRef.current) {
          sceneRef.current.resize(appRef.current.screen.width, appRef.current.screen.height);
        }
      });
      resizeObserver.observe(container);

      return () => {
        resizeObserver.disconnect();
      };
    });

    return () => {
      destroyed = true;
      cancelAll();
      if (appRef.current) {
        appRef.current.destroy(true);
        appRef.current = null;
        sceneRef.current = null;
      }
    };
  }, []);

  // Sync props into the PixiJS scene every render
  useEffect(() => {
    if (sceneRef.current) {
      sceneRef.current.nameResolver = getDisplayName ?? null;
      sceneRef.current.syncProps({ seats, hand, localPlayerSeat, localHoleCards, onAction, actionEnabled });
    }
  });

  // Detect hand completion for win celebration
  const prevHandIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!handHistory || handHistory.length === 0) return;
    const latest = handHistory[0];
    if (!latest || latest.handId === prevHandIdRef.current) return;
    prevHandIdRef.current = latest.handId;

    // Celebrate winners with sound
    if (sceneRef.current && latest.winners.length > 0) {
      const big = latest.winners.some((w) => Number(w.amount) > 50000);
      audioManager.play(big ? "winBig" : "winSmall");
      for (const w of latest.winners) {
        sceneRef.current.celebrateWinner(w.seat, big);
      }
    }
  }, [handHistory]);

  const handleAction = (action: string) => {
    if (action === "bet" || action === "raise") {
      onAction(action, betAmount || undefined);
    } else {
      onAction(action);
    }
  };

  const phase = hand?.phase ?? "";

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

      {/* PixiJS Canvas — matches old .felt aspect ratio */}
      <div
        ref={containerRef}
        className="pixi-table-container"
        style={{
          width: "100%",
          aspectRatio: "16 / 10",
          minHeight: 380,
          position: "relative",
          zIndex: 1,
        }}
      />

      {/* Action panel (React/CSS, below the canvas) */}
      {hand && localPlayerSeat != null && (
        <div className={`action-panel ${actionEnabled ? "action-panel--live" : ""}`} style={{ zIndex: 2 }}>
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

      {/* Hand History (React/CSS, stays as-is) */}
      {handHistory && handHistory.length > 0 && (
        <div className="hand-history" style={{ zIndex: 2 }}>
          <h4 className="hand-history__title">Hand History</h4>
          <div className="hand-history__list">
            {handHistory.map((result, idx) => (
              <details key={result.handId} className="hand-history__entry" open={idx === 0 ? true : undefined}>
                <summary className="hand-history__header">
                  <span className="hand-history__hand-id">
                    Hand #{result.handId}
                    {result.street && <span className="hand-history__street">{result.street}</span>}
                    {result.reason && <span className="hand-history__reason">{result.reason}</span>}
                  </span>
                  <span className="hand-history__meta">
                    <span className="hand-history__relative">{idx === 0 ? "Last hand" : `${idx} hand${idx > 1 ? "s" : ""} ago`}</span>
                    <span className="hand-history__pot">Pot: {result.pot}</span>
                  </span>
                </summary>
                {result.board.length > 0 && (
                  <div className="hand-history__board">
                    {result.board.map((cardId, i) => (
                      <CardFace key={i} cardId={cardId} size="sm" />
                    ))}
                  </div>
                )}
                {result.revealedCards && Object.keys(result.revealedCards).length > 0 && (
                  <div className="hand-history__revealed">
                    {Object.entries(result.revealedCards).map(([seatStr, cards]) => {
                      const seatNum = Number(seatStr);
                      const seatInfo = seatNum >= 0 && seatNum < seats.length ? seats[seatNum] : undefined;
                      const label = seatInfo?.player
                        ? truncateAddress(seatInfo.player)
                        : `Seat ${seatNum}`;
                      return (
                        <span key={seatStr} className="hand-history__reveal">
                          {label}:{" "}
                          {cards.map((c, ci) => {
                            const cid = cardIdFromLabel(c);
                            return cid != null
                              ? <CardFace key={ci} cardId={cid} size="sm" />
                              : <span key={ci} className="hand-history__card-label">{c}</span>;
                          })}
                        </span>
                      );
                    })}
                  </div>
                )}
                <div className="hand-history__winners">
                  {result.winners.length > 0 ? (
                    result.winners.map((w, i) => {
                      const seatInfo = w.seat >= 0 ? seats[w.seat] : undefined;
                      const label = seatInfo?.player
                        ? truncateAddress(seatInfo.player)
                        : `Seat ${w.seat}`;
                      return (
                        <span key={i} className="hand-history__winner">
                          {label} won {w.amount}
                        </span>
                      );
                    })
                  ) : (
                    <span className="hand-history__winner">Pot distributed</span>
                  )}
                </div>
              </details>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

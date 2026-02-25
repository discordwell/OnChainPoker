import { useState } from "react";
import type { ChainVerificationResult } from "./useChainVerification";
import type { CometBftMetrics, CometBftStatus } from "./useCometBftEvents";
import "./ChainVerificationBadge.css";

const cometStatusLabels: Record<CometBftStatus, string> = {
  connected: "Connected",
  connecting: "Connecting\u2026",
  error: "Error",
  disconnected: "Disconnected",
};

type Props = ChainVerificationResult & {
  cometMetrics?: CometBftMetrics;
};

export function ChainVerificationBadge({
  status,
  mismatches,
  lastVerifiedAt,
  verify,
  cometMetrics,
}: Props) {
  const [open, setOpen] = useState(false);

  if (status === "idle") return null;

  const cometConnected = cometMetrics?.status === "connected";

  const label =
    status === "verified" && cometConnected ? "Chain Verified (Live)" :
    status === "verified" ? "Chain Verified" :
    status === "pending" ? "Verifying\u2026" :
    status === "mismatch" ? "Chain Mismatch!" :
    "Verification unavailable";

  const ago = lastVerifiedAt
    ? `${Math.max(0, Math.round((Date.now() - lastVerifiedAt) / 1000))}s ago`
    : null;

  return (
    <span
      className={`chain-badge chain-badge--${status}`}
      onClick={() => setOpen((v) => !v)}
      title={ago ? `Last checked ${ago}` : undefined}
    >
      <span className="chain-badge__dot" />
      {label}

      {open && (
        <span className="chain-badge__dropdown" onClick={(e) => e.stopPropagation()}>
          {status === "mismatch" && mismatches.length > 0 && (
            <>
              <h5>Mismatched Fields</h5>
              <ul className="chain-badge__mismatch-list">
                {mismatches.map((m) => (
                  <li key={m.path}>
                    <span className="chain-badge__field-path">{m.path}</span>
                    <span className="chain-badge__field-vals">
                      <span>coord: {m.coordinator}</span>
                      <span>chain: {m.chain}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {status === "verified" && <p>Coordinator data matches on-chain state.</p>}
          {status === "error" && <p>Could not reach LCD endpoint for verification.</p>}

          <button type="button" className="chain-badge__verify-btn" onClick={verify}>
            Verify Now
          </button>

          {lastVerifiedAt && (
            <p className="chain-badge__timestamp">
              Last verified: {new Date(lastVerifiedAt).toLocaleTimeString()}
            </p>
          )}

          {cometMetrics && (
            <div className="chain-badge__comet-section">
              <h5>Direct Chain Link</h5>
              <div className="chain-badge__comet-row">
                <span className={`chain-badge__dot chain-badge__dot--sm chain-badge__dot--${cometMetrics.status}`} />
                <span>{cometStatusLabels[cometMetrics.status]}</span>
              </div>
              {cometMetrics.eventsReceived > 0 && (
                <div className="chain-badge__comet-row">
                  <span>Events received:</span>
                  <span>{cometMetrics.eventsReceived}</span>
                </div>
              )}
              {cometMetrics.medianDelayMs != null && (
                <div className="chain-badge__comet-row">
                  <span>Coordinator delay:</span>
                  <span>+{cometMetrics.medianDelayMs}ms</span>
                </div>
              )}
              {cometMetrics.coordinatorMisses > 0 && (
                <div className="chain-badge__comet-row chain-badge__comet-warn">
                  <span>Coordinator misses:</span>
                  <span>{cometMetrics.coordinatorMisses}</span>
                </div>
              )}
            </div>
          )}
        </span>
      )}
    </span>
  );
}

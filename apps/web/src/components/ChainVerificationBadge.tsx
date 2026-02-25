import { useState } from "react";
import type { ChainVerificationResult } from "./useChainVerification";
import "./ChainVerificationBadge.css";

export function ChainVerificationBadge({
  status,
  mismatches,
  lastVerifiedAt,
  verify,
}: ChainVerificationResult) {
  const [open, setOpen] = useState(false);

  if (status === "idle") return null;

  const label =
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
        </span>
      )}
    </span>
  );
}

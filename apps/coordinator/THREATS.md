# Threat Model: Coordinator (Untrusted)

The coordinator is an **optional** off-chain service. It is trusted for convenience only (UX), not for correctness, funds custody, or confidentiality.

## What It CAN Do (Expected Capabilities)

- Provide table discovery/matchmaking hints (seat intents, lobby views).
- Relay chain events to clients via WebSocket push.
- Cache and serve dealer artifacts for convenience (clients can still fetch from chain).
- Apply rate limiting / basic abuse controls at the edge.

## What It MUST NOT Do

- Hold player funds or custody keys.
- Be required to complete a hand.
- Be required to validate game state or resolve disputes.
- Be a confidentiality boundary (it should not learn unrevealed cards).

## Threats

- **Lying about state**: coordinator shows fake table/hand state.
  - Mitigation: clients treat chain as source of truth; verify via direct RPC queries and/or block height/event index.
- **Censorship / selective relay**: coordinator withholds events or artifacts.
  - Mitigation: clients use direct chain queries; artifacts can be fetched on-chain; coordinator is a cache, not an oracle.
- **Replay / reordering**: coordinator replays old events.
  - Mitigation: clients use monotonic `(height, txIndex, logIndex)` or `eventIndex` to de-duplicate and order events.
- **DoS**: coordinator is overloaded or goes offline.
  - Mitigation: client fallback to direct chain queries; coordinator deploy is horizontally scalable; enforce payload size limits.
- **Traffic analysis / metadata leakage**: coordinator can learn which tables a player is watching.
  - Mitigation: clients may connect directly to chain; use TLS; consider batching or privacy-preserving relay later (non-goal v1).
- **Artifact poisoning**: coordinator serves corrupted artifacts.
  - Mitigation: clients verify proofs/commitments against on-chain references; invalid proofs must fail verification deterministically.

## Non-Goals (v1)

- Preventing collusion, bribery, or out-of-band signaling.
- Providing anonymity against network-level observers.
- Replacing a proper p2p gossip layer.


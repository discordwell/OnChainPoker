# WS8: Coordinator (Untrusted) (One-Shot Brief)

## Goal

Implement an optional coordinator service that improves UX without affecting correctness: table discovery, matchmaking, notifications, artifact caching/relay.

## Inputs

- `docs/SPEC.md` Section 11

## Deliverables

- New app: `apps/coordinator`
  - REST: table list, seating intents
  - WebSocket: event push (subscribes to chain, forwards to clients)
  - Artifact relay: caches dealer artifacts, but clients can always fetch from chain
- Threat model doc: `apps/coordinator/THREATS.md` (what it can and cannot do)

## Acceptance Tests

- Coordinator can be shut down mid-hand without breaking the game (clients continue via direct chain queries).


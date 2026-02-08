# WS7: Client Protocol + SDK (One-Shot Brief)

## Goal

Define the client-facing protocol (txs, events, queries) and implement a client SDK to drive gameplay, including hole-card share retrieval and local decryption.

## Inputs

- `docs/INTERFACES.md` events + API concepts
- `docs/SPEC.md` Section 10 (client requirements)

## Deliverables

- Doc: `docs/PROTOCOL.md` (tx schemas, events, queries)
- New package: `packages/ocp-sdk`
  - connect to node RPC
  - submit txs
  - subscribe to events
  - fetch shares + decrypt/assemble hole cards (using WS3/WS4)
- Integration example script: `scripts/play_hand.mjs` (uses `OcpV0Client`; run via `pnpm ws7:play_hand`)

## Acceptance Tests

- Can sit, post blinds, receive hole cards, act, and complete a hand against a local devnet.

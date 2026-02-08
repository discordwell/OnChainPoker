# WS4: DKG + Threshold Key Derivation (One-Shot Brief)

## Goal

Specify and prototype DKG + per-hand key derivation (`PK_hand`, `sk_i_hand`) with verifiable transcripts and slashable failure modes.

## Inputs

- `docs/SPEC.md` Sections 6.2 and 6.3

## Deliverables

- Doc: `docs/DKG.md`
  - protocol steps, message types, timeouts
  - evidence for slashing (what exactly is submitted on-chain)
  - how complaints are resolved deterministically
- Prototype implementation in the chosen language (even if off-chain simulation):
  - can run `N` participants, threshold `t`
  - outputs `PK_epoch` and per-validator shares
  - supports byzantine behaviors: equivocation, withholding

## Acceptance Tests

- Simulate:
  - all honest -> success
  - 1 byzantine equivocation -> complaint + slash + still finalize
  - > tolerated withholding -> epoch fails with deterministic abort

## Notes

If on-chain DKG is too heavy for v1, propose a constrained alternative (still decentralized) and document the tradeoff explicitly.


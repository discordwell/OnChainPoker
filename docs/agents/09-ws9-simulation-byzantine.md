# WS9: Simulation + Byzantine/Grief Testing (One-Shot Brief)

## Goal

Build a deterministic simulator that exercises the full protocol with configurable adversaries, then turn it into a regression suite.

## Inputs

- `docs/SPEC.md` Sections 7 and 8 (slashing, abort/refund)
- WS1 + WS3/WS4 APIs

## Deliverables

- New app: `apps/sim`
  - can run N players and a dealer committee
  - can inject byzantine behaviors:
    - withhold shuffle / share
    - submit invalid proof
    - player timeouts
    - coordinator outage (if modeled)
- Scenario suite + invariants.

## Acceptance Tests

- Scenarios cover:
  - mid-hand slashing and continuation
  - threshold failure -> abort + refunds
  - repeated grief attempts -> bonds/slashing deter

## Current Implementation Notes (Repo)

Implemented in `apps/sim` as a deterministic, crypto-light protocol simulator (threshold gating + slashing + abort/refund),
with a scenario suite that runs under Node's built-in test runner.

Run:

```bash
pnpm -C apps/sim sim --list
pnpm -C apps/sim sim mid-hand-slash-continues
pnpm -C apps/sim sim threshold-failure-abort-refund
```

Tests:

```bash
pnpm -C apps/sim test
```

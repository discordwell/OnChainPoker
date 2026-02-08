# WS9 Simulator (`apps/sim`)

Deterministic, fault-injectable protocol simulator used for WS9 regression scenarios (Byzantine/grief testing).

## Run

```bash
pnpm -C apps/sim sim --list
pnpm -C apps/sim sim mid-hand-slash-continues
pnpm -C apps/sim sim threshold-failure-abort-refund
```

## Tests

```bash
pnpm -C apps/sim test
```

## What This Models (v0)

- A simplified `PokerTable` + `Dealer` flow matching the intent of `docs/INTERFACES.md`.
- Dealer committee shuffles, encrypted/private share delivery (modeled), and public reveals (modeled).
- Fault injection:
  - withhold shuffle/share
  - submit invalid proof
  - player timeouts (auto-check if legal else fold + bond slash)
  - coordinator outage (modeled as non-impacting UX flag)
- Invariants:
  - chip conservation across stacks/bonds/validator stake/treasury
  - no negative balances
  - deck cursor bounds

This is intentionally crypto-light: it models *protocol behavior* (threshold gating, slashing, abort/refund) without implementing real proofs.


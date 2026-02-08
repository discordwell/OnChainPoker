# WS10: DevEx / CI / Localnet Tooling (One-Shot Brief)

## Goal

Make the repo runnable and testable end-to-end with one command, and keep it green via CI.

## Inputs

- existing `pnpm` workspace
- WS6 localnet requirements

## Deliverables

- `scripts/` utilities:
  - start localnet (chain)
  - start coordinator
  - start web
  - run integration tests
- CI config (GitHub Actions or equivalent) that runs:
  - unit tests (WS1/WS2/WS3)
  - integration sim (WS9) if feasible

## Acceptance Tests

- `pnpm test` (or equivalent) passes on a clean checkout.


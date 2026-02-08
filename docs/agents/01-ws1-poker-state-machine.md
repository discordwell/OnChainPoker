# WS1: Poker State Machine + Pot/Side Pots (One-Shot Brief)

## Goal

Implement the deterministic 9-max NLH cash-game state machine (actions, legality, side pots, timeouts) as a reusable library with tests.

## Inputs

- `docs/SPEC.md` Sections 5 and 8
- `docs/INTERFACES.md` Section 2 (PokerTable API)

## Deliverables

- New package: `packages/poker-engine`
- Core types:
  - `TableState`, `HandState`, `SeatState`, `Pot`, `Action`
- Pure transition function:
  - `applyAction(state, action, now) -> state`
  - `applyTick(state, now) -> state`
- Side pot algorithm + tests.
- Timeout behavior exactly as spec: auto-check if legal else fold; optional bond slash hook.

## Acceptance Tests

- Unit tests for:
  - bet sizing legality (check/call/bet/raise)
  - all-in edge cases
  - side pot correctness in multi-all-in scenarios
- Invariant/property tests:
  - chip conservation (sum stacks + pots constant, minus configured rake)
  - no negative stack
  - no action out of turn can be applied

## Non-Goals (v1)

- Tournament rules, antes, multi-asset chips.
- Anti-collusion heuristics.

## Notes

Keep the engine deterministic and serialization-friendly; no floating point; no dates (use integer timestamps).


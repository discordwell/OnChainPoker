# WS2: Hand Evaluation (Showdown) (One-Shot Brief)

## Goal

Implement a correct and deterministic Texas Hold'em evaluator for showdown settlement (7-card best-of-5), including ties and split pots.

## Inputs

- `docs/SPEC.md` (showdown requirements)
- WS1 pot/eligibility output: list of eligible seats per (side) pot.

## Deliverables

- Module in `packages/poker-engine` OR separate `packages/holdem-eval` (your choice; justify).
- API:
  - `evaluate7(cards7) -> HandRank`
  - `compare(a, b) -> -1|0|1`
  - `winners(board5, holeCardsBySeat) -> seats[]` (handles ties)

## Acceptance Tests

- Known-answer tests: straight/flush/full house/quads edge cases.
- Randomized tests cross-checking a reference evaluator (can be a dev-only dependency or golden dataset).

## Notes

Be explicit about card encoding (`0..51` or `(rank,suit)`) and keep it consistent with `docs/SPEC.md` encoding plan.


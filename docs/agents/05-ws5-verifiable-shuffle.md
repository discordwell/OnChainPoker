# WS5: Verifiable Shuffle Proofs (One-Shot Brief)

## Goal

Lock the shuffle proof system and produce a verifier + cost model suitable for an appchain runtime.

## Inputs

- `docs/SPEC.md` Section 6.5
- WS3 group + ElGamal definitions

## Deliverables

- Doc: `docs/SHUFFLE.md`
  - chosen scheme (with citations)
  - statement being proved
  - transcript format + Fiat-Shamir tags
  - expected proof sizes and verification complexity for 52 ciphertexts
- Prototype verifier implementation (even if not yet embedded on-chain).
- Benchmark script:
  - verify time for N=52, committee sizes 16..64

## Acceptance Tests

- Valid shuffle proofs verify.
- Invalid shuffles (wrong permutation, missing rerandomization) fail.

## Notes

This is a hard track. If the chosen shuffle is too expensive, propose a plan B (e.g., smaller committee for shuffle, batched proofs, precompiles) but keep the non-negotiables intact.


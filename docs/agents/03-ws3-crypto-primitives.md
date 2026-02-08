# WS3: Crypto Primitives Library (One-Shot Brief)

## Goal

Produce a concrete, testable crypto library for the v1 suite (group ops, ElGamal, Chaum-Pedersen, Fiat-Shamir transcript rules) plus canonical serialization.

## Inputs

- `docs/SPEC.md` Section 6.1.1 (Concrete v1 suite)
- `docs/INTERFACES.md` Section 4 (serialization placeholder)

## Deliverables

- New package: `packages/ocp-crypto` (language: TS or Rust; pick what compiles in repo today)
- Implement:
  - `hashToScalar(domainSep, bytes...)`
  - `elgamalEncrypt(PK, M, r) -> (c1, c2)`
  - `elgamalDecrypt(x, (c1,c2)) -> M`
  - Chaum-Pedersen proof for `log_g(Y) = log_{c1}(d)`
  - Fiat-Shamir transcript spec (domain tags, ordering)
  - Canonical encodings for Scalar/GroupElement
- Provide test vectors in `docs/test-vectors/` (format: JSON) and tests that consume them.

## Acceptance Tests

- Positive + negative proof verification tests.
- Round-trip serialization tests.
- Fuzz (optional): random scalars and points; ensure verifier rejects malformed encodings.

## Notes

Avoid inventing crypto. If you choose a library (e.g., noble-curves / curve25519-dalek), document version and encoding assumptions.


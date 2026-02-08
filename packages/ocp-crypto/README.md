# @onchainpoker/ocp-crypto

WS3 crypto primitives for OnChainPoker v1.

## Suite

- Group: Ristretto255 (prime-order group built on Curve25519)
- Hash: SHA-512
- Encodings:
  - `Scalar`: 32-byte little-endian, canonical (`0 <= s < q`)
  - `GroupElement`: 32-byte canonical Ristretto encoding

Library versions are pinned in `package.json` (`@noble/curves@1.2.0`, `@noble/hashes@1.3.2`).

## Implemented

- `hashToScalar(domainSep, ...msgs)`
- ElGamal in `G`: `C = (c1, c2) = (g^r, M * Y^r)` (implemented in additive notation)
- Chaum-Pedersen equality-of-discrete-log proof:
  - Proves `log_g(Y) = log_{c1}(d)`
  - Uses Fiat-Shamir via `Transcript` (domain-separated)

## Tests

Tests consume JSON vectors in `docs/test-vectors/ocp-crypto-v1.json`.


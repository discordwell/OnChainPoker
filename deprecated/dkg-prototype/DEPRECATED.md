# Deprecated: DKG Prototype

This package was a toy off-chain simulation of the DKG protocol using a 61-bit Schnorr group, a non-cryptographic "hmacToy" signature, and deterministic coefficients derived from a default seed. It is retained here for historical reference only and must not be used in production.

The production DKG protocol is implemented on-chain in `apps/cosmos/x/dealer` with cryptographic primitives in `packages/ocp-crypto` and (planned) encrypted-share messaging described in `docs/DKG-V2.md`.

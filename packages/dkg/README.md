# @onchainpoker/dkg (WS4 Prototype)

Off-chain simulation/prototype for WS4:

- Feldman-style DKG with deterministic complaint/reveal slashing rules
- epoch public key `PK_E` + per-validator shares `sk_i`
- deterministic per-hand derivation (`PK_hand`, `sk_i_hand`)

This package intentionally uses a small toy Schnorr group (safe prime) for fast tests.
It is **not** production crypto and is meant to validate protocol flow and transcript verification.

## Run

```bash
pnpm -C packages/dkg test
pnpm -C packages/dkg sim
```


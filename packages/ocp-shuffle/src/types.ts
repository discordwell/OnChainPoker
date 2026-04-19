import type { ElGamalCiphertext, GroupElement, Scalar } from "@onchainpoker/ocp-crypto";

export type { Scalar, GroupElement, ElGamalCiphertext };

export type ShuffleProveOpts = {
  // SECURITY: test-only deterministic CSPRNG seed override. NEVER use in
  // production. Reusing a seed across two shuffles causes identical Schnorr
  // nonces to be paired with different Fiat-Shamir challenges, letting a
  // verifier recover re-encryption randomness rho via
  // rho = (z1 - z2) / (e1 - e2), leaking the permutation. Guarded at runtime
  // by `shuffleProveV1`: disallowed unless NODE_ENV=test or
  // OCP_ALLOW_UNSAFE_SEED=1.
  seedUnsafeForTestsOnly?: Uint8Array;
  // Number of odd-even rounds (defaults to n).
  rounds?: number;
  // Context bytes to bind into the Fiat-Shamir transcript (required for v2).
  // If omitted, prover emits a legacy v1 proof (no context binding).
  // Canonical format (shared byte-for-byte with Go verifier):
  //   u64le(tableId) || u64le(handId) || u16le(round) || u16le(shufflerLen) || shuffler_utf8
  context?: Uint8Array;
};

export type ShuffleProveResult = {
  deckOut: ElGamalCiphertext[];
  proofBytes: Uint8Array;
};

export type ShuffleVerifyResult =
  | { ok: true; deckOut: ElGamalCiphertext[] }
  | { ok: false; error: string };


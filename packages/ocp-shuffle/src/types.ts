import type { ElGamalCiphertext, GroupElement, Scalar } from "@onchainpoker/ocp-crypto";

export type { Scalar, GroupElement, ElGamalCiphertext };

export type ShuffleProveOpts = {
  // If provided, proof and shuffle are deterministic.
  seed?: Uint8Array;
  // Number of odd-even rounds (defaults to n).
  rounds?: number;
};

export type ShuffleProveResult = {
  deckOut: ElGamalCiphertext[];
  proofBytes: Uint8Array;
};

export type ShuffleVerifyResult =
  | { ok: true; deckOut: ElGamalCiphertext[] }
  | { ok: false; error: string };


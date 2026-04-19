import { gcm } from "@noble/ciphers/aes";
import { sha256 } from "@noble/hashes/sha256";

import type { GroupElement } from "../utils/group.js";
import { groupElementToBytes, mulPoint } from "../utils/group.js";
import type { Scalar } from "../utils/scalar.js";
import { scalarFromBytes, scalarToBytes } from "../utils/scalar.js";
import { concatBytes } from "../utils/bytes.js";

// Hybrid scalar-delivery AEAD for DKG v2.
//
// The NIZK in dkgEncShare.ts proves the share POINT `s*G` is delivered
// correctly to the recipient. Downstream Chaum-Pedersen decryption proofs
// (see packages/ocp-crypto/src/proofs/{chaumPedersen,encShare}.ts) need the
// share SCALAR `s` as a witness, not just the point. This module provides
// the scalar alongside the NIZK-verified point, encrypted under a key
// derived from the same ECDH as the ElGamal ciphertext.
//
// Wire format: ct = AES-256-GCM(key, iv=0^12, plaintext=scalar_bytes_LE(32),
// aad=proof_bytes_160). 48-byte output (32 ct + 16 GCM tag).
//
// Key derivation: key = SHA256("ocp/v1/dkg/scalar-aead/v1" || dh_bytes)
// where dh = r*pkR (prover) = skR*U (recipient).
//
// Zero IV is safe because the key is unique per (r, pkR) pair — each share
// uses a fresh r, so the AES-GCM per-invocation key-IV pair is never
// repeated. The AEAD tag binds the ct to the NIZK proof (via AAD), so an
// attacker cannot substitute one dealer's ct onto another's proof. If AEAD
// decryption fails, OR if `s*G` (decrypted scalar times G) does not match
// the share point derived from (u, v) + skR, the recipient treats the
// share as invalid and files a complaint.
//
// Implementation uses @noble/ciphers + @noble/hashes so the primitive is
// usable in both Node (dealer daemon) and the browser (web client
// recipient-side sanity checks). The Go mirror at
// apps/cosmos/internal/ocpcrypto/dkg_scalar_aead.go produces identical
// bytes — cross-language compatibility is enforced by the vectors tests.

export const DKG_SCALAR_AEAD_KEY_DOMAIN = "ocp/v1/dkg/scalar-aead/v1";
export const DKG_SCALAR_AEAD_CT_BYTES = 48; // 32 scalar + 16 GCM tag

const AEAD_IV = new Uint8Array(12); // all zeros

const DOMAIN_BYTES = new TextEncoder().encode(DKG_SCALAR_AEAD_KEY_DOMAIN);

function deriveAeadKey(dh: GroupElement): Uint8Array {
  const dhBytes = groupElementToBytes(dh);
  return sha256(concatBytes(DOMAIN_BYTES, dhBytes));
}

/**
 * Encrypts the share scalar `s` so that only the holder of `skR`
 * (the recipient whose public key is `pkR`) can recover it.
 *
 * The prover computes the ECDH value `dh = r*pkR` (where `r` is the same
 * ephemeral randomness used in the accompanying NIZK / ElGamal ciphertext
 * `(U=r*G, V=s*G+r*pkR)`). AEAD AAD is the 160-byte encoded NIZK proof,
 * so the scalar ct is cryptographically bound to the NIZK statement.
 */
export function encryptShareScalar(params: {
  pkR: GroupElement;
  r: Scalar;
  s: Scalar;
  proofBytes: Uint8Array;
}): Uint8Array {
  const { pkR, r, s, proofBytes } = params;
  if (!(proofBytes instanceof Uint8Array)) {
    throw new Error("encryptShareScalar: proofBytes must be Uint8Array");
  }
  const dh = mulPoint(pkR, r);
  const key = deriveAeadKey(dh);
  const cipher = gcm(key, AEAD_IV, proofBytes);
  const pt = scalarToBytes(s);
  const ct = cipher.encrypt(pt);
  if (ct.length !== DKG_SCALAR_AEAD_CT_BYTES) {
    throw new Error(`encryptShareScalar: unexpected ct length ${ct.length}`);
  }
  return ct;
}

/**
 * Recipient-side decryption. Given `skR` and the ElGamal ephemeral `u = r*G`,
 * reconstructs the key via `dh = skR*u` and AEAD-decrypts the ct.
 *
 * Throws if the AEAD tag check fails (ct or AAD was tampered, or key is wrong).
 * The caller MUST subsequently verify that `s*G` matches the share point
 * derived from the ElGamal ciphertext (`V - skR*U`), otherwise the dealer
 * could have embedded a scalar inconsistent with the NIZK-verified share point.
 */
export function decryptShareScalar(params: {
  skR: Scalar;
  u: GroupElement;
  proofBytes: Uint8Array;
  ct: Uint8Array;
}): Scalar {
  const { skR, u, proofBytes, ct } = params;
  if (!(ct instanceof Uint8Array) || ct.length !== DKG_SCALAR_AEAD_CT_BYTES) {
    throw new Error(
      `decryptShareScalar: ct must be ${DKG_SCALAR_AEAD_CT_BYTES} bytes`
    );
  }
  if (!(proofBytes instanceof Uint8Array)) {
    throw new Error("decryptShareScalar: proofBytes must be Uint8Array");
  }
  const dh = mulPoint(u, skR);
  const key = deriveAeadKey(dh);
  const cipher = gcm(key, AEAD_IV, proofBytes);
  const pt = cipher.decrypt(ct); // throws on bad tag
  if (pt.length !== 32) {
    throw new Error("decryptShareScalar: unexpected plaintext length");
  }
  return scalarFromBytes(pt);
}

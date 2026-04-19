import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

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

export const DKG_SCALAR_AEAD_KEY_DOMAIN = "ocp/v1/dkg/scalar-aead/v1";
export const DKG_SCALAR_AEAD_CT_BYTES = 48; // 32 scalar + 16 GCM tag

const AEAD_IV = new Uint8Array(12); // all zeros

function u8(buf: Uint8Array | Buffer): Uint8Array {
  return buf instanceof Uint8Array && !(buf instanceof Buffer)
    ? buf
    : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function deriveAeadKey(dh: GroupElement): Uint8Array {
  const dhBytes = groupElementToBytes(dh);
  const h = createHash("sha256");
  h.update(Buffer.from(DKG_SCALAR_AEAD_KEY_DOMAIN, "utf8"));
  h.update(Buffer.from(dhBytes));
  return u8(h.digest());
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
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(AEAD_IV));
  cipher.setAAD(Buffer.from(proofBytes));
  const pt = scalarToBytes(s);
  const ctBody = cipher.update(Buffer.from(pt));
  const ctFinal = cipher.final();
  const tag = cipher.getAuthTag();
  const out = new Uint8Array(DKG_SCALAR_AEAD_CT_BYTES);
  let off = 0;
  out.set(ctBody, off);
  off += ctBody.length;
  out.set(ctFinal, off);
  off += ctFinal.length;
  out.set(tag, off);
  return out;
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
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(AEAD_IV));
  decipher.setAAD(Buffer.from(proofBytes));
  decipher.setAuthTag(Buffer.from(ct.subarray(32, 48)));
  const ptBody = decipher.update(Buffer.from(ct.subarray(0, 32)));
  const ptFinal = decipher.final(); // throws on bad tag
  const pt = concatBytes(u8(ptBody), u8(ptFinal));
  if (pt.length !== 32) {
    throw new Error("decryptShareScalar: unexpected plaintext length");
  }
  return scalarFromBytes(pt);
}

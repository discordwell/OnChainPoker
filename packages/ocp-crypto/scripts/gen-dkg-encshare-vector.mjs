// Emits a deterministic DkgEncShare test vector to stdout as JSON.
// Run from the repo root with:
//   node --import tsx packages/ocp-crypto/scripts/gen-dkg-encshare-vector.mjs
// and paste the output into docs/test-vectors/ocp-crypto-v1.json's
// "dkgEncShare" array. Both TS and Go vectors tests then verify the proof
// bytes — the purpose is cross-language byte-for-byte parity.
//
// The vector pins fixed inputs so that both implementations produce the
// exact same 160-byte proof; if they diverge, the transcript framing has
// regressed and the two verifiers will accept each other's proofs only by
// coincidence.

import {
  basePoint,
  bytesToHex,
  groupElementToBytes,
  mulBase,
  mulPoint,
  pointAdd,
  scalarMul,
  scalarAdd,
  scalarToBytes,
} from "../dist/index.js";
import {
  dkgEncShareProve,
  encodeDkgEncShareProof,
} from "../dist/proofs/dkgEncShare.js";
import { encryptShareScalar } from "../dist/proofs/dkgScalarAead.js";

// Fixed polynomial f(x) = 100 + 200*x + 300*x^2 mod q.
const coeffs = [100n, 200n, 300n];
// Build commitments C_k = a_k * G.
const commitments = coeffs.map((a) => mulBase(a));

// Recipient key.
const skR = 9001n;
const pkR = mulBase(skR);

// Recipient index.
const j = 2;

// Share scalar s = f(j) = 100 + 200*2 + 300*4 = 1700.
// Compute generically so if the polynomial ever changes, s follows.
function evalPoly(cs, jv) {
  let acc = 0n;
  let pow = 1n;
  const js = BigInt(jv);
  for (const a of cs) {
    acc = scalarAdd(acc, scalarMul(a, pow));
    pow = scalarMul(pow, js);
  }
  return acc;
}

const s = evalPoly(coeffs, j);

// ElGamal randomness.
const r = 42n;
const U = mulBase(r);
const V = pointAdd(mulBase(s), mulPoint(pkR, r));

// Fiat-Shamir nonces (fixed — do not reuse in production).
const ws = 11n;
const wr = 13n;

const proof = dkgEncShareProve({ commitments, j, pkR, u: U, v: V, s, r, ws, wr });
const proofBytes = encodeDkgEncShareProof(proof);

// Hybrid AEAD scalar-delivery ciphertext: AES-256-GCM over s_bytes_LE with
// AAD = proofBytes, IV = 0^12, key = SHA256(domain || r*pkR). 48 bytes.
const scalarCt = encryptShareScalar({ pkR, r, s, proofBytes });

const vector = {
  description: "DkgEncShare: f(x)=100+200*x+300*x^2 at j=2, skR=9001, r=42, ws=11, wr=13",
  commitmentsHex: commitments.map((c) => "0x" + bytesToHex(groupElementToBytes(c))),
  j,
  pkRHex: "0x" + bytesToHex(groupElementToBytes(pkR)),
  uHex: "0x" + bytesToHex(groupElementToBytes(U)),
  vHex: "0x" + bytesToHex(groupElementToBytes(V)),
  proofHex: "0x" + bytesToHex(proofBytes),
  scalarCtHex: "0x" + bytesToHex(scalarCt),
  scalarHexLE: "0x" + bytesToHex(scalarToBytes(s)),
};

console.log(JSON.stringify(vector, null, 2));

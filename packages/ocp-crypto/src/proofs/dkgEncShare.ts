import {
  GroupElement,
  groupElementFromBytes,
  groupElementToBytes,
  mulBase,
  mulPoint,
  pointAdd,
  pointEq,
} from "../utils/group.js";
import type { Scalar } from "../utils/scalar.js";
import {
  assertScalar,
  scalarAdd,
  scalarFromBytes,
  scalarMul,
  scalarToBytes,
} from "../utils/scalar.js";
import { Transcript } from "../utils/transcript.js";
import { concatBytes, u32le } from "../utils/bytes.js";

// DkgEncShareProof is a Sigma-protocol / Schnorr-style NIZK proof for the
// statement that an on-chain ciphertext (U, V) carries a Feldman-consistent
// DKG share to recipient j, encrypted under that recipient's public key
// `pkR`. Concretely, it proves knowledge of scalars (s, r) such that:
//
//   (a) s*G = Σ_{k=0..t-1} C_k * j^k      (share s is consistent with
//                                          the dealer's Feldman commitments)
//   (b) U   = r*G                          (ElGamal ephemeral component)
//   (c) V   = s*G + r*pkR                  (ElGamal message component,
//                                          encrypting share "in the exponent")
//
// The proof is Fiat-Shamir-transformed using the existing Transcript class
// with domain "ocp/v1/dkg/encshare".
//
// Sigma commitments (prover picks random scalars ws, wr):
//   A1 = ws*G
//   A2 = wr*G
//   A3 = ws*G + wr*pkR
//
// Challenge: e = H(C_0..C_{t-1}, j, pkR, U, V, A1, A2, A3)
//
// Responses:
//   ss = ws + e*s
//   sr = wr + e*r
//
// Verification:
//   ss*G         == A1 + e * Eval_j        where Eval_j := Σ C_k * j^k
//   sr*G         == A2 + e * U
//   ss*G + sr*pkR == A3 + e * V
//
// All checks are required. Note (ss*G) appears in checks 1 and 3 — the
// verifier MUST NOT conflate them.
export type DkgEncShareProof = {
  a1: GroupElement; // ws*G
  a2: GroupElement; // wr*G
  a3: GroupElement; // ws*G + wr*pkR
  ss: Scalar; // ws + e*s
  sr: Scalar; // wr + e*r
};

export const DKG_ENC_SHARE_DOMAIN = "ocp/v1/dkg/encshare";

// Evaluate Σ_{k=0..t-1} C_k * j^k in the group. j is a uint32 recipient
// index. j == 0 is disallowed by Feldman VSS (it would leak C_0 directly
// as the share point); we enforce j >= 1 here as a safety rail.
export function evalCommitments(
  commitments: GroupElement[],
  j: number
): GroupElement {
  if (!Array.isArray(commitments) || commitments.length === 0) {
    throw new Error("evalCommitments: commitments must be a non-empty array");
  }
  if (!Number.isInteger(j) || j < 1 || j > 0xffffffff) {
    throw new Error("evalCommitments: j must be a uint32 >= 1");
  }
  const jScalar = BigInt(j);
  let pow: Scalar = 1n;
  let acc = GroupElement.zero();
  for (const c of commitments) {
    acc = pointAdd(acc, mulPoint(c, pow));
    pow = scalarMul(pow, jScalar);
  }
  return acc;
}

function appendStatement(
  tr: Transcript,
  commitments: GroupElement[],
  j: number,
  pkR: GroupElement,
  u: GroupElement,
  v: GroupElement
): void {
  // Bind the number of commitments (threshold degree) into the transcript
  // so that an attacker cannot truncate or pad the commitments vector to
  // get a matching challenge for a different statement.
  tr.appendMessage("t", u32le(commitments.length));
  for (let k = 0; k < commitments.length; k++) {
    tr.appendMessage(`C${k}`, groupElementToBytes(commitments[k]!));
  }
  tr.appendMessage("j", u32le(j));
  tr.appendMessage("pkR", groupElementToBytes(pkR));
  tr.appendMessage("U", groupElementToBytes(u));
  tr.appendMessage("V", groupElementToBytes(v));
}

export function dkgEncShareProve(params: {
  // Public statement:
  commitments: GroupElement[]; // C_0..C_{t-1}
  j: number; // recipient index (uint32, >= 1)
  pkR: GroupElement; // recipient public key
  u: GroupElement; // = r*G
  v: GroupElement; // = s*G + r*pkR
  // Witness:
  s: Scalar; // share scalar s = f(j)
  r: Scalar; // ElGamal ephemeral randomness
  // Nonces (MUST be freshly sampled, non-zero, canonical scalars):
  ws: Scalar;
  wr: Scalar;
}): DkgEncShareProof {
  const { commitments, j, pkR, u, v, s, r, ws, wr } = params;

  assertScalar(s);
  assertScalar(r);
  assertScalar(ws);
  assertScalar(wr);
  if (ws === 0n || wr === 0n) {
    throw new Error("dkgEncShareProve: nonces must be non-zero");
  }
  if (!Array.isArray(commitments) || commitments.length === 0) {
    throw new Error("dkgEncShareProve: commitments must be a non-empty array");
  }
  if (!Number.isInteger(j) || j < 1 || j > 0xffffffff) {
    throw new Error("dkgEncShareProve: j must be a uint32 >= 1");
  }

  const a1 = mulBase(ws);
  const a2 = mulBase(wr);
  const a3 = pointAdd(mulBase(ws), mulPoint(pkR, wr));

  const tr = new Transcript(DKG_ENC_SHARE_DOMAIN);
  appendStatement(tr, commitments, j, pkR, u, v);
  tr.appendMessage("A1", groupElementToBytes(a1));
  tr.appendMessage("A2", groupElementToBytes(a2));
  tr.appendMessage("A3", groupElementToBytes(a3));
  const e = tr.challengeScalar("e");

  const ss = scalarAdd(ws, scalarMul(e, s));
  const sr = scalarAdd(wr, scalarMul(e, r));
  return { a1, a2, a3, ss, sr };
}

export function dkgEncShareVerify(params: {
  commitments: GroupElement[];
  j: number;
  pkR: GroupElement;
  u: GroupElement;
  v: GroupElement;
  proof: DkgEncShareProof;
}): boolean {
  const { commitments, j, pkR, u, v, proof } = params;
  const { a1, a2, a3, ss, sr } = proof;

  assertScalar(ss);
  assertScalar(sr);
  if (!Array.isArray(commitments) || commitments.length === 0) return false;
  if (!Number.isInteger(j) || j < 1 || j > 0xffffffff) return false;

  let evalJ: GroupElement;
  try {
    evalJ = evalCommitments(commitments, j);
  } catch {
    return false;
  }

  const tr = new Transcript(DKG_ENC_SHARE_DOMAIN);
  appendStatement(tr, commitments, j, pkR, u, v);
  tr.appendMessage("A1", groupElementToBytes(a1));
  tr.appendMessage("A2", groupElementToBytes(a2));
  tr.appendMessage("A3", groupElementToBytes(a3));
  const e = tr.challengeScalar("e");

  // Check (a): ss*G == A1 + e * Eval_j
  const lhs1 = mulBase(ss);
  const rhs1 = pointAdd(a1, mulPoint(evalJ, e));
  if (!pointEq(lhs1, rhs1)) return false;

  // Check (b): sr*G == A2 + e * U
  const lhs2 = mulBase(sr);
  const rhs2 = pointAdd(a2, mulPoint(u, e));
  if (!pointEq(lhs2, rhs2)) return false;

  // Check (c): ss*G + sr*pkR == A3 + e * V
  const lhs3 = pointAdd(mulBase(ss), mulPoint(pkR, sr));
  const rhs3 = pointAdd(a3, mulPoint(v, e));
  if (!pointEq(lhs3, rhs3)) return false;

  return true;
}

// Canonical encoding: A1(32) || A2(32) || A3(32) || ss(32 le) || sr(32 le)
// = 160 bytes. This mirrors EncShareProof's layout so chain-side decoding
// can reuse the same fixed-size scheme.
export const DKG_ENC_SHARE_PROOF_BYTES = 160;

export function encodeDkgEncShareProof(p: DkgEncShareProof): Uint8Array {
  return concatBytes(
    groupElementToBytes(p.a1),
    groupElementToBytes(p.a2),
    groupElementToBytes(p.a3),
    scalarToBytes(p.ss),
    scalarToBytes(p.sr)
  );
}

export function decodeDkgEncShareProof(bytes: Uint8Array): DkgEncShareProof {
  if (!(bytes instanceof Uint8Array) || bytes.length !== DKG_ENC_SHARE_PROOF_BYTES) {
    throw new Error(
      `decodeDkgEncShareProof: expected ${DKG_ENC_SHARE_PROOF_BYTES} bytes`
    );
  }
  const a1 = groupElementFromBytes(bytes.slice(0, 32));
  const a2 = groupElementFromBytes(bytes.slice(32, 64));
  const a3 = groupElementFromBytes(bytes.slice(64, 96));
  // Scalars must be canonical (< q) 32-byte LE encodings. Decoder stays
  // strict so that `decode(encode(p)) == p` and invalid encodings are
  // rejected up front instead of producing bogus accept/reject results.
  const ss = scalarFromBytes(bytes.slice(96, 128));
  const sr = scalarFromBytes(bytes.slice(128, 160));
  return { a1, a2, a3, ss, sr };
}

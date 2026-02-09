import type { GroupElement } from "../utils/group.js";
import {
  groupElementFromBytes,
  groupElementToBytes,
  mulBase,
  mulPoint,
  pointAdd,
  pointEq,
} from "../utils/group.js";
import type { Scalar } from "../utils/scalar.js";
import { assertScalar, scalarAdd, scalarFromBytes, scalarMul, scalarToBytes } from "../utils/scalar.js";
import { Transcript } from "../utils/transcript.js";
import { concatBytes } from "../utils/bytes.js";

// EncShareProof is a Schnorr-style proof of knowledge for the statement:
//
// There exist scalars (x, r) such that:
//   Y = x*G
//   U = r*G
//   V = x*C1 + r*PKP
//
// where (U,V) is an ElGamal encryption (under PKP) of the decryption share x*C1.
export type EncShareProof = {
  a1: GroupElement; // w_x*G
  a2: GroupElement; // w_r*G
  a3: GroupElement; // w_x*C1 + w_r*PKP
  sx: Scalar; // w_x + e*x
  sr: Scalar; // w_r + e*r
};

const ENC_SHARE_DOMAIN = "ocp/v1/dealer/encshare";

export function encShareProve(params: {
  // Public statement:
  y: GroupElement; // y = x*G
  c1: GroupElement;
  pkP: GroupElement;
  u: GroupElement;
  v: GroupElement;
  // Witness:
  x: Scalar;
  r: Scalar;
  // Nonces:
  wx: Scalar;
  wr: Scalar;
}): EncShareProof {
  const { y, c1, pkP, u, v, x, r, wx, wr } = params;

  assertScalar(x);
  assertScalar(r);
  assertScalar(wx);
  assertScalar(wr);
  if (wx === 0n || wr === 0n) throw new Error("encShareProve: nonces must be non-zero");

  const a1 = mulBase(wx);
  const a2 = mulBase(wr);
  const a3 = pointAdd(mulPoint(c1, wx), mulPoint(pkP, wr));

  const tr = new Transcript(ENC_SHARE_DOMAIN);
  tr.appendMessage("Y", groupElementToBytes(y));
  tr.appendMessage("C1", groupElementToBytes(c1));
  tr.appendMessage("PKP", groupElementToBytes(pkP));
  tr.appendMessage("U", groupElementToBytes(u));
  tr.appendMessage("V", groupElementToBytes(v));
  tr.appendMessage("A1", groupElementToBytes(a1));
  tr.appendMessage("A2", groupElementToBytes(a2));
  tr.appendMessage("A3", groupElementToBytes(a3));
  const e = tr.challengeScalar("e");

  const sx = scalarAdd(wx, scalarMul(e, x));
  const sr = scalarAdd(wr, scalarMul(e, r));
  return { a1, a2, a3, sx, sr };
}

export function encShareVerify(params: {
  y: GroupElement;
  c1: GroupElement;
  pkP: GroupElement;
  u: GroupElement;
  v: GroupElement;
  proof: EncShareProof;
}): boolean {
  const { y, c1, pkP, u, v, proof } = params;
  const { a1, a2, a3, sx, sr } = proof;

  assertScalar(sx);
  assertScalar(sr);

  const tr = new Transcript(ENC_SHARE_DOMAIN);
  tr.appendMessage("Y", groupElementToBytes(y));
  tr.appendMessage("C1", groupElementToBytes(c1));
  tr.appendMessage("PKP", groupElementToBytes(pkP));
  tr.appendMessage("U", groupElementToBytes(u));
  tr.appendMessage("V", groupElementToBytes(v));
  tr.appendMessage("A1", groupElementToBytes(a1));
  tr.appendMessage("A2", groupElementToBytes(a2));
  tr.appendMessage("A3", groupElementToBytes(a3));
  const e = tr.challengeScalar("e");

  // Check: sx*G == A1 + e*Y
  const lhs1 = mulBase(sx);
  const rhs1 = pointAdd(a1, mulPoint(y, e));
  if (!pointEq(lhs1, rhs1)) return false;

  // Check: sr*G == A2 + e*U
  const lhs2 = mulBase(sr);
  const rhs2 = pointAdd(a2, mulPoint(u, e));
  if (!pointEq(lhs2, rhs2)) return false;

  // Check: sx*C1 + sr*PKP == A3 + e*V
  const lhs3 = pointAdd(mulPoint(c1, sx), mulPoint(pkP, sr));
  const rhs3 = pointAdd(a3, mulPoint(v, e));
  if (!pointEq(lhs3, rhs3)) return false;

  return true;
}

// Encoding: A1(32)||A2(32)||A3(32)||sx(32 le)||sr(32 le) = 160 bytes.
export function encodeEncShareProof(p: EncShareProof): Uint8Array {
  return concatBytes(
    groupElementToBytes(p.a1),
    groupElementToBytes(p.a2),
    groupElementToBytes(p.a3),
    scalarToBytes(p.sx),
    scalarToBytes(p.sr)
  );
}

export function decodeEncShareProof(bytes: Uint8Array): EncShareProof {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 160) {
    throw new Error("decodeEncShareProof: expected 160 bytes");
  }
  const a1 = groupElementFromBytes(bytes.slice(0, 32));
  const a2 = groupElementFromBytes(bytes.slice(32, 64));
  const a3 = groupElementFromBytes(bytes.slice(64, 96));

  // Scalars are expected to be canonical 32-byte LE encodings.
  const sx = scalarFromBytes(bytes.slice(96, 128));
  const sr = scalarFromBytes(bytes.slice(128, 160));
  return { a1, a2, a3, sx, sr };
}


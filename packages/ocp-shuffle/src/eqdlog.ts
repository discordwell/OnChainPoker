import type { GroupElement, Scalar } from "@onchainpoker/ocp-crypto";
import {
  Transcript,
  groupElementFromBytes,
  groupElementToBytes,
  mulPoint,
  pointAdd,
  pointEq,
  pointSub,
  scalarAdd,
  scalarMul,
  scalarSub,
  scalarToBytes,
  scalarFromBytes,
} from "@onchainpoker/ocp-crypto";
import { concatBytes } from "@onchainpoker/ocp-crypto";
import { encodePoint, decodePoint, encodeScalar, decodeScalar, Reader } from "./encoding.js";
import type { ScalarRng } from "./rng.js";

export type EqDlogProof = {
  t1: GroupElement;
  t2: GroupElement;
  z: Scalar;
};

// Prove knowledge of x such that:
//   X = x*A and Y = x*B
export function proveEqDlog(params: {
  domain: string;
  A: GroupElement;
  B: GroupElement;
  X: GroupElement;
  Y: GroupElement;
  x: Scalar;
  rng: ScalarRng;
}): EqDlogProof {
  const { domain, A, B, X, Y, x, rng } = params;

  const w = rng.nextScalar();
  const t1 = mulPoint(A, w);
  const t2 = mulPoint(B, w);

  const tr = new Transcript(domain);
  tr.appendMessage("A", groupElementToBytes(A));
  tr.appendMessage("B", groupElementToBytes(B));
  tr.appendMessage("X", groupElementToBytes(X));
  tr.appendMessage("Y", groupElementToBytes(Y));
  tr.appendMessage("t1", groupElementToBytes(t1));
  tr.appendMessage("t2", groupElementToBytes(t2));
  const e = tr.challengeScalar("e");

  const z = scalarAdd(w, scalarMul(e, x));
  return { t1, t2, z };
}

export function verifyEqDlog(params: {
  domain: string;
  A: GroupElement;
  B: GroupElement;
  X: GroupElement;
  Y: GroupElement;
  proof: EqDlogProof;
}): boolean {
  const { domain, A, B, X, Y, proof } = params;
  const { t1, t2, z } = proof;

  const tr = new Transcript(domain);
  tr.appendMessage("A", groupElementToBytes(A));
  tr.appendMessage("B", groupElementToBytes(B));
  tr.appendMessage("X", groupElementToBytes(X));
  tr.appendMessage("Y", groupElementToBytes(Y));
  tr.appendMessage("t1", groupElementToBytes(t1));
  tr.appendMessage("t2", groupElementToBytes(t2));
  const e = tr.challengeScalar("e");

  // Check: z*A == t1 + e*X
  const lhs1 = mulPoint(A, z);
  const rhs1 = pointAdd(t1, mulPoint(X, e));
  if (!pointEq(lhs1, rhs1)) return false;

  // Check: z*B == t2 + e*Y
  const lhs2 = mulPoint(B, z);
  const rhs2 = pointAdd(t2, mulPoint(Y, e));
  if (!pointEq(lhs2, rhs2)) return false;

  return true;
}

// Simulation helper: given chosen (e,z), compute commitments that satisfy verification equations.
export function simulateEqDlogCommitments(params: {
  A: GroupElement;
  B: GroupElement;
  X: GroupElement;
  Y: GroupElement;
  e: Scalar;
  z: Scalar;
}): { t1: GroupElement; t2: GroupElement } {
  const { A, B, X, Y, e, z } = params;
  const t1 = pointSub(mulPoint(A, z), mulPoint(X, e));
  const t2 = pointSub(mulPoint(B, z), mulPoint(Y, e));
  return { t1, t2 };
}

// Encoding: t1(32) || t2(32) || z(32)
export function encodeEqDlogProof(p: EqDlogProof): Uint8Array {
  return concatBytes(groupElementToBytes(p.t1), groupElementToBytes(p.t2), scalarToBytes(p.z));
}

export function decodeEqDlogProof(bytes: Uint8Array): EqDlogProof {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 96) throw new Error("decodeEqDlogProof: expected 96 bytes");
  const t1 = groupElementFromBytes(bytes.subarray(0, 32));
  const t2 = groupElementFromBytes(bytes.subarray(32, 64));
  const z = scalarFromBytes(bytes.subarray(64, 96));
  return { t1, t2, z };
}

export function decodeEqDlogProofFromReader(reader: Reader): EqDlogProof {
  return {
    t1: decodePoint(reader.take(32)),
    t2: decodePoint(reader.take(32)),
    z: decodeScalar(reader.take(32)),
  };
}

export function encodeEqDlogProofV1(p: EqDlogProof): Uint8Array {
  // Uses encoding.ts wrappers; identical to encodeEqDlogProof but avoids deep crypto imports if needed.
  return concatBytes(encodePoint(p.t1), encodePoint(p.t2), encodeScalar(p.z));
}


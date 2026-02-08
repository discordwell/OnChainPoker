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
import {
  assertScalar,
  scalarAdd,
  scalarFromBytes,
  scalarMul,
  scalarToBytes,
} from "../utils/scalar.js";
import { Transcript } from "../utils/transcript.js";
import { concatBytes } from "../utils/bytes.js";

export type ChaumPedersenProof = {
  // a = w*G
  a: GroupElement;
  // b = w*c1
  b: GroupElement;
  // s = w + e*x
  s: Scalar;
};

const CP_DOMAIN = "ocp/v1/chaum-pedersen-eqdl";

export function chaumPedersenProve(params: {
  // Public statement:
  y: GroupElement; // y = x*G
  c1: GroupElement;
  d: GroupElement; // d = x*c1
  // Witness:
  x: Scalar;
  // Nonce:
  w: Scalar;
}): ChaumPedersenProof {
  const { y, c1, d, x, w } = params;
  assertScalar(x);
  assertScalar(w);

  const a = mulBase(w);
  const b = mulPoint(c1, w);

  const tr = new Transcript(CP_DOMAIN);
  tr.appendMessage("y", groupElementToBytes(y));
  tr.appendMessage("c1", groupElementToBytes(c1));
  tr.appendMessage("d", groupElementToBytes(d));
  tr.appendMessage("a", groupElementToBytes(a));
  tr.appendMessage("b", groupElementToBytes(b));
  const e = tr.challengeScalar("e");

  const s = scalarAdd(w, scalarMul(e, x));
  return { a, b, s };
}

export function chaumPedersenVerify(params: {
  y: GroupElement;
  c1: GroupElement;
  d: GroupElement;
  proof: ChaumPedersenProof;
}): boolean {
  const { y, c1, d, proof } = params;
  const { a, b, s } = proof;

  assertScalar(s);

  const tr = new Transcript(CP_DOMAIN);
  tr.appendMessage("y", groupElementToBytes(y));
  tr.appendMessage("c1", groupElementToBytes(c1));
  tr.appendMessage("d", groupElementToBytes(d));
  tr.appendMessage("a", groupElementToBytes(a));
  tr.appendMessage("b", groupElementToBytes(b));
  const e = tr.challengeScalar("e");

  // Check: s*G == a + e*y
  const lhs1 = mulBase(s);
  const rhs1 = pointAdd(a, mulPoint(y, e));
  if (!pointEq(lhs1, rhs1)) return false;

  // Check: s*c1 == b + e*d
  const lhs2 = mulPoint(c1, s);
  const rhs2 = pointAdd(b, mulPoint(d, e));
  if (!pointEq(lhs2, rhs2)) return false;

  return true;
}

// Encoding: A(32) || B(32) || s(32 le)
export function encodeChaumPedersenProof(p: ChaumPedersenProof): Uint8Array {
  return concatBytes(groupElementToBytes(p.a), groupElementToBytes(p.b), scalarToBytes(p.s));
}

export function decodeChaumPedersenProof(bytes: Uint8Array): ChaumPedersenProof {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32 + 32 + 32) {
    throw new Error("decodeChaumPedersenProof: expected 96 bytes");
  }
  const aBytes = bytes.slice(0, 32);
  const bBytes = bytes.slice(32, 64);
  const sBytes = bytes.slice(64, 96);

  const a = groupElementFromBytes(aBytes);
  const b = groupElementFromBytes(bBytes);
  // scalarFromBytes expects 32-bytes canonical; but `s` is always mod q so it should be canonical.
  // Keep decode strict to match acceptance tests.
  const s = scalarFromBytes(sBytes);
  return { a, b, s };
}

import type { ElGamalCiphertext, GroupElement, Scalar } from "@onchainpoker/ocp-crypto";
import {
  Transcript,
  basePoint,
  groupElementToBytes,
  mulPoint,
  pointAdd,
  pointEq,
  pointSub,
  scalarAdd,
  scalarMul,
  scalarSub,
} from "@onchainpoker/ocp-crypto";
import { concatBytes } from "@onchainpoker/ocp-crypto";
import { Reader, encodePoint, encodeScalar, decodePoint, decodeScalar } from "./encoding.js";
import type { ScalarRng } from "./rng.js";
import { simulateEqDlogCommitments } from "./eqdlog.js";

export type SwitchProof = {
  // Challenge for branch 0 (no swap). Branch 1 is derived as e - e0.
  e0: Scalar;
  // 4 relations, each with commitments (t1,t2) and response z.
  // Ordering matches docs/SHUFFLE.md:
  //  0: branch0 rel0 (out0 vs in0)
  //  1: branch0 rel1 (out1 vs in1)
  //  2: branch1 rel0 (out0 vs in1)
  //  3: branch1 rel1 (out1 vs in0)
  t1: [GroupElement, GroupElement, GroupElement, GroupElement];
  t2: [GroupElement, GroupElement, GroupElement, GroupElement];
  z: [Scalar, Scalar, Scalar, Scalar];
};

const DOMAIN_SWITCH = "ocp/v1/shuffle/switch-or";
const G = basePoint();
const T1_LABELS = ["t1.0", "t1.1", "t1.2", "t1.3"];
const T2_LABELS = ["t2.0", "t2.1", "t2.2", "t2.3"];

function dlogDiff(pk: GroupElement, inCt: ElGamalCiphertext, outCt: ElGamalCiphertext): { X: GroupElement; Y: GroupElement } {
  // X = out.c1 - in.c1 = rho*G
  // Y = out.c2 - in.c2 = rho*pk
  return {
    X: pointSub(outCt.c1, inCt.c1),
    Y: pointSub(outCt.c2, inCt.c2),
  };
}

function switchChallenge(params: {
  pk: GroupElement;
  in0: ElGamalCiphertext;
  in1: ElGamalCiphertext;
  out0: ElGamalCiphertext;
  out1: ElGamalCiphertext;
  t1: GroupElement[];
  t2: GroupElement[];
}): Scalar {
  const { pk, in0, in1, out0, out1, t1, t2 } = params;
  const tr = new Transcript(DOMAIN_SWITCH);
  tr.appendMessage("pk", groupElementToBytes(pk));
  tr.appendMessage("in0.c1", groupElementToBytes(in0.c1));
  tr.appendMessage("in0.c2", groupElementToBytes(in0.c2));
  tr.appendMessage("in1.c1", groupElementToBytes(in1.c1));
  tr.appendMessage("in1.c2", groupElementToBytes(in1.c2));
  tr.appendMessage("out0.c1", groupElementToBytes(out0.c1));
  tr.appendMessage("out0.c2", groupElementToBytes(out0.c2));
  tr.appendMessage("out1.c1", groupElementToBytes(out1.c1));
  tr.appendMessage("out1.c2", groupElementToBytes(out1.c2));
  for (let i = 0; i < 4; i++) tr.appendMessage(T1_LABELS[i]!, groupElementToBytes(t1[i]!));
  for (let i = 0; i < 4; i++) tr.appendMessage(T2_LABELS[i]!, groupElementToBytes(t2[i]!));
  return tr.challengeScalar("e");
}

export function proveSwitch(params: {
  pk: GroupElement;
  in0: ElGamalCiphertext;
  in1: ElGamalCiphertext;
  out0: ElGamalCiphertext;
  out1: ElGamalCiphertext;
  swapped: boolean;
  rho0: Scalar;
  rho1: Scalar;
  rng: ScalarRng;
}): SwitchProof {
  const { pk, in0, in1, out0, out1, swapped, rho0, rho1, rng } = params;

  // Public relations:
  // branch0:
  //  rel0: out0 vs in0
  //  rel1: out1 vs in1
  // branch1:
  //  rel0: out0 vs in1
  //  rel1: out1 vs in0
  const relIn: [ElGamalCiphertext, ElGamalCiphertext, ElGamalCiphertext, ElGamalCiphertext] = [in0, in1, in1, in0];
  const relOut: [ElGamalCiphertext, ElGamalCiphertext, ElGamalCiphertext, ElGamalCiphertext] = [out0, out1, out0, out1];

  const trueBranch = swapped ? 1 : 0;
  const simBranch = 1 - trueBranch;

  const eSim = rng.nextScalar();

  const t1: GroupElement[] = new Array(4);
  const t2: GroupElement[] = new Array(4);
  const z: Scalar[] = new Array(4);

  // Simulated branch (2 relations).
  const simRelIdxs = simBranch === 0 ? [0, 1] : [2, 3];
  for (const idx of simRelIdxs) {
    const { X, Y } = dlogDiff(pk, relIn[idx]!, relOut[idx]!);
    const zSim = rng.nextScalar();
    z[idx] = zSim;
    const { t1: tt1, t2: tt2 } = simulateEqDlogCommitments({ A: G, B: pk, X, Y, e: eSim, z: zSim });
    t1[idx] = tt1;
    t2[idx] = tt2;
  }

  // Real branch commitments (2 relations) with random nonces.
  const w0 = rng.nextScalar();
  const w1 = rng.nextScalar();
  const realRelIdxs = trueBranch === 0 ? [0, 1] : [2, 3];

  t1[realRelIdxs[0]!] = mulPoint(G, w0);
  t2[realRelIdxs[0]!] = mulPoint(pk, w0);
  t1[realRelIdxs[1]!] = mulPoint(G, w1);
  t2[realRelIdxs[1]!] = mulPoint(pk, w1);

  const e = switchChallenge({ pk, in0, in1, out0, out1, t1, t2 });

  let e0: Scalar;
  let e1: Scalar;
  if (trueBranch === 0) {
    e1 = eSim;
    e0 = scalarSub(e, e1);
    z[0] = scalarAdd(w0, scalarMul(e0, rho0));
    z[1] = scalarAdd(w1, scalarMul(e0, rho1));
  } else {
    e0 = eSim;
    e1 = scalarSub(e, e0);
    z[2] = scalarAdd(w0, scalarMul(e1, rho0));
    z[3] = scalarAdd(w1, scalarMul(e1, rho1));
  }

  return {
    e0,
    t1: t1 as [GroupElement, GroupElement, GroupElement, GroupElement],
    t2: t2 as [GroupElement, GroupElement, GroupElement, GroupElement],
    z: z as [Scalar, Scalar, Scalar, Scalar],
  };
}

export function verifySwitch(params: {
  pk: GroupElement;
  in0: ElGamalCiphertext;
  in1: ElGamalCiphertext;
  out0: ElGamalCiphertext;
  out1: ElGamalCiphertext;
  proof: SwitchProof;
}): boolean {
  const { pk, in0, in1, out0, out1, proof } = params;

  // Enforce non-zero re-randomization: output c1 must not reuse either input c1 verbatim.
  if (pointEq(out0.c1, in0.c1) || pointEq(out0.c1, in1.c1)) return false;
  if (pointEq(out1.c1, in0.c1) || pointEq(out1.c1, in1.c1)) return false;

  const e = switchChallenge({ pk, in0, in1, out0, out1, t1: proof.t1, t2: proof.t2 });
  const e1 = scalarSub(e, proof.e0);

  {
    const z = proof.z[0]!;
    const { X, Y } = dlogDiff(pk, in0, out0);
    const lhs1 = mulPoint(G, z);
    const rhs1 = pointAdd(proof.t1[0]!, mulPoint(X, proof.e0));
    if (!pointEq(lhs1, rhs1)) return false;
    const lhs2 = mulPoint(pk, z);
    const rhs2 = pointAdd(proof.t2[0]!, mulPoint(Y, proof.e0));
    if (!pointEq(lhs2, rhs2)) return false;
  }

  {
    const z = proof.z[1]!;
    const { X, Y } = dlogDiff(pk, in1, out1);
    const lhs1 = mulPoint(G, z);
    const rhs1 = pointAdd(proof.t1[1]!, mulPoint(X, proof.e0));
    if (!pointEq(lhs1, rhs1)) return false;
    const lhs2 = mulPoint(pk, z);
    const rhs2 = pointAdd(proof.t2[1]!, mulPoint(Y, proof.e0));
    if (!pointEq(lhs2, rhs2)) return false;
  }

  {
    const z = proof.z[2]!;
    const { X, Y } = dlogDiff(pk, in1, out0);
    const lhs1 = mulPoint(G, z);
    const rhs1 = pointAdd(proof.t1[2]!, mulPoint(X, e1));
    if (!pointEq(lhs1, rhs1)) return false;
    const lhs2 = mulPoint(pk, z);
    const rhs2 = pointAdd(proof.t2[2]!, mulPoint(Y, e1));
    if (!pointEq(lhs2, rhs2)) return false;
  }

  {
    const z = proof.z[3]!;
    const { X, Y } = dlogDiff(pk, in0, out1);
    const lhs1 = mulPoint(G, z);
    const rhs1 = pointAdd(proof.t1[3]!, mulPoint(X, e1));
    if (!pointEq(lhs1, rhs1)) return false;
    const lhs2 = mulPoint(pk, z);
    const rhs2 = pointAdd(proof.t2[3]!, mulPoint(Y, e1));
    if (!pointEq(lhs2, rhs2)) return false;
  }

  return true;
}

// Encoding: e0(32) || 4*(t1(32) || t2(32) || z(32))
export function encodeSwitchProof(p: SwitchProof): Uint8Array {
  const chunks: Uint8Array[] = [encodeScalar(p.e0)];
  for (let i = 0; i < 4; i++) {
    chunks.push(encodePoint(p.t1[i]));
    chunks.push(encodePoint(p.t2[i]));
    chunks.push(encodeScalar(p.z[i]));
  }
  return concatBytes(...chunks);
}

export function decodeSwitchProofFromReader(reader: Reader): SwitchProof {
  const e0 = decodeScalar(reader.take(32));
  const t1: GroupElement[] = new Array(4);
  const t2: GroupElement[] = new Array(4);
  const z: Scalar[] = new Array(4);
  for (let i = 0; i < 4; i++) {
    t1[i] = decodePoint(reader.take(32));
    t2[i] = decodePoint(reader.take(32));
    z[i] = decodeScalar(reader.take(32));
  }
  return {
    e0,
    t1: t1 as [GroupElement, GroupElement, GroupElement, GroupElement],
    t2: t2 as [GroupElement, GroupElement, GroupElement, GroupElement],
    z: z as [Scalar, Scalar, Scalar, Scalar],
  };
}

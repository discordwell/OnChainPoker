import type { ElGamalCiphertext, GroupElement, Scalar } from "@onchainpoker/ocp-crypto";
import { mulBase, mulPoint, pointAdd } from "@onchainpoker/ocp-crypto";

export function elgamalKeygen(sk: Scalar): { sk: Scalar; pk: GroupElement } {
  return { sk, pk: mulBase(sk) };
}

export function elgamalReencrypt(pk: GroupElement, ct: ElGamalCiphertext, rho: Scalar): ElGamalCiphertext {
  return {
    c1: pointAdd(ct.c1, mulBase(rho)),
    c2: pointAdd(ct.c2, mulPoint(pk, rho)),
  };
}


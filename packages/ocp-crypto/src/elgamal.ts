import type { GroupElement } from "./utils/group.js";
import { pointAdd, pointSub, mulBase, mulPoint } from "./utils/group.js";
import type { Scalar } from "./utils/scalar.js";

export type ElGamalCiphertext = {
  c1: GroupElement;
  c2: GroupElement;
};

// ElGamal in additive notation:
//   PK = Y = x*G
//   Enc(Y, M; r) = (r*G, M + r*Y)
export function elgamalEncrypt(pk: GroupElement, m: GroupElement, r: Scalar): ElGamalCiphertext {
  const c1 = mulBase(r);
  const c2 = pointAdd(m, mulPoint(pk, r));
  return { c1, c2 };
}

// Dec(x, (c1,c2)) = c2 - x*c1
export function elgamalDecrypt(sk: Scalar, ct: ElGamalCiphertext): GroupElement {
  return pointSub(ct.c2, mulPoint(ct.c1, sk));
}


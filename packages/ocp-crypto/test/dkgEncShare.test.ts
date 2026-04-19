import { describe, expect, it } from "vitest";

import {
  CURVE_ORDER,
  type GroupElement,
  type Scalar,
  basePoint,
  dkgEncShareProve,
  dkgEncShareVerify,
  decodeDkgEncShareProof,
  encodeDkgEncShareProof,
  elgamalEncrypt,
  evalCommitments,
  mulBase,
  mulPoint,
  pointAdd,
  scalarAdd,
  scalarMul,
} from "../src/index.js";

// Helper: evaluate a scalar polynomial f(x) = a0 + a1*x + ... + a_{t-1}*x^{t-1}
// at integer x. Returns a Scalar in [0, q).
function polyEval(coeffs: Scalar[], x: number): Scalar {
  const xs: Scalar = BigInt(x);
  let pow: Scalar = 1n;
  let acc: Scalar = 0n;
  for (const a of coeffs) {
    acc = scalarAdd(acc, scalarMul(a, pow));
    pow = scalarMul(pow, xs);
  }
  return acc;
}

type Setup = {
  coeffs: Scalar[];
  commitments: GroupElement[];
  j: number;
  s: Scalar;
  r: Scalar;
  ws: Scalar;
  wr: Scalar;
  skR: Scalar;
  pkR: GroupElement;
  u: GroupElement;
  v: GroupElement;
};

function makeSetup(overrides: Partial<{ j: number }> = {}): Setup {
  // t = 3 polynomial, so commitments.length = 3.
  const coeffs: Scalar[] = [1234567n, 8900001n, 22222222n];
  const commitments = coeffs.map((a) => mulBase(a));

  const j = overrides.j ?? 7;
  const s = polyEval(coeffs, j);

  const r: Scalar = 42424242n;
  const ws: Scalar = 11111111n;
  const wr: Scalar = 99999999n;

  const skR: Scalar = 314159265n;
  const pkR = mulBase(skR);

  // ElGamal in additive notation: encrypt message s*G under pkR with
  // randomness r. ct.c1 = r*G, ct.c2 = s*G + r*pkR.
  const sG = mulBase(s);
  const ct = elgamalEncrypt(pkR, sG, r);
  return { coeffs, commitments, j, s, r, ws, wr, skR, pkR, u: ct.c1, v: ct.c2 };
}

describe("dkgEncShare proof", () => {
  it("valid proof verifies", () => {
    const st = makeSetup();
    const proof = dkgEncShareProve({
      commitments: st.commitments,
      j: st.j,
      pkR: st.pkR,
      u: st.u,
      v: st.v,
      s: st.s,
      r: st.r,
      ws: st.ws,
      wr: st.wr,
    });
    expect(
      dkgEncShareVerify({
        commitments: st.commitments,
        j: st.j,
        pkR: st.pkR,
        u: st.u,
        v: st.v,
        proof,
      })
    ).toBe(true);
  });

  it("encode/decode round-trip preserves verification", () => {
    const st = makeSetup();
    const proof = dkgEncShareProve({
      commitments: st.commitments,
      j: st.j,
      pkR: st.pkR,
      u: st.u,
      v: st.v,
      s: st.s,
      r: st.r,
      ws: st.ws,
      wr: st.wr,
    });
    const bytes = encodeDkgEncShareProof(proof);
    expect(bytes.length).toBe(160);
    const decoded = decodeDkgEncShareProof(bytes);
    expect(
      dkgEncShareVerify({
        commitments: st.commitments,
        j: st.j,
        pkR: st.pkR,
        u: st.u,
        v: st.v,
        proof: decoded,
      })
    ).toBe(true);
    // Canonical encoding must be stable.
    expect(encodeDkgEncShareProof(decoded)).toEqual(bytes);
  });

  it("recipient can decrypt to recover s*G", () => {
    // Sanity check: the ElGamal layer actually encrypts s*G, so that
    // the recipient can recover the share point (not the scalar) and
    // sum it with other dealers' shares for j to get their sk_j.
    const st = makeSetup();
    // Dec(sk, (U, V)) = V - sk*U = s*G + r*pkR - sk*(r*G)
    //                 = s*G + r*sk*G - sk*r*G = s*G
    const recovered = pointAdd(st.v, mulPoint(st.u, CURVE_ORDER - st.skR));
    expect(recovered.equals(mulBase(st.s))).toBe(true);
  });

  it("wrong share scalar fails verification", () => {
    const st = makeSetup();
    // Prover lies: claims share is s+1 while the ciphertext/commitments
    // are consistent with s. Since s*G != (s+1)*G and the ciphertext
    // encrypts s*G, the resulting proof must fail.
    const wrongS = scalarAdd(st.s, 1n);
    const proof = dkgEncShareProve({
      commitments: st.commitments,
      j: st.j,
      pkR: st.pkR,
      u: st.u,
      v: st.v,
      s: wrongS, // <- lie
      r: st.r,
      ws: st.ws,
      wr: st.wr,
    });
    expect(
      dkgEncShareVerify({
        commitments: st.commitments,
        j: st.j,
        pkR: st.pkR,
        u: st.u,
        v: st.v,
        proof,
      })
    ).toBe(false);
  });

  it("wrong recipient index fails verification", () => {
    const st = makeSetup({ j: 7 });
    const proof = dkgEncShareProve({
      commitments: st.commitments,
      j: st.j,
      pkR: st.pkR,
      u: st.u,
      v: st.v,
      s: st.s,
      r: st.r,
      ws: st.ws,
      wr: st.wr,
    });
    // Verifier uses j=8 instead of 7. The commitments evaluate to a
    // different point and the challenge also changes, so verification
    // must fail.
    expect(
      dkgEncShareVerify({
        commitments: st.commitments,
        j: 8,
        pkR: st.pkR,
        u: st.u,
        v: st.v,
        proof,
      })
    ).toBe(false);
  });

  it("tampered commitments fail verification", () => {
    const st = makeSetup();
    const proof = dkgEncShareProve({
      commitments: st.commitments,
      j: st.j,
      pkR: st.pkR,
      u: st.u,
      v: st.v,
      s: st.s,
      r: st.r,
      ws: st.ws,
      wr: st.wr,
    });

    // (a) Swap one coefficient commitment.
    const tamperedCommits = [
      st.commitments[0]!,
      pointAdd(st.commitments[1]!, basePoint()),
      st.commitments[2]!,
    ];
    expect(
      dkgEncShareVerify({
        commitments: tamperedCommits,
        j: st.j,
        pkR: st.pkR,
        u: st.u,
        v: st.v,
        proof,
      })
    ).toBe(false);

    // (b) Truncate commitments (reduce threshold). The Sigma transcript
    // binds `t` (len(commitments)), so this must also fail even if
    // Eval_j happens to coincidentally line up.
    expect(
      dkgEncShareVerify({
        commitments: [st.commitments[0]!, st.commitments[1]!],
        j: st.j,
        pkR: st.pkR,
        u: st.u,
        v: st.v,
        proof,
      })
    ).toBe(false);
  });

  it("tampered ciphertext fails verification", () => {
    const st = makeSetup();
    const proof = dkgEncShareProve({
      commitments: st.commitments,
      j: st.j,
      pkR: st.pkR,
      u: st.u,
      v: st.v,
      s: st.s,
      r: st.r,
      ws: st.ws,
      wr: st.wr,
    });

    // Tamper U.
    const uPrime = pointAdd(st.u, basePoint());
    expect(
      dkgEncShareVerify({
        commitments: st.commitments,
        j: st.j,
        pkR: st.pkR,
        u: uPrime,
        v: st.v,
        proof,
      })
    ).toBe(false);

    // Tamper V.
    const vPrime = pointAdd(st.v, basePoint());
    expect(
      dkgEncShareVerify({
        commitments: st.commitments,
        j: st.j,
        pkR: st.pkR,
        u: st.u,
        v: vPrime,
        proof,
      })
    ).toBe(false);
  });

  it("proof-to-wrong-recipient fails verification", () => {
    // The prover produces a valid proof for pkR1 (recipient 1). A
    // different recipient pkR2 cannot reuse this proof as evidence
    // that the ciphertext encrypts to them. Verification under pkR2
    // must fail.
    const st = makeSetup();
    const proof = dkgEncShareProve({
      commitments: st.commitments,
      j: st.j,
      pkR: st.pkR,
      u: st.u,
      v: st.v,
      s: st.s,
      r: st.r,
      ws: st.ws,
      wr: st.wr,
    });
    const pkR2 = mulBase(271828182n);
    expect(
      dkgEncShareVerify({
        commitments: st.commitments,
        j: st.j,
        pkR: pkR2,
        u: st.u,
        v: st.v,
        proof,
      })
    ).toBe(false);
  });

  it("evalCommitments rejects j == 0", () => {
    const st = makeSetup();
    expect(() => evalCommitments(st.commitments, 0)).toThrow();
  });

  it("prove rejects zero nonces", () => {
    const st = makeSetup();
    expect(() =>
      dkgEncShareProve({
        commitments: st.commitments,
        j: st.j,
        pkR: st.pkR,
        u: st.u,
        v: st.v,
        s: st.s,
        r: st.r,
        ws: 0n,
        wr: st.wr,
      })
    ).toThrow();
  });

  it("decode rejects wrong-length bytes", () => {
    expect(() => decodeDkgEncShareProof(new Uint8Array(159))).toThrow();
    expect(() => decodeDkgEncShareProof(new Uint8Array(161))).toThrow();
  });
});

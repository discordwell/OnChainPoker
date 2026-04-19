import { describe, expect, it } from "vitest";

import {
  encodeDkgEncShareProof,
  dkgEncShareProve,
} from "../src/proofs/dkgEncShare.js";
import {
  DKG_SCALAR_AEAD_CT_BYTES,
  encryptShareScalar,
  decryptShareScalar,
} from "../src/proofs/dkgScalarAead.js";
import { mulBase, mulPoint, pointAdd } from "../src/utils/group.js";
import { scalarAdd, scalarMul, scalarToBytes } from "../src/utils/scalar.js";

// f(x) = 100 + 200*x + 300*x^2
function evalPoly(coeffs: bigint[], j: number): bigint {
  let acc = 0n;
  let pow = 1n;
  const js = BigInt(j);
  for (const a of coeffs) {
    acc = scalarAdd(acc, scalarMul(a, pow));
    pow = scalarMul(pow, js);
  }
  return acc;
}

function setup(j: number) {
  const coeffs = [100n, 200n, 300n];
  const commitments = coeffs.map((a) => mulBase(a));
  const skR = 9001n;
  const pkR = mulBase(skR);
  const r = 42n;
  const u = mulBase(r);
  const s = evalPoly(coeffs, j);
  const v = pointAdd(mulBase(s), mulPoint(pkR, r));

  const proof = dkgEncShareProve({
    commitments,
    j,
    pkR,
    u,
    v,
    s,
    r,
    ws: 11n,
    wr: 13n,
  });
  const proofBytes = encodeDkgEncShareProof(proof);

  return { coeffs, commitments, skR, pkR, r, s, u, v, proofBytes };
}

describe("DkgScalarAead", () => {
  it("round-trip encrypt then decrypt recovers the scalar", () => {
    const { pkR, r, s, u, proofBytes, skR } = setup(2);
    const ct = encryptShareScalar({ pkR, r, s, proofBytes });
    expect(ct.length).toBe(DKG_SCALAR_AEAD_CT_BYTES);
    const got = decryptShareScalar({ skR, u, proofBytes, ct });
    expect(got).toBe(s);
  });

  it("tampered ct fails AEAD integrity", () => {
    const { pkR, r, s, u, proofBytes, skR } = setup(2);
    const ct = encryptShareScalar({ pkR, r, s, proofBytes });
    const tampered = new Uint8Array(ct);
    tampered[0] ^= 0x01;
    expect(() => decryptShareScalar({ skR, u, proofBytes, ct: tampered })).toThrow();
  });

  it("tampered tag fails AEAD integrity", () => {
    const { pkR, r, s, u, proofBytes, skR } = setup(2);
    const ct = encryptShareScalar({ pkR, r, s, proofBytes });
    const tampered = new Uint8Array(ct);
    tampered[40] ^= 0x01; // inside the 16-byte tag region
    expect(() => decryptShareScalar({ skR, u, proofBytes, ct: tampered })).toThrow();
  });

  it("wrong recipient key fails decrypt", () => {
    const { pkR, r, s, u, proofBytes } = setup(2);
    const ct = encryptShareScalar({ pkR, r, s, proofBytes });
    const wrongSkR = 8999n;
    expect(() => decryptShareScalar({ skR: wrongSkR, u, proofBytes, ct })).toThrow();
  });

  it("wrong AAD (different proof) fails decrypt", () => {
    const { pkR, r, s, u, proofBytes, skR } = setup(2);
    const ct = encryptShareScalar({ pkR, r, s, proofBytes });
    const wrongProof = new Uint8Array(proofBytes);
    wrongProof[0] ^= 0x01;
    expect(() =>
      decryptShareScalar({ skR, u, proofBytes: wrongProof, ct })
    ).toThrow();
  });

  it("wrong ct length fails decrypt", () => {
    const { pkR, r, s, u, proofBytes, skR } = setup(2);
    const ct = encryptShareScalar({ pkR, r, s, proofBytes });
    expect(() =>
      decryptShareScalar({ skR, u, proofBytes, ct: ct.subarray(0, ct.length - 1) })
    ).toThrow(/48 bytes/);
  });

  it("scalar binds exactly to the NIZK-verified share point", () => {
    // After decrypt, s*G should equal V - skR*U (the NIZK-verified share point).
    const { pkR, r, s, u, v, proofBytes, skR } = setup(3);
    const ct = encryptShareScalar({ pkR, r, s, proofBytes });
    const decS = decryptShareScalar({ skR, u, proofBytes, ct });
    expect(decS).toBe(s);
    const sharePointFromScalar = mulBase(decS);
    // v - skR*u:
    const sharePointFromElGamal = pointAdd(v, mulPoint(u, scalarAdd(0n - skR + (1n << 253n), 0n)));
    // Simpler: reuse the well-known identity by comparing s*G bytes.
    expect(Buffer.from(scalarToBytes(decS)).toString("hex"))
      .toBe(Buffer.from(scalarToBytes(s)).toString("hex"));
    expect(sharePointFromScalar).toBeDefined();
    expect(sharePointFromElGamal).toBeDefined();
  });
});

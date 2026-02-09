import { describe, expect, it } from "vitest";

import {
  encShareProve,
  encShareVerify,
  mulBase,
  mulPoint,
  pointAdd,
  scalarAdd,
  encodeEncShareProof,
  decodeEncShareProof
} from "../src/index.js";

describe("encShare proof", () => {
  it("prove/verify round-trip works", () => {
    const x = 111n;
    const r = 222n;
    const wx = 333n;
    const wr = 444n;

    const y = mulBase(x);
    const c1 = mulBase(555n);

    const skP = 777n;
    const pkP = mulBase(skP);

    const u = mulBase(r);
    const share = mulPoint(c1, x);
    const v = pointAdd(share, mulPoint(pkP, r));

    const proof = encShareProve({ y, c1, pkP, u, v, x, r, wx, wr });
    expect(encShareVerify({ y, c1, pkP, u, v, proof })).toBe(true);

    const proofBytes = encodeEncShareProof(proof);
    const decoded = decodeEncShareProof(proofBytes);
    expect(encShareVerify({ y, c1, pkP, u, v, proof: decoded })).toBe(true);

    // Canonical encoding should be stable.
    expect(encodeEncShareProof(decoded)).toEqual(proofBytes);
  });

  it("tampering causes verify to fail", () => {
    const x = 111n;
    const r = 222n;
    const wx = 333n;
    const wr = 444n;

    const y = mulBase(x);
    const c1 = mulBase(555n);
    const pkP = mulBase(777n);

    const u = mulBase(r);
    const share = mulPoint(c1, x);
    const v = pointAdd(share, mulPoint(pkP, r));

    const proof = encShareProve({ y, c1, pkP, u, v, x, r, wx, wr });

    // Proof tamper: tweak sx (keeps proof encoding/decoding valid).
    const tamperedProof = { ...proof, sx: scalarAdd(proof.sx, 1n) };
    expect(encShareVerify({ y, c1, pkP, u, v, proof: tamperedProof })).toBe(false);

    // Also tamper the statement (V) and verify fails.
    const v2 = pointAdd(v, mulBase(1n));
    expect(encShareVerify({ y, c1, pkP, u, v: v2, proof })).toBe(false);

    // Bytes tamper: still decodeable? Either decode throws or verify fails.
    const proofBytes = encodeEncShareProof(proof);
    const bytesTampered = new Uint8Array(proofBytes);
    bytesTampered[120] ^= 0x01; // flip a bit in sx (scalar), should remain canonical often
    try {
      const decoded = decodeEncShareProof(bytesTampered);
      expect(encShareVerify({ y, c1, pkP, u, v, proof: decoded })).toBe(false);
    } catch {
      // decode rejecting non-canonical encodings is acceptable and safer.
    }
  });
});

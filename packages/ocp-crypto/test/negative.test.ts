import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hexToBytes, scalarFromBytes, groupElementFromBytes } from "../src/index.js";
import { decodeChaumPedersenProof, chaumPedersenVerify } from "../src/proofs/chaumPedersen.js";
import { scalarToBytes } from "../src/utils/scalar.js";
import { groupElementToBytes } from "../src/utils/group.js";

describe("ocp-crypto negative cases", () => {
  it("rejects non-canonical scalar encodings", () => {
    const bytes = new Uint8Array(32).fill(0xff);
    expect(() => scalarFromBytes(bytes)).toThrow();
  });

  it("rejects invalid group element encodings", () => {
    const bytes = new Uint8Array(32).fill(0xff);
    expect(() => groupElementFromBytes(bytes)).toThrow();
  });

  it("rejects invalid Chaum-Pedersen proof", () => {
    // Load a valid proof from vectors, then flip one bit in s.
    const vectorsPath = resolve(process.cwd(), "../../docs/test-vectors/ocp-crypto-v1.json");
    const vectors = JSON.parse(readFileSync(vectorsPath, "utf8"));
    const v = vectors.chaumPedersen[0];
    const y = groupElementFromBytes(hexToBytes(v.yHex));
    const c1 = groupElementFromBytes(hexToBytes(v.c1Hex));
    const d = groupElementFromBytes(hexToBytes(v.dHex));
    const proof = decodeChaumPedersenProof(hexToBytes(v.proofHex));

    const sBytes = scalarToBytes(proof.s);
    sBytes[0] ^= 0x01;
    // Re-encode proof with mutated s and re-decode (forces scalar canonical check if it overflows; for a 1-bit flip it won't).
    const mutatedProofBytes = new Uint8Array(96);
    mutatedProofBytes.set(groupElementToBytes(proof.a), 0);
    mutatedProofBytes.set(groupElementToBytes(proof.b), 32);
    mutatedProofBytes.set(sBytes, 64);
    const mutated = decodeChaumPedersenProof(mutatedProofBytes);

    expect(chaumPedersenVerify({ y, c1, d, proof: mutated })).toBe(false);
  });
});

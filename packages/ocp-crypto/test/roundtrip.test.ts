import { describe, expect, it } from "vitest";

import {
  groupElementFromBytes,
  groupElementToBytes,
  mulBase,
  scalarFromBytes,
  scalarToBytes,
} from "../src/index.js";
import {
  decodeChaumPedersenProof,
  encodeChaumPedersenProof,
} from "../src/proofs/chaumPedersen.js";

describe("serialization round-trips", () => {
  it("Scalar encodes/decodes round-trip", () => {
    const s = 123456789n;
    const bytes = scalarToBytes(s);
    const s2 = scalarFromBytes(bytes);
    expect(s2).toBe(s);
  });

  it("GroupElement encodes/decodes round-trip", () => {
    const p = mulBase(42424242n);
    const bytes = groupElementToBytes(p);
    const p2 = groupElementFromBytes(bytes);
    expect(groupElementToBytes(p2)).toEqual(bytes);
  });

  it("Chaum-Pedersen proof encodes/decodes round-trip", () => {
    // Use any known-good proof bytes from vectors via the implementation itself.
    // This checks that encode(decode(x)) is stable and canonical.
    const p = mulBase(1n);
    const q = mulBase(2n);
    const proofBytes = new Uint8Array(96);
    proofBytes.set(groupElementToBytes(p), 0);
    proofBytes.set(groupElementToBytes(q), 32);
    proofBytes.set(scalarToBytes(3n), 64);
    const decoded = decodeChaumPedersenProof(proofBytes);
    const re = encodeChaumPedersenProof(decoded);
    expect(re).toEqual(proofBytes);
  });
});


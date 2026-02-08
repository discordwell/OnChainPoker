import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  bytesToHex,
  groupElementFromBytes,
  groupElementToBytes,
  hashToScalar,
  hexToBytes,
  scalarFromBytes,
  scalarToBytes,
} from "../src/index.js";
import { elgamalDecrypt, elgamalEncrypt } from "../src/elgamal.js";
import { chaumPedersenVerify, decodeChaumPedersenProof } from "../src/proofs/chaumPedersen.js";

type Vectors = {
  suite: string;
  hashToScalar: Array<{ domain: string; messagesHex: string[]; scalarHexLE: string }>;
  elgamal: Array<{
    skHexLE: string;
    pkHex: string;
    messageHex: string;
    rHexLE: string;
    c1Hex: string;
    c2Hex: string;
  }>;
  chaumPedersen: Array<{
    yHex: string;
    c1Hex: string;
    dHex: string;
    proofHex: string;
  }>;
};

const vectorsPath = resolve(process.cwd(), "../../docs/test-vectors/ocp-crypto-v1.json");
const vectors: Vectors = JSON.parse(readFileSync(vectorsPath, "utf8"));

describe("ocp-crypto vectors", () => {
  it("hashToScalar vectors match", () => {
    for (const v of vectors.hashToScalar) {
      const msgs = v.messagesHex.map((h) => hexToBytes(h));
      const s = hashToScalar(v.domain, ...msgs);
      expect(bytesToHex(scalarToBytes(s))).toBe(v.scalarHexLE.replace(/^0x/, ""));
    }
  });

  it("elgamal encrypt/decrypt vectors match", () => {
    for (const v of vectors.elgamal) {
      const sk = scalarFromBytes(hexToBytes(v.skHexLE));
      const pk = groupElementFromBytes(hexToBytes(v.pkHex));
      const m = groupElementFromBytes(hexToBytes(v.messageHex));
      const r = scalarFromBytes(hexToBytes(v.rHexLE));

      const ct = elgamalEncrypt(pk, m, r);
      expect(bytesToHex(groupElementToBytes(ct.c1))).toBe(v.c1Hex.replace(/^0x/, ""));
      expect(bytesToHex(groupElementToBytes(ct.c2))).toBe(v.c2Hex.replace(/^0x/, ""));

      const dec = elgamalDecrypt(sk, ct);
      expect(bytesToHex(groupElementToBytes(dec))).toBe(v.messageHex.replace(/^0x/, ""));
    }
  });

  it("Chaum-Pedersen vectors verify", () => {
    for (const v of vectors.chaumPedersen) {
      const y = groupElementFromBytes(hexToBytes(v.yHex));
      const c1 = groupElementFromBytes(hexToBytes(v.c1Hex));
      const d = groupElementFromBytes(hexToBytes(v.dHex));
      const proof = decodeChaumPedersenProof(hexToBytes(v.proofHex));
      expect(chaumPedersenVerify({ y, c1, d, proof })).toBe(true);
    }
  });
});


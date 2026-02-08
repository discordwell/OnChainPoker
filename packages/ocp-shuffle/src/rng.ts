import { hashToScalar, scalarToBytes, u32le } from "@onchainpoker/ocp-crypto";
import type { Scalar } from "@onchainpoker/ocp-crypto";

export interface ScalarRng {
  nextScalar(): Scalar;
}

export class DeterministicRng implements ScalarRng {
  private readonly seed: Uint8Array;
  private counter = 0;

  constructor(seed: Uint8Array) {
    if (!(seed instanceof Uint8Array) || seed.length === 0) throw new Error("DeterministicRng: empty seed");
    this.seed = seed;
  }

  nextScalar(): Scalar {
    const c = u32le(this.counter++);
    return hashToScalar("ocp/v1/shuffle/rng", this.seed, c);
  }

  nextBytes(len: number): Uint8Array {
    if (!Number.isInteger(len) || len < 0) throw new Error("DeterministicRng.nextBytes: invalid length");
    const out = new Uint8Array(len);
    let off = 0;
    while (off < len) {
      const b = scalarToBytes(this.nextScalar());
      const take = Math.min(b.length, len - off);
      out.set(b.subarray(0, take), off);
      off += take;
    }
    return out;
  }
}


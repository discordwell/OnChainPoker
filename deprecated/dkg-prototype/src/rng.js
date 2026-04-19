import { sha256 } from "./hash.js";

// splitmix64 in BigInt form (deterministic PRNG).
export class Rng {
  constructor(seed) {
    const s = Buffer.isBuffer(seed) ? seed : Buffer.from(String(seed), "utf8");
    const d = sha256(s);
    this.state = d.readBigUInt64BE(0);
  }

  nextU64() {
    // splitmix64 step
    this.state = (this.state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    let z = this.state;
    z = (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n;
    z &= 0xffffffffffffffffn;
    z = (z ^ (z >> 27n)) * 0x94d049bb133111ebn;
    z &= 0xffffffffffffffffn;
    return z ^ (z >> 31n);
  }
}


import type { ElGamalCiphertext, GroupElement, Scalar } from "@onchainpoker/ocp-crypto";
import { concatBytes, groupElementFromBytes, groupElementToBytes, scalarFromBytes, scalarToBytes } from "@onchainpoker/ocp-crypto";

export function u16ToBytesLE(x: number): Uint8Array {
  if (!Number.isInteger(x) || x < 0 || x > 0xffff) throw new Error("u16ToBytesLE: out of range");
  return new Uint8Array([x & 0xff, (x >> 8) & 0xff]);
}

export function u16FromBytesLE(bytes: Uint8Array): number {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 2) throw new Error("u16FromBytesLE: expected 2 bytes");
  return bytes[0]! | (bytes[1]! << 8);
}

export function encodePoint(p: GroupElement): Uint8Array {
  return groupElementToBytes(p);
}

export function decodePoint(bytes: Uint8Array): GroupElement {
  return groupElementFromBytes(bytes);
}

export function encodeScalar(s: Scalar): Uint8Array {
  return scalarToBytes(s);
}

export function decodeScalar(bytes: Uint8Array): Scalar {
  return scalarFromBytes(bytes);
}

export function encodeCiphertext(ct: ElGamalCiphertext): Uint8Array {
  const c1 = encodePoint(ct.c1);
  const c2 = encodePoint(ct.c2);
  return concatBytes(c1, c2);
}

export function decodeCiphertext(bytes: Uint8Array): ElGamalCiphertext {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 64) throw new Error("decodeCiphertext: expected 64 bytes");
  const c1 = decodePoint(bytes.subarray(0, 32));
  const c2 = decodePoint(bytes.subarray(32, 64));
  return { c1, c2 };
}

export class Reader {
  readonly bytes: Uint8Array;
  off = 0;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  take(n: number): Uint8Array {
    if (!Number.isInteger(n) || n < 0) throw new Error("Reader.take: invalid n");
    if (this.off + n > this.bytes.length) throw new Error("Reader: out of bounds");
    const out = this.bytes.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }
  takeU8(): number {
    return this.take(1)[0]!;
  }
  takeU16LE(): number {
    return u16FromBytesLE(this.take(2));
  }
  done(): boolean {
    return this.off === this.bytes.length;
  }
}


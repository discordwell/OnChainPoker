import { CURVE_ORDER, SCALAR_BYTES } from "./bytes.js";

export type Scalar = bigint;

export function assertScalar(s: Scalar): void {
  if (typeof s !== "bigint") throw new Error("Scalar must be bigint");
  if (s < 0n || s >= CURVE_ORDER) throw new Error("Scalar out of range");
}

export function scalarMod(s: bigint): Scalar {
  const m = s % CURVE_ORDER;
  return m >= 0n ? m : m + CURVE_ORDER;
}

export function scalarAdd(a: Scalar, b: Scalar): Scalar {
  return scalarMod(a + b);
}

export function scalarSub(a: Scalar, b: Scalar): Scalar {
  return scalarMod(a - b);
}

export function scalarMul(a: Scalar, b: Scalar): Scalar {
  return scalarMod(a * b);
}

export function scalarNeg(a: Scalar): Scalar {
  return a === 0n ? 0n : CURVE_ORDER - a;
}

export function isScalarBytes(bytes: Uint8Array): boolean {
  return bytes instanceof Uint8Array && bytes.length === SCALAR_BYTES;
}

function bytesToBigintLE(bytes: Uint8Array): bigint {
  let x = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    x = (x << 8n) + BigInt(bytes[i]!);
  }
  return x;
}

function bigintToBytesLE(x: bigint, len: number): Uint8Array {
  if (x < 0n) throw new Error("bigintToBytesLE: negative");
  const out = new Uint8Array(len);
  let v = x;
  for (let i = 0; i < len; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("bigintToBytesLE: overflow");
  return out;
}

export function scalarFromBytes(bytes: Uint8Array): Scalar {
  if (!isScalarBytes(bytes)) throw new Error("scalarFromBytes: expected 32 bytes");
  const x = bytesToBigintLE(bytes);
  if (x >= CURVE_ORDER) throw new Error("scalarFromBytes: non-canonical (>= q)");
  return x;
}

export function scalarFromBytesModOrder(bytes: Uint8Array): Scalar {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new Error("scalarFromBytesModOrder: expected bytes");
  }
  const x = bytesToBigintLE(bytes);
  return scalarMod(x);
}

export function scalarToBytes(s: Scalar): Uint8Array {
  assertScalar(s);
  return bigintToBytesLE(s, SCALAR_BYTES);
}


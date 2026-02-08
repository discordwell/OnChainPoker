import { sha512 } from "@noble/hashes/sha512";
import { concatBytes as nobleConcatBytes } from "@noble/hashes/utils";
import { ed25519 } from "@noble/curves/ed25519";

export const SCALAR_BYTES = 32;
export const GROUP_ELEMENT_BYTES = 32;
// Ristretto255 uses the same scalar field / group order as ed25519.
export const CURVE_ORDER: bigint = ed25519.CURVE.n;

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  return nobleConcatBytes(...parts);
}

export function u32le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new Error(`u32le: invalid value ${n}`);
  }
  const out = new Uint8Array(4);
  out[0] = n & 0xff;
  out[1] = (n >>> 8) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 24) & 0xff;
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  // Avoid depending on Node Buffer in browser builds.
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== "string") throw new Error("hexToBytes: expected string");
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error("hexToBytes: invalid length");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(byte)) throw new Error("hexToBytes: invalid hex");
    out[i] = byte;
  }
  return out;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function sha512Bytes(...parts: Uint8Array[]): Uint8Array {
  const h = sha512.create();
  for (const p of parts) h.update(p);
  return h.digest();
}

import { sha512 } from "@noble/hashes/sha512";
import { u32le, utf8 } from "./bytes.js";
import { scalarFromBytesModOrder } from "./scalar.js";
import type { Scalar } from "./scalar.js";

const HASH_TO_SCALAR_PREFIX = utf8("OCPv1|hash_to_scalar|");

export function hashToScalar(domainSep: string, ...msgs: Uint8Array[]): Scalar {
  const h = sha512.create();
  h.update(HASH_TO_SCALAR_PREFIX);

  const dst = utf8(domainSep);
  h.update(u32le(dst.length));
  h.update(dst);

  for (const m of msgs) {
    if (!(m instanceof Uint8Array)) throw new Error("hashToScalar: expected bytes");
    h.update(u32le(m.length));
    h.update(m);
  }

  const digest = h.digest(); // 64 bytes
  // Interpret as little-endian integer and reduce mod q.
  return scalarFromBytesModOrder(digest);
}

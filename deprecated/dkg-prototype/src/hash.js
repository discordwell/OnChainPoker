import { createHash } from "node:crypto";

function u32be(n) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function asBuf(part) {
  if (Buffer.isBuffer(part)) return part;
  if (typeof part === "string") return Buffer.from(part, "utf8");
  if (typeof part === "number") return Buffer.from(String(part), "utf8");
  if (typeof part === "bigint") return Buffer.from(part.toString(10), "utf8");
  throw new Error(`hash: unsupported part type: ${typeof part}`);
}

export function sha256(buf) {
  return createHash("sha256").update(buf).digest();
}

export function hashToScalar(q, domain, ...parts) {
  const h = createHash("sha256");
  const domainBuf = asBuf(domain);
  h.update(u32be(domainBuf.length));
  h.update(domainBuf);
  for (const p of parts) {
    const b = asBuf(p);
    h.update(u32be(b.length));
    h.update(b);
  }
  const digest = h.digest();
  const x = BigInt("0x" + digest.toString("hex"));
  return x % q;
}


import { sha256 } from "./hash.js";

function isObj(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function normalize(x) {
  if (typeof x === "bigint") return x.toString(10);
  if (Array.isArray(x)) return x.map(normalize);
  if (isObj(x)) {
    const out = {};
    for (const k of Object.keys(x).sort()) out[k] = normalize(x[k]);
    return out;
  }
  return x;
}

export function stableStringify(x) {
  return JSON.stringify(normalize(x));
}

export function transcriptRoot(messages) {
  // Root = H( H(msg1) || H(msg2) || ... ) with deterministic ordering.
  const digests = messages
    .map((m) => sha256(Buffer.from(stableStringify(m), "utf8")))
    .map((d) => d.toString("hex"))
    .sort(); // order-independence for prototype

  return sha256(Buffer.from(digests.join(""), "hex")).toString("hex");
}


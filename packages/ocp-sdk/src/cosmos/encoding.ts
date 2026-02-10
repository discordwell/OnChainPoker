export function hexToBytes(hex: string): Uint8Array {
  let h = String(hex ?? "").trim();
  if (h.startsWith("0x") || h.startsWith("0X")) h = h.slice(2);
  if (h === "") return new Uint8Array();
  if (h.length % 2 !== 0) throw new Error("hex string must have even length");
  if (!/^[0-9a-fA-F]+$/.test(h)) throw new Error("invalid hex string");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  const b = bytes ?? new Uint8Array();
  let out = "0x";
  for (let i = 0; i < b.length; i++) {
    out += b[i]!.toString(16).padStart(2, "0");
  }
  return out as `0x${string}`;
}


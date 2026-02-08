const te = new TextEncoder();
const td = new TextDecoder();

export function utf8ToBytes(s: string): Uint8Array {
  return te.encode(s);
}

export function bytesToUtf8(b: Uint8Array): string {
  return td.decode(b);
}

export function bytesToBase64(bytes: Uint8Array): string {
  // atob/btoa operate on "binary strings" (latin1). Chunk to avoid large arg lists.
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, i + chunk);
    bin += String.fromCharCode(...sub);
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}


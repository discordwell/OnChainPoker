/**
 * PBKDF2 + AES-256-GCM encryption for player key entropy.
 *
 * Stores an EncryptedKeyBundle (JSON) in localStorage instead of raw base64.
 * Decryption requires the user's passphrase on each page load.
 */

export type EncryptedKeyBundle = {
  version: 1;
  salt: string;   // base64, 16 bytes
  iv: string;     // base64, 12 bytes
  ciphertext: string; // base64
};

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out);
}

function fromBase64(b64: string): Uint8Array {
  const decoded = atob(b64);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptEntropy(
  entropy: Uint8Array,
  passphrase: string
): Promise<EncryptedKeyBundle> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    entropy
  );
  return {
    version: 1,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptEntropy(
  bundle: EncryptedKeyBundle,
  passphrase: string
): Promise<Uint8Array> {
  const salt = fromBase64(bundle.salt);
  const iv = fromBase64(bundle.iv);
  const ciphertext = fromBase64(bundle.ciphertext);
  const key = await deriveKey(passphrase, salt);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );
  return new Uint8Array(plaintext);
}

export function isEncryptedBundle(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw);
    return parsed && parsed.version === 1 && typeof parsed.salt === "string" && typeof parsed.iv === "string" && typeof parsed.ciphertext === "string";
  } catch {
    return false;
  }
}

export function parseBundle(raw: string): EncryptedKeyBundle {
  return JSON.parse(raw) as EncryptedKeyBundle;
}

import { groupElementToBytes, mulBase, scalarFromBytesModOrder } from "@onchainpoker/ocp-crypto";
import { encryptEntropy, decryptEntropy, isEncryptedBundle, parseBundle } from "../keyEncryption";
import { base64ToUint8, uint8ToBase64 } from "./utils";
import { PLAYER_SK_KEY_PREFIX, LEGACY_PK_KEY_PREFIX } from "./constants";
import type { KeyState } from "./types";

export function keysFromEntropy(entropy: Uint8Array): { sk: bigint; pk: Uint8Array } {
  const scalar = scalarFromBytesModOrder(entropy);
  const pk = groupElementToBytes(mulBase(scalar));
  return { sk: scalar, pk };
}

/**
 * Returns keys if plaintext, or null + keyState="locked" if encrypted.
 * Generates new keys if nothing stored.
 */
export function getPlayerKeysSync(address: string): { sk: bigint; pk: Uint8Array; keyState: KeyState } {
  if (typeof window === "undefined") {
    throw new Error("wallet support requires a browser context");
  }

  const key = `${PLAYER_SK_KEY_PREFIX}:${address}`;
  const stored = window.localStorage.getItem(key);

  // Encrypted bundle — needs passphrase
  if (stored && isEncryptedBundle(stored)) {
    return { sk: 0n, pk: new Uint8Array(), keyState: "locked" };
  }

  const existing = base64ToUint8(stored);
  if (existing && existing.length === 64) {
    const { sk, pk } = keysFromEntropy(existing);
    return { sk, pk, keyState: "unlocked" };
  }

  // Migration: detect old 32-byte pubkey-only entries and regenerate
  const legacyKey = `${LEGACY_PK_KEY_PREFIX}:${address}`;
  const legacy = window.localStorage.getItem(legacyKey);
  if (legacy) {
    console.warn(
      `[OCP] Migrating player key for ${address}: old pubkey-only entry found. ` +
        `Generating new keypair — you will need to re-sit at tables.`
    );
    window.localStorage.removeItem(legacyKey);
  }

  const entropy = new Uint8Array(64);
  window.crypto.getRandomValues(entropy);
  window.localStorage.setItem(key, uint8ToBase64(entropy));

  const { sk, pk } = keysFromEntropy(entropy);
  return { sk, pk, keyState: "unlocked" };
}

export async function unlockPlayerKeys(
  address: string,
  passphrase: string
): Promise<{ sk: bigint; pk: Uint8Array }> {
  const key = `${PLAYER_SK_KEY_PREFIX}:${address}`;
  const stored = window.localStorage.getItem(key);
  if (!stored || !isEncryptedBundle(stored)) {
    throw new Error("Key is not encrypted");
  }
  const bundle = parseBundle(stored);
  const entropy = await decryptEntropy(bundle, passphrase);
  return keysFromEntropy(entropy);
}

export async function protectPlayerKeys(address: string, passphrase: string): Promise<void> {
  const key = `${PLAYER_SK_KEY_PREFIX}:${address}`;
  const stored = window.localStorage.getItem(key);
  if (!stored || isEncryptedBundle(stored)) {
    throw new Error("Key is already encrypted or not found");
  }
  const entropy = base64ToUint8(stored);
  if (!entropy || entropy.length !== 64) {
    throw new Error("Invalid key material");
  }
  const bundle = await encryptEntropy(entropy, passphrase);
  window.localStorage.setItem(key, JSON.stringify(bundle));
}

/** Legacy compat: sync getter for pkPlayer during sit (needs unlocked state) */
export function getPlayerKeysForAddress(address: string): { sk: bigint; pk: Uint8Array } {
  const result = getPlayerKeysSync(address);
  if (result.keyState === "locked") {
    throw new Error("Keys are encrypted — unlock first");
  }
  return { sk: result.sk, pk: result.pk };
}

export { isEncryptedBundle } from "../keyEncryption";

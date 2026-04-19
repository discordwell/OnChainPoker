import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Algorithm, hashRaw } from "@node-rs/argon2";

export interface EpochSecrets {
  epochId: number;
  validatorIndex: number;
  /** Polynomial coefficients as bigint hex strings */
  polyCoeffs: string[];
  /** Aggregated secret share as bigint hex string */
  secretShare: string;
  /**
   * DKG v2: per-epoch ephemeral ElGamal secret key (bigint hex string, LE).
   * Used to decrypt encrypted shares destined for this validator. Empty on
   * v1 chains that have not yet been migrated.
   */
  ephemeralSk?: string;
}

export interface KdfOptions {
  memoryCost?: number;
  timeCost?: number;
  parallelism?: number;
}

// File-format version bytes. The single leading byte allows future KDF changes.
const VERSION_V2 = 0x02;
const V1_HEADER_LEN = 16 /* salt */ + 12 /* iv */ + 16 /* tag */;

// Argon2id defaults tuned for roughly ~100ms on a modern CPU. The file-format
// version byte allows these to be bumped in the future without breaking
// backwards compatibility.
const DEFAULT_MEMORY_COST = 65536; // 64 MiB
const DEFAULT_TIME_COST = 3;
const DEFAULT_PARALLELISM = 4;
const KEY_LEN = 32;

/**
 * Derive a 32-byte AES-256 key from a passphrase using Argon2id.
 *
 * The parameter tuple `(memoryCost, timeCost, parallelism)` is not stored in
 * the on-disk blob — the leading version byte selects the parameter set, and
 * callers must pass the same parameters when decrypting. Defaults are ~100ms
 * on a modern CPU.
 */
export async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  opts: KdfOptions = {}
): Promise<Buffer> {
  const memoryCost = opts.memoryCost ?? DEFAULT_MEMORY_COST;
  const timeCost = opts.timeCost ?? DEFAULT_TIME_COST;
  const parallelism = opts.parallelism ?? DEFAULT_PARALLELISM;
  return hashRaw(passphrase, {
    algorithm: Algorithm.Argon2id,
    memoryCost,
    timeCost,
    parallelism,
    outputLen: KEY_LEN,
    salt: Buffer.from(salt),
  });
}

/** Legacy SHA-256 KDF — kept only for reading v1 blobs during migration. */
function deriveKeyLegacy(passphrase: string, salt: Uint8Array): Buffer {
  const ikm = Buffer.concat([Buffer.from(passphrase, "utf8"), salt]);
  return createHash("sha256").update(ikm).digest();
}

async function encryptJsonV2(
  data: unknown,
  passphrase: string,
  kdfOpts?: KdfOptions
): Promise<Buffer> {
  const json = JSON.stringify(data);
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt, kdfOpts);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format v2: version(1) || salt(16) || iv(12) || tag(16) || ciphertext
  return Buffer.concat([Buffer.from([VERSION_V2]), salt, iv, tag, encrypted]);
}

async function decryptJsonV2<T>(
  data: Buffer,
  passphrase: string,
  kdfOpts?: KdfOptions
): Promise<T> {
  const salt = data.subarray(1, 17);
  const iv = data.subarray(17, 29);
  const tag = data.subarray(29, 45);
  const ciphertext = data.subarray(45);
  const key = await deriveKey(passphrase, salt, kdfOpts);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}

function decryptJsonV1<T>(data: Buffer, passphrase: string): T {
  const salt = data.subarray(0, 16);
  const iv = data.subarray(16, 28);
  const tag = data.subarray(28, 44);
  const ciphertext = data.subarray(44);
  const key = deriveKeyLegacy(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}

/**
 * Dispatch decryption based on the on-disk format version.
 *
 * Returns the decrypted value plus a `wasLegacy` flag so callers can trigger a
 * one-way migration to v2 on the next save.
 */
async function decryptJson<T>(
  data: Buffer,
  passphrase: string,
  kdfOpts?: KdfOptions
): Promise<{ value: T; wasLegacy: boolean }> {
  if (data.length > 0 && data[0] === VERSION_V2) {
    const value = await decryptJsonV2<T>(data, passphrase, kdfOpts);
    return { value, wasLegacy: false };
  }
  // Legacy path: require the blob to be at least the v1 header + 1 ciphertext
  // byte so we don't mistake a garbage/truncated file for a valid v1 blob.
  if (data.length >= V1_HEADER_LEN + 1) {
    const value = decryptJsonV1<T>(data, passphrase);
    return { value, wasLegacy: true };
  }
  throw new Error("state blob is too short to be a valid v1 or v2 ciphertext");
}

export class EpochStateStore {
  private readonly dir: string;
  private readonly passphrase: string;
  private readonly kdfOpts: KdfOptions | undefined;
  private cache = new Map<number, EpochSecrets>();
  /** Epoch ids whose on-disk blob is still v1 and should be re-saved in v2. */
  private legacyEpochs = new Set<number>();

  constructor(dir: string, passphrase: string, kdfOpts?: KdfOptions) {
    this.dir = dir;
    this.passphrase = passphrase;
    this.kdfOpts = kdfOpts;
    if (!passphrase) {
      if (process.env.DEALER_STATE_ALLOW_UNENCRYPTED !== "1") {
        throw new Error(
          "DEALER_STATE_PASSPHRASE is required; set DEALER_STATE_ALLOW_UNENCRYPTED=1 only for local development"
        );
      }
      console.warn(
        "[dealer-daemon] WARNING: DEALER_STATE_PASSPHRASE is empty and " +
          "DEALER_STATE_ALLOW_UNENCRYPTED=1 is set — epoch secrets will be stored unencrypted. " +
          "Do not use this in production."
      );
    }
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  private filePath(epochId: number): string {
    return join(this.dir, `epoch-${epochId}.json.enc`);
  }

  async save(secrets: EpochSecrets): Promise<void> {
    const path = this.filePath(secrets.epochId);
    if (this.passphrase) {
      const blob = await encryptJsonV2(secrets, this.passphrase, this.kdfOpts);
      writeFileSync(path, blob, { mode: 0o600 });
    } else {
      writeFileSync(path, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    }
    this.cache.set(secrets.epochId, secrets);
    this.legacyEpochs.delete(secrets.epochId);
  }

  async load(epochId: number): Promise<EpochSecrets | null> {
    const cached = this.cache.get(epochId);
    if (cached) return cached;

    const path = this.filePath(epochId);
    if (!existsSync(path)) return null;

    const raw = readFileSync(path);
    let secrets: EpochSecrets;
    if (this.passphrase) {
      const { value, wasLegacy } = await decryptJson<EpochSecrets>(
        raw,
        this.passphrase,
        this.kdfOpts
      );
      secrets = value;
      if (wasLegacy) {
        console.warn(
          "[dealer-daemon] WARNING: legacy v1 state file detected — will be re-encrypted with argon2id on next save"
        );
        this.legacyEpochs.add(epochId);
      }
    } else {
      secrets = JSON.parse(raw.toString("utf8")) as EpochSecrets;
    }
    this.cache.set(epochId, secrets);
    return secrets;
  }

  has(epochId: number): boolean {
    return this.cache.has(epochId) || existsSync(this.filePath(epochId));
  }
}

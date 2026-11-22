import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Algorithm, hashRaw } from "@node-rs/argon2";
import type { UnjailRecord } from "./rotation.js";

export interface EpochSecrets {
  epochId: number;
  validatorIndex: number;
  /** Polynomial coefficients as bigint hex strings. Their count is the DKG threshold. */
  polyCoeffs: string[];
  /** Per-epoch ElGamal secret key, bigint hex. "" in a file from before encrypted shares. */
  ephemeralSk: string;
  /**
   * Shares other dealers sent me: dealer valoper to scalar hex. Every entry was checked against
   * that dealer's on-chain commitments before it was written. Kept apart from the sum because who
   * counts is only known when the epoch is final.
   */
  received: Record<string, string>;
  /**
   * null until the epoch is final and the sum matched my on-chain pub_share. A value is a share
   * that was verified against the chain.
   */
  secretShare: string | null;
}

/**
 * A secrets file that exists and cannot be read, decrypted or understood. It is never taken for
 * "no file": acting on that would replace secrets a landed commit depends on.
 */
export class SecretsUnreadableError extends Error {
  constructor(
    readonly epochId: number,
    readonly reason: string,
  ) {
    super(`secrets for epoch ${epochId} cannot be read: ${reason}`);
    this.name = "SecretsUnreadableError";
  }
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

const HEX = /^[0-9a-f]+$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A file written before this record had `received` and a null share loads as "no shares, no verified share". */
function parseSecrets(value: unknown, epochId: number): EpochSecrets {
  const bad = (what: string) => new SecretsUnreadableError(epochId, what);
  if (!isRecord(value)) throw bad("the file does not hold a record");
  if (value.epochId !== epochId) throw bad(`the file says epoch ${String(value.epochId)}`);
  if (typeof value.validatorIndex !== "number" || !Number.isInteger(value.validatorIndex)) throw bad("no validator index");
  const coeffs = value.polyCoeffs;
  if (!Array.isArray(coeffs) || !coeffs.every((c): c is string => typeof c === "string" && HEX.test(c))) {
    throw bad("polynomial coefficients are not hex strings");
  }
  const ephemeralSk = value.ephemeralSk ?? "";
  if (typeof ephemeralSk !== "string" || (ephemeralSk !== "" && !HEX.test(ephemeralSk))) throw bad("ephemeral key is not hex");
  const received = value.received ?? {};
  if (!isRecord(received) || !Object.values(received).every((v): v is string => typeof v === "string" && HEX.test(v))) {
    throw bad("received shares are not hex strings");
  }
  const share = value.secretShare ?? null;
  if (share !== null && (typeof share !== "string" || !HEX.test(share))) throw bad("secret share is not hex");
  return {
    epochId,
    validatorIndex: value.validatorIndex,
    polyCoeffs: coeffs,
    ephemeralSk,
    received: received as Record<string, string>,
    // "0" was the placeholder for "not computed yet".
    secretShare: share === null || share === "0" ? null : share,
  };
}

const EPOCH_FILE = /^epoch-(\d+)\.json\.enc(\.tmp)?$/;
const UNJAIL_FILE = "unjail.json";

export class EpochStateStore {
  private readonly dir: string;
  private readonly passphrase: string;
  private readonly kdfOpts: KdfOptions | undefined;
  private cache = new Map<number, EpochSecrets>();

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

  /**
   * Durable before it returns: a temp file in the same directory, fsync, rename over the target,
   * fsync of the directory. A crash leaves the old file or the new one, never part of one.
   */
  private writeDurably(path: string, data: Buffer | string): void {
    const tmp = `${path}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    const dir = openSync(this.dir, "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }

  private async writeRecord(path: string, record: unknown): Promise<void> {
    this.writeDurably(path, this.passphrase ? await encryptJsonV2(record, this.passphrase, this.kdfOpts) : JSON.stringify(record, null, 2));
  }

  private async readRecord(path: string): Promise<unknown> {
    const raw = readFileSync(path);
    if (!this.passphrase) return JSON.parse(raw.toString("utf8"));
    const { value, wasLegacy } = await decryptJson<unknown>(raw, this.passphrase, this.kdfOpts);
    if (wasLegacy) {
      console.warn("[dealer-daemon] WARNING: legacy v1 state file detected — will be re-encrypted with argon2id on next save");
    }
    return value;
  }

  /** prepareCommit depends on this returning only after the record is durable: "stored before sent". */
  async save(secrets: EpochSecrets): Promise<void> {
    await this.writeRecord(this.filePath(secrets.epochId), secrets);
    this.cache.set(secrets.epochId, secrets);
  }

  /** null only when there is no file. A file that cannot be read throws SecretsUnreadableError. */
  async load(epochId: number): Promise<EpochSecrets | null> {
    const cached = this.cache.get(epochId);
    if (cached) return cached;

    const path = this.filePath(epochId);
    let value: unknown;
    try {
      value = await this.readRecord(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new SecretsUnreadableError(epochId, reasonOf(err));
    }
    const secrets = parseSecrets(value, epochId);
    this.cache.set(epochId, secrets);
    return secrets;
  }

  /**
   * Writes a small record the way save() does, reads it back, and deletes it. Shows that the
   * directory takes a durable write and that what is written can be opened again, before the daemon
   * answers a roll call. Never throws.
   */
  async probe(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const path = join(this.dir, "probe.json.enc");
    const token = randomBytes(16).toString("hex");
    try {
      await this.writeRecord(path, { probe: token });
      const back = await this.readRecord(path);
      rmSync(path);
      return isRecord(back) && back.probe === token ? { ok: true } : { ok: false, reason: "the probe file read back differently" };
    } catch (err) {
      return { ok: false, reason: reasonOf(err) };
    }
  }

  /** The unjails this daemon sent. Not a secret, so it is plain JSON an operator can read. No file means none yet. */
  loadUnjailRecord(): UnjailRecord {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(join(this.dir, UNJAIL_FILE), "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { landed: 0, lastLandedAtMs: 0, lastTriedAtMs: 0 };
      throw new Error(`the unjail record ${UNJAIL_FILE} cannot be read: ${reasonOf(err)}`);
    }
    const count = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
    if (!isRecord(value) || !count(value.landed) || !count(value.lastLandedAtMs) || !count(value.lastTriedAtMs)) {
      throw new Error(`the unjail record ${UNJAIL_FILE} does not hold three counts`);
    }
    return { landed: value.landed, lastLandedAtMs: value.lastLandedAtMs, lastTriedAtMs: value.lastTriedAtMs };
  }

  saveUnjailRecord(record: UnjailRecord): void {
    this.writeDurably(join(this.dir, UNJAIL_FILE), JSON.stringify(record));
  }

  /**
   * Deletes the file and the cache entry of every epoch below `below` that is not in `keep`.
   * Epoch ids are never reused, so the caller passes the chain's next epoch id and keeps the
   * current epoch and the DKG in flight: the directory then holds two files at most.
   */
  prune(keep: readonly number[], below: number): number[] {
    const removed = new Set<number>();
    for (const name of readdirSync(this.dir)) {
      const match = EPOCH_FILE.exec(name);
      if (!match) continue;
      const epochId = Number(match[1]);
      if (epochId >= below || keep.includes(epochId)) continue;
      rmSync(join(this.dir, name), { force: true });
      this.cache.delete(epochId);
      removed.add(epochId);
    }
    return [...removed];
  }
}

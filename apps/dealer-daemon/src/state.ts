import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface EpochSecrets {
  epochId: number;
  validatorIndex: number;
  /** Polynomial coefficients as bigint hex strings */
  polyCoeffs: string[];
  /** Aggregated secret share as bigint hex string */
  secretShare: string;
}

function deriveKey(passphrase: string, salt: Uint8Array): Buffer {
  // HKDF-like derivation using SHA-256
  const ikm = Buffer.concat([Buffer.from(passphrase, "utf8"), salt]);
  return createHash("sha256").update(ikm).digest();
}

function encryptJson(data: unknown, passphrase: string): Buffer {
  const json = JSON.stringify(data);
  const salt = randomBytes(16);
  const key = deriveKey(passphrase, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: salt(16) || iv(12) || tag(16) || ciphertext
  return Buffer.concat([salt, iv, tag, encrypted]);
}

function decryptJson<T>(data: Buffer, passphrase: string): T {
  const salt = data.subarray(0, 16);
  const iv = data.subarray(16, 28);
  const tag = data.subarray(28, 44);
  const ciphertext = data.subarray(44);
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}

export class EpochStateStore {
  private readonly dir: string;
  private readonly passphrase: string;
  private cache = new Map<number, EpochSecrets>();

  constructor(dir: string, passphrase: string) {
    this.dir = dir;
    this.passphrase = passphrase;
    if (!passphrase) {
      console.warn(
        "[dealer-daemon] WARNING: DEALER_STATE_PASSPHRASE is empty — epoch secrets will be stored unencrypted. " +
        "Set DEALER_STATE_PASSPHRASE for production use."
      );
    }
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  private filePath(epochId: number): string {
    return join(this.dir, `epoch-${epochId}.json.enc`);
  }

  save(secrets: EpochSecrets): void {
    const path = this.filePath(secrets.epochId);
    if (this.passphrase) {
      writeFileSync(path, encryptJson(secrets, this.passphrase), { mode: 0o600 });
    } else {
      writeFileSync(path, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    }
    this.cache.set(secrets.epochId, secrets);
  }

  load(epochId: number): EpochSecrets | null {
    const cached = this.cache.get(epochId);
    if (cached) return cached;

    const path = this.filePath(epochId);
    if (!existsSync(path)) return null;

    const raw = readFileSync(path);
    let secrets: EpochSecrets;
    if (this.passphrase) {
      secrets = decryptJson<EpochSecrets>(raw, this.passphrase);
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

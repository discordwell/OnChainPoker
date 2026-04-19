import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createCipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpochStateStore, deriveKey, type EpochSecrets } from "../src/state.js";

// --- helpers ---------------------------------------------------------------

function sampleSecrets(epochId = 1): EpochSecrets {
  return {
    epochId,
    validatorIndex: 2,
    polyCoeffs: ["abc", "def"],
    secretShare: "deadbeef",
  };
}

/**
 * Produce a legacy v1 blob: salt(16) || iv(12) || tag(16) || ciphertext
 * using the old SHA-256 KDF, so we can exercise the compat path.
 */
function makeLegacyV1Blob(data: unknown, passphrase: string): Buffer {
  const json = JSON.stringify(data);
  const salt = randomBytes(16);
  const ikm = Buffer.concat([Buffer.from(passphrase, "utf8"), salt]);
  const key = createHash("sha256").update(ikm).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, encrypted]);
}

// Fast argon2 parameters for the round-trip tests — the KDF itself is
// exercised once in the benchmark-ish test at defaults.
const FAST_KDF = { memoryCost: 8, timeCost: 1, parallelism: 1 };

// --- fixtures --------------------------------------------------------------

let dir: string;
let prevAllow: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dealer-state-test-"));
  prevAllow = process.env.DEALER_STATE_ALLOW_UNENCRYPTED;
  delete process.env.DEALER_STATE_ALLOW_UNENCRYPTED;
});

afterEach(() => {
  if (prevAllow === undefined) {
    delete process.env.DEALER_STATE_ALLOW_UNENCRYPTED;
  } else {
    process.env.DEALER_STATE_ALLOW_UNENCRYPTED = prevAllow;
  }
  rmSync(dir, { recursive: true, force: true });
});

// --- tests -----------------------------------------------------------------

describe("EpochStateStore v2 (argon2id)", () => {
  it("round-trips encrypt/decrypt with argon2id", async () => {
    const store = new EpochStateStore(dir, "correct horse battery staple", FAST_KDF);
    const secrets = sampleSecrets(1);
    await store.save(secrets);

    // Fresh store, empty cache → forces decrypt from disk
    const store2 = new EpochStateStore(dir, "correct horse battery staple", FAST_KDF);
    const loaded = await store2.load(1);
    assert.deepEqual(loaded, secrets);
  });

  it("on-disk blob is tagged with v2 byte", async () => {
    const store = new EpochStateStore(dir, "pw", FAST_KDF);
    await store.save(sampleSecrets(7));
    const blob = readFileSync(join(dir, "epoch-7.json.enc"));
    assert.equal(blob[0], 0x02);
    // version(1) + salt(16) + iv(12) + tag(16) + >=1 ciphertext byte
    assert.ok(blob.length > 45);
  });

  it("wrong passphrase fails", async () => {
    const store = new EpochStateStore(dir, "right-pass", FAST_KDF);
    await store.save(sampleSecrets(2));

    const store2 = new EpochStateStore(dir, "wrong-pass", FAST_KDF);
    await assert.rejects(() => store2.load(2));
  });

  it("decrypts legacy v1 blob via compat path", async () => {
    const passphrase = "legacy-pass";
    const secrets = sampleSecrets(3);
    const v1Blob = makeLegacyV1Blob(secrets, passphrase);
    writeFileSync(join(dir, "epoch-3.json.enc"), v1Blob, { mode: 0o600 });

    const store = new EpochStateStore(dir, passphrase, FAST_KDF);
    const loaded = await store.load(3);
    assert.deepEqual(loaded, secrets);
  });

  it("after load-then-save cycle, blob is upgraded to v2", async () => {
    const passphrase = "migrate-pass";
    const secrets = sampleSecrets(4);
    const v1Blob = makeLegacyV1Blob(secrets, passphrase);
    const path = join(dir, "epoch-4.json.enc");
    writeFileSync(path, v1Blob, { mode: 0o600 });

    const store = new EpochStateStore(dir, passphrase, FAST_KDF);
    const loaded = await store.load(4);
    assert.deepEqual(loaded, secrets);

    // First byte of the v1 blob is the first salt byte — not necessarily 0x02,
    // but verify the whole blob changes and leads with 0x02 after save.
    await store.save(loaded!);
    const newBlob = readFileSync(path);
    assert.equal(newBlob[0], 0x02);
    assert.notDeepEqual(newBlob, v1Blob);

    // And it still decrypts under a fresh store (no cache).
    const store2 = new EpochStateStore(dir, passphrase, FAST_KDF);
    const reloaded = await store2.load(4);
    assert.deepEqual(reloaded, secrets);
  });

  it("empty passphrase throws unless escape hatch is set", () => {
    assert.throws(
      () => new EpochStateStore(dir, ""),
      /DEALER_STATE_PASSPHRASE is required/
    );

    // With escape hatch, construction succeeds (and warns).
    process.env.DEALER_STATE_ALLOW_UNENCRYPTED = "1";
    const store = new EpochStateStore(dir, "");
    assert.ok(store);
  });

  it("empty passphrase with escape hatch stores plaintext round-trip", async () => {
    process.env.DEALER_STATE_ALLOW_UNENCRYPTED = "1";
    const store = new EpochStateStore(dir, "");
    const secrets = sampleSecrets(5);
    await store.save(secrets);

    const store2 = new EpochStateStore(dir, "");
    const loaded = await store2.load(5);
    assert.deepEqual(loaded, secrets);
  });

  it("tampered version byte fails gracefully", async () => {
    const store = new EpochStateStore(dir, "pw", FAST_KDF);
    await store.save(sampleSecrets(6));
    const path = join(dir, "epoch-6.json.enc");
    const blob = readFileSync(path);
    // Flip the version byte to something other than 0x02. The blob is far too
    // long to be a valid v1 layout, so the v1 path will fail auth, but we must
    // not crash.
    blob[0] = 0xff;
    writeFileSync(path, blob);

    const store2 = new EpochStateStore(dir, "pw", FAST_KDF);
    await assert.rejects(() => store2.load(6));
  });

  it("tampered ciphertext fails GCM auth", async () => {
    const store = new EpochStateStore(dir, "pw", FAST_KDF);
    await store.save(sampleSecrets(8));
    const path = join(dir, "epoch-8.json.enc");
    const blob = readFileSync(path);
    // Flip a byte inside the ciphertext region.
    blob[blob.length - 1] ^= 0x01;
    writeFileSync(path, blob);

    const store2 = new EpochStateStore(dir, "pw", FAST_KDF);
    await assert.rejects(() => store2.load(8));
  });

  it("has() detects both cached and on-disk entries", async () => {
    const store = new EpochStateStore(dir, "pw", FAST_KDF);
    assert.equal(store.has(42), false);
    await store.save(sampleSecrets(42));
    assert.equal(store.has(42), true);

    // Fresh store (empty cache) still sees the on-disk file
    const store2 = new EpochStateStore(dir, "pw", FAST_KDF);
    assert.equal(store2.has(42), true);
  });
});

describe("deriveKey", () => {
  it("produces a 32-byte key and is deterministic for same salt+params", async () => {
    const salt = Buffer.alloc(16, 0x11);
    const k1 = await deriveKey("pw", salt, FAST_KDF);
    const k2 = await deriveKey("pw", salt, FAST_KDF);
    assert.equal(k1.length, 32);
    assert.deepEqual(k1, k2);
  });

  it("different passphrase → different key", async () => {
    const salt = Buffer.alloc(16, 0x22);
    const k1 = await deriveKey("one", salt, FAST_KDF);
    const k2 = await deriveKey("two", salt, FAST_KDF);
    assert.notDeepEqual(k1, k2);
  });

  it("benchmark: default params finish in reasonable time", async () => {
    const salt = randomBytes(16);
    const t0 = performance.now();
    const key = await deriveKey("benchmark", salt); // defaults
    const dt = performance.now() - t0;
    assert.equal(key.length, 32);
    // Generous upper bound for CI; informational log too.
    console.log(`  [deriveKey default params] ${dt.toFixed(1)}ms`);
    assert.ok(dt < 5000, `argon2id default derive took ${dt}ms (>5s)`);
  });
});

// How a beacon salt and its commitment are derived. Which epoch, which window and whether to take
// part are decided in rotation.ts from the chain's own beacon window.

import { createHash, createHmac } from "node:crypto";
import type { DealerDaemonConfig } from "../config.js";

const BEACON_COMMIT_DOMAIN = "ocp/v1/beacon/commit";

function u64LE(n: bigint): Uint8Array {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n);
  return new Uint8Array(buf);
}

function u32LE(n: number): Uint8Array {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n);
  return new Uint8Array(buf);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function lengthPrefixed(parts: Uint8Array[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    chunks.push(u32LE(p.length));
    chunks.push(p);
  }
  return concat(...chunks);
}

function hashDomain(domain: string, ...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha256");
  h.update(Buffer.from(domain, "utf8"));
  h.update(lengthPrefixed(parts));
  return new Uint8Array(h.digest());
}

function computeCommit(validator: string, epochId: bigint, salt: Uint8Array): Uint8Array {
  return hashDomain(
    BEACON_COMMIT_DOMAIN,
    Buffer.from(validator, "utf8"),
    u64LE(epochId),
    salt,
  );
}

type Identity = Pick<DealerDaemonConfig, "statePassphrase" | "validatorAddress">;

/** One beacon window: the epoch it seeds and the height at which the chain opened it. */
export type BeaconWindowId = { epochId: number; commitOpenHeight: number };

const WINDOW_SALT_DOMAIN = "ocp/v1/beacon/salt/v2";

/**
 * The 32-byte salt this validator commits to and later reveals in one beacon window.
 * Derived, not stored, so a restart between the commit and the reveal still reveals the same salt.
 * Bound to the window's commit-open height: the chain replaces a window that closed below its
 * threshold with one for the same epoch id, and a salt revealed in the old one must not be the
 * secret of the new one.
 */
export function beaconSalt(config: Identity, window: BeaconWindowId): Uint8Array {
  const mac = createHmac("sha256", Buffer.from(config.statePassphrase, "utf8"));
  mac.update(Buffer.from(WINDOW_SALT_DOMAIN, "utf8"));
  mac.update(Buffer.from(config.validatorAddress, "utf8"));
  mac.update(u64LE(BigInt(window.epochId)));
  mac.update(u64LE(BigInt(window.commitOpenHeight)));
  return new Uint8Array(mac.digest());
}

/** What MsgBeaconCommit carries: the chain's hash of (validator, epoch id, salt), which it recomputes at the reveal. */
export function beaconCommitment(config: Identity, window: BeaconWindowId): Uint8Array {
  return computeCommit(config.validatorAddress, BigInt(window.epochId), beaconSalt(config, window));
}

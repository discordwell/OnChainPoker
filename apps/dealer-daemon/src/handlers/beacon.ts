import { createHash, createHmac } from "node:crypto";
import type { OcpCosmosClient } from "@onchainpoker/ocp-sdk/cosmos";
import type { DealerDaemonConfig } from "../config.js";
import { log } from "../log.js";

const BEACON_COMMIT_DOMAIN = "ocp/v1/beacon/commit";
const SALT_DOMAIN = "ocp/v1/beacon/salt/v1";

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

function deriveSalt(passphrase: string, validator: string, epochId: bigint): Uint8Array {
  const mac = createHmac("sha256", Buffer.from(passphrase, "utf8"));
  mac.update(Buffer.from(SALT_DOMAIN, "utf8"));
  mac.update(Buffer.from(validator, "utf8"));
  mac.update(u64LE(epochId));
  return new Uint8Array(mac.digest());
}

function isExpectedBeaconError(msg: string): boolean {
  return (
    msg.includes("already committed") ||
    msg.includes("already revealed") ||
    msg.includes("not in commit window") ||
    msg.includes("not in reveal window") ||
    msg.includes("no beacon state") ||
    msg.includes("commit not found") ||
    msg.includes("beacon not open") ||
    msg.includes("active bonded")
  );
}

export async function maybeBeaconParticipate(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
}): Promise<void> {
  const { client, config } = args;

  const epoch = await client.getDealerEpoch().catch(() => null);
  const currentEpochId = epoch ? BigInt(epoch.epoch_id ?? epoch.epochId ?? "0") : 0n;
  const targetEpoch = currentEpochId + 1n;

  const passphrase = config.statePassphrase ?? "ocp-beacon-fallback";
  const salt = deriveSalt(passphrase, config.validatorAddress, targetEpoch);
  const commit = computeCommit(config.validatorAddress, targetEpoch, salt);

  try {
    await client.dealerBeaconCommit({
      validator: config.validatorAddress,
      epochId: targetEpoch.toString(),
      commit,
    });
    log(`Beacon: committed for epoch ${targetEpoch}`);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (!isExpectedBeaconError(msg)) {
      log(`Beacon: commit error for epoch ${targetEpoch}: ${msg.slice(0, 200)}`);
    }
  }

  try {
    await client.dealerBeaconReveal({
      validator: config.validatorAddress,
      epochId: targetEpoch.toString(),
      salt,
    });
    log(`Beacon: revealed for epoch ${targetEpoch}`);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (!isExpectedBeaconError(msg)) {
      log(`Beacon: reveal error for epoch ${targetEpoch}: ${msg.slice(0, 200)}`);
    }
  }
}

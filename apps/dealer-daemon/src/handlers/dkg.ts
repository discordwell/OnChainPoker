import { randomBytes } from "node:crypto";
import {
  CURVE_ORDER,
  groupElementToBytes,
  mulBase,
  scalarFromBytesModOrder,
  scalarToBytes,
} from "@onchainpoker/ocp-crypto";
import type { OcpCosmosClient } from "@onchainpoker/ocp-sdk/cosmos";
import type { EpochStateStore } from "../state.js";
import type { DealerDaemonConfig } from "../config.js";
import { log } from "../log.js";

function modQ(n: bigint): bigint {
  const x = n % CURVE_ORDER;
  return x < 0n ? x + CURVE_ORDER : x;
}

function evalPoly(coeffs: bigint[], x: bigint): bigint {
  let acc = 0n;
  let pow = 1n;
  for (const a of coeffs) {
    acc = modQ(acc + modQ(a) * pow);
    pow = modQ(pow * x);
  }
  return modQ(acc);
}

function nonzeroScalar(): bigint {
  while (true) {
    const s = scalarFromBytesModOrder(randomBytes(64));
    if (s !== 0n) return s;
  }
}

export async function handleDkgCommit(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
  stateStore: EpochStateStore;
  epochId: number;
  members: Array<{ validator: string; index: number }>;
}): Promise<void> {
  const { client, config, stateStore, epochId, members } = args;

  // Check if we already committed for this epoch
  if (stateStore.has(epochId)) {
    log(`DKG: already have secrets for epoch ${epochId}, skipping commit`);
    return;
  }

  const myMember = members.find(
    (m) => m.validator.toLowerCase() === config.validatorAddress.toLowerCase()
  );
  if (!myMember) {
    log(`DKG: not a member for epoch ${epochId}, skipping`);
    return;
  }

  // Generate polynomial of degree (threshold - 1)
  const polyCoeffs: bigint[] = Array.from({ length: config.threshold }, () => nonzeroScalar());
  const commitments = polyCoeffs.map((c) => groupElementToBytes(mulBase(c)));

  log(`DKG: submitting commit for epoch ${epochId}, validator index ${myMember.index}`);

  await client.dealerDkgCommit({
    dealer: config.validatorAddress,
    epochId,
    commitments,
  });

  // Store the polynomial now; we'll compute the aggregated share after reveals.
  stateStore.save({
    epochId,
    validatorIndex: myMember.index,
    polyCoeffs: polyCoeffs.map((c) => c.toString(16)),
    secretShare: "0", // placeholder until aggregation
  });

  log(`DKG: commit submitted for epoch ${epochId}`);
}

/**
 * File "missing" complaints for all other committee members.
 * In an on-chain-only DKG (no off-chain channels), every validator files
 * a complaint against every other validator to force on-chain share reveals.
 */
export async function handleDkgComplaints(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
  epochId: number;
  members: Array<{ validator: string; index: number }>;
  dkg: any;
}): Promise<void> {
  const { client, config, epochId, members, dkg } = args;

  const myAddress = config.validatorAddress.toLowerCase();

  // Only file complaints if we've already committed
  const commits = Array.isArray(dkg.commits) ? dkg.commits : [];
  const myCommit = commits.find(
    (c: any) => String(c.dealer ?? "").toLowerCase() === myAddress
  );
  if (!myCommit) return;

  // Check existing complaints from us
  const complaints = Array.isArray(dkg.complaints) ? dkg.complaints : [];
  const myComplaints = new Set(
    complaints
      .filter((c: any) => String(c.complainer ?? "").toLowerCase() === myAddress)
      .map((c: any) => String(c.dealer ?? "").toLowerCase())
  );

  // File complaints for all other committed members
  for (const member of members) {
    const memberAddr = member.validator.toLowerCase();
    if (memberAddr === myAddress) continue;
    if (myComplaints.has(memberAddr)) continue;

    try {
      await client.dealerDkgComplaintMissing({
        complainer: config.validatorAddress,
        epochId,
        dealer: member.validator,
      });
      log(`DKG: filed missing complaint against ${member.validator}`);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (!msg.includes("already") && !msg.includes("deadline") && !msg.includes("too early")) {
        log(`DKG: complaint against ${member.validator} failed: ${msg}`);
      }
    }
  }
}

/**
 * Reveal shares in response to complaints targeting us.
 * When another validator files a "missing" complaint against us,
 * we must reveal our polynomial evaluation at their index.
 */
export async function handleDkgReveals(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
  stateStore: EpochStateStore;
  epochId: number;
  members: Array<{ validator: string; index: number }>;
  dkg: any;
}): Promise<void> {
  const { client, config, stateStore, epochId, members, dkg } = args;

  const myAddress = config.validatorAddress.toLowerCase();

  const secrets = stateStore.load(epochId);
  if (!secrets) return; // haven't committed

  const polyCoeffs = secrets.polyCoeffs.map((c) => BigInt(`0x${c}`));

  // Find complaints against us
  const complaints = Array.isArray(dkg.complaints) ? dkg.complaints : [];
  const complaintsAgainstUs = complaints.filter(
    (c: any) => String(c.dealer ?? "").toLowerCase() === myAddress
  );

  if (complaintsAgainstUs.length === 0) return;

  // Check existing reveals from us
  const reveals = Array.isArray(dkg.reveals) ? dkg.reveals : [];
  const myReveals = new Set(
    reveals
      .filter((r: any) => String(r.dealer ?? "").toLowerCase() === myAddress)
      .map((r: any) => String(r.to ?? "").toLowerCase())
  );

  for (const complaint of complaintsAgainstUs) {
    const complainerId = String(complaint.complainer ?? "").toLowerCase();
    if (myReveals.has(complainerId)) continue;

    // Find complainer's index
    const complainerMember = members.find(
      (m) => m.validator.toLowerCase() === complainerId
    );
    if (!complainerMember) continue;

    // Evaluate our polynomial at the complainer's index
    const share = evalPoly(polyCoeffs, BigInt(complainerMember.index));
    const shareBytes = scalarToBytes(share);

    try {
      await client.dealerDkgShareReveal({
        dealer: config.validatorAddress,
        epochId,
        to: complaint.complainer,
        share: shareBytes,
      });
      log(`DKG: revealed share for ${complaint.complainer} (index ${complainerMember.index})`);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (!msg.includes("already") && !msg.includes("deadline") && !msg.includes("too early")) {
        log(`DKG: share reveal for ${complaint.complainer} failed: ${msg}`);
      }
    }
  }
}

/**
 * Compute the aggregated secret share from own polynomial self-evaluation
 * plus revealed shares from other dealers. Must be called BEFORE FinalizeEpoch
 * since finalization clears the DKG state (including reveals).
 */
export async function handleDkgAggregate(args: {
  stateStore: EpochStateStore;
  config: DealerDaemonConfig;
  epochId: number;
  members: Array<{ validator: string; index: number }>;
  dkg: any;
}): Promise<boolean> {
  const { stateStore, config, epochId, members, dkg } = args;

  const secrets = stateStore.load(epochId);
  if (!secrets) return false;
  if (secrets.secretShare !== "0") return true; // already computed

  const myAddress = config.validatorAddress.toLowerCase();
  const myMember = members.find(
    (m) => m.validator.toLowerCase() === myAddress
  );
  if (!myMember) return false;

  const polyCoeffs = secrets.polyCoeffs.map((c) => BigInt(`0x${c}`));

  // Start with self-evaluation
  let aggregated = evalPoly(polyCoeffs, BigInt(myMember.index));

  // Collect reveals where other dealers revealed their share to us
  const reveals = Array.isArray(dkg.reveals) ? dkg.reveals : [];
  const slashed = new Set(
    (Array.isArray(dkg.slashed) ? dkg.slashed : []).map((s: string) =>
      String(s).toLowerCase()
    )
  );

  let revealCount = 0;
  for (const reveal of reveals) {
    const dealerAddr = String(reveal.dealer ?? "").toLowerCase();
    const toAddr = String(reveal.to ?? "").toLowerCase();
    if (toAddr !== myAddress) continue;
    if (dealerAddr === myAddress) continue; // skip self
    if (slashed.has(dealerAddr)) continue; // skip slashed dealers

    const shareBytes = reveal.share;
    if (!shareBytes) continue;

    let shareBigint: bigint;
    try {
      if (shareBytes instanceof Uint8Array || (typeof shareBytes === "object" && shareBytes.length)) {
        const buf = shareBytes instanceof Uint8Array ? shareBytes : new Uint8Array(Object.values(shareBytes));
        // Little-endian bytes → bigint
        let x = 0n;
        for (let i = buf.length - 1; i >= 0; i--) {
          x = (x << 8n) + BigInt(buf[i]!);
        }
        shareBigint = modQ(x);
      } else if (typeof shareBytes === "string") {
        // Could be base64 or hex
        const hex = shareBytes.startsWith("0x") ? shareBytes.slice(2) : shareBytes;
        if (/^[0-9a-fA-F]+$/.test(hex) && hex.length === 64) {
          // Hex-encoded 32 bytes, convert to LE bigint
          const buf = new Uint8Array(32);
          for (let i = 0; i < 32; i++) {
            buf[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
          }
          let x = 0n;
          for (let i = buf.length - 1; i >= 0; i--) {
            x = (x << 8n) + BigInt(buf[i]!);
          }
          shareBigint = modQ(x);
        } else {
          // Try base64
          const raw = Buffer.from(shareBytes, "base64");
          let x = 0n;
          for (let i = raw.length - 1; i >= 0; i--) {
            x = (x << 8n) + BigInt(raw[i]!);
          }
          shareBigint = modQ(x);
        }
      } else {
        continue;
      }
    } catch {
      log(`DKG: failed to decode reveal share from ${dealerAddr}`);
      continue;
    }

    aggregated = modQ(aggregated + shareBigint);
    revealCount++;
  }

  const expectedOtherMembers = members.filter(
    (m) => m.validator.toLowerCase() !== myAddress && !slashed.has(m.validator.toLowerCase())
  ).length;

  if (revealCount < expectedOtherMembers) {
    log(
      `DKG: have ${revealCount}/${expectedOtherMembers} reveals for epoch ${epochId}, waiting for more`
    );
    return false;
  }

  // Clone before mutation to avoid corrupting cache if save() fails
  const updated = { ...secrets, secretShare: aggregated.toString(16) };
  stateStore.save(updated);
  log(
    `DKG: computed aggregated secret share for epoch ${epochId} from ${revealCount + 1} contributions`
  );
  return true;
}

export { nonzeroScalar, modQ, evalPoly };

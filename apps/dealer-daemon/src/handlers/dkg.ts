import { randomBytes } from "node:crypto";
import {
  CURVE_ORDER,
  decryptShareScalar,
  dkgEncShareProve,
  encodeDkgEncShareProof,
  encryptShareScalar,
  groupElementFromBytes,
  groupElementToBytes,
  mulBase,
  mulPoint,
  pointAdd,
  pointEq,
  pointSub,
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

  // DKG v2: fresh per-epoch ElGamal keypair for encrypted-share receipt.
  // skR stays local to the daemon; pkR is published with the commit so other
  // dealers can encrypt shares destined for us. Rotating per epoch preserves
  // forward secrecy if a later epoch's keys are compromised.
  const ephemeralSk = nonzeroScalar();
  const ephemeralPk = groupElementToBytes(mulBase(ephemeralSk));

  log(`DKG: submitting commit for epoch ${epochId}, validator index ${myMember.index}`);

  await client.dealerDkgCommit({
    dealer: config.validatorAddress,
    epochId,
    commitments,
    ephemeralPubkey: ephemeralPk,
  });

  // Store the polynomial + ephemeral secret now; we'll compute the aggregated
  // share after encrypted shares / reveals arrive.
  await stateStore.save({
    epochId,
    validatorIndex: myMember.index,
    polyCoeffs: polyCoeffs.map((c) => c.toString(16)),
    secretShare: "0", // placeholder until aggregation
    ephemeralSk: ephemeralSk.toString(16),
  });

  log(`DKG: commit submitted for epoch ${epochId}`);
}

function decodeOnchainBytes(raw: unknown): Uint8Array | undefined {
  if (raw == null) return undefined;
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return Uint8Array.from(raw.map((x) => Number(x)));
  if (typeof raw === "object" && (raw as any).length != null) {
    return new Uint8Array(Object.values(raw as Record<string, number>));
  }
  if (typeof raw === "string") {
    const s = raw.startsWith("0x") ? raw.slice(2) : raw;
    if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
      const out = new Uint8Array(s.length / 2);
      for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
      }
      return out;
    }
    const buf = Buffer.from(raw, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  return undefined;
}

function evalPolyScalar(coeffs: bigint[], j: number): bigint {
  return evalPoly(coeffs, BigInt(j));
}

/**
 * DKG v2: for every other committee member that has committed and published
 * an ephemeral pubkey, publish one encrypted share. Idempotent: skips pairs
 * already present in `dkg.encryptedShares`.
 *
 * Runs after `handleDkgCommit` (we need our own `polyCoeffs` to compute
 * `s = f(j)` for each recipient index `j`). Parallel with the legacy
 * "missing complaint → plaintext reveal" path; the chain accepts both and
 * aggregation prefers encrypted shares when available.
 */
export async function handleDkgEncryptedShares(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
  stateStore: EpochStateStore;
  epochId: number;
  members: Array<{ validator: string; index: number; ephemeralPubkey?: Uint8Array }>;
  dkg: any;
}): Promise<void> {
  const { client, config, stateStore, epochId, members, dkg } = args;

  const secrets = await stateStore.load(epochId);
  if (!secrets || !secrets.polyCoeffs?.length) return;

  const myAddress = config.validatorAddress.toLowerCase();
  const myMember = members.find((m) => m.validator.toLowerCase() === myAddress);
  if (!myMember) return;

  const polyCoeffs = secrets.polyCoeffs.map((c) => BigInt(`0x${c}`));
  // Parse the dealer's Feldman commitments back to group elements.
  const commits = Array.isArray(dkg.commits) ? dkg.commits : [];
  const myCommit = commits.find(
    (c: any) => String(c.dealer ?? "").toLowerCase() === myAddress
  );
  if (!myCommit) return; // We haven't committed yet.
  const commitmentsBytes: Uint8Array[] = [];
  for (const cb of myCommit.commitments ?? []) {
    const b = decodeOnchainBytes(cb);
    if (!b || b.length !== 32) return; // malformed; skip this cycle
    commitmentsBytes.push(b);
  }
  const commitmentsPts = commitmentsBytes.map((b) => groupElementFromBytes(b));

  // Index existing encrypted-shares we've already submitted so we don't re-submit.
  const existing = new Set<string>();
  for (const es of (Array.isArray(dkg.encryptedShares) ? dkg.encryptedShares : [])) {
    const d = String(es.dealer ?? "").toLowerCase();
    const j = Number(es.recipientIndex ?? es.recipient_index ?? 0) | 0;
    if (d && j > 0) existing.add(`${d}:${j}`);
  }

  for (const recipient of members) {
    if (recipient.validator.toLowerCase() === myAddress) continue;
    const key = `${myAddress}:${recipient.index}`;
    if (existing.has(key)) continue;

    // Recipient must have published a valid ephemeral pubkey.
    const pkRBytes = decodeOnchainBytes(recipient.ephemeralPubkey);
    if (!pkRBytes || pkRBytes.length !== 32) continue;
    let pkR;
    try {
      pkR = groupElementFromBytes(pkRBytes);
    } catch {
      continue;
    }

    // Build the encrypted share: ElGamal on the share-point s*G under pkR,
    // plus the NIZK binding it to the Feldman commitments, plus the AEAD
    // ciphertext carrying the scalar s.
    const s = evalPolyScalar(polyCoeffs, recipient.index);
    const r = nonzeroScalar();
    const u = mulBase(r);                    // U = r*G
    const v = pointAdd(mulBase(s), mulPoint(pkR, r)); // V = s*G + r*pkR

    const proof = dkgEncShareProve({
      commitments: commitmentsPts,
      j: recipient.index,
      pkR,
      u,
      v,
      s,
      r,
      ws: nonzeroScalar(),
      wr: nonzeroScalar(),
    });
    const proofBytes = encodeDkgEncShareProof(proof);
    const scalarCt = encryptShareScalar({ pkR, r, s, proofBytes });

    try {
      await client.dealerDkgEncryptedShare({
        dealer: config.validatorAddress,
        epochId,
        recipientIndex: recipient.index,
        u: groupElementToBytes(u),
        v: groupElementToBytes(v),
        proof: proofBytes,
        scalarCt,
      });
      log(`DKG: submitted encrypted share for recipient index ${recipient.index}`);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (!msg.includes("already") && !msg.includes("deadline")) {
        log(`DKG: encrypted share for idx=${recipient.index} failed: ${msg}`);
      }
    }
  }
}

/**
 * DKG v2 aggregation: decrypt encrypted shares destined for us and return
 * their scalars (keyed by dealer address). Recipient-side verification:
 *   1. AEAD decrypts successfully.
 *   2. s*G matches v - skR*u (i.e., scalar is consistent with the
 *      NIZK-verified share point).
 * Any share that fails these checks is discarded silently; the dealer's
 * misbehavior is already slashable via the on-chain NIZK check at submit
 * time, so the recipient's local check is defense-in-depth.
 */
async function collectEncryptedShareScalars(args: {
  stateStore: EpochStateStore;
  config: DealerDaemonConfig;
  epochId: number;
  dkg: any;
}): Promise<Map<string, bigint>> {
  const { stateStore, config, epochId, dkg } = args;
  const out = new Map<string, bigint>();

  const secrets = await stateStore.load(epochId);
  if (!secrets?.ephemeralSk) return out;

  const skR = BigInt(`0x${secrets.ephemeralSk}`);
  const myAddress = config.validatorAddress.toLowerCase();
  const myIndex = secrets.validatorIndex;

  const shares = Array.isArray(dkg.encryptedShares) ? dkg.encryptedShares : [];
  for (const es of shares) {
    const dealerAddr = String(es.dealer ?? "").toLowerCase();
    if (dealerAddr === myAddress) continue;
    const recipientIndex = Number(es.recipientIndex ?? es.recipient_index ?? 0) | 0;
    if (recipientIndex !== myIndex) continue;

    const uBytes = decodeOnchainBytes(es.u);
    const vBytes = decodeOnchainBytes(es.v);
    const proofBytes = decodeOnchainBytes(es.proof);
    const ct = decodeOnchainBytes(es.scalarCt ?? es.scalar_ct);
    if (!uBytes || !vBytes || !proofBytes || !ct) continue;

    try {
      const u = groupElementFromBytes(uBytes);
      const v = groupElementFromBytes(vBytes);
      const s = decryptShareScalar({ skR, u, proofBytes, ct });
      // Consistency: s*G == v - skR*u.
      const sharePointFromScalar = mulBase(s);
      const sharePointFromElGamal = pointSub(v, mulPoint(u, skR));
      if (!pointEq(sharePointFromScalar, sharePointFromElGamal)) {
        log(`DKG: encrypted share from ${dealerAddr} fails consistency check — discarding`);
        continue;
      }
      out.set(dealerAddr, s);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      log(`DKG: failed to decrypt encrypted share from ${dealerAddr}: ${msg}`);
    }
  }
  return out;
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

  // Only file complaints against members who have actually committed
  const committedAddrs = new Set(
    commits.map((c: any) => String(c.dealer ?? "").toLowerCase())
  );

  for (const member of members) {
    const memberAddr = member.validator.toLowerCase();
    if (memberAddr === myAddress) continue;
    if (myComplaints.has(memberAddr)) continue;
    if (!committedAddrs.has(memberAddr)) continue;

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

  const secrets = await stateStore.load(epochId);
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

  const secrets = await stateStore.load(epochId);
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

  const slashed = new Set(
    (Array.isArray(dkg.slashed) ? dkg.slashed : []).map((s: string) =>
      String(s).toLowerCase()
    )
  );

  // DKG v2: prefer scalars recovered from encrypted shares (AEAD-decrypted
  // locally via our ephemeralSk). Keys are lowercased dealer addresses.
  const encScalars = await collectEncryptedShareScalars({ stateStore, config, epochId, dkg });

  // Track which dealers we've counted so v1 reveals don't double-count a
  // dealer who also published an encrypted share.
  const counted = new Set<string>();
  for (const [dealerAddr, s] of encScalars) {
    if (slashed.has(dealerAddr)) continue;
    aggregated = modQ(aggregated + s);
    counted.add(dealerAddr);
  }

  // Legacy v1 path: collect reveals where other dealers revealed their share
  // to us via the plaintext MsgDkgShareReveal path. Fills in gaps for dealers
  // that haven't migrated to the encrypted-share flow yet.
  const reveals = Array.isArray(dkg.reveals) ? dkg.reveals : [];
  for (const reveal of reveals) {
    const dealerAddr = String(reveal.dealer ?? "").toLowerCase();
    const toAddr = String(reveal.to ?? "").toLowerCase();
    if (toAddr !== myAddress) continue;
    if (dealerAddr === myAddress) continue;
    if (slashed.has(dealerAddr)) continue;
    if (counted.has(dealerAddr)) continue; // encrypted share already contributed

    const shareBytes = reveal.share;
    if (!shareBytes) continue;

    let shareBigint: bigint;
    try {
      if (shareBytes instanceof Uint8Array || (typeof shareBytes === "object" && shareBytes.length)) {
        const buf = shareBytes instanceof Uint8Array ? shareBytes : new Uint8Array(Object.values(shareBytes));
        let x = 0n;
        for (let i = buf.length - 1; i >= 0; i--) {
          x = (x << 8n) + BigInt(buf[i]!);
        }
        shareBigint = modQ(x);
      } else if (typeof shareBytes === "string") {
        const hex = shareBytes.startsWith("0x") ? shareBytes.slice(2) : shareBytes;
        if (/^[0-9a-fA-F]+$/.test(hex) && hex.length === 64) {
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
    counted.add(dealerAddr);
  }

  const expectedOtherMembers = members.filter(
    (m) => m.validator.toLowerCase() !== myAddress && !slashed.has(m.validator.toLowerCase())
  ).length;

  if (counted.size < expectedOtherMembers) {
    log(
      `DKG: have ${counted.size}/${expectedOtherMembers} contributions for epoch ${epochId} (${encScalars.size} encrypted + ${counted.size - encScalars.size} reveals), waiting for more`
    );
    return false;
  }

  const updated = { ...secrets, secretShare: aggregated.toString(16) };
  await stateStore.save(updated);
  log(
    `DKG: computed aggregated secret share for epoch ${epochId} from ${counted.size + 1} contributions (${encScalars.size} encrypted + ${counted.size - encScalars.size} plaintext reveals + 1 self)`
  );
  return true;
}

export { nonzeroScalar, modQ, evalPoly };

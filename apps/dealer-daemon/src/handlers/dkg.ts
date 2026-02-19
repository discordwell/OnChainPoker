import { randomBytes } from "node:crypto";
import {
  CURVE_ORDER,
  groupElementToBytes,
  mulBase,
  scalarFromBytesModOrder,
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

  // We won't know the aggregated secret share until after finalization.
  // Store the polynomial now; we'll compute the aggregated share in handleEpochFinalized.
  stateStore.save({
    epochId,
    validatorIndex: myMember.index,
    polyCoeffs: polyCoeffs.map((c) => c.toString(16)),
    secretShare: "0", // placeholder until finalization
  });

  log(`DKG: commit submitted for epoch ${epochId}`);
}

export async function handleEpochFinalized(args: {
  stateStore: EpochStateStore;
  epochId: number;
  members: Array<{ validator: string; index: number }>;
  allPolynomials?: Array<{ validator: string; coeffs: bigint[] }>;
  myIndex: number;
}): Promise<void> {
  const { stateStore, epochId, members, allPolynomials, myIndex } = args;

  const existing = stateStore.load(epochId);
  if (!existing) {
    log(`DKG finalized: no local secrets for epoch ${epochId}`);
    return;
  }

  // If we have all polynomials (from full DKG), compute aggregated secret share
  if (allPolynomials && allPolynomials.length > 0) {
    let aggregated = 0n;
    for (const poly of allPolynomials) {
      aggregated = modQ(aggregated + evalPoly(poly.coeffs, BigInt(myIndex)));
    }
    existing.secretShare = aggregated.toString(16);
    stateStore.save(existing);
    log(`DKG finalized: computed aggregated secret share for epoch ${epochId}`);
  }
}

export { nonzeroScalar, modQ, evalPoly };

import { randomBytes } from "node:crypto";
import {
  groupElementToBytes,
  hashToScalar,
  mulBase,
  mulPoint,
  scalarFromBytesModOrder,
  scalarMul,
  chaumPedersenProve,
  encodeChaumPedersenProof,
  groupElementFromBytes,
} from "@onchainpoker/ocp-crypto";
import type { OcpCosmosClient } from "@onchainpoker/ocp-sdk/cosmos";
import type { DealerDaemonConfig } from "../config.js";
import type { EpochStateStore } from "../state.js";
import { log } from "../log.js";
import { decodeBytes, decodeDeck } from "./shuffle.js";

function u64le(v: number | bigint): Uint8Array {
  const out = new Uint8Array(8);
  let x = BigInt(v);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function nonzeroScalar(): bigint {
  while (true) {
    const s = scalarFromBytesModOrder(randomBytes(64));
    if (s !== 0n) return s;
  }
}

export async function handlePubShare(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
  stateStore: EpochStateStore;
  tableId: string;
  handId: string;
  epochId: number;
  pos: number;
}): Promise<void> {
  const { client, config, stateStore, tableId, handId, epochId, pos } = args;

  const secrets = stateStore.load(epochId);
  if (!secrets || secrets.secretShare === "0") {
    log(`PubShare: no secrets for epoch ${epochId}`);
    return;
  }

  const secretShare = BigInt(`0x${secrets.secretShare}`);
  const handScalar = hashToScalar(
    "ocp/v1/dealer/hand-derive",
    u64le(epochId),
    u64le(Number(tableId)),
    u64le(Number(handId))
  );
  const xHand = scalarMul(secretShare, handScalar);
  const yHand = mulBase(xHand);

  // Get the dealer hand state to access the deck
  const dealerHand = await client.getDealerHand(tableId, handId);
  if (!dealerHand) {
    log(`PubShare: dealer hand not available`);
    return;
  }

  const rawDeck = dealerHand.deck ?? [];
  const deck = decodeDeck(rawDeck);
  const cipher = deck[pos];
  if (!cipher) {
    log(`PubShare: deck missing position ${pos}`);
    return;
  }

  const d = mulPoint(cipher.c1, xHand);
  const proof = chaumPedersenProve({
    y: yHand,
    c1: cipher.c1,
    d,
    x: xHand,
    w: nonzeroScalar(),
  });

  const pubShareBytes = groupElementToBytes(d);
  const proofBytes = encodeChaumPedersenProof(proof);

  try {
    await client.dealerSubmitPubShare({
      validator: config.validatorAddress,
      tableId,
      handId,
      pos,
      pubShare: pubShareBytes,
      proofShare: proofBytes,
    });
    log(`PubShare: submitted for pos ${pos} table ${tableId} hand ${handId}`);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (msg.includes("already") || msg.includes("duplicate")) {
      log(`PubShare: already submitted for pos ${pos}, skipping`);
    } else {
      throw err;
    }
  }
}

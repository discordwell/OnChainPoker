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
} from "@onchainpoker/ocp-crypto";
import type { OcpCosmosClient } from "@onchainpoker/ocp-sdk/cosmos";
import type { DealerDaemonConfig } from "../config.js";
import type { EpochStateStore } from "../state.js";
import { log, logProgress } from "../log.js";
import { sharesNow, turnOrder } from "../turns.js";
import { BLIND_GAS, type HandSender } from "./send.js";
import { decodeDeck } from "./shuffle.js";

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

function i64le(v: number | bigint): Uint8Array {
  // Two's-complement little-endian encoding of a signed 64-bit integer,
  // matching the Go-side i64le in x/dealer/keeper/logic.go.
  const out = new Uint8Array(8);
  let x = BigInt(v);
  if (x < 0n) x += 1n << 64n;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function decodeSaltBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return Uint8Array.from(raw.map((x) => Number(x)));
  if (typeof raw === "string" && raw.length > 0) {
    return Uint8Array.from(Buffer.from(raw, "base64"));
  }
  throw new Error(`unsupported initHashSalt bytes value: ${typeof raw}`);
}

/**
 * The card at `pos`. Members whose turn it is (turns.ts) send their public share and, right behind
 * it in their next transaction, FinalizeReveal: whichever share brings the card to its threshold,
 * the FinalizeReveal after it in the same block finds both and reveals the card, one block after the
 * step opened instead of two. A FinalizeReveal that lands before the threshold fails alone, and the
 * next block sends it again with a simulation.
 */
export async function handlePubShare(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
  stateStore: EpochStateStore;
  tableId: string;
  handId: string;
  epochId: number;
  pos: number;
  qualified: readonly { validator: string }[];
  threshold: number;
  /** The reveal's deadline (table.hand.dealer.reveal_deadline) and the table's dealer timeout, in seconds. */
  revealDeadline: number;
  dealerTimeoutSecs: number;
  nowUnix: number;
  sender: HandSender;
}): Promise<void> {
  const { client, config, stateStore, tableId, handId, epochId, pos, sender } = args;
  const shareKey = `t${tableId}:h${handId}:pub${pos}`;
  const finalizeKey = `t${tableId}:h${handId}:reveal${pos}`;

  // Get the dealer hand state to access the deck + per-hand init entropy (v2 hand-derive).
  const dealerHand = await client.getDealerHand(tableId, handId);
  if (!dealerHand) {
    log(`PubShare: dealer hand not available`);
    return;
  }
  const shares = ((dealerHand.pubShares ?? dealerHand.pub_shares ?? []) as any[]).filter((ps) => Number(ps?.pos) === pos);
  const finalize = () =>
    sender.send({
      key: finalizeKey,
      msgs: [client.messages.finalizeReveal({ tableId, handId, pos })],
      holdBlocks: 0,
      what: `finalize reveal of pos ${pos} table ${tableId} hand ${handId}`,
    });

  if (shares.some((ps) => ps?.validator === config.validatorAddress)) {
    // Mine is in. Every FinalizeReveal sent behind a share failed: whoever shared, finalizes now.
    if (shares.length >= args.threshold && !sender.inflight.holds(finalizeKey, sender.height)) await finalize();
    return;
  }
  if (sender.inflight.holds(shareKey, sender.height)) return;
  const order = turnOrder(args.qualified, pos);
  const openedAtUnix = args.revealDeadline - args.dealerTimeoutSecs;
  if (!sharesNow({ order, threshold: args.threshold, me: config.validatorAddress, openedAtUnix, nowUnix: args.nowUnix })) return;

  const share = await pubShareMessage({ client, config, stateStore, tableId, handId, epochId, dealerHand, pos });
  if (!share) return;

  const shared = await sender.send({
    key: shareKey,
    msgs: [share],
    holdBlocks: 1,
    what: `public share of pos ${pos} table ${tableId} hand ${handId}`,
  });
  if (!shared) return;
  logProgress(`PubShare: sent for pos ${pos} table ${tableId} hand ${handId}`);
  await sender.send({
    key: finalizeKey,
    msgs: [client.messages.finalizeReveal({ tableId, handId, pos })],
    holdBlocks: 0,
    gasLimit: BLIND_GAS.finalizeReveal,
    what: `finalize reveal of pos ${pos} table ${tableId} hand ${handId}, behind my share`,
  });
}

/** This validator's public share of the card at `pos`, with its proof, as the message that carries it. null when it cannot be made. */
export async function pubShareMessage(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
  stateStore: EpochStateStore;
  tableId: string;
  handId: string;
  epochId: number;
  dealerHand: any;
  pos: number;
}): Promise<ReturnType<OcpCosmosClient["messages"]["submitPubShare"]> | null> {
  const { client, config, stateStore, tableId, handId, epochId, dealerHand, pos } = args;
  const secrets = await stateStore.load(epochId);
  if (!secrets || secrets.secretShare === null) {
    log(`PubShare: no secrets for epoch ${epochId}`);
    return null;
  }

  const secretShare = BigInt(`0x${secrets.secretShare}`);

  const initHeightRaw = dealerHand.initHeight ?? dealerHand.init_height;
  const initSaltRaw = dealerHand.initHashSalt ?? dealerHand.init_hash_salt;
  if (initHeightRaw == null || initSaltRaw == null) {
    log(`PubShare: dealer hand missing initHeight/initHashSalt (pre-v2 chain state?)`);
    return null;
  }
  const initHeight = BigInt(initHeightRaw as string | number);
  const initSalt = decodeSaltBytes(initSaltRaw);
  if (initSalt.length !== 32) {
    log(`PubShare: initHashSalt must be 32 bytes, got ${initSalt.length}`);
    return null;
  }

  const handScalar = hashToScalar(
    "ocp/v1/dealer/hand-derive/v2",
    u64le(epochId),
    u64le(Number(tableId)),
    u64le(Number(handId)),
    i64le(initHeight),
    initSalt
  );
  const xHand = scalarMul(secretShare, handScalar);
  const yHand = mulBase(xHand);

  const rawDeck = dealerHand.deck ?? [];
  const deck = decodeDeck(rawDeck);
  const cipher = deck[pos];
  if (!cipher) {
    log(`PubShare: deck missing position ${pos}`);
    return null;
  }

  const d = mulPoint(cipher.c1, xHand);
  const proof = chaumPedersenProve({
    y: yHand,
    c1: cipher.c1,
    d,
    x: xHand,
    w: nonzeroScalar(),
  });
  return client.messages.submitPubShare({
    validator: config.validatorAddress,
    tableId,
    handId,
    pos,
    pubShare: groupElementToBytes(d),
    proofShare: encodeChaumPedersenProof(proof),
  });
}

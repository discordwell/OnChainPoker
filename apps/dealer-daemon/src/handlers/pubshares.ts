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

  const secrets = await stateStore.load(epochId);
  if (!secrets || secrets.secretShare === "0") {
    log(`PubShare: no secrets for epoch ${epochId}`);
    return;
  }

  const secretShare = BigInt(`0x${secrets.secretShare}`);

  // Get the dealer hand state to access the deck + per-hand init entropy (v2 hand-derive).
  const dealerHand = await client.getDealerHand(tableId, handId);
  if (!dealerHand) {
    log(`PubShare: dealer hand not available`);
    return;
  }

  const initHeightRaw = dealerHand.initHeight ?? dealerHand.init_height;
  const initSaltRaw = dealerHand.initHashSalt ?? dealerHand.init_hash_salt;
  if (initHeightRaw === undefined || initSaltRaw === undefined) {
    log(`PubShare: dealer hand missing initHeight/initHashSalt (pre-v2 chain state?)`);
    return;
  }
  const initHeight = BigInt(initHeightRaw as string | number);
  const initSalt = decodeSaltBytes(initSaltRaw);
  if (initSalt.length !== 32) {
    log(`PubShare: initHashSalt must be 32 bytes, got ${initSalt.length}`);
    return;
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

import { randomBytes } from "node:crypto";
import {
  concatBytes,
  groupElementFromBytes,
  groupElementToBytes,
  hashToScalar,
  mulBase,
  mulPoint,
  pointAdd,
  scalarFromBytesModOrder,
  scalarMul,
  encShareProve,
  encodeEncShareProof,
} from "@onchainpoker/ocp-crypto";
import { HOLE_SHARE_GAS_MULTIPLIER, type OcpCosmosClient } from "@onchainpoker/ocp-sdk/cosmos";
import type { DealerDaemonConfig } from "../config.js";
import type { EpochStateStore } from "../state.js";
import { log, logProgress } from "../log.js";
import { batches, sharesNow, turnOrder } from "../turns.js";
import type { HandSender } from "./send.js";
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

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
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
 * Sends this daemon's encrypted shares of the hole cards it has not sent yet, all in one
 * transaction: one block for every share instead of one block per share. When transactions of
 * this step failed before, the shares go in halves, then one per transaction (turns.ts batches).
 */
export async function handleEncShares(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
  stateStore: EpochStateStore;
  tableId: string;
  handId: string;
  epochId: number;
  qualified: readonly { validator: string }[];
  threshold: number;
  nowUnix: number;
  sender: HandSender;
}): Promise<void> {
  const { client, config, stateStore, tableId, handId, epochId, sender } = args;
  const key = `t${tableId}:h${handId}:holeShares`;
  if (sender.inflight.holds(key, sender.height)) return;

  // Get the table to find player pubkeys and holePos (on table.hand.dealer)
  const table = await client.getTable(tableId);
  if (!table) {
    log(`EncShares: table ${tableId} not found`);
    return;
  }

  const dealer = table?.hand?.dealer ?? table?.hand?.dealerState;
  const holePosRaw = dealer?.holePos ?? dealer?.hole_pos;
  const holePos: number[] = Array.isArray(holePosRaw)
    ? holePosRaw.map((x: unknown) => asNumber(x)).filter((x): x is number => x !== undefined)
    : [];

  if (holePos.length !== 18) {
    log(`EncShares: holePos length ${holePos.length} !== 18, skipping`);
    return;
  }

  // Get the dealer hand state for the deck + per-hand init entropy (v2 hand-derive).
  const dealerHand = await client.getDealerHand(tableId, handId);
  if (!dealerHand) {
    log(`EncShares: dealer hand not available for table ${tableId} hand ${handId}`);
    return;
  }

  // The last shuffler and the member after it send at once, the others a block later (turns.ts).
  const deadline = asNumber(dealerHand.holeSharesDeadline ?? dealerHand.hole_shares_deadline) ?? 0;
  const order = turnOrder(args.qualified, args.qualified.length - 1);
  if (!sharesNow({ order, threshold: args.threshold, me: config.validatorAddress, openedAtUnix: deadline - dealerTimeoutSecs(table), nowUnix: args.nowUnix })) return;
  const sent = new Set(
    ((dealerHand.encShares ?? dealerHand.enc_shares ?? []) as any[])
      .filter((es) => es?.validator === config.validatorAddress)
      .map((es) => asNumber(es?.pos)),
  );

  const shares = await holeShareMessages({ client, config, stateStore, tableId, handId, epochId, table, dealerHand, deck: dealerHand.deck ?? [], holePos, skip: sent });

  // Every share has the same deadline, so a batch that fails must not hold back the others.
  for (const batch of batches(shares, sender.inflight.failures(key))) {
    const positions = batch.map((s) => s.pos).join(", ");
    const ok = await sender.send({
      key,
      msgs: batch.map((s) => s.msg),
      holdBlocks: 1,
      gasMultiplier: HOLE_SHARE_GAS_MULTIPLIER,
      what: `hole-card shares for table ${tableId} hand ${handId} pos ${positions}`,
    });
    if (ok) logProgress(`EncShares: sent ${batch.length === 1 ? "the share" : `${batch.length} shares`} for pos ${positions} of table ${tableId} hand ${handId}`);
  }
}

/** This validator's encrypted share of each hole card at `holePos` over `deck`, but those in `skip`, as the messages that carry them. */
export async function holeShareMessages(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
  stateStore: EpochStateStore;
  tableId: string;
  handId: string;
  epochId: number;
  table: any;
  dealerHand: any;
  deck: readonly { c1: unknown; c2: unknown }[];
  holePos: readonly number[];
  skip: ReadonlySet<number | undefined>;
}): Promise<{ seat: number; pos: number; msg: ReturnType<OcpCosmosClient["messages"]["submitEncShare"]> }[]> {
  const { client, config, stateStore, tableId, handId, epochId, table, dealerHand, holePos } = args;
  const secrets = await stateStore.load(epochId);
  if (!secrets || secrets.secretShare === null) {
    log(`EncShares: no secrets for epoch ${epochId}`);
    return [];
  }
  const secretShare = BigInt(`0x${secrets.secretShare}`);

  const initHeightRaw = dealerHand.initHeight ?? dealerHand.init_height;
  const initSaltRaw = dealerHand.initHashSalt ?? dealerHand.init_hash_salt;
  if (initHeightRaw == null || initSaltRaw == null) {
    log(`EncShares: dealer hand missing initHeight/initHashSalt (pre-v2 chain state?)`);
    return [];
  }
  const initHeight = BigInt(initHeightRaw as string | number);
  const initSalt = decodeSaltBytes(initSaltRaw);
  if (initSalt.length !== 32) {
    log(`EncShares: initHashSalt must be 32 bytes, got ${initSalt.length}`);
    return [];
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

  const deck = decodeDeck([...args.deck]);

  const seats = Array.isArray(table.seats) ? table.seats : [];
  const shares: { seat: number; pos: number; msg: ReturnType<OcpCosmosClient["messages"]["submitEncShare"]> }[] = [];

  for (let seat = 0; seat < 9; seat++) {
    const seatData = seats[seat];
    if (!seatData?.player) continue;

    const pkPlayerRaw = seatData.pkPlayer ?? seatData.pk_player ?? seatData.pk;
    if (!pkPlayerRaw) continue;

    let pkPlayerPoint;
    let pkPlayerBytes: Uint8Array;
    try {
      pkPlayerBytes = decodeBytes(pkPlayerRaw);
      pkPlayerPoint = groupElementFromBytes(pkPlayerBytes);
    } catch {
      continue;
    }

    for (let cardIdx = 0; cardIdx < 2; cardIdx++) {
      const pos = holePos[seat * 2 + cardIdx];
      if (pos === undefined || pos < 0 || pos === 255 || args.skip.has(pos)) continue;

      const c1 = deck[pos]?.c1;
      if (!c1) continue;

      const d = mulPoint(c1, xHand);
      const r = nonzeroScalar();
      const u = mulBase(r);
      const v = pointAdd(d, mulPoint(pkPlayerPoint, r));
      const proof = encShareProve({
        y: yHand,
        c1,
        pkP: pkPlayerPoint,
        u,
        v,
        x: xHand,
        r,
        wx: nonzeroScalar(),
        wr: nonzeroScalar(),
      });

      shares.push({
        seat,
        pos,
        msg: client.messages.submitEncShare({
          validator: config.validatorAddress,
          tableId,
          handId,
          pos,
          pkPlayer: pkPlayerBytes,
          encShare: concatBytes(groupElementToBytes(u), groupElementToBytes(v)),
          proofEncShare: encodeEncShareProof(proof),
        }),
      });
    }
  }

  return shares;
}

/** The chain's dealer timeout for a table: its own setting, or 120 s when it has none (x/dealer/keeper/logic.go tableDealerTimeoutSecs). */
export function dealerTimeoutSecs(table: any): number {
  const v = asNumber(table?.params?.dealerTimeoutSecs ?? table?.params?.dealer_timeout_secs) ?? 0;
  return v > 0 ? v : 120;
}

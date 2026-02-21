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

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export async function handleEncShares(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
  stateStore: EpochStateStore;
  tableId: string;
  handId: string;
  epochId: number;
}): Promise<void> {
  const { client, config, stateStore, tableId, handId, epochId } = args;

  const secrets = stateStore.load(epochId);
  if (!secrets || secrets.secretShare === "0") {
    log(`EncShares: no secrets for epoch ${epochId}`);
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

  // Get the dealer hand state for the deck
  const dealerHand = await client.getDealerHand(tableId, handId);
  if (!dealerHand) {
    log(`EncShares: dealer hand not available for table ${tableId} hand ${handId}`);
    return;
  }

  const rawDeck = dealerHand.deck ?? [];
  const deck = decodeDeck(rawDeck);

  const seats = Array.isArray(table.seats) ? table.seats : [];

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
      if (pos === undefined || pos < 0 || pos === 255) continue;

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

      const encShare = concatBytes(groupElementToBytes(u), groupElementToBytes(v));
      const proofBytesEncoded = encodeEncShareProof(proof);

      try {
        await client.dealerSubmitEncShare({
          validator: config.validatorAddress,
          tableId,
          handId,
          pos,
          pkPlayer: pkPlayerBytes,
          encShare,
          proofEncShare: proofBytesEncoded,
        });
        log(`EncShares: submitted for seat ${seat} card ${cardIdx} pos ${pos}`);
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        if (msg.includes("already") || msg.includes("duplicate")) {
          // Already submitted — skip this position
        } else if (msg.includes("not in shuffle phase")) {
          log(`EncShares: hand already advanced past shuffle, done`);
          return;
        } else {
          throw err;
        }
      }
    }
  }

  log(`EncShares: all shares submitted for table ${tableId} hand ${handId}`);
}

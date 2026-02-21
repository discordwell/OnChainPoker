import { randomBytes } from "node:crypto";
import {
  groupElementFromBytes,
  groupElementToBytes,
} from "@onchainpoker/ocp-crypto";
import { shuffleProveV1 } from "@onchainpoker/ocp-shuffle";
import type { OcpCosmosClient } from "@onchainpoker/ocp-sdk/cosmos";
import type { DealerDaemonConfig } from "../config.js";
import { log } from "../log.js";

function decodeBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return Uint8Array.from(raw.map((x) => Number(x)));
  if (typeof raw === "string" && raw.length > 0) {
    return Uint8Array.from(Buffer.from(raw, "base64"));
  }
  throw new Error(`unsupported bytes value: ${typeof raw}`);
}

function decodeDeck(rawDeck: any[]) {
  return (rawDeck ?? []).map((entry: any, idx: number) => {
    if (!entry) throw new Error(`missing deck entry ${idx}`);
    return {
      c1: groupElementFromBytes(decodeBytes(entry.c1)),
      c2: groupElementFromBytes(decodeBytes(entry.c2)),
    };
  });
}

export async function handleShuffle(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
  tableId: string;
  handId: string;
  shuffleStep: number;
  epochMembers: Array<{ validator: string; index: number }>;
}): Promise<void> {
  const { client, config, tableId, handId, epochMembers } = args;

  // Fetch current dealer hand state — this is the authoritative source for shuffleStep
  const dealerHand = await client.getDealerHand(tableId, handId);
  if (!dealerHand) throw new Error(`dealer hand not found for table ${tableId} hand ${handId}`);

  const actualStep = Number(dealerHand.shuffleStep ?? dealerHand.shuffle_step ?? 0);

  // Determine if it's our turn
  const memberIdx = actualStep % epochMembers.length;
  const expectedShuffler = epochMembers[memberIdx]?.validator;
  if (!expectedShuffler || expectedShuffler.toLowerCase() !== config.validatorAddress.toLowerCase()) {
    return; // Not our turn
  }

  const round = actualStep + 1;
  log(`Shuffle: our turn (step ${round}/${epochMembers.length}) for table ${tableId} hand ${handId}`);

  const pkHandRaw = dealerHand.pkHand ?? dealerHand.pk_hand;
  if (!pkHandRaw) throw new Error("dealer hand missing pkHand");

  const pkHand = groupElementFromBytes(decodeBytes(pkHandRaw));
  const rawDeck = dealerHand.deck ?? [];
  const deck = decodeDeck(rawDeck);

  const seed = randomBytes(32);
  const { proofBytes } = shuffleProveV1(pkHand, deck, {
    rounds: config.shuffleRounds,
    seed,
  });

  log(`Shuffle: submitting proof for round ${round}`);

  await client.dealerSubmitShuffle({
    shuffler: config.validatorAddress,
    tableId,
    handId,
    round,
    proofShuffle: proofBytes,
  });

  log(`Shuffle: submitted round ${round} for table ${tableId} hand ${handId}`);
}

export { decodeBytes, decodeDeck };

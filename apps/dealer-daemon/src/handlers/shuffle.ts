import { groupElementFromBytes } from "@onchainpoker/ocp-crypto";
import { shuffleProveV1, buildShuffleContext } from "@onchainpoker/ocp-shuffle";
import type { OcpCosmosClient } from "@onchainpoker/ocp-sdk/cosmos";
import type { DealerDaemonConfig } from "../config.js";
import { log, logProgress } from "../log.js";

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
  /**
   * The members the chain asks to shuffle, in its order: shufflersOf(epoch). The chain indexes its
   * list of members that are not slashed with shuffleStep. Indexing all members made a daemon wait
   * for a slashed member while the chain waited for, and then slashed, the next one.
   */
  shufflers: readonly { validator: string; index: number }[];
}): Promise<void> {
  const { client, config, tableId, handId, shufflers } = args;

  // Fetch current dealer hand state — this is the authoritative source for shuffleStep
  const dealerHand = await client.getDealerHand(tableId, handId);
  if (!dealerHand) throw new Error(`dealer hand not found for table ${tableId} hand ${handId}`);

  const actualStep = Number(dealerHand.shuffleStep ?? dealerHand.shuffle_step ?? 0);

  // Shuffle phase has N rounds (one per qualified member). When actualStep
  // reaches N the chain refuses further submissions and the next message is
  // FinalizeDeck. Without this guard, modulo wraparound (step 3 % 3 = 0)
  // would tell whoever is shufflers[0] to re-shuffle, producing wasted
  // proofs that the chain rejects with "deck already finalized".
  if (actualStep >= shufflers.length) return;

  const expectedShuffler = shufflers[actualStep]?.validator;
  if (!expectedShuffler || expectedShuffler.toLowerCase() !== config.validatorAddress.toLowerCase()) {
    return; // Not our turn
  }

  const round = actualStep + 1;
  log(`Shuffle: our turn (step ${round}/${shufflers.length}) for table ${tableId} hand ${handId}`);

  const pkHandRaw = dealerHand.pkHand ?? dealerHand.pk_hand;
  if (!pkHandRaw) throw new Error("dealer hand missing pkHand");

  const pkHand = groupElementFromBytes(decodeBytes(pkHandRaw));
  const rawDeck = dealerHand.deck ?? [];
  const deck = decodeDeck(rawDeck);

  // Bind full context (tableId, handId, round, shuffler) into the Fiat-Shamir
  // transcript of every inner proof. Emits a v2 proof; the Go verifier must
  // rebuild the same context bytes byte-for-byte.
  const context = buildShuffleContext({
    tableId: BigInt(tableId),
    handId: BigInt(handId),
    round,
    shuffler: config.validatorAddress,
  });

  // SECURITY: do NOT pass a seed; shuffleProveV1 uses randomBytes(32) internally.
  // Reusing seeds across shuffles leaks re-encryption randomness rho.
  const { proofBytes } = shuffleProveV1(pkHand, deck, {
    rounds: config.shuffleRounds,
    context,
  });

  log(`Shuffle: submitting proof for round ${round}`);

  await client.dealerSubmitShuffle({
    shuffler: config.validatorAddress,
    tableId,
    handId,
    round,
    proofShuffle: proofBytes,
  });

  logProgress(`Shuffle: submitted round ${round} for table ${tableId} hand ${handId}`);
}

export { decodeBytes, decodeDeck };

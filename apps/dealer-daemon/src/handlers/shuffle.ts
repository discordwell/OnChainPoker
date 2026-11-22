import { groupElementFromBytes } from "@onchainpoker/ocp-crypto";
import { shuffleProveV1, buildShuffleContext } from "@onchainpoker/ocp-shuffle";
import type { OcpCosmosClient } from "@onchainpoker/ocp-sdk/cosmos";
import type { DealerDaemonConfig } from "../config.js";
import { log, logProgress } from "../log.js";
import { BLIND_GAS, type HandSender } from "./send.js";

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
  sender: HandSender;
}): Promise<void> {
  const { client, config, tableId, handId, shufflers, sender } = args;
  const key = `t${tableId}:h${handId}:shuffle`;

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

  // A proof takes seconds of processor time: never made again while the last one may still land.
  if (sender.inflight.holds(key, sender.height)) return;

  const round = actualStep + 1;
  log(`Shuffle: our turn (step ${round}/${shufflers.length}) for table ${tableId} hand ${handId}`);

  const rawDeck = dealerHand.deck ?? [];
  const proofBytes = proveRound(config, dealerHand.pkHand ?? dealerHand.pk_hand, rawDeck, tableId, handId, round);

  const shuffled = await sender.send({
    key,
    msgs: [client.messages.submitShuffle({ shuffler: config.validatorAddress, tableId, handId, round, proofShuffle: proofBytes })],
    holdBlocks: Infinity,
    what: `shuffle round ${round} of table ${tableId} hand ${handId}`,
  });
  if (!shuffled) return;
  logProgress(`Shuffle: sent round ${round} for table ${tableId} hand ${handId}`);

  // The last round makes the deck final: FinalizeDeck lands in the shuffle's own block, behind it.
  if (round === shufflers.length) {
    await sender.send({
      key: `t${tableId}:h${handId}:finalizeDeck`,
      msgs: [client.messages.finalizeDeck({ tableId, handId })],
      holdBlocks: 0,
      gasLimit: BLIND_GAS.finalizeDeck,
      what: `finalize deck of table ${tableId} hand ${handId}, behind my last shuffle`,
    });
  }
}

/** This validator's proof for `round` over `deck` (the chain's entries or a proof's). Seconds of processor time. */
export function proveRound(config: DealerDaemonConfig, pkHandRaw: unknown, deck: readonly { c1: unknown; c2: unknown }[], tableId: string, handId: string, round: number): Uint8Array {
  if (!pkHandRaw) throw new Error("dealer hand missing pkHand");
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
  return shuffleProveV1(groupElementFromBytes(decodeBytes(pkHandRaw)), decodeDeck([...deck]), { rounds: config.shuffleRounds, context }).proofBytes;
}

export { decodeBytes, decodeDeck };

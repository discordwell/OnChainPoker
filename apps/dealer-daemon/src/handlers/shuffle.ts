import { elgamalEncrypt, groupElementFromBytes, groupElementToBytes, hashToScalar, mulBase, mulPoint, scalarToBytes } from "@onchainpoker/ocp-crypto";
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
  /** A proof made before this round's turn came (see Ahead). Used only when it was made on the chain's deck. */
  ahead?: Ahead | null;
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
  const ahead = args.ahead;
  const made = ahead && ahead.tableId === tableId && ahead.handId === handId && ahead.round === round && ahead.inputKey === deckKey(rawDeck);
  if (made) logProgress(`Shuffle: round ${round} for table ${tableId} hand ${handId} was proved ahead, on the deck the round before it left`);
  const proofBytes = made ? ahead.proofBytes : proveRound(config, dealerHand.pkHand ?? dealerHand.pk_hand, rawDeck, tableId, handId, round);

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

/** A round proved ahead, on the deck that the pending round before it leaves (finalDeckOf). */
export type Ahead = { tableId: string; handId: string; round: number; inputKey: string; proofBytes: Uint8Array };

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

/**
 * The deck a shuffle proof ends with: its last round's deck snapshot. Layout from
 * packages/ocp-shuffle/src/shuffle_v1.ts: a header (version 2 carries its context), then per round
 * the deck (64 bytes a card), a 416-byte switch proof per adjacent pair and a 96-byte proof per
 * card left single, the pairs starting at card 0 in even rounds and at card 1 in odd ones.
 */
export function finalDeckOf(proof: Uint8Array): { c1: Uint8Array; c2: Uint8Array }[] {
  const u16 = (at: number) => proof[at]! | (proof[at + 1]! << 8);
  const version = proof[0];
  if (version !== 1 && version !== 2) throw new Error(`shuffle proof version ${version}`);
  const n = u16(1);
  const rounds = u16(3);
  let at = version === 2 ? 7 + u16(5) : 5;
  for (let round = 0; round < rounds - 1; round++) {
    const pairs = Math.floor((n - (round % 2)) / 2);
    at += n * 64 + pairs * 416 + (n - 2 * pairs) * 96;
  }
  if (rounds < 1 || at + n * 64 > proof.length) throw new Error("shuffle proof shorter than its header says");
  return Array.from({ length: n }, (_, i) => ({ c1: proof.slice(at + i * 64, at + i * 64 + 32), c2: proof.slice(at + i * 64 + 32, at + i * 64 + 64) }));
}

const le = (v: bigint, bytes: number) => {
  const out = new Uint8Array(bytes);
  for (let i = 0, x = BigInt.asUintN(bytes * 8, v); i < bytes; i++, x >>= 8n) out[i] = Number(x & 0xffn);
  return out;
};

/**
 * The deck InitHand makes at `initHeight` (x/dealer/keeper msg_server.go InitHand and logic.go):
 * the hand scalar k from the epoch, table, hand, height and salt; pkHand = k·pkEpoch; card c is
 * ((r·G), (c+1)·G + r·pkHand) with r the first non-zero hash of k and c. The salt is the block's
 * LastBlockId hash, which this chain's handlers see as empty: 32 zero bytes.
 */
export function initialDeck(args: { pkEpoch: Uint8Array; epochId: number; tableId: string; handId: string; initHeight: number; initSalt?: Uint8Array; deckSize?: number }): {
  pkHand: Uint8Array;
  deck: { c1: Uint8Array; c2: Uint8Array }[];
} {
  const k = hashToScalar(
    "ocp/v1/dealer/hand-derive/v2",
    le(BigInt(args.epochId), 8),
    le(BigInt(args.tableId), 8),
    le(BigInt(args.handId), 8),
    le(BigInt(args.initHeight), 8),
    args.initSalt ?? new Uint8Array(32),
  );
  const pkHand = mulPoint(groupElementFromBytes(args.pkEpoch), k);
  const kBytes = scalarToBytes(k);
  const deck = Array.from({ length: args.deckSize ?? 52 }, (_, card) => {
    let r = 0n;
    for (let counter = 0; r === 0n && counter < 256; counter++) {
      const parts = [kBytes, le(BigInt(card), 2)];
      if (counter > 0) parts.push(new Uint8Array([counter]));
      r = hashToScalar("ocp/v1/dealer/deck-init", ...parts);
    }
    const ct = elgamalEncrypt(pkHand, mulBase(BigInt(card + 1)), r);
    return { c1: groupElementToBytes(ct.c1), c2: groupElementToBytes(ct.c2) };
  });
  return { pkHand: groupElementToBytes(pkHand), deck };
}

/** One deck as a string, from the chain's entries (base64) or a proof's (bytes), to tell two decks apart. */
export function deckKey(deck: readonly { c1: unknown; c2: unknown }[]): string {
  return deck.map((e) => Buffer.from(decodeBytes(e.c1)).toString("hex") + Buffer.from(decodeBytes(e.c2)).toString("hex")).join("");
}

export { decodeBytes, decodeDeck };

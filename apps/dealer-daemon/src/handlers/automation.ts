import { txFailureOf, type OcpCosmosClient } from "@onchainpoker/ocp-sdk/cosmos";
import type { DealerDaemonConfig } from "../config.js";
import { log, logProgress } from "../log.js";
import { sharesNow, turnOrder } from "../turns.js";
import type { HandSender } from "./send.js";

/**
 * Tick and Timeout probe by sending, so a refusal says only "not due" and stays silent. A
 * transaction that may have landed, or that expired, is news.
 */
function reportIfInDoubt(what: string, err: unknown): void {
  const failure = txFailureOf(err);
  if (failure.kind === "unknown" || failure.kind === "expired") log(`Automation: ${what} ${failure.kind}: ${String(err)}`);
}

function pick(obj: any, ...keys: string[]): any {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) {
      return obj[k];
    }
  }
  return undefined;
}

/**
 * A hand the chain shows started but not initialized: its InitHand did not land with it. The
 * member whose turn it is sends at once, the others once an earlier block showed it too.
 */
export async function maybeInitHand(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
  tableId: string;
  handId: string;
  epochId: number;
  qualified: readonly { validator: string }[];
  /** The first height at which this daemon saw the hand uninitialized. */
  seenSince: number;
  sender: HandSender;
}): Promise<void> {
  const { client, config, tableId, handId, epochId, sender } = args;
  const key = `t${tableId}:h${handId}:init`;
  if (sender.inflight.holds(key, sender.height)) return;
  const rank = turnOrder(args.qualified, Number(handId)).indexOf(config.validatorAddress);
  if (rank < 0 || (rank > 0 && args.seenSince >= sender.height)) return;
  await sender.send({
    key,
    msgs: [client.messages.initHand({ tableId, handId, epochId })],
    holdBlocks: 1,
    what: `init hand ${handId} of table ${tableId}`,
  });
}

/**
 * Every round shuffled and the deck not final: the FinalizeDeck behind the last shuffle did not
 * land. The last shuffler sends again at once, the others from the block after the last shuffle.
 */
export async function maybeFinalizeDeck(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
  tableId: string;
  handId: string;
  qualified: readonly { validator: string }[];
  /** The block time of the last shuffle: the hand's shuffle deadline minus the table's dealer timeout. */
  shuffledAtUnix: number;
  nowUnix: number;
  sender: HandSender;
}): Promise<void> {
  const { client, config, tableId, handId, sender } = args;
  if (!config.autoFinalize) return;
  const key = `t${tableId}:h${handId}:finalizeDeck`;
  if (sender.inflight.holds(key, sender.height)) return;
  const order = turnOrder(args.qualified, args.qualified.length - 1);
  if (!sharesNow({ order, threshold: 1, me: config.validatorAddress, openedAtUnix: args.shuffledAtUnix, nowUnix: args.nowUnix })) return;
  await sender.send({
    key,
    msgs: [client.messages.finalizeDeck({ tableId, handId })],
    holdBlocks: 0,
    what: `finalize deck of table ${tableId} hand ${handId}`,
  });
}

export async function maybeTick(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
  tableId: string;
}): Promise<boolean> {
  const { client, tableId } = args;

  try {
    await client.pokerTick({ tableId });
    logProgress(`Automation: tick for table ${tableId}`);
    return true;
  } catch (err) {
    reportIfInDoubt(`tick for table ${tableId}`, err);
    return false;
  }
}

export async function maybeDealerTimeout(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
  tableId: string;
  handId: string;
}): Promise<boolean> {
  const { client, tableId, handId } = args;

  try {
    await client.dealerTimeout({ tableId, handId });
    logProgress(`Automation: dealer timeout for table ${tableId} hand ${handId}`);
    return true;
  } catch (err) {
    reportIfInDoubt(`dealer timeout for table ${tableId} hand ${handId}`, err);
    return false;
  }
}

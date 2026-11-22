import { txFailureOf, type OcpCosmosClient } from "@onchainpoker/ocp-sdk/cosmos";
import type { DealerDaemonConfig } from "../config.js";
import { log, logProgress } from "../log.js";

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

export async function maybeStartAndInitHand(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
  tableId: string;
  epochId: number;
}): Promise<boolean> {
  const { client, config, tableId, epochId } = args;
  if (!config.autoInitHand) return false;

  const table = await client.getTable(tableId).catch(() => null);
  if (!table) return false;

  // Check if there's an active hand
  const handId = pick(table?.hand, "handId", "hand_id");
  if (handId) return false; // already has an active hand

  // Check if enough players are seated
  const seats = Array.isArray(table.seats) ? table.seats : [];
  const seatedCount = seats.filter((s: any) => s?.player).length;
  if (seatedCount < 2) return false;

  log(`Automation: table ${tableId} has ${seatedCount} players, starting hand`);

  try {
    await client.pokerStartHand({ tableId });
    logProgress(`Automation: hand started for table ${tableId}`);

    // Re-fetch table to get the new hand ID
    const updatedTable = await client.getTable(tableId).catch(() => null);
    const newHandId = String(pick(updatedTable?.hand, "handId", "hand_id") ?? "1");

    // Init the dealer hand
    await client.dealerInitHand({
      tableId,
      handId: newHandId,
      epochId,
    });
    logProgress(`Automation: dealer hand initialized for table ${tableId} hand ${newHandId}`);
    return true;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    log(`Automation: startHand/initHand failed: ${msg}`);
    return false;
  }
}

export async function maybeFinalizeDeck(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
  tableId: string;
  handId: string;
}): Promise<boolean> {
  const { client, config, tableId, handId } = args;
  if (!config.autoFinalize) return false;

  try {
    await client.dealerFinalizeDeck({ tableId, handId });
    logProgress(`Automation: deck finalized for table ${tableId} hand ${handId}`);
    return true;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (!msg.includes("already") && !msg.includes("not ready")) {
      log(`Automation: finalizeDeck failed: ${msg}`);
    }
    return false;
  }
}

export async function maybeFinalizeReveal(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
  tableId: string;
  handId: string;
  pos: number;
}): Promise<boolean> {
  const { client, config, tableId, handId, pos } = args;
  if (!config.autoFinalize) return false;

  try {
    await client.dealerFinalizeReveal({ tableId, handId, pos });
    logProgress(`Automation: reveal finalized for pos ${pos} table ${tableId}`);
    return true;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (!msg.includes("already") && !msg.includes("not enough")) {
      log(`Automation: finalizeReveal failed: ${msg}`);
    }
    return false;
  }
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

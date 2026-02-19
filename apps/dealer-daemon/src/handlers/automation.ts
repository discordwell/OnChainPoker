import type { OcpCosmosClient } from "@onchainpoker/ocp-sdk/cosmos";
import type { DealerDaemonConfig } from "../config.js";
import { log } from "../log.js";

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
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

/** Returns true if this validator is the designated gamemaster (lowest sorted address) */
function isGamemasterForEpoch(
  config: DealerDaemonConfig,
  members: Array<{ validator: string; index: number }>
): boolean {
  if (!config.isGamemaster) return false;
  if (members.length === 0) return true; // no epoch yet, we can try
  const sorted = [...members].sort((a, b) =>
    a.validator.localeCompare(b.validator)
  );
  return sorted[0]?.validator.toLowerCase() === config.validatorAddress.toLowerCase();
}

export async function maybeBeginEpoch(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
}): Promise<boolean> {
  const { client, config } = args;
  if (!config.autoBeginEpoch || !config.isGamemaster) return false;

  // Check if there's already an active epoch
  const epoch = await client.getDealerEpoch().catch(() => null);
  if (epoch) return false; // already have an epoch

  // Check if DKG is in flight
  const dkg = await client.getDealerDkg().catch(() => null);
  if (dkg) return false; // DKG in progress

  log("Automation: no active epoch and no DKG, beginning new epoch");

  try {
    await client.dealerBeginEpoch({
      committeeSize: config.committeeSize,
      threshold: config.threshold,
    });
    log("Automation: epoch begun");
    return true;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (!msg.includes("already")) {
      log(`Automation: beginEpoch failed: ${msg}`);
    }
    return false;
  }
}

export async function maybeFinalizeEpoch(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
  epochId: number;
}): Promise<boolean> {
  const { client, config, epochId } = args;
  if (!config.autoFinalize) return false;

  try {
    await client.dealerFinalizeEpoch({ epochId });
    log(`Automation: epoch ${epochId} finalized`);
    return true;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (msg.includes("too early") || msg.includes("already") || msg.includes("retry")) {
      return false; // expected, not ready yet
    }
    log(`Automation: finalizeEpoch failed: ${msg}`);
    return false;
  }
}

export async function maybeStartAndInitHand(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
  tableId: string;
  epochId: number;
}): Promise<boolean> {
  const { client, config, tableId, epochId } = args;
  if (!config.autoInitHand || !config.isGamemaster) return false;

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
    log(`Automation: hand started for table ${tableId}`);

    // Re-fetch table to get the new hand ID
    const updatedTable = await client.getTable(tableId).catch(() => null);
    const newHandId = String(pick(updatedTable?.hand, "handId", "hand_id") ?? "1");

    // Init the dealer hand
    await client.dealerInitHand({
      tableId,
      handId: newHandId,
      epochId,
    });
    log(`Automation: dealer hand initialized for table ${tableId} hand ${newHandId}`);
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
    log(`Automation: deck finalized for table ${tableId} hand ${handId}`);
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
    log(`Automation: reveal finalized for pos ${pos} table ${tableId}`);
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
  const { client, config, tableId } = args;
  if (!config.isGamemaster) return false;

  try {
    await client.pokerTick({ tableId });
    log(`Automation: tick for table ${tableId}`);
    return true;
  } catch (err) {
    // Tick failures are expected when no timeout has elapsed
    return false;
  }
}

export async function maybeDealerTimeout(args: {
  client: OcpCosmosClient;
  config: DealerDaemonConfig;
  tableId: string;
  handId: string;
}): Promise<boolean> {
  const { client, config, tableId, handId } = args;
  if (!config.isGamemaster) return false;

  try {
    await client.dealerTimeout({ tableId, handId });
    log(`Automation: dealer timeout for table ${tableId} hand ${handId}`);
    return true;
  } catch (err) {
    // Timeout failures are expected when deadline hasn't passed
    return false;
  }
}


import type { EventFilter, EventPage, OcpEvent } from "./events.js";
import type { EncShareArtifact, HandState, Hex, SeatIndex, TableId, TableState, U64 } from "./types.js";
import type { OcpTx } from "./tx.js";

export interface RpcTransport {
  request<T>(method: string, params?: unknown): Promise<T>;
}

export type BroadcastTxResult = {
  txHash: Hex;
  height?: U64;
};

export class OcpRpcClient {
  readonly transport: RpcTransport;

  constructor(transport: RpcTransport) {
    this.transport = transport;
  }

  // --- Tx submission ---
  async broadcastTx(txBytes: Hex): Promise<BroadcastTxResult> {
    return this.transport.request<BroadcastTxResult>("ocp_broadcastTx", { txBytes });
  }

  // Optional convenience if a chain implements typed tx submission directly.
  async submitTypedTx(tx: OcpTx): Promise<BroadcastTxResult> {
    return this.transport.request<BroadcastTxResult>("ocp_submitTx", { tx });
  }

  // --- Queries ---
  async getTable(tableId: TableId): Promise<TableState> {
    return this.transport.request<TableState>("ocp_getTable", { tableId });
  }

  async getHand(tableId: TableId, handId: U64): Promise<HandState> {
    return this.transport.request<HandState>("ocp_getHand", { tableId, handId });
  }

  async getEvents(args: { cursor?: string; filter?: EventFilter; limit?: number } = {}): Promise<EventPage> {
    const { cursor, filter, limit } = args;
    return this.transport.request<EventPage>("ocp_getEvents", { cursor, filter, limit });
  }

  async getHoleCardPositions(args: { tableId: TableId; handId: U64; seat: SeatIndex }): Promise<{ pos0: number; pos1: number }> {
    const { tableId, handId, seat } = args;
    return this.transport.request<{ pos0: number; pos1: number }>("ocp_getHoleCardPositions", { tableId, handId, seat });
  }

  async getDealerCiphertext(args: { tableId: TableId; handId: U64; pos: number }): Promise<{ ciphertext: Hex }> {
    const { tableId, handId, pos } = args;
    return this.transport.request<{ ciphertext: Hex }>("ocp_getDealerCiphertext", { tableId, handId, pos });
  }

  async getDealerEncShares(args: { tableId: TableId; handId: U64; pos: number; pkPlayer?: Hex }): Promise<{ shares: EncShareArtifact[] }> {
    const { tableId, handId, pos, pkPlayer } = args;
    return this.transport.request<{ shares: EncShareArtifact[] }>("ocp_getDealerEncShares", { tableId, handId, pos, pkPlayer });
  }

  // --- Event subscription (polling) ---
  async *subscribeEvents(args: {
    cursor?: string;
    filter?: EventFilter;
    limit?: number;
    pollIntervalMs?: number;
    signal?: AbortSignal;
  } = {}): AsyncGenerator<OcpEvent, void, void> {
    let cursor = args.cursor;
    const limit = args.limit ?? 200;
    const pollIntervalMs = args.pollIntervalMs ?? 1000;

    for (;;) {
      if (args.signal?.aborted) return;

      const page = await this.getEvents({ cursor, filter: args.filter, limit });
      const events = page.events ?? [];

      for (const ev of events) {
        yield ev;
      }

      cursor = page.nextCursor ?? cursor;

      if (events.length === 0) {
        await sleep(pollIntervalMs, args.signal);
      }
    }
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });
}


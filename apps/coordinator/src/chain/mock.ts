import { EventEmitter } from "node:events";
import type { ChainAdapter } from "./adapter.js";
import type { ChainEvent, TableInfo, TableParams, TableStatus } from "../types.js";

type MockTableState = {
  tableId: string;
  params: TableParams;
  status: TableStatus;
  updatedAtMs: number;
};

export class MockChainAdapter implements ChainAdapter {
  readonly kind = "mock" as const;

  private readonly emitter = new EventEmitter();
  private readonly tablesById = new Map<string, MockTableState>();
  private readonly events: ChainEvent[] = [];
  private nextEventIndex = 1;

  subscribe(cb: (event: ChainEvent) => void): () => void {
    this.emitter.on("event", cb);
    return () => this.emitter.off("event", cb);
  }

  async listTables(): Promise<TableInfo[]> {
    return [...this.tablesById.values()].map((t) => ({ ...t }));
  }

  async getTable(tableId: string): Promise<TableInfo | null> {
    const t = this.tablesById.get(tableId);
    return t ? { ...t } : null;
  }

  getEventsSince(eventIndex: number): ChainEvent[] {
    return this.events.filter((e) => e.eventIndex > eventIndex).map((e) => ({ ...e }));
  }

  createTable(
    tableId: string,
    params: Partial<TableParams> = {}
  ): TableInfo {
    const nowMs = Date.now();
    const fullParams: TableParams = {
      maxPlayers: 9,
      smallBlind: "1",
      bigBlind: "2",
      minBuyIn: "100",
      maxBuyIn: "1000",
      ...params
    };

    const state: MockTableState = {
      tableId,
      params: fullParams,
      status: "open",
      updatedAtMs: nowMs
    };
    this.tablesById.set(tableId, state);
    this.publishEvent({
      name: "TableCreated",
      tableId,
      data: { params: fullParams }
    });
    return { ...state };
  }

  startHand(tableId: string, handId: string): void {
    const t = this.tablesById.get(tableId);
    if (!t) throw new Error(`unknown table: ${tableId}`);
    t.status = "in_hand";
    t.updatedAtMs = Date.now();
    this.publishEvent({ name: "HandStarted", tableId, handId });
  }

  completeHand(tableId: string, handId: string): void {
    const t = this.tablesById.get(tableId);
    if (!t) throw new Error(`unknown table: ${tableId}`);
    t.status = "open";
    t.updatedAtMs = Date.now();
    this.publishEvent({ name: "HandCompleted", tableId, handId });
  }

  publishEvent(input: Omit<ChainEvent, "eventIndex" | "timeMs"> & { timeMs?: number }): ChainEvent {
    const ev: ChainEvent = {
      name: input.name,
      tableId: input.tableId,
      handId: input.handId,
      data: input.data,
      eventIndex: this.nextEventIndex++,
      timeMs: input.timeMs ?? Date.now()
    };
    this.events.push(ev);
    this.emitter.emit("event", ev);
    return ev;
  }
}

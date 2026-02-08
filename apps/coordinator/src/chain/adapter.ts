import type { ChainEvent, TableInfo } from "../types.js";

export interface ChainAdapter {
  readonly kind: string;

  start?(): Promise<void>;
  stop?(): Promise<void>;

  listTables(): Promise<TableInfo[]>;
  getTable(tableId: string): Promise<TableInfo | null>;

  subscribe(cb: (event: ChainEvent) => void): () => void;
}

import type { ChainEvent, TableInfo } from "../types.js";

export interface ChainAdapter {
  readonly kind: string;

  start?(): Promise<void>;
  stop?(): Promise<void>;

  listTables(): Promise<TableInfo[]>;
  getTable(tableId: string): Promise<TableInfo | null>;

  subscribe(cb: (event: ChainEvent) => void): () => void;

  /**
   * Optional raw query interface for chain-specific features.
   * For the v0 CometBFT + ABCI scaffold, this maps to `abci_query` paths.
   */
  queryJson?<T = unknown>(path: string): Promise<T | null>;
}

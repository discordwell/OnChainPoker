// Two reads of the node a client is connected to that are not transactions: one key of a module's
// store, and the node's own status. signing.ts owns the connection. This file owns what counts as
// an answer.

/**
 * One raw store read: abci_query on "/store/<store>/key".
 * `height` omitted means the latest state, and the answer says which height that was, so the reads
 * that follow can be pinned to it. `value` is null when the key is absent at that height.
 * Rejects when the node cannot answer, refuses, or does not answer from the state asked for.
 */
export type QueryStore = (
  store: string,
  key: Uint8Array,
  height?: number
) => Promise<{ value: Uint8Array | null; height: number }>;

/** What the node says about itself. */
export type NodeStatus = {
  readonly latestHeight: number;
  /** Header time of the latest block, in Unix milliseconds. */
  readonly latestBlockTimeMs: number;
  readonly catchingUp: boolean;
  /** The ed25519 consensus key this node signs blocks with. null when it holds none of that type. */
  readonly consensusPubkey: Uint8Array | null;
};

export type NodeReads = {
  queryStore: QueryStore;
  nodeStatus: () => Promise<NodeStatus>;
};

/** The two CometBFT RPC calls these reads make. CometClient of @cosmjs/tendermint-rpc has this shape. */
export interface CometReads {
  abciQuery(params: { path: string; data: Uint8Array; height?: number; prove?: boolean }): Promise<{
    readonly value: Uint8Array;
    readonly height?: number;
    readonly code?: number;
    readonly log?: string;
  }>;
  status(): Promise<{
    readonly syncInfo: {
      readonly latestBlockHeight: number;
      readonly latestBlockTime: { getTime(): number };
      readonly catchingUp: boolean;
    };
    readonly validatorInfo: { readonly pubkey?: { readonly algorithm: string; readonly data: Uint8Array } };
  }>;
}

/** `comet` is a getter because the owner of the connection replaces it when it reconnects. */
export function nodeReadsOver(comet: () => CometReads): NodeReads {
  return {
    async queryStore(store, key, height) {
      const res = await comet().abciQuery({ path: `/store/${store}/key`, data: key, height, prove: false });
      const code = res.code ?? 0;
      if (code !== 0) throw new Error(`store "${store}" refused the read: code ${code}${res.log ? `: ${res.log}` : ""}`);
      // A height the node no longer keeps answers code 0, an empty value and only this log
      // (cosmossdk.io/store iavl/store.go, Query). Read as "absent" it would say "no DKG, no epoch".
      if (res.log) throw new Error(`store "${store}" did not answer from the state asked for: ${res.log}`);
      if (res.height === undefined || res.height <= 0) throw new Error(`store "${store}" answered without a height`);
      if (height !== undefined && res.height !== height) {
        throw new Error(`store "${store}" answered at height ${res.height}, not the height asked for, ${height}`);
      }
      return { value: res.value.length > 0 ? res.value : null, height: res.height };
    },

    async nodeStatus() {
      const status = await comet().status();
      const key = status.validatorInfo.pubkey;
      return {
        latestHeight: status.syncInfo.latestBlockHeight,
        latestBlockTimeMs: status.syncInfo.latestBlockTime.getTime(),
        catchingUp: status.syncInfo.catchingUp,
        consensusPubkey: key && key.algorithm === "ed25519" ? key.data : null,
      };
    },
  };
}

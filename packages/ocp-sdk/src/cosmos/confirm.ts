// Did a transaction land, and with what result? Answered from blocks only: the tx index is off on
// every live node, so nothing here may look a transaction up by hash (LCD /txs/{hash}, tx, tx_search).
// Public: TxFailure, OcpTxError, txFailureOf (cosmos/index.ts exports only these).

import type { DeliverTxResponse } from "@cosmjs/stargate";

/** Why a transaction helper did not resolve. Exactly one of these, or the helper resolved. */
export type TxFailure =
  /** Refused before the mempool, by simulate or CheckTx. No effect; the sequence did not move. */
  | { readonly kind: "rejected"; readonly log: string }
  /** In a block with a non-zero code. No effect except the sequence. */
  | { readonly kind: "failed"; readonly hash: string; readonly height: number; readonly code: number; readonly codespace: string; readonly log: string }
  /** The chain is past timeoutHeight and no block up to it holds the tx. It can never land. */
  | { readonly kind: "expired"; readonly hash: string; readonly timeoutHeight: number }
  /**
   * "I do not know whether it landed": the node could not be read through timeoutHeight in time.
   * The tx is in a block in (sentAtHeight, timeoutHeight], or it never lands.
   */
  | { readonly kind: "unknown"; readonly hash: string; readonly sentAtHeight: number; readonly timeoutHeight: number; readonly why: string }
  /** Not a transaction outcome: a read or transport error from somewhere else. */
  | { readonly kind: "not-a-tx"; readonly error: unknown };

type TxOutcome = Exclude<TxFailure, { kind: "not-a-tx" }>;

/**
 * Thrown by signAndBroadcastAuto and every pokerX / dealerX helper. For "rejected" and "failed" the
 * message carries the chain's own text, so callers that match substrings ("already") keep working.
 */
export class OcpTxError extends Error {
  readonly failure: TxOutcome;
  constructor(failure: TxOutcome) {
    super(messageFor(failure));
    this.name = "OcpTxError";
    this.failure = failure;
  }
}

// The daemon matches error text ("already", "deadline", "retry", "too early"); these sentences avoid those words.
function messageFor(f: TxOutcome): string {
  switch (f.kind) {
    case "rejected":
      return f.log;
    case "failed":
      return `tx failed: code=${f.code} log=${f.log}`;
    case "expired":
      return `tx ${f.hash} expired: no block up to its timeout height ${f.timeoutHeight} holds it, so it never lands`;
    case "unknown":
      return `tx ${f.hash} not confirmed: ${f.why}. It is in a block from height ${f.sentAtHeight + 1} to ${f.timeoutHeight}, or it never lands`;
  }
}

/** Total. An OcpTxError gives its failure; anything else gives { kind: "not-a-tx" }. */
export function txFailureOf(err: unknown): TxFailure {
  return err instanceof OcpTxError ? err.failure : { kind: "not-a-tx", error: err };
}

// ---------------------------------------------------------------------------------------------
// Internal from here down.
// ---------------------------------------------------------------------------------------------

export const CONFIRM_LIMITS = {
  /**
   * Every tx is signed with timeout_height = latest + ttl; the ante chain refuses it after that
   * (apps/cosmos/app/ante.go, TxTimeoutHeightDecorator). A person approving in a wallet needs longer.
   */
  ttlBlocks: { service: 6, interactive: 60 },
  /** Wall-clock cap from the broadcast. 6 blocks at 5.3 s is 32 s. Past it: "unknown". */
  maxWaitMs: 45_000,
  /** How often the latest height is asked for while waiting. */
  pollMs: 700,
} as const;

export type Clock = {
  now(): number;
  /** Resolves after `ms`. Aborting `signal` drops the timer, and the promise then never settles. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
    }),
};

/** Settles as `p` does, or rejects once `deadline` passes. A node that never answers cannot hold the caller. */
export async function answerBy<T>(p: Promise<T>, deadline: number, clock: Clock): Promise<T> {
  const stop = new AbortController();
  const late = clock.sleep(Math.max(0, deadline - clock.now()), stop.signal).then((): never => {
    throw new Error("the node did not answer in time");
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    stop.abort();
  }
}

/** The three reads confirmation needs. signing.ts adapts the CometBFT client to this; tests fake it. */
export interface BlockSource {
  /** Height of the last committed block. Rejects when the node cannot answer. */
  latestHeight(): Promise<number>;
  /** Upper-case hex sha256 of each tx in the block, in block order. Rejects for a height not yet committed. */
  txHashesAt(height: number): Promise<readonly string[]>;
  /** The result of tx number `index` in the block (block_results; needs discard_abci_responses = false). */
  txResultAt(height: number, index: number): Promise<{
    code: number;
    codespace: string;
    log: string;
    events: DeliverTxResponse["events"];
    gasWanted: bigint;
    gasUsed: bigint;
  }>;
}

export type ScanRequest = {
  /** Upper-case hex sha256 of the signed tx bytes, computed before broadcast. */
  readonly hash: string;
  /** Latest height when the tx was signed; the tx can only be in a later block. */
  readonly sentAtHeight: number;
  /** The timeout height signed into the tx. */
  readonly timeoutHeight: number;
};

/**
 * Resolves with the block's result when the tx is found with code 0. Throws OcpTxError "failed",
 * "expired" or "unknown", and nothing else. A height counts as scanned only once its block was read,
 * so "expired" is a fact: every height in (sentAtHeight, timeoutHeight] was read and none holds the tx.
 */
export async function confirmByBlockScan(
  source: BlockSource,
  req: ScanRequest,
  clock: Clock = realClock,
  deadline = clock.now() + CONFIRM_LIMITS.maxWaitMs,
): Promise<DeliverTxResponse> {
  let next = req.sentAtHeight + 1;
  let latest = req.sentAtHeight;
  let lastError = "";
  while (clock.now() < deadline) {
    try {
      latest = await answerBy(source.latestHeight(), deadline, clock);
      for (; next <= Math.min(latest, req.timeoutHeight); next++) {
        const index = (await answerBy(source.txHashesAt(next), deadline, clock)).indexOf(req.hash);
        if (index < 0) continue;
        const r = await answerBy(source.txResultAt(next, index), deadline, clock);
        if (r.code !== 0) {
          throw new OcpTxError({ kind: "failed", hash: req.hash, height: next, code: r.code, codespace: r.codespace, log: r.log });
        }
        return {
          height: next,
          txIndex: index,
          code: 0,
          transactionHash: req.hash,
          events: r.events,
          rawLog: r.log,
          msgResponses: [],
          gasWanted: r.gasWanted,
          gasUsed: r.gasUsed,
        };
      }
      if (next > req.timeoutHeight) {
        throw new OcpTxError({ kind: "expired", hash: req.hash, timeoutHeight: req.timeoutHeight });
      }
      lastError = "";
    } catch (err) {
      if (err instanceof OcpTxError) throw err;
      lastError = err instanceof Error ? err.message : String(err);
    }
    await clock.sleep(Math.min(CONFIRM_LIMITS.pollMs, Math.max(0, deadline - clock.now())));
  }
  throw new OcpTxError({
    kind: "unknown",
    hash: req.hash,
    sentAtHeight: req.sentAtHeight,
    timeoutHeight: req.timeoutHeight,
    why: lastError || `the chain reached height ${latest}, below the timeout height`,
  });
}

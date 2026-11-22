// STAND-IN. The typed transaction failure belongs to cosmos/confirm.ts, which the confirmation
// change adds. This file holds only its public half, so that code written against it compiles and
// runs before that change is merged. When confirm.ts exists: delete this file and export
// TxFailure, OcpTxError and txFailureOf from confirm.js in cosmos/index.ts.

/** Why a transaction helper did not resolve. Exactly one of these, or the helper resolved. */
export type TxFailure =
  /** Refused before the mempool, by simulate or CheckTx. No effect. The sequence did not move. */
  | { readonly kind: "rejected"; readonly log: string }
  /** In a block with a non-zero code. No effect except the sequence. */
  | { readonly kind: "failed"; readonly hash: string; readonly height: number; readonly code: number; readonly codespace: string; readonly log: string }
  /** The chain is past timeoutHeight and no block up to it holds the transaction. It can never land. */
  | { readonly kind: "expired"; readonly hash: string; readonly timeoutHeight: number }
  /** "I do not know whether it landed." It is in a block in (sentAtHeight, timeoutHeight] or it is dead. */
  | { readonly kind: "unknown"; readonly hash: string; readonly sentAtHeight: number; readonly timeoutHeight: number; readonly why: string }
  /** Not a transaction outcome at all: a read or transport error from another call. */
  | { readonly kind: "not-a-tx"; readonly error: unknown };

export class OcpTxError extends Error {
  readonly failure: Exclude<TxFailure, { kind: "not-a-tx" }>;
  constructor(failure: Exclude<TxFailure, { kind: "not-a-tx" }>) {
    super(messageFor(failure));
    this.name = "OcpTxError";
    this.failure = failure;
  }
}

function messageFor(failure: Exclude<TxFailure, { kind: "not-a-tx" }>): string {
  switch (failure.kind) {
    case "rejected":
      return failure.log;
    case "failed":
      return `tx failed: code=${failure.code} log=${failure.log}`;
    case "expired":
      return `tx ${failure.hash} expired: not in any block through height ${failure.timeoutHeight}`;
    case "unknown":
      return `tx ${failure.hash} unknown: ${failure.why} (sent at height ${failure.sentAtHeight}, dead after ${failure.timeoutHeight})`;
  }
}

/** Total. An OcpTxError gives its failure. Anything else gives { kind: "not-a-tx" }. */
export function txFailureOf(err: unknown): TxFailure {
  return err instanceof OcpTxError ? err.failure : { kind: "not-a-tx", error: err };
}

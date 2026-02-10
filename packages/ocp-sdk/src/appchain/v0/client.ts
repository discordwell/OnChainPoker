import { JsonRpcTransport } from "../transports/jsonrpc.js";

import { base64ToBytes, bytesToBase64, bytesToUtf8, utf8ToBytes } from "./encoding.js";
import type {
  AbciEvent,
  AbciEventAttribute,
  AbciQueryResult,
  AccountView,
  AuthRegisterAccountTx,
  BankMintTx,
  BankSendTx,
  BroadcastTxCommitResult,
  DealerBeginEpochTx,
  DealerDKGCommitTx,
  DealerDKGComplaintInvalidTx,
  DealerDKGComplaintMissingTx,
  DealerDKGShareRevealTx,
  DealerDKGTimeoutTx,
  DealerFinalizeDeckTx,
  DealerFinalizeEpochTx,
  DealerFinalizeRevealTx,
  DealerInitHandTx,
  DealerSubmitEncShareTx,
  DealerSubmitPubShareTx,
  DealerSubmitShuffleTx,
  DealerTimeoutTx,
  PokerActTx,
  PokerLeaveTx,
  PokerTickTx,
  PokerCreateTableTx,
  PokerSitTx,
  PokerStartHandTx,
  StakingBondTx,
  StakingRegisterValidatorTx,
  StakingUnbondTx,
  StakingUnjailTx,
  TableView,
  TxEnvelope,
  WsSubscriptionMsg
} from "./types.js";

export class OcpV0Client {
  readonly rpcUrl: string;
  readonly wsUrl: string;
  readonly rpc: JsonRpcTransport;

  private txNonce = 0;

  constructor(args: { rpcUrl: string; wsUrl?: string; headers?: Record<string, string> }) {
    this.rpcUrl = args.rpcUrl;
    this.wsUrl = args.wsUrl ?? toWebSocketUrl(args.rpcUrl);
    this.rpc = new JsonRpcTransport({ url: this.rpcUrl, headers: args.headers });
  }

  // --- Low-level CometBFT RPC ---

  cometRpc<T>(method: string, params?: unknown): Promise<T> {
    return this.rpc.request<T>(method, params);
  }

  async broadcastTxCommit(txBytes: Uint8Array): Promise<BroadcastTxCommitResult> {
    const tx = bytesToBase64(txBytes);
    const result = await this.cometRpc<BroadcastTxCommitResult>("broadcast_tx_commit", { tx });

    const deliver = result.tx_result ?? result.deliver_tx;
    if (deliver && Number(deliver.code) !== 0) {
      throw new Error(`tx failed: code=${deliver.code} log=${deliver.log ?? ""}`);
    }

    return result;
  }

  async abciQueryJson<T>(path: string): Promise<T | null> {
    const result = await this.cometRpc<AbciQueryResult>("abci_query", { path });
    const valueB64 = result.response?.value ?? "";
    if (!valueB64) return null;
    const bytes = base64ToBytes(valueB64);
    return JSON.parse(bytesToUtf8(bytes)) as T;
  }

  // --- OCP v0 queries ---

  getAccount(addr: string): Promise<AccountView | null> {
    return this.abciQueryJson<AccountView>(`/account/${addr}`);
  }

  getTables(): Promise<number[] | null> {
    return this.abciQueryJson<number[]>("/tables");
  }

  getTable(tableId: number): Promise<TableView | null> {
    return this.abciQueryJson<TableView>(`/table/${tableId}`);
  }

  // --- OCP v0 tx helpers ---

  /**
   * v0 account key registration for tx authentication.
   *
   * Note: the chain verifies this tx is signed by `value.account` using `value.pubKey`;
   * callers should broadcast a signed envelope via `broadcastTxEnvelope()`.
   */
  authRegisterAccount(value: AuthRegisterAccountTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "auth/register_account", value });
  }

  bankMint(value: BankMintTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "bank/mint", value });
  }

  bankSend(value: BankSendTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "bank/send", value });
  }

  pokerCreateTable(value: PokerCreateTableTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "poker/create_table", value });
  }

  pokerSit(value: PokerSitTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "poker/sit", value });
  }

  pokerStartHand(value: PokerStartHandTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "poker/start_hand", value });
  }

  pokerAct(value: PokerActTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "poker/act", value });
  }

  pokerTick(value: PokerTickTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "poker/tick", value });
  }

  pokerLeave(value: PokerLeaveTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "poker/leave", value });
  }

  stakingRegisterValidator(value: StakingRegisterValidatorTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "staking/register_validator", value });
  }

  stakingBond(value: StakingBondTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "staking/bond", value });
  }

  stakingUnbond(value: StakingUnbondTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "staking/unbond", value });
  }

  stakingUnjail(value: StakingUnjailTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "staking/unjail", value });
  }

  dealerBeginEpoch(value: DealerBeginEpochTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "dealer/begin_epoch", value });
  }

  dealerDkgCommit(value: DealerDKGCommitTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "dealer/dkg_commit", value });
  }

  dealerDkgComplaintMissing(value: DealerDKGComplaintMissingTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "dealer/dkg_complaint_missing", value });
  }

  dealerDkgComplaintInvalid(value: DealerDKGComplaintInvalidTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "dealer/dkg_complaint_invalid", value });
  }

  dealerDkgShareReveal(value: DealerDKGShareRevealTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "dealer/dkg_share_reveal", value });
  }

  dealerFinalizeEpoch(value: DealerFinalizeEpochTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "dealer/finalize_epoch", value });
  }

  dealerDkgTimeout(value: DealerDKGTimeoutTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "dealer/dkg_timeout", value });
  }

  dealerInitHand(value: DealerInitHandTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "dealer/init_hand", value });
  }

  dealerSubmitShuffle(value: DealerSubmitShuffleTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "dealer/submit_shuffle", value });
  }

  dealerFinalizeDeck(value: DealerFinalizeDeckTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "dealer/finalize_deck", value });
  }

  dealerSubmitPubShare(value: DealerSubmitPubShareTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "dealer/submit_pub_share", value });
  }

  dealerSubmitEncShare(value: DealerSubmitEncShareTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "dealer/submit_enc_share", value });
  }

  dealerFinalizeReveal(value: DealerFinalizeRevealTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "dealer/finalize_reveal", value });
  }

  dealerTimeout(value: DealerTimeoutTx): Promise<BroadcastTxCommitResult> {
    return this.broadcastTxEnvelope({ type: "dealer/timeout", value });
  }

  async broadcastTxEnvelope(env: TxEnvelope): Promise<BroadcastTxCommitResult> {
    // v0 localnet: optional tx auth. CometBFT rejects identical tx bytes via its tx cache,
    // so we always include a nonce to keep bytes unique.
    const hasAuth = env.signer != null || env.sig != null;
    const nonce = env.nonce ?? `${Date.now()}-${++this.txNonce}`;
    if (hasAuth && !env.nonce) {
      throw new Error("signed tx requires env.nonce (nonce is part of the signature)");
    }
    const withNonce = { ...env, nonce };
    const txBytes = utf8ToBytes(JSON.stringify(withNonce));
    return this.broadcastTxCommit(txBytes);
  }

  // --- Event parsing helpers ---

  static findEvent(events: AbciEvent[] | undefined, typ: string): AbciEvent | undefined {
    return (events ?? []).find((e) => e.type === typ);
  }

  static attrValue(attrs: AbciEventAttribute[] | undefined, key: string): string | undefined {
    return (attrs ?? []).find((a) => a.key === key)?.value;
  }

  // --- WS subscription (optional) ---

  async *subscribeTxResults(args: { query?: string; signal?: AbortSignal } = {}): AsyncGenerator<{ events: AbciEvent[]; tx?: Uint8Array }, void, void> {
    const query = args.query ?? "tm.event='Tx'";
    const ws = new WebSocket(this.wsUrl);

    const queue: WsSubscriptionMsg[] = [];
    let notify: (() => void) | null = null;
    const wake = () => {
      notify?.();
      notify = null;
    };

    const onMessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data));
        queue.push(msg);
        wake();
      } catch {
        // ignore
      }
    };

    const onError = () => wake();
    const onClose = () => wake();

    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);

    try {
      await onceOpen(ws, args.signal);
      const subId = 1;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: subId, method: "subscribe", params: { query } }));

      // Await subscribe response (or error) before yielding.
      for (;;) {
        const msg = await shift(queue, () => new Promise((r) => (notify = r)), args.signal);
        if (!msg) return;
        if (msg.id === subId) {
          if (msg.error) throw new Error(`subscribe error: ${JSON.stringify(msg.error)}`);
          break;
        }
      }

      for (;;) {
        const msg = await shift(queue, () => new Promise((r) => (notify = r)), args.signal);
        if (!msg) return;

        const txResult = extractTxResult(msg);
        if (!txResult) continue;

        const events: AbciEvent[] = txResult.result?.events ?? txResult.events ?? [];
        const txB64: string | undefined = txResult.tx;
        const tx = txB64 ? base64ToBytes(txB64) : undefined;

        yield { events, tx };
      }
    } finally {
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }
}

function toWebSocketUrl(rpcUrl: string): string {
  const u = new URL(rpcUrl);
  const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
  u.protocol = wsProto;
  u.pathname = u.pathname.replace(/\/+$/, "") + "/websocket";
  return u.toString();
}

async function onceOpen(ws: WebSocket, signal?: AbortSignal): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));

    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("websocket error"));
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("aborted"));
    };
    const cleanup = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };

    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function shift<T>(queue: T[], wait: () => Promise<void>, signal?: AbortSignal): Promise<T | undefined> {
  for (;;) {
    if (queue.length > 0) return queue.shift();
    if (signal?.aborted) return undefined;
    await wait();
  }
}

function extractTxResult(msg: WsSubscriptionMsg): any | null {
  // Tendermint/CometBFT has had a few websocket shapes over time. Try to be liberal.
  //
  // Common shape:
  // - msg.result.data.value.TxResult
  // or:
  // - msg.result.data.value (is TxResult)
  // or:
  // - msg.params.result.data.value.TxResult
  const root = msg.result ?? msg.params?.result ?? null;
  if (!root) return null;

  const data = root.data ?? root;
  const value = data.value ?? data;

  if (value && typeof value === "object" && "TxResult" in value) return (value as any).TxResult;
  if (value && typeof value === "object" && ("result" in value || "events" in value)) return value;

  return null;
}

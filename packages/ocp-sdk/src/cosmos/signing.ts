import { sha256 } from "@cosmjs/crypto";
import { fromBase64, toHex } from "@cosmjs/encoding";
import type { EncodeObject, OfflineSigner, Registry } from "@cosmjs/proto-signing";
import { decodeTxRaw, DirectSecp256k1HdWallet, DirectSecp256k1Wallet } from "@cosmjs/proto-signing";
import type { DeliverTxResponse, SigningStargateClientOptions, StdFee } from "@cosmjs/stargate";
import { calculateFee, fromTendermintEvent, GasPrice, SigningStargateClient } from "@cosmjs/stargate";
import { connectComet, type CometClient } from "@cosmjs/tendermint-rpc";
import { TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx.js";

import { answerBy, type BlockSource, CONFIRM_LIMITS, confirmByBlockScan, OcpTxError, realClock } from "./confirm.js";
import { nodeReadsOver, type NodeReads } from "./nodeReads.js";

export type SendOptions = {
  /** Replaces the client's multiplier for this transaction: the gas limit is that many times what the simulation used. */
  gasMultiplier?: number;
  /**
   * The gas limit, and no simulation. For a transaction that is only valid after another one of this
   * signer's that is not in a block yet: the node simulates at its last block and would refuse it.
   */
  gasLimit?: number;
};

/** A transaction the node took into its mempool, and the block it lands in. */
export type Broadcast = {
  readonly hash: string;
  /** Resolves only for code 0 in a block; rejects with OcpTxError "failed" | "expired" | "unknown". Never unhandled. */
  readonly landed: Promise<DeliverTxResponse>;
};

export type OcpCosmosSigningClient = {
  address: string;
  client: SigningStargateClient;

  /**
   * Simulates (unless opts.gasLimit), signs with a timeout height and this signer's next sequence,
   * and broadcasts. Resolves once the node took the tx. Throws OcpTxError "rejected" when it did not,
   * and passes other errors from before the broadcast through unchanged.
   * Calls are broadcast in the order they are made, each with the sequence after the last one the
   * node took, so several can be in the mempool at once and land in one block in that order.
   */
  broadcastAuto: (msgs: readonly EncodeObject[], memo?: string, opts?: SendOptions) => Promise<Broadcast>;

  /**
   * broadcastAuto, then reads blocks until one holds the tx. Resolves only for a tx in a block with
   * code 0, with that block's result. Throws OcpTxError "rejected" | "failed" | "expired" | "unknown"
   * (see txFailureOf). Holds the caller at most CONFIRM_LIMITS.maxWaitMs from the broadcast.
   */
  signAndBroadcastAuto: (msgs: readonly EncodeObject[], memo?: string, opts?: SendOptions) => Promise<DeliverTxResponse>;

  /**
   * The messages of the transactions in this node's mempool (unconfirmed_txs), decoded: what the
   * next block will likely hold. For work that can start before that block; never a confirmation.
   * A message of a type the registry does not know is left out.
   */
  pendingMessages: () => Promise<readonly EncodeObject[]>;
} & NodeReads;

export async function walletFromMnemonic(args: { mnemonic: string; prefix: string }): Promise<DirectSecp256k1HdWallet> {
  return DirectSecp256k1HdWallet.fromMnemonic(args.mnemonic, { prefix: args.prefix });
}

export async function walletGenerate(args: { prefix: string; mnemonicLength?: 12 | 15 | 18 | 21 | 24 }): Promise<DirectSecp256k1HdWallet> {
  return DirectSecp256k1HdWallet.generate(args.mnemonicLength ?? 24, { prefix: args.prefix });
}

export async function walletFromPrivKey(args: { privateKeyHex: string; prefix: string }): Promise<DirectSecp256k1Wallet> {
  const clean = (args.privateKeyHex ?? "").trim();
  const normalized = clean.startsWith("0x") ? clean.slice(2) : clean;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("walletFromPrivKey: private key must be 32-byte hex");
  }
  return DirectSecp256k1Wallet.fromKey(new Uint8Array(Buffer.from(normalized, "hex")), args.prefix);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** cosmjs throws a node's JSON-RPC error as its JSON text. This is the node's own sentence, or null. */
function nodeSaid(err: unknown): string | null {
  try {
    const e = JSON.parse(errorText(err));
    return typeof e?.code === "number" ? String(e.data || e.message) : null;
  } catch {
    return null;
  }
}

function isSocketError(err: unknown): boolean {
  const msg = errorText(err).toLowerCase();
  return msg.includes("socket hang up") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("epipe") ||
    msg.includes("connection closed") ||
    msg.includes("fetch failed");
}

/** A keep-alive socket the node closed while we were idle fails the first request; one more try gets a new one. */
async function onceMoreOnSocketError<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!isSocketError(err)) throw err;
    return call();
  }
}

const txHashOf = (tx: Uint8Array) => toHex(sha256(tx)).toUpperCase();

type BlockResults = Awaited<ReturnType<CometClient["blockResults"]>>;

function blockSource(comet: CometClient): BlockSource {
  const read = <T>(p: Promise<T>) => p.catch((err): never => { throw new Error(nodeSaid(err) ?? errorText(err)); });
  return {
    latestHeight: async () => (await read(comet.status())).syncInfo.latestBlockHeight,
    txHashesAt: async (height) => (await read(comet.block(height))).block.txs.map(txHashOf),
    txResultAt: async (height, index) => {
      const r = (await read<BlockResults>(comet.blockResults(height))).results[index];
      if (!r) throw new Error(`block results at height ${height} have no result for tx ${index}`);
      return {
        code: r.code,
        codespace: r.codespace ?? "",
        log: r.log ?? "",
        events: r.events.map(fromTendermintEvent),
        gasWanted: r.gasWanted,
        gasUsed: r.gasUsed,
      };
    },
  };
}

export async function connectOcpCosmosSigningClient(args: {
  rpcUrl: string;
  signer: OfflineSigner;
  signerAddress?: string;
  gasPrice: string;
  /** A person approves each signature (a browser wallet): a tx gets 60 blocks to land instead of 6. */
  interactive?: boolean;
  registry?: Registry;
  stargate?: Omit<SigningStargateClientOptions, "registry">;
  gasMultiplier?: number;
}): Promise<OcpCosmosSigningClient> {
  const accounts = await args.signer.getAccounts();
  if (accounts.length === 0) throw new Error("cosmos signer has no accounts");

  const address = (args.signerAddress ?? accounts[0]!.address).trim();
  if (!address) throw new Error("empty signer address");

  const gasPrice = GasPrice.fromString(args.gasPrice);
  const gasMultiplier = args.gasMultiplier ?? 1.3;
  const ttlBlocks = args.interactive ? CONFIRM_LIMITS.ttlBlocks.interactive : CONFIRM_LIMITS.ttlBlocks.service;

  const comet = await connectComet(args.rpcUrl);
  const client = await SigningStargateClient.createWithSigner(comet, args.signer, {
    gasPrice,
    registry: args.registry,
    ...(args.stargate ?? {}),
  });
  const source = blockSource(comet);

  // Confirmation reads each tx's result from block_results. The latest block may still be executing, so ask for the one before it.
  const latest = await source.latestHeight();
  await comet.blockResults(Math.max(1, latest - 1)).catch((err) => {
    throw new Error(
      `${args.rpcUrl} does not serve block results, so no transaction it takes can be confirmed ` +
      `(its config.toml must keep discard_abci_responses = false under [storage]): ${nodeSaid(err) ?? errorText(err)}`,
    );
  });

  async function simulate(msgs: readonly EncodeObject[], memo: string): Promise<number> {
    try {
      // cosmjs reads the account's sequence, then simulates: a block between the two makes them disagree.
      return await onceMoreOnSocketError(() => client.simulate(address, msgs, memo)).catch((err) => {
        if (!errorText(err).includes("account sequence mismatch")) throw err;
        return client.simulate(address, msgs, memo);
      });
    } catch (err) {
      const text = errorText(err);
      // cosmjs's wording for "the chain answered no": a failed query, or no account to sign for.
      if (/^Query failed with \(\d+\)/.test(text) || text.includes("does not exist on chain")) {
        throw new OcpTxError({ kind: "rejected", log: text });
      }
      throw err;
    }
  }

  // Throws "rejected" only when the node's first answer says it did not take the tx. When the first
  // attempt fails on the wire the tx may be in a mempool, so the same bytes go once more and the block scan decides.
  async function broadcast(tx: Uint8Array, deadline: number): Promise<void> {
    try {
      const res = await answerBy(comet.broadcastTxSync({ tx }), deadline, realClock);
      if (res.code !== 0) throw new OcpTxError({ kind: "rejected", log: res.log ?? "" });
      return;
    } catch (err) {
      if (err instanceof OcpTxError) throw err;
      const said = nodeSaid(err);
      if (said?.includes("tx already exists in cache")) return;
      if (said !== null) throw new OcpTxError({ kind: "rejected", log: said });
    }
    await answerBy(comet.broadcastTxSync({ tx }), deadline, realClock).catch(() => undefined);
  }

  // The sequence of the next tx, counted here from the ones the node took: the node's query state
  // can be a block behind its last block, and a tx still in the mempool is not in it at all.
  // null: ask the chain. A refusal that names the expected sequence corrects it.
  let nextSequence: number | null = null;
  let signer: { accountNumber: number; chainId: string } | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(step: () => Promise<T>): Promise<T> => {
    const run = queue.then(step, step);
    queue = run.catch(() => undefined);
    return run;
  };

  async function signAt(msgs: readonly EncodeObject[], fee: StdFee, memo: string, sequence: number, timeoutHeight: number): Promise<Uint8Array> {
    signer ??= { accountNumber: (await client.getSequence(address)).accountNumber, chainId: await client.getChainId() };
    return TxRaw.encode(await client.sign(address, msgs, fee, memo, { ...signer, sequence }, BigInt(timeoutHeight))).finish();
  }

  // One signature per sequence the node took. A tx signed again is one the node refused at CheckTx,
  // so it is in no mempool: only then is the same body signed at the sequence the node asked for.
  async function broadcastAuto(msgs: readonly EncodeObject[], memo = "", opts: SendOptions = {}): Promise<Broadcast> {
    // The simulation runs beside the sends ahead of this one; the place in line is taken now.
    const gas =
      opts.gasLimit !== undefined
        ? Promise.resolve(opts.gasLimit)
        : simulate(msgs, memo).then((used) => Math.max(200_000, Math.ceil(used * (opts.gasMultiplier ?? gasMultiplier))));
    gas.catch(() => undefined);
    const sent = await inOrder(async () => {
      const fee = calculateFee(await gas, gasPrice);
      const sentAtHeight = await onceMoreOnSocketError(() => source.latestHeight());
      const timeoutHeight = sentAtHeight + ttlBlocks;
      let sequence = nextSequence ?? (await onceMoreOnSocketError(() => client.getSequence(address))).sequence;
      for (let tries = 0; ; tries++) {
        const tx = await signAt(msgs, fee, memo, sequence, timeoutHeight);
        // From the signature on: a person may take minutes to approve it in a wallet.
        const deadline = realClock.now() + CONFIRM_LIMITS.maxWaitMs;
        try {
          await broadcast(tx, deadline);
        } catch (err) {
          const expected = tries === 0 ? expectedSequence(err) : null;
          if (expected === null || expected === sequence) throw err;
          sequence = expected;
          continue;
        }
        nextSequence = sequence + 1;
        return { hash: txHashOf(tx), sentAtHeight, timeoutHeight, deadline };
      }
    });
    const landed = confirmByBlockScan(source, sent, realClock, sent.deadline).catch((err): never => {
      // A tx that never landed did not use its sequence, and the ones sent after it cannot land either.
      if (err instanceof OcpTxError && (err.failure.kind === "expired" || err.failure.kind === "unknown")) nextSequence = null;
      throw err;
    });
    landed.catch(() => undefined);
    return { hash: sent.hash, landed };
  }

  async function signAndBroadcastAuto(msgs: readonly EncodeObject[], memo = "", opts: SendOptions = {}): Promise<DeliverTxResponse> {
    return (await broadcastAuto(msgs, memo, opts)).landed;
  }

  async function pendingMessages(): Promise<readonly EncodeObject[]> {
    const res = await fetch(`${args.rpcUrl.replace(/\/+$/, "")}/unconfirmed_txs?limit=100`);
    const body = (await res.json()) as { result?: { txs?: string[] | null } };
    const out: EncodeObject[] = [];
    for (const tx of body.result?.txs ?? []) {
      for (const any of decodeTxRaw(fromBase64(tx)).body.messages) {
        try {
          out.push({ typeUrl: any.typeUrl, value: client.registry.decode(any) });
        } catch {
          // Not a type this client registers.
        }
      }
    }
    return out;
  }

  return { address, client, broadcastAuto, signAndBroadcastAuto, pendingMessages, ...nodeReadsOver(() => comet) };
}

/** The sequence a CheckTx refusal says the account is at: "account sequence mismatch, expected 61, got 60". */
function expectedSequence(err: unknown): number | null {
  if (!(err instanceof OcpTxError) || err.failure.kind !== "rejected") return null;
  const m = /account sequence mismatch, expected (\d+)/.exec(err.failure.log);
  return m ? Number(m[1]) : null;
}

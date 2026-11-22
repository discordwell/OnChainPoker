import { sha256 } from "@cosmjs/crypto";
import { toHex } from "@cosmjs/encoding";
import type { EncodeObject, OfflineSigner, Registry } from "@cosmjs/proto-signing";
import { DirectSecp256k1HdWallet, DirectSecp256k1Wallet } from "@cosmjs/proto-signing";
import type { DeliverTxResponse, SigningStargateClientOptions } from "@cosmjs/stargate";
import { calculateFee, fromTendermintEvent, GasPrice, SigningStargateClient } from "@cosmjs/stargate";
import { connectComet, type CometClient } from "@cosmjs/tendermint-rpc";
import { TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx.js";

import { answerBy, type BlockSource, CONFIRM_LIMITS, confirmByBlockScan, OcpTxError, realClock } from "./confirm.js";
import { nodeReadsOver, type NodeReads } from "./nodeReads.js";

export type OcpCosmosSigningClient = {
  address: string;
  client: SigningStargateClient;

  /**
   * Simulates, signs with a timeout height, broadcasts, and reads blocks until one holds the tx.
   * Resolves only for a tx in a block with code 0, with that block's result.
   * Throws OcpTxError "rejected" | "failed" | "expired" | "unknown" (see txFailureOf), and passes other
   * errors from before the broadcast through unchanged. Holds the caller at most
   * CONFIRM_LIMITS.maxWaitMs from the broadcast.
   */
  signAndBroadcastAuto: (msgs: readonly EncodeObject[], memo?: string) => Promise<DeliverTxResponse>;
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
      return await onceMoreOnSocketError(() => client.simulate(address, msgs, memo));
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

  // Signs once. A second signature would be a second tx with the same sequence, and the caller would hear of one.
  async function signAndBroadcastAuto(msgs: readonly EncodeObject[], memo = ""): Promise<DeliverTxResponse> {
    const sentAtHeight = await onceMoreOnSocketError(() => source.latestHeight());
    const gasUsed = await simulate(msgs, memo);
    const fee = calculateFee(Math.max(200_000, Math.ceil(gasUsed * gasMultiplier)), gasPrice);
    const timeoutHeight = sentAtHeight + ttlBlocks;
    const tx = TxRaw.encode(await client.sign(address, msgs, fee, memo, undefined, BigInt(timeoutHeight))).finish();
    const hash = txHashOf(tx);

    const deadline = realClock.now() + CONFIRM_LIMITS.maxWaitMs;
    await broadcast(tx, deadline);
    return confirmByBlockScan(source, { hash, sentAtHeight, timeoutHeight }, realClock, deadline);
  }

  return { address, client, signAndBroadcastAuto, ...nodeReadsOver(() => comet) };
}

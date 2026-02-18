import type { EncodeObject, OfflineSigner, Registry } from "@cosmjs/proto-signing";
import { DirectSecp256k1HdWallet, DirectSecp256k1Wallet } from "@cosmjs/proto-signing";
import type { DeliverTxResponse, Event, SigningStargateClientOptions } from "@cosmjs/stargate";
import { calculateFee, GasPrice, SigningStargateClient } from "@cosmjs/stargate";

export type OcpCosmosSigningClient = {
  address: string;
  client: SigningStargateClient;
  signAndBroadcastAuto: (msgs: readonly EncodeObject[], memo?: string) => Promise<DeliverTxResponse>;
};

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

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(x: unknown, fallback = 0): number {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "") {
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
  }
  if (typeof x === "bigint") return Number(x);
  return fallback;
}

function toBigInt(x: unknown): bigint {
  if (typeof x === "bigint") return x;
  if (typeof x === "number" && Number.isFinite(x)) return BigInt(Math.trunc(x));
  if (typeof x === "string" && x.trim() !== "") {
    try {
      return BigInt(x);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function normalizeEvents(eventsRaw: unknown): readonly Event[] {
  if (!Array.isArray(eventsRaw)) return [];
  const events: Event[] = [];
  for (const ev of eventsRaw) {
    if (!ev || typeof ev !== "object") continue;
    const type = String((ev as Record<string, unknown>).type ?? "");
    if (!type) continue;
    const attrsRaw = (ev as Record<string, unknown>).attributes;
    const attrs = Array.isArray(attrsRaw)
      ? attrsRaw
        .filter((a) => a && typeof a === "object")
        .map((a) => ({
          key: String((a as Record<string, unknown>).key ?? ""),
          value: String((a as Record<string, unknown>).value ?? ""),
        }))
      : [];
    events.push({ type, attributes: attrs });
  }
  return events;
}

async function waitForDeliverTxViaLcd(lcdUrl: string, txHash: string): Promise<DeliverTxResponse> {
  const fetchFn: ((input: string) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>) | undefined =
    (globalThis as { fetch?: any }).fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("global fetch is required to poll tx results via LCD");
  }

  const base = lcdUrl.replace(/\/+$/, "");
  const hash = txHash.trim().toUpperCase();
  const deadline = Date.now() + 120_000;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const res = await fetchFn(`${base}/cosmos/tx/v1beta1/txs/${hash}`);
      if (res.ok) {
        const json = await res.json();
        const txRes = json?.tx_response ?? json?.txResponse;
        if (txRes && typeof txRes === "object") {
          return {
            height: toNumber(txRes.height),
            txIndex: toNumber(txRes.tx_index ?? txRes.txIndex, 0),
            code: toNumber(txRes.code),
            transactionHash: String(txRes.txhash ?? txRes.txHash ?? hash).toUpperCase(),
            events: normalizeEvents(txRes.events),
            rawLog: typeof txRes.raw_log === "string" ? txRes.raw_log : typeof txRes.rawLog === "string" ? txRes.rawLog : "",
            msgResponses: [],
            gasWanted: toBigInt(txRes.gas_wanted ?? txRes.gasWanted),
            gasUsed: toBigInt(txRes.gas_used ?? txRes.gasUsed),
          };
        }
      } else if (res.status !== 404 && res.status !== 400) {
        lastError = `unexpected HTTP ${res.status} from LCD tx query`;
      }
    } catch (err) {
      lastError = String((err as Error)?.message ?? err);
    }
    await sleepMs(500);
  }

  throw new Error(`timed out waiting for tx ${hash} via LCD${lastError ? ` (${lastError})` : ""}`);
}

export async function connectOcpCosmosSigningClient(args: {
  rpcUrl: string;
  signer: OfflineSigner;
  signerAddress?: string;
  gasPrice: string;
  lcdUrl?: string;
  registry?: Registry;
  stargate?: Omit<SigningStargateClientOptions, "registry">;
  gasMultiplier?: number;
}): Promise<OcpCosmosSigningClient> {
  const accounts = await args.signer.getAccounts();
  if (accounts.length === 0) throw new Error("cosmos signer has no accounts");

  const address = (args.signerAddress ?? accounts[0]!.address).trim();
  if (!address) throw new Error("empty signer address");

  const gasPrice = GasPrice.fromString(args.gasPrice);
  const client = await SigningStargateClient.connectWithSigner(args.rpcUrl, args.signer, {
    gasPrice,
    registry: args.registry,
    ...(args.stargate ?? {})
  });

  const gasMultiplier = args.gasMultiplier ?? 1.3;

  async function signAndBroadcastAuto(msgs: readonly EncodeObject[], memo = ""): Promise<DeliverTxResponse> {
    const gasUsed = await client.simulate(address, msgs, memo);
    const gasLimit = Math.max(200_000, Math.ceil(gasUsed * gasMultiplier));
    const fee = calculateFee(gasLimit, gasPrice);

    if (args.lcdUrl) {
      const txHash = await client.signAndBroadcastSync(address, msgs, fee, memo);
      return waitForDeliverTxViaLcd(args.lcdUrl, txHash);
    }

    return client.signAndBroadcast(address, msgs, fee, memo);
  }

  return { address, client, signAndBroadcastAuto };
}

import "dotenv/config";
import { createHash } from "node:crypto";
import {
  CosmosLcdClient,
  connectOcpCosmosSigningClient,
  createOcpCosmosClient,
  createOcpRegistry,
  walletFromMnemonic,
  walletFromPrivKey,
} from "@onchainpoker/ocp-sdk/cosmos";
import {
  scalarFromBytesModOrder,
  mulBase,
  groupElementToBytes,
} from "@onchainpoker/ocp-crypto";
import { loadConfig } from "./config.js";
import { PokerBot } from "./bot.js";
import { CallingStation } from "./strategies/callingStation.js";
import { TagStrategy } from "./strategies/tag.js";
import { LagStrategy } from "./strategies/lag.js";
import { log, logError } from "./log.js";
import type { Strategy } from "./strategy.js";

function deriveRistrettoKey(seed: string): { sk: bigint; pkBytes: Uint8Array } {
  const hash = createHash("sha256")
    .update("ocp-bot-ristretto:" + seed)
    .digest();
  const sk = scalarFromBytesModOrder(new Uint8Array(hash));
  const pk = mulBase(sk);
  const pkBytes = groupElementToBytes(pk);
  return { sk, pkBytes };
}

function createStrategy(name: string): Strategy {
  switch (name) {
    case "tag":
      return new TagStrategy();
    case "lag":
      return new LagStrategy();
    case "calling-station":
    default:
      return new CallingStation();
  }
}

async function main() {
  const config = loadConfig();
  log(`Config: strategy=${config.strategy} table=${config.tableId} name=${config.name}`);

  // Create wallet
  const wallet = config.mnemonic
    ? await walletFromMnemonic({ mnemonic: config.mnemonic, prefix: config.bech32Prefix })
    : await walletFromPrivKey({ privateKeyHex: config.privkeyHex!, prefix: config.bech32Prefix });

  const [account] = await wallet.getAccounts();
  if (!account) throw new Error("wallet has no accounts");
  log(`Wallet: ${account.address}`);

  // Derive ristretto key deterministically from wallet credentials
  const keySeed = config.mnemonic ?? config.privkeyHex!;
  const { sk, pkBytes } = deriveRistrettoKey(keySeed);
  log(`Player PK: ${Buffer.from(pkBytes).toString("hex").slice(0, 16)}...`);

  // Connect to chain
  const registry = createOcpRegistry();
  const signing = await connectOcpCosmosSigningClient({
    rpcUrl: config.cosmosRpcUrl,
    lcdUrl: config.cosmosLcdUrl,
    signer: wallet,
    gasPrice: config.gasPrice,
    registry,
  });

  const lcd = new CosmosLcdClient({ baseUrl: config.cosmosLcdUrl });
  const client = createOcpCosmosClient({ signing, lcd });

  // Create and start bot
  const strategy = createStrategy(config.strategy);
  const bot = new PokerBot({
    client,
    config,
    strategy,
    sk,
    pkBytes,
    address: account.address,
  });

  await bot.start();

  // Graceful shutdown
  const shutdown = async () => {
    log("Shutting down...");
    await bot.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  logError("Fatal error", err);
  process.exit(1);
});

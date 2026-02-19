import "dotenv/config";
import {
  CosmosLcdClient,
  connectOcpCosmosSigningClient,
  createOcpCosmosClient,
  createOcpRegistry,
  walletFromMnemonic,
  walletFromPrivKey,
} from "@onchainpoker/ocp-sdk/cosmos";
import { loadConfig } from "./config.js";
import { EpochStateStore } from "./state.js";
import { DealerDaemon } from "./daemon.js";
import { log, logError } from "./log.js";

async function main() {
  const config = loadConfig();
  log(`Config loaded for validator ${config.validatorAddress}`);

  // Create wallet from mnemonic or private key
  const wallet = config.mnemonic
    ? await walletFromMnemonic({ mnemonic: config.mnemonic, prefix: config.bech32Prefix })
    : await walletFromPrivKey({ privateKeyHex: config.privkeyHex!, prefix: config.bech32Prefix });

  const [account] = await wallet.getAccounts();
  if (!account) throw new Error("wallet has no accounts");
  log(`Wallet address: ${account.address}`);

  // Connect signing client
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

  // Initialize state store
  const stateStore = new EpochStateStore(config.stateDir, config.statePassphrase);

  // Create and start daemon
  const daemon = new DealerDaemon({ client, config, stateStore });
  await daemon.start();

  // Graceful shutdown
  const shutdown = async () => {
    log("Shutting down...");
    await daemon.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  logError("Fatal error", err);
  process.exit(1);
});

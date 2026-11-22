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
import { retryUntilOk } from "./retry.js";

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

  // Initialize state store (a config error must exit before we wait for the chain)
  const stateStore = new EpochStateStore(config.stateDir, config.statePassphrase);

  // Connect signing client; an unreachable chain is waited for, not fatal
  const registry = createOcpRegistry();
  const signing = await retryUntilOk("connect to chain RPC", () =>
    connectOcpCosmosSigningClient({
      rpcUrl: config.cosmosRpcUrl,
      signer: wallet,
      gasPrice: config.gasPrice,
      registry,
    })
  );

  const lcd = new CosmosLcdClient({ baseUrl: config.cosmosLcdUrl });
  const client = createOcpCosmosClient({ signing, lcd });

  const daemon = new DealerDaemon({ client, config, stateStore });

  // --explain: print what the daemon sees and what it would send, send nothing, and exit.
  if (process.argv.includes("--explain")) {
    await daemon.explain();
    process.exit(0);
  }

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

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { CometChainAdapter } from "./chain/comet.js";
import { CosmosChainAdapter } from "./chain/cosmos.js";
import { MockChainAdapter } from "./chain/mock.js";
import type { ChainAdapter } from "./chain/adapter.js";
import { CoordinatorStore } from "./store.js";
import { createCoordinatorServer } from "./server.js";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(thisDir, "..", ".env") });

const config = loadConfig();
const chainKind = (process.env.COORDINATOR_CHAIN_ADAPTER ?? "mock").trim() || "mock";

let chain: ChainAdapter;
switch (chainKind) {
  case "mock":
    chain = new MockChainAdapter();
    break;
  case "comet": {
    const rpcUrl = (process.env.COORDINATOR_COMET_RPC_URL ?? "").trim() || "http://127.0.0.1:26657";
    const wsUrlRaw = (process.env.COORDINATOR_COMET_WS_URL ?? "").trim();
    chain = new CometChainAdapter({ rpcUrl, wsUrl: wsUrlRaw || undefined });
    break;
  }
  case "cosmos": {
    const rpcUrl = (process.env.COORDINATOR_COSMOS_RPC_URL ?? "").trim() || "http://127.0.0.1:26657";
    const lcdUrl = (process.env.COORDINATOR_COSMOS_LCD_URL ?? "").trim() || "http://127.0.0.1:1317";
    const wsUrlRaw = (process.env.COORDINATOR_COSMOS_WS_URL ?? "").trim();
    chain = new CosmosChainAdapter({ rpcUrl, lcdUrl, wsUrl: wsUrlRaw || undefined });
    break;
  }
  default:
    throw new Error(`Unsupported COORDINATOR_CHAIN_ADAPTER: ${chainKind}`);
}

const store = new CoordinatorStore({
  artifactMaxBytes: config.artifactMaxBytes,
  artifactCacheMaxBytes: config.artifactCacheMaxBytes
});

const server = createCoordinatorServer({ config, chain, store });
const { url } = await server.start();
console.log(`[coordinator] listening: ${url}`);

const shutdown = async () => {
  console.log("[coordinator] shutting down...");
  await server.stop();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

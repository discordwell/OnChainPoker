import hardhatEthersPlugin from "@nomicfoundation/hardhat-ethers";
import hardhatEthersChaiMatchersPlugin from "@nomicfoundation/hardhat-ethers-chai-matchers";
import hardhatMochaPlugin from "@nomicfoundation/hardhat-mocha";
import dotenv from "dotenv";
import { defineConfig } from "hardhat/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Prefer repo-root env files, but fall back to local package env.
dotenv.config({ path: resolve(__dirname, "../../.env") });
dotenv.config({ path: resolve(__dirname, "../../.env.local") });
dotenv.config();

function normalizePrivateKey(pk: string | undefined): string | undefined {
  if (pk == null) return undefined;
  const trimmed = pk.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return `0x${trimmed}`;
  return undefined;
}

const privateKey = normalizePrivateKey(process.env.PRIVATE_KEY);

export default defineConfig({
  plugins: [hardhatEthersPlugin, hardhatEthersChaiMatchersPlugin, hardhatMochaPlugin],
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 }
    }
  },
  networks: {
    default: { type: "edr-simulated", chainType: "l1" },
    localhost: { type: "http", chainType: "l1", url: "http://127.0.0.1:8545" },
    amoy: {
      type: "http",
      chainType: "l1",
      url: process.env.AMOY_RPC_URL ?? "https://rpc-amoy.polygon.technology",
      chainId: 80002,
      accounts: privateKey ? [privateKey] : []
    }
  }
});

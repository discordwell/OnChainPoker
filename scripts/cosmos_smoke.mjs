// Smoke test for the Cosmos SDK chain boundary (RPC + LCD).
//
// Usage:
//   pnpm sdk:build
//   COSMOS_RPC_URL=http://127.0.0.1:26657 COSMOS_LCD_URL=http://127.0.0.1:1317 node scripts/cosmos_smoke.mjs
//
// Optional:
//   COSMOS_MNEMONIC="..." COSMOS_PREFIX=ocp node scripts/cosmos_smoke.mjs

import { StargateClient } from "@cosmjs/stargate";
import { CosmosLcdClient, walletFromMnemonic } from "../packages/ocp-sdk/dist/index.js";

const RPC = (process.env.COSMOS_RPC_URL ?? "").trim() || "http://127.0.0.1:26657";
const LCD = (process.env.COSMOS_LCD_URL ?? "").trim() || "http://127.0.0.1:1317";
const MNEMONIC = (process.env.COSMOS_MNEMONIC ?? "").trim();
const PREFIX = (process.env.COSMOS_PREFIX ?? "").trim() || "ocp";

const client = await StargateClient.connect(RPC);
const chainId = await client.getChainId();
const height = await client.getHeight();

console.log(JSON.stringify({ rpc: RPC, lcd: LCD, chainId, height }, null, 2));

if (MNEMONIC) {
  const wallet = await walletFromMnemonic({ mnemonic: MNEMONIC, prefix: PREFIX });
  const [acct] = await wallet.getAccounts();
  console.log(JSON.stringify({ address: acct?.address ?? null }, null, 2));
}

// Demonstrate the LCD client works (even without any custom module protos).
// Standard endpoints depend on which servers the chain enables; this is expected to work when the API server is on.
try {
  const lcd = new CosmosLcdClient({ baseUrl: LCD });
  const nodeInfo = await lcd.getJson("/cosmos/base/tendermint/v1beta1/node_info");
  console.log(JSON.stringify({ lcdNodeInfo: nodeInfo?.default_node_info?.network ?? null }, null, 2));
} catch (e) {
  console.warn(`[cosmos_smoke] lcd query failed: ${String(e?.message ?? e)}`);
}


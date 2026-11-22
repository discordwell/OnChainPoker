#!/usr/bin/env node
// Reads a finalized epoch's DKG at past heights on a real node, the way a dealer daemon that was
// down at the finalize reads it (DealerDaemon.readFinalDkg), and checks that a height the node
// does not hold is refused and not answered as "nothing there". Sends nothing.
//
//   node scripts/liveness/past-state-probe.mjs --rpc http://127.0.0.1:26657
//
// Prints one line: "<commits> <encrypted shares>; <refused> of 2", the DKG record at its reveal
// deadline, and how many of two reads at heights the node does not hold were refused.

import process from "node:process";
import { parseArgs } from "node:util";

import * as sdk from "../../packages/ocp-sdk/dist/cosmos/index.js";

const { values: flags } = parseArgs({ options: { rpc: { type: "string", default: "http://127.0.0.1:26657" } } });

const signer = await sdk.walletGenerate({ prefix: "ocp" });
const signing = await sdk.connectOcpCosmosSigningClient({ rpcUrl: flags.rpc, signer, gasPrice: "0uchips", registry: sdk.createOcpRegistry() });
const client = sdk.createOcpCosmosClient({ signing });

const now = await client.getDealerState();
if (!now.epoch) {
  console.log("no epoch");
  process.exit(1);
}
const begun = (await client.getDealerState({ height: now.epoch.startHeight })).dkg;
const final = begun ? (await client.getDealerState({ height: begun.revealDeadline })).dkg : null;

let refused = 0;
for (const height of [now.epoch.startHeight - 200, now.height + 1000]) {
  await client.getDealerState({ height }).catch(() => refused++);
}
console.log(`${final?.commits.length ?? "no DKG"} ${final?.encryptedShares.length ?? ""}; ${refused} of 2`);
process.exit(0);

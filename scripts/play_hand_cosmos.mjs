#!/usr/bin/env node

import process from "node:process";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

import {
  CosmosLcdClient,
  connectOcpCosmosSigningClient,
  createOcpCosmosClient,
  createOcpRegistry,
  parseHandIdFromTx,
  parseTableIdFromTx,
  walletFromMnemonic,
  walletGenerate,
} from "../packages/ocp-sdk/dist/index.js";

import { groupElementToBytes, mulBase, scalarFromBytesModOrder } from "../packages/ocp-crypto/dist/index.js";

const RPC = (process.env.COSMOS_RPC_URL ?? "").trim() || "http://127.0.0.1:26657";
const LCD = (process.env.COSMOS_LCD_URL ?? "").trim() || "http://127.0.0.1:1317";
const PREFIX = (process.env.COSMOS_PREFIX ?? "").trim() || "ocp";
const GAS_PRICE = (process.env.COSMOS_GAS_PRICE ?? "").trim() || "0uocp";

const BUY_IN = BigInt(process.env.COSMOS_BUY_IN ?? "1000000"); // 1,000,000 uocp = 1 ocp if display exponent is 6
const FAUCET_AMOUNT = BigInt(process.env.COSMOS_FAUCET_AMOUNT ?? "50000000");
const NO_FAUCET = (process.env.COSMOS_NO_FAUCET ?? "").trim() === "1";

function nonzeroScalar() {
  while (true) {
    const s = scalarFromBytesModOrder(randomBytes(64));
    if (s !== 0n) return s;
  }
}

function genPkPlayer() {
  const sk = nonzeroScalar();
  const pk = mulBase(sk);
  const bytes = groupElementToBytes(pk);
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error("unexpected pk_player bytes");
  return bytes;
}

function faucet(toAddr, amount) {
  if (NO_FAUCET) return;
  const script = "apps/cosmos/scripts/faucet.sh";
  const args = [script, String(toAddr), String(amount)];
  const res = spawnSync("bash", args, { stdio: "inherit", env: process.env });
  if (res.status !== 0) throw new Error(`faucet failed: exit=${res.status}`);
}

async function mkClient(name, mnemonicEnv) {
  const mnemonic = (process.env[mnemonicEnv] ?? "").trim();
  const wallet = mnemonic ? await walletFromMnemonic({ mnemonic, prefix: PREFIX }) : await walletGenerate({ prefix: PREFIX });

  const [acct] = await wallet.getAccounts();
  if (!acct?.address) throw new Error(`${name}: wallet has no account`);

  faucet(acct.address, FAUCET_AMOUNT);

  const registry = createOcpRegistry();
  const signing = await connectOcpCosmosSigningClient({
    rpcUrl: RPC,
    signer: wallet,
    gasPrice: GAS_PRICE,
    registry,
  });
  const lcd = new CosmosLcdClient({ baseUrl: LCD });
  return { address: signing.address, client: createOcpCosmosClient({ signing, lcd }), pkPlayer: genPkPlayer() };
}

async function main() {
  const alice = await mkClient("alice", "ALICE_MNEMONIC");
  const bob = await mkClient("bob", "BOB_MNEMONIC");

  console.log(JSON.stringify({ rpc: RPC, lcd: LCD, alice: alice.address, bob: bob.address }, null, 2));

  const createTx = await alice.client.pokerCreateTable({
    smallBlind: 1n,
    bigBlind: 2n,
    minBuyIn: BUY_IN,
    maxBuyIn: BUY_IN * 1000n,
    label: "cosmos-localnet",
  });
  const tableId =
    parseTableIdFromTx(createTx) ??
    (await alice.client.getTables())
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0))
      .at(-1);
  if (!tableId) throw new Error("could not determine tableId");

  await alice.client.pokerSit({ tableId, seat: 0, buyIn: BUY_IN, pkPlayer: alice.pkPlayer });
  await bob.client.pokerSit({ tableId, seat: 1, buyIn: BUY_IN, pkPlayer: bob.pkPlayer });

  const before = await alice.client.getTable(tableId);
  console.log(JSON.stringify({ tableId, table: before }, null, 2));

  // This will start a hand, but dealer progression requires validator-signed x/dealer messages.
  const startTx = await alice.client.pokerStartHand({ tableId });
  const handId = parseHandIdFromTx(startTx);

  const after = await alice.client.getTable(tableId);
  console.log(JSON.stringify({ tableId, handId, table: after }, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err?.stack || String(err));
  process.exit(1);
});

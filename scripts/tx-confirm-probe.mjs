#!/usr/bin/env node
// Checks on a real chain that the SDK confirms a transaction by reading blocks, with the tx index off.
// Sends 1 base unit to fresh addresses, three times, from a funded key, and one send above the balance.
//
// usage: OCP_PROBE_MNEMONIC="..." node scripts/tx-confirm-probe.mjs --rpc http://127.0.0.1:26657 [--quiet-rpc URL]
//   The key comes from the environment only (OCP_PROBE_MNEMONIC, or OCP_PROBE_PRIVKEY as 32-byte hex),
//   so it does not show in the process list.
//   --quiet-rpc (or OCP_PROBE_QUIET_RPC): a node of the same chain whose mempool does not relay
//   ([mempool] broadcast = false, not a validator). A tx sent there is never included, so it must
//   come back "expired". Without it that check is skipped.
//   --denom, --gas-price, --prefix (or OCP_PROBE_DENOM, OCP_PROBE_GAS_PRICE, OCP_PROBE_PREFIX):
//   default uchips, 0uchips, ocp.
// Prints one PASS, FAIL or SKIP line per check and exits 1 when any check fails.

import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import process from "node:process";
import { parseArgs } from "node:util";

import * as sdk from "../packages/ocp-sdk/dist/index.js";

const sdkRequire = createRequire(new URL("../packages/ocp-sdk/package.json", import.meta.url));
const { sha256 } = sdkRequire("@cosmjs/crypto");
const { toHex } = sdkRequire("@cosmjs/encoding");
const { decodeTxRaw } = sdkRequire("@cosmjs/proto-signing");
const { StargateClient } = sdkRequire("@cosmjs/stargate");
const { connectComet } = sdkRequire("@cosmjs/tendermint-rpc");

const { values: flags } = parseArgs({
  options: {
    rpc: { type: "string" },
    "quiet-rpc": { type: "string" },
    denom: { type: "string" },
    "gas-price": { type: "string" },
    prefix: { type: "string" },
  },
});
const env = process.env;
const RPC = flags.rpc ?? env.OCP_PROBE_RPC ?? "http://127.0.0.1:26657";
const QUIET_RPC = flags["quiet-rpc"] ?? env.OCP_PROBE_QUIET_RPC ?? "";
const DENOM = flags.denom ?? env.OCP_PROBE_DENOM ?? "uchips";
const GAS_PRICE = flags["gas-price"] ?? env.OCP_PROBE_GAS_PRICE ?? `0${DENOM}`;
const PREFIX = flags.prefix ?? env.OCP_PROBE_PREFIX ?? "ocp";

const mnemonic = (env.OCP_PROBE_MNEMONIC ?? "").trim();
const privateKeyHex = (env.OCP_PROBE_PRIVKEY ?? "").trim();
if (!mnemonic && !privateKeyHex) {
  console.error("set OCP_PROBE_MNEMONIC or OCP_PROBE_PRIVKEY to a funded key");
  process.exit(2);
}
const wallet = mnemonic
  ? await sdk.walletFromMnemonic({ mnemonic, prefix: PREFIX })
  : await sdk.walletFromPrivKey({ privateKeyHex, prefix: PREFIX });
const [{ address }] = await wallet.getAccounts();

const outcomes = [];
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  outcomes.push(ok);
}

// An SDK from before block-scan confirmation has no txFailureOf; the probe also runs against it.
const failureOf = (err) => (sdk.txFailureOf ? sdk.txFailureOf(err) : { kind: "untyped" });
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

async function timed(call) {
  const start = Date.now();
  try {
    return { value: await call(), ms: Date.now() - start };
  } catch (error) {
    return { error, ms: Date.now() - start };
  }
}

const comet = await connectComet(RPC);
const query = await StargateClient.connect(RPC);
const latestHeight = async () => (await comet.status()).syncInfo.latestBlockHeight;
const balanceOf = async (addr) => BigInt((await query.getBalance(addr, DENOM)).amount);
const freshAddress = async () => {
  const w = await sdk.walletFromPrivKey({ privateKeyHex: randomBytes(32).toString("hex"), prefix: PREFIX });
  return (await w.getAccounts())[0].address;
};
const send = (to, amount) => ({
  typeUrl: "/cosmos.bank.v1beta1.MsgSend",
  value: { fromAddress: address, toAddress: to, amount: [{ denom: DENOM, amount: String(amount) }] },
});

/** The timeout height signed into the tx that block `height` holds under `hash`, read from the block itself. */
async function signedTimeoutHeight(height, hash) {
  const { block } = await comet.block(height);
  const tx = block.txs.find((t) => toHex(sha256(t)).toUpperCase() === hash);
  return tx ? Number(decodeTxRaw(tx).body.timeoutHeight) : null;
}

async function connect(rpcUrl, interactive) {
  return sdk.connectOcpCosmosSigningClient({ rpcUrl, signer: wallet, gasPrice: GAS_PRICE, interactive });
}

async function landsAndIsConfirmed(label, signing, ttl) {
  const to = await freshAddress();
  const before = await latestHeight();
  const { value: res, error, ms } = await timed(() => signing.signAndBroadcastAuto([send(to, 1)], "tx-confirm-probe"));
  const held = await balanceOf(to);
  if (error) {
    const landed = held === 1n ? "the transfer landed" : "the transfer did not land";
    check(`${label}: a transfer lands and the call returns its block`, false,
      `the call threw after ${seconds(ms)} (${failureOf(error).kind}): ${error.message}; the recipient holds ${held}${DENOM}, so ${landed}`);
    return;
  }
  const timeout = await signedTimeoutHeight(res.height, res.transactionHash);
  check(`${label}: a transfer lands and the call returns its block`, res.code === 0 && held === 1n && timeout !== null,
    `code ${res.code} at height ${res.height}, ${res.height - before} block(s) after ${before}, in ${seconds(ms)}; ` +
    `block ${res.height} holds tx ${res.transactionHash.slice(0, 16)}; the recipient holds ${held}${DENOM}`);
  check(`${label}: the tx is signed with timeout height = latest + ${ttl}`,
    timeout !== null && timeout >= before + ttl && timeout <= res.height - 1 + ttl,
    `timeout_height ${timeout}; latest height before the call ${before}, landed at ${res.height}`);
}

const connected = await timed(() => connect(RPC, false));
check("connect", !connected.error,
  connected.error ? connected.error.message : `${RPC} at height ${await latestHeight()}, sender ${address} holds ${await balanceOf(address)}${DENOM}`);

if (!connected.error) {
  const service = connected.value;
  await landsAndIsConfirmed("service signer", service, 6);
  await landsAndIsConfirmed("interactive signer", await connect(RPC, true), 60);

  const to = await freshAddress();
  const over = (await balanceOf(address)) + 1n;
  const refused = await timed(() => service.signAndBroadcastAuto([send(to, over)], "tx-confirm-probe"));
  const refusal = refused.error ? failureOf(refused.error) : null;
  check("a send above the balance is rejected at once", refusal?.kind === "rejected" && (await balanceOf(to)) === 0n,
    refused.error ? `${refusal.kind} after ${seconds(refused.ms)}: ${refused.error.message}` : `it resolved at height ${refused.value.height}`);

  if (!QUIET_RPC) {
    console.log("SKIP a tx that no block takes expires: no --quiet-rpc");
  } else {
    // The quiet node trails by a block or so. Until it holds the sender's last tx it answers with the old sequence.
    const quietComet = await connectComet(QUIET_RPC);
    const target = await latestHeight();
    for (let i = 0; i < 40 && (await quietComet.status()).syncInfo.latestBlockHeight < target; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    quietComet.disconnect();
    const to2 = await freshAddress();
    const quiet = await connect(QUIET_RPC, false);
    const lost = await timed(() => quiet.signAndBroadcastAuto([send(to2, 1)], "tx-confirm-probe"));
    const f = lost.error ? failureOf(lost.error) : null;
    const held = await balanceOf(to2);
    check("a tx that no block takes expires", f?.kind === "expired" && held === 0n,
      lost.error
        ? `after ${seconds(lost.ms)} the caller got ${JSON.stringify(f.kind === "untyped" ? lost.error.message : f)}; message "${lost.error.message}"; the recipient holds ${held}${DENOM}`
        : `it resolved at height ${lost.value.height}`);
  }
}

const passed = outcomes.filter(Boolean).length;
console.log(`checks ran ${outcomes.length}, passed ${passed}, failed ${outcomes.length - passed}`);
comet.disconnect();
query.disconnect();
process.exitCode = passed === outcomes.length ? 0 : 1;

#!/usr/bin/env node

import process from "node:process";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import { OcpV0Client } from "../packages/ocp-sdk/dist/index.js";

const RPC = process.env.OCP_RPC ?? "http://127.0.0.1:26657";

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function b64urlToBytes(str) {
  const s = String(str);
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// v0 tx auth: ed25519 signature over (type, nonce, signer, sha256(valueJson)).
let txNonceCtr = 0n;
function nextTxNonce() {
  // Numeric u64 string, strictly increasing for replay protection.
  txNonceCtr++;
  return (BigInt(Date.now()) * 1000000n + txNonceCtr).toString();
}

function txAuthSignBytesV0({ type, value, nonce, signer }) {
  const valueBytes = Buffer.from(JSON.stringify(value), "utf8");
  const valueHash = createHash("sha256").update(valueBytes).digest();
  return Buffer.concat([
    Buffer.from("ocp/tx/v0", "utf8"),
    Buffer.from([0]),
    Buffer.from(String(type), "utf8"),
    Buffer.from([0]),
    Buffer.from(String(nonce), "utf8"),
    Buffer.from([0]),
    Buffer.from(String(signer), "utf8"),
    Buffer.from([0]),
    valueHash,
  ]);
}

function signedEnv({ type, value, signerId, signerSk }) {
  const nonce = nextTxNonce();
  const msg = txAuthSignBytesV0({ type, value, nonce, signer: signerId });
  const sig = cryptoSign(null, msg, signerSk);
  return { type, value, nonce, signer: signerId, sig: b64(sig) };
}

function seatPlayer(table, seatIdx) {
  const s = table?.seats?.[seatIdx];
  return s?.player ?? null;
}

function toCallForSeat(table, seatIdx) {
  const h = table?.hand;
  if (!h) return 0;
  const betTo = Number(h.betTo ?? 0);
  const streetCommit = Number(h.streetCommit?.[seatIdx] ?? 0);
  return Math.max(0, betTo - streetCommit);
}

function parseTableIdFromTxResult(txResult) {
  const events = txResult?.events ?? [];
  const tableCreated = events.find((e) => e.type === "TableCreated");
  const tableId = Number((tableCreated?.attributes ?? []).find((a) => a.key === "tableId")?.value ?? "0");
  if (!tableId) throw new Error("could not parse tableId from TableCreated event");
  return tableId;
}

function parseHoleCardsFromTxResult(txResult) {
  const events = txResult?.events ?? [];
  const hole = events
    .filter((e) => e.type === "HoleCardAssigned")
    .map((e) => {
      const attrs = Object.fromEntries((e.attributes ?? []).map((a) => [a.key, a.value]));
      return {
        seat: Number(attrs.seat ?? "-1"),
        player: attrs.player ?? "",
        card0: attrs.card0 ?? "",
        card1: attrs.card1 ?? ""
      };
    })
    .filter((x) => Number.isFinite(x.seat) && x.seat >= 0 && x.player);

  return hole;
}

async function main() {
  const ocp = new OcpV0Client({ rpcUrl: RPC });

  const ALICE = "alice";
  const BOB = "bob";

  // Devnet-only faucet: register a local validator key so we can mint chips.
  // Note: `bank/mint` is validator-signed only.
  const FAUCET = "faucet";
  const faucetKeys = generateKeyPairSync("ed25519");
  const faucetPkBytes = b64urlToBytes(faucetKeys.publicKey.export({ format: "jwk" }).x);
  if (faucetPkBytes.length !== 32) throw new Error("unexpected ed25519 pubkey length");
  await ocp.broadcastTxEnvelope(
    signedEnv({
      type: "staking/register_validator",
      value: { validatorId: FAUCET, pubKey: b64(faucetPkBytes), power: 1 },
      signerId: FAUCET,
      signerSk: faucetKeys.privateKey,
    })
  );

  // v0: register account pubkeys so player txs can be authenticated on-chain.
  const aliceKeys = generateKeyPairSync("ed25519");
  const bobKeys = generateKeyPairSync("ed25519");
  const alicePkBytes = b64urlToBytes(aliceKeys.publicKey.export({ format: "jwk" }).x);
  const bobPkBytes = b64urlToBytes(bobKeys.publicKey.export({ format: "jwk" }).x);
  if (alicePkBytes.length !== 32 || bobPkBytes.length !== 32) throw new Error("unexpected ed25519 pubkey length");

  await ocp.broadcastTxEnvelope(
    signedEnv({
      type: "bank/mint",
      value: { to: ALICE, amount: 100000 },
      signerId: FAUCET,
      signerSk: faucetKeys.privateKey,
    })
  );
  await ocp.broadcastTxEnvelope(
    signedEnv({
      type: "bank/mint",
      value: { to: BOB, amount: 100000 },
      signerId: FAUCET,
      signerSk: faucetKeys.privateKey,
    })
  );

  await ocp.broadcastTxEnvelope(
    signedEnv({
      type: "auth/register_account",
      value: { account: ALICE, pubKey: b64(alicePkBytes) },
      signerId: ALICE,
      signerSk: aliceKeys.privateKey,
    })
  );
  await ocp.broadcastTxEnvelope(
    signedEnv({
      type: "auth/register_account",
      value: { account: BOB, pubKey: b64(bobPkBytes) },
      signerId: BOB,
      signerSk: bobKeys.privateKey,
    })
  );

  const createRes = await ocp.broadcastTxEnvelope(
    signedEnv({
      type: "poker/create_table",
      value: {
        creator: ALICE,
        smallBlind: 1,
        bigBlind: 2,
        minBuyIn: 100,
        maxBuyIn: 100000,
        label: "localnet",
      },
      signerId: ALICE,
      signerSk: aliceKeys.privateKey,
    })
  );

  const tableId = parseTableIdFromTxResult(createRes.tx_result ?? createRes.deliver_tx);

  await ocp.broadcastTxEnvelope(
    signedEnv({
      type: "poker/sit",
      value: { player: ALICE, tableId, seat: 0, buyIn: 1000 },
      signerId: ALICE,
      signerSk: aliceKeys.privateKey,
    })
  );
  await ocp.broadcastTxEnvelope(
    signedEnv({
      type: "poker/sit",
      value: { player: BOB, tableId, seat: 1, buyIn: 1000 },
      signerId: BOB,
      signerSk: bobKeys.privateKey,
    })
  );

  const startRes = await ocp.broadcastTxEnvelope(
    signedEnv({
      type: "poker/start_hand",
      value: { caller: ALICE, tableId },
      signerId: ALICE,
      signerSk: aliceKeys.privateKey,
    })
  ).catch((e) => {
    const msg = String(e?.message ?? e);
    if (msg.includes("no active dealer epoch") || msg.includes("public dealing is disabled")) {
      throw new Error(
        "poker/start_hand rejected: DealerStub (public dealing) is disabled by default.\n" +
          "Use scripts/play_hand_dealer.mjs to exercise the on-chain dealer pipeline, or start the chain with OCP_UNSAFE_ALLOW_DEALER_STUB=1 for insecure local testing."
      );
    }
    throw e;
  });
  const hole = parseHoleCardsFromTxResult(startRes.tx_result ?? startRes.deliver_tx);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ tableId, hole }, null, 2));

  const signingKeyByPlayer = new Map([
    [ALICE, aliceKeys.privateKey],
    [BOB, bobKeys.privateKey],
  ]);

  for (let i = 0; i < 200; i++) {
    const table = await ocp.getTable(tableId);
    if (!table?.hand) break;

    const actingSeat = Number(table.hand.actionOn ?? -1);
    if (actingSeat < 0) throw new Error(`hand stuck: actionOn=${actingSeat}`);

    const player = seatPlayer(table, actingSeat);
    if (!player) throw new Error(`no player at actingSeat=${actingSeat}`);

    const toCall = toCallForSeat(table, actingSeat);
    const action = toCall === 0 ? "check" : "call";

    const signerSk = signingKeyByPlayer.get(player);
    if (!signerSk) throw new Error(`missing signer key for player=${player}`);
    await ocp.broadcastTxEnvelope(
      signedEnv({
        type: "poker/act",
        value: { player, tableId, action },
        signerId: player,
        signerSk,
      })
    );
  }

  const finalTable = await ocp.getTable(tableId);
  const stacks = (finalTable?.seats ?? [])
    .map((s, idx) => (s ? { seat: idx, player: s.player, stack: s.stack } : null))
    .filter(Boolean);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ tableId, stacks }, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err?.stack || String(err));
  process.exit(1);
});

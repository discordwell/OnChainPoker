#!/usr/bin/env node

import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";

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
let txNonceCtr = 0;
function nextTxNonce() {
  return `${Date.now()}-${++txNonceCtr}`;
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

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(`${method} error: ${JSON.stringify(json.error)}`);
  }
  return json.result;
}

async function broadcastTx(tx) {
  // CometBFT mempool rejects identical tx bytes. Until we have real auth/seq,
  // include a throwaway nonce at the envelope level to keep txs unique.
  const nonce = tx.nonce ?? nextTxNonce();
  const txWithNonce = { ...tx, nonce };
  const bytes = Buffer.from(JSON.stringify(txWithNonce), "utf8");
  const txB64 = bytes.toString("base64");
  const result = await rpc("broadcast_tx_commit", { tx: txB64 });
  const txResult = result.tx_result;
  if (txResult && Number(txResult.code) !== 0) {
    throw new Error(`tx_result failed: code=${txResult.code} log=${txResult.log ?? ""}`);
  }
  return result;
}

async function abciQuery(path) {
  const result = await rpc("abci_query", { path });
  const valueB64 = result.response?.value ?? "";
  if (!valueB64) return null;
  const bytes = Buffer.from(valueB64, "base64");
  return JSON.parse(bytes.toString("utf8"));
}

function seatPlayer(table, seatIdx) {
  const s = table.seats?.[seatIdx];
  return s?.player ?? null;
}

function toCallForSeat(table, seatIdx) {
  const h = table.hand;
  if (!h) return 0;
  const betTo = Number(h.betTo ?? 0);
  const streetCommit = Number(h.streetCommit?.[seatIdx] ?? 0);
  return Math.max(0, betTo - streetCommit);
}

async function main() {
  const ALICE = "alice";
  const BOB = "bob";

  await broadcastTx({ type: "bank/mint", value: { to: ALICE, amount: 100000 } });
  await broadcastTx({ type: "bank/mint", value: { to: BOB, amount: 100000 } });

  const aliceKeys = generateKeyPairSync("ed25519");
  const bobKeys = generateKeyPairSync("ed25519");
  const alicePkBytes = b64urlToBytes(aliceKeys.publicKey.export({ format: "jwk" }).x);
  const bobPkBytes = b64urlToBytes(bobKeys.publicKey.export({ format: "jwk" }).x);
  if (alicePkBytes.length !== 32 || bobPkBytes.length !== 32) throw new Error("unexpected ed25519 pubkey length");

  await broadcastTx(
    signedEnv({
      type: "auth/register_account",
      value: { account: ALICE, pubKey: b64(alicePkBytes) },
      signerId: ALICE,
      signerSk: aliceKeys.privateKey,
    })
  );
  await broadcastTx(
    signedEnv({
      type: "auth/register_account",
      value: { account: BOB, pubKey: b64(bobPkBytes) },
      signerId: BOB,
      signerSk: bobKeys.privateKey,
    })
  );

  const createRes = await broadcastTx(
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

  const tableCreated = (createRes.tx_result?.events ?? []).find((e) => e.type === "TableCreated");
  const tableId = Number((tableCreated?.attributes ?? []).find((a) => a.key === "tableId")?.value ?? "0");
  if (!tableId) throw new Error("could not parse tableId from TableCreated event");

  await broadcastTx(
    signedEnv({
      type: "poker/sit",
      value: { player: ALICE, tableId, seat: 0, buyIn: 1000 },
      signerId: ALICE,
      signerSk: aliceKeys.privateKey,
    })
  );
  await broadcastTx(
    signedEnv({
      type: "poker/sit",
      value: { player: BOB, tableId, seat: 1, buyIn: 1000 },
      signerId: BOB,
      signerSk: bobKeys.privateKey,
    })
  );

  await broadcastTx(
    signedEnv({
      type: "poker/start_hand",
      value: { caller: ALICE, tableId },
      signerId: ALICE,
      signerSk: aliceKeys.privateKey,
    })
  );

  const signerSkByPlayer = new Map([
    [ALICE, aliceKeys.privateKey],
    [BOB, bobKeys.privateKey],
  ]);

  for (let i = 0; i < 200; i++) {
    const table = await abciQuery(`/table/${tableId}`);
    if (!table?.hand) break;

    const actingSeat = Number(table.hand.actionOn ?? -1);
    if (actingSeat < 0) throw new Error(`hand stuck: actionOn=${actingSeat}`);

    const player = seatPlayer(table, actingSeat);
    if (!player) throw new Error(`no player at actingSeat=${actingSeat}`);

    const toCall = toCallForSeat(table, actingSeat);
    const action = toCall === 0 ? "check" : "call";

    const signerSk = signerSkByPlayer.get(player);
    if (!signerSk) throw new Error(`missing signer key for player=${player}`);
    await broadcastTx(
      signedEnv({
        type: "poker/act",
        value: { player, tableId, action },
        signerId: player,
        signerSk,
      })
    );
  }

  const finalTable = await abciQuery(`/table/${tableId}`);
  const stacks = (finalTable?.seats ?? [])
    .map((s, idx) => (s ? { seat: idx, player: s.player, stack: s.stack } : null))
    .filter(Boolean);

  console.log(JSON.stringify({ tableId, stacks }, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});

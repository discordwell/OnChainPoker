#!/usr/bin/env node

const RPC = process.env.OCP_RPC ?? "http://127.0.0.1:26657";
let NONCE = 1;

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
  const txWithNonce = { ...tx, nonce: NONCE++ };
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
  const s = table.seats?.[seatIdx];
  if (!h || !s) return 0;
  const currentBet = Number(h.currentBet ?? 0);
  const betThisRound = Number(s.betThisRound ?? 0);
  return Math.max(0, currentBet - betThisRound);
}

async function main() {
  const ALICE = "alice";
  const BOB = "bob";

  await broadcastTx({ type: "bank/mint", value: { to: ALICE, amount: 100000 } });
  await broadcastTx({ type: "bank/mint", value: { to: BOB, amount: 100000 } });

  const createRes = await broadcastTx({
    type: "poker/create_table",
    value: {
      creator: ALICE,
      smallBlind: 1,
      bigBlind: 2,
      minBuyIn: 100,
      maxBuyIn: 100000,
      label: "localnet",
    },
  });

  const tableCreated = (createRes.tx_result?.events ?? []).find((e) => e.type === "TableCreated");
  const tableId = Number((tableCreated?.attributes ?? []).find((a) => a.key === "tableId")?.value ?? "0");
  if (!tableId) throw new Error("could not parse tableId from TableCreated event");

  await broadcastTx({ type: "poker/sit", value: { player: ALICE, tableId, seat: 0, buyIn: 1000 } });
  await broadcastTx({ type: "poker/sit", value: { player: BOB, tableId, seat: 1, buyIn: 1000 } });

  await broadcastTx({ type: "poker/start_hand", value: { caller: ALICE, tableId } });

  for (let i = 0; i < 200; i++) {
    const table = await abciQuery(`/table/${tableId}`);
    if (!table?.hand) break;

    const actingSeat = Number(table.hand.actingSeat ?? -1);
    if (actingSeat < 0) throw new Error(`hand stuck: actingSeat=${actingSeat}`);

    const player = seatPlayer(table, actingSeat);
    if (!player) throw new Error(`no player at actingSeat=${actingSeat}`);

    const toCall = toCallForSeat(table, actingSeat);
    const action = toCall === 0 ? "check" : "call";

    await broadcastTx({ type: "poker/act", value: { player, tableId, action } });
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

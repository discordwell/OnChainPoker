#!/usr/bin/env node

import process from "node:process";

import { OcpV0Client } from "../packages/ocp-sdk/dist/index.js";

const RPC = process.env.OCP_RPC ?? "http://127.0.0.1:26657";

function seatPlayer(table, seatIdx) {
  const s = table?.seats?.[seatIdx];
  return s?.player ?? null;
}

function toCallForSeat(table, seatIdx) {
  const h = table?.hand;
  const s = table?.seats?.[seatIdx];
  if (!h || !s) return 0;
  const currentBet = Number(h.currentBet ?? 0);
  const betThisRound = Number(s.betThisRound ?? 0);
  return Math.max(0, currentBet - betThisRound);
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

  await ocp.bankMint({ to: ALICE, amount: 100000 });
  await ocp.bankMint({ to: BOB, amount: 100000 });

  const createRes = await ocp.pokerCreateTable({
    creator: ALICE,
    smallBlind: 1,
    bigBlind: 2,
    minBuyIn: 100,
    maxBuyIn: 100000,
    label: "localnet"
  });

  const tableId = parseTableIdFromTxResult(createRes.tx_result ?? createRes.deliver_tx);

  await ocp.pokerSit({ player: ALICE, tableId, seat: 0, buyIn: 1000 });
  await ocp.pokerSit({ player: BOB, tableId, seat: 1, buyIn: 1000 });

  const startRes = await ocp.pokerStartHand({ caller: ALICE, tableId });
  const hole = parseHoleCardsFromTxResult(startRes.tx_result ?? startRes.deliver_tx);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ tableId, hole }, null, 2));

  for (let i = 0; i < 200; i++) {
    const table = await ocp.getTable(tableId);
    if (!table?.hand) break;

    const actingSeat = Number(table.hand.actingSeat ?? -1);
    if (actingSeat < 0) throw new Error(`hand stuck: actingSeat=${actingSeat}`);

    const player = seatPlayer(table, actingSeat);
    if (!player) throw new Error(`no player at actingSeat=${actingSeat}`);

    const toCall = toCallForSeat(table, actingSeat);
    const action = toCall === 0 ? "check" : "call";

    await ocp.pokerAct({ player, tableId, action });
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

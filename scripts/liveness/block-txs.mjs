#!/usr/bin/env node
// Lists every transaction of every block from block results: who sent it, at which sequence, which
// messages it carried, and how it ended. Read-only, no dependencies, no tx index.
//
//   node scripts/liveness/block-txs.mjs --rpc http://127.0.0.1:26657 --from H [--to H] [--names a=dealer-0,b=bot-0]
//
// One line per transaction:
//   1100412 2026-11-22T18:46:01.123Z 3 dealer-1 seq=45 SubmitPubShare(t1 h5 p12) code=0 gas=171002/320000
//   1100412 2026-11-22T18:46:01.123Z 4 dealer-2 seq=33 FinalizeReveal(t1 h5 p12) code=1 gas=40211/200000 "insufficient shares"
// The sender is the account of the tx's first signature (its acc_seq event), named by --names.
// A dealer message's first field (validator or caller) is named too, so a validator's operator
// address may be given as well as its account address.

import process from "node:process";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({
  options: {
    rpc: { type: "string", default: "http://127.0.0.1:26657" },
    from: { type: "string" },
    to: { type: "string" },
    names: { type: "string", default: "" },
  },
});
const rpcUrl = flags.rpc.replace(/\/+$/, "");
const from = Number(flags.from);
if (!Number.isInteger(from) || from < 1) {
  console.error("--from <height> is required");
  process.exit(2);
}
const names = new Map(
  flags.names.split(",").filter(Boolean).map((pair) => {
    const at = pair.indexOf("=");
    return [pair.slice(0, at), pair.slice(at + 1)];
  }),
);
const nameOf = (addr) => names.get(addr) ?? (addr ? `${addr.slice(0, 10)}..${addr.slice(-4)}` : "?");

async function rpc(method, params) {
  const res = await fetch(`${rpcUrl}/${method}?${new URLSearchParams(params)}`);
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.data ?? body.error.message}`);
  return body.result;
}

/** Protobuf fields of `buf` as [fieldNumber, value]: a bigint for a varint, a Uint8Array for bytes. */
function fields(buf) {
  const out = [];
  let i = 0;
  const varint = () => {
    let x = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const b = buf[i++];
      x |= BigInt(b & 0x7f) << shift;
      if (b < 0x80) return x;
    }
  };
  while (i < buf.length) {
    const key = Number(varint());
    const wire = key & 7;
    if (wire === 0) out.push([key >> 3, varint()]);
    else if (wire === 2) {
      const len = Number(varint());
      out.push([key >> 3, buf.subarray(i, i + len)]);
      i += len;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else break;
  }
  return out;
}

const text = (bytes) => new TextDecoder().decode(bytes);
// Fields 2, 3 and 4 of these are the table, the hand and the position (the round for a shuffle).
const HAND_MSGS = new Set(["MsgInitHand", "MsgSubmitShuffle", "MsgFinalizeDeck", "MsgSubmitEncShare", "MsgSubmitPubShare", "MsgFinalizeReveal", "MsgTimeout"]);
const POKER_MSGS = new Set(["MsgStartHand", "MsgAct", "MsgTick", "MsgSit", "MsgLeave", "MsgRebuy"]);

/** "SubmitPubShare(t1 h5 p12)" for each message of a tx. */
function messagesOf(txBase64) {
  const raw = fields(Buffer.from(txBase64, "base64"));
  const body = raw.find(([n]) => n === 1)?.[1];
  if (!body) return ["?"];
  return fields(body)
    .filter(([n]) => n === 1)
    .map(([, any]) => {
      const f = fields(any);
      const type = text(f.find(([n]) => n === 1)?.[1] ?? new Uint8Array()).split(".").pop();
      const value = fields(f.find(([n]) => n === 2)?.[1] ?? new Uint8Array());
      const num = (n) => value.find(([k, v]) => k === n && typeof v === "bigint")?.[1];
      const parts = [];
      if (HAND_MSGS.has(type)) {
        if (num(2) !== undefined) parts.push(`t${num(2)}`);
        if (num(3) !== undefined) parts.push(`h${num(3)}`);
        // Protobuf leaves out a zero, so a share of position 0 carries no field 4.
        if (type === "MsgSubmitShuffle") parts.push(`r${num(4)}`);
        else if (/Share$|Reveal$/.test(type)) parts.push(`p${num(4) ?? 0n}`);
      } else if (POKER_MSGS.has(type) && num(2) !== undefined) parts.push(`t${num(2)}`);
      return `${type}${parts.length ? `(${parts.join(" ")})` : ""}`;
    });
}

function accSeq(events) {
  for (const e of events ?? []) {
    if (e.type !== "tx") continue;
    const a = (e.attributes ?? []).find((x) => x.key === "acc_seq");
    if (a) {
      const at = a.value.lastIndexOf("/");
      return { sender: a.value.slice(0, at), seq: a.value.slice(at + 1) };
    }
  }
  return { sender: "", seq: "?" };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const latest = Number((await rpc("status", {})).sync_info.latest_block_height);
const to = flags.to === undefined ? latest : Math.min(Number(flags.to), latest);

for (let height = from; height <= to; height++) {
  let block, results;
  for (let attempt = 0; ; attempt++) {
    try {
      block = (await rpc("block", { height })).block;
      results = await rpc("block_results", { height });
      break;
    } catch (err) {
      if (attempt >= 50 || !/could not find results/.test(String(err.message))) throw err;
      await sleep(200);
    }
  }
  const time = block.header.time;
  (block.data.txs ?? []).forEach((tx, index) => {
    const r = results.txs_results[index] ?? {};
    const { sender, seq } = accSeq(r.events);
    const log = r.code === 0 ? "" : ` ${JSON.stringify(String(r.log ?? "").slice(0, 160))}`;
    console.log(`${height} ${time} ${index} ${nameOf(sender)} seq=${seq} ${messagesOf(tx).join("+")} code=${r.code} gas=${r.gas_used}/${r.gas_wanted}${log}`);
  });
}

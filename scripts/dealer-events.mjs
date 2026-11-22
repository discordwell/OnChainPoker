#!/usr/bin/env node
// Lists dealer and poker events from block results. It never uses the tx index, so it works on
// nodes that run with `indexer = "null"`. Read-only, no dependencies.
//
//   node scripts/dealer-events.mjs --rpc http://127.0.0.1:26657 --from 1536900 [--to 1537400] [--follow]
//   node scripts/dealer-events.mjs --rpc ... --from H --count ValidatorSlashed      prints one number
//   node scripts/dealer-events.mjs --rpc ... --from H --find-tx <HASH> [--wait 20]  prints "<height> code=<n>"
//
// One line per event, begin-block and end-block events included (BeaconOpened is emitted there):
//   1536569 DealerEpochBegun epochId=44 committeeSize=3 commitDeadline=1536689 ...
//   1041960 ValidatorSlashed validator=ocpvaloper1... reason=hole-enc-shares-timeout slashFraction=0.1
// A value with a space in it is printed in double quotes.
//
//   --types A,B     only these event types (default: every type of x/dealer and x/poker)
//   --time          print the block's header time after the height
//   --heartbeat     also print "<height> -" for a block with no such event, so a reader of the
//                   output knows how far the scan is
//   --wait N        with --find-tx: keep reading new blocks until N blocks past --from
//
// Bounded: one request per height (two with --time or --find-tx), one block in memory, and with
// --follow a 500 ms sleep between polls. A height the node no longer holds prints "pruned below H"
// to stderr once and the scan starts at H.

import { createHash } from "node:crypto";
import process from "node:process";
import { parseArgs } from "node:util";

// x/dealer/types/events.go and x/poker/types/events.go.
const MODULE_EVENTS = [
  "BeaconOpened", "BeaconCommitted", "BeaconRevealed", "BeaconFinalized", "BeaconFallback",
  "DealerEpochBegun", "DealerEpochFinalized", "DealerEpochAborted",
  "DKGCommitAccepted", "DKGEncryptedShareAccepted", "DKGComplaintAccepted", "DKGShareRevealed", "DKGTimeoutApplied",
  "ValidatorSlashed", "DealerTimeoutApplied",
  "DealerHandInitialized", "ShuffleAccepted", "DeckFinalized", "EncShareAccepted", "HoleCardsReady",
  "PubShareAccepted", "RevealFinalized",
  "TableCreated", "PlayerSat", "PlayerLeft", "PlayerEjected", "PlayerRebuyed", "PlayerSlashed",
  "HandStarted", "ActionApplied", "TimeoutApplied", "StreetRevealed", "HoleCardRevealed",
  "ShowdownReached", "PotAwarded", "PotRefunded", "HandCompleted", "HandAborted",
];

const { values: flags } = parseArgs({
  options: {
    rpc: { type: "string", default: "http://127.0.0.1:26657" },
    from: { type: "string" },
    to: { type: "string" },
    follow: { type: "boolean", default: false },
    types: { type: "string" },
    time: { type: "boolean", default: false },
    heartbeat: { type: "boolean", default: false },
    count: { type: "string" },
    "find-tx": { type: "string" },
    wait: { type: "string", default: "0" },
  },
});

function fail(message) {
  console.error(message);
  process.exit(2);
}

const rpcUrl = flags.rpc.replace(/\/+$/, "");
const from = Number(flags.from);
if (!Number.isInteger(from) || from < 1) fail("--from <height> is required");
const to = flags.to === undefined ? null : Number(flags.to);
if (to !== null && !Number.isInteger(to)) fail("--to must be a height");
const wanted = new Set(flags.count ? [flags.count] : flags.types ? flags.types.split(",") : MODULE_EVENTS);

async function rpc(method, params) {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`${rpcUrl}/${method}${query ? `?${query}` : ""}`);
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.data ?? body.error.message}`);
  return body.result;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const latestHeight = async () => Number((await rpc("status", {})).sync_info.latest_block_height);

/** The node's block results at `height`, or the lowest height it holds when it has pruned this one. */
async function resultsAt(height) {
  for (let attempt = 0; ; attempt++) {
    try {
      return { results: await rpc("block_results", { height }) };
    } catch (err) {
      const lowest = /lowest height is (\d+)/.exec(String(err.message));
      if (lowest && Number(lowest[1]) > height) return { prunedBelow: Number(lowest[1]) };
      // A node reports a height as its latest before it has stored that block's results.
      if (attempt >= 50 || !/could not find results/.test(String(err.message))) throw err;
      await sleep(200);
    }
  }
}

function eventsOf(results) {
  const all = [...(results.finalize_block_events ?? [])];
  for (const tx of results.txs_results ?? []) all.push(...(tx.events ?? []));
  return all.filter((e) => wanted.has(e.type));
}

function lineOf(event) {
  const attrs = (event.attributes ?? [])
    .filter((a) => a.key !== "mode" && a.key !== "msg_index")
    .map((a) => `${a.key}=${/[\s"]/.test(a.value) ? JSON.stringify(a.value) : a.value}`);
  return [event.type, ...attrs].join(" ");
}

/** Calls `visit(height, results)` for each height from `start`, until `visit` returns true or the range ends. */
async function scan(start, visit) {
  // Blocks that do not exist yet are waited for with --follow, and with --find-tx up to this height.
  const waitThrough = flags["find-tx"] ? from + Number(flags.wait) : 0;
  let latest = await latestHeight();
  for (let height = start; ; ) {
    if (to !== null && height > to) return;
    if (height > latest) {
      if (!flags.follow && height > waitThrough) return;
      await sleep(500);
      latest = await latestHeight();
      continue;
    }
    const at = await resultsAt(height);
    if (at.prunedBelow !== undefined) {
      console.error(`pruned below ${at.prunedBelow}`);
      height = at.prunedBelow;
      continue;
    }
    if (await visit(height, at.results)) return;
    height++;
  }
}

if (flags["find-tx"]) {
  const hash = flags["find-tx"].toUpperCase();
  let found = false;
  await scan(from, async (height, results) => {
    if ((results.txs_results ?? []).length === 0) return false;
    const { block } = await rpc("block", { height });
    const index = block.data.txs.findIndex(
      (tx) => createHash("sha256").update(Buffer.from(tx, "base64")).digest("hex").toUpperCase() === hash,
    );
    if (index < 0) return false;
    const tx = results.txs_results[index];
    console.log(`${height} code=${tx.code}${tx.code === 0 ? "" : ` ${JSON.stringify(tx.log)}`}`);
    found = true;
    return true;
  });
  if (!found) console.log("not found");
  process.exit(found ? 0 : 1);
}

let counted = 0;
await scan(from, async (height, results) => {
  const events = eventsOf(results);
  if (flags.count) {
    counted += events.length;
    return false;
  }
  if (events.length === 0 && !flags.heartbeat) return false;
  const stamp = flags.time ? `${height} ${(await rpc("header", { height })).header.time}` : String(height);
  if (events.length === 0) console.log(`${stamp} -`);
  for (const event of events) console.log(`${stamp} ${lineOf(event)}`);
  return false;
});
if (flags.count) console.log(counted);

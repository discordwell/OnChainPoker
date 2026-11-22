#!/usr/bin/env node
// How long hands took, from the chain's own block heights and header times. Reads the output of
// `dealer-events.mjs --time` and prints, for the hands that reached showdown:
//   one row per hand, the median and the worst of "StartHand to first decision possible"
//   (HoleCardsReady) and "StartHand to showdown result" (HandCompleted), and the steps of the
//   median hand in blocks and seconds.
//
//   node scripts/liveness/hand-times.mjs <events.log> [--from HEIGHT] [--players N] [--json]
//
// --from     only hands started at or after this height
// --players  only hands dealt to this many players
// A step runs from the event before it to its own event, so the steps of a hand add up to the hand.
// "players" steps are the blocks in which the chain waited for a player's action.

import { readFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: { from: { type: "string", default: "0" }, players: { type: "string" }, json: { type: "boolean", default: false } },
});
if (positionals.length !== 1) {
  console.error("usage: hand-times.mjs <events.log> [--from HEIGHT] [--players N] [--json]");
  process.exit(2);
}

/** "<height> <time> <Type> key=value ..." */
function parse(line) {
  const [height, time, type, ...rest] = line.split(" ");
  if (!type || type === "-") return null;
  const attrs = {};
  for (const pair of rest.join(" ").match(/[A-Za-z]+=("[^"]*"|\S*)/g) ?? []) {
    const at = pair.indexOf("=");
    attrs[pair.slice(0, at)] = pair.slice(at + 1).replace(/^"|"$/g, "");
  }
  return { height: Number(height), ms: Date.parse(time), type, attrs };
}

const hands = new Map();
for (const line of readFileSync(positionals[0], "utf8").split("\n")) {
  const event = parse(line);
  if (!event?.attrs.handId) continue;
  if (!hands.has(event.attrs.handId)) hands.set(event.attrs.handId, []);
  hands.get(event.attrs.handId).push(event);
}

/** The steps of one hand, or null when it did not run from HandStarted to a showdown. */
function stepsOf(events) {
  const start = events.find((e) => e.type === "HandStarted");
  const end = events.find((e) => e.type === "HandCompleted");
  if (!start || !end || end.attrs.reason !== "showdown") return null;

  const steps = [];
  let last = start;
  let street = "preflop";
  let boardCards = 0;
  let showdownCards = 0;
  const mark = (name, kind, event) => {
    steps.push({ name, kind, blocks: event.height - last.height, seconds: (event.ms - last.ms) / 1000 });
    last = event;
  };
  for (const e of events) {
    switch (e.type) {
      case "DealerHandInitialized":
        mark("init hand", "dealer", e);
        break;
      case "ShuffleAccepted":
        mark(`shuffle ${e.attrs.round}`, "dealer", e);
        break;
      case "DeckFinalized":
        mark("finalize deck", "dealer", e);
        break;
      case "HoleCardsReady":
        mark("hole-card shares", "dealer", e);
        break;
      case "ActionApplied": {
        // The action that closes a betting round carries the phase the hand moved to.
        const next = /AWAIT_(FLOP|TURN|RIVER|SHOWDOWN)/.exec(e.attrs.phase ?? "");
        if (!next) break;
        mark(`${street} betting`, "players", e);
        street = next[1].toLowerCase();
        break;
      }
      case "RevealFinalized":
        if (street === "showdown") mark(`showdown card ${++showdownCards}`, "dealer", e);
        else mark(`board card ${++boardCards}`, "dealer", e);
        break;
    }
  }
  const ready = events.find((e) => e.type === "HoleCardsReady");
  if (!ready) return null;
  const sum = (kind, field) => steps.filter((s) => s.kind === kind).reduce((n, s) => n + s[field], 0);
  return {
    handId: Number(start.attrs.handId),
    startHeight: start.height,
    players: new Set(events.filter((e) => e.type === "EncShareAccepted").map((e) => e.attrs.pos)).size / 2,
    toDecision: { blocks: ready.height - start.height, seconds: (ready.ms - start.ms) / 1000 },
    toShowdown: { blocks: end.height - start.height, seconds: (end.ms - start.ms) / 1000 },
    dealer: { blocks: sum("dealer", "blocks"), seconds: sum("dealer", "seconds") },
    playersWait: { blocks: sum("players", "blocks"), seconds: sum("players", "seconds") },
    steps,
  };
}

const timed = [...hands.values()]
  .map(stepsOf)
  .filter((h) => h !== null && h.startHeight >= Number(flags.from) && (flags.players === undefined || h.players === Number(flags.players)))
  .sort((a, b) => a.handId - b.handId);

if (timed.length === 0) {
  console.log("hands timed 0");
  process.exit(1);
}

/** The middle value, the lower of the two middle ones for an even count: always a value that was measured. */
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)];
const worst = (values) => Math.max(...values);
const stat = (pick) => ({
  median: { blocks: median(timed.map((h) => pick(h).blocks)), seconds: median(timed.map((h) => pick(h).seconds)) },
  worst: { blocks: worst(timed.map((h) => pick(h).blocks)), seconds: worst(timed.map((h) => pick(h).seconds)) },
});
const summary = {
  hands: timed.length,
  players: timed[0].players,
  toDecision: stat((h) => h.toDecision),
  toShowdown: stat((h) => h.toShowdown),
  dealer: stat((h) => h.dealer),
  playersWait: stat((h) => h.playersWait),
};
const typical = timed.find((h) => h.toShowdown.seconds === summary.toShowdown.median.seconds);

if (flags.json) {
  console.log(JSON.stringify({ summary, typical, hands: timed.map(({ steps, ...rest }) => rest) }));
  process.exit(0);
}

const s = (n) => n.toFixed(1).padStart(6);
const b = (n) => String(n).padStart(4);
console.log(`hands timed ${summary.hands}, ${summary.players} players each`);
console.log("hand   to first decision    to showdown       dealer steps      waiting for players");
for (const h of timed) {
  console.log(
    `${String(h.handId).padStart(4)}  ${b(h.toDecision.blocks)} blk ${s(h.toDecision.seconds)} s  ${b(h.toShowdown.blocks)} blk ${s(h.toShowdown.seconds)} s  ` +
    `${b(h.dealer.blocks)} blk ${s(h.dealer.seconds)} s  ${b(h.playersWait.blocks)} blk ${s(h.playersWait.seconds)} s`,
  );
}
for (const row of ["median", "worst"]) {
  console.log(
    `${row.padStart(6)}${b(summary.toDecision[row].blocks)} blk ${s(summary.toDecision[row].seconds)} s  ${b(summary.toShowdown[row].blocks)} blk ${s(summary.toShowdown[row].seconds)} s  ` +
    `${b(summary.dealer[row].blocks)} blk ${s(summary.dealer[row].seconds)} s  ${b(summary.playersWait[row].blocks)} blk ${s(summary.playersWait[row].seconds)} s`,
  );
}
console.log(`steps of hand ${typical.handId} (the median hand to showdown):`);
for (const step of typical.steps) {
  console.log(`  ${step.name.padEnd(18)} ${b(step.blocks)} blk ${s(step.seconds)} s${step.kind === "players" ? "  (players)" : ""}`);
}

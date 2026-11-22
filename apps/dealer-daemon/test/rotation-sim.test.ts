// Three copies of decide() against the model of the dealer module in modelChain.ts, over seeded
// schedules of polls, restarts and outages. Each daemon here does what DealerDaemon does around
// decide(): it keeps the same memory, stores a commit before sending it, and sends at most one
// transaction per poll, which the chain executes in the next block.
//
// Hands are not modelled. A daemon that is down for longer than a hand's deadline is slashed by
// the chain whatever the daemon does when it is up.
//
// SIM_SEEDS sets the number of random schedules per group (default 300).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DealerDkg } from "@onchainpoker/ocp-sdk/cosmos";
import { POLICY, afterUnjail, decide, unjailBlock, type Action, type ChainView, type KeygenFacts, type Me, type Memory, type ShareStatus, type UnjailRecord } from "../src/rotation.js";
import { ModelChain, type Slash, type Tx } from "./modelChain.js";

const SEEDS = Number(process.env.SIM_SEEDS ?? 300);
const VALIDATORS = ["ocpvaloper1a", "ocpvaloper1b", "ocpvaloper1c"];
// Where the live chain stood on 2026-11-22: above the height that lets the chain replace a stuck
// beacon window, epoch 42 dead, and next epoch id 44.
const START = { height: 1_536_600, deadEpochId: 42, nextEpochId: 44 };
const BLOCK_MS = 5_000;

function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One daemon: what the process remembers, and what its state directory holds. */
type Daemon = {
  me: Me;
  rotatingSince: number | null;
  disk: { committed: Set<number>; received: Map<number, Set<string>>; settled: Set<number>; unjail: UnjailRecord };
};

function daemonFor(validator: string, patienceBlocks: number): Daemon {
  return {
    me: { validator, committeeSize: 3, threshold: 2, mayBeginEpoch: true, mayFinalizeEpoch: true, patienceBlocks },
    rotatingSince: null,
    disk: { committed: new Set(), received: new Map(), settled: new Set(), unjail: { landed: 0, lastLandedAtMs: 0, lastTriedAtMs: 0 } },
  };
}

/** What syncShares does: every share for me that the record holds goes to disk. */
function sync(d: Daemon, dkg: DealerDkg): Set<string> {
  const me = d.me.validator;
  const index = dkg.members.find((m) => m.validator === me)!.index;
  const held = d.disk.received.get(dkg.epochId) ?? new Set<string>();
  for (const e of dkg.encryptedShares) if (e.recipientIndex === index) held.add(e.dealer);
  for (const r of dkg.reveals) if (r.to === me) held.add(r.dealer);
  d.disk.received.set(dkg.epochId, held);
  return held;
}

/** What DealerDaemon.remember does, with facts instead of bytes. */
function remember(d: Daemon, view: ChainView, chain: ModelChain): Memory {
  const me = d.me.validator;
  const { dkg, epoch, height } = view.dealer;

  let keygen: KeygenFacts | null = null;
  if (dkg && dkg.members.some((m) => m.validator === me)) {
    const onChain = dkg.commits.some((c) => c.dealer === me);
    keygen = !onChain
      ? { disk: "ok", commitMatchesDisk: null, holds: new Set() }
      : { disk: "ok", commitMatchesDisk: d.disk.committed.has(dkg.epochId), holds: d.disk.committed.has(dkg.epochId) ? new Set(sync(d, dkg)) : new Set() };
  }

  let share: ShareStatus = { is: "not-member" };
  if (epoch && epoch.members.some((m) => m.validator === me)) {
    if (epoch.slashed.includes(me)) share = { is: "slashed" };
    else if (d.disk.settled.has(epoch.epochId)) share = { is: "ready" };
    else {
      const needed = epoch.members.map((m) => m.validator).filter((v) => v !== me && !epoch.slashed.includes(v));
      const held = () => d.disk.received.get(epoch.epochId) ?? new Set<string>();
      // A daemon that was down at finalize reads the DKG as it was at its reveal deadline.
      const final = chain.dkgView(chain.finalDkgs.get(epoch.epochId) ?? null);
      if (needed.some((v) => !held().has(v)) && final && d.disk.committed.has(epoch.epochId)) sync(d, final);
      const missing = needed.filter((v) => !held().has(v));
      if (missing.length > 0 || !d.disk.committed.has(epoch.epochId)) share = { is: "missing", from: missing };
      else {
        d.disk.settled.add(epoch.epochId);
        share = { is: "ready" };
      }
    }
  }

  const mine = view.validators.find((v) => v.operator === me);
  const nowMs = height * BLOCK_MS;
  return {
    waitedBlocks: d.rotatingSince === null ? 0 : height - d.rotatingSince,
    storeUsable: true,
    unjailBlockedBy: mine?.jailed
      ? unjailBlock({ nowMs, record: d.disk.unjail, node: { latestHeight: height, latestBlockTimeMs: nowMs, catchingUp: false, consensusPubkey: mine.consensusPubkey }, consensusPubkey: mine.consensusPubkey })
      : null,
    keygen,
    share,
  };
}

/** What DealerDaemon.perform does: the transaction for an action. A commit is on disk before it is sent. */
function txFor(d: Daemon, action: Action, height: number): Tx {
  const me = d.me.validator;
  switch (action.do) {
    case "unjail":
      d.disk.unjail = { ...d.disk.unjail, lastTriedAtMs: height * BLOCK_MS };
      return { type: "unjail", validator: me };
    case "beaconCommit":
      return { type: "beaconCommit", validator: me, epochId: action.epochId };
    case "beaconReveal":
      return { type: "beaconReveal", validator: me, epochId: action.epochId };
    case "beginEpoch":
      return { type: "beginEpoch", caller: me, epochId: action.epochId, committeeSize: action.committeeSize, threshold: action.threshold, ...POLICY.dkgWindows };
    case "dkgCommit":
      d.disk.committed.add(action.dkg.epochId);
      return { type: "dkgCommit", dealer: me, epochId: action.dkg.epochId };
    case "dkgEncryptedShare":
      return { type: "dkgEncryptedShare", dealer: me, epochId: action.dkg.epochId, recipientIndex: action.recipientIndex };
    case "dkgRevealShare":
      return { type: "dkgShareReveal", dealer: me, epochId: action.dkg.epochId, to: action.to };
    case "dkgComplainMissing":
      return { type: "dkgComplaintMissing", complainer: me, epochId: action.dkg.epochId, dealer: action.dealer };
    case "finalizeEpoch":
      return { type: "finalizeEpoch", epochId: action.epochId };
  }
}

/** The daemon the repair replaces: it commits for the current epoch plus one, and begins only when no epoch exists. */
function oldDaemonTx(d: Daemon, view: ChainView): Tx | null {
  const epoch = view.dealer.epoch;
  if (!epoch && !view.dealer.dkg) return { type: "beginEpoch", caller: d.me.validator, epochId: view.dealer.nextEpochId, committeeSize: 3, threshold: 2, commitBlocks: 5, complaintBlocks: 5, revealBlocks: 5 };
  return { type: "beaconCommit", validator: d.me.validator, epochId: (epoch?.epochId ?? 0) + 1 };
}

type Schedule = {
  blocks: number;
  /** The daemon does not poll at this height. */
  down?: (daemon: number, height: number) => boolean;
  /** The daemon's process restarts before this poll: it loses its memory and keeps its disk. */
  restarts?: (daemon: number, height: number) => boolean;
  /** The order daemons poll in at this height. */
  order?: (height: number) => number[];
  patienceBlocks?: number;
  old?: boolean;
  stopWhenDealing?: boolean;
};

type Outcome = {
  slashes: readonly Slash[];
  /** Height at which an epoch that can deal with every validator qualified first existed. */
  dealingAt: number | null;
  chain: ModelChain;
  /** A slash that no daemon announced as the cost of its action. */
  unannounced: Slash[];
  blockedAt: number | null;
};

function run(schedule: Schedule): Outcome {
  const chain = new ModelChain(VALIDATORS, START);
  const daemons = VALIDATORS.map((v) => daemonFor(v, schedule.patienceBlocks ?? POLICY.defaultPatienceBlocks));
  const announced = new Set<string>();
  let dealingAt: number | null = null;
  let blockedAt: number | null = null;
  let pending: { daemon: Daemon; tx: Tx }[] = [];

  for (let i = 0; i < schedule.blocks; i++) {
    const answers = chain.block(pending.map((p) => p.tx));
    pending.forEach(({ daemon, tx }, n) => {
      if (tx.type === "unjail" && answers[n] === null) daemon.disk.unjail = afterUnjail(daemon.disk.unjail, chain.height * BLOCK_MS);
    });
    pending = [];

    const view = chain.view();
    const epoch = view.dealer.epoch;
    if (dealingAt === null && epoch && epoch.epochId !== START.deadEpochId && epoch.members.length - epoch.slashed.length >= epoch.threshold) {
      dealingAt = chain.height;
      if (schedule.stopWhenDealing) break;
    }

    for (const n of schedule.order?.(chain.height) ?? [0, 1, 2]) {
      const d = daemons[n]!;
      if (schedule.down?.(n, chain.height)) continue;
      if (schedule.restarts?.(n, chain.height)) d.rotatingSince = null;
      if (schedule.old) {
        const tx = oldDaemonTx(d, view);
        if (tx) pending.push({ daemon: d, tx });
        continue;
      }
      const decision = decide(view, d.me, remember(d, view, chain));
      if (decision.situation.kind !== "rotating") d.rotatingSince = null;
      else {
        d.rotatingSince ??= chain.height;
        if (decision.situation.rollCall.at === "blocked") blockedAt ??= chain.height;
      }
      for (const v of decision.costs) announced.add(v);
      if (decision.action) pending.push({ daemon: d, tx: txFor(d, decision.action, chain.height) });
    }
  }
  return { slashes: chain.slashes, dealingAt, chain, unannounced: chain.slashes.filter((s) => !announced.has(s.validator)), blockedAt };
}

/** Outages of 1..maxLength blocks for each daemon, at least `gap` blocks apart, from a seed. */
function outages(seed: number, blocks: number, maxLength: number, gap: number): (daemon: number, height: number) => boolean {
  const rng = rngOf(seed);
  const down = new Set<string>();
  for (let n = 0; n < 3; n++) {
    let h = START.height + Math.floor(rng() * gap * 2);
    while (h < START.height + blocks) {
      const length = 1 + Math.floor(rng() * maxLength);
      for (let k = 0; k < length; k++) down.add(`${n}:${h + k}`);
      h += length + gap + Math.floor(rng() * gap * 3);
    }
  }
  return (daemon, height) => down.has(`${daemon}:${height}`);
}

const shuffled = (rng: () => number) => () => [0, 1, 2].sort(() => rng() - 0.5);
const worst = (heights: (number | null)[]) => Math.max(...heights.map((h) => (h === null ? Infinity : h - START.height)));

describe("no schedule of polls, restarts and short outages slashes anyone", () => {
  it("a healthy rotation: every daemon polls every block, nobody is slashed, and the epoch deals with all three", () => {
    const out = run({ blocks: 800, stopWhenDealing: true });
    assert.deepEqual(out.slashes, []);
    assert.ok(out.dealingAt !== null, "no dealing epoch in 800 blocks");
    assert.deepEqual(out.chain.begun.map((b) => [b.epochId, b.committee.length]), [[44, 3]]);
    console.log(`  healthy rotation: dealing ${out.dealingAt! - START.height} blocks after the start, epoch ${out.chain.epoch!.epochId}`);
  });

  it(`${SEEDS} seeds: daemons poll in random order, each with outages of up to 40 blocks at least 60 blocks apart`, () => {
    const dealing: (number | null)[] = [];
    const landed = { dkgComplaintMissing: 0, dkgShareReveal: 0 };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const out = run({ blocks: 6000, stopWhenDealing: true, down: outages(seed, 6000, 40, 60), order: shuffled(rngOf(seed * 7919)) });
      assert.deepEqual(out.slashes, [], `seed ${seed}`);
      dealing.push(out.dealingAt);
      for (const { tx } of out.chain.landed) if (tx.type in landed) landed[tx.type as keyof typeof landed]++;
    }
    console.log(`  seeds ${SEEDS}, slashes 0, slowest rotation ${worst(dealing)} blocks, complaints filed ${landed.dkgComplaintMissing}, answered ${landed.dkgShareReveal}`);
    assert.ok(worst(dealing) < 6000, "a schedule did not reach a dealing epoch");
    assert.equal(landed.dkgShareReveal, landed.dkgComplaintMissing, "a complaint was left unanswered");
  });

  it(`${SEEDS} seeds: one daemon restarts at a random block, losing its memory and keeping its disk`, () => {
    const dealing: (number | null)[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rng = rngOf(seed);
      const who = Math.floor(rng() * 3);
      const when = START.height + Math.floor(rng() * 500);
      const out = run({ blocks: 1500, stopWhenDealing: true, restarts: (n, h) => n === who && h === when, order: shuffled(rng) });
      assert.deepEqual(out.slashes, [], `seed ${seed}`);
      dealing.push(out.dealingAt);
    }
    console.log(`  seeds ${SEEDS}, slashes 0, slowest rotation ${worst(dealing)} blocks`);
    assert.ok(worst(dealing) < 1500);
  });

  it("every block of one rotation: one daemon stops for 40 blocks from that block, for each block and each daemon", () => {
    const length = run({ blocks: 800, stopWhenDealing: true }).dealingAt! - START.height;
    const dealing: (number | null)[] = [];
    for (let n = 0; n < 3; n++) {
      for (let b = 0; b <= length; b++) {
        const from = START.height + b;
        const out = run({ blocks: 3000, stopWhenDealing: true, down: (d, h) => d === n && h >= from && h < from + 40 });
        assert.deepEqual(out.slashes, [], `daemon ${n} down for 40 blocks from block ${b}`);
        dealing.push(out.dealingAt);
      }
    }
    console.log(`  runs ${dealing.length}, slashes 0, slowest rotation ${worst(dealing)} blocks`);
    assert.ok(worst(dealing) < 3000);
  });

  it("every block of one rotation: one daemon stops for 60 blocks. Nobody is slashed before patience ends, and a window is blocked only by the last validator in order, down between its beacon commit and its reveal", () => {
    const healthy = run({ blocks: 800, stopWhenDealing: true });
    const length = healthy.dealingAt! - START.height;
    const landedAt = (type: Tx["type"]) => healthy.chain.landed.find((l) => l.tx.type === type && "validator" in l.tx && l.tx.validator === VALIDATORS[2])!.height;
    // Its commit was sent one block before it landed, and so was its reveal.
    const exposed = { from: landedAt("beaconCommit"), to: landedAt("beaconReveal") - 1 };
    const blocked: string[] = [];
    let runs = 0;
    for (let n = 0; n < 3; n++) {
      for (let b = 0; b <= length; b++) {
        const from = START.height + b;
        const out = run({ blocks: 3000, stopWhenDealing: true, down: (d, h) => d === n && h >= from && h < from + 60 });
        runs++;
        assert.deepEqual(out.slashes, [], `daemon ${n} down for 60 blocks from block ${b}`);
        if (out.dealingAt === null) {
          blocked.push(`daemon ${n} from block ${b}`);
          assert.equal(n, 2, `a window was blocked by daemon ${n}, which is not the last in validator order`);
          assert.ok(out.blockedAt !== null);
          assert.ok(from >= exposed.from && from <= exposed.to, `blocked by an outage from block ${b}, outside its commit-to-reveal span`);
        }
      }
    }
    console.log(`  runs ${runs}, slashes 0, blocked until patience: ${blocked.length} (${blocked[0]} to ${blocked.at(-1)}); its commit landed at block ${exposed.from - START.height}, its reveal was sent at block ${exposed.to - START.height}`);
    assert.ok(blocked.length > 0, "the scan did not reach the one blocked case the design names");
  });

  it("when every permissionless message races, one BeginEpoch lands per epoch and nobody is slashed", () => {
    // Without turns all three would send BeginEpoch and FinalizeEpoch in the same block. With them, and with the chain's own checks, one lands.
    const out = run({ blocks: 800, stopWhenDealing: true, order: () => [2, 1, 0] });
    assert.deepEqual([out.slashes, out.chain.begun.length, out.chain.finalized.length], [[], 1, 1]);
  });
});

describe("one daemon missing", () => {
  const without2 = (d: number) => d === 2;

  it("down from the start: no DKG and no slash for 17,279 blocks", () => {
    const out = run({ blocks: 17_279, down: without2 });
    assert.deepEqual([out.slashes, out.chain.begun], [[], []]);
  });

  it("down for longer than patience: exactly one slash, of that validator, for its missing commit, announced first, and the other two deal", () => {
    const out = run({ blocks: 17_280 + 800, down: without2, stopWhenDealing: true });
    assert.deepEqual(out.slashes.map((s) => [s.validator, s.reason]), [["ocpvaloper1c", "dkg-missing-commit"]]);
    assert.deepEqual(out.unannounced, []);
    assert.deepEqual(out.chain.epoch!.slashed, ["ocpvaloper1c"]);
    console.log(`  slashes 1: ${out.slashes[0]!.validator} ${out.slashes[0]!.reason} at block ${out.slashes[0]!.height - START.height} after the start`);
  });

  it("with patience 0 the others never begin without it", () => {
    const out = run({ blocks: 40_000, down: without2, patienceBlocks: 0 });
    assert.deepEqual([out.slashes, out.chain.begun], [[], []]);
  });

  it("down for 5,000 blocks, then back: no slash, and dealing within 900 blocks of its return", () => {
    const back = START.height + 5000;
    const out = run({ blocks: 5900, down: (d, h) => d === 2 && h < back, stopWhenDealing: true });
    assert.deepEqual(out.slashes, []);
    assert.ok(out.dealingAt !== null && out.dealingAt - back <= 900, `dealing at ${out.dealingAt}`);
    console.log(`  dealing ${out.dealingAt! - back} blocks after the daemon came back`);
  });
});

describe("the slash path that is left", () => {
  it("the last validator in order dies between its beacon commit and its reveal: the window is blocked, nobody begins before patience, then the chain slashes it and the others deal", () => {
    // Its daemon stops for good at the block in which its commit landed.
    const healthy = run({ blocks: 200 });
    const committedAt = healthy.chain.landed.find((l) => l.tx.type === "beaconCommit" && l.tx.validator === VALIDATORS[2])!.height;

    const before = run({ blocks: 17_000, down: (d, h) => d === 2 && h >= committedAt });
    assert.deepEqual([before.slashes, before.chain.begun], [[], []]);

    const after = run({ blocks: 17_280 + 1200, down: (d, h) => d === 2 && h >= committedAt, stopWhenDealing: true });
    assert.deepEqual(after.slashes.map((s) => [s.validator, s.reason]), [["ocpvaloper1c", "beacon-missing-reveal"]]);
    assert.deepEqual(after.unannounced, []);
    assert.deepEqual(after.chain.begun.map((b) => b.committee), [["ocpvaloper1a", "ocpvaloper1b"]]);
    assert.ok(after.dealingAt !== null);
  });
});

describe("a DKG with a member that falls behind", () => {
  /** Stops daemon 2 from the block after its DKG commit landed, for `blocks` blocks. */
  function stopAfterCommit(blocks: number) {
    const healthy = run({ blocks: 800, stopWhenDealing: true });
    const committed = healthy.chain.landed.find((l) => l.tx.type === "dkgCommit" && l.tx.dealer === VALIDATORS[2])!.height;
    return { committed, out: run({ blocks: 1200, stopWhenDealing: true, down: (d, h) => d === 2 && h >= committed && h < committed + blocks }) };
  }

  it("commits, stops before sending its shares, and returns after the others complained: it answers both complaints and nobody is slashed", () => {
    const { out } = stopAfterCommit(170);
    const count = (type: Tx["type"]) => out.chain.landed.filter((l) => l.tx.type === type).length;
    assert.deepEqual([out.slashes, count("dkgComplaintMissing"), count("dkgShareReveal")], [[], 2, 2]);
    assert.deepEqual(out.chain.epoch!.slashed, []);
  });

  it("commits and stays down past the reveal deadline: the chain slashes it for the unanswered complaint, and the other two deal", () => {
    const { out } = stopAfterCommit(400);
    assert.deepEqual(out.slashes.map((s) => [s.validator, s.reason]), [["ocpvaloper1c", "dkg-complaint-unresolved"]]);
    assert.deepEqual(out.chain.epoch!.slashed, ["ocpvaloper1c"]);
  });

  it("is down for the whole commit window: the chain slashes it for its missing commit, with no complaint from anyone", () => {
    const healthy = run({ blocks: 800, stopWhenDealing: true });
    const begun = healthy.chain.begun[0]!.height;
    const out = run({ blocks: 1200, stopWhenDealing: true, down: (d, h) => d === 2 && h >= begun && h < begun + 121 });
    assert.deepEqual(out.slashes.map((s) => [s.validator, s.reason]), [["ocpvaloper1c", "dkg-missing-commit"]]);
    assert.equal(out.chain.landed.filter((l) => l.tx.type === "dkgComplaintMissing").length, 0);
  });

  it("is down for all but the last block of the commit window: it commits in time and nobody is slashed", () => {
    const healthy = run({ blocks: 800, stopWhenDealing: true });
    const begun = healthy.chain.begun[0]!.height;
    const out = run({ blocks: 1200, stopWhenDealing: true, down: (d, h) => d === 2 && h >= begun && h < begun + 119 });
    assert.deepEqual(out.slashes, []);
  });
});

describe("the daemon the repair replaces, in the same model", () => {
  it("commits for the current epoch plus one and begins only when no epoch exists: no DKG in 10,000 blocks", () => {
    const out = run({ blocks: 10_000, old: true });
    assert.deepEqual([out.chain.begun, out.chain.beacon!.committed], [[], []]);
  });
});

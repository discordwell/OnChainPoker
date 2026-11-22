// Tests of decide() and shufflersOf(). No chain, no disk, no clock: each builds a ChainView by hand
// and reads the Decision. Names state the rule. Expected values come from the chain's rules (the
// height at which x/dealer accepts each message) and from the live chain as measured on
// 2026-11-22, not from rotation.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BeaconWindow, DealerDkg, DealerEpoch, DealerState, ValidatorInfo } from "@onchainpoker/ocp-sdk/cosmos";
import {
  POLICY,
  afterUnjail,
  decide,
  shufflersOf,
  unjailBlock,
  unjailWaitMs,
  type Action,
  type ChainView,
  type Decision,
  type KeygenFacts,
  type Me,
  type Memory,
} from "../src/rotation.js";

// Three validators in the chain's order (ascending by operator address).
const A = "ocpvaloper1a";
const B = "ocpvaloper1b";
const C = "ocpvaloper1c";
const ALL = [A, B, C];

const bytes = (fill: number) => new Uint8Array(32).fill(fill);

function validators(overrides: Record<string, Partial<ValidatorInfo>> = {}): ValidatorInfo[] {
  return ALL.map((operator, i) => ({ operator, bonded: true, jailed: false, power: 1000 + i, consensusPubkey: bytes(i + 1), ...overrides[operator] }));
}

function me(validator: string, overrides: Partial<Me> = {}): Me {
  return { validator, committeeSize: 3, threshold: 2, mayBeginEpoch: true, mayFinalizeEpoch: true, patienceBlocks: 17_280, ...overrides };
}

const HOLDS_ALL: KeygenFacts = { disk: "ok", commitMatchesDisk: true, holds: new Set(ALL) };

function memory(overrides: Partial<Memory> = {}): Memory {
  return { waitedBlocks: 0, storeUsable: true, unjailBlockedBy: null, keygen: null, share: { is: "ready" }, ...overrides };
}

function epoch(epochId: number, slashed: string[] = []): DealerEpoch {
  return {
    epochId,
    threshold: 2,
    startHeight: 100,
    slashed,
    members: ALL.map((validator, i) => ({ validator, index: i + 1, pubShare: bytes(10 + i), ephemeralPubkey: bytes(20 + i), power: 1000 })),
  };
}

// The beacon windows the chain opens on a production chain id: 50 blocks to commit, 50 to reveal.
function beacon(open: number, parts: Partial<BeaconWindow> = {}): BeaconWindow {
  return { epochId: 8, commitOpenHeight: open, commitCloseHeight: open + 50, revealCloseHeight: open + 100, threshold: 2, committed: [], revealed: [], consumed: false, ...parts };
}

/** A dead epoch 7 with next id 8: the state a rotation starts from. */
function rotating(height: number, window: BeaconWindow | null, vals: ValidatorInfo[] = validators()): ChainView {
  return { dealer: { height, nextEpochId: 8, epoch: epoch(7, ALL), dkg: null, beacon: window }, validators: vals };
}

// A DKG as BeginEpoch writes it with the daemon's windows: 120 to commit, 60 for complaints, 60 for reveals.
const DKG_START = 1000;
const COMMIT_DL = 1120;
const COMPLAINT_DL = 1180;
const REVEAL_DL = 1240;

function dkg(parts: Partial<DealerDkg> & { committed?: string[] } = {}): DealerDkg {
  const committed = parts.committed ?? ALL;
  return {
    epochId: 8,
    threshold: 2,
    startHeight: DKG_START,
    commitDeadline: COMMIT_DL,
    complaintDeadline: COMPLAINT_DL,
    revealDeadline: REVEAL_DL,
    members: ALL.map((validator, i) => ({ validator, index: i + 1, pubShare: null, ephemeralPubkey: committed.includes(validator) ? bytes(20 + i) : null, power: 1000 })),
    commits: committed.map((dealer) => ({ dealer, commitments: [bytes(1), bytes(2)] })),
    encryptedShares: [],
    complaints: [],
    reveals: [],
    slashed: [],
    ...parts,
  };
}

function keygen(height: number, record: DealerDkg, vals: ValidatorInfo[] = validators()): ChainView {
  return { dealer: { height, nextEpochId: 9, epoch: epoch(7, ALL), dkg: record, beacon: null }, validators: vals };
}

/** Every encrypted share that `dealers` owe, already on chain. */
const sharesFrom = (dealers: string[]) =>
  dealers.flatMap((dealer) =>
    ALL.filter((to) => to !== dealer).map((to) => ({ dealer, recipientIndex: ALL.indexOf(to) + 1, u: bytes(1), v: bytes(2), proof: bytes(3), scalarCt: bytes(4) })),
  );

const act = (d: Decision): Action["do"] | null => d.action?.do ?? null;

// The live chain on 2026-11-22: epoch 42 with all three members slashed, an aborted DKG for 43
// behind it, next epoch id 44, and a beacon window for 44 that nobody had committed to.
const LIVE_WINDOW = beacon(1_536_468, { epochId: 44 });
const liveAt = (height: number, window: BeaconWindow = LIVE_WINDOW): ChainView => ({
  dealer: { height, nextEpochId: 44, epoch: { ...epoch(42, ALL), startHeight: 1_036_206 }, dkg: null, beacon: window },
  validators: validators(),
});

describe("the epoch the daemon works on is the chain's next epoch id", () => {
  it("on the live chain, in the commit tail, it commits to the beacon for epoch 44", () => {
    const d = decide(liveAt(1_536_510), me(C), memory());
    assert.deepEqual(d.action, { do: "beaconCommit", epochId: 44, commitOpenHeight: 1_536_468 });
  });

  it("on the live chain it never acts on or names epoch 43, at any height of the window, for any daemon", () => {
    for (const who of ALL) {
      for (let h = 1_536_468; h <= 1_536_575; h++) {
        const d = decide(liveAt(h), me(who), memory());
        assert.doesNotMatch(`${JSON.stringify(d.action)} ${d.why}`, /\b43\b/, `height ${h}, ${who}`);
      }
    }
  });

  it("BeginEpoch carries the next epoch id (44), not the current epoch plus one (43) and not 0", () => {
    const ready = { ...LIVE_WINDOW, committed: ALL, revealed: ALL };
    const d = decide(liveAt(1_536_568, ready), me(A), memory());
    assert.deepEqual(d.action, { do: "beginEpoch", epochId: 44, committeeSize: 3, threshold: 2 });
  });
});

describe("an epoch that cannot deal is replaced, one that can is left alone", () => {
  it("an epoch with fewer unslashed members than its threshold is rotating", () => {
    const view: ChainView = { dealer: { height: 500, nextEpochId: 8, epoch: epoch(7, [A, B]), dkg: null, beacon: null }, validators: validators() };
    const s = decide(view, me(A), memory()).situation;
    assert.deepEqual([s.kind, s.kind === "rotating" && s.reason], ["rotating", "below-threshold"]);
  });

  it("no epoch and no DKG is rotating", () => {
    const view: ChainView = { dealer: { height: 500, nextEpochId: 1, epoch: null, dkg: null, beacon: null }, validators: validators() };
    const s = decide(view, me(A), memory()).situation;
    assert.deepEqual([s.kind, s.kind === "rotating" && s.reason], ["rotating", "no-epoch"]);
  });

  it("an epoch with exactly its threshold of unslashed members is dealing and gets no action, whatever the beacon holds", () => {
    const usable = beacon(300, { committed: ALL, revealed: ALL });
    const view: ChainView = { dealer: { height: 500, nextEpochId: 8, epoch: epoch(7, [A]), dkg: null, beacon: usable }, validators: validators() };
    for (const who of ALL) {
      const d = decide(view, me(who), memory());
      assert.deepEqual([d.situation.kind, d.action], ["dealing", null]);
    }
  });

  it("a DKG in flight is keygen, whatever the epoch holds", () => {
    const view: ChainView = { dealer: { height: 1010, nextEpochId: 9, epoch: epoch(7, []), dkg: dkg(), beacon: null }, validators: validators() };
    assert.equal(decide(view, me(A), memory({ keygen: HOLDS_ALL })).situation.kind, "keygen");
  });

  it("a DKG is in its commit phase through commitDeadline - 1, in shares through revealDeadline - 1, then finalizable", () => {
    const phaseAt = (h: number) => {
      const s = decide(keygen(h, dkg()), me(A), memory({ keygen: HOLDS_ALL })).situation;
      return s.kind === "keygen" ? s.phase : s.kind;
    };
    assert.deepEqual(
      [COMMIT_DL - 1, COMMIT_DL, REVEAL_DL - 1, REVEAL_DL].map(phaseAt),
      ["commit", "shares", "shares", "finalizable"],
    );
  });
});

describe("roll call: a DKG starts only when every bonded validator's daemon was just seen", () => {
  // Window 900..950..1000. The chain takes a commit at heights 900..950 and a reveal at 951..1000.
  const open = beacon(900);

  it("does not commit before the last 12 blocks of the commit window", () => {
    assert.equal(act(decide(rotating(937, open), me(A), memory())), null);
    assert.equal(act(decide(rotating(938, open), me(A), memory())), "beaconCommit");
  });

  it("commits when the commit would land at commitClose, and not when it would land after", () => {
    assert.equal(act(decide(rotating(949, open), me(A), memory())), "beaconCommit");
    assert.equal(act(decide(rotating(950, open), me(A), memory())), null);
  });

  it("does not commit when my validator is not bonded, or has no power", () => {
    for (const mine of [{ bonded: false }, { bonded: false, jailed: true }, { power: 0 }]) {
      const view = rotating(945, open, validators({ [A]: mine }));
      assert.notEqual(act(decide(view, me(A), memory({ unjailBlockedBy: "test" }))), "beaconCommit", JSON.stringify(mine));
    }
  });

  it("does not commit when the secrets directory failed its probe, and raises it", () => {
    const d = decide(rotating(945, open), me(A), memory({ storeUsable: false }));
    assert.deepEqual([d.action, d.alarm], [null, true]);
  });

  it("does not commit twice", () => {
    assert.equal(act(decide(rotating(945, { ...open, committed: [A] }), me(A), memory())), null);
  });

  it("the first committer in validator order reveals once every bonded validator committed", () => {
    const d = decide(rotating(950, { ...open, committed: ALL }), me(A), memory());
    assert.deepEqual(d.action, { do: "beaconReveal", epochId: 8, commitOpenHeight: 900 });
  });

  it("a later committer does not reveal until every committer before it has revealed", () => {
    const full = { ...open, committed: ALL };
    assert.equal(act(decide(rotating(955, full), me(B), memory())), null);
    assert.equal(act(decide(rotating(955, full), me(C), memory())), null);
    assert.equal(act(decide(rotating(955, { ...full, revealed: [A] }), me(B), memory())), "beaconReveal");
    assert.equal(act(decide(rotating(955, { ...full, revealed: [A] }), me(C), memory())), null);
  });

  it("does not reveal when one bonded validator did not commit, and says which", () => {
    const d = decide(rotating(955, { ...open, committed: [A, B] }), me(A), memory());
    assert.equal(d.action, null);
    assert.match(d.why, /no commit from ocpvaloper1c/);
  });

  it("reveals at once when the window already has its threshold of reveals, whatever the order or the roll call", () => {
    // B did not commit and A did not reveal, yet the window is binding: C must not be left without a reveal.
    const window = { ...open, committed: [A, C, "ocpvaloper1x", "ocpvaloper1y"], revealed: ["ocpvaloper1x", "ocpvaloper1y"] };
    assert.equal(act(decide(rotating(999, window), me(C), memory())), "beaconReveal");
  });

  it("does not wait for a jailed validator", () => {
    const view = rotating(950, { ...open, committed: [A, B] }, validators({ [C]: { bonded: false, jailed: true } }));
    assert.equal(act(decide(view, me(A), memory())), "beaconReveal");
  });

  it("three daemons given the same view at reveal time reach the same verdict", () => {
    const incomplete = rotating(960, { ...open, committed: [A, C] });
    assert.deepEqual(ALL.map((who) => act(decide(incomplete, me(who), memory()))), [null, null, null]);
    const complete = rotating(960, { ...open, committed: ALL });
    assert.deepEqual(ALL.map((who) => act(decide(complete, me(who), memory()))), ["beaconReveal", null, null]);
  });

  it("reveals when the reveal would land at revealClose, and not when it would land after", () => {
    const window = { ...open, committed: ALL, revealed: [A, B] };
    assert.equal(act(decide(rotating(999, window), me(C), memory())), "beaconReveal");
    assert.notEqual(act(decide(rotating(1000, window), me(C), memory())), "beaconReveal");
  });

  it("sends the reveal that reaches the threshold only in the first 8 blocks of the reveal window", () => {
    // B's reveal is the second of a threshold of two. After it C must reveal or be slashed, and
    // C was last seen at its commit, so B does not make the window binding long after the commits.
    const window = { ...open, committed: ALL, revealed: [A] };
    assert.equal(act(decide(rotating(958, window), me(B), memory())), "beaconReveal");
    assert.equal(act(decide(rotating(959, window), me(B), memory())), null);
  });

  it("never sends the reveal that reaches the threshold with fewer than 10 blocks of the window left", () => {
    const window = { ...open, committed: ALL, revealed: [A] };
    const sentAt = [];
    for (let h = 950; h < 1000; h++) if (act(decide(rotating(h, window), me(B), memory())) === "beaconReveal") sentAt.push(h);
    assert.ok(sentAt.length > 0 && sentAt.every((h) => 1000 - h >= 10), `sent at ${sentAt}`);
  });

  it("on a window shorter than the production one, it reaches the threshold only in the first half", () => {
    // The chain's devnet window: 5 blocks to reveal, 951..955.
    const devnet = { ...open, revealCloseHeight: 955, committed: ALL, revealed: [A] };
    assert.equal(act(decide(rotating(953, devnet), me(B), memory())), "beaconReveal");
    assert.equal(act(decide(rotating(954, devnet), me(B), memory())), null);
  });

  it("sends a reveal that does not reach the threshold however late it is", () => {
    assert.equal(act(decide(rotating(999, { ...open, committed: ALL }), me(A), memory())), "beaconReveal");
  });

  it("does not send a reveal the chain would refuse because my validator lost its bond after committing", () => {
    const view = rotating(960, { ...open, committed: ALL }, validators({ [A]: { bonded: false } }));
    const d = decide(view, me(A), memory());
    assert.deepEqual([d.action, d.alarm], [null, true]);
  });

  it("commit and reveal name the window they belong to, so each window gets its own salt", () => {
    const first = decide(rotating(945, beacon(900)), me(A), memory()).action;
    const next = decide(rotating(1046, beacon(1001)), me(A), memory()).action;
    assert.deepEqual([first, next], [
      { do: "beaconCommit", epochId: 8, commitOpenHeight: 900 },
      { do: "beaconCommit", epochId: 8, commitOpenHeight: 1001 },
    ]);
  });

  it("waits while the chain has no window for the next epoch id: none, a consumed one, or one for another epoch", () => {
    for (const window of [null, beacon(900, { consumed: true, committed: ALL, revealed: ALL }), beacon(900, { epochId: 7, committed: ALL, revealed: ALL })]) {
      const d = decide(rotating(1005, window), me(A), memory());
      assert.equal(d.action, null);
      assert.equal(d.situation.kind === "rotating" && d.situation.rollCall.at, "no-window");
    }
  });
});

describe("BeginEpoch is sent only when it slashes nobody", () => {
  // Window 900..950..1000. BeginEpoch is accepted from height 1001.
  const usable = beacon(900, { committed: ALL, revealed: ALL });

  it("not while a BeginEpoch would land inside the reveal window", () => {
    assert.equal(act(decide(rotating(999, usable), me(A), memory())), null);
    assert.equal(act(decide(rotating(1000, usable), me(A), memory())), "beginEpoch");
  });

  it("not with fewer reveals than the beacon's threshold", () => {
    const d = decide(rotating(1000, { ...usable, revealed: [A] }), me(A), memory());
    assert.equal(d.action, null);
    assert.equal(d.situation.kind === "rotating" && d.situation.rollCall.at, "closed-short");
  });

  it("not while a committer has not revealed: BeginEpoch would slash it", () => {
    for (const who of [A, B]) {
      const d = decide(rotating(1010, { ...usable, revealed: [A, B] }), me(who), memory());
      assert.equal(d.action, null);
      assert.match(d.why, /ocpvaloper1c committed and did not reveal/);
    }
  });

  it("not while another bonded validator took no part: the DKG would slash it", () => {
    for (const who of [A, B]) {
      const d = decide(rotating(1010, { ...usable, committed: [A, B], revealed: [A, B] }), me(who), memory());
      assert.equal(d.action, null);
      assert.match(d.why, /ocpvaloper1c took no part/);
    }
  });

  it("the validator that took no part itself may begin: its own poll shows it is alive", () => {
    // C was unjailed after the others had revealed. For A and B the window is blocked on C.
    const window = { ...usable, committed: [A, B], revealed: [A, B] };
    assert.equal(act(decide(rotating(1003, window), me(C), memory())), null); // after both revealers' turns
    assert.deepEqual(decide(rotating(1004, window), me(C), memory()).action, { do: "beginEpoch", epochId: 8, committeeSize: 3, threshold: 2 });
  });

  it("not with fewer bonded validators than the threshold", () => {
    const view = rotating(1000, usable, validators({ [B]: { bonded: false, jailed: true }, [C]: { bonded: false, jailed: true } }));
    const d = decide(view, me(A), memory());
    assert.equal(d.action, null);
    assert.match(d.why, /1 bonded validator, need 2/);
  });

  it("not when DEALER_AUTO_BEGIN_EPOCH is off, and says so", () => {
    const d = decide(rotating(1000, usable), me(A, { mayBeginEpoch: false }), memory());
    assert.equal(d.action, null);
    assert.match(d.why, /BeginEpoch is disabled on this daemon/);
  });

  it("not from a validator that is not bonded", () => {
    const view = rotating(1000, { ...usable, committed: [B, C], revealed: [B, C] }, validators({ [A]: { bonded: false } }));
    assert.equal(act(decide(view, me(A), memory())), null);
  });

  it("asks for a committee of the configured size, or of every bonded validator with power when there are fewer", () => {
    const sizeFor = (view: ChainView, who: Me) => {
      const a = decide(view, who, memory()).action;
      return a?.do === "beginEpoch" ? a.committeeSize : a;
    };
    assert.equal(sizeFor(rotating(1010, usable), me(A)), 3);
    assert.equal(sizeFor(rotating(1010, usable), me(A, { committeeSize: 2 })), 2);
    const twoBonded = rotating(1010, { ...usable, committed: [A, B], revealed: [A, B] }, validators({ [C]: { bonded: false, jailed: true } }));
    assert.equal(sizeFor(twoBonded, me(A)), 2);
    const noPower = rotating(1010, { ...usable, committed: [A, B], revealed: [A, B] }, validators({ [C]: { power: 0 } }));
    assert.equal(sizeFor(noPower, me(A)), 2);
  });

  it("the first revealer in validator order sends at revealClose, the next two blocks later, the third four blocks later", () => {
    const firstHeight = (who: string) => {
      for (let h = 995; h < 1010; h++) if (act(decide(rotating(h, usable), me(who), memory())) === "beginEpoch") return h;
      return null;
    };
    assert.deepEqual(ALL.map(firstHeight), [1000, 1002, 1004]);
  });

  it("when the first in turn stays silent the others still send, each at its own turn", () => {
    // The chain still shows no DKG at 1002 and 1004: nobody waits for A.
    assert.equal(act(decide(rotating(1002, usable), me(B), memory())), "beginEpoch");
    assert.equal(act(decide(rotating(1004, usable), me(C), memory())), "beginEpoch");
  });
});

describe("patience is the only way to an action that gets a validator slashed", () => {
  const patient = memory({ waitedBlocks: 17_280 });
  const almost = memory({ waitedBlocks: 17_279 });
  const incomplete = rotating(960, beacon(900, { committed: [A, B] }));
  const unrevealed = rotating(1010, beacon(900, { committed: ALL, revealed: [A, B] }));
  const absent = rotating(1010, beacon(900, { committed: [A, B], revealed: [A, B] }));

  it("one block short of 17,280 waited blocks: no reveal without a full roll call, no BeginEpoch on a blocked window", () => {
    for (const view of [incomplete, unrevealed, absent]) {
      assert.deepEqual(ALL.map((who) => act(decide(view, me(who), almost))).filter((a) => a !== null), view === absent ? ["beginEpoch"] : []);
    }
    // In `absent`, the one that may begin is C itself, and that costs nobody.
    assert.deepEqual(decide(absent, me(C), almost).costs, []);
  });

  it("at 17,280: reveals without the absent validator when commits reach the threshold, and names who it costs", () => {
    const d = decide(incomplete, me(A), patient);
    assert.equal(act(d), "beaconReveal");
    assert.deepEqual(d.costs, [C]);
    assert.match(d.why, /will slash it/);
  });

  it("at 17,280: still does not reveal when commits are below the beacon's threshold", () => {
    assert.equal(act(decide(rotating(960, beacon(900, { committed: [A] })), me(A), patient)), null);
  });

  it("at 17,280: begins over a committer that did not reveal, with the committee that remains once the chain jails it", () => {
    const d = decide(unrevealed, me(A), patient);
    assert.deepEqual(d.action, { do: "beginEpoch", epochId: 8, committeeSize: 2, threshold: 2 });
    assert.deepEqual(d.costs, [C]);
  });

  it("at 17,280: begins over a bonded validator that took no part, which the committee still includes", () => {
    const d = decide(absent, me(A), patient);
    assert.deepEqual(d.action, { do: "beginEpoch", epochId: 8, committeeSize: 3, threshold: 2 });
    assert.deepEqual(d.costs, [C]);
  });

  it("at 17,280: does not begin when the committee that would remain is below the threshold", () => {
    const view = rotating(1010, beacon(900, { committed: [A, B, C, "ocpvaloper1x", "ocpvaloper1y"], revealed: ["ocpvaloper1x", "ocpvaloper1y"] }));
    // x and y revealed and are no longer bonded. Jailing A, B and C leaves nobody.
    for (const who of ALL) assert.equal(act(decide(view, me(who), patient)), null);
  });

  it("never sends the BeginEpoch that would slash its own validator, however long it has waited", () => {
    assert.equal(act(decide(unrevealed, me(C), memory({ waitedBlocks: 1_000_000 }))), null);
  });

  it("with DEALER_PATIENCE_BLOCKS at 0 it never takes a slashing step: it waits for a person", () => {
    const forever = memory({ waitedBlocks: 10_000_000 });
    for (const view of [incomplete, unrevealed]) {
      for (const who of ALL) assert.equal(act(decide(view, me(who, { patienceBlocks: 0 }), forever)), null);
    }
  });

  it("before patience ends, no decision at any height of a rotation costs anybody", () => {
    const windows = [
      beacon(900),
      beacon(900, { committed: [A] }),
      beacon(900, { committed: [A, B] }),
      beacon(900, { committed: ALL }),
      beacon(900, { committed: ALL, revealed: [A] }),
      beacon(900, { committed: ALL, revealed: [A, B] }),
      beacon(900, { committed: [A, B], revealed: [A, B] }),
      beacon(900, { committed: ALL, revealed: ALL }),
    ];
    for (const window of windows) {
      for (let h = 900; h <= 1012; h++) {
        for (const who of ALL) {
          const d = decide(rotating(h, window), me(who), almost);
          assert.deepEqual(d.costs, [], `height ${h}, ${who}, ${JSON.stringify(window)}`);
        }
      }
    }
  });
});

describe("DKG steps are read off the chain", () => {
  const facts = (holds: string[], commitMatchesDisk: boolean | null = true): Memory => memory({ keygen: { disk: "ok", commitMatchesDisk, holds: new Set(holds) } });

  it("commits when my commit is not on chain and a commit sent now lands by commitDeadline", () => {
    const d = decide(keygen(COMMIT_DL - 1, dkg({ committed: [B, C] })), me(A), facts([], null));
    assert.equal(act(d), "dkgCommit");
  });

  it("does not commit when the commit would land after commitDeadline, and says finalize will slash this validator", () => {
    const d = decide(keygen(COMMIT_DL, dkg({ committed: [B, C] })), me(A), facts([], null));
    assert.equal(d.action, null);
    assert.match(d.why, /Finalize will slash this validator/);
    assert.equal(d.alarm, true);
  });

  it("does not commit again when my commit is on chain, whatever the disk says", () => {
    for (const matches of [true, false]) {
      const d = decide(keygen(1010, dkg({ encryptedShares: sharesFrom([A]) })), me(A), facts([], matches));
      assert.notEqual(act(d), "dkgCommit");
    }
  });

  it("does not commit when the secrets directory failed its probe", () => {
    const d = decide(keygen(1010, dkg({ committed: [B, C] })), me(A), memory({ storeUsable: false, keygen: { disk: "ok", commitMatchesDisk: null, holds: new Set() } }));
    assert.deepEqual([d.action, d.alarm], [null, true]);
  });

  it("does nothing for an epoch whose secrets file cannot be read: no commit, no share, no complaint", () => {
    const unreadable = memory({ keygen: { disk: "unreadable", reason: "bad tag" } });
    const uncommitted = decide(keygen(1010, dkg({ committed: [B, C] })), me(A), unreadable);
    const committed = decide(keygen(COMMIT_DL + 40, dkg()), me(A), unreadable);
    assert.deepEqual([uncommitted.action, uncommitted.alarm, committed.action, committed.alarm], [null, true, null, true]);
  });

  it("sends nothing but raises it when my commit is on chain and the disk does not match it", () => {
    const d = decide(keygen(1010, dkg()), me(A), facts([], false));
    assert.deepEqual([d.action, d.alarm], [null, true]);
  });

  const recipientAt = (h: number, record: DealerDkg) => {
    const a = decide(keygen(h, record), me(B), facts([])).action;
    return a?.do === "dkgEncryptedShare" ? a.recipientIndex : a;
  };

  it("sends an encrypted share to each member that has an ephemeral key and none from me, one per poll", () => {
    const first = recipientAt(1010, dkg());
    assert.ok(first === 1 || first === 3, `sent ${JSON.stringify(first)}`);
    const other = first === 1 ? 3 : 1;
    const oneSent = dkg({ encryptedShares: [{ dealer: B, recipientIndex: first as number, u: bytes(1), v: bytes(2), proof: bytes(3), scalarCt: bytes(4) }] });
    assert.deepEqual([1011, 1012].map((h) => recipientAt(h, oneSent)), [other, other]);

    const allSent = decide(keygen(1013, dkg({ encryptedShares: sharesFrom([B]) })), me(B), facts(ALL));
    assert.equal(allSent.action, null);
  });

  it("a share the chain keeps refusing does not hold back the other recipient's: the next block tries the other", () => {
    // Nothing lands between these two polls.
    assert.deepEqual(new Set([recipientAt(1010, dkg()), recipientAt(1011, dkg())]), new Set([1, 3]));
  });

  it("a share the chain keeps refusing does not hold back a complaint that is due", () => {
    // B still owes A its share, and lacks C's. In the complaint window both get their turn.
    const record = dkg({ encryptedShares: sharesFrom([A, B]).filter((e) => !(e.dealer === B && e.recipientIndex === 1)) });
    const turns = [1160, 1161].map((h) => act(decide(keygen(h, record), me(B), facts([A]))));
    assert.deepEqual(new Set(turns), new Set(["dkgEncryptedShare", "dkgComplainMissing"]));
  });

  it("sends no share to a member that has published no ephemeral key", () => {
    const d = decide(keygen(1010, dkg({ committed: [A, B] })), me(A), facts([]));
    assert.equal(d.action?.do === "dkgEncryptedShare" && d.action.recipientIndex, 2);
    const after = decide(keygen(1011, dkg({ committed: [A, B], encryptedShares: [{ dealer: A, recipientIndex: 2, u: bytes(1), v: bytes(2), proof: bytes(3), scalarCt: bytes(4) }] })), me(A), facts([B]));
    assert.equal(after.action, null);
  });

  it("answers a complaint against me before anything else, whatever its kind, and only once", () => {
    for (const kind of ["missing", "invalid", "aead-spurious"]) {
      const complained = dkg({ complaints: [{ complainer: C, dealer: A, kind }] });
      const d = decide(keygen(COMMIT_DL + 5, complained), me(A), facts([]));
      assert.deepEqual(d.action && { do: d.action.do, to: d.action.do === "dkgRevealShare" && d.action.to }, { do: "dkgRevealShare", to: C }, kind);
    }
    const answered = dkg({ complaints: [{ complainer: C, dealer: A, kind: "missing" }], reveals: [{ dealer: A, to: C, share: bytes(9) }], encryptedShares: sharesFrom([A]) });
    assert.equal(decide(keygen(COMMIT_DL + 5, answered), me(A), facts(ALL)).action, null);
  });

  it("files no complaint when I hold every committed dealer's share", () => {
    for (let h = COMMIT_DL; h < REVEAL_DL; h++) {
      const d = decide(keygen(h, dkg({ encryptedShares: sharesFrom(ALL) })), me(A), facts([B, C]));
      assert.equal(d.action, null, `height ${h}`);
    }
  });

  it("files a 'missing' complaint only in the second half of the complaint window, and only while it can land", () => {
    // Complaints are accepted at heights 1120..1180. The first 30 blocks are left for late shares.
    const lacking = (h: number) => act(decide(keygen(h, dkg({ encryptedShares: sharesFrom([A, B]) })), me(A), facts([B])));
    assert.deepEqual([1149, 1150, 1179, 1180].map(lacking), [null, "dkgComplainMissing", "dkgComplainMissing", null]);
  });

  it("complains against the dealer whose share I lack, and nobody else", () => {
    const view = keygen(1160, dkg({ committed: [A, B], encryptedShares: sharesFrom([A]) }));
    const d = decide(view, me(A), facts([]));
    // B committed and its share is missing. C never committed: finalize slashes it without my help.
    assert.deepEqual(d.action && { do: d.action.do, dealer: d.action.do === "dkgComplainMissing" && d.action.dealer }, { do: "dkgComplainMissing", dealer: B });

    const alreadyFiled = keygen(1161, dkg({ committed: [A, B], encryptedShares: sharesFrom([A]), complaints: [{ complainer: A, dealer: B, kind: "missing" }] }));
    assert.equal(decide(alreadyFiled, me(A), facts([])).action, null);

    const dealerSlashed = keygen(1160, dkg({ encryptedShares: sharesFrom([A]), slashed: [B] }));
    assert.equal(decide(dealerSlashed, me(A), facts([C])).action, null);
  });

  it("files no complaint when it knows nothing about what it holds", () => {
    for (let h = COMMIT_DL; h < REVEAL_DL; h++) {
      const d = decide(keygen(h, dkg({ encryptedShares: sharesFrom([A]) })), me(A), memory({ keygen: null }));
      assert.notEqual(act(d), "dkgComplainMissing", `height ${h}`);
    }
  });

  it("sends no share or reveal that would land after revealDeadline", () => {
    const owing = dkg({ complaints: [{ complainer: C, dealer: A, kind: "missing" }] });
    assert.equal(act(decide(keygen(REVEAL_DL - 1, owing), me(A), facts(ALL))), "dkgRevealShare");
    assert.notEqual(act(decide(keygen(REVEAL_DL, owing), me(B), facts(ALL))), "dkgEncryptedShare");
    assert.notEqual(act(decide(keygen(REVEAL_DL, owing), me(A), facts(ALL))), "dkgRevealShare");
  });

  it("finalizes from revealDeadline in turn order, two blocks apart, and a validator outside the committee goes last", () => {
    const done = dkg({ encryptedShares: sharesFrom(ALL) });
    const firstHeight = (who: string, record: DealerDkg) => {
      for (let h = REVEAL_DL - 3; h < REVEAL_DL + 12; h++) if (act(decide(keygen(h, record), me(who), facts(ALL))) === "finalizeEpoch") return h;
      return null;
    };
    assert.deepEqual(ALL.map((who) => firstHeight(who, done)), [1240, 1242, 1244]);
    const withoutC = { ...done, members: done.members.filter((m) => m.validator !== C), commits: done.commits.filter((c) => c.dealer !== C) };
    assert.equal(firstHeight(C, withoutC), 1244);
  });

  it("does not wait for a member that never committed", () => {
    const d = decide(keygen(REVEAL_DL, dkg({ committed: [A, B], encryptedShares: sharesFrom([A, B]) })), me(A), facts([B]));
    assert.deepEqual(d.action, { do: "finalizeEpoch", epochId: 8 });
  });

  it("does not finalize when DEALER_AUTO_FINALIZE is off", () => {
    const d = decide(keygen(REVEAL_DL + 10, dkg({ encryptedShares: sharesFrom(ALL) })), me(A, { mayFinalizeEpoch: false }), facts(ALL));
    assert.equal(d.action, null);
  });

  it("owes the DKG nothing more once it was slashed in it", () => {
    const slashed = dkg({ slashed: [A], complaints: [{ complainer: C, dealer: A, kind: "invalid" }] });
    assert.equal(decide(keygen(COMMIT_DL + 5, slashed), me(A), facts([])).action, null);
  });
});

describe("the actions the daemon can take", () => {
  it("are nine, and none of them is a DKG timeout or an AEAD complaint", () => {
    const seen = new Set<string>();
    const note = (d: Decision) => d.action && seen.add(d.action.do);
    const patient = memory({ waitedBlocks: 17_280, keygen: HOLDS_ALL });
    for (const who of ALL) {
      for (let h = 900; h <= 1012; h++) {
        for (const window of [beacon(900), beacon(900, { committed: ALL }), beacon(900, { committed: ALL, revealed: [A] }), beacon(900, { committed: ALL, revealed: ALL }), beacon(900, { committed: [A, B] })]) {
          note(decide(rotating(h, window), me(who), patient));
        }
      }
      for (let h = DKG_START; h <= REVEAL_DL + 6; h++) {
        note(decide(keygen(h, dkg({ committed: [B, C] })), me(who), memory({ keygen: { disk: "ok", commitMatchesDisk: who === A ? null : true, holds: new Set() } })));
        note(decide(keygen(h, dkg({ complaints: [{ complainer: C, dealer: A, kind: "missing" }] })), me(who), memory({ keygen: { disk: "ok", commitMatchesDisk: true, holds: new Set([A]) } })));
        note(decide(keygen(h, dkg({ encryptedShares: sharesFrom([who]) })), me(who), memory({ keygen: { disk: "ok", commitMatchesDisk: true, holds: new Set() } })));
      }
      note(decide(rotating(945, beacon(900), validators({ [who]: { bonded: false, jailed: true } })), me(who), memory()));
    }
    assert.deepEqual([...seen].sort(), [
      "beaconCommit", "beaconReveal", "beginEpoch", "dkgCommit", "dkgComplainMissing", "dkgEncryptedShare", "dkgRevealShare", "finalizeEpoch", "unjail",
    ]);
  });
});

describe("shufflers are chosen as the chain chooses them", () => {
  it("with the first member slashed, step 0 belongs to the second member", () => {
    assert.equal(shufflersOf(epoch(7, [A]))[0]!.validator, B);
  });

  it("keeps the stored member order", () => {
    const stored: DealerEpoch = { ...epoch(7, [B]), members: [C, A, B].map((validator, i) => ({ validator, index: i + 1, pubShare: null, ephemeralPubkey: null, power: 1 })) };
    assert.deepEqual(shufflersOf(stored).map((m) => m.validator), [C, A]);
  });
});

describe("unjail", () => {
  const jailed = validators({ [A]: { bonded: false, jailed: true } });

  it("a jailed validator whose guards all pass is unjailed before any roll-call or DKG step", () => {
    assert.deepEqual(decide(rotating(945, beacon(900), jailed), me(A), memory()).action, { do: "unjail" });
    assert.deepEqual(decide(keygen(1010, dkg({ committed: [B, C] }), jailed), me(A), memory({ keygen: HOLDS_ALL })).action, { do: "unjail" });
  });

  it("not when the secrets directory failed its probe", () => {
    assert.notEqual(act(decide(rotating(945, beacon(900), jailed), me(A), memory({ storeUsable: false }))), "unjail");
  });

  it("not when a guard holds it back, and the sentence says which", () => {
    const d = decide(rotating(945, beacon(900), jailed), me(A), memory({ unjailBlockedBy: "this node is still catching up" }));
    assert.notEqual(act(d), "unjail");
    assert.match(d.why, /this node is still catching up/);
  });

  it("still does its DKG duty while a guard holds the unjail back", () => {
    const d = decide(keygen(1010, dkg({ committed: [B, C] }), jailed), me(A), memory({ unjailBlockedBy: "waiting 1 h since the last unjail", keygen: { disk: "ok", commitMatchesDisk: null, holds: new Set() } }));
    assert.equal(act(d), "dkgCommit");
  });

  it("is never sent for a validator that is not jailed", () => {
    assert.notEqual(act(decide(rotating(945, beacon(900)), me(A), memory())), "unjail");
  });

  it("each unjail that landed doubles the wait before the next, from an hour up to a day", () => {
    const hour = 3_600_000;
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 40].map(unjailWaitMs), [0, hour, 2 * hour, 4 * hour, 8 * hour, 16 * hour, 24 * hour, 24 * hour]);
  });
});

describe("the guards on unjailing my own validator", () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const NOW = 1_800_000_000_000;
  const KEY = bytes(7);
  const node = { latestHeight: 5000, latestBlockTimeMs: NOW - 5_000, catchingUp: false, consensusPubkey: KEY };
  const never = { landed: 0, lastLandedAtMs: 0, lastTriedAtMs: 0 };
  const block = (parts: Partial<Parameters<typeof unjailBlock>[0]> = {}) => unjailBlock({ nowMs: NOW, record: never, node, consensusPubkey: KEY, ...parts });

  it("pass for a node that is caught up, holds a fresh block and signs with my validator's key", () => {
    assert.equal(block(), null);
  });

  it("hold while my node is catching up", () => {
    assert.match(block({ node: { ...node, catchingUp: true } })!, /catching up/);
  });

  it("hold when my node's latest block is more than 30 s old", () => {
    assert.equal(block({ node: { ...node, latestBlockTimeMs: NOW - 30_000 } }), null);
    assert.match(block({ node: { ...node, latestBlockTimeMs: NOW - 30_001 } })!, /no block from the last 30 s/);
  });

  it("hold when my node signs with another key, or with none", () => {
    for (const consensusPubkey of [bytes(8), null]) {
      assert.match(block({ node: { ...node, consensusPubkey } })!, /does not sign with this validator's consensus key/);
    }
    assert.match(block({ consensusPubkey: null })!, /does not sign with this validator's consensus key/);
  });

  it("ask the chain at most once a minute", () => {
    assert.match(block({ record: { ...never, lastTriedAtMs: NOW - MINUTE + 1 } })!, /less than a minute ago/);
    assert.equal(block({ record: { ...never, lastTriedAtMs: NOW - MINUTE } }), null);
  });

  it("wait an hour after the first unjail that landed, two after the second, and a day at most", () => {
    const landedAgo = (landed: number, ago: number) => block({ record: { landed, lastLandedAtMs: NOW - ago, lastTriedAtMs: NOW - ago } });
    assert.notEqual(landedAgo(1, HOUR - 1), null);
    assert.equal(landedAgo(1, HOUR), null);
    assert.notEqual(landedAgo(2, 2 * HOUR - 1), null);
    assert.equal(landedAgo(2, 2 * HOUR), null);
    assert.notEqual(landedAgo(30, DAY - 1), null);
    assert.equal(landedAgo(30, DAY), null);
  });

  it("count unjails from one again after seven days without one", () => {
    const old = { landed: 6, lastLandedAtMs: NOW - 7 * DAY - 1, lastTriedAtMs: NOW - 7 * DAY - 1 };
    assert.deepEqual(afterUnjail(old, NOW), { landed: 1, lastLandedAtMs: NOW, lastTriedAtMs: NOW });
    const recent = { landed: 6, lastLandedAtMs: NOW - 7 * DAY, lastTriedAtMs: NOW - 7 * DAY };
    assert.deepEqual(afterUnjail(recent, NOW), { landed: 7, lastLandedAtMs: NOW, lastTriedAtMs: NOW });
  });
});

describe("decide is total and gives the same answer twice", () => {
  it("returns a decision for every combination of a small grid of states, and never throws", () => {
    const memories = [
      memory(),
      memory({ storeUsable: false }),
      memory({ waitedBlocks: 20_000 }),
      memory({ keygen: HOLDS_ALL }),
      memory({ keygen: { disk: "unreadable", reason: "x" } }),
      memory({ share: { is: "missing", from: [B] } }),
      memory({ share: { is: "mismatch" } }),
      memory({ share: { is: "unreadable", reason: "x" } }),
      memory({ share: { is: "slashed" } }),
      memory({ share: { is: "not-member" } }),
      memory({ unjailBlockedBy: "x" }),
    ];
    const dealers: DealerState[] = [
      { height: 5, nextEpochId: 1, epoch: null, dkg: null, beacon: null },
      { height: 950, nextEpochId: 8, epoch: epoch(7, ALL), dkg: null, beacon: beacon(900, { committed: [C] }) },
      { height: 1001, nextEpochId: 8, epoch: epoch(7, ALL), dkg: null, beacon: beacon(900, { committed: [C, A], revealed: [C, A] }) },
      { height: 1001, nextEpochId: 8, epoch: epoch(7, []), dkg: null, beacon: null },
      { height: 1130, nextEpochId: 9, epoch: null, dkg: dkg({ committed: [] }), beacon: null },
      { height: 1300, nextEpochId: 9, epoch: epoch(7, [A]), dkg: { ...dkg(), members: [] }, beacon: null },
    ];
    const validatorSets = [validators(), [], validators({ [A]: { jailed: true, bonded: false }, [B]: { power: 0 } })];
    let decisions = 0;
    for (const dealer of dealers) {
      for (const vals of validatorSets) {
        for (const mem of memories) {
          for (const who of [A, B, C, "ocpvaloper1stranger"]) {
            const view = { dealer, validators: vals };
            const first = decide(view, me(who), mem);
            assert.deepEqual(decide(view, me(who), mem), first);
            assert.equal(typeof first.why, "string");
            decisions++;
          }
        }
      }
    }
    assert.equal(decisions, dealers.length * validatorSets.length * memories.length * 4);
  });
});

describe("policy", () => {
  it("BeginEpoch's commit window is long enough for a daemon to crash, wait out a 60 s restart backoff, and commit", () => {
    // 5 s blocks. The chain's default of 5 blocks is 25 s, which slashed two validators in the DKG for epoch 43.
    assert.ok(POLICY.dkgWindows.commitBlocks * 5 >= 60 + 45 + 60, `${POLICY.dkgWindows.commitBlocks} blocks`);
  });
});

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  CURVE_ORDER,
  mulBase,
  groupElementToBytes,
  scalarToBytes,
  scalarFromBytesModOrder,
} from "@onchainpoker/ocp-crypto";
import { evalPoly, modQ } from "../src/handlers/dkg.js";
import { handleDkgComplaints, handleDkgAggregate } from "../src/handlers/dkg.js";
import type { EpochSecrets } from "../src/state.js";

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

class StubStateStore {
  private map = new Map<number, EpochSecrets>();

  save(s: EpochSecrets): void {
    this.map.set(s.epochId, s);
  }
  load(epochId: number): EpochSecrets | null {
    return this.map.get(epochId) ?? null;
  }
  has(epochId: number): boolean {
    return this.map.has(epochId);
  }
}

class StubClient {
  calls: Array<{ method: string; args: unknown }> = [];

  async dealerDkgComplaintMissing(args: unknown): Promise<void> {
    this.calls.push({ method: "dealerDkgComplaintMissing", args });
  }
}

function makeConfig(addr: string) {
  return {
    validatorAddress: addr,
    threshold: 2,
  } as any;
}

// ---------------------------------------------------------------------------
// evalPoly
// ---------------------------------------------------------------------------
describe("evalPoly", () => {
  it("constant polynomial", () => {
    // f(x) = 42
    assert.equal(evalPoly([42n], 100n), 42n);
  });

  it("linear polynomial", () => {
    // f(x) = 3 + 5x → f(2) = 3 + 10 = 13
    assert.equal(evalPoly([3n, 5n], 2n), 13n);
  });

  it("degree-2 polynomial", () => {
    // f(x) = 1 + 2x + 3x² → f(4) = 1 + 8 + 48 = 57
    assert.equal(evalPoly([1n, 2n, 3n], 4n), 57n);
  });

  it("wraps at CURVE_ORDER", () => {
    const result = evalPoly([CURVE_ORDER - 1n, 1n], 2n);
    // (CURVE_ORDER - 1 + 2) mod q = 1
    assert.equal(result, 1n);
  });
});

// ---------------------------------------------------------------------------
// handleDkgComplaints
// ---------------------------------------------------------------------------
describe("handleDkgComplaints", () => {
  it("files complaints only against committed members, skips self, skips already-complained", async () => {
    const client = new StubClient();
    const config = makeConfig("alice");
    const members = [
      { validator: "alice", index: 1 },
      { validator: "bob", index: 2 },
      { validator: "carol", index: 3 },
      { validator: "dave", index: 4 },
    ];

    const dkg = {
      commits: [
        { dealer: "alice" },
        { dealer: "bob" },
        { dealer: "carol" },
        // dave has NOT committed
      ],
      complaints: [
        // alice already complained about bob
        { complainer: "alice", dealer: "bob" },
      ],
    };

    await handleDkgComplaints({
      client: client as any,
      config,
      epochId: 1,
      members,
      dkg,
    });

    // Should only file complaint against carol (bob already complained, dave not committed, alice is self)
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0]!.method, "dealerDkgComplaintMissing");
    assert.deepEqual((client.calls[0]!.args as any).dealer, "carol");
  });

  it("does nothing if we have not committed", async () => {
    const client = new StubClient();
    const config = makeConfig("alice");

    await handleDkgComplaints({
      client: client as any,
      config,
      epochId: 1,
      members: [{ validator: "alice", index: 1 }, { validator: "bob", index: 2 }],
      dkg: { commits: [{ dealer: "bob" }], complaints: [] },
    });

    assert.equal(client.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// handleDkgAggregate
// ---------------------------------------------------------------------------
describe("handleDkgAggregate", () => {
  it("returns false with no secrets stored", async () => {
    const store = new StubStateStore();
    const result = await handleDkgAggregate({
      stateStore: store as any,
      config: makeConfig("alice"),
      epochId: 1,
      members: [{ validator: "alice", index: 1 }],
      dkg: { reveals: [] },
    });
    assert.equal(result, false);
  });

  it("returns true when already computed (secretShare != 0)", async () => {
    const store = new StubStateStore();
    store.save({
      epochId: 1,
      validatorIndex: 1,
      polyCoeffs: ["a"],
      secretShare: "deadbeef", // non-zero → already computed
    });

    const result = await handleDkgAggregate({
      stateStore: store as any,
      config: makeConfig("alice"),
      epochId: 1,
      members: [{ validator: "alice", index: 1 }],
      dkg: { reveals: [] },
    });
    assert.equal(result, true);
  });

  it("parses Uint8Array reveal shares", async () => {
    const store = new StubStateStore();
    // Alice's polynomial: f(x) = 5 + 3x (secret=5, threshold=2)
    const alicePoly = [5n, 3n];
    store.save({
      epochId: 1,
      validatorIndex: 1,
      polyCoeffs: alicePoly.map((c) => c.toString(16)),
      secretShare: "0",
    });

    // Bob's polynomial: f(x) = 7 + 2x
    const bobPoly = [7n, 2n];
    // Bob reveals share to alice: bobPoly(1) = 7 + 2 = 9
    const bobShareToAlice = modQ(evalPoly(bobPoly, 1n));
    const shareBytes = scalarToBytes(bobShareToAlice);

    const result = await handleDkgAggregate({
      stateStore: store as any,
      config: makeConfig("alice"),
      epochId: 1,
      members: [
        { validator: "alice", index: 1 },
        { validator: "bob", index: 2 },
      ],
      dkg: {
        reveals: [
          { dealer: "bob", to: "alice", share: shareBytes },
        ],
        slashed: [],
      },
    });

    assert.equal(result, true);
    const secrets = store.load(1);
    assert.ok(secrets);
    // Aggregated = alicePoly(1) + bobShareToAlice = (5+3) + 9 = 17
    const expected = modQ(evalPoly(alicePoly, 1n) + bobShareToAlice);
    assert.equal(BigInt("0x" + secrets.secretShare), expected);
  });

  it("parses hex string reveal shares", async () => {
    const store = new StubStateStore();
    const alicePoly = [10n, 20n];
    store.save({
      epochId: 2,
      validatorIndex: 1,
      polyCoeffs: alicePoly.map((c) => c.toString(16)),
      secretShare: "0",
    });

    const bobShare = scalarToBytes(42n);
    // Convert to hex string (64 chars)
    const hexStr = Array.from(bobShare).map((b) => b.toString(16).padStart(2, "0")).join("");

    const result = await handleDkgAggregate({
      stateStore: store as any,
      config: makeConfig("alice"),
      epochId: 2,
      members: [
        { validator: "alice", index: 1 },
        { validator: "bob", index: 2 },
      ],
      dkg: {
        reveals: [
          { dealer: "bob", to: "alice", share: hexStr },
        ],
        slashed: [],
      },
    });

    assert.equal(result, true);
  });

  it("parses base64 reveal shares", async () => {
    const store = new StubStateStore();
    const alicePoly = [10n, 20n];
    store.save({
      epochId: 3,
      validatorIndex: 1,
      polyCoeffs: alicePoly.map((c) => c.toString(16)),
      secretShare: "0",
    });

    const bobShare = scalarToBytes(42n);
    const b64 = Buffer.from(bobShare).toString("base64");

    const result = await handleDkgAggregate({
      stateStore: store as any,
      config: makeConfig("alice"),
      epochId: 3,
      members: [
        { validator: "alice", index: 1 },
        { validator: "bob", index: 2 },
      ],
      dkg: {
        reveals: [
          { dealer: "bob", to: "alice", share: b64 },
        ],
        slashed: [],
      },
    });

    assert.equal(result, true);
  });

  it("skips slashed dealers", async () => {
    const store = new StubStateStore();
    const alicePoly = [5n, 3n];
    store.save({
      epochId: 4,
      validatorIndex: 1,
      polyCoeffs: alicePoly.map((c) => c.toString(16)),
      secretShare: "0",
    });

    const bobShare = scalarToBytes(9n);
    const carolShare = scalarToBytes(11n);

    const result = await handleDkgAggregate({
      stateStore: store as any,
      config: makeConfig("alice"),
      epochId: 4,
      members: [
        { validator: "alice", index: 1 },
        { validator: "bob", index: 2 },
        { validator: "carol", index: 3 },
      ],
      dkg: {
        reveals: [
          { dealer: "bob", to: "alice", share: bobShare },
          { dealer: "carol", to: "alice", share: carolShare },
        ],
        slashed: ["carol"], // carol is slashed, should be skipped
      },
    });

    // Only bob's reveal should count; carol is slashed but still expected.
    // However, expectedOtherMembers excludes slashed, so only bob is expected → 1 reveal = 1 expected → true
    assert.equal(result, true);
  });

  it("full 3-member DKG cycle", async () => {
    // 3 members, threshold 2: each generates degree-1 poly
    const polys = [
      [11n, 22n], // member 1: f1(x) = 11 + 22x
      [33n, 44n], // member 2: f2(x) = 33 + 44x
      [55n, 66n], // member 3: f3(x) = 55 + 66x
    ];

    // Each member's aggregated share at their index:
    // agg_j = Σ_i f_i(j) for all i
    for (let myIdx = 0; myIdx < 3; myIdx++) {
      const myIndex = myIdx + 1; // 1-based
      const members = [
        { validator: `member${1}`, index: 1 },
        { validator: `member${2}`, index: 2 },
        { validator: `member${3}`, index: 3 },
      ];

      const store = new StubStateStore();
      store.save({
        epochId: 10,
        validatorIndex: myIndex,
        polyCoeffs: polys[myIdx]!.map((c) => c.toString(16)),
        secretShare: "0",
      });

      // Reveals: other members reveal their share to us
      const reveals = [];
      for (let otherIdx = 0; otherIdx < 3; otherIdx++) {
        if (otherIdx === myIdx) continue;
        const shareVal = evalPoly(polys[otherIdx]!, BigInt(myIndex));
        reveals.push({
          dealer: `member${otherIdx + 1}`,
          to: `member${myIndex}`,
          share: scalarToBytes(shareVal),
        });
      }

      const result = await handleDkgAggregate({
        stateStore: store as any,
        config: makeConfig(`member${myIndex}`),
        epochId: 10,
        members,
        dkg: { reveals, slashed: [] },
      });

      assert.equal(result, true);

      // Verify the aggregated share
      const secrets = store.load(10);
      assert.ok(secrets);
      let expectedAgg = 0n;
      for (const poly of polys) {
        expectedAgg = modQ(expectedAgg + evalPoly(poly, BigInt(myIndex)));
      }
      assert.equal(BigInt("0x" + secrets.secretShare), expectedAgg);
    }
  });
});

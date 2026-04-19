import test from "node:test";
import assert from "node:assert/strict";

import { elgamalEncrypt, mulBase } from "@onchainpoker/ocp-crypto";
import { shuffleProveV1 } from "../index.js";

function makeDeck(pk: any, n: number, seed: bigint): any[] {
  const deck: any[] = [];
  for (let i = 0; i < n; i++) {
    const m = mulBase(BigInt(i + 1));
    const r = seed + BigInt(i + 1);
    deck.push(elgamalEncrypt(pk, m, r));
  }
  return deck;
}

// Save and restore environment inside each test so we don't affect sibling
// tests that rely on NODE_ENV=test to pass their seed overrides.
function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void,
): void {
  const prior: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) prior[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("seed guard: seedUnsafeForTestsOnly throws when NODE_ENV != test and OCP_ALLOW_UNSAFE_SEED != 1", () => {
  const pk = mulBase(77n);
  const deckIn = makeDeck(pk, 4, 42n);

  withEnv({ NODE_ENV: "production", OCP_ALLOW_UNSAFE_SEED: undefined }, () => {
    assert.throws(
      () =>
        shuffleProveV1(pk, deckIn, {
          seedUnsafeForTestsOnly: new Uint8Array(32).fill(11),
          rounds: 4,
        }),
      /seedUnsafeForTestsOnly is a test hook/,
    );
  });
});

test("seed guard: escape hatch OCP_ALLOW_UNSAFE_SEED=1 permits the override in non-test env", () => {
  const pk = mulBase(77n);
  const deckIn = makeDeck(pk, 4, 42n);

  withEnv({ NODE_ENV: "production", OCP_ALLOW_UNSAFE_SEED: "1" }, () => {
    const { proofBytes } = shuffleProveV1(pk, deckIn, {
      seedUnsafeForTestsOnly: new Uint8Array(32).fill(11),
      rounds: 4,
    });
    assert.ok(proofBytes.length > 0);
  });
});

test("seed guard: NODE_ENV=test allows seedUnsafeForTestsOnly", () => {
  const pk = mulBase(77n);
  const deckIn = makeDeck(pk, 4, 42n);

  withEnv({ NODE_ENV: "test", OCP_ALLOW_UNSAFE_SEED: undefined }, () => {
    const { proofBytes } = shuffleProveV1(pk, deckIn, {
      seedUnsafeForTestsOnly: new Uint8Array(32).fill(11),
      rounds: 4,
    });
    assert.ok(proofBytes.length > 0);
  });
});

test("seed guard: omitting the option works in any environment (uses randomBytes)", () => {
  const pk = mulBase(77n);
  const deckIn = makeDeck(pk, 4, 42n);

  withEnv({ NODE_ENV: "production", OCP_ALLOW_UNSAFE_SEED: undefined }, () => {
    const { proofBytes } = shuffleProveV1(pk, deckIn, { rounds: 4 });
    assert.ok(proofBytes.length > 0);
  });
});

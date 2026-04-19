import test from "node:test";
import assert from "node:assert/strict";

import { elgamalEncrypt, mulBase } from "@onchainpoker/ocp-crypto";
import { shuffleProveV1, shuffleVerifyV1, buildShuffleContext } from "../index.js";

function makeDeck(pk: any, n: number, seed: bigint): any[] {
  const deck: any[] = [];
  for (let i = 0; i < n; i++) {
    const m = mulBase(BigInt(i + 1));
    // Deterministic-ish randomness for encrypting test deck.
    const r = seed + BigInt(i + 1);
    deck.push(elgamalEncrypt(pk, m, r));
  }
  return deck;
}

function mutateSingleProofForRound(
  proofBytes: Uint8Array,
  n: number,
  rounds: number,
  targetRound: number,
  singleSlot: number,
): Uint8Array {
  const proof = new Uint8Array(proofBytes);
  const switchProofLen = 4 * 3 * 32;
  const singleProofLen = 3 * 32;
  let offset = 5;

  for (let round = 0; round < rounds; round++) {
    const start = round & 1;
    offset += n * 64;
    const pairCount = Math.floor((n - start) / 2);
    offset += pairCount * switchProofLen;

    if (round === targetRound) {
      if (n % 2 === 1) {
        if (singleSlot !== 0) {
          throw new Error(`invalid singleSlot=${singleSlot} for odd deck`);
        }
        proof[offset] ^= 0x01;
        return proof;
      }
      if (start === 1) {
        const slotOffset = singleSlot * singleProofLen;
        proof[offset + slotOffset] ^= 0x01;
        return proof;
      }
      throw new Error(`no singles at round=${round} for n=${n}, start=${start}`);
    }

    if (n % 2 === 1 || start === 1) {
      const singleCount = n % 2 === 1 ? 1 : 2;
      offset += singleCount * singleProofLen;
    }
  }

  throw new Error(`targetRound ${targetRound} out of range`);
}

test("WS5: valid shuffle proof verifies (small deck)", () => {
  const sk = 42n;
  const pk = mulBase(sk);
  const deckIn = makeDeck(pk, 10, 123n);

  const { proofBytes } = shuffleProveV1(pk, deckIn, { seedUnsafeForTestsOnly: new Uint8Array(32).fill(7), rounds: 10 });
  const vr = shuffleVerifyV1(pk, deckIn, proofBytes);
  if (!vr.ok) throw new Error(vr.error);
  assert.equal(vr.deckOut.length, 10);
});

test("WS5: tampering output deck bytes fails verification", () => {
  const sk = 123n;
  const pk = mulBase(sk);
  const deckIn = makeDeck(pk, 12, 999n);

  const { proofBytes } = shuffleProveV1(pk, deckIn, { seedUnsafeForTestsOnly: new Uint8Array(32).fill(9), rounds: 12 });

  // Flip one bit in the first post-round deck snapshot.
  const bad = new Uint8Array(proofBytes);
  // Header is 1 + 2 + 2 = 5 bytes; deck snapshot begins immediately.
  bad[5 + 0] ^= 0x01;

  const vr = shuffleVerifyV1(pk, deckIn, bad);
  assert.equal(vr.ok, false);
});

test("WS5: wrong permutation (swapping two ciphertexts) fails verification", () => {
  const sk = 321n;
  const pk = mulBase(sk);
  const n = 10;
  const deckIn = makeDeck(pk, n, 222n);

  const { proofBytes } = shuffleProveV1(pk, deckIn, { seedUnsafeForTestsOnly: new Uint8Array(32).fill(8), rounds: n });

  const bad = new Uint8Array(proofBytes);
  const headerLen = 5;
  const ctLen = 64;

  const a0 = bad.slice(headerLen + 0 * ctLen, headerLen + 1 * ctLen);
  const a1 = bad.slice(headerLen + 1 * ctLen, headerLen + 2 * ctLen);
  bad.set(a1, headerLen + 0 * ctLen);
  bad.set(a0, headerLen + 1 * ctLen);

  const vr = shuffleVerifyV1(pk, deckIn, bad);
  assert.equal(vr.ok, false);
});

test("WS5: missing rerandomization (reusing c1) fails verification", () => {
  const sk = 777n;
  const pk = mulBase(sk);
  const deckIn = makeDeck(pk, 8, 111n);

  const { proofBytes } = shuffleProveV1(pk, deckIn, { seedUnsafeForTestsOnly: new Uint8Array(32).fill(3), rounds: 8 });

  // Force output[0].c1 bytes to equal input[0].c1 bytes in round 0 deck snapshot.
  const bad = new Uint8Array(proofBytes);
  const headerLen = 5;
  const ctLen = 64;
  const in0c1 = deckIn[0].c1.toBytes();
  bad.set(in0c1, headerLen + 0 * ctLen + 0 /* c1 offset */);

  const vr = shuffleVerifyV1(pk, deckIn, bad);
  assert.equal(vr.ok, false);
});

test("WS5: verify handles odd/even rounds with mixed parity singles", () => {
  const sk = 2468n;
  const pk = mulBase(sk);
  const rounds = 7;

  const cases = [2, 3, 4, 5, 6];
  for (const n of cases) {
    const deckIn = makeDeck(pk, n, BigInt(1000 + n));
    const seed = new Uint8Array(32).fill(17 + n);
    const { proofBytes } = shuffleProveV1(pk, deckIn, { seedUnsafeForTestsOnly: seed, rounds });
    const vr = shuffleVerifyV1(pk, deckIn, proofBytes);
    if (!vr.ok) throw new Error(vr.error);
    assert.equal(vr.deckOut.length, n);
  }
});

test("WS5: N=52 smoke (rounds=10) verifies", () => {
  const sk = 999n;
  const pk = mulBase(sk);
  const deckIn = makeDeck(pk, 52, 555n);

  const { proofBytes } = shuffleProveV1(pk, deckIn, { seedUnsafeForTestsOnly: new Uint8Array(32).fill(1), rounds: 10 });
  const vr = shuffleVerifyV1(pk, deckIn, proofBytes);
  if (!vr.ok) throw new Error(vr.error);
});

test("WS5: even deck odd-start round uses two single proofs (round 1, n=2, rounds=2)", () => {
  const sk = 2024n;
  const pk = mulBase(sk);
  const deckIn = makeDeck(pk, 2, 2222n);

  const { proofBytes } = shuffleProveV1(pk, deckIn, { seedUnsafeForTestsOnly: new Uint8Array(32).fill(4), rounds: 2 });
  const vr = shuffleVerifyV1(pk, deckIn, proofBytes);
  if (!vr.ok) throw new Error(vr.error);
});

test("WS5: even deck odd-start rejects tampered first single proof (round 1 slot 0)", () => {
  const sk = 2024n;
  const pk = mulBase(sk);
  const deckIn = makeDeck(pk, 2, 2222n);

  const { proofBytes } = shuffleProveV1(pk, deckIn, { seedUnsafeForTestsOnly: new Uint8Array(32).fill(4), rounds: 2 });
  const bad = mutateSingleProofForRound(proofBytes, 2, 2, 1, 0);
  const vr = shuffleVerifyV1(pk, deckIn, bad);
  assert.equal(vr.ok, false);
});

test("WS5: even deck odd-start rejects tampered second single proof (round 1 slot 1)", () => {
  const sk = 2024n;
  const pk = mulBase(sk);
  const deckIn = makeDeck(pk, 2, 2222n);

  const { proofBytes } = shuffleProveV1(pk, deckIn, { seedUnsafeForTestsOnly: new Uint8Array(32).fill(4), rounds: 2 });
  const bad = mutateSingleProofForRound(proofBytes, 2, 2, 1, 1);
  const vr = shuffleVerifyV1(pk, deckIn, bad);
  assert.equal(vr.ok, false);
});

test("WS5 ctx-binding: v2 proof verifies under matching context", () => {
  const sk = 4242n;
  const pk = mulBase(sk);
  const n = 6;
  const deckIn = makeDeck(pk, n, 7777n);

  const ctx = buildShuffleContext({
    tableId: 1n,
    handId: 2n,
    round: 3,
    shuffler: "cosmosvaloper1foo",
  });

  const { proofBytes } = shuffleProveV1(pk, deckIn, {
    seedUnsafeForTestsOnly: new Uint8Array(32).fill(11),
    rounds: n,
    context: ctx,
  });

  // Header byte 0 must now be version=2 (v2 format).
  assert.equal(proofBytes[0], 2);

  const vr = shuffleVerifyV1(pk, deckIn, proofBytes, ctx);
  if (!vr.ok) throw new Error(vr.error);
  assert.equal(vr.deckOut.length, n);
});

test("WS5 ctx-binding: proof with context A does not verify under context B", () => {
  const sk = 4242n;
  const pk = mulBase(sk);
  const n = 6;
  const deckIn = makeDeck(pk, n, 7777n);

  const ctxA = buildShuffleContext({
    tableId: 1n,
    handId: 2n,
    round: 3,
    shuffler: "cosmosvaloper1foo",
  });
  const ctxB = buildShuffleContext({
    tableId: 1n,
    handId: 2n,
    round: 3,
    shuffler: "cosmosvaloper1bar", // different shuffler
  });

  const { proofBytes } = shuffleProveV1(pk, deckIn, {
    seedUnsafeForTestsOnly: new Uint8Array(32).fill(12),
    rounds: n,
    context: ctxA,
  });

  const vr = shuffleVerifyV1(pk, deckIn, proofBytes, ctxB);
  assert.equal(vr.ok, false);
});

test("WS5 ctx-binding: proof bound to (handId=2) rejected under (handId=3)", () => {
  const sk = 4242n;
  const pk = mulBase(sk);
  const n = 6;
  const deckIn = makeDeck(pk, n, 7777n);

  const ctx2 = buildShuffleContext({ tableId: 1n, handId: 2n, round: 1, shuffler: "v" });
  const ctx3 = buildShuffleContext({ tableId: 1n, handId: 3n, round: 1, shuffler: "v" });

  const { proofBytes } = shuffleProveV1(pk, deckIn, {
    seedUnsafeForTestsOnly: new Uint8Array(32).fill(13),
    rounds: n,
    context: ctx2,
  });

  const vr = shuffleVerifyV1(pk, deckIn, proofBytes, ctx3);
  assert.equal(vr.ok, false);
});

test("WS5 ctx-binding: empty context rejected at v2 (prover throws)", () => {
  const sk = 4242n;
  const pk = mulBase(sk);
  const deckIn = makeDeck(pk, 4, 7777n);

  assert.throws(() =>
    shuffleProveV1(pk, deckIn, {
      seedUnsafeForTestsOnly: new Uint8Array(32).fill(14),
      rounds: 4,
      context: new Uint8Array(0),
    }),
  );
});

test("WS5 ctx-binding: v2 proof without caller-supplied context fails verify", () => {
  const sk = 4242n;
  const pk = mulBase(sk);
  const n = 4;
  const deckIn = makeDeck(pk, n, 7777n);

  const ctx = buildShuffleContext({ tableId: 1n, handId: 1n, round: 1, shuffler: "v" });
  const { proofBytes } = shuffleProveV1(pk, deckIn, {
    seedUnsafeForTestsOnly: new Uint8Array(32).fill(15),
    rounds: n,
    context: ctx,
  });

  const vr = shuffleVerifyV1(pk, deckIn, proofBytes /* no context */);
  assert.equal(vr.ok, false);
});

test("WS5 ctx-binding: v1 proof (no context) still verifies via legacy path", () => {
  // Ensures backward-compat: legacy proofs emitted with no context opt
  // continue to work when verifier is called without a context.
  const sk = 42n;
  const pk = mulBase(sk);
  const deckIn = makeDeck(pk, 10, 123n);

  const { proofBytes } = shuffleProveV1(pk, deckIn, {
    seedUnsafeForTestsOnly: new Uint8Array(32).fill(7),
    rounds: 10,
  });
  // Version byte must remain 1 (no context supplied).
  assert.equal(proofBytes[0], 1);

  const vr = shuffleVerifyV1(pk, deckIn, proofBytes);
  if (!vr.ok) throw new Error(vr.error);
});

test("WS5 ctx-binding: v1 proof rejected when verifier is given a context", () => {
  const sk = 42n;
  const pk = mulBase(sk);
  const deckIn = makeDeck(pk, 10, 123n);

  const { proofBytes } = shuffleProveV1(pk, deckIn, {
    seedUnsafeForTestsOnly: new Uint8Array(32).fill(7),
    rounds: 10,
  });

  const ctx = buildShuffleContext({ tableId: 1n, handId: 1n, round: 1, shuffler: "v" });
  const vr = shuffleVerifyV1(pk, deckIn, proofBytes, ctx);
  assert.equal(vr.ok, false);
});

test("WS5 ctx-binding: buildShuffleContext produces canonical wire format", () => {
  // u64le(tableId=1) || u64le(handId=2) || u16le(round=3) || u16le(len) || shuffler
  const ctx = buildShuffleContext({
    tableId: 1n,
    handId: 2n,
    round: 3,
    shuffler: "cosmosvaloper1foo",
  });
  // 8 + 8 + 2 + 2 + 17 = 37
  assert.equal(ctx.length, 37);
  // tableId little-endian
  assert.deepEqual(Array.from(ctx.subarray(0, 8)), [1, 0, 0, 0, 0, 0, 0, 0]);
  // handId
  assert.deepEqual(Array.from(ctx.subarray(8, 16)), [2, 0, 0, 0, 0, 0, 0, 0]);
  // round=3
  assert.deepEqual(Array.from(ctx.subarray(16, 18)), [3, 0]);
  // shufflerLen=17
  assert.deepEqual(Array.from(ctx.subarray(18, 20)), [17, 0]);
  // utf-8 bytes
  assert.equal(new TextDecoder().decode(ctx.subarray(20)), "cosmosvaloper1foo");
});

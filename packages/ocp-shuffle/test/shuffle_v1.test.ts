import test from "node:test";
import assert from "node:assert/strict";

import { elgamalEncrypt, mulBase } from "@onchainpoker/ocp-crypto";
import { shuffleProveV1, shuffleVerifyV1 } from "../index.js";

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

  const { proofBytes } = shuffleProveV1(pk, deckIn, { seed: new Uint8Array(32).fill(7), rounds: 10 });
  const vr = shuffleVerifyV1(pk, deckIn, proofBytes);
  if (!vr.ok) throw new Error(vr.error);
  assert.equal(vr.deckOut.length, 10);
});

test("WS5: tampering output deck bytes fails verification", () => {
  const sk = 123n;
  const pk = mulBase(sk);
  const deckIn = makeDeck(pk, 12, 999n);

  const { proofBytes } = shuffleProveV1(pk, deckIn, { seed: new Uint8Array(32).fill(9), rounds: 12 });

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

  const { proofBytes } = shuffleProveV1(pk, deckIn, { seed: new Uint8Array(32).fill(8), rounds: n });

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

  const { proofBytes } = shuffleProveV1(pk, deckIn, { seed: new Uint8Array(32).fill(3), rounds: 8 });

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
    const { proofBytes } = shuffleProveV1(pk, deckIn, { seed, rounds });
    const vr = shuffleVerifyV1(pk, deckIn, proofBytes);
    if (!vr.ok) throw new Error(vr.error);
    assert.equal(vr.deckOut.length, n);
  }
});

test("WS5: N=52 smoke (rounds=10) verifies", () => {
  const sk = 999n;
  const pk = mulBase(sk);
  const deckIn = makeDeck(pk, 52, 555n);

  const { proofBytes } = shuffleProveV1(pk, deckIn, { seed: new Uint8Array(32).fill(1), rounds: 10 });
  const vr = shuffleVerifyV1(pk, deckIn, proofBytes);
  if (!vr.ok) throw new Error(vr.error);
});

test("WS5: even deck odd-start round uses two single proofs (round 1, n=2, rounds=2)", () => {
  const sk = 2024n;
  const pk = mulBase(sk);
  const deckIn = makeDeck(pk, 2, 2222n);

  const { proofBytes } = shuffleProveV1(pk, deckIn, { seed: new Uint8Array(32).fill(4), rounds: 2 });
  const vr = shuffleVerifyV1(pk, deckIn, proofBytes);
  if (!vr.ok) throw new Error(vr.error);
});

test("WS5: even deck odd-start rejects tampered first single proof (round 1 slot 0)", () => {
  const sk = 2024n;
  const pk = mulBase(sk);
  const deckIn = makeDeck(pk, 2, 2222n);

  const { proofBytes } = shuffleProveV1(pk, deckIn, { seed: new Uint8Array(32).fill(4), rounds: 2 });
  const bad = mutateSingleProofForRound(proofBytes, 2, 2, 1, 0);
  const vr = shuffleVerifyV1(pk, deckIn, bad);
  assert.equal(vr.ok, false);
});

test("WS5: even deck odd-start rejects tampered second single proof (round 1 slot 1)", () => {
  const sk = 2024n;
  const pk = mulBase(sk);
  const deckIn = makeDeck(pk, 2, 2222n);

  const { proofBytes } = shuffleProveV1(pk, deckIn, { seed: new Uint8Array(32).fill(4), rounds: 2 });
  const bad = mutateSingleProofForRound(proofBytes, 2, 2, 1, 1);
  const vr = shuffleVerifyV1(pk, deckIn, bad);
  assert.equal(vr.ok, false);
});

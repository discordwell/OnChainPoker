import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveHandPublicKey,
  deriveHandScalar,
  deriveHandSecretShare,
  publicKeyFromSecret,
  reconstructSecretFromShares,
  runDkg,
  verifyDkgTranscript
} from "../src/dkg.js";

function pickShares(map, ids) {
  return ids.map((id) => ({ id, share: map.get(id) }));
}

test("DKG: all honest -> success, PK matches reconstructed secret, hand derivation consistent", () => {
  const epochId = 7;
  const committeeIds = [1, 2, 3, 4, 5];
  const threshold = 3;

  const res = runDkg({ epochId, committeeIds, threshold, seed: "honest" });
  assert.equal(res.ok, true);
  assert.deepEqual(res.slashed, []);
  assert.deepEqual(res.qual, committeeIds);

  // Transcript is sufficient to re-derive PK/QUAL deterministically.
  const verified = verifyDkgTranscript({
    epochId,
    committeeIds,
    threshold,
    onchain: res.transcript.onchain
  });
  assert.deepEqual(verified.slashed, []);
  assert.deepEqual(verified.qual, committeeIds);
  assert.equal(verified.pkEpoch, res.pkEpoch);

  const secret = reconstructSecretFromShares(pickShares(res.shares, [1, 2, 3]));
  assert.equal(publicKeyFromSecret(secret), res.pkEpoch);

  const k = deriveHandScalar(epochId, 111, 222);
  const pkHand = deriveHandPublicKey(res.pkEpoch, k);

  // Derived shares reconstruct secret*k
  const sharesHand = new Map();
  for (const [id, sk] of res.shares.entries()) {
    sharesHand.set(id, deriveHandSecretShare(sk, k));
  }

  const secretHand = reconstructSecretFromShares(pickShares(sharesHand, [1, 2, 3]));
  assert.equal(publicKeyFromSecret(secretHand), pkHand);
});

test("DKG: 1 byzantine equivocation -> complaint + slash + still finalize", () => {
  const epochId = 8;
  const committeeIds = [1, 2, 3, 4, 5];
  const threshold = 3;

  const res = runDkg({
    epochId,
    committeeIds,
    threshold,
    seed: "equiv",
    byzantine: { equivocate: [{ dealerId: 2, targetId: 3 }] }
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.slashed, [2]);
  assert.deepEqual(res.qual, [1, 3, 4, 5]);

  const verified = verifyDkgTranscript({
    epochId,
    committeeIds,
    threshold,
    onchain: res.transcript.onchain
  });
  assert.deepEqual(verified.slashed, [2]);
  assert.deepEqual(verified.qual, [1, 3, 4, 5]);
  assert.equal(verified.pkEpoch, res.pkEpoch);

  const secret = reconstructSecretFromShares(pickShares(res.shares, [1, 3, 4]));
  assert.equal(publicKeyFromSecret(secret), res.pkEpoch);
});

test("DKG: withholding beyond tolerance -> deterministic abort", () => {
  const epochId = 9;
  const committeeIds = [1, 2, 3, 4, 5, 6];
  const threshold = 5;

  const res = runDkg({
    epochId,
    committeeIds,
    threshold,
    seed: "withhold",
    byzantine: {
      withhold: [{ dealerId: 2 }, { dealerId: 5 }],
      noReveal: [2, 5]
    }
  });

  assert.equal(res.ok, false);
  assert.match(res.reason, /QUAL size/);
  assert.deepEqual(res.slashed.sort((a, b) => a - b), [2, 5]);
});

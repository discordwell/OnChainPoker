import { describe, expect, it } from "vitest";

import {
  Transcript,
  bytesToHex,
  scalarToBytes,
} from "../src/index.js";

describe("Transcript", () => {
  // Backward-compatibility golden vector. Captured against the pre-fold
  // implementation; must remain unchanged after the fold is introduced
  // because single-challenge callers observe the same challenge digest.
  const SINGLE_CHALLENGE_GOLDEN =
    "a2e9007cc0b1a8acf959efd4e0a810bd90bc64b16d9b96b266c5f3b328960d05";

  it("single-challenge golden vector is unchanged (backward compat)", () => {
    const tr = new Transcript("ocp/v1/test");
    tr.appendMessage("msg1", new Uint8Array([1, 2, 3, 4]));
    const e = tr.challengeScalar("e");
    expect(bytesToHex(scalarToBytes(e))).toBe(SINGLE_CHALLENGE_GOLDEN);
  });

  it("two challenges on the same transcript differ (fold is in effect)", () => {
    const tr = new Transcript("ocp/v1/test");
    tr.appendMessage("msg1", new Uint8Array([1, 2, 3, 4]));
    const e1 = tr.challengeScalar("e");
    const e2 = tr.challengeScalar("e");
    expect(bytesToHex(scalarToBytes(e1))).not.toBe(bytesToHex(scalarToBytes(e2)));
  });

  it("first challenge equals the single-challenge golden even when a second is drawn", () => {
    // Belt-and-suspenders: the fold must only affect subsequent challenges,
    // never the first one.
    const tr = new Transcript("ocp/v1/test");
    tr.appendMessage("msg1", new Uint8Array([1, 2, 3, 4]));
    const e1 = tr.challengeScalar("e");
    // Drawing a second challenge must not retroactively change e1.
    tr.challengeScalar("e");
    expect(bytesToHex(scalarToBytes(e1))).toBe(SINGLE_CHALLENGE_GOLDEN);
  });

  it("second challenge binds earlier appended messages (binding)", () => {
    // Two transcripts with identical prefix through the first challenge,
    // but differing in the message appended between challenge 1 and
    // challenge 2, must yield different second challenges. Without the
    // fold they would match whenever the intervening append was the same
    // — which isn't what we're testing here — but the binding guarantee
    // is that *any* difference in the inter-challenge messages flows into
    // the second challenge.
    const trA = new Transcript("ocp/v1/test");
    trA.appendMessage("m", new Uint8Array([0xaa]));
    const e1A = trA.challengeScalar("e");
    trA.appendMessage("extra", new Uint8Array([0x01]));
    const e2A = trA.challengeScalar("e");

    const trB = new Transcript("ocp/v1/test");
    trB.appendMessage("m", new Uint8Array([0xaa]));
    const e1B = trB.challengeScalar("e");
    trB.appendMessage("extra", new Uint8Array([0x02]));
    const e2B = trB.challengeScalar("e");

    // First challenges are identical: same domain + same single append.
    expect(bytesToHex(scalarToBytes(e1A))).toBe(bytesToHex(scalarToBytes(e1B)));
    // Second challenges differ because the intervening append differs.
    expect(bytesToHex(scalarToBytes(e2A))).not.toBe(bytesToHex(scalarToBytes(e2B)));
  });

  it("second challenge binds the first challenge's label (fold tags label)", () => {
    // Two transcripts identical except for the label of the first
    // challenge. The first challenges differ (labels are part of the
    // challenge hash). The second challenges must also differ — the fold
    // binds the first-challenge label via the "chal" tag.
    const trA = new Transcript("ocp/v1/test");
    trA.appendMessage("m", new Uint8Array([0xaa]));
    trA.challengeScalar("e");
    const e2A = trA.challengeScalar("e");

    const trB = new Transcript("ocp/v1/test");
    trB.appendMessage("m", new Uint8Array([0xaa]));
    trB.challengeScalar("f");
    const e2B = trB.challengeScalar("e");

    expect(bytesToHex(scalarToBytes(e2A))).not.toBe(bytesToHex(scalarToBytes(e2B)));
  });
});

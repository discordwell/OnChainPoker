import { randomBytes } from "node:crypto";

import type { ElGamalCiphertext, GroupElement, Scalar } from "@onchainpoker/ocp-crypto";
import { basePoint, pointEq } from "@onchainpoker/ocp-crypto";
import { concatBytes } from "@onchainpoker/ocp-crypto";

import type { ShuffleProveOpts, ShuffleProveResult, ShuffleVerifyResult } from "./types.js";
import { DeterministicRng } from "./rng.js";
import type { ScalarRng } from "./rng.js";
import { Reader, u16ToBytesLE, encodeCiphertext, decodeCiphertext } from "./encoding.js";
import { elgamalReencrypt } from "./elgamal.js";
import { proveEqDlog, verifyEqDlog, decodeEqDlogProofFromReader, encodeEqDlogProofV1 } from "./eqdlog.js";
import { proveSwitch, verifySwitch, decodeSwitchProofFromReader, encodeSwitchProof } from "./switch_or.js";

export const SHUFFLE_PROOF_V1_VERSION = 1;
export const SHUFFLE_PROOF_V2_VERSION = 2;

// Shuffle context wire format (canonical, shared byte-for-byte with Go):
//
//   ctx = u64le(tableId) || u64le(handId) || u16le(round) || u16le(shufflerLen) || shuffler_utf8
//
// All integers are little-endian unsigned. `shuffler` is the bech32 validator
// operator address encoded as UTF-8 (no NUL). Example (tableId=1, handId=2,
// round=3, shuffler="cosmosvaloper1foo"):
//   01 00 00 00 00 00 00 00 | 02 00 00 00 00 00 00 00 | 03 00 | 11 00 | "cosmosvaloper1foo"
//   = 8 + 8 + 2 + 2 + 17 = 37 bytes.
//
// Proof v2 byte layout:
//   u8(version=2) || u16le(n) || u16le(rounds) || u16le(ctxLen) || ctx_bytes
//     || <per-round: deck snapshot, switch proofs, single proofs> (identical to v1)
//
// The context is also bound into every inner Fiat-Shamir transcript (switch
// and eqdlog) via tr.appendMessage("ctx", ctx) right after the domain
// separator, so no proof verifies without the matching context value. v1
// proofs/transcripts are unchanged (no ctx appended) for backward compat.

const DOMAIN_REENC = "ocp/v1/shuffle/reenc-eqdlog";
const G = basePoint();

export function buildShuffleContext(params: {
  tableId: bigint | number;
  handId: bigint | number;
  round: number;
  shuffler: string;
}): Uint8Array {
  const { tableId, handId, round, shuffler } = params;
  const tableIdBig = typeof tableId === "bigint" ? tableId : BigInt(tableId);
  const handIdBig = typeof handId === "bigint" ? handId : BigInt(handId);
  if (tableIdBig < 0n || tableIdBig > 0xffffffffffffffffn) throw new Error("buildShuffleContext: tableId out of range");
  if (handIdBig < 0n || handIdBig > 0xffffffffffffffffn) throw new Error("buildShuffleContext: handId out of range");
  if (!Number.isInteger(round) || round < 0 || round > 0xffff) throw new Error("buildShuffleContext: round out of range");
  const shufflerBytes = new TextEncoder().encode(shuffler);
  if (shufflerBytes.length > 0xffff) throw new Error("buildShuffleContext: shuffler too long");

  const out = new Uint8Array(8 + 8 + 2 + 2 + shufflerBytes.length);
  const dv = new DataView(out.buffer);
  dv.setBigUint64(0, tableIdBig, true);
  dv.setBigUint64(8, handIdBig, true);
  dv.setUint16(16, round, true);
  dv.setUint16(18, shufflerBytes.length, true);
  out.set(shufflerBytes, 20);
  return out;
}

function sampleNonzeroScalar(rng: ScalarRng): Scalar {
  while (true) {
    const s = rng.nextScalar();
    if (s !== 0n) return s;
  }
}

function reencryptAvoidingC1Collisions(rng: ScalarRng, pk: GroupElement, src: ElGamalCiphertext, avoidC1s: GroupElement[]): { ct: ElGamalCiphertext; rho: Scalar } {
  while (true) {
    const rho = sampleNonzeroScalar(rng);
    const ct = elgamalReencrypt(pk, src, rho);
    let ok = true;
    for (const a of avoidC1s) {
      if (pointEq(ct.c1, a)) {
        ok = false;
        break;
      }
    }
    if (ok) return { ct, rho };
  }
}

function randomPermutation(rng: DeterministicRng, n: number): number[] {
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const b = rng.nextBytes(4);
    const x = (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
    const j = x % (i + 1);
    const tmp = perm[i]!;
    perm[i] = perm[j]!;
    perm[j] = tmp;
  }
  return perm;
}

function roundPairs(n: number, round: number): { pairs: Array<[number, number]>; singles: number[] } {
  const start = round % 2;
  const pairs: Array<[number, number]> = [];
  const used = new Array<boolean>(n).fill(false);
  for (let i = start; i + 1 < n; i += 2) {
    pairs.push([i, i + 1]);
    used[i] = true;
    used[i + 1] = true;
  }
  const singles: number[] = [];
  for (let i = 0; i < n; i++) if (!used[i]) singles.push(i);
  return { pairs, singles };
}

// SECURITY: The CSPRNG seed must never be reused across shuffles. Reuse
// causes identical Schnorr nonces to be paired with different Fiat-Shamir
// challenges, allowing a verifier to recover re-encryption randomness rho
// via rho = (z1 - z2) / (e1 - e2). This is why `seedUnsafeForTestsOnly`
// exists only for tests; production must let the function use randomBytes(32).
export function shuffleProveV1(pk: GroupElement, deckIn: ElGamalCiphertext[], opts: ShuffleProveOpts = {}): ShuffleProveResult {
  const n = deckIn.length;
  if (n < 2) throw new Error("shuffleProveV1: deck too small");
  const rounds = opts.rounds ?? n;
  if (!Number.isInteger(rounds) || rounds <= 0) throw new Error("shuffleProveV1: rounds must be > 0");

  let seed: Uint8Array;
  if (opts.seedUnsafeForTestsOnly !== undefined) {
    if (process.env.NODE_ENV !== "test" && process.env.OCP_ALLOW_UNSAFE_SEED !== "1") {
      throw new Error(
        "seedUnsafeForTestsOnly is a test hook; set NODE_ENV=test or OCP_ALLOW_UNSAFE_SEED=1 to enable",
      );
    }
    console.warn(
      "[ocp-shuffle] WARNING: deterministic seed override in use — never use in production; nonce reuse leaks permutation randomness",
    );
    seed = opts.seedUnsafeForTestsOnly;
  } else {
    seed = randomBytes(32);
  }
  const rng = new DeterministicRng(seed);

  // Resolve context: if caller passes it, emit v2 format; else legacy v1.
  let context: Uint8Array | undefined = opts.context;
  let version: number;
  if (context !== undefined) {
    if (context.length === 0) throw new Error("shuffleProveV1: context must be non-empty for v2");
    version = SHUFFLE_PROOF_V2_VERSION;
  } else {
    version = SHUFFLE_PROOF_V1_VERSION;
  }

  const perm = randomPermutation(rng, n);
  const items: Array<{ ct: ElGamalCiphertext; key: number }> = deckIn.map((ct, i) => ({ ct, key: perm[i]! }));

  let header: Uint8Array;
  if (version === SHUFFLE_PROOF_V2_VERSION) {
    if (context!.length > 0xffff) throw new Error("shuffleProveV1: context too long (>65535 bytes)");
    header = concatBytes(
      new Uint8Array([SHUFFLE_PROOF_V2_VERSION]),
      u16ToBytesLE(n),
      u16ToBytesLE(rounds),
      u16ToBytesLE(context!.length),
      context!,
    );
  } else {
    header = concatBytes(new Uint8Array([SHUFFLE_PROOF_V1_VERSION]), u16ToBytesLE(n), u16ToBytesLE(rounds));
  }
  const proofChunks: Uint8Array[] = [header];

  for (let round = 0; round < rounds; round++) {
    const { pairs, singles } = roundPairs(n, round);
    const next: Array<{ ct: ElGamalCiphertext; key: number }> = items.map((it) => ({ ...it }));

    const deckOutRound: ElGamalCiphertext[] = new Array(n);
    // Fill with current to avoid undefined, then overwrite in processing.
    for (let i = 0; i < n; i++) deckOutRound[i] = items[i]!.ct;

    const switchProofs: Uint8Array[] = [];
    const singleProofs: Uint8Array[] = [];

    // Process disjoint adjacent pairs (switch proofs).
    for (const [i, j] of pairs) {
      const left0 = items[i]!.ct;
      const left1 = items[j]!.ct;

      const swap = items[i]!.key > items[j]!.key;
      const src0 = swap ? left1 : left0;
      const src1 = swap ? left0 : left1;

      const out0Res = reencryptAvoidingC1Collisions(rng, pk, src0, [left0.c1, left1.c1]);
      const out1Res = reencryptAvoidingC1Collisions(rng, pk, src1, [left0.c1, left1.c1]);

      const out0 = out0Res.ct;
      const out1 = out1Res.ct;

      const sp = proveSwitch({
        pk,
        in0: left0,
        in1: left1,
        out0,
        out1,
        swapped: swap,
        rho0: out0Res.rho,
        rho1: out1Res.rho,
        rng,
        context,
      });
      switchProofs.push(encodeSwitchProof(sp));

      deckOutRound[i] = out0;
      deckOutRound[j] = out1;

      next[i]!.ct = out0;
      next[j]!.ct = out1;
      if (swap) {
        const tmpK = next[i]!.key;
        next[i]!.key = next[j]!.key;
        next[j]!.key = tmpK;
      }
    }

    // Singles: plain eqdlog re-encryption proofs.
    for (const idx of singles) {
      const inCt = items[idx]!.ct;
      const rho = sampleNonzeroScalar(rng);
      const outCt = elgamalReencrypt(pk, inCt, rho);

      // Prove that (out.c1 - in.c1) = rho*G and (out.c2 - in.c2) = rho*pk
      const X = outCt.c1.subtract(inCt.c1);
      const Y = outCt.c2.subtract(inCt.c2);

      const p = proveEqDlog({ domain: DOMAIN_REENC, A: G, B: pk, X, Y, x: rho, rng, context });
      singleProofs.push(encodeEqDlogProofV1(p));

      deckOutRound[idx] = outCt;
      next[idx]!.ct = outCt;
    }

    // Deck snapshot bytes (post-round).
    const deckBytes = new Uint8Array(n * 64);
    for (let i = 0; i < n; i++) deckBytes.set(encodeCiphertext(deckOutRound[i]!), i * 64);
    // v1 encoding order per round:
    //  1) deck snapshot
    //  2) switch proofs (pairs, ascending indices)
    //  3) single proofs (singles, ascending indices)
    proofChunks.push(deckBytes, ...switchProofs, ...singleProofs);

    // Advance
    for (let i = 0; i < n; i++) items[i] = next[i]!;
  }

  const deckOut = items.map((it) => it.ct);

  return { deckOut, proofBytes: concatBytes(...proofChunks) };
}

// Verify a shuffle proof. `context` must be supplied when verifying a v2
// proof (and must match byte-for-byte what the prover bound); it must be
// omitted (undefined) when verifying a legacy v1 proof. Mismatches surface as
// "unsupported version" or as inner-proof failures.
export function shuffleVerifyV1(
  pk: GroupElement,
  deckIn: ElGamalCiphertext[],
  proofBytes: Uint8Array,
  context?: Uint8Array,
): ShuffleVerifyResult {
  try {
    const rd = new Reader(proofBytes);
    const version = rd.takeU8();
    let ctx: Uint8Array | undefined;
    if (version === SHUFFLE_PROOF_V1_VERSION) {
      if (context !== undefined) {
        return { ok: false, error: "context supplied for v1 proof; v1 must omit context" };
      }
      ctx = undefined;
    } else if (version === SHUFFLE_PROOF_V2_VERSION) {
      if (context === undefined) {
        return { ok: false, error: "context required for v2 proof" };
      }
      if (context.length === 0) {
        return { ok: false, error: "context must be non-empty for v2" };
      }
      ctx = context;
    } else {
      return { ok: false, error: `unsupported version ${version}` };
    }
    const n = rd.takeU16LE();
    const rounds = rd.takeU16LE();
    if (version === SHUFFLE_PROOF_V2_VERSION) {
      const ctxLen = rd.takeU16LE();
      const ctxBytes = rd.take(ctxLen);
      // Compare expected context (caller-supplied) vs embedded bytes.
      if (ctxBytes.length !== ctx!.length) {
        return { ok: false, error: "context length mismatch" };
      }
      for (let i = 0; i < ctxBytes.length; i++) {
        if (ctxBytes[i] !== ctx![i]) return { ok: false, error: "context mismatch" };
      }
    }
    if (n !== deckIn.length) return { ok: false, error: `n mismatch: proof n=${n}, deck n=${deckIn.length}` };
    if (n < 2) return { ok: false, error: "deck too small" };
    if (rounds <= 0) return { ok: false, error: "rounds must be > 0" };

    let cur: ElGamalCiphertext[] = deckIn.slice();
    let next: ElGamalCiphertext[] = new Array(n);

    for (let round = 0; round < rounds; round++) {
      const start = round & 1;
      const deckBytes = rd.take(n * 64);
      for (let i = 0; i < n; i++) {
        next[i] = decodeCiphertext(deckBytes.subarray(i * 64, i * 64 + 64));
      }

      // 2) Switch proofs (pairs in order)
      for (let i = start; i + 1 < n; i += 2) {
        const j = i + 1;
        const sp = decodeSwitchProofFromReader(rd);
        const ok = verifySwitch({ pk, in0: cur[i]!, in1: cur[j]!, out0: next[i]!, out1: next[j]!, proof: sp, context: ctx });
        if (!ok) return { ok: false, error: `invalid switch proof at round=${round} pair=(${i},${j})` };
      }

      // 3) Single proofs (singles in order)
      if (n % 2 === 1) {
        const idx = start === 0 ? n - 1 : 0;
        const p = decodeEqDlogProofFromReader(rd);
        if (pointEq(next[idx]!.c1, cur[idx]!.c1)) {
          return { ok: false, error: `single not rerandomized at round=${round} idx=${idx}` };
        }
        const X = next[idx]!.c1.subtract(cur[idx]!.c1);
        const Y = next[idx]!.c2.subtract(cur[idx]!.c2);
        const ok = verifyEqDlog({ domain: DOMAIN_REENC, A: G, B: pk, X, Y, proof: p, context: ctx });
        if (!ok) return { ok: false, error: `invalid single proof at round=${round} idx=${idx}` };
      } else if (start === 1) {
        const singleIdx0 = 0;
        {
          const p = decodeEqDlogProofFromReader(rd);
          if (pointEq(next[singleIdx0]!.c1, cur[singleIdx0]!.c1)) {
            return { ok: false, error: `single not rerandomized at round=${round} idx=${singleIdx0}` };
          }
          const X = next[singleIdx0]!.c1.subtract(cur[singleIdx0]!.c1);
          const Y = next[singleIdx0]!.c2.subtract(cur[singleIdx0]!.c2);
          const ok = verifyEqDlog({ domain: DOMAIN_REENC, A: G, B: pk, X, Y, proof: p, context: ctx });
          if (!ok) return { ok: false, error: `invalid single proof at round=${round} idx=${singleIdx0}` };
        }

        const singleIdxLast = n - 1;
        {
          const p = decodeEqDlogProofFromReader(rd);
          if (pointEq(next[singleIdxLast]!.c1, cur[singleIdxLast]!.c1)) {
            return { ok: false, error: `single not rerandomized at round=${round} idx=${singleIdxLast}` };
          }
          const X = next[singleIdxLast]!.c1.subtract(cur[singleIdxLast]!.c1);
          const Y = next[singleIdxLast]!.c2.subtract(cur[singleIdxLast]!.c2);
          const ok = verifyEqDlog({ domain: DOMAIN_REENC, A: G, B: pk, X, Y, proof: p, context: ctx });
          if (!ok) return { ok: false, error: `invalid single proof at round=${round} idx=${singleIdxLast}` };
        }
      }

      const finished = cur;
      cur = next;
      next = finished;
    }

    if (!rd.done()) return { ok: false, error: "trailing bytes in proof" };
    return { ok: true, deckOut: cur };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

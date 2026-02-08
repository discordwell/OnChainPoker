import { elgamalEncrypt, mulBase } from "@onchainpoker/ocp-crypto";
import { shuffleProveV1, shuffleVerifyV1 } from "../index.js";

function makeDeck(pk: any, n: number): any[] {
  const deck: any[] = [];
  for (let i = 0; i < n; i++) {
    const m = mulBase(BigInt(i + 1));
    const r = BigInt(i + 1000);
    deck.push(elgamalEncrypt(pk, m, r));
  }
  return deck;
}

function nowMs(): number {
  // @ts-ignore
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

async function main() {
  const n = 52;
  const rounds = Number(process.env.OCP_SHUFFLE_ROUNDS ?? 10);
  const reps = [16, 24, 32, 40, 48, 56, 64];
  const samples = Number(process.env.OCP_SHUFFLE_SAMPLES ?? 3);
  const exact = process.env.OCP_SHUFFLE_EXACT === "1";

  const pk = mulBase(123n);
  const deckIn = makeDeck(pk, n);

  const { proofBytes } = shuffleProveV1(pk, deckIn, { seed: new Uint8Array(32).fill(2), rounds });

  // Warmup
  const warm = shuffleVerifyV1(pk, deckIn, proofBytes);
  if (!warm.ok) throw new Error(`warmup verify failed: ${warm.error}`);

  console.log(`n=${n} rounds=${rounds} proofBytes=${proofBytes.length}`);

  // Estimate per-proof verify time from a few samples, then extrapolate.
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t0 = nowMs();
    const vr = shuffleVerifyV1(pk, deckIn, proofBytes);
    if (!vr.ok) throw new Error(`verify failed at sample=${i}: ${vr.error}`);
    const t1 = nowMs();
    times.push(t1 - t0);
  }
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);
  console.log(`per_proof_ms_mean=${mean.toFixed(2)} min=${min.toFixed(2)} max=${max.toFixed(2)} samples=${samples}`);

  for (const k of reps) {
    console.log(`committee=${k} verify_total_ms_est=${(mean * k).toFixed(2)}`);
  }

  if (exact) {
    for (const k of reps) {
      const t0 = nowMs();
      for (let i = 0; i < k; i++) {
        const vr = shuffleVerifyV1(pk, deckIn, proofBytes);
        if (!vr.ok) throw new Error(`verify failed at i=${i}: ${vr.error}`);
      }
      const t1 = nowMs();
      const total = t1 - t0;
      console.log(`committee=${k} verify_total_ms_exact=${total.toFixed(2)} per_proof_ms=${(total / k).toFixed(2)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

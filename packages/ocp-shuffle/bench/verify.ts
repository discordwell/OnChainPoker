import { elgamalEncrypt, mulBase } from "@onchainpoker/ocp-crypto";
import { shuffleProveV1, shuffleVerifyV1 } from "../index.js";

function parseCommiteeSizes(value: string | undefined, fallback: number[]): number[] {
  if (!value) return fallback;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

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

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[idx]!;
}

function printStats(label: string, values: number[]): void {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const p50 = percentile(values, 0.5);
  const p95 = percentile(values, 0.95);
  const p99 = percentile(values, 0.99);
  const opsPerSec = (1000 * values.length) / values.reduce((a, b) => a + b, 0);
  console.log(
    `${label} count=${values.length} mean_ms=${mean.toFixed(2)} min_ms=${min.toFixed(2)} max_ms=${max.toFixed(2)} p50_ms=${p50.toFixed(
      2,
    )} p95_ms=${p95.toFixed(2)} p99_ms=${p99.toFixed(2)} throughput_per_sec=${opsPerSec.toFixed(2)}`,
  );
}

async function main() {
  const n = 52;
  const rounds = Number(process.env.OCP_SHUFFLE_ROUNDS ?? 10);
  const reps = parseCommiteeSizes(process.env.OCP_SHUFFLE_COMMITTEE, [16, 24, 32, 40, 48, 56, 64]);
  const samples = Number(process.env.OCP_SHUFFLE_SAMPLES ?? 3);
  const exact = process.env.OCP_SHUFFLE_EXACT === "1";

  const pk = mulBase(123n);
  const deckIn = makeDeck(pk, n);

  const { proofBytes } = shuffleProveV1(pk, deckIn, { seed: new Uint8Array(32).fill(2), rounds });

  // Warmup
  const warm = shuffleVerifyV1(pk, deckIn, proofBytes);
  if (!warm.ok) throw new Error(`warmup verify failed: ${warm.error}`);

  console.log(`n=${n} rounds=${rounds} proofBytes=${proofBytes.length}`);

  if (reps.length === 0) {
    throw new Error("committee list is empty");
  }

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
    const mean = total / k;
    const throughput = k / (total / 1000);
    console.log(
      `committee=${k} verify_total_ms_exact=${total.toFixed(2)} per_proof_ms_exact=${mean.toFixed(2)} throughput_per_sec_exact=${throughput.toFixed(2)}`,
    );
    }
  }

  printStats("single-shot", times);
  for (const k of reps) {
    console.log(`committee=${k} estimate_per_proof_ms=${mean.toFixed(2)} estimate_total_ms=${(mean * k).toFixed(2)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

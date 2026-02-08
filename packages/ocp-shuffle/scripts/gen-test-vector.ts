import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { elgamalEncrypt, mulBase } from "@onchainpoker/ocp-crypto";
import { shuffleProveV1, shuffleVerifyV1 } from "../index.js";

function makeDeck(pk: any, n: number): any[] {
  const deck: any[] = [];
  for (let i = 0; i < n; i++) {
    const m = mulBase(BigInt(i + 1));
    const r = BigInt(i + 4242);
    deck.push(elgamalEncrypt(pk, m, r));
  }
  return deck;
}

function main() {
  const n = 52;
  const rounds = 52;
  const seed = new Uint8Array(32).fill(5);

  const pk = mulBase(123n);
  const deckIn = makeDeck(pk, n);

  const { proofBytes } = shuffleProveV1(pk, deckIn, { seed, rounds });
  const vr = shuffleVerifyV1(pk, deckIn, proofBytes);
  if (!vr.ok) throw new Error(`self-check failed: ${vr.error}`);

  const outDir = join(process.cwd(), "test-vectors");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `shuffle_v1_n${n}_r${rounds}.bin`);
  writeFileSync(outPath, proofBytes);
  // eslint-disable-next-line no-console
  console.log(`wrote ${outPath} (${proofBytes.length} bytes)`);
}

main();

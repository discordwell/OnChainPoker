import {
  deriveHandPublicKey,
  deriveHandScalar,
  deriveHandSecretShare,
  publicKeyFromSecret,
  reconstructSecretFromShares,
  runDkg
} from "./dkg.js";
import { GROUP } from "./params.js";

function pickFirstT(map, t) {
  const out = [];
  for (const [id, share] of map.entries()) {
    out.push({ id, share });
    if (out.length >= t) break;
  }
  return out;
}

function main() {
  const epochId = 1;
  const committeeIds = [1, 2, 3, 4, 5];
  const threshold = 3;

  const res = runDkg({ epochId, committeeIds, threshold, seed: "demo" });
  if (!res.ok) {
    console.log("DKG failed:", res.reason);
    process.exitCode = 1;
    return;
  }

  const secret = reconstructSecretFromShares(pickFirstT(res.shares, threshold));
  console.log("epochId:", epochId);
  console.log("QUAL:", res.qual);
  console.log("PK_epoch:", res.pkEpoch.toString(10));
  console.log("PK_epoch (from secret):", publicKeyFromSecret(secret).toString(10));
  console.log("transcriptRoot:", res.transcriptRoot);

  const k = deriveHandScalar(epochId, 123, 456);
  const pkHand = deriveHandPublicKey(res.pkEpoch, k);
  const secretHand = (secret * k) % GROUP.q;
  console.log("k:", k.toString(10));
  console.log("PK_hand:", pkHand.toString(10));
  console.log("PK_hand (from secret*k):", publicKeyFromSecret(secretHand).toString(10));

  // Example derived shares:
  for (const [id, sk] of res.shares.entries()) {
    const skHand = deriveHandSecretShare(sk, k);
    console.log(`sk_${id}_hand:`, skHand.toString(10));
  }
}

main();

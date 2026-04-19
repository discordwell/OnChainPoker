import { createHash } from "node:crypto";

import { hashToScalar } from "./hash.js";
import { addMod, mod, mulMod, powMod } from "./math.js";
import { GROUP } from "./params.js";
import { evalPoly, lagrangeInterpolateAt0 } from "./poly.js";
import { transcriptRoot } from "./transcript.js";

function hmacToy(key, msg) {
  // Toy "signature": H(key || msg). NOT secure; only for prototype evidence plumbing.
  const h = createHash("sha256");
  h.update(Buffer.from(String(key), "utf8"));
  h.update(Buffer.from("\0", "utf8"));
  h.update(Buffer.from(msg, "utf8"));
  return h.digest("hex");
}

function shareMsgToString(m) {
  return `DKGShare|${m.epochId}|${m.from}|${m.to}|${m.share}`;
}

function signShare(toySigningKey, shareMsg) {
  return hmacToy(toySigningKey, shareMsgToString(shareMsg));
}

function verifyShareSig(toySigningKey, shareMsg) {
  return signShare(toySigningKey, shareMsg) === shareMsg.sig;
}

function verifyShareAgainstCommitments(commitments, toId, share) {
  const { p, q, g } = GROUP;
  const x = BigInt(toId);
  const lhs = powMod(g, mod(share, q), p);
  let rhs = 1n;
  // rhs = Π C_k^{x^k}
  let xPow = 1n; // x^0
  for (const Ck of commitments) {
    rhs = (rhs * powMod(Ck, xPow, p)) % p;
    xPow = mod(xPow * x, q);
  }
  return lhs === rhs;
}

function makeCommitments(coeffs) {
  const { p, g } = GROUP;
  return coeffs.map((a) => powMod(g, a, p));
}

export function verifyDkgTranscript({ epochId, committeeIds, threshold, onchain }) {
  const { p } = GROUP;

  const commits = new Map(); // dealerId -> commitments[]
  const complaints = [];
  const reveals = new Map(); // `${dealer}|${to}` -> share

  for (const msg of onchain) {
    if (msg.epochId !== epochId) continue;
    if (msg.type === "DKGCommit") commits.set(msg.dealerId, msg.commitments);
    else if (msg.type === "DKGComplaintMissing" || msg.type === "DKGComplaintInvalid") complaints.push(msg);
    else if (msg.type === "DKGShareReveal") reveals.set(`${msg.dealer}|${msg.to}`, msg.share);
  }

  const slashed = new Set();

  // Missing commit is objectively slashable.
  for (const id of committeeIds) {
    if (!commits.has(id)) slashed.add(id);
  }

  // Complaint resolution rules (deterministic, chain-verifiable).
  for (const c of complaints) {
    const dealerId = c.dealer;
    const toId = c.complainer;

    if (slashed.has(dealerId)) continue;
    const dealerCommitments = commits.get(dealerId);
    if (!dealerCommitments) {
      slashed.add(dealerId);
      continue;
    }

    const revealShare = reveals.get(`${dealerId}|${toId}`);
    if (revealShare === undefined) {
      slashed.add(dealerId);
      continue;
    }

    const okReveal = verifyShareAgainstCommitments(dealerCommitments, toId, BigInt(revealShare));
    if (!okReveal) {
      slashed.add(dealerId);
      continue;
    }

    if (c.type === "DKGComplaintInvalid") {
      // Equivocation: dealer-signed share in complaint vs revealed share differ.
      // (Signature verification is omitted in this toy prototype; see docs/DKG.md.)
      if (BigInt(c.shareMsg.share) !== BigInt(revealShare)) slashed.add(dealerId);
    }
  }

  const qual = committeeIds.filter((id) => !slashed.has(id));
  const ok = qual.length >= threshold;

  let pkEpoch = null;
  if (ok) {
    let pk = 1n;
    for (const id of qual) {
      const C0 = commits.get(id)[0];
      pk = (pk * C0) % p;
    }
    pkEpoch = pk;
  }

  return {
    ok,
    epochId,
    threshold,
    committeeIds,
    qual,
    slashed: Array.from(slashed).sort((a, b) => a - b),
    pkEpoch
  };
}

export function deriveHandScalar(epochId, tableId, handId) {
  const { q } = GROUP;
  return hashToScalar(q, "OCP/handkey/v1", epochId, tableId, handId);
}

export function deriveHandPublicKey(pkEpoch, k) {
  const { p } = GROUP;
  return powMod(pkEpoch, k, p);
}

export function deriveHandSecretShare(sk, k) {
  const { q } = GROUP;
  return mod(sk * k, q);
}

export function reconstructSecretFromShares(shares) {
  // shares: [{id, share}]
  const { q } = GROUP;
  return lagrangeInterpolateAt0(
    shares.map(({ id, share }) => ({ x: BigInt(id), y: BigInt(share) })),
    q
  );
}

export function publicKeyFromSecret(secret) {
  const { p, g, q } = GROUP;
  return powMod(g, mod(secret, q), p);
}

export function runDkg({
  epochId,
  committeeIds,
  threshold,
  seed = "seed",
  byzantine = {}
}) {
  const { q, p } = GROUP;
  const N = committeeIds.length;
  const t = threshold;

  const byzEquiv = new Map(); // dealerId -> Set(targetId)
  for (const e of byzantine.equivocate ?? []) {
    if (!byzEquiv.has(e.dealerId)) byzEquiv.set(e.dealerId, new Set());
    byzEquiv.get(e.dealerId).add(e.targetId);
  }

  const byzWithhold = new Map(); // dealerId -> Set(targetId|'*')
  for (const w of byzantine.withhold ?? []) {
    if (!byzWithhold.has(w.dealerId)) byzWithhold.set(w.dealerId, new Set());
    const targets = w.targets ?? ["*"];
    for (const target of targets) byzWithhold.get(w.dealerId).add(target);
  }

  const noReveal = new Set(byzantine.noReveal ?? []);

  // Toy per-validator signing keys. In production this is validator consensus identity.
  const signKeys = new Map();
  for (const id of committeeIds) signKeys.set(id, `${seed}|sign|${epochId}|${id}`);

  // Round 1: each dealer samples polynomial and posts commitments.
  const dealers = new Map(); // id -> { coeffs, commitments }
  const onchain = [];

  for (const id of committeeIds) {
    const coeffs = [];
    // Deterministic "random" coefficients derived from hash(seed,...)
    for (let k = 0; k < t; k++) {
      coeffs.push(hashToScalar(q, "OCP/dkg/coef/v1", seed, epochId, id, k));
    }
    const commitments = makeCommitments(coeffs);
    dealers.set(id, { coeffs, commitments });
    onchain.push({
      type: "DKGCommit",
      epochId,
      dealerId: id,
      commitments
    });
  }

  // Round 2: share send (off-chain)
  const shares = new Map(); // toId -> Map(fromId -> shareMsg)
  for (const toId of committeeIds) shares.set(toId, new Map());

  for (const fromId of committeeIds) {
    const { coeffs } = dealers.get(fromId);
    for (const toId of committeeIds) {
      const withholdTargets = byzWithhold.get(fromId);
      const isWithheld =
        withholdTargets?.has("*") || withholdTargets?.has(toId) || false;
      if (isWithheld) continue;

      let share = evalPoly(coeffs, BigInt(toId), q);

      if (byzEquiv.get(fromId)?.has(toId)) {
        // Send a share that is invalid w.r.t commitments (equivocation).
        share = addMod(share, 1n, q);
      }

      const msg = {
        type: "DKGShare",
        epochId,
        from: fromId,
        to: toId,
        share,
        sig: ""
      };
      msg.sig = signShare(signKeys.get(fromId), msg);
      shares.get(toId).set(fromId, msg);
    }
  }

  // Round 3: complaints (on-chain)
  const complaints = [];
  for (const toId of committeeIds) {
    for (const fromId of committeeIds) {
      if (fromId === toId) {
        // still must receive own share; treat uniformly
      }
      const shareMsg = shares.get(toId).get(fromId);
      if (!shareMsg) {
        complaints.push({
          type: "DKGComplaintMissing",
          epochId,
          complainer: toId,
          dealer: fromId
        });
        continue;
      }

      const okSig = verifyShareSig(signKeys.get(fromId), shareMsg);
      const okShare = verifyShareAgainstCommitments(
        dealers.get(fromId).commitments,
        toId,
        shareMsg.share
      );
      if (!okSig || !okShare) {
        complaints.push({
          type: "DKGComplaintInvalid",
          epochId,
          complainer: toId,
          dealer: fromId,
          shareMsg
        });
      }
    }
  }
  onchain.push(...complaints);

  // Round 4: reveals (on-chain) + deterministic slashing
  const slashed = new Set();
  const reveals = [];

  for (const c of complaints) {
    const dealerId = c.dealer;
    const toId = c.complainer;
    if (slashed.has(dealerId)) continue;

    if (noReveal.has(dealerId)) {
      slashed.add(dealerId);
      continue;
    }

    const { coeffs, commitments } = dealers.get(dealerId);
    const correctShare = evalPoly(coeffs, BigInt(toId), q);

    const reveal = {
      type: "DKGShareReveal",
      epochId,
      dealer: dealerId,
      to: toId,
      share: correctShare
    };
    reveals.push(reveal);

    const ok = verifyShareAgainstCommitments(commitments, toId, reveal.share);
    if (!ok) {
      slashed.add(dealerId);
      continue;
    }

    if (c.type === "DKGComplaintInvalid") {
      // If the complaint includes a dealer-signed share, revealing a different
      // share is slashable equivocation (even if the reveal is valid).
      if (BigInt(c.shareMsg.share) !== BigInt(reveal.share)) {
        slashed.add(dealerId);
        continue;
      }
    }
  }
  onchain.push(...reveals);

  const qual = committeeIds.filter((id) => !slashed.has(id));

  const ok = qual.length >= t;
  if (!ok) {
    return {
      ok: false,
      reason: `QUAL size ${qual.length} < threshold ${t}`,
      epochId,
      threshold: t,
      committeeIds,
      qual,
      slashed: Array.from(slashed).sort((a, b) => a - b),
      pkEpoch: null,
      shares: new Map(),
      transcriptRoot: transcriptRoot(onchain),
      transcript: { onchain, shares }
    };
  }

  // Compute PK_epoch from QUAL dealers' commitments.
  let pkEpoch = 1n;
  for (const id of qual) {
    const C0 = dealers.get(id).commitments[0];
    pkEpoch = (pkEpoch * C0) % p;
  }

  // Compute per-validator shares (only for remaining committee members).
  const outShares = new Map(); // id -> scalar
  for (const toId of qual) {
    let sk = 0n;
    for (const fromId of qual) {
      const { coeffs } = dealers.get(fromId);
      sk = addMod(sk, evalPoly(coeffs, BigInt(toId), q), q);
    }
    outShares.set(toId, sk);
  }

  return {
    ok: true,
    epochId,
    threshold: t,
    committeeIds,
    qual,
    slashed: Array.from(slashed).sort((a, b) => a - b),
    pkEpoch,
    shares: outShares,
    transcriptRoot: transcriptRoot(onchain),
    transcript: { onchain, shares }
  };
}

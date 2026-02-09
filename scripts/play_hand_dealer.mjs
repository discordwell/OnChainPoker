#!/usr/bin/env node

import process from "node:process";
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";

import { OcpV0Client } from "../packages/ocp-sdk/dist/index.js";
import {
  CURVE_ORDER,
  GroupElement,
  bytesToHex,
  concatBytes,
  hashToScalar,
  groupElementFromBytes,
  groupElementToBytes,
  mulBase,
  mulPoint,
  pointAdd,
  pointEq,
  pointSub,
  scalarAdd,
  scalarFromBytesModOrder,
  scalarMul,
  scalarToBytes,
  chaumPedersenProve,
  encodeChaumPedersenProof,
  encShareProve,
  encodeEncShareProof,
} from "../packages/ocp-crypto/dist/index.js";
import { shuffleProveV1 } from "../packages/ocp-shuffle/dist/index.js";

const RPC = process.env.OCP_RPC ?? "http://127.0.0.1:26657";

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function unb64(str) {
  return new Uint8Array(Buffer.from(String(str), "base64"));
}

function b64urlToBytes(str) {
  const s = String(str);
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// v0 tx auth: ed25519 signature over (type, nonce, signer, sha256(valueJson)).
let txNonceCtr = 0n;
function nextTxNonce() {
  // Numeric u64 string, strictly increasing for replay protection.
  txNonceCtr++;
  return (BigInt(Date.now()) * 1000000n + txNonceCtr).toString();
}

function txAuthSignBytesV0({ type, value, nonce, signer }) {
  const valueBytes = Buffer.from(JSON.stringify(value), "utf8");
  const valueHash = createHash("sha256").update(valueBytes).digest();
  return Buffer.concat([
    Buffer.from("ocp/tx/v0", "utf8"),
    Buffer.from([0]),
    Buffer.from(String(type), "utf8"),
    Buffer.from([0]),
    Buffer.from(String(nonce), "utf8"),
    Buffer.from([0]),
    Buffer.from(String(signer), "utf8"),
    Buffer.from([0]),
    valueHash,
  ]);
}

function signedEnv({ type, value, signerId, signerSk }) {
  const nonce = nextTxNonce();
  const msg = txAuthSignBytesV0({ type, value, nonce, signer: signerId });
  const sig = cryptoSign(null, msg, signerSk);
  return { type, value, nonce, signer: signerId, sig: b64(sig) };
}

function u64le(n) {
  const x = BigInt(n);
  const b = new Uint8Array(8);
  let v = x;
  for (let i = 0; i < 8; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

function modQ(x) {
  const r = x % CURVE_ORDER;
  return r >= 0n ? r : r + CURVE_ORDER;
}

function invQ(a) {
  // Extended Euclid mod CURVE_ORDER.
  let t = 0n;
  let newT = 1n;
  let r = CURVE_ORDER;
  let newR = modQ(a);
  while (newR !== 0n) {
    const q = r / newR;
    [t, newT] = [newT, t - q * newT];
    [r, newR] = [newR, r - q * newR];
  }
  if (r !== 1n) throw new Error("invQ: not invertible");
  return t < 0n ? t + CURVE_ORDER : t;
}

function lagrangeAtZero(idxs) {
  // idxs: bigint[], distinct non-zero.
  return idxs.map((xi, i) => {
    let num = 1n;
    let den = 1n;
    for (let j = 0; j < idxs.length; j++) {
      if (i === j) continue;
      const xj = idxs[j];
      num = modQ(num * modQ(-xj));
      den = modQ(den * modQ(xi - xj));
    }
    return modQ(num * invQ(den));
  });
}

function randomScalarNonzero() {
  while (true) {
    const s = scalarFromBytesModOrder(randomBytes(64));
    if (s !== 0n) return s;
  }
}

function evalPoly(coeffs, x) {
  // coeffs: Scalar[], f(x) = a0 + a1*x + ... + a_{t-1}*x^{t-1}
  let acc = 0n;
  let pow = 1n;
  for (const a of coeffs) {
    acc = scalarAdd(acc, scalarMul(a, pow));
    pow = scalarMul(pow, x);
  }
  return acc;
}

function cardToString(id) {
  const c = Number(id);
  const r = (c % 13) + 2;
  const s = Math.floor(c / 13);
  const rch =
    r === 14 ? "A" :
    r === 13 ? "K" :
    r === 12 ? "Q" :
    r === 11 ? "J" :
    r === 10 ? "T" :
    String(r);
  const sch = s === 0 ? "c" : s === 1 ? "d" : s === 2 ? "h" : "s";
  return `${rch}${sch}`;
}

function findCardIdFromPoint(pt, deckSize = 52) {
  for (let c = 0; c < deckSize; c++) {
    const want = mulBase(BigInt(c + 1));
    if (pointEq(pt, want)) return c;
  }
  return null;
}

function seatPlayer(table, seatIdx) {
  const s = table?.seats?.[seatIdx];
  return s?.player ?? null;
}

function toCallForSeat(table, seatIdx) {
  const h = table?.hand;
  if (!h) return 0;
  const betTo = Number(h.betTo ?? 0);
  const streetCommit = Number(h.streetCommit?.[seatIdx] ?? 0);
  return Math.max(0, betTo - streetCommit);
}

function parseTableIdFromTxResult(txResult) {
  const events = txResult?.events ?? [];
  const tableCreated = events.find((e) => e.type === "TableCreated");
  const tableId = Number((tableCreated?.attributes ?? []).find((a) => a.key === "tableId")?.value ?? "0");
  if (!tableId) throw new Error("could not parse tableId from TableCreated event");
  return tableId;
}

function parseHandStartedFromTxResult(txResult) {
  const events = txResult?.events ?? [];
  const handStarted = events.find((e) => e.type === "HandStarted");
  if (!handStarted) return null;
  const attrs = Object.fromEntries((handStarted.attributes ?? []).map((a) => [a.key, a.value]));
  const handId = Number(attrs.handId ?? "0");
  return Number.isFinite(handId) && handId > 0 ? handId : null;
}

function dealerExpectedPos(table) {
  const h = table?.hand;
  const dh = h?.dealer;
  if (!h || !dh) return null;
  if (!dh.finalized) throw new Error("dealerExpectedPos: deck not finalized");

  const phase = String(h.phase);
  if (phase === "awaitFlop" || phase === "awaitTurn" || phase === "awaitRiver") {
    return Number(dh.cursor) + Number(h.board?.length ?? 0);
  }
  if (phase === "awaitShowdown") {
    const holePos = dh.holePos ?? [];
    if (holePos.length !== 18) throw new Error("dealerExpectedPos: holePos missing/invalid");
    const reveals = new Set((dh.reveals ?? []).map((r) => Number(r.pos)));

    const eligible = [];
    for (let seat = 0; seat < 9; seat++) {
      if (!h.inHand?.[seat] || h.folded?.[seat]) continue;
      for (let c = 0; c < 2; c++) {
        const p = Number(holePos[seat * 2 + c] ?? 255);
        if (p === 255) continue;
        eligible.push(p);
      }
    }
    eligible.sort((a, b) => a - b);
    for (const p of eligible) {
      if (!reveals.has(p)) return p;
    }
    return null;
  }
  return null;
}

async function main() {
  const ocp = new OcpV0Client({ rpcUrl: RPC });

  const numPlayers = Math.min(9, Math.max(2, Number(process.env.OCP_PLAYERS ?? 3)));
  const committeeN = Math.min(9, Math.max(1, Number(process.env.OCP_COMMITTEE_N ?? 3)));
  const threshold = Math.min(committeeN, Math.max(1, Number(process.env.OCP_THRESHOLD ?? Math.min(2, committeeN))));
  // The chain requires the deck be shuffled by every QUAL committee member before finalization.
  const shuffleSteps = Math.min(committeeN, Math.max(1, Number(process.env.OCP_SHUFFLE_STEPS ?? committeeN)));
  const shuffleRounds = Math.max(2, Number(process.env.OCP_SHUFFLE_ROUNDS ?? 8));
  const requestedEpochId = Math.max(0, Number(process.env.OCP_EPOCH_ID ?? 0));

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ rpc: RPC, numPlayers, committeeN, threshold, shuffleSteps, shuffleRounds, requestedEpochId }, null, 2));

  // ---- Committee / epoch setup (v0: on-chain Feldman-style DKG) ----
  // Register a local validator set for committee sampling.
  const committee = Array.from({ length: committeeN }, (_, i) => {
    const index = i + 1; // DKG assigns indices deterministically by sorting validator ids; v1..vN => 1..N.
    const id = `v${index}`;
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" });
    const pkSignBytes = b64urlToBytes(jwk.x);
    if (pkSignBytes.length !== 32) throw new Error("unexpected ed25519 pubkey length");
    return { id, index, skShare: 0n, signSk: privateKey, signPkBytes: pkSignBytes };
  });
  const committeeById = new Map(committee.map((m) => [m.id, m]));
  for (const v of committee) {
    await ocp.bankMint({ to: v.id, amount: 100000 });
    await ocp.broadcastTxEnvelope(
      signedEnv({
        type: "staking/register_validator",
        value: { validatorId: v.id, pubKey: b64(v.signPkBytes), power: 1 },
        signerId: v.id,
        signerSk: v.signSk,
      })
    );
    await ocp.broadcastTxEnvelope(
      signedEnv({
        type: "staking/bond",
        value: { validatorId: v.id, amount: 1000 },
        signerId: v.id,
        signerSk: v.signSk,
      })
    );
  }

  // Begin epoch DKG. If the requested epoch id is wrong (state already advanced), omit epochId.
  const beginRes = await ocp.dealerBeginEpoch({
    epochId: requestedEpochId || undefined,
    committeeSize: committeeN,
    threshold,
    // Make commit window long enough for sequential broadcast_tx_commit submissions.
    commitBlocks: committeeN + 2,
    complaintBlocks: 2,
    revealBlocks: 2,
    finalizeBlocks: 2,
  });
  const begun = (beginRes.tx_result?.events ?? beginRes.deliver_tx?.events ?? []).find((e) => e.type === "DealerEpochBegun");
  const epochId = Number((begun?.attributes ?? []).find((a) => a.key === "epochId")?.value ?? "0");
  if (!epochId) throw new Error("could not parse epochId from DealerEpochBegun event");

  // Simulate all-honest DKG locally: each committee member posts coefficient commitments; shares are computed off-chain.
  const polys = committee.map((m, di) => ({
    dealerId: m.id,
    coeffs: Array.from({ length: threshold }, (_x, k) => randomScalarNonzero()),
  }));

  for (const p of polys) {
    const commitments = p.coeffs.map((a) => b64(groupElementToBytes(mulBase(a))));
    const dealer = committeeById.get(p.dealerId);
    if (!dealer) throw new Error(`missing dealer signing key for ${p.dealerId}`);
    await ocp.broadcastTxEnvelope(
      signedEnv({
        type: "dealer/dkg_commit",
        value: { epochId, dealerId: p.dealerId, commitments },
        signerId: dealer.id,
        signerSk: dealer.signSk,
      })
    );
  }

  // Derive epoch secret and per-validator shares (needed to produce decrypt shares later in this script).
  const skEpoch = polys.reduce((acc, p) => scalarAdd(acc, p.coeffs[0]), 0n);
  const pkEpoch = mulBase(skEpoch);
  for (const m of committee) {
    const x = BigInt(m.index);
    let sk = 0n;
    for (const p of polys) sk = scalarAdd(sk, evalPoly(p.coeffs, x));
    m.skShare = sk;
  }

  // Finalize once the chain's revealDeadline has passed (retry loop).
  for (;;) {
    try {
      await ocp.dealerFinalizeEpoch({ epochId });
      break;
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (!msg.includes("too early to finalize")) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // ---- Players ----
  const names = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi", "ivan"];
  const players = names.slice(0, numPlayers).map((player, i) => {
    const sk = randomScalarNonzero();
    const pk = mulBase(sk);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" });
    const pkSignBytes = b64urlToBytes(jwk.x);
    if (pkSignBytes.length !== 32) throw new Error("unexpected ed25519 pubkey length");
    return { player, seat: i, sk, pk, signSk: privateKey, signPkBytes };
  });

  for (const p of players) await ocp.bankMint({ to: p.player, amount: 100000 });

  for (const p of players) {
    await ocp.broadcastTxEnvelope(
      signedEnv({
        type: "auth/register_account",
        value: { account: p.player, pubKey: b64(p.signPkBytes) },
        signerId: p.player,
        signerSk: p.signSk,
      })
    );
  }

  const createRes = await ocp.broadcastTxEnvelope(
    signedEnv({
      type: "poker/create_table",
      value: {
        creator: players[0].player,
        smallBlind: 1,
        bigBlind: 2,
        minBuyIn: 100,
        maxBuyIn: 100000,
        label: "dealer-mode-localnet",
      },
      signerId: players[0].player,
      signerSk: players[0].signSk,
    })
  );
  const tableId = parseTableIdFromTxResult(createRes.tx_result ?? createRes.deliver_tx);

  for (const p of players) {
    await ocp.broadcastTxEnvelope(
      signedEnv({
        type: "poker/sit",
        value: {
          player: p.player,
          tableId,
          seat: p.seat,
          buyIn: 1000,
          pkPlayer: b64(groupElementToBytes(p.pk)),
        },
        signerId: p.player,
        signerSk: p.signSk,
      })
    );
  }

  const startRes = await ocp.broadcastTxEnvelope(
    signedEnv({
      type: "poker/start_hand",
      value: { caller: players[0].player, tableId },
      signerId: players[0].player,
      signerSk: players[0].signSk,
    })
  );
  const handIdFromEvent = parseHandStartedFromTxResult(startRes.tx_result ?? startRes.deliver_tx);

  let table = await ocp.getTable(tableId);
  if (!table?.hand?.dealer) throw new Error("expected dealer mode (missing table.hand.dealer)");
  const handId = Number(table.hand.handId ?? handIdFromEvent ?? 0);
  if (!handId) throw new Error("missing handId");
  if (String(table.hand.phase) !== "shuffle") throw new Error(`expected phase=shuffle, got ${table.hand.phase}`);

  // Derive per-hand scalar (matches apps/chain/internal/app/dealer.go deriveHandScalar()).
  const k = hashToScalar("ocp/v1/dealer/hand-derive", u64le(epochId), u64le(tableId), u64le(handId));

  // Sanity: chain's pkHand should equal pkEpoch * k.
  const pkHandExpected = mulPoint(pkEpoch, k);
  const pkHandChain = groupElementFromBytes(unb64(table.hand.dealer.pkHand));
  if (!pointEq(pkHandExpected, pkHandChain)) throw new Error("pkHand mismatch (script derivation != chain state)");

  // ---- Shuffle steps (committee members) ----
  for (let step = 1; step <= shuffleSteps; step++) {
    table = await ocp.getTable(tableId);
    const dh = table?.hand?.dealer;
    if (!dh) throw new Error("missing dealer hand");

    const pkHand = groupElementFromBytes(unb64(dh.pkHand));
    const deckIn = (dh.deck ?? []).map((ct) => ({
      c1: groupElementFromBytes(unb64(ct.c1)),
      c2: groupElementFromBytes(unb64(ct.c2)),
    }));

    const seed = randomBytes(32);
    const { proofBytes } = shuffleProveV1(pkHand, deckIn, { rounds: shuffleRounds, seed });
    const shuffler = committee[(step - 1) % committee.length];
    if (!shuffler) throw new Error("missing shuffler");

    await ocp.broadcastTxEnvelope(
      signedEnv({
        type: "dealer/submit_shuffle",
        value: { tableId, handId, round: step, shufflerId: shuffler.id, proofShuffle: b64(proofBytes) },
        signerId: shuffler.id,
        signerSk: shuffler.signSk,
      })
    );
  }

  await ocp.dealerFinalizeDeck({ tableId, handId });

  table = await ocp.getTable(tableId);
  if (!table?.hand?.dealer?.finalized) throw new Error("expected deck finalized");

  // Cache deck points post-finalization.
  const dh0 = table.hand.dealer;
  const deck = (dh0.deck ?? []).map((ct) => ({
    c1: groupElementFromBytes(unb64(ct.c1)),
    c2: groupElementFromBytes(unb64(ct.c2)),
  }));

  // ---- Encrypted decryption shares for hole cards ----
  const holePos = dh0.holePos ?? [];
  if (holePos.length !== 18) throw new Error("missing dealer.holePos after finalization");

  const shareMembers = committee.slice(0, threshold);

  for (const p of players) {
    for (let c = 0; c < 2; c++) {
      const pos = Number(holePos[p.seat * 2 + c] ?? 255);
      if (!Number.isFinite(pos) || pos < 0) throw new Error(`invalid holePos for seat=${p.seat} c=${c}`);

      const ct = deck[pos];
      if (!ct) throw new Error(`missing ciphertext at pos=${pos}`);
      const c1Cipher = ct.c1;
      for (const m of shareMembers) {
        const xHand = scalarMul(m.skShare, k);
        const yHand = mulBase(xHand);

        const d = mulPoint(c1Cipher, xHand); // decryption share
        const r = randomScalarNonzero();
        const u = mulBase(r);
        const v = pointAdd(d, mulPoint(p.pk, r));

        const wx = randomScalarNonzero();
        const wr = randomScalarNonzero();
        const proof = encShareProve({ y: yHand, c1: c1Cipher, pkP: p.pk, u, v, x: xHand, r, wx, wr });

        const encShareBytes = concatBytes(groupElementToBytes(u), groupElementToBytes(v));
        const proofBytes = encodeEncShareProof(proof);

        await ocp.broadcastTxEnvelope(
          signedEnv({
            type: "dealer/submit_enc_share",
            value: {
              tableId,
              handId,
              pos,
              validatorId: m.id,
              pkPlayer: b64(groupElementToBytes(p.pk)),
              encShare: b64(encShareBytes),
              proofEncShare: b64(proofBytes),
            },
            signerId: m.id,
            signerSk: m.signSk,
          })
        );
      }
    }
  }

  table = await ocp.getTable(tableId);
  if (!table?.hand?.dealer) throw new Error("hand missing after enc shares");
  if (String(table.hand.phase) !== "betting" && String(table.hand.phase) !== "awaitFlop") {
    throw new Error(`expected phase betting/awaitFlop after hole shares, got ${table.hand.phase}`);
  }

  // ---- Demonstrate off-chain hole card recovery (player privacy) ----
  // Players decrypt their own hole cards from encrypted shares (EncShares) + ciphertext at their assigned deck pos.
  const encSharesAll = table.hand.dealer.encShares ?? [];
  for (const p of players) {
    const cards = [];
    for (let c = 0; c < 2; c++) {
      const pos = Number(holePos[p.seat * 2 + c] ?? 255);
      const ct = deck[pos];
      if (!ct) throw new Error(`missing ciphertext at pos=${pos}`);

      const sharesForPos = encSharesAll
        .filter((es) => Number(es.pos) === pos && es.pkPlayer === b64(groupElementToBytes(p.pk)))
        .sort((a, b) => Number(a.index) - Number(b.index) || String(a.validatorId).localeCompare(String(b.validatorId)))
        .slice(0, threshold);
      if (sharesForPos.length < threshold) throw new Error(`insufficient encShares for seat=${p.seat} pos=${pos}`);

      const idxs = sharesForPos.map((s) => BigInt(s.index));
      const lambdas = lagrangeAtZero(idxs);

      let combined = GroupElement.zero();
      for (let i = 0; i < sharesForPos.length; i++) {
        const es = sharesForPos[i];
        if (!es) throw new Error(`missing encShare at i=${i}`);
        const bytes = unb64(es.encShare);
        const u = groupElementFromBytes(bytes.slice(0, 32));
        const v = groupElementFromBytes(bytes.slice(32, 64));
        const di = pointSub(v, mulPoint(u, p.sk));
        const lambda = lambdas[i];
        if (lambda == null) throw new Error(`missing lagrange coefficient at i=${i}`);
        combined = pointAdd(combined, mulPoint(di, lambda));
      }

      const pt = pointSub(ct.c2, combined);
      const cardId = findCardIdFromPoint(pt, Number(table.hand.dealer.deckSize ?? 52));
      if (cardId === null) throw new Error(`could not map plaintext to card id (seat=${p.seat} c=${c})`);
      cards.push(cardToString(cardId));
    }
    // eslint-disable-next-line no-console
    console.log(`seat=${p.seat} player=${p.player} hole=${cards.join(" ")}`);
  }

  // Optional: stop here to let a web client attach and decrypt hole cards locally from encShares.
  // (Keeps the hand active in betting/awaitFlop.)
  const stopAfter = String(process.env.OCP_STOP_AFTER ?? "").trim().toLowerCase();
  if (stopAfter === "hole" || stopAfter === "encshares") {
    const keys = players.map((p) => ({
      seat: p.seat,
      player: p.player,
      skHex: bytesToHex(scalarToBytes(p.sk)),
      pkBase64: b64(groupElementToBytes(p.pk)),
    }));
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ tableId, handId, keys }, null, 2));
    return;
  }

  // ---- Play out: check/call betting; reveals driven by dealer pub shares + finalize ----
  for (let step = 0; step < 2000; step++) {
    table = await ocp.getTable(tableId);
    const h = table?.hand;
    if (!h) break;

    const phase = String(h.phase);
    if (phase === "betting") {
      const actingSeat = Number(h.actionOn ?? -1);
      if (actingSeat < 0) throw new Error(`hand stuck: actionOn=${actingSeat}`);

      const player = seatPlayer(table, actingSeat);
      if (!player) throw new Error(`no player at actingSeat=${actingSeat}`);

      const toCall = toCallForSeat(table, actingSeat);
      const action = toCall === 0 ? "check" : "call";
      const p = players.find((x) => x.player === player);
      if (!p) throw new Error(`missing signer key for player=${player}`);
      await ocp.broadcastTxEnvelope(
        signedEnv({
          type: "poker/act",
          value: { player, tableId, action },
          signerId: player,
          signerSk: p.signSk,
        })
      );
      continue;
    }

    if (phase.startsWith("await")) {
      const pos = dealerExpectedPos(table);
      if (pos === null) throw new Error(`await phase ${phase} but no reveal pos found`);
      const ct = deck[pos];
      if (!ct) throw new Error(`missing ciphertext at pos=${pos}`);
      const c1Cipher = ct.c1;

      for (const m of shareMembers) {
        const xHand = scalarMul(m.skShare, k);
        const yHand = mulBase(xHand);
        const d = mulPoint(c1Cipher, xHand);
        const w = randomScalarNonzero();
        const proof = chaumPedersenProve({ y: yHand, c1: c1Cipher, d, x: xHand, w });
        const proofBytes = encodeChaumPedersenProof(proof);

        await ocp.broadcastTxEnvelope(
          signedEnv({
            type: "dealer/submit_pub_share",
            value: {
              tableId,
              handId,
              pos,
              validatorId: m.id,
              pubShare: b64(groupElementToBytes(d)),
              proofShare: b64(proofBytes),
            },
            signerId: m.id,
            signerSk: m.signSk,
          })
        );
      }

      await ocp.dealerFinalizeReveal({ tableId, handId, pos });
      continue;
    }

    if (phase === "showdown") {
      // The chain settles and clears the hand after showdown reveals.
      continue;
    }

    throw new Error(`unexpected phase: ${phase}`);
  }

  const finalTable = await ocp.getTable(tableId);
  const stacks = (finalTable?.seats ?? [])
    .map((s, idx) => (s ? { seat: idx, player: s.player, stack: s.stack } : null))
    .filter(Boolean);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ tableId, stacks }, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err?.stack || String(err));
  process.exit(1);
});

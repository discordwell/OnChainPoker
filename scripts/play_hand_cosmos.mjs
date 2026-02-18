#!/usr/bin/env node

import process from "node:process";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

import {
  CosmosLcdClient,
  connectOcpCosmosSigningClient,
  createOcpCosmosClient,
  createOcpRegistry,
  findEventAttr,
  parseHandIdFromTx,
  parseTableIdFromTx,
  walletFromMnemonic,
  walletFromPrivKey,
  walletGenerate,
} from "../packages/ocp-sdk/dist/index.js";

import {
  CURVE_ORDER,
  concatBytes,
  hashToScalar,
  mulBase,
  mulPoint,
  pointAdd,
  pointEq,
  pointSub,
  scalarFromBytesModOrder,
  scalarMul,
  groupElementFromBytes,
  groupElementToBytes,
} from "../packages/ocp-crypto/dist/index.js";
import { shuffleProveV1 } from "../packages/ocp-shuffle/dist/index.js";
import {
  chaumPedersenProve,
  encodeChaumPedersenProof,
  encShareProve,
  encodeEncShareProof,
} from "../packages/ocp-crypto/dist/index.js";

const RPC = (process.env.COSMOS_RPC_URL ?? "").trim() || "http://127.0.0.1:26657";
const LCD = (process.env.COSMOS_LCD_URL ?? "").trim() || "http://127.0.0.1:1317";
const PREFIX = (process.env.COSMOS_PREFIX ?? "").trim() || "ocp";
const GAS_PRICE = (process.env.COSMOS_GAS_PRICE ?? "").trim() || "0uocp";

const NUM_PLAYERS = Number(process.env.COSMOS_PLAYERS ?? "2");
const COMMITTEE_SIZE = Number(process.env.COSMOS_COMMITTEE_SIZE ?? "3");
const THRESHOLD = Number(process.env.COSMOS_THRESHOLD ?? "3");
const SHUFFLE_STEPS = Number(process.env.COSMOS_SHUFFLE_STEPS ?? COMMITTEE_SIZE);
const SHUFFLE_ROUNDS = Math.max(1, Number(process.env.COSMOS_SHUFFLE_ROUNDS ?? "8"));
const BUY_IN = BigInt(process.env.COSMOS_BUY_IN ?? "1000000");
const FAUCET_AMOUNT = BigInt(process.env.COSMOS_FAUCET_AMOUNT ?? "10000000");
const NO_FAUCET = (process.env.COSMOS_NO_FAUCET ?? "").trim() === "1";

const DKG_COMMIT_BLOCKS = Number(process.env.COSMOS_DKG_COMMIT_BLOCKS ?? "12");
const DKG_COMPLAINT_BLOCKS = Number(process.env.COSMOS_DKG_COMPLAINT_BLOCKS ?? "12");
const DKG_REVEAL_BLOCKS = Number(process.env.COSMOS_DKG_REVEAL_BLOCKS ?? "12");
const DKG_FINALIZE_BLOCKS = Number(process.env.COSMOS_DKG_FINALIZE_BLOCKS ?? "12");
const OCPD_NUM_NODES = Number(process.env.COSMOS_OCPD_NUM_NODES ?? process.env.OCPD_NUM_NODES ?? "3");

const OCPD_MULTI_HOME = (process.env.COSMOS_MULTI_HOME ?? process.env.OCPD_MULTI_HOME ?? `${process.cwd()}/apps/cosmos/.ocpd-multi`).trim();
const OCPD_BIN = (process.env.COSMOS_OCPD_BIN ?? process.env.OCPD_BIN ?? `${process.cwd()}/apps/cosmos/bin/ocpd`).trim();
const KEYRING_BACKEND = (process.env.COSMOS_KEYRING_BACKEND ?? "test").trim();
const NODE0_HOME = `${OCPD_MULTI_HOME}/node0`;
const OCP_NODE = (process.env.OCPD_NODE ?? RPC).replace(/^https?:\/\//, "tcp://").replace(/^http:/, "tcp:");

const NAME_TO_MNEMONIC = ["ALICE_MNEMONIC", "BOB_MNEMONIC", "CAROL_MNEMONIC"];

function nonzeroScalar() {
  while (true) {
    const s = scalarFromBytesModOrder(randomBytes(64));
    if (s !== 0n) return s;
  }
}

function u64le(v) {
  const out = new Uint8Array(8);
  let x = BigInt(v);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function modQ(n) {
  const x = n % CURVE_ORDER;
  return x < 0n ? x + CURVE_ORDER : x;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableNetworkError(err) {
  const msg = String(err?.message ?? err);
  return /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|socket hang up|network|fetch failed/i.test(msg);
}

async function withRetry(label, fn, { attempts = 8, delayMs = 400 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= attempts || !isRetriableNetworkError(err)) {
        throw err;
      }
      await sleepMs(delayMs * attempt);
    }
  }
  throw lastError ?? new Error(`${label}: unknown retry failure`);
}

function asNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asString(v) {
  if (v == null) return "";
  return String(v);
}

function pick(obj, ...keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) {
      return obj[k];
    }
  }
  return undefined;
}

function decodeBytes(raw) {
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return Uint8Array.from(raw.map((x) => Number(x)));
  if (typeof raw === "string" && raw.length > 0) {
    return Uint8Array.from(Buffer.from(raw, "base64"));
  }
  throw new Error(`unsupported bytes value: ${typeof raw}`);
}

function nodeHome(index) {
  const idx = Number(index);
  if (!Number.isFinite(idx) || idx < 0) return `${OCPD_MULTI_HOME}/node0`;
  return `${OCPD_MULTI_HOME}/node${idx}`;
}

function hexFromOutput(raw) {
  const text = asString(raw);
  const matches = text.match(/[0-9a-fA-F]{64}/g);
  if (!matches?.length) return "";
  return matches[matches.length - 1].toLowerCase();
}

function normalizePhase(raw) {
  const s = asString(raw).toLowerCase();
  const clean = s.startsWith("hand_phase_") ? s.slice("hand_phase_".length) : s;
  if (clean === "betting") return "betting";
  if (clean === "shuffle") return "shuffle";
  if (clean === "await_flop") return "awaitFlop";
  if (clean === "await_turn") return "awaitTurn";
  if (clean === "await_river") return "awaitRiver";
  if (clean === "await_showdown") return "awaitShowdown";
  if (clean === "showdown") return "showdown";
  return clean;
}

function toCallForSeat(table, seatIdx) {
  const h = table?.hand;
  if (!h) return 0;
  const betTo = asNumber(pick(h, "betTo", "bet_to")) ?? 0;
  const streetCommit = pick(h, "streetCommit", "street_commit");
  const committed = asNumber(Array.isArray(streetCommit) ? streetCommit[seatIdx] : undefined) ?? 0;
  return Math.max(0, betTo - committed);
}

function findPlayerAtSeat(table, seatIdx) {
  const seats = Array.isArray(table?.seats) ? table.seats : [];
  const seat = seats?.[seatIdx];
  return seat?.player ?? null;
}

function expectedRevealPos(table) {
  const h = table?.hand;
  const phase = normalizePhase(h?.phase);
  const dh = h?.dealer;
  if (!h || !dh) return null;

  const explicitRevealPos = asNumber(pick(dh, "revealPos", "reveal_pos"));
  if (explicitRevealPos != null && Number.isFinite(explicitRevealPos) && explicitRevealPos >= 0 && explicitRevealPos !== 255) {
    return explicitRevealPos;
  }

  if (phase === "awaitFlop" || phase === "awaitTurn" || phase === "awaitRiver") {
    const cursor = asNumber(dh.cursor) ?? 0;
    const boardLen = Array.isArray(h.board) ? h.board.length : 0;
    return cursor + boardLen;
  }

  if (phase === "awaitShowdown") {
    const holePosRaw = pick(dh, "holePos", "hole_pos");
    const holePos = Array.isArray(holePosRaw) ? holePosRaw.map(asNumber).filter(Number.isFinite) : [];
    if (holePos.length !== 18) return null;

    const reveals = new Set();
    for (const r of dh.reveals ?? []) {
      const rp = asNumber(r?.pos);
      if (rp != null && Number.isFinite(rp)) reveals.add(rp);
    }

    const inHandRaw = pick(h, "inHand", "in_hand");
    const inHand = Array.isArray(inHandRaw) ? inHandRaw : [];
    const folded = Array.isArray(h.folded) ? h.folded : [];
    const eligible = [];
    for (let seat = 0; seat < 9; seat++) {
      if (!inHand[seat] || folded[seat]) continue;
      const p0 = asNumber(holePos[seat * 2]);
      const p1 = asNumber(holePos[seat * 2 + 1]);
      if (p0 != null && p0 >= 0 && p0 !== 255) eligible.push(p0);
      if (p1 != null && p1 >= 0 && p1 !== 255) eligible.push(p1);
    }
    eligible.sort((a, b) => a - b);
    for (const pos of eligible) {
      if (!reveals.has(pos)) return pos;
    }
  }

  return null;
}

function decodeDeck(rawDeck) {
  return (rawDeck ?? []).map((entry, idx) => {
    if (!entry) throw new Error(`missing deck entry ${idx}`);
    return {
      c1: groupElementFromBytes(decodeBytes(entry.c1)),
      c2: groupElementFromBytes(decodeBytes(entry.c2)),
    };
  });
}

function runCli(bin, args, { env = {} } = {}) {
  const res = spawnSync(bin, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    const msg = String(res.stderr || res.stdout || "").trim();
    throw new Error(`command failed: ${bin} ${args.join(" ")} status=${res.status} ${msg}`);
  }
  return String(res.stdout ?? "").trim();
}

function faucet(toAddr, amount) {
  if (NO_FAUCET) return;
  const args = ["apps/cosmos/scripts/faucet.sh", asString(toAddr), asString(amount)];
  const res = spawnSync("bash", args, {
    stdio: "inherit",
    env: {
      ...process.env,
      OCPD_HOME: NODE0_HOME,
      OCPD_NODE: OCP_NODE,
      OCPD_KEYRING_BACKEND: KEYRING_BACKEND,
      OCPD_WAIT: "0",
    },
  });
  if (res.status !== 0) throw new Error(`faucet failed: exit=${res.status}`);
}

function getNodeValidatorAddress(node, bech) {
  const home = nodeHome(node);
  return runCli(OCPD_BIN, [
    "keys",
    "show",
    "validator",
    "-a",
    "--bech",
    bech,
    "--home",
    home,
    "--keyring-backend",
    KEYRING_BACKEND,
  ]).trim();
}

function getNodeValidatorPrivateKey(node) {
  const home = nodeHome(node);
  const out = runCli(OCPD_BIN, [
    "keys",
    "export",
    "validator",
    "--unarmored-hex",
    "--unsafe",
    "-y",
    "--home",
    home,
    "--keyring-backend",
    KEYRING_BACKEND,
  ]);
  const hex = hexFromOutput(out);
  if (!hex) {
    throw new Error(`could not export private key from ${home}`);
  }
  return hex;
}

async function mkValidatorClient(name, node) {
  const privateKeyHex = getNodeValidatorPrivateKey(node);
  const wallet = await walletFromPrivKey({ privateKeyHex, prefix: PREFIX });
  const [acct] = await wallet.getAccounts();
  const address = asString(acct?.address);
  if (!address) throw new Error(`${name}: wallet has no account`);

  const registry = createOcpRegistry();
  const signing = await withRetry(`${name}: connect signing client`, () =>
    connectOcpCosmosSigningClient({
      rpcUrl: RPC,
      lcdUrl: LCD,
      signer: wallet,
      gasPrice: GAS_PRICE,
      registry,
    }),
  );
  const lcd = new CosmosLcdClient({ baseUrl: LCD });

  const valAddress = getNodeValidatorAddress(node, "val").trim();
  if (!valAddress) {
    throw new Error(`${name}: missing valoper address`);
  }

  return {
    name,
    node,
    address,
    valAddress,
    client: createOcpCosmosClient({ signing, lcd }),
  };
}

async function loadValidatorClients() {
  const nodeCount = Math.max(1, Math.min(COMMITTEE_SIZE, OCPD_NUM_NODES));
  const clients = [];
  for (let node = 0; node < nodeCount; node++) {
    const client = await mkValidatorClient(`validator-${node}`, node);
    clients.push(client);
  }

  if (clients.length === 0) {
    throw new Error("no validator signers available");
  }

  return clients;
}

function parseMembersFromDkg(dkg) {
  const rawMembers = dkg?.members ?? dkg?.Members ?? [];
  if (!Array.isArray(rawMembers)) return [];
  return rawMembers
    .map((m) => {
      const validator = asString(m?.validator ?? m?.Validator);
      const index = asNumber(m?.index ?? m?.Index);
      if (!validator || !Number.isFinite(index)) return null;
      return { validator, index };
    })
    .filter(Boolean);
}

function parseMembersFromEpoch(epoch) {
  return parseMembersFromDkg(epoch);
}

function parseCommitCount(dkg) {
  return asNumber(dkg?.commits?.length ?? dkg?.Commits?.length) ?? 0;
}

function normalizeString(v) {
  return asString(v).toLowerCase();
}

function evalPoly(coeffs, x) {
  let acc = 0n;
  let pow = 1n;
  const X = BigInt(x);
  for (const a of coeffs) {
    acc = modQ(acc + modQ(a) * pow);
    pow = modQ(pow * X);
  }
  return modQ(acc);
}

async function mkClient(name, mnemonicEnv) {
  const mnemonic = (process.env[mnemonicEnv] ?? "").trim();
  const wallet = mnemonic ? await walletFromMnemonic({ mnemonic, prefix: PREFIX }) : await walletGenerate({ prefix: PREFIX });
  const [acct] = await wallet.getAccounts();
  const address = asString(acct?.address);
  if (!address) throw new Error(`${name}: wallet has no account`);

  faucet(address, FAUCET_AMOUNT);

  const registry = createOcpRegistry();
  const signing = await withRetry(`${name}: connect signing client`, () =>
    connectOcpCosmosSigningClient({
      rpcUrl: RPC,
      lcdUrl: LCD,
      signer: wallet,
      gasPrice: GAS_PRICE,
      registry,
    }),
  );
  const lcd = new CosmosLcdClient({ baseUrl: LCD });
  return { name, address, client: createOcpCosmosClient({ signing, lcd }) };
}

async function waitFor(label, getter, testFn, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getter();
    if (testFn(state)) return state;
    await sleepMs(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function randomDeckProof(pkHand, deck) {
  const seed = randomBytes(32);
  return shuffleProveV1(pkHand, deck, {
    rounds: SHUFFLE_ROUNDS,
    seed,
  });
}

async function expectTxFailure(txFn, label) {
  try {
    await txFn();
  } catch (err) {
    return;
  }
  throw new Error(`expected tx failure but succeeded: ${label}`);
}

async function main() {
  if (COMMITTEE_SIZE < THRESHOLD) throw new Error("COSMOS_COMMITTEE_SIZE must be >= threshold");
  if (NUM_PLAYERS < 2) throw new Error("COSMOS_PLAYERS must be at least 2");
  if (OCPD_NUM_NODES < COMMITTEE_SIZE) {
    throw new Error(`COSMOS/OCPD node count ${OCPD_NUM_NODES} is less than committee size ${COMMITTEE_SIZE}`);
  }

  const players = [];
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const walletName = NAME_TO_MNEMONIC[i] ?? `COSMOS_PLAYER_${i}_MNEMONIC`;
    players.push(await mkClient(`player-${i}`, walletName));
  }

  for (const [idx, p] of players.entries()) {
    p.seat = idx;
    const sk = nonzeroScalar();
    p.pkPlayerPoint = mulBase(sk);
    p.pkPlayer = groupElementToBytes(p.pkPlayerPoint);
  }

  const validatorSigners = await loadValidatorClients();
  const validatorByVal = new Map(
    validatorSigners.map((v) => [normalizeString(v.valAddress), v]),
  );

  if (validatorSigners.length < THRESHOLD) {
    throw new Error(`insufficient validator signers: expected at least ${THRESHOLD}, got ${validatorSigners.length}`);
  }

  console.log(JSON.stringify({
    rpc: RPC,
    lcd: LCD,
    players: players.length,
    committeeSize: COMMITTEE_SIZE,
    threshold: THRESHOLD,
    shuffleSteps: SHUFFLE_STEPS,
  }));

  const alice = players[0];
  const tableTx = await alice.client.pokerCreateTable({
    smallBlind: 1n,
    bigBlind: 2n,
    minBuyIn: BUY_IN,
    maxBuyIn: BUY_IN * 1000n,
    dealerTimeoutSecs: 120,
    actionTimeoutSecs: 120,
    label: "cosmos-localnet-dealer-e2e",
  });

  const tableId = parseTableIdFromTx(tableTx) ??
    (await waitFor("table id", async () => {
      const ids = await alice.client.getTables();
      if (ids.length === 0) return undefined;
      return ids.sort((a, b) => Number(a) - Number(b)).at(-1);
    }, Boolean));
  if (!tableId) throw new Error("could not determine tableId");

  await Promise.all(players.map((p, idx) =>
    p.client.pokerSit({
      tableId,
      seat: idx,
      buyIn: BUY_IN,
      pkPlayer: p.pkPlayer,
      player: p.address,
    }),
  ));

  const startTx = await alice.client.pokerStartHand({ tableId });
  const parsedHandId = parseHandIdFromTx(startTx);
  const tableAfterStart = await waitFor("active hand", async () => alice.client.getTable(tableId), (t) => pick(t?.hand, "handId", "hand_id"));

  const handId = parsedHandId ?? readBigIntLike(pick(tableAfterStart?.hand, "handId", "hand_id"));
  if (!handId) throw new Error("could not determine handId");

  const beginSigner = validatorSigners[0];
  const beginTx = await beginSigner.client.dealerBeginEpoch({
    caller: beginSigner.address,
    committeeSize: COMMITTEE_SIZE,
    threshold: THRESHOLD,
    commitBlocks: DKG_COMMIT_BLOCKS,
    complaintBlocks: DKG_COMPLAINT_BLOCKS,
    revealBlocks: DKG_REVEAL_BLOCKS,
    finalizeBlocks: DKG_FINALIZE_BLOCKS,
  });

  const epochId = readBigIntLike(assertEvent(beginTx.events, "DealerEpochBegun", "epochId"));
  if (!epochId) throw new Error("could not parse epochId from DealerEpochBegun");

  const dkgAfterBegin = await waitFor("DKG members", async () => alice.client.getDealerDkg(), (dkg) => parseMembersFromDkg(dkg).length >= COMMITTEE_SIZE);
  const dkgMembers = parseMembersFromDkg(dkgAfterBegin).slice(0, COMMITTEE_SIZE);
  if (dkgMembers.length < COMMITTEE_SIZE) {
    throw new Error(`DKG selected only ${dkgMembers.length} members, expected ${COMMITTEE_SIZE}`);
  }

  const polynomials = dkgMembers.map((m) => {
    const coeffs = Array.from({ length: THRESHOLD }, () => nonzeroScalar());
    const commitments = coeffs.map((c) => groupElementToBytes(mulBase(c)));
    return { member: m, coeffs, commitments };
  });

  const secretSharesByValidator = new Map();
  for (const member of dkgMembers) {
    let aggregated = 0n;
    for (const poly of polynomials) {
      aggregated = modQ(aggregated + evalPoly(poly.coeffs, BigInt(member.index)));
    }
    secretSharesByValidator.set(member.validator, {
      index: member.index,
      secretShare: aggregated,
    });
  }

  await Promise.all(polynomials.map(async (item) => {
    const validatorClient = validatorByVal.get(normalizeString(item.member.validator));
    if (!validatorClient) {
      throw new Error(`missing validator signer for ${item.member.validator}`);
    }
    await validatorClient.client.dealerDkgCommit({
      dealer: item.member.validator,
      epochId,
      commitments: item.commitments,
    });
  }));

  await waitFor("all commit submissions", async () => alice.client.getDealerDkg(),
    (dkg) => parseCommitCount(dkg) >= COMMITTEE_SIZE,
  );

  while (true) {
    try {
      const finalizeSigner = validatorByVal.get(normalizeString(dkgMembers[0]?.validator));
      if (!finalizeSigner) throw new Error("missing finalize epoch validator signer");

      const finalizeTx = await finalizeSigner.client.dealerFinalizeEpoch({
        caller: finalizeSigner.address,
        epochId,
      });
      assertEvent(finalizeTx.events, "DealerEpochFinalized", "epochId", String(epochId));
      break;
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (!msg.includes("too early") && !msg.includes("already") && !msg.includes("retry")) {
        throw err;
      }
      await sleepMs(1000);
    }
  }

  const epoch = await waitFor(
    "dealer epoch",
    async () => alice.client.getDealerEpoch(),
    (e) => Number(asNumber(pick(e, "epochId", "epoch_id", "EpochId"))) === epochId,
  );
  const epochMembers = parseMembersFromEpoch(epoch);
  if (epochMembers.length < THRESHOLD) throw new Error("dealer epoch members unexpectedly low");

  const initHandTx = await alice.client.dealerInitHand({
    tableId,
    handId,
    epochId,
    caller: alice.address,
  });
  assertEvent(initHandTx.events, "DealerHandInitialized", "tableId", String(tableId));

  const dealerHandAfterInit = await waitFor(
    "dealer pk hand",
    async () => alice.client.getDealerHand(tableId, handId),
    (dh) => Boolean(pick(dh, "pkHand", "pk_hand")),
  );
  const pkHandRaw = pick(dealerHandAfterInit, "pkHand", "pk_hand");
  if (!pkHandRaw) throw new Error("hand missing dealer.pkHand");

  const deckSize = asNumber(pick(dealerHandAfterInit, "deckSize", "deck_size")) ?? 52;
  const pkHandChain = groupElementFromBytes(decodeBytes(pkHandRaw));
  const pkEpoch = groupElementFromBytes(decodeBytes(pick(epoch, "pkEpoch", "pk_epoch", "PkEpoch")));
  const handScalar = hashToScalar("ocp/v1/dealer/hand-derive", u64le(epochId), u64le(tableId), u64le(handId));
  const pkHandExpected = mulPoint(pkEpoch, handScalar);
  if (!pointEq(pkHandExpected, pkHandChain)) throw new Error("pkHand invariant failed");

  for (let step = 1; step <= Math.min(SHUFFLE_STEPS, epochMembers.length); step++) {
    const state = await alice.client.getDealerHand(tableId, handId);
    if (!state) throw new Error("dealer hand unavailable during shuffle");
    const deck = decodeDeck(pick(state, "deck"));

    const { proofBytes } = randomDeckProof(pkHandChain, deck);
    const shuffler = epochMembers[(step - 1) % epochMembers.length]?.validator;
    if (!shuffler) throw new Error(`missing shuffler for step=${step}`);
    const shufflerClient = validatorByVal.get(normalizeString(shuffler));
    if (!shufflerClient) throw new Error(`missing validator signer for shuffler ${shuffler}`);

    const shuffleTx = await shufflerClient.client.dealerSubmitShuffle({
      shuffler,
      tableId,
      handId,
      round: step,
      proofShuffle: proofBytes,
    });
    assertEvent(shuffleTx.events, "ShuffleAccepted", "round", String(step));
  }

  const deckFinalTx = await alice.client.dealerFinalizeDeck({
    tableId,
    handId,
    caller: alice.address,
  });
  assertEvent(deckFinalTx.events, "DeckFinalized", "handId", String(handId));

  const afterDeck = await waitFor("deck finalization", async () => alice.client.getDealerHand(tableId, handId),
    (dh) => pick(dh, "finalized", "deck_finalized") === true,
  );

  const tableAfterDeck = await waitFor(
    "table hole positions",
    async () => alice.client.getTable(tableId),
    (t) => Array.isArray(pick(t?.hand?.dealer, "holePos", "hole_pos")),
  );

  const holePosRaw = pick(afterDeck, "holePos", "hole_pos") ?? pick(tableAfterDeck?.hand?.dealer, "holePos", "hole_pos");
  const holePos = Array.isArray(holePosRaw) ? holePosRaw.map(asNumber) : [];
  if (holePos.length !== 18) throw new Error("holePos length mismatch");

  const deck = decodeDeck(pick(afterDeck, "deck"));
  const thresholdMembers = epochMembers.slice(0, THRESHOLD);

  // Provide a valid duplicate-enc-share call and ensure it fails.
  let duplicateChecked = false;

  for (const p of players) {
    for (let cardIdx = 0; cardIdx < 2; cardIdx++) {
      const pos = Number(holePos[p.seat * 2 + cardIdx] ?? 255);
      if (!Number.isFinite(pos) || pos < 0) continue;
      const c1 = deck[pos]?.c1;
      if (!c1) continue;

      for (let idx = 0; idx < thresholdMembers.length; idx++) {
        const mem = thresholdMembers[idx];
        if (!mem) continue;
        const validatorClient = validatorByVal.get(normalizeString(mem.validator));
        if (!validatorClient) {
          throw new Error(`missing validator signer for ${mem.validator}`);
        }
        const local = secretSharesByValidator.get(mem.validator);
        if (!local) continue;

        const xHand = scalarMul(local.secretShare, handScalar);
        const yHand = mulBase(xHand);
        const d = mulPoint(c1, xHand);
        const r = nonzeroScalar();
        const u = mulBase(r);
        const v = pointAdd(d, mulPoint(p.pkPlayerPoint, r));
        const proof = encShareProve({
          y: yHand,
          c1,
          pkP: p.pkPlayerPoint,
          u,
          v,
          x: xHand,
          r,
          wx: nonzeroScalar(),
          wr: nonzeroScalar(),
        });

        const encShare = concatBytes(groupElementToBytes(u), groupElementToBytes(v));
        const proofBytes = encodeEncShareProof(proof);

        await validatorClient.client.dealerSubmitEncShare({
          validator: mem.validator,
          tableId,
          handId,
          pos,
          pkPlayer: p.pkPlayer,
          encShare,
          proofEncShare: proofBytes,
        });

        if (!duplicateChecked && idx === 0) {
          await expectTxFailure(() =>
            validatorClient.client.dealerSubmitEncShare({
              validator: mem.validator,
              tableId,
              handId,
              pos,
              pkPlayer: p.pkPlayer,
              encShare,
              proofEncShare: proofBytes,
            }),
          "duplicate enc share");
          duplicateChecked = true;
        }
      }
    }
  }

  if (!duplicateChecked) {
    throw new Error("did not run duplicate enc-share failure check");
  }

  await waitFor("phase after hole shares", async () => alice.client.getTable(tableId),
    (t) => {
      const phase = normalizePhase(t?.hand?.phase);
      return phase === "betting" || phase === "awaitFlop" || phase === "awaitTurn" || phase === "awaitRiver" || phase === "awaitShowdown" || phase === "showdown";
    },
  );

  let terminalState = "";
  for (let step = 0; step < 220; step++) {
    const t = await alice.client.getTable(tableId);
    const handInfo = t?.hand;
    if (!handInfo) {
      terminalState = "cleared";
      break;
    }
    const phase = normalizePhase(handInfo.phase);

    if (phase === "showdown") {
      terminalState = "showdown";
      console.log("hand reached showdown");
      break;
    }

    if (phase === "betting") {
      const actionSeat = asNumber(pick(handInfo, "actionOn", "action_on"));
      if (!Number.isFinite(actionSeat)) throw new Error("missing actionOn");
      const actionPlayer = findPlayerAtSeat(t, actionSeat);
      const local = players.find((p) => p.address === actionPlayer);
      if (!local) throw new Error(`no local key for action seat=${actionSeat}`);

      const toCall = toCallForSeat(t, actionSeat);
      const action = toCall === 0 ? "check" : "call";
      await local.client.pokerAct({
        player: local.address,
        tableId,
        action,
        amount: toCall ? BigInt(toCall) : undefined,
      });
      continue;
    }

    if (phase === "awaitFlop" || phase === "awaitTurn" || phase === "awaitRiver" || phase === "awaitShowdown") {
      const pos = expectedRevealPos(t);
      if (!Number.isFinite(pos)) throw new Error(`could not infer reveal pos in phase=${phase}`);
      const cipher = deck[pos];
      if (!cipher) throw new Error(`deck missing reveal position ${pos}`);

      for (const mem of thresholdMembers) {
        const validatorClient = validatorByVal.get(normalizeString(mem?.validator));
        if (!validatorClient) {
          throw new Error(`missing validator signer for ${mem?.validator}`);
        }
        const local = secretSharesByValidator.get(mem.validator);
        if (!local) continue;

        const xHand = scalarMul(local.secretShare, handScalar);
        const yHand = mulBase(xHand);
        const d = mulPoint(cipher.c1, xHand);
        const proof = chaumPedersenProve({
          y: yHand,
          c1: cipher.c1,
          d,
          x: xHand,
          w: nonzeroScalar(),
        });

        await validatorClient.client.dealerSubmitPubShare({
          validator: mem.validator,
          tableId,
          handId,
          pos,
          pubShare: groupElementToBytes(mulPoint(cipher.c1, xHand)),
          proofShare: encodeChaumPedersenProof(proof),
        });
      }

      await alice.client.dealerFinalizeReveal({
        tableId,
        handId,
        pos,
        caller: alice.address,
      });
      continue;
    }

    throw new Error(`unexpected phase: ${phase}`);
  }

  if (!terminalState) {
    throw new Error("hand did not reach a terminal state within step limit");
  }

  const finalTable = await alice.client.getTable(tableId);
  console.log(JSON.stringify({
    tableId,
    handId,
    terminalState,
    phase: normalizePhase(finalTable?.hand?.phase),
    actionOn: pick(finalTable?.hand, "actionOn", "action_on"),
    seatCards: players.map((p) => ({
      player: p.address,
      seat: p.seat,
      stack: finalTable?.seats?.[p.seat]?.stack,
      inHand: (pick(finalTable?.hand, "inHand", "in_hand") ?? [])[p.seat],
    })),
  }, null, 2));
}

function readBigIntLike(value) {
  if (value == null) return undefined;
  const s = asString(value);
  if (s.trim() === "") return undefined;
  try {
    const n = BigInt(s);
    return Number(n);
  } catch {
    return undefined;
  }
}

function assertEvent(events, type, attr, expected) {
  const v = findEventAttr(events, type, attr);
  if (!v) throw new Error(`missing event ${type}.${attr}`);
  if (expected != null && String(v) !== String(expected)) {
    throw new Error(`unexpected event attr for ${type}.${attr}: expected ${expected} got ${v}`);
  }
  return v;
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});

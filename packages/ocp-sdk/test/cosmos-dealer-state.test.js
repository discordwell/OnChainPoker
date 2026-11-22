// The dealer module's state read from its store keys. The reader and the transport check are not
// in the package's exports, so they are reached by path in dist, like the generated codecs that
// build the stored bytes here.

import assert from "node:assert/strict";
import test from "node:test";

import { CosmosLcdClient, createOcpCosmosClient, createOcpRegistry, OCP_TYPE_URLS } from "../dist/index.js";
import { parseValidators, readDealerState } from "../dist/cosmos/dealerState.js";
import { nodeReadsOver } from "../dist/cosmos/nodeReads.js";
import { BeaconState, DealerDKG, DealerEpoch } from "../dist/cosmos/gen/onchainpoker/dealer/v1/dealer.js";

const hex = (s) => Uint8Array.from(Buffer.from(s, "hex"));
const bytes = (n, fill) => new Uint8Array(n).fill(fill);

// Measured on the live chain on 2026-11-22 with abci_query on "/store/dealer/key".
const LIVE_NEXT_EPOCH_ID = hex("000000000000002c");
const LIVE_BEACON = hex("082c10d4e35d1886e45d20b8e45d2802");

/** A queryStore over a table of key byte to stored value, recording each read. */
function storeOf(values, height = 1_536_600) {
  const reads = [];
  const queryStore = async (store, key, asked) => {
    reads.push({ store, key: key[0], height: asked });
    const value = values[key[0]];
    if (value instanceof Error) throw value;
    return { value: value ?? null, height: asked ?? height };
  };
  return { queryStore, reads };
}

const member = (validator, index, extra = {}) => ({
  validator,
  index,
  pubShare: new Uint8Array(),
  consPubkey: bytes(32, index),
  power: "1000",
  ephemeralPubkey: new Uint8Array(),
  ...extra,
});

test("dealer state: the live chain's next-epoch bytes 000000000000002c are 44", async () => {
  const { queryStore } = storeOf({ 0x01: LIVE_NEXT_EPOCH_ID });
  assert.equal((await readDealerState(queryStore)).nextEpochId, 44);
});

test("dealer state: the live chain's beacon bytes decode to the window the chain opened for epoch 44", async () => {
  const { queryStore } = storeOf({ 0x01: LIVE_NEXT_EPOCH_ID, 0x05: LIVE_BEACON });
  assert.deepEqual((await readDealerState(queryStore)).beacon, {
    epochId: 44,
    commitOpenHeight: 1_536_468,
    commitCloseHeight: 1_536_518,
    revealCloseHeight: 1_536_568,
    threshold: 2,
    committed: [],
    revealed: [],
    consumed: false,
  });
});

test("dealer state: a beacon with commits, reveals and a final value lists who took part and is consumed", async () => {
  const beacon = BeaconState.encode(
    BeaconState.fromPartial({
      epochId: "9",
      commitOpenHeight: "100",
      commitCloseHeight: "150",
      revealCloseHeight: "200",
      threshold: 2,
      commits: [{ validator: "valA", commit: bytes(32, 1) }, { validator: "valB", commit: bytes(32, 2) }],
      reveals: [{ validator: "valA", salt: bytes(32, 3) }],
      final: bytes(32, 4),
    })
  ).finish();
  const { queryStore } = storeOf({ 0x01: LIVE_NEXT_EPOCH_ID, 0x05: beacon });
  const state = await readDealerState(queryStore);
  assert.deepEqual(
    { committed: state.beacon.committed, revealed: state.beacon.revealed, consumed: state.beacon.consumed },
    { committed: ["valA", "valB"], revealed: ["valA"], consumed: true }
  );
});

test("dealer state: a stored epoch decodes to numbers, with members in stored order and empty bytes as null", async () => {
  const epoch = DealerEpoch.encode(
    DealerEpoch.fromPartial({
      epochId: "42",
      threshold: 2,
      pkEpoch: bytes(32, 9),
      startHeight: "1036206",
      slashed: ["valC"],
      // Not sorted on purpose: the reader must keep the order the chain stored.
      members: [
        member("valC", 3, { pubShare: bytes(32, 7), power: "9000" }),
        member("valA", 1, { pubShare: bytes(32, 8), ephemeralPubkey: bytes(32, 6) }),
      ],
    })
  ).finish();
  const { queryStore } = storeOf({ 0x01: LIVE_NEXT_EPOCH_ID, 0x02: epoch });
  assert.deepEqual((await readDealerState(queryStore)).epoch, {
    epochId: 42,
    threshold: 2,
    startHeight: 1_036_206,
    slashed: ["valC"],
    members: [
      { validator: "valC", index: 3, pubShare: bytes(32, 7), ephemeralPubkey: null, power: 9000 },
      { validator: "valA", index: 1, pubShare: bytes(32, 8), ephemeralPubkey: bytes(32, 6), power: 1000 },
    ],
  });
});

test("dealer state: a stored DKG decodes with its deadlines, commits, shares, complaints and reveals", async () => {
  const dkg = DealerDKG.encode(
    DealerDKG.fromPartial({
      epochId: "44",
      threshold: 2,
      members: [member("valA", 1, { ephemeralPubkey: bytes(32, 5) }), member("valB", 2)],
      startHeight: "1000",
      commitDeadline: "1120",
      complaintDeadline: "1180",
      revealDeadline: "1240",
      finalizeDeadline: "1300",
      commits: [{ dealer: "valA", commitments: [bytes(32, 1), bytes(32, 2)] }],
      encryptedShares: [{ dealer: "valA", recipientIndex: 2, u: bytes(32, 3), v: bytes(32, 4), proof: bytes(160, 5), scalarCt: bytes(48, 6) }],
      complaints: [{ epochId: "44", complainer: "valB", dealer: "valA", kind: "missing" }],
      reveals: [{ epochId: "44", dealer: "valA", to: "valB", share: bytes(32, 7) }],
      slashed: ["valB"],
    })
  ).finish();
  const { queryStore } = storeOf({ 0x01: LIVE_NEXT_EPOCH_ID, 0x03: dkg });
  assert.deepEqual((await readDealerState(queryStore)).dkg, {
    epochId: 44,
    threshold: 2,
    startHeight: 1000,
    commitDeadline: 1120,
    complaintDeadline: 1180,
    revealDeadline: 1240,
    members: [
      { validator: "valA", index: 1, pubShare: null, ephemeralPubkey: bytes(32, 5), power: 1000 },
      { validator: "valB", index: 2, pubShare: null, ephemeralPubkey: null, power: 1000 },
    ],
    commits: [{ dealer: "valA", commitments: [bytes(32, 1), bytes(32, 2)] }],
    encryptedShares: [{ dealer: "valA", recipientIndex: 2, u: bytes(32, 3), v: bytes(32, 4), proof: bytes(160, 5), scalarCt: bytes(48, 6) }],
    complaints: [{ complainer: "valB", dealer: "valA", kind: "missing" }],
    reveals: [{ dealer: "valA", to: "valB", share: bytes(32, 7) }],
    slashed: ["valB"],
  });
});

test("dealer state: absent epoch, DKG and beacon keys are null", async () => {
  const { queryStore } = storeOf({ 0x01: LIVE_NEXT_EPOCH_ID });
  const state = await readDealerState(queryStore);
  assert.deepEqual({ epoch: state.epoch, dkg: state.dkg, beacon: state.beacon }, { epoch: null, dkg: null, beacon: null });
});

test("dealer state: an absent next-epoch key rejects, because the chain always holds one", async () => {
  // What a node answers for a height it has pruned: every key absent.
  const { queryStore } = storeOf({});
  await assert.rejects(() => readDealerState(queryStore), /key 0x01: no value at height 1536600/);
});

test("dealer state: the later reads carry the height the first read answered, and the next-epoch key is read last", async () => {
  const { queryStore, reads } = storeOf({ 0x01: LIVE_NEXT_EPOCH_ID }, 777);
  const state = await readDealerState(queryStore);
  assert.equal(state.height, 777);
  assert.equal(reads[0].height, undefined);
  assert.deepEqual(reads.slice(1).map((r) => r.height), [777, 777, 777]);
  assert.equal(reads.at(-1).key, 0x01);
  assert.deepEqual(reads.map((r) => r.key).sort(), [0x01, 0x02, 0x03, 0x05]);
});

test("dealer state: a read answered at another height rejects", async () => {
  let n = 0;
  const queryStore = async (_store, _key, asked) => ({ value: LIVE_NEXT_EPOCH_ID, height: n++ === 2 ? 778 : (asked ?? 777) });
  await assert.rejects(() => readDealerState(queryStore), /answered at height 778, not 777/);
});

test("dealer state: one failed read rejects the whole state and names the key", async () => {
  const { queryStore } = storeOf({ 0x01: LIVE_NEXT_EPOCH_ID, 0x05: new TypeError("fetch failed") });
  await assert.rejects(() => readDealerState(queryStore), /dealer state read failed at key 0x05: fetch failed/);
});

test("dealer state: bytes that are not the stored type reject and name the key", async () => {
  const { queryStore } = storeOf({ 0x01: hex("2c") });
  await assert.rejects(() => readDealerState(queryStore), /key 0x01: next epoch id is 1 bytes, expected 8/);
});

test("dealer state: getDealerState({ height }) asks for that height in all four reads", async () => {
  const { queryStore, reads } = storeOf({ 0x01: LIVE_NEXT_EPOCH_ID });
  const client = createOcpCosmosClient({ signing: { address: "ocp1x", client: {}, signAndBroadcastAuto: async () => ({}), queryStore } });
  const state = await client.getDealerState({ height: 1_536_500 });
  assert.equal(state.height, 1_536_500);
  assert.deepEqual(reads.map((r) => [r.store, r.height]), Array(4).fill(["dealer", 1_536_500]));
});

// ---- the transport half: what counts as an answer from the node ----

function cometAnswering(response) {
  const asked = [];
  const reads = nodeReadsOver(() => ({
    abciQuery: async (params) => {
      asked.push(params);
      return typeof response === "function" ? response(params) : response;
    },
    status: async () => {
      throw new Error("not asked in these tests");
    },
  }));
  return { reads, asked };
}

test("store read: asks abci_query for /store/<store>/key at the height given and returns the value with its height", async () => {
  const { reads, asked } = cometAnswering({ value: LIVE_NEXT_EPOCH_ID, height: 500, code: 0, log: "" });
  assert.deepEqual(await reads.queryStore("dealer", Uint8Array.of(0x01), 500), { value: LIVE_NEXT_EPOCH_ID, height: 500 });
  assert.deepEqual(asked, [{ path: "/store/dealer/key", data: Uint8Array.of(0x01), height: 500, prove: false }]);
});

test("store read: an empty value is null, with the height the node chose", async () => {
  const { reads } = cometAnswering({ value: new Uint8Array(), height: 912 });
  assert.deepEqual(await reads.queryStore("dealer", Uint8Array.of(0x03)), { value: null, height: 912 });
});

test("store read: a non-zero code rejects with the node's text", async () => {
  const { reads } = cometAnswering({ value: new Uint8Array(), height: 0, code: 6, log: "no such store: dealer" });
  await assert.rejects(() => reads.queryStore("dealer", Uint8Array.of(0x01)), /code 6: no such store: dealer/);
});

test("store read: code 0 with a log rejects, as a node answers for a height it no longer holds", async () => {
  const { reads } = cometAnswering({ value: new Uint8Array(), height: 100, code: 0, log: "version does not exist" });
  await assert.rejects(() => reads.queryStore("dealer", Uint8Array.of(0x03), 100), /version does not exist/);
});

test("store read: an answer at a height other than the one asked rejects", async () => {
  const { reads } = cometAnswering({ value: LIVE_NEXT_EPOCH_ID, height: 501 });
  await assert.rejects(() => reads.queryStore("dealer", Uint8Array.of(0x01), 500), /answered at height 501, not the height asked for, 500/);
});

test("node status: reports height, block time, catching up and the node's ed25519 consensus key", async () => {
  const status = (pubkey) =>
    nodeReadsOver(() => ({
      abciQuery: async () => ({ value: new Uint8Array() }),
      status: async () => ({
        syncInfo: { latestBlockHeight: 1_536_600, latestBlockTime: new Date("2026-11-22T04:00:00Z"), catchingUp: true },
        validatorInfo: { pubkey },
      }),
    })).nodeStatus();
  assert.deepEqual(await status({ algorithm: "ed25519", data: bytes(32, 1) }), {
    latestHeight: 1_536_600,
    latestBlockTimeMs: Date.parse("2026-11-22T04:00:00Z"),
    catchingUp: true,
    consensusPubkey: bytes(32, 1),
  });
  assert.equal((await status({ algorithm: "secp256k1", data: bytes(33, 1) })).consensusPubkey, null);
  assert.equal((await status(undefined)).consensusPubkey, null);
});

// ---- validators ----

const lcdValidator = (operator, extra = {}) => ({
  operator_address: operator,
  consensus_pubkey: { "@type": "/cosmos.crypto.ed25519.PubKey", key: Buffer.from(bytes(32, 7)).toString("base64") },
  jailed: false,
  status: "BOND_STATUS_BONDED",
  tokens: "8100000000",
  ...extra,
});

test("validators: bonded, jailed, power in whole units of 10^6 tokens, and the consensus key", () => {
  const parsed = parseValidators({
    validators: [
      lcdValidator("valA"),
      lcdValidator("valB", { jailed: true, status: "BOND_STATUS_UNBONDING", tokens: "4050999999" }),
      lcdValidator("valC", { tokens: "999999", consensus_pubkey: { "@type": "/cosmos.crypto.secp256k1.PubKey", key: "AAAA" } }),
    ],
    pagination: { next_key: null, total: "3" },
  });
  assert.deepEqual(parsed, [
    { operator: "valA", bonded: true, jailed: false, power: 8100, consensusPubkey: bytes(32, 7) },
    { operator: "valB", bonded: false, jailed: true, power: 4050, consensusPubkey: bytes(32, 7) },
    { operator: "valC", bonded: true, jailed: false, power: 0, consensusPubkey: null },
  ]);
});

test("validators: a shape it does not know rejects, and so does a list that continues on another page", () => {
  assert.throws(() => parseValidators({}), /no validators list/);
  assert.throws(() => parseValidators({ validators: [lcdValidator("valA", { tokens: 12 })] }), /valA has no tokens amount/);
  assert.throws(() => parseValidators({ validators: [lcdValidator("valA", { status: undefined })] }), /valA has no status/);
  assert.throws(() => parseValidators({ validators: [lcdValidator("valA")], pagination: { next_key: "AAAB" } }), /another page/);
});

test("validators: getValidators reads every status from the LCD in one page of 500", async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ validators: [lcdValidator("valA")], pagination: { next_key: null } }), { status: 200 });
  };
  const client = createOcpCosmosClient({
    signing: { address: "ocp1x", client: {}, signAndBroadcastAuto: async () => ({}) },
    lcd: new CosmosLcdClient({ baseUrl: "http://127.0.0.1:1317", fetchFn }),
  });
  assert.equal((await client.getValidators())[0].operator, "valA");
  assert.deepEqual(urls, ["http://127.0.0.1:1317/cosmos/staking/v1beta1/validators?pagination.limit=500"]);
});

test("unjail: slashingUnjail signs one MsgUnjail for the validator, and the registry can encode it", async () => {
  const sent = [];
  const client = createOcpCosmosClient({
    signing: { address: "ocp1x", client: {}, signAndBroadcastAuto: async (msgs) => (sent.push(...msgs), { code: 0 }) },
  });
  await client.slashingUnjail({ validator: "ocpvaloper1abc" });
  assert.deepEqual(sent, [{ typeUrl: OCP_TYPE_URLS.slashing.unjail, value: { validatorAddr: "ocpvaloper1abc" } }]);

  const any = createOcpRegistry().encodeAsAny(sent[0]);
  // protobuf: field 1, length-delimited, the address.
  assert.deepEqual([...any.value], [0x0a, 14, ...Buffer.from("ocpvaloper1abc")]);
});

// Confirmation without the tx index. The live nodes run with indexer = "null", so a transaction that
// lands can only be found by reading the blocks it can be in.
// Group 1 drives signAndBroadcastAuto through the public entry against a fake CometBFT node (fake-comet.js).
// Group 2 drives the block scan (dist/cosmos/confirm.js, not exported by the package) with a virtual clock.

import assert from "node:assert/strict";
import test from "node:test";

import { decodeTxRaw } from "@cosmjs/proto-signing";

import * as sdk from "../dist/index.js";
import { fakeChain, okResult, startFakeComet, txHash } from "./fake-comet.js";

const failureOf = (err) => (sdk.txFailureOf ? sdk.txFailureOf(err) : { kind: "(the SDK has no typed failure)" });

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail("expected the call to throw");
}

const ALLOWED_METHODS = new Set(["status", "abci_query", "broadcast_tx_sync", "block", "block_results"]);

/** A connected signing client over a fake node; `signs` counts signatures made. */
async function connected(t, chainOver = {}, connectOver = {}) {
  const wallet = await sdk.walletFromPrivKey({ privateKeyHex: "11".repeat(32), prefix: "ocp" });
  const [{ address }] = await wallet.getAccounts();
  const chain = fakeChain({ address, ...chainOver });
  const node = await startFakeComet(chain);
  t.after(() => node.close());
  const counter = { signs: 0 };
  const signer = {
    getAccounts: () => wallet.getAccounts(),
    signDirect: (a, doc) => {
      counter.signs += 1;
      return wallet.signDirect(a, doc);
    },
  };
  const signing = await sdk.connectOcpCosmosSigningClient({
    rpcUrl: node.url,
    signer,
    gasPrice: "0uchips",
    registry: sdk.createOcpRegistry(),
    ...connectOver,
  });
  const send = {
    typeUrl: "/cosmos.bank.v1beta1.MsgSend",
    value: { fromAddress: address, toAddress: address, amount: [{ denom: "uchips", amount: "1" }] },
  };
  return { chain, signing, send, counter };
}

const timeoutOf = (tx) => Number(decodeTxRaw(tx).body.timeoutHeight);

// ---- group 1: signAndBroadcastAuto ----

test("a landed tx resolves with its own block's result, and the other tx in that block is not taken for it", async (t) => {
  const other = Uint8Array.from([1, 2, 3]);
  const { chain, signing, send } = await connected(t, {
    land: (tx) => [{
      txs: [other, tx],
      results: [
        okResult({ gas_used: "111", events: [{ type: "other", attributes: [{ key: "who", value: "someone else" }] }] }),
        okResult({ gas_used: "59618", events: [{ type: "transfer", attributes: [{ key: "amount", value: "1uchips" }] }] }),
      ],
    }],
  });

  const res = await signing.signAndBroadcastAuto([send], "probe");

  assert.equal(chain.broadcasts.length, 1);
  assert.equal(res.transactionHash, txHash(chain.broadcasts[0]));
  assert.equal(res.height, 101);
  assert.equal(res.txIndex, 1);
  assert.equal(res.code, 0);
  assert.equal(res.gasUsed, 59618n);
  assert.equal(res.gasWanted, 200000n);
  assert.deepEqual(res.events, [{ type: "transfer", attributes: [{ key: "amount", value: "1uchips" }] }]);
});

test("a service signer signs every tx with timeout height = latest + 6", async (t) => {
  const { chain, signing, send } = await connected(t);
  const outcome = await signing.signAndBroadcastAuto([send]).catch((err) => err);
  assert.equal(timeoutOf(chain.broadcasts[0]), 100 + 6);
  assert.ifError(outcome instanceof Error ? outcome : null);
});

test("an interactive signer (a person approves in a wallet) gets timeout height = latest + 60", async (t) => {
  const { chain, signing, send } = await connected(t, {}, { interactive: true });
  const outcome = await signing.signAndBroadcastAuto([send]).catch((err) => err);
  assert.equal(timeoutOf(chain.broadcasts[0]), 100 + 60);
  assert.ifError(outcome instanceof Error ? outcome : null);
});

test("a tx in a block with code 5 throws failed with that height, code and the chain's log", async (t) => {
  const log = "failed to execute message; message index: 0: not in shuffle phase";
  const { chain, signing, send } = await connected(t, {
    land: (tx) => [{ txs: [tx], results: [okResult({ code: 5, codespace: "dealer", log })] }],
  });

  const err = await rejectionOf(signing.signAndBroadcastAuto([send]));

  assert.deepEqual(failureOf(err), { kind: "failed", hash: txHash(chain.broadcasts[0]), height: 101, code: 5, codespace: "dealer", log });
  assert.match(err.message, /not in shuffle phase/);
});

test("simulate refused by the chain throws rejected with the chain's text, and nothing is broadcast", async (t) => {
  const { chain, signing, send } = await connected(t, {
    simulate: () => ({ code: 18, log: "failed to execute message; message index: 0: commit already submitted: invalid request" }),
  });

  const err = await rejectionOf(signing.signAndBroadcastAuto([send]));

  assert.equal(failureOf(err).kind, "rejected");
  assert.match(err.message, /already/);
  assert.equal(chain.broadcasts.length, 0);
});

test("CheckTx code 32 (sequence mismatch) throws rejected with the chain's log", async (t) => {
  const log = "account sequence mismatch, expected 4, got 3: incorrect account sequence";
  const { signing, send } = await connected(t, { checkTx: () => ({ code: 32, codespace: "sdk", log }) });

  const err = await rejectionOf(signing.signAndBroadcastAuto([send]));

  assert.deepEqual(failureOf(err), { kind: "rejected", log });
  assert.match(err.message, /account sequence mismatch/);
});

test("a socket error on broadcast re-sends the same bytes, does not sign again, then finds the tx", async (t) => {
  const { chain, signing, send, counter } = await connected(t, {
    checkTx: (_tx, attempt) => (attempt === 1 ? "hang up" : { code: 0, log: "" }),
  });

  const res = await signing.signAndBroadcastAuto([send]);

  assert.equal(chain.broadcasts.length, 2);
  assert.deepEqual(chain.broadcasts[1], chain.broadcasts[0]);
  assert.equal(counter.signs, 1);
  assert.equal(res.transactionHash, txHash(chain.broadcasts[0]));
  assert.equal(res.height, 101);
});

test("a tx that no block holds up to its timeout height throws expired, and no block above it is read", async (t) => {
  const { chain, signing, send } = await connected(t, {
    land: () => Array.from({ length: 10 }, () => ({ txs: [], results: [] })),
  });

  const err = await rejectionOf(signing.signAndBroadcastAuto([send]));

  assert.deepEqual(failureOf(err), { kind: "expired", hash: txHash(chain.broadcasts[0]), timeoutHeight: 106 });
  assert.deepEqual([...new Set(chain.blockReads)].sort((a, b) => a - b), [101, 102, 103, 104, 105, 106]);
});

test("sending asks the node for no transaction lookup (tx, tx_search) and nothing but block reads", async (t) => {
  const { chain, signing, send } = await connected(t);
  await signing.signAndBroadcastAuto([send]).catch(() => {});
  assert.deepEqual(chain.methods.filter((m) => !ALLOWED_METHODS.has(m)), []);
});

test("connecting to a node that keeps no block results fails at connect and says which setting", async (t) => {
  const err = await rejectionOf(connected(t, {
    blockResults: () => { throw new Error("node is not persisting finalize block responses"); },
  }));
  assert.match(err.message, /discard_abci_responses/);
  assert.match(err.message, /node is not persisting finalize block responses/);
});

test("txFailureOf is total: a transport error is not-a-tx", () => {
  const err = new TypeError("fetch failed");
  assert.deepEqual(failureOf(err), { kind: "not-a-tx", error: err });
});

// ---- group 2: the block scan, with a fake block source and a virtual clock ----

const confirmModule = () => import("../dist/cosmos/confirm.js");

/** Virtual time: a sleep wakes only when it is the earliest pending one and nothing else is running. */
function virtualClock() {
  let now = 0;
  const timers = [];
  let scheduled = false;
  const tick = () => {
    scheduled = false;
    if (timers.length === 0) return;
    timers.sort((a, b) => a.at - b.at);
    const next = timers.shift();
    now = Math.max(now, next.at);
    next.resolve();
    schedule();
  };
  const schedule = () => {
    if (!scheduled && timers.length > 0) {
      scheduled = true;
      setImmediate(tick);
    }
  };
  return {
    now: () => now,
    sleep(ms, signal) {
      return new Promise((resolve) => {
        const timer = { at: now + ms, resolve };
        timers.push(timer);
        signal?.addEventListener("abort", () => {
          const i = timers.indexOf(timer);
          if (i >= 0) timers.splice(i, 1);
        }, { once: true });
        schedule();
      });
    },
  };
}

const HASH = "AA".repeat(32);
const REQ = { hash: HASH, sentAtHeight: 10, timeoutHeight: 16 };
const result = (over = {}) => ({ code: 0, codespace: "", log: "", events: [], gasWanted: 200000n, gasUsed: 50000n, ...over });

/**
 * A chain that grows by `perPoll` blocks each time the latest height is asked for.
 * `blocks[h]` is a list of [hash, result] pairs; `fail` decides which reads reject.
 */
function fakeSource({ start = 10, perPoll = 1, blocks = {}, fail = () => null }) {
  let latest = start;
  const reads = { latest: 0, hashes: [], results: [] };
  const source = {
    async latestHeight() {
      reads.latest += 1;
      const err = fail("latest", latest);
      if (err) throw err;
      latest += perPoll;
      return latest;
    },
    async txHashesAt(h) {
      reads.hashes.push(h);
      assert.ok(h <= latest, `asked for height ${h} above the latest ${latest}`);
      const err = fail("hashes", h);
      if (err) throw err;
      return (blocks[h] ?? []).map(([hash]) => hash);
    },
    async txResultAt(h, i) {
      reads.results.push([h, i]);
      const err = fail("results", h);
      if (err) throw err;
      return blocks[h][i][1];
    },
  };
  return { source, reads };
}

test("scan: a tx in the next block resolves with that block's height, index, events and gas", async () => {
  const { confirmByBlockScan } = await confirmModule();
  const events = [{ type: "transfer", attributes: [{ key: "amount", value: "1uchips" }] }];
  const { source } = fakeSource({ blocks: { 11: [[HASH, result({ events, gasUsed: 61000n })]] } });

  const res = await confirmByBlockScan(source, REQ, virtualClock());

  assert.deepEqual(
    { height: res.height, txIndex: res.txIndex, code: res.code, hash: res.transactionHash, events: res.events, gasUsed: res.gasUsed },
    { height: 11, txIndex: 0, code: 0, hash: HASH, events, gasUsed: 61000n },
  );
});

test("scan: a tx three blocks later resolves; every height in between was read exactly once", async () => {
  const { confirmByBlockScan } = await confirmModule();
  const { source, reads } = fakeSource({ blocks: { 13: [["BB".repeat(32), result()], [HASH, result()]] } });

  const res = await confirmByBlockScan(source, REQ, virtualClock());

  assert.equal(res.height, 13);
  assert.equal(res.txIndex, 1);
  assert.deepEqual(reads.hashes, [11, 12, 13]);
  assert.deepEqual(reads.results, [[13, 1]]);
});

test("scan: two txs in one block, the result taken is the one at this tx's index", async () => {
  const { confirmByBlockScan } = await confirmModule();
  const { source } = fakeSource({
    blocks: { 11: [["CC".repeat(32), result({ code: 7, log: "someone else's failure" })], [HASH, result({ gasUsed: 42n })]] },
  });

  const res = await confirmByBlockScan(source, REQ, virtualClock());

  assert.equal(res.code, 0);
  assert.equal(res.txIndex, 1);
  assert.equal(res.gasUsed, 42n);
});

test("scan: a tx in a block with code 5 throws failed with that code and the chain's log", async () => {
  const { confirmByBlockScan, txFailureOf } = await confirmModule();
  const { source } = fakeSource({ perPoll: 2, blocks: { 12: [[HASH, result({ code: 5, codespace: "poker", log: "not your turn" })]] } });

  const err = await rejectionOf(confirmByBlockScan(source, REQ, virtualClock()));

  assert.deepEqual(txFailureOf(err), { kind: "failed", hash: HASH, height: 12, code: 5, codespace: "poker", log: "not your turn" });
});

test("scan: passing timeoutHeight without the tx throws expired, only after every height up to it was read", async () => {
  const { confirmByBlockScan, txFailureOf } = await confirmModule();
  const { source, reads } = fakeSource({ perPoll: 4 });

  const err = await rejectionOf(confirmByBlockScan(source, REQ, virtualClock()));

  assert.deepEqual(txFailureOf(err), { kind: "expired", hash: HASH, timeoutHeight: 16 });
  assert.deepEqual(reads.hashes, [11, 12, 13, 14, 15, 16]);
});

test("scan: it never asks for a height above timeoutHeight, even when the chain is far past it", async () => {
  const { confirmByBlockScan } = await confirmModule();
  const { source, reads } = fakeSource({ perPoll: 50 });

  await rejectionOf(confirmByBlockScan(source, REQ, virtualClock()));

  assert.equal(Math.max(...reads.hashes), 16);
});

test("scan: a height whose block read failed is read again, never skipped", async () => {
  const { confirmByBlockScan } = await confirmModule();
  let failures = 2;
  const { source, reads } = fakeSource({
    perPoll: 3,
    blocks: { 13: [[HASH, result()]] },
    fail: (what, h) => (what === "hashes" && h === 12 && failures-- > 0 ? new Error("socket hang up") : null),
  });

  const res = await confirmByBlockScan(source, REQ, virtualClock());

  assert.equal(res.height, 13);
  assert.deepEqual(reads.hashes, [11, 12, 12, 12, 13]);
});

test("scan: a node that stops answering throws unknown at 45 s, not before, with the hash and both heights", async () => {
  const { confirmByBlockScan, txFailureOf } = await confirmModule();
  const clock = virtualClock();
  const { source, reads } = fakeSource({ fail: (what) => (what === "latest" ? new Error("fetch failed") : null) });

  const err = await rejectionOf(confirmByBlockScan(source, REQ, clock));

  assert.equal(clock.now(), 45_000);
  assert.deepEqual(txFailureOf(err), { kind: "unknown", hash: HASH, sentAtHeight: 10, timeoutHeight: 16, why: "fetch failed" });
  assert.ok(reads.latest > 10 && reads.latest < 100, `latest height asked ${reads.latest} times`);
});

test("scan: a read that never returns still ends as unknown at 45 s", async () => {
  const { confirmByBlockScan, txFailureOf } = await confirmModule();
  const clock = virtualClock();
  const source = { latestHeight: () => new Promise(() => {}), txHashesAt: async () => [], txResultAt: async () => result() };

  const err = await rejectionOf(confirmByBlockScan(source, REQ, clock));

  assert.equal(clock.now(), 45_000);
  assert.equal(txFailureOf(err).kind, "unknown");
});

test("scan: a block whose results stay missing is never called expired; the caller gets unknown at 45 s", async () => {
  const { confirmByBlockScan, txFailureOf } = await confirmModule();
  const clock = virtualClock();
  const { source, reads } = fakeSource({
    perPoll: 3,
    blocks: { 12: [[HASH, result()]] },
    fail: (what) => (what === "results" ? new Error("could not find results for height #12") : null),
  });

  const err = await rejectionOf(confirmByBlockScan(source, REQ, clock));

  const f = txFailureOf(err);
  assert.equal(f.kind, "unknown");
  assert.match(f.why, /could not find results for height #12/);
  assert.equal(clock.now(), 45_000);
  assert.ok(!reads.hashes.includes(13), "no height after the block that holds the tx is read");
});

test("scan: a block whose results are missing at first is read again at the same height and resolves", async () => {
  const { confirmByBlockScan } = await confirmModule();
  let failures = 1;
  const { source, reads } = fakeSource({
    blocks: { 11: [[HASH, result()]] },
    fail: (what) => (what === "results" && failures-- > 0 ? new Error("could not find results for height #11") : null),
  });

  const res = await confirmByBlockScan(source, REQ, virtualClock());

  assert.equal(res.height, 11);
  assert.deepEqual(reads.results, [[11, 0], [11, 0]]);
});

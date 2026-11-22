// A CometBFT 0.38 JSON-RPC node over HTTP, with the tx index off, for the signing tests.
// Shapes are copied from a local ocpd node (CometBFT reports 0.38.19). The real cosmjs clients talk to it.

import http from "node:http";

import { sha256 } from "@cosmjs/crypto";
import { fromBase64, fromHex, toBase64, toHex } from "@cosmjs/encoding";
import { BaseAccount } from "cosmjs-types/cosmos/auth/v1beta1/auth.js";
import { QueryAccountResponse } from "cosmjs-types/cosmos/auth/v1beta1/query.js";
import { SimulateResponse } from "cosmjs-types/cosmos/tx/v1beta1/service.js";

const HASH = "0B19CD9CDC3DFA7D6AA873040FC9C1F7BC4598810642729D602B57AE041A20D3";
const PARTS = { total: 1, hash: "E8545F6362B53818705414AF32960AAF040BE3F48BF3F7E8A652EB536F416560" };
const EMPTY = "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855";
const VALIDATOR = "04703A8DE7A7922ABE1DC2D02536A9DF1432BD48";
const TIME = "2026-11-22T05:43:52.235827Z";

export const txHash = (tx) => toHex(sha256(tx)).toUpperCase();

/** What the node does. Every field may be replaced by a test. */
export function fakeChain(over = {}) {
  return {
    chainId: "ocp-fake-1",
    height: 100,
    account: { accountNumber: 7n, sequence: 3n },
    blocks: new Map(), // height -> { txs: Uint8Array[], results: object[] }
    queued: [], // blocks to commit at the next status call: { txs, results }
    methods: [], // every JSON-RPC method asked for, in order
    blockReads: [], // the height of every block request
    broadcasts: [], // every tx body received by broadcast_tx_sync
    simulate: () => ({ gasUsed: 80_000n }), // or { code, log }
    checkTx: () => ({ code: 0, log: "" }), // or { code, codespace, log }, { rpcError }, or "hang up"
    // After a tx is admitted: the blocks that will hold it. Default: the next block, alone, code 0.
    land: (tx) => [{ txs: [tx], results: [okResult()] }],
    blockResults: (height, block) => block.results, // throw to make a height's results unreadable
    ...over,
  };
}

export function okResult(over = {}) {
  return {
    code: 0,
    data: "",
    log: "",
    info: "",
    gas_wanted: "200000",
    gas_used: "59618",
    events: [{ type: "transfer", attributes: [{ key: "amount", value: "1uchips", index: true }] }],
    codespace: "",
    ...over,
  };
}

function rpcError(data) {
  return { code: -32603, message: "Internal error", data };
}

function heightError(height, chain) {
  return rpcError(`height ${height} must be less than or equal to the current blockchain height ${chain.height}`);
}

function status(chain) {
  for (const block of chain.queued.splice(0)) chain.blocks.set(++chain.height, block);
  return {
    node_info: {
      protocol_version: { p2p: "8", block: "11", app: "0" },
      id: "d6555d45025b1a4143d3cad5ca22b9fccbd1d828",
      listen_addr: "tcp://127.0.0.1:26656",
      network: chain.chainId,
      version: "0.38.19",
      channels: "40202122233038606100",
      moniker: "fake",
      other: { tx_index: "off", rpc_address: "tcp://127.0.0.1:26657" },
    },
    sync_info: {
      latest_block_hash: HASH,
      latest_app_hash: EMPTY,
      latest_block_height: String(chain.height),
      latest_block_time: TIME,
      catching_up: false,
    },
    validator_info: {
      address: VALIDATOR,
      pub_key: { type: "tendermint/PubKeyEd25519", value: "SX/pwWReqM4ZXCL9U+7jGWL3S7HMeN1qF/PZ+zKdiTs=" },
      voting_power: "10",
    },
  };
}

function abciQuery(chain, params) {
  const at = String(chain.height);
  if (params.path === "/cosmos.auth.v1beta1.Query/Account") {
    const account = BaseAccount.fromPartial({ address: chain.address, ...chain.account });
    const value = QueryAccountResponse.encode({
      account: { typeUrl: "/cosmos.auth.v1beta1.BaseAccount", value: BaseAccount.encode(account).finish() },
    }).finish();
    return { response: { code: 0, log: "", info: "", index: "0", key: null, value: toBase64(value), height: at, codespace: "" } };
  }
  if (params.path === "/cosmos.tx.v1beta1.Service/Simulate") {
    const sim = chain.simulate(fromHex(params.data));
    if (sim.code) return { response: { code: sim.code, log: sim.log, info: "", index: "0", value: "", height: "0", codespace: "sdk" } };
    const value = SimulateResponse.encode(SimulateResponse.fromPartial({ gasInfo: { gasWanted: 0n, gasUsed: sim.gasUsed }, result: {} })).finish();
    return { response: { code: 0, log: "", info: "", index: "0", value: toBase64(value), height: at, codespace: "" } };
  }
  throw new Error(`fake node: no answer for abci_query ${params.path}`);
}

function block(chain, height) {
  const b = chain.blocks.get(height) ?? { txs: [], results: [] };
  return {
    block_id: { hash: HASH, parts: PARTS },
    block: {
      header: {
        version: { block: "11" },
        chain_id: chain.chainId,
        height: String(height),
        time: TIME,
        last_block_id: { hash: HASH, parts: PARTS },
        last_commit_hash: EMPTY,
        data_hash: EMPTY,
        validators_hash: EMPTY,
        next_validators_hash: EMPTY,
        consensus_hash: EMPTY,
        app_hash: EMPTY,
        last_results_hash: EMPTY,
        evidence_hash: EMPTY,
        proposer_address: VALIDATOR,
      },
      data: { txs: b.txs.map(toBase64) },
      evidence: { evidence: [] },
      last_commit: { height: String(height - 1), round: 0, block_id: { hash: HASH, parts: PARTS }, signatures: [] },
    },
  };
}

function answer(chain, method, params) {
  switch (method) {
    case "status":
      return { result: status(chain) };
    case "abci_query":
      return { result: abciQuery(chain, params) };
    case "broadcast_tx_sync": {
      const tx = fromBase64(params.tx);
      chain.broadcasts.push(tx);
      const seen = chain.broadcasts.slice(0, -1).some((t) => txHash(t) === txHash(tx));
      if (seen) return { error: rpcError("tx already exists in cache") };
      const check = chain.checkTx(tx, chain.broadcasts.length);
      if (check === "hang up") {
        chain.queued.push(...chain.land(tx));
        return "hang up";
      }
      if (check.rpcError) return { error: rpcError(check.rpcError) };
      if (check.code === 0) chain.queued.push(...chain.land(tx));
      return { result: { code: check.code, data: "", log: check.log, codespace: check.codespace ?? "", hash: txHash(tx) } };
    }
    case "block": {
      const height = Number(params.height);
      chain.blockReads.push(height);
      return height > chain.height ? { error: heightError(height, chain) } : { result: block(chain, height) };
    }
    case "block_results": {
      const height = Number(params.height);
      if (height > chain.height) return { error: heightError(height, chain) };
      const b = chain.blocks.get(height) ?? { txs: [], results: [] };
      try {
        const results = chain.blockResults(height, b);
        return { result: { height: String(height), txs_results: results, finalize_block_events: [], validator_updates: null, consensus_param_updates: null, app_hash: "" } };
      } catch (err) {
        return { error: rpcError(err.message) };
      }
    }
    case "tx":
    case "tx_search":
      return { error: rpcError("transaction indexing is disabled") };
    default:
      return { error: { code: -32601, message: "Method not found", data: "" } };
  }
}

/** Starts the node on 127.0.0.1. `chain.address` must be the signer's address. */
export async function startFakeComet(chain) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body);
      chain.methods.push(method);
      const out = answer(chain, method, params ?? {});
      if (out === "hang up") {
        req.socket.destroy();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, ...out }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

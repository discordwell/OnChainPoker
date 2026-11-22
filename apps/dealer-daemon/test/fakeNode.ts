// A chain node for tests of DealerDaemon: one state, answered both ways the daemon has read it.
// The LCD paths serve the epoch and DKG as JSON, and `queryStore` serves the same records as the
// bytes the dealer module stores, so a test runs unchanged on either side of the move between them.
// The real SDK client sits on top, so what a test sees sent is what the SDK would sign.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@onchainpoker/ocp-sdk/cosmos";
import {
  BeaconState,
  DealerDKG,
  DealerEpoch,
} from "../../../packages/ocp-sdk/dist/cosmos/gen/onchainpoker/dealer/v1/dealer.js";
import { DealerDaemon } from "../src/daemon.js";
import { EpochStateStore } from "../src/state.js";
import type { DealerDaemonConfig } from "../src/config.js";

export type Sent = { typeUrl: string; value: any };

/** What the chain does with one message: it lands, it is refused before the mempool, its confirmation is lost, or it waits in the mempool. */
export type Answer = "land" | "lose" | "wait" | { refuse: string };

export type FakeValidator = {
  operator: string;
  status: "BOND_STATUS_BONDED" | "BOND_STATUS_UNBONDING" | "BOND_STATUS_UNBONDED";
  jailed: boolean;
  tokens: string;
  consensusKey: Uint8Array;
};

const STORE_KEY = { nextEpochId: 0x01, epoch: 0x02, dkg: 0x03, beacon: 0x05 } as const;
const FAST_KDF = { memoryCost: 8, timeCost: 1, parallelism: 1 };

function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), snakeKeys(v)])
  );
}

function u64be(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}

export class FakeNode {
  height = 1000;
  nextEpochId = 1;
  epoch: DealerEpoch | null = null;
  dkg: DealerDKG | null = null;
  beacon: BeaconState | null = null;
  validators: FakeValidator[] = [];
  /** What the node says of itself. By default it is caught up, holds a fresh block and has no validator key. */
  nodeStatus: { catchingUp: boolean; blockAgeMs: number; consensusPubkey: Uint8Array | null; blockTimeMs?: number } = { catchingUp: false, blockAgeMs: 0, consensusPubkey: null };
  /** Table id to the table as the LCD prints it. */
  readonly tables = new Map<string, unknown>();
  /** "tableId/handId" to the dealer hand as the LCD prints it. */
  readonly dealerHands = new Map<string, unknown>();

  /** Every message handed to the signer, in order, whatever became of it. */
  readonly sent: Sent[] = [];
  /** The messages of the transactions in the node's mempool. */
  pending: Sent[] = [];
  /** Every transaction: its messages, and whether it was sent without a simulation. */
  readonly txs: { msgs: readonly Sent[]; gasLimit?: number }[] = [];
  /** How the chain answers the nth message of a type (n from 0). Everything lands unless a test says otherwise. */
  answer: (msg: Sent, nthOfType: number) => Answer = () => "land";
  /** A read that fails: "store:0x03" for a dealer store key, "lcd:<path>" for an LCD path. Returns the error text, or null. */
  failRead: (read: string) => string | null = () => null;
  /** The stored bytes of a dealer key at a past height, for a node that keeps them. Without it every height reads the current state. */
  storeAt: ((key: number, height: number) => Uint8Array | null) | null = null;

  sentOf(typeUrl: string): Sent[] {
    return this.sent.filter((m) => m.typeUrl === typeUrl);
  }

  storeValue(key: number): Uint8Array | null {
    switch (key) {
      case STORE_KEY.nextEpochId:
        return u64be(this.nextEpochId);
      case STORE_KEY.epoch:
        return this.epoch ? DealerEpoch.encode(this.epoch).finish() : null;
      case STORE_KEY.dkg:
        return this.dkg ? DealerDKG.encode(this.dkg).finish() : null;
      case STORE_KEY.beacon:
        return this.beacon ? BeaconState.encode(this.beacon).finish() : null;
      default:
        throw new Error(`fake node: unknown dealer store key 0x${key.toString(16)}`);
    }
  }

  private lcdJson(pathname: string): unknown {
    if (pathname === "/onchainpoker/dealer/v1/epoch") {
      return { epoch: this.epoch ? snakeKeys(DealerEpoch.toJSON(this.epoch)) : null };
    }
    if (pathname === "/onchainpoker/dealer/v1/dkg") {
      return this.dkg ? { dkg: snakeKeys(DealerDKG.toJSON(this.dkg)) } : {};
    }
    if (pathname === "/onchainpoker/poker/v1/tables") return { table_ids: [...this.tables.keys()] };
    if (pathname === "/cosmos/staking/v1beta1/validators") {
      return {
        validators: this.validators.map((v) => ({
          operator_address: v.operator,
          consensus_pubkey: { "@type": "/cosmos.crypto.ed25519.PubKey", key: Buffer.from(v.consensusKey).toString("base64") },
          jailed: v.jailed,
          status: v.status,
          tokens: v.tokens,
        })),
        pagination: { next_key: null, total: String(this.validators.length) },
      };
    }
    const table = /^\/onchainpoker\/poker\/v1\/tables\/(\d+)$/.exec(pathname);
    if (table && this.tables.has(table[1]!)) return { table: this.tables.get(table[1]!) };
    const hand = /^\/onchainpoker\/dealer\/v1\/tables\/(\d+)\/hands\/(\d+)$/.exec(pathname);
    if (hand && this.dealerHands.has(`${hand[1]}/${hand[2]}`)) return { hand: this.dealerHands.get(`${hand[1]}/${hand[2]}`) };
    return undefined;
  }

  private failure(answer: Exclude<Answer, "land" | "wait">, hash: string): Error {
    // The typed failure exists once the SDK confirms from blocks; before that the SDK threw plain errors.
    const Typed = (sdk as Record<string, any>).OcpTxError;
    if (answer === "lose") {
      return Typed
        ? new Typed({ kind: "unknown", hash, sentAtHeight: this.height, timeoutHeight: this.height + 6, why: "node did not answer" })
        : new Error(`timed out waiting for tx ${hash} via LCD (unexpected HTTP 500 from LCD tx query)`);
    }
    return Typed ? new Typed({ kind: "rejected", log: answer.refuse }) : new Error(answer.refuse);
  }

  /** `signer` is the account that signs: the chain reads it as the caller of BeginEpoch and FinalizeEpoch. */
  client(signer = "ocp1signer"): sdk.OcpCosmosClient {
    const fetchFn = (async (url: string) => {
      const failure = this.failRead(`lcd:${new URL(url).pathname}`);
      if (failure !== null) throw new TypeError(failure);
      const body = this.lcdJson(new URL(url).pathname);
      const status = body === undefined ? 404 : 200;
      return {
        ok: status === 200,
        status,
        statusText: "",
        json: async () => body,
        text: async () => JSON.stringify(body ?? { message: "not found" }),
      };
    }) as unknown as typeof fetch;

    // A transaction is atomic: every message is sent, and the first one the chain does not take decides it.
    const broadcastAuto = async (msgs: readonly Sent[], _memo?: string, opts: { gasLimit?: number } = {}) => {
      this.txs.push({ msgs, gasLimit: opts.gasLimit });
      const answers = msgs.map((msg) => {
        const nth = this.sentOf(msg.typeUrl).length;
        this.sent.push(msg);
        return this.answer(msg, nth);
      });
      const hash = `${"AB".repeat(31)}${String(this.sent.length).padStart(2, "0")}`;
      const refused = answers.find((a): a is { refuse: string } => typeof a === "object");
      if (refused) throw this.failure(refused, hash);
      const landed = answers.includes("wait")
        ? new Promise<never>(() => {})
        : answers.includes("lose")
        ? Promise.reject(this.failure("lose", hash))
        : Promise.resolve({ code: 0, height: this.height + 1, txIndex: 0, events: [], rawLog: "", transactionHash: hash, msgResponses: [], gasUsed: 0n, gasWanted: 0n });
      landed.catch(() => undefined);
      return { hash, landed };
    };
    const signing = {
      address: signer,
      client: {} as any,
      broadcastAuto,
      signAndBroadcastAuto: async (msgs: readonly Sent[]) => (await broadcastAuto(msgs)).landed,
      committedHeight: async () => this.height,
      pendingMessages: async () => this.pending,
      queryStore: async (store: string, key: Uint8Array, height?: number) => {
        if (store !== "dealer") throw new Error(`fake node: unknown store ${store}`);
        const failure = this.failRead(`store:0x${key[0]!.toString(16).padStart(2, "0")}`);
        if (failure !== null) throw new TypeError(failure);
        const past = height !== undefined && height !== this.height && this.storeAt;
        return { value: past ? past(key[0]!, height) : this.storeValue(key[0]!), height: height ?? this.height };
      },
      nodeStatus: async () => ({
        latestHeight: this.height,
        latestBlockTimeMs: this.nodeStatus.blockTimeMs ?? Date.now() - this.nodeStatus.blockAgeMs,
        catchingUp: this.nodeStatus.catchingUp,
        consensusPubkey: this.nodeStatus.consensusPubkey,
      }),
    };

    return sdk.createOcpCosmosClient({
      signing: signing as any,
      lcd: new sdk.CosmosLcdClient({ baseUrl: "http://127.0.0.1:1317", fetchFn }),
    });
  }
}

/** The account that signs for a validator. On the chain both are one key under two prefixes. */
export const accountOf = (validator: string): string => validator.replace("valoper", "");

export type Harness = { daemon: DealerDaemon; node: FakeNode; store: EpochStateStore; stateDir: string };

/** A daemon for `validator` against `node`, with its own empty state directory unless one is given. */
export function daemonAgainst(node: FakeNode, validator: string, overrides: Partial<DealerDaemonConfig> = {}): Harness {
  const stateDir = overrides.stateDir ?? mkdtempSync(join(tmpdir(), "dealer-daemon-test-"));
  const statePassphrase = "a passphrase for tests only";
  const store = new EpochStateStore(stateDir, statePassphrase, FAST_KDF);
  const config = {
    validatorAddress: validator,
    cosmosRpcUrl: "http://127.0.0.1:26657",
    cosmosLcdUrl: "http://127.0.0.1:1317",
    bech32Prefix: "ocp",
    gasPrice: "0uchips",
    stateDir,
    statePassphrase,
    autoBeginEpoch: true,
    autoInitHand: true,
    autoFinalize: true,
    pollIntervalMs: 3_600_000,
    committeeSize: 3,
    threshold: 2,
    shuffleRounds: 2,
    patienceBlocks: 17_280,
    ...overrides,
  } as DealerDaemonConfig;
  const daemon = new DealerDaemon({ client: node.client(accountOf(validator)), config, stateStore: store });
  return { daemon, node, store, stateDir };
}

/**
 * Runs one poll to its end, through the daemon's own error handling. `poll` is private in
 * TypeScript only; start() offers no way to wait for the poll it kicks off.
 */
export async function pollOnce(daemon: DealerDaemon): Promise<void> {
  await (daemon as unknown as { poll(): Promise<void> }).poll();
}

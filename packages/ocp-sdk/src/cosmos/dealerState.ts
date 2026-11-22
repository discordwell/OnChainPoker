// The dealer module's state as a caller needs it: which store keys hold it, how the stored bytes
// decode, and the domain types everything else uses. Callers see nothing of protobuf, base64,
// snake_case or integers carried as strings.
//
// The state is read from the module's store because the chain has no query for the beacon window
// or for the next epoch id.

import {
  BeaconState,
  DealerDKG,
  DealerEpoch as WireEpoch,
  type DealerMember as WireMember,
} from "./gen/onchainpoker/dealer/v1/dealer.js";
import type { QueryStore } from "./nodeReads.js";

/** A validator operator address, "ocpvaloper1...". Compared as the chain compares it: byte for byte. */
export type Valoper = string;

export type DealerMember = {
  readonly validator: Valoper;
  /** Shamir x-coordinate, 1..N in ascending validator order. */
  readonly index: number;
  /** Set when the epoch is finalized. null inside a DKG. */
  readonly pubShare: Uint8Array | null;
  /** Published with the DKG commit. null until then. */
  readonly ephemeralPubkey: Uint8Array | null;
  readonly power: number;
};

export type DealerEpoch = {
  readonly epochId: number;
  readonly threshold: number;
  /** Height of the BeginEpoch that started this epoch's DKG. */
  readonly startHeight: number;
  /** In stored order, which is ascending by validator. The chain picks shufflers from this order. */
  readonly members: readonly DealerMember[];
  readonly slashed: readonly Valoper[];
};

export type DealerDkg = {
  readonly epochId: number;
  readonly threshold: number;
  readonly startHeight: number;
  readonly commitDeadline: number;
  readonly complaintDeadline: number;
  readonly revealDeadline: number;
  readonly members: readonly DealerMember[];
  readonly commits: readonly { readonly dealer: Valoper; readonly commitments: readonly Uint8Array[] }[];
  readonly encryptedShares: readonly {
    readonly dealer: Valoper;
    readonly recipientIndex: number;
    readonly u: Uint8Array;
    readonly v: Uint8Array;
    readonly proof: Uint8Array;
    readonly scalarCt: Uint8Array;
  }[];
  readonly complaints: readonly { readonly complainer: Valoper; readonly dealer: Valoper; readonly kind: string }[];
  readonly reveals: readonly { readonly dealer: Valoper; readonly to: Valoper; readonly share: Uint8Array }[];
  readonly slashed: readonly Valoper[];
};

export type BeaconWindow = {
  /** The epoch this window seeds. Equal to nextEpochId while it is the pending one. */
  readonly epochId: number;
  readonly commitOpenHeight: number;
  readonly commitCloseHeight: number;
  readonly revealCloseHeight: number;
  /** Reveals needed before BeginEpoch can consume it. */
  readonly threshold: number;
  readonly committed: readonly Valoper[];
  readonly revealed: readonly Valoper[];
  /** True once a BeginEpoch has consumed it. */
  readonly consumed: boolean;
};

/** The dealer module at one height. Either every field was read at `height`, or the read rejected. */
export type DealerState = {
  readonly height: number;
  /** The only epoch id BeginEpoch accepts next. Never derived from epoch.epochId + 1. */
  readonly nextEpochId: number;
  readonly epoch: DealerEpoch | null;
  readonly dkg: DealerDkg | null;
  readonly beacon: BeaconWindow | null;
};

export type ValidatorInfo = {
  readonly operator: Valoper;
  /** In the active set: what the chain's BeginEpoch samples from and what BeaconCommit requires. */
  readonly bonded: boolean;
  readonly jailed: boolean;
  /** Consensus power, tokens / 10^6. The chain samples only validators with power above zero. */
  readonly power: number;
  /** The ed25519 key the validator's node must sign with. null for a key of another type. */
  readonly consensusPubkey: Uint8Array | null;
};

// x/dealer/types/keys.go. A change there must change this table.
const DEALER_STORE = "dealer";
const KEY = {
  nextEpochId: Uint8Array.of(0x01),
  epoch: Uint8Array.of(0x02),
  dkg: Uint8Array.of(0x03),
  beacon: Uint8Array.of(0x05),
} as const;

/**
 * Reads the four keys at one height and parses them.
 *
 * With no `height`, the first read fixes the height and the others are pinned to it, so a
 * transaction that lands between two reads cannot produce a state that never existed (an old epoch
 * with no DKG reads as "begin an epoch").
 *
 * The next-epoch-id key is read last and must be present. The chain writes it at genesis and never
 * deletes it, and a node asked for a height it does not hold answers every key as absent. Its
 * presence after the other reads shows that all four were answered from a state the node holds.
 */
export async function readDealerState(queryStore: QueryStore, at?: { height: number }): Promise<DealerState> {
  const dkg = await readKey(queryStore, KEY.dkg, at?.height);
  const height = dkg.height;
  const [epoch, beacon] = await Promise.all([
    readKey(queryStore, KEY.epoch, height),
    readKey(queryStore, KEY.beacon, height),
  ]);
  const next = await readKey(queryStore, KEY.nextEpochId, height);
  if (next.value === null) {
    throw new Error(`${failedAt(KEY.nextEpochId)}: no value at height ${height}, so the node does not hold that state`);
  }

  return {
    height,
    nextEpochId: parsed(KEY.nextEpochId, () => nextEpochIdOf(next.value!)),
    epoch: epoch.value === null ? null : parsed(KEY.epoch, () => epochOf(WireEpoch.decode(epoch.value!))),
    dkg: dkg.value === null ? null : parsed(KEY.dkg, () => dkgOf(DealerDKG.decode(dkg.value!))),
    beacon: beacon.value === null ? null : parsed(KEY.beacon, () => beaconOf(BeaconState.decode(beacon.value!))),
  };
}

function failedAt(key: Uint8Array): string {
  return `dealer state read failed at key 0x${key[0]!.toString(16).padStart(2, "0")}`;
}

async function readKey(queryStore: QueryStore, key: Uint8Array, height: number | undefined) {
  let answer: Awaited<ReturnType<QueryStore>>;
  try {
    answer = await queryStore(DEALER_STORE, key, height);
  } catch (err) {
    throw new Error(`${failedAt(key)}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (!Number.isSafeInteger(answer.height) || answer.height <= 0) {
    throw new Error(`${failedAt(key)}: answered at height ${answer.height}`);
  }
  if (height !== undefined && answer.height !== height) {
    throw new Error(`${failedAt(key)}: answered at height ${answer.height}, not ${height}`);
  }
  return answer;
}

function parsed<T>(key: Uint8Array, parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    throw new Error(`${failedAt(key)}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

function safeInt(value: string | number, what: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${what} is not a safe non-negative integer: ${value}`);
  return n;
}

function positive(value: string | number, what: string): number {
  const n = safeInt(value, what);
  if (n === 0) throw new Error(`${what} is zero`);
  return n;
}

const orNull = (bytes: Uint8Array): Uint8Array | null => (bytes.length > 0 ? bytes : null);

function nextEpochIdOf(bytes: Uint8Array): number {
  if (bytes.length !== 8) throw new Error(`next epoch id is ${bytes.length} bytes, expected 8`);
  return positive(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0).toString(), "next epoch id");
}

function memberOf(m: WireMember): DealerMember {
  if (m.validator === "") throw new Error("member without a validator");
  return {
    validator: m.validator,
    index: positive(m.index, "member index"),
    pubShare: orNull(m.pubShare),
    ephemeralPubkey: orNull(m.ephemeralPubkey),
    power: safeInt(m.power, "member power"),
  };
}

function epochOf(e: WireEpoch): DealerEpoch {
  return {
    epochId: positive(e.epochId, "epoch id"),
    threshold: e.threshold,
    startHeight: safeInt(e.startHeight, "epoch start height"),
    members: e.members.map(memberOf),
    slashed: e.slashed,
  };
}

function dkgOf(d: DealerDKG): DealerDkg {
  return {
    epochId: positive(d.epochId, "DKG epoch id"),
    threshold: d.threshold,
    startHeight: safeInt(d.startHeight, "DKG start height"),
    commitDeadline: safeInt(d.commitDeadline, "DKG commit deadline"),
    complaintDeadline: safeInt(d.complaintDeadline, "DKG complaint deadline"),
    revealDeadline: safeInt(d.revealDeadline, "DKG reveal deadline"),
    members: d.members.map(memberOf),
    commits: d.commits.map((c) => ({ dealer: c.dealer, commitments: c.commitments })),
    encryptedShares: d.encryptedShares.map((s) => ({
      dealer: s.dealer,
      recipientIndex: s.recipientIndex,
      u: s.u,
      v: s.v,
      proof: s.proof,
      scalarCt: s.scalarCt,
    })),
    complaints: d.complaints.map((c) => ({ complainer: c.complainer, dealer: c.dealer, kind: c.kind })),
    reveals: d.reveals.map((r) => ({ dealer: r.dealer, to: r.to, share: r.share })),
    slashed: d.slashed,
  };
}

function beaconOf(b: BeaconState): BeaconWindow {
  return {
    epochId: positive(b.epochId, "beacon epoch id"),
    commitOpenHeight: safeInt(b.commitOpenHeight, "beacon commit open height"),
    commitCloseHeight: safeInt(b.commitCloseHeight, "beacon commit close height"),
    revealCloseHeight: safeInt(b.revealCloseHeight, "beacon reveal close height"),
    threshold: b.threshold,
    committed: b.commits.map((c) => c.validator),
    revealed: b.reveals.map((r) => r.validator),
    consumed: b.final.length > 0,
  };
}

const POWER_REDUCTION = 1_000_000n;
const ED25519_PUBKEY = "/cosmos.crypto.ed25519.PubKey";

/**
 * The staking module's validators, every status, as LCD /cosmos/staking/v1beta1/validators prints
 * them. Rejects a shape it does not know, and a list that continues on another page.
 */
export function parseValidators(json: unknown): ValidatorInfo[] {
  const body = record(json, "validators response");
  if (!Array.isArray(body.validators)) throw new Error("validators response has no validators list");
  const pagination = body.pagination == null ? {} : record(body.pagination, "pagination");
  if (pagination.next_key != null && pagination.next_key !== "") {
    throw new Error("validators response continues on another page");
  }
  return body.validators.map((entry, i) => {
    const v = record(entry, `validator ${i}`);
    if (typeof v.operator_address !== "string" || v.operator_address === "") {
      throw new Error(`validator ${i} has no operator_address`);
    }
    if (typeof v.status !== "string") throw new Error(`validator ${v.operator_address} has no status`);
    if (v.jailed !== undefined && typeof v.jailed !== "boolean") {
      throw new Error(`validator ${v.operator_address} has a jailed flag that is not a boolean`);
    }
    if (typeof v.tokens !== "string" || !/^\d+$/.test(v.tokens)) {
      throw new Error(`validator ${v.operator_address} has no tokens amount`);
    }
    return {
      operator: v.operator_address,
      bonded: v.status === "BOND_STATUS_BONDED",
      jailed: v.jailed === true,
      power: safeInt((BigInt(v.tokens) / POWER_REDUCTION).toString(), `power of ${v.operator_address}`),
      consensusPubkey: consensusKeyOf(v.consensus_pubkey),
    };
  });
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} is not an object`);
  return value as Record<string, unknown>;
}

function consensusKeyOf(value: unknown): Uint8Array | null {
  if (value === null || typeof value !== "object") return null;
  const key = value as Record<string, unknown>;
  if (key["@type"] !== ED25519_PUBKEY || typeof key.key !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(key.key)) return null;
  return Uint8Array.from(atob(key.key), (c) => c.charCodeAt(0));
}

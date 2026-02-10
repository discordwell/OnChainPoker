import type { EncodeObject } from "@cosmjs/proto-signing";
import type { DeliverTxResponse, Event } from "@cosmjs/stargate";

import type { CosmosLcdClient } from "./lcd.js";
import { OCP_TYPE_URLS } from "./ocp.js";
import type { OcpCosmosSigningClient } from "./signing.js";

import type {
  MsgAct,
  MsgCreateTable,
  MsgLeave,
  MsgSit,
  MsgStartHand,
  MsgTick
} from "./gen/onchainpoker/poker/v1/tx.js";
import type {
  MsgBeginEpoch,
  MsgDkgCommit,
  MsgDkgComplaintInvalid,
  MsgDkgComplaintMissing,
  MsgDkgShareReveal,
  MsgDkgTimeout,
  MsgFinalizeDeck,
  MsgFinalizeEpoch,
  MsgFinalizeReveal,
  MsgInitHand,
  MsgSubmitEncShare,
  MsgSubmitPubShare,
  MsgSubmitShuffle,
  MsgTimeout
} from "./gen/onchainpoker/dealer/v1/tx.js";

type UintLike = string | number | bigint;

function toU64String(x: UintLike, label: string): string {
  if (typeof x === "string") {
    const s = x.trim();
    if (s === "") throw new Error(`${label} must be a non-empty string`);
    // Best-effort validation; on-chain will fully validate.
    if (!/^\d+$/.test(s)) throw new Error(`${label} must be an unsigned integer string`);
    return s;
  }
  if (typeof x === "number") {
    if (!Number.isFinite(x) || x < 0 || Math.floor(x) !== x) throw new Error(`${label} must be a uint`);
    return String(x);
  }
  if (typeof x === "bigint") {
    if (x < 0n) throw new Error(`${label} must be a uint`);
    return x.toString();
  }
  throw new Error(`${label} must be a string|number|bigint`);
}

function u64(x: UintLike | undefined, fallback: string, label: string): string {
  if (x == null) return fallback;
  return toU64String(x, label);
}

function maybeBase64ToUtf8(s: string): string {
  // Tendermint RPC stacks may return ABCI event keys/values base64-encoded.
  // Decode only when it's a strict base64 round-trip and valid UTF-8.
  const norm = String(s ?? "");
  if (norm === "") return "";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(norm)) return norm;
  const padded = norm.length % 4 === 0 ? norm : norm + "=".repeat(4 - (norm.length % 4));
  let bin: string;
  try {
    bin = atob(padded);
  } catch {
    return norm;
  }
  const stripPad = (x: string) => x.replace(/=+$/, "");
  if (stripPad(btoa(bin)) !== stripPad(padded)) return norm;

  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  try {
    // Use fatal decoding to reject invalid UTF-8.
    const td = new TextDecoder("utf-8", { fatal: true });
    return td.decode(bytes);
  } catch {
    return norm;
  }
}

export type OcpAbciEvent = { type: string; attributes: Record<string, string> };

export function normalizeDeliverTxEvents(events: readonly Event[] | undefined): OcpAbciEvent[] {
  const out: OcpAbciEvent[] = [];
  for (const ev of events ?? []) {
    if (!ev || typeof ev.type !== "string") continue;
    const attrs: Record<string, string> = {};
    for (const a of ev.attributes ?? []) {
      if (!a || typeof a.key !== "string") continue;
      const k = maybeBase64ToUtf8(a.key);
      const v = maybeBase64ToUtf8(String(a.value ?? ""));
      attrs[k] = v;
    }
    out.push({ type: ev.type, attributes: attrs });
  }
  return out;
}

export function findEventAttr(
  events: readonly Event[] | undefined,
  eventType: string,
  attrKey: string
): string | undefined {
  const evs = normalizeDeliverTxEvents(events);
  const ev = evs.find((e) => e.type === eventType);
  if (!ev) return undefined;
  return ev.attributes[attrKey];
}

export function parseTableIdFromTx(tx: DeliverTxResponse): string | null {
  const v = findEventAttr(tx.events, "TableCreated", "tableId");
  return v && /^\d+$/.test(v) ? v : null;
}

export function parseHandIdFromTx(tx: DeliverTxResponse): string | null {
  const v = findEventAttr(tx.events, "HandStarted", "handId");
  return v && /^\d+$/.test(v) ? v : null;
}

export type OcpCosmosClient = {
  signing: OcpCosmosSigningClient;
  lcd?: CosmosLcdClient;

  // --- poker queries ---
  getTables: () => Promise<string[]>;
  getTable: (tableId: UintLike) => Promise<any | null>;

  // --- dealer queries ---
  getDealerEpoch: () => Promise<any | null>;
  getDealerDkg: () => Promise<any | null>;
  getDealerHand: (tableId: UintLike, handId: UintLike) => Promise<any | null>;

  // --- poker tx helpers ---
  pokerCreateTable: (args: {
    creator?: string;
    smallBlind: UintLike;
    bigBlind: UintLike;
    minBuyIn: UintLike;
    maxBuyIn: UintLike;
    actionTimeoutSecs?: UintLike;
    dealerTimeoutSecs?: UintLike;
    playerBond?: UintLike;
    rakeBps?: number;
    maxPlayers?: number;
    label?: string;
    memo?: string;
  }) => Promise<DeliverTxResponse>;
  pokerSit: (args: { player?: string; tableId: UintLike; seat: number; buyIn: UintLike; pkPlayer: Uint8Array; memo?: string }) => Promise<DeliverTxResponse>;
  pokerStartHand: (args: { caller?: string; tableId: UintLike; memo?: string }) => Promise<DeliverTxResponse>;
  pokerAct: (args: { player?: string; tableId: UintLike; action: string; amount?: UintLike; memo?: string }) => Promise<DeliverTxResponse>;
  pokerTick: (args: { caller?: string; tableId: UintLike; memo?: string }) => Promise<DeliverTxResponse>;
  pokerLeave: (args: { player?: string; tableId: UintLike; memo?: string }) => Promise<DeliverTxResponse>;

  // --- dealer tx helpers ---
  dealerBeginEpoch: (args: {
    caller?: string;
    epochId?: UintLike;
    committeeSize: number;
    threshold: number;
    randEpoch?: Uint8Array;
    commitBlocks?: UintLike;
    complaintBlocks?: UintLike;
    revealBlocks?: UintLike;
    finalizeBlocks?: UintLike;
    memo?: string;
  }) => Promise<DeliverTxResponse>;
  dealerDkgCommit: (args: { dealer: string; epochId: UintLike; commitments: Uint8Array[]; memo?: string }) => Promise<DeliverTxResponse>;
  dealerDkgComplaintMissing: (args: { complainer: string; epochId: UintLike; dealer: string; memo?: string }) => Promise<DeliverTxResponse>;
  dealerDkgComplaintInvalid: (args: { complainer: string; epochId: UintLike; dealer: string; shareMsg: Uint8Array; memo?: string }) => Promise<DeliverTxResponse>;
  dealerDkgShareReveal: (args: { dealer: string; epochId: UintLike; to: string; share: Uint8Array; memo?: string }) => Promise<DeliverTxResponse>;
  dealerFinalizeEpoch: (args: { caller?: string; epochId: UintLike; memo?: string }) => Promise<DeliverTxResponse>;
  dealerDkgTimeout: (args: { caller?: string; epochId: UintLike; memo?: string }) => Promise<DeliverTxResponse>;
  dealerInitHand: (args: { caller?: string; tableId: UintLike; handId: UintLike; epochId: UintLike; deckSize?: number; memo?: string }) => Promise<DeliverTxResponse>;
  dealerSubmitShuffle: (args: { shuffler: string; tableId: UintLike; handId: UintLike; round: number; proofShuffle: Uint8Array; memo?: string }) => Promise<DeliverTxResponse>;
  dealerFinalizeDeck: (args: { caller?: string; tableId: UintLike; handId: UintLike; memo?: string }) => Promise<DeliverTxResponse>;
  dealerSubmitPubShare: (args: { validator: string; tableId: UintLike; handId: UintLike; pos: number; pubShare: Uint8Array; proofShare: Uint8Array; memo?: string }) => Promise<DeliverTxResponse>;
  dealerSubmitEncShare: (args: {
    validator: string;
    tableId: UintLike;
    handId: UintLike;
    pos: number;
    pkPlayer: Uint8Array;
    encShare: Uint8Array;
    proofEncShare: Uint8Array;
    memo?: string;
  }) => Promise<DeliverTxResponse>;
  dealerFinalizeReveal: (args: { caller?: string; tableId: UintLike; handId: UintLike; pos: number; memo?: string }) => Promise<DeliverTxResponse>;
  dealerTimeout: (args: { caller?: string; tableId: UintLike; handId: UintLike; memo?: string }) => Promise<DeliverTxResponse>;
};

export function createOcpCosmosClient(args: { signing: OcpCosmosSigningClient; lcd?: CosmosLcdClient }): OcpCosmosClient {
  const { signing, lcd } = args;

  async function signAndBroadcast(msgs: readonly EncodeObject[], memo?: string): Promise<DeliverTxResponse> {
    const res = await signing.signAndBroadcastAuto(msgs, memo);
    if (res.code !== 0) throw new Error(`tx failed: code=${res.code} log=${res.rawLog ?? ""}`);
    return res;
  }

  function ensureLcd(): CosmosLcdClient {
    if (!lcd) throw new Error("OcpCosmosClient: lcd client not configured");
    return lcd;
  }

  async function getTables(): Promise<string[]> {
    const c = ensureLcd();
    const json = await c.getJson<any>("/onchainpoker/poker/v1/tables");
    const raw = Array.isArray(json?.tableIds) ? json.tableIds : Array.isArray(json?.table_ids) ? json.table_ids : [];
    return raw.map((x: any) => String(x)).filter((x: string) => /^\d+$/.test(x));
  }

  async function getTable(tableId: UintLike): Promise<any | null> {
    const c = ensureLcd();
    const id = toU64String(tableId, "tableId");
    const json = await c.getJson<any>(`/onchainpoker/poker/v1/tables/${encodeURIComponent(id)}`).catch(() => null);
    return json?.table ?? json ?? null;
  }

  async function getDealerEpoch(): Promise<any | null> {
    const c = ensureLcd();
    const json = await c.getJson<any>("/onchainpoker/dealer/v1/epoch").catch(() => null);
    return json?.epoch ?? json ?? null;
  }

  async function getDealerDkg(): Promise<any | null> {
    const c = ensureLcd();
    const json = await c.getJson<any>("/onchainpoker/dealer/v1/dkg").catch(() => null);
    return json?.dkg ?? json ?? null;
  }

  async function getDealerHand(tableId: UintLike, handId: UintLike): Promise<any | null> {
    const c = ensureLcd();
    const tid = toU64String(tableId, "tableId");
    const hid = toU64String(handId, "handId");
    const json = await c.getJson<any>(`/onchainpoker/dealer/v1/tables/${encodeURIComponent(tid)}/hands/${encodeURIComponent(hid)}`).catch(() => null);
    return json?.hand ?? json ?? null;
  }

  async function pokerCreateTable(a: {
    creator?: string;
    smallBlind: UintLike;
    bigBlind: UintLike;
    minBuyIn: UintLike;
    maxBuyIn: UintLike;
    actionTimeoutSecs?: UintLike;
    dealerTimeoutSecs?: UintLike;
    playerBond?: UintLike;
    rakeBps?: number;
    maxPlayers?: number;
    label?: string;
    memo?: string;
  }): Promise<DeliverTxResponse> {
    const msg: MsgCreateTable = {
      creator: (a.creator ?? signing.address).trim(),
      smallBlind: toU64String(a.smallBlind, "smallBlind"),
      bigBlind: toU64String(a.bigBlind, "bigBlind"),
      minBuyIn: toU64String(a.minBuyIn, "minBuyIn"),
      maxBuyIn: toU64String(a.maxBuyIn, "maxBuyIn"),
      actionTimeoutSecs: u64(a.actionTimeoutSecs, "0", "actionTimeoutSecs"),
      dealerTimeoutSecs: u64(a.dealerTimeoutSecs, "0", "dealerTimeoutSecs"),
      playerBond: u64(a.playerBond, "0", "playerBond"),
      rakeBps: a.rakeBps ?? 0,
      maxPlayers: a.maxPlayers ?? 0, // 0 => module default (9)
      label: a.label ?? ""
    };
    const eo: EncodeObject = { typeUrl: OCP_TYPE_URLS.poker.createTable, value: msg };
    return signAndBroadcast([eo], a.memo);
  }

  async function pokerSit(a: {
    player?: string;
    tableId: UintLike;
    seat: number;
    buyIn: UintLike;
    pkPlayer: Uint8Array;
    memo?: string;
  }): Promise<DeliverTxResponse> {
    const msg: MsgSit = {
      player: (a.player ?? signing.address).trim(),
      tableId: toU64String(a.tableId, "tableId"),
      seat: a.seat,
      buyIn: toU64String(a.buyIn, "buyIn"),
      pkPlayer: a.pkPlayer
    };
    const eo: EncodeObject = { typeUrl: OCP_TYPE_URLS.poker.sit, value: msg };
    return signAndBroadcast([eo], a.memo);
  }

  async function pokerStartHand(a: { caller?: string; tableId: UintLike; memo?: string }): Promise<DeliverTxResponse> {
    const msg: MsgStartHand = {
      caller: (a.caller ?? signing.address).trim(),
      tableId: toU64String(a.tableId, "tableId")
    };
    const eo: EncodeObject = { typeUrl: OCP_TYPE_URLS.poker.startHand, value: msg };
    return signAndBroadcast([eo], a.memo);
  }

  async function pokerAct(a: {
    player?: string;
    tableId: UintLike;
    action: string;
    amount?: UintLike;
    memo?: string;
  }): Promise<DeliverTxResponse> {
    const msg: MsgAct = {
      player: (a.player ?? signing.address).trim(),
      tableId: toU64String(a.tableId, "tableId"),
      action: a.action,
      amount: u64(a.amount, "0", "amount")
    };
    const eo: EncodeObject = { typeUrl: OCP_TYPE_URLS.poker.act, value: msg };
    return signAndBroadcast([eo], a.memo);
  }

  async function pokerTick(a: { caller?: string; tableId: UintLike; memo?: string }): Promise<DeliverTxResponse> {
    const msg: MsgTick = {
      caller: (a.caller ?? signing.address).trim(),
      tableId: toU64String(a.tableId, "tableId")
    };
    const eo: EncodeObject = { typeUrl: OCP_TYPE_URLS.poker.tick, value: msg };
    return signAndBroadcast([eo], a.memo);
  }

  async function pokerLeave(a: { player?: string; tableId: UintLike; memo?: string }): Promise<DeliverTxResponse> {
    const msg: MsgLeave = {
      player: (a.player ?? signing.address).trim(),
      tableId: toU64String(a.tableId, "tableId")
    };
    const eo: EncodeObject = { typeUrl: OCP_TYPE_URLS.poker.leave, value: msg };
    return signAndBroadcast([eo], a.memo);
  }

  async function dealerBeginEpoch(a: {
    caller?: string;
    epochId?: UintLike;
    committeeSize: number;
    threshold: number;
    randEpoch?: Uint8Array;
    commitBlocks?: UintLike;
    complaintBlocks?: UintLike;
    revealBlocks?: UintLike;
    finalizeBlocks?: UintLike;
    memo?: string;
  }): Promise<DeliverTxResponse> {
    const msg: MsgBeginEpoch = {
      caller: (a.caller ?? signing.address).trim(),
      epochId: u64(a.epochId, "0", "epochId"),
      committeeSize: a.committeeSize,
      threshold: a.threshold,
      randEpoch: a.randEpoch ?? new Uint8Array(),
      commitBlocks: u64(a.commitBlocks, "0", "commitBlocks"),
      complaintBlocks: u64(a.complaintBlocks, "0", "complaintBlocks"),
      revealBlocks: u64(a.revealBlocks, "0", "revealBlocks"),
      finalizeBlocks: u64(a.finalizeBlocks, "0", "finalizeBlocks")
    };
    const eo: EncodeObject = { typeUrl: OCP_TYPE_URLS.dealer.beginEpoch, value: msg };
    return signAndBroadcast([eo], a.memo);
  }

  async function dealerDkgCommit(a: { dealer: string; epochId: UintLike; commitments: Uint8Array[]; memo?: string }): Promise<DeliverTxResponse> {
    const msg: MsgDkgCommit = { dealer: a.dealer.trim(), epochId: toU64String(a.epochId, "epochId"), commitments: a.commitments };
    const eo: EncodeObject = { typeUrl: OCP_TYPE_URLS.dealer.dkgCommit, value: msg };
    return signAndBroadcast([eo], a.memo);
  }

  async function dealerDkgComplaintMissing(a: { complainer: string; epochId: UintLike; dealer: string; memo?: string }): Promise<DeliverTxResponse> {
    const msg: MsgDkgComplaintMissing = {
      complainer: a.complainer.trim(),
      epochId: toU64String(a.epochId, "epochId"),
      dealer: a.dealer.trim()
    };
    const eo: EncodeObject = { typeUrl: OCP_TYPE_URLS.dealer.dkgComplaintMissing, value: msg };
    return signAndBroadcast([eo], a.memo);
  }

  async function dealerDkgComplaintInvalid(a: {
    complainer: string;
    epochId: UintLike;
    dealer: string;
    shareMsg: Uint8Array;
    memo?: string;
  }): Promise<DeliverTxResponse> {
    const msg: MsgDkgComplaintInvalid = {
      complainer: a.complainer.trim(),
      epochId: toU64String(a.epochId, "epochId"),
      dealer: a.dealer.trim(),
      shareMsg: a.shareMsg
    };
    const eo: EncodeObject = { typeUrl: OCP_TYPE_URLS.dealer.dkgComplaintInvalid, value: msg };
    return signAndBroadcast([eo], a.memo);
  }

  async function dealerDkgShareReveal(a: { dealer: string; epochId: UintLike; to: string; share: Uint8Array; memo?: string }): Promise<DeliverTxResponse> {
    const msg: MsgDkgShareReveal = {
      dealer: a.dealer.trim(),
      epochId: toU64String(a.epochId, "epochId"),
      to: a.to.trim(),
      share: a.share
    };
    const eo: EncodeObject = { typeUrl: OCP_TYPE_URLS.dealer.dkgShareReveal, value: msg };
    return signAndBroadcast([eo], a.memo);
  }

  async function dealerFinalizeEpoch(a: { caller?: string; epochId: UintLike; memo?: string }): Promise<DeliverTxResponse> {
    const msg: MsgFinalizeEpoch = { caller: (a.caller ?? signing.address).trim(), epochId: toU64String(a.epochId, "epochId") };
    const eo: EncodeObject = { typeUrl: OCP_TYPE_URLS.dealer.finalizeEpoch, value: msg };
    return signAndBroadcast([eo], a.memo);
  }

  async function dealerDkgTimeout(a: { caller?: string; epochId: UintLike; memo?: string }): Promise<DeliverTxResponse> {
    const msg: MsgDkgTimeout = { caller: (a.caller ?? signing.address).trim(), epochId: toU64String(a.epochId, "epochId") };
    const eo: EncodeObject = { typeUrl: OCP_TYPE_URLS.dealer.dkgTimeout, value: msg };
    return signAndBroadcast([eo], a.memo);
  }

  async function dealerInitHand(a: {
    caller?: string;
    tableId: UintLike;
    handId: UintLike;
    epochId: UintLike;
    deckSize?: number;
    memo?: string;
  }): Promise<DeliverTxResponse> {
    const msg: MsgInitHand = {
      caller: (a.caller ?? signing.address).trim(),
      tableId: toU64String(a.tableId, "tableId"),
      handId: toU64String(a.handId, "handId"),
      epochId: toU64String(a.epochId, "epochId"),
      deckSize: a.deckSize ?? 0
    };
    const eo: EncodeObject = { typeUrl: OCP_TYPE_URLS.dealer.initHand, value: msg };
    return signAndBroadcast([eo], a.memo);
  }

  async function dealerSubmitShuffle(a: {
    shuffler: string;
    tableId: UintLike;
    handId: UintLike;
    round: number;
    proofShuffle: Uint8Array;
    memo?: string;
  }): Promise<DeliverTxResponse> {
    const msg: MsgSubmitShuffle = {
      shuffler: a.shuffler.trim(),
      tableId: toU64String(a.tableId, "tableId"),
      handId: toU64String(a.handId, "handId"),
      round: a.round,
      proofShuffle: a.proofShuffle
    };
    const eo: EncodeObject = { typeUrl: OCP_TYPE_URLS.dealer.submitShuffle, value: msg };
    return signAndBroadcast([eo], a.memo);
  }

  async function dealerFinalizeDeck(a: { caller?: string; tableId: UintLike; handId: UintLike; memo?: string }): Promise<DeliverTxResponse> {
    const msg: MsgFinalizeDeck = {
      caller: (a.caller ?? signing.address).trim(),
      tableId: toU64String(a.tableId, "tableId"),
      handId: toU64String(a.handId, "handId")
    };
    const eo: EncodeObject = { typeUrl: OCP_TYPE_URLS.dealer.finalizeDeck, value: msg };
    return signAndBroadcast([eo], a.memo);
  }

  async function dealerSubmitPubShare(a: {
    validator: string;
    tableId: UintLike;
    handId: UintLike;
    pos: number;
    pubShare: Uint8Array;
    proofShare: Uint8Array;
    memo?: string;
  }): Promise<DeliverTxResponse> {
    const msg: MsgSubmitPubShare = {
      validator: a.validator.trim(),
      tableId: toU64String(a.tableId, "tableId"),
      handId: toU64String(a.handId, "handId"),
      pos: a.pos,
      pubShare: a.pubShare,
      proofShare: a.proofShare
    };
    const eo: EncodeObject = { typeUrl: OCP_TYPE_URLS.dealer.submitPubShare, value: msg };
    return signAndBroadcast([eo], a.memo);
  }

  async function dealerSubmitEncShare(a: {
    validator: string;
    tableId: UintLike;
    handId: UintLike;
    pos: number;
    pkPlayer: Uint8Array;
    encShare: Uint8Array;
    proofEncShare: Uint8Array;
    memo?: string;
  }): Promise<DeliverTxResponse> {
    const msg: MsgSubmitEncShare = {
      validator: a.validator.trim(),
      tableId: toU64String(a.tableId, "tableId"),
      handId: toU64String(a.handId, "handId"),
      pos: a.pos,
      pkPlayer: a.pkPlayer,
      encShare: a.encShare,
      proofEncShare: a.proofEncShare
    };
    const eo: EncodeObject = { typeUrl: OCP_TYPE_URLS.dealer.submitEncShare, value: msg };
    return signAndBroadcast([eo], a.memo);
  }

  async function dealerFinalizeReveal(a: { caller?: string; tableId: UintLike; handId: UintLike; pos: number; memo?: string }): Promise<DeliverTxResponse> {
    const msg: MsgFinalizeReveal = {
      caller: (a.caller ?? signing.address).trim(),
      tableId: toU64String(a.tableId, "tableId"),
      handId: toU64String(a.handId, "handId"),
      pos: a.pos
    };
    const eo: EncodeObject = { typeUrl: OCP_TYPE_URLS.dealer.finalizeReveal, value: msg };
    return signAndBroadcast([eo], a.memo);
  }

  async function dealerTimeout(a: { caller?: string; tableId: UintLike; handId: UintLike; memo?: string }): Promise<DeliverTxResponse> {
    const msg: MsgTimeout = {
      caller: (a.caller ?? signing.address).trim(),
      tableId: toU64String(a.tableId, "tableId"),
      handId: toU64String(a.handId, "handId")
    };
    const eo: EncodeObject = { typeUrl: OCP_TYPE_URLS.dealer.timeout, value: msg };
    return signAndBroadcast([eo], a.memo);
  }

  return {
    signing,
    lcd,

    getTables,
    getTable,

    getDealerEpoch,
    getDealerDkg,
    getDealerHand,

    pokerCreateTable,
    pokerSit,
    pokerStartHand,
    pokerAct,
    pokerTick,
    pokerLeave,

    dealerBeginEpoch,
    dealerDkgCommit,
    dealerDkgComplaintMissing,
    dealerDkgComplaintInvalid,
    dealerDkgShareReveal,
    dealerFinalizeEpoch,
    dealerDkgTimeout,
    dealerInitHand,
    dealerSubmitShuffle,
    dealerFinalizeDeck,
    dealerSubmitPubShare,
    dealerSubmitEncShare,
    dealerFinalizeReveal,
    dealerTimeout
  };
}

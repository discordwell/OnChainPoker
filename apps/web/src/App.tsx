import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CosmosLcdClient,
  connectOcpCosmosSigningClient,
  createOcpCosmosClient,
  createOcpRegistry,
  findEventAttr,
  type OcpCosmosClient
} from "@onchainpoker/ocp-sdk/cosmos";
import { groupElementToBytes, mulBase, scalarFromBytesModOrder } from "@onchainpoker/ocp-crypto";
import { PokerTable, type HandResult } from "./components/PokerTable";
import { deriveTableProps } from "./components/useTableState";
import { useHoleCards } from "./components/useHoleCards";
import { encryptEntropy, decryptEntropy, isEncryptedBundle, parseBundle } from "./keyEncryption";
import { parsePlayerTable, type PlayerTableState } from "./lib/parsePlayerTable";
import { useChainVerification } from "./components/useChainVerification";
import { ChainVerificationBadge } from "./components/ChainVerificationBadge";
import { useCometBftEvents } from "./components/useCometBftEvents";
import type { ChainEvent as CometChainEvent } from "./lib/cometEventParser";

type TableInfo = {
  tableId: string;
  label?: string;
  params: {
    maxPlayers: number;
    smallBlind: string;
    bigBlind: string;
    minBuyIn: string;
    maxBuyIn: string;
    passwordHash?: string;
  };
  status: "open" | "in_hand" | "closed";
  updatedAtMs: number;
};

type SeatIntent = {
  intentId: string;
  tableId: string;
  seat: number;
  player: string;
  pkPlayer?: string;
  buyIn?: string;
  bond?: string;
  createdAtMs: number;
  expiresAtMs: number;
};

type ChainEvent = {
  name: string;
  tableId?: string;
  handId?: string;
  eventIndex: number;
  timeMs: number;
  data?: unknown;
};

type HealthResponse = {
  ok: boolean;
  name: string;
  chainAdapter: string;
  nowMs: number;
};

type QueryState<T> = {
  loading: boolean;
  data: T | null;
  error: string | null;
};

type SeatSubmitState = {
  kind: "idle" | "pending" | "success" | "error";
  message: string | null;
};

type PlayerTxState = {
  kind: "idle" | "pending" | "success" | "error";
  message: string | null;
};

type PlayerWalletStatus = "disconnected" | "connecting" | "connected" | "error";

type PlayerWalletState = {
  status: PlayerWalletStatus;
  address: string;
  chainId: string;
  error: string | null;
};


type PlayerSeatForm = {
  buyIn: string;
  password: string;
};

type PlayerActionForm = {
  action: "fold" | "check" | "call" | "bet" | "raise";
  amount: string;
};

type CreateTableForm = {
  label: string;
  smallBlind: string;
  bigBlind: string;
  minBuyIn: string;
  maxBuyIn: string;
  maxPlayers: string;
  password: string;
  actionTimeoutSecs: string;
  dealerTimeoutSecs: string;
  playerBond: string;
  rakeBps: string;
};

type LobbyFilter = {
  search: string;
  status: "all" | "open" | "in_hand";
  password: "all" | "open" | "protected";
  sort: "id-asc" | "id-desc" | "blinds-asc" | "blinds-desc";
};

type WsStatus = "connecting" | "open" | "closed" | "error";

type KeplrLike = {
  enable: (chainId: string) => Promise<void>;
  getOfflineSignerAuto?: (chainId: string) => Promise<unknown> | unknown;
  getOfflineSigner?: (chainId: string) => Promise<unknown> | unknown;
  getKey: (chainId: string) => Promise<{ bech32Address: string }>;
};

type WindowWithKeplr = Window & { keplr?: KeplrLike };

type SeatFormState = {
  player: string;
  seat: string;
  buyIn: string;
  bond: string;
  pkPlayer: string;
};

function uint8ToBase64(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out);
}

function base64ToUint8(raw: string | null): Uint8Array | null {
  if (!raw) return null;
  try {
    const decoded = atob(raw);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

const DEFAULT_COORDINATOR_HTTP_URL =
  import.meta.env.VITE_COORDINATOR_HTTP_URL ?? "http://127.0.0.1:8788";
const DEFAULT_COSMOS_RPC_URL = import.meta.env.VITE_COSMOS_RPC_URL ?? "http://127.0.0.1:26657";
const DEFAULT_COSMOS_LCD_URL = import.meta.env.VITE_COSMOS_LCD_URL ?? "http://127.0.0.1:1317";
const DEFAULT_COSMOS_CHAIN_ID = import.meta.env.VITE_COSMOS_CHAIN_ID ?? "ocp-local-1";
const DEFAULT_COSMOS_GAS_PRICE = import.meta.env.VITE_COSMOS_GAS_PRICE ?? "0uocp";
const PLAYER_SK_KEY_PREFIX = "ocp.web.skPlayer";
const LEGACY_PK_KEY_PREFIX = "ocp.web.pkPlayer";
const MAX_EVENTS = 200;
const HAND_HISTORY_KEY = "ocp.web.handHistory";
const PLAYER_NOTES_KEY = "ocp.web.playerNotes";
const MAX_CHAT_MESSAGES = 50;

type ChatMsg = {
  sender: string;
  text: string;
  timeMs: number;
};

function loadPlayerNotes(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PLAYER_NOTES_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch { return {}; }
}

function savePlayerNotes(notes: Record<string, string>) {
  try {
    localStorage.setItem(PLAYER_NOTES_KEY, JSON.stringify(notes));
  } catch { /* localStorage full */ }
}

function loadHandHistory(): Map<string, HandResult[]> {
  try {
    const raw = localStorage.getItem(HAND_HISTORY_KEY);
    if (!raw) return new Map();
    return new Map(Object.entries(JSON.parse(raw)));
  } catch { return new Map(); }
}

function saveHandHistory(h: Map<string, HandResult[]>) {
  try {
    const obj: Record<string, HandResult[]> = {};
    for (const [k, v] of h) obj[k] = v;
    localStorage.setItem(HAND_HISTORY_KEY, JSON.stringify(obj));
  } catch { /* localStorage full */ }
}

type KeyState = "none" | "locked" | "unlocked";

function keysFromEntropy(entropy: Uint8Array): { sk: bigint; pk: Uint8Array } {
  const scalar = scalarFromBytesModOrder(entropy);
  const pk = groupElementToBytes(mulBase(scalar));
  return { sk: scalar, pk };
}

/**
 * Returns keys if plaintext, or null + keyState="locked" if encrypted.
 * Generates new keys if nothing stored.
 */
function getPlayerKeysSync(address: string): { sk: bigint; pk: Uint8Array; keyState: KeyState } {
  if (typeof window === "undefined") {
    throw new Error("wallet support requires a browser context");
  }

  const key = `${PLAYER_SK_KEY_PREFIX}:${address}`;
  const stored = window.localStorage.getItem(key);

  // Encrypted bundle — needs passphrase
  if (stored && isEncryptedBundle(stored)) {
    return { sk: 0n, pk: new Uint8Array(), keyState: "locked" };
  }

  const existing = base64ToUint8(stored);
  if (existing && existing.length === 64) {
    const { sk, pk } = keysFromEntropy(existing);
    return { sk, pk, keyState: "unlocked" };
  }

  // Migration: detect old 32-byte pubkey-only entries and regenerate
  const legacyKey = `${LEGACY_PK_KEY_PREFIX}:${address}`;
  const legacy = window.localStorage.getItem(legacyKey);
  if (legacy) {
    console.warn(
      `[OCP] Migrating player key for ${address}: old pubkey-only entry found. ` +
      `Generating new keypair — you will need to re-sit at tables.`
    );
    window.localStorage.removeItem(legacyKey);
  }

  const entropy = new Uint8Array(64);
  window.crypto.getRandomValues(entropy);
  window.localStorage.setItem(key, uint8ToBase64(entropy));

  const { sk, pk } = keysFromEntropy(entropy);
  return { sk, pk, keyState: "unlocked" };
}

async function unlockPlayerKeys(address: string, passphrase: string): Promise<{ sk: bigint; pk: Uint8Array }> {
  const key = `${PLAYER_SK_KEY_PREFIX}:${address}`;
  const stored = window.localStorage.getItem(key);
  if (!stored || !isEncryptedBundle(stored)) {
    throw new Error("Key is not encrypted");
  }
  const bundle = parseBundle(stored);
  const entropy = await decryptEntropy(bundle, passphrase);
  return keysFromEntropy(entropy);
}

async function protectPlayerKeys(address: string, passphrase: string): Promise<void> {
  const key = `${PLAYER_SK_KEY_PREFIX}:${address}`;
  const stored = window.localStorage.getItem(key);
  if (!stored || isEncryptedBundle(stored)) {
    throw new Error("Key is already encrypted or not found");
  }
  const entropy = base64ToUint8(stored);
  if (!entropy || entropy.length !== 64) {
    throw new Error("Invalid key material");
  }
  const bundle = await encryptEntropy(entropy, passphrase);
  window.localStorage.setItem(key, JSON.stringify(bundle));
}

/** Legacy compat: sync getter for pkPlayer during sit (needs unlocked state) */
function getPlayerKeysForAddress(address: string): { sk: bigint; pk: Uint8Array } {
  const result = getPlayerKeysSync(address);
  if (result.keyState === "locked") {
    throw new Error("Keys are encrypted — unlock first");
  }
  return { sk: result.sk, pk: result.pk };
}


function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeCoordinatorBase(raw: string): string {
  const input = raw.trim();
  if (!input) return trimTrailingSlashes(DEFAULT_COORDINATOR_HTTP_URL);

  try {
    const absolute = new URL(input, window.location.origin);
    return trimTrailingSlashes(absolute.toString());
  } catch {
    return trimTrailingSlashes(DEFAULT_COORDINATOR_HTTP_URL);
  }
}

function toWsUrl(httpBase: string): string {
  const base = new URL(httpBase, window.location.origin);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/ws`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function formatTimestamp(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleString();
}

function formatRelative(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "-";
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  if (abs < 1_000) return "now";
  if (abs < 60_000) return `${Math.round(abs / 1_000)}s ${diff > 0 ? "left" : "ago"}`;
  return `${Math.round(abs / 60_000)}m ${diff > 0 ? "left" : "ago"}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }
  return (await response.json()) as T;
}

function statusTone(status: TableInfo["status"]): string {
  if (status === "in_hand") return "status-live";
  if (status === "closed") return "status-closed";
  return "status-open";
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "";
}

function wsTone(status: WsStatus): string {
  if (status === "open") return "status-open";
  if (status === "error") return "status-closed";
  if (status === "connecting") return "status-live";
  return "status-muted";
}

function initialCoordinatorBase(): string {
  const saved = window.localStorage.getItem("ocp.web.coordinatorBase") ?? "";
  return normalizeCoordinatorBase(saved || DEFAULT_COORDINATOR_HTTP_URL);
}

function defaultSeatForm(): SeatFormState {
  return {
    player: "",
    seat: "0",
    buyIn: "",
    bond: "",
    pkPlayer: ""
  };
}

function defaultPlayerSeatForm(): PlayerSeatForm {
  return {
    buyIn: "",
    password: ""
  };
}

function defaultPlayerActionForm(): PlayerActionForm {
  return {
    action: "check",
    amount: ""
  };
}

function defaultCreateTableForm(): CreateTableForm {
  return {
    label: "",
    smallBlind: "1",
    bigBlind: "2",
    minBuyIn: "100",
    maxBuyIn: "1000",
    maxPlayers: "9",
    password: "",
    actionTimeoutSecs: "30",
    dealerTimeoutSecs: "120",
    playerBond: "0",
    rakeBps: "0",
  };
}

export function App() {
  const [coordinatorInput, setCoordinatorInput] = useState<string>(initialCoordinatorBase);
  const [coordinatorBase, setCoordinatorBase] = useState<string>(initialCoordinatorBase);

  const [health, setHealth] = useState<QueryState<HealthResponse>>({
    loading: true,
    data: null,
    error: null
  });

  const [tables, setTables] = useState<QueryState<TableInfo[]>>({
    loading: true,
    data: null,
    error: null
  });

  const [selectedTableId, setSelectedTableId] = useState<string>("");
  const [seatIntents, setSeatIntents] = useState<QueryState<SeatIntent[]>>({
    loading: false,
    data: null,
    error: null
  });

  const [rawTable, setRawTable] = useState<QueryState<unknown>>({
    loading: false,
    data: null,
    error: null
  });

  const [dealerNext, setDealerNext] = useState<QueryState<unknown>>({
    loading: false,
    data: null,
    error: null
  });

  const [seatForm, setSeatForm] = useState<SeatFormState>(defaultSeatForm);
  const [seatSubmit, setSeatSubmit] = useState<SeatSubmitState>({ kind: "idle", message: null });

  const [playerWallet, setPlayerWallet] = useState<PlayerWalletState>({
    status: "disconnected",
    address: "",
    chainId: DEFAULT_COSMOS_CHAIN_ID,
    error: null
  });

  const [playerTable, setPlayerTable] = useState<QueryState<PlayerTableState | null>>({
    loading: false,
    data: null,
    error: null
  });

  const [playerSeatForm, setPlayerSeatForm] = useState<PlayerSeatForm>(defaultPlayerSeatForm);
  const [playerActionForm, setPlayerActionForm] = useState<PlayerActionForm>(defaultPlayerActionForm);
  const [playerSitSubmit, setPlayerSitSubmit] = useState<PlayerTxState>({
    kind: "idle",
    message: null
  });
  const [playerActionSubmit, setPlayerActionSubmit] = useState<PlayerTxState>({
    kind: "idle",
    message: null
  });
  const [playerLeaveSubmit, setPlayerLeaveSubmit] = useState<PlayerTxState>({
    kind: "idle",
    message: null
  });

  const [createTableForm, setCreateTableForm] = useState<CreateTableForm>(defaultCreateTableForm);
  const [createTableSubmit, setCreateTableSubmit] = useState<PlayerTxState>({ kind: "idle", message: null });
  const [showCreateAdvanced, setShowCreateAdvanced] = useState(false);
  const [rebuyAmount, setRebuyAmount] = useState("");
  const [rebuySubmit, setRebuySubmit] = useState<PlayerTxState>({ kind: "idle", message: null });
  const [lobbyFilter, setLobbyFilter] = useState<LobbyFilter>({
    search: "", status: "all", password: "all", sort: "id-asc",
  });

  const [seatedTableIds, setSeatedTableIds] = useState<string[]>([]);

  const [events, setEvents] = useState<ChainEvent[]>([]);
  const [handHistory, setHandHistory] = useState<Map<string, HandResult[]>>(loadHandHistory);
  const [wsStatus, setWsStatus] = useState<WsStatus>("connecting");
  const [wsError, setWsError] = useState<string | null>(null);

  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const [playerNotes, setPlayerNotes] = useState<Record<string, string>>(loadPlayerNotes);

  useEffect(() => { saveHandHistory(handHistory); }, [handHistory]);
  useEffect(() => { savePlayerNotes(playerNotes); }, [playerNotes]);

  const wsRef = useRef<WebSocket | null>(null);
  const playerClientRef = useRef<OcpCosmosClient | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const subscribedTableRef = useRef<string | null>(null);
  const selectedTableRef = useRef<string>("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ChainEvent types differ slightly between App and cometEventParser
  const recordCoordinatorEventRef = useRef<(event: any) => boolean>(() => true);

  const apiUrl = useCallback(
    (path: string) => `${coordinatorBase}${path.startsWith("/") ? path : `/${path}`}`,
    [coordinatorBase]
  );

  const loadHealth = useCallback(async () => {
    setHealth((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await fetchJson<HealthResponse>(apiUrl("/health"));
      setHealth({ loading: false, data, error: null });
    } catch (err) {
      setHealth({ loading: false, data: null, error: errorMessage(err) });
    }
  }, [apiUrl]);

  const loadTables = useCallback(
    async (showSpinner = true) => {
      if (showSpinner) {
        setTables((prev) => ({ ...prev, loading: true, error: null }));
      }
      try {
        const payload = await fetchJson<{ tables: TableInfo[] }>(apiUrl("/v1/tables"));
        const nextTables = payload.tables ?? [];
        setTables({ loading: false, data: nextTables, error: null });

        setSelectedTableId((current) => {
          if (current && nextTables.some((table) => table.tableId === current)) return current;
          return nextTables[0]?.tableId ?? "";
        });
      } catch (err) {
        setTables({ loading: false, data: null, error: errorMessage(err) });
      }
    },
    [apiUrl]
  );

  const loadSeatIntents = useCallback(
    async (tableId: string, showSpinner = true) => {
      if (!tableId) {
        setSeatIntents({ loading: false, data: null, error: null });
        return;
      }

      if (showSpinner) {
        setSeatIntents((prev) => ({ ...prev, loading: true, error: null }));
      }

      try {
        const payload = await fetchJson<{ intents: SeatIntent[] }>(
          apiUrl(`/v1/seat-intents?tableId=${encodeURIComponent(tableId)}`)
        );
        setSeatIntents({ loading: false, data: payload.intents ?? [], error: null });
      } catch (err) {
        setSeatIntents({ loading: false, data: null, error: errorMessage(err) });
      }
    },
    [apiUrl]
  );

  const loadDealerViews = useCallback(
    async (tableId: string) => {
      if (!tableId) {
        setRawTable({ loading: false, data: null, error: null });
        setDealerNext({ loading: false, data: null, error: null });
        return;
      }

      setRawTable({ loading: true, data: null, error: null });
      setDealerNext({ loading: true, data: null, error: null });

      const [tableResp, dealerResp] = await Promise.allSettled([
        fetchJson<{ table: unknown }>(apiUrl(`/v1/appchain/v0/tables/${encodeURIComponent(tableId)}`)),
        fetchJson<{ action?: unknown; tableId?: string; handId?: number }>(
          apiUrl(`/v1/appchain/v0/tables/${encodeURIComponent(tableId)}/dealer/next`)
        )
      ]);

      if (tableResp.status === "fulfilled") {
        setRawTable({ loading: false, data: tableResp.value.table, error: null });
      } else {
        setRawTable({
          loading: false,
          data: null,
          error: errorMessage(tableResp.reason)
        });
      }

      if (dealerResp.status === "fulfilled") {
        setDealerNext({ loading: false, data: dealerResp.value, error: null });
      } else {
        setDealerNext({
          loading: false,
          data: null,
          error: errorMessage(dealerResp.reason)
        });
      }
    },
    [apiUrl]
  );

  const loadPlayerTable = useCallback(async (tableId: string, showSpinner = true) => {
    const client = playerClientRef.current;
    if (!client) {
      setPlayerTable({
        loading: false,
        data: null,
        error: "Connect wallet to load player table state."
      });
      return;
    }

    if (!tableId) {
      setPlayerTable({ loading: false, data: null, error: null });
      return;
    }

    if (showSpinner) {
      setPlayerTable((prev) => ({ ...prev, loading: true, error: null }));
    }

    try {
      const rawTable = await client.getTable(tableId);
      const table = parsePlayerTable(rawTable);
      if (!table) {
        throw new Error("Unexpected player table shape.");
      }
      setPlayerTable({ loading: false, data: table, error: null });
    } catch (err) {
      setPlayerTable({ loading: false, data: null, error: errorMessage(err) });
    }
  }, []);

  const scheduleTableRefresh = useCallback(() => {
    if (refreshTimerRef.current != null) return;
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void loadTables(false);
    }, 400);
  }, [loadTables]);

  useEffect(() => {
    selectedTableRef.current = selectedTableId;
  }, [selectedTableId]);

  useEffect(() => {
    void loadHealth();
    const timer = window.setInterval(() => void loadHealth(), 15_000);
    return () => window.clearInterval(timer);
  }, [loadHealth]);

  useEffect(() => {
    void loadTables(true);
    const timer = window.setInterval(() => void loadTables(false), 5_000);
    return () => window.clearInterval(timer);
  }, [loadTables]);

  useEffect(() => {
    if (!selectedTableId) {
      setSeatIntents({ loading: false, data: null, error: null });
      setRawTable({ loading: false, data: null, error: null });
      setDealerNext({ loading: false, data: null, error: null });
      return;
    }

    void loadSeatIntents(selectedTableId, true);
    void loadDealerViews(selectedTableId);
  }, [selectedTableId, loadSeatIntents, loadDealerViews]);

  useEffect(() => {
    if (!selectedTableId || playerWallet.status !== "connected") {
      setPlayerTable({ loading: false, data: null, error: null });
      return;
    }

    void loadPlayerTable(selectedTableId, true);
  }, [playerWallet.status, selectedTableId, loadPlayerTable]);

  useEffect(() => {
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      setWsStatus("connecting");
      setWsError(null);

      const ws = new WebSocket(toWsUrl(coordinatorBase));
      wsRef.current = ws;

      ws.onopen = () => {
        if (stopped) {
          ws.close();
          return;
        }

        setWsStatus("open");
        ws.send(JSON.stringify({ type: "subscribe", topic: "global" }));

        const currentTable = selectedTableRef.current;
        subscribedTableRef.current = null;
        if (currentTable) {
          ws.send(
            JSON.stringify({ type: "subscribe", topic: "table", tableId: currentTable })
          );
          subscribedTableRef.current = currentTable;
        }
      };

      ws.onmessage = (event) => {
        if (stopped) return;

        let payload: unknown;
        try {
          payload = JSON.parse(String(event.data));
        } catch {
          return;
        }

        if (!payload || typeof payload !== "object") return;
        const msg = payload as Record<string, unknown>;

        if (msg.type === "error") {
          setWsError(String(msg.error ?? "WebSocket subscription error"));
          return;
        }

        if (msg.type === "event") {
          const chainEvent = msg.event as ChainEvent | undefined;
          if (!chainEvent || typeof chainEvent.name !== "string") return;

          // Always add to event log
          setEvents((prev) => [chainEvent, ...prev].slice(0, MAX_EVENTS));

          // Dedup: if CometBFT already triggered refresh, skip coordinator's refresh
          const coordFirst = recordCoordinatorEventRef.current(chainEvent);
          if (coordFirst) {
            scheduleTableRefresh();

            if (chainEvent.tableId && chainEvent.tableId === selectedTableRef.current) {
              void loadSeatIntents(chainEvent.tableId, false);
              void loadDealerViews(chainEvent.tableId);
              if (playerClientRef.current) {
                void loadPlayerTable(chainEvent.tableId, false);
              }
            }
          }

          return;
        }

        if (msg.type === "table_chat") {
          const chatMsg: ChatMsg = {
            sender: String(msg.sender ?? ""),
            text: String(msg.text ?? ""),
            timeMs: Number(msg.timeMs ?? Date.now()),
          };
          setChatMessages((prev) => [...prev, chatMsg].slice(-MAX_CHAT_MESSAGES));
          return;
        }

        if (msg.type === "chat_history") {
          const messages = Array.isArray(msg.messages) ? msg.messages : [];
          setChatMessages(messages.map((m: any) => ({
            sender: String(m.sender ?? ""),
            text: String(m.text ?? ""),
            timeMs: Number(m.timeMs ?? 0),
          })));
          return;
        }

        if (msg.type === "seat_intent") {
          const data = msg.intent as SeatIntent | undefined;
          if (data?.tableId && data.tableId === selectedTableRef.current) {
            void loadSeatIntents(data.tableId, false);
          }
        }
      };

      ws.onerror = () => {
        if (stopped) return;
        setWsStatus("error");
        setWsError("Socket transport error");
      };

      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (stopped) return;

        setWsStatus("closed");
        if (reconnectTimerRef.current != null) return;

        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, 1_500);
      };
    };

    connect();

    return () => {
      stopped = true;

      if (refreshTimerRef.current != null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }

      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
  }, [coordinatorBase, loadSeatIntents, loadDealerViews, loadPlayerTable, scheduleTableRefresh]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const previous = subscribedTableRef.current;
    if (previous && previous !== selectedTableId) {
      ws.send(JSON.stringify({ type: "unsubscribe", topic: "table", tableId: previous }));
      subscribedTableRef.current = null;
    }

    if (selectedTableId && selectedTableId !== previous) {
      ws.send(JSON.stringify({ type: "subscribe", topic: "table", tableId: selectedTableId }));
      subscribedTableRef.current = selectedTableId;
      setChatMessages([]);
      // Request chat history for the new table
      ws.send(JSON.stringify({ type: "chat_history", tableId: selectedTableId }));
    }
  }, [selectedTableId]);

  const tableList = tables.data ?? [];
  const filteredTableList = useMemo(() => {
    let list = [...tableList];

    // Search filter (by ID or label)
    const q = lobbyFilter.search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (t) => t.tableId.toLowerCase().includes(q) || (t.label ?? "").toLowerCase().includes(q)
      );
    }

    // Status filter
    if (lobbyFilter.status !== "all") {
      list = list.filter((t) => t.status === lobbyFilter.status);
    }

    // Password filter
    if (lobbyFilter.password === "open") {
      list = list.filter((t) => !t.params.passwordHash);
    } else if (lobbyFilter.password === "protected") {
      list = list.filter((t) => !!t.params.passwordHash);
    }

    // Sort
    list.sort((a, b) => {
      switch (lobbyFilter.sort) {
        case "id-asc": return Number(a.tableId) - Number(b.tableId);
        case "id-desc": return Number(b.tableId) - Number(a.tableId);
        case "blinds-asc": return Number(a.params.bigBlind) - Number(b.params.bigBlind);
        case "blinds-desc": return Number(b.params.bigBlind) - Number(a.params.bigBlind);
        default: return 0;
      }
    });

    return list;
  }, [tableList, lobbyFilter]);

  const selectedTable = useMemo(
    () => tableList.find((table) => table.tableId === selectedTableId) ?? null,
    [tableList, selectedTableId]
  );
  const playerTableForSelected = useMemo(
    () => (playerTable.data?.tableId === selectedTableId ? playerTable.data : null),
    [playerTable.data, selectedTableId]
  );
  const playerSeat = useMemo(
    () => playerTableForSelected?.seats.find((seat) => seat.player === playerWallet.address) ?? null,
    [playerTableForSelected, playerWallet.address]
  );
  const playerActionEnabled = Boolean(
    playerSeat && playerTableForSelected?.hand?.actionOn === playerSeat.seat
  );

  const chainVerification = useChainVerification({
    coordinatorRawTable: rawTable.data,
    playerTable: playerTable.data,
    enabled: playerWallet.status === "connected",
  });

  // CometBFT direct WebSocket — supplementary event source for timing verification
  const handleCometEvent = useCallback(
    (ev: CometChainEvent) => {
      // Mirror coordinator's refresh logic (without setEvents to avoid duplicate log entries)
      scheduleTableRefresh();
      if (ev.tableId && ev.tableId === selectedTableRef.current) {
        void loadSeatIntents(ev.tableId, false);
        void loadDealerViews(ev.tableId);
        if (playerClientRef.current) {
          void loadPlayerTable(ev.tableId, false);
        }
      }
    },
    [scheduleTableRefresh, loadSeatIntents, loadDealerViews, loadPlayerTable],
  );

  const { metrics: cometMetrics, recordCoordinatorEvent } = useCometBftEvents({
    rpcUrl: DEFAULT_COSMOS_RPC_URL,
    enabled: true,
    selectedTableId,
    onChainEvent: handleCometEvent,
  });
  recordCoordinatorEventRef.current = recordCoordinatorEvent;

  // Sync seatedTableIds from observed player table state
  useEffect(() => {
    if (!selectedTableId || !playerTableForSelected || playerWallet.status !== "connected") return;
    const isSeated = playerTableForSelected.seats.some((s) => s.player === playerWallet.address);
    setSeatedTableIds((prev) => {
      if (isSeated && !prev.includes(selectedTableId)) return [...prev, selectedTableId];
      if (!isSeated && prev.includes(selectedTableId)) return prev.filter((id) => id !== selectedTableId);
      return prev;
    });
  }, [playerTableForSelected, selectedTableId, playerWallet.status, playerWallet.address]);

  // Clear seated tables on wallet disconnect
  useEffect(() => {
    if (playerWallet.status !== "connected") setSeatedTableIds([]);
  }, [playerWallet.status]);

  // Track hand completion for history (per-table)
  const lastHandRef = useRef<{ handId: string; pot: string; board: number[] } | null>(null);

  // Accumulator for in-progress showdown data from chain events
  const pendingShowdownRef = useRef<Map<string, {
    revealedCards: Record<number, string[]>;
    winners: Array<{ seat: number; amount: string }>;
  }>>(new Map());

  const MAX_HISTORY_PER_TABLE = 20;

  const addHandResult = useCallback((tableId: string, result: HandResult) => {
    setHandHistory((prev) => {
      const next = new Map(prev);
      const list = next.get(tableId) ?? [];
      if (list.some((h) => h.handId === result.handId)) return prev;
      next.set(tableId, [result, ...list].slice(0, MAX_HISTORY_PER_TABLE));
      return next;
    });
  }, []);

  const updateHandResult = useCallback((tableId: string, handId: string, update: Partial<HandResult>) => {
    setHandHistory((prev) => {
      const list = prev.get(tableId);
      if (!list) return prev;
      const idx = list.findIndex((h) => h.handId === handId);
      if (idx < 0) return prev;
      const next = new Map(prev);
      const updated = [...list];
      updated[idx] = { ...updated[idx]!, ...update };
      next.set(tableId, updated);
      return next;
    });
  }, []);

  useEffect(() => {
    const currentHand = playerTableForSelected?.hand;
    const prevHand = lastHandRef.current;

    if (currentHand) {
      lastHandRef.current = {
        handId: currentHand.handId,
        pot: currentHand.pot,
        board: currentHand.board,
      };
    } else if (prevHand && prevHand.handId && selectedTableId) {
      addHandResult(selectedTableId, {
        handId: prevHand.handId,
        winners: [],
        board: prevHand.board,
        pot: prevHand.pot,
        timestamp: Date.now(),
      });
      lastHandRef.current = null;
    }
  }, [playerTableForSelected, selectedTableId, addHandResult]);

  // Capture hand results from chain events (PotAwarded, HandCompleted, HoleCardRevealed)
  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[0];
    if (!latest || !latest.tableId) return;

    const tableId = latest.tableId;
    const data = latest.data as Record<string, string> | undefined;
    if (!data) return;
    const handId = String(latest.handId ?? data.handId ?? "");
    if (!handId) return;

    const pendingKey = `${tableId}:${handId}`;

    if (latest.name === "HoleCardRevealed") {
      const seat = Number(data.seat ?? -1);
      const card = data.card ?? "";
      if (seat < 0 || !card) return;

      const pending = pendingShowdownRef.current.get(pendingKey) ?? {
        revealedCards: {},
        winners: [],
      };
      const existing = pending.revealedCards[seat] ?? [];
      if (!existing.includes(card)) {
        pending.revealedCards[seat] = [...existing, card];
      }
      pendingShowdownRef.current.set(pendingKey, pending);

      // Also update any existing history entry in real-time
      updateHandResult(tableId, handId, { revealedCards: { ...pending.revealedCards } });
    }

    if (latest.name === "PotAwarded") {
      const amount = data.amount ?? "0";
      const winnersCSV = data.winners ?? "";
      const winnerSeats = winnersCSV.split(",").map(Number).filter((n) => Number.isFinite(n) && n >= 0);

      const pending = pendingShowdownRef.current.get(pendingKey) ?? {
        revealedCards: {},
        winners: [],
      };
      for (const seat of winnerSeats) {
        if (!pending.winners.some((w) => w.seat === seat)) {
          pending.winners.push({ seat, amount });
        }
      }
      pendingShowdownRef.current.set(pendingKey, pending);
    }

    if (latest.name === "HandCompleted") {
      const pending = pendingShowdownRef.current.get(pendingKey);
      const reason = data.reason ?? "";

      // For all-folded, extract winner from event attributes
      const winners: Array<{ seat: number; amount: string }> = pending?.winners ?? [];
      if (reason === "all-folded" && winners.length === 0) {
        const winnerSeat = Number(data.winnerSeat ?? -1);
        const pot = data.pot ?? "0";
        if (winnerSeat >= 0) {
          winners.push({ seat: winnerSeat, amount: pot });
        }
      }

      const street = data.street ?? "";
      const result: HandResult = {
        handId,
        winners,
        board: [],
        pot: data.pot ?? "0",
        timestamp: latest.timeMs,
        revealedCards: pending?.revealedCards,
        street: street || undefined,
        reason: reason || undefined,
      };

      // Try to merge with existing entry (which may have board info from state tracking)
      setHandHistory((prev) => {
        const next = new Map(prev);
        const list = next.get(tableId) ?? [];
        const existingIdx = list.findIndex((h) => h.handId === handId);
        if (existingIdx >= 0) {
          const updated = [...list];
          const existing = updated[existingIdx]!;
          updated[existingIdx] = {
            ...existing,
            winners: result.winners.length > 0 ? result.winners : existing.winners,
            revealedCards: result.revealedCards ?? existing.revealedCards,
            pot: result.pot !== "0" ? result.pot : existing.pot,
            street: result.street ?? existing.street,
            reason: result.reason ?? existing.reason,
          };
          next.set(tableId, updated);
        } else {
          next.set(tableId, [result, ...list].slice(0, MAX_HISTORY_PER_TABLE));
        }
        return next;
      });

      pendingShowdownRef.current.delete(pendingKey);
    }
  }, [events, updateHandResult]);

  // Player key state for hole card decryption + encryption management
  const [playerKeyState, setPlayerKeyState] = useState<KeyState>("none");
  const [playerSk, setPlayerSk] = useState<bigint | null>(null);
  const [playerPk, setPlayerPk] = useState<Uint8Array | null>(null);
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [protectPassphrase, setProtectPassphrase] = useState("");
  const [protectConfirm, setProtectConfirm] = useState("");
  const [protectStatus, setProtectStatus] = useState<string | null>(null);

  const KEY_LOCK_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
  const keyLockTimerRef = useRef<number | null>(null);
  const isInHandRef = useRef(false);
  const isKeyEncryptedRef = useRef(false);

  // Keep isInHandRef in sync with game state
  useEffect(() => {
    isInHandRef.current = Boolean(playerSeat?.inHand && playerTableForSelected?.hand);
  }, [playerSeat?.inHand, playerTableForSelected?.hand]);

  const resetKeyLockTimer = useCallback(() => {
    if (keyLockTimerRef.current != null) window.clearTimeout(keyLockTimerRef.current);
    // Only set timer if keys are encrypted on disk but unlocked in memory
    if (playerKeyState !== "unlocked" || !playerWallet.address) return;
    if (!isKeyEncryptedRef.current) return;
    keyLockTimerRef.current = window.setTimeout(() => {
      // Suppress auto-lock while player is in an active hand
      if (isInHandRef.current) {
        keyLockTimerRef.current = null;
        resetKeyLockTimer(); // reschedule
        return;
      }
      setPlayerSk(null);
      setPlayerPk(null);
      setPlayerKeyState("locked");
      keyLockTimerRef.current = null;
      console.log("[OCP] Keys auto-locked after inactivity");
    }, KEY_LOCK_TIMEOUT_MS);
  }, [playerKeyState, playerWallet.address]);

  // Reset lock timer on user activity
  useEffect(() => {
    if (playerKeyState !== "unlocked") return;
    window.addEventListener("click", resetKeyLockTimer);
    window.addEventListener("keydown", resetKeyLockTimer);
    resetKeyLockTimer(); // start initial timer
    return () => {
      window.removeEventListener("click", resetKeyLockTimer);
      window.removeEventListener("keydown", resetKeyLockTimer);
      if (keyLockTimerRef.current != null) {
        window.clearTimeout(keyLockTimerRef.current);
        keyLockTimerRef.current = null;
      }
    };
  }, [playerKeyState, resetKeyLockTimer]);

  // Initialize key state on wallet connect
  useEffect(() => {
    if (playerWallet.status !== "connected" || !playerWallet.address) {
      setPlayerKeyState("none");
      setPlayerSk(null);
      setPlayerPk(null);
      setKeyError(null);
      isKeyEncryptedRef.current = false;
      return;
    }
    try {
      const result = getPlayerKeysSync(playerWallet.address);
      const stored = window.localStorage.getItem(`${PLAYER_SK_KEY_PREFIX}:${playerWallet.address}`);
      isKeyEncryptedRef.current = Boolean(stored && isEncryptedBundle(stored));
      setPlayerKeyState(result.keyState);
      if (result.keyState === "unlocked") {
        setPlayerSk(result.sk);
        setPlayerPk(result.pk);
      } else {
        setPlayerSk(null);
        setPlayerPk(null);
      }
    } catch {
      setPlayerKeyState("none");
      setPlayerSk(null);
      setPlayerPk(null);
    }
  }, [playerWallet.status, playerWallet.address]);

  // Warn if local pk doesn't match on-chain pkPlayer (e.g. after key regeneration)
  useEffect(() => {
    if (!playerSk || !rawTable.data || !playerWallet.address) return;
    const raw = rawTable.data as Record<string, unknown>;
    const seats = Array.isArray(raw?.seats) ? raw.seats : [];
    const mySeat = (seats as Record<string, unknown>[]).find(
      (s) => String(s?.player ?? "").toLowerCase() === playerWallet.address.toLowerCase()
    );
    if (!mySeat) return;
    const chainPk = String(
      mySeat.pk ?? mySeat.pkPlayer ?? mySeat.pk_player ?? (mySeat as any).PkPlayer ?? ""
    );
    if (!chainPk) return;
    const { pk } = getPlayerKeysForAddress(playerWallet.address);
    const localPkBase64 = uint8ToBase64(pk);
    if (localPkBase64 !== chainPk) {
      console.warn(
        `[OCP] Local public key does not match on-chain pkPlayer for ${playerWallet.address}. ` +
        `You may need to re-sit to register your current key.`
      );
    }
  }, [playerSk, rawTable.data, playerWallet.address]);

  // Determine if deck is finalized from raw chain table state or player table
  const deckFinalized = useMemo(() => {
    function checkDealer(dealer: any): boolean {
      return Boolean(dealer?.deckFinalized || dealer?.deck_finalized || dealer?.finalized);
    }
    // Try raw table from coordinator v0 endpoint
    if (rawTable.data) {
      const raw = rawTable.data as any;
      if (checkDealer(raw?.hand?.dealer)) return true;
    }
    // Fall back to player table (LCD endpoint uses camelCase)
    if (playerTableForSelected?.hand) {
      const raw = playerTableForSelected as any;
      if (checkDealer(raw?.hand?.dealer)) return true;
    }
    return false;
  }, [rawTable.data, playerTableForSelected]);

  // Hole card recovery
  const holeCardState = useHoleCards({
    coordinatorBase,
    tableId: selectedTableId || null,
    handId: playerTableForSelected?.hand?.handId ?? null,
    seat: playerSeat?.seat ?? null,
    skPlayer: playerSk,
    deckFinalized,
  });

  const applyCoordinatorBase = useCallback(() => {
    const normalized = normalizeCoordinatorBase(coordinatorInput);
    setCoordinatorInput(normalized);
    setCoordinatorBase(normalized);
    setEvents([]);
    window.localStorage.setItem("ocp.web.coordinatorBase", normalized);
  }, [coordinatorInput]);

  const onSeatInputChange = useCallback(
    (field: keyof SeatFormState, value: string) => {
      setSeatForm((prev) => ({ ...prev, [field]: value }));
    },
    []
  );

  const onPlayerSeatInputChange = useCallback((field: keyof PlayerSeatForm, value: string) => {
    setPlayerSeatForm((prev) => ({ ...prev, [field]: value }));
  }, []);

  const onPlayerActionInputChange = useCallback((field: keyof PlayerActionForm, value: string) => {
    if (field === "action") {
      const nextAction = value as PlayerActionForm["action"];
      setPlayerActionForm((prev) => ({
        ...prev,
        action: nextAction,
        amount: nextAction === "bet" || nextAction === "raise" ? prev.amount : ""
      }));
      return;
    }

    setPlayerActionForm((prev) => ({ ...prev, [field]: value }));
  }, []);

  const connectWallet = useCallback(async () => {
    setPlayerWallet((prev) => ({ ...prev, status: "connecting", error: null }));
    setPlayerSitSubmit({ kind: "idle", message: null });
    setPlayerActionSubmit({ kind: "idle", message: null });
    setPlayerLeaveSubmit({ kind: "idle", message: null });

    try {
      const keplr = (window as WindowWithKeplr).keplr;
      if (!keplr) {
        throw new Error(
          "No wallet found. Install Keplr (or a wallet exposing getOfflineSigner / getOfflineSignerAuto)."
        );
      }

      await keplr.enable(DEFAULT_COSMOS_CHAIN_ID);

      const getSigner = keplr.getOfflineSignerAuto ?? keplr.getOfflineSigner;
      if (!getSigner) {
        throw new Error("Connected wallet does not expose an offline signer.");
      }

      const signer = (await Promise.resolve(
        getSigner.call(keplr, DEFAULT_COSMOS_CHAIN_ID)
      )) as Parameters<typeof connectOcpCosmosSigningClient>[0]["signer"];
      const key = await keplr.getKey(DEFAULT_COSMOS_CHAIN_ID);

      const signing = await connectOcpCosmosSigningClient({
        rpcUrl: DEFAULT_COSMOS_RPC_URL,
        signer,
        signerAddress: key.bech32Address,
        gasPrice: DEFAULT_COSMOS_GAS_PRICE,
        registry: createOcpRegistry()
      });

      const lcd = new CosmosLcdClient({ baseUrl: DEFAULT_COSMOS_LCD_URL });
      const client = createOcpCosmosClient({ signing, lcd });

      playerClientRef.current = client;
      setPlayerWallet({
        status: "connected",
        address: key.bech32Address,
        chainId: DEFAULT_COSMOS_CHAIN_ID,
        error: null
      });
      setPlayerActionForm(defaultPlayerActionForm());

      if (selectedTableId) {
        void loadPlayerTable(selectedTableId, true);
      }
    } catch (err) {
      playerClientRef.current = null;
      setPlayerWallet({
        status: "error",
        address: "",
        chainId: DEFAULT_COSMOS_CHAIN_ID,
        error: errorMessage(err)
      });
    }
  }, [loadPlayerTable, selectedTableId]);

  const submitPlayerSeat = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const tableId = selectedTableId;
      if (!tableId) return;

      if (!playerWallet.address) {
        setPlayerSitSubmit({ kind: "error", message: "Connect wallet first." });
        return;
      }

      const buyIn = playerSeatForm.buyIn.trim();
      if (!/^\d+$/.test(buyIn)) {
        setPlayerSitSubmit({
          kind: "error",
          message: "Buy-In must be a non-negative integer."
        });
        return;
      }

      const client = playerClientRef.current;
      if (!client) {
        setPlayerSitSubmit({
          kind: "error",
          message: "Wallet is not connected. Connect wallet and try again."
        });
        return;
      }

      const { pk: pkPlayer } = getPlayerKeysForAddress(playerWallet.address);
      setPlayerSitSubmit({ kind: "pending", message: "Submitting sit transaction..." });

      try {
        const sitPassword = playerSeatForm.password.trim() || undefined;
        await client.pokerSit({
          tableId,
          buyIn,
          pkPlayer,
          password: sitPassword
        });
        setPlayerSitSubmit({ kind: "success", message: "Seated successfully." });
        setPlayerSeatForm(defaultPlayerSeatForm());
        await loadPlayerTable(tableId, false);
      } catch (err) {
        setPlayerSitSubmit({ kind: "error", message: errorMessage(err) });
      }
    },
    [loadPlayerTable, playerSeatForm, selectedTableId, playerWallet.address]
  );

  const submitPlayerAction = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const table = playerTable.data;
      const tableId = selectedTableId;

      if (!tableId || !table) {
        setPlayerActionSubmit({ kind: "error", message: "Select a table and wait for player state to load." });
        return;
      }

      if (!table.hand) {
        setPlayerActionSubmit({ kind: "error", message: "No hand is currently active for this table." });
        return;
      }

      const mySeat = table.seats.find((seat) => seat.player === playerWallet.address);
      if (!mySeat) {
        setPlayerActionSubmit({ kind: "error", message: "You are not seated at this table." });
        return;
      }

      if (table.hand.actionOn !== mySeat.seat) {
        setPlayerActionSubmit({ kind: "error", message: "It is not your turn yet." });
        return;
      }

      const client = playerClientRef.current;
      if (!client) {
        setPlayerActionSubmit({
          kind: "error",
          message: "Wallet is not connected. Connect wallet and try again."
        });
        return;
      }

      const action = playerActionForm.action;
      const needsAmount = action === "bet" || action === "raise";
      const amountRaw = playerActionForm.amount.trim();
      let amount: string | undefined;
      if (needsAmount) {
        if (!/^\d+$/.test(amountRaw) || amountRaw === "") {
          setPlayerActionSubmit({ kind: "error", message: "Amount is required for bet and raise." });
          return;
        }
        amount = amountRaw;
      }

      setPlayerActionSubmit({ kind: "pending", message: "Submitting action..." });
      try {
        await client.pokerAct({ tableId, action, amount });
        setPlayerActionSubmit({ kind: "success", message: `Action sent: ${action}.` });
        setPlayerActionForm(defaultPlayerActionForm());
        await loadPlayerTable(tableId, false);
      } catch (err) {
        setPlayerActionSubmit({ kind: "error", message: errorMessage(err) });
      }
    },
    [loadPlayerTable, playerActionForm.action, playerActionForm.amount, playerTable.data, playerWallet.address, selectedTableId]
  );

  const submitPlayerLeave = useCallback(async () => {
    const tableId = selectedTableId;
    if (!tableId) return;

    if (playerWallet.status !== "connected" || !playerWallet.address) {
      setPlayerLeaveSubmit({ kind: "error", message: "Connect wallet first." });
      return;
    }

    const client = playerClientRef.current;
    if (!client) {
      setPlayerLeaveSubmit({ kind: "error", message: "Wallet is not connected." });
      return;
    }

    const table = playerTable.data;
    if (!table) {
      setPlayerLeaveSubmit({ kind: "error", message: "Table state not loaded." });
      return;
    }

    const mySeat = table.seats.find((s) => s.player === playerWallet.address);
    if (!mySeat) {
      setPlayerLeaveSubmit({ kind: "error", message: "You are not seated at this table." });
      return;
    }

    if (table.hand && mySeat.inHand) {
      setPlayerLeaveSubmit({ kind: "error", message: "Cannot leave during an active hand." });
      return;
    }

    setPlayerLeaveSubmit({ kind: "pending", message: "Submitting leave transaction..." });
    try {
      await client.pokerLeave({ tableId });
      setPlayerLeaveSubmit({ kind: "success", message: "Left table successfully." });
      await loadPlayerTable(tableId, false);
    } catch (err) {
      setPlayerLeaveSubmit({ kind: "error", message: errorMessage(err) });
    }
  }, [loadPlayerTable, playerTable.data, playerWallet.address, playerWallet.status, selectedTableId]);

  const submitCreateTable = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const client = playerClientRef.current;
    if (!client) {
      setCreateTableSubmit({ kind: "error", message: "Connect wallet first." });
      return;
    }

    const f = createTableForm;
    for (const [field, val] of Object.entries({ smallBlind: f.smallBlind, bigBlind: f.bigBlind, minBuyIn: f.minBuyIn, maxBuyIn: f.maxBuyIn })) {
      if (!/^\d+$/.test(val.trim()) || val.trim() === "0") {
        setCreateTableSubmit({ kind: "error", message: `${field} must be a positive integer.` });
        return;
      }
    }

    setCreateTableSubmit({ kind: "pending", message: "Creating table..." });
    try {
      const tx = await client.pokerCreateTable({
        smallBlind: f.smallBlind.trim(),
        bigBlind: f.bigBlind.trim(),
        minBuyIn: f.minBuyIn.trim(),
        maxBuyIn: f.maxBuyIn.trim(),
        maxPlayers: parseInt(f.maxPlayers.trim(), 10) || 9,
        label: f.label.trim(),
        password: f.password.trim() || undefined,
        actionTimeoutSecs: f.actionTimeoutSecs.trim() || "0",
        dealerTimeoutSecs: f.dealerTimeoutSecs.trim() || "0",
        playerBond: f.playerBond.trim() || "0",
        rakeBps: parseInt(f.rakeBps.trim(), 10) || 0,
      });
      const newTableId = findEventAttr(tx.events, "TableCreated", "tableId");
      setCreateTableSubmit({ kind: "success", message: `Table #${newTableId ?? "?"} created.` });
      setCreateTableForm(defaultCreateTableForm());
      await loadTables(false);
      if (newTableId) setSelectedTableId(newTableId);
    } catch (err) {
      setCreateTableSubmit({ kind: "error", message: errorMessage(err) });
    }
  }, [createTableForm, loadTables]);

  const submitRebuy = useCallback(async () => {
    const tableId = selectedTableId;
    if (!tableId) return;

    const client = playerClientRef.current;
    if (!client) {
      setRebuySubmit({ kind: "error", message: "Connect wallet first." });
      return;
    }

    const amount = rebuyAmount.trim();
    if (!/^\d+$/.test(amount) || amount === "0") {
      setRebuySubmit({ kind: "error", message: "Amount must be a positive integer." });
      return;
    }

    setRebuySubmit({ kind: "pending", message: "Submitting rebuy..." });
    try {
      await client.pokerRebuy({ tableId, amount });
      setRebuySubmit({ kind: "success", message: `Rebuyed ${amount} chips.` });
      setRebuyAmount("");
      await loadPlayerTable(tableId, false);
    } catch (err) {
      setRebuySubmit({ kind: "error", message: errorMessage(err) });
    }
  }, [loadPlayerTable, rebuyAmount, selectedTableId]);

  const submitPlayerActionDirect = useCallback(
    async (action: string, amount?: string) => {
      const table = playerTable.data;
      const tableId = selectedTableId;
      if (!tableId || !table?.hand) return;

      const client = playerClientRef.current;
      if (!client) return;

      setPlayerActionSubmit({ kind: "pending", message: "Submitting action..." });
      try {
        await client.pokerAct({ tableId, action, amount });
        setPlayerActionSubmit({ kind: "success", message: `Action sent: ${action}.` });
        setPlayerActionForm(defaultPlayerActionForm());
        await loadPlayerTable(tableId, false);
      } catch (err) {
        setPlayerActionSubmit({ kind: "error", message: errorMessage(err) });
      }
    },
    [loadPlayerTable, playerTable.data, selectedTableId]
  );

  const submitSeatIntent = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!selectedTableId) return;

      setSeatSubmit({ kind: "pending", message: "Submitting seat intent..." });

      const seat = Number.parseInt(seatForm.seat, 10);
      if (!Number.isInteger(seat) || seat < 0 || seat > 8) {
        setSeatSubmit({ kind: "error", message: "Seat must be an integer from 0 to 8." });
        return;
      }

      const payload: Record<string, unknown> = {
        tableId: selectedTableId,
        seat,
        player: seatForm.player.trim()
      };

      const buyIn = seatForm.buyIn.trim();
      const bond = seatForm.bond.trim();
      const pkPlayer = seatForm.pkPlayer.trim();

      if (buyIn) payload.buyIn = buyIn;
      if (bond) payload.bond = bond;
      if (pkPlayer) payload.pkPlayer = pkPlayer;

      try {
        const result = await fetchJson<{ intent: SeatIntent }>(apiUrl("/v1/seat-intents"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });

        setSeatSubmit({
          kind: "success",
          message: `Intent submitted for seat ${result.intent.seat}.`
        });
        setSeatForm((prev) => ({ ...defaultSeatForm(), player: prev.player }));
        void loadSeatIntents(selectedTableId, false);
      } catch (err) {
        setSeatSubmit({ kind: "error", message: errorMessage(err) });
      }
    },
    [apiUrl, loadSeatIntents, seatForm, selectedTableId]
  );

  const doUnlock = useCallback(() => {
    setKeyError(null);
    void (async () => {
      try {
        const { sk, pk } = await unlockPlayerKeys(playerWallet.address, keyPassphrase);
        setPlayerSk(sk);
        setPlayerPk(pk);
        setPlayerKeyState("unlocked");
        setKeyPassphrase("");
      } catch {
        setKeyError("Wrong passphrase");
      }
    })();
  }, [playerWallet.address, keyPassphrase]);

  const sendChat = useCallback(() => {
    const text = chatInput.trim();
    if (!text || !selectedTableId) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const sender = playerWallet.status === "connected" ? playerWallet.address : "anon";
    ws.send(JSON.stringify({ type: "table_chat", tableId: selectedTableId, text, sender }));
    setChatInput("");
  }, [chatInput, selectedTableId, playerWallet.status, playerWallet.address]);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  const onInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        applyCoordinatorBase();
      }
    },
    [applyCoordinatorBase]
  );

  return (
    <div className="app-shell">
      <header className="topbar panel">
        <div>
          <p className="kicker">OnChainPoker</p>
          <h1>Control Room + Player</h1>
        </div>

        <div className="endpoint-row">
          <label htmlFor="coordinator-url">Coordinator URL</label>
          <div className="endpoint-controls">
            <input
              id="coordinator-url"
              value={coordinatorInput}
              onChange={(event) => setCoordinatorInput(event.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="http://127.0.0.1:8788"
              spellCheck={false}
            />
            <button type="button" onClick={applyCoordinatorBase}>
              Connect
            </button>
          </div>
          <p className="hint">WebSocket endpoint: {toWsUrl(coordinatorBase)}</p>
        </div>

        <div className="status-grid">
          <div className="status-tile">
            <span className={`dot ${health.error ? "status-closed" : "status-open"}`} />
            <div>
              <p>Health</p>
              <strong>
                {health.loading
                  ? "Checking..."
                  : health.error
                    ? "Unavailable"
                    : `${health.data?.name ?? "coordinator"} (${health.data?.chainAdapter ?? "?"})`}
              </strong>
            </div>
          </div>

          <div className="status-tile">
            <span className={`dot ${wsTone(wsStatus)}`} />
            <div>
              <p>Event Stream</p>
              <strong>{wsStatus}</strong>
            </div>
          </div>

          <div className="status-tile">
            <span
              className={`dot ${
                playerWallet.status === "connected"
                  ? "status-open"
                  : playerWallet.status === "connecting"
                    ? "status-live"
                    : playerWallet.status === "error"
                      ? "status-closed"
                      : "status-muted"
              }`}
            />
            <div>
              <p>Wallet</p>
              <strong>
                {playerWallet.status === "connected"
                  ? playerWallet.address
                  : playerWallet.status === "error"
                    ? "Error"
                    : playerWallet.status === "connecting"
                      ? "Connecting"
                      : "Disconnected"}
              </strong>
            </div>
          </div>

          <div className="status-tile">
            <span className="dot status-live" />
            <div>
              <p>Tables</p>
              <strong>{tableList.length}</strong>
            </div>
          </div>
        </div>

        {(health.error || wsError) && (
          <p className="error-banner">{health.error ?? wsError}</p>
        )}
      </header>

      <main className="dashboard">
        <section className="panel">
          <div className="section-header">
            <h2>Player Desk</h2>
            <button
              type="button"
              onClick={() => {
                if (selectedTableId && playerWallet.status === "connected") {
                  void loadPlayerTable(selectedTableId, false);
                }
              }}
            >
              Refresh
            </button>
          </div>

          {seatedTableIds.length > 0 && (
            <div className="table-tabs">
              {seatedTableIds.map((tid) => {
                const info = tableList.find((t) => t.tableId === tid);
                return (
                  <button
                    key={tid}
                    type="button"
                    className={`table-tab${tid === selectedTableId ? " active" : ""}`}
                    onClick={() => setSelectedTableId(tid)}
                  >
                    <span>#{tid}</span>
                    {info && <span>{info.params.smallBlind}/{info.params.bigBlind}</span>}
                    {info && <span className={`badge ${statusTone(info.status)}`}>{info.status}</span>}
                  </button>
                );
              })}
            </div>
          )}

          {!selectedTable && <p className="placeholder">Select a table to join as a player.</p>}

          {/* Chain verification badge */}
          {selectedTableId && <ChainVerificationBadge {...chainVerification} cometMetrics={cometMetrics} />}

          {/* Visual poker table */}
          {playerTableForSelected && (() => {
            const tableProps = deriveTableProps({
              raw: playerTableForSelected,
              rawDealer: null,
              localAddress: playerWallet.status === "connected" ? playerWallet.address : null,
              localHoleCards: holeCardState.cards,
              actionEnabled: playerActionEnabled,
              onAction: (action: string, amount?: string) => {
                onPlayerActionInputChange("action", action as PlayerActionForm["action"]);
                if (amount) onPlayerActionInputChange("amount", amount);
                // Auto-submit simple actions
                if (action === "fold" || action === "check" || action === "call") {
                  void submitPlayerActionDirect(action, amount);
                }
              },
            });
            return tableProps ? <PokerTable {...tableProps} handHistory={handHistory.get(selectedTableId) ?? []} /> : null;
          })()}

          {/* Chat Panel */}
          {selectedTableId && (
            <div className="chat-panel">
              <h4 className="chat-panel__title">Table Chat</h4>
              <div className="chat-messages">
                {chatMessages.length === 0 && (
                  <p className="chat-empty">No messages yet</p>
                )}
                {chatMessages.map((m, i) => (
                  <div key={i} className="chat-msg">
                    <span className="chat-msg__sender">{m.sender.slice(0, 8)}...</span>
                    <span className="chat-msg__text">{m.text}</span>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
              <div className="chat-input-row">
                <input
                  className="chat-input"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); sendChat(); } }}
                  placeholder="Type a message..."
                  maxLength={200}
                />
                <button type="button" onClick={sendChat} disabled={!chatInput.trim()}>Send</button>
              </div>
            </div>
          )}

          <div className="stack-two">
            <div>
              <h4>Wallet Session</h4>
              <p className="hint">
                Chain: {playerWallet.chainId} <br />
                RPC: {DEFAULT_COSMOS_RPC_URL} <br />
                LCD: {DEFAULT_COSMOS_LCD_URL}
              </p>

              {playerWallet.status === "connected" ? (
                <>
                  <p>Connected as {playerWallet.address}</p>
                  <p className="hint">Seat state: {playerSeat ? `#${playerSeat.seat}` : "Not seated"}</p>
                </>
              ) : (
                <>
                  <p className="placeholder">
                    {playerWallet.status === "connecting" ? "Connecting wallet..." : "Wallet not connected"}
                  </p>
                  <p className="hint">Connect a compatible Cosmos wallet with onchainpoker prefix account (ocp).</p>
                  <button type="button" onClick={connectWallet} disabled={playerWallet.status === "connecting"}>
                    Connect wallet
                  </button>
                </>
              )}

              {playerWallet.error && <p className="error-banner">{playerWallet.error}</p>}

              {playerWallet.status === "connected" && playerKeyState === "locked" && (
                <div style={{ marginTop: "0.5rem" }}>
                  <p className="hint">Keys are encrypted. Enter passphrase to unlock.</p>
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    <input
                      type="password"
                      value={keyPassphrase}
                      onChange={(e) => setKeyPassphrase(e.target.value)}
                      placeholder="Passphrase"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          doUnlock();
                        }
                      }}
                    />
                    <button type="button" onClick={doUnlock}>Unlock</button>
                  </div>
                  {keyError && <p className="error-banner">{keyError}</p>}
                </div>
              )}

              {playerWallet.status === "connected" && playerKeyState === "unlocked" && (
                <div style={{ marginTop: "0.5rem" }}>
                  <details>
                    <summary style={{ cursor: "pointer" }}>Protect Keys</summary>
                    <p className="hint">Encrypt your player keys with a passphrase. You will need it on each page load.</p>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                      <input
                        type="password"
                        value={protectPassphrase}
                        onChange={(e) => setProtectPassphrase(e.target.value)}
                        placeholder="New passphrase"
                      />
                      <input
                        type="password"
                        value={protectConfirm}
                        onChange={(e) => setProtectConfirm(e.target.value)}
                        placeholder="Confirm passphrase"
                      />
                      <button type="button" disabled={!protectPassphrase || protectPassphrase !== protectConfirm} onClick={() => {
                        setProtectStatus(null);
                        void (async () => {
                          try {
                            await protectPlayerKeys(playerWallet.address, protectPassphrase);
                            isKeyEncryptedRef.current = true;
                            setProtectStatus("Keys encrypted successfully.");
                            setProtectPassphrase("");
                            setProtectConfirm("");
                            setPlayerKeyState("unlocked"); // remains unlocked for this session
                          } catch (err) {
                            setProtectStatus(errorMessage(err));
                          }
                        })();
                      }}>Encrypt Keys</button>
                    </div>
                    {protectStatus && <p className="hint">{protectStatus}</p>}
                  </details>
                </div>
              )}
            </div>

            <div>
              <h4>Seat</h4>
              <form className="seat-form" onSubmit={submitPlayerSeat}>
                <label>
                  Buy-In
                  <input
                    required
                    value={playerSeatForm.buyIn}
                    onChange={(event) => onPlayerSeatInputChange("buyIn", event.target.value)}
                    placeholder="1000000"
                    disabled={playerSitSubmit.kind === "pending"}
                  />
                </label>

                {selectedTable?.params?.passwordHash && (
                  <label>
                    Password
                    <input
                      type="password"
                      value={playerSeatForm.password}
                      onChange={(event) => onPlayerSeatInputChange("password", event.target.value)}
                      placeholder="Table password"
                      disabled={playerSitSubmit.kind === "pending"}
                    />
                  </label>
                )}

                <button
                  type="submit"
                  disabled={
                    playerSitSubmit.kind === "pending" ||
                    playerWallet.status !== "connected" ||
                    !selectedTableId
                  }
                >
                  {playerSitSubmit.kind === "pending" ? "Submitting..." : "Sit"}
                </button>
              </form>

              <p className={playerSitSubmit.kind === "error" ? "error-banner" : "hint"}>
                {playerSitSubmit.message}
              </p>

              {playerSeat && (
                <div style={{ marginTop: "0.5rem" }}>
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    <button
                      type="button"
                      className="btn-leave"
                      disabled={
                        playerLeaveSubmit.kind === "pending" ||
                        playerWallet.status !== "connected" ||
                        !selectedTableId ||
                        Boolean(playerTableForSelected?.hand && playerSeat.inHand)
                      }
                      onClick={submitPlayerLeave}
                    >
                      {playerLeaveSubmit.kind === "pending" ? "Leaving..." : "Leave Table"}
                    </button>
                  </div>
                  {playerLeaveSubmit.message && (
                    <p className={playerLeaveSubmit.kind === "error" ? "error-banner" : "hint"}>
                      {playerLeaveSubmit.message}
                    </p>
                  )}

                  <div className="rebuy-row">
                    <input
                      value={rebuyAmount}
                      onChange={(e) => setRebuyAmount(e.target.value)}
                      placeholder="Rebuy amount"
                      inputMode="numeric"
                      disabled={rebuySubmit.kind === "pending"}
                    />
                    <button
                      type="button"
                      disabled={
                        rebuySubmit.kind === "pending" ||
                        playerWallet.status !== "connected" ||
                        !selectedTableId ||
                        Boolean(playerTableForSelected?.hand && playerSeat.inHand)
                      }
                      onClick={submitRebuy}
                    >
                      {rebuySubmit.kind === "pending" ? "Rebuying..." : "Rebuy"}
                    </button>
                    {Boolean(playerTableForSelected?.hand && playerSeat.inHand) && (
                      <span className="rebuy-hint">Available between hands</span>
                    )}
                  </div>
                  {rebuySubmit.message && (
                    <p className={rebuySubmit.kind === "error" ? "error-banner" : "hint"}>
                      {rebuySubmit.message}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="stack-two">
            <div>
              <h4>Current Hand</h4>
              {playerTable.loading && <p className="placeholder">Loading player table state...</p>}
              {playerTable.error && <p className="error-banner">{playerTable.error}</p>}

              {!playerTable.loading && !playerTable.error && playerTableForSelected ? (
                <>
                  <dl className="facts">
                    <div>
                      <dt>Hand</dt>
                      <dd>{playerTableForSelected.hand?.handId ?? "none"}</dd>
                    </div>
                    <div>
                      <dt>Phase</dt>
                      <dd>{playerTableForSelected.hand?.phase || "waiting"}</dd>
                    </div>
                    <div>
                      <dt>Your seat</dt>
                      <dd>{playerSeat ? `#${playerSeat.seat}` : "not seated"}</dd>
                    </div>
                    <div>
                      <dt>Turn</dt>
                      <dd>{playerActionEnabled ? "you" : "other"}</dd>
                    </div>
                  </dl>

                  <form className="seat-form" onSubmit={submitPlayerAction}>
                    <label>
                      Action
                      <select
                        value={playerActionForm.action}
                        onChange={(event) =>
                          onPlayerActionInputChange("action", event.target.value as PlayerActionForm["action"])
                        }
                        disabled={playerActionSubmit.kind === "pending"}
                      >
                        <option value="fold">fold</option>
                        <option value="check">check</option>
                        <option value="call">call</option>
                        <option value="bet">bet</option>
                        <option value="raise">raise</option>
                      </select>
                    </label>

                    {(playerActionForm.action === "bet" || playerActionForm.action === "raise") && (
                      <label>
                        Amount
                        <input
                          required
                          value={playerActionForm.amount}
                          onChange={(event) =>
                            onPlayerActionInputChange("amount", event.target.value)
                          }
                          inputMode="numeric"
                          disabled={playerActionSubmit.kind === "pending"}
                        />
                      </label>
                    )}

                    <button
                      type="submit"
                      disabled={
                        playerActionSubmit.kind === "pending" ||
                        playerWallet.status !== "connected" ||
                        !selectedTableId ||
                        !playerActionEnabled ||
                        !playerTableForSelected?.hand
                      }
                    >
                      {playerActionSubmit.kind === "pending" ? "Submitting..." : "Take Action"}
                    </button>
                  </form>
                </>
              ) : (
                <p className="placeholder">Connect wallet and connect to a table to see hand state.</p>
              )}

              {playerActionSubmit.message && (
                <p className={playerActionSubmit.kind === "error" ? "error-banner" : "hint"}>
                  {playerActionSubmit.message}
                </p>
              )}
            </div>

            <div>
              <h4>Seat Snapshot</h4>
              {playerTable.loading && <p className="placeholder">Loading seat snapshot...</p>}
              {!playerTableForSelected && !playerTable.loading ? (
                <p className="placeholder">No seat snapshot yet. Join a seated player to populate.</p>
              ) : (
                <div>
                  {(playerTableForSelected?.seats ?? []).map((seat) => (
                    <article key={`${seat.seat}`} className="intent-card">
                      <header>
                        <strong>Seat {seat.seat}</strong>
                        <span>{seat.player || "-"}</span>
                      </header>
                      <p>
                        stack {seat.stack} | bond {seat.bond}
                      </p>
                      <small>
                        inHand: {seat.inHand ? "yes" : "no"} | folded:{" "}
                        {seat.folded ? "yes" : "no"} | all-in: {seat.allIn ? "yes" : "no"}
                      </small>
                      {seat.player && (
                        <textarea
                          className="player-note"
                          placeholder="Private note..."
                          value={playerNotes[seat.player] ?? ""}
                          onChange={(e) => setPlayerNotes((prev) => ({ ...prev, [seat.player]: e.target.value }))}
                          rows={1}
                        />
                      )}
                    </article>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="panel">
        <div className="section-header">
            <h2>Lobby</h2>
            <button type="button" onClick={() => void loadTables(true)}>
              Refresh
            </button>
          </div>

          {tables.loading && !tables.data && <p className="placeholder">Loading tables...</p>}
          {tables.error && <p className="error-banner">{tables.error}</p>}

          <div className="lobby-filters">
            <input
              value={lobbyFilter.search}
              onChange={(e) => setLobbyFilter((prev) => ({ ...prev, search: e.target.value }))}
              placeholder="Search by ID or label"
            />
            <select
              value={lobbyFilter.status}
              onChange={(e) => setLobbyFilter((prev) => ({ ...prev, status: e.target.value as LobbyFilter["status"] }))}
            >
              <option value="all">All status</option>
              <option value="open">Open</option>
              <option value="in_hand">In hand</option>
            </select>
            <select
              value={lobbyFilter.password}
              onChange={(e) => setLobbyFilter((prev) => ({ ...prev, password: e.target.value as LobbyFilter["password"] }))}
            >
              <option value="all">Any access</option>
              <option value="open">No password</option>
              <option value="protected">Password</option>
            </select>
            <select
              value={lobbyFilter.sort}
              onChange={(e) => setLobbyFilter((prev) => ({ ...prev, sort: e.target.value as LobbyFilter["sort"] }))}
            >
              <option value="id-asc">ID asc</option>
              <option value="id-desc">ID desc</option>
              <option value="blinds-asc">Blinds asc</option>
              <option value="blinds-desc">Blinds desc</option>
            </select>
          </div>

          {!tables.loading && tableList.length === 0 && (
            <p className="placeholder">No tables reported by coordinator.</p>
          )}

          {!tables.loading && tableList.length > 0 && filteredTableList.length === 0 && (
            <p className="placeholder">No tables match filters ({tableList.length} total).</p>
          )}

          <ul className="table-list">
            {filteredTableList.map((table) => (
              <li key={table.tableId}>
                <button
                  type="button"
                  className={`table-row ${table.tableId === selectedTableId ? "active" : ""}`}
                  onClick={() => setSelectedTableId(table.tableId)}
                >
                  <div>
                    <strong>#{table.tableId}{table.label ? ` ${table.label}` : ""}</strong>
                    <p>
                      blinds {table.params.smallBlind}/{table.params.bigBlind}
                      {table.params.passwordHash ? " \u{1F512}" : ""}
                    </p>
                  </div>
                  <div className="table-meta">
                    {table.params.passwordHash && <span className="badge status-muted">Password</span>}
                    <span className={`badge ${statusTone(table.status)}`}>{table.status}</span>
                    <small>{formatTimestamp(table.updatedAtMs)}</small>
                  </div>
                </button>
              </li>
            ))}
          </ul>

          {playerWallet.status === "connected" && (
            <div style={{ marginTop: "1rem" }}>
              <h4>Create Table</h4>
              <form className="create-table-form" onSubmit={submitCreateTable}>
                <label>
                  Label
                  <input
                    value={createTableForm.label}
                    onChange={(e) => setCreateTableForm((prev) => ({ ...prev, label: e.target.value }))}
                    placeholder="My Table"
                  />
                </label>
                <div className="create-table-grid">
                  <label>
                    Small Blind
                    <input
                      required
                      value={createTableForm.smallBlind}
                      onChange={(e) => setCreateTableForm((prev) => ({ ...prev, smallBlind: e.target.value }))}
                      inputMode="numeric"
                    />
                  </label>
                  <label>
                    Big Blind
                    <input
                      required
                      value={createTableForm.bigBlind}
                      onChange={(e) => setCreateTableForm((prev) => ({ ...prev, bigBlind: e.target.value }))}
                      inputMode="numeric"
                    />
                  </label>
                  <label>
                    Min Buy-In
                    <input
                      required
                      value={createTableForm.minBuyIn}
                      onChange={(e) => setCreateTableForm((prev) => ({ ...prev, minBuyIn: e.target.value }))}
                      inputMode="numeric"
                    />
                  </label>
                  <label>
                    Max Buy-In
                    <input
                      required
                      value={createTableForm.maxBuyIn}
                      onChange={(e) => setCreateTableForm((prev) => ({ ...prev, maxBuyIn: e.target.value }))}
                      inputMode="numeric"
                    />
                  </label>
                </div>
                <label>
                  Password (optional)
                  <input
                    type="password"
                    value={createTableForm.password}
                    onChange={(e) => setCreateTableForm((prev) => ({ ...prev, password: e.target.value }))}
                    placeholder="Leave blank for open table"
                  />
                </label>
                <details open={showCreateAdvanced} onToggle={(e) => setShowCreateAdvanced((e.target as HTMLDetailsElement).open)}>
                  <summary style={{ cursor: "pointer" }}>Advanced</summary>
                  <div className="create-table-advanced">
                    <label>
                      Max Players
                      <input
                        value={createTableForm.maxPlayers}
                        onChange={(e) => setCreateTableForm((prev) => ({ ...prev, maxPlayers: e.target.value }))}
                        inputMode="numeric"
                      />
                    </label>
                    <label>
                      Action Timeout (s)
                      <input
                        value={createTableForm.actionTimeoutSecs}
                        onChange={(e) => setCreateTableForm((prev) => ({ ...prev, actionTimeoutSecs: e.target.value }))}
                        inputMode="numeric"
                      />
                    </label>
                    <label>
                      Dealer Timeout (s)
                      <input
                        value={createTableForm.dealerTimeoutSecs}
                        onChange={(e) => setCreateTableForm((prev) => ({ ...prev, dealerTimeoutSecs: e.target.value }))}
                        inputMode="numeric"
                      />
                    </label>
                    <label>
                      Player Bond
                      <input
                        value={createTableForm.playerBond}
                        onChange={(e) => setCreateTableForm((prev) => ({ ...prev, playerBond: e.target.value }))}
                        inputMode="numeric"
                      />
                    </label>
                    <label>
                      Rake BPS
                      <input
                        value={createTableForm.rakeBps}
                        onChange={(e) => setCreateTableForm((prev) => ({ ...prev, rakeBps: e.target.value }))}
                        inputMode="numeric"
                      />
                    </label>
                  </div>
                </details>
                <button type="submit" disabled={createTableSubmit.kind === "pending" || playerWallet.status !== "connected"}>
                  {createTableSubmit.kind === "pending" ? "Creating..." : "Create Table"}
                </button>
              </form>
              {createTableSubmit.message && (
                <p className={createTableSubmit.kind === "success" ? "create-table-success" : createTableSubmit.kind === "error" ? "error-banner" : "hint"}>
                  {createTableSubmit.message}
                </p>
              )}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="section-header">
            <h2>Table Detail</h2>
            {selectedTableId && (
              <button
                type="button"
                onClick={() => {
                  void loadSeatIntents(selectedTableId, true);
                  void loadDealerViews(selectedTableId);
                  if (playerWallet.status === "connected") {
                    void loadPlayerTable(selectedTableId);
                  }
                }}
              >
                Refresh
              </button>
            )}
          </div>

          {!selectedTable && <p className="placeholder">Select a table to inspect state and seat intents.</p>}

          {selectedTable && (
            <>
              <div className="table-summary">
                <div>
                  <p className="kicker">Table</p>
                  <h3>{selectedTable.tableId}</h3>
                </div>
                <span className={`badge ${statusTone(selectedTable.status)}`}>{selectedTable.status}</span>
              </div>

              <dl className="facts">
                <div>
                  <dt>Max Players</dt>
                  <dd>{selectedTable.params.maxPlayers}</dd>
                </div>
                <div>
                  <dt>Blinds</dt>
                  <dd>
                    {selectedTable.params.smallBlind}/{selectedTable.params.bigBlind}
                  </dd>
                </div>
                <div>
                  <dt>Buy-in</dt>
                  <dd>
                    {selectedTable.params.minBuyIn} - {selectedTable.params.maxBuyIn}
                  </dd>
                </div>
              </dl>

              <div className="stack-two">
                <div>
                  <h4>Seat Intents</h4>
                  {seatIntents.loading && <p className="placeholder">Loading intents...</p>}
                  {seatIntents.error && <p className="error-banner">{seatIntents.error}</p>}
                  {!seatIntents.loading && !seatIntents.error && (seatIntents.data?.length ?? 0) === 0 && (
                    <p className="placeholder">No active intents.</p>
                  )}

                  {(seatIntents.data ?? []).map((intent) => (
                    <article key={intent.intentId} className="intent-card">
                      <header>
                        <strong>Seat {intent.seat}</strong>
                        <span>{intent.player}</span>
                      </header>
                      <p>
                        buyIn {intent.buyIn ?? "-"} | bond {intent.bond ?? "-"}
                      </p>
                      <small>expires {formatRelative(intent.expiresAtMs)}</small>
                    </article>
                  ))}
                </div>

                <div>
                  <h4>Submit Seat Intent</h4>
                  <form className="seat-form" onSubmit={submitSeatIntent}>
                    <label>
                      Player
                      <input
                        required
                        value={seatForm.player}
                        onChange={(event) => onSeatInputChange("player", event.target.value)}
                        placeholder="alice"
                      />
                    </label>

                    <label>
                      Seat (0-8)
                      <input
                        required
                        value={seatForm.seat}
                        onChange={(event) => onSeatInputChange("seat", event.target.value)}
                        inputMode="numeric"
                      />
                    </label>

                    <label>
                      Buy-In (optional)
                      <input
                        value={seatForm.buyIn}
                        onChange={(event) => onSeatInputChange("buyIn", event.target.value)}
                        placeholder="1000000"
                      />
                    </label>

                    <label>
                      Bond (optional)
                      <input
                        value={seatForm.bond}
                        onChange={(event) => onSeatInputChange("bond", event.target.value)}
                        placeholder="10000"
                      />
                    </label>

                    <label>
                      pkPlayer (optional)
                      <input
                        value={seatForm.pkPlayer}
                        onChange={(event) => onSeatInputChange("pkPlayer", event.target.value)}
                        placeholder="base64"
                        spellCheck={false}
                      />
                    </label>

                    <button
                      type="submit"
                      disabled={
                        seatSubmit.kind === "pending" ||
                        !selectedTableId ||
                        seatForm.player.trim().length === 0
                      }
                    >
                      {seatSubmit.kind === "pending" ? "Submitting..." : "Submit"}
                    </button>
                  </form>

                  {seatSubmit.message && (
                    <p className={seatSubmit.kind === "error" ? "error-banner" : "hint"}>
                      {seatSubmit.message}
                    </p>
                  )}
                </div>
              </div>

              <div className="stack-two">
                <div>
                  <h4>v0 Raw Table Query</h4>
                  {rawTable.loading && <p className="placeholder">Loading raw table view...</p>}
                  {rawTable.error && <p className="placeholder">{rawTable.error}</p>}
                  {rawTable.data != null ? <pre>{prettyJson(rawTable.data)}</pre> : null}
                </div>

                <div>
                  <h4>v0 Dealer Next Helper</h4>
                  {dealerNext.loading && <p className="placeholder">Loading dealer hint...</p>}
                  {dealerNext.error && <p className="placeholder">{dealerNext.error}</p>}
                  {dealerNext.data != null ? <pre>{prettyJson(dealerNext.data)}</pre> : null}
                </div>
              </div>
            </>
          )}
        </section>

        <section className="panel">
          <div className="section-header">
            <h2>Live Event Feed</h2>
            <button type="button" onClick={() => setEvents([])}>
              Clear
            </button>
          </div>

          {events.length === 0 && (
            <p className="placeholder">No events yet. Keep this tab open while coordinator streams chain events.</p>
          )}

          <div className="event-list">
            {events.map((event) => (
              <article key={`${event.eventIndex}-${event.timeMs}-${event.name}`} className="event-card">
                <header>
                  <strong>{event.name}</strong>
                  <span>#{event.eventIndex}</span>
                </header>
                <p>
                  table {event.tableId ?? "-"} | hand {event.handId ?? "-"}
                </p>
                <small>{formatTimestamp(event.timeMs)}</small>
                {event.data != null ? <pre>{prettyJson(event.data)}</pre> : null}
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

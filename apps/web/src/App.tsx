import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CosmosLcdClient,
  connectOcpCosmosSigningClient,
  createOcpCosmosClient,
  createOcpRegistry,
  type OcpCosmosClient
} from "@onchainpoker/ocp-sdk/cosmos";
import { groupElementToBytes, mulBase, scalarFromBytesModOrder } from "@onchainpoker/ocp-crypto";

type TableInfo = {
  tableId: string;
  params: {
    maxPlayers: number;
    smallBlind: string;
    bigBlind: string;
    minBuyIn: string;
    maxBuyIn: string;
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

type PlayerSeatState = {
  seat: number;
  player: string;
  stack: string;
  bond: string;
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
};

type PlayerHandState = {
  handId: string;
  phase: string;
  actionOn: number;
};

type PlayerTableState = {
  tableId: string;
  params: TableInfo["params"];
  seats: PlayerSeatState[];
  hand: PlayerHandState | null;
};

type PlayerSeatForm = {
  seat: string;
  buyIn: string;
};

type PlayerActionForm = {
  action: "fold" | "check" | "call" | "bet" | "raise";
  amount: string;
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
const PLAYER_PK_KEY_PREFIX = "ocp.web.pkPlayer";
const MAX_EVENTS = 200;

function getPlayerPkForAddress(address: string): Uint8Array {
  if (typeof window === "undefined") {
    throw new Error("wallet support requires a browser context");
  }

  const key = `${PLAYER_PK_KEY_PREFIX}:${address}`;
  const stored = window.localStorage.getItem(key);
  const existing = base64ToUint8(stored);
  if (existing && existing.length === 32) return existing;

  const entropy = new Uint8Array(64);
  window.crypto.getRandomValues(entropy);

  const scalar = scalarFromBytesModOrder(entropy);
  const pkPlayer = groupElementToBytes(mulBase(scalar));
  window.localStorage.setItem(key, uint8ToBase64(pkPlayer));
  return pkPlayer;
}

function parseTableBool(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw === "string") return raw === "true" || raw === "1";
  return Boolean(raw);
}

function parsePlayerTable(raw: unknown): PlayerTableState | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;

  const tableId = String(root.id ?? root.tableId ?? "").trim();
  if (!tableId) return null;

  const params = (root.params as Record<string, unknown>) ?? {};
  const rawSeats = Array.isArray(root.seats) ? root.seats : [];
  const rawHand = (root.hand as Record<string, unknown>) ?? null;
  const inHands = Array.isArray(rawHand?.inHand) ? rawHand.inHand : [];
  const folded = Array.isArray(rawHand?.folded) ? rawHand.folded : [];
  const allIn = Array.isArray(rawHand?.allIn) ? rawHand.allIn : [];

  const seats: PlayerSeatState[] = rawSeats
    .slice(0, 9)
    .map((seatRaw, seat) => {
      const value = (seatRaw ?? {}) as Record<string, unknown>;
      return {
        seat,
        player: String(value.player ?? ""),
        stack: String(value.stack ?? "0"),
        bond: String(value.bond ?? "0"),
        inHand: parseTableBool(inHands[seat] ?? value.inHand),
        folded: parseTableBool(folded[seat] ?? value.folded),
        allIn: parseTableBool(allIn[seat] ?? value.allIn)
      } satisfies PlayerSeatState;
    });

  while (seats.length < 9) {
    const seat = seats.length;
    seats.push({
      seat,
      player: "",
      stack: "0",
      bond: "0",
      inHand: false,
      folded: false,
      allIn: false
    });
  }

  const handRaw = rawHand;
  const phase = String(handRaw?.phase ?? "");
  const actionOn = Number.isFinite(Number(handRaw?.actionOn)) ? Number(handRaw?.actionOn) : -1;

  return {
    tableId,
    params: {
      maxPlayers: Number.isFinite(Number(params.maxPlayers)) ? Number(params.maxPlayers) : 9,
      smallBlind: String(params.smallBlind ?? "0"),
      bigBlind: String(params.bigBlind ?? "0"),
      minBuyIn: String(params.minBuyIn ?? "0"),
      maxBuyIn: String(params.maxBuyIn ?? "0")
    },
    seats,
    hand: handRaw
      ? {
          handId: String(handRaw.handId ?? ""),
          phase,
          actionOn
        }
      : null
  };
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
    seat: "0",
    buyIn: ""
  };
}

function defaultPlayerActionForm(): PlayerActionForm {
  return {
    action: "check",
    amount: ""
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

  const [events, setEvents] = useState<ChainEvent[]>([]);
  const [wsStatus, setWsStatus] = useState<WsStatus>("connecting");
  const [wsError, setWsError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const playerClientRef = useRef<OcpCosmosClient | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const subscribedTableRef = useRef<string | null>(null);
  const selectedTableRef = useRef<string>("");

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

          setEvents((prev) => [chainEvent, ...prev].slice(0, MAX_EVENTS));
          scheduleTableRefresh();

          if (chainEvent.tableId && chainEvent.tableId === selectedTableRef.current) {
            void loadSeatIntents(chainEvent.tableId, false);
            void loadDealerViews(chainEvent.tableId);
            if (playerClientRef.current) {
              void loadPlayerTable(chainEvent.tableId, false);
            }
          }

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
    }
  }, [selectedTableId]);

  const tableList = tables.data ?? [];
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

      const seat = Number.parseInt(playerSeatForm.seat, 10);
      if (!Number.isInteger(seat) || seat < 0 || seat > 8) {
        setPlayerSitSubmit({ kind: "error", message: "Seat must be an integer from 0 to 8." });
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

      const pkPlayer = getPlayerPkForAddress(playerWallet.address);
      setPlayerSitSubmit({ kind: "pending", message: "Submitting sit transaction..." });

      try {
        await client.pokerSit({
          tableId,
          seat,
          buyIn,
          pkPlayer
        });
        setPlayerSitSubmit({ kind: "success", message: `Sat down at seat ${seat}.` });
        setPlayerSeatForm((prev) => ({ ...defaultPlayerSeatForm(), seat: prev.seat }));
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

          {!selectedTable && <p className="placeholder">Select a table to join as a player.</p>}

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
            </div>

            <div>
              <h4>Seat</h4>
              <form className="seat-form" onSubmit={submitPlayerSeat}>
                <label>
                  Seat (0-8)
                  <input
                    required
                    value={playerSeatForm.seat}
                    onChange={(event) => onPlayerSeatInputChange("seat", event.target.value)}
                    inputMode="numeric"
                    disabled={playerSitSubmit.kind === "pending"}
                  />
                </label>

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

          {!tables.loading && tableList.length === 0 && (
            <p className="placeholder">No tables reported by coordinator.</p>
          )}

          <ul className="table-list">
            {tableList.map((table) => (
              <li key={table.tableId}>
                <button
                  type="button"
                  className={`table-row ${table.tableId === selectedTableId ? "active" : ""}`}
                  onClick={() => setSelectedTableId(table.tableId)}
                >
                  <div>
                    <strong>{table.tableId}</strong>
                    <p>
                      blinds {table.params.smallBlind}/{table.params.bigBlind}
                    </p>
                  </div>
                  <div className="table-meta">
                    <span className={`badge ${statusTone(table.status)}`}>{table.status}</span>
                    <small>{formatTimestamp(table.updatedAtMs)}</small>
                  </div>
                </button>
              </li>
            ))}
          </ul>
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

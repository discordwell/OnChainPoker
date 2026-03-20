import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CosmosLcdClient,
  connectOcpCosmosSigningClient,
  createOcpCosmosClient,
  createOcpRegistry,
  findEventAttr,
  type OcpCosmosClient,
} from "@onchainpoker/ocp-sdk/cosmos";
import { useHoleCards } from "../components/useHoleCards";
import { isEncryptedBundle } from "../keyEncryption";
import { parsePlayerTable, type PlayerTableState } from "../lib/parsePlayerTable";
import { useChainVerification } from "../components/useChainVerification";
import { useCometBftEvents } from "../components/useCometBftEvents";
import type { ChainEvent } from "../lib/cometEventParser";

import type {
  TableInfo,
  SeatIntent,
  HealthResponse,
  QueryState,
  SeatSubmitState,
  PlayerTxState,
  PlayerWalletState,
  PlayerSeatForm,
  PlayerActionForm,
  CreateTableForm,
  LobbyFilter,
  WsStatus,
  WindowWithKeplr,
  SeatFormState,
  ChatMsg,
  KeyState,
  HandResult,
} from "../lib/types";

import {
  DEFAULT_COORDINATOR_HTTP_URL,
  DEFAULT_COSMOS_RPC_URL,
  DEFAULT_COSMOS_LCD_URL,
  DEFAULT_COSMOS_CHAIN_ID,
  DEFAULT_COSMOS_GAS_PRICE,
  PLAYER_SK_KEY_PREFIX,
  MAX_EVENTS,
  MAX_CHAT_MESSAGES,
  MAX_HISTORY_PER_TABLE,
  KEY_LOCK_TIMEOUT_MS,
} from "../lib/constants";

import {
  uint8ToBase64,
  errorMessage,
  fetchJson,
  defaultSeatForm,
  defaultPlayerSeatForm,
  defaultPlayerActionForm,
  defaultCreateTableForm,
  loadPlayerNotes,
  savePlayerNotes,
  loadHandHistory,
  saveHandHistory,
} from "../lib/utils";

import {
  getPlayerKeysSync,
  getPlayerKeysForAddress,
  unlockPlayerKeys,
  protectPlayerKeys,
} from "../lib/playerKeys";

import {
  normalizeCoordinatorBase,
  toWsUrl,
  initialCoordinatorBase,
} from "../lib/coordinatorUrl";

import { deriveTableProps } from "../components/useTableState";

export type GameState = ReturnType<typeof useGameState>;

export function useGameState() {
  const [coordinatorInput, setCoordinatorInput] = useState<string>(initialCoordinatorBase);
  const [coordinatorBase, setCoordinatorBase] = useState<string>(initialCoordinatorBase);

  const [health, setHealth] = useState<QueryState<HealthResponse>>({
    loading: true,
    data: null,
    error: null,
  });

  const [tables, setTables] = useState<QueryState<TableInfo[]>>({
    loading: true,
    data: null,
    error: null,
  });

  const [selectedTableId, setSelectedTableId] = useState<string>(() => {
    const urlTable = new URLSearchParams(window.location.search).get("table");
    return urlTable ?? "";
  });
  const [seatIntents, setSeatIntents] = useState<QueryState<SeatIntent[]>>({
    loading: false,
    data: null,
    error: null,
  });

  const [rawTable, setRawTable] = useState<QueryState<unknown>>({
    loading: false,
    data: null,
    error: null,
  });

  const [dealerNext, setDealerNext] = useState<QueryState<unknown>>({
    loading: false,
    data: null,
    error: null,
  });

  const [seatForm, setSeatForm] = useState<SeatFormState>(defaultSeatForm);
  const [seatSubmit, setSeatSubmit] = useState<SeatSubmitState>({ kind: "idle", message: null });

  const [playerWallet, setPlayerWallet] = useState<PlayerWalletState>({
    status: "disconnected",
    address: "",
    chainId: DEFAULT_COSMOS_CHAIN_ID,
    error: null,
  });

  const [playerTable, setPlayerTable] = useState<QueryState<PlayerTableState | null>>({
    loading: false,
    data: null,
    error: null,
  });

  const [playerSeatForm, setPlayerSeatForm] = useState<PlayerSeatForm>(defaultPlayerSeatForm);
  const [playerActionForm, setPlayerActionForm] = useState<PlayerActionForm>(defaultPlayerActionForm);
  const [playerSitSubmit, setPlayerSitSubmit] = useState<PlayerTxState>({
    kind: "idle",
    message: null,
  });
  const [playerActionSubmit, setPlayerActionSubmit] = useState<PlayerTxState>({
    kind: "idle",
    message: null,
  });
  const [playerLeaveSubmit, setPlayerLeaveSubmit] = useState<PlayerTxState>({
    kind: "idle",
    message: null,
  });

  const [faucetStatus, setFaucetStatus] = useState<{
    kind: "idle" | "pending" | "success" | "error";
    message: string | null;
  }>({ kind: "idle", message: null });

  const [createTableForm, setCreateTableForm] = useState<CreateTableForm>(defaultCreateTableForm);
  const [createTableSubmit, setCreateTableSubmit] = useState<PlayerTxState>({
    kind: "idle",
    message: null,
  });
  const [showCreateAdvanced, setShowCreateAdvanced] = useState(false);
  const [rebuyAmount, setRebuyAmount] = useState("");
  const [rebuySubmit, setRebuySubmit] = useState<PlayerTxState>({ kind: "idle", message: null });
  const [lobbyFilter, setLobbyFilter] = useState<LobbyFilter>({
    search: "",
    status: "all",
    password: "all",
    sort: "id-asc",
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

  const [viewMode, setViewMode] = useState<"game" | "admin">("game");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showCreateTableModal, setShowCreateTableModal] = useState(false);
  const [playerBalance, setPlayerBalance] = useState<string | null>(null);

  useEffect(() => {
    saveHandHistory(handHistory);
  }, [handHistory]);
  useEffect(() => {
    savePlayerNotes(playerNotes);
  }, [playerNotes]);

  const wsRef = useRef<WebSocket | null>(null);
  const playerClientRef = useRef<OcpCosmosClient | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const subscribedTableRef = useRef<string | null>(null);
  const selectedTableRef = useRef<string>("");
  const recordCoordinatorEventRef = useRef<(event: ChainEvent) => boolean>(() => true);

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
        fetchJson<{ table: unknown }>(
          apiUrl(`/v1/appchain/v0/tables/${encodeURIComponent(tableId)}`)
        ),
        fetchJson<{ action?: unknown; tableId?: string; handId?: number }>(
          apiUrl(`/v1/appchain/v0/tables/${encodeURIComponent(tableId)}/dealer/next`)
        ),
      ]);

      if (tableResp.status === "fulfilled") {
        setRawTable({ loading: false, data: tableResp.value.table, error: null });
      } else {
        setRawTable({ loading: false, data: null, error: errorMessage(tableResp.reason) });
      }

      if (dealerResp.status === "fulfilled") {
        setDealerNext({ loading: false, data: dealerResp.value, error: null });
      } else {
        setDealerNext({ loading: false, data: null, error: errorMessage(dealerResp.reason) });
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
        error: "Connect wallet to load player table state.",
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
    const url = new URL(window.location.href);
    if (selectedTableId) {
      url.searchParams.set("table", selectedTableId);
    } else {
      url.searchParams.delete("table");
    }
    window.history.replaceState(null, "", url.toString());
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

  // WebSocket connection
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
          ws.send(JSON.stringify({ type: "subscribe", topic: "table", tableId: currentTable }));
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
          setChatMessages(
            messages.map((m: any) => ({
              sender: String(m.sender ?? ""),
              text: String(m.text ?? ""),
              timeMs: Number(m.timeMs ?? 0),
            }))
          );
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
      ws.send(JSON.stringify({ type: "chat_history", tableId: selectedTableId }));
    }
  }, [selectedTableId]);

  // Derived state
  const tableList = tables.data ?? [];
  const filteredTableList = useMemo(() => {
    let list = [...tableList];

    const q = lobbyFilter.search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (t) => t.tableId.toLowerCase().includes(q) || (t.label ?? "").toLowerCase().includes(q)
      );
    }

    if (lobbyFilter.status !== "all") {
      list = list.filter((t) => t.status === lobbyFilter.status);
    }

    if (lobbyFilter.password === "open") {
      list = list.filter((t) => !t.params.passwordHash);
    } else if (lobbyFilter.password === "protected") {
      list = list.filter((t) => !!t.params.passwordHash);
    }

    list.sort((a, b) => {
      switch (lobbyFilter.sort) {
        case "id-asc":
          return Number(a.tableId) - Number(b.tableId);
        case "id-desc":
          return Number(b.tableId) - Number(a.tableId);
        case "blinds-asc":
          return Number(a.params.bigBlind) - Number(b.params.bigBlind);
        case "blinds-desc":
          return Number(b.params.bigBlind) - Number(a.params.bigBlind);
        default:
          return 0;
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
  const spectatorTable = useMemo(() => {
    if (playerTableForSelected) return null;
    if (!rawTable.data) return null;
    return parsePlayerTable(rawTable.data);
  }, [rawTable.data, playerTableForSelected]);

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

  const handleCometEvent = useCallback(
    (ev: ChainEvent) => {
      scheduleTableRefresh();
      if (ev.tableId && ev.tableId === selectedTableRef.current) {
        void loadSeatIntents(ev.tableId, false);
        void loadDealerViews(ev.tableId);
        if (playerClientRef.current) {
          void loadPlayerTable(ev.tableId, false);
        }
      }
    },
    [scheduleTableRefresh, loadSeatIntents, loadDealerViews, loadPlayerTable]
  );

  const { metrics: cometMetrics, recordCoordinatorEvent } = useCometBftEvents({
    rpcUrl: DEFAULT_COSMOS_RPC_URL,
    enabled: Boolean(selectedTableId),
    selectedTableId,
    onChainEvent: handleCometEvent,
  });
  recordCoordinatorEventRef.current = recordCoordinatorEvent;

  // Sync seatedTableIds
  useEffect(() => {
    if (!selectedTableId || !playerTableForSelected || playerWallet.status !== "connected") return;
    const isSeated = playerTableForSelected.seats.some((s) => s.player === playerWallet.address);
    setSeatedTableIds((prev) => {
      if (isSeated && !prev.includes(selectedTableId)) return [...prev, selectedTableId];
      if (!isSeated && prev.includes(selectedTableId))
        return prev.filter((id) => id !== selectedTableId);
      return prev;
    });
  }, [playerTableForSelected, selectedTableId, playerWallet.status, playerWallet.address]);

  useEffect(() => {
    if (playerWallet.status !== "connected") setSeatedTableIds([]);
  }, [playerWallet.status]);

  // Hand history tracking
  const lastHandRef = useRef<{ handId: string; pot: string; board: number[] } | null>(null);
  const pendingShowdownRef = useRef<
    Map<
      string,
      {
        revealedCards: Record<number, string[]>;
        winners: Array<{ seat: number; amount: string }>;
      }
    >
  >(new Map());

  const addHandResult = useCallback((tableId: string, result: HandResult) => {
    setHandHistory((prev) => {
      const next = new Map(prev);
      const list = next.get(tableId) ?? [];
      if (list.some((h) => h.handId === result.handId)) return prev;
      next.set(tableId, [result, ...list].slice(0, MAX_HISTORY_PER_TABLE));
      return next;
    });
  }, []);

  const updateHandResult = useCallback(
    (tableId: string, handId: string, update: Partial<HandResult>) => {
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
    },
    []
  );

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

  // Capture hand results from chain events
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
      updateHandResult(tableId, handId, { revealedCards: { ...pending.revealedCards } });
    }

    if (latest.name === "PotAwarded") {
      const amount = data.amount ?? "0";
      const winnersCSV = data.winners ?? "";
      const winnerSeats = winnersCSV
        .split(",")
        .map(Number)
        .filter((n) => Number.isFinite(n) && n >= 0);

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

  // Player key state
  const [playerKeyState, setPlayerKeyState] = useState<KeyState>("none");
  const [playerSk, setPlayerSk] = useState<bigint | null>(null);
  const [playerPk, setPlayerPk] = useState<Uint8Array | null>(null);
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [protectPassphrase, setProtectPassphrase] = useState("");
  const [protectConfirm, setProtectConfirm] = useState("");
  const [protectStatus, setProtectStatus] = useState<string | null>(null);

  const keyLockTimerRef = useRef<number | null>(null);
  const isInHandRef = useRef(false);
  const isKeyEncryptedRef = useRef(false);

  useEffect(() => {
    isInHandRef.current = Boolean(playerSeat?.inHand && playerTableForSelected?.hand);
  }, [playerSeat?.inHand, playerTableForSelected?.hand]);

  const resetKeyLockTimer = useCallback(() => {
    if (keyLockTimerRef.current != null) window.clearTimeout(keyLockTimerRef.current);
    if (playerKeyState !== "unlocked" || !playerWallet.address) return;
    if (!isKeyEncryptedRef.current) return;
    keyLockTimerRef.current = window.setTimeout(() => {
      if (isInHandRef.current) {
        keyLockTimerRef.current = null;
        resetKeyLockTimer();
        return;
      }
      setPlayerSk(null);
      setPlayerPk(null);
      setPlayerKeyState("locked");
      keyLockTimerRef.current = null;
      console.log("[OCP] Keys auto-locked after inactivity");
    }, KEY_LOCK_TIMEOUT_MS);
  }, [playerKeyState, playerWallet.address]);

  useEffect(() => {
    if (playerKeyState !== "unlocked") return;
    window.addEventListener("click", resetKeyLockTimer);
    window.addEventListener("keydown", resetKeyLockTimer);
    resetKeyLockTimer();
    return () => {
      window.removeEventListener("click", resetKeyLockTimer);
      window.removeEventListener("keydown", resetKeyLockTimer);
      if (keyLockTimerRef.current != null) {
        window.clearTimeout(keyLockTimerRef.current);
        keyLockTimerRef.current = null;
      }
    };
  }, [playerKeyState, resetKeyLockTimer]);

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
      const stored = window.localStorage.getItem(
        `${PLAYER_SK_KEY_PREFIX}:${playerWallet.address}`
      );
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

  const deckFinalized = useMemo(() => {
    function checkDealer(dealer: any): boolean {
      return Boolean(dealer?.deckFinalized || dealer?.deck_finalized || dealer?.finalized);
    }
    if (rawTable.data) {
      const raw = rawTable.data as any;
      if (checkDealer(raw?.hand?.dealer)) return true;
    }
    if (playerTableForSelected?.hand) {
      const raw = playerTableForSelected as any;
      if (checkDealer(raw?.hand?.dealer)) return true;
    }
    return false;
  }, [rawTable.data, playerTableForSelected]);

  const holeCardState = useHoleCards({
    coordinatorBase,
    tableId: selectedTableId || null,
    handId: playerTableForSelected?.hand?.handId ?? null,
    seat: playerSeat?.seat ?? null,
    skPlayer: playerSk,
    deckFinalized,
  });

  // Action callbacks
  const applyCoordinatorBase = useCallback(() => {
    const normalized = normalizeCoordinatorBase(coordinatorInput);
    setCoordinatorInput(normalized);
    setCoordinatorBase(normalized);
    setEvents([]);
    window.localStorage.setItem("ocp.web.coordinatorBase", normalized);
  }, [coordinatorInput]);

  const onSeatInputChange = useCallback((field: keyof SeatFormState, value: string) => {
    setSeatForm((prev) => ({ ...prev, [field]: value }));
  }, []);

  const onPlayerSeatInputChange = useCallback((field: keyof PlayerSeatForm, value: string) => {
    setPlayerSeatForm((prev) => ({ ...prev, [field]: value }));
  }, []);

  const onPlayerActionInputChange = useCallback((field: keyof PlayerActionForm, value: string) => {
    if (field === "action") {
      const nextAction = value as PlayerActionForm["action"];
      setPlayerActionForm((prev) => ({
        ...prev,
        action: nextAction,
        amount: nextAction === "bet" || nextAction === "raise" ? prev.amount : "",
      }));
      return;
    }
    setPlayerActionForm((prev) => ({ ...prev, [field]: value }));
  }, []);

  const requestFaucet = useCallback(async () => {
    if (!playerWallet.address) return;
    setFaucetStatus({ kind: "pending", message: null });
    try {
      const res = await fetch(`${coordinatorBase}/v1/faucet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: playerWallet.address }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg =
          res.status === 429
            ? `Cooldown active — ${data.error ?? "try again later"}`
            : (data.error ?? "faucet error");
        setFaucetStatus({ kind: "error", message: msg });
        return;
      }
      const chips = (Number(data.amount) / 1_000_000).toFixed(0);
      setFaucetStatus({
        kind: "success",
        message: `Received ${chips} CHIPS (tx: ${data.txHash?.slice(0, 12)}...)`,
      });
      setTimeout(() => setFaucetStatus({ kind: "idle", message: null }), 8000);
    } catch (err: any) {
      setFaucetStatus({ kind: "error", message: err?.message ?? "network error" });
    }
  }, [playerWallet.address, coordinatorBase]);

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

      try {
        await keplr.experimentalSuggestChain?.({
          chainId: DEFAULT_COSMOS_CHAIN_ID,
          chainName: "OnChainPoker Testnet",
          rpc: DEFAULT_COSMOS_RPC_URL,
          rest: DEFAULT_COSMOS_LCD_URL,
          bip44: { coinType: 118 },
          bech32Config: {
            bech32PrefixAccAddr: "ocp",
            bech32PrefixAccPub: "ocppub",
            bech32PrefixValAddr: "ocpvaloper",
            bech32PrefixValPub: "ocpvaloperpub",
            bech32PrefixConsAddr: "ocpvalcons",
            bech32PrefixConsPub: "ocpvalconspub",
          },
          currencies: [{ coinDenom: "CHIPS", coinMinimalDenom: "uchips", coinDecimals: 6 }],
          feeCurrencies: [
            {
              coinDenom: "CHIPS",
              coinMinimalDenom: "uchips",
              coinDecimals: 6,
              gasPriceStep: { low: 0, average: 0, high: 0 },
            },
          ],
          stakeCurrency: { coinDenom: "CHIPS", coinMinimalDenom: "uchips", coinDecimals: 6 },
        });
      } catch (e) {
        console.warn("[OCP] experimentalSuggestChain failed:", e);
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
        registry: createOcpRegistry(),
      });

      const lcd = new CosmosLcdClient({ baseUrl: DEFAULT_COSMOS_LCD_URL });
      const client = createOcpCosmosClient({ signing, lcd });

      playerClientRef.current = client;
      setPlayerWallet({
        status: "connected",
        address: key.bech32Address,
        chainId: DEFAULT_COSMOS_CHAIN_ID,
        error: null,
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
        error: errorMessage(err),
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
        setPlayerSitSubmit({ kind: "error", message: "Buy-In must be a non-negative integer." });
        return;
      }

      const client = playerClientRef.current;
      if (!client) {
        setPlayerSitSubmit({
          kind: "error",
          message: "Wallet is not connected. Connect wallet and try again.",
        });
        return;
      }

      const { pk: pkPlayer } = getPlayerKeysForAddress(playerWallet.address);
      setPlayerSitSubmit({ kind: "pending", message: "Submitting sit transaction..." });

      try {
        const sitPassword = playerSeatForm.password.trim() || undefined;
        await client.pokerSit({ tableId, buyIn, pkPlayer, password: sitPassword });
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
        setPlayerActionSubmit({
          kind: "error",
          message: "Select a table and wait for player state to load.",
        });
        return;
      }

      if (!table.hand) {
        setPlayerActionSubmit({
          kind: "error",
          message: "No hand is currently active for this table.",
        });
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
          message: "Wallet is not connected. Connect wallet and try again.",
        });
        return;
      }

      const action = playerActionForm.action;
      const needsAmount = action === "bet" || action === "raise";
      const amountRaw = playerActionForm.amount.trim();
      let amount: string | undefined;
      if (needsAmount) {
        if (!/^\d+$/.test(amountRaw) || amountRaw === "") {
          setPlayerActionSubmit({
            kind: "error",
            message: "Amount is required for bet and raise.",
          });
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
    [
      loadPlayerTable,
      playerActionForm.action,
      playerActionForm.amount,
      playerTable.data,
      playerWallet.address,
      selectedTableId,
    ]
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
  }, [
    loadPlayerTable,
    playerTable.data,
    playerWallet.address,
    playerWallet.status,
    selectedTableId,
  ]);

  const submitCreateTable = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const client = playerClientRef.current;
      if (!client) {
        setCreateTableSubmit({ kind: "error", message: "Connect wallet first." });
        return;
      }

      const f = createTableForm;
      for (const [field, val] of Object.entries({
        smallBlind: f.smallBlind,
        bigBlind: f.bigBlind,
        minBuyIn: f.minBuyIn,
        maxBuyIn: f.maxBuyIn,
      })) {
        if (!/^\d+$/.test(val.trim()) || val.trim() === "0") {
          setCreateTableSubmit({
            kind: "error",
            message: `${field} must be a positive integer.`,
          });
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
        setCreateTableSubmit({
          kind: "success",
          message: `Table #${newTableId ?? "?"} created.`,
        });
        setCreateTableForm(defaultCreateTableForm());
        setShowCreateTableModal(false);
        await loadTables(false);
        if (newTableId) setSelectedTableId(newTableId);
      } catch (err) {
        setCreateTableSubmit({ kind: "error", message: errorMessage(err) });
      }
    },
    [createTableForm, loadTables]
  );

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
        player: seatForm.player.trim(),
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
          body: JSON.stringify(payload),
        });

        setSeatSubmit({
          kind: "success",
          message: `Intent submitted for seat ${result.intent.seat}.`,
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

  // Balance polling
  useEffect(() => {
    if (playerWallet.status !== "connected" || !playerWallet.address) {
      setPlayerBalance(null);
      return;
    }
    let cancelled = false;
    const fetchBalance = async () => {
      try {
        const res = await fetch(
          `${DEFAULT_COSMOS_LCD_URL}/cosmos/bank/v1beta1/balances/${playerWallet.address}`
        );
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const balances = data?.balances as Array<{ denom: string; amount: string }> | undefined;
        const chips = balances?.find((b) => b.denom === "uchips");
        if (!cancelled) setPlayerBalance(chips?.amount ?? "0");
      } catch {
        /* ignore */
      }
    };
    void fetchBalance();
    const timer = window.setInterval(fetchBalance, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [playerWallet.status, playerWallet.address]);

  // UI effects
  useEffect(() => {
    if (!sidebarOpen) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sidebarOpen]);

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

  const formattedBalance =
    playerBalance != null
      ? (Number(playerBalance) / 1_000_000).toLocaleString(undefined, {
          maximumFractionDigits: 2,
        })
      : null;

  // Poker table render helper
  const renderPokerTableProps = useMemo(() => {
    const tableData = playerTableForSelected ?? spectatorTable;
    if (!tableData) return null;
    const isSpectator = !playerTableForSelected;
    return deriveTableProps({
      raw: tableData,
      rawDealer: null,
      localAddress: isSpectator
        ? null
        : playerWallet.status === "connected"
          ? playerWallet.address
          : null,
      localHoleCards: isSpectator ? null : holeCardState.cards,
      actionEnabled: isSpectator ? false : playerActionEnabled,
      onAction: isSpectator
        ? () => {}
        : (action: string, amount?: string) => {
            onPlayerActionInputChange("action", action as PlayerActionForm["action"]);
            if (amount) onPlayerActionInputChange("amount", amount);
            if (action === "fold" || action === "check" || action === "call") {
              void submitPlayerActionDirect(action, amount);
            }
          },
    });
  }, [
    playerTableForSelected,
    spectatorTable,
    playerWallet.status,
    playerWallet.address,
    holeCardState.cards,
    playerActionEnabled,
    onPlayerActionInputChange,
    submitPlayerActionDirect,
  ]);

  const showLobby = viewMode === "game" && !selectedTableId;
  const showActionBanner =
    viewMode === "game" &&
    !!selectedTableId &&
    (playerWallet.status !== "connected" || !playerSeat);

  return {
    // State
    coordinatorInput,
    setCoordinatorInput,
    coordinatorBase,
    health,
    tables,
    selectedTableId,
    setSelectedTableId,
    seatIntents,
    rawTable,
    dealerNext,
    seatForm,
    seatSubmit,
    playerWallet,
    playerTable,
    playerSeatForm,
    playerActionForm,
    playerSitSubmit,
    playerActionSubmit,
    playerLeaveSubmit,
    faucetStatus,
    createTableForm,
    setCreateTableForm,
    createTableSubmit,
    showCreateAdvanced,
    setShowCreateAdvanced,
    rebuyAmount,
    setRebuyAmount,
    rebuySubmit,
    lobbyFilter,
    setLobbyFilter,
    seatedTableIds,
    events,
    setEvents,
    handHistory,
    wsStatus,
    wsError,
    chatMessages,
    chatInput,
    setChatInput,
    chatEndRef,
    playerNotes,
    setPlayerNotes,
    viewMode,
    setViewMode,
    sidebarOpen,
    setSidebarOpen,
    showCreateTableModal,
    setShowCreateTableModal,
    playerBalance,
    playerKeyState,
    keyPassphrase,
    setKeyPassphrase,
    keyError,
    protectPassphrase,
    setProtectPassphrase,
    protectConfirm,
    setProtectConfirm,
    protectStatus,
    isKeyEncryptedRef,

    // Derived
    tableList,
    filteredTableList,
    selectedTable,
    playerTableForSelected,
    spectatorTable,
    playerSeat,
    playerActionEnabled,
    chainVerification,
    cometMetrics,
    holeCardState,
    formattedBalance,
    renderPokerTableProps,
    showLobby,
    showActionBanner,

    // Callbacks
    applyCoordinatorBase,
    onSeatInputChange,
    onPlayerSeatInputChange,
    onPlayerActionInputChange,
    requestFaucet,
    connectWallet,
    submitPlayerSeat,
    submitPlayerAction,
    submitPlayerLeave,
    submitCreateTable,
    submitRebuy,
    submitPlayerActionDirect,
    submitSeatIntent,
    doUnlock,
    sendChat,
    onInputKeyDown,
    loadTables,
    loadPlayerTable,
    loadSeatIntents,
    loadDealerViews,

    // Key protection handler
    handleProtectKeys: useCallback(async () => {
      setProtectStatus(null);
      try {
        await protectPlayerKeys(playerWallet.address, protectPassphrase);
        isKeyEncryptedRef.current = true;
        setProtectStatus("Keys encrypted successfully.");
        setProtectPassphrase("");
        setProtectConfirm("");
        setPlayerKeyState("unlocked");
      } catch (err) {
        setProtectStatus(errorMessage(err));
      }
    }, [playerWallet.address, protectPassphrase]),
  };
}

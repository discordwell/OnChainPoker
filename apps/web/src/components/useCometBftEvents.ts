import { useCallback, useEffect, useRef, useState } from "react";
import {
  toWebSocketUrl,
  extractTxResult,
  eventsToChainEvents,
  type ChainEvent,
} from "../lib/cometEventParser";

export type CometBftStatus = "disconnected" | "connecting" | "connected" | "error";

export type CometBftMetrics = {
  status: CometBftStatus;
  eventsReceived: number;
  medianDelayMs: number | null;
  coordinatorMisses: number;
};

type DedupEntry = {
  cometMs: number | null;
  coordMs: number | null;
};

/** Content fingerprint for dedup — keys sorted for order-independence. */
export function fingerprint(ev: ChainEvent): string {
  const d = ev.data ?? {};
  const sorted = typeof d === "object" && d !== null
    ? JSON.stringify(d, Object.keys(d as Record<string, unknown>).sort())
    : JSON.stringify(d);
  return `${ev.name}|${ev.tableId ?? ""}|${ev.handId ?? ""}|${sorted}`;
}

export function computeMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

const DEDUP_MAX = 500;
const MISS_TIMEOUT_MS = 5_000;
const DELAY_WINDOW = 20;
const MAX_BACKOFF_MS = 30_000;

export function useCometBftEvents({
  rpcUrl,
  enabled,
  selectedTableId,
  onChainEvent,
}: {
  rpcUrl: string;
  enabled: boolean;
  selectedTableId: string;
  onChainEvent: (event: ChainEvent) => void;
}): {
  metrics: CometBftMetrics;
  recordCoordinatorEvent: (event: ChainEvent) => boolean;
} {
  const [metrics, setMetrics] = useState<CometBftMetrics>({
    status: "disconnected",
    eventsReceived: 0,
    medianDelayMs: null,
    coordinatorMisses: 0,
  });

  // Refs for mutable state that shouldn't trigger re-renders
  const dedupMapRef = useRef(new Map<string, DedupEntry>());
  const missTimersRef = useRef(new Map<string, number>());
  const delayWindowRef = useRef<number[]>([]);
  const nextEventIndexRef = useRef(1);
  const onChainEventRef = useRef(onChainEvent);
  onChainEventRef.current = onChainEvent;
  const selectedTableIdRef = useRef(selectedTableId);
  selectedTableIdRef.current = selectedTableId;

  // Evict oldest dedup entries when over capacity (Map iterates in insertion order)
  const pruneDedup = useCallback(() => {
    const map = dedupMapRef.current;
    while (map.size > DEDUP_MAX) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest); else break;
    }
  }, []);

  /**
   * Called by App.tsx when the coordinator WS delivers a chain event.
   * Returns true if coordinator was first (App.tsx should do its normal refresh).
   * Returns false if CometBFT already delivered this event (skip refresh).
   */
  const recordCoordinatorEvent = useCallback(
    (event: ChainEvent): boolean => {
      const fp = fingerprint(event);
      const now = Date.now();
      const map = dedupMapRef.current;
      const existing = map.get(fp);

      if (existing) {
        // CometBFT already delivered — record timing, skip refresh
        existing.coordMs = now;
        if (existing.cometMs != null) {
          const delay = now - existing.cometMs;
          const w = delayWindowRef.current;
          w.push(delay);
          if (w.length > DELAY_WINDOW) w.shift();
          setMetrics((prev) => ({
            ...prev,
            medianDelayMs: computeMedian(w),
          }));
        }
        // Cancel miss timer if any
        const timer = missTimersRef.current.get(fp);
        if (timer != null) {
          globalThis.clearTimeout(timer);
          missTimersRef.current.delete(fp);
        }
        return false;
      }

      // Coordinator is first
      map.set(fp, { cometMs: null, coordMs: now });
      pruneDedup();
      return true;
    },
    [pruneDedup],
  );

  useEffect(() => {
    if (!enabled || !rpcUrl) {
      setMetrics((prev) => ({ ...prev, status: "disconnected" }));
      return;
    }

    let stopped = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let backoffMs = 1000;

    const setStatus = (status: CometBftStatus) => {
      if (stopped) return;
      setMetrics((prev) => (prev.status === status ? prev : { ...prev, status }));
    };

    const connect = () => {
      if (stopped) return;
      setStatus("connecting");

      let wsUrl: string;
      try {
        wsUrl = toWebSocketUrl(rpcUrl);
      } catch {
        setStatus("error");
        return;
      }

      try {
        ws = new WebSocket(wsUrl);
      } catch {
        setStatus("error");
        scheduleReconnect();
        return;
      }

      let subscribed = false;

      ws.onopen = () => {
        if (stopped) {
          ws?.close();
          return;
        }
        ws!.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "subscribe",
            params: { query: "tm.event='Tx'" },
          }),
        );
      };

      ws.onmessage = (event) => {
        if (stopped) return;

        let msg: any;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }

        // Subscribe ACK
        if (msg.id === 1) {
          if (msg.error) {
            ws?.close();
            return;
          }
          subscribed = true;
          backoffMs = 1000; // Reset backoff on successful subscribe
          setStatus("connected");
          return;
        }

        const txResult = extractTxResult(msg);
        if (!txResult) return;

        const events = txResult.result?.events ?? txResult.events ?? [];
        if (!Array.isArray(events) || events.length === 0) return;

        const nowMs = Date.now();
        const chainEvents = eventsToChainEvents(events, {
          eventIndexStart: nextEventIndexRef.current,
          timeMs: nowMs,
        });
        nextEventIndexRef.current += chainEvents.length;

        const currentTable = selectedTableIdRef.current;

        for (const ev of chainEvents) {
          // Filter: only process events for the currently selected table (or global events)
          if (ev.tableId && currentTable && ev.tableId !== currentTable) continue;

          const fp = fingerprint(ev);
          const map = dedupMapRef.current;
          const existing = map.get(fp);

          if (existing) {
            // Coordinator already delivered — record timing, skip.
            // Don't record delay here: coordinator was faster, so there's
            // no "coordinator lag" to measure. Only the recordCoordinatorEvent
            // path (CometBFT first, coordinator second) produces meaningful delay.
            existing.cometMs = nowMs;
          } else {
            // CometBFT is first — call onChainEvent for data refresh
            map.set(fp, { cometMs: nowMs, coordMs: null });
            pruneDedup();
            onChainEventRef.current(ev);

            // Start miss timer: if coordinator doesn't deliver in 5s, count as a miss
            const missTimer = window.setTimeout(() => {
              missTimersRef.current.delete(fp);
              const entry = map.get(fp);
              if (entry && entry.coordMs == null) {
                setMetrics((prev) => ({
                  ...prev,
                  coordinatorMisses: prev.coordinatorMisses + 1,
                }));
              }
            }, MISS_TIMEOUT_MS);
            missTimersRef.current.set(fp, missTimer);

            setMetrics((prev) => ({
              ...prev,
              eventsReceived: prev.eventsReceived + 1,
            }));
          }
        }
      };

      const onCloseOrError = () => {
        if (ws) ws = null;
        if (stopped) return;
        setStatus(subscribed ? "disconnected" : "error");
        scheduleReconnect();
      };

      ws.onclose = onCloseOrError;
      ws.onerror = onCloseOrError;
    };

    const scheduleReconnect = () => {
      if (stopped || reconnectTimer != null) return;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        connect();
      }, backoffMs);
    };

    connect();

    return () => {
      setStatus("disconnected");
      stopped = true;
      if (reconnectTimer != null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      // Clear all miss timers
      for (const timer of missTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      missTimersRef.current.clear();
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
        ws = null;
      }
    };
  }, [enabled, rpcUrl, pruneDedup]);

  return { metrics, recordCoordinatorEvent };
}

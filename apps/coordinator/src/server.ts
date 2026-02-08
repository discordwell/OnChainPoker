import http from "node:http";
import type { CoordinatorConfig } from "./config.js";
import type { ChainAdapter } from "./chain/adapter.js";
import { createHttpApp } from "./http.js";
import type { CoordinatorStore } from "./store.js";
import { createWsHub } from "./ws.js";
import type { ChainEvent, TableInfo } from "./types.js";

export type CoordinatorServer = {
  start: () => Promise<{ url: string; host: string; port: number }>;
  stop: () => Promise<void>;
};

export function createCoordinatorServer(opts: {
  config: CoordinatorConfig;
  chain: ChainAdapter;
  store: CoordinatorStore;
}): CoordinatorServer {
  const { config, chain, store } = opts;

  let httpServer: http.Server | null = null;
  let stopChainSub: (() => void) | null = null;
  let stopPruneTimer: NodeJS.Timeout | null = null;
  let wsHub: ReturnType<typeof createWsHub> | null = null;

  async function start() {
    if (chain.start) await chain.start();

    // Initial snapshot.
    const tables = await chain.listTables().catch(() => []);
    for (const t of tables) store.upsertTable(t);

    const app = createHttpApp({
      config,
      store,
      chain,
      ws: {
        broadcastChainEvent: (ev: ChainEvent) => wsHub?.broadcastChainEvent(ev),
        broadcast: (msg: unknown) => wsHub?.broadcast(msg),
        close: async () => wsHub?.close()
      }
    });

    httpServer = http.createServer(app);
    wsHub = createWsHub({ httpServer, store, path: "/ws" });

    stopChainSub = chain.subscribe((ev: ChainEvent) => {
      wsHub?.broadcastChainEvent(ev);
      if (ev.tableId) {
        void chain
          .getTable(ev.tableId)
          .then((t: TableInfo | null) => {
            if (t) store.upsertTable(t);
          })
          .catch(() => {});
      }
    });

    stopPruneTimer = setInterval(() => {
      store.pruneExpiredSeatIntents();
    }, 1_000);
    stopPruneTimer.unref?.();

    await new Promise<void>((resolve, reject) => {
      const onError = (err: unknown) => reject(err);
      httpServer!.once("error", onError);
      httpServer!.listen(config.port, config.host, () => {
        httpServer!.off("error", onError);
        resolve();
      });
    });

    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("unexpected address()");
    const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
    const url = `http://${host}:${addr.port}`;
    return { url, host: config.host, port: addr.port };
  }

  async function stop() {
    if (stopPruneTimer) clearInterval(stopPruneTimer);
    stopPruneTimer = null;

    stopChainSub?.();
    stopChainSub = null;

    if (wsHub) await wsHub.close().catch(() => {});
    wsHub = null;

    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    }
    httpServer = null;

    if (chain.stop) await chain.stop().catch(() => {});
  }

  return { start, stop };
}

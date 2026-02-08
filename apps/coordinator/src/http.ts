import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import { z } from "zod";
import type { CoordinatorConfig } from "./config.js";
import type { ChainAdapter } from "./chain/adapter.js";
import type { CoordinatorStore } from "./store.js";
import type { ArtifactKind } from "./types.js";
import type { WsHub } from "./ws.js";

const SeatIntentSchema = z.object({
  tableId: z.string().min(1),
  seat: z.number().int().min(0).max(8),
  player: z.string().min(1),
  pkPlayer: z.string().min(1).optional(),
  buyIn: z.string().min(1).optional(),
  bond: z.string().min(1).optional()
});

const ArtifactPutSchema = z.object({
  kind: z
    .enum(["shuffle", "encShare", "pubShare", "reveal", "other"] as const)
    .optional(),
  mime: z.string().min(1).optional(),
  dataBase64: z.string().min(1),
  meta: z.record(z.unknown()).optional()
});

export function createHttpApp(opts: {
  config: CoordinatorConfig;
  store: CoordinatorStore;
  chain: ChainAdapter;
  ws: WsHub;
}) {
  const { config, store, chain, ws } = opts;
  const app = express();

  app.use(
    cors({
      origin:
        config.corsOrigins == null
          ? true
          : (origin, cb) => {
              if (!origin) return cb(null, true);
              if (config.corsOrigins!.includes(origin)) return cb(null, true);
              return cb(new Error("CORS blocked"), false);
            }
    })
  );

  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      name: "ocp-coordinator",
      chainAdapter: chain.kind,
      nowMs: Date.now()
    });
  });

  app.get("/v1/tables", (_req, res) => {
    res.json({ tables: store.listTables() });
  });

  app.get("/v1/tables/:tableId", (req, res) => {
    const tableId = String(req.params.tableId ?? "");
    const t = store.getTable(tableId);
    if (!t) return res.status(404).json({ error: "not found" });
    return res.json({ table: t });
  });

  app.post("/v1/seat-intents", (req, res) => {
    const parsed = SeatIntentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const nowMs = Date.now();
    const intentId = crypto.randomUUID();
    const intent = {
      intentId,
      ...parsed.data,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + config.seatIntentTtlMs
    };
    store.putSeatIntent(intent);
    ws.broadcast({ type: "seat_intent", intent });
    res.json({ intent });
  });

  app.get("/v1/seat-intents", (req, res) => {
    const tableId = String(req.query.tableId ?? "");
    if (!tableId) return res.status(400).json({ error: "tableId required" });
    res.json({ intents: store.listSeatIntents(tableId) });
  });

  app.put("/v1/artifacts/:artifactId", (req, res) => {
    const artifactId = String(req.params.artifactId ?? "");
    if (!artifactId) return res.status(400).json({ error: "artifactId required" });

    const parsed = ArtifactPutSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const kind: ArtifactKind = parsed.data.kind ?? "other";
    const mime = parsed.data.mime ?? "application/octet-stream";
    const bytes = Buffer.from(parsed.data.dataBase64, "base64");

    if (bytes.length > config.artifactMaxBytes) {
      return res.status(413).json({ error: "artifact too large" });
    }

    const nowMs = Date.now();
    store.putArtifact({
      artifactId,
      kind,
      mime,
      bytes,
      meta: parsed.data.meta ?? {},
      createdAtMs: nowMs,
      lastAccessAtMs: nowMs
    });
    ws.broadcast({ type: "artifact_stored", artifactId, kind, bytes: bytes.length, nowMs });
    res.json({ ok: true, artifactId, kind, bytes: bytes.length });
  });

  app.get("/v1/artifacts/:artifactId", (req, res) => {
    const artifactId = String(req.params.artifactId ?? "");
    if (!artifactId) return res.status(400).json({ error: "artifactId required" });

    const rec = store.getArtifact(artifactId);
    if (!rec) return res.status(404).json({ error: "not found" });

    res.json({
      artifactId: rec.artifactId,
      kind: rec.kind,
      mime: rec.mime,
      bytes: rec.bytes.length,
      meta: rec.meta,
      dataBase64: rec.bytes.toString("base64")
    });
  });

  app.get("/v1/artifacts/:artifactId/raw", (req, res) => {
    const artifactId = String(req.params.artifactId ?? "");
    if (!artifactId) return res.status(400).end();

    const rec = store.getArtifact(artifactId);
    if (!rec) return res.status(404).end();

    res.setHeader("Content-Type", rec.mime);
    res.setHeader("Content-Length", String(rec.bytes.length));
    res.send(rec.bytes);
  });

  if (config.devRoutes) {
    app.post("/_dev/mock/tables", async (req, res) => {
      if (chain.kind !== "mock") return res.status(400).json({ error: "not a mock chain adapter" });
      const tableId = String(req.body?.tableId ?? "").trim() || `table-${Math.floor(Math.random() * 1e9)}`;

      // Lazily import to avoid exposing mock-only methods on the ChainAdapter interface.
      const { MockChainAdapter } = await import("./chain/mock.js");
      const mock = chain as unknown as InstanceType<typeof MockChainAdapter>;
      const table = mock.createTable(tableId, req.body?.params ?? {});
      res.json({ table });
    });

    app.post("/_dev/mock/events", async (req, res) => {
      if (chain.kind !== "mock") return res.status(400).json({ error: "not a mock chain adapter" });
      const { MockChainAdapter } = await import("./chain/mock.js");
      const mock = chain as unknown as InstanceType<typeof MockChainAdapter>;

      const body = req.body ?? {};
      if (typeof body?.name !== "string" || !body.name) {
        return res.status(400).json({ error: "name required" });
      }
      const ev = mock.publishEvent({
        name: body.name,
        tableId: typeof body.tableId === "string" ? body.tableId : undefined,
        handId: typeof body.handId === "string" ? body.handId : undefined,
        data: body.data
      });
      res.json({ event: ev });
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const msg = err instanceof Error ? err.message : "internal error";
    res.status(500).json({ error: msg });
  });

  return app;
}

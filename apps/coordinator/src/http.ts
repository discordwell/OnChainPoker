import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
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

const ShuffleArtifactPutSchema = z.object({
  proofShuffleBase64: z.string().min(1),
  mime: z.string().min(1).optional(),
  meta: z.record(z.unknown()).optional()
});

function getClientId(req: Request): string {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip || req.socket.remoteAddress || "unknown";
}

function extractWriteToken(req: Request): string | null {
  const keyHeader = req.header("x-api-key");
  if (keyHeader?.trim()) return keyHeader.trim();

  const authHeader = req.header("authorization");
  if (!authHeader) return null;

  const m = /^\s*Bearer\s+(.+)$/i.exec(authHeader);
  if (m?.[1]?.trim()) return m[1].trim();

  return authHeader.trim() || null;
}

function createWriteAuthGuard(config: CoordinatorConfig): express.RequestHandler {
  if (!config.requireWriteAuth) return (_req: Request, _res: Response, next: NextFunction) => next();
  const expected = Buffer.from(config.writeAuthToken ?? "");

  return (req: Request, res: Response, next: NextFunction) => {
    const token = extractWriteToken(req);
    if (!token || token.length === 0) {
      return res.status(401).json({ error: "write auth token required" });
    }

    const candidate = Buffer.from(token);
    if (
      candidate.length !== expected.length ||
      !crypto.timingSafeEqual(candidate, expected)
    ) {
      return res.status(401).json({ error: "invalid write auth token" });
    }

    next();
  };
}

function createWriteRateLimiter(config: CoordinatorConfig): express.RequestHandler {
  if (!config.writeRateLimitEnabled) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  const max = Math.max(1, config.writeRateLimitMax);
  const windowMs = Math.max(1_000, config.writeRateLimitWindowMs);
  const buckets = new Map<string, { count: number; windowEndMs: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = getClientId(req);
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || now >= bucket.windowEndMs) {
      bucket = { count: 1, windowEndMs: now + windowMs };
      buckets.set(key, bucket);
    } else {
      if (bucket.count >= max) {
        const resetSec = Math.max(0, Math.ceil((bucket.windowEndMs - now) / 1000));
        res.setHeader("Retry-After", String(resetSec));
        res.setHeader("X-RateLimit-Limit", String(max));
        res.setHeader("X-RateLimit-Remaining", "0");
        res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.windowEndMs / 1000)));
        return res.status(429).json({ error: "rate limit exceeded" });
      }
      bucket.count += 1;
    }

    const remaining = Math.max(0, max - bucket.count);
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.windowEndMs / 1000)));
    next();
  };
}

type V0DealerEpoch = {
  epochId: number;
  threshold: number;
  pkEpoch: string; // base64
  members: Array<{ validatorId: string; index: number; pubShare: string }>;
  slashed?: string[];
};

function asNumber(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "") {
    const n = Number(x);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function decodeU8Array(raw: unknown): number[] | null {
  if (Array.isArray(raw)) {
    const out: number[] = [];
    for (const v of raw) {
      const n = asNumber(v);
      if (n == null || !Number.isInteger(n) || n < 0 || n > 255) return null;
      out.push(n);
    }
    return out;
  }

  if (typeof raw === "string" && raw.length > 0) {
    try {
      return Array.from(Buffer.from(raw, "base64"), (b) => Number(b));
    } catch {
      return null;
    }
  }
  return null;
}

function v0ExpectedRevealPos(table: any): number | null {
  const h = table?.hand;
  const dh = h?.dealer;
  if (!h || !dh) return null;
  if (!dh.finalized) return null;

  const phase = String(h.phase ?? "");

  if (phase === "awaitFlop" || phase === "awaitTurn" || phase === "awaitRiver") {
    const cursor = asNumber(dh.cursor) ?? 0;
    const boardLen = decodeU8Array(h.board)?.length ?? 0;
    const pos = cursor + boardLen;
    return Number.isFinite(pos) ? pos : null;
  }

  if (phase === "awaitShowdown") {
    const holePos = decodeU8Array(dh.holePos);
    if (!holePos || holePos.length !== 18) return null;

    const reveals = new Set<number>();
    if (Array.isArray(dh.reveals)) {
      for (const r of dh.reveals as any[]) {
        const p = asNumber(r?.pos);
        if (p != null) reveals.add(p);
      }
    }

    const eligible: number[] = [];
    for (let seat = 0; seat < 9; seat++) {
      if (!h.inHand?.[seat] || h.folded?.[seat]) continue;
      for (let c = 0; c < 2; c++) {
        const p = asNumber(holePos[seat * 2 + c]);
        if (p == null || p === 255) continue;
        eligible.push(p);
      }
    }
    eligible.sort((a, b) => a - b);
    for (const p of eligible) {
      if (!reveals.has(p)) return p;
    }
    return null;
  }

  return null;
}

export function createHttpApp(opts: {
  config: CoordinatorConfig;
  store: CoordinatorStore;
  chain: ChainAdapter;
  ws: WsHub;
}) {
  const { config, store, chain, ws } = opts;
  const app = express();
  const writeGuards = [createWriteAuthGuard(config), createWriteRateLimiter(config)];

  app.use(
    cors({
      origin:
        config.corsOrigins == null
          ? true
          : (origin, cb) => {
              if (!origin) return cb(null, true);
              if (config.corsOrigins!.includes("*")) return cb(null, true);
              if (config.corsOrigins.includes(origin)) return cb(null, true);
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

  // ---- Appchain v0 helpers (CometBFT + ABCI scaffold) ----

  app.get("/v1/appchain/v0/tables/:tableId", async (req, res) => {
    if (chain.kind !== "comet" || !chain.queryJson) {
      return res.status(400).json({ error: "chain adapter does not support v0 table queries" });
    }

    const tableId = String(req.params.tableId ?? "").trim();
    if (!tableId) return res.status(400).json({ error: "tableId required" });

    const table = await chain.queryJson<any>(`/table/${tableId}`).catch(() => null);
    if (!table) return res.status(404).json({ error: "not found" });
    return res.json({ table });
  });

  app.get("/v1/appchain/v0/dealer/epoch", async (_req, res) => {
    if (chain.kind !== "comet" || !chain.queryJson) {
      return res.status(400).json({ error: "chain adapter does not support dealer epoch queries" });
    }
    const epoch = await chain.queryJson<V0DealerEpoch>("/dealer/epoch").catch(() => null);
    if (!epoch) return res.status(404).json({ error: "no active epoch" });
    return res.json({ epoch });
  });

  app.get("/v1/appchain/v0/tables/:tableId/dealer/next", async (req, res) => {
    if (chain.kind !== "comet" || !chain.queryJson) {
      return res.status(400).json({ error: "chain adapter does not support v0 dealer queries" });
    }

    const tableId = String(req.params.tableId ?? "").trim();
    if (!tableId) return res.status(400).json({ error: "tableId required" });

    const table = await chain.queryJson<any>(`/table/${tableId}`).catch(() => null);
    if (!table) return res.status(404).json({ error: "not found" });

    const h = table?.hand;
    const dh = h?.dealer;
    const handId = asNumber(h?.handId);
    const phase = String(h?.phase ?? "");

    // Epoch is optional; used for "who" suggestions and threshold counts.
    let epoch = await chain.queryJson<V0DealerEpoch>("/dealer/epoch").catch(() => null);
    const dhEpochId = asNumber(dh?.epochId);
    if (epoch && dhEpochId != null && asNumber(epoch.epochId) !== dhEpochId) {
      epoch = null;
    }
    const slashed = new Set((epoch?.slashed ?? []).map((x) => String(x)));

    if (!h || !dh || !handId) {
      return res.json({
        tableId,
        action: { kind: "none" as const, reason: "no active dealer hand" }
      });
    }

    if (phase === "shuffle") {
      const shuffleStep = asNumber(dh.shuffleStep) ?? 0;
      const nextRound = shuffleStep + 1;
      // v1 dealer mode requires the deck be shuffled by every QUAL member before finalization.
      let canFinalize = shuffleStep > 0;

      let suggestedShuffler: string | null = null;
      if (epoch?.members?.length) {
        const qual = [...epoch.members]
          .filter((m) => !slashed.has(String(m.validatorId)))
          .sort((a, b) => (a.index ?? 0) - (b.index ?? 0) || String(a.validatorId).localeCompare(String(b.validatorId)));
        canFinalize = shuffleStep >= qual.length;
        const pick = qual[shuffleStep];
        suggestedShuffler = pick?.validatorId ?? null;
      }

      return res.json({
        tableId,
        handId,
        action: {
          kind: "shuffle" as const,
          shuffleStep,
          nextRound,
          suggestedShuffler,
          canFinalize
        }
      });
    }

    const pos = v0ExpectedRevealPos(table);
    if (pos != null) {
      const pubShares = Array.isArray(dh.pubShares) ? dh.pubShares : [];
      const seen = new Set<string>();
      for (const ps of pubShares) {
        if (asNumber(ps?.pos) !== pos) continue;
        const vid = String(ps?.validatorId ?? "");
        if (vid) seen.add(vid);
      }

      const threshold = epoch ? asNumber(epoch.threshold) : null;
      const missingValidatorIds = epoch?.members?.length
        ? epoch.members
            .filter((m) => !slashed.has(String(m.validatorId)))
            .map((m) => m.validatorId)
            .filter((vid) => !seen.has(String(vid)))
        : null;

      return res.json({
        tableId,
        handId,
        action: {
          kind: "reveal" as const,
          pos,
          havePubShares: seen.size,
          threshold,
          missingValidatorIds
        }
      });
    }

    return res.json({
      tableId,
      handId,
      action: { kind: "none" as const, reason: "hand not awaiting dealer action" }
    });
  });

  // ---- Dealer hand LCD proxy routes ----

  app.get("/v1/dealer/hand/:tableId/:handId", async (req, res) => {
    if (chain.kind !== "comet" || !chain.queryJson) {
      return res.status(400).json({ error: "chain adapter does not support dealer queries" });
    }

    const tableId = String(req.params.tableId ?? "").trim();
    const handId = String(req.params.handId ?? "").trim();
    if (!tableId || !handId) return res.status(400).json({ error: "tableId and handId required" });

    const table = await chain.queryJson<any>(`/table/${tableId}`).catch(() => null);
    if (!table) return res.status(404).json({ error: "table not found" });

    const dh = table?.hand?.dealer;
    if (!dh || String(table?.hand?.handId ?? table?.hand?.hand_id ?? "") !== handId) {
      return res.status(404).json({ error: "dealer hand not found" });
    }

    return res.json({ hand: dh, tableId, handId });
  });

  app.get("/v1/dealer/hand/:tableId/:handId/hole-positions/:seat", async (req, res) => {
    if (chain.kind !== "comet" || !chain.queryJson) {
      return res.status(400).json({ error: "chain adapter does not support dealer queries" });
    }

    const tableId = String(req.params.tableId ?? "").trim();
    const handId = String(req.params.handId ?? "").trim();
    const seat = asNumber(req.params.seat);
    if (!tableId || !handId || seat == null || seat < 0 || seat > 8) {
      return res.status(400).json({ error: "tableId, handId, and seat (0-8) required" });
    }

    const table = await chain.queryJson<any>(`/table/${tableId}`).catch(() => null);
    if (!table) return res.status(404).json({ error: "table not found" });

    const dh = table?.hand?.dealer;
    if (!dh || String(table?.hand?.handId ?? table?.hand?.hand_id ?? "") !== handId) {
      return res.status(404).json({ error: "dealer hand not found" });
    }

    const holePos = decodeU8Array(dh.holePos ?? dh.hole_pos);
    if (!holePos || holePos.length !== 18) {
      return res.status(404).json({ error: "hole positions not available" });
    }

    const pos0 = holePos[seat * 2];
    const pos1 = holePos[seat * 2 + 1];
    return res.json({ pos0, pos1 });
  });

  app.get("/v1/dealer/hand/:tableId/:handId/enc-shares/:pos", async (req, res) => {
    if (chain.kind !== "comet" || !chain.queryJson) {
      return res.status(400).json({ error: "chain adapter does not support dealer queries" });
    }

    const tableId = String(req.params.tableId ?? "").trim();
    const handId = String(req.params.handId ?? "").trim();
    const pos = asNumber(req.params.pos);
    if (!tableId || !handId || pos == null || pos < 0) {
      return res.status(400).json({ error: "tableId, handId, and pos required" });
    }

    const table = await chain.queryJson<any>(`/table/${tableId}`).catch(() => null);
    if (!table) return res.status(404).json({ error: "table not found" });

    const dh = table?.hand?.dealer;
    if (!dh || String(table?.hand?.handId ?? table?.hand?.hand_id ?? "") !== handId) {
      return res.status(404).json({ error: "dealer hand not found" });
    }

    const encShares = Array.isArray(dh.encShares ?? dh.enc_shares)
      ? (dh.encShares ?? dh.enc_shares)
      : [];
    const filtered = encShares.filter((s: any) => asNumber(s?.pos) === pos);

    return res.json({
      shares: filtered.map((s: any) => ({
        validator: String(s.validatorId ?? s.validator_id ?? s.validator ?? ""),
        encShare: String(s.encShare ?? s.enc_share ?? ""),
        proofEncShare: String(s.proofEncShare ?? s.proof_enc_share ?? ""),
        pkPlayer: String(s.pkPlayer ?? s.pk_player ?? "")
      }))
    });
  });

  app.get("/v1/dealer/hand/:tableId/:handId/ciphertext/:pos", async (req, res) => {
    if (chain.kind !== "comet" || !chain.queryJson) {
      return res.status(400).json({ error: "chain adapter does not support dealer queries" });
    }

    const tableId = String(req.params.tableId ?? "").trim();
    const handId = String(req.params.handId ?? "").trim();
    const pos = asNumber(req.params.pos);
    if (!tableId || !handId || pos == null || pos < 0) {
      return res.status(400).json({ error: "tableId, handId, and pos required" });
    }

    const table = await chain.queryJson<any>(`/table/${tableId}`).catch(() => null);
    if (!table) return res.status(404).json({ error: "table not found" });

    const dh = table?.hand?.dealer;
    if (!dh || String(table?.hand?.handId ?? table?.hand?.hand_id ?? "") !== handId) {
      return res.status(404).json({ error: "dealer hand not found" });
    }

    const deck = Array.isArray(dh.deck) ? dh.deck : [];
    const entry = deck[pos];
    if (!entry) {
      return res.status(404).json({ error: `deck position ${pos} not found` });
    }

    return res.json({
      c1: String(entry.c1 ?? ""),
      c2: String(entry.c2 ?? "")
    });
  });

  // Convenience: store a shuffle proof artifact using its sha256(proofBytes) hex as the artifactId.
  // This lines up with the `proofHash` attribute emitted by the chain on `ShuffleAccepted`.
  app.post("/v1/appchain/v0/artifacts/shuffle", ...writeGuards, (req, res) => {
    const parsed = ShuffleArtifactPutSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const mime = parsed.data.mime ?? "application/octet-stream";
    const bytes = Buffer.from(parsed.data.proofShuffleBase64, "base64");
    if (bytes.length > config.artifactMaxBytes) {
      return res.status(413).json({ error: "artifact too large" });
    }

    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const artifactId = sha256;

    const nowMs = Date.now();
    store.putArtifact({
      artifactId,
      kind: "shuffle",
      mime,
      bytes,
      meta: parsed.data.meta ?? {},
      createdAtMs: nowMs,
      lastAccessAtMs: nowMs
    });
    ws.broadcast({ type: "artifact_stored", artifactId, kind: "shuffle", bytes: bytes.length, nowMs });
    res.json({ ok: true, artifactId, kind: "shuffle", bytes: bytes.length });
  });

  app.post("/v1/seat-intents", ...writeGuards, (req, res) => {
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

  app.put("/v1/artifacts/:artifactId", ...writeGuards, (req, res) => {
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

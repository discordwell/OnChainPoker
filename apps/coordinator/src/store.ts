import type { ArtifactRecord, SeatIntent, TableInfo } from "./types.js";

export class CoordinatorStore {
  private readonly tablesById = new Map<string, TableInfo>();
  private readonly seatIntentsByTable = new Map<string, Map<string, SeatIntent>>();

  private readonly artifactsById = new Map<string, ArtifactRecord>();
  private artifactsTotalBytes = 0;

  constructor(
    private readonly limits: {
      artifactMaxBytes: number;
      artifactCacheMaxBytes: number;
    }
  ) {}

  upsertTable(table: TableInfo): void {
    this.tablesById.set(table.tableId, table);
  }

  listTables(): TableInfo[] {
    return [...this.tablesById.values()].sort((a, b) => a.tableId.localeCompare(b.tableId));
  }

  getTable(tableId: string): TableInfo | null {
    return this.tablesById.get(tableId) ?? null;
  }

  putSeatIntent(intent: SeatIntent): void {
    let byId = this.seatIntentsByTable.get(intent.tableId);
    if (!byId) {
      byId = new Map();
      this.seatIntentsByTable.set(intent.tableId, byId);
    }
    byId.set(intent.intentId, intent);
  }

  listSeatIntents(tableId: string, nowMs = Date.now()): SeatIntent[] {
    this.pruneExpiredSeatIntents(nowMs);
    const byId = this.seatIntentsByTable.get(tableId);
    if (!byId) return [];
    return [...byId.values()].sort((a, b) => a.seat - b.seat);
  }

  pruneExpiredSeatIntents(nowMs = Date.now()): void {
    for (const [tableId, byId] of this.seatIntentsByTable.entries()) {
      for (const [intentId, intent] of byId.entries()) {
        if (intent.expiresAtMs <= nowMs) byId.delete(intentId);
      }
      if (byId.size === 0) this.seatIntentsByTable.delete(tableId);
    }
  }

  putArtifact(artifact: ArtifactRecord, nowMs = Date.now()): void {
    if (artifact.bytes.length > this.limits.artifactMaxBytes) {
      throw new Error(
        `artifact too large: ${artifact.bytes.length} > ${this.limits.artifactMaxBytes}`
      );
    }

    const prev = this.artifactsById.get(artifact.artifactId);
    if (prev) this.artifactsTotalBytes -= prev.bytes.length;

    artifact.lastAccessAtMs = nowMs;
    this.artifactsById.set(artifact.artifactId, artifact);
    this.artifactsTotalBytes += artifact.bytes.length;

    this.evictArtifactsIfNeeded();
  }

  getArtifact(artifactId: string, nowMs = Date.now()): ArtifactRecord | null {
    const rec = this.artifactsById.get(artifactId);
    if (!rec) return null;
    rec.lastAccessAtMs = nowMs;
    return rec;
  }

  hasArtifact(artifactId: string): boolean {
    return this.artifactsById.has(artifactId);
  }

  private evictArtifactsIfNeeded(): void {
    if (this.artifactsTotalBytes <= this.limits.artifactCacheMaxBytes) return;

    const artifacts = [...this.artifactsById.values()].sort(
      (a, b) => a.lastAccessAtMs - b.lastAccessAtMs
    );

    for (const a of artifacts) {
      if (this.artifactsTotalBytes <= this.limits.artifactCacheMaxBytes) break;
      this.artifactsById.delete(a.artifactId);
      this.artifactsTotalBytes -= a.bytes.length;
    }
  }
}

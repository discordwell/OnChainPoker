export type CoordinatorConfig = {
  host: string;
  port: number;
  corsOrigins: string[] | null; // null => allow all
  devRoutes: boolean;
  artifactMaxBytes: number;
  artifactCacheMaxBytes: number;
  seatIntentTtlMs: number;
};

function parseIntEnv(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  return n;
}

function parseBoolEnv(v: string | undefined): boolean | undefined {
  if (!v) return undefined;
  const norm = v.trim().toLowerCase();
  if (norm === "1" || norm === "true" || norm === "yes" || norm === "on") return true;
  if (norm === "0" || norm === "false" || norm === "no" || norm === "off") return false;
  return undefined;
}

function parseCsv(v: string | undefined): string[] | null {
  if (!v) return null;
  const norm = v.trim();
  if (norm === "" || norm === "*") return null;
  const parts = norm
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoordinatorConfig {
  // Default to loopback so we fail loudly on port conflicts and avoid binding quirks on some OSes.
  const host = (env.COORDINATOR_HOST ?? "").trim() || "127.0.0.1";
  const port =
    parseIntEnv(env.COORDINATOR_PORT) ??
    parseIntEnv(env.PORT) ??
    8788;

  const corsOrigins = parseCsv(env.CORS_ORIGINS);
  const devRoutes =
    parseBoolEnv(env.COORDINATOR_DEV_ROUTES) ??
    (env.NODE_ENV !== "production");

  const artifactMaxBytes =
    parseIntEnv(env.COORDINATOR_ARTIFACT_MAX_BYTES) ??
    1_000_000;
  const artifactCacheMaxBytes =
    parseIntEnv(env.COORDINATOR_ARTIFACT_CACHE_MAX_BYTES) ??
    10_000_000;

  const seatIntentTtlSecs =
    parseIntEnv(env.COORDINATOR_SEAT_INTENT_TTL_SECS) ??
    300;

  return {
    host,
    port,
    corsOrigins,
    devRoutes,
    artifactMaxBytes,
    artifactCacheMaxBytes,
    seatIntentTtlMs: seatIntentTtlSecs * 1000
  };
}

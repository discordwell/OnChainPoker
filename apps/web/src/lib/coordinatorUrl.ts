import { DEFAULT_COORDINATOR_HTTP_URL } from "./constants";

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export function normalizeCoordinatorBase(raw: string): string {
  const input = raw.trim();
  if (!input) return trimTrailingSlashes(DEFAULT_COORDINATOR_HTTP_URL);

  try {
    const absolute = new URL(input, window.location.origin);
    if (!ALLOWED_PROTOCOLS.has(absolute.protocol)) {
      return trimTrailingSlashes(DEFAULT_COORDINATOR_HTTP_URL);
    }
    return trimTrailingSlashes(absolute.toString());
  } catch {
    return trimTrailingSlashes(DEFAULT_COORDINATOR_HTTP_URL);
  }
}

export function toWsUrl(httpBase: string): string {
  const base = new URL(httpBase, window.location.origin);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/ws`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

export function initialCoordinatorBase(): string {
  const saved = window.localStorage.getItem("ocp.web.coordinatorBase") ?? "";
  return normalizeCoordinatorBase(saved || DEFAULT_COORDINATOR_HTTP_URL);
}

import type { HandResult } from "../components/PokerTable";
import type {
  TableInfo,
  WsStatus,
  SeatFormState,
  PlayerSeatForm,
  PlayerActionForm,
  CreateTableForm,
} from "./types";
import { HAND_HISTORY_KEY, PLAYER_NOTES_KEY } from "./constants";

export function uint8ToBase64(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out);
}

export function base64ToUint8(raw: string | null): Uint8Array | null {
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

export function formatTimestamp(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleString();
}

export function formatRelative(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "-";
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  if (abs < 1_000) return "now";
  if (abs < 60_000) return `${Math.round(abs / 1_000)}s ${diff > 0 ? "left" : "ago"}`;
  return `${Math.round(abs / 60_000)}m ${diff > 0 ? "left" : "ago"}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }
  return (await response.json()) as T;
}

export function statusTone(status: TableInfo["status"]): string {
  if (status === "in_hand") return "status-live";
  if (status === "closed") return "status-closed";
  return "status-open";
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "";
}

export function wsTone(status: WsStatus): string {
  if (status === "open") return "status-open";
  if (status === "error") return "status-closed";
  if (status === "connecting") return "status-live";
  return "status-muted";
}

export function defaultSeatForm(): SeatFormState {
  return {
    player: "",
    seat: "0",
    buyIn: "",
    bond: "",
    pkPlayer: "",
  };
}

export function defaultPlayerSeatForm(): PlayerSeatForm {
  return {
    buyIn: "",
    password: "",
  };
}

export function defaultPlayerActionForm(): PlayerActionForm {
  return {
    action: "check",
    amount: "",
  };
}

export function defaultCreateTableForm(): CreateTableForm {
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

export function loadPlayerNotes(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PLAYER_NOTES_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function savePlayerNotes(notes: Record<string, string>) {
  try {
    localStorage.setItem(PLAYER_NOTES_KEY, JSON.stringify(notes));
  } catch {
    /* localStorage full */
  }
}

export function loadHandHistory(): Map<string, HandResult[]> {
  try {
    const raw = localStorage.getItem(HAND_HISTORY_KEY);
    if (!raw) return new Map();
    return new Map(Object.entries(JSON.parse(raw)));
  } catch {
    return new Map();
  }
}

export function saveHandHistory(h: Map<string, HandResult[]>) {
  try {
    const obj: Record<string, HandResult[]> = {};
    for (const [k, v] of h) obj[k] = v;
    localStorage.setItem(HAND_HISTORY_KEY, JSON.stringify(obj));
  } catch {
    /* localStorage full */
  }
}

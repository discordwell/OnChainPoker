export const DEFAULT_COORDINATOR_HTTP_URL =
  import.meta.env.VITE_COORDINATOR_HTTP_URL ?? "http://127.0.0.1:8788";
export const DEFAULT_COSMOS_RPC_URL =
  import.meta.env.VITE_COSMOS_RPC_URL ?? "http://127.0.0.1:26657";
export const DEFAULT_COSMOS_LCD_URL =
  import.meta.env.VITE_COSMOS_LCD_URL ?? "http://127.0.0.1:1317";
export const DEFAULT_COSMOS_CHAIN_ID =
  import.meta.env.VITE_COSMOS_CHAIN_ID ?? "ocp-local-1";
export const DEFAULT_COSMOS_GAS_PRICE =
  import.meta.env.VITE_COSMOS_GAS_PRICE ?? "0uchips";
export const PLAYER_SK_KEY_PREFIX = "ocp.web.skPlayer";
export const LEGACY_PK_KEY_PREFIX = "ocp.web.pkPlayer";
export const MAX_EVENTS = 200;
export const HAND_HISTORY_KEY = "ocp.web.handHistory";
export const PLAYER_NOTES_KEY = "ocp.web.playerNotes";
export const MAX_CHAT_MESSAGES = 50;
export const MAX_HISTORY_PER_TABLE = 20;
export const KEY_LOCK_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

export interface BotConfig {
  strategy: "calling-station" | "tag" | "lag";
  tableId: string;
  buyIn: string | null;
  password: string;
  mnemonic?: string;
  privkeyHex?: string;
  cosmosRpcUrl: string;
  cosmosLcdUrl: string;
  bech32Prefix: string;
  gasPrice: string;
  pollIntervalMs: number;
  autoStartHand: boolean;
  autoSit: boolean;
  autoRebuy: boolean;
  rebuyDelayMs: number;
  name: string;
}

function envStr(key: string, fallback: string): string {
  return (process.env[key] ?? "").trim() || fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = (process.env[key] ?? "").trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes";
}

function envInt(key: string, fallback: number): number {
  const v = (process.env[key] ?? "").trim();
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): BotConfig {
  const tableId = envStr("BOT_TABLE_ID", "");
  if (!tableId) throw new Error("BOT_TABLE_ID is required");

  const mnemonic = envStr("BOT_MNEMONIC", "");
  const privkeyHex = envStr("BOT_PRIVKEY_HEX", "");
  if (!mnemonic && !privkeyHex) {
    throw new Error("Either BOT_MNEMONIC or BOT_PRIVKEY_HEX is required");
  }

  const buyInStr = (process.env["BOT_BUY_IN"] ?? "").trim();

  return {
    strategy: envStr("BOT_STRATEGY", "calling-station") as BotConfig["strategy"],
    tableId,
    buyIn: buyInStr || null,
    password: envStr("BOT_PASSWORD", ""),
    mnemonic: mnemonic || undefined,
    privkeyHex: privkeyHex || undefined,
    cosmosRpcUrl: envStr("BOT_COSMOS_RPC_URL", "http://127.0.0.1:26657"),
    cosmosLcdUrl: envStr("BOT_COSMOS_LCD_URL", "http://127.0.0.1:1317"),
    bech32Prefix: envStr("BOT_BECH32_PREFIX", "ocp"),
    gasPrice: envStr("BOT_GAS_PRICE", "0uocp"),
    pollIntervalMs: envInt("BOT_POLL_INTERVAL_MS", 1000),
    autoStartHand: envBool("BOT_AUTO_START_HAND", true),
    autoSit: envBool("BOT_AUTO_SIT", true),
    autoRebuy: envBool("BOT_AUTO_REBUY", true),
    rebuyDelayMs: envInt("BOT_REBUY_DELAY_MS", 5000),
    name: envStr("BOT_NAME", "bot"),
  };
}

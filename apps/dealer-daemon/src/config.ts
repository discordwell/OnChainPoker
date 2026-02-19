export interface DealerDaemonConfig {
  /** Validator bech32 address (ocp1...) */
  validatorAddress: string;
  /** Mnemonic phrase for signing transactions */
  mnemonic?: string;
  /** Alternative: raw hex private key */
  privkeyHex?: string;
  /** Cosmos SDK RPC URL */
  cosmosRpcUrl: string;
  /** Cosmos LCD (REST) URL */
  cosmosLcdUrl: string;
  /** Bech32 prefix */
  bech32Prefix: string;
  /** Gas price string e.g. "0uocp" */
  gasPrice: string;
  /** Directory for epoch secret state files */
  stateDir: string;
  /** Passphrase for encrypting state files at rest */
  statePassphrase: string;
  /** Whether this daemon is the designated gamemaster */
  isGamemaster: boolean;
  /** Auto-begin new epochs when none active */
  autoBeginEpoch: boolean;
  /** Auto-init hands when table ready */
  autoInitHand: boolean;
  /** Auto-finalize deck/reveals */
  autoFinalize: boolean;
  /** Poll interval in ms for fallback polling */
  pollIntervalMs: number;
  /** DKG parameters */
  committeeSize: number;
  threshold: number;
  /** Shuffle rounds */
  shuffleRounds: number;
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

export function loadConfig(): DealerDaemonConfig {
  const validatorAddress = envStr("DEALER_VALIDATOR_ADDRESS", "");
  if (!validatorAddress) {
    throw new Error("DEALER_VALIDATOR_ADDRESS is required");
  }

  const mnemonic = envStr("DEALER_VALIDATOR_MNEMONIC", "");
  const privkeyHex = envStr("DEALER_VALIDATOR_PRIVKEY_HEX", "");
  if (!mnemonic && !privkeyHex) {
    throw new Error("Either DEALER_VALIDATOR_MNEMONIC or DEALER_VALIDATOR_PRIVKEY_HEX is required");
  }

  return {
    validatorAddress,
    mnemonic: mnemonic || undefined,
    privkeyHex: privkeyHex || undefined,
    cosmosRpcUrl: envStr("DEALER_COSMOS_RPC_URL", "http://127.0.0.1:26657"),
    cosmosLcdUrl: envStr("DEALER_COSMOS_LCD_URL", "http://127.0.0.1:1317"),
    bech32Prefix: envStr("DEALER_BECH32_PREFIX", "ocp"),
    gasPrice: envStr("DEALER_GAS_PRICE", "0uocp"),
    stateDir: envStr("DEALER_STATE_DIR", `${process.env.HOME ?? "/tmp"}/.ocp-dealer`),
    statePassphrase: envStr("DEALER_STATE_PASSPHRASE", ""),
    isGamemaster: envBool("DEALER_IS_GAMEMASTER", false),
    autoBeginEpoch: envBool("DEALER_AUTO_BEGIN_EPOCH", true),
    autoInitHand: envBool("DEALER_AUTO_INIT_HAND", true),
    autoFinalize: envBool("DEALER_AUTO_FINALIZE", true),
    pollIntervalMs: envInt("DEALER_POLL_INTERVAL_MS", 2000),
    committeeSize: envInt("DEALER_COMMITTEE_SIZE", 3),
    threshold: envInt("DEALER_THRESHOLD", 3),
    shuffleRounds: envInt("DEALER_SHUFFLE_ROUNDS", 8),
  };
}

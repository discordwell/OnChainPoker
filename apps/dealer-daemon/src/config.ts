export interface DealerDaemonConfig {
  /** Validator operator bech32 address (ocpvaloper1...) */
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

function isProductionEnv(): boolean {
  return (process.env.NODE_ENV ?? "").trim().toLowerCase() === "production";
}

function requireHttpUrl(name: string, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http:// or https://`);
  }
}

export function loadConfig(): DealerDaemonConfig {
  const bech32Prefix = envStr("DEALER_BECH32_PREFIX", "ocp");
  const validatorAddress = envStr("DEALER_VALIDATOR_ADDRESS", "");
  if (!validatorAddress) {
    throw new Error("DEALER_VALIDATOR_ADDRESS is required");
  }
  if (!validatorAddress.startsWith(`${bech32Prefix}valoper1`)) {
    throw new Error(`DEALER_VALIDATOR_ADDRESS must be a ${bech32Prefix}valoper1... address`);
  }

  const mnemonic = envStr("DEALER_VALIDATOR_MNEMONIC", "");
  const privkeyHex = envStr("DEALER_VALIDATOR_PRIVKEY_HEX", "");
  if (!mnemonic && !privkeyHex) {
    throw new Error("Either DEALER_VALIDATOR_MNEMONIC or DEALER_VALIDATOR_PRIVKEY_HEX is required");
  }
  if (mnemonic && privkeyHex) {
    throw new Error("Set only one signer credential: DEALER_VALIDATOR_MNEMONIC or DEALER_VALIDATOR_PRIVKEY_HEX");
  }

  const cosmosRpcUrl = envStr("DEALER_COSMOS_RPC_URL", "http://127.0.0.1:26657");
  const cosmosLcdUrl = envStr("DEALER_COSMOS_LCD_URL", "http://127.0.0.1:1317");
  requireHttpUrl("DEALER_COSMOS_RPC_URL", cosmosRpcUrl);
  requireHttpUrl("DEALER_COSMOS_LCD_URL", cosmosLcdUrl);

  const pollIntervalMs = envInt("DEALER_POLL_INTERVAL_MS", 2000);
  if (pollIntervalMs < 250) {
    throw new Error("DEALER_POLL_INTERVAL_MS must be >= 250");
  }

  const committeeSize = envInt("DEALER_COMMITTEE_SIZE", 3);
  const threshold = envInt("DEALER_THRESHOLD", 3);
  if (committeeSize < 1) throw new Error("DEALER_COMMITTEE_SIZE must be >= 1");
  if (threshold < 1) throw new Error("DEALER_THRESHOLD must be >= 1");
  if (threshold > committeeSize) throw new Error("DEALER_THRESHOLD must be <= DEALER_COMMITTEE_SIZE");

  const shuffleRounds = envInt("DEALER_SHUFFLE_ROUNDS", 26);
  if (shuffleRounds < 1) throw new Error("DEALER_SHUFFLE_ROUNDS must be >= 1");

  const statePassphrase = envStr("DEALER_STATE_PASSPHRASE", "");
  if (isProductionEnv()) {
    if (!statePassphrase) {
      throw new Error("DEALER_STATE_PASSPHRASE is required when NODE_ENV=production");
    }
    if (statePassphrase.length < 16) {
      throw new Error("DEALER_STATE_PASSPHRASE must be at least 16 characters in production");
    }
  }

  return {
    validatorAddress,
    mnemonic: mnemonic || undefined,
    privkeyHex: privkeyHex || undefined,
    cosmosRpcUrl,
    cosmosLcdUrl,
    bech32Prefix,
    gasPrice: envStr("DEALER_GAS_PRICE", "0uocp"),
    stateDir: envStr("DEALER_STATE_DIR", `${process.env.HOME ?? "/tmp"}/.ocp-dealer`),
    statePassphrase,
    autoBeginEpoch: envBool("DEALER_AUTO_BEGIN_EPOCH", true),
    autoInitHand: envBool("DEALER_AUTO_INIT_HAND", true),
    autoFinalize: envBool("DEALER_AUTO_FINALIZE", true),
    pollIntervalMs,
    committeeSize,
    threshold,
    shuffleRounds,
  };
}

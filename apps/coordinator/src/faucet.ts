import type { FaucetConfig } from "./config.js";
import {
  walletFromMnemonic,
  connectOcpCosmosSigningClient,
} from "@onchainpoker/ocp-sdk/cosmos";

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) chk ^= GEN[i]!;
    }
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}

export function decodeBech32Prefix(address: string): string | null {
  if (typeof address !== "string" || address.length < 8 || address.length > 90) return null;
  let hasLower = false;
  let hasUpper = false;
  for (let i = 0; i < address.length; i++) {
    const c = address.charCodeAt(i);
    if (c < 33 || c > 126) return null;
    if (c >= 97 && c <= 122) hasLower = true;
    else if (c >= 65 && c <= 90) hasUpper = true;
  }
  if (hasLower && hasUpper) return null;
  const addr = address.toLowerCase();
  const sep = addr.lastIndexOf("1");
  if (sep < 1 || sep + 7 > addr.length) return null;
  const hrp = addr.slice(0, sep);
  const data: number[] = [];
  for (let i = sep + 1; i < addr.length; i++) {
    const idx = BECH32_CHARSET.indexOf(addr[i]!);
    if (idx === -1) return null;
    data.push(idx);
  }
  if (bech32Polymod(bech32HrpExpand(hrp).concat(data)) !== 1) return null;
  return hrp;
}

export type FaucetStatus = {
  enabled: boolean;
  address: string;
  amount: string;
  denom: string;
  cooldownSecs: number;
};

export type FaucetDripResult = {
  txHash: string;
  amount: string;
  denom: string;
};

export class FaucetService {
  private config: FaucetConfig;
  private addressCooldowns = new Map<string, number>();
  private ipCooldowns = new Map<string, number>();
  private signing: Awaited<ReturnType<typeof connectOcpCosmosSigningClient>> | null = null;
  private busy = false;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: FaucetConfig) {
    this.config = config;
    this.pruneTimer = setInterval(() => this.pruneCooldowns(), 60_000);
    this.pruneTimer.unref?.();
  }

  async init(): Promise<void> {
    if (!this.config.mnemonic) throw new Error("faucet mnemonic not configured");
    const wallet = await walletFromMnemonic({
      mnemonic: this.config.mnemonic,
      prefix: this.config.bech32Prefix,
    });
    this.signing = await connectOcpCosmosSigningClient({
      rpcUrl: this.config.rpcUrl,
      signer: wallet,
      gasPrice: this.config.gasPrice,
      lcdUrl: this.config.lcdUrl,
    });
    console.log(`[faucet] initialized — address: ${this.signing.address}, drip: ${this.config.amount}${this.config.denom}`);
  }

  getStatus(): FaucetStatus {
    return {
      enabled: this.config.enabled,
      address: this.signing?.address ?? "",
      amount: this.config.amount,
      denom: this.config.denom,
      cooldownSecs: Math.ceil(this.config.cooldownMs / 1000),
    };
  }

  async drip(address: string, clientIp: string): Promise<FaucetDripResult> {
    if (!this.signing) throw new Error("faucet not initialized");

    const now = Date.now();

    // Per-IP spam cooldown applied to every entered request (including bogus addresses) to
    // prevent attackers from hammering the faucet with malformed inputs that bypass downstream gates.
    const spamIpCooldownMs = Math.min(this.config.ipCooldownMs, 60_000);
    const ipExpiry = this.ipCooldowns.get(clientIp);
    if (ipExpiry && now < ipExpiry) {
      const waitSecs = Math.ceil((ipExpiry - now) / 1000);
      const err = new Error(`IP rate limited — try again in ${waitSecs}s`);
      (err as any).status = 429;
      (err as any).retryAfter = waitSecs;
      throw err;
    }
    this.ipCooldowns.set(clientIp, now + spamIpCooldownMs);

    const decodedPrefix = decodeBech32Prefix(address);
    if (decodedPrefix !== this.config.bech32Prefix) {
      const error = new Error("invalid address");
      (error as any).status = 400;
      throw error;
    }

    // Address cooldown
    const addrExpiry = this.addressCooldowns.get(address);
    if (addrExpiry && now < addrExpiry) {
      const waitSecs = Math.ceil((addrExpiry - now) / 1000);
      const err = new Error(`address rate limited — try again in ${waitSecs}s`);
      (err as any).status = 429;
      (err as any).retryAfter = waitSecs;
      throw err;
    }

    // Mutex to prevent concurrent signing (sequence number conflicts)
    if (this.busy) {
      const err = new Error("faucet is busy — try again shortly");
      (err as any).status = 429;
      (err as any).retryAfter = 5;
      throw err;
    }

    this.busy = true;
    try {
      const msg = {
        typeUrl: "/cosmos.bank.v1beta1.MsgSend",
        value: {
          fromAddress: this.signing.address,
          toAddress: address,
          amount: [{ denom: this.config.denom, amount: this.config.amount }],
        },
      };

      const result = await this.signing.signAndBroadcastAuto([msg], "ocp faucet drip");

      if (result.code !== 0) {
        throw new Error(`tx failed with code ${result.code}: ${result.rawLog}`);
      }

      // Set cooldowns after success
      this.addressCooldowns.set(address, now + this.config.cooldownMs);
      this.ipCooldowns.set(clientIp, now + this.config.ipCooldownMs);

      console.log(`[faucet] drip ${this.config.amount}${this.config.denom} -> ${address} (tx: ${result.transactionHash})`);

      return {
        txHash: result.transactionHash,
        amount: this.config.amount,
        denom: this.config.denom,
      };
    } finally {
      this.busy = false;
    }
  }

  stop(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  private static MAX_COOLDOWN_ENTRIES = 10_000;

  private pruneCooldowns(): void {
    const now = Date.now();
    for (const [k, v] of this.addressCooldowns) {
      if (now >= v) this.addressCooldowns.delete(k);
    }
    for (const [k, v] of this.ipCooldowns) {
      if (now >= v) this.ipCooldowns.delete(k);
    }
    // Hard cap to prevent memory abuse — evict oldest entries (Map insertion order)
    this.evictExcess(this.addressCooldowns);
    this.evictExcess(this.ipCooldowns);
  }

  private evictExcess(map: Map<string, number>): void {
    if (map.size <= FaucetService.MAX_COOLDOWN_ENTRIES) return;
    const excess = map.size - FaucetService.MAX_COOLDOWN_ENTRIES;
    let removed = 0;
    for (const key of map.keys()) {
      if (removed >= excess) break;
      map.delete(key);
      removed++;
    }
  }
}

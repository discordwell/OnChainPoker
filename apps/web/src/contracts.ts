import { ethers } from "ethers";

export const ENV = {
  expectedChainId: import.meta.env.VITE_CHAIN_ID ? Number(import.meta.env.VITE_CHAIN_ID) : undefined,
  rpcUrl: (import.meta.env.VITE_RPC_URL as string | undefined) ?? undefined,
  tokenAddress: (import.meta.env.VITE_TOKEN_ADDRESS as string | undefined)?.trim() ?? "",
  vaultAddress: (import.meta.env.VITE_VAULT_ADDRESS as string | undefined)?.trim() ?? ""
};

export function isConfigured(): boolean {
  return ethers.isAddress(ENV.tokenAddress) && ethers.isAddress(ENV.vaultAddress);
}

export const OCP_TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function owner() view returns (address)",
  "function mint(address to, uint256 amount)"
] as const;

export const POKER_VAULT_ABI = [
  "function token() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function deposit(uint256 amount)",
  "function withdraw(uint256 amount)",
  "function nonces(address) view returns (uint256)",
  "function handApplied(bytes32) view returns (bool)",
  "function computeResultHash(bytes32 handId, address[] players, int256[] deltas) view returns (bytes32)",
  "function applyHandResultWithSignatures(bytes32 handId, address[] players, int256[] deltas, uint256 deadline, bytes[] signatures)"
] as const;

export function formatAddr(addr: string): string {
  if (!ethers.isAddress(addr)) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}


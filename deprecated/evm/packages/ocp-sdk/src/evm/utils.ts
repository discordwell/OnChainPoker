import { ethers } from "ethers";

export function toBytes32HandId(handId: string): string {
  const trimmed = handId.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed;
  return ethers.keccak256(ethers.toUtf8Bytes(trimmed));
}


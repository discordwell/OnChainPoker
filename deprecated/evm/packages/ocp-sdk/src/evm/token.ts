import { Contract, type ContractRunner } from "ethers";
import { OCP_TOKEN_ABI } from "./abis.js";

export class OcpTokenClient {
  readonly address: string;
  readonly contract: Contract;

  constructor(args: { address: string; runner: ContractRunner }) {
    this.address = args.address;
    this.contract = new Contract(args.address, OCP_TOKEN_ABI, args.runner);
  }

  name(): Promise<string> {
    return this.contract.name();
  }

  symbol(): Promise<string> {
    return this.contract.symbol();
  }

  decimals(): Promise<number> {
    return this.contract.decimals().then((n: any) => Number(n));
  }

  balanceOf(owner: string): Promise<bigint> {
    return this.contract.balanceOf(owner).then((v: any) => BigInt(v));
  }

  allowance(owner: string, spender: string): Promise<bigint> {
    return this.contract.allowance(owner, spender).then((v: any) => BigInt(v));
  }

  approve(spender: string, amount: bigint): Promise<any> {
    return this.contract.approve(spender, amount);
  }

  owner(): Promise<string> {
    return this.contract.owner();
  }

  mint(to: string, amount: bigint): Promise<any> {
    return this.contract.mint(to, amount);
  }
}


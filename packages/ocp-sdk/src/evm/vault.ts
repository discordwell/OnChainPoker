import { Contract, ethers, type ContractRunner, type Signer } from "ethers";
import { POKER_VAULT_ABI } from "./abis.js";
import { toBytes32HandId } from "./utils.js";

const approvalTypes = {
  HandResultApproval: [
    { name: "resultHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
} as const;

export class PokerVaultClient {
  readonly address: string;
  readonly contract: Contract;

  constructor(args: { address: string; runner: ContractRunner }) {
    this.address = args.address;
    this.contract = new Contract(args.address, POKER_VAULT_ABI, args.runner);
  }

  token(): Promise<string> {
    return this.contract.token();
  }

  balanceOf(player: string): Promise<bigint> {
    return this.contract.balanceOf(player).then((v: any) => BigInt(v));
  }

  deposit(amount: bigint): Promise<any> {
    return this.contract.deposit(amount);
  }

  withdraw(amount: bigint): Promise<any> {
    return this.contract.withdraw(amount);
  }

  nonces(player: string): Promise<bigint> {
    return this.contract.nonces(player).then((v: any) => BigInt(v));
  }

  computeResultHash(args: { handId: string; players: string[]; deltas: bigint[] }): Promise<string> {
    const handId32 = toBytes32HandId(args.handId);
    return this.contract.computeResultHash(handId32, args.players, args.deltas);
  }

  async signHandResultApproval(args: {
    signer: Signer;
    handId: string;
    players: string[];
    deltas: bigint[];
    deadline: bigint;
    chainId?: bigint;
  }): Promise<{ resultHash: string; nonce: bigint; signature: string }> {
    const { signer, handId, players, deltas, deadline } = args;

    const resultHash = await this.computeResultHash({ handId, players, deltas });
    const addr = await signer.getAddress();
    const nonce = await this.nonces(addr);

    const chainId =
      args.chainId ??
      (await signer.provider?.getNetwork().then((n) => n.chainId).catch(() => undefined)) ??
      0n;

    const signature = await (signer as any).signTypedData(
      { name: "PokerVault", version: "1", chainId, verifyingContract: this.address },
      approvalTypes,
      { resultHash, nonce, deadline }
    );

    return { resultHash, nonce, signature };
  }

  applyHandResultWithSignatures(args: {
    handId: string;
    players: string[];
    deltas: bigint[];
    deadline: bigint;
    signatures: string[];
  }): Promise<any> {
    const handId32 = toBytes32HandId(args.handId);
    return this.contract.applyHandResultWithSignatures(handId32, args.players, args.deltas, args.deadline, args.signatures);
  }

  onDeposit(listener: (args: { player: string; amount: bigint; log: ethers.EventLog }) => void): () => void {
    const handler = (player: string, amount: any, log: ethers.EventLog) => {
      listener({ player, amount: BigInt(amount), log });
    };
    this.contract.on("Deposit", handler);
    return () => this.contract.off("Deposit", handler);
  }

  onWithdraw(listener: (args: { player: string; amount: bigint; log: ethers.EventLog }) => void): () => void {
    const handler = (player: string, amount: any, log: ethers.EventLog) => {
      listener({ player, amount: BigInt(amount), log });
    };
    this.contract.on("Withdraw", handler);
    return () => this.contract.off("Withdraw", handler);
  }

  onHandResultApplied(
    listener: (args: { handId: string; resultHash: string; submitter: string; players: string[]; deltas: bigint[]; log: ethers.EventLog }) => void
  ): () => void {
    const handler = (handId: string, resultHash: string, submitter: string, players: string[], deltas: any[], log: ethers.EventLog) => {
      listener({ handId, resultHash, submitter, players, deltas: deltas.map((d) => BigInt(d)), log });
    };
    this.contract.on("HandResultApplied", handler);
    return () => this.contract.off("HandResultApplied", handler);
  }
}


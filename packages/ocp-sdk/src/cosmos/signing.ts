import type { EncodeObject, OfflineSigner, Registry } from "@cosmjs/proto-signing";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import type { DeliverTxResponse, SigningStargateClientOptions } from "@cosmjs/stargate";
import { calculateFee, GasPrice, SigningStargateClient } from "@cosmjs/stargate";

export type OcpCosmosSigningClient = {
  address: string;
  client: SigningStargateClient;
  signAndBroadcastAuto: (msgs: readonly EncodeObject[], memo?: string) => Promise<DeliverTxResponse>;
};

export async function walletFromMnemonic(args: { mnemonic: string; prefix: string }): Promise<DirectSecp256k1HdWallet> {
  return DirectSecp256k1HdWallet.fromMnemonic(args.mnemonic, { prefix: args.prefix });
}

export async function walletGenerate(args: { prefix: string; mnemonicLength?: 12 | 15 | 18 | 21 | 24 }): Promise<DirectSecp256k1HdWallet> {
  return DirectSecp256k1HdWallet.generate(args.mnemonicLength ?? 24, { prefix: args.prefix });
}

export async function connectOcpCosmosSigningClient(args: {
  rpcUrl: string;
  signer: OfflineSigner;
  signerAddress?: string;
  gasPrice: string;
  registry?: Registry;
  stargate?: Omit<SigningStargateClientOptions, "registry">;
  gasMultiplier?: number;
}): Promise<OcpCosmosSigningClient> {
  const accounts = await args.signer.getAccounts();
  if (accounts.length === 0) throw new Error("cosmos signer has no accounts");

  const address = (args.signerAddress ?? accounts[0]!.address).trim();
  if (!address) throw new Error("empty signer address");

  const gasPrice = GasPrice.fromString(args.gasPrice);
  const client = await SigningStargateClient.connectWithSigner(args.rpcUrl, args.signer, {
    gasPrice,
    registry: args.registry,
    ...(args.stargate ?? {})
  });

  const gasMultiplier = args.gasMultiplier ?? 1.3;

  async function signAndBroadcastAuto(msgs: readonly EncodeObject[], memo = ""): Promise<DeliverTxResponse> {
    const gasUsed = await client.simulate(address, msgs, memo);
    const gasLimit = Math.max(200_000, Math.ceil(gasUsed * gasMultiplier));
    const fee = calculateFee(gasLimit, gasPrice);
    return client.signAndBroadcast(address, msgs, fee, memo);
  }

  return { address, client, signAndBroadcastAuto };
}

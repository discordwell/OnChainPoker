import { network } from "hardhat";

import { ethers } from "ethers";
import { OcpTokenClient, PokerVaultClient } from "@onchainpoker/ocp-sdk/evm";

const DEFAULT_MNEMONIC = "test test test test test test test test test test test junk";
const DEFAULT_PATH = "m/44'/60'/0'/0";

async function main() {
  const connection = await network.connect();
  const { ethers: hhEthers } = connection;

  const signers = await hhEthers.getSigners().catch(() => []);
  const provider = hhEthers.provider;

  const [owner, alice, bob] =
    signers.length >= 3
      ? signers
      : [
          ethers.HDNodeWallet.fromPhrase(DEFAULT_MNEMONIC, undefined, `${DEFAULT_PATH}/0`).connect(provider),
          ethers.HDNodeWallet.fromPhrase(DEFAULT_MNEMONIC, undefined, `${DEFAULT_PATH}/1`).connect(provider),
          ethers.HDNodeWallet.fromPhrase(DEFAULT_MNEMONIC, undefined, `${DEFAULT_PATH}/2`).connect(provider)
        ];

  const Token = await hhEthers.getContractFactory("OCPToken", owner);
  const token = await Token.deploy(await owner.getAddress(), hhEthers.parseEther("1000000"));
  await token.waitForDeployment();

  const Vault = await hhEthers.getContractFactory("PokerVault", owner);
  const vault = await Vault.deploy(await owner.getAddress(), await token.getAddress(), 3600);
  await vault.waitForDeployment();

  const tokenAddr = await token.getAddress();
  const vaultAddr = await vault.getAddress();

  // eslint-disable-next-line no-console
  console.log("token:", tokenAddr);
  // eslint-disable-next-line no-console
  console.log("vault:", vaultAddr);

  const tokenOwner = new OcpTokenClient({ address: tokenAddr, runner: owner });
  const tokenAlice = new OcpTokenClient({ address: tokenAddr, runner: alice });
  const tokenBob = new OcpTokenClient({ address: tokenAddr, runner: bob });

  const vaultOwner = new PokerVaultClient({ address: vaultAddr, runner: owner });
  const vaultAlice = new PokerVaultClient({ address: vaultAddr, runner: alice });
  const vaultBob = new PokerVaultClient({ address: vaultAddr, runner: bob });

  const offDeposit = vaultOwner.onDeposit(({ player, amount }) => {
    // eslint-disable-next-line no-console
    console.log("Deposit", player, amount.toString());
  });
  const offApplied = vaultOwner.onHandResultApplied(({ handId, resultHash, submitter }) => {
    // eslint-disable-next-line no-console
    console.log("HandResultApplied", { handId, resultHash, submitter });
  });

  const aliceAddr = await alice.getAddress();
  const bobAddr = await bob.getAddress();

  await (await tokenOwner.mint(aliceAddr, hhEthers.parseEther("100"))).wait();
  await (await tokenOwner.mint(bobAddr, hhEthers.parseEther("100"))).wait();

  await (await tokenAlice.approve(vaultAddr, hhEthers.parseEther("50"))).wait();
  await (await tokenBob.approve(vaultAddr, hhEthers.parseEther("50"))).wait();

  await (await vaultAlice.deposit(hhEthers.parseEther("50"))).wait();
  await (await vaultBob.deposit(hhEthers.parseEther("50"))).wait();

  const handId = "hand-1";
  const players = [aliceAddr, bobAddr];
  const deltas = [hhEthers.parseEther("10"), -hhEthers.parseEther("10")];

  const latestBlock = await provider.getBlock("latest");
  const deadline = BigInt((latestBlock?.timestamp ?? 0) + 3600);

  const sigAlice = await vaultOwner.signHandResultApproval({
    signer: alice,
    handId,
    players,
    deltas,
    deadline
  });
  const sigBob = await vaultOwner.signHandResultApproval({
    signer: bob,
    handId,
    players,
    deltas,
    deadline
  });

  await (
    await vaultOwner.applyHandResultWithSignatures({
      handId,
      players,
      deltas,
      deadline,
      signatures: [sigAlice.signature, sigBob.signature]
    })
  ).wait();

  // eslint-disable-next-line no-console
  console.log("vault balances", {
    alice: (await vaultOwner.balanceOf(aliceAddr)).toString(),
    bob: (await vaultOwner.balanceOf(bobAddr)).toString()
  });

  await (await vaultAlice.requestWithdraw(hhEthers.parseEther("60"))).wait();
  await (await vaultBob.requestWithdraw(hhEthers.parseEther("40"))).wait();

  const withdrawDelay = await vaultOwner.withdrawDelay();
  await provider.send("evm_increaseTime", [Number(withdrawDelay)]);
  await provider.send("evm_mine", []);

  await (await vaultAlice.executeWithdraw()).wait();
  await (await vaultBob.executeWithdraw()).wait();

  offDeposit();
  offApplied();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

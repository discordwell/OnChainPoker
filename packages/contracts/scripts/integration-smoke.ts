import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { network } from "hardhat";

const { ethers } = await network.connect();

const approvalTypes = {
  HandResultApproval: [
    { name: "resultHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
} as const;

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (e: any) {
    if (e?.code === "ENOENT") return false;
    throw e;
  }
}

async function loadDeploymentJson(): Promise<{
  chainId: string;
  deployer: string;
  token: string;
  vault: string;
}> {
  if (process.env.DEPLOYMENT_PATH) {
    return JSON.parse(await readFile(process.env.DEPLOYMENT_PATH, "utf8"));
  }

  const chain = await ethers.provider.getNetwork();
  const chainId = chain.chainId.toString();

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const deploymentsDir = resolve(__dirname, "../../../deployments");

  const candidates = [resolve(deploymentsDir, `localhost-${chainId}.json`), resolve(deploymentsDir, `default-${chainId}.json`)];
  for (const p of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await fileExists(p)) return JSON.parse(await readFile(p, "utf8"));
  }

  throw new Error(`No deployment JSON found for chainId=${chainId}. Run deploy first.`);
}

async function signHandResultApproval(params: {
  signer: any;
  vaultAddress: string;
  chainId: bigint;
  resultHash: string;
  nonce: bigint;
  deadline: bigint;
}) {
  const { signer, vaultAddress, chainId, resultHash, nonce, deadline } = params;
  return signer.signTypedData(
    { name: "PokerVault", version: "1", chainId, verifyingContract: vaultAddress },
    approvalTypes,
    { resultHash, nonce, deadline }
  );
}

const deployment = await loadDeploymentJson();
assert.ok(deployment.token, "deployment.token missing");
assert.ok(deployment.vault, "deployment.vault missing");

const token = await ethers.getContractAt("OCPToken", deployment.token);
const vault = await ethers.getContractAt("PokerVault", deployment.vault);

const [owner, alice, bob] = await ethers.getSigners();

await (await token.mint(alice.address, ethers.parseEther("100"))).wait();
await (await token.mint(bob.address, ethers.parseEther("100"))).wait();

await (await token.connect(alice).approve(await vault.getAddress(), ethers.parseEther("50"))).wait();
await (await token.connect(bob).approve(await vault.getAddress(), ethers.parseEther("50"))).wait();

await (await vault.connect(alice).deposit(ethers.parseEther("50"))).wait();
await (await vault.connect(bob).deposit(ethers.parseEther("50"))).wait();

assert.equal(await vault.balanceOf(alice.address), ethers.parseEther("50"));
assert.equal(await vault.balanceOf(bob.address), ethers.parseEther("50"));

const { chainId } = await ethers.provider.getNetwork();
const handId = ethers.keccak256(ethers.toUtf8Bytes("hand-1"));
const players = [alice.address, bob.address];
const deltas = [ethers.parseEther("10"), -ethers.parseEther("10")];

const latestBlock = await ethers.provider.getBlock("latest");
const deadline = BigInt((latestBlock?.timestamp ?? 0) + 3600);

const resultHash = await vault.computeResultHash(handId, players, deltas);
const vaultAddress = await vault.getAddress();

const sigAlice = await signHandResultApproval({
  signer: alice,
  vaultAddress,
  chainId,
  resultHash,
  nonce: await vault.nonces(alice.address),
  deadline
});
const sigBob = await signHandResultApproval({
  signer: bob,
  vaultAddress,
  chainId,
  resultHash,
  nonce: await vault.nonces(bob.address),
  deadline
});

await (await vault.connect(owner).applyHandResultWithSignatures(handId, players, deltas, deadline, [sigAlice, sigBob])).wait();

assert.equal(await vault.balanceOf(alice.address), ethers.parseEther("60"));
assert.equal(await vault.balanceOf(bob.address), ethers.parseEther("40"));

const withdrawDelay = await vault.withdrawDelay();
if (withdrawDelay === 0n) {
  await (await vault.connect(alice).withdraw(ethers.parseEther("60"))).wait();
  await (await vault.connect(bob).withdraw(ethers.parseEther("40"))).wait();
} else {
  await (await vault.connect(alice).requestWithdraw(ethers.parseEther("60"))).wait();
  await (await vault.connect(bob).requestWithdraw(ethers.parseEther("40"))).wait();

  // Local-only convenience: try to fast-forward time. On real networks, execute the withdraw later.
  try {
    await ethers.provider.send("evm_increaseTime", [Number(withdrawDelay)]);
    await ethers.provider.send("evm_mine", []);
  } catch {
    // eslint-disable-next-line no-console
    console.log(
      `Withdraw requests submitted. withdrawDelay=${withdrawDelay.toString()}s; unable to time-travel on this network, so executeWithdraw() later.`
    );
    process.exit(0);
  }

  await (await vault.connect(alice).executeWithdraw()).wait();
  await (await vault.connect(bob).executeWithdraw()).wait();
}

assert.equal(await token.balanceOf(alice.address), ethers.parseEther("110"));
assert.equal(await token.balanceOf(bob.address), ethers.parseEther("90"));

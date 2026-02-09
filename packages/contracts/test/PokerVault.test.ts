import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();

const approvalTypes = {
  HandResultApproval: [
    { name: "resultHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
} as const;

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

describe("PokerVault", () => {
  it("deposit -> applyHandResultWithSignatures -> withdraw", async () => {
    const [owner, alice, bob] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("OCPToken");
    const token = await Token.deploy(owner.address, ethers.parseEther("1000000"));
    await token.waitForDeployment();

    const Vault = await ethers.getContractFactory("PokerVault");
    const vault = await Vault.deploy(owner.address, await token.getAddress());
    await vault.waitForDeployment();

    await token.mint(alice.address, ethers.parseEther("100"));
    await token.mint(bob.address, ethers.parseEther("100"));

    await token.connect(alice).approve(await vault.getAddress(), ethers.parseEther("50"));
    await token.connect(bob).approve(await vault.getAddress(), ethers.parseEther("50"));

    await vault.connect(alice).deposit(ethers.parseEther("50"));
    await vault.connect(bob).deposit(ethers.parseEther("50"));

    expect(await vault.balanceOf(alice.address)).to.equal(ethers.parseEther("50"));
    expect(await vault.balanceOf(bob.address)).to.equal(ethers.parseEther("50"));

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

    await vault
      .connect(owner)
      .applyHandResultWithSignatures(handId, players, deltas, deadline, [sigAlice, sigBob]);

    expect(await vault.balanceOf(alice.address)).to.equal(ethers.parseEther("60"));
    expect(await vault.balanceOf(bob.address)).to.equal(ethers.parseEther("40"));

    await expect(
      vault
        .connect(owner)
        .applyHandResultWithSignatures(handId, players, deltas, deadline, [sigAlice, sigBob])
    )
      .to.be.revertedWithCustomError(vault, "HandAlreadyApplied")
      .withArgs(handId);

    await vault.connect(alice).withdraw(ethers.parseEther("60"));
    await vault.connect(bob).withdraw(ethers.parseEther("40"));

    expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("110"));
    expect(await token.balanceOf(bob.address)).to.equal(ethers.parseEther("90"));
  });

  it("reverts when deltas don't sum to zero", async () => {
    const [owner, alice, bob] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("OCPToken");
    const token = await Token.deploy(owner.address, ethers.parseEther("1000000"));
    await token.waitForDeployment();

    const Vault = await ethers.getContractFactory("PokerVault");
    const vault = await Vault.deploy(owner.address, await token.getAddress());
    await vault.waitForDeployment();

    await token.mint(alice.address, ethers.parseEther("10"));
    await token.connect(alice).approve(await vault.getAddress(), ethers.parseEther("10"));
    await vault.connect(alice).deposit(ethers.parseEther("10"));

    const { chainId } = await ethers.provider.getNetwork();
    const handId = ethers.keccak256(ethers.toUtf8Bytes("hand-nonzero-sum"));
    const players = [alice.address, bob.address];
    const deltas = [ethers.parseEther("1"), ethers.parseEther("1")];

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

    await expect(
      vault
        .connect(owner)
        .applyHandResultWithSignatures(handId, players, deltas, deadline, [sigAlice, sigBob])
    ).to.be.revertedWithCustomError(vault, "NonZeroSum");
  });

  it("reverts when a delta would make a balance negative", async () => {
    const [owner, alice] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("OCPToken");
    const token = await Token.deploy(owner.address, ethers.parseEther("1000000"));
    await token.waitForDeployment();

    const Vault = await ethers.getContractFactory("PokerVault");
    const vault = await Vault.deploy(owner.address, await token.getAddress());
    await vault.waitForDeployment();

    await token.mint(alice.address, ethers.parseEther("5"));
    await token.connect(alice).approve(await vault.getAddress(), ethers.parseEther("5"));
    await vault.connect(alice).deposit(ethers.parseEther("5"));

    const { chainId } = await ethers.provider.getNetwork();
    const handId = ethers.keccak256(ethers.toUtf8Bytes("hand-negative"));
    const players = [alice.address];
    const deltas = [-ethers.parseEther("6")];

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

    await expect(
      vault.connect(owner).applyHandResultWithSignatures(handId, players, deltas, deadline, [sigAlice])
    ).to.be.revertedWithCustomError(vault, "InsufficientBalance");
  });

  it("reverts when players list is empty (prevents handId griefing)", async () => {
    const [owner] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("OCPToken");
    const token = await Token.deploy(owner.address, ethers.parseEther("1000000"));
    await token.waitForDeployment();

    const Vault = await ethers.getContractFactory("PokerVault");
    const vault = await Vault.deploy(owner.address, await token.getAddress());
    await vault.waitForDeployment();

    const handId = ethers.keccak256(ethers.toUtf8Bytes("hand-empty"));
    const players: string[] = [];
    const deltas: bigint[] = [];
    const signatures: string[] = [];

    const latestBlock = await ethers.provider.getBlock("latest");
    const deadline = BigInt((latestBlock?.timestamp ?? 0) + 3600);

    await expect(
      vault.connect(owner).applyHandResultWithSignatures(handId, players, deltas, deadline, signatures)
    ).to.be.revertedWithCustomError(vault, "EmptyPlayers");
  });

  it("credits deposit by tokens actually received (fee-on-transfer safe)", async () => {
    const [owner, alice] = await ethers.getSigners();

    const FeeToken = await ethers.getContractFactory("MockFeeToken");
    const token = await FeeToken.deploy(1000); // 10% fee
    await token.waitForDeployment();

    const Vault = await ethers.getContractFactory("PokerVault");
    const vault = await Vault.deploy(owner.address, await token.getAddress());
    await vault.waitForDeployment();

    await token.mint(alice.address, ethers.parseEther("100"));
    await token.connect(alice).approve(await vault.getAddress(), ethers.parseEther("100"));

    await vault.connect(alice).deposit(ethers.parseEther("100"));

    // Only 90 tokens arrive; vault must credit 90 to avoid insolvency.
    expect(await token.balanceOf(await vault.getAddress())).to.equal(ethers.parseEther("90"));
    expect(await vault.balanceOf(alice.address)).to.equal(ethers.parseEther("90"));

    await vault.connect(alice).withdraw(ethers.parseEther("90"));
    expect(await vault.balanceOf(alice.address)).to.equal(0n);
    expect(await token.balanceOf(await vault.getAddress())).to.equal(0n);
  });
});

import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();

describe("PokerVault", () => {
  it("deposit -> applyHandResult -> withdraw", async () => {
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

    await vault
      .connect(owner)
      .applyHandResult(
        [alice.address, bob.address],
        [ethers.parseEther("10"), -ethers.parseEther("10")]
      );

    expect(await vault.balanceOf(alice.address)).to.equal(ethers.parseEther("60"));
    expect(await vault.balanceOf(bob.address)).to.equal(ethers.parseEther("40"));

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

    await expect(
      vault
        .connect(owner)
        .applyHandResult(
          [alice.address, bob.address],
          [ethers.parseEther("1"), ethers.parseEther("1")]
        )
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

    await expect(
      vault.connect(owner).applyHandResult([alice.address], [-ethers.parseEther("6")])
    ).to.be.revertedWithCustomError(vault, "InsufficientBalance");
  });
});

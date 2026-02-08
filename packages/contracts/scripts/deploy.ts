import { network } from "hardhat";

async function main() {
  const connection = await network.connect();
  const { ethers } = connection;

  const [deployer] = await ethers.getSigners();

  const initialSupply =
    process.env.INITIAL_SUPPLY != null
      ? ethers.parseEther(process.env.INITIAL_SUPPLY)
      : ethers.parseEther("1000000");

  const Token = await ethers.getContractFactory("OCPToken");
  const token = await Token.deploy(deployer.address, initialSupply);
  await token.waitForDeployment();

  const Vault = await ethers.getContractFactory("PokerVault");
  const vault = await Vault.deploy(deployer.address, await token.getAddress());
  await vault.waitForDeployment();

  const chain = await ethers.provider.getNetwork();

  const out = {
    network: connection.networkName,
    chainId: chain.chainId.toString(),
    deployer: deployer.address,
    token: await token.getAddress(),
    vault: await vault.getAddress()
  };

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

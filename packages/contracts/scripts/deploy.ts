import { network } from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  const connection = await network.connect();
  const { ethers } = connection;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

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

  // Also persist for easy local/dev reuse.
  const deploymentsDir = resolve(__dirname, "../../../deployments");
  await mkdir(deploymentsDir, { recursive: true });
  await writeFile(resolve(deploymentsDir, `${out.network}-${out.chainId}.json`), `${JSON.stringify(out, null, 2)}\n`, "utf8");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

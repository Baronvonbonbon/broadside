#!/usr/bin/env node
// Deploy a built artifact's PolkaVM blob.
//
//   node contracts/scripts/deploy.mjs BroadsideSeam --rpc <url> [--evm]
//
// Key comes from DEPLOYER_KEY in the environment. `--evm` deploys the EVM blob
// instead, which is only useful for establishing that a failure is the PolkaVM
// path's fault rather than the contract's.
//
// The chain id is read off the chain and written into the address book rather
// than configured. Paseo has moved once already (the relay was replaced on
// 2026-07-02) and the host now serves "Paseo Next v2 Hub", so an endpoint's
// identity is something to discover and record, not something to assert.

import fs from "node:fs";
import path from "node:path";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";

const HERE = import.meta.dirname;
const CONTRACTS = path.resolve(HERE, "..");
const ROOT = path.resolve(CONTRACTS, "..");
const BOOK = path.join(CONTRACTS, "deployed-addresses.json");

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
};
const has = (flag) => process.argv.includes(flag);

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(2);
}

const name = process.argv[2];
if (!name || name.startsWith("--")) fail("Usage: deploy.mjs <ContractName> --rpc <url>");

const rpc = arg("--rpc", process.env.BROADSIDE_RPC);
if (!rpc) fail("No RPC. Pass --rpc <url> or set BROADSIDE_RPC.");

const key = process.env.DEPLOYER_KEY;
if (!key) fail("No DEPLOYER_KEY in the environment.");

const artifactPath = path.join(CONTRACTS, "out", `${name}.json`);
if (!fs.existsSync(artifactPath)) fail(`No artifact for ${name}. Run \`pnpm --filter @broadside/contracts build\` first.`);
const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

const target = has("--evm") ? "evm" : "pvm";
const { bytecode, bytes } = artifact[target];

const provider = new JsonRpcProvider(rpc);
const wallet = new Wallet(key, provider);

const net = await provider.getNetwork();
const balance = await provider.getBalance(wallet.address);

console.log(`rpc        ${rpc}`);
console.log(`chainId    ${net.chainId}`);
console.log(`deployer   ${wallet.address}`);
console.log(`balance    ${balance} planck`);
console.log(`target     ${target.toUpperCase()}  (${bytes.toLocaleString()} bytes)`);
console.log(`solc       ${artifact.solc}`);
console.log(`resolc     ${artifact.resolc}\n`);

if (balance === 0n) fail("Deployer has no balance. Fund it before deploying.");

const factory = new ContractFactory(artifact.abi, bytecode, wallet);
console.log("deploying…");
const contract = await factory.deploy();
const tx = contract.deploymentTransaction();
console.log(`tx         ${tx.hash}`);
await contract.waitForDeployment();
const address = await contract.getAddress();
console.log(`address    ${address}`);

// Confirm the deployed contract agrees with the chain about which chain it is
// on. A mismatch means every EIP-712 signature bound to this domain would be
// rejected while looking perfectly well-formed — the exact failure this whole
// probe exists to catch, so catching it at deploy time is cheaper.
if (artifact.abi.some((f) => f.name === "chainId")) {
  const onChain = await contract.chainId();
  if (onChain !== net.chainId) {
    fail(`Contract reports chainId ${onChain} but the RPC reports ${net.chainId}. Do not use this deployment.`);
  }
  console.log(`chainId ✓  contract and RPC agree (${onChain})`);
}

const book = fs.existsSync(BOOK) ? JSON.parse(fs.readFileSync(BOOK, "utf8")) : {};
book[name] = {
  address,
  target,
  chainId: Number(net.chainId),
  rpc,
  bytes,
  solc: artifact.solc,
  resolc: artifact.resolc,
  deployedAt: new Date().toISOString(),
  tx: tx.hash,
};
fs.writeFileSync(BOOK, JSON.stringify(book, null, 2) + "\n");
console.log(`\n✓ ${path.relative(ROOT, BOOK)}`);

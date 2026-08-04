#!/usr/bin/env node
// Prove the seam from Node, against the real deployment.
//
//   node contracts/scripts/verify-seam.mjs [--write]
//
// This is the half of Phase 1's gate 5 that does not need a phone. It answers
// "does a PolkaVM contract accept an off-chain secp256k1 EIP-712 signature" —
// which is the part that could have been false for reasons of the compiler, the
// precompile, or the chain. What it cannot answer is whether the *host* can
// produce such a key and reach such a contract; only `apps/seam` running inside
// the Polkadot App can say that.
//
// `--write` additionally submits `attest` from a *different* account than the
// one that signed. That is not a detail — it is the production relay pattern in
// miniature: the viewer signs and holds no funds, the relay pays the gas, and
// the contract cares only about who signed.
//
// Key comes from DEPLOYER_KEY. Reads need none.

import fs from "node:fs";
import path from "node:path";
import { Interface, JsonRpcProvider, TypedDataEncoder, Wallet, hexlify, randomBytes } from "ethers";

const HERE = import.meta.dirname;
const CONTRACTS = path.resolve(HERE, "..");

const write = process.argv.includes("--write");

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const artifact = JSON.parse(fs.readFileSync(path.join(CONTRACTS, "out", "BroadsideSeam.json"), "utf8"));
const bookPath = path.join(CONTRACTS, "deployed-addresses.json");
if (!fs.existsSync(bookPath)) fail("Not deployed — run contracts/scripts/deploy.mjs first.");
const book = JSON.parse(fs.readFileSync(bookPath, "utf8")).BroadsideSeam;
if (!book) fail("deployed-addresses.json has no BroadsideSeam entry.");

const provider = new JsonRpcProvider(book.rpc);
const iface = new Interface(artifact.abi);

const line = (k, v) => console.log(`  ${k.padEnd(20)} ${v}`);
let failures = 0;
const check = (label, pass, detail = "") => {
  console.log(`  ${pass ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!pass) failures++;
};

console.log(`\nBroadsideSeam @ ${book.address}`);
line("chain", `${book.chainId} via ${book.rpc}`);
line("target", `${book.target.toUpperCase()} (${book.bytes.toLocaleString()} bytes)`);
line("resolc", book.resolc);
console.log();

// ── the deployment is real ───────────────────────────────────────────────────
const code = await provider.getCode(book.address);
const onChainBytes = code.length > 2 ? code.length / 2 - 1 : 0;
check("code is deployed", onChainBytes > 0, `${onChainBytes.toLocaleString()} bytes on chain`);
check(
  "on-chain size matches the artifact",
  onChainBytes === book.bytes,
  onChainBytes === book.bytes ? "" : `artifact says ${book.bytes}`,
);

const reportedChainId = Number(iface.decodeFunctionResult("chainId", await provider.call({ to: book.address, data: iface.encodeFunctionData("chainId", []) }))[0]);
check("contract agrees on chainId", reportedChainId === book.chainId, `contract says ${reportedChainId}`);

// ── the client and the contract hash the domain identically ──────────────────
const domain = { ...artifact.eip712.domain, chainId: book.chainId, verifyingContract: book.address };
const onChainDomain = iface.decodeFunctionResult(
  "domainSeparator",
  await provider.call({ to: book.address, data: iface.encodeFunctionData("domainSeparator", []) }),
)[0];
check(
  "domain separator matches",
  onChainDomain === TypedDataEncoder.hashDomain(domain),
  "a mismatch here makes every signature valid-looking and never matching",
);

// ── ecrecover accepts an off-chain signature ─────────────────────────────────
const viewer = Wallet.createRandom();
const value = { viewer: viewer.address, nonce: BigInt(Date.now()), note: hexlify(randomBytes(32)) };
const signature = await viewer.signTypedData(domain, artifact.eip712.types, value);
const tuple = [value.viewer, value.nonce, value.note];

const onChainDigest = iface.decodeFunctionResult(
  "hashSeam",
  await provider.call({ to: book.address, data: iface.encodeFunctionData("hashSeam", [tuple]) }),
)[0];
check("digest matches", onChainDigest === TypedDataEncoder.hash(domain, artifact.eip712.types, value));

const recovered = iface.decodeFunctionResult(
  "recover",
  await provider.call({ to: book.address, data: iface.encodeFunctionData("recover", [tuple, signature]) }),
)[0];
check(
  "ecrecover returns the signer",
  recovered.toLowerCase() === viewer.address.toLowerCase(),
  `${recovered} — a PolkaVM contract accepting an off-chain EIP-712 signature`,
);

// ── malleability is actually rejected ────────────────────────────────────────
// The guard is only worth having if it fires. Flip `s` to its high twin, which
// is an equally valid signature for the same message, and the contract must
// refuse it rather than treat one authorisation as two.
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const r = signature.slice(0, 66);
const s = BigInt("0x" + signature.slice(66, 130));
const v = parseInt(signature.slice(130, 132), 16);
const malleable = r + (N - s).toString(16).padStart(64, "0") + (v === 27 ? "1c" : "1b");
let rejected = false;
let how = "";
try {
  await provider.call({ to: book.address, data: iface.encodeFunctionData("recover", [tuple, malleable]) });
} catch (e) {
  rejected = true;
  how = /malleable/i.test(JSON.stringify(e.info ?? e.message ?? "")) ? "MalleableSignature" : "reverted";
}
check("high-s twin is rejected", rejected, how);

// ── the same claim, as a transaction someone else pays for ───────────────────
if (write) {
  const key = process.env.DEPLOYER_KEY;
  if (!key) fail("--write needs DEPLOYER_KEY in the environment.");
  const relay = new Wallet(key, provider);
  console.log(`\n  submitting attest from ${relay.address}`);
  console.log(`  signed by             ${viewer.address}  (holds no funds)`);

  const tx = await relay.sendTransaction({ to: book.address, data: iface.encodeFunctionData("attest", [tuple, signature]) });
  const receipt = await tx.wait();
  check("attest included", receipt.status === 1, `block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);

  const stored = iface.decodeFunctionResult(
    "attestationOf",
    await provider.call({ to: book.address, data: iface.encodeFunctionData("attestationOf", [viewer.address]) }),
  );
  check("stored under the signer, not the submitter", stored[1] === value.note && String(stored[0]) === String(value.nonce));
  check("submitter recorded separately", String(stored[3]).toLowerCase() === relay.address.toLowerCase(), String(stored[3]));
  console.log("\n  → the gasless relay pattern works: the viewer signs, the relay pays, the contract credits the viewer.");
}

provider.destroy();
console.log(failures ? `\n✗ ${failures} check(s) failed\n` : `\n✓ all checks passed\n`);
process.exit(failures ? 1 : 0);

// Contract tests that need no chain.
//
// The EIP-712 typehash is a string literal in Solidity and a structured type
// table in JS, and nothing in either language checks that they describe the
// same struct. Get one character wrong — a space after a comma, `uint` for
// `uint256`, fields in the wrong order — and every signature a client produces
// is well-formed, recoverable, and recovers to the wrong address. There is no
// runtime symptom to debug; it just never matches.
//
// So this asserts the two against each other, plus the curve constant that
// makes signatures non-malleable.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { TypedDataEncoder, id, keccak256, toUtf8Bytes } from "ethers";

const HERE = import.meta.dirname;
const SRC = path.resolve(HERE, "..", "src");
const OUT = path.resolve(HERE, "..", "out");

const sol = fs.readFileSync(path.join(SRC, "BroadsideSeam.sol"), "utf8");
const artifactPath = path.join(OUT, "BroadsideSeam.json");
const artifact = fs.existsSync(artifactPath) ? JSON.parse(fs.readFileSync(artifactPath, "utf8")) : null;

/** Pull `keccak256("…")` literals out of the Solidity source. */
function literals() {
  return [...sol.matchAll(/keccak256\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g)].map((m) => m[1]);
}

test("the Seam typehash string matches the JS type table", () => {
  const types = JSON.parse(fs.readFileSync(path.join(SRC, "BroadsideSeam.types.json"), "utf8"));
  // ethers derives the canonical encoding from the structured types — the same
  // derivation a wallet does when it signs. If Solidity's literal differs by so
  // much as a space, the two hashes differ and no signature ever matches.
  const canonical = TypedDataEncoder.from(types.types).encodeType(types.primaryType);
  assert.ok(
    literals().includes(canonical),
    `BroadsideSeam.sol has no keccak256("${canonical}").\n  Found: ${literals().join("\n         ")}`,
  );
});

test("the EIP712Domain typehash is the standard one", () => {
  const standard = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
  assert.ok(literals().includes(standard), "domain typehash literal is missing or non-standard");
});

test("the domain name and version literals agree with the types file", () => {
  const types = JSON.parse(fs.readFileSync(path.join(SRC, "BroadsideSeam.types.json"), "utf8"));
  const found = literals();
  assert.ok(found.includes(types.domain.name), `Solidity has no keccak256("${types.domain.name}")`);
  assert.ok(found.includes(types.domain.version), `Solidity has no keccak256("${types.domain.version}")`);
});

test("HALF_N is exactly half the secp256k1 order", () => {
  // n for secp256k1. An `s` above n/2 has a valid low-`s` twin, so accepting
  // both turns one authorisation into two distinct signatures — which is how a
  // replay guard keyed on the signature bytes gets bypassed.
  const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const m = sol.match(/HALF_N\s*=\s*(0x[0-9a-fA-F]+)/);
  assert.ok(m, "HALF_N constant not found");
  assert.equal(BigInt(m[1]), n / 2n);
});

test("the struct hash formula matches ethers end to end", () => {
  const types = JSON.parse(fs.readFileSync(path.join(SRC, "BroadsideSeam.types.json"), "utf8"));
  const value = {
    viewer: "0x1111111111111111111111111111111111111111",
    nonce: 7n,
    note: "0x" + "ab".repeat(32),
  };
  // abi.encode(TYPEHASH, viewer, nonce, note) — every field is already one
  // word, so the Solidity encoding is a plain concatenation and can be
  // reproduced here without an ABI coder.
  const word = (h) => h.replace(/^0x/, "").padStart(64, "0");
  const manual = keccak256(
    "0x" +
      word(id(TypedDataEncoder.from(types.types).encodeType(types.primaryType))) +
      word(value.viewer.toLowerCase()) +
      word(value.nonce.toString(16)) +
      word(value.note),
  );
  assert.equal(manual, TypedDataEncoder.hashStruct(types.primaryType, types.types, value));
});

test("the built artifact carries what a client needs", { skip: artifact ? false : "run `pnpm build` first" }, () => {
  const fns = artifact.abi.filter((f) => f.type === "function").map((f) => f.name);
  for (const required of ["recover", "attest", "hashSeam", "domainSeparator", "chainId", "attestationOf"]) {
    assert.ok(fns.includes(required), `ABI is missing ${required}`);
  }
  assert.ok(artifact.eip712?.domain?.name, "artifact carries no eip712 block");
  assert.equal(artifact.eip712.domain.name, "BroadsideSeam");
});

test("the PolkaVM blob is real and fits", { skip: artifact ? false : "run `pnpm build` first" }, () => {
  assert.ok(artifact.pvm.bytes > 0, "empty PVM blob");
  assert.ok(
    artifact.pvm.bytes <= 256 * 1024,
    `${artifact.pvm.bytes} bytes exceeds pallet-revive's 256 KiB limit`,
  );
  assert.equal(artifact.pvm.bytecode.length, 2 + artifact.pvm.bytes * 2, "declared size disagrees with the hex");
});

test("the EVM blob is emitted too, so the size gap stays visible", { skip: artifact ? false : "run `pnpm build` first" }, () => {
  assert.ok(artifact.evm.bytes > 0);
  // The whole justification for the port: PolkaVM blobs are much larger, and
  // the ceiling is much larger still.
  assert.ok(artifact.pvm.bytes > artifact.evm.bytes, "expected PVM expansion over EVM");
});

test("no stray non-hash string literal is mistaken for a typehash", () => {
  // Guards the parser above: if someone adds keccak256("something else") the
  // typehash assertions still pass by coincidence, so make the count explicit.
  assert.equal(literals().length, 4, `expected 4 keccak256 literals, found ${literals().length}: ${literals()}`);
});

void toUtf8Bytes;

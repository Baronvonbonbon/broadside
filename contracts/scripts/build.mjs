#!/usr/bin/env node
// Compile contracts/src to both targets and emit one artifact per contract.
//
// Two compilers, one source: solc gives the ABI and an EVM blob, resolc gives
// the PolkaVM blob. Both are emitted because the comparison is the point of
// this migration — the EVM number is what EIP-170's 24,576-byte ceiling
// applies to, the PVM number is what pallet-revive's 256 KiB blob limit
// applies to, and an artifact carrying only one of them cannot show the gap
// that justified the port.
//
//   node contracts/scripts/build.mjs [--src <dir>] [--out <dir>]
//
// Needs tools/solc and tools/resolc — run tools/fetch-toolchain.sh first.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const CONTRACTS = path.resolve(HERE, "..");
const ROOT = path.resolve(CONTRACTS, "..");
const TOOLS = path.join(ROOT, "tools");

// pallet-revive rejects a blob over this with `BlobTooLarge`.
const BLOB_LIMIT = 256 * 1024;
// EIP-170. Not our ceiling any more; reported so the diff stays visible.
const EIP170_LIMIT = 24_576;

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
};

const SRC = path.resolve(arg("--src", path.join(CONTRACTS, "src")));
const OUT = path.resolve(arg("--out", path.join(CONTRACTS, "out")));

// Matches DATUM's settings so a ported contract compiles to comparable output.
// viaIR is on for the same reason it is on there: without it the settlement
// family does not fit its own optimiser budget.
const SOLC_ARGS = ["--optimize", "--optimize-runs", "200", "--via-ir", "--evm-version", "cancun"];

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(2);
}

function tool(name) {
  const p = path.join(TOOLS, name);
  if (!fs.existsSync(p)) fail(`${name} not found at ${path.relative(ROOT, p)}. Run tools/fetch-toolchain.sh.`);
  return p;
}

const solc = tool("solc");
const resolc = tool("resolc");
// resolc shells out to `solc` by that exact name, so tools/ has to be on PATH
// ahead of any system install — otherwise the two targets silently compile
// against different frontend versions.
const env = { ...process.env, PATH: `${TOOLS}:${process.env.PATH}` };

const sources = fs
  .readdirSync(SRC)
  .filter((f) => f.endsWith(".sol"))
  .sort();
if (!sources.length) fail(`No .sol files in ${SRC}`);

fs.mkdirSync(OUT, { recursive: true });

const solcVersion = execFileSync(solc, ["--version"], { encoding: "utf8" }).trim().split("\n").pop().trim();
const resolcVersion = execFileSync(resolc, ["--version"], { encoding: "utf8" }).trim();

console.log(solcVersion);
console.log(resolcVersion);
console.log(`src: ${path.relative(ROOT, SRC)}\n`);

/** solc's combined-json, keyed `<file>:<Contract>`. */
function solcCombined(rel) {
  const raw = execFileSync(
    solc,
    ["--combined-json", "abi,bin", ...SOLC_ARGS, rel],
    { cwd: SRC, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env },
  );
  return JSON.parse(raw).contracts;
}

/** resolc emits `======= file:Contract =======\nBinary:\n<hex>` blocks. */
function resolcBin(rel, name) {
  const stdout = execFileSync(
    resolc,
    ["--bin", "-O", "z", "--evm-version", "cancun", "--base-path", ".", rel],
    { cwd: SRC, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, env },
  );
  const at = stdout.indexOf(`${rel}:${name} =======`);
  if (at === -1) return null;
  const m = stdout.slice(at).match(/Binary:\s*\n([0-9a-fA-F]*)/);
  return m && m[1] ? m[1] : null;
}

const rows = [];

for (const file of sources) {
  const combined = solcCombined(file);
  for (const [key, unit] of Object.entries(combined)) {
    const [, name] = key.split(":");
    // Interfaces and abstract contracts compile to an empty bin. They are not
    // deployable and not a failure — skip rather than report a zero-byte blob.
    if (!unit.bin) continue;

    const pvmHex = resolcBin(file, name);
    if (!pvmHex) fail(`${name}: solc produced a binary but resolc did not. That is a port blocker, not a warning.`);

    const evmBytes = unit.bin.length / 2;
    const pvmBytes = pvmHex.length / 2;

    // A sibling `<Name>.types.json` rides along into the artifact. A client
    // needs the EIP-712 domain and type table exactly as much as it needs the
    // ABI, and shipping them apart is how the two drift.
    const typesPath = path.join(SRC, `${name}.types.json`);
    const eip712 = fs.existsSync(typesPath) ? JSON.parse(fs.readFileSync(typesPath, "utf8")) : undefined;

    fs.writeFileSync(
      path.join(OUT, `${name}.json`),
      JSON.stringify(
        {
          contract: name,
          source: file,
          solc: solcVersion,
          resolc: resolcVersion,
          settings: { optimize: true, runs: 200, viaIR: true, evmVersion: "cancun", resolcOpt: "z" },
          abi: unit.abi,
          ...(eip712 ? { eip712 } : {}),
          pvm: { bytes: pvmBytes, bytecode: `0x${pvmHex}` },
          evm: { bytes: evmBytes, bytecode: `0x${unit.bin}` },
        },
        null,
        2,
      ) + "\n",
    );

    rows.push({ name, evmBytes, pvmBytes });
  }
}

const w = Math.max(...rows.map((r) => r.name.length), 8);
console.log(`${"contract".padEnd(w)}  ${"EVM".padStart(8)}  ${"of 24K".padStart(7)}  ${"PVM".padStart(8)}  ${"of 256K".padStart(8)}`);
console.log("-".repeat(w + 38));
for (const r of rows) {
  const evmPct = ((100 * r.evmBytes) / EIP170_LIMIT).toFixed(1);
  const pvmPct = ((100 * r.pvmBytes) / BLOB_LIMIT).toFixed(1);
  console.log(
    `${r.name.padEnd(w)}  ${String(r.evmBytes).padStart(8)}  ${(evmPct + "%").padStart(7)}  ` +
      `${String(r.pvmBytes).padStart(8)}  ${(pvmPct + "%").padStart(8)}`,
  );
  if (r.pvmBytes > BLOB_LIMIT) fail(`${r.name} is over the ${BLOB_LIMIT}-byte blob limit — pallet-revive will reject it.`);
}

console.log(`\n✓ ${rows.length} artifact(s) → ${path.relative(ROOT, OUT)}/`);

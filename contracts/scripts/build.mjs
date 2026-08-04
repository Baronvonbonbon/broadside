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
// Contracts import OpenZeppelin by package name, so both compilers need a
// node_modules to resolve against. It lives beside src/, not inside it.
const MODULES = path.join(CONTRACTS, "node_modules");

/**
 * Directories solc is permitted to read from.
 *
 * pnpm does not copy dependencies — it symlinks them into a content-addressed
 * store, so `node_modules/@openzeppelin/contracts` is a link and the files
 * actually live under `.pnpm/`. solc resolves the link and then refuses the
 * result as "outside of allowed directories", which reads like a missing file
 * and is not one. Passing the resolved target is the fix.
 */
function realpaths(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    // Scoped packages are a plain directory whose *children* are the symlinks,
    // so `@openzeppelin` resolves to itself and tells us nothing. Descend.
    if (entry.startsWith("@")) {
      out.push(...realpaths(p));
      continue;
    }
    try {
      out.push(fs.realpathSync(p));
    } catch {
      // A broken link is not this script's problem to report.
    }
  }
  return out;
}
const ALLOW = [...new Set([MODULES, ...realpaths(MODULES)])].join(",");

const OUT = path.resolve(arg("--out", path.join(CONTRACTS, "out")));

// Matches DATUM's settings so a ported contract compiles to comparable output.
// viaIR is on for the same reason it is on there: without it the settlement
// family does not fit its own optimiser budget.
const RUNS = arg("--runs", "200");
const SOLC_ARGS = ["--optimize", "--optimize-runs", RUNS, "--via-ir", "--evm-version", "cancun"];

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
    ["--combined-json", "abi,bin", "--base-path", ".", "--include-path", MODULES, "--allow-paths", ALLOW, ...SOLC_ARGS, rel],
    { cwd: SRC, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env },
  );
  return JSON.parse(raw).contracts;
}

/** resolc emits `======= file:Contract =======\nBinary:\n<hex>` blocks. */
function resolcBin(rel, name) {
  const stdout = execFileSync(
    resolc,
    ["--bin", "-O", "z", "--evm-version", "cancun", "--base-path", ".", "--include-path", MODULES, "--allow-paths", ALLOW, rel],
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
    // combined-json carries every compiled unit, dependencies included. Only
    // contracts declared in *this* file are ours to emit — OpenZeppelin's
    // `Panic` is a library solc reports and resolc does not, which reads as a
    // port blocker and is nothing of the kind.
    if (!key.startsWith(`${file}:`)) continue;
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

// The size gate. Committed and diffed, so a contract growing toward the blob
// limit shows up in review rather than at deploy time — and so the day the
// Settlement merge was measured at 138.7% is a line in a diff, not a memory.
const SNAPSHOT = path.join(CONTRACTS, "sizes.json");
fs.writeFileSync(
  SNAPSHOT,
  JSON.stringify(
    {
      _comment: "Generated by contracts/scripts/build.mjs. Commit changes deliberately.",
      solc: solcVersion,
      resolc: resolcVersion,
      blobLimit: BLOB_LIMIT,
      contracts: Object.fromEntries(
        rows.sort((a, b) => b.pvmBytes - a.pvmBytes).map((r) => [
          r.name,
          { pvm: r.pvmBytes, evm: r.evmBytes, pctOfBlobLimit: Number(((100 * r.pvmBytes) / BLOB_LIMIT).toFixed(1)) },
        ]),
      ),
    },
    null,
    2,
  ) + "\n",
);

const tight = rows.filter((r) => r.pvmBytes > 0.7 * BLOB_LIMIT);
if (tight.length) {
  console.log(`\n! over 70% of the blob limit: ${tight.map((r) => r.name).join(", ")}`);
}
console.log(`\n✓ ${rows.length} artifact(s) → ${path.relative(ROOT, OUT)}/`);
console.log(`✓ ${path.relative(ROOT, SNAPSHOT)}`);

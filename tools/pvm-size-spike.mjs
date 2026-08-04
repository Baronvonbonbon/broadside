#!/usr/bin/env node
// Phase-0 spike: measure every alpha-core contract as a PolkaVM blob.
//
// This answers one question and only one: which contracts can be deployed to
// pallet-revive as-is, and which have to lose code before they can be. It reads
// the DATUM sources read-only and writes everything into broadside/.
//
//   node tools/pvm-size-spike.mjs [--src <alpha-core>] [--jobs N]
//
// Adapted from fare/scripts/build-pvm.mjs, with four changes that matter for a
// survey rather than a build:
//
//   1. Compiles *every* non-mock contract instead of a hand-listed deploy set —
//      the point is to find the surprises.
//   2. Never aborts on a failure. A contract that will not compile under resolc
//      is a finding, not an error, and stopping would hide the other 62.
//   3. Reports bytes-per-line next to bytes, so the density figure that sizes
//      the port is measured on DATUM's own code rather than borrowed from fare.
//   4. Runs a worker pool. resolc drives LLVM; serially this is ~20 minutes.
//
// Needs resolc (RESOLC=..., or ./tools/resolc, or on PATH).

import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..");
const OUT_DIR = path.join(ROOT, "artifacts-pvm-spike");
const SNAPSHOT = path.join(ROOT, "pvm-size-spike.json");
const REPORT = path.join(ROOT, "docs", "phase0-pvm-size-report.md");

// pallet-revive rejects a blob over this with `BlobTooLarge`. Contracts also
// get 1 MB of memory for code+data, but the blob ceiling is what binds.
const BLOB_LIMIT = 256 * 1024;

// Headroom below which a contract is "comfortable". Anything above wants a
// deliberate decision during the port rather than a shrug.
const COMFORTABLE_PCT = 70;

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

const SRC = path.resolve(arg("--src", "/home/k/Documents/datum/alpha-core"));
const JOBS = Number(arg("--jobs", Math.min(os.cpus().length, 8)));

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(2);
}

function findResolc() {
  const local = path.join(HERE, "resolc");
  for (const c of [process.env.RESOLC, fs.existsSync(local) ? local : null]) {
    if (c && fs.existsSync(c)) return c;
  }
  try {
    return execFileSync("which", ["resolc"], { encoding: "utf8" }).trim();
  } catch {
    fail(
      "resolc not found.\n" +
        "  Put a release binary at tools/resolc, on PATH, or set RESOLC:\n" +
        "    https://github.com/paritytech/revive/releases",
    );
  }
}

function readCfg(re, fallback) {
  const cfg = fs.readFileSync(path.join(SRC, "hardhat.config.ts"), "utf8");
  const m = cfg.match(re);
  if (!m && fallback === undefined) fail(`Could not read ${re} out of hardhat.config.ts.`);
  return m ? m[1] : fallback;
}

/**
 * Reuse hardhat's cached solc so the EVM and PVM targets cannot drift onto
 * different frontend versions. resolc shells out to `solc` by that exact name,
 * so it needs a directory containing a file literally called "solc".
 */
function findSolcDir(version) {
  const base = path.join(os.homedir(), ".cache", "hardhat-nodejs");
  const hits = [];
  const walk = (dir, depth = 0) => {
    if (depth > 3 || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.startsWith("solc-") && e.name.includes(version)) hits.push(p);
    }
  };
  walk(base);
  if (!hits.length) {
    fail(
      `No cached solc ${version} under ${base}.\n` +
        "  Run `npx hardhat compile` in alpha-core once to populate it.",
    );
  }
  const shim = path.join(OUT_DIR, ".solc-bin");
  fs.mkdirSync(shim, { recursive: true });
  const dest = path.join(shim, "solc");
  fs.copyFileSync(hits[0], dest);
  fs.chmodSync(dest, 0o755);
  return shim;
}

/** Production contracts: contracts/*.sol and contracts/token/*.sol, no mocks. */
function collect() {
  const out = [];
  for (const sub of ["", "token"]) {
    const dir = path.join(SRC, "contracts", sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".sol") || f.startsWith("Mock") || f.includes("Mock")) continue;
      const rel = path.join("contracts", sub, f);
      const abs = path.join(SRC, rel);
      if (!fs.statSync(abs).isFile()) continue;
      const name = f.replace(/\.sol$/, "");
      const src = fs.readFileSync(abs, "utf8");
      out.push({
        name,
        rel,
        lines: src.split("\n").length,
        // Abstract contracts, libraries and interfaces are not deployable on
        // their own, so resolc emits no block for them at all. Knowing that up
        // front is the difference between "7 failures" and "7 base classes".
        abstract: new RegExp(`^\\s*(abstract\\s+contract|library|interface)\\s+${name}\\b`, "m").test(src),
      });
    }
  }
  return out.sort((a, b) => b.lines - a.lines);
}

async function compile(resolc, solcDir, evmVersion, c) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      resolc,
      [
        "--bin",
        "-O", "z", // resolc's default; stated so a change shows up in the diff
        "--evm-version", evmVersion,
        "--base-path", ".",
        "--include-path", "node_modules",
        c.rel,
      ],
      { cwd: SRC, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
    ));
  } catch (e) {
    const line = String(e.stderr ?? e.message)
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("Warning"));
    return { status: "error", detail: line ?? "compile failed" };
  }

  // Output is a run of "======= file:Contract =======\nBinary:\n<hex>" blocks,
  // one per compiled unit including every dependency. Find ours.
  const at = stdout.indexOf(`${c.rel}:${c.name} =======`);
  const bin = at === -1 ? null : stdout.slice(at).match(/Binary:\s*\n([0-9a-fA-F]*)/);
  if (!bin || !bin[1]) {
    // resolc omits non-deployable units entirely rather than emitting an empty
    // Binary block, so "absent" and "broken" look identical here. The source
    // declaration is what tells them apart.
    return c.abstract
      ? { status: "abstract", detail: "abstract/library — not deployable alone" }
      : { status: "nobin", detail: "compiled, but resolc emitted no binary" };
  }
  return { status: "ok", hex: bin[1] };
}

async function pool(items, n, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, n) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    }),
  );
  return results;
}

function verdict(pct) {
  if (pct > 100) return "OVER";
  if (pct > COMFORTABLE_PCT) return "tight";
  return "ok";
}

async function main() {
  const resolc = findResolc();
  const solcVersion = readCfg(/version:\s*"([\d.]+)"/);
  const evmVersion = readCfg(/evmVersion:\s*"([a-z]+)"/, "cancun");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  const solcDir = findSolcDir(solcVersion);

  const resolcVersion = execFileSync(resolc, ["--version"], { encoding: "utf8" }).trim();
  const contracts = collect();

  console.log(resolcVersion);
  console.log(`src: ${SRC}`);
  console.log(
    `solc: ${solcVersion}   evm-version: ${evmVersion}   opt: -Oz   jobs: ${JOBS}`,
  );
  console.log(`${contracts.length} production contracts\n`);

  // resolc invokes solc by name; give the shim priority on PATH.
  process.env.PATH = `${solcDir}:${process.env.PATH}`;

  let done = 0;
  const rows = await pool(contracts, JOBS, async (c) => {
    const r = await compile(resolc, solcDir, evmVersion, c);
    done++;
    process.stderr.write(`\r  compiling… ${done}/${contracts.length}   `);
    if (r.status !== "ok") return { ...c, ...r };
    const bytes = r.hex.length / 2;
    fs.writeFileSync(
      path.join(OUT_DIR, `${c.name}.json`),
      JSON.stringify(
        { contract: c.name, resolc: resolcVersion, evmVersion, bytes, bytecode: `0x${r.hex}` },
        null,
        2,
      ),
    );
    return { ...c, status: "ok", bytes, pct: (100 * bytes) / BLOB_LIMIT, density: bytes / c.lines };
  });
  process.stderr.write("\r".padEnd(40) + "\r");

  const ok = rows.filter((r) => r.status === "ok").sort((a, b) => b.bytes - a.bytes);
  const other = rows.filter((r) => r.status !== "ok");

  const w = Math.max(...rows.map((r) => r.name.length));
  console.log(`${"contract".padEnd(w)}  ${"lines".padStart(5)}  ${"bytes".padStart(7)}  ${"%".padStart(6)}  ${"B/line".padStart(6)}  verdict`);
  console.log("-".repeat(w + 40));
  for (const r of ok) {
    console.log(
      `${r.name.padEnd(w)}  ${String(r.lines).padStart(5)}  ${String(r.bytes).padStart(7)}  ` +
        `${r.pct.toFixed(1).padStart(5)}%  ${r.density.toFixed(0).padStart(6)}  ${verdict(r.pct)}`,
    );
  }
  for (const r of other) {
    console.log(`${r.name.padEnd(w)}  ${String(r.lines).padStart(5)}  ${"—".padStart(7)}  ${"—".padStart(6)}  ${"—".padStart(6)}  ${r.status}: ${r.detail.slice(0, 60)}`);
  }

  const densities = ok.map((r) => r.density).sort((a, b) => a - b);
  const median = densities[Math.floor(densities.length / 2)] ?? 0;
  const over = ok.filter((r) => r.pct > 100);
  const tight = ok.filter((r) => r.pct > COMFORTABLE_PCT && r.pct <= 100);

  console.log();
  console.log(`deployable: ${ok.length}   abstract/lib: ${other.filter((r) => r.status === "abstract").length}   failed: ${other.filter((r) => r.status === "error" || r.status === "nobin").length}`);
  console.log(`median density: ${median.toFixed(0)} B/line   budget line: ~${Math.round(BLOB_LIMIT / median)} lines`);
  console.log(`OVER limit: ${over.length ? over.map((r) => r.name).join(", ") : "none"}`);
  console.log(`tight (>${COMFORTABLE_PCT}%): ${tight.length ? tight.map((r) => r.name).join(", ") : "none"}`);

  const snapshot = Object.fromEntries(ok.map((r) => [r.name, r.bytes]));
  fs.writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 2) + "\n");

  const md = [
    "# Phase 0 — PolkaVM size survey of alpha-core",
    "",
    `Generated by \`tools/pvm-size-spike.mjs\`. Sources read read-only from \`${SRC}\`.`,
    "",
    `- ${resolcVersion}`,
    `- solc ${solcVersion}, evm-version ${evmVersion}, \`-Oz\``,
    `- blob limit **${BLOB_LIMIT} bytes** (256 KiB); over this pallet-revive rejects with \`BlobTooLarge\``,
    `- median density **${median.toFixed(0)} B/line** → budget line ≈ **${Math.round(BLOB_LIMIT / median)} lines** of Solidity`,
    "",
    "## Deployable contracts",
    "",
    "| Contract | Lines | PVM bytes | % of limit | B/line | Verdict |",
    "|---|---:|---:|---:|---:|---|",
    ...ok.map(
      (r) =>
        `| \`${r.name}\` | ${r.lines} | ${r.bytes.toLocaleString()} | ${r.pct.toFixed(1)}% | ${r.density.toFixed(0)} | ${verdict(r.pct)} |`,
    ),
    "",
    "## Not deployable on their own",
    "",
    "| Contract | Lines | Why |",
    "|---|---:|---|",
    ...other.map((r) => `| \`${r.name}\` | ${r.lines} | ${r.status}: ${r.detail} |`),
    "",
  ].join("\n");
  fs.writeFileSync(REPORT, md);

  console.log(`\n✓ ${path.relative(ROOT, SNAPSHOT)}`);
  console.log(`✓ ${path.relative(ROOT, REPORT)}`);
  console.log(`✓ ${ok.length} blobs → ${path.relative(ROOT, OUT_DIR)}/`);
}

main();
